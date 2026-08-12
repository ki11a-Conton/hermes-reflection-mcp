import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { withFileLock } from "./file_lock.js";
import { CompactionMetadataSchema } from "./compaction_handoff.js";
import { codePointLength } from "./redaction.js";
import { MAX_CAPTURE_CODE_POINTS } from "./turn_capture.js";

const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const MAX_QUEUED_EVENTS = 1_000;
const MAX_COMPLETED_EVENTS = 4_096;
const MAX_QUEUE_BYTES = MAX_HOOK_INPUT_BYTES * MAX_QUEUED_EVENTS;
const MAX_DEDUP_BYTES = 4 * 1024 * 1024;
const HOOK_FILE_LOCK_OPTIONS = { timeout_ms: 4_000, retry_ms: 25, stale_ms: 500 } as const;

const SafeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const CapturedTurnSchema = z.object({
  side: z.enum(["user", "assistant"]),
  content: z.string().refine(
    (value) => codePointLength(value) <= MAX_CAPTURE_CODE_POINTS,
    `captured content exceeds ${MAX_CAPTURE_CODE_POINTS} Unicode code points`,
  ),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  original_code_points: z.number().int().min(0).max(1_000_000),
  content_truncated: z.boolean(),
  content_blocked: z.boolean(),
}).strict();

const HookEventObjectSchema = z.object({
  schema_version: z.literal(1),
  event_id: SafeIdSchema,
  event_id_source: z.literal("generated").optional(),
  event: z.enum(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PreCompact", "PostCompact"]),
  session_id: SafeIdSchema,
  occurred_at: z.string().refine((value) => Number.isFinite(Date.parse(value)), "invalid occurred_at"),
  occurred_at_source: z.literal("received").optional(),
  project_key: z.string().regex(/^project:[a-f0-9]{64}$/).optional(),
  scope_intent: z.enum(["global", "project"]).optional(),
  turn_id: SafeIdSchema.optional(),
  trigger: z.enum(["auto", "manual"]).optional(),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
  reason: z.string().min(1).max(200).optional(),
  stop_hook_active: z.boolean().optional(),
  captured: CapturedTurnSchema.optional(),
  metadata: CompactionMetadataSchema.optional(),
}).strict();

export const HookEventSchema = HookEventObjectSchema.superRefine((value, context) => {
  if (value.event === "SessionStart") {
    if (!value.project_key && value.scope_intent !== "global") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope_intent"],
        message: "SessionStart requires project_key or explicit global scope_intent provenance",
      });
    }
    if (value.project_key && value.scope_intent === "global") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope_intent"],
        message: "SessionStart project_key conflicts with global scope_intent",
      });
    }
    if (!value.project_key && value.scope_intent === "project") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["project_key"],
        message: "Project scope_intent requires project_key",
      });
    }
  } else if (value.scope_intent !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope_intent"],
      message: "scope_intent is valid only for SessionStart",
    });
  }
  if (value.metadata !== undefined && value.event !== "PostCompact") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata"],
      message: "compaction metadata is valid only for PostCompact",
    });
  }
  if (value.captured !== undefined) {
    const expectedSide = value.event === "UserPromptSubmit"
      ? "user"
      : value.event === "Stop"
        ? "assistant"
        : undefined;
    if (!expectedSide || value.captured.side !== expectedSide) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["captured", "side"],
        message: "captured content side conflicts with the hook event",
      });
    }
    if (!value.turn_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["turn_id"],
        message: "captured turn content requires turn_id",
      });
    }
  }
  if (value.trigger !== undefined && value.event !== "PreCompact" && value.event !== "PostCompact") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger"],
      message: "trigger is valid only for compaction hooks",
    });
  }
  if (value.source !== undefined && value.event !== "SessionStart") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "source is valid only for SessionStart" });
  }
  if (value.reason !== undefined && value.event !== "SessionEnd") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "reason is valid only for SessionEnd" });
  }
  if (value.stop_hook_active !== undefined && value.event !== "Stop") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stop_hook_active"],
      message: "stop_hook_active is valid only for Stop",
    });
  }
});

export type HookEvent = z.infer<typeof HookEventSchema>;

