// ============================================================
// Hermes Reflection MCP v19.0.0 - New Tool Handlers
// Tools: capture_memory_snapshot, session_lifecycle_hook, 
//        scan_memory_threats, scroll_session_context, compact_session_context,
//        trigger_background_review
// ============================================================
import { z } from "zod";
import { captureSessionSnapshot, releaseSessionSnapshot, } from "./storage_enhanced.js";
import { exportData, getSessionReflections, getRawMemoryStores, safeHeuristicText, scanHeuristicThreats, upsertHeuristicsBatch, } from "../storage.js";
import { listSessionTurns, listSessionTurnsAround, SESSION_STORAGE_UNAVAILABLE } from "../session_storage.js";
import { buildCompactionHandoff } from "./compaction_handoff.js";
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
    session_id: z.string().min(1).max(200),
    review_scope: z.enum(["recent", "full"]).default("recent"),
    auto_apply: z.boolean().default(false),
});
export const CompactSessionContextSchema = z.object({
    session_id: z.string().min(1).max(200),
    max_turns: z.number().int().min(1).max(200).default(40),
    max_chars: z.number().int().min(500).max(20000).default(6000),
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
            return JSON.stringify({
                success: captureResult.success, // A13-fix: use actual result instead of hardcoded true
                event,
                session_id,
                actions_performed: actions,
                snapshot_info: captureResult.snapshot_info,
            }, null, 2);
        }
        case "end": {
            const releaseResult = releaseSessionSnapshot(session_id);
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
    return JSON.stringify({
        success: true,
        session_id,
        anchor_turn_index: around_turn_index,
        window,
        turns: windowResult.turns,
        has_before: windowResult.has_before,
        has_after: windowResult.has_after,
        available_range: windowResult.available_range,
        message: windowResult.turns.length === 0 ? "No turns found for session." : undefined,
    }, null, 2);
}
/**
 * compact_session_context - Build a bounded historical handoff for an explicit
 * client integration. It does not control Codex's actual context window.
 */
export async function handleCompactSessionContext(args) {
    const { session_id, max_turns, max_chars } = CompactSessionContextSchema.parse(args);
    // Load the bounded session-tool maximum so the builder can report how many
    // loaded turns were omitted by the caller's smaller max_turns window.
    const turns = await listSessionTurns(session_id, 200);
    if (turns === null) {
        return JSON.stringify({ success: false, error: SESSION_STORAGE_UNAVAILABLE, session_id }, null, 2);
    }
    const reflections = await getSessionReflections(session_id, 50);
    const result = buildCompactionHandoff(turns, reflections, max_turns, max_chars);
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
    const { session_id, review_scope, auto_apply } = TriggerBackgroundReviewSchema.parse(args);
    const MAX_FULL_REFLECTIONS = 200;
    const MAX_CANDIDATES = 50;
    const store = await exportData();
    const allSessionReflections = store.reflections
        .filter((reflection) => reflection.session_id === session_id)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const reviewedReflections = review_scope === "recent"
        ? allSessionReflections.slice(-10)
        : allSessionReflections.slice(-MAX_FULL_REFLECTIONS);
    const existingHeuristics = new Set(store.heuristics
        .filter((heuristic) => !heuristic.superseded_by)
        .map((heuristic) => normalizeCandidateText(heuristic.heuristic)));
    const candidateHeuristics = buildReviewHeuristicCandidates(reviewedReflections, existingHeuristics)
        .slice(0, MAX_CANDIDATES);
    const skipped = candidateHeuristics.filter((candidate) => candidate.skipped_reason);
    const safeCandidates = candidateHeuristics.filter((candidate) => !candidate.skipped_reason);
    const applied = { heuristics_added: 0, heuristic_ids: [] };
    let autoApplyBlocked;
    if (auto_apply && store.metadata?.write_approval === true) {
        autoApplyBlocked = "write_approval_enabled";
    }
    else if (auto_apply && safeCandidates.length > 0) {
        const saved = await upsertHeuristicsBatch(safeCandidates.map((candidate) => ({
            domain: candidate.domain,
            heuristic: candidate.heuristic,
            source_task: `background_review:${session_id}`,
            session_id,
            confidence: 0.65,
            tags: candidate.tags,
        })));
        applied.heuristics_added = saved.length;
        applied.heuristic_ids = saved.map((item) => item.id);
    }
    return JSON.stringify({
        success: true,
        session_id,
        review_scope,
        auto_apply,
        auto_apply_blocked: autoApplyBlocked,
        capabilities: {
            heuristic_candidates: true,
            memory_candidates: false,
            user_profile_candidates: false,
            skill_suggestions: false,
        },
        limits: {
            max_recent_reflections: 10,
            max_full_reflections: MAX_FULL_REFLECTIONS,
            max_candidates: MAX_CANDIDATES,
        },
        source_reflection_ids: reviewedReflections.map((reflection) => reflection.id),
        candidate_heuristics: candidateHeuristics,
        candidate_memory_entries: [],
        candidate_user_profile_entries: [],
        skipped_items: skipped,
        applied,
    }, null, 2);
}
// ============================================================
// Helper Functions
// ============================================================
function normalizeCandidateText(text) {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
}
function buildReviewHeuristicCandidates(reflections, existingHeuristics) {
    const seen = new Set(existingHeuristics);
    const candidates = [];
    for (const reflection of reflections) {
        for (const lesson of reflection.lessons_learned) {
            const heuristic = lesson.trim();
            if (!heuristic)
                continue;
            const normalized = normalizeCandidateText(heuristic);
            if (seen.has(normalized))
                continue;
            seen.add(normalized);
            const threatPatterns = scanHeuristicThreats(heuristic, "strict");
            candidates.push({
                heuristic: threatPatterns.length > 0 ? safeHeuristicText(heuristic) : heuristic,
                source_reflection_id: reflection.id,
                domain: reflection.domain,
                tags: [...new Set([...(reflection.tags ?? []), "background-review"])],
                skipped_reason: threatPatterns.length > 0 ? "threat_pattern_detected" : undefined,
                threat_patterns: threatPatterns.length > 0 ? threatPatterns : undefined,
            });
        }
    }
    return candidates;
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
        description: "Deterministically review stored reflections for safe heuristic candidates. Preview is the default; auto_apply atomically upserts safe heuristics. This tool does not call an LLM, modify skills, or generate Memory Board/User Profile candidates.",
        inputSchema: {
            type: "object",
            required: ["session_id"],
            properties: {
                session_id: { type: "string", maxLength: 200 },
                review_scope: { type: "string", enum: ["recent", "full"], default: "recent", description: "Recent analyzes last 10 reflections, full scans entire session" },
                auto_apply: { type: "boolean", default: false, description: "If true, automatically apply extracted updates" },
            },
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
};
