// ============================================================
// Hermes Reflection MCP v19.0.0 - New Tool Handlers
// Tools: capture_memory_snapshot, session_lifecycle_hook, 
//        scan_memory_threats, scroll_session_context, compact_session_context,
//        trigger_background_review
// ============================================================
import { z } from "zod";
import { captureSessionSnapshot, releaseSessionSnapshot, } from "./storage_enhanced.js";
import { getSessionReflections, getRawMemoryStores, safeHeuristicText, scanHeuristicThreats, } from "../storage.js";
import { listSessionTurns, listSessionTurnsAround, SESSION_STORAGE_UNAVAILABLE } from "../session_storage.js";
import { buildCompactionHandoff } from "./compaction_handoff.js";
import { getReviewReadinessStatus, runReview } from "./review_engine.js";
import { backgroundLifecycle } from "./background_lifecycle.js";
import { codePointLength, redactSensitiveText, truncateCodePoints } from "./redaction.js";
// ============================================================
// Schemas
// ============================================================
export const CaptureMemorySnapshotSchema = z.object({
    session_id: z.string().min(1).max(200),
});
export const SessionLifecycleHookSchema = z.object({
    event: z.enum(["start", "end", "pause", "resume"]),
    session_id: z.string().min(1).max(200),
    metadata: z.object({
        model: z.string().max(100).optional(),
        platform: z.string().max(100).optional(),
        user_id: z.string().max(100).optional(),
    }).optional(),
});
export const ScanMemoryThreatsSchema = z.object({
    target: z.enum(["memory", "user"]),
    scope: z.enum(["all", "context", "strict"]).default("strict"),
});
export const ScrollSessionContextSchema = z.object({
    session_id: z.string().min(1).max(200),
    around_turn_index: z.number().int().min(0),
    window: z.number().int().min(1).max(50).default(5),
});
export const TriggerBackgroundReviewSchema = z.object({
    action: z.enum(["run", "status"]).default("run"),
    session_id: z.string().min(1).max(200),
    review_scope: z.enum(["recent", "full"]).default("recent"),
    review_mode: z.enum(["deterministic", "llm", "auto"]).default("deterministic"),
    auto_apply: z.boolean().default(false),
});
export const CompactSessionContextSchema = z.object({
    session_id: z.string().min(1).max(200),
    max_turns: z.number().int().min(1).max(200).default(40),
    max_chars: z.number().int().min(500).max(20000).default(6000),
    preserve_recent_user_turns: z.number().int().min(1).max(5).default(3),
});
// ============================================================
// Tool Implementations
// ============================================================
/**
 * capture_memory_snapshot - Capture frozen snapshot for session
 */
