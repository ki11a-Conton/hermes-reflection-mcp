import type { CompactionMetadata } from "../compaction_handoff.js";
import type { RequestedSessionScope } from "../session_scope.js";

export const CANONICAL_LIFECYCLE_EVENT_TYPES = [
  "session_start",
  "turn_start",
  "turn_end",
  "pre_compact",
  "post_compact",
  "session_end",
] as const;

export type CanonicalLifecycleEventType = typeof CANONICAL_LIFECYCLE_EVENT_TYPES[number];

export const MAX_LIFECYCLE_CAPTURE_CODE_POINTS = 12_000;

export interface LifecycleHost {
  name: string;
  version?: string;
}

export interface LifecycleIdentity {
  key: string;
  source: "host" | "derived" | "generated";
}

export interface LifecycleHostMetadata {
  model?: string;
  platform?: string;
  user_id?: string;
}

export interface CapturedTurnProjection {
  side: "user" | "assistant";
  content: string;
  content_hash: string;
  original_code_points: number;
  content_truncated: boolean;
  content_blocked: boolean;
}

export interface CompactionObservation {
  trigger: "auto" | "manual";
}

interface CanonicalLifecycleEventBase<TType extends CanonicalLifecycleEventType, TPayload> {
  schema_version: 1;
  type: TType;
  host: LifecycleHost;
  session_id: string;
  turn_id?: string;
  occurred_at: string;
  occurred_at_source: "host" | "received";
  scope: RequestedSessionScope;
  identity: LifecycleIdentity;
  payload: TPayload;
  host_metadata?: LifecycleHostMetadata;
}

export type SessionStartLifecycleEvent = CanonicalLifecycleEventBase<"session_start", {
  kind: "session_start";
  source?: "startup" | "resume" | "clear" | "compact";
  parent_session_id?: string;
}>;

export type TurnStartLifecycleEvent = CanonicalLifecycleEventBase<"turn_start", {
  kind: "turn_start";
  capture?: CapturedTurnProjection & { side: "user" };
}> & { turn_id: string };

export type TurnEndLifecycleEvent = CanonicalLifecycleEventBase<"turn_end", {
  kind: "turn_end";
  capture?: CapturedTurnProjection & { side: "assistant" };
}> & { turn_id: string };

export type PreCompactLifecycleEvent = CanonicalLifecycleEventBase<"pre_compact", {
  kind: "pre_compact";
  observation?: CompactionObservation;
}>;

export type PostCompactLifecycleEvent = CanonicalLifecycleEventBase<"post_compact", {
  kind: "post_compact";
  observation?: CompactionObservation;
  trusted_receipt?: CompactionMetadata;
}>;

export type SessionEndLifecycleEvent = CanonicalLifecycleEventBase<"session_end", {
  kind: "session_end";
  reason: string;
}>;

export type CanonicalLifecycleEvent =
  | SessionStartLifecycleEvent
  | TurnStartLifecycleEvent
  | TurnEndLifecycleEvent
  | PreCompactLifecycleEvent
  | PostCompactLifecycleEvent
  | SessionEndLifecycleEvent;
