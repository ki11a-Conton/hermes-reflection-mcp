#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { HookEventSchema, MAX_HOOK_INPUT_BYTES, hookInbox } from "./hook_inbox.js";
import { deriveProjectKey, loadOrCreateProjectSalt } from "./project_scope.js";
import { CompactionMetadataSchema } from "./compaction_handoff.js";
import { codexTurnCaptureEnabled, prepareTurnContent } from "./turn_capture.js";

const HookEventNameSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
]);
const SafeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

const HookInputSchema = z.object({
  hook_event_name: HookEventNameSchema.optional(),
  event: HookEventNameSchema.optional(),
  event_id: SafeIdSchema.optional(),
  session_id: SafeIdSchema,
  turn_id: SafeIdSchema.optional(),
  trigger: z.enum(["auto", "manual"]).optional(),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
  reason: z.string().min(1).max(200).optional(),
  prompt: z.string().optional(),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  occurred_at: z.string().refine((value) => Number.isFinite(Date.parse(value))).optional(),
  timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))).optional(),
  transcript_path: z.unknown().optional(),
  cwd: z.unknown().optional(),
  metadata: CompactionMetadataSchema.optional(),
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
  if ((event === "UserPromptSubmit" || event === "Stop") && !codexTurnCaptureEnabled()) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      accepted: false,
      duplicate: false,
      status: "capture_disabled",
    })}\n`);
    return;
  }
  const captured = event === "UserPromptSubmit"
    ? { side: "user" as const, ...prepareTurnContent(input.prompt ?? "") }
    : event === "Stop"
      ? { side: "assistant" as const, ...prepareTurnContent(input.last_assistant_message ?? "") }
      : undefined;
  const projectKey = deriveProjectKey(process.cwd(), await loadOrCreateProjectSalt());
  const explicitOccurredAt = input.occurred_at ?? input.timestamp;
  const canonicalExplicitOccurredAt = explicitOccurredAt === undefined
    ? undefined
    : new Date(explicitOccurredAt).toISOString();
  const canonicalGeneratedInput = JSON.stringify({
    schema_version: 1,
    event,
    session_id: input.session_id,
    project_key: projectKey,
    ...(input.turn_id ? { turn_id: input.turn_id } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.stop_hook_active !== undefined ? { stop_hook_active: input.stop_hook_active } : {}),
    ...(captured ? { content_hash: captured.content_hash } : {}),
    ...(event === "PostCompact" && input.metadata ? { metadata: input.metadata } : {}),
  });
  const generatedDigest = createHash("sha256").update(canonicalGeneratedInput, "utf8").digest("hex");
  const hasTurnIdentity = input.turn_id !== undefined
    && (event === "UserPromptSubmit" || event === "Stop" || event === "PreCompact" || event === "PostCompact");
  const eventId = input.event_id ?? (hasTurnIdentity
    ? `hook:turn:${generatedDigest.slice(0, 40)}`
    : `hook:event:${randomUUID()}`);
  const occurredAt = canonicalExplicitOccurredAt ?? new Date().toISOString();
  const receipt = await hookInbox.enqueue(HookEventSchema.parse({
    schema_version: 1,
    event_id: eventId,
    ...(input.event_id === undefined ? { event_id_source: "generated" } : {}),
    event,
    session_id: input.session_id,
    occurred_at: occurredAt,
    ...(canonicalExplicitOccurredAt === undefined ? { occurred_at_source: "received" } : {}),
    project_key: projectKey,
    ...(input.turn_id ? { turn_id: input.turn_id } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.stop_hook_active !== undefined ? { stop_hook_active: input.stop_hook_active } : {}),
    ...(captured ? { captured } : {}),
    ...(event === "PostCompact" && input.metadata ? { metadata: input.metadata } : {}),
  }));
  process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: "invalid_hook_input" })}\n`);
  process.exitCode = 1;
});
