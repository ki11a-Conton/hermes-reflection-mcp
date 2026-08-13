import { z } from "zod";
import { CompactionMetadataSchema } from "../compaction_handoff.js";
import { codePointLength } from "../redaction.js";
import {
  MAX_LIFECYCLE_CAPTURE_CODE_POINTS,
  type CanonicalLifecycleEvent,
} from "./events.js";

const SafeIdentifierSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

const BoundedMetadataTextSchema = z.string().min(1).max(100).refine(
  (value) => !value.includes("\r") && !value.includes("\n") && !value.includes("\0"),
  { message: "Must not contain CR, LF, or NUL" },
);

const HostSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  version: BoundedMetadataTextSchema.optional(),
}).strict();

const ScopeSchema = z.string().refine(
  (value) => value === "global" || /^project:[A-Za-z0-9._:-]{1,128}$/.test(value),
  { message: "scope must be global or a non-empty project scope" },
);

const IdentitySchema = z.object({
  key: SafeIdentifierSchema,
  source: z.enum(["host", "derived", "generated"]),
}).strict();

const HostMetadataSchema = z.object({
  model: BoundedMetadataTextSchema.optional(),
  platform: BoundedMetadataTextSchema.optional(),
  user_id: BoundedMetadataTextSchema.optional(),
}).strict();

const OccurredAtSchema = z.string()
  .refine((value) => Number.isFinite(Date.parse(value)), "invalid occurred_at")
  .transform((value) => new Date(value).toISOString());

const CaptureBaseShape = {
  content: z.string().refine(
    (value) => codePointLength(value) <= MAX_LIFECYCLE_CAPTURE_CODE_POINTS,
    `captured content exceeds ${MAX_LIFECYCLE_CAPTURE_CODE_POINTS} Unicode code points`,
  ),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  original_code_points: z.number().int().min(0).max(1_000_000),
  content_truncated: z.boolean(),
  content_blocked: z.boolean(),
} as const;

const UserCaptureSchema = z.object({
  side: z.literal("user"),
  ...CaptureBaseShape,
}).strict();

const AssistantCaptureSchema = z.object({
  side: z.literal("assistant"),
  ...CaptureBaseShape,
}).strict();

const ObservationSchema = z.object({
  trigger: z.enum(["auto", "manual"]),
}).strict();

const CommonShape = {
  schema_version: z.literal(1),
  host: HostSchema,
  session_id: SafeIdentifierSchema,
  occurred_at: OccurredAtSchema,
  occurred_at_source: z.enum(["host", "received"]),
  scope: ScopeSchema,
  identity: IdentitySchema,
  host_metadata: HostMetadataSchema.optional(),
} as const;

const SessionStartSchema = z.object({
  ...CommonShape,
  type: z.literal("session_start"),
  turn_id: SafeIdentifierSchema.optional(),
  payload: z.object({
    kind: z.literal("session_start"),
    source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
    parent_session_id: SafeIdentifierSchema.optional(),
  }).strict(),
}).strict();

const TurnStartSchema = z.object({
  ...CommonShape,
  type: z.literal("turn_start"),
  turn_id: SafeIdentifierSchema,
  payload: z.object({
    kind: z.literal("turn_start"),
    capture: UserCaptureSchema.optional(),
  }).strict(),
}).strict();

const TurnEndSchema = z.object({
  ...CommonShape,
  type: z.literal("turn_end"),
  turn_id: SafeIdentifierSchema,
  payload: z.object({
    kind: z.literal("turn_end"),
    capture: AssistantCaptureSchema.optional(),
  }).strict(),
}).strict();

const PreCompactSchema = z.object({
  ...CommonShape,
  type: z.literal("pre_compact"),
  turn_id: SafeIdentifierSchema.optional(),
  payload: z.object({
    kind: z.literal("pre_compact"),
    observation: ObservationSchema.optional(),
  }).strict(),
}).strict();

const PostCompactSchema = z.object({
  ...CommonShape,
  type: z.literal("post_compact"),
  turn_id: SafeIdentifierSchema.optional(),
  payload: z.object({
    kind: z.literal("post_compact"),
    observation: ObservationSchema.optional(),
    trusted_receipt: CompactionMetadataSchema.optional(),
  }).strict(),
}).strict();

const SessionEndSchema = z.object({
  ...CommonShape,
  type: z.literal("session_end"),
  turn_id: SafeIdentifierSchema.optional(),
  payload: z.object({
    kind: z.literal("session_end"),
    reason: z.string().max(200).refine((value) => value.trim().length > 0, "reason is required"),
  }).strict(),
}).strict();

export const CanonicalLifecycleEventSchema = z.discriminatedUnion("type", [
  SessionStartSchema,
  TurnStartSchema,
  TurnEndSchema,
  PreCompactSchema,
  PostCompactSchema,
  SessionEndSchema,
]);

export function parseCanonicalLifecycleEvent(value: unknown): CanonicalLifecycleEvent {
  return CanonicalLifecycleEventSchema.parse(value) as CanonicalLifecycleEvent;
}
