import type { CanonicalLifecycleEvent } from "./events.js";
import type { LifecycleDispatcherPorts } from "./state.js";
import { parseCanonicalLifecycleEvent } from "./validation.js";

export type { LifecycleDispatcherPorts } from "./state.js";

export async function dispatchLifecycleEvent(
  input: CanonicalLifecycleEvent,
  ports: LifecycleDispatcherPorts,
): Promise<void> {
  const event = parseCanonicalLifecycleEvent(input);
  switch (event.type) {
    case "session_start":
      if (!await ports.persist_session_start(event)) {
        throw new Error("LIFECYCLE_PERSISTENCE_UNAVAILABLE: session start was not persisted");
      }
      await ports.bind_scope(event);
      await ports.capture_snapshot(event.session_id);
      return;
    case "turn_start":
    case "turn_end":
      if (event.payload.capture) await ports.stage_turn_side(event);
      return;
    case "pre_compact":
      if (event.turn_id && event.payload.observation) {
        await ports.persist_compaction_observation(event, "pre");
      }
      return;
    case "post_compact":
      if (event.turn_id && event.payload.observation) {
        await ports.persist_compaction_observation(event, "post");
      }
      if (event.payload.trusted_receipt && !await ports.persist_compaction_receipt(event)) {
        throw new Error("LIFECYCLE_PERSISTENCE_UNAVAILABLE: compaction receipt was not persisted");
      }
      await ports.capture_snapshot(event.session_id);
      return;
    case "session_end":
      if (!await ports.persist_session_end(event)) {
        throw new Error("LIFECYCLE_PERSISTENCE_UNAVAILABLE: session end was not persisted");
      }
      await ports.cleanup_pending_turn_sides(event.session_id);
      ports.release_snapshot(event.session_id);
      await ports.notify_session_end(event.session_id);
      await ports.release_scope(event.session_id);
      return;
  }
}