export async function handleCaptureMemorySnapshot(args) {
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
export async function handleSessionLifecycleHook(args) {
    const { event, session_id } = SessionLifecycleHookSchema.parse(args);
    const actions = [];
    switch (event) {
        case "start": {
            const captureResult = await captureSessionSnapshot(session_id);
            actions.push("Captured or refreshed memory snapshot");
            const background = await backgroundLifecycle.status();
            return JSON.stringify({
                success: captureResult.success, // A13-fix: use actual result instead of hardcoded true
                event,
                session_id,
                actions_performed: actions,
                snapshot_info: captureResult.snapshot_info,
                background_lifecycle: background.runtime,
            }, null, 2);
        }
        case "end": {
            const releaseResult = releaseSessionSnapshot(session_id);
            let backgroundNotificationError;
            try {
                await backgroundLifecycle.notifySessionEnd(session_id);
            }
            catch {
                backgroundNotificationError = "background_state_unavailable";
            }
            // J3-fix: only push "Released" actions if release actually succeeded
            if (releaseResult.success) {
                actions.push("Released memory snapshot");
                actions.push("Session cleanup completed");
            }
            else {
                actions.push(`No active snapshot: ${releaseResult.message}`);
            }
            return JSON.stringify({
                success: releaseResult.success, // C4: use actual result
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
function threatSeverity(threats) {
    return threats.some((id) => /exfil|secret|backdoor|injection|override|c2|brainworm|forensic|bypass/.test(id)) ? "high" : "medium";
}
export async function handleScanMemoryThreats(args) {
    const { target, scope } = ScanMemoryThreatsSchema.parse(args);
    const raw = await getRawMemoryStores();
    const entries = target === "memory" ? raw.memory_board.entries : raw.user_profile.entries;
    const details = [];
    let threatsFound = 0;
    for (const entry of entries) {
        const threats = scanHeuristicThreats(entry.content, scope);
        if (threats.length === 0)
            continue;
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
function boundedHistoricalTurn(turn, maxChars) {
    const originalLength = codePointLength(turn.content);
    const safe = redactSensitiveText(turn.content, { strictHistorical: true });
    if (codePointLength(safe) <= maxChars)
        return { ...turn, content: safe };
    return {
        ...turn,
        content: truncateCodePoints(safe, maxChars),
        content_truncated: true,
        original_content_chars: originalLength,
    };
}
export async function handleScrollSessionContext(args) {
    const { session_id, around_turn_index, window } = ScrollSessionContextSchema.parse(args);
    const windowResult = await listSessionTurnsAround(session_id, around_turn_index, window);
    if (windowResult === null) {
        return JSON.stringify({
            success: false,
            error: SESSION_STORAGE_UNAVAILABLE,
            session_id,
            anchor_turn_index: around_turn_index,
        }, null, 2);
    }
    const boundedTurns = windowResult.turns.map((turn) => boundedHistoricalTurn(turn, turn.turn_index === around_turn_index ? 4_000 : 1_200));
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
export async function handleCompactSessionContext(args) {
    const { session_id, max_turns, max_chars, preserve_recent_user_turns } = CompactSessionContextSchema.parse(args);
    // Load the bounded session-tool maximum so the builder can report how many
    // loaded turns were omitted by the caller's smaller max_turns window.
    const turns = await listSessionTurns(session_id, 200);
    if (turns === null) {
        return JSON.stringify({ success: false, error: SESSION_STORAGE_UNAVAILABLE, session_id }, null, 2);
    }
    const reflections = await getSessionReflections(session_id, 50);
    const result = buildCompactionHandoff(turns, reflections, max_turns, max_chars, preserve_recent_user_turns);
    return JSON.stringify({
        success: true,
        session_id,
        reference_only: true,
        message: turns.length === 0
            ? "No stored turns found; returned an empty historical handoff."
            : undefined,
        ...result,
    }, null, 2);
}
/**
 * trigger_background_review - Analyze reflections and extract heuristics
 */
export async function handleTriggerBackgroundReview(args) {
    const { action, session_id, review_scope, review_mode, auto_apply } = TriggerBackgroundReviewSchema.parse(args);
    if (action === "status") {
        const background = await backgroundLifecycle.status();
        return JSON.stringify({
            success: true,
            action,
            session_id,
            llm: getReviewReadinessStatus(),
            background_lifecycle: {
                runtime: background.runtime,
                durable: {
                    schema_version: background.durable.schema_version,
                    dirty_session_count: background.durable.dirty_session_count,
                    lease: background.durable.lease,
                    recent_runs: background.durable.recent_runs,
                },
            },
        }, null, 2);
    }
    return JSON.stringify(await runReview({
        session_id,
        review_scope,
        review_mode,
        auto_apply,
    }), null, 2);
}
// ============================================================
// Tool Metadata (for index.ts integration)
// ============================================================
export const NEW_TOOL_DEFINITIONS = {
    capture_memory_snapshot: {
        name: "capture_memory_snapshot",
        description: "Capture a frozen, reference-only snapshot of Memory Board and User Profile for an explicit client session. Call this from a client integration at session start or when intentionally refreshing the snapshot.",
        inputSchema: {
            type: "object",
            required: ["session_id"],
            properties: {
                session_id: { type: "string", maxLength: 200, description: "Unique session identifier" },
            },
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    session_lifecycle_hook: {
        name: "session_lifecycle_hook",
        description: "Record an explicit client lifecycle event. Start captures or refreshes a snapshot, end releases it, and pause/resume do not control Codex execution state. Call explicitly from a client integration.",
        inputSchema: {
            type: "object",
            required: ["event", "session_id"],
            properties: {
                event: { type: "string", enum: ["start", "end", "pause", "resume"] },
                session_id: { type: "string", maxLength: 200 },
                metadata: {
                    type: "object",
                    properties: {
                        model: { type: "string", maxLength: 100 },
                        platform: { type: "string", maxLength: 100 },
                        user_id: { type: "string", maxLength: 100 },
                    },
                },
            },
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    scan_memory_threats: {
        name: "scan_memory_threats",
        description: "Scan memory board or user profile for threat patterns (injection, exfiltration, backdoors). Returns detailed list of suspicious entries. Use scope='strict' for comprehensive security audit.",
        inputSchema: {
            type: "object",
            required: ["target"],
            properties: {
                target: { type: "string", enum: ["memory", "user"], description: "Which memory target to scan" },
                scope: { type: "string", enum: ["all", "context", "strict"], default: "strict", description: "Threat detection scope" },
            },
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    scroll_session_context: {
        name: "scroll_session_context",
        description: "Retrieve session messages around a specific turn index. Returns anchor message ± window size with pagination info. Use for exploring conversation context.",
        inputSchema: {
            type: "object",
            required: ["session_id", "around_turn_index"],
            properties: {
                session_id: { type: "string", maxLength: 200 },
                around_turn_index: { type: "number", description: "Turn index to center the window around" },
                window: { type: "number", default: 5, minimum: 1, maximum: 50, description: "Number of messages before and after anchor" },
            },
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    trigger_background_review: {
        name: "trigger_background_review",
        description: "Review stored reflections for safe heuristic candidates. Deterministic preview remains the default; optional explicitly configured LLM review and status are available. auto_apply atomically upserts safe candidates and never modifies skills or User Profile/Memory Board entries.",
        inputSchema: {
            type: "object",
            required: ["session_id"],
            properties: {
                action: { type: "string", enum: ["run", "status"], default: "run", description: "Run a review or inspect sanitized background/LLM readiness." },
                session_id: { type: "string", maxLength: 200 },
                review_scope: { type: "string", enum: ["recent", "full"], default: "recent", description: "Recent analyzes last 10 reflections, full scans entire session" },
                review_mode: { type: "string", enum: ["deterministic", "llm", "auto"], default: "deterministic", description: "Deterministic is local; llm requires dedicated config; auto falls back to deterministic." },
                auto_apply: { type: "boolean", default: false, description: "If true, automatically apply extracted updates" },
            },
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
};
