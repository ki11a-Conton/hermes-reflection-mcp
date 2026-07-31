// ============================================================
// Hermes Reflection MCP v19.0.0 - New Tool Handlers
// Tools: capture_memory_snapshot, session_lifecycle_hook, 
//        scan_memory_threats, scroll_session_context, compact_session_context,
//        trigger_background_review
// ============================================================

import {
  captureSessionSnapshot,
  releaseSessionSnapshot,
} from "./storage_enhanced.js";
import {
  getSessionReflections,
  getRawMemoryStores,
  safeHeuristicText,
  scanHeuristicThreats,
} from "../storage.js";
import { listSessionTurns, listSessionTurnsAround, SESSION_STORAGE_UNAVAILABLE } from "../session_storage.js";
import type { SessionTurn } from "../types.js";
import { buildCompactionHandoff } from "./compaction_handoff.js";
import { getReviewReadinessStatus, getReviewSourceState } from "./review_engine.js";
import { reviewQueueCounts } from "./review_queue.js";
import { backgroundLifecycle } from "./background_lifecycle.js";
import { codePointLength, redactSensitiveText, truncateCodePoints } from "./redaction.js";
import { isFullResponse } from "./response_mode.js";
import {
  CaptureMemorySnapshotSchema,
  CompactSessionContextSchema,
  ScanMemoryThreatsSchema,
  ScrollSessionContextSchema,
  SessionLifecycleHookSchema,
  TriggerBackgroundReviewSchema,
} from "./tool_registry.js";
import { projectScopeRepository } from "./project_scope.js";

// ============================================================
// Tool Implementations
// ============================================================

/**
 * capture_memory_snapshot - Capture frozen snapshot for session
 */
export async function handleCaptureMemorySnapshot(args: any): Promise<string> {
  const { session_id } = CaptureMemorySnapshotSchema.parse(args);
  
  const result = await captureSessionSnapshot(session_id);
  
  return JSON.stringify({
    success: result.success,
    message: result.message,
    snapshot_info: result.snapshot_info,
  }, null, 2);
}

/**
 * session_lifecycle_hook - Session lifecycle event handler
 */
export async function handleSessionLifecycleHook(args: any): Promise<string> {
  const { event, session_id, project_key, metadata } = SessionLifecycleHookSchema.parse(args);
  const resolvedProjectKey = metadata?.project_key ?? project_key;
  const acceptedMetadata = metadata
    ? {
        ...(metadata.model ? { model: metadata.model } : {}),
        ...(metadata.platform ? { platform: metadata.platform } : {}),
        ...(metadata.user_id ? { user_id: metadata.user_id } : {}),
      }
    : undefined;
  
  const actions: string[] = [];
  
  switch (event) {
    case "start": {
      const scope = await projectScopeRepository.bind(session_id, resolvedProjectKey, acceptedMetadata);
      const captureResult = await captureSessionSnapshot(session_id);
      actions.push("Captured or refreshed memory snapshot");
      const background = await backgroundLifecycle.status();

      return JSON.stringify({
        success: captureResult.success,  // A13-fix: use actual result instead of hardcoded true
        event,
        session_id,
        scope,
        ...(acceptedMetadata ? { metadata: acceptedMetadata } : {}),
        actions_performed: actions,
        snapshot_info: captureResult.snapshot_info,
        background_lifecycle: background.runtime,
      }, null, 2);
    }

    case "end": {
      const releaseResult = releaseSessionSnapshot(session_id);
      let backgroundNotificationError: string | undefined;
      try {
        await backgroundLifecycle.notifySessionEnd(session_id);
      } catch {
        backgroundNotificationError = "background_state_unavailable";
      }
      await projectScopeRepository.release(session_id);
      // J3-fix: only push "Released" actions if release actually succeeded
      if (releaseResult.success) {
        actions.push("Released memory snapshot");
        actions.push("Session cleanup completed");
      } else {
        actions.push(`No active snapshot: ${releaseResult.message}`);
      }

      return JSON.stringify({
        success: releaseResult.success,  // C4: use actual result
        event,
        session_id,
        message: releaseResult.message,
        actions_performed: actions,
        background_lifecycle: (await backgroundLifecycle.status()).runtime,
        background_notification_error: backgroundNotificationError,
      }, null, 2);
    }

    case "pause":
    case "resume":
      return JSON.stringify({
        success: true,
        event,
        session_id,
        snapshot_changed: false,
        message: `Client lifecycle event recorded: ${event}. Codex execution state is not controlled by this MCP.`,
        background_lifecycle: (await backgroundLifecycle.status()).runtime,
      }, null, 2);
      
    default:
      throw new Error(`Unknown event: ${event}`);
  }
}

/**
 * scan_memory_threats - Scan memory board or user profile for threats
 */
function threatSeverity(threats: string[]): "high" | "medium" {
  return threats.some((id) =>
    /exfil|secret|backdoor|injection|override|c2|brainworm|forensic|bypass/.test(id)
  ) ? "high" : "medium";
}

