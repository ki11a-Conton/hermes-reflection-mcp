#!/usr/bin/env node
import { createHash } from "node:crypto";
import { z } from "zod";
import { HookEventSchema, MAX_HOOK_INPUT_BYTES, hookInbox } from "./hook_inbox.js";
import { deriveProjectKey, loadOrCreateProjectSalt } from "./project_scope.js";
import { CompactionMetadataSchema } from "./compaction_handoff.js";
const HookInputSchema = z.object({
    hook_event_name: z.enum(["SessionStart", "Stop", "SessionEnd", "PreCompact", "PostCompact"]).optional(),
    event: z.enum(["SessionStart", "Stop", "SessionEnd", "PreCompact", "PostCompact"]).optional(),
    event_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    session_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
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
async function readBoundedStdin() {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_HOOK_INPUT_BYTES)
            throw new Error("input_too_large");
        chunks.push(buffer);
    }
    if (bytes === 0)
        throw new Error("empty_input");
    return Buffer.concat(chunks, bytes);
}
async function main() {
    const raw = await readBoundedStdin();
    const input = HookInputSchema.parse(JSON.parse(raw.toString("utf8")));
    const event = input.hook_event_name ?? input.event;
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
        ...(canonicalExplicitOccurredAt ? { occurred_at: canonicalExplicitOccurredAt } : {}),
        ...(event === "PostCompact" && input.metadata ? { metadata: input.metadata } : {}),
    });
    const generatedDigest = createHash("sha256").update(canonicalGeneratedInput, "utf8").digest("hex");
    const eventId = input.event_id
        ?? `hook:${canonicalExplicitOccurredAt ? "" : "auto:"}${generatedDigest.slice(0, 40)}`;
    const occurredAt = canonicalExplicitOccurredAt ?? new Date().toISOString();
    const receipt = await hookInbox.enqueue(HookEventSchema.parse({
        schema_version: 1,
        event_id: eventId,
        event,
        session_id: input.session_id,
        occurred_at: occurredAt,
        ...(canonicalExplicitOccurredAt === undefined ? { occurred_at_source: "received" } : {}),
        project_key: projectKey,
        ...(event === "PostCompact" && input.metadata ? { metadata: input.metadata } : {}),
    }));
    process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
}
main().catch(() => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "invalid_hook_input" })}\n`);
    process.exitCode = 1;
});
