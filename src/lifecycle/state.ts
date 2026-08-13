import type { CanonicalLifecycleEvent } from "./events.js";

export interface LifecycleDispatcherPorts {
  persist_session_start(event: Extract<CanonicalLifecycleEvent, { type: "session_start" }>): Promise<boolean>;
  bind_scope(event: Extract<CanonicalLifecycleEvent, { type: "session_start" }>): Promise<void>;
  capture_snapshot(sessionId: string): Promise<void>;
  stage_turn_side(event: Extract<CanonicalLifecycleEvent, { type: "turn_start" | "turn_end" }>): Promise<void>;
  persist_compaction_observation(
    event: Extract<CanonicalLifecycleEvent, { type: "pre_compact" | "post_compact" }>,
    phase: "pre" | "post",
  ): Promise<void>;
  persist_compaction_receipt(event: Extract<CanonicalLifecycleEvent, { type: "post_compact" }>): Promise<boolean>;
  persist_session_end(event: Extract<CanonicalLifecycleEvent, { type: "session_end" }>): Promise<boolean>;
  cleanup_pending_turn_sides(sessionId: string): Promise<void>;
  release_snapshot(sessionId: string): void;
  notify_session_end(sessionId: string): Promise<void>;
  release_scope(sessionId: string): Promise<void>;
}
