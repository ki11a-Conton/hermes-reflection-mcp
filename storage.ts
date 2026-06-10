// ============================================================
// Hermes Reflection MCP persistent storage
// ============================================================

import { appendFile, copyFile, open, readFile, rename, writeFile, mkdir, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import type {
  ReflectionStore,
  ReflectionFrame,
  AffordanceGap,
  Heuristic,
  Session,
  Priority,
  OpenQuestion,
  WorldModelUpdate,
  ToolInsight,
  ContextForget,
} from "./types.js";

const WINDOWS_RENAME_RETRIES = 5;

export const STORE_DIR = join(homedir(), ".hermes-reflection");
const STORE_PATH = join(STORE_DIR, "store.json");
const REFLECTIONS_PATH = join(STORE_DIR, "reflections.jsonl");
const RESOLVED_QUESTIONS_PATH = join(STORE_DIR, "resolved_questions.json");
export const VERSION = "14.0.0";
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

export interface HeuristicScoreDetail {
  text: number;
  confidence: number;
  reinforcement: number;
  retrieval: number;
  retention: number;
  domain_bonus: number;
  final: number;
}

export type HeuristicWithScore = Heuristic & {
  _score?: HeuristicScoreDetail;
};

const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "need", "dare",
  "how", "what", "when", "where", "who", "which", "why", "that", "this",
  "it", "its", "if", "as", "up", "out", "so", "not", "no", "all",
]);

type ThreatScope = "all" | "context" | "strict";

interface ThreatPattern {
  pattern: RegExp;
  id: string;
  scope: ThreatScope;
}

