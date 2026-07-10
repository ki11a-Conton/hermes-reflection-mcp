// ============================================================
// Hermes Reflection MCP persistent storage
// ============================================================
import { appendFile, copyFile, open, readFile, rename, writeFile, mkdir, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { scanForThreats, firstThreatMessage, containsInvisibleChars, MAX_SCAN_CHARS } from "./src/threat_patterns.js";
import { withFileLock } from "./src/file_lock.js";
const WINDOWS_RENAME_RETRIES = 5;
export const STORE_DIR = join(homedir(), ".hermes-reflection");
const STORE_PATH = join(STORE_DIR, "store.json");
const REFLECTIONS_PATH = join(STORE_DIR, "reflections.jsonl");
const RESOLVED_QUESTIONS_PATH = join(STORE_DIR, "resolved_questions.json");
export const VERSION = "19.2.0";
export const HEURISTIC_DEDUP_THRESHOLD = 0.75;
const WORLD_FACT_DEDUP_THRESHOLD = 0.65;
export const HEURISTIC_MAX_COUNT = 500;
const HEURISTIC_PRUNE_CONFIDENCE = 0.2;
export const REFLECTION_SOFT_LIMIT = 2000;
const SEARCH_MIN_TEXT_SCORE = 0.05;
const EBBINGHAUS_BASE_STABILITY_DAYS = 30;
const EBBINGHAUS_MAX_STABILITY_DAYS = 365;
const AVG_HEURISTIC_DOC_LEN = 20;
const AVG_REFLECTION_DOC_LEN = 60;
const CJK_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;
const CJK_REPLACE_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;
const STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "shall", "can", "need", "dare",
    "how", "what", "when", "where", "who", "which", "why", "that", "this",
    "it", "its", "if", "as", "up", "out", "so", "not", "no", "all",
]);
// ============================================================
// Phase 1 Security Enhancement - Threat Detection
// Using new comprehensive threat_patterns.ts module (45+ patterns)
// ============================================================
// Create local aliases with old names for backward compatibility
const scanHeuristicThreats = scanForThreats;
const firstHeuristicThreatMessage = firstThreatMessage;
// Re-export for external use with old names
export { scanHeuristicThreats, firstHeuristicThreatMessage, containsInvisibleChars };
// Enhanced threat check - returns sanitized text with [BLOCKED] marker if unsafe
export function safeHeuristicText(text) {
    const threat = firstThreatMessage(text, "strict");
    if (!threat)
        return text;
    // Check invisible chars
    if (containsInvisibleChars(text)) {
        return `[BLOCKED: contains invisible Unicode characters. Hidden from normal retrieval/list/search output.]`;
    }
    const threats = scanForThreats(text.slice(0, MAX_SCAN_CHARS), "strict");
    return `[BLOCKED: heuristic contained threat pattern(s): ${threats.join(", ")}. Hidden from normal retrieval/list/search output; use export_data(collection:"heuristics") to inspect the raw record.]`;
}
// Validation helper - throws error if text contains threats
function assertHeuristicTextSafe(text) {
    const threat = firstThreatMessage(text, "strict");
    if (threat)
        throw new Error(threat);
}
function sanitizeHeuristicForOutput(heuristic) {
    return {
        ...heuristic,
        heuristic: safeHeuristicText(heuristic.heuristic),
        tags: [...(heuristic.tags ?? [])],
        contradiction_notes: [...(heuristic.contradiction_notes ?? [])],
        supersedes: [...(heuristic.supersedes ?? [])],
    };
}
let mutationQueue = Promise.resolve();
let resolvedQuestionsMutationQueue = Promise.resolve();
let storeCache = null;
let _mutationStore = null;
let _storeIndexDirty = false;
const CACHE_TTL_MS = 500;
let _resolvedQuestionsCache = null;
let _mutationResolvedIndex = null;
const RESOLVED_QUESTIONS_CACHE_TTL_MS = 500;
function buildSessionIndex(reflections) {
    const index = new Map();
    for (let i = 0; i < reflections.length; i++) {
        const sessionId = reflections[i].session_id;
        const existing = index.get(sessionId);
        if (existing) {
            existing.push(i);
        }
        else {
            index.set(sessionId, [i]);
        }
    }
    return index;
}
function checkIsAscending(reflections) {
    for (let i = 1; i < reflections.length; i++) {
        if (reflections[i].timestamp < reflections[i - 1].timestamp)
            return false;
    }
    return true;
}
function buildOpenQuestionsIndex(reflections) {
    const index = new Map();
    for (const reflection of reflections) {
        let count = 0;
        for (const question of reflection.open_questions) {
            if (!question.resolved)
                count++;
        }
        if (count > 0)
            index.set(reflection.id, count);
    }
    return index;
}
function buildSessionHeuristicsCount(heuristics) {
    const index = new Map();
    for (const heuristic of heuristics) {
        if (heuristic.superseded_by)
            continue;
        if (!heuristic.session_id)
            continue;
        index.set(heuristic.session_id, (index.get(heuristic.session_id) ?? 0) + 1);
    }
    return index;
}
function buildHeuristicSearchTextIndex(heuristics) {
    const index = new Map();
    for (const heuristic of heuristics) {
        index.set(heuristic.id, heuristicSearchText(heuristic));
    }
    return index;
}
function buildReflectionSearchTextIndex(reflections) {
    const index = new Map();
    for (const reflection of reflections) {
        index.set(reflection.id, reflectionSearchText(reflection));
    }
    return index;
}
function normalizeTags(tags) {
    return (tags ?? []).map((tag) => tag.toLowerCase().trim()).filter(Boolean);
}
function buildTagSetIndex(items) {
    const index = new Map();
    for (const item of items) {
        index.set(item.id, new Set(normalizeTags(item.tags)));
    }
    return index;
}
function buildReflectionByIdIndex(reflections) {
    const index = new Map();
    for (const reflection of reflections) {
        index.set(reflection.id, reflection);
    }
    return index;
}
function buildHeuristicByIdIndex(heuristics) {
    const index = new Map();
    for (const heuristic of heuristics) {
        index.set(heuristic.id, heuristic);
    }
    return index;
}
function countUnresolvedOpenQuestions(reflection) {
    let count = 0;
    for (const question of reflection.open_questions) {
        if (!question.resolved)
            count++;
    }
    return count;
}
function cloneSessionIndex(index) {
    const cloned = new Map();
    for (const [sessionId, positions] of index) {
        cloned.set(sessionId, [...positions]);
    }
    return cloned;
}
function buildStoreCache(store, storeFileSize, reflectionsFileSize, loadedAt = Date.now()) {
    return {
        store,
        loadedAt,
        storeFileSize,
        reflectionsFileSize,
        reflectionsAreAscending: checkIsAscending(store.reflections),
        sessionIndex: buildSessionIndex(store.reflections),
        reflectionsWithOpenQuestionsCount: buildOpenQuestionsIndex(store.reflections),
        sessionHeuristicsCount: buildSessionHeuristicsCount(store.heuristics),
        heuristicSearchTextById: buildHeuristicSearchTextIndex(store.heuristics),
        reflectionSearchTextById: buildReflectionSearchTextIndex(store.reflections),
        heuristicTagSetById: buildTagSetIndex(store.heuristics),
        reflectionTagSetById: buildTagSetIndex(store.reflections),
        reflectionById: buildReflectionByIdIndex(store.reflections),
        heuristicById: buildHeuristicByIdIndex(store.heuristics),
    };
}
async function refreshStoreCacheAfterMutation(store, reflectionHint, previousReflectionCount, oldCache) {
    const loadedAt = Date.now();
    const storeFileSize = await fileSize(STORE_PATH);
    if (!oldCache) {
        return buildStoreCache(store, storeFileSize, await fileSize(REFLECTIONS_PATH), loadedAt);
    }
    if (reflectionHint === "append-only" && previousReflectionCount <= store.reflections.length) {
        const newReflections = store.reflections.slice(previousReflectionCount);
        const sessionIndex = cloneSessionIndex(oldCache.sessionIndex);
        const reflectionsWithOpenQuestionsCount = new Map(oldCache.reflectionsWithOpenQuestionsCount);
        const reflectionSearchTextById = new Map(oldCache.reflectionSearchTextById);
        const reflectionTagSetById = new Map(oldCache.reflectionTagSetById);
        const reflectionById = new Map(oldCache.reflectionById);
        for (let i = 0; i < newReflections.length; i++) {
            const reflection = newReflections[i];
            const reflectionIndex = previousReflectionCount + i;
            const sessionRefs = sessionIndex.get(reflection.session_id);
            if (sessionRefs) {
                sessionRefs.push(reflectionIndex);
            }
            else {
                sessionIndex.set(reflection.session_id, [reflectionIndex]);
            }
            const unresolvedCount = countUnresolvedOpenQuestions(reflection);
            if (unresolvedCount > 0) {
                reflectionsWithOpenQuestionsCount.set(reflection.id, unresolvedCount);
            }
            else {
                reflectionsWithOpenQuestionsCount.delete(reflection.id);
            }
            reflectionSearchTextById.set(reflection.id, reflectionSearchText(reflection));
            reflectionTagSetById.set(reflection.id, new Set(normalizeTags(reflection.tags)));
            reflectionById.set(reflection.id, reflection);
        }
        const lastOldReflection = previousReflectionCount > 0
            ? store.reflections[previousReflectionCount - 1]
            : undefined;
        const firstNewReflection = newReflections[0];
        return {
            store,
            loadedAt,
            storeFileSize,
            reflectionsFileSize: await fileSize(REFLECTIONS_PATH),
            reflectionsAreAscending: previousReflectionCount === 0
                ? checkIsAscending(store.reflections) // B7-fix: validate order on previously-empty store
                : oldCache.reflectionsAreAscending
                    && checkIsAscending(newReflections) // I4-fix: validate new reflections are internally ascending
                    && (!lastOldReflection || !firstNewReflection || firstNewReflection.timestamp >= lastOldReflection.timestamp),
            sessionIndex,
            reflectionsWithOpenQuestionsCount,
            sessionHeuristicsCount: buildSessionHeuristicsCount(store.heuristics),
            heuristicSearchTextById: buildHeuristicSearchTextIndex(store.heuristics),
            reflectionSearchTextById,
            heuristicTagSetById: buildTagSetIndex(store.heuristics),
            reflectionTagSetById,
            reflectionById,
            heuristicById: buildHeuristicByIdIndex(store.heuristics),
        };
    }
    if (reflectionHint === "none") {
        return {
            store,
            loadedAt,
            storeFileSize,
            reflectionsFileSize: oldCache.reflectionsFileSize,
            reflectionsAreAscending: oldCache.reflectionsAreAscending,
            sessionIndex: oldCache.sessionIndex,
            reflectionsWithOpenQuestionsCount: oldCache.reflectionsWithOpenQuestionsCount,
            sessionHeuristicsCount: buildSessionHeuristicsCount(store.heuristics),
            heuristicSearchTextById: buildHeuristicSearchTextIndex(store.heuristics),
            reflectionSearchTextById: oldCache.reflectionSearchTextById,
            heuristicTagSetById: buildTagSetIndex(store.heuristics),
            reflectionTagSetById: oldCache.reflectionTagSetById,
            reflectionById: oldCache.reflectionById,
            heuristicById: buildHeuristicByIdIndex(store.heuristics),
        };
    }
    return buildStoreCache(store, storeFileSize, await fileSize(REFLECTIONS_PATH), loadedAt);
}
async function getCachedStoreEntry() {
    const now = Date.now();
    if (storeCache && now - storeCache.loadedAt < CACHE_TTL_MS) {
        return storeCache;
    }
    if (storeCache) {
        try {
            const storeFileSize = await fileSize(STORE_PATH);
            const reflectionsFileSize = await fileSize(REFLECTIONS_PATH);
            if (storeFileSize === storeCache.storeFileSize &&
                reflectionsFileSize === storeCache.reflectionsFileSize) {
                storeCache = { ...storeCache, loadedAt: now };
                return storeCache;
            }
        }
        catch {
            // Fall through and reload from disk.
        }
    }
    const store = await loadStore();
    storeCache = buildStoreCache(store, await fileSize(STORE_PATH), await fileSize(REFLECTIONS_PATH));
    return storeCache;
}
async function getCachedStore() {
    return (await getCachedStoreEntry()).store;
}
function invalidateStoreCache() {
    storeCache = null;
    _mutationStore = null;
    invalidateResolvedQuestionsCache();
}
async function getCachedResolvedQuestions() {
    const now = Date.now();
    // Within TTL window: return cache directly, no file stat
    if (_resolvedQuestionsCache && now - _resolvedQuestionsCache.loadedAt < RESOLVED_QUESTIONS_CACHE_TTL_MS) {
        return _resolvedQuestionsCache.index;
    }
    // TTL expired but cache exists: stat once to check freshness
    if (_resolvedQuestionsCache) {
        try {
            const currentSize = await fileSize(RESOLVED_QUESTIONS_PATH);
            if (currentSize === _resolvedQuestionsCache.fileSize) {
                _resolvedQuestionsCache.loadedAt = now;
                return _resolvedQuestionsCache.index;
            }
        }
        catch { /* stat failed or file missing, fall through to reload */ }
    }
    // No cache or size changed or stat failed: full reload
    const index = await loadResolvedQuestions();
    _resolvedQuestionsCache = {
        index,
        loadedAt: Date.now(),
        fileSize: await fileSize(RESOLVED_QUESTIONS_PATH),
    };
    return index;
}
function invalidateResolvedQuestionsCache() {
    _resolvedQuestionsCache = null;
    _mutationResolvedIndex = null;
}
async function ensureStoreDir() {
    if (!existsSync(STORE_DIR)) {
        await mkdir(STORE_DIR, { recursive: true });
    }
}
export async function loadStore() {
    await ensureStoreDir();
    if (!existsSync(STORE_PATH)) {
        const store = emptyStore();
        store.reflections = await loadReflections();
        return store;
    }
    try {
        const raw = await readFile(STORE_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        const legacyReflections = (parsed.reflections ?? []).map((reflection) => normalizeReflectionFrame(reflection));
        if (legacyReflections.length > 0) {
            if (!existsSync(REFLECTIONS_PATH)) {
                await replaceReflectionsFile(legacyReflections);
            }
            await writeStoreIndex({
                sessions: normalizeSessionsRecord(parsed.sessions),
                reflections: [],
                affordance_gaps: (parsed.affordance_gaps ?? []).map((gap) => normalizeAffordanceGapRecord(gap)),
                heuristics: (parsed.heuristics ?? []),
                version: parsed.version ?? VERSION,
                memory_board: normalizeMemoryBoard(parsed.memory_board),
                user_profile: normalizeMemoryBoard(parsed.user_profile, 1800),
                metadata: parsed.metadata ? { ...parsed.metadata, pending_mutations: parsed.metadata.pending_mutations ?? [] } : undefined,
            }, false);
        }
        return {
            sessions: normalizeSessionsRecord(parsed.sessions),
            reflections: await loadReflections(legacyReflections),
            affordance_gaps: (parsed.affordance_gaps ?? []).map((gap) => normalizeAffordanceGapRecord(gap)),
            heuristics: (parsed.heuristics ?? []).map(normalizeHeuristicRecord),
            version: parsed.version ?? VERSION,
            memory_board: normalizeMemoryBoard(parsed.memory_board),
            user_profile: normalizeMemoryBoard(parsed.user_profile, 1800),
            metadata: parsed.metadata ? { ...parsed.metadata, pending_mutations: parsed.metadata.pending_mutations ?? [] } : undefined,
        };
    }
    catch (error) {
        await preserveCorruptStore(error);
        return emptyStore();
    }
}
function emptyStore() {
    const now = new Date().toISOString();
    return {
        sessions: {},
        reflections: [],
        affordance_gaps: [],
        heuristics: [],
        version: VERSION,
        memory_board: { entries: [], char_limit: 2200, used_chars: 0 },
        user_profile: { entries: [], char_limit: 1800, used_chars: 0 },
        metadata: {
            created_at: now,
            last_written_at: now,
            write_count: 0,
            pending_mutations: [],
        },
    };
}
const VALID_FAILURE_MODES = new Set([
    "incorrect_task_interpretation",
    "incorrect_world_assumption",
    "missing_affordance",
    "tool_limitation_or_misbehavior",
    "exhausted_or_misdirected_search",
    "success",
]);
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function stringArray(value) {
    return asArray(value).filter((item) => typeof item === "string");
}
function normalizeTaskOutcome(value) {
    return value === "partial" || value === "failure" || value === "success" ? value : "success";
}
function normalizeFailureMode(value) {
    return typeof value === "string" && VALID_FAILURE_MODES.has(value)
        ? value
        : "success";
}
function normalizeOpenQuestion(value) {
    const priority = value.priority === "high" || value.priority === "low" || value.priority === "medium"
        ? value.priority
        : "medium";
    return {
        question: typeof value.question === "string" ? value.question : "",
        priority,
        requires_environment_interaction: value.requires_environment_interaction === true,
        ...(value.resolved === true ? { resolved: true } : {}),
        ...(typeof value.resolved_at === "string" ? { resolved_at: value.resolved_at } : {}),
        ...(typeof value.resolved_by === "string" ? { resolved_by: value.resolved_by } : {}),
    };
}
function normalizeWorldModelUpdate(value) {
    return {
        fact: typeof value.fact === "string" ? value.fact : "",
        polarity: value.polarity === "negate" ? "negate" : "affirm",
        source: typeof value.source === "string" ? value.source : "",
        evidence: typeof value.evidence === "string" ? value.evidence : "",
    };
}
function normalizeToolInsight(value) {
    return {
        tool: typeof value.tool === "string" ? value.tool : "",
        insight: typeof value.insight === "string" ? value.insight : "",
        status: value.status === "confirmed" ? "confirmed" : "needs_verification",
        evidence: typeof value.evidence === "string" ? value.evidence : "",
    };
}
function normalizeContextForget(value) {
    return {
        item: typeof value.item === "string" ? value.item : "",
        reason: typeof value.reason === "string" ? value.reason : "",
    };
}
function normalizeReflectionFrame(input) {
    const taskState = (input.task_state ?? {});
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : "legacy";
    return {
        id: typeof input.id === "string" && input.id ? input.id : generateId(),
        timestamp: typeof input.timestamp === "string" && input.timestamp ? input.timestamp : new Date().toISOString(),
        session_id: sessionId,
        task_goal: typeof input.task_goal === "string" ? input.task_goal : "",
        task_outcome: normalizeTaskOutcome(input.task_outcome),
        failure_mode: normalizeFailureMode(input.failure_mode),
        task_state: {
            summary: typeof taskState.summary === "string" ? taskState.summary : "",
            summary_sections: Array.isArray(taskState.summary_sections) ? taskState.summary_sections : undefined,
            immediate_blockers: stringArray(taskState.immediate_blockers),
            active_hypotheses: stringArray(taskState.active_hypotheses),
            proven_safe_paths: stringArray(taskState.proven_safe_paths),
            exhausted_search: stringArray(taskState.exhausted_search),
        },
        world_model_updates: asArray(input.world_model_updates).map(normalizeWorldModelUpdate),
        tool_insights: asArray(input.tool_insights).map(normalizeToolInsight),
        context_forget: asArray(input.context_forget).map(normalizeContextForget),
        open_questions: asArray(input.open_questions).map(normalizeOpenQuestion),
        lessons_learned: stringArray(input.lessons_learned),
        affordance_gaps: asArray(input.affordance_gaps).map((gap) => normalizeAffordanceGapRecord(gap, sessionId)),
        domain: typeof input.domain === "string" ? normalizeDomain(input.domain) : "general",
        tags: stringArray(input.tags).map((tag) => tag.toLowerCase().trim()).filter(Boolean),
        context_notes: typeof input.context_notes === "string" && input.context_notes.trim() ? input.context_notes.slice(0, 2000) : undefined,
    };
}
function normalizeHeuristicRecord(h) {
    const now = new Date().toISOString();
    return {
        id: typeof h.id === "string" && h.id ? h.id : generateId(),
        created_at: typeof h.created_at === "string" && h.created_at ? h.created_at : now,
        updated_at: typeof h.updated_at === "string" && h.updated_at ? h.updated_at : now,
        domain: typeof h.domain === "string" ? normalizeDomain(h.domain) : "general",
        heuristic: typeof h.heuristic === "string" ? h.heuristic : "",
        source_task: typeof h.source_task === "string" ? h.source_task : "",
        session_id: typeof h.session_id === "string" ? h.session_id : undefined,
        reinforcement_count: typeof h.reinforcement_count === "number" ? h.reinforcement_count : 1,
        contradiction_count: typeof h.contradiction_count === "number" ? h.contradiction_count : 0,
        contradiction_notes: stringArray(h.contradiction_notes),
        confidence: typeof h.confidence === "number" ? Math.max(0, Math.min(1, h.confidence)) : 0.6,
        retrieval_count: typeof h.retrieval_count === "number" ? h.retrieval_count : 0,
        last_retrieved_at: typeof h.last_retrieved_at === "string" ? h.last_retrieved_at : undefined,
        supersedes: stringArray(h.supersedes),
        superseded_by: typeof h.superseded_by === "string" ? h.superseded_by : undefined,
        pinned: h.pinned === true ? true : undefined,
        version: typeof h.version === "number" ? h.version : 1,
        tags: stringArray(h.tags).map((tag) => tag.toLowerCase().trim()).filter(Boolean),
    };
}
function normalizeMemoryBoard(input, defaultCharLimit = 2200) {
    const entries = Array.isArray(input?.entries)
        ? input.entries.map((e) => ({
            id: typeof e.id === "string" && e.id ? e.id : generateId(),
            content: typeof e.content === "string" ? e.content : "",
            created_at: typeof e.created_at === "string" && e.created_at ? e.created_at : new Date().toISOString(),
            updated_at: typeof e.updated_at === "string" && e.updated_at ? e.updated_at : new Date().toISOString(),
            source_reflection_id: typeof e.source_reflection_id === "string" && e.source_reflection_id ? e.source_reflection_id : undefined,
        }))
        : [];
    const raw_limit = typeof input?.char_limit === "number" && Number.isFinite(input.char_limit) && input.char_limit > 0
        ? input.char_limit
        : defaultCharLimit;
    const char_limit = Math.min(raw_limit, 100000); // B16: cap to prevent unbounded growth
    const used_chars = entries.reduce((sum, e) => sum + e.content.length, 0);
    return { entries, char_limit, used_chars };
}
function normalizeAffordanceGapRecord(input, fallbackSessionId = "legacy") {
    const now = new Date().toISOString();
    return {
        id: typeof input.id === "string" && input.id ? input.id : generateId(),
        timestamp: typeof input.timestamp === "string" && input.timestamp ? input.timestamp : now,
        session_id: typeof input.session_id === "string" && input.session_id ? input.session_id : fallbackSessionId,
        goal_description: typeof input.goal_description === "string" ? input.goal_description : "",
        failure_description: typeof input.failure_description === "string" ? input.failure_description : "",
        missing_capability: typeof input.missing_capability === "string" ? input.missing_capability : "",
        available_tools: stringArray(input.available_tools),
        occurrence_count: typeof input.occurrence_count === "number" && Number.isFinite(input.occurrence_count) && input.occurrence_count > 0 ? input.occurrence_count : 1,
        suggested_solution: typeof input.suggested_solution === "string" && input.suggested_solution ? input.suggested_solution : undefined,
        resolved: input.resolved === true ? true : undefined,
        resolved_at: typeof input.resolved_at === "string" ? input.resolved_at : undefined,
        resolution_notes: typeof input.resolution_notes === "string" ? input.resolution_notes : undefined,
    };
}
function normalizeSessionRecord(id, input) {
    return {
        id,
        started_at: typeof input.started_at === "string" && input.started_at ? input.started_at : new Date().toISOString(),
        reflection_count: typeof input.reflection_count === "number" && Number.isFinite(input.reflection_count) && input.reflection_count >= 0 ? input.reflection_count : 0,
        affordance_gap_count: typeof input.affordance_gap_count === "number" && Number.isFinite(input.affordance_gap_count) && input.affordance_gap_count >= 0 ? input.affordance_gap_count : 0,
    };
}
function normalizeSessionsRecord(input) {
    return Object.fromEntries(Object.entries(input ?? {}).map(([id, session]) => [id, normalizeSessionRecord(id, session)]));
}
// B15: removed dead code saveStore
async function writeStoreIndex(store, incrementWriteCount) {
    await ensureStoreDir();
    store.version = VERSION;
    if (incrementWriteCount && _storeIndexDirty) {
        const now = new Date().toISOString();
        if (store.metadata) {
            store.metadata.last_written_at = now;
            store.metadata.write_count = (store.metadata.write_count ?? 0) + 1;
        }
        else {
            store.metadata = { created_at: now, last_written_at: now, write_count: 1 };
        }
        _storeIndexDirty = false;
    }
    const tmpPath = join(STORE_DIR, `store.json.tmp.${process.pid}.${Date.now()}.${randomUUID()}`);
    const indexStore = { ...store, reflections: undefined };
    await writeFile(tmpPath, JSON.stringify(indexStore, null, 2), "utf-8");
    await replaceFileAtomically(tmpPath, STORE_PATH);
}
async function replaceFileAtomically(tmpPath, targetPath) {
    let lastError;
    // Phase 1: direct rename with retries
    for (let attempt = 0; attempt < WINDOWS_RENAME_RETRIES; attempt++) {
        try {
            await rename(tmpPath, targetPath);
            return;
        }
        catch (error) {
            lastError = error;
            if (!isWindowsRenameRetryable(error))
                break;
            if (attempt < WINDOWS_RENAME_RETRIES - 1) {
                await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
            }
        }
    }
    // Phase 2: if still failing with retryable Windows errors, delete target
    // first, then retry the rename up to WINDOWS_RENAME_RETRIES times.
    if (isWindowsRenameRetryable(lastError)) {
        let targetRemoved = false;
        try {
            await rm(targetPath, { force: true });
            targetRemoved = true;
        }
        catch (error) {
            lastError = error;
        }
        if (targetRemoved) {
            for (let attempt = 0; attempt < WINDOWS_RENAME_RETRIES; attempt++) {
                try {
                    await rename(tmpPath, targetPath);
                    return;
                }
                catch (error) {
                    lastError = error;
                    if (!isWindowsRenameRetryable(error))
                        break;
                    if (attempt < WINDOWS_RENAME_RETRIES - 1) {
                        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
                    }
                }
            }
        }
    }
    // Cleanup: delete temp file only; never remove a valid target
    try {
        await rm(tmpPath, { force: true });
    }
    catch {
        // Best-effort cleanup
    }
    const ctx = `replaceFileAtomically failed to move ${tmpPath} -> ${targetPath}`;
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${ctx}: ${detail}`);
}
function isWindowsRenameRetryable(error) {
    if (!(error instanceof Error))
        return false;
    const code = error.code;
    return code === "EPERM" || code === "EACCES" || code === "EEXIST";
}
async function loadReflections(fallback = []) {
    const normalizedFallback = fallback.map((reflection) => normalizeReflectionFrame(reflection));
    if (!existsSync(REFLECTIONS_PATH))
        return normalizedFallback;
    const raw = await readFile(REFLECTIONS_PATH, "utf-8");
    const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const results = [];
    let skipped = 0;
    for (const line of lines) {
        try {
            results.push(normalizeReflectionFrame(JSON.parse(line)));
        }
        catch {
            skipped++;
            console.error(`[hermes] skipped corrupt reflection line (${skipped} total)`);
        }
    }
    if (skipped > 0) {
        await preservePartialReflectionsFile();
        console.error(`[hermes] loadReflections: ${results.length} ok, ${skipped} corrupt lines skipped.`);
    }
    return results.length > 0 ? results : normalizedFallback;
}
function parseReflectionLines(lines) {
    const results = [];
    let skipped = 0;
    for (const line of lines) {
        try {
            results.push(normalizeReflectionFrame(JSON.parse(line)));
        }
        catch {
            skipped++;
            console.error(`[hermes] skipped corrupt reflection line (${skipped} total)`);
        }
    }
    if (skipped > 0) {
        console.error(`[hermes] parseReflectionLines: ${results.length} ok, ${skipped} corrupt lines skipped.`);
    }
    return results;
}
async function loadRecentReflections(limit) {
    if (!existsSync(REFLECTIONS_PATH))
        return [];
    const fileStat = await stat(REFLECTIONS_PATH);
    if (fileStat.size === 0)
        return [];
    let chunkSize = Math.max(limit * 2048, 8192);
    while (chunkSize < fileStat.size) {
        const parsed = await readRecentReflectionChunk(fileStat.size, chunkSize);
        if (parsed.length >= limit)
            return parsed.slice(-limit).reverse();
        chunkSize *= 2;
    }
    return (await loadReflections()).slice(-limit).reverse();
}
async function readRecentReflectionChunk(fileSize, chunkSize) {
    const start = Math.max(0, fileSize - chunkSize);
    const length = fileSize - start;
    const file = await open(REFLECTIONS_PATH, "r");
    try {
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, start);
        const text = buffer.toString("utf-8");
        const newlineIndex = start > 0 ? text.indexOf("\n") : -1;
        const safeText = newlineIndex >= 0 ? text.slice(newlineIndex + 1) : text;
        const lines = safeText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        return parseReflectionLines(lines);
    }
    finally {
        await file.close();
    }
}
async function replaceReflectionsFile(reflections) {
    await ensureStoreDir();
    const tmpPath = join(STORE_DIR, `reflections.jsonl.tmp.${process.pid}.${Date.now()}.${randomUUID()}`);
    const content = reflections.map((reflection) => JSON.stringify(reflection)).join("\n");
    await writeFile(tmpPath, content ? `${content}\n` : "", "utf-8");
    await replaceFileAtomically(tmpPath, REFLECTIONS_PATH);
}
async function appendReflectionsFile(reflections) {
    if (reflections.length === 0)
        return;
    await ensureStoreDir();
    const content = reflections.map((reflection) => JSON.stringify(reflection)).join("\n") + "\n";
    await appendFile(REFLECTIONS_PATH, content, "utf-8");
}
async function persistStoreAfterMutation(store, reflectionHint, previousReflectionCount) {
    if (reflectionHint === "rewrite") {
        await replaceReflectionsFile(store.reflections);
    }
    else if (reflectionHint === "append-only") {
        await appendReflectionsFile(store.reflections.slice(previousReflectionCount));
    }
    await writeStoreIndex(store, true);
}
async function preserveCorruptStore(error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = `corrupt.${stamp}.${randomUUID()}`;
    const storeBackupPath = join(STORE_DIR, `store.json.${suffix}`);
    const reflectionsBackupPath = join(STORE_DIR, `reflections.jsonl.${suffix}`);
    try {
        await copyFile(STORE_PATH, storeBackupPath);
    }
    catch (copyError) {
        console.error("Hermes Reflection store was invalid JSON and could not be copied.", copyError);
    }
    if (existsSync(REFLECTIONS_PATH)) {
        try {
            await copyFile(REFLECTIONS_PATH, reflectionsBackupPath);
        }
        catch (copyError) {
            console.error("Hermes Reflection reflections.jsonl could not be copied during corrupt-store backup.", copyError);
        }
    }
    console.error(`[hermes] corrupt store preserved with suffix .${suffix}`, error);
}
async function preservePartialReflectionsFile() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(STORE_DIR, `reflections.jsonl.partial.${stamp}.${randomUUID()}`);
    try {
        await copyFile(REFLECTIONS_PATH, backupPath);
    }
    catch (copyError) {
        console.error("[hermes] corrupt reflections.jsonl backup failed.", copyError);
    }
}
async function mutateStore(mutator, reflectionHint = "none", operationName, operationPayload) {
    const run = mutationQueue.then(() => withFileLock(STORE_PATH, async () => {
        // A process-local cache is insufficient when multiple MCP processes share
        // one HOME. Reload only after acquiring the cross-process transaction lock.
        _mutationStore = await loadStore();
        // Write-approval gate: queue mutation instead of executing.
        // This uses the live _mutationStore because it must persist immediately.
        if (operationName && _mutationStore.metadata?.write_approval === true) {
            const store = _mutationStore;
            const metadata = store.metadata;
            const pending = metadata.pending_mutations ?? [];
            const pendingId = randomUUID();
            const pendingMutation = {
                id: pendingId,
                created_at: new Date().toISOString(),
                operation: operationName,
                preview: `Queued ${operationName} pending approval`,
                payload: operationPayload ?? {},
            };
            pending.push(pendingMutation);
            metadata.pending_mutations = pending;
            _storeIndexDirty = true; // B6-fix: ensure write_count/last_written_at update
            await persistStoreAfterMutation(store, "none", store.reflections.length);
            storeCache = await refreshStoreCacheAfterMutation(store, "none", store.reflections.length, storeCache);
            const approvalError = new Error(`Operation "${operationName}" was queued for approval (pending_mutation_id: ${pendingId}). ` +
                `Use approve_pending_mutation to approve or reject.`);
            approvalError.isPendingApproval = true;
            approvalError.pendingMutationId = pendingId;
            throw approvalError;
        }
        // Normal mutation: work on a clone so a partial or failed mutator
        // cannot corrupt the live cached _mutationStore.
        const store = structuredClone(_mutationStore);
        const previousReflectionCount = store.reflections.length;
        let result;
        try {
            result = await mutator(store);
            _storeIndexDirty = true;
        }
        finally {
            // Invalidate caches keyed by the previous live store (stale after mutation)
            _heuristicDedupCache.delete(_mutationStore);
            _affordanceGapIndex.delete(_mutationStore);
            _affordanceGapByIdCache.delete(_mutationStore);
            _heuristicSearchTextCache.delete(_mutationStore);
            _heuristicTagSetCache.delete(_mutationStore);
            _heuristicByIdCache.delete(_mutationStore);
            _reflectionByIdCache.delete(_mutationStore);
            // Also invalidate any caches that might have been attached to the clone
            _heuristicDedupCache.delete(store);
            _affordanceGapIndex.delete(store);
            _affordanceGapByIdCache.delete(store);
            _heuristicSearchTextCache.delete(store);
            _heuristicTagSetCache.delete(store);
            _heuristicByIdCache.delete(store);
            _reflectionByIdCache.delete(store);
        }
        await persistStoreAfterMutation(store, reflectionHint, previousReflectionCount);
        // Commit the working clone only after persistence succeeds
        _mutationStore = store;
        storeCache = await refreshStoreCacheAfterMutation(store, reflectionHint, previousReflectionCount, storeCache);
        return result;
    }));
    mutationQueue = run.then(() => undefined, (error) => {
        // Approval-queued events are normal control flow, not storage faults
        if (error instanceof Error && error.isPendingApproval === true) {
            return;
        }
        console.error("[hermes] storage error:", error instanceof Error ? error.message : String(error));
        _mutationStore = null;
        invalidateStoreCache();
    });
    return run;
}
function ensureSession(store, sessionId) {
    if (!store.sessions[sessionId]) {
        store.sessions[sessionId] = {
            id: sessionId,
            started_at: new Date().toISOString(),
            reflection_count: 0,
            affordance_gap_count: 0,
        };
    }
    return store.sessions[sessionId];
}
function upsertAffordanceGapMut(store, gap) {
    const capability = normalizeCapability(gap.missing_capability);
    const existing = getOrBuildAffordanceGapIndex(store).get(capability);
    if (existing) {
        existing.occurrence_count++;
        existing.timestamp = gap.timestamp;
        existing.goal_description = gap.goal_description;
        existing.failure_description = gap.failure_description;
        existing.available_tools = gap.available_tools;
        if (gap.suggested_solution) {
            existing.suggested_solution = gap.suggested_solution;
        }
        else if (existing.occurrence_count >= 3 && !existing.suggested_solution) {
            existing.suggested_solution = generateGapSuggestion(existing);
        }
        return { gap: existing, isNew: false };
    }
    const newGap = { ...gap, occurrence_count: 1 };
    if (!newGap.suggested_solution)
        delete newGap.suggested_solution;
    store.affordance_gaps.push(newGap);
    getOrBuildAffordanceGapIndex(store).set(capability, newGap);
    getOrBuildAffordanceGapByIdIndex(store).set(newGap.id, newGap);
    return { gap: newGap, isNew: true };
}
function generateGapSuggestion(gap) {
    const goal = gap.goal_description.trim();
    const failure = gap.failure_description.trim();
    const capability = gap.missing_capability.trim();
    const lower = `${failure} ${capability}`.toLowerCase();
    if (lower.includes("permission") || lower.includes("denied") || lower.includes("approval")) {
        return `Could not "${goal}" because "${capability}" is unavailable or blocked by permissions. Suggested fix: add a permission-aware wrapper, document the approval path, or route this step to a tool that can request access.`;
    }
    if (lower.includes("file") || lower.includes("directory") || lower.includes("path")) {
        return `Could not "${goal}" because file/path capability "${capability}" is missing. Suggested fix: add a dedicated filesystem helper that validates paths, handles errors, and reports the exact file operation outcome.`;
    }
    if (lower.includes("search") || lower.includes("retrieve") || lower.includes("rag")) {
        return `Could not "${goal}" because retrieval capability "${capability}" is missing. Suggested fix: add a focused search/retrieval tool with source citations and a clear no-result response.`;
    }
    return `Could not "${goal}" because "${capability}" is unavailable. Failure context: "${failure}". Suggested fix: add a dedicated tool or skill wrapper for this capability, or record the required external step before retrying.`;
}
export async function upsertAffordanceGap(gap, operationName) {
    return mutateStore((store) => {
        const { gap: saved, isNew } = upsertAffordanceGapMut(store, gap);
        if (isNew) {
            const session = ensureSession(store, gap.session_id);
            session.affordance_gap_count++;
        }
        return { ...saved, available_tools: [...saved.available_tools] };
    }, "none", operationName, { gap });
}
// Write-lifetime dedup cache: keyed by ReflectionStore instance, maps normalized
// domain to [{id, tokens}]. Survives across upsertHeuristicMut calls within a
// single mutateStore write-lifetime (including batchSaveReflections loops).
// Invalidated whenever heuristics are structurally mutated (prune, text-change
// replacement, delete, clear, import).
const _heuristicDedupCache = new WeakMap();
// Write-lifetime affordance-gap index: keyed by ReflectionStore instance, maps
// normalized missing_capability to the AffordanceGap entry. Survives across
// upsertAffordanceGapMut calls within a single mutateStore write-lifetime.
// Invalidated alongside _heuristicDedupCache in the mutateStore finally block.
const _affordanceGapIndex = new WeakMap();
// Write-lifetime affordance-gap by-id cache: keyed by ReflectionStore instance,
// maps AffordanceGap id to the AffordanceGap entry. Survives across
// upsertAffordanceGapMut calls within a single mutateStore write-lifetime.
// Invalidated alongside _heuristicDedupCache in the mutateStore finally block.
const _affordanceGapByIdCache = new WeakMap();
// Write-lifetime heuristic search-text cache: keyed by ReflectionStore instance,
// maps heuristic id to precomputed search text. Invalidated alongside
// _heuristicDedupCache in the mutateStore finally block.
const _heuristicSearchTextCache = new WeakMap();
// Write-lifetime heuristic tag cache for mutating retrieval paths.
const _heuristicTagSetCache = new WeakMap();
// Write-lifetime heuristic by-id cache: keyed by ReflectionStore instance, maps
// heuristic id to the Heuristic object. Survives across mutating calls within a
// single mutateStore write-lifetime. Invalidated alongside _heuristicDedupCache
// in the mutateStore finally block.
const _heuristicByIdCache = new WeakMap();
function getOrBuildHeuristicByIdMap(store) {
    let map = _heuristicByIdCache.get(store);
    if (map)
        return map;
    map = new Map();
    for (const h of store.heuristics) {
        map.set(h.id, h);
    }
    _heuristicByIdCache.set(store, map);
    return map;
}
// Write-lifetime reflection by-id cache: keyed by ReflectionStore instance, maps
// reflection id to the ReflectionFrame object. Survives across mutating calls
// within a single mutateStore write-lifetime. Invalidated alongside
// _heuristicDedupCache in the mutateStore finally block.
const _reflectionByIdCache = new WeakMap();
function getOrBuildReflectionByIdMap(store) {
    let map = _reflectionByIdCache.get(store);
    if (map)
        return map;
    map = new Map();
    for (const r of store.reflections) {
        map.set(r.id, r);
    }
    _reflectionByIdCache.set(store, map);
    return map;
}
function getOrBuildHeuristicSearchTextMap(store) {
    let map = _heuristicSearchTextCache.get(store);
    if (map)
        return map;
    map = new Map();
    for (const heuristic of store.heuristics) {
        map.set(heuristic.id, heuristicSearchText(heuristic));
    }
    _heuristicSearchTextCache.set(store, map);
    return map;
}
function getOrBuildHeuristicTagSetMap(store) {
    let map = _heuristicTagSetCache.get(store);
    if (map)
        return map;
    map = buildTagSetIndex(store.heuristics);
    _heuristicTagSetCache.set(store, map);
    return map;
}
function getOrBuildAffordanceGapIndex(store) {
    let index = _affordanceGapIndex.get(store);
    if (index)
        return index;
    index = new Map();
    for (const gap of store.affordance_gaps) {
        index.set(normalizeCapability(gap.missing_capability), gap);
    }
    _affordanceGapIndex.set(store, index);
    return index;
}
function getOrBuildAffordanceGapByIdIndex(store) {
    let map = _affordanceGapByIdCache.get(store);
    if (map)
        return map;
    map = new Map();
    for (const gap of store.affordance_gaps) {
        map.set(gap.id, gap);
    }
    _affordanceGapByIdCache.set(store, map);
    return map;
}
function getOrBuildDedupCache(store) {
    let cache = _heuristicDedupCache.get(store);
    if (cache)
        return cache;
    cache = new Map();
    for (const h of store.heuristics) {
        if (h.superseded_by)
            continue;
        const d = normalizeDomain(h.domain);
        const entry = cache.get(d) ?? [];
        entry.push({ id: h.id, tokens: new Set(tokenizeSimilarityText(h.heuristic)), ref: h });
        cache.set(d, entry);
    }
    _heuristicDedupCache.set(store, cache);
    return cache;
}
function upsertHeuristicMut(store, input) {
    assertHeuristicTextSafe(input.heuristic);
    const domain = normalizeDomain(input.domain);
    // Use a token-level pre-filter via write-lifetime cache before calling the
    // full BM25 similarity. This avoids re-tokenizing all active heuristics on
    // every call in bulk_reflect hot paths.
    const cache = getOrBuildDedupCache(store);
    const domainEntries = cache.get(domain) ?? [];
    const inputTokens = new Set(tokenizeSimilarityText(input.heuristic));
    let existing;
    for (const entry of domainEntries) {
        let overlap = 0;
        for (const t of inputTokens) {
            if (entry.tokens.has(t))
                overlap++;
        }
        const union = inputTokens.size + entry.tokens.size - overlap;
        if (union === 0 || overlap / union < 0.3)
            continue;
        if (similarity(entry.ref.heuristic, input.heuristic) > HEURISTIC_DEDUP_THRESHOLD) {
            existing = entry.ref;
            break;
        }
    }
    if (existing) {
        existing.reinforcement_count++;
        existing.confidence = Math.min(1.0, existing.confidence + 0.05);
        existing.updated_at = new Date().toISOString();
        if (input.tags && input.tags.length > 0) {
            const existingTagSet = new Set(existing.tags.map((t) => t.toLowerCase().trim()));
            for (const tag of input.tags) {
                const normalizedTag = tag.toLowerCase().trim();
                if (normalizedTag && !existingTagSet.has(normalizedTag)) {
                    existing.tags.push(tag);
                    existingTagSet.add(normalizedTag);
                }
            }
        }
        return existing;
    }
    const now = new Date().toISOString();
    const heuristic = {
        id: generateId(),
        created_at: now,
        updated_at: now,
        reinforcement_count: 1,
        contradiction_count: 0,
        contradiction_notes: [],
        retrieval_count: 0,
        supersedes: [],
        version: 1,
        domain,
        heuristic: input.heuristic,
        source_task: input.source_task,
        session_id: input.session_id,
        confidence: input.confidence ?? 0.6,
        tags: input.tags ?? [],
    };
    store.heuristics.push(heuristic);
    // Register new heuristic in the dedup cache so subsequent calls in the same
    // write-lifetime see it without a full cache rebuild.
    domainEntries.push({ id: heuristic.id, tokens: inputTokens, ref: heuristic });
    cache.set(domain, domainEntries);
    return heuristic;
}
function computeMemoryBoardUsedChars(entries) {
    return entries.reduce((sum, entry) => sum + entry.content.length, 0);
}
function computeConsolidationHints(entries) {
    const hints = [];
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const score = similarity(entries[i].content, entries[j].content, 1.5, 0.75, AVG_HEURISTIC_DOC_LEN);
            if (score > 0.5) {
                const estimatedSavings = Math.min(entries[i].content.length, entries[j].content.length) - 20;
                if (estimatedSavings > 0) {
                    hints.push({
                        entry_ids: [entries[i].id, entries[j].id],
                        reason: `Entries are ${Math.round(score * 100)}% similar and may be consolidated.`,
                        estimated_savings: estimatedSavings,
                    });
                }
            }
        }
    }
    return hints.sort((a, b) => b.estimated_savings - a.estimated_savings).slice(0, 3);
}
function findMemoryBoardMatches(entries, oldText) {
    return entries.filter((entry) => entry.content.includes(oldText));
}
function applyMemoryBoardOperation(board, operation) {
    const newContent = operation.content ?? "";
    if ((operation.action === "add" || operation.action === "replace") && newContent.trim().length === 0) {
        return {
            success: false,
            result: {
                success: false,
                error: "content must be a non-empty string for action 'add' or 'replace'.",
                current_entries: board.entries,
                used_chars: board.used_chars,
                char_limit: board.char_limit,
            },
        };
    }
    // B8-fix: reject content containing the entry separator "\n§\n" to prevent parsing corruption
    if ((operation.action === "add" || operation.action === "replace") && newContent.includes("\n§\n")) {
        return {
            success: false,
            result: {
                success: false,
                error: "content must not contain the entry separator '\\n§\\n'.",
                current_entries: board.entries,
                used_chars: board.used_chars,
                char_limit: board.char_limit,
            },
        };
    }
    if (operation.action === "add" || operation.action === "replace") {
        const threat = firstHeuristicThreatMessage(newContent, "strict");
        if (threat) {
            return {
                success: false,
                result: {
                    success: false,
                    error: `Memory board write blocked: ${threat}`,
                    current_entries: board.entries,
                    used_chars: board.used_chars,
                    char_limit: board.char_limit,
                },
            };
        }
    }
    if (operation.action === "add") {
        if (board.entries.some((entry) => entry.content === newContent)) {
            return { success: true, note: "no duplicate added" };
        }
        const newUsed = board.used_chars + newContent.length;
        if (newUsed > board.char_limit) {
            return {
                success: false,
                result: {
                    success: false,
                    error: `Memory at ${board.used_chars}/${board.char_limit} chars. Adding (${newContent.length} chars) would exceed limit by ${newUsed - board.char_limit} chars. Replace or remove existing entries first.`,
                    current_entries: board.entries,
                    used_chars: board.used_chars,
                    char_limit: board.char_limit,
                    overflow_chars: newUsed - board.char_limit,
                    current_entry_count: board.entries.length,
                    suggestion: "Try removing or consolidating existing entries to free up space.",
                    consolidation_hints: computeConsolidationHints(board.entries),
                },
            };
        }
        const now = new Date().toISOString();
        board.entries.push({ id: randomUUID(), content: newContent, created_at: now, updated_at: now });
        board.used_chars = newUsed;
        return { success: true };
    }
    if (operation.action === "replace") {
        if (!operation.old_text) {
            return { success: false, result: { success: false, error: "replace requires old_text", current_entries: board.entries } };
        }
        const matches = findMemoryBoardMatches(board.entries, operation.old_text);
        if (matches.length === 0) {
            return { success: false, result: { success: false, error: `No entry matches old_text: "${operation.old_text}"`, current_entries: board.entries } };
        }
        if (matches.length > 1) {
            return { success: false, result: { success: false, error: `old_text "${operation.old_text}" matches ${matches.length} entries; use a more specific substring`, current_entries: board.entries } };
        }
        const match = matches[0];
        const index = board.entries.findIndex((entry) => entry.id === match.id);
        // I5-fix: check for duplicate content (excluding the entry being replaced)
        if (board.entries.some((entry) => entry.id !== match.id && entry.content === newContent)) {
            return { success: true, note: "no duplicate added (content already exists)" };
        }
        const newUsed = board.used_chars - match.content.length + newContent.length;
        if (newUsed > board.char_limit) {
            return {
                success: false,
                result: {
                    success: false,
                    error: `Replacement would exceed limit (${newUsed}/${board.char_limit}) by ${newUsed - board.char_limit} chars.`,
                    current_entries: board.entries,
                    used_chars: board.used_chars,
                    char_limit: board.char_limit,
                    overflow_chars: newUsed - board.char_limit,
                    current_entry_count: board.entries.length,
                    suggestion: "Try replacing with shorter content or removing other entries first.",
                    consolidation_hints: computeConsolidationHints(board.entries),
                },
            };
        }
        board.entries[index] = { ...match, content: newContent, updated_at: new Date().toISOString() };
        board.used_chars = newUsed;
        return { success: true };
    }
    if (operation.action === "remove") {
        if (!operation.old_text) {
            return { success: false, result: { success: false, error: "remove requires old_text", current_entries: board.entries } };
        }
        const matches = findMemoryBoardMatches(board.entries, operation.old_text);
        if (matches.length === 0) {
            return { success: false, result: { success: false, error: `No entry matches old_text: "${operation.old_text}"`, current_entries: board.entries } };
        }
        if (matches.length > 1) {
            return { success: false, result: { success: false, error: `old_text "${operation.old_text}" matches ${matches.length} entries; use a more specific substring`, current_entries: board.entries } };
        }
        const match = matches[0];
        board.entries = board.entries.filter((entry) => entry.id !== match.id);
        board.used_chars = computeMemoryBoardUsedChars(board.entries);
        return { success: true };
    }
    return { success: false, result: { success: false, error: `Unsupported memory board action: ${operation.action}` } };
}
export async function memoryBoardWrite(action, content, oldText, operationName) {
    return mutateStore((store) => {
        const board = store.memory_board ?? normalizeMemoryBoard(undefined);
        store.memory_board = board;
        board.used_chars = computeMemoryBoardUsedChars(board.entries);
        const newContent = content ?? "";
        if ((action === "add" || action === "replace") && newContent.trim().length === 0) {
            throw new Error("content must be a non-empty string for action 'add' or 'replace'.");
        }
        // B8-fix: reject content containing the entry separator "\n§\n"
        if ((action === "add" || action === "replace") && newContent.includes("\n§\n")) {
            return {
                success: false,
                error: "content must not contain the entry separator '\\n§\\n'.",
                entries: board.entries,
                used_chars: board.used_chars,
                char_limit: board.char_limit,
            };
        }
        if (action === "add" || action === "replace") {
            const threat = firstHeuristicThreatMessage(newContent, "strict");
            if (threat) {
                return {
                    success: false,
                    error: `Memory board write blocked: ${threat}`,
                    entries: board.entries,
                    used_chars: board.used_chars,
                    char_limit: board.char_limit,
                };
            }
        }
        if (action === "add") {
            if (board.entries.some((entry) => entry.content === newContent)) {
                return {
                    success: true,
                    note: "no duplicate added",
                    entries: board.entries,
                    used_chars: board.used_chars,
                    char_limit: board.char_limit,
                };
            }
            const newUsed = board.used_chars + newContent.length;
            if (newUsed > board.char_limit) {
                return {
                    success: false,
                    error: `Memory at ${board.used_chars}/${board.char_limit} chars. Adding (${newContent.length} chars) would exceed limit by ${newUsed - board.char_limit} chars. Replace or remove existing entries first.`,
                    current_entries: board.entries,
                    used_chars: board.used_chars,
                    char_limit: board.char_limit,
                    overflow_chars: newUsed - board.char_limit,
                    current_entry_count: board.entries.length,
                    suggestion: "Try removing or consolidating existing entries to free up space.",
                    consolidation_hints: computeConsolidationHints(board.entries),
                };
            }
            const now = new Date().toISOString();
            board.entries.push({
                id: randomUUID(),
                content: newContent,
                created_at: now,
                updated_at: now,
            });
            board.used_chars = newUsed;
            return { success: true, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
        }
        if (action === "replace") {
            // I3-fix: return structured error instead of throw, consistent with add action
            if (!oldText)
                return { success: false, error: "replace requires old_text", entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
            const matches = findMemoryBoardMatches(board.entries, oldText);
            if (matches.length === 0)
                return { success: false, error: `No entry matches old_text: "${oldText}"`, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
            if (matches.length > 1)
                return { success: false, error: `old_text "${oldText}" matches ${matches.length} entries; use a more specific substring`, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
            const match = matches[0];
            const index = board.entries.findIndex((entry) => entry.id === match.id);
            const newUsed = board.used_chars - match.content.length + newContent.length;
            if (newUsed > board.char_limit) {
                return {
                    success: false,
                    error: `Replacement would exceed limit (${newUsed}/${board.char_limit}) by ${newUsed - board.char_limit} chars.`,
                    current_entries: board.entries,
                    used_chars: board.used_chars,
                    char_limit: board.char_limit,
                    overflow_chars: newUsed - board.char_limit,
                    current_entry_count: board.entries.length,
                    suggestion: "Try replacing with shorter content or removing other entries first.",
                    consolidation_hints: computeConsolidationHints(board.entries),
                };
            }
            board.entries[index] = { ...match, content: newContent, updated_at: new Date().toISOString() };
            board.used_chars = newUsed;
            return { success: true, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
        }
        if (action === "remove") {
            // I3-fix: return structured error instead of throw
            if (!oldText)
                return { success: false, error: "remove requires old_text", entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
            const matches = findMemoryBoardMatches(board.entries, oldText);
            if (matches.length === 0)
                return { success: false, error: `No entry matches old_text: "${oldText}"`, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
            if (matches.length > 1)
                return { success: false, error: `old_text "${oldText}" matches ${matches.length} entries; use a more specific substring`, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
            const match = matches[0];
            board.entries = board.entries.filter((entry) => entry.id !== match.id);
            board.used_chars = computeMemoryBoardUsedChars(board.entries);
            return { success: true, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
        }
        throw new Error(`Unsupported memory board action: ${action}`);
    }, "none", operationName, { action, content, old_text: oldText });
}
export async function memoryBoardBatchWrite(operations, operationName) {
    return mutateStore((store) => {
        const current = store.memory_board ?? normalizeMemoryBoard(undefined);
        const working = {
            entries: current.entries.map((entry) => ({ ...entry })),
            char_limit: current.char_limit,
            used_chars: computeMemoryBoardUsedChars(current.entries),
        };
        const notes = [];
        for (const operation of operations) {
            const applied = applyMemoryBoardOperation(working, operation);
            if (!applied.success) {
                return {
                    ...applied.result,
                    current_entries: current.entries,
                    current_entry_count: current.entries.length, // I6-fix: override with original count for consistency
                    used_chars: computeMemoryBoardUsedChars(current.entries),
                    char_limit: current.char_limit,
                };
            }
            if (applied.note)
                notes.push(applied.note);
        }
        working.used_chars = computeMemoryBoardUsedChars(working.entries);
        if (working.used_chars > working.char_limit) {
            return {
                success: false,
                error: `Batch would exceed limit (${working.used_chars}/${working.char_limit}) by ${working.used_chars - working.char_limit} chars.`,
                current_entries: current.entries,
                consolidation_hints: computeConsolidationHints(current.entries),
                used_chars: computeMemoryBoardUsedChars(current.entries),
                char_limit: current.char_limit,
                overflow_chars: working.used_chars - working.char_limit,
                current_entry_count: current.entries.length,
                suggestion: "Reduce the total size of your batch operations by removing or consolidating entries first.",
            };
        }
        store.memory_board = working;
        return {
            success: true,
            entries: working.entries,
            used_chars: working.used_chars,
            char_limit: working.char_limit,
            operations_applied: operations.length,
            note: notes.length > 0 ? [...new Set(notes)].join("; ") : undefined,
        };
    }, "none", operationName, {
        operations: operations.map((operation) => ({
            action: operation.action,
            content: operation.content,
            old_text: operation.old_text,
        })),
    });
}
export async function memoryBoardRead() {
    const cache = await getCachedStoreEntry();
    const board = cache.store.memory_board ?? normalizeMemoryBoard(undefined);
    const usedChars = computeMemoryBoardUsedChars(board.entries);
    const pct = board.char_limit > 0 ? Math.round((usedChars / board.char_limit) * 100) : 0;
    const header = [
        "==============================",
        `MEMORY BOARD [${pct}% - ${usedChars}/${board.char_limit} chars]`,
        "==============================",
    ].join("\n");
    if (board.entries.length === 0)
        return `${header}\n(empty)`;
    return `${header}\n${board.entries.map((entry) => safeHeuristicText(entry.content)).join("\n§\n")}`;
}
export async function userProfileWrite(action, content, oldText, operationName) {
    return mutateStore((store) => {
        const profile = store.user_profile ?? normalizeMemoryBoard(undefined, 1800);
        store.user_profile = profile;
        profile.used_chars = computeMemoryBoardUsedChars(profile.entries);
        const result = applyMemoryBoardOperation(profile, { action, content, old_text: oldText });
        if (!result.success)
            return result.result;
        return {
            success: true,
            entries: profile.entries,
            used_chars: profile.used_chars,
            char_limit: profile.char_limit,
            note: result.note,
        };
    }, "none", operationName, { action, content, old_text: oldText });
}
export async function userProfileBatchWrite(operations, operationName) {
    return mutateStore((store) => {
        const current = store.user_profile ?? normalizeMemoryBoard(undefined, 1800);
        const working = {
            entries: current.entries.map((entry) => ({ ...entry })),
            char_limit: current.char_limit,
            used_chars: computeMemoryBoardUsedChars(current.entries),
        };
        const notes = [];
        for (const operation of operations) {
            const applied = applyMemoryBoardOperation(working, operation);
            if (!applied.success) {
                return {
                    ...applied.result,
                    current_entries: current.entries,
                    current_entry_count: current.entries.length, // I6-fix: override with original count for consistency
                    used_chars: computeMemoryBoardUsedChars(current.entries),
                    char_limit: current.char_limit,
                };
            }
            if (applied.note)
                notes.push(applied.note);
        }
        working.used_chars = computeMemoryBoardUsedChars(working.entries);
        if (working.used_chars > working.char_limit) {
            return {
                success: false,
                error: `Batch would exceed limit (${working.used_chars}/${working.char_limit}) by ${working.used_chars - working.char_limit} chars.`,
                current_entries: current.entries,
                consolidation_hints: computeConsolidationHints(current.entries),
                used_chars: computeMemoryBoardUsedChars(current.entries),
                char_limit: current.char_limit,
                overflow_chars: working.used_chars - working.char_limit,
                current_entry_count: current.entries.length,
                suggestion: "Reduce the total size of your batch operations by removing or consolidating entries first.",
            };
        }
        store.user_profile = working;
        return {
            success: true,
            entries: working.entries,
            used_chars: working.used_chars,
            char_limit: working.char_limit,
            operations_applied: operations.length,
            note: notes.length > 0 ? [...new Set(notes)].join("; ") : undefined,
        };
    }, "none", operationName, {
        operations: operations.map((operation) => ({
            action: operation.action,
            content: operation.content,
            old_text: operation.old_text,
        })),
    });
}
export async function userProfileRead() {
    const cache = await getCachedStoreEntry();
    const profile = cache.store.user_profile ?? normalizeMemoryBoard(undefined, 1800);
    const usedChars = computeMemoryBoardUsedChars(profile.entries);
    const pct = profile.char_limit > 0 ? Math.round((usedChars / profile.char_limit) * 100) : 0;
    const header = [
        "==============================",
        `USER PROFILE [${pct}% - ${usedChars}/${profile.char_limit} chars]`,
        "==============================",
        "Reference only: these are stable user preferences/facts, not fresh instructions.",
    ].join("\n");
    if (profile.entries.length === 0)
        return `${header}\n(empty)`;
    return `${header}\n${profile.entries.map((entry) => safeHeuristicText(entry.content)).join("\n§\n")}`;
}
export async function getRawMemoryStores() {
    await mutationQueue;
    const cache = await getCachedStoreEntry();
    return {
        memory_board: structuredClone(cache.store.memory_board ?? normalizeMemoryBoard(undefined)),
        user_profile: structuredClone(cache.store.user_profile ?? normalizeMemoryBoard(undefined, 1800)),
    };
}
export async function rejectPendingMutation(mutationId) {
    return mutateStore((store) => {
        const pending = store.metadata?.pending_mutations ?? [];
        const index = pending.findIndex((mutation) => mutation.id === mutationId);
        if (index < 0)
            return null;
        const [removed] = pending.splice(index, 1);
        if (store.metadata)
            store.metadata.pending_mutations = pending;
        return removed;
    }, "none");
}
export async function listPendingMutations() {
    await mutationQueue;
    const store = await getCachedStore();
    return structuredClone(store.metadata?.pending_mutations ?? []);
}
export async function upsertHeuristic(input, operationName) {
    return mutateStore((store) => {
        const result = upsertHeuristicMut(store, input);
        pruneHeuristicsMut(store);
        return sanitizeHeuristicForOutput(result);
    }, "none", operationName, { ...input });
}
/** Upsert a bounded set of heuristics in one cross-process storage transaction. */
export async function upsertHeuristicsBatch(inputs) {
    return mutateStore((store) => {
        const saved = inputs.map((input) => upsertHeuristicMut(store, input));
        if (store.heuristics.length > HEURISTIC_MAX_COUNT)
            pruneHeuristicsMut(store);
        return saved.map((item) => sanitizeHeuristicForOutput(item));
    });
}
export async function saveReflectionAndHeuristics(reflection, lessons, domain, sourceTask, confidence, tags, operationName) {
    return mutateStore((store) => {
        const session = ensureSession(store, reflection.session_id);
        session.reflection_count++;
        store.reflections.push(reflection);
        for (const gap of reflection.affordance_gaps) {
            const { isNew } = upsertAffordanceGapMut(store, gap);
            if (isNew)
                session.affordance_gap_count++;
        }
        const safeLessons = lessons.filter((lesson) => firstHeuristicThreatMessage(lesson, "strict") === null);
        for (const lesson of safeLessons) {
            upsertHeuristicMut(store, {
                domain,
                heuristic: lesson,
                source_task: sourceTask,
                session_id: reflection.session_id,
                confidence,
                tags,
            });
        }
        if (store.heuristics.length > HEURISTIC_MAX_COUNT)
            pruneHeuristicsMut(store);
        return {
            session: { ...session },
            reflectionCount: store.reflections.length,
            nearSoftLimit: store.reflections.length >= REFLECTION_SOFT_LIMIT,
        };
    }, "append-only", operationName, { reflection, lessons, domain, sourceTask, confidence, tags });
}
function saveReflectionAndHeuristicsMut(store, input) {
    const session = ensureSession(store, input.reflection.session_id);
    session.reflection_count++;
    store.reflections.push(input.reflection);
    for (const gap of input.reflection.affordance_gaps) {
        const { isNew } = upsertAffordanceGapMut(store, gap);
        if (isNew)
            session.affordance_gap_count++;
    }
    const safeLessons = input.lessons.filter((lesson) => firstHeuristicThreatMessage(lesson, "strict") === null);
    for (const lesson of safeLessons) {
        upsertHeuristicMut(store, {
            domain: input.domain,
            heuristic: lesson,
            source_task: input.sourceTask,
            session_id: input.reflection.session_id,
            confidence: input.confidence,
            tags: input.tags,
        });
    }
    return {
        id: input.reflection.id,
        task_goal: input.reflection.task_goal,
        outcome: input.reflection.task_outcome,
        heuristics_extracted: safeLessons.length,
    };
}
export async function batchSaveReflections(inputs, operationName) {
    if (inputs.length === 0) { // B20: skip disk write for empty batch
        const store = await getCachedStore();
        return { results: [], reflectionCount: store.reflections.length, nearSoftLimit: false };
    }
    return mutateStore((store) => {
        const results = inputs.map((input) => saveReflectionAndHeuristicsMut(store, input));
        if (store.heuristics.length > HEURISTIC_MAX_COUNT)
            pruneHeuristicsMut(store);
        return {
            results,
            reflectionCount: store.reflections.length,
            nearSoftLimit: store.reflections.length >= REFLECTION_SOFT_LIMIT,
        };
    }, inputs.length > 0 ? "append-only" : "none", operationName, { inputs });
}
function pruneHeuristicsMut(store) {
    if (store.heuristics.length <= HEURISTIC_MAX_COUNT)
        return 0;
    const totalBefore = store.heuristics.length;
    let activeCount = 0;
    const supersededScored = [];
    const activeUnpinnedScored = [];
    for (const h of store.heuristics) {
        if (h.superseded_by) {
            if (!h.pinned) {
                supersededScored.push({
                    heuristic: h,
                    score: h.confidence + Math.min(h.reinforcement_count / 20, 0.3),
                });
            }
        }
        else {
            activeCount++;
            if (!h.pinned) {
                activeUnpinnedScored.push({
                    heuristic: h,
                    score: h.confidence + Math.min(h.reinforcement_count / 20, 0.3),
                });
            }
        }
    }
    let removedInPhase1 = 0;
    // Phase 1: prune superseded entries first - they are archived history.
    if (supersededScored.length > 0) {
        supersededScored.sort((a, b) => a.score - b.score);
        const supersededToRemove = new Set();
        for (const entry of supersededScored) {
            if (store.heuristics.length - supersededToRemove.size <= HEURISTIC_MAX_COUNT)
                break;
            supersededToRemove.add(entry.heuristic.id);
        }
        // If active entries are already within the cap, removing selected archived entries is enough.
        if (supersededToRemove.size > 0 && activeCount <= HEURISTIC_MAX_COUNT) {
            store.heuristics = store.heuristics.filter((h) => !supersededToRemove.has(h.id));
            _heuristicDedupCache.delete(store);
            return supersededToRemove.size;
        }
        // Active entries still exceed limit - remove all unpinned superseded, then prune active.
        store.heuristics = store.heuristics.filter((h) => !h.superseded_by || h.pinned);
        _heuristicDedupCache.delete(store);
        removedInPhase1 = totalBefore - store.heuristics.length;
    }
    // Phase 2: prune the lowest-scored remaining active entries until under the cap.
    activeUnpinnedScored.sort((a, b) => a.score - b.score);
    const toRemove = new Set();
    for (const entry of activeUnpinnedScored) {
        if (store.heuristics.length - toRemove.size <= HEURISTIC_MAX_COUNT)
            break;
        toRemove.add(entry.heuristic.id);
    }
    if (toRemove.size === 0 && removedInPhase1 === 0)
        return 0;
    store.heuristics = store.heuristics.filter((h) => !toRemove.has(h.id));
    // B6-fix: clear all WeakMap caches, not just dedup cache
    _heuristicDedupCache.delete(store);
    _heuristicByIdCache.delete(store);
    _heuristicSearchTextCache.delete(store);
    _heuristicTagSetCache.delete(store);
    return removedInPhase1 + toRemove.size;
}
export async function contradictHeuristic(id, reason, operationName) {
    return mutateStore((store) => {
        const heuristic = getOrBuildHeuristicByIdMap(store).get(id);
        if (!heuristic)
            return null;
        heuristic.contradiction_count++;
        heuristic.confidence = Math.max(0.0, heuristic.confidence - 0.1);
        heuristic.updated_at = new Date().toISOString();
        if (!heuristic.contradiction_notes)
            heuristic.contradiction_notes = [];
        if (reason) {
            const date = new Date().toISOString().slice(0, 10);
            heuristic.contradiction_notes.push(`[${date}] ${reason}`);
        }
        return sanitizeHeuristicForOutput(heuristic);
    }, "none", operationName, { id, reason });
}
export async function deleteHeuristic(id, operationName) {
    return mutateStore((store) => {
        const byId = getOrBuildHeuristicByIdMap(store);
        if (!byId.has(id))
            return false;
        // I1-fix: clean up dangling references from other heuristics before removing
        for (const h of store.heuristics) {
            if (h.superseded_by === id)
                delete h.superseded_by;
            if (h.supersedes?.includes(id)) {
                h.supersedes = h.supersedes.filter((sid) => sid !== id);
            }
        }
        store.heuristics = store.heuristics.filter((heuristic) => heuristic.id !== id);
        byId.delete(id);
        return true;
    }, "none", operationName, { id });
}
export async function pinHeuristic(id, pin, operationName) {
    return mutateStore((store) => {
        const heuristic = getOrBuildHeuristicByIdMap(store).get(id);
        if (!heuristic || heuristic.superseded_by)
            return null;
        if (pin) {
            heuristic.pinned = true;
        }
        else {
            delete heuristic.pinned;
        }
        heuristic.updated_at = new Date().toISOString();
        return sanitizeHeuristicForOutput(heuristic);
    }, "none", operationName, { id, pin });
}
export async function updateHeuristic(id, update, operationName) {
    return mutateStore((store) => {
        const h = getOrBuildHeuristicByIdMap(store).get(id);
        if (!h)
            return null;
        const now = new Date().toISOString();
        const normalizedTags = update.tags !== undefined
            ? [...new Set(update.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))]
            : undefined;
        const normalizedConfidence = update.confidence !== undefined ? Math.max(0, Math.min(1, update.confidence)) : undefined;
        const normalizedDomain = update.domain !== undefined ? normalizeDomain(update.domain) : undefined;
        const textChanged = update.heuristic !== undefined && update.heuristic !== h.heuristic;
        if (update.heuristic !== undefined) {
            assertHeuristicTextSafe(update.heuristic);
        }
        if (textChanged) {
            const replacement = {
                ...h,
                id: generateId(),
                created_at: now,
                updated_at: now,
                heuristic: update.heuristic,
                tags: normalizedTags ?? [...(h.tags ?? [])],
                confidence: normalizedConfidence ?? h.confidence,
                domain: normalizedDomain ?? h.domain,
                contradiction_count: 0,
                contradiction_notes: [],
                retrieval_count: 0,
                last_retrieved_at: undefined,
                supersedes: [...(h.supersedes ?? []), h.id],
                superseded_by: undefined,
                version: (h.version ?? 1) + 1,
            };
            h.superseded_by = replacement.id;
            h.updated_at = now;
            store.heuristics.push(replacement);
            getOrBuildHeuristicByIdMap(store).set(replacement.id, replacement);
            pruneHeuristicsMut(store);
            // B2-fix: if prune removed the replacement (low confidence + store at max),
            // roll back h to active state and apply metadata updates to h directly.
            const stillExists = store.heuristics.some((he) => he.id === replacement.id);
            if (!stillExists) {
                // I2-fix: h may have been removed by pruneHeuristicsMut Phase 1 (if h itself was superseded & not pinned).
                // Check if h is still in store; if not, re-add it.
                const hStillExists = store.heuristics.some((he) => he.id === h.id);
                if (!hStillExists) {
                    store.heuristics.push(h);
                    getOrBuildHeuristicByIdMap(store).set(h.id, h);
                }
                h.superseded_by = undefined; // restore h as active
                h.updated_at = now;
                if (normalizedTags !== undefined)
                    h.tags = normalizedTags;
                if (normalizedConfidence !== undefined)
                    h.confidence = normalizedConfidence;
                if (normalizedDomain !== undefined)
                    h.domain = normalizedDomain;
                getOrBuildHeuristicByIdMap(store).delete(replacement.id);
                return sanitizeHeuristicForOutput(h);
            }
            return sanitizeHeuristicForOutput(replacement);
        }
        if (update.heuristic !== undefined)
            h.heuristic = update.heuristic;
        if (normalizedTags !== undefined)
            h.tags = normalizedTags;
        if (normalizedConfidence !== undefined)
            h.confidence = normalizedConfidence;
        if (normalizedDomain !== undefined)
            h.domain = normalizedDomain;
        h.version = h.version ?? 1;
        h.supersedes = h.supersedes ?? [];
        h.updated_at = new Date().toISOString();
        return sanitizeHeuristicForOutput(h);
    }, "none", operationName, { id, ...update });
}
export async function mergeHeuristics(targetId, sourceIds, operationName) {
    return mutateStore((store) => {
        const byId = getOrBuildHeuristicByIdMap(store);
        const target = byId.get(targetId);
        if (!target || target.superseded_by)
            return null;
        const now = new Date().toISOString();
        for (const sourceId of sourceIds) {
            if (sourceId === targetId)
                continue;
            const source = byId.get(sourceId);
            if (!source || source.superseded_by)
                continue;
            target.reinforcement_count += source.reinforcement_count;
            target.contradiction_count += source.contradiction_count;
            target.contradiction_notes = [
                ...(target.contradiction_notes ?? []),
                ...(source.contradiction_notes ?? []),
            ];
            const targetTags = target.tags ?? [];
            const tagSet = new Set(targetTags.map((tag) => tag.toLowerCase().trim()));
            for (const tag of source.tags ?? []) {
                const normalizedTag = tag.toLowerCase().trim();
                if (normalizedTag && !tagSet.has(normalizedTag)) {
                    targetTags.push(tag);
                    tagSet.add(normalizedTag);
                }
            }
            target.tags = targetTags;
            target.confidence = Math.min(1.0, (target.confidence * 0.6 + source.confidence * 0.4) +
                Math.min(target.reinforcement_count * 0.005, 0.1));
            source.superseded_by = targetId;
            source.updated_at = now;
            target.supersedes = target.supersedes ?? [];
            if (!target.supersedes.includes(sourceId))
                target.supersedes.push(sourceId);
        }
        target.updated_at = now;
        if (store.heuristics.length > HEURISTIC_MAX_COUNT)
            pruneHeuristicsMut(store);
        return sanitizeHeuristicForOutput(target);
    }, "none", operationName, { target_id: targetId, source_ids: sourceIds });
}
function matchesTags(itemTags, filterTags, tagMode) {
    if (filterTags.length === 0)
        return true;
    const normalized = normalizeTags(itemTags);
    return tagMode === "or"
        ? filterTags.some((tag) => normalized.includes(tag))
        : filterTags.every((tag) => normalized.includes(tag));
}
function matchesTagSet(itemTagSet, filterTags, tagMode) {
    if (filterTags.length === 0)
        return true;
    if (!itemTagSet || itemTagSet.size === 0)
        return false;
    return tagMode === "or"
        ? filterTags.some((tag) => itemTagSet.has(tag))
        : filterTags.every((tag) => itemTagSet.has(tag));
}
function insertSorted(arr, item, compare, maxSize) {
    if (arr.length >= maxSize && compare(item, arr[arr.length - 1]) >= 0) {
        return;
    }
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compare(arr[mid], item) <= 0) {
            lo = mid + 1;
        }
        else {
            hi = mid;
        }
    }
    arr.splice(lo, 0, item);
    if (arr.length > maxSize)
        arr.pop();
}
export async function listHeuristics(options = {}) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const normalizedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
    const filterTags = normalizeTags(options.tags);
    const tagMode = options.tagMode ?? "and";
    const minConfidence = options.minConfidence ?? 0;
    const limit = options.limit ?? 20;
    const sort = options.sort ?? "confidence";
    const compare = (a, b) => {
        switch (sort) {
            case "updated_at":
                return b.updated_at.localeCompare(a.updated_at);
            case "created_at":
                return b.created_at.localeCompare(a.created_at);
            case "reinforcement":
                return b.reinforcement_count - a.reinforcement_count;
            case "confidence":
                return b.confidence - a.confidence;
        }
    };
    const topItems = [];
    for (const heuristic of store.heuristics) {
        if (heuristic.superseded_by)
            continue;
        if (normalizedDomain && normalizeDomain(heuristic.domain) !== normalizedDomain)
            continue;
        if (filterTags.length > 0 && !matchesTagSet(cache.heuristicTagSetById.get(heuristic.id), filterTags, tagMode))
            continue;
        if (heuristic.confidence < minConfidence)
            continue;
        insertSorted(topItems, heuristic, compare, limit);
    }
    return topItems.map((heuristic) => ({
        ...sanitizeHeuristicForOutput(heuristic),
    }));
}
export async function getHeuristicHistory(id, includeArchived = true) {
    const cache = await getCachedStoreEntry();
    const byId = cache.heuristicById;
    const start = byId.get(id);
    if (!start)
        return null;
    let latest = start;
    const seenForward = new Set([latest.id]);
    while (latest.superseded_by) {
        const next = byId.get(latest.superseded_by);
        if (!next || seenForward.has(next.id))
            break;
        latest = next;
        seenForward.add(next.id);
    }
    const chain = [];
    const seenBackward = new Set();
    let cursor = latest;
    while (cursor && !seenBackward.has(cursor.id)) {
        chain.push(cursor);
        seenBackward.add(cursor.id);
        const supersedes = cursor.supersedes ?? [];
        const previousId = supersedes[supersedes.length - 1];
        cursor = previousId ? byId.get(previousId) : undefined;
    }
    const ordered = chain.reverse();
    const filtered = includeArchived ? ordered : ordered.filter((heuristic) => !heuristic.superseded_by);
    return filtered.map(sanitizeHeuristicForOutput);
}
function heuristicSearchText(heuristic) {
    return `${heuristic.heuristic} ${heuristic.tags.join(" ")} ${heuristic.domain}`;
}
export async function searchHeuristics(query, domain, tags, tagMode = "and", minConfidence = 0, limit = 20) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
    const filterTags = normalizeTags(tags);
    let candidates = store.heuristics.filter((heuristic) => !heuristic.superseded_by && heuristic.confidence >= minConfidence);
    if (normalizedDomain) {
        candidates = candidates.filter((heuristic) => normalizeDomain(heuristic.domain) === normalizedDomain);
    }
    if (filterTags.length > 0) {
        candidates = candidates.filter((heuristic) => matchesTagSet(cache.heuristicTagSetById.get(heuristic.id), filterTags, tagMode));
    }
    const scored = candidates
        .map((heuristic) => {
        const searchText = cache.heuristicSearchTextById.get(heuristic.id) ?? heuristicSearchText(heuristic);
        const textScore = similarity(searchText, query, 1.5, 0.75, AVG_HEURISTIC_DOC_LEN);
        if (textScore < SEARCH_MIN_TEXT_SCORE)
            return null;
        return {
            ...sanitizeHeuristicForOutput(heuristic),
            score: textScore,
        };
    })
        .filter((item) => item !== null);
    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
export async function retrieveRelevantHeuristics(taskDescription, domain, limit = 10, tags, includeScores = false, minConfidence = 0.3, tagMode = "and") {
    return mutateStore((store) => {
        const searchTextMap = getOrBuildHeuristicSearchTextMap(store);
        const tagSetMap = getOrBuildHeuristicTagSetMap(store);
        const topItems = scoreHeuristicsForQuery(store, {
            taskDescription,
            domain,
            tags,
            tagMode,
            limit,
            minConfidence,
        }, searchTextMap, tagSetMap);
        const now = new Date().toISOString();
        for (const item of topItems) {
            item.heuristic.retrieval_count = (item.heuristic.retrieval_count ?? 0) + 1;
            item.heuristic.last_retrieved_at = now;
        }
        return topItems.map((item) => ({
            ...sanitizeHeuristicForOutput(item.heuristic),
            ...(includeScores ? { _score: item.scoreDetail } : {}),
        }));
    });
}
function scoreHeuristicsForQuery(store, query, searchTextMap, tagSetMap) {
    const normalizedDomain = query.domain ? normalizeDomain(query.domain) : undefined;
    const limit = query.limit ?? 10;
    const minConfidence = query.minConfidence ?? 0.3;
    const tagMode = query.tagMode ?? "and";
    const filterTags = normalizeTags(query.tags);
    const topItems = [];
    const scoreCompare = (a, b) => b.score - a.score;
    for (const heuristic of store.heuristics) {
        if (heuristic.superseded_by)
            continue;
        if (heuristic.confidence < minConfidence)
            continue;
        if (filterTags.length > 0 && !matchesTagSet(tagSetMap.get(heuristic.id), filterTags, tagMode))
            continue;
        const textScore = similarity(searchTextMap.get(heuristic.id) ?? heuristicSearchText(heuristic), query.taskDescription, 1.5, 0.75, AVG_HEURISTIC_DOC_LEN);
        if (textScore < SEARCH_MIN_TEXT_SCORE)
            continue;
        const domainBonus = normalizedDomain && normalizeDomain(heuristic.domain) === normalizedDomain ? 0.1 : 0;
        const reinforcementScore = Math.min(heuristic.reinforcement_count / 10, 1.0);
        const retrievalScore = Math.min((heuristic.retrieval_count ?? 0) / 20, 0.15);
        const retention = ebbinghausRetention(heuristic);
        const baseScore = textScore * 0.55 +
            heuristic.confidence * 0.25 +
            reinforcementScore * 0.1 +
            retrievalScore +
            domainBonus;
        const finalScore = baseScore * (0.7 + 0.3 * retention);
        insertSorted(topItems, {
            heuristic,
            score: finalScore,
            scoreDetail: {
                text: roundScore(textScore),
                confidence: roundScore(heuristic.confidence),
                reinforcement: roundScore(reinforcementScore),
                retrieval: roundScore(retrievalScore),
                retention: roundScore(retention),
                domain_bonus: roundScore(domainBonus),
                final: roundScore(finalScore),
            },
        }, scoreCompare, limit);
    }
    return topItems;
}
export async function bulkRetrieveHeuristics(queries, includeScores = false) {
    return mutateStore((store) => {
        const searchTextMap = getOrBuildHeuristicSearchTextMap(store);
        const tagSetMap = getOrBuildHeuristicTagSetMap(store);
        const seen = new Set();
        const results = [];
        const now = new Date().toISOString();
        for (const query of queries) {
            const topItems = scoreHeuristicsForQuery(store, query, searchTextMap, tagSetMap);
            for (const item of topItems) {
                if (!seen.has(item.heuristic.id)) {
                    seen.add(item.heuristic.id);
                    item.heuristic.retrieval_count = (item.heuristic.retrieval_count ?? 0) + 1;
                    item.heuristic.last_retrieved_at = now;
                }
            }
            results.push(topItems.map((item) => ({
                ...sanitizeHeuristicForOutput(item.heuristic),
                ...(includeScores ? { _score: item.scoreDetail } : {}),
            })));
        }
        return results;
    });
}
/**
 * Return a window of reflections in newest-first order without cloning or
 * sorting the full array when the input is already timestamp-ascending.
 * Falls back to copy+sort for out-of-order data to preserve v12 behavior.
 */
function newestFirstSlice(reflections, limit, offset = 0, isAscending) {
    if (limit <= 0)
        return [];
    let ascending = isAscending;
    if (ascending === undefined) {
        ascending = true;
        for (let i = 1; i < reflections.length; i++) {
            if (reflections[i].timestamp < reflections[i - 1].timestamp) {
                ascending = false;
                break;
            }
        }
    }
    if (ascending) {
        // Collect from the end (newest) toward the beginning, skipping `offset` items.
        const start = reflections.length - 1 - offset;
        if (start < 0)
            return [];
        const result = [];
        for (let i = start; i >= 0 && result.length < limit; i--) {
            result.push(reflections[i]);
        }
        return result;
    }
    // Fallback: full copy + sort (preserves v12 behavior for imported/out-of-order data).
    return [...reflections]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(offset, offset + limit);
}
export async function searchReflections(query, domain, outcome, limit = 20, sinceDays, tags, failureMode, tagMode = "and") {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
    let candidates = store.reflections;
    if (normalizedDomain) {
        candidates = candidates.filter((reflection) => normalizeDomain(reflection.domain) === normalizedDomain);
    }
    if (outcome) {
        candidates = candidates.filter((reflection) => reflection.task_outcome === outcome);
    }
    if (sinceDays !== undefined) {
        const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
        candidates = candidates.filter((reflection) => reflection.timestamp >= cutoff);
    }
    if (tags && tags.length > 0) {
        const filterTags = normalizeTags(tags);
        candidates = candidates.filter((reflection) => matchesTagSet(cache.reflectionTagSetById.get(reflection.id), filterTags, tagMode));
    }
    if (failureMode) {
        candidates = candidates.filter((reflection) => reflection.failure_mode === failureMode);
    }
    if (query.trim().length === 0) {
        const sliced = newestFirstSlice(candidates, limit, 0, cache.reflectionsAreAscending);
        return Promise.all(sliced.map(sanitizeReflectionForOutput));
    }
    const scored = candidates
        .map((reflection) => {
        const haystack = cache.reflectionSearchTextById.get(reflection.id) ?? reflectionSearchText(reflection);
        const textScore = similarity(haystack, query, 1.5, 0.75, AVG_REFLECTION_DOC_LEN);
        if (textScore < SEARCH_MIN_TEXT_SCORE)
            return null;
        const ageMs = Date.now() - new Date(reflection.timestamp).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyFactor = 0.5 + 0.5 * Math.exp(-ageDays / 90);
        return { reflection, score: textScore * recencyFactor };
    })
        .filter((item) => item !== null);
    scored.sort((a, b) => b.score - a.score);
    return Promise.all(scored.slice(0, limit).map((item) => sanitizeReflectionForOutput(item.reflection)));
}
export async function listReflections(options = {}) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const normalizedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
    const filterTags = normalizeTags(options.tags);
    const tagMode = options.tagMode ?? "and";
    const cutoff = options.sinceDays !== undefined
        ? new Date(Date.now() - options.sinceDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const base = options.sessionId
        ? (cache.sessionIndex.get(options.sessionId) ?? []).map((index) => store.reflections[index])
        : store.reflections;
    let candidates = base;
    if (normalizedDomain) {
        candidates = candidates.filter((reflection) => normalizeDomain(reflection.domain) === normalizedDomain);
    }
    if (options.outcome) {
        candidates = candidates.filter((reflection) => reflection.task_outcome === options.outcome);
    }
    if (options.failureMode) {
        candidates = candidates.filter((reflection) => reflection.failure_mode === options.failureMode);
    }
    if (cutoff) {
        candidates = candidates.filter((reflection) => reflection.timestamp >= cutoff);
    }
    if (filterTags.length > 0) {
        candidates = candidates.filter((reflection) => matchesTagSet(cache.reflectionTagSetById.get(reflection.id), filterTags, tagMode));
    }
    const sliced = newestFirstSlice(candidates, limit, offset, cache.reflectionsAreAscending);
    return Promise.all(sliced.map(sanitizeReflectionForOutput));
}
function sanitizeReflectionLessonsForOutput(reflection) {
    return {
        ...reflection,
        lessons_learned: reflection.lessons_learned.map(safeHeuristicText),
    };
}
/**
 * B3-fix: Apply resolved_questions overlay to a reflection's open_questions,
 * then sanitize lessons. Used by all reflection output paths to ensure
 * resolved questions display consistently across all retrieval functions.
 */
async function sanitizeReflectionForOutput(reflection) {
    const resolvedIndex = await getCachedResolvedQuestions();
    const sanitized = sanitizeReflectionLessonsForOutput(reflection);
    // Apply resolved overlay to open_questions
    sanitized.open_questions = sanitized.open_questions.map((question, index) => {
        const overlay = resolveQuestionOverlay(reflection.id, index, question, resolvedIndex);
        if (overlay.resolved) {
            return {
                ...question,
                resolved: true,
                resolved_at: overlay.resolved_at,
                ...(overlay.resolved_by ? { resolved_by: overlay.resolved_by } : {}),
            };
        }
        return question;
    });
    return sanitized;
}
function reflectionSearchText(reflection) {
    return [
        reflection.task_goal,
        reflection.task_state.summary,
        ...reflection.lessons_learned,
        ...reflection.task_state.proven_safe_paths,
        ...reflection.task_state.immediate_blockers,
        ...reflection.task_state.active_hypotheses,
        ...reflection.task_state.exhausted_search,
        ...(reflection.task_state.summary_sections?.flatMap((s) => [s.title, s.content]) ?? []),
        ...reflection.world_model_updates.map((update) => `${update.fact} ${update.evidence}`),
        ...reflection.tool_insights.map((insight) => `${insight.tool} ${insight.insight}`),
        ...reflection.context_forget.map((item) => `${item.item} ${item.reason}`),
        ...reflection.open_questions.map((question) => question.question),
        ...(reflection.tags ?? []),
    ].join(" ");
}
export async function getReflectionSummary() {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    let activeGaps = 0;
    let resolvedGaps = 0;
    const topGaps = [];
    for (const gap of store.affordance_gaps) {
        if (gap.resolved) {
            resolvedGaps++;
        }
        else {
            activeGaps++;
            insertSorted(topGaps, gap, (a, b) => b.occurrence_count - a.occurrence_count, 5);
        }
    }
    let activeHeuristics = 0;
    let archivedHeuristics = 0;
    for (const heuristic of store.heuristics) {
        if (heuristic.superseded_by)
            archivedHeuristics++;
        else
            activeHeuristics++;
    }
    const failureDist = {};
    const outcomeDist = {};
    const domainDist = {};
    const tagDist = {};
    for (const reflection of store.reflections) {
        failureDist[reflection.failure_mode] = (failureDist[reflection.failure_mode] ?? 0) + 1;
        outcomeDist[reflection.task_outcome] = (outcomeDist[reflection.task_outcome] ?? 0) + 1;
        const domain = normalizeDomain(reflection.domain);
        domainDist[domain] = (domainDist[domain] ?? 0) + 1;
        const failureModeVal = reflection.failure_mode.toLowerCase();
        for (const tag of reflection.tags ?? []) {
            const normalizedTag = tag.toLowerCase().trim();
            if (normalizedTag && normalizedTag !== domain && normalizedTag !== failureModeVal) {
                tagDist[normalizedTag] = (tagDist[normalizedTag] ?? 0) + 1;
            }
        }
    }
    const recentLessons = [];
    for (let i = store.reflections.length - 1; i >= 0 && recentLessons.length < 10; i--) {
        for (const lesson of store.reflections[i].lessons_learned) {
            if (recentLessons.length >= 10)
                break;
            recentLessons.push(safeHeuristicText(lesson));
        }
    }
    return {
        total_reflections: store.reflections.length,
        total_sessions: Object.keys(store.sessions).length,
        total_heuristics: activeHeuristics,
        total_heuristics_archived: archivedHeuristics,
        total_affordance_gaps: activeGaps,
        total_affordance_gaps_resolved: resolvedGaps,
        top_gaps: topGaps,
        recent_lessons: recentLessons,
        outcome_distribution: outcomeDist,
        failure_distribution: failureDist,
        domain_distribution: domainDist,
        tag_distribution: tagDist,
        metadata: store.metadata,
    };
}
export async function getAffordanceGaps(minOccurrences = 1, includeResolved = false, limit) {
    const store = await getCachedStore();
    const filtered = store.affordance_gaps
        .filter((gap) => gap.occurrence_count >= minOccurrences && (includeResolved || !gap.resolved));
    if (limit != null) {
        const top = [];
        for (const gap of filtered) {
            insertSorted(top, gap, (a, b) => b.occurrence_count - a.occurrence_count, limit);
        }
        return top;
    }
    return filtered.sort((a, b) => b.occurrence_count - a.occurrence_count);
}
export async function resolveAffordanceGap(id, resolutionNotes, operationName) {
    return mutateStore((store) => {
        const gap = getOrBuildAffordanceGapByIdIndex(store).get(id);
        if (!gap)
            return null;
        gap.resolved = true;
        gap.resolved_at = new Date().toISOString();
        if (resolutionNotes)
            gap.resolution_notes = resolutionNotes;
        return { ...gap, available_tools: [...gap.available_tools] };
    }, "none", operationName, { id, resolution_notes: resolutionNotes });
}
export async function getRecentReflections(limit = 20) {
    const recent = await loadRecentReflections(limit);
    return Promise.all(recent.map(sanitizeReflectionForOutput));
}
export async function getSessionReflections(sessionId, limit = 20) {
    const cache = await getCachedStoreEntry();
    const indexes = cache.sessionIndex.get(sessionId) ?? [];
    const sliced = indexes.slice(-limit).reverse().map((index) => cache.store.reflections[index]);
    return Promise.all(sliced.map(sanitizeReflectionForOutput));
}
export async function getReflectionChain(id, similarityThreshold = 0.2, limit = 10, includeSelf = true) {
    const cache = await getCachedStoreEntry();
    const seed = cache.reflectionById.get(id);
    if (!seed)
        return null;
    const sessionIndexes = cache.sessionIndex.get(seed.session_id) ?? [];
    const seedText = cache.reflectionSearchTextById.get(id) ?? reflectionSearchText(seed);
    let seedEntry;
    const others = [];
    for (const index of sessionIndexes) {
        const reflection = cache.store.reflections[index];
        if (reflection.id === id) {
            if (includeSelf) {
                const sanitizedSeed = await sanitizeReflectionForOutput(reflection);
                seedEntry = {
                    reflection: sanitizedSeed,
                    similarity: 1.0,
                    is_seed: true,
                };
            }
            continue;
        }
        const rText = cache.reflectionSearchTextById.get(reflection.id) ?? reflectionSearchText(reflection);
        const sim = similarity(seedText, rText, 1.5, 0.75, AVG_REFLECTION_DOC_LEN);
        if (sim >= similarityThreshold) {
            const sanitizedOther = await sanitizeReflectionForOutput(reflection);
            others.push({
                reflection: sanitizedOther,
                similarity: Number(sim.toFixed(3)),
                is_seed: false,
            });
        }
    }
    others.sort((a, b) => {
        if (b.similarity !== a.similarity)
            return b.similarity - a.similarity;
        return a.reflection.timestamp.localeCompare(b.reflection.timestamp);
    });
    if (!seedEntry) {
        return others.slice(0, limit);
    }
    return [seedEntry, ...others.slice(0, Math.max(0, limit - 1))];
}
export async function getSessionSummary(sessionId) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const resolvedIndex = await getCachedResolvedQuestions();
    const session = store.sessions[sessionId];
    if (!session)
        return null;
    const sessionReflections = (cache.sessionIndex.get(sessionId) ?? [])
        .map((index) => store.reflections[index]);
    if (sessionReflections.length === 0)
        return null;
    const outcomeDist = {};
    const domainSet = new Set();
    const openQuestionCandidates = [];
    const PRIORITY_ORDER = { high: 3, medium: 2, low: 1 };
    const openQCompare = (a, b) => {
        const pd = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
        return pd !== 0 ? pd : b.timestamp.localeCompare(a.timestamp);
    };
    for (const reflection of sessionReflections) {
        outcomeDist[reflection.task_outcome] = (outcomeDist[reflection.task_outcome] ?? 0) + 1;
        domainSet.add(normalizeDomain(reflection.domain));
        for (const [index, q] of reflection.open_questions.entries()) {
            if (resolveQuestionOverlay(reflection.id, index, q, resolvedIndex).resolved)
                continue;
            insertSorted(openQuestionCandidates, { question: q.question, priority: q.priority, timestamp: reflection.timestamp }, openQCompare, 5);
        }
    }
    const topLessons = [];
    for (let i = sessionReflections.length - 1; i >= 0 && topLessons.length < 5; i--) {
        for (const lesson of sessionReflections[i].lessons_learned) {
            if (topLessons.length >= 5)
                break;
            topLessons.push(safeHeuristicText(lesson));
        }
    }
    const topOpenQs = openQuestionCandidates
        .map((q) => ({ question: q.question, priority: q.priority }));
    const sessionHeuristics = cache.sessionHeuristicsCount.get(sessionId) ?? 0;
    return {
        session_id: sessionId,
        started_at: session.started_at,
        reflection_count: sessionReflections.length,
        outcome_distribution: outcomeDist,
        domains: [...domainSet],
        top_lessons: topLessons,
        open_questions: topOpenQs,
        affordance_gaps_logged: session.affordance_gap_count,
        heuristics_extracted: sessionHeuristics,
    };
}
export async function getReflectionById(id, applyResolvedOverlay = true) {
    const cache = await getCachedStoreEntry();
    const reflection = cache.reflectionById.get(id);
    if (!reflection)
        return null;
    if (!applyResolvedOverlay) {
        return {
            ...reflection,
            lessons_learned: reflection.lessons_learned.map(safeHeuristicText),
        };
    }
    const resolvedIndex = await getCachedResolvedQuestions();
    return {
        ...reflection,
        lessons_learned: reflection.lessons_learned.map(safeHeuristicText),
        open_questions: reflection.open_questions.map((question, index) => {
            const resolved = resolveQuestionOverlay(reflection.id, index, question, resolvedIndex);
            return resolved.resolved
                ? {
                    ...question,
                    resolved: true,
                    resolved_at: resolved.resolved_at,
                    resolved_by: resolved.resolved_by,
                }
                : question;
        }),
    };
}
export async function updateReflection(id, update, operationName) {
    const result = await mutateStore((store) => {
        const reflection = getOrBuildReflectionByIdMap(store).get(id);
        if (!reflection)
            return null;
        if (update.domain !== undefined) {
            reflection.domain = normalizeDomain(update.domain);
        }
        if (update.tags !== undefined) {
            reflection.tags = [...new Set(normalizeTags(update.tags))];
        }
        if (update.lessons_learned !== undefined) {
            const safeLessons = update.lessons_learned.filter((lesson) => firstHeuristicThreatMessage(lesson, "strict") === null);
            reflection.lessons_learned = safeLessons;
            if (update.reExtractHeuristics && safeLessons.length > 0) {
                const confidence = update.confidence ?? 0.6;
                for (const lesson of safeLessons) {
                    upsertHeuristicMut(store, {
                        domain: reflection.domain,
                        heuristic: lesson,
                        source_task: reflection.task_goal,
                        session_id: reflection.session_id,
                        confidence,
                        tags: reflection.tags,
                    });
                }
                if (store.heuristics.length > HEURISTIC_MAX_COUNT)
                    pruneHeuristicsMut(store);
            }
        }
        return reflection; // B3-fix: caller applies overlay via sanitizeReflectionForOutput
    }, "rewrite", operationName, { id, ...update });
    if (!result)
        return null;
    return sanitizeReflectionForOutput(result);
}
export async function diffReflections(idA, idB) {
    const cache = await getCachedStoreEntry();
    const a = cache.reflectionById.get(idA);
    const b = cache.reflectionById.get(idB);
    if (!a || !b)
        return null;
    const comparableFields = [
        "task_outcome",
        "failure_mode",
        "domain",
    ];
    const sameFields = comparableFields.filter((field) => a[field] === b[field]);
    const changedFields = comparableFields.filter((field) => a[field] !== b[field]);
    const lessonSimilarityThreshold = 0.38;
    const unchangedLessons = [];
    const removedLessons = [];
    const matchedLessonB = new Set();
    for (const lessonA of a.lessons_learned) {
        let bestIndex = -1;
        let bestScore = 0;
        for (let i = 0; i < b.lessons_learned.length; i++) {
            if (matchedLessonB.has(i))
                continue;
            const lessonB = b.lessons_learned[i];
            const exactMatch = lessonA.toLowerCase().trim() === lessonB.toLowerCase().trim();
            const score = exactMatch
                ? 1
                : Math.max(similarity(lessonA, lessonB), similarity(lessonB, lessonA));
            const overlap = exactMatch ? { count: Number.MAX_SAFE_INTEGER, ratio: 1 } : tokenOverlapStats(lessonA, lessonB);
            const isCandidate = exactMatch || (score >= lessonSimilarityThreshold && overlap.count >= 2 && overlap.ratio >= 0.4);
            if (isCandidate && score > bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }
        if (bestIndex >= 0) {
            matchedLessonB.add(bestIndex);
            unchangedLessons.push({ a: lessonA, b: b.lessons_learned[bestIndex] });
        }
        else {
            removedLessons.push(lessonA);
        }
    }
    const addedLessons = b.lessons_learned.filter((_, i) => !matchedLessonB.has(i));
    const worldPolarityChanges = [];
    for (const updateA of a.world_model_updates) {
        for (const updateB of b.world_model_updates) {
            if (updateA.polarity !== updateB.polarity && similarity(updateA.fact, updateB.fact) > 0.65) {
                worldPolarityChanges.push({
                    fact_a: updateA.fact,
                    polarity_a: updateA.polarity,
                    fact_b: updateB.fact,
                    polarity_b: updateB.polarity,
                });
            }
        }
    }
    const commonOpenQuestions = [];
    for (const questionA of a.open_questions) {
        for (const questionB of b.open_questions) {
            if (similarity(questionA.question, questionB.question) > 0.7) {
                commonOpenQuestions.push({
                    question_a: questionA.question,
                    question_b: questionB.question,
                });
            }
        }
    }
    const timestampA = Date.parse(a.timestamp);
    const timestampB = Date.parse(b.timestamp);
    const timeDelta = Number.isFinite(timestampA) && Number.isFinite(timestampB)
        ? timestampB - timestampA
        : 0;
    const [sanitizedA, sanitizedB] = await Promise.all([
        sanitizeReflectionForOutput(a),
        sanitizeReflectionForOutput(b),
    ]);
    return {
        a: sanitizedA,
        b: sanitizedB,
        diff: {
            id_a: idA,
            id_b: idB,
            same_reflection: idA === idB,
            time_delta_ms: timeDelta,
            same_fields: sameFields,
            changed_fields: changedFields,
            lessons: {
                added: addedLessons.map(safeHeuristicText),
                removed: removedLessons.map(safeHeuristicText),
                unchanged: unchangedLessons.map((item) => ({
                    a: safeHeuristicText(item.a),
                    b: safeHeuristicText(item.b),
                })),
            },
            world_model_polarity_changes: worldPolarityChanges,
            common_open_questions: commonOpenQuestions,
        },
    };
}
const PRIORITY_RANK = {
    high: 3,
    medium: 2,
    low: 1,
};
export async function getWorldModel(domain, polarity, limit = 50, sinceDays) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
    const cutoff = sinceDays !== undefined
        ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
    const deduplicatedFacts = [];
    const exactSeen = new Map();
    const polarityBuckets = new Map();
    const bucketByIndex = new Map();
    const registerBucket = (index, fact) => {
        const nextKey = worldFactBucketKey(fact.polarity, fact.fact);
        const previousKey = bucketByIndex.get(index);
        if (previousKey && previousKey !== nextKey) {
            const previousBucket = polarityBuckets.get(previousKey);
            if (previousBucket) {
                polarityBuckets.set(previousKey, previousBucket.filter((item) => item !== index));
            }
        }
        const bucket = polarityBuckets.get(nextKey) ?? [];
        if (!bucket.includes(index))
            bucket.push(index);
        polarityBuckets.set(nextKey, bucket);
        bucketByIndex.set(index, nextKey);
    };
    const orderedReflections = cache.reflectionsAreAscending ? store.reflections : [...store.reflections].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (const reflection of orderedReflections) {
        if (cutoff && reflection.timestamp < cutoff)
            continue;
        if (normalizedDomain && normalizeDomain(reflection.domain) !== normalizedDomain)
            continue;
        for (const update of reflection.world_model_updates) {
            const candidate = {
                fact: update.fact,
                polarity: update.polarity,
                source: update.source,
                evidence: update.evidence,
                reflection_id: reflection.id,
                timestamp: reflection.timestamp,
                domain: reflection.domain,
            };
            const exactKey = worldFactExactKey(candidate.polarity, update.fact);
            const rawExactIndex = exactSeen.get(exactKey);
            const exactIndex = rawExactIndex !== undefined
                && deduplicatedFacts[rawExactIndex]?.polarity === candidate.polarity
                ? rawExactIndex
                : undefined;
            let similarIndex = exactIndex ?? -1;
            if (similarIndex < 0) {
                const bucket = polarityBuckets.get(worldFactBucketKey(candidate.polarity, update.fact)) ?? [];
                for (const index of bucket) {
                    const existing = deduplicatedFacts[index];
                    if (existing?.polarity === candidate.polarity &&
                        worldFactSimilarity(existing.fact, update.fact) > WORLD_FACT_DEDUP_THRESHOLD) {
                        similarIndex = index;
                        break;
                    }
                }
            }
            if (similarIndex >= 0) {
                // Clean up stale exact key for the old fact being replaced
                const oldFact = deduplicatedFacts[similarIndex];
                const oldKey = worldFactExactKey(oldFact.polarity, oldFact.fact);
                if (oldKey !== exactKey && exactSeen.get(oldKey) === similarIndex) {
                    exactSeen.delete(oldKey);
                }
                deduplicatedFacts[similarIndex] = candidate;
                exactSeen.set(exactKey, similarIndex);
                registerBucket(similarIndex, candidate);
            }
            else {
                const newIndex = deduplicatedFacts.length;
                exactSeen.set(exactKey, newIndex);
                deduplicatedFacts.push(candidate);
                registerBucket(newIndex, candidate);
            }
        }
    }
    let facts = deduplicatedFacts;
    if (polarity) {
        facts = facts.filter((f) => f.polarity === polarity);
    }
    facts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return facts.slice(0, limit);
}
function worldFactExactKey(polarity, fact) {
    return `${polarity}::${fact.toLowerCase().trim()}`;
}
function worldFactBucketKey(polarity, fact) {
    const prefix = normalizeWorldFactForSimilarity(fact)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .join(" ");
    return `${polarity}::${prefix}`;
}
function startOfUtcDay(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function timelineBucketRange(date, bucket) {
    if (bucket === "month") {
        const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
        const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
        return { start, end, key: start.toISOString().slice(0, 7) };
    }
    if (bucket === "week") {
        const start = startOfUtcDay(date);
        const day = start.getUTCDay();
        const mondayOffset = day === 0 ? -6 : 1 - day;
        start.setUTCDate(start.getUTCDate() + mondayOffset);
        const end = new Date(start);
        end.setUTCDate(start.getUTCDate() + 6);
        return { start, end, key: start.toISOString().slice(0, 10) };
    }
    const start = startOfUtcDay(date);
    return { start, end: new Date(start), key: start.toISOString().slice(0, 10) };
}
export async function getReflectionTimeline(bucket, domain, sinceDays = 90, limit = 20) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const buckets = new Map();
    const resolvedIndex = await getCachedResolvedQuestions();
    for (const reflection of store.reflections) {
        if (reflection.timestamp < cutoff)
            continue;
        if (normalizedDomain && normalizeDomain(reflection.domain) !== normalizedDomain)
            continue;
        const date = new Date(reflection.timestamp);
        if (Number.isNaN(date.getTime()))
            continue;
        const range = timelineBucketRange(date, bucket);
        let entry = buckets.get(range.key);
        if (!entry) {
            entry = {
                start: range.start,
                end: range.end,
                reflection_count: 0,
                outcome_distribution: {},
                failure_distribution: {},
                lessons_count: 0,
                open_questions_count: 0,
                domains: new Set(),
            };
            buckets.set(range.key, entry);
        }
        entry.reflection_count++;
        entry.outcome_distribution[reflection.task_outcome] = (entry.outcome_distribution[reflection.task_outcome] ?? 0) + 1;
        if (reflection.failure_mode !== "success") {
            entry.failure_distribution[reflection.failure_mode] = (entry.failure_distribution[reflection.failure_mode] ?? 0) + 1;
        }
        entry.lessons_count += reflection.lessons_learned.length;
        if (cache.reflectionsWithOpenQuestionsCount.has(reflection.id)) {
            for (let i = 0; i < reflection.open_questions.length; i++) {
                if (!resolveQuestionOverlay(reflection.id, i, reflection.open_questions[i], resolvedIndex).resolved) {
                    entry.open_questions_count++;
                }
            }
        }
        entry.domains.add(normalizeDomain(reflection.domain));
    }
    const sortedBuckets = [...buckets.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
    const selectedBuckets = sortedBuckets.length <= limit
        ? sortedBuckets
        : sortedBuckets.slice(sortedBuckets.length - limit);
    return selectedBuckets.map((entry) => {
        let topFailureMode;
        let topFailureCount = 0;
        for (const [mode, count] of Object.entries(entry.failure_distribution)) {
            if (count > topFailureCount) {
                topFailureMode = mode;
                topFailureCount = count;
            }
        }
        return {
            start: entry.start.toISOString().slice(0, 10),
            end: entry.end.toISOString().slice(0, 10),
            reflection_count: entry.reflection_count,
            outcome_distribution: entry.outcome_distribution,
            top_failure_mode: topFailureMode ? `${topFailureMode} (x${topFailureCount})` : undefined,
            lessons_count: entry.lessons_count,
            open_questions_count: entry.open_questions_count,
            domains: [...entry.domains].sort(),
        };
    });
}
function worldFactSimilarity(a, b) {
    const normalizedA = normalizeWorldFactForSimilarity(a);
    const normalizedB = normalizeWorldFactForSimilarity(b);
    if (hasConflictingNumberTokens(normalizedA, normalizedB))
        return 0;
    const trigramScore = characterTrigramSimilarity(normalizedA, normalizedB);
    if (trigramScore < 0.4)
        return trigramScore;
    return Math.max(similarity(normalizedA, normalizedB), similarity(normalizedB, normalizedA), trigramScore);
}
function normalizeWorldFactForSimilarity(value) {
    return value
        .toLowerCase()
        .replace(/\b(\d+)\s*(seconds?|secs?|s)\b/g, "$1 second")
        .replace(/\b(\d+)\s*(minutes?|mins?|m)\b/g, "$1 minute")
        .replace(/\b(\d+)\s*(hours?|hrs?|h)\b/g, "$1 hour")
        .replace(/\b(\d+)\s*(milliseconds?|millis?|ms)\b/g, "$1 millisecond");
}
function hasConflictingNumberTokens(a, b) {
    const numbersA = numberTokens(a);
    const numbersB = numberTokens(b);
    if (numbersA.size === 0 || numbersB.size === 0)
        return false;
    const aSubsetOfB = [...numbersA].every((value) => numbersB.has(value));
    const bSubsetOfA = [...numbersB].every((value) => numbersA.has(value));
    return !(aSubsetOfB || bSubsetOfA);
}
function numberTokens(value) {
    return new Set(value.match(/\d+/g) ?? []);
}
function characterTrigramSimilarity(a, b) {
    const gramsA = characterTrigrams(a);
    const gramsB = characterTrigrams(b);
    if (gramsA.size === 0 || gramsB.size === 0)
        return 0;
    let overlap = 0;
    for (const gram of gramsA) {
        if (gramsB.has(gram))
            overlap++;
    }
    return (2 * overlap) / (gramsA.size + gramsB.size);
}
function characterTrigrams(value) {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const grams = new Set();
    for (let i = 0; i <= normalized.length - 3; i++) {
        grams.add(normalized.slice(i, i + 3));
    }
    return grams;
}
export async function getOpenQuestions(domain, priority, limit = 30, sinceDays, includeResolved = false) {
    const store = await getCachedStore();
    const resolvedIndex = await getCachedResolvedQuestions();
    const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
    const cutoff = sinceDays !== undefined
        ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
    const results = [];
    const openQCompare = (a, b) => {
        const priorityDelta = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
        if (priorityDelta !== 0)
            return priorityDelta;
        return b.timestamp.localeCompare(a.timestamp);
    };
    for (const reflection of store.reflections) {
        if (normalizedDomain && normalizeDomain(reflection.domain) !== normalizedDomain)
            continue;
        if (cutoff && reflection.timestamp < cutoff)
            continue;
        for (const [index, question] of reflection.open_questions.entries()) {
            if (priority && question.priority !== priority)
                continue;
            const resolved = resolveQuestionOverlay(reflection.id, index, question, resolvedIndex);
            if (!includeResolved && resolved.resolved)
                continue;
            insertSorted(results, {
                id: `${reflection.id}:${index}`,
                reflection_id: reflection.id,
                question_index: index,
                timestamp: reflection.timestamp,
                domain: reflection.domain,
                task_goal: reflection.task_goal,
                question: question.question,
                priority: question.priority,
                requires_environment_interaction: question.requires_environment_interaction,
                resolved: resolved.resolved,
                resolved_at: resolved.resolved_at,
                resolved_by: resolved.resolved_by,
            }, openQCompare, limit);
        }
    }
    return results;
}
export async function resolveOpenQuestion(reflectionId, questionIndex, resolvedByReflectionId) {
    const cache = await getCachedStoreEntry();
    const reflection = cache.reflectionById.get(reflectionId);
    if (!reflection)
        return null;
    const question = reflection.open_questions[questionIndex];
    if (!question)
        return { found: false, question: "" };
    await mutateResolvedQuestions(async (resolved) => {
        resolved[resolvedQuestionKey(reflectionId, questionIndex)] = {
            resolved_at: new Date().toISOString(),
            ...(resolvedByReflectionId ? { resolved_by: resolvedByReflectionId } : {}),
        };
    });
    return { found: true, question: question.question };
}
export async function exportData() {
    return mergeResolvedQuestionsIntoStore(await getCachedStore());
}
function estimateReflectionBytes(reflection) {
    const strSize = (s) => s ? s.length : 0;
    let len = 0;
    // Top-level scalar strings
    len += strSize(reflection.id);
    len += strSize(reflection.timestamp);
    len += strSize(reflection.session_id);
    len += strSize(reflection.task_goal);
    len += strSize(reflection.task_outcome);
    len += strSize(reflection.failure_mode);
    len += strSize(reflection.domain);
    len += strSize(reflection.context_notes);
    // task_state
    len += strSize(reflection.task_state.summary);
    for (const s of reflection.task_state.summary_sections ?? [])
        len += strSize(s.title) + strSize(s.content);
    for (const s of reflection.task_state.immediate_blockers)
        len += strSize(s);
    for (const s of reflection.task_state.active_hypotheses)
        len += strSize(s);
    for (const s of reflection.task_state.proven_safe_paths)
        len += strSize(s);
    for (const s of reflection.task_state.exhausted_search)
        len += strSize(s);
    // Arrays of objects with string fields
    for (const u of reflection.world_model_updates)
        len += strSize(u.fact) + strSize(u.polarity) + strSize(u.source) + strSize(u.evidence);
    for (const t of reflection.tool_insights)
        len += strSize(t.tool) + strSize(t.insight) + strSize(t.status) + strSize(t.evidence);
    for (const c of reflection.context_forget)
        len += strSize(c.item) + strSize(c.reason);
    for (const q of reflection.open_questions) {
        len += strSize(q.question) + strSize(q.priority) + strSize(q.resolved_at) + strSize(q.resolved_by);
    }
    for (const s of reflection.lessons_learned)
        len += strSize(s);
    for (const s of reflection.tags)
        len += strSize(s);
    // Nested affordance gaps
    for (const g of reflection.affordance_gaps) {
        len += strSize(g.id) + strSize(g.timestamp) + strSize(g.session_id)
            + strSize(g.goal_description) + strSize(g.failure_description) + strSize(g.missing_capability);
        for (const t of g.available_tools)
            len += strSize(t);
        len += strSize(g.suggested_solution) + strSize(g.resolved_at) + strSize(g.resolution_notes);
    }
    // Conservative multiplier for JSON structural overhead (keys, quotes, commas, braces)
    // and potential UTF-8 multi-byte characters
    return Math.round(len * 1.3) + 64;
}
export async function checkStoreHealth() {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const sessionIds = new Set(Object.keys(store.sessions));
    const issues = [];
    let orphanReflections = 0;
    for (const reflection of store.reflections) {
        if (!sessionIds.has(reflection.session_id))
            orphanReflections++;
    }
    if (orphanReflections > 0) {
        issues.push(`${orphanReflections} reflection(s) reference missing sessions.`);
    }
    let orphanGaps = 0;
    for (const gap of store.affordance_gaps) {
        if (!sessionIds.has(gap.session_id))
            orphanGaps++;
    }
    if (orphanGaps > 0) {
        issues.push(`${orphanGaps} affordance gap(s) reference missing sessions.`);
    }
    const heuristicById = cache.heuristicById;
    let brokenLinks = 0;
    for (const heuristic of store.heuristics) {
        for (const previousId of heuristic.supersedes ?? []) {
            const previous = heuristicById.get(previousId);
            if (!previous || previous.superseded_by !== heuristic.id)
                brokenLinks++;
        }
        if (heuristic.superseded_by) {
            const next = heuristicById.get(heuristic.superseded_by);
            if (!next || !(next.supersedes ?? []).includes(heuristic.id))
                brokenLinks++;
        }
    }
    if (brokenLinks > 0) {
        issues.push(`${brokenLinks} heuristic supersedes/superseded_by link(s) are broken.`);
    }
    let suspiciousHeuristics = 0;
    for (const heuristic of store.heuristics) {
        if (scanHeuristicThreats(heuristic.heuristic, "strict").length > 0)
            suspiciousHeuristics++;
    }
    if (suspiciousHeuristics > 0) {
        issues.push(`${suspiciousHeuristics} heuristic(s) contain blocked context-injection or exfiltration patterns. Normal list/search/retrieve output hides their raw text; inspect with export_data(collection:"heuristics").`);
    }
    let totalReflectionBytes = 0;
    let largestReflection;
    for (const reflection of store.reflections) {
        const bytes = estimateReflectionBytes(reflection);
        totalReflectionBytes += bytes;
        if (!largestReflection || bytes > largestReflection.bytes) {
            largestReflection = { id: reflection.id, bytes };
        }
    }
    const storeJsonBytes = await fileSize(STORE_PATH);
    const reflectionsJsonlBytes = await fileSize(REFLECTIONS_PATH);
    const resolvedQuestionsJsonBytes = await fileSize(RESOLVED_QUESTIONS_PATH);
    return {
        healthy: issues.length === 0,
        orphan_reflections: orphanReflections,
        orphan_affordance_gaps: orphanGaps,
        broken_heuristic_links: brokenLinks,
        suspicious_heuristics: suspiciousHeuristics,
        file_stats: {
            store_json_bytes: storeJsonBytes,
            reflections_jsonl_bytes: reflectionsJsonlBytes,
            resolved_questions_json_bytes: resolvedQuestionsJsonBytes,
            reflection_count: store.reflections.length,
            average_reflection_bytes: store.reflections.length > 0
                ? Math.round(totalReflectionBytes / store.reflections.length)
                : 0,
        },
        largest_reflection: largestReflection,
        issues,
    };
}
export async function createSnapshot(outputDir, label) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const normalizedLabel = label?.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
    const dirName = normalizedLabel ? `${timestamp}-${normalizedLabel}` : timestamp;
    const baseDir = outputDir ?? join(STORE_DIR, "snapshots");
    const snapshotDir = join(baseDir, dirName);
    await mkdir(snapshotDir, { recursive: true });
    const files = [];
    const srcFiles = [
        { src: STORE_PATH, name: "store.json" },
        { src: REFLECTIONS_PATH, name: "reflections.jsonl" },
        { src: RESOLVED_QUESTIONS_PATH, name: "resolved_questions.json" },
    ];
    for (const { src, name } of srcFiles) {
        if (!existsSync(src))
            continue;
        const dest = join(snapshotDir, name);
        await copyFile(src, dest);
        files.push(dest);
    }
    return {
        snapshot_dir: snapshotDir,
        files,
        timestamp: new Date().toISOString(),
    };
}
async function fileSize(path) {
    try {
        return (await stat(path)).size;
    }
    catch {
        return 0;
    }
}
function resolvedQuestionKey(reflectionId, questionIndex) {
    return `${reflectionId}:${questionIndex}`;
}
async function loadResolvedQuestions() {
    if (!existsSync(RESOLVED_QUESTIONS_PATH))
        return {};
    try {
        return JSON.parse(await readFile(RESOLVED_QUESTIONS_PATH, "utf-8"));
    }
    catch (error) {
        console.error("[hermes] resolved_questions.json is invalid; ignoring overlay.", error);
        return {};
    }
}
async function saveResolvedQuestions(index) {
    await ensureStoreDir();
    const tmpPath = join(STORE_DIR, `resolved_questions.json.tmp.${process.pid}.${Date.now()}.${randomUUID()}`);
    await writeFile(tmpPath, JSON.stringify(index, null, 2), "utf-8");
    await replaceFileAtomically(tmpPath, RESOLVED_QUESTIONS_PATH);
}
async function mutateResolvedQuestions(mutator) {
    const run = resolvedQuestionsMutationQueue.then(async () => {
        if (!_mutationResolvedIndex) {
            _mutationResolvedIndex = await loadResolvedQuestions();
        }
        const index = _mutationResolvedIndex;
        await mutator(index);
        await saveResolvedQuestions(index);
        _mutationResolvedIndex = index;
        _resolvedQuestionsCache = {
            index,
            loadedAt: Date.now(),
            fileSize: await fileSize(RESOLVED_QUESTIONS_PATH),
        };
    });
    resolvedQuestionsMutationQueue = run.then(() => undefined, (error) => {
        console.error("[hermes] resolved questions error:", error instanceof Error ? error.message : String(error));
        _mutationResolvedIndex = null;
        invalidateResolvedQuestionsCache();
    });
    return run;
}
function resolvedQuestionsFromReflections(reflections) {
    const resolved = {};
    for (const reflection of reflections) {
        reflection.open_questions = reflection.open_questions.map((question, index) => {
            if (question.resolved === true) {
                resolved[resolvedQuestionKey(reflection.id, index)] = {
                    resolved_at: question.resolved_at ?? new Date().toISOString(),
                    ...(question.resolved_by ? { resolved_by: question.resolved_by } : {}),
                };
                const { resolved: _resolved, resolved_at: _resolvedAt, resolved_by: _resolvedBy, ...rest } = question;
                return rest;
            }
            return question;
        });
    }
    return resolved;
}
function resolveQuestionOverlay(reflectionId, questionIndex, question, resolvedIndex) {
    const overlay = resolvedIndex[resolvedQuestionKey(reflectionId, questionIndex)];
    if (overlay) {
        return { resolved: true, resolved_at: overlay.resolved_at, resolved_by: overlay.resolved_by };
    }
    return {
        resolved: question.resolved === true,
        resolved_at: question.resolved_at,
        resolved_by: question.resolved_by,
    };
}
async function mergeResolvedQuestionsIntoStore(store) {
    const resolvedIndex = await getCachedResolvedQuestions();
    return {
        ...store,
        reflections: store.reflections.map((reflection) => ({
            ...reflection,
            open_questions: reflection.open_questions.map((question, index) => {
                const resolved = resolveQuestionOverlay(reflection.id, index, question, resolvedIndex);
                return resolved.resolved
                    ? {
                        ...question,
                        resolved: true,
                        resolved_at: resolved.resolved_at,
                        resolved_by: resolved.resolved_by,
                    }
                    : question;
            }),
        })),
    };
}
export async function importData(incoming, mode, operationName) {
    // B4-fix: validate incoming is a non-null object before accessing properties
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
        throw new Error("importData requires a non-null 'incoming' object");
    }
    const mutationResult = await mutateStore((store) => {
        let replacementResolvedIndex;
        let mergedResolvedIndex;
        const mergedNewReflections = [];
        let newReflections = 0;
        let newHeuristics = 0;
        let newGaps = 0;
        let newSessions = 0;
        let newMemoryBoard = 0; // E4-fix: track memory_board/user_profile additions
        let newUserProfile = 0;
        if (mode === "replace") {
            if (incoming.reflections) {
                store.reflections = incoming.reflections.map(normalizeReflectionFrame);
                replacementResolvedIndex = resolvedQuestionsFromReflections(store.reflections);
            }
            if (incoming.heuristics) {
                store.heuristics = incoming.heuristics.map(normalizeHeuristicRecord);
            }
            if (incoming.affordance_gaps)
                store.affordance_gaps = incoming.affordance_gaps.map((gap) => normalizeAffordanceGapRecord(gap));
            if (incoming.sessions)
                store.sessions = normalizeSessionsRecord(incoming.sessions);
            if (incoming.memory_board)
                store.memory_board = normalizeMemoryBoard(incoming.memory_board);
            if (incoming.user_profile)
                store.user_profile = normalizeMemoryBoard(incoming.user_profile, 1800);
        }
        else {
            // merge mode: append items whose ids are not already present
            if (incoming.reflections) {
                const existingIds = new Set(store.reflections.map((r) => r.id));
                for (const rawReflection of incoming.reflections) {
                    const r = normalizeReflectionFrame(rawReflection);
                    if (!existingIds.has(r.id)) {
                        mergedNewReflections.push(r);
                        store.reflections.push(r);
                        existingIds.add(r.id);
                        newReflections++;
                    }
                }
            }
            if (incoming.heuristics) {
                const existingIds = new Set(store.heuristics.map((h) => h.id));
                // B4-fix: also check content similarity to avoid importing near-duplicate
                // heuristics that differ only by ID. Uses exact text match (lowercased)
                // for deterministic behavior; semantic dedup is handled by upsertHeuristicMut.
                const existingTexts = new Set(store.heuristics.map((h) => h.heuristic.toLowerCase().trim()));
                for (const h of incoming.heuristics) {
                    const normalized = normalizeHeuristicRecord(h);
                    if (existingIds.has(normalized.id))
                        continue;
                    const textLower = normalized.heuristic.toLowerCase().trim();
                    if (existingTexts.has(textLower))
                        continue; // skip content duplicate
                    store.heuristics.push(normalized);
                    existingIds.add(normalized.id);
                    existingTexts.add(textLower);
                    newHeuristics++;
                }
                // B7-fix: enforce HEURISTIC_MAX_COUNT after merge
                pruneHeuristicsMut(store);
            }
            if (incoming.affordance_gaps) {
                const existingIds = new Set(store.affordance_gaps.map((g) => g.id));
                for (const rawG of incoming.affordance_gaps) {
                    const g = normalizeAffordanceGapRecord(rawG);
                    if (!existingIds.has(g.id)) {
                        store.affordance_gaps.push(g);
                        existingIds.add(g.id);
                        newGaps++;
                    }
                }
            }
            if (incoming.sessions) {
                for (const [id, session] of Object.entries(incoming.sessions)) {
                    if (!store.sessions[id]) {
                        store.sessions[id] = normalizeSessionRecord(id, session);
                        newSessions++;
                    }
                }
            }
            if (incoming.memory_board) {
                const normalized = normalizeMemoryBoard(incoming.memory_board);
                const existingIds = new Set(store.memory_board?.entries.map((e) => e.id) ?? []);
                const board = store.memory_board ?? normalizeMemoryBoard(undefined);
                store.memory_board = board;
                board.used_chars = computeMemoryBoardUsedChars(board.entries); // B8-fix: recompute before merge
                for (const entry of normalized.entries) {
                    if (existingIds.has(entry.id))
                        continue;
                    if (board.used_chars + entry.content.length <= board.char_limit) {
                        board.entries.push(entry);
                        board.used_chars += entry.content.length;
                        newMemoryBoard++; // E4-fix
                    }
                }
            }
            if (incoming.user_profile) {
                const normalized = normalizeMemoryBoard(incoming.user_profile, 1800);
                const existingIds = new Set(store.user_profile?.entries.map((e) => e.id) ?? []);
                const profile = store.user_profile ?? normalizeMemoryBoard(undefined, 1800);
                store.user_profile = profile;
                profile.used_chars = computeMemoryBoardUsedChars(profile.entries); // B8-fix
                for (const entry of normalized.entries) {
                    if (existingIds.has(entry.id))
                        continue;
                    if (profile.used_chars + entry.content.length <= profile.char_limit) {
                        profile.entries.push(entry);
                        profile.used_chars += entry.content.length;
                        newUserProfile++; // E4-fix
                    }
                }
            }
        }
        const mergeCounts = {
            reflections: newReflections,
            heuristics: newHeuristics,
            affordance_gaps: newGaps,
            sessions: newSessions,
            memory_board_added: newMemoryBoard,
            user_profile_added: newUserProfile,
        };
        const replaceCounts = {
            reflections: store.reflections.length,
            heuristics: store.heuristics.length,
            affordance_gaps: store.affordance_gaps.length,
            sessions: Object.keys(store.sessions).length,
            memory_board_added: store.memory_board?.entries.length ?? 0,
            user_profile_added: store.user_profile?.entries.length ?? 0,
        };
        return {
            counts: mode === "replace" ? replaceCounts : mergeCounts,
            replacementResolvedIndex,
            mergedResolvedIndex: mergedResolvedIndex ?? resolvedQuestionsFromReflections(mergedNewReflections),
            mergedNewReflections,
        };
    }, incoming.reflections ? "rewrite" : "none", operationName, { incoming, mode });
    if (mode === "replace" && incoming.reflections) {
        await mutateResolvedQuestions(async (resolved) => {
            for (const key of Object.keys(resolved))
                delete resolved[key];
            Object.assign(resolved, mutationResult.replacementResolvedIndex ?? {});
        });
    }
    if (mode === "merge" && mutationResult.mergedNewReflections.length > 0) {
        const newResolvedEntries = mutationResult.mergedResolvedIndex ?? {};
        if (Object.keys(newResolvedEntries).length > 0) {
            await mutateResolvedQuestions(async (resolved) => {
                for (const [key, entry] of Object.entries(newResolvedEntries)) {
                    if (!resolved[key]) {
                        resolved[key] = entry;
                    }
                }
            });
        }
    }
    return mutationResult.counts;
}
export async function clearData(collection, operationName) {
    await mutateStore((store) => {
        switch (collection) {
            case "reflections":
                store.reflections = [];
                // E3-fix: reset reflection_count on all sessions to keep counts consistent
                for (const s of Object.values(store.sessions)) {
                    s.reflection_count = 0;
                }
                break;
            case "heuristics":
                store.heuristics = [];
                break;
            case "affordance_gaps":
                store.affordance_gaps = [];
                for (const session of Object.values(store.sessions)) {
                    session.affordance_gap_count = 0;
                }
                break;
            case "sessions":
                store.sessions = {};
                break;
            case "all":
                store.sessions = {};
                store.reflections = [];
                store.affordance_gaps = [];
                store.heuristics = [];
                store.memory_board = { entries: [], char_limit: store.memory_board?.char_limit ?? 2200, used_chars: 0 };
                store.user_profile = { entries: [], char_limit: store.user_profile?.char_limit ?? 1800, used_chars: 0 };
                break;
        }
    }, collection === "reflections" || collection === "all" ? "rewrite" : "none", operationName, { collection });
    if (collection === "reflections" || collection === "all") {
        await mutateResolvedQuestions(async (resolved) => {
            for (const key of Object.keys(resolved))
                delete resolved[key];
        });
    }
}
export function normalizeDomain(domain) {
    return domain.toLowerCase().trim() || "general";
}
function normalizeCapability(capability) {
    return capability.toLowerCase().trim();
}
export function generateId() {
    return randomUUID();
}
export async function getHeuristicStats() {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    let activeCount = 0;
    let archivedCount = 0;
    let suspiciousCount = 0;
    const confidenceDistribution = { high: 0, medium: 0, low: 0 };
    let neverRetrieved = 0;
    let staleCount = 0;
    const domains = {};
    const topByRetrievalItems = [];
    const topByReinforcementItems = [];
    for (const heuristic of store.heuristics) {
        if (heuristic.superseded_by) {
            archivedCount++;
            continue;
        }
        activeCount++;
        if (scanHeuristicThreats(heuristic.heuristic, "strict").length > 0)
            suspiciousCount++;
        insertSorted(topByRetrievalItems, heuristic, (a, b) => (b.retrieval_count ?? 0) - (a.retrieval_count ?? 0), 5);
        insertSorted(topByReinforcementItems, heuristic, (a, b) => b.reinforcement_count - a.reinforcement_count, 5);
        if (heuristic.confidence >= 0.8) {
            confidenceDistribution.high++;
        }
        else if (heuristic.confidence >= 0.5) {
            confidenceDistribution.medium++;
        }
        else {
            confidenceDistribution.low++;
        }
        const createdMs = Date.parse(heuristic.created_at);
        if ((heuristic.retrieval_count ?? 0) === 0 &&
            Number.isFinite(createdMs) &&
            now - createdMs > sevenDaysMs) {
            neverRetrieved++;
        }
        if (ebbinghausRetention(heuristic) < 0.3)
            staleCount++;
        const domain = normalizeDomain(heuristic.domain);
        const entry = domains[domain] ?? { count: 0, totalConfidence: 0, totalRetrieval: 0 };
        entry.count++;
        entry.totalConfidence += heuristic.confidence;
        entry.totalRetrieval += heuristic.retrieval_count ?? 0;
        domains[domain] = entry;
    }
    const domainBreakdown = {};
    for (const [domain, entry] of Object.entries(domains)) {
        domainBreakdown[domain] = {
            count: entry.count,
            avg_confidence: Number((entry.totalConfidence / entry.count).toFixed(3)),
            avg_retrieval_count: Number((entry.totalRetrieval / entry.count).toFixed(2)),
        };
    }
    const topByRetrieval = topByRetrievalItems
        .map((heuristic) => ({
        id: heuristic.id,
        heuristic: safeHeuristicText(heuristic.heuristic).slice(0, 100),
        domain: heuristic.domain,
        retrieval_count: heuristic.retrieval_count ?? 0,
    }));
    const topByReinforcement = topByReinforcementItems
        .map((heuristic) => ({
        id: heuristic.id,
        heuristic: safeHeuristicText(heuristic.heuristic).slice(0, 100),
        domain: heuristic.domain,
        reinforcement_count: heuristic.reinforcement_count,
    }));
    return {
        total_active: activeCount,
        total_archived: archivedCount,
        suspicious_count: suspiciousCount,
        confidence_distribution: confidenceDistribution,
        never_retrieved: neverRetrieved,
        stale_count: staleCount,
        domain_breakdown: domainBreakdown,
        top_by_retrieval: topByRetrieval,
        top_by_reinforcement: topByReinforcement,
    };
}
function ebbinghausRetention(heuristic) {
    const referenceTime = heuristic.last_retrieved_at ?? heuristic.updated_at ?? heuristic.created_at;
    const referenceMs = Date.parse(referenceTime);
    if (!Number.isFinite(referenceMs))
        return 1;
    const ageDays = Math.max(0, (Date.now() - referenceMs) / (1000 * 60 * 60 * 24));
    const reinforcement = Math.max(0, heuristic.reinforcement_count ?? 0);
    const stabilityDays = Math.min(EBBINGHAUS_BASE_STABILITY_DAYS * (1 + reinforcement / 5), EBBINGHAUS_MAX_STABILITY_DAYS);
    return Math.exp(-ageDays / stabilityDays);
}
function tokenizeSimilarityText(text) {
    const lower = text.toLowerCase();
    const cjkTokens = [];
    CJK_RE.lastIndex = 0;
    let m;
    while ((m = CJK_RE.exec(lower)) !== null)
        cjkTokens.push(m[0]);
    CJK_REPLACE_RE.lastIndex = 0;
    const asciiTokens = lower
        .replace(CJK_REPLACE_RE, " ")
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((t) => Boolean(t) && !STOPWORDS.has(t));
    CJK_REPLACE_RE.lastIndex = 0;
    return [...asciiTokens, ...cjkTokens];
}
function tokenOverlapStats(a, b) {
    const aTokens = new Set(tokenizeSimilarityText(a));
    const bTokens = new Set(tokenizeSimilarityText(b));
    if (aTokens.size === 0 || bTokens.size === 0)
        return { count: 0, ratio: 0 };
    let overlap = 0;
    for (const token of aTokens) {
        if (bTokens.has(token))
            overlap++;
    }
    return { count: overlap, ratio: overlap / Math.min(aTokens.size, bTokens.size) };
}
function roundScore(value) {
    return Number(value.toFixed(3));
}
function buildFreqMap(tokens) {
    const map = new Map();
    for (const token of tokens)
        map.set(token, (map.get(token) ?? 0) + 1);
    return map;
}
function similarity(a, b, k1 = 1.5, b_param = 0.75, avgDocLen) {
    const aTokens = tokenizeSimilarityText(a);
    const bTokens = tokenizeSimilarityText(b);
    if (aTokens.length === 0 || bTokens.length === 0)
        return 0;
    const docLen = aTokens.length;
    const effectiveAvgDocLen = avgDocLen && avgDocLen > 0 ? avgDocLen : docLen;
    const docFreq = buildFreqMap(aTokens);
    const queryFreq = buildFreqMap(bTokens);
    let score = 0;
    let totalQueryTokens = 0;
    for (const [term, qf] of queryFreq) {
        totalQueryTokens += qf;
        const tf = docFreq.get(term) ?? 0;
        if (tf === 0)
            continue;
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b_param + b_param * (docLen / effectiveAvgDocLen));
        score += qf * (numerator / denominator);
    }
    return totalQueryTokens === 0 ? 0 : Math.min(score / totalQueryTokens, 1.0);
}
/** Escape pipe characters and backslashes for Markdown table cells. */
function mdTableEscape(text) {
    return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
/** Render a Markdown bullet list from non-empty strings. */
function mdBulletList(items, indent = 0) {
    const prefix = "  ".repeat(indent);
    return items.map((item) => `${prefix}- ${item}`).join("\n");
}
/** Generate a filesystem-safe slug from arbitrary text. */
export function safeFilename(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "project-experience";
}
/** Generate a filesystem-safe `.md` filename from arbitrary text. */
export function safeMarkdownFilename(text) {
    return safeFilename(text) + ".md";
}
/** Deduplicate reflections by id, sorted newest-first. */
function dedupeNewestFirst(reflections) {
    const seen = new Set();
    const result = [];
    for (const r of reflections) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            result.push(r);
        }
    }
    return result;
}
/** Compute the date range [earliest, latest] ISO strings from reflections. */
function computeDateRange(reflections) {
    if (reflections.length === 0)
        return null;
    let earliest = reflections[0].timestamp;
    let latest = reflections[0].timestamp;
    for (const r of reflections) {
        if (r.timestamp < earliest)
            earliest = r.timestamp;
        if (r.timestamp > latest)
            latest = r.timestamp;
    }
    return { earliest, latest };
}
/** Format an ISO date string as YYYY-MM-DD for display. */
function fmtDate(iso) {
    return iso.slice(0, 10);
}
/** Truncate a string to maxLen, appending "..." if truncated. */
function truncate(text, maxLen) {
    if (text.length <= maxLen)
        return text;
    return text.slice(0, maxLen - 3) + "...";
}
export async function generateProjectExperienceMarkdown(options = {}) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const limit = options.limit ?? 200;
    // --- Select reflections ---
    let selected;
    if (options.session_id) {
        selected = (cache.sessionIndex.get(options.session_id) ?? [])
            .map((index) => store.reflections[index]);
        if (selected.length === 0)
            return null;
        // Newest-first for presentation, dedupe, apply limit
        selected.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        selected = dedupeNewestFirst(selected);
        selected = selected.slice(0, limit);
    }
    else {
        // Pre-compute filter predicates once
        const normalizedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
        const filterTags = options.tags && options.tags.length > 0 ? normalizeTags(options.tags) : [];
        const tagMode = options.tag_mode ?? "and";
        const cutoff = options.since_days !== undefined
            ? new Date(Date.now() - options.since_days * 24 * 60 * 60 * 1000).toISOString()
            : undefined;
        if (cache.reflectionsAreAscending) {
            // Scan from end (newest) toward start; early-stop once limit is reached
            const seenIds = new Set();
            selected = [];
            for (let i = store.reflections.length - 1; i >= 0 && selected.length < limit; i--) {
                const r = store.reflections[i];
                if (seenIds.has(r.id))
                    continue;
                if (normalizedDomain && normalizeDomain(r.domain) !== normalizedDomain)
                    continue;
                if (filterTags.length > 0 && !matchesTagSet(cache.reflectionTagSetById.get(r.id), filterTags, tagMode))
                    continue;
                if (cutoff !== undefined && r.timestamp < cutoff)
                    continue;
                seenIds.add(r.id);
                selected.push(r);
            }
        }
        else {
            // Correctness fallback: single-pass filter, sort newest-first, dedupe, limit
            const filtered = [];
            for (const r of store.reflections) {
                if (normalizedDomain && normalizeDomain(r.domain) !== normalizedDomain)
                    continue;
                if (filterTags.length > 0 && !matchesTagSet(cache.reflectionTagSetById.get(r.id), filterTags, tagMode))
                    continue;
                if (cutoff !== undefined && r.timestamp < cutoff)
                    continue;
                filtered.push(r);
            }
            filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
            selected = dedupeNewestFirst(filtered).slice(0, limit);
        }
        if (selected.length === 0)
            return null;
    }
    // Load resolved questions overlay once for filtering open questions
    const resolvedIndex = await getCachedResolvedQuestions();
    // Date range from actual timestamps (min/max)
    const dateRange = computeDateRange(selected);
    // --- Build scope string ---
    const scopeParts = [];
    if (options.session_id)
        scopeParts.push(`session: ${options.session_id}`);
    if (options.domain)
        scopeParts.push(`domain: ${options.domain}`);
    if (options.tags && options.tags.length > 0)
        scopeParts.push(`tags: [${options.tags.join(", ")}]`);
    if (options.since_days !== undefined)
        scopeParts.push(`since: ${options.since_days}d`);
    if (scopeParts.length === 0)
        scopeParts.push("all reflections");
    scopeParts.push(`limit ${limit}`);
    const scope = scopeParts.join(", ");
    // --- Aggregate data ---
    const domains = new Set();
    const allGoals = [];
    const allLessons = [];
    const allPaths = [];
    const allToolInsights = [];
    const allWorldUpdates = [];
    const allOpenQuestions = [];
    const allFailureRows = [];
    const allTags = new Set();
    const summaries = [];
    for (const r of selected) {
        domains.add(normalizeDomain(r.domain));
        allGoals.push(r.task_goal);
        for (const lesson of r.lessons_learned) {
            if (lesson.trim())
                allLessons.push(safeHeuristicText(lesson.trim()));
        }
        for (const p of r.task_state.proven_safe_paths) {
            if (p.trim())
                allPaths.push(p.trim());
        }
        for (const ti of r.tool_insights) {
            allToolInsights.push(ti);
        }
        for (const wu of r.world_model_updates) {
            allWorldUpdates.push(wu);
        }
        for (const [index, oq] of r.open_questions.entries()) {
            if (resolveQuestionOverlay(r.id, index, oq, resolvedIndex).resolved)
                continue;
            allOpenQuestions.push(oq);
        }
        if (r.task_outcome === "failure" || r.task_outcome === "partial") {
            const symptom = r.task_state.summary || "";
            const fixCandidate = (r.lessons_learned.length > 0 ? safeHeuristicText(r.lessons_learned[0]) : null)
                ?? r.task_state.proven_safe_paths[0]
                ?? r.task_state.immediate_blockers[0]
                ?? r.task_state.active_hypotheses[0]
                ?? r.task_state.exhausted_search[0]
                ?? "";
            allFailureRows.push({
                task: truncate(r.task_goal, 80),
                failure_mode: r.failure_mode,
                symptom: truncate(symptom, 120),
                fix_lesson: truncate(fixCandidate, 120),
            });
        }
        for (const tag of r.tags ?? []) {
            const nt = tag.toLowerCase().trim();
            if (nt)
                allTags.add(nt);
        }
        if (r.task_state.summary)
            summaries.push(r.task_state.summary);
    }
    // Dedupe lessons by lowercase
    const seenLessons = new Set();
    const uniqueLessons = [];
    for (const lesson of allLessons) {
        const key = lesson.toLowerCase();
        if (!seenLessons.has(key)) {
            seenLessons.add(key);
            uniqueLessons.push(lesson);
        }
    }
    // Dedupe paths by lowercase
    const seenPaths = new Set();
    const uniquePaths = [];
    for (const p of allPaths) {
        const key = p.toLowerCase();
        if (!seenPaths.has(key)) {
            seenPaths.add(key);
            uniquePaths.push(p);
        }
    }
    // Dedupe world model updates by fact lowercase
    const seenFacts = new Set();
    const uniqueWorldUpdates = [];
    for (const wu of allWorldUpdates) {
        const key = wu.fact.toLowerCase();
        if (!seenFacts.has(key)) {
            seenFacts.add(key);
            uniqueWorldUpdates.push(wu);
        }
    }
    // Dedupe open questions by lowercase
    const seenQuestions = new Set();
    const uniqueQuestions = [];
    for (const oq of allOpenQuestions) {
        const key = oq.question.toLowerCase();
        if (!seenQuestions.has(key)) {
            seenQuestions.add(key);
            uniqueQuestions.push(oq);
        }
    }
    // Sort open questions by priority
    const uniqueQuestionsSorted = [...uniqueQuestions].sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
    // --- Build title ---
    const defaultTitleDomain = options.domain ? normalizeDomain(options.domain) : [...domains].sort().join(", ") || "general";
    const titleDate = dateRange ? fmtDate(dateRange.latest) : fmtDate(new Date().toISOString());
    const title = options.title || `${defaultTitleDomain} - Project Experience - ${titleDate}`;
    // --- Outcome counts ---
    const outcomeDist = {};
    for (const r of selected) {
        outcomeDist[r.task_outcome] = (outcomeDist[r.task_outcome] ?? 0) + 1;
    }
    // --- Build Markdown ---
    const sections = [];
    // Title
    sections.push(`# ${title}\n`);
    // Metadata
    const metaLines = [];
    metaLines.push(`**Generated:** ${fmtDate(new Date().toISOString())}`);
    metaLines.push(`**Hermes version:** ${VERSION}`);
    metaLines.push(`**Scope:** ${scope}`);
    metaLines.push(`**Reflections included:** ${selected.length}`);
    if (dateRange) {
        metaLines.push(`**Date range:** ${fmtDate(dateRange.earliest)} to ${fmtDate(dateRange.latest)}`);
    }
    metaLines.push(`**Domains:** ${[...domains].sort().join(", ") || "general"}`);
    const outcomeParts = Object.entries(outcomeDist)
        .sort((a, b) => b[1] - a[1])
        .map(([outcome, count]) => `${count} ${outcome}`);
    metaLines.push(`**Outcomes:** ${outcomeParts.join(", ")}`);
    sections.push(`## Metadata\n\n${metaLines.join("\n")}\n`);
    // Executive Summary
    const execLines = [];
    execLines.push(`This report covers **${selected.length} reflections** across domain(s) **${[...domains].sort().join(", ") || "general"}**.`);
    execLines.push(`Outcome distribution: ${outcomeParts.join(", ")}.`);
    if (summaries.length > 0) {
        execLines.push(`\n**Top summary:** ${summaries[0]}`);
    }
    sections.push(`## Executive Summary\n\n${execLines.join("\n")}\n`);
    // What Was Done
    const goalLines = allGoals.map((g) => truncate(g, 120));
    sections.push(`## What Was Done\n\n${mdBulletList(goalLines)}\n`);
    // Key Lessons
    if (uniqueLessons.length > 0) {
        sections.push(`## Key Lessons\n\n${mdBulletList(uniqueLessons)}\n`);
    }
    // Bugs / Failures / Fixes Table
    if (allFailureRows.length > 0) {
        const header = "| Task | Failure mode | Symptom | Fix / lesson |";
        const sep = "| --- | --- | --- | --- |";
        const rows = allFailureRows.map((row) => `| ${mdTableEscape(row.task)} | ${mdTableEscape(row.failure_mode)} | ${mdTableEscape(row.symptom)} | ${mdTableEscape(row.fix_lesson)} |`);
        sections.push(`## Bugs, Failures, And Fixes\n\n${[header, sep, ...rows].join("\n")}\n`);
    }
    // Proven Safe Paths
    if (uniquePaths.length > 0) {
        sections.push(`## Proven Safe Paths\n\n${mdBulletList(uniquePaths)}\n`);
    }
    // Tool and Workflow Insights
    if (allToolInsights.length > 0) {
        const insightLines = allToolInsights.map((ti) => `**${mdTableEscape(ti.tool)}:** ${ti.insight}`);
        sections.push(`## Tool and Workflow Insights\n\n${mdBulletList(insightLines)}\n`);
    }
    // World Model Updates
    if (uniqueWorldUpdates.length > 0) {
        const header = "| Polarity | Fact | Evidence | Source |";
        const sep = "| --- | --- | --- | --- |";
        const rows = uniqueWorldUpdates.map((wu) => `| ${wu.polarity} | ${mdTableEscape(wu.fact)} | ${mdTableEscape(wu.evidence)} | ${mdTableEscape(wu.source)} |`);
        sections.push(`## World Model Updates\n\n${[header, sep, ...rows].join("\n")}\n`);
    }
    // Open Questions
    if (uniqueQuestionsSorted.length > 0) {
        const qLines = uniqueQuestionsSorted.map((oq) => `[${oq.priority}] ${oq.question}${oq.requires_environment_interaction ? " *(requires env interaction)*" : ""}`);
        sections.push(`## Open Questions\n\n${mdBulletList(qLines)}\n`);
    }
    // RAG Keywords
    const ragKeywordSet = new Set(["hermes-reflection"]);
    for (const d of domains)
        ragKeywordSet.add(d);
    for (const tag of allTags)
        ragKeywordSet.add(tag);
    const ragKeywords = [...ragKeywordSet].sort();
    sections.push(`## RAG Keywords\n\n${ragKeywords.join(", ")}\n`);
    // Source Reflections
    const sourceLines = selected.map((r) => `\`${r.id}\` (${fmtDate(r.timestamp)}) ${truncate(r.task_goal, 100)}`);
    sections.push(`## Source Reflections\n\n${mdBulletList(sourceLines)}\n`);
    // Optional raw reflections (compact per-reflection markdown)
    if (options.include_raw_reflections) {
        const rawLines = [];
        for (const r of selected) {
            rawLines.push(`### ${r.id}`);
            rawLines.push(`- **Goal:** ${r.task_goal}`);
            rawLines.push(`- **Domain:** ${r.domain}`);
            rawLines.push(`- **Outcome:** ${r.task_outcome} (${r.failure_mode})`);
            rawLines.push(`- **Timestamp:** ${r.timestamp}`);
            if (r.task_state.summary)
                rawLines.push(`- **Summary:** ${r.task_state.summary}`);
            if (r.lessons_learned.length > 0)
                rawLines.push(`- **Lessons:** ${r.lessons_learned.map(safeHeuristicText).join("; ")}`);
            if (r.task_state.proven_safe_paths.length > 0)
                rawLines.push(`- **Safe paths:** ${r.task_state.proven_safe_paths.join("; ")}`);
            if (r.task_state.immediate_blockers.length > 0)
                rawLines.push(`- **Blockers:** ${r.task_state.immediate_blockers.join("; ")}`);
            if (r.open_questions.length > 0) {
                const oqLines = r.open_questions
                    .map((oq, index) => ({ oq, resolved: resolveQuestionOverlay(r.id, index, oq, resolvedIndex).resolved }))
                    .filter(({ resolved }) => !resolved)
                    .map(({ oq }) => `[${oq.priority}] ${oq.question}${oq.requires_environment_interaction ? " *(requires env interaction)*" : ""}`);
                if (oqLines.length > 0) {
                    rawLines.push(`- **Open questions:**`);
                    for (const line of oqLines)
                        rawLines.push(`  - ${line}`);
                }
            }
            if (r.context_notes)
                rawLines.push(`- **Context notes:** ${r.context_notes}`);
            rawLines.push("");
        }
        sections.push(`## Raw Reflections\n\n${rawLines.join("\n")}\n`);
    }
    const markdown = sections.join("\n");
    return {
        markdown,
        title,
        reflection_count: selected.length,
        scope,
    };
}
/**
 * Build a Markdown or plaintext document of active heuristics grouped by domain.
 * Returns null when no active heuristics match the filters.
 */
export async function generateHeuristicsExport(options = {}) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const format = options.format ?? "markdown";
    const limitPerDomain = options.limit_per_domain ?? 50;
    const sort = options.sort ?? "confidence";
    const minConfidence = options.min_confidence ?? 0;
    const normalizedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
    const filterTags = normalizeTags(options.tags);
    const tagMode = options.tag_mode ?? "and";
    // --- Filter to active heuristics ---
    let candidates = store.heuristics.filter((h) => !h.superseded_by);
    if (normalizedDomain) {
        candidates = candidates.filter((h) => normalizeDomain(h.domain) === normalizedDomain);
    }
    if (filterTags.length > 0) {
        candidates = candidates.filter((h) => matchesTagSet(cache.heuristicTagSetById.get(h.id), filterTags, tagMode));
    }
    candidates = candidates.filter((h) => h.confidence >= minConfidence);
    if (candidates.length === 0)
        return null;
    // --- Sort ---
    const sortCompare = (a, b) => {
        switch (sort) {
            case "updated_at":
                return b.updated_at.localeCompare(a.updated_at);
            case "created_at":
                return b.created_at.localeCompare(a.created_at);
            case "reinforcement":
                return b.reinforcement_count - a.reinforcement_count;
            case "confidence":
                return b.confidence - a.confidence;
        }
    };
    candidates.sort(sortCompare);
    // --- Group by domain (alphabetical) ---
    const domainMap = new Map();
    for (const h of candidates) {
        const d = normalizeDomain(h.domain);
        let group = domainMap.get(d);
        if (!group) {
            group = [];
            domainMap.set(d, group);
        }
        if (group.length < limitPerDomain) {
            group.push(h);
        }
    }
    const sortedDomains = [...domainMap.keys()].sort();
    // --- Build scope string ---
    const scopeParts = [];
    if (options.domain)
        scopeParts.push(`domain: ${options.domain}`);
    if (options.tags && options.tags.length > 0)
        scopeParts.push(`tags: [${options.tags.join(", ")}]`);
    if (minConfidence > 0)
        scopeParts.push(`min_confidence: ${minConfidence}`);
    scopeParts.push(`sort: ${sort}`);
    scopeParts.push(`limit_per_domain: ${limitPerDomain}`);
    const scope = scopeParts.join(", ");
    // --- Render content ---
    const lines = [];
    const md = format === "markdown";
    const heading = md
        ? (level, text) => `${"#".repeat(level)} ${text}`
        : (_level, text) => text;
    const bold = md ? (t) => `**${t}**` : (t) => t;
    const bullet = (t) => `- ${t}`;
    lines.push(heading(1, "Active Heuristics Export"));
    lines.push("");
    lines.push(`${bold("Generated")}: ${fmtDate(new Date().toISOString())}`);
    lines.push(`${bold("Hermes version")}: ${VERSION}`);
    lines.push(`${bold("Scope")}: ${scope}`);
    lines.push(`${bold("Format")}: ${format}`);
    lines.push("");
    let totalCount = 0;
    for (const d of sortedDomains) {
        const group = domainMap.get(d);
        lines.push(heading(2, d));
        lines.push("");
        for (const h of group) {
            const safeText = safeHeuristicText(h.heuristic);
            const confidence = Math.round(h.confidence * 100);
            const tagStr = h.tags.length > 0 ? ` [${h.tags.join(", ")}]` : "";
            lines.push(bullet(`${safeText} (${confidence}%${tagStr})`));
            totalCount++;
        }
        lines.push("");
    }
    return {
        content: lines.join("\n"),
        format,
        heuristic_count: totalCount,
        domain_count: sortedDomains.length,
        scope,
    };
}
export async function getDomainSummary(domain, topN = 10, includeOpenQuestionsDetail = false) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const resolvedIndex = await getCachedResolvedQuestions();
    const hasAnyResolved = Object.keys(resolvedIndex).length > 0;
    let activeGapsGlobal = 0;
    for (const gap of store.affordance_gaps) {
        if (!gap.resolved)
            activeGapsGlobal++;
    }
    const domainMap = new Map();
    const openQuestionDetailCompare = (a, b) => {
        const priorityDelta = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
        if (priorityDelta !== 0)
            return priorityDelta;
        return b.timestamp.localeCompare(a.timestamp);
    };
    for (const reflection of store.reflections) {
        const d = normalizeDomain(reflection.domain);
        const entry = domainMap.get(d) ?? {
            reflection_count: 0,
            outcome_distribution: {},
            failure_mode_counts: {},
            open_questions: 0,
            open_questions_detail: [],
            recent_lesson_ts: "",
        };
        entry.reflection_count++;
        entry.outcome_distribution[reflection.task_outcome] = (entry.outcome_distribution[reflection.task_outcome] ?? 0) + 1;
        if (reflection.task_outcome !== "success" && reflection.failure_mode !== "success") {
            entry.failure_mode_counts[reflection.failure_mode] = (entry.failure_mode_counts[reflection.failure_mode] ?? 0) + 1;
        }
        const cachedOpenCount = cache.reflectionsWithOpenQuestionsCount.get(reflection.id) ?? 0;
        if (cachedOpenCount > 0) {
            if (!hasAnyResolved && !includeOpenQuestionsDetail) {
                entry.open_questions += cachedOpenCount;
            }
            else {
                for (let i = 0; i < reflection.open_questions.length; i++) {
                    const question = reflection.open_questions[i];
                    const resolved = resolveQuestionOverlay(reflection.id, i, question, resolvedIndex);
                    if (!resolved.resolved) {
                        entry.open_questions++;
                        if (includeOpenQuestionsDetail) {
                            insertSorted(entry.open_questions_detail, {
                                question: question.question,
                                priority: question.priority,
                                reflection_id: reflection.id,
                                requires_environment_interaction: question.requires_environment_interaction,
                                timestamp: reflection.timestamp,
                            }, openQuestionDetailCompare, 10);
                        }
                    }
                }
            }
        }
        for (const lesson of reflection.lessons_learned) {
            if (reflection.timestamp > entry.recent_lesson_ts) {
                entry.recent_lesson_ts = reflection.timestamp;
                entry.recent_lesson = safeHeuristicText(lesson);
            }
        }
        domainMap.set(d, entry);
    }
    const activeHeuristicsByDomain = new Map();
    for (const h of store.heuristics) {
        if (h.superseded_by)
            continue;
        const d = normalizeDomain(h.domain);
        activeHeuristicsByDomain.set(d, (activeHeuristicsByDomain.get(d) ?? 0) + 1);
    }
    function buildSummary(d, entry) {
        let topFailureMode;
        let topFailureCount = 0;
        for (const [mode, count] of Object.entries(entry.failure_mode_counts)) {
            if (count > topFailureCount) {
                topFailureCount = count;
                topFailureMode = mode;
            }
        }
        const topFailureModeDisplay = topFailureMode && topFailureCount > 0
            ? `${topFailureMode} (x${topFailureCount})`
            : undefined;
        const summary = {
            domain: d,
            reflection_count: entry.reflection_count,
            outcome_distribution: entry.outcome_distribution,
            top_failure_mode: topFailureModeDisplay,
            active_heuristics: activeHeuristicsByDomain.get(d) ?? 0,
            active_affordance_gaps_global: activeGapsGlobal,
            open_questions: entry.open_questions,
            recent_lesson: entry.recent_lesson,
        };
        if (includeOpenQuestionsDetail) {
            summary.open_questions_detail = entry.open_questions_detail.map(({ timestamp: _timestamp, ...question }) => question);
        }
        return summary;
    }
    if (domain) {
        const d = normalizeDomain(domain);
        const entry = domainMap.get(d);
        if (!entry) {
            return {
                domain: d,
                reflection_count: 0,
                outcome_distribution: {},
                active_heuristics: activeHeuristicsByDomain.get(d) ?? 0,
                active_affordance_gaps_global: activeGapsGlobal,
                open_questions: 0,
            };
        }
        return buildSummary(d, entry);
    }
    const summaries = [];
    for (const [d, entry] of domainMap.entries()) {
        summaries.push(buildSummary(d, entry));
    }
    summaries.sort((a, b) => b.reflection_count - a.reflection_count);
    return summaries.slice(0, topN);
}
export async function getContradictionReport(domain, minContradictions = 1, limit = 20, includeArchived = false) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
    const results = [];
    const compare = (a, b) => {
        if (b.contradiction_count !== a.contradiction_count)
            return b.contradiction_count - a.contradiction_count;
        return a.confidence - b.confidence;
    };
    for (const h of store.heuristics) {
        if (h.contradiction_count < minContradictions)
            continue;
        if (!includeArchived && h.superseded_by)
            continue;
        if (normalizedDomain && normalizeDomain(h.domain) !== normalizedDomain)
            continue;
        insertSorted(results, {
            id: h.id,
            domain: h.domain,
            heuristic: safeHeuristicText(h.heuristic).slice(0, 200),
            contradiction_count: h.contradiction_count,
            reinforcement_count: h.reinforcement_count,
            confidence: h.confidence,
            contradiction_notes: [...(h.contradiction_notes ?? [])],
            superseded_by: h.superseded_by,
            tags: [...(h.tags ?? [])],
        }, compare, limit);
    }
    return results;
}
export async function getStaleHeuristics(domain, retentionThreshold = 0.3, minAgeDays = 7, limit = 20, includePinned = false) {
    const cache = await getCachedStoreEntry();
    const store = cache.store;
    const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
    const now = Date.now();
    const results = [];
    const compare = (a, b) => a.retention - b.retention;
    for (const h of store.heuristics) {
        if (h.superseded_by)
            continue;
        if (!includePinned && h.pinned)
            continue;
        if (normalizedDomain && normalizeDomain(h.domain) !== normalizedDomain)
            continue;
        const retention = ebbinghausRetention(h);
        if (retention >= retentionThreshold)
            continue;
        const referenceTime = h.last_retrieved_at ?? h.updated_at ?? h.created_at;
        const referenceMs = Date.parse(referenceTime);
        let daysSinceLastActivity;
        if (!Number.isFinite(referenceMs)) {
            daysSinceLastActivity = -1;
        }
        else {
            daysSinceLastActivity = Math.max(0, (now - referenceMs) / (1000 * 60 * 60 * 24));
        }
        const effectiveDays = Number.isFinite(referenceMs) ? daysSinceLastActivity : Infinity;
        if (effectiveDays < minAgeDays)
            continue;
        insertSorted(results, {
            id: h.id,
            domain: h.domain,
            heuristic: safeHeuristicText(h.heuristic).slice(0, 200),
            retention: Number(retention.toFixed(3)),
            reinforcement_count: h.reinforcement_count,
            retrieval_count: h.retrieval_count ?? 0,
            confidence: h.confidence,
            days_since_last_activity: Number.isFinite(daysSinceLastActivity) ? Math.floor(daysSinceLastActivity) : -1,
            tags: [...(h.tags ?? [])],
        }, compare, limit);
    }
    return results;
}
