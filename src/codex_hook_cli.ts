#!/usr/bin/env node

import { createHash } from "node:crypto";
import { z } from "zod";
import { HookEventSchema, MAX_HOOK_INPUT_BYTES, hookInbox } from "./hook_inbox.js";
import { deriveProjectKey, loadOrCreateProjectSalt } from "./project_scope.js";

const HookInputSchema = z.object({
  hook_event_name: z.enum(["SessionStart", "Stop", "SessionEnd", "PreCompact", "PostCompact"]).optional(),
  event: z.enum(["SessionStart", "Stop", "SessionEnd", "PreCompact", "PostCompact"]).optional(),
  event_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  session_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  occurred_at: z.string().refine((value) => Number.isFinite(Date.parse(value))).optional(),
  timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))).optional(),
  transcript_path: z.unknown().optional(),
  cwd: z.unknown().optional(),
}).passthrough().superRefine((value, context) => {
  if (!value.hook_event_name && !value.event) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["hook_event_name"], message: "event is required" });
  }
  if (value.hook_event_name && value.event && value.hook_event_name !== value.event) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["event"], message: "event names must agree" });
  }
});

async function readBoundedStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_HOOK_INPUT_BYTES) throw new Error("input_too_large");
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("empty_input");
  return Buffer.concat(chunks, bytes);
}

async function main(): Promise<void> {
  const raw = await readBoundedStdin();
  const input = HookInputSchema.parse(JSON.parse(raw.toString("utf8")));
  const event = input.hook_event_name ?? input.event!;
  const eventId = input.event_id
    ?? `hook:${createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;
  const occurredAt = new Date(input.occurred_at ?? input.timestamp ?? Date.now()).toISOString();
  const projectKey = event === "SessionStart"
    ? deriveProjectKey(process.cwd(), await loadOrCreateProjectSalt())
    : undefined;
  const receipt = await hookInbox.enqueue(HookEventSchema.parse({
    schema_version: 1,
    event_id: eventId,
    event,
    session_id: input.session_id,
    occurred_at: occurredAt,
    ...(projectKey ? { project_key: projectKey } : {}),
  }));
  process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: "invalid_hook_input" })}\n`);
  process.exitCode = 1;
});