const CompletedEventSchema = z.object({
  event_id: SafeIdSchema,
  event: HookEventObjectSchema.shape.event,
  session_id: SafeIdSchema,
  occurred_at: HookEventObjectSchema.shape.occurred_at,
  completed_at: HookEventObjectSchema.shape.occurred_at,
  event_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  event_identity_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const DedupStateSchema = z.object({
  schema_version: z.literal(1),
  completed: z.array(CompletedEventSchema).max(MAX_COMPLETED_EVENTS),
}).strict();

type DedupState = z.infer<typeof DedupStateSchema>;

export interface HookInboxStatus {
  queued: number;
  processing: number;
  deduplicated: number;
}

export interface HookConsumeObserver {
  onClaimed?: (event: HookEvent) => void;
  onSettled?: (event: HookEvent) => void;
}

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
    ...(event.event_id_source ? { event_id_source: event.event_id_source } : {}),
    event: event.event,
    session_id: event.session_id,
    occurred_at: new Date(event.occurred_at).toISOString(),
    ...(event.occurred_at_source ? { occurred_at_source: event.occurred_at_source } : {}),
    ...(event.project_key ? { project_key: event.project_key } : {}),
    ...(event.event === "SessionStart" && event.project_key ? { scope_intent: "project" } : {}),
    ...(!event.project_key && event.scope_intent === "global" ? { scope_intent: "global" } : {}),
    ...(event.turn_id ? { turn_id: event.turn_id } : {}),
    ...(event.trigger ? { trigger: event.trigger } : {}),
    ...(event.source ? { source: event.source } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.stop_hook_active !== undefined ? { stop_hook_active: event.stop_hook_active } : {}),
    ...(event.captured ? { captured: event.captured } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  });
}