export async function handleScanMemoryThreats(args: unknown): Promise<string> {
  const { target, scope } = ScanMemoryThreatsSchema.parse(args);
  const raw = await getRawMemoryStores();
  const entries = target === "memory" ? raw.memory_board.entries : raw.user_profile.entries;
  const details: Array<{
    entry_id: string;
    content_preview: string;
    threat_patterns: string[];
    severity: "high" | "medium";
    recommendation: string;
  }> = [];
  let threatsFound = 0;

  for (const entry of entries) {
    const threats = scanHeuristicThreats(entry.content, scope);
    if (threats.length === 0) continue;
    threatsFound += threats.length;
    details.push({
      entry_id: entry.id,
      content_preview: safeHeuristicText(entry.content).slice(0, 160),
      threat_patterns: threats,
      severity: threatSeverity(threats),
      recommendation: "Review the raw record through an explicit export and remove it from persistent memory.",
    });
  }

  return JSON.stringify({
    success: true,
    target,
    scope,
    scanned_entries: entries.length,
    threats_found: threatsFound,
    details,
  }, null, 2);
}

/**
 * scroll_session_context - Scroll session messages around anchor
 */
function boundedHistoricalTurn(turn: SessionTurn, maxChars: number): SessionTurn {
  const originalLength = codePointLength(turn.content);
  const safe = redactSensitiveText(turn.content, { strictHistorical: true });
  if (codePointLength(safe) <= maxChars) return { ...turn, content: safe };
  return {
    ...turn,
    content: truncateCodePoints(safe, maxChars),
    content_truncated: true,
    original_content_chars: originalLength,
  };
}

export async function handleScrollSessionContext(args: any): Promise<string> {
  const { session_id, around_turn_index, window, response_mode } = ScrollSessionContextSchema.parse(args);

  const windowResult = await listSessionTurnsAround(session_id, around_turn_index, window);
  if (windowResult === null) {
    return JSON.stringify({
      success: false,
      error: SESSION_STORAGE_UNAVAILABLE,
      session_id,
      anchor_turn_index: around_turn_index,
    }, null, 2);
  }

  const boundedTurns = windowResult.turns.map((turn) => boundedHistoricalTurn(
    turn,
    turn.turn_index === around_turn_index
      ? (isFullResponse(response_mode) ? 4_000 : 800)
      : (isFullResponse(response_mode) ? 1_200 : 300),
  ));

  return JSON.stringify({
    success: true,
    session_id,
    anchor_turn_index: around_turn_index,
    window,
    turns: boundedTurns,
    has_before: windowResult.has_before,
    has_after: windowResult.has_after,
    available_range: windowResult.available_range,
    message: boundedTurns.length === 0 ? "No turns found for session." : undefined,
  }, null, 2);
}

/**
 * compact_session_context - Build a bounded historical handoff for an explicit
 * client integration. It does not control Codex's actual context window.
 */
export async function handleCompactSessionContext(args: unknown): Promise<string> {
  const { session_id, max_turns, max_chars, preserve_recent_user_turns, response_mode } = CompactSessionContextSchema.parse(args);
  // Load the bounded session-tool maximum so the builder can report how many
  // loaded turns were omitted by the caller's smaller max_turns window.
  const turns = await listSessionTurns(session_id, 200);
  if (turns === null) {
    return JSON.stringify({ success: false, error: SESSION_STORAGE_UNAVAILABLE, session_id }, null, 2);
  }
  const reflections = await getSessionReflections(session_id, 50);
  const result = buildCompactionHandoff(
    turns,
    reflections,
    max_turns,
    max_chars,
    preserve_recent_user_turns,
  );
  const message = turns.length === 0
    ? "No stored turns found; returned an empty historical handoff."
    : undefined;
  if (!isFullResponse(response_mode)) {
    return JSON.stringify({
      success: true,
      session_id,
      reference_only: true,
      message,
      handoff: result.handoff,
      truncated: result.truncated,
      continuation: {
        first_turn_index: result.source.first_turn_index,
        last_turn_index: result.source.last_turn_index,
        turns_omitted: result.source.turns_omitted,
      },
    }, null, 2);
  }
  return JSON.stringify({
    success: true,
    session_id,
    reference_only: true,
    message,
    ...result,
  }, null, 2);
}

/**
 * trigger_background_review - Analyze reflections and extract heuristics
 */
export async function handleTriggerBackgroundReview(args: any): Promise<string> {
  const { action, session_id, review_scope, review_mode, auto_apply } = TriggerBackgroundReviewSchema.parse(args);
  const scope = session_id ? await projectScopeRepository.resolve({ session_id }) : undefined;
  if (action === "status") {
    const background = await backgroundLifecycle.status();
    const queue = await reviewQueueCounts(scope);
    return JSON.stringify({
      success: true,
      action,
      session_id,
      llm: getReviewReadinessStatus(),
      review_queue: {
        ...queue,
        ...(queue.pending > 0
          ? { admin_hint: "Use list_pending_mutations, then approve_pending_mutation to approve or reject candidates." }
          : {}),
      },
      background_lifecycle: {
        runtime: background.runtime,
        durable: {
          schema_version: background.durable.schema_version,
          dirty_session_count: background.durable.dirty_session_count,
          retrying_session_count: background.durable.retrying_session_count,
          lease: background.durable.lease,
          recent_runs: background.durable.recent_runs,
        },
      },
    }, null, 2);
  }
  const source = await getReviewSourceState(session_id!, review_scope);
  const readiness = getReviewReadinessStatus();
  return JSON.stringify(await backgroundLifecycle.runNow({
    session_id: session_id!,
    scope: scope ?? source.scope ?? "global",
    stage: review_mode === "deterministic" ? "deterministic" : (readiness.ready ? "llm" : "deterministic"),
    source_fingerprint: source.source_fingerprint,
    review_scope,
    review_mode,
    auto_apply,
  }), null, 2);
}