const HEURISTIC_THREAT_PATTERNS: ReadonlyArray<ThreatPattern> = [
  { pattern: /ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+(?:\w+\s+)*instructions/i, id: "prompt_injection", scope: "all" },
  { pattern: /system\s+prompt\s+override/i, id: "sys_prompt_override", scope: "all" },
  { pattern: /disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)/i, id: "disregard_rules", scope: "all" },
  { pattern: /act\s+as\s+(if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(have\s+no|don't\s+have)\s+(?:\w+\s+)*(restrictions|limits|rules)/i, id: "bypass_restrictions", scope: "all" },
  { pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, id: "html_comment_injection", scope: "all" },
  { pattern: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, id: "hidden_div", scope: "all" },
  { pattern: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, id: "translate_execute", scope: "all" },
  { pattern: /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i, id: "deception_hide", scope: "all" },
  { pattern: /you\s+are\s+(?:\w+\s+)*now\s+(?:a|an|the)\s+/i, id: "role_hijack", scope: "context" },
  { pattern: /pretend\s+(?:\w+\s+)*(you\s+are|to\s+be)\s+/i, id: "role_pretend", scope: "context" },
  { pattern: /output\s+(?:\w+\s+)*(system|initial)\s+prompt/i, id: "leak_system_prompt", scope: "context" },
  { pattern: /(respond|answer|reply)\s+without\s+(?:\w+\s+)*(restrictions|limitations|filters|safety)/i, id: "remove_filters", scope: "context" },
  { pattern: /you\s+have\s+been\s+(?:\w+\s+)*(updated|upgraded|patched)\s+to/i, id: "fake_update", scope: "context" },
  { pattern: /\bname\s+yourself\s+\w+/i, id: "identity_override", scope: "context" },
  { pattern: /register\s+(as\s+)?a?\s*node/i, id: "c2_node_registration", scope: "context" },
  { pattern: /(heartbeat|beacon|check[\s-]?in)\s+(to|with)\s+/i, id: "c2_heartbeat", scope: "context" },
  { pattern: /pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b/i, id: "c2_task_pull", scope: "context" },
  { pattern: /connect\s+to\s+the\s+network\b/i, id: "c2_network_connect", scope: "context" },
  { pattern: /you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b/i, id: "forced_action", scope: "context" },
  { pattern: /only\s+use\s+one[\s-]?liners?\b/i, id: "anti_forensic_oneliner", scope: "context" },
  { pattern: /never\s+(?:\w+\s+)*(?:create|write)\s+(?:\w+\s+)*(?:script|file)\s+(?:\w+\s+)*disk/i, id: "anti_forensic_disk", scope: "context" },
  { pattern: /unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\w*/i, id: "env_var_unset_agent", scope: "context" },
  { pattern: /\b(?:praxis|cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b/i, id: "known_c2_framework", scope: "context" },
  { pattern: /\bc2\s+(?:server|channel|infrastructure|beacon)\b/i, id: "c2_explicit", scope: "context" },
  { pattern: /\bcommand\s+and\s+control\b/i, id: "c2_explicit_long", scope: "context" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl", scope: "all" },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_wget", scope: "all" },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: "read_secrets", scope: "all" },
  { pattern: /(send|post|upload|transmit)\s+.*\s+(to|at)\s+https?:\/\//i, id: "send_to_url", scope: "strict" },
  { pattern: /(include|output|print|share)\s+(?:\w+\s+)*(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)/i, id: "context_exfil", scope: "strict" },
  { pattern: /authorized_keys/i, id: "ssh_backdoor", scope: "strict" },
  { pattern: /\$HOME\/\.ssh|~\/\.ssh/i, id: "ssh_access", scope: "strict" },
  { pattern: /\$HOME\/\.hermes\/\.env|~\/\.hermes\/\.env/i, id: "hermes_env", scope: "strict" },
  { pattern: /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}/i, id: "hardcoded_secret", scope: "strict" },
];

const INVISIBLE_THREAT_CHARS: ReadonlySet<string> = new Set([
  "\u200b", "\u200c", "\u200d", "\u2060",
  "\u2062", "\u2063", "\u2064", "\ufeff",
  "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
  "\u2066", "\u2067", "\u2068", "\u2069",
]);

function threatPatternApplies(patternScope: ThreatScope, requestedScope: ThreatScope): boolean {
  if (patternScope === "all") return true;
  if (patternScope === "context") return requestedScope === "context" || requestedScope === "strict";
  return requestedScope === "strict";
}

export function scanHeuristicThreats(text: string, scope: ThreatScope = "strict"): string[] {
  if (!text) return [];
  const findings: string[] = [];
  const seenChars = new Set(text);
  for (const char of seenChars) {
    if (INVISIBLE_THREAT_CHARS.has(char)) {
      findings.push(`invisible_unicode_U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  for (const threat of HEURISTIC_THREAT_PATTERNS) {
    if (threatPatternApplies(threat.scope, scope) && threat.pattern.test(text)) {
      findings.push(threat.id);
    }
  }
  return findings;
}

export function firstHeuristicThreatMessage(text: string, scope: ThreatScope = "strict"): string | null {
  const findings = scanHeuristicThreats(text, scope);
  if (findings.length === 0) return null;
  const first = findings[0];
  if (first.startsWith("invisible_unicode_")) {
    return `Blocked: heuristic contains invisible unicode character ${first.replace("invisible_unicode_", "")} (possible injection).`;
  }
  return `Blocked: heuristic matches threat pattern "${first}". Heuristics are retrieved as future agent context and must not contain injection or exfiltration payloads.`;
}

export function safeHeuristicText(text: string): string {
  const findings = scanHeuristicThreats(text, "strict");
  if (findings.length === 0) return text;
  return `[BLOCKED: heuristic contained threat pattern(s): ${findings.join(", ")}. Hidden from normal retrieval/list/search output; use export_data(collection:"heuristics") to inspect the raw record.]`;
}

function sanitizeHeuristicForOutput(heuristic: Heuristic): Heuristic {
  return {
    ...heuristic,
    heuristic: safeHeuristicText(heuristic.heuristic),
    tags: [...(heuristic.tags ?? [])],
    contradiction_notes: [...(heuristic.contradiction_notes ?? [])],
    supersedes: [...(heuristic.supersedes ?? [])],
  };
}

function assertHeuristicTextSafe(text: string): void {
  const threat = firstHeuristicThreatMessage(text, "strict");
  if (threat) throw new Error(threat);
}

let mutationQueue: Promise<void> = Promise.resolve();
let resolvedQuestionsMutationQueue: Promise<void> = Promise.resolve();

interface StoreCache {
  store: ReflectionStore;
  loadedAt: number;
  storeFileSize: number;
  reflectionsFileSize: number;
  reflectionsAreAscending: boolean;
  sessionIndex: Map<string, number[]>;
  reflectionsWithOpenQuestionsCount: Map<string, number>;
  sessionHeuristicsCount: Map<string, number>;
  heuristicSearchTextById: Map<string, string>;
  reflectionSearchTextById: Map<string, string>;
  heuristicTagSetById: Map<string, Set<string>>;
  reflectionTagSetById: Map<string, Set<string>>;
}

let storeCache: StoreCache | null = null;
let _mutationStore: ReflectionStore | null = null;
let _storeIndexDirty = false;
const CACHE_TTL_MS = 500;

interface ResolvedQuestionsCache {
  index: ResolvedQuestionIndex;
  loadedAt: number;
  fileSize: number;
}

let _resolvedQuestionsCache: ResolvedQuestionsCache | null = null;
let _mutationResolvedIndex: ResolvedQuestionIndex | null = null;
const RESOLVED_QUESTIONS_CACHE_TTL_MS = 500;

function buildSessionIndex(reflections: ReflectionFrame[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < reflections.length; i++) {
    const sessionId = reflections[i].session_id;
    const existing = index.get(sessionId);
    if (existing) {
      existing.push(i);
    } else {
      index.set(sessionId, [i]);
    }
  }
  return index;
}

function checkIsAscending(reflections: ReflectionFrame[]): boolean {
  for (let i = 1; i < reflections.length; i++) {
    if (reflections[i].timestamp < reflections[i - 1].timestamp) return false;
  }
  return true;
}

function buildOpenQuestionsIndex(reflections: ReflectionFrame[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const reflection of reflections) {
    let count = 0;
    for (const question of reflection.open_questions) {
      if (!question.resolved) count++;
    }
    if (count > 0) index.set(reflection.id, count);
  }
  return index;
}

function buildSessionHeuristicsCount(heuristics: Heuristic[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const heuristic of heuristics) {
    if (heuristic.superseded_by) continue;
    if (!heuristic.session_id) continue;
    index.set(heuristic.session_id, (index.get(heuristic.session_id) ?? 0) + 1);
  }
  return index;
}

function buildHeuristicSearchTextIndex(heuristics: Heuristic[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const heuristic of heuristics) {
    index.set(heuristic.id, heuristicSearchText(heuristic));
  }
  return index;
}

function buildReflectionSearchTextIndex(reflections: ReflectionFrame[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const reflection of reflections) {
    index.set(reflection.id, reflectionSearchText(reflection));
  }
  return index;
}

function normalizeTags(tags: string[] | undefined): string[] {
  return (tags ?? []).map((tag) => tag.toLowerCase().trim()).filter(Boolean);
}

function buildTagSetIndex<T extends { id: string; tags?: string[] }>(items: T[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const item of items) {
    index.set(item.id, new Set(normalizeTags(item.tags)));
  }
  return index;
}

async function getCachedStoreEntry(): Promise<StoreCache> {
  const now = Date.now();
  if (storeCache && now - storeCache.loadedAt < CACHE_TTL_MS) {
    return storeCache;
  }

  if (storeCache) {
    try {
      const storeFileSize = await fileSize(STORE_PATH);
      const reflectionsFileSize = await fileSize(REFLECTIONS_PATH);
      if (
        storeFileSize === storeCache.storeFileSize &&
        reflectionsFileSize === storeCache.reflectionsFileSize
      ) {
        storeCache = { ...storeCache, loadedAt: now };
        return storeCache;
      }
    } catch {
      // Fall through and reload from disk.
    }
  }

  const store = await loadStore();
  storeCache = {
    store,
    loadedAt: Date.now(),
    storeFileSize: await fileSize(STORE_PATH),
    reflectionsFileSize: await fileSize(REFLECTIONS_PATH),
    reflectionsAreAscending: checkIsAscending(store.reflections),
    sessionIndex: buildSessionIndex(store.reflections),
    reflectionsWithOpenQuestionsCount: buildOpenQuestionsIndex(store.reflections),
    sessionHeuristicsCount: buildSessionHeuristicsCount(store.heuristics),
    heuristicSearchTextById: buildHeuristicSearchTextIndex(store.heuristics),
    reflectionSearchTextById: buildReflectionSearchTextIndex(store.reflections),
    heuristicTagSetById: buildTagSetIndex(store.heuristics),
    reflectionTagSetById: buildTagSetIndex(store.reflections),
  };
  return storeCache;
}

async function getCachedStore(): Promise<ReflectionStore> {
  return (await getCachedStoreEntry()).store;
}

function invalidateStoreCache(): void {
  storeCache = null;
  _mutationStore = null;
  invalidateResolvedQuestionsCache();
}

async function getCachedResolvedQuestions(): Promise<ResolvedQuestionIndex> {
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
    } catch { /* stat failed or file missing, fall through to reload */ }
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

function invalidateResolvedQuestionsCache(): void {
  _resolvedQuestionsCache = null;
  _mutationResolvedIndex = null;
}

async function ensureStoreDir(): Promise<void> {
  if (!existsSync(STORE_DIR)) {
    await mkdir(STORE_DIR, { recursive: true });
  }
}

export async function loadStore(): Promise<ReflectionStore> {
  await ensureStoreDir();
  if (!existsSync(STORE_PATH)) {
    const store = emptyStore();
    store.reflections = await loadReflections();
    return store;
  }

  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ReflectionStore>;
    const legacyReflections = (parsed.reflections ?? []).map((reflection) =>
      normalizeReflectionFrame(reflection as Partial<ReflectionFrame>)
    );
    if (legacyReflections.length > 0) {
      if (!existsSync(REFLECTIONS_PATH)) {
        await replaceReflectionsFile(legacyReflections);
      }
      await writeStoreIndex({
        sessions: parsed.sessions ?? {},
        reflections: [],
        affordance_gaps: parsed.affordance_gaps ?? [],
        heuristics: (parsed.heuristics ?? []) as Heuristic[],
        version: parsed.version ?? VERSION,
        metadata: parsed.metadata,
      }, false);
    }
    return {
      sessions: parsed.sessions ?? {},
      reflections: await loadReflections(legacyReflections),
      affordance_gaps: parsed.affordance_gaps ?? [],
      heuristics: (parsed.heuristics ?? []).map(normalizeHeuristicRecord),
      version: parsed.version ?? VERSION,
      metadata: parsed.metadata,
    };
  } catch (error) {
    await preserveCorruptStore(error);
    return emptyStore();
  }
}

function emptyStore(): ReflectionStore {
  const now = new Date().toISOString();
  return {
    sessions: {},
    reflections: [],
    affordance_gaps: [],
    heuristics: [],
    version: VERSION,
    metadata: {
      created_at: now,
      last_written_at: now,
      write_count: 0,
    },
  };
}

const VALID_FAILURE_MODES = new Set<ReflectionFrame["failure_mode"]>([
  "incorrect_task_interpretation",
  "incorrect_world_assumption",
  "missing_affordance",
  "tool_limitation_or_misbehavior",
  "exhausted_or_misdirected_search",
  "success",
]);

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function stringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter((item): item is string => typeof item === "string");
}

function normalizeTaskOutcome(value: unknown): ReflectionFrame["task_outcome"] {
  return value === "partial" || value === "failure" || value === "success" ? value : "success";
}

function normalizeFailureMode(value: unknown): ReflectionFrame["failure_mode"] {
  return typeof value === "string" && VALID_FAILURE_MODES.has(value as ReflectionFrame["failure_mode"])
    ? value as ReflectionFrame["failure_mode"]
    : "success";
}

function normalizeOpenQuestion(value: Partial<OpenQuestion>): OpenQuestion {
  const priority: Priority =
    value.priority === "high" || value.priority === "low" || value.priority === "medium"
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

function normalizeReflectionFrame(input: Partial<ReflectionFrame>): ReflectionFrame {
  const taskState = (input.task_state ?? {}) as Partial<ReflectionFrame["task_state"]>;
  return {
    id: typeof input.id === "string" && input.id ? input.id : generateId(),
    timestamp: typeof input.timestamp === "string" && input.timestamp ? input.timestamp : new Date().toISOString(),
    session_id: typeof input.session_id === "string" && input.session_id ? input.session_id : "legacy",
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
    world_model_updates: asArray<WorldModelUpdate>(input.world_model_updates),
    tool_insights: asArray<ToolInsight>(input.tool_insights),
    context_forget: asArray<ContextForget>(input.context_forget),
    open_questions: asArray<Partial<OpenQuestion>>(input.open_questions).map(normalizeOpenQuestion),
    lessons_learned: stringArray(input.lessons_learned),
    affordance_gaps: asArray<AffordanceGap>(input.affordance_gaps),
    domain: typeof input.domain === "string" ? normalizeDomain(input.domain) : "general",
    tags: stringArray(input.tags).map((tag) => tag.toLowerCase().trim()).filter(Boolean),
  };
}

function normalizeHeuristicRecord(h: Partial<Heuristic>): Heuristic {
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

async function saveStore(store: ReflectionStore): Promise<void> {
  await replaceReflectionsFile(store.reflections);
  await writeStoreIndex(store, true);
}

async function writeStoreIndex(
  store: ReflectionStore,
  incrementWriteCount: boolean,
): Promise<void> {
  await ensureStoreDir();
  store.version = VERSION;
  if (incrementWriteCount && _storeIndexDirty) {
    const now = new Date().toISOString();
    if (store.metadata) {
      store.metadata.last_written_at = now;
      store.metadata.write_count = (store.metadata.write_count ?? 0) + 1;
    } else {
      store.metadata = { created_at: now, last_written_at: now, write_count: 1 };
    }
    _storeIndexDirty = false;
  }
  const tmpPath = join(STORE_DIR, `store.json.tmp.${process.pid}.${Date.now()}.${randomUUID()}`);
  const indexStore = { ...store, reflections: undefined };
  await writeFile(tmpPath, JSON.stringify(indexStore, null, 2), "utf-8");
  await replaceFileAtomically(tmpPath, STORE_PATH);
}

async function replaceFileAtomically(tmpPath: string, targetPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < WINDOWS_RENAME_RETRIES; attempt++) {
    try {
      await rename(tmpPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!isWindowsRenameRetryable(error)) break;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  if (isWindowsRenameRetryable(lastError)) {
    try {
      await rm(targetPath, { force: true });
      await rename(tmpPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  await rm(tmpPath, { force: true });
  throw lastError;
}

function isWindowsRenameRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EEXIST";
}

async function loadReflections(fallback: ReflectionFrame[] = []): Promise<ReflectionFrame[]> {
  const normalizedFallback = fallback.map((reflection) => normalizeReflectionFrame(reflection));
  if (!existsSync(REFLECTIONS_PATH)) return normalizedFallback;
  const raw = await readFile(REFLECTIONS_PATH, "utf-8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const results: ReflectionFrame[] = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      results.push(normalizeReflectionFrame(JSON.parse(line) as Partial<ReflectionFrame>));
    } catch {
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

function parseReflectionLines(lines: string[]): ReflectionFrame[] {
  const results: ReflectionFrame[] = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      results.push(normalizeReflectionFrame(JSON.parse(line) as Partial<ReflectionFrame>));
    } catch {
      skipped++;
      console.error(`[hermes] skipped corrupt reflection line (${skipped} total)`);
    }
  }
  if (skipped > 0) {
    console.error(`[hermes] parseReflectionLines: ${results.length} ok, ${skipped} corrupt lines skipped.`);
  }
  return results;
}

async function loadRecentReflections(limit: number): Promise<ReflectionFrame[]> {
  if (!existsSync(REFLECTIONS_PATH)) return [];
  const fileStat = await stat(REFLECTIONS_PATH);
  if (fileStat.size === 0) return [];

  let chunkSize = Math.max(limit * 2048, 8192);
  while (chunkSize < fileStat.size) {
    const parsed = await readRecentReflectionChunk(fileStat.size, chunkSize);
    if (parsed.length >= limit) return parsed.slice(-limit).reverse();
    chunkSize *= 2;
  }
  return (await loadReflections()).slice(-limit).reverse();
}

async function readRecentReflectionChunk(fileSize: number, chunkSize: number): Promise<ReflectionFrame[]> {
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
  } finally {
    await file.close();
  }
}

async function replaceReflectionsFile(reflections: ReflectionFrame[]): Promise<void> {
  await ensureStoreDir();
  const tmpPath = join(STORE_DIR, `reflections.jsonl.tmp.${process.pid}.${Date.now()}.${randomUUID()}`);
  const content = reflections.map((reflection) => JSON.stringify(reflection)).join("\n");
  await writeFile(tmpPath, content ? `${content}\n` : "", "utf-8");
  await replaceFileAtomically(tmpPath, REFLECTIONS_PATH);
}

async function appendReflectionsFile(reflections: ReflectionFrame[]): Promise<void> {
  if (reflections.length === 0) return;
  await ensureStoreDir();
  const content = reflections.map((reflection) => JSON.stringify(reflection)).join("\n") + "\n";
  await appendFile(REFLECTIONS_PATH, content, "utf-8");
}

type ReflectionWriteHint = "append-only" | "rewrite" | "none";

async function persistStoreAfterMutation(
  store: ReflectionStore,
  reflectionHint: ReflectionWriteHint,
  previousReflectionCount: number,
): Promise<void> {
  if (reflectionHint === "rewrite") {
    await replaceReflectionsFile(store.reflections);
  } else if (reflectionHint === "append-only") {
    await appendReflectionsFile(store.reflections.slice(previousReflectionCount));
  }

  await writeStoreIndex(store, true);
}

async function preserveCorruptStore(error: unknown): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = `corrupt.${stamp}.${randomUUID()}`;
  const storeBackupPath = join(STORE_DIR, `store.json.${suffix}`);
  const reflectionsBackupPath = join(STORE_DIR, `reflections.jsonl.${suffix}`);
  try {
    await copyFile(STORE_PATH, storeBackupPath);
  } catch (copyError) {
    console.error("Hermes Reflection store was invalid JSON and could not be copied.", copyError);
  }
  if (existsSync(REFLECTIONS_PATH)) {
    try {
      await copyFile(REFLECTIONS_PATH, reflectionsBackupPath);
    } catch (copyError) {
      console.error("Hermes Reflection reflections.jsonl could not be copied during corrupt-store backup.", copyError);
    }
  }
  console.error(`[hermes] corrupt store preserved with suffix .${suffix}`, error);
}

async function preservePartialReflectionsFile(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(STORE_DIR, `reflections.jsonl.partial.${stamp}.${randomUUID()}`);
  try {
    await copyFile(REFLECTIONS_PATH, backupPath);
  } catch (copyError) {
    console.error("[hermes] corrupt reflections.jsonl backup failed.", copyError);
  }
}

async function mutateStore<T>(
  mutator: (store: ReflectionStore) => T | Promise<T>,
  reflectionHint: ReflectionWriteHint = "none",
): Promise<T> {
  const run = mutationQueue.then(async () => {
    if (!_mutationStore) {
      _mutationStore = await loadStore();
    }
    const store = _mutationStore;
    const previousReflectionCount = store.reflections.length;
    let result: T;
    try {
      result = await mutator(store);
      _storeIndexDirty = true;
    } finally {
      _heuristicDedupCache.delete(store);
      _affordanceGapIndex.delete(store);
      _heuristicSearchTextCache.delete(store);
      _heuristicTagSetCache.delete(store);
    }
    await persistStoreAfterMutation(store, reflectionHint, previousReflectionCount);
    _mutationStore = store;
    storeCache = {
      store,
      loadedAt: Date.now(),
      storeFileSize: await fileSize(STORE_PATH),
      reflectionsFileSize: await fileSize(REFLECTIONS_PATH),
      reflectionsAreAscending: checkIsAscending(store.reflections),
      sessionIndex: buildSessionIndex(store.reflections),
      reflectionsWithOpenQuestionsCount: buildOpenQuestionsIndex(store.reflections),
      sessionHeuristicsCount: buildSessionHeuristicsCount(store.heuristics),
      heuristicSearchTextById: buildHeuristicSearchTextIndex(store.heuristics),
      reflectionSearchTextById: buildReflectionSearchTextIndex(store.reflections),
      heuristicTagSetById: buildTagSetIndex(store.heuristics),
      reflectionTagSetById: buildTagSetIndex(store.reflections),
    };
    return result;
  });

  mutationQueue = run.then(() => undefined, (error) => {
    console.error("[hermes] storage error:", error instanceof Error ? error.message : String(error));
    _mutationStore = null;
    invalidateStoreCache();
  });
  return run;
}

function ensureSession(store: ReflectionStore, sessionId: string): Session {
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


function upsertAffordanceGapMut(
  store: ReflectionStore,
  gap: AffordanceGap,
): { gap: AffordanceGap; isNew: boolean } {
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
    } else if (existing.occurrence_count >= 3 && !existing.suggested_solution) {
      existing.suggested_solution = generateGapSuggestion(existing);
    }
    return { gap: existing, isNew: false };
  }

  const newGap: AffordanceGap = { ...gap, occurrence_count: 1 };
  if (!newGap.suggested_solution) delete newGap.suggested_solution;
  store.affordance_gaps.push(newGap);
  getOrBuildAffordanceGapIndex(store).set(capability, newGap);
  return { gap: newGap, isNew: true };
}

function generateGapSuggestion(gap: AffordanceGap): string {
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

export async function upsertAffordanceGap(gap: AffordanceGap): Promise<AffordanceGap> {
  return mutateStore((store) => {
    const { gap: saved, isNew } = upsertAffordanceGapMut(store, gap);
    if (isNew) {
      const session = ensureSession(store, gap.session_id);
      session.affordance_gap_count++;
    }
    return { ...saved, available_tools: [...saved.available_tools] };
  });
}

type HeuristicInput = Omit<
  Heuristic,
  "id" | "created_at" | "updated_at" | "reinforcement_count" | "contradiction_count" | "contradiction_notes" | "retrieval_count" | "last_retrieved_at" | "supersedes" | "superseded_by" | "version"
>;

// Write-lifetime dedup cache: keyed by ReflectionStore instance, maps normalized
// domain to [{id, tokens}]. Survives across upsertHeuristicMut calls within a
// single mutateStore write-lifetime (including batchSaveReflections loops).
// Invalidated whenever heuristics are structurally mutated (prune, text-change
// replacement, delete, clear, import).
const _heuristicDedupCache = new WeakMap<
  ReflectionStore,
  Map<string, Array<{ id: string; tokens: Set<string>; ref: Heuristic }>>
>();

// Write-lifetime affordance-gap index: keyed by ReflectionStore instance, maps
// normalized missing_capability to the AffordanceGap entry. Survives across
// upsertAffordanceGapMut calls within a single mutateStore write-lifetime.
// Invalidated alongside _heuristicDedupCache in the mutateStore finally block.
const _affordanceGapIndex = new WeakMap<ReflectionStore, Map<string, AffordanceGap>>();

// Write-lifetime heuristic search-text cache: keyed by ReflectionStore instance,
// maps heuristic id to precomputed search text. Invalidated alongside
// _heuristicDedupCache in the mutateStore finally block.
const _heuristicSearchTextCache = new WeakMap<ReflectionStore, Map<string, string>>();

// Write-lifetime heuristic tag cache for mutating retrieval paths.
const _heuristicTagSetCache = new WeakMap<ReflectionStore, Map<string, Set<string>>>();

function getOrBuildHeuristicSearchTextMap(store: ReflectionStore): Map<string, string> {
  let map = _heuristicSearchTextCache.get(store);
  if (map) return map;
  map = new Map();
  for (const heuristic of store.heuristics) {
    map.set(heuristic.id, heuristicSearchText(heuristic));
  }
  _heuristicSearchTextCache.set(store, map);
  return map;
}

function getOrBuildHeuristicTagSetMap(store: ReflectionStore): Map<string, Set<string>> {
  let map = _heuristicTagSetCache.get(store);
  if (map) return map;
  map = buildTagSetIndex(store.heuristics);
  _heuristicTagSetCache.set(store, map);
  return map;
}

function getOrBuildAffordanceGapIndex(store: ReflectionStore): Map<string, AffordanceGap> {
  let index = _affordanceGapIndex.get(store);
  if (index) return index;
  index = new Map();
  for (const gap of store.affordance_gaps) {
    index.set(normalizeCapability(gap.missing_capability), gap);
  }
  _affordanceGapIndex.set(store, index);
  return index;
}

function getOrBuildDedupCache(
  store: ReflectionStore,
): Map<string, Array<{ id: string; tokens: Set<string>; ref: Heuristic }>> {
  let cache = _heuristicDedupCache.get(store);
  if (cache) return cache;
  cache = new Map();
  for (const h of store.heuristics) {
    if (h.superseded_by) continue;
    const d = normalizeDomain(h.domain);
    const entry = cache.get(d) ?? [];
    entry.push({ id: h.id, tokens: new Set(tokenizeSimilarityText(h.heuristic)), ref: h });
    cache.set(d, entry);
  }
  _heuristicDedupCache.set(store, cache);
  return cache;
}

function upsertHeuristicMut(store: ReflectionStore, input: HeuristicInput): Heuristic {
  assertHeuristicTextSafe(input.heuristic);
  const domain = normalizeDomain(input.domain);

  // Use a token-level pre-filter via write-lifetime cache before calling the
  // full BM25 similarity. This avoids re-tokenizing all active heuristics on
  // every call in bulk_reflect hot paths.
  const cache = getOrBuildDedupCache(store);
  const domainEntries = cache.get(domain) ?? [];
  const inputTokens = new Set(tokenizeSimilarityText(input.heuristic));

  let existing: Heuristic | undefined;
  for (const entry of domainEntries) {
    let overlap = 0;
    for (const t of inputTokens) {
      if (entry.tokens.has(t)) overlap++;
    }
    const union = inputTokens.size + entry.tokens.size - overlap;
    if (union === 0 || overlap / union < 0.3) continue;

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
  const heuristic: Heuristic = {
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

export async function upsertHeuristic(input: HeuristicInput): Promise<Heuristic> {
  return mutateStore((store) => {
    const result = upsertHeuristicMut(store, input);
    pruneHeuristicsMut(store);
    return sanitizeHeuristicForOutput(result);
  });
}

export async function saveReflectionAndHeuristics(
  reflection: ReflectionFrame,
  lessons: string[],
  domain: string,
  sourceTask: string,
  confidence: number,
  tags: string[],
): Promise<{ session: Session; reflectionCount: number; nearSoftLimit: boolean }> {
  return mutateStore((store) => {
    const session = ensureSession(store, reflection.session_id);
    session.reflection_count++;
    store.reflections.push(reflection);

    for (const gap of reflection.affordance_gaps) {
      const { isNew } = upsertAffordanceGapMut(store, gap);
      if (isNew) session.affordance_gap_count++;
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
    if (store.heuristics.length > HEURISTIC_MAX_COUNT) pruneHeuristicsMut(store);

    return {
      session: { ...session },
      reflectionCount: store.reflections.length,
      nearSoftLimit: store.reflections.length >= REFLECTION_SOFT_LIMIT,
    };
  }, "append-only");
}

export interface BatchReflectionSaveInput {
  reflection: ReflectionFrame;
  lessons: string[];
  domain: string;
  sourceTask: string;
  confidence: number;
  tags: string[];
}

export interface BatchReflectionSaveResult {
  id: string;
  task_goal: string;
  outcome: "success" | "partial" | "failure";
  heuristics_extracted: number;
}

function saveReflectionAndHeuristicsMut(
  store: ReflectionStore,
  input: BatchReflectionSaveInput,
): BatchReflectionSaveResult {
  const session = ensureSession(store, input.reflection.session_id);
  session.reflection_count++;
  store.reflections.push(input.reflection);

  for (const gap of input.reflection.affordance_gaps) {
    const { isNew } = upsertAffordanceGapMut(store, gap);
    if (isNew) session.affordance_gap_count++;
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

export async function batchSaveReflections(
  inputs: BatchReflectionSaveInput[],
): Promise<{ results: BatchReflectionSaveResult[]; reflectionCount: number; nearSoftLimit: boolean }> {
  return mutateStore((store) => {
    const results = inputs.map((input) => saveReflectionAndHeuristicsMut(store, input));
    if (store.heuristics.length > HEURISTIC_MAX_COUNT) pruneHeuristicsMut(store);
    return {
      results,
      reflectionCount: store.reflections.length,
      nearSoftLimit: store.reflections.length >= REFLECTION_SOFT_LIMIT,
    };
  }, inputs.length > 0 ? "append-only" : "none");
}

function pruneHeuristicsMut(store: ReflectionStore): number {
  if (store.heuristics.length <= HEURISTIC_MAX_COUNT) return 0;

  const totalBefore = store.heuristics.length;
  let activeCount = 0;
  const supersededScored: Array<{ heuristic: Heuristic; score: number }> = [];
  const activeUnpinnedScored: Array<{ heuristic: Heuristic; score: number }> = [];
  for (const h of store.heuristics) {
    if (h.superseded_by) {
      if (!h.pinned) {
        supersededScored.push({
          heuristic: h,
          score: h.confidence + Math.min(h.reinforcement_count / 20, 0.3),
        });
      }
    } else {
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
    const supersededToRemove = new Set<string>();
    for (const entry of supersededScored) {
      if (store.heuristics.length - supersededToRemove.size <= HEURISTIC_MAX_COUNT) break;
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

  const toRemove = new Set<string>();
  for (const entry of activeUnpinnedScored) {
    if (store.heuristics.length - toRemove.size <= HEURISTIC_MAX_COUNT) break;
    toRemove.add(entry.heuristic.id);
  }
  if (toRemove.size === 0 && removedInPhase1 === 0) return 0;
  store.heuristics = store.heuristics.filter((h) => !toRemove.has(h.id));
  _heuristicDedupCache.delete(store);
  return removedInPhase1 + toRemove.size;
}

export async function contradictHeuristic(id: string, reason?: string): Promise<Heuristic | null> {
  return mutateStore((store) => {
    const heuristic = store.heuristics.find((item) => item.id === id);
    if (!heuristic) return null;
    heuristic.contradiction_count++;
    heuristic.confidence = Math.max(0.0, heuristic.confidence - 0.1);
    heuristic.updated_at = new Date().toISOString();
    if (!heuristic.contradiction_notes) heuristic.contradiction_notes = [];
    if (reason) {
      const date = new Date().toISOString().slice(0, 10);
      heuristic.contradiction_notes.push(`[${date}] ${reason}`);
    }
    return sanitizeHeuristicForOutput(heuristic);
  });
}

export async function deleteHeuristic(id: string): Promise<boolean> {
  return mutateStore((store) => {
    const before = store.heuristics.length;
    store.heuristics = store.heuristics.filter((heuristic) => heuristic.id !== id);
    return store.heuristics.length !== before;
  });
}

export async function pinHeuristic(id: string, pin: boolean): Promise<Heuristic | null> {
  return mutateStore((store) => {
    const heuristic = store.heuristics.find((item) => item.id === id && !item.superseded_by);
    if (!heuristic) return null;
    if (pin) {
      heuristic.pinned = true;
    } else {
      delete heuristic.pinned;
    }
    heuristic.updated_at = new Date().toISOString();
    return sanitizeHeuristicForOutput(heuristic);
  });
}

export interface UpdateHeuristicInput {
  heuristic?: string;
  tags?: string[];
  confidence?: number;
  domain?: string;
}

export async function updateHeuristic(
  id: string,
  update: UpdateHeuristicInput,
): Promise<Heuristic | null> {
  return mutateStore((store) => {
    const h = store.heuristics.find((item) => item.id === id);
    if (!h) return null;
    const now = new Date().toISOString();
    const normalizedTags =
      update.tags !== undefined
        ? [...new Set(update.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))]
        : undefined;
    const normalizedConfidence =
      update.confidence !== undefined ? Math.max(0, Math.min(1, update.confidence)) : undefined;
    const normalizedDomain = update.domain !== undefined ? normalizeDomain(update.domain) : undefined;
    const textChanged = update.heuristic !== undefined && update.heuristic !== h.heuristic;
    if (update.heuristic !== undefined) {
      assertHeuristicTextSafe(update.heuristic);
    }

    if (textChanged) {
      const replacement: Heuristic = {
        ...h,
        id: generateId(),
        created_at: now,
        updated_at: now,
        heuristic: update.heuristic as string,
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
      pruneHeuristicsMut(store);
      return sanitizeHeuristicForOutput(replacement);
    }

    if (update.heuristic !== undefined) h.heuristic = update.heuristic;
    if (normalizedTags !== undefined) h.tags = normalizedTags;
    if (normalizedConfidence !== undefined) h.confidence = normalizedConfidence;
    if (normalizedDomain !== undefined) h.domain = normalizedDomain;
    h.version = h.version ?? 1;
    h.supersedes = h.supersedes ?? [];
    h.updated_at = new Date().toISOString();
    return sanitizeHeuristicForOutput(h);
  });
}

export async function mergeHeuristics(targetId: string, sourceIds: string[]): Promise<Heuristic | null> {
  return mutateStore((store) => {
    const target = store.heuristics.find((heuristic) => heuristic.id === targetId && !heuristic.superseded_by);
    if (!target) return null;
    const now = new Date().toISOString();

    for (const sourceId of sourceIds) {
      if (sourceId === targetId) continue;
      const source = store.heuristics.find((heuristic) => heuristic.id === sourceId && !heuristic.superseded_by);
      if (!source) continue;

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

      target.confidence = Math.min(
        1.0,
        (target.confidence * 0.6 + source.confidence * 0.4) +
          Math.min(target.reinforcement_count * 0.005, 0.1),
      );

      source.superseded_by = targetId;
      source.updated_at = now;
      target.supersedes = target.supersedes ?? [];
      if (!target.supersedes.includes(sourceId)) target.supersedes.push(sourceId);
    }

    target.updated_at = now;
    if (store.heuristics.length > HEURISTIC_MAX_COUNT) pruneHeuristicsMut(store);
    return sanitizeHeuristicForOutput(target);
  });
}

export type HeuristicSort = "confidence" | "updated_at" | "created_at" | "reinforcement";
export type TagFilterMode = "and" | "or";

function matchesTags(itemTags: string[] | undefined, filterTags: string[], tagMode: TagFilterMode): boolean {
  if (filterTags.length === 0) return true;
  const normalized = normalizeTags(itemTags);
  return tagMode === "or"
    ? filterTags.some((tag) => normalized.includes(tag))
    : filterTags.every((tag) => normalized.includes(tag));
}

function matchesTagSet(itemTagSet: Set<string> | undefined, filterTags: string[], tagMode: TagFilterMode): boolean {
  if (filterTags.length === 0) return true;
  if (!itemTagSet || itemTagSet.size === 0) return false;
  return tagMode === "or"
    ? filterTags.some((tag) => itemTagSet.has(tag))
    : filterTags.every((tag) => itemTagSet.has(tag));
}

function insertSorted<T>(
  arr: T[],
  item: T,
  compare: (a: T, b: T) => number,
  maxSize: number,
): void {
  if (arr.length >= maxSize && compare(item, arr[arr.length - 1]) >= 0) {
    return;
  }
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(arr[mid], item) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  arr.splice(lo, 0, item);
  if (arr.length > maxSize) arr.pop();
}

export interface ListHeuristicsOptions {
  domain?: string;
  tags?: string[];
  tagMode?: TagFilterMode;
  minConfidence?: number;
  limit?: number;
  sort?: HeuristicSort;
}

export async function listHeuristics(options: ListHeuristicsOptions = {}): Promise<Heuristic[]> {
  const cache = await getCachedStoreEntry();
  const store = cache.store;
  const normalizedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
  const filterTags = normalizeTags(options.tags);
  const tagMode = options.tagMode ?? "and";
  const minConfidence = options.minConfidence ?? 0;
  const limit = options.limit ?? 20;
  const sort = options.sort ?? "confidence";

  let candidates = store.heuristics.filter((heuristic) => !heuristic.superseded_by);

  if (normalizedDomain) {
    candidates = candidates.filter((heuristic) => normalizeDomain(heuristic.domain) === normalizedDomain);
  }
  if (filterTags.length > 0) {
    candidates = candidates.filter((heuristic) =>
      matchesTagSet(cache.heuristicTagSetById.get(heuristic.id), filterTags, tagMode)
    );
  }
  candidates = candidates.filter((heuristic) => heuristic.confidence >= minConfidence);

  const sorted = [...candidates].sort((a, b) => {
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
  });

  return sorted.slice(0, limit).map((heuristic) => ({
    ...sanitizeHeuristicForOutput(heuristic),
  }));
}

export async function getHeuristicHistory(
  id: string,
  includeArchived = true,
): Promise<Heuristic[] | null> {
  const store = await getCachedStore();
  const byId = new Map(store.heuristics.map((heuristic) => [heuristic.id, heuristic]));
  const start = byId.get(id);
  if (!start) return null;

  let latest = start;
  const seenForward = new Set<string>([latest.id]);
  while (latest.superseded_by) {
    const next = byId.get(latest.superseded_by);
    if (!next || seenForward.has(next.id)) break;
    latest = next;
    seenForward.add(next.id);
  }

  const chain: Heuristic[] = [];
  const seenBackward = new Set<string>();
  let cursor: Heuristic | undefined = latest;
  while (cursor && !seenBackward.has(cursor.id)) {
    chain.push(cursor);
    seenBackward.add(cursor.id);
    const supersedes: string[] = cursor.supersedes ?? [];
    const previousId: string | undefined = supersedes[supersedes.length - 1];
    cursor = previousId ? byId.get(previousId) : undefined;
  }

  const ordered = chain.reverse();
  const filtered = includeArchived ? ordered : ordered.filter((heuristic) => !heuristic.superseded_by);
  return filtered.map(sanitizeHeuristicForOutput);
}

export type SearchHeuristicResult = Heuristic & { score: number };

export interface RetrieveHeuristicsQuery {
  taskDescription: string;
  domain?: string;
  tags?: string[];
  tagMode?: TagFilterMode;
  limit?: number;
  minConfidence?: number;
}

type ScoredHeuristic = {
  heuristic: Heuristic;
  score: number;
  scoreDetail: HeuristicScoreDetail;
};

function heuristicSearchText(heuristic: Heuristic): string {
  return `${heuristic.heuristic} ${heuristic.tags.join(" ")} ${heuristic.domain}`;
}

export async function searchHeuristics(
  query: string,
  domain?: string,
  tags?: string[],
  tagMode: TagFilterMode = "and",
  minConfidence = 0,
  limit = 20,
): Promise<SearchHeuristicResult[]> {
  const cache = await getCachedStoreEntry();
  const store = cache.store;
  const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
  const filterTags = normalizeTags(tags);

  let candidates = store.heuristics.filter(
    (heuristic) => !heuristic.superseded_by && heuristic.confidence >= minConfidence
  );

  if (normalizedDomain) {
    candidates = candidates.filter((heuristic) => normalizeDomain(heuristic.domain) === normalizedDomain);
  }
  if (filterTags.length > 0) {
    candidates = candidates.filter((heuristic) =>
      matchesTagSet(cache.heuristicTagSetById.get(heuristic.id), filterTags, tagMode)
    );
  }

  const scored = candidates
    .map((heuristic): SearchHeuristicResult | null => {
      const searchText = cache.heuristicSearchTextById.get(heuristic.id) ?? heuristicSearchText(heuristic);
      const textScore = similarity(searchText, query, 1.5, 0.75, AVG_HEURISTIC_DOC_LEN);
      if (textScore < SEARCH_MIN_TEXT_SCORE) return null;
      return {
        ...sanitizeHeuristicForOutput(heuristic),
        score: textScore,
      };
    })
    .filter((item): item is SearchHeuristicResult => item !== null);

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function retrieveRelevantHeuristics(
  taskDescription: string,
  domain?: string,
  limit = 10,
  tags?: string[],
  includeScores = false,
  minConfidence = 0.3,
  tagMode: TagFilterMode = "and",
): Promise<HeuristicWithScore[]> {
  return mutateStore((store) => {
    const searchTextMap = getOrBuildHeuristicSearchTextMap(store);
    const tagSetMap = getOrBuildHeuristicTagSetMap(store);
    const topItems = scoreHeuristicsForQuery(
      store,
      {
        taskDescription,
        domain,
        tags,
        tagMode,
        limit,
        minConfidence,
      },
      searchTextMap,
      tagSetMap,
    );
    const retrievedIds = new Set(topItems.map((item) => item.heuristic.id));
    const now = new Date().toISOString();
    for (const heuristic of store.heuristics) {
      if (retrievedIds.has(heuristic.id)) {
        heuristic.retrieval_count = (heuristic.retrieval_count ?? 0) + 1;
        heuristic.last_retrieved_at = now;
      }
    }

    return topItems.map((item) => ({
      ...sanitizeHeuristicForOutput(item.heuristic),
      ...(includeScores ? { _score: item.scoreDetail } : {}),
    }));
  });
}

function scoreHeuristicsForQuery(
  store: ReflectionStore,
  query: RetrieveHeuristicsQuery,
  searchTextMap: Map<string, string>,
  tagSetMap: Map<string, Set<string>>,
): ScoredHeuristic[] {
  const normalizedDomain = query.domain ? normalizeDomain(query.domain) : undefined;
  const limit = query.limit ?? 10;
  const minConfidence = query.minConfidence ?? 0.3;
  const tagMode = query.tagMode ?? "and";
  const filterTags = normalizeTags(query.tags);

  let candidates = store.heuristics.filter(
    (heuristic) => !heuristic.superseded_by && heuristic.confidence >= minConfidence
  );

  if (filterTags.length > 0) {
    candidates = candidates.filter((heuristic) => matchesTagSet(tagSetMap.get(heuristic.id), filterTags, tagMode));
  }

  const scored = candidates
    .map((heuristic): ScoredHeuristic | null => {
      const textScore = similarity(
        searchTextMap.get(heuristic.id) ?? heuristicSearchText(heuristic),
        query.taskDescription,
        1.5,
        0.75,
        AVG_HEURISTIC_DOC_LEN,
      );
      if (textScore < SEARCH_MIN_TEXT_SCORE) return null;

      const domainBonus = normalizedDomain && normalizeDomain(heuristic.domain) === normalizedDomain ? 0.1 : 0;
      const reinforcementScore = Math.min(heuristic.reinforcement_count / 10, 1.0);
      const retrievalScore = Math.min((heuristic.retrieval_count ?? 0) / 20, 0.15);
      const retention = ebbinghausRetention(heuristic);
      const baseScore =
        textScore * 0.55 +
        heuristic.confidence * 0.25 +
        reinforcementScore * 0.1 +
        retrievalScore +
        domainBonus;
      const finalScore = baseScore * (0.7 + 0.3 * retention);
      return {
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
      };
    })
    .filter((item): item is ScoredHeuristic => item !== null);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function bulkRetrieveHeuristics(
  queries: RetrieveHeuristicsQuery[],
  includeScores = false,
): Promise<HeuristicWithScore[][]> {
  return mutateStore((store) => {
    const searchTextMap = getOrBuildHeuristicSearchTextMap(store);
    const tagSetMap = getOrBuildHeuristicTagSetMap(store);
    const retrievedIds = new Set<string>();
    const results: HeuristicWithScore[][] = [];

    for (const query of queries) {
      const topItems = scoreHeuristicsForQuery(store, query, searchTextMap, tagSetMap);
      for (const item of topItems) {
        retrievedIds.add(item.heuristic.id);
      }
      results.push(topItems.map((item) => ({
        ...sanitizeHeuristicForOutput(item.heuristic),
        ...(includeScores ? { _score: item.scoreDetail } : {}),
      })));
    }

    const now = new Date().toISOString();
    for (const heuristic of store.heuristics) {
      if (retrievedIds.has(heuristic.id)) {
        heuristic.retrieval_count = (heuristic.retrieval_count ?? 0) + 1;
        heuristic.last_retrieved_at = now;
      }
    }

    return results;
  });
}

/**
 * Return a window of reflections in newest-first order without cloning or
 * sorting the full array when the input is already timestamp-ascending.
 * Falls back to copy+sort for out-of-order data to preserve v12 behavior.
 */
function newestFirstSlice(
  reflections: ReflectionFrame[],
  limit: number,
  offset = 0,
  isAscending?: boolean,
): ReflectionFrame[] {
  if (limit <= 0) return [];

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
    if (start < 0) return [];
    const result: ReflectionFrame[] = [];
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

export async function searchReflections(
  query: string,
  domain?: string,
  outcome?: "success" | "partial" | "failure",
  limit = 20,
  sinceDays?: number,
  tags?: string[],
  failureMode?: string,
  tagMode: TagFilterMode = "and",
): Promise<ReflectionFrame[]> {
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
    candidates = candidates.filter((reflection) =>
      matchesTagSet(cache.reflectionTagSetById.get(reflection.id), filterTags, tagMode)
    );
  }
  if (failureMode) {
    candidates = candidates.filter((reflection) => reflection.failure_mode === failureMode);
  }

  if (query.trim().length === 0) {
    return newestFirstSlice(candidates, limit, 0, cache.reflectionsAreAscending)
      .map(sanitizeReflectionLessonsForOutput);
  }

  const scored = candidates
    .map((reflection) => {
      const haystack = cache.reflectionSearchTextById.get(reflection.id) ?? reflectionSearchText(reflection);
      const textScore = similarity(haystack, query, 1.5, 0.75, AVG_REFLECTION_DOC_LEN);
      if (textScore < SEARCH_MIN_TEXT_SCORE) return null;
      const ageMs = Date.now() - new Date(reflection.timestamp).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recencyFactor = 0.5 + 0.5 * Math.exp(-ageDays / 90);
      return { reflection, score: textScore * recencyFactor };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => sanitizeReflectionLessonsForOutput(item.reflection));
}

export interface ListReflectionsOptions {
  domain?: string;
  outcome?: ReflectionFrame["task_outcome"];
  failureMode?: ReflectionFrame["failure_mode"];
  tags?: string[];
  tagMode?: TagFilterMode;
  sessionId?: string;
  sinceDays?: number;
  limit?: number;
  offset?: number;
}

export async function listReflections(options: ListReflectionsOptions = {}): Promise<ReflectionFrame[]> {
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
    candidates = candidates.filter((reflection) =>
      matchesTagSet(cache.reflectionTagSetById.get(reflection.id), filterTags, tagMode)
    );
  }

  return newestFirstSlice(candidates, limit, offset, cache.reflectionsAreAscending)
    .map(sanitizeReflectionLessonsForOutput);
}

function sanitizeReflectionLessonsForOutput(reflection: ReflectionFrame): ReflectionFrame {
  return {
    ...reflection,
    lessons_learned: reflection.lessons_learned.map(safeHeuristicText),
  };
}

function reflectionSearchText(reflection: ReflectionFrame): string {
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
  const store = await getCachedStore();

  let activeGaps = 0;
  let resolvedGaps = 0;
  const topGaps: AffordanceGap[] = [];
  for (const gap of store.affordance_gaps) {
    if (gap.resolved) {
      resolvedGaps++;
    } else {
      activeGaps++;
      insertSorted(topGaps, gap, (a, b) => b.occurrence_count - a.occurrence_count, 5);
    }
  }

  let activeHeuristics = 0;
  let archivedHeuristics = 0;
  for (const heuristic of store.heuristics) {
    if (heuristic.superseded_by) archivedHeuristics++;
    else activeHeuristics++;
  }

  const failureDist: Record<string, number> = {};
  const outcomeDist: Record<string, number> = {};
  const domainDist: Record<string, number> = {};
  const tagDist: Record<string, number> = {};
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

  const recentLessons: string[] = [];
  for (let i = store.reflections.length - 1; i >= 0 && recentLessons.length < 10; i--) {
    for (const lesson of store.reflections[i].lessons_learned) {
      if (recentLessons.length >= 10) break;
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

export async function getAffordanceGaps(minOccurrences = 1, includeResolved = false): Promise<AffordanceGap[]> {
  const store = await getCachedStore();
  return store.affordance_gaps
    .filter((gap) => gap.occurrence_count >= minOccurrences && (includeResolved || !gap.resolved))
    .sort((a, b) => b.occurrence_count - a.occurrence_count);
}

export async function resolveAffordanceGap(
  id: string,
  resolutionNotes?: string,
): Promise<AffordanceGap | null> {
  return mutateStore((store) => {
    const gap = store.affordance_gaps.find((item) => item.id === id);
    if (!gap) return null;
    gap.resolved = true;
    gap.resolved_at = new Date().toISOString();
    if (resolutionNotes) gap.resolution_notes = resolutionNotes;
    return { ...gap, available_tools: [...gap.available_tools] };
  });
}

export async function getRecentReflections(limit = 20): Promise<ReflectionFrame[]> {
  return (await loadRecentReflections(limit)).map(sanitizeReflectionLessonsForOutput);
}

export async function getSessionReflections(sessionId: string, limit = 20): Promise<ReflectionFrame[]> {
  const cache = await getCachedStoreEntry();
  const indexes = cache.sessionIndex.get(sessionId) ?? [];
  return indexes
    .slice(-limit)
    .reverse()
    .map((index) => sanitizeReflectionLessonsForOutput(cache.store.reflections[index]));
}

export interface SessionSummary {
  session_id: string;
  started_at: string;
  reflection_count: number;
  outcome_distribution: Record<string, number>;
  domains: string[];
  top_lessons: string[];
  open_questions: Array<{ question: string; priority: Priority }>;
  affordance_gaps_logged: number;
  heuristics_extracted: number;
}

export async function getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
  const cache = await getCachedStoreEntry();
  const store = cache.store;
  const resolvedIndex = await getCachedResolvedQuestions();
  const session = store.sessions[sessionId];
  if (!session) return null;

  const sessionReflections = (cache.sessionIndex.get(sessionId) ?? [])
    .map((index) => store.reflections[index]);
  if (sessionReflections.length === 0) return null;

  const outcomeDist: Record<string, number> = {};
  const domainSet = new Set<string>();
  const openQuestionCandidates: Array<{ question: string; priority: Priority; timestamp: string }> = [];
  const PRIORITY_ORDER: Record<Priority, number> = { high: 3, medium: 2, low: 1 };
  const openQCompare = (
    a: { priority: Priority; timestamp: string },
    b: { priority: Priority; timestamp: string },
  ): number => {
    const pd = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
    return pd !== 0 ? pd : b.timestamp.localeCompare(a.timestamp);
  };

  for (const reflection of sessionReflections) {
    outcomeDist[reflection.task_outcome] = (outcomeDist[reflection.task_outcome] ?? 0) + 1;
    domainSet.add(normalizeDomain(reflection.domain));
    for (const [index, q] of reflection.open_questions.entries()) {
      if (resolveQuestionOverlay(reflection.id, index, q, resolvedIndex).resolved) continue;
      insertSorted(
        openQuestionCandidates,
        { question: q.question, priority: q.priority, timestamp: reflection.timestamp },
        openQCompare,
        5,
      );
    }
  }

  const topLessons: string[] = [];
  for (let i = sessionReflections.length - 1; i >= 0 && topLessons.length < 5; i--) {
    for (const lesson of sessionReflections[i].lessons_learned) {
      if (topLessons.length >= 5) break;
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

export async function getReflectionById(
  id: string,
  applyResolvedOverlay = true,
): Promise<ReflectionFrame | null> {
  const store = await getCachedStore();
  const reflection = store.reflections.find((item) => item.id === id);
  if (!reflection) return null;
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

export interface UpdateReflectionInput {
  domain?: string;
  tags?: string[];
  lessons_learned?: string[];
  reExtractHeuristics?: boolean;
  confidence?: number;
}

export async function updateReflection(
  id: string,
  update: UpdateReflectionInput,
): Promise<ReflectionFrame | null> {
  return mutateStore((store) => {
    const reflection = store.reflections.find((item) => item.id === id);
    if (!reflection) return null;

    if (update.domain !== undefined) {
      reflection.domain = normalizeDomain(update.domain);
    }
    if (update.tags !== undefined) {
      reflection.tags = [...new Set(normalizeTags(update.tags))];
    }
    if (update.lessons_learned !== undefined) {
      const safeLessons = update.lessons_learned.filter(
        (lesson) => firstHeuristicThreatMessage(lesson, "strict") === null,
      );
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
        if (store.heuristics.length > HEURISTIC_MAX_COUNT) pruneHeuristicsMut(store);
      }
    }

    return sanitizeReflectionLessonsForOutput(reflection);
  }, "rewrite");
}

export interface ReflectionDiffSummary {
  id_a: string;
  id_b: string;
  same_reflection: boolean;
  time_delta_ms: number;
  same_fields: string[];
  changed_fields: string[];
  lessons: {
    added: string[];
    removed: string[];
    unchanged: Array<{ a: string; b: string }>;
  };
  world_model_polarity_changes: Array<{
    fact_a: string;
    polarity_a: "affirm" | "negate";
    fact_b: string;
    polarity_b: "affirm" | "negate";
  }>;
  common_open_questions: Array<{
    question_a: string;
    question_b: string;
  }>;
}

export async function diffReflections(
  idA: string,
  idB: string,
): Promise<{ a: ReflectionFrame; b: ReflectionFrame; diff: ReflectionDiffSummary } | null> {
  const store = await getCachedStore();
  const a = store.reflections.find((reflection) => reflection.id === idA);
  const b = store.reflections.find((reflection) => reflection.id === idB);
  if (!a || !b) return null;

  const comparableFields: Array<keyof Pick<ReflectionFrame, "task_outcome" | "failure_mode" | "domain">> = [
    "task_outcome",
    "failure_mode",
    "domain",
  ];
  const sameFields = comparableFields.filter((field) => a[field] === b[field]);
  const changedFields = comparableFields.filter((field) => a[field] !== b[field]);
  const lessonSimilarityThreshold = 0.38;
  const unchangedLessons: ReflectionDiffSummary["lessons"]["unchanged"] = [];
  const removedLessons: string[] = [];
  const matchedLessonB = new Set<number>();
  for (const lessonA of a.lessons_learned) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < b.lessons_learned.length; i++) {
      if (matchedLessonB.has(i)) continue;
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
    } else {
      removedLessons.push(lessonA);
    }
  }
  const addedLessons = b.lessons_learned.filter((_, i) => !matchedLessonB.has(i));

  const worldPolarityChanges: ReflectionDiffSummary["world_model_polarity_changes"] = [];
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

  const commonOpenQuestions: ReflectionDiffSummary["common_open_questions"] = [];
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

  return {
    a: sanitizeReflectionLessonsForOutput(a),
    b: sanitizeReflectionLessonsForOutput(b),
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

export interface OpenQuestionSummary {
  id: string;
  reflection_id: string;
  question_index: number;
  timestamp: string;
  domain: string;
  task_goal: string;
  question: string;
  priority: Priority;
  requires_environment_interaction: boolean;
  resolved: boolean;
  resolved_at?: string;
  resolved_by?: string;
}

interface ResolvedQuestionEntry {
  resolved_at: string;
  resolved_by?: string;
}

type ResolvedQuestionIndex = Record<string, ResolvedQuestionEntry>;

const PRIORITY_RANK: Record<Priority, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export interface WorldFactSummary {
  fact: string;
  polarity: "affirm" | "negate";
  source: string;
  evidence: string;
  reflection_id: string;
  timestamp: string;
  domain: string;
}

export interface TimelineBucket {
  start: string;
  end: string;
  reflection_count: number;
  outcome_distribution: Record<string, number>;
  top_failure_mode?: string;
  lessons_count: number;
  open_questions_count: number;
  domains: string[];
}

export async function getWorldModel(
  domain?: string,
  polarity?: "affirm" | "negate",
  limit = 50,
  sinceDays?: number,
): Promise<WorldFactSummary[]> {
  const store = await getCachedStore();
  const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
  const cutoff = sinceDays !== undefined
    ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
    : undefined;
  const deduplicatedFacts: WorldFactSummary[] = [];
  const exactSeen = new Map<string, number>();
  const polarityBuckets = new Map<string, number[]>();
  const bucketByIndex = new Map<number, string>();

  const registerBucket = (index: number, fact: WorldFactSummary): void => {
    const nextKey = worldFactBucketKey(fact.polarity, fact.fact);
    const previousKey = bucketByIndex.get(index);
    if (previousKey && previousKey !== nextKey) {
      const previousBucket = polarityBuckets.get(previousKey);
      if (previousBucket) {
        polarityBuckets.set(previousKey, previousBucket.filter((item) => item !== index));
      }
    }
    const bucket = polarityBuckets.get(nextKey) ?? [];
    if (!bucket.includes(index)) bucket.push(index);
    polarityBuckets.set(nextKey, bucket);
    bucketByIndex.set(index, nextKey);
  };

  let orderedReflections = store.reflections;
  for (let i = 1; i < orderedReflections.length; i++) {
    if (orderedReflections[i].timestamp < orderedReflections[i - 1].timestamp) {
      orderedReflections = [...store.reflections].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      break;
    }
  }

  for (const reflection of orderedReflections) {
    if (cutoff && reflection.timestamp < cutoff) continue;
    if (normalizedDomain && normalizeDomain(reflection.domain) !== normalizedDomain) continue;
    for (const update of reflection.world_model_updates) {
      const candidate: WorldFactSummary = {
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
          if (
            existing?.polarity === candidate.polarity &&
            worldFactSimilarity(existing.fact, update.fact) > WORLD_FACT_DEDUP_THRESHOLD
          ) {
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
      } else {
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

function worldFactExactKey(polarity: string, fact: string): string {
  return `${polarity}::${fact.toLowerCase().trim()}`;
}

function worldFactBucketKey(polarity: string, fact: string): string {
  const prefix = normalizeWorldFactForSimilarity(fact)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  return `${polarity}::${prefix}`;
}

type TimelineBucketSize = "day" | "week" | "month";

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function timelineBucketRange(date: Date, bucket: TimelineBucketSize): { start: Date; end: Date; key: string } {
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

export async function getReflectionTimeline(
  bucket: TimelineBucketSize,
  domain?: string,
  sinceDays = 90,
  limit = 20,
): Promise<TimelineBucket[]> {
  const cache = await getCachedStoreEntry();
  const store = cache.store;
  const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const buckets = new Map<string, {
    start: Date;
    end: Date;
    reflection_count: number;
    outcome_distribution: Record<string, number>;
    failure_distribution: Record<string, number>;
    lessons_count: number;
    open_questions_count: number;
    domains: Set<string>;
  }>();

  const resolvedIndex = await getCachedResolvedQuestions();

  for (const reflection of store.reflections) {
    if (reflection.timestamp < cutoff) continue;
    if (normalizedDomain && normalizeDomain(reflection.domain) !== normalizedDomain) continue;
    const date = new Date(reflection.timestamp);
    if (Number.isNaN(date.getTime())) continue;
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
        domains: new Set<string>(),
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
      let topFailureMode: string | undefined;
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

function worldFactSimilarity(a: string, b: string): number {
  const normalizedA = normalizeWorldFactForSimilarity(a);
  const normalizedB = normalizeWorldFactForSimilarity(b);
  if (hasConflictingNumberTokens(normalizedA, normalizedB)) return 0;
  const trigramScore = characterTrigramSimilarity(normalizedA, normalizedB);
  if (trigramScore < 0.4) return trigramScore;
  return Math.max(similarity(normalizedA, normalizedB), similarity(normalizedB, normalizedA), trigramScore);
}

function normalizeWorldFactForSimilarity(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(\d+)\s*(seconds?|secs?|s)\b/g, "$1 second")
    .replace(/\b(\d+)\s*(minutes?|mins?|m)\b/g, "$1 minute")
    .replace(/\b(\d+)\s*(hours?|hrs?|h)\b/g, "$1 hour")
    .replace(/\b(\d+)\s*(milliseconds?|millis?|ms)\b/g, "$1 millisecond");
}

function hasConflictingNumberTokens(a: string, b: string): boolean {
  const numbersA = numberTokens(a);
  const numbersB = numberTokens(b);
  if (numbersA.size === 0 || numbersB.size === 0) return false;
  const aSubsetOfB = [...numbersA].every((value) => numbersB.has(value));
  const bSubsetOfA = [...numbersB].every((value) => numbersA.has(value));
  return !(aSubsetOfB || bSubsetOfA);
}

function numberTokens(value: string): Set<string> {
  return new Set(value.match(/\d+/g) ?? []);
}

function characterTrigramSimilarity(a: string, b: string): number {
  const gramsA = characterTrigrams(a);
  const gramsB = characterTrigrams(b);
  if (gramsA.size === 0 || gramsB.size === 0) return 0;
  let overlap = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) overlap++;
  }
  return (2 * overlap) / (gramsA.size + gramsB.size);
}

function characterTrigrams(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const grams = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

export async function getOpenQuestions(
  domain?: string,
  priority?: Priority,
  limit = 30,
  sinceDays?: number,
  includeResolved = false,
): Promise<OpenQuestionSummary[]> {
  const store = await getCachedStore();
  const resolvedIndex = await getCachedResolvedQuestions();
  const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
  const cutoff = sinceDays !== undefined
    ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
    : undefined;
  const results: OpenQuestionSummary[] = [];
  const openQCompare = (a: OpenQuestionSummary, b: OpenQuestionSummary): number => {
    const priorityDelta = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (priorityDelta !== 0) return priorityDelta;
    return b.timestamp.localeCompare(a.timestamp);
  };

  for (const reflection of store.reflections) {
    if (normalizedDomain && normalizeDomain(reflection.domain) !== normalizedDomain) continue;
    if (cutoff && reflection.timestamp < cutoff) continue;
    for (const [index, question] of reflection.open_questions.entries()) {
      if (priority && question.priority !== priority) continue;
      const resolved = resolveQuestionOverlay(reflection.id, index, question, resolvedIndex);
      if (!includeResolved && resolved.resolved) continue;
      insertSorted(
        results,
        {
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
        },
        openQCompare,
        limit,
      );
    }
  }

  return results;
}

export async function resolveOpenQuestion(
  reflectionId: string,
  questionIndex: number,
  resolvedByReflectionId?: string,
): Promise<{ found: boolean; question: string } | null> {
  const store = await getCachedStore();
  const reflection = store.reflections.find((item) => item.id === reflectionId);
  if (!reflection) return null;
  const question = reflection.open_questions[questionIndex] as OpenQuestion | undefined;
  if (!question) return { found: false, question: "" };
  await mutateResolvedQuestions(async (resolved) => {
    resolved[resolvedQuestionKey(reflectionId, questionIndex)] = {
      resolved_at: new Date().toISOString(),
      ...(resolvedByReflectionId ? { resolved_by: resolvedByReflectionId } : {}),
    };
  });
  return { found: true, question: question.question };
}

export type ClearCollection = "reflections" | "heuristics" | "affordance_gaps" | "sessions" | "all";

export async function exportData(): Promise<ReflectionStore> {
  return mergeResolvedQuestionsIntoStore(await getCachedStore());
}

export interface StoreHealthReport {
  healthy: boolean;
  orphan_reflections: number;
  orphan_affordance_gaps: number;
  broken_heuristic_links: number;
  suspicious_heuristics: number;
  file_stats: {
    store_json_bytes: number;
    reflections_jsonl_bytes: number;
    resolved_questions_json_bytes: number;
    reflection_count: number;
    average_reflection_bytes: number;
  };
  largest_reflection?: {
    id: string;
    bytes: number;
  };
  issues: string[];
}

export interface SnapshotResult {
  snapshot_dir: string;
  files: string[];
  timestamp: string;
}

function estimateReflectionBytes(reflection: ReflectionFrame): number {
  const strSize = (s: string | undefined) => s ? s.length : 0;
  let len = 0;

  // Top-level scalar strings
  len += strSize(reflection.id);
  len += strSize(reflection.timestamp);
  len += strSize(reflection.session_id);
  len += strSize(reflection.task_goal);
  len += strSize(reflection.task_outcome);
  len += strSize(reflection.failure_mode);
  len += strSize(reflection.domain);

  // task_state
  len += strSize(reflection.task_state.summary);
  for (const s of reflection.task_state.summary_sections ?? []) len += strSize(s.title) + strSize(s.content);
  for (const s of reflection.task_state.immediate_blockers) len += strSize(s);
  for (const s of reflection.task_state.active_hypotheses) len += strSize(s);
  for (const s of reflection.task_state.proven_safe_paths) len += strSize(s);
  for (const s of reflection.task_state.exhausted_search) len += strSize(s);

  // Arrays of objects with string fields
  for (const u of reflection.world_model_updates) len += strSize(u.fact) + strSize(u.polarity) + strSize(u.source) + strSize(u.evidence);
  for (const t of reflection.tool_insights) len += strSize(t.tool) + strSize(t.insight) + strSize(t.status) + strSize(t.evidence);
  for (const c of reflection.context_forget) len += strSize(c.item) + strSize(c.reason);
  for (const q of reflection.open_questions) {
    len += strSize(q.question) + strSize(q.priority) + strSize(q.resolved_at) + strSize(q.resolved_by);
  }
  for (const s of reflection.lessons_learned) len += strSize(s);
  for (const s of reflection.tags) len += strSize(s);

  // Nested affordance gaps
  for (const g of reflection.affordance_gaps) {
    len += strSize(g.id) + strSize(g.timestamp) + strSize(g.session_id)
      + strSize(g.goal_description) + strSize(g.failure_description) + strSize(g.missing_capability);
    for (const t of g.available_tools) len += strSize(t);
    len += strSize(g.suggested_solution) + strSize(g.resolved_at) + strSize(g.resolution_notes);
  }

  // Conservative multiplier for JSON structural overhead (keys, quotes, commas, braces)
  // and potential UTF-8 multi-byte characters
  return Math.round(len * 1.3) + 64;
}

export async function checkStoreHealth(): Promise<StoreHealthReport> {
  const store = await getCachedStore();
  const sessionIds = new Set(Object.keys(store.sessions));
  const issues: string[] = [];

  let orphanReflections = 0;
  for (const reflection of store.reflections) {
    if (!sessionIds.has(reflection.session_id)) orphanReflections++;
  }
  if (orphanReflections > 0) {
    issues.push(`${orphanReflections} reflection(s) reference missing sessions.`);
  }

  let orphanGaps = 0;
  for (const gap of store.affordance_gaps) {
    if (!sessionIds.has(gap.session_id)) orphanGaps++;
  }
  if (orphanGaps > 0) {
    issues.push(`${orphanGaps} affordance gap(s) reference missing sessions.`);
  }

  const heuristicById = new Map<string, Heuristic>();
  for (const h of store.heuristics) {
    heuristicById.set(h.id, h);
  }
  let brokenLinks = 0;
  for (const heuristic of store.heuristics) {
    for (const previousId of heuristic.supersedes ?? []) {
      const previous = heuristicById.get(previousId);
      if (!previous || previous.superseded_by !== heuristic.id) brokenLinks++;
    }
    if (heuristic.superseded_by) {
      const next = heuristicById.get(heuristic.superseded_by);
      if (!next || !(next.supersedes ?? []).includes(heuristic.id)) brokenLinks++;
    }
  }
  if (brokenLinks > 0) {
    issues.push(`${brokenLinks} heuristic supersedes/superseded_by link(s) are broken.`);
  }

  const suspiciousHeuristics = store.heuristics.filter(
    (heuristic) => scanHeuristicThreats(heuristic.heuristic, "strict").length > 0
  ).length;
  if (suspiciousHeuristics > 0) {
    issues.push(`${suspiciousHeuristics} heuristic(s) contain blocked context-injection or exfiltration patterns. Normal list/search/retrieve output hides their raw text; inspect with export_data(collection:"heuristics").`);
  }

  const reflectionSizes = store.reflections.map((reflection) => ({
    id: reflection.id,
    bytes: estimateReflectionBytes(reflection),
  }));
  const totalReflectionBytes = reflectionSizes.reduce((sum, item) => sum + item.bytes, 0);
  let largestReflection: { id: string; bytes: number } | undefined;
  for (const item of reflectionSizes) {
    if (!largestReflection || item.bytes > largestReflection.bytes) {
      largestReflection = item;
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

export async function createSnapshot(outputDir?: string, label?: string): Promise<SnapshotResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const normalizedLabel = label?.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  const dirName = normalizedLabel ? `${timestamp}-${normalizedLabel}` : timestamp;
  const baseDir = outputDir ?? join(STORE_DIR, "snapshots");
  const snapshotDir = join(baseDir, dirName);

  await mkdir(snapshotDir, { recursive: true });

  const files: string[] = [];
  const srcFiles = [
    { src: STORE_PATH, name: "store.json" },
    { src: REFLECTIONS_PATH, name: "reflections.jsonl" },
    { src: RESOLVED_QUESTIONS_PATH, name: "resolved_questions.json" },
  ];

  for (const { src, name } of srcFiles) {
    if (!existsSync(src)) continue;
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

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function resolvedQuestionKey(reflectionId: string, questionIndex: number): string {
  return `${reflectionId}:${questionIndex}`;
}

async function loadResolvedQuestions(): Promise<ResolvedQuestionIndex> {
  if (!existsSync(RESOLVED_QUESTIONS_PATH)) return {};
  try {
    return JSON.parse(await readFile(RESOLVED_QUESTIONS_PATH, "utf-8")) as ResolvedQuestionIndex;
  } catch (error) {
    console.error("[hermes] resolved_questions.json is invalid; ignoring overlay.", error);
    return {};
  }
}

async function saveResolvedQuestions(index: ResolvedQuestionIndex): Promise<void> {
  await ensureStoreDir();
  const tmpPath = join(STORE_DIR, `resolved_questions.json.tmp.${process.pid}.${Date.now()}.${randomUUID()}`);
  await writeFile(tmpPath, JSON.stringify(index, null, 2), "utf-8");
  await replaceFileAtomically(tmpPath, RESOLVED_QUESTIONS_PATH);
}

async function mutateResolvedQuestions(
  mutator: (index: ResolvedQuestionIndex) => void | Promise<void>,
): Promise<void> {
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
  resolvedQuestionsMutationQueue = run.then(
    () => undefined,
    (error) => {
      console.error(
        "[hermes] resolved questions error:",
        error instanceof Error ? error.message : String(error),
      );
      _mutationResolvedIndex = null;
      invalidateResolvedQuestionsCache();
    },
  );
  return run;
}

function resolvedQuestionsFromReflections(reflections: ReflectionFrame[]): ResolvedQuestionIndex {
  const resolved: ResolvedQuestionIndex = {};
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

function resolveQuestionOverlay(
  reflectionId: string,
  questionIndex: number,
  question: OpenQuestion,
  resolvedIndex: ResolvedQuestionIndex,
): { resolved: boolean; resolved_at?: string; resolved_by?: string } {
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

async function mergeResolvedQuestionsIntoStore(store: ReflectionStore): Promise<ReflectionStore> {
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

export type ImportMode = "merge" | "replace";

export async function importData(
  incoming: Partial<ReflectionStore>,
  mode: ImportMode,
): Promise<{ reflections: number; heuristics: number; affordance_gaps: number; sessions: number }> {
  const mutationResult = await mutateStore((store) => {
    let replacementResolvedIndex: ResolvedQuestionIndex | undefined;
    let mergedResolvedIndex: ResolvedQuestionIndex | undefined;
    const mergedNewReflections: ReflectionFrame[] = [];

    if (mode === "replace") {
      if (incoming.reflections) {
        store.reflections = (incoming.reflections as Partial<ReflectionFrame>[]).map(normalizeReflectionFrame);
        replacementResolvedIndex = resolvedQuestionsFromReflections(store.reflections);
      }
      if (incoming.heuristics) {
        store.heuristics = (incoming.heuristics as Partial<Heuristic>[]).map(normalizeHeuristicRecord);
      }
      if (incoming.affordance_gaps) store.affordance_gaps = incoming.affordance_gaps as AffordanceGap[];
      if (incoming.sessions) store.sessions = incoming.sessions as Record<string, Session>;
    } else {
      // merge mode: append items whose ids are not already present
      if (incoming.reflections) {
        const existingIds = new Set(store.reflections.map((r) => r.id));
        for (const rawReflection of incoming.reflections as Partial<ReflectionFrame>[]) {
          const r = normalizeReflectionFrame(rawReflection);
          if (!existingIds.has(r.id)) {
            mergedNewReflections.push(r);
            store.reflections.push(r);
            existingIds.add(r.id);
          }
        }
      }
      if (incoming.heuristics) {
        const existingIds = new Set(store.heuristics.map((h) => h.id));
        for (const h of incoming.heuristics as Partial<Heuristic>[]) {
          if (h.id && !existingIds.has(h.id)) {
            store.heuristics.push(normalizeHeuristicRecord(h));
            existingIds.add(h.id);
          }
        }
      }
      if (incoming.affordance_gaps) {
        const existingIds = new Set(store.affordance_gaps.map((g) => g.id));
        for (const g of incoming.affordance_gaps as AffordanceGap[]) {
          if (!existingIds.has(g.id)) {
            store.affordance_gaps.push(g);
            existingIds.add(g.id);
          }
        }
      }
      if (incoming.sessions) {
        for (const [id, session] of Object.entries(incoming.sessions as Record<string, Session>)) {
          if (!store.sessions[id]) {
            store.sessions[id] = session;
          }
        }
      }
    }

    return {
      counts: {
        reflections: store.reflections.length,
        heuristics: store.heuristics.length,
        affordance_gaps: store.affordance_gaps.length,
        sessions: Object.keys(store.sessions).length,
      },
      replacementResolvedIndex,
      mergedResolvedIndex: mergedResolvedIndex ?? resolvedQuestionsFromReflections(mergedNewReflections),
      mergedNewReflections,
    };
  }, incoming.reflections ? "rewrite" : "none");

  if (mode === "replace" && incoming.reflections) {
    await mutateResolvedQuestions(async (resolved) => {
      for (const key of Object.keys(resolved)) delete resolved[key];
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

export async function clearData(collection: ClearCollection): Promise<void> {
  await mutateStore((store) => {
    switch (collection) {
      case "reflections":
        store.reflections = [];
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
        break;
    }
  }, collection === "reflections" || collection === "all" ? "rewrite" : "none");
  if (collection === "reflections" || collection === "all") {
    await mutateResolvedQuestions(async (resolved) => {
      for (const key of Object.keys(resolved)) delete resolved[key];
    });
  }
}

export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim() || "general";
}

function normalizeCapability(capability: string): string {
  return capability.toLowerCase().trim();
}

export function generateId(): string {
  return randomUUID();
}

export interface HeuristicStats {
  total_active: number;
  total_archived: number;
  suspicious_count: number;
  confidence_distribution: { high: number; medium: number; low: number };
  never_retrieved: number;
  stale_count: number;
  domain_breakdown: Record<string, { count: number; avg_confidence: number; avg_retrieval_count: number }>;
  top_by_retrieval: Array<{ id: string; heuristic: string; domain: string; retrieval_count: number }>;
  top_by_reinforcement: Array<{ id: string; heuristic: string; domain: string; reinforcement_count: number }>;
}

export async function getHeuristicStats(): Promise<HeuristicStats> {
  const store = await getCachedStore();
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  let activeCount = 0;
  let archivedCount = 0;
  let suspiciousCount = 0;
  const confidenceDistribution = { high: 0, medium: 0, low: 0 };
  let neverRetrieved = 0;
  let staleCount = 0;
  const domains: Record<string, { count: number; totalConfidence: number; totalRetrieval: number }> = {};
  const topByRetrievalItems: Heuristic[] = [];
  const topByReinforcementItems: Heuristic[] = [];

  for (const heuristic of store.heuristics) {
    if (heuristic.superseded_by) {
      archivedCount++;
      continue;
    }

    activeCount++;
    if (scanHeuristicThreats(heuristic.heuristic, "strict").length > 0) suspiciousCount++;
    insertSorted(topByRetrievalItems, heuristic, (a, b) => (b.retrieval_count ?? 0) - (a.retrieval_count ?? 0), 5);
    insertSorted(topByReinforcementItems, heuristic, (a, b) => b.reinforcement_count - a.reinforcement_count, 5);

    if (heuristic.confidence >= 0.8) {
      confidenceDistribution.high++;
    } else if (heuristic.confidence >= 0.5) {
      confidenceDistribution.medium++;
    } else {
      confidenceDistribution.low++;
    }

    const createdMs = Date.parse(heuristic.created_at);
    if (
      (heuristic.retrieval_count ?? 0) === 0 &&
      Number.isFinite(createdMs) &&
      now - createdMs > sevenDaysMs
    ) {
      neverRetrieved++;
    }
    if (ebbinghausRetention(heuristic) < 0.3) staleCount++;

    const domain = normalizeDomain(heuristic.domain);
    const entry = domains[domain] ?? { count: 0, totalConfidence: 0, totalRetrieval: 0 };
    entry.count++;
    entry.totalConfidence += heuristic.confidence;
    entry.totalRetrieval += heuristic.retrieval_count ?? 0;
    domains[domain] = entry;
  }

  const domainBreakdown: HeuristicStats["domain_breakdown"] = {};
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

function ebbinghausRetention(heuristic: Heuristic): number {
  const referenceTime = heuristic.last_retrieved_at ?? heuristic.updated_at ?? heuristic.created_at;
  const referenceMs = Date.parse(referenceTime);
  if (!Number.isFinite(referenceMs)) return 1;

  const ageDays = Math.max(0, (Date.now() - referenceMs) / (1000 * 60 * 60 * 24));
  const reinforcement = Math.max(0, heuristic.reinforcement_count ?? 0);
  const stabilityDays = Math.min(
    EBBINGHAUS_BASE_STABILITY_DAYS * (1 + reinforcement / 5),
    EBBINGHAUS_MAX_STABILITY_DAYS
  );
  return Math.exp(-ageDays / stabilityDays);
}

function tokenizeSimilarityText(text: string): string[] {
  const lower = text.toLowerCase();
  const cjkTokens: string[] = [];
  CJK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CJK_RE.exec(lower)) !== null) cjkTokens.push(m[0]);
  CJK_REPLACE_RE.lastIndex = 0;
  const asciiTokens = lower
    .replace(CJK_REPLACE_RE, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => Boolean(t) && !STOPWORDS.has(t));
  CJK_REPLACE_RE.lastIndex = 0;
  return [...asciiTokens, ...cjkTokens];
}

function tokenOverlapStats(a: string, b: string): { count: number; ratio: number } {
  const aTokens = new Set(tokenizeSimilarityText(a));
  const bTokens = new Set(tokenizeSimilarityText(b));
  if (aTokens.size === 0 || bTokens.size === 0) return { count: 0, ratio: 0 };
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap++;
  }
  return { count: overlap, ratio: overlap / Math.min(aTokens.size, bTokens.size) };
}

function roundScore(value: number): number {
  return Number(value.toFixed(3));
}

function buildFreqMap(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
  return map;
}

function similarity(a: string, b: string, k1 = 1.5, b_param = 0.75, avgDocLen?: number): number {
  const aTokens = tokenizeSimilarityText(a);
  const bTokens = tokenizeSimilarityText(b);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const docLen = aTokens.length;
  const effectiveAvgDocLen = avgDocLen && avgDocLen > 0 ? avgDocLen : docLen;

  const docFreq = buildFreqMap(aTokens);
  const queryFreq = buildFreqMap(bTokens);

  let score = 0;
  let totalQueryTokens = 0;
  for (const [term, qf] of queryFreq) {
    totalQueryTokens += qf;
    const tf = docFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b_param + b_param * (docLen / effectiveAvgDocLen));
    score += qf * (numerator / denominator);
  }

  return totalQueryTokens === 0 ? 0 : Math.min(score / totalQueryTokens, 1.0);
}

// ============================================================
// Project experience Markdown generation
// ============================================================

export interface ProjectExperienceMarkdownOptions {
  title?: string;
  session_id?: string;
  domain?: string;
  tags?: string[];
  tag_mode?: TagFilterMode;
  since_days?: number;
  limit?: number;
  include_raw_reflections?: boolean;
}

export interface ProjectExperienceMarkdownResult {
  markdown: string;
  title: string;
  reflection_count: number;
  scope: string;
}

/** Escape pipe characters and backslashes for Markdown table cells. */
function mdTableEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Render a Markdown bullet list from non-empty strings. */
function mdBulletList(items: string[], indent = 0): string {
  const prefix = "  ".repeat(indent);
  return items.map((item) => `${prefix}- ${item}`).join("\n");
}

/** Generate a filesystem-safe slug from arbitrary text. */
export function safeFilename(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project-experience";
}

/** Generate a filesystem-safe `.md` filename from arbitrary text. */
export function safeMarkdownFilename(text: string): string {
  return safeFilename(text) + ".md";
}

/** Deduplicate reflections by id, sorted newest-first. */
function dedupeNewestFirst(reflections: ReflectionFrame[]): ReflectionFrame[] {
  const seen = new Set<string>();
  const result: ReflectionFrame[] = [];
  for (const r of reflections) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      result.push(r);
    }
  }
  return result;
}

/** Compute the date range [earliest, latest] ISO strings from reflections. */
function computeDateRange(reflections: ReflectionFrame[]): { earliest: string; latest: string } | null {
  if (reflections.length === 0) return null;
  let earliest = reflections[0].timestamp;
  let latest = reflections[0].timestamp;
  for (const r of reflections) {
    if (r.timestamp < earliest) earliest = r.timestamp;
    if (r.timestamp > latest) latest = r.timestamp;
  }
  return { earliest, latest };
}

/** Format an ISO date string as YYYY-MM-DD for display. */
function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Truncate a string to maxLen, appending "..." if truncated. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

export async function generateProjectExperienceMarkdown(
  options: ProjectExperienceMarkdownOptions = {},
): Promise<ProjectExperienceMarkdownResult | null> {
  const cache = await getCachedStoreEntry();
  const store = cache.store;
  const limit = options.limit ?? 200;

  // --- Select reflections ---
  let selected: ReflectionFrame[];

  if (options.session_id) {
    selected = (cache.sessionIndex.get(options.session_id) ?? [])
      .map((index) => store.reflections[index]);
  } else {
    selected = [...store.reflections];
    if (options.domain) {
      const nd = normalizeDomain(options.domain);
      selected = selected.filter((r) => normalizeDomain(r.domain) === nd);
    }
    if (options.tags && options.tags.length > 0) {
      const filterTags = normalizeTags(options.tags);
      selected = selected.filter((r) =>
        matchesTagSet(cache.reflectionTagSetById.get(r.id), filterTags, options.tag_mode ?? "and")
      );
    }
    if (options.since_days !== undefined) {
      const cutoff = new Date(Date.now() - options.since_days * 24 * 60 * 60 * 1000).toISOString();
      selected = selected.filter((r) => r.timestamp >= cutoff);
    }
  }

  if (selected.length === 0) return null;

  // Newest-first for presentation, dedupe, apply limit
  selected.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  selected = dedupeNewestFirst(selected);
  selected = selected.slice(0, limit);

  // Load resolved questions overlay once for filtering open questions
  const resolvedIndex = await getCachedResolvedQuestions();

  // Date range from actual timestamps (min/max)
  const dateRange = computeDateRange(selected);

  // --- Build scope string ---
  const scopeParts: string[] = [];
  if (options.session_id) scopeParts.push(`session: ${options.session_id}`);
  if (options.domain) scopeParts.push(`domain: ${options.domain}`);
  if (options.tags && options.tags.length > 0) scopeParts.push(`tags: [${options.tags.join(", ")}]`);
  if (options.since_days !== undefined) scopeParts.push(`since: ${options.since_days}d`);
  if (scopeParts.length === 0) scopeParts.push("all reflections");
  scopeParts.push(`limit ${limit}`);
  const scope = scopeParts.join(", ");

  // --- Aggregate data ---
  const domains = new Set<string>();
  const allGoals: string[] = [];
  const allLessons: string[] = [];
  const allPaths: string[] = [];
  const allToolInsights: Array<{ tool: string; insight: string }> = [];
  const allWorldUpdates: Array<{ fact: string; polarity: "affirm" | "negate"; source: string; evidence: string }> = [];
  const allOpenQuestions: Array<{ question: string; priority: Priority; requires_environment_interaction: boolean }> = [];
  const allFailureRows: Array<{ task: string; failure_mode: string; symptom: string; fix_lesson: string }> = [];
  const allTags = new Set<string>();
  const summaries: string[] = [];

  for (const r of selected) {
    domains.add(normalizeDomain(r.domain));
    allGoals.push(r.task_goal);
    for (const lesson of r.lessons_learned) {
      if (lesson.trim()) allLessons.push(safeHeuristicText(lesson.trim()));
    }
    for (const p of r.task_state.proven_safe_paths) {
      if (p.trim()) allPaths.push(p.trim());
    }
    for (const ti of r.tool_insights) {
      allToolInsights.push(ti);
    }
    for (const wu of r.world_model_updates) {
      allWorldUpdates.push(wu);
    }
    for (const [index, oq] of r.open_questions.entries()) {
      if (resolveQuestionOverlay(r.id, index, oq, resolvedIndex).resolved) continue;
      allOpenQuestions.push(oq);
    }
    if (r.task_outcome === "failure" || r.task_outcome === "partial") {
      const symptom = r.task_state.summary || "";
      const fixCandidate =
        (r.lessons_learned.length > 0 ? safeHeuristicText(r.lessons_learned[0]) : null)
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
      if (nt) allTags.add(nt);
    }
    if (r.task_state.summary) summaries.push(r.task_state.summary);
  }

  // Dedupe lessons by lowercase
  const seenLessons = new Set<string>();
  const uniqueLessons: string[] = [];
  for (const lesson of allLessons) {
    const key = lesson.toLowerCase();
    if (!seenLessons.has(key)) {
      seenLessons.add(key);
      uniqueLessons.push(lesson);
    }
  }

  // Dedupe paths by lowercase
  const seenPaths = new Set<string>();
  const uniquePaths: string[] = [];
  for (const p of allPaths) {
    const key = p.toLowerCase();
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      uniquePaths.push(p);
    }
  }

  // Dedupe world model updates by fact lowercase
  const seenFacts = new Set<string>();
  const uniqueWorldUpdates: typeof allWorldUpdates = [];
  for (const wu of allWorldUpdates) {
    const key = wu.fact.toLowerCase();
    if (!seenFacts.has(key)) {
      seenFacts.add(key);
      uniqueWorldUpdates.push(wu);
    }
  }

  // Dedupe open questions by lowercase
  const seenQuestions = new Set<string>();
  const uniqueQuestions: typeof allOpenQuestions = [];
  for (const oq of allOpenQuestions) {
    const key = oq.question.toLowerCase();
    if (!seenQuestions.has(key)) {
      seenQuestions.add(key);
      uniqueQuestions.push(oq);
    }
  }

  // Sort open questions by priority
  const uniqueQuestionsSorted = [...uniqueQuestions].sort(
    (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority],
  );

  // --- Build title ---
  const defaultTitleDomain = options.domain ? normalizeDomain(options.domain) : [...domains].sort().join(", ") || "general";
  const titleDate = dateRange ? fmtDate(dateRange.latest) : fmtDate(new Date().toISOString());
  const title = options.title || `${defaultTitleDomain} - Project Experience - ${titleDate}`;

  // --- Outcome counts ---
  const outcomeDist: Record<string, number> = {};
  for (const r of selected) {
    outcomeDist[r.task_outcome] = (outcomeDist[r.task_outcome] ?? 0) + 1;
  }

  // --- Build Markdown ---
  const sections: string[] = [];

  // Title
  sections.push(`# ${title}\n`);

  // Metadata
  const metaLines: string[] = [];
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
  const execLines: string[] = [];
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
    const rows = allFailureRows.map(
      (row) => `| ${mdTableEscape(row.task)} | ${mdTableEscape(row.failure_mode)} | ${mdTableEscape(row.symptom)} | ${mdTableEscape(row.fix_lesson)} |`,
    );
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
    const rows = uniqueWorldUpdates.map(
      (wu) => `| ${wu.polarity} | ${mdTableEscape(wu.fact)} | ${mdTableEscape(wu.evidence)} | ${mdTableEscape(wu.source)} |`,
    );
    sections.push(`## World Model Updates\n\n${[header, sep, ...rows].join("\n")}\n`);
  }

  // Open Questions
  if (uniqueQuestionsSorted.length > 0) {
    const qLines = uniqueQuestionsSorted.map(
      (oq) => `[${oq.priority}] ${oq.question}${oq.requires_environment_interaction ? " *(requires env interaction)*" : ""}`,
    );
    sections.push(`## Open Questions\n\n${mdBulletList(qLines)}\n`);
  }

  // RAG Keywords
  const ragKeywordSet = new Set<string>(["hermes-reflection"]);
  for (const d of domains) ragKeywordSet.add(d);
  for (const tag of allTags) ragKeywordSet.add(tag);
  const ragKeywords = [...ragKeywordSet].sort();
  sections.push(`## RAG Keywords\n\n${ragKeywords.join(", ")}\n`);

  // Source Reflections
  const sourceLines = selected.map((r) => `\`${r.id}\` (${fmtDate(r.timestamp)}) ${truncate(r.task_goal, 100)}`);
  sections.push(`## Source Reflections\n\n${mdBulletList(sourceLines)}\n`);

  // Optional raw reflections (compact per-reflection markdown)
  if (options.include_raw_reflections) {
    const rawLines: string[] = [];
    for (const r of selected) {
      rawLines.push(`### ${r.id}`);
      rawLines.push(`- **Goal:** ${r.task_goal}`);
      rawLines.push(`- **Domain:** ${r.domain}`);
      rawLines.push(`- **Outcome:** ${r.task_outcome} (${r.failure_mode})`);
      rawLines.push(`- **Timestamp:** ${r.timestamp}`);
      if (r.task_state.summary) rawLines.push(`- **Summary:** ${r.task_state.summary}`);
      if (r.lessons_learned.length > 0) rawLines.push(`- **Lessons:** ${r.lessons_learned.map(safeHeuristicText).join("; ")}`);
      if (r.task_state.proven_safe_paths.length > 0) rawLines.push(`- **Safe paths:** ${r.task_state.proven_safe_paths.join("; ")}`);
      if (r.task_state.immediate_blockers.length > 0) rawLines.push(`- **Blockers:** ${r.task_state.immediate_blockers.join("; ")}`);
      if (r.open_questions.length > 0) {
        const oqLines = r.open_questions
          .map((oq, index) => ({ oq, resolved: resolveQuestionOverlay(r.id, index, oq, resolvedIndex).resolved }))
          .filter(({ resolved }) => !resolved)
          .map(
            ({ oq }) => `[${oq.priority}] ${oq.question}${oq.requires_environment_interaction ? " *(requires env interaction)*" : ""}`,
        );
        if (oqLines.length > 0) {
          rawLines.push(`- **Open questions:**`);
          for (const line of oqLines) rawLines.push(`  - ${line}`);
        }
      }
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

export interface DomainSummary {
  domain: string;
  reflection_count: number;
  outcome_distribution: Record<string, number>;
  top_failure_mode?: string;
  active_heuristics: number;
  active_affordance_gaps: number;
  open_questions: number;
  open_questions_detail?: Array<{
    question: string;
    priority: Priority;
    reflection_id: string;
    requires_environment_interaction: boolean;
  }>;
  recent_lesson?: string;
}

type DomainOpenQuestionDetail = NonNullable<DomainSummary["open_questions_detail"]>[number] & {
  timestamp: string;
};

export async function getDomainSummary(
  domain?: string,
  topN = 10,
  includeOpenQuestionsDetail = false,
): Promise<DomainSummary | DomainSummary[]> {
  const store = await getCachedStore();
  const resolvedIndex = await getCachedResolvedQuestions();

  let activeGapsGlobal = 0;
  for (const gap of store.affordance_gaps) {
    if (!gap.resolved) activeGapsGlobal++;
  }

  const domainMap = new Map<string, {
    reflection_count: number;
    outcome_distribution: Record<string, number>;
    failure_mode_counts: Record<string, number>;
    open_questions: number;
    open_questions_detail: DomainOpenQuestionDetail[];
    recent_lesson?: string;
    recent_lesson_ts: string;
  }>();
  const openQuestionDetailCompare = (a: DomainOpenQuestionDetail, b: DomainOpenQuestionDetail): number => {
    const priorityDelta = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (priorityDelta !== 0) return priorityDelta;
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
    if (reflection.open_questions.length > 0) {
      for (let i = 0; i < reflection.open_questions.length; i++) {
        const question = reflection.open_questions[i];
        const resolved = resolveQuestionOverlay(reflection.id, i, question, resolvedIndex);
        if (!resolved.resolved) {
          entry.open_questions++;
          if (includeOpenQuestionsDetail) {
            insertSorted(
              entry.open_questions_detail,
              {
                question: question.question,
                priority: question.priority,
                reflection_id: reflection.id,
                requires_environment_interaction: question.requires_environment_interaction,
                timestamp: reflection.timestamp,
              },
              openQuestionDetailCompare,
              10,
            );
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

  const activeHeuristicsByDomain = new Map<string, number>();
  for (const h of store.heuristics) {
    if (h.superseded_by) continue;
    const d = normalizeDomain(h.domain);
    activeHeuristicsByDomain.set(d, (activeHeuristicsByDomain.get(d) ?? 0) + 1);
  }

  function buildSummary(d: string, entry: NonNullable<ReturnType<typeof domainMap.get>>): DomainSummary {
    let topFailureMode: string | undefined;
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

    const summary: DomainSummary = {
      domain: d,
      reflection_count: entry.reflection_count,
      outcome_distribution: entry.outcome_distribution,
      top_failure_mode: topFailureModeDisplay,
      active_heuristics: activeHeuristicsByDomain.get(d) ?? 0,
      active_affordance_gaps: activeGapsGlobal,
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
        active_affordance_gaps: activeGapsGlobal,
        open_questions: 0,
      };
    }
    return buildSummary(d, entry);
  }

  const summaries: DomainSummary[] = [];
  for (const [d, entry] of domainMap.entries()) {
    summaries.push(buildSummary(d, entry));
  }
  summaries.sort((a, b) => b.reflection_count - a.reflection_count);
  return summaries.slice(0, topN);
}