function canonicalEventIdentity(event: HookEvent): string {
  if (event.occurred_at_source !== "received") return canonicalEvent(event);
  return JSON.stringify({
    schema_version: 1,
    event_id: event.event_id,
    ...(event.event_id_source ? { event_id_source: event.event_id_source } : {}),
    event: event.event,
    session_id: event.session_id,
    occurred_at_source: "received",
    ...(event.project_key ? { project_key: event.project_key } : {}),
    ...(event.event === "SessionStart" && event.project_key ? { scope_intent: "project" } : {}),
    ...(!event.project_key && event.scope_intent === "global" ? { scope_intent: "global" } : {}),
    ...(event.turn_id ? { turn_id: event.turn_id } : {}),
    ...(event.trigger ? { trigger: event.trigger } : {}),
    ...(event.source ? { source: event.source } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.stop_hook_active !== undefined ? { stop_hook_active: event.stop_hook_active } : {}),
    ...(event.captured ? { captured: event.captured } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  });
}

function eventIdentityHash(event: HookEvent): string {
  return createHash("sha256").update(canonicalEventIdentity(event), "utf8").digest("hex");
}

function eventHash(event: HookEvent): string {
  return createHash("sha256").update(canonicalEvent(event), "utf8").digest("hex");
}

function completedMatches(event: HookEvent, completed: DedupState["completed"][number]): boolean {
  if (event.occurred_at_source === "received" && completed.event_identity_hash) {
    return completed.event_identity_hash === eventIdentityHash(event);
  }
  if (completed.event_hash) return completed.event_hash === eventHash(event);
  return false;
}

function eventIdConflict(eventId: string): Error {
  return new Error(`HOOK_EVENT_ID_CONFLICT: event_id '${eventId}' is already bound to different canonical input`);
}

function completionForEvent(event: HookEvent, dedup: DedupState): DedupState["completed"][number] | undefined {
  const matches = dedup.completed.filter((item) => item.event_id === event.event_id);
  if (matches.length === 0) return undefined;
  const [first, ...rest] = matches;
  if (!first.event_hash || rest.some((item) => !item.event_hash || item.event_hash !== first.event_hash)) {
    throw eventIdConflict(event.event_id);
  }
  if (!completedMatches(event, first)) throw eventIdConflict(event.event_id);
  return first;
}

function completedIdsForPending(events: HookEvent[], dedup: DedupState): Set<string> {
  const pendingById = new Map<string, string>();
  const completed = new Set<string>();
  for (const event of events) {
    const canonical = canonicalEventIdentity(event);
    const prior = pendingById.get(event.event_id);
    if (prior !== undefined && prior !== canonical) throw eventIdConflict(event.event_id);
    pendingById.set(event.event_id, canonical);
    if (completionForEvent(event, dedup)) completed.add(event.event_id);
  }
  return completed;
}

function completionRecord(event: HookEvent, completedAt = new Date().toISOString()): DedupState["completed"][number] {
  return {
    event_id: event.event_id,
    event: event.event,
    session_id: event.session_id,
    occurred_at: new Date(event.occurred_at).toISOString(),
    completed_at: completedAt,
    event_hash: eventHash(event),
    ...(event.occurred_at_source === "received" ? { event_identity_hash: eventIdentityHash(event) } : {}),
  };
}

function serializedDedup(state: DedupState): string {
  const validated = DedupStateSchema.parse(state);
  const serialized = JSON.stringify(validated, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DEDUP_BYTES) {
    throw new Error(`HOOK_COMPLETION_LEDGER_FULL: hook dedup state exceeds ${MAX_DEDUP_BYTES} bytes`);
  }
  return serialized;
}

function assertCompletionCapacity(dedup: DedupState, event: HookEvent): void {
  if (dedup.completed.length >= MAX_COMPLETED_EVENTS) {
    throw new Error(`HOOK_COMPLETION_LEDGER_FULL: hook dedup state reached ${MAX_COMPLETED_EVENTS} events`);
  }
  serializedDedup({ ...dedup, completed: [...dedup.completed, completionRecord(event)] });
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
    const raw = await readOptional(this.dedupPath, MAX_DEDUP_BYTES);
    if (!raw) return { schema_version: 1, completed: [] };
    try {
      return DedupStateSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error("hook dedup state is invalid or unsupported");
    }
  }

  private async writeDedup(state: DedupState): Promise<void> {
    const serialized = serializedDedup(state);
    await mkdir(this.root, { recursive: true });
    const temp = `${this.dedupPath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
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
      const completedMatch = completionForEvent(event, dedup);
      if (completedMatch) {
        return { accepted: false, duplicate: true, event_id: event.event_id };
      }
      const pendingMatch = [...queued, ...processingEvents].find((item) => item.event_id === event.event_id);
      if (pendingMatch) {
        if (canonicalEventIdentity(pendingMatch) !== canonicalEventIdentity(event)) throw eventIdConflict(event.event_id);
        return { accepted: false, duplicate: true, event_id: event.event_id };
      }
      if (dedup.completed.length >= MAX_COMPLETED_EVENTS) {
        throw new Error(`HOOK_COMPLETION_LEDGER_FULL: hook dedup state reached ${MAX_COMPLETED_EVENTS} events`);
      }
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
    }, HOOK_FILE_LOCK_OPTIONS);
  }

  async status(): Promise<HookInboxStatus> {
    return withFileLock(this.stateLockPath, async () => {
      const [queue, processing, dedup] = await Promise.all([
        readOptional(this.queuePath),
        readOptional(this.processingPath),
        this.readDedup(),
      ]);
      const queued = parseJsonl(queue, "hook inbox");
      const processingEvents = parseJsonl(processing, "hook processing inbox");
      const completed = completedIdsForPending([...queued, ...processingEvents], dedup);
      return {
        queued: queued.filter((event) => !completed.has(event.event_id)).length,
        processing: processingEvents.filter((event) => !completed.has(event.event_id)).length,
        deduplicated: dedup.completed.length,
      };
    }, HOOK_FILE_LOCK_OPTIONS);
  }

  async hasPendingSessionStart(sessionId: string): Promise<boolean> {
    const validatedSessionId = SafeIdSchema.parse(sessionId);
    return withFileLock(this.stateLockPath, async () => {
      const [queue, processing, dedup] = await Promise.all([
        readOptional(this.queuePath),
        readOptional(this.processingPath),
        this.readDedup(),
      ]);
      const processingEvents = parseJsonl(processing, "hook processing inbox");
      const queued = parseJsonl(queue, "hook inbox");
      const pending = [...processingEvents, ...queued];
      const completed = completedIdsForPending(pending, dedup);
      return pending
        .some((event) => event.event === "SessionStart"
          && event.session_id === validatedSessionId
          && !completed.has(event.event_id));
    }, HOOK_FILE_LOCK_OPTIONS);
  }

  async consume(
    handler: (event: HookEvent) => Promise<void>,
    observer: HookConsumeObserver = {},
  ): Promise<{ processed: number; skipped: number }> {
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
      }, HOOK_FILE_LOCK_OPTIONS);
      if (batch.length === 0) return { processed: 0, skipped: 0 };

      let processed = 0;
      let skipped = 0;
      for (const event of batch) {
        const alreadyCompleted = await withFileLock(this.stateLockPath, async () => {
          const dedup = await this.readDedup();
          const completed = completionForEvent(event, dedup);
          if (!completed) assertCompletionCapacity(dedup, event);
          return Boolean(completed);
        }, HOOK_FILE_LOCK_OPTIONS);
        if (alreadyCompleted) {
          skipped += 1;
          continue;
        }
        observer.onClaimed?.(event);
        try {
          await handler(event);
          await withFileLock(this.stateLockPath, async () => {
            const dedup = await this.readDedup();
            const completed = completionForEvent(event, dedup);
            if (!completed) {
              dedup.completed.push(completionRecord(event));
              await this.writeDedup(dedup);
            }
          }, HOOK_FILE_LOCK_OPTIONS);
        } finally {
          observer.onSettled?.(event);
        }
        processed += 1;
      }
      await withFileLock(this.stateLockPath, async () => {
        await rm(this.processingPath, { force: true });
      }, HOOK_FILE_LOCK_OPTIONS);
      return { processed, skipped };
    }, HOOK_FILE_LOCK_OPTIONS);
  }
}

export const hookInbox = new HookInbox();
export { MAX_HOOK_INPUT_BYTES };
