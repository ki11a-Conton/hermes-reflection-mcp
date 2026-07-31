import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { withFileLock } from "./file_lock.js";

const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const MAX_QUEUED_EVENTS = 1_000;
const MAX_COMPLETED_EVENTS = 1_000;
const MAX_QUEUE_BYTES = MAX_HOOK_INPUT_BYTES * MAX_QUEUED_EVENTS;

const SafeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

export const HookEventSchema = z.object({
  schema_version: z.literal(1),
  event_id: SafeIdSchema,
  event: z.enum(["SessionStart", "Stop", "SessionEnd", "PreCompact", "PostCompact"]),
  session_id: SafeIdSchema,
  occurred_at: z.string().refine((value) => Number.isFinite(Date.parse(value)), "invalid occurred_at"),
  project_key: z.string().regex(/^project:[a-f0-9]{64}$/).optional(),
}).strict();

export type HookEvent = z.infer<typeof HookEventSchema>;

const CompletedEventSchema = z.object({
  event_id: SafeIdSchema,
  event: HookEventSchema.shape.event,
  session_id: SafeIdSchema,
  occurred_at: HookEventSchema.shape.occurred_at,
  completed_at: HookEventSchema.shape.occurred_at,
}).strict();

const DedupStateSchema = z.object({
  schema_version: z.literal(1),
  completed: z.array(CompletedEventSchema).max(MAX_COMPLETED_EVENTS),
}).strict();

type DedupState = z.infer<typeof DedupStateSchema>;

async function readOptional(path: string, maxBytes = MAX_QUEUE_BYTES): Promise<string> {
  try {
    const data = await readFile(path);
    if (data.byteLength > maxBytes) throw new Error("hook inbox state exceeds its hard byte limit");
    return data.toString("utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function parseJsonl(raw: string, label: string): HookEvent[] {
  if (!raw.trim()) return [];
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length > MAX_QUEUED_EVENTS) throw new Error(`${label} exceeds ${MAX_QUEUED_EVENTS} events`);
  return lines.map((line, index) => {
    if (Buffer.byteLength(line, "utf8") > MAX_HOOK_INPUT_BYTES) {
      throw new Error(`${label} event at line ${index + 1} exceeds ${MAX_HOOK_INPUT_BYTES} bytes`);
    }
    try {
      return HookEventSchema.parse(JSON.parse(line));
    } catch {
      throw new Error(`${label} contains an invalid event at line ${index + 1}`);
    }
  });
}

function canonicalEvent(event: HookEvent): string {
  return JSON.stringify({
    schema_version: 1,
    event_id: event.event_id,
    event: event.event,
    session_id: event.session_id,
    occurred_at: new Date(event.occurred_at).toISOString(),
    ...(event.project_key ? { project_key: event.project_key } : {}),
  });
}

export class HookInbox {
  readonly queuePath: string;
  readonly processingPath: string;
  readonly dedupPath: string;
  private readonly stateLockPath: string;
  private readonly consumerLockPath: string;

  constructor(readonly root: string = join(homedir(), ".hermes-reflection")) {
    this.queuePath = join(root, "hook_inbox.jsonl");
    this.processingPath = join(root, "hook_inbox.processing.jsonl");
    this.dedupPath = join(root, "hook_dedup.json");
    this.stateLockPath = join(root, "hook_inbox.state");
    this.consumerLockPath = join(root, "hook_inbox.consumer");
  }

  private async readDedup(): Promise<DedupState> {
    const raw = await readOptional(this.dedupPath, 512 * 1024);
    if (!raw) return { schema_version: 1, completed: [] };
    try {
      return DedupStateSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error("hook dedup state is invalid or unsupported");
    }
  }

  private async writeDedup(state: DedupState): Promise<void> {
    const validated = DedupStateSchema.parse(state);
    await mkdir(this.root, { recursive: true });
    const temp = `${this.dedupPath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(validated, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.dedupPath);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async enqueue(input: HookEvent): Promise<{ accepted: boolean; duplicate: boolean; event_id: string }> {
    const event = HookEventSchema.parse(input);
    return withFileLock(this.stateLockPath, async () => {
      const [queue, processing, dedup] = await Promise.all([
        readOptional(this.queuePath),
        readOptional(this.processingPath),
        this.readDedup(),
      ]);
      const queued = parseJsonl(queue, "hook inbox");
      const processingEvents = parseJsonl(processing, "hook processing inbox");
      const duplicate = dedup.completed.some((item) => item.event_id === event.event_id)
        || queued.some((item) => item.event_id === event.event_id)
        || processingEvents.some((item) => item.event_id === event.event_id);
      if (duplicate) return { accepted: false, duplicate: true, event_id: event.event_id };
      if (queued.length + processingEvents.length >= MAX_QUEUED_EVENTS) {
        throw new Error(`hook inbox is full (${MAX_QUEUED_EVENTS} events)`);
      }
      await mkdir(this.root, { recursive: true });
      const handle = await open(this.queuePath, "a", 0o600);
      try {
        await handle.writeFile(`${canonicalEvent(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { accepted: true, duplicate: false, event_id: event.event_id };
    });
  }

  async consume(handler: (event: HookEvent) => Promise<void>): Promise<{ processed: number; skipped: number }> {
    return withFileLock(this.consumerLockPath, async () => {
      const batch = await withFileLock(this.stateLockPath, async () => {
        const processingRaw = await readOptional(this.processingPath);
        if (processingRaw) return parseJsonl(processingRaw, "hook processing inbox");
        await rm(this.processingPath, { force: true });
        const queueRaw = await readOptional(this.queuePath);
        if (!queueRaw) return [];
        const events = parseJsonl(queueRaw, "hook inbox");
        await rename(this.queuePath, this.processingPath);
        return events;
      });
      if (batch.length === 0) return { processed: 0, skipped: 0 };

      let processed = 0;
      let skipped = 0;
      for (const event of batch) {
        const alreadyCompleted = await withFileLock(this.stateLockPath, async () => {
          const dedup = await this.readDedup();
          return dedup.completed.some((item) => item.event_id === event.event_id);
        });
        if (alreadyCompleted) {
          skipped += 1;
          continue;
        }
        await handler(event);
        await withFileLock(this.stateLockPath, async () => {
          const dedup = await this.readDedup();
          if (!dedup.completed.some((item) => item.event_id === event.event_id)) {
            dedup.completed.push({
              event_id: event.event_id,
              event: event.event,
              session_id: event.session_id,
              occurred_at: new Date(event.occurred_at).toISOString(),
              completed_at: new Date().toISOString(),
            });
            dedup.completed = dedup.completed.slice(-MAX_COMPLETED_EVENTS);
            await this.writeDedup(dedup);
          }
        });
        processed += 1;
      }
      await withFileLock(this.stateLockPath, async () => {
        await rm(this.processingPath, { force: true });
      });
      return { processed, skipped };
    });
  }
}

export const hookInbox = new HookInbox();
export { MAX_HOOK_INPUT_BYTES };
