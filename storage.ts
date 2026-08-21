// ============================================================
// Hermes Reflection MCP persistent storage
// ============================================================

import { appendFile, copyFile, rename, writeFile, mkdir, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
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
  PendingMutation,
  MemoryBoard,
  MemoryEntry,
  MemoryScope,
  HeuristicEvidence,
  HeuristicFeedback,
  HeuristicFeedbackInput,
  ReviewCandidate,
  CommittedReceipt,
  SkillPromotionCandidate,
  SkillPromotionDirtyScope,
  SkillPromotionMetadata,
  SkillRecord,
  SkillRevision,
} from "./types.js";

import { 
  scanForThreats, 
  firstThreatMessage,
  containsInvisibleChars,
  MAX_SCAN_CHARS
} from "./src/threat_patterns.js";
import { withFileLock } from "./src/file_lock.js";
import { redactSensitiveText } from "./src/redaction.js";
import { evidenceId, evidenceSignal, feedbackSignal, lessonContentHash } from "./src/evidence.js";
import {
  AuthoritativeStateError,
  preserveCorruptUtf8,
  readAuthoritativeJson,
  readAuthoritativeUtf8,
} from "./src/authoritative_state.js";
import {
  commitResourceTransaction,
  operationResultHash,
  operationRecoveryGeneration,
  recoverPendingOperation,
  reserveOperationTransaction,
  type OperationTransactionReservation,
  withOperationJournalBarrier,
} from "./src/operation_journal.js";
import { serializeReflectionResources } from "./src/reflection_transaction.js";
import {
  SKILL_CLUSTER_ALGORITHM,
  buildPromotionClusters,
  isPromotionProcedureGrounded,
  matchPromotionTarget,
  type PromotionCluster,
  type PromotionSnapshot,
} from "./src/learning/skill_promotion.js";
import {
  SkillPromotionCandidateSchema,
  SkillPromotionMetadataSchema,
  SkillRecordSchema,
  SkillRevisionSchema,
  createSkillPromotionCandidate,
  isSkillPromotionScopeDirty,
  skillRevisionContentHash,
  transitionSkillPromotionCandidate,
  type CreateSkillPromotionCandidateInput,
} from "./src/learning/skill_candidate.js";
import { canonicalizeStable, compareStableText, stableUniqueSorted } from "./src/stable_order.js";

const WINDOWS_RENAME_RETRIES = 5;
const REVIEW_CANDIDATE_LESSON_MAX = 1_000;
const REVIEW_CANDIDATE_TAGS_MAX = 100;
const REVIEW_CANDIDATE_SOURCE_IDS_MAX = 50;
const REVIEW_CANDIDATE_PENDING_PER_SCOPE_MAX = 100;
const REVIEW_CANDIDATE_TERMINAL_PER_SCOPE_MAX = 20;
const SKILL_RECORDS_PER_SCOPE_MAX = 200;
const SKILL_CANDIDATE_PENDING_PER_SCOPE_MAX = 100;
const SKILL_CANDIDATE_TERMINAL_PER_SCOPE_MAX = 100;
export const MAX_SKILL_CANDIDATES_PER_BATCH = 50;
export const SKILL_CANDIDATE_CAPACITY_CODE = "SKILL_CANDIDATE_CAPACITY";
const SKILL_PROMOTION_SCOPE_MAX = 1_000;
const COMMITTED_RECEIPT_MAX = 2_048;
const COMMITTED_RECEIPT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export const STORE_DIR = join(homedir(), ".hermes-reflection");
const STORE_PATH = join(STORE_DIR, "store.json");
const REFLECTIONS_PATH = join(STORE_DIR, "reflections.jsonl");
const RESOLVED_QUESTIONS_PATH = join(STORE_DIR, "resolved_questions.json");
const operationJournalMutationContext = new AsyncLocalStorage<boolean>();
export const VERSION = "22.1.0";
export const HEURISTIC_DEDUP_THRESHOLD = 0.75;
const WORLD_FACT_DEDUP_THRESHOLD = 0.65;
export const HEURISTIC_MAX_COUNT = 500;
export const REFLECTION_SOFT_LIMIT = 2000;
const SEARCH_MIN_TEXT_SCORE = 0.05;
const EBBINGHAUS_BASE_STABILITY_DAYS = 30;
const EBBINGHAUS_MAX_STABILITY_DAYS = 365;
const AVG_HEURISTIC_DOC_LEN = 20;
const AVG_REFLECTION_DOC_LEN = 60;
const CJK_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;
const CJK_REPLACE_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;

export class SkillCandidateCapacityError extends Error {
  readonly code = SKILL_CANDIDATE_CAPACITY_CODE;

  constructor(message: string) {
    super(message);
    this.name = "SkillCandidateCapacityError";
  }
}

export interface HeuristicScoreDetail {
  text: number;
  confidence: number;
  evidence: number;
  feedback: number;
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
export function safeHeuristicText(text: string): string {
  const threat = firstThreatMessage(text, "strict");
  if (!threat) return text;
  
  // Check invisible chars
  if (containsInvisibleChars(text)) {
    return `[BLOCKED: contains invisible Unicode characters. Hidden from normal retrieval/list/search output.]`;
  }
  
  const threats = scanForThreats(text.slice(0, MAX_SCAN_CHARS), "strict");
  return `[BLOCKED: heuristic contained threat pattern(s): ${threats.join(", ")}. Hidden from normal retrieval/list/search output; use export_data(collection:"heuristics") to inspect the raw record.]`;
}

// Validation helper - throws error if text contains threats
function assertHeuristicTextSafe(text: string): void {
  const threat = firstThreatMessage(text, "strict");
  if (threat) throw new Error(threat);
}

function sanitizeHeuristicForOutput(heuristic: Heuristic): Heuristic {
  return {
    ...heuristic,
    heuristic: safeHeuristicText(heuristic.heuristic),
    tags: [...(heuristic.tags ?? [])],
    contradiction_notes: [...(heuristic.contradiction_notes ?? [])],
    supersedes: [...(heuristic.supersedes ?? [])],
    evidence: (heuristic.evidence ?? []).map((item) => ({ ...item })),
    feedback: (heuristic.feedback ?? []).map((item) => ({ ...item })),
  };
}

let mutationQueue: Promise<void> = Promise.resolve();
let resolvedQuestionsMutationQueue: Promise<void> = Promise.resolve();

interface FileFingerprint {
  exists: boolean;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface StoreCache {
  store: ReflectionStore;
  loadedAt: number;
  storeFingerprint: FileFingerprint;
  reflectionsFingerprint: FileFingerprint;
  reflectionsAreAscending: boolean;
  sessionIndex: Map<string, number[]>;
  reflectionsWithOpenQuestionsCount: Map<string, number>;
  sessionHeuristicsCount: Map<string, number>;
  heuristicSearchTextById: Map<string, string>;
  reflectionSearchTextById: Map<string, string>;
  heuristicTagSetById: Map<string, Set<string>>;
  reflectionTagSetById: Map<string, Set<string>>;
  reflectionById: Map<string, ReflectionFrame>;
  heuristicById: Map<string, Heuristic>;
}

let storeCache: StoreCache | null = null;
let _mutationStore: ReflectionStore | null = null;
let _storeIndexDirty = false;
let seenReflectionRecoveryGeneration = 0;

async function runReflectionRecoveryBarrier(): Promise<void> {
  const generation = operationRecoveryGeneration();
  if (generation !== seenReflectionRecoveryGeneration) {
    seenReflectionRecoveryGeneration = generation;
    invalidateStoreCache();
  }
}

async function withReflectionAuthorityRead<T>(callback: () => Promise<T>): Promise<T> {
  return withOperationJournalBarrier(async () => {
    await runReflectionRecoveryBarrier();
    return callback();
  });
}

interface ResolvedQuestionsCache {
  index: ResolvedQuestionIndex;
  loadedAt: number;
  fingerprint: FileFingerprint;
}

let _resolvedQuestionsCache: ResolvedQuestionsCache | null = null;
const PENDING_CLAIM_STALE_MS = 5 * 60_000;

function isPendingClaimStale(mutation: PendingMutation): boolean {
  if (mutation.state !== "processing" || !mutation.claimed_at) return false;
  const claimedAt = Date.parse(mutation.claimed_at);
  return Number.isNaN(claimedAt) || Date.now() - claimedAt >= PENDING_CLAIM_STALE_MS;
}

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

function buildReflectionByIdIndex(reflections: ReflectionFrame[]): Map<string, ReflectionFrame> {
  const index = new Map<string, ReflectionFrame>();
  for (const reflection of reflections) {
    index.set(reflection.id, reflection);
  }
  return index;
}

function buildHeuristicByIdIndex(heuristics: Heuristic[]): Map<string, Heuristic> {
  const index = new Map<string, Heuristic>();
  for (const heuristic of heuristics) {
    index.set(heuristic.id, heuristic);
  }
  return index;
}

function countUnresolvedOpenQuestions(reflection: ReflectionFrame): number {
  let count = 0;
  for (const question of reflection.open_questions) {
    if (!question.resolved) count++;
  }
  return count;
}

function cloneSessionIndex(index: Map<string, number[]>): Map<string, number[]> {
  const cloned = new Map<string, number[]>();
  for (const [sessionId, positions] of index) {
    cloned.set(sessionId, [...positions]);
  }
  return cloned;
}

function buildStoreCache(
  store: ReflectionStore,
  storeFingerprint: FileFingerprint,
  reflectionsFingerprint: FileFingerprint,
  loadedAt = Date.now(),
): StoreCache {
  return {
    store,
    loadedAt,
    storeFingerprint,
    reflectionsFingerprint,
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

async function refreshStoreCacheAfterMutation(
  store: ReflectionStore,
  reflectionHint: ReflectionWriteHint,
  previousReflectionCount: number,
  oldCache: StoreCache | null,
): Promise<StoreCache> {
  const loadedAt = Date.now();
  const storeFingerprint = await fileFingerprint(STORE_PATH);

  if (!oldCache) {
    return buildStoreCache(store, storeFingerprint, await fileFingerprint(REFLECTIONS_PATH), loadedAt);
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
      } else {
        sessionIndex.set(reflection.session_id, [reflectionIndex]);
      }
      const unresolvedCount = countUnresolvedOpenQuestions(reflection);
      if (unresolvedCount > 0) {
        reflectionsWithOpenQuestionsCount.set(reflection.id, unresolvedCount);
      } else {
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
      storeFingerprint,
      reflectionsFingerprint: await fileFingerprint(REFLECTIONS_PATH),
      reflectionsAreAscending: previousReflectionCount === 0
        ? checkIsAscending(store.reflections)  // B7-fix: validate order on previously-empty store
        : oldCache.reflectionsAreAscending
          && checkIsAscending(newReflections)  // I4-fix: validate new reflections are internally ascending
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
      storeFingerprint,
      reflectionsFingerprint: oldCache.reflectionsFingerprint,
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

  return buildStoreCache(store, storeFingerprint, await fileFingerprint(REFLECTIONS_PATH), loadedAt);
}

async function getCachedStoreEntryUnderBarrier(): Promise<StoreCache> {
  const now = Date.now();
  if (storeCache) {
    try {
      const storeFingerprint = await fileFingerprint(STORE_PATH);
      const reflectionsFingerprint = await fileFingerprint(REFLECTIONS_PATH);
      if (
        sameFingerprint(storeFingerprint, storeCache.storeFingerprint) &&
        sameFingerprint(reflectionsFingerprint, storeCache.reflectionsFingerprint)
      ) {
        storeCache = { ...storeCache, loadedAt: now };
        return storeCache;
      }
    } catch {
      // Fall through and reload from disk.
    }
  }

  const store = await loadStoreUnderBarrier();
  storeCache = buildStoreCache(
    store,
    await fileFingerprint(STORE_PATH),
    await fileFingerprint(REFLECTIONS_PATH),
  );
  return storeCache;
}

async function getCachedStoreEntry(): Promise<StoreCache> {
  return withReflectionAuthorityRead(getCachedStoreEntryUnderBarrier);
}

async function getCachedStore(): Promise<ReflectionStore> {
  return (await getCachedStoreEntry()).store;
}

function invalidateStoreCache(): void {
  storeCache = null;
  _mutationStore = null;
  invalidateResolvedQuestionsCache();
}

async function getCachedResolvedQuestionsUnderBarrier(): Promise<ResolvedQuestionIndex> {
  const now = Date.now();
  if (_resolvedQuestionsCache) {
    try {
      const currentFingerprint = await fileFingerprint(RESOLVED_QUESTIONS_PATH);
      if (sameFingerprint(currentFingerprint, _resolvedQuestionsCache.fingerprint)) {
        _resolvedQuestionsCache.loadedAt = now;
        return _resolvedQuestionsCache.index;
      }
    } catch { /* stat failed or file missing, fall through to reload */ }
  }
  // No cache or size changed or stat failed: full reload
  const index = await loadResolvedQuestionsUnderBarrier();
  _resolvedQuestionsCache = {
    index,
    loadedAt: Date.now(),
    fingerprint: await fileFingerprint(RESOLVED_QUESTIONS_PATH),
  };
  return index;
}

async function getCachedStoreAndResolvedQuestions(): Promise<{
  cache: StoreCache;
  resolvedIndex: ResolvedQuestionIndex;
}> {
  return withReflectionAuthorityRead(async () => ({
    cache: await getCachedStoreEntryUnderBarrier(),
    resolvedIndex: await getCachedResolvedQuestionsUnderBarrier(),
  }));
}

function invalidateResolvedQuestionsCache(): void {
  _resolvedQuestionsCache = null;
}

async function ensureStoreDir(): Promise<void> {
  if (!existsSync(STORE_DIR)) {
    await mkdir(STORE_DIR, { recursive: true });
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireStoredScope(value: unknown, label: string): MemoryScope {
  if (value === "global") return value;
  if (typeof value === "string" && /^project:[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    return value as MemoryScope;
  }
  throw new Error(`${label}.scope is invalid`);
}

function requireStoredTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function validateLegacyReflectionRaw(value: unknown, label: string): void {
  const raw = requireRecord(value, label);
  if (typeof raw.id !== "string" || raw.id.length === 0) throw new Error(`${label}.id is required`);
  requireStoredTimestamp(raw.timestamp, `${label}.timestamp`);
  if (typeof raw.session_id !== "string" || raw.session_id.length === 0) throw new Error(`${label}.session_id is required`);
  if (typeof raw.task_goal !== "string") throw new Error(`${label}.task_goal must be a string`);
}

function validateV20ReflectionRaw(value: unknown, label: string): void {
  validateLegacyReflectionRaw(value, label);
  requireStoredScope((value as Record<string, unknown>).scope, label);
}

function validateLegacyHeuristicRaw(value: unknown, label: string): void {
  const raw = requireRecord(value, label);
  if (typeof raw.id !== "string" || raw.id.length === 0) throw new Error(`${label}.id is required`);
  requireStoredTimestamp(raw.created_at, `${label}.created_at`);
  requireStoredTimestamp(raw.updated_at, `${label}.updated_at`);
  if (typeof raw.heuristic !== "string") throw new Error(`${label}.heuristic must be a string`);
  if (typeof raw.source_task !== "string") throw new Error(`${label}.source_task must be a string`);
}

function validateV20HeuristicRaw(value: unknown, label: string): void {
  validateLegacyHeuristicRaw(value, label);
  const raw = value as Record<string, unknown>;
  requireStoredScope(raw.scope, label);
  if (!Array.isArray(raw.evidence)) throw new Error(`${label}.evidence must be an array`);
  for (const [index, unknownEvidence] of raw.evidence.entries()) {
    const evidence = requireRecord(unknownEvidence, `${label}.evidence[${index}]`);
    if (typeof evidence.id !== "string" || !/^[a-f0-9]{64}$/.test(evidence.id)) {
      throw new Error(`${label}.evidence[${index}].id must be a sha256 value`);
    }
    if (typeof evidence.source_task !== "string") throw new Error(`${label}.evidence[${index}].source_task must be a string`);
    if (typeof evidence.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(evidence.content_hash)) {
      throw new Error(`${label}.evidence[${index}].content_hash must be a sha256 value`);
    }
    requireStoredTimestamp(evidence.created_at, `${label}.evidence[${index}].created_at`);
    if (evidence.source_reflection_id !== undefined && typeof evidence.source_reflection_id !== "string") {
      throw new Error(`${label}.evidence[${index}].source_reflection_id must be a string`);
    }
  }
  if (!Array.isArray(raw.feedback)) throw new Error(`${label}.feedback must be an array`);
  for (const [index, unknownFeedback] of raw.feedback.entries()) {
    const feedback = requireRecord(unknownFeedback, `${label}.feedback[${index}]`);
    if (typeof feedback.heuristic_id !== "string" || typeof feedback.reflection_id !== "string") {
      throw new Error(`${label}.feedback[${index}] identifiers must be strings`);
    }
    if (feedback.value !== "helpful" && feedback.value !== "harmful" && feedback.value !== "irrelevant") {
      throw new Error(`${label}.feedback[${index}].value is invalid`);
    }
    requireStoredTimestamp(feedback.created_at, `${label}.feedback[${index}].created_at`);
  }
}

function validateLegacyStoreRaw(value: unknown): Record<string, unknown> {
  const raw = requireRecord(value, "store.json");
  // v19 intentionally isolated malformed collection shapes: a bad optional
  // collection normalized to empty without discarding valid neighbours.
  asArray<unknown>(raw.reflections).forEach((item, index) => validateLegacyReflectionRaw(item, `store.json.reflections[${index}]`));
  asArray<unknown>(raw.heuristics).forEach((item, index) => validateLegacyHeuristicRaw(item, `store.json.heuristics[${index}]`));
  return raw;
}

function validateV20StoreRaw(value: unknown): Record<string, unknown> {
  const raw = validateLegacyStoreRaw(value);
  for (const key of ["reflections", "affordance_gaps", "heuristics"] as const) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new Error(`store.json.${key} must be an array`);
  }
  if (raw.sessions !== undefined && (!raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions))) {
    throw new Error("store.json.sessions must be an object");
  }
  const metadata = requireRecord(raw.metadata, "store.json.metadata");
  if (metadata.store_schema_version !== 2) {
    throw new Error(`store_schema_version must be 2, got ${String(metadata.store_schema_version)}`);
  }
  if (metadata.skills !== undefined && !Array.isArray(metadata.skills)) {
    throw new Error("store.json.metadata.skills must be an array");
  }
  if (metadata.skill_candidates !== undefined && !Array.isArray(metadata.skill_candidates)) {
    throw new Error("store.json.metadata.skill_candidates must be an array");
  }
  asArray<unknown>(metadata.skills).forEach((item, index) => {
    const parsed = SkillRecordSchema.safeParse(item);
    if (!parsed.success) throw new Error(`store.json.metadata.skills[${index}] is invalid: ${parsed.error.message}`);
  });
  asArray<unknown>(metadata.skill_candidates).forEach((item, index) => {
    const parsed = SkillPromotionCandidateSchema.safeParse(item);
    if (!parsed.success) throw new Error(`store.json.metadata.skill_candidates[${index}] is invalid: ${parsed.error.message}`);
  });
  if (metadata.skill_promotion !== undefined) {
    const parsed = SkillPromotionMetadataSchema.safeParse(metadata.skill_promotion);
    if (!parsed.success) throw new Error(`store.json.metadata.skill_promotion is invalid: ${parsed.error.message}`);
  }
  asArray<unknown>(raw.reflections).forEach((item, index) => validateV20ReflectionRaw(item, `store.json.reflections[${index}]`));
  asArray<unknown>(raw.heuristics).forEach((item, index) => validateV20HeuristicRaw(item, `store.json.heuristics[${index}]`));
  return raw;
}

async function readRawReflectionSnapshot(fallback: unknown[]): Promise<unknown[]> {
  const loaded = await readAuthoritativeUtf8(REFLECTIONS_PATH);
  if (!loaded.exists) return fallback;
  const rows: unknown[] = [];
  for (const [index, line] of loaded.raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      const backup = await preserveCorruptUtf8(REFLECTIONS_PATH, loaded.raw);
      throw new AuthoritativeStateError(
        `Refusing to continue: reflections.jsonl line ${index + 1} cannot be parsed. Evidence backup: ${backup}. Nothing was changed.`,
        { cause: error },
      );
    }
  }
  return rows.length > 0 ? rows : fallback;
}

async function rejectInvalidStore(raw: string, reason: string): Promise<never> {
  const backup = await preserveCorruptUtf8(STORE_PATH, raw);
  throw new AuthoritativeStateError(
    `Refusing to continue: store.json is invalid (${reason}). Evidence backup: ${backup}. Nothing was changed.`,
  );
}

export async function initializeStoreV20(): Promise<void> {
  await ensureStoreDir();
  await withOperationJournalBarrier(() => withFileLock(STORE_PATH, async () => {
    const loaded = await readAuthoritativeJson<unknown>(STORE_PATH, "Hermes Reflection main store");
    if (!loaded.exists) return;
    let raw: Record<string, unknown>;
    try {
      raw = requireRecord(loaded.value, "store.json");
    } catch (error) {
      return rejectInvalidStore(loaded.raw, error instanceof Error ? error.message : "invalid root value");
    }

    const metadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? raw.metadata as Record<string, unknown>
      : undefined;
    const schemaVersion = metadata?.store_schema_version;
    if (schemaVersion !== undefined && schemaVersion !== 2) {
      const reason = typeof schemaVersion === "number" && schemaVersion > 2
        ? `future store_schema_version ${schemaVersion} is unsupported`
        : `store_schema_version ${String(schemaVersion)} is invalid`;
      await rejectInvalidStore(loaded.raw, reason);
    }

    const fallbackRows = asArray<unknown>(raw.reflections);
    const rawReflectionRows = await readRawReflectionSnapshot(fallbackRows);
    if (schemaVersion === 2) {
      try {
        validateV20StoreRaw(raw);
        rawReflectionRows.forEach((item, index) => validateV20ReflectionRaw(item, `reflections.jsonl[${index}]`));
      } catch (error) {
        await rejectInvalidStore(loaded.raw, error instanceof Error ? error.message : "invalid schema-2 state");
      }
      return;
    }

    try {
      validateLegacyStoreRaw(raw);
      rawReflectionRows.forEach((item, index) => validateLegacyReflectionRaw(item, `reflections.jsonl[${index}]`));
    } catch (error) {
      await rejectInvalidStore(loaded.raw, error instanceof Error ? error.message : "invalid legacy state");
    }

    const now = new Date().toISOString();
    const reflections = uniqueById(rawReflectionRows.map((item) => ({
      ...normalizeReflectionFrame(item as Partial<ReflectionFrame>),
      scope: "global" as const,
    })));
    const heuristics = uniqueById(asArray<Partial<Heuristic>>(raw.heuristics).map((item) => {
      const normalized = normalizeHeuristicRecord(item);
      return {
        ...normalized,
        scope: "global" as const,
        evidence: [{
          id: evidenceId(normalized.source_task, normalized.heuristic),
          source_task: normalized.source_task,
          content_hash: lessonContentHash(normalized.heuristic),
          created_at: normalized.created_at,
        }],
        feedback: [],
      };
    }));
    const normalizedMetadata = normalizeStoreMetadata(raw.metadata) ?? {
      store_schema_version: 2 as const,
      created_at: now,
      last_written_at: now,
      write_count: 0,
      pending_mutations: [],
      review_candidates: [],
      skills: [],
      skill_candidates: [],
      skill_promotion: { dirty_scopes: [] },
    };
    normalizedMetadata.store_schema_version = 2;
    const migrated: ReflectionStore = {
      sessions: normalizeSessionsRecord(recordValue(raw.sessions) as Record<string, Partial<Session>>),
      reflections,
      affordance_gaps: uniqueById(asArray<Partial<AffordanceGap>>(raw.affordance_gaps).map((gap) => normalizeAffordanceGapRecord(gap))),
      heuristics,
      version: typeof raw.version === "string" ? raw.version : VERSION,
      memory_board: normalizeMemoryBoard(raw.memory_board as Partial<MemoryBoard> | undefined),
      user_profile: normalizeMemoryBoard(raw.user_profile as Partial<MemoryBoard> | undefined, 1800),
      metadata: normalizedMetadata,
    };
    reconcileSessionCounters(migrated, false);

    const indexBytes = JSON.stringify({ ...migrated, reflections: undefined }, null, 2);
    const reflectionBytes = reflections.map((reflection) => JSON.stringify(reflection)).join("\n");
    const storeTemp = join(STORE_DIR, `store.json.v20.${process.pid}.${randomUUID()}.tmp`);
    const reflectionsTemp = join(STORE_DIR, `reflections.jsonl.v20.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(storeTemp, indexBytes, { encoding: "utf8", mode: 0o600 });
      await writeFile(reflectionsTemp, reflectionBytes ? `${reflectionBytes}\n` : "", { encoding: "utf8", mode: 0o600 });
      validateV20StoreRaw(JSON.parse(indexBytes));
      reflectionBytes.split(/\r?\n/).filter(Boolean).forEach((line, index) =>
        validateV20ReflectionRaw(JSON.parse(line), `staged reflections.jsonl[${index}]`));
      await replaceFileAtomically(reflectionsTemp, REFLECTIONS_PATH);
      await replaceFileAtomically(storeTemp, STORE_PATH);
      invalidateStoreCache();
    } finally {
      await rm(storeTemp, { force: true }).catch(() => undefined);
      await rm(reflectionsTemp, { force: true }).catch(() => undefined);
    }
  }), { allowLegacyJournal: true });
}

async function runAuthorityReadHookForTest(
  point: "after_store_index_read" | "before_mutation_result_finalize",
): Promise<void> {
  const configured = process.env.HERMES_TEST_AUTHORITY_READ_HOOK_DIR;
  if (process.env.NODE_ENV !== "test" || !configured) return;
  const configuredPoint = process.env.HERMES_TEST_AUTHORITY_READ_HOOK_POINT;
  const allowedPoints = new Set(["after_store_index_read", "before_mutation_result_finalize"]);
  if (!configuredPoint || !allowedPoints.has(configuredPoint)) {
    throw new Error("authority-read test hook point is missing or invalid");
  }
  if (configuredPoint !== point) return;
  const storeRoot = resolve(STORE_DIR);
  const hookDir = resolve(configured);
  const relativeHookDir = relative(storeRoot, hookDir);
  if (!relativeHookDir || relativeHookDir.startsWith("..") || isAbsolute(relativeHookDir)) {
    throw new Error("authority-read test hook directory must be a strict descendant of STORE_DIR");
  }
  await mkdir(hookDir, { recursive: true });
  const readyMarker = join(hookDir, `${point}.ready`);
  const continueMarker = join(hookDir, `${point}.continue`);
  await writeFile(readyMarker, "ready\n", { encoding: "utf8", mode: 0o600 });
  const deadline = Date.now() + 5_000;
  try {
    while (Date.now() < deadline) {
      try { await stat(continueMarker); return; }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    throw new Error(`authority-read test hook timed out at ${point}`);
  } finally {
    await rm(readyMarker, { force: true }).catch(() => undefined);
    await rm(continueMarker, { force: true }).catch(() => undefined);
  }
}

async function loadStoreUnderBarrier(): Promise<ReflectionStore> {
  await ensureStoreDir();
  const loaded = await readAuthoritativeJson<unknown>(STORE_PATH, "Hermes Reflection main store");
  if (!loaded.exists) {
    const store = emptyStore();
    store.reflections = await loadReflections([], true);
    reconcileSessionCounters(store, true);
    return store;
  }
  const parsed = requireRecord(loaded.value, "store.json") as Partial<ReflectionStore>;
  await runAuthorityReadHookForTest("after_store_index_read");
  const metadata = recordValue(parsed.metadata);
  if (metadata.store_schema_version !== 2) {
    // Validate JSONL first so an existing corrupt sidecar remains the primary
    // fail-closed diagnostic and cannot be hidden by a migration-required error.
    await readRawReflectionSnapshot(asArray<unknown>(parsed.reflections));
    throw new AuthoritativeStateError(
      "Refusing to continue: store.json requires initializeStoreV20() before normal reads. Nothing was changed.",
    );
  }
  let rawRows: unknown[];
  try {
    validateV20StoreRaw(loaded.value);
    rawRows = await readRawReflectionSnapshot(asArray<unknown>(parsed.reflections));
    rawRows.forEach((item, index) => validateV20ReflectionRaw(item, `reflections.jsonl[${index}]`));
  } catch (error) {
    if (error instanceof AuthoritativeStateError) throw error;
    return rejectInvalidStore(loaded.raw, error instanceof Error ? error.message : "invalid schema-2 state");
  }
  const store: ReflectionStore = {
    sessions: normalizeSessionsRecord(recordValue(parsed.sessions) as Record<string, Partial<Session>>),
    reflections: uniqueById(rawRows.map((item) => normalizeReflectionFrame(item as Partial<ReflectionFrame>))),
    affordance_gaps: uniqueById(
      asArray<Partial<AffordanceGap>>(parsed.affordance_gaps).map((gap) => normalizeAffordanceGapRecord(gap)),
    ),
    heuristics: uniqueById(asArray<Partial<Heuristic>>(parsed.heuristics).map(normalizeHeuristicRecord)),
    version: typeof parsed.version === "string" ? parsed.version : VERSION,
    memory_board: normalizeMemoryBoard(parsed.memory_board as Partial<MemoryBoard> | undefined),
    user_profile: normalizeMemoryBoard(parsed.user_profile as Partial<MemoryBoard> | undefined, 1800),
    metadata: normalizeStoreMetadata(parsed.metadata),
  };
  reconcileSessionCounters(store, false);
  return store;
}

export async function loadStore(): Promise<ReflectionStore> {
  return withReflectionAuthorityRead(loadStoreUnderBarrier);
}

function emptyStore(): ReflectionStore {
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
      store_schema_version: 2,
      created_at: now,
      last_written_at: now,
      write_count: 0,
      pending_mutations: [],
      review_candidates: [],
      skills: [],
      skill_candidates: [],
      skill_promotion: { dirty_scopes: [] },
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

function normalizeIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number, minimum = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? Math.floor(value)
    : fallback;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeOpenQuestion(value: Partial<OpenQuestion> | unknown): OpenQuestion {
  const input = recordValue(value);
  const now = new Date().toISOString();
  const priority: Priority =
    input.priority === "high" || input.priority === "low" || input.priority === "medium"
      ? input.priority
      : "medium";
  return {
    question: typeof input.question === "string" ? input.question : "",
    priority,
    requires_environment_interaction: input.requires_environment_interaction === true,
    ...(input.resolved === true ? { resolved: true } : {}),
    ...(input.resolved === true
      ? { resolved_at: normalizeIsoTimestamp(input.resolved_at, now) }
      : {}),
    ...(typeof input.resolved_by === "string" ? { resolved_by: input.resolved_by } : {}),
  };
}

function normalizeWorldModelUpdate(value: Partial<WorldModelUpdate> | unknown): WorldModelUpdate {
  const input = recordValue(value);
  return {
    fact: typeof input.fact === "string" ? input.fact : "",
    polarity: input.polarity === "negate" ? "negate" : "affirm",
    source: typeof input.source === "string" ? input.source : "",
    evidence: typeof input.evidence === "string" ? input.evidence : "",
  };
}

function normalizeToolInsight(value: Partial<ToolInsight> | unknown): ToolInsight {
  const input = recordValue(value);
  return {
    tool: typeof input.tool === "string" ? input.tool : "",
    insight: typeof input.insight === "string" ? input.insight : "",
    status: input.status === "confirmed" ? "confirmed" : "needs_verification",
    evidence: typeof input.evidence === "string" ? input.evidence : "",
  };
}

function normalizeContextForget(value: Partial<ContextForget> | unknown): ContextForget {
  const input = recordValue(value);
  return {
    item: typeof input.item === "string" ? input.item : "",
    reason: typeof input.reason === "string" ? input.reason : "",
  };
}

function normalizeSummarySections(value: unknown): Array<{ title: string; content: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value.flatMap((section) => {
    const input = recordValue(section);
    return typeof input.title === "string" && typeof input.content === "string"
      ? [{ title: input.title, content: input.content }]
      : [];
  });
  return sections.length > 0 ? sections : undefined;
}

function normalizeReflectionFrame(input: Partial<ReflectionFrame>): ReflectionFrame {
  const source = recordValue(input);
  const taskState = recordValue(source.task_state);
  const sessionId = typeof source.session_id === "string" && source.session_id ? source.session_id : "legacy";
  const now = new Date().toISOString();
  return {
    id: typeof source.id === "string" && source.id ? source.id : generateId(),
    timestamp: normalizeIsoTimestamp(source.timestamp, now),
    session_id: sessionId,
    scope: normalizeMemoryScope(source.scope),
    task_goal: typeof source.task_goal === "string" ? source.task_goal : "",
    task_outcome: normalizeTaskOutcome(source.task_outcome),
    failure_mode: normalizeFailureMode(source.failure_mode),
    task_state: {
      summary: typeof taskState.summary === "string" ? taskState.summary : "",
      summary_sections: normalizeSummarySections(taskState.summary_sections),
      immediate_blockers: stringArray(taskState.immediate_blockers),
      active_hypotheses: stringArray(taskState.active_hypotheses),
      proven_safe_paths: stringArray(taskState.proven_safe_paths),
      exhausted_search: stringArray(taskState.exhausted_search),
    },
    world_model_updates: asArray<Partial<WorldModelUpdate>>(source.world_model_updates).map(normalizeWorldModelUpdate),
    tool_insights: asArray<Partial<ToolInsight>>(source.tool_insights).map(normalizeToolInsight),
    context_forget: asArray<Partial<ContextForget>>(source.context_forget).map(normalizeContextForget),
    open_questions: asArray<Partial<OpenQuestion>>(source.open_questions).map(normalizeOpenQuestion),
    lessons_learned: stringArray(source.lessons_learned),
    affordance_gaps: asArray<Partial<AffordanceGap>>(source.affordance_gaps).map((gap) => normalizeAffordanceGapRecord(gap, sessionId)),
    domain: typeof source.domain === "string" ? normalizeDomain(source.domain) : "general",
    tags: stringArray(source.tags).map((tag) => tag.toLowerCase().trim()).filter(Boolean),
    context_notes: typeof source.context_notes === "string" && source.context_notes.trim() ? source.context_notes.slice(0, 2000) : undefined,
  };
}

function normalizeHeuristicRecord(h: Partial<Heuristic>): Heuristic {
  const now = new Date().toISOString();
  return {
    id: typeof h.id === "string" && h.id ? h.id : generateId(),
    created_at: normalizeIsoTimestamp(h.created_at, now),
    updated_at: normalizeIsoTimestamp(h.updated_at, now),
    domain: typeof h.domain === "string" ? normalizeDomain(h.domain) : "general",
    heuristic: typeof h.heuristic === "string" ? h.heuristic : "",
    source_task: typeof h.source_task === "string" ? h.source_task : "",
    session_id: typeof h.session_id === "string" ? h.session_id : undefined,
    scope: normalizeMemoryScope(h.scope),
    evidence: normalizeHeuristicEvidence(h.evidence),
    feedback: normalizeHeuristicFeedback(h.feedback),
    reinforcement_count: normalizeNonNegativeInteger(h.reinforcement_count, 1, 1),
    contradiction_count: normalizeNonNegativeInteger(h.contradiction_count, 0),
    contradiction_notes: stringArray(h.contradiction_notes),
    confidence: typeof h.confidence === "number" && Number.isFinite(h.confidence)
      ? Math.max(0, Math.min(1, h.confidence))
      : 0.6,
    retrieval_count: normalizeNonNegativeInteger(h.retrieval_count, 0),
    last_retrieved_at: typeof h.last_retrieved_at === "string"
      ? normalizeIsoTimestamp(h.last_retrieved_at, now)
      : undefined,
    supersedes: stringArray(h.supersedes),
    superseded_by: typeof h.superseded_by === "string" ? h.superseded_by : undefined,
    pinned: h.pinned === true ? true : undefined,
    version: normalizeNonNegativeInteger(h.version, 1, 1),
    tags: stringArray(h.tags).map((tag) => tag.toLowerCase().trim()).filter(Boolean),
  };
}

function normalizeMemoryScope(value: unknown): MemoryScope {
  if (value === "global") return value;
  if (typeof value === "string" && /^project:[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    return value as MemoryScope;
  }
  return "global";
}

function normalizeHeuristicEvidence(value: unknown): HeuristicEvidence[] {
  return asArray<unknown>(value).flatMap((item) => {
    const raw = recordValue(item);
    if (typeof raw.id !== "string" || typeof raw.source_task !== "string"
      || typeof raw.content_hash !== "string" || typeof raw.created_at !== "string") return [];
    return [{
      id: raw.id,
      ...(typeof raw.source_reflection_id === "string" ? { source_reflection_id: raw.source_reflection_id } : {}),
      source_task: raw.source_task,
      content_hash: raw.content_hash,
      created_at: raw.created_at,
    }];
  });
}

function normalizeHeuristicFeedback(value: unknown): HeuristicFeedback[] {
  return asArray<unknown>(value).flatMap((item) => {
    const raw = recordValue(item);
    if (typeof raw.heuristic_id !== "string" || typeof raw.reflection_id !== "string"
      || (raw.value !== "helpful" && raw.value !== "harmful" && raw.value !== "irrelevant")
      || typeof raw.created_at !== "string") return [];
    return [{
      heuristic_id: raw.heuristic_id,
      reflection_id: raw.reflection_id,
      value: raw.value,
      created_at: raw.created_at,
    }];
  });
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function normalizeMemoryBoard(input: Partial<MemoryBoard> | undefined, defaultCharLimit = 2200): MemoryBoard {
  const now = new Date().toISOString();
  const entries: MemoryEntry[] = uniqueById(Array.isArray(input?.entries)
    ? (input!.entries as Partial<MemoryEntry>[]).map((e) => ({
        id: typeof e.id === "string" && e.id ? e.id : generateId(),
        content: typeof e.content === "string" ? e.content : "",
        created_at: normalizeIsoTimestamp(e.created_at, now),
        updated_at: normalizeIsoTimestamp(e.updated_at, now),
        source_reflection_id: typeof e.source_reflection_id === "string" && e.source_reflection_id ? e.source_reflection_id : undefined,
      }))
    : []);
  const raw_limit = typeof input?.char_limit === "number" && Number.isFinite(input.char_limit) && input.char_limit > 0
    ? input.char_limit
    : defaultCharLimit;
  const char_limit = Math.min(raw_limit, 100000);  // B16: cap to prevent unbounded growth
  const used_chars = entries.reduce((sum, e) => sum + e.content.length, 0);
  return { entries, char_limit, used_chars };
}

function normalizeAffordanceGapRecord(input: Partial<AffordanceGap>, fallbackSessionId = "legacy"): AffordanceGap {
  const now = new Date().toISOString();
  return {
    id: typeof input.id === "string" && input.id ? input.id : generateId(),
    timestamp: normalizeIsoTimestamp(input.timestamp, now),
    session_id: typeof input.session_id === "string" && input.session_id ? input.session_id : fallbackSessionId,
    goal_description: typeof input.goal_description === "string" ? input.goal_description : "",
    failure_description: typeof input.failure_description === "string" ? input.failure_description : "",
    missing_capability: typeof input.missing_capability === "string" ? input.missing_capability : "",
    available_tools: stringArray(input.available_tools),
    occurrence_count: typeof input.occurrence_count === "number" && Number.isFinite(input.occurrence_count) && input.occurrence_count > 0 ? input.occurrence_count : 1,
    suggested_solution: typeof input.suggested_solution === "string" && input.suggested_solution ? input.suggested_solution : undefined,
    resolved: input.resolved === true ? true : undefined,
    resolved_at: input.resolved === true
      ? normalizeIsoTimestamp(input.resolved_at, now)
      : undefined,
    resolution_notes: typeof input.resolution_notes === "string" ? input.resolution_notes : undefined,
  };
}

function normalizeSessionRecord(id: string, input: Partial<Session>): Session {
  const now = new Date().toISOString();
  return {
    id,
    started_at: normalizeIsoTimestamp(input.started_at, now),
    reflection_count: typeof input.reflection_count === "number" && Number.isFinite(input.reflection_count) && input.reflection_count >= 0 ? input.reflection_count : 0,
    affordance_gap_count: typeof input.affordance_gap_count === "number" && Number.isFinite(input.affordance_gap_count) && input.affordance_gap_count >= 0 ? input.affordance_gap_count : 0,
  };
}

function getOwnSession(sessions: Record<string, Session>, id: string): Session | undefined {
  return Object.prototype.hasOwnProperty.call(sessions, id) ? sessions[id] : undefined;
}

function setOwnSession(sessions: Record<string, Session>, id: string, session: Session): void {
  // Assignment to "__proto__" on an ordinary object invokes its legacy
  // prototype setter. Define an own data property so every valid session_id is
  // stored literally.
  Object.defineProperty(sessions, id, {
    value: session,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalizeSessionsRecord(input: Record<string, Partial<Session>> | undefined): Record<string, Session> {
  const sessions: Record<string, Session> = {};
  for (const [id, session] of Object.entries(input ?? {})) {
    setOwnSession(sessions, id, normalizeSessionRecord(id, session));
  }
  return sessions;
}

function normalizeReviewCandidate(value: unknown, fallbackTimestamp: string): ReviewCandidate | null {
  const input = recordValue(value);
  const id = typeof input.id === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(input.id) ? input.id : undefined;
  const scope = normalizeMemoryScope(input.scope);
  const stage = input.stage === "deterministic" || input.stage === "llm" ? input.stage : undefined;
  const fingerprint = typeof input.source_fingerprint === "string" && /^[a-f0-9]{64}$/i.test(input.source_fingerprint)
    ? input.source_fingerprint.toLowerCase()
    : undefined;
  const evidenceFingerprint = typeof input.evidence_fingerprint === "string" && /^[a-f0-9]{64}$/i.test(input.evidence_fingerprint)
    ? input.evidence_fingerprint.toLowerCase()
    : "0".repeat(64);
  const heuristic = typeof input.heuristic === "string" ? input.heuristic.trim() : "";
  const domain = typeof input.domain === "string" ? input.domain.trim() : "";
  const state = input.state === "pending" || input.state === "applied" || input.state === "rejected"
    ? input.state
    : undefined;
  const sourceIds = asArray<unknown>(input.source_reflection_ids)
    .filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 100)
    .slice(0, REVIEW_CANDIDATE_SOURCE_IDS_MAX);
  const tags = [...new Set(asArray<unknown>(input.tags)
    .filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 100))]
    .slice(0, REVIEW_CANDIDATE_TAGS_MAX);
  const riskReasons = [...new Set([
    ...asArray<unknown>(input.risk_reasons)
      .filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200),
    ...(evidenceFingerprint === "0".repeat(64) ? ["legacy_missing_evidence_fingerprint"] : []),
  ])]
    .slice(0, 20);
  const confidence = Number(input.confidence);
  const mutationId = typeof input.mutation_id === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(input.mutation_id)
    ? input.mutation_id
    : undefined;
  if (!id || !stage || !fingerprint || !heuristic || heuristic.length > REVIEW_CANDIDATE_LESSON_MAX
    || !domain || domain.length > 100 || !state || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
    || (state === "pending" && !mutationId)) {
    return null;
  }
  return {
    id,
    created_at: normalizeIsoTimestamp(input.created_at, fallbackTimestamp),
    scope,
    stage,
    source_fingerprint: fingerprint,
    evidence_fingerprint: evidenceFingerprint,
    source_reflection_ids: sourceIds,
    heuristic,
    domain,
    tags,
    confidence,
    risk_reasons: riskReasons,
    state,
    ...(mutationId ? { mutation_id: mutationId } : {}),
  };
}

function boundReviewCandidateAudit(candidates: ReviewCandidate[]): ReviewCandidate[] {
  const retained = new Set<string>();
  const scopes = new Set(candidates.map((candidate) => candidate.scope));
  for (const scope of scopes) {
    const scoped = candidates.filter((candidate) => candidate.scope === scope);
    for (const item of scoped.filter((candidate) => candidate.state === "pending").slice(-REVIEW_CANDIDATE_PENDING_PER_SCOPE_MAX)) {
      retained.add(item.id);
    }
    for (const item of scoped.filter((candidate) => candidate.state !== "pending").slice(-REVIEW_CANDIDATE_TERMINAL_PER_SCOPE_MAX)) {
      retained.add(item.id);
    }
  }
  return candidates.filter((candidate) => retained.has(candidate.id));
}

function boundSkillCandidateAudit(
  candidates: SkillPromotionCandidate[],
  skills: readonly SkillRecord[] = [],
): SkillPromotionCandidate[] {
  const retained = new Set<string>();
  const currentOriginsByScope = new Map<MemoryScope, Set<string>>();
  for (const skill of skills) {
    const revision = skill.revisions.find((item) => item.revision === skill.current_revision);
    if (!revision) continue;
    const origins = currentOriginsByScope.get(skill.scope) ?? new Set<string>();
    origins.add(revision.origin_candidate_id);
    currentOriginsByScope.set(skill.scope, origins);
  }
  const scopes = new Set(candidates.map((candidate) => candidate.scope));
  for (const scope of scopes) {
    const scoped = candidates.filter((candidate) => candidate.scope === scope);
    for (const item of scoped.filter((candidate) => candidate.state === "pending" || candidate.state === "approved")
      .slice(-SKILL_CANDIDATE_PENDING_PER_SCOPE_MAX)) {
      retained.add(item.id);
    }
    const terminal = scoped.filter((candidate) => candidate.state !== "pending" && candidate.state !== "approved");
    const pinned = terminal.filter((candidate) => currentOriginsByScope.get(scope)?.has(candidate.id))
      .slice(-SKILL_CANDIDATE_TERMINAL_PER_SCOPE_MAX);
    for (const item of pinned) {
      retained.add(item.id);
    }
    const remaining = SKILL_CANDIDATE_TERMINAL_PER_SCOPE_MAX - pinned.length;
    if (remaining > 0) {
      for (const item of terminal.filter((candidate) => !retained.has(candidate.id)).slice(-remaining)) {
        retained.add(item.id);
      }
    }
  }
  return candidates.filter((candidate) => retained.has(candidate.id));
}

function normalizeSkillRecords(value: unknown): SkillRecord[] {
  const records = asArray<unknown>(value).map((item) => SkillRecordSchema.parse(item));
  const ids = new Set<string>();
  const perScope = new Map<MemoryScope, number>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Duplicate skill record ID: ${record.id}`);
    ids.add(record.id);
    const count = (perScope.get(record.scope) ?? 0) + 1;
    if (count > SKILL_RECORDS_PER_SCOPE_MAX) throw new Error(`Skill record limit exceeded for ${record.scope}`);
    perScope.set(record.scope, count);
  }
  return records;
}

function normalizeSkillCandidates(value: unknown, skills: readonly SkillRecord[]): SkillPromotionCandidate[] {
  const candidates = asArray<unknown>(value).map((item) => SkillPromotionCandidateSchema.parse(item));
  const ids = new Set<string>();
  const pendingByScope = new Map<MemoryScope, number>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) throw new Error(`Duplicate skill candidate ID: ${candidate.id}`);
    ids.add(candidate.id);
    if (candidate.state === "pending" || candidate.state === "approved") {
      const count = (pendingByScope.get(candidate.scope) ?? 0) + 1;
      if (count > SKILL_CANDIDATE_PENDING_PER_SCOPE_MAX) {
        throw new Error(`Pending skill candidate limit exceeded for ${candidate.scope}`);
      }
      pendingByScope.set(candidate.scope, count);
    }
  }
  return boundSkillCandidateAudit(candidates, skills);
}

function normalizeSkillPromotionMetadata(value: unknown): { dirty_scopes: SkillPromotionDirtyScope[] } {
  if (value === undefined) return { dirty_scopes: [] };
  const parsed = SkillPromotionMetadataSchema.parse(value);
  const seen = new Set<MemoryScope>();
  for (const item of parsed.dirty_scopes) {
    if (seen.has(item.scope)) throw new Error(`Duplicate skill promotion dirty scope: ${item.scope}`);
    seen.add(item.scope);
  }
  return parsed;
}

export function idempotencyKeyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function normalizeCommittedReceipts(value: unknown, now = Date.now()): Record<string, CommittedReceipt> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.create(null) as Record<string, CommittedReceipt>;
  const cutoff = now - COMMITTED_RECEIPT_RETENTION_MS;
  const entries: Array<[string, CommittedReceipt]> = [];
  for (const [keyHash, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!SHA256_RE.test(keyHash) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).sort().join("\0") !== ["committed_at", "input_hash", "reflection_ids", "result_id", "transaction_id"].join("\0")) continue;
    const committedAt = typeof item.committed_at === "string" ? Date.parse(item.committed_at) : NaN;
    if (!Number.isFinite(committedAt) || committedAt < cutoff
        || typeof item.transaction_id !== "string" || !UUID_RE.test(item.transaction_id)
        || typeof item.result_id !== "string" || !UUID_RE.test(item.result_id)
        || typeof item.input_hash !== "string" || !SHA256_RE.test(item.input_hash)
        || !Array.isArray(item.reflection_ids) || item.reflection_ids.length > 256
        || !item.reflection_ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100)) continue;
    entries.push([keyHash, {
      transaction_id: item.transaction_id,
      result_id: item.result_id,
      reflection_ids: [...item.reflection_ids] as string[],
      input_hash: item.input_hash,
      committed_at: new Date(committedAt).toISOString(),
    }]);
  }
  entries.sort((left, right) => compareStableText(left[1].committed_at, right[1].committed_at)
    || compareStableText(left[0], right[0]));
  const bounded = entries.slice(-COMMITTED_RECEIPT_MAX);
  return Object.fromEntries(bounded) as Record<string, CommittedReceipt>;
}

function committedReceiptFor(store: ReflectionStore, key: string): CommittedReceipt | undefined {
  return store.metadata?.committed_receipts?.[idempotencyKeyHash(key)];
}

function normalizeStoreMetadata(value: unknown): ReflectionStore["metadata"] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const now = new Date().toISOString();
  const pending: PendingMutation[] = [];
  for (const rawMutation of asArray<unknown>(input.pending_mutations)) {
    const mutation = recordValue(rawMutation);
    const id = typeof mutation.id === "string" ? mutation.id.trim() : "";
    const operation = typeof mutation.operation === "string" ? mutation.operation.trim() : "";
    if (!id || !operation) continue;
    const isProcessing = mutation.state === "processing"
      && typeof mutation.claim_token === "string"
      && mutation.claim_token.length > 0;
    pending.push({
      id,
      created_at: normalizeIsoTimestamp(mutation.created_at, now),
      operation,
      preview: typeof mutation.preview === "string" ? mutation.preview : `Queued ${operation} pending approval`,
      ...(recordValue(mutation.payload) !== mutation.payload
        ? {}
        : { payload: mutation.payload as Record<string, unknown> }),
      ...(typeof mutation.payload_hash === "string" ? { payload_hash: mutation.payload_hash } : {}),
      ...(isProcessing
        ? {
            state: "processing" as const,
            claim_token: mutation.claim_token as string,
            claimed_at: normalizeIsoTimestamp(mutation.claimed_at, now),
          }
        : { state: "pending" as const }),
    });
  }

  const reviewCandidates = boundReviewCandidateAudit(
    asArray<unknown>(input.review_candidates)
      .map((item) => normalizeReviewCandidate(item, now))
      .filter((item): item is ReviewCandidate => item !== null),
  );
  const reviewMutationIds = new Set(reviewCandidates
    .filter((candidate) => candidate.state === "pending" && candidate.mutation_id)
    .map((candidate) => candidate.mutation_id!));
  const skills = normalizeSkillRecords(input.skills);
  const skillCandidates = normalizeSkillCandidates(input.skill_candidates, skills);
  const skillMutationIds = new Set(skillCandidates
    .filter((candidate) => (candidate.state === "pending" || candidate.state === "approved") && candidate.mutation_id)
    .map((candidate) => candidate.mutation_id!));
  const consistentPending = pending.filter((mutation) =>
    (mutation.operation !== "apply_review_candidate" || reviewMutationIds.has(mutation.id))
    && (mutation.operation !== "apply_skill_candidate" || skillMutationIds.has(mutation.id)));

  const provider = recordValue(input.external_provider);
  const providerName = typeof provider.name === "string" && provider.name.trim()
    ? provider.name.trim()
    : undefined;

  return {
    store_schema_version: 2,
    created_at: normalizeIsoTimestamp(input.created_at, now),
    last_written_at: normalizeIsoTimestamp(input.last_written_at, now),
    write_count: normalizeNonNegativeInteger(input.write_count, 0),
    ...(typeof input.write_approval === "boolean" ? { write_approval: input.write_approval } : {}),
    pending_mutations: consistentPending,
    review_candidates: reviewCandidates,
    skills,
    skill_candidates: skillCandidates,
    skill_promotion: normalizeSkillPromotionMetadata(input.skill_promotion),
    committed_receipts: normalizeCommittedReceipts(input.committed_receipts),
    ...(providerName
      ? {
          external_provider: {
            name: providerName,
            ...(typeof provider.endpoint === "string" ? { endpoint: provider.endpoint } : {}),
            ...(typeof provider.db_path === "string" ? { db_path: provider.db_path } : {}),
            ...(typeof provider.auto_sync === "boolean" ? { auto_sync: provider.auto_sync } : {}),
          },
        }
      : {}),
  };
}

function nextSkillPromotionDirtyTimestamp(existing: SkillPromotionDirtyScope | undefined): string {
  const previous = Math.max(
    existing ? Date.parse(existing.dirty_at) : 0,
    existing?.completed_at ? Date.parse(existing.completed_at) : 0,
  );
  return new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
}

function markSkillPromotionDirtyMut(store: ReflectionStore, scope: MemoryScope): void {
  const metadata = store.metadata;
  if (!metadata) throw new Error("Store metadata is unavailable");
  const promotion: SkillPromotionMetadata = metadata.skill_promotion ?? { dirty_scopes: [] };
  const existing = promotion.dirty_scopes.find((item) => item.scope === scope);
  const dirtyAt = nextSkillPromotionDirtyTimestamp(existing);
  if (existing) existing.dirty_at = dirtyAt;
  else {
    const requiredEvictions = promotion.dirty_scopes.length - SKILL_PROMOTION_SCOPE_MAX + 1;
    if (requiredEvictions > 0) {
      const evictable = promotion.dirty_scopes
        .filter((item) => !isSkillPromotionScopeDirty(item))
        .sort((left, right) =>
          (Date.parse(left.completed_at!) - Date.parse(right.completed_at!))
          || compareStableText(left.scope, right.scope));
      if (evictable.length < requiredEvictions) {
        throw new Error(`Active skill promotion scope limit reached (${SKILL_PROMOTION_SCOPE_MAX})`);
      }
      const evicted = new Set(evictable.slice(0, requiredEvictions).map((item) => item.scope));
      promotion.dirty_scopes = promotion.dirty_scopes.filter((item) => !evicted.has(item.scope));
    }
    promotion.dirty_scopes.push({ scope, dirty_at: dirtyAt });
  }
  promotion.dirty_scopes.sort((left, right) => compareStableText(left.scope, right.scope));
  metadata.skill_promotion = SkillPromotionMetadataSchema.parse(promotion);
}

// B15: removed dead code saveStore

async function writeStoreIndex(
  store: ReflectionStore,
  incrementWriteCount: boolean,
): Promise<void> {
  await ensureStoreDir();
  const content = prepareStoreIndexContent(store, incrementWriteCount);
  const tmpPath = join(STORE_DIR, `store.json.tmp.${process.pid}.${Date.now()}.${randomUUID()}`);
  await writeFile(tmpPath, content, "utf-8");
  await replaceFileAtomically(tmpPath, STORE_PATH);
}

function prepareStoreIndexContent(store: ReflectionStore, incrementWriteCount: boolean): string {
  store.version = VERSION;
  if (incrementWriteCount && _storeIndexDirty) {
    const now = new Date().toISOString();
    if (store.metadata) {
      store.metadata.last_written_at = now;
      store.metadata.write_count = (store.metadata.write_count ?? 0) + 1;
    } else {
      store.metadata = { store_schema_version: 2, created_at: now, last_written_at: now, write_count: 1 };
    }
    _storeIndexDirty = false;
  }
  const indexStore = { ...store, reflections: undefined };
  return `${JSON.stringify(indexStore, null, 2)}\n`;
}

async function replaceFileAtomically(tmpPath: string, targetPath: string): Promise<void> {
  let lastError: unknown;

  // Phase 1: direct rename with retries
  for (let attempt = 0; attempt < WINDOWS_RENAME_RETRIES; attempt++) {
    try {
      await rename(tmpPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!isWindowsRenameRetryable(error)) break;
      if (attempt < WINDOWS_RENAME_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  // Cleanup: delete the temp file only. A failed replacement must never
  // delete the last known-good target before the new file is durable.
  try {
    await rm(tmpPath, { force: true });
  } catch {
    // Best-effort cleanup
  }

  const ctx = `replaceFileAtomically failed to move ${tmpPath} -> ${targetPath}`;
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${ctx}: ${detail}`);
}

/** Narrow module-level test seam; this is not exposed as an MCP tool. */
export async function replaceFileAtomicallyForTest(tmpPath: string, targetPath: string): Promise<void> {
  return replaceFileAtomically(tmpPath, targetPath);
}

function isWindowsRenameRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EEXIST";
}

async function loadReflections(fallback: ReflectionFrame[] = [], requireV20 = true): Promise<ReflectionFrame[]> {
  if (requireV20) {
    fallback.forEach((reflection, index) => validateV20ReflectionRaw(reflection, `fallback reflections[${index}]`));
  }
  const normalizedFallback = fallback.map((reflection) => normalizeReflectionFrame(reflection));
  const loaded = await readAuthoritativeUtf8(REFLECTIONS_PATH);
  if (!loaded.exists) return normalizedFallback;
  const results: ReflectionFrame[] = [];
  for (const [index, line] of loaded.raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<ReflectionFrame>;
      if (requireV20) validateV20ReflectionRaw(parsed, `reflections.jsonl[${index}]`);
      results.push(normalizeReflectionFrame(parsed));
    } catch (error) {
      const backup = await preserveCorruptUtf8(REFLECTIONS_PATH, loaded.raw);
      throw new AuthoritativeStateError(
        `Refusing to continue: reflections.jsonl line ${index + 1} cannot be parsed. Evidence backup: ${backup}. Nothing was changed.`,
        { cause: error },
      );
    }
  }
  return results.length > 0 ? uniqueById(results) : uniqueById(normalizedFallback);
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

export interface ReflectionIdempotencyContext {
  key: string;
  input_hash: string;
}

interface MutationIdempotency<T> extends ReflectionIdempotencyContext {
  reflection_ids: string[];
  replay: (store: ReflectionStore, receipt: CommittedReceipt) => T;
  decorate: (result: T, receipt: CommittedReceipt, replayed: boolean) => T;
}

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

async function mutateStore<T>(
  mutator: (store: ReflectionStore) => T | Promise<T>,
  reflectionHint: ReflectionWriteHint = "none",
  operationName?: string,
  operationPayload?: Record<string, unknown>,
  preflight?: (store: ReflectionStore) => void,
  resolvedQuestionsMutator?: (index: ResolvedQuestionIndex, result: T) => void | Promise<void>,
  idempotency?: MutationIdempotency<T>,
  approvalInputHash?: string,
  resultFinalizer?: (result: T, resolved: ResolvedQuestionIndex) => T | Promise<T>,
): Promise<T> {
  const execute = () => withFileLock(STORE_PATH, async () => {
    // A process-local cache is insufficient when multiple MCP processes share
    // one HOME. Reload only after acquiring the cross-process transaction lock.
    _mutationStore = await loadStore();
    preflight?.(_mutationStore);

    // Write-approval gate: queue mutation instead of executing.
    // This uses the live _mutationStore because it must persist immediately.
    if (operationName && _mutationStore.metadata?.write_approval === true) {
      const store = _mutationStore;
      const metadata = store.metadata!;
      const pending = metadata.pending_mutations ?? [];
      const pendingId = randomUUID();
      const pendingMutation: PendingMutation = {
        id: pendingId,
        created_at: new Date().toISOString(),
        operation: operationName,
        preview: `Queued ${operationName} pending approval`,
        payload: operationPayload ?? {},
        payload_hash: approvalInputHash ?? pendingMutationPayloadHash(operationPayload ?? {}),
      };
      pending.push(pendingMutation);
      metadata.pending_mutations = pending;
      _storeIndexDirty = true;  // B6-fix: ensure write_count/last_written_at update
      await persistStoreAfterMutation(store, "none", store.reflections.length);
      storeCache = await refreshStoreCacheAfterMutation(store, "none", store.reflections.length, storeCache);
      const approvalError = new Error(
        `Operation "${operationName}" was queued for approval (pending_mutation_id: ${pendingId}). ` +
        `Use approve_pending_mutation to approve or reject.`,
      ) as Error & { isPendingApproval: boolean; pendingMutationId: string };
      approvalError.isPendingApproval = true;
      approvalError.pendingMutationId = pendingId;
      throw approvalError;
    }

    if (idempotency) {
      const prior = committedReceiptFor(_mutationStore, idempotency.key);
      if (prior) {
        if (prior.input_hash !== idempotency.input_hash) {
          throw new Error("IDEMPOTENCY_CONFLICT: idempotency_key is already committed for different normalized input");
        }
        return idempotency.decorate(idempotency.replay(_mutationStore, prior), structuredClone(prior), true);
      }
    }

    // Normal mutation: work on a clone so a partial or failed mutator
    // cannot corrupt the live cached _mutationStore.
    const store = structuredClone(_mutationStore) as ReflectionStore;
    const previousReflectionCount = store.reflections.length;
    let result: T;
    let resolvedForFinalizer: ResolvedQuestionIndex | undefined;
    let reservation: OperationTransactionReservation | undefined;
    let committedReceipt: CommittedReceipt | undefined;
    try {
      result = await mutator(store);
      if (idempotency && reflectionHint !== "none" && operationJournalMutationContext.getStore() !== true) {
        reservation = reserveOperationTransaction();
        committedReceipt = {
          transaction_id: reservation.transaction_id,
          result_id: reservation.result_id,
          reflection_ids: [...idempotency.reflection_ids],
          input_hash: idempotency.input_hash,
          committed_at: reservation.created_at,
        };
        const metadata = store.metadata;
        if (!metadata) throw new Error("Store metadata is unavailable");
        metadata.committed_receipts = normalizeCommittedReceipts({
          ...(metadata.committed_receipts ?? {}),
          [idempotencyKeyHash(idempotency.key)]: committedReceipt,
        });
      }
      _storeIndexDirty = true;
    } finally {
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
    if (reflectionHint === "none" || operationJournalMutationContext.getStore() === true) {
      await persistStoreAfterMutation(store, reflectionHint, previousReflectionCount);
      if (resolvedQuestionsMutator || resultFinalizer) {
        const resolved = await loadResolvedQuestionsUnderBarrier();
        await resolvedQuestionsMutator?.(resolved, result);
        if (resolvedQuestionsMutator) await saveResolvedQuestions(resolved);
        resolvedForFinalizer = structuredClone(resolved);
        _resolvedQuestionsCache = {
          index: resolved,
          loadedAt: Date.now(),
          fingerprint: await fileFingerprint(RESOLVED_QUESTIONS_PATH),
        };
      }
    } else {
      const resolved = await loadResolvedQuestionsUnderBarrier();
      resolvedForFinalizer = structuredClone(resolved);
      await resolvedQuestionsMutator?.(resolved, result);
      prepareStoreIndexContent(store, true);
      const serialized = serializeReflectionResources(store, resolved as Record<string, unknown>);
      await commitResourceTransaction("reflection_mutation", [
        { name: "reflections", after: serialized.reflections },
        { name: "store_index", after: serialized.store_index },
        { name: "resolved_questions", after: serialized.resolved_questions },
      ], {
        reflection_ids: store.reflections.slice(Math.max(0, previousReflectionCount - (reflectionHint === "rewrite" ? store.reflections.length : 0)))
          .slice(0, 256).map((item) => item.id),
        result_hash: operationResultHash(result),
      }, reservation);
      _resolvedQuestionsCache = {
        index: resolved,
        loadedAt: Date.now(),
        fingerprint: await fileFingerprint(RESOLVED_QUESTIONS_PATH),
      };
    }
    // Commit the working clone only after persistence succeeds
    _mutationStore = store;
    storeCache = await refreshStoreCacheAfterMutation(store, reflectionHint, previousReflectionCount, storeCache);
    seenReflectionRecoveryGeneration = operationRecoveryGeneration();
    if (resultFinalizer) {
      await runAuthorityReadHookForTest("before_mutation_result_finalize");
      result = await resultFinalizer(result, resolvedForFinalizer ?? {});
    }
    return committedReceipt && idempotency
      ? idempotency.decorate(result, committedReceipt, false)
      : result;
  });
  const run = mutationQueue.then(() => operationJournalMutationContext.getStore() === true
    ? execute()
    : withOperationJournalBarrier(execute));

  mutationQueue = run.then(() => undefined, (error) => {
    // Approval-queued events are normal control flow, not storage faults
    if (error instanceof Error && (error as any).isPendingApproval === true) {
      return;
    }
    console.error("[hermes] storage error:", error instanceof Error ? error.message : String(error));
    _mutationStore = null;
    invalidateStoreCache();
  });
  return run;
}

export async function requireWriteApproval(
  operationName: string,
  operationPayload: Record<string, unknown>,
): Promise<void> {
  const execute = () => withFileLock(STORE_PATH, async () => {
    _mutationStore = await loadStore();
    if (_mutationStore.metadata?.write_approval !== true) return;

    const store = _mutationStore;
    const metadata = store.metadata!;
    const pendingId = randomUUID();
    const pendingMutation: PendingMutation = {
      id: pendingId,
      created_at: new Date().toISOString(),
      operation: operationName,
      preview: `Queued ${operationName} pending approval`,
      payload: operationPayload,
    };
    metadata.pending_mutations = [...(metadata.pending_mutations ?? []), pendingMutation];
    _storeIndexDirty = true;
    await persistStoreAfterMutation(store, "none", store.reflections.length);
    storeCache = await refreshStoreCacheAfterMutation(store, "none", store.reflections.length, storeCache);
    const approvalError = new Error(
      `Operation "${operationName}" was queued for approval (pending_mutation_id: ${pendingId}). ` +
      "Use approve_pending_mutation to approve or reject.",
    ) as Error & { isPendingApproval: boolean; pendingMutationId: string };
    approvalError.isPendingApproval = true;
    approvalError.pendingMutationId = pendingId;
    throw approvalError;
  });
  const run = mutationQueue.then(() => operationJournalMutationContext.getStore() === true
    ? execute()
    : withOperationJournalBarrier(execute));

  mutationQueue = run.then(() => undefined, (error) => {
    if (error instanceof Error && (error as Error & { isPendingApproval?: boolean }).isPendingApproval === true) return;
    console.error("[hermes] storage approval preflight error:", error instanceof Error ? error.message : String(error));
    _mutationStore = null;
    invalidateStoreCache();
  });
  return run;
}

export async function withOperationJournalStoreMutation<T>(callback: () => Promise<T>): Promise<T> {
  return operationJournalMutationContext.run(true, callback);
}

/** Narrow module-level recovery seam; not registered as an MCP tool. */
export async function recoverReflectionTransactionsForTest(): Promise<void> {
  await recoverPendingOperation();
  invalidateStoreCache();
}

export async function withStoreSnapshotBarrier<T>(callback: () => Promise<T>): Promise<T> {
  return withOperationJournalBarrier(() => withFileLock(STORE_PATH, callback));
}

function ensureSession(store: ReflectionStore, sessionId: string, startedAt?: string): Session {
  let session = getOwnSession(store.sessions, sessionId);
  const normalizedStartedAt = normalizeIsoTimestamp(startedAt, new Date().toISOString());
  if (!session) {
    session = {
      id: sessionId,
      started_at: normalizedStartedAt,
      reflection_count: 0,
      affordance_gap_count: 0,
    };
    setOwnSession(store.sessions, sessionId, session);
  } else if (normalizedStartedAt < session.started_at) {
    session.started_at = normalizedStartedAt;
  }
  return session;
}

function reconcileSessionCounters(store: ReflectionStore, createMissing: boolean): void {
  for (const session of Object.values(store.sessions)) {
    session.reflection_count = 0;
    session.affordance_gap_count = 0;
  }
  for (const reflection of store.reflections) {
    const session = getOwnSession(store.sessions, reflection.session_id)
      ?? (createMissing ? ensureSession(store, reflection.session_id, reflection.timestamp) : undefined);
    if (session) {
      if (reflection.timestamp < session.started_at) session.started_at = reflection.timestamp;
      session.reflection_count++;
    }
  }
  for (const gap of store.affordance_gaps) {
    const session = getOwnSession(store.sessions, gap.session_id)
      ?? (createMissing ? ensureSession(store, gap.session_id, gap.timestamp) : undefined);
    if (session) {
      if (gap.timestamp < session.started_at) session.started_at = gap.timestamp;
      session.affordance_gap_count++;
    }
  }
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
  getOrBuildAffordanceGapByIdIndex(store).set(newGap.id, newGap);
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

export async function upsertAffordanceGap(gap: AffordanceGap, operationName?: string): Promise<AffordanceGap> {
  return mutateStore((store) => {
    const { gap: saved, isNew } = upsertAffordanceGapMut(store, gap);
    if (isNew) {
      const session = ensureSession(store, gap.session_id);
      session.affordance_gap_count++;
    }
    return { ...saved, available_tools: [...saved.available_tools] };
  }, "none", operationName, { gap });
}

export type HeuristicInput = Omit<
  Heuristic,
  "id" | "created_at" | "updated_at" | "reinforcement_count" | "contradiction_count" | "contradiction_notes" | "retrieval_count" | "last_retrieved_at" | "supersedes" | "superseded_by" | "version" | "scope" | "evidence" | "feedback"
> & Partial<Pick<Heuristic, "scope" | "evidence" | "feedback">>;

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

// Write-lifetime affordance-gap by-id cache: keyed by ReflectionStore instance,
// maps AffordanceGap id to the AffordanceGap entry. Survives across
// upsertAffordanceGapMut calls within a single mutateStore write-lifetime.
// Invalidated alongside _heuristicDedupCache in the mutateStore finally block.
const _affordanceGapByIdCache = new WeakMap<ReflectionStore, Map<string, AffordanceGap>>();

// Write-lifetime heuristic search-text cache: keyed by ReflectionStore instance,
// maps heuristic id to precomputed search text. Invalidated alongside
// _heuristicDedupCache in the mutateStore finally block.
const _heuristicSearchTextCache = new WeakMap<ReflectionStore, Map<string, string>>();

// Write-lifetime heuristic tag cache for mutating retrieval paths.
const _heuristicTagSetCache = new WeakMap<ReflectionStore, Map<string, Set<string>>>();

// Write-lifetime heuristic by-id cache: keyed by ReflectionStore instance, maps
// heuristic id to the Heuristic object. Survives across mutating calls within a
// single mutateStore write-lifetime. Invalidated alongside _heuristicDedupCache
// in the mutateStore finally block.
const _heuristicByIdCache = new WeakMap<ReflectionStore, Map<string, Heuristic>>();

function getOrBuildHeuristicByIdMap(store: ReflectionStore): Map<string, Heuristic> {
  let map = _heuristicByIdCache.get(store);
  if (map) return map;
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
const _reflectionByIdCache = new WeakMap<ReflectionStore, Map<string, ReflectionFrame>>();

function getOrBuildReflectionByIdMap(store: ReflectionStore): Map<string, ReflectionFrame> {
  let map = _reflectionByIdCache.get(store);
  if (map) return map;
  map = new Map();
  for (const r of store.reflections) {
    map.set(r.id, r);
  }
  _reflectionByIdCache.set(store, map);
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

function getOrBuildAffordanceGapByIdIndex(store: ReflectionStore): Map<string, AffordanceGap> {
  let map = _affordanceGapByIdCache.get(store);
  if (map) return map;
  map = new Map();
  for (const gap of store.affordance_gaps) {
    map.set(gap.id, gap);
  }
  _affordanceGapByIdCache.set(store, map);
  return map;
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
  const now = new Date().toISOString();
  const incomingEvidence = input.evidence ?? [{
    id: evidenceId(input.source_task, input.heuristic),
    source_task: input.source_task,
    content_hash: lessonContentHash(input.heuristic),
    created_at: now,
  }];

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
    if (entry.ref.scope !== (input.scope ?? "global")) continue;

    const dedupSimilarity = Math.max(
      similarity(entry.ref.heuristic, input.heuristic),
      similarity(input.heuristic, entry.ref.heuristic),
    );
    if (dedupSimilarity > HEURISTIC_DEDUP_THRESHOLD) {
      existing = entry.ref;
      break;
    }
  }

  if (existing) {
    const evidenceIds = new Set(existing.evidence.map((item) => item.id));
    let newEvidenceCount = 0;
    for (const item of incomingEvidence) {
      if (!evidenceIds.has(item.id)) {
        existing.evidence.push(item);
        evidenceIds.add(item.id);
        newEvidenceCount += 1;
      }
    }
    if (newEvidenceCount > 0) {
      existing.reinforcement_count += newEvidenceCount;
      existing.confidence = Math.min(1.0, existing.confidence + 0.05 * newEvidenceCount);
    }
    let tagsChanged = false;
    if (input.tags && input.tags.length > 0) {
      const existingTagSet = new Set(existing.tags.map((t) => t.toLowerCase().trim()));
      for (const tag of input.tags) {
        const normalizedTag = tag.toLowerCase().trim();
        if (normalizedTag && !existingTagSet.has(normalizedTag)) {
          existing.tags.push(tag);
          existingTagSet.add(normalizedTag);
          tagsChanged = true;
        }
      }
    }
    if (newEvidenceCount > 0 || tagsChanged) {
      existing.updated_at = now;
      markSkillPromotionDirtyMut(store, existing.scope);
    }
    return existing;
  }

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
    scope: input.scope ?? "global",
    evidence: incomingEvidence,
    feedback: input.feedback ?? [],
    confidence: input.confidence ?? 0.6,
    tags: input.tags ?? [],
  };
  store.heuristics.push(heuristic);
  markSkillPromotionDirtyMut(store, heuristic.scope);

  // Register new heuristic in the dedup cache so subsequent calls in the same
  // write-lifetime see it without a full cache rebuild.
  domainEntries.push({ id: heuristic.id, tokens: inputTokens, ref: heuristic });
  cache.set(domain, domainEntries);

  return heuristic;
}

type MemoryBoardWriteResult = {
  success: boolean;
  entries?: MemoryEntry[];
  used_chars?: number;
  char_limit?: number;
  overflow_chars?: number;
  current_entry_count?: number;
  suggestion?: string;
  error?: string;
  note?: string;
  operations_applied?: number;
  current_entries?: MemoryEntry[];
  consolidation_hints?: Array<{ entry_ids: string[]; reason: string; estimated_savings: number }>;
};

type MemoryBoardAction = "add" | "replace" | "remove";
type MemoryBoardOperation = {
  action: MemoryBoardAction;
  content?: string;
  old_text?: string;
};

function computeMemoryBoardUsedChars(entries: MemoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.content.length, 0);
}

function computeConsolidationHints(
  entries: MemoryEntry[],
): Array<{ entry_ids: string[]; reason: string; estimated_savings: number }> {
  const hints: Array<{ entry_ids: string[]; reason: string; estimated_savings: number }> = [];
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

function findMemoryBoardMatches(entries: MemoryEntry[], oldText: string): MemoryEntry[] {
  return entries.filter((entry) => entry.content.includes(oldText));
}

function applyMemoryBoardOperation(
  board: MemoryBoard,
  operation: MemoryBoardOperation,
): { success: true; note?: string } | { success: false; result: MemoryBoardWriteResult } {
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

export async function memoryBoardWrite(
  action: "add" | "replace" | "remove",
  content?: string,
  oldText?: string,
  operationName?: string,
): Promise<MemoryBoardWriteResult> {
  return structuredClone(await mutateStore((store) => {
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
      if (!oldText) return { success: false, error: "replace requires old_text", entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
      const matches = findMemoryBoardMatches(board.entries, oldText);
      if (matches.length === 0) return { success: false, error: `No entry matches old_text: "${oldText}"`, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
      if (matches.length > 1) return { success: false, error: `old_text "${oldText}" matches ${matches.length} entries; use a more specific substring`, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
      const match = matches[0];
      if (board.entries.some((entry) => entry.id !== match.id && entry.content === newContent)) {
        return {
          success: true,
          note: "no duplicate added (content already exists)",
          entries: board.entries,
          used_chars: board.used_chars,
          char_limit: board.char_limit,
        };
      }
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
      if (!oldText) return { success: false, error: "remove requires old_text", entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
      const matches = findMemoryBoardMatches(board.entries, oldText);
      if (matches.length === 0) return { success: false, error: `No entry matches old_text: "${oldText}"`, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
      if (matches.length > 1) return { success: false, error: `old_text "${oldText}" matches ${matches.length} entries; use a more specific substring`, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
      const match = matches[0];
      board.entries = board.entries.filter((entry) => entry.id !== match.id);
      board.used_chars = computeMemoryBoardUsedChars(board.entries);
      return { success: true, entries: board.entries, used_chars: board.used_chars, char_limit: board.char_limit };
    }

    throw new Error(`Unsupported memory board action: ${action}`);
  }, "none", operationName, { action, content, old_text: oldText }));
}

export async function memoryBoardBatchWrite(
  operations: MemoryBoardOperation[],
  operationName?: string,
): Promise<MemoryBoardWriteResult> {
  return structuredClone(await mutateStore((store) => {
    const current = store.memory_board ?? normalizeMemoryBoard(undefined);
    const working: MemoryBoard = {
      entries: current.entries.map((entry) => ({ ...entry })),
      char_limit: current.char_limit,
      used_chars: computeMemoryBoardUsedChars(current.entries),
    };
    const notes: string[] = [];

    for (const operation of operations) {
      const applied = applyMemoryBoardOperation(working, operation);
      if (!applied.success) {
        return {
          ...applied.result,
          current_entries: current.entries,
          current_entry_count: current.entries.length,  // I6-fix: override with original count for consistency
          used_chars: computeMemoryBoardUsedChars(current.entries),
          char_limit: current.char_limit,
        };
      }
      if (applied.note) notes.push(applied.note);
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
  }));
}

export async function memoryBoardRead(): Promise<string> {
  const cache = await getCachedStoreEntry();
  const board = cache.store.memory_board ?? normalizeMemoryBoard(undefined);
  const usedChars = computeMemoryBoardUsedChars(board.entries);
  const pct = board.char_limit > 0 ? Math.round((usedChars / board.char_limit) * 100) : 0;
  const header = [
    "==============================",
    `MEMORY BOARD [${pct}% - ${usedChars}/${board.char_limit} chars]`,
    "==============================",
  ].join("\n");
  if (board.entries.length === 0) return `${header}\n(empty)`;
  return `${header}\n${board.entries.map((entry) => safeHeuristicText(entry.content)).join("\n§\n")}`;
}

export async function userProfileWrite(
  action: MemoryBoardAction,
  content?: string,
  oldText?: string,
  operationName?: string,
): Promise<MemoryBoardWriteResult> {
  return structuredClone(await mutateStore((store) => {
    const profile = store.user_profile ?? normalizeMemoryBoard(undefined, 1800);
    store.user_profile = profile;
    profile.used_chars = computeMemoryBoardUsedChars(profile.entries);
    const result = applyMemoryBoardOperation(profile, { action, content, old_text: oldText });
    if (!result.success) return result.result;
    return {
      success: true,
      entries: profile.entries,
      used_chars: profile.used_chars,
      char_limit: profile.char_limit,
      note: result.note,
    };
  }, "none", operationName, { action, content, old_text: oldText }));
}

export async function userProfileBatchWrite(
  operations: MemoryBoardOperation[],
  operationName?: string,
): Promise<MemoryBoardWriteResult> {
  return structuredClone(await mutateStore((store) => {
    const current = store.user_profile ?? normalizeMemoryBoard(undefined, 1800);
    const working: MemoryBoard = {
      entries: current.entries.map((entry) => ({ ...entry })),
      char_limit: current.char_limit,
      used_chars: computeMemoryBoardUsedChars(current.entries),
    };
    const notes: string[] = [];

    for (const operation of operations) {
      const applied = applyMemoryBoardOperation(working, operation);
      if (!applied.success) {
        return {
          ...applied.result,
          current_entries: current.entries,
          current_entry_count: current.entries.length,  // I6-fix: override with original count for consistency
          used_chars: computeMemoryBoardUsedChars(current.entries),
          char_limit: current.char_limit,
        };
      }
      if (applied.note) notes.push(applied.note);
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
  }));
}

export async function userProfileRead(): Promise<string> {
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
  if (profile.entries.length === 0) return `${header}\n(empty)`;
  return `${header}\n${profile.entries.map((entry) => safeHeuristicText(entry.content)).join("\n§\n")}`;
}

export interface RawMemoryStores {
  memory_board: MemoryBoard;
  user_profile: MemoryBoard;
}

export async function getRawMemoryStores(): Promise<RawMemoryStores> {
  await mutationQueue;
  const cache = await getCachedStoreEntry();
  return {
    memory_board: structuredClone(cache.store.memory_board ?? normalizeMemoryBoard(undefined)),
    user_profile: structuredClone(cache.store.user_profile ?? normalizeMemoryBoard(undefined, 1800)),
  };
}

type ReviewCandidateDraft = Omit<ReviewCandidate, "created_at" | "state" | "mutation_id" | "evidence_fingerprint">
  & Partial<Pick<ReviewCandidate, "evidence_fingerprint">>;

export function pendingMutationPayloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeStable(payload)), "utf8").digest("hex");
}

function reviewCandidateContentHash(candidate: Pick<ReviewCandidate,
  "id" | "scope" | "stage" | "source_fingerprint" | "evidence_fingerprint" | "source_reflection_ids" | "heuristic" | "domain" | "tags" | "confidence" | "risk_reasons"
>): string {
  return pendingMutationPayloadHash({
    id: candidate.id,
    scope: candidate.scope,
    stage: candidate.stage,
    source_fingerprint: candidate.source_fingerprint,
    evidence_fingerprint: candidate.evidence_fingerprint,
    source_reflection_ids: candidate.source_reflection_ids,
    heuristic: candidate.heuristic,
    domain: candidate.domain,
    tags: candidate.tags,
    confidence: candidate.confidence,
    risk_reasons: candidate.risk_reasons,
  });
}

function evidenceText(value: string): string {
  return redactSensitiveText(value, { strictHistorical: true }).trim();
}

/** Candidate-specific authoritative source projection used at generation and locked apply. */
export function reviewCandidateEvidenceFingerprint(
  reflections: ReflectionFrame[],
  sourceReflectionIds: string[],
): string {
  const byId = new Map(reflections.map((reflection) => [reflection.id, reflection]));
  const projection = sourceReflectionIds.map((id) => {
    const reflection = byId.get(id);
    if (!reflection) return { id, missing: true };
    return {
      id: reflection.id,
      scope: reflection.scope,
      outcome: reflection.task_outcome,
      task_goal: evidenceText(reflection.task_goal),
      summary: evidenceText(reflection.task_state.summary),
      summary_sections: (reflection.task_state.summary_sections ?? []).map((section) => ({
        title: evidenceText(section.title),
        content: evidenceText(section.content),
      })),
      blockers: reflection.task_state.immediate_blockers.map(evidenceText),
      lessons: reflection.lessons_learned.map(evidenceText),
      open_questions: reflection.open_questions
        .filter((question) => !question.resolved)
        .map((question) => evidenceText(question.question)),
    };
  });
  return pendingMutationPayloadHash({ source_reflection_ids: sourceReflectionIds, projection });
}

function fingerprintsEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function requireReviewCandidateDraft(draft: ReviewCandidateDraft): ReviewCandidateDraft & Pick<ReviewCandidate, "evidence_fingerprint"> {
  const probe = normalizeReviewCandidate({
    ...draft,
    created_at: new Date().toISOString(),
    state: "pending",
    mutation_id: randomUUID(),
    evidence_fingerprint: draft.evidence_fingerprint ?? "0".repeat(64),
  }, new Date().toISOString());
  if (!probe) throw new Error(`Invalid review candidate: ${draft.id}`);
  return {
    id: probe.id,
    scope: probe.scope,
    stage: probe.stage,
    source_fingerprint: probe.source_fingerprint,
    evidence_fingerprint: probe.evidence_fingerprint,
    source_reflection_ids: probe.source_reflection_ids,
    heuristic: probe.heuristic,
    domain: probe.domain,
    tags: probe.tags,
    confidence: probe.confidence,
    risk_reasons: probe.risk_reasons,
  };
}

/** Persist candidates and their approval mutations in one locked store write. */
export async function enqueueReviewCandidateRecords(drafts: ReviewCandidateDraft[]): Promise<ReviewCandidate[]> {
  if (drafts.length > MAX_REVIEW_CANDIDATES_PER_BATCH) {
    throw new Error(`Review candidate batch exceeds ${MAX_REVIEW_CANDIDATES_PER_BATCH}`);
  }
  return mutateStore((store) => {
    const metadata = store.metadata;
    if (!metadata) throw new Error("Store metadata is unavailable");
    const candidates = metadata.review_candidates ?? [];
    const pending = metadata.pending_mutations ?? [];
    const saved: ReviewCandidate[] = [];
    const validated = drafts.map((draft) => requireReviewCandidateDraft({
      ...draft,
      evidence_fingerprint: draft.evidence_fingerprint
        ?? reviewCandidateEvidenceFingerprint(store.reflections, draft.source_reflection_ids),
    }));
    for (const draft of validated) {
      const existing = candidates.find((candidate) => candidate.id === draft.id);
      if (existing) {
        if (reviewCandidateContentHash(existing) !== reviewCandidateContentHash(draft)) {
          throw new Error(`Review candidate id collision: ${draft.id}`);
        }
        if (existing.state === "pending"
          && (!existing.mutation_id || !pending.some((mutation) => mutation.id === existing.mutation_id))) {
          throw new Error(`Review candidate ${draft.id} has no matching pending mutation`);
        }
        saved.push(structuredClone(existing));
        continue;
      }
      const pendingForScope = candidates.filter((candidate) => candidate.scope === draft.scope && candidate.state === "pending").length;
      if (pendingForScope >= REVIEW_CANDIDATE_PENDING_PER_SCOPE_MAX) {
        throw new Error(`Pending review candidate limit reached for ${draft.scope}`);
      }
      const mutationId = randomUUID();
      const candidate: ReviewCandidate = {
        ...draft,
        created_at: new Date().toISOString(),
        state: "pending",
        mutation_id: mutationId,
      };
      const payload = {
        candidate_id: candidate.id,
        candidate_hash: reviewCandidateContentHash(candidate),
        evidence_fingerprint: candidate.evidence_fingerprint,
      };
      candidates.push(candidate);
      pending.push({
        id: mutationId,
        created_at: candidate.created_at,
        operation: "apply_review_candidate",
        preview: `Apply review candidate ${candidate.id}`,
        payload,
        payload_hash: pendingMutationPayloadHash(payload),
        state: "pending",
      });
      saved.push(structuredClone(candidate));
    }
    metadata.review_candidates = boundReviewCandidateAudit(candidates);
    metadata.pending_mutations = pending;
    return saved;
  }, "none");
}

const MAX_REVIEW_CANDIDATES_PER_BATCH = 50;

export async function listReviewCandidateRecords(scope?: MemoryScope): Promise<ReviewCandidate[]> {
  await mutationQueue;
  const store = await getCachedStore();
  return structuredClone((store.metadata?.review_candidates ?? [])
    .filter((candidate) => !scope || candidate.scope === scope));
}

export async function getReviewCandidateRecord(id: string): Promise<ReviewCandidate | null> {
  const candidates = await listReviewCandidateRecords();
  return candidates.find((candidate) => candidate.id === id) ?? null;
}

export async function reviewCandidateIdsExist(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const candidates = await listReviewCandidateRecords();
  const known = new Set(candidates.map((candidate) => candidate.id));
  return ids.every((id) => known.has(id));
}

export async function validateReviewCandidateMutation(mutation: PendingMutation): Promise<ReviewCandidate> {
  if (mutation.operation !== "apply_review_candidate" || !mutation.payload || !mutation.payload_hash) {
    throw new Error(`Pending mutation ${mutation.id} is not a review candidate mutation`);
  }
  if (pendingMutationPayloadHash(mutation.payload) !== mutation.payload_hash) {
    throw new Error(`Pending mutation ${mutation.id} payload hash mismatch`);
  }
  const candidateId = mutation.payload.candidate_id;
  const candidateHash = mutation.payload.candidate_hash;
  const evidenceFingerprint = mutation.payload.evidence_fingerprint;
  if (typeof candidateId !== "string" || typeof candidateHash !== "string" || typeof evidenceFingerprint !== "string") {
    throw new Error(`Pending mutation ${mutation.id} has an invalid review candidate payload`);
  }
  const candidate = await getReviewCandidateRecord(candidateId);
  if (!candidate || candidate.state !== "pending" || candidate.mutation_id !== mutation.id) {
    throw new Error(`Review candidate ${candidateId} is missing, finalized, or linked to another mutation`);
  }
  if (reviewCandidateContentHash(candidate) !== candidateHash) {
    throw new Error(`Review candidate ${candidateId} content hash mismatch`);
  }
  if (!fingerprintsEqual(candidate.evidence_fingerprint, evidenceFingerprint)) {
    throw new Error(`Review candidate ${candidateId} evidence fingerprint mismatch`);
  }
  return candidate;
}

/**
 * Revalidate a claimed review candidate against the current authoritative
 * reflection set, apply it, and finalize the queue item in one store write.
 * This is the final scope/evidence boundary; provider output and earlier
 * engine validation are never treated as persistent authority.
 */
export async function applyClaimedReviewCandidateMutation(
  mutationId: string,
  claimToken: string,
): Promise<{ candidate: ReviewCandidate; heuristic: Heuristic } | null> {
  return mutateStore((store) => {
    const metadata = store.metadata;
    if (!metadata) return null;
    const pending = metadata.pending_mutations ?? [];
    const mutationIndex = pending.findIndex((item) => item.id === mutationId
      && item.operation === "apply_review_candidate"
      && item.state === "processing"
      && item.claim_token === claimToken);
    if (mutationIndex < 0) return null;
    const mutation = pending[mutationIndex];
    if (!mutation.payload || !mutation.payload_hash
      || pendingMutationPayloadHash(mutation.payload) !== mutation.payload_hash) {
      throw new Error(`Pending mutation ${mutationId} payload hash mismatch`);
    }
    const candidateId = mutation.payload.candidate_id;
    const candidateHash = mutation.payload.candidate_hash;
    const evidenceFingerprint = mutation.payload.evidence_fingerprint;
    const candidates = metadata.review_candidates ?? [];
    const candidateIndex = candidates.findIndex((item) => item.id === candidateId
      && item.state === "pending" && item.mutation_id === mutationId);
    const candidate = candidateIndex >= 0 ? candidates[candidateIndex] : undefined;
    if (!candidate || typeof candidateHash !== "string" || typeof evidenceFingerprint !== "string"
      || reviewCandidateContentHash(candidate) !== candidateHash) {
      throw new Error(`Review candidate ${String(candidateId)} content hash mismatch`);
    }

    const sourceIds = candidate.source_reflection_ids;
    const uniqueSourceIds = [...new Set(sourceIds)];
    if (sourceIds.length === 0 || uniqueSourceIds.length !== sourceIds.length) {
      throw new Error(`Review candidate ${candidate.id} has missing or duplicate evidence`);
    }
    const reflections = uniqueSourceIds.map((id) => store.reflections.find((item) => item.id === id));
    if (reflections.some((item) => !item || item.scope !== candidate.scope)) {
      throw new Error(`Review candidate ${candidate.id} evidence is missing or outside its scope`);
    }
    if (!reflections.some((item) => item?.task_outcome === "success")) {
      throw new Error(`Review candidate ${candidate.id} has no exact-scope successful evidence`);
    }
    const currentEvidenceFingerprint = reviewCandidateEvidenceFingerprint(
      reflections.filter((item): item is ReflectionFrame => item !== undefined),
      sourceIds,
    );
    if (!fingerprintsEqual(candidate.evidence_fingerprint, evidenceFingerprint)
      || !fingerprintsEqual(candidate.evidence_fingerprint, currentEvidenceFingerprint)) {
      throw new Error(`Review candidate ${candidate.id} evidence fingerprint mismatch`);
    }

    const sourceTask = `${candidate.stage}_background_review:${candidate.source_fingerprint.slice(0, 12)}`;
    const heuristic = upsertHeuristicMut(store, {
      scope: candidate.scope,
      domain: candidate.domain,
      heuristic: candidate.heuristic,
      source_task: sourceTask,
      confidence: candidate.confidence,
      tags: candidate.tags,
      evidence: uniqueSourceIds.map((sourceReflectionId) => ({
        id: evidenceId(`${sourceTask}:${sourceReflectionId}`, candidate.heuristic),
        source_reflection_id: sourceReflectionId,
        source_task: sourceTask,
        content_hash: lessonContentHash(candidate.heuristic),
        created_at: candidate.created_at,
      })),
    });
    if (store.heuristics.length > HEURISTIC_MAX_COUNT) pruneHeuristicsMut(store);

    pending.splice(mutationIndex, 1);
    const finalized: ReviewCandidate = { ...candidate, state: "applied" };
    candidates.splice(candidateIndex, 1);
    candidates.push(finalized);
    metadata.pending_mutations = pending;
    metadata.review_candidates = boundReviewCandidateAudit(candidates);
    return {
      candidate: structuredClone(finalized),
      heuristic: sanitizeHeuristicForOutput(heuristic),
    };
  }, "none");
}

export async function completeReviewCandidateMutation(
  mutationId: string,
  claimToken: string,
): Promise<ReviewCandidate | null> {
  return mutateStore((store) => {
    const metadata = store.metadata;
    if (!metadata) return null;
    const pending = metadata.pending_mutations ?? [];
    const index = pending.findIndex((item) => item.id === mutationId
      && item.operation === "apply_review_candidate"
      && item.state === "processing" && item.claim_token === claimToken);
    const candidates = metadata.review_candidates ?? [];
    // v21 replay applies and finalizes atomically. Keep this completion call
    // idempotent for the existing public approval workflow.
    if (index < 0) {
      const finalized = candidates.find((item) => item.mutation_id === mutationId && item.state === "applied");
      return finalized ? structuredClone(finalized) : null;
    }
    const candidateIndex = candidates.findIndex((item) => item.mutation_id === mutationId && item.state === "pending");
    const candidate = candidateIndex >= 0 ? candidates[candidateIndex] : undefined;
    if (!candidate) return null;
    pending.splice(index, 1);
    const finalized: ReviewCandidate = { ...candidate, state: "applied" };
    candidates.splice(candidateIndex, 1);
    candidates.push(finalized);
    metadata.pending_mutations = pending;
    metadata.review_candidates = boundReviewCandidateAudit(candidates);
    return structuredClone(finalized);
  }, "none");
}

export async function rejectReviewCandidateMutation(mutationId: string): Promise<ReviewCandidate | null> {
  return mutateStore((store) => {
    const metadata = store.metadata;
    if (!metadata) return null;
    const pending = metadata.pending_mutations ?? [];
    const index = pending.findIndex((mutation) => mutation.id === mutationId
      && mutation.operation === "apply_review_candidate"
      && ((mutation.state ?? "pending") === "pending" || isPendingClaimStale(mutation)));
    if (index < 0) return null;
    const candidates = metadata.review_candidates ?? [];
    const candidateIndex = candidates.findIndex((item) => item.mutation_id === mutationId && item.state === "pending");
    const candidate = candidateIndex >= 0 ? candidates[candidateIndex] : undefined;
    if (!candidate) return null;
    pending.splice(index, 1);
    const finalized: ReviewCandidate = { ...candidate, state: "rejected" };
    candidates.splice(candidateIndex, 1);
    candidates.push(finalized);
    metadata.pending_mutations = pending;
    metadata.review_candidates = boundReviewCandidateAudit(candidates);
    return structuredClone(finalized);
  }, "none");
}

export async function reviewCandidateCounts(scope?: MemoryScope): Promise<{ pending: number; applied: number; rejected: number }> {
  const candidates = await listReviewCandidateRecords(scope);
  return {
    pending: candidates.filter((candidate) => candidate.state === "pending").length,
    applied: candidates.filter((candidate) => candidate.state === "applied").length,
    rejected: candidates.filter((candidate) => candidate.state === "rejected").length,
  };
}

export type SkillCandidateDraft = Omit<CreateSkillPromotionCandidateInput, "id" | "mutation_id">;

function sortedUnique(values: readonly string[]): string[] {
  return stableUniqueSorted(values);
}

export function skillReflectionContentHash(reflection: ReflectionFrame): string {
  return pendingMutationPayloadHash(reflection as unknown as Record<string, unknown>);
}

export function skillPromotionEvidenceFingerprint(
  snapshot: PromotionSnapshot,
  sourceHeuristicIds: string[],
  sourceReflectionIds: string[],
): string {
  const heuristicById = new Map(snapshot.heuristics.map((heuristic) => [heuristic.id, heuristic]));
  const reflectionById = new Map(snapshot.reflections.map((reflection) => [reflection.id, reflection]));
  const heuristics = sortedUnique(sourceHeuristicIds).map((id) => {
    const heuristic = heuristicById.get(id);
    if (!heuristic) return { id, missing: true };
    return {
      id: heuristic.id,
      scope: heuristic.scope,
      version: heuristic.version,
      domain: heuristic.domain,
      heuristic: heuristic.heuristic,
      source_task: heuristic.source_task,
      evidence: [...heuristic.evidence].sort((left, right) => compareStableText(left.id, right.id)),
      feedback: [...heuristic.feedback].sort((left, right) =>
        compareStableText(left.reflection_id, right.reflection_id) || compareStableText(left.value, right.value)),
      reinforcement_count: heuristic.reinforcement_count,
      contradiction_count: heuristic.contradiction_count,
      contradiction_notes: heuristic.contradiction_notes,
      confidence: heuristic.confidence,
      supersedes: sortedUnique(heuristic.supersedes ?? []),
      superseded_by: heuristic.superseded_by,
      tags: sortedUnique(heuristic.tags),
    };
  });
  const reflections = sortedUnique(sourceReflectionIds).map((id) => {
    const reflection = reflectionById.get(id);
    return reflection ? { id, content_hash: skillReflectionContentHash(reflection) } : { id, missing: true };
  });
  return pendingMutationPayloadHash({
    scope: snapshot.scope,
    source_heuristic_ids: sortedUnique(sourceHeuristicIds),
    source_reflection_ids: sortedUnique(sourceReflectionIds),
    heuristics,
    reflections,
  });
}

function skillCandidateMutationPayload(candidate: SkillPromotionCandidate): Record<string, unknown> {
  return {
    candidate_id: candidate.id,
    candidate_fingerprint: candidate.fingerprint,
    evidence_fingerprint: candidate.evidence_fingerprint,
    scope: candidate.scope,
    action: candidate.action,
    target_skill_id: candidate.target_skill_id,
    expected_target_revision: candidate.expected_target_revision,
    proposed_revision_hash: candidate.proposed_revision.content_hash,
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = sortedUnique(left);
  const normalizedRight = sortedUnique(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((item, index) => item === normalizedRight[index]);
}

function sameSkillCandidateCluster(
  left: SkillPromotionCandidate,
  right: Pick<SkillPromotionCandidate,
    "scope" | "action" | "target_skill_id" | "source_heuristic_ids">,
): boolean {
  return left.scope === right.scope
    && left.action === right.action
    && left.target_skill_id === right.target_skill_id
    && sameStringSet(left.source_heuristic_ids, right.source_heuristic_ids);
}

function currentPromotionSnapshotMut(store: ReflectionStore, scope: MemoryScope): PromotionSnapshot {
  return {
    scope,
    heuristics: structuredClone(store.heuristics.filter((heuristic) => heuristic.scope === scope)),
    reflections: structuredClone(store.reflections.filter((reflection) => reflection.scope === scope)),
    skills: structuredClone((store.metadata?.skills ?? []).filter((skill) => skill.scope === scope)),
  };
}

function assertSkillCandidateEvidence(
  store: ReflectionStore,
  candidate: Pick<SkillPromotionCandidate,
    | "id"
    | "scope"
    | "source_heuristic_ids"
    | "source_reflection_ids"
    | "evidence_fingerprint"
    | "proposed_revision"
    | "cluster_algorithm"
    | "cluster_fingerprint"
    | "confidence">,
): { snapshot: PromotionSnapshot; cluster: PromotionCluster } {
  if (candidate.source_heuristic_ids.length !== new Set(candidate.source_heuristic_ids).size
      || candidate.source_reflection_ids.length !== new Set(candidate.source_reflection_ids).size) {
    throw new Error(`Skill candidate ${candidate.id} has duplicate evidence IDs`);
  }
  const snapshot = currentPromotionSnapshotMut(store, candidate.scope);
  const heuristicById = new Map(snapshot.heuristics.map((heuristic) => [heuristic.id, heuristic]));
  for (const id of candidate.source_heuristic_ids) {
    const heuristic = heuristicById.get(id);
    if (!heuristic || heuristic.superseded_by || heuristic.contradiction_count > 0
        || heuristic.feedback.some((item) => item.value === "harmful")) {
      throw new Error(`Skill candidate ${candidate.id} heuristic evidence is missing, unsafe, or stale`);
    }
  }
  const reflectionById = new Map(snapshot.reflections.map((reflection) => [reflection.id, reflection]));
  const provenanceById = new Map(candidate.proposed_revision.provenance.map((item) => [item.source_id, item]));
  if (provenanceById.size !== candidate.source_reflection_ids.length) {
    throw new Error(`Skill candidate ${candidate.id} provenance does not match source reflections`);
  }
  for (const id of candidate.source_reflection_ids) {
    const reflection = reflectionById.get(id);
    const provenance = provenanceById.get(id);
    if (!reflection || !provenance || provenance.source_type !== "reflection" || provenance.status !== "active"
        || !fingerprintsEqual(provenance.content_hash, skillReflectionContentHash(reflection))) {
      throw new Error(`Skill candidate ${candidate.id} reflection provenance is missing or stale`);
    }
  }
  const current = skillPromotionEvidenceFingerprint(
    snapshot,
    candidate.source_heuristic_ids,
    candidate.source_reflection_ids,
  );
  if (!fingerprintsEqual(candidate.evidence_fingerprint, current)) {
    throw new Error(`Skill candidate ${candidate.id} evidence fingerprint mismatch`);
  }
  const authoritativeCluster = buildPromotionClusters(snapshot).find((cluster) =>
    sameStringSet(cluster.heuristic_ids, candidate.source_heuristic_ids)
    && sameStringSet(cluster.reflection_ids, candidate.source_reflection_ids));
  if (candidate.cluster_algorithm !== SKILL_CLUSTER_ALGORITHM || !authoritativeCluster
      || !fingerprintsEqual(candidate.cluster_fingerprint, authoritativeCluster.fingerprint)
      || Math.abs(candidate.confidence - authoritativeCluster.confidence) > Number.EPSILON) {
    throw new Error(`Skill candidate ${candidate.id} cluster fingerprint is stale or invalid`);
  }
  return { snapshot, cluster: authoritativeCluster };
}

function appendSkillRevision(record: SkillRecord, revision: SkillRevision, updatedAt: string): SkillRecord {
  if (revision.revision !== record.current_revision + 1) {
    throw new Error(`Skill ${record.id} revision is not monotonic`);
  }
  const revisions = [...record.revisions, revision];
  const audit = [...record.compacted_revision_audit];
  while (revisions.length > 20) {
    const removed = revisions.shift();
    if (!removed) break;
    audit.push({
      revision: removed.revision,
      content_hash: removed.content_hash,
      origin_candidate_id: removed.origin_candidate_id,
      created_at: removed.created_at,
    });
  }
  const boundedAudit = audit.sort((left, right) => left.revision - right.revision).slice(-100);
  return SkillRecordSchema.parse({
    ...record,
    current_revision: revision.revision,
    revisions,
    compacted_revision_audit: boundedAudit,
    updated_at: updatedAt,
  });
}

function appliedSkillForCandidate(
  skills: readonly SkillRecord[],
  candidate: SkillPromotionCandidate,
): SkillRecord | undefined {
  if (candidate.action === "update" && candidate.target_skill_id) {
    return skills.find((skill) => skill.id === candidate.target_skill_id);
  }
  return skills.find((skill) => skill.revisions.some((revision) => revision.origin_candidate_id === candidate.id));
}

function skillProcedureContentFields(revision: SkillRevision): string[] {
  return [
    revision.title,
    revision.summary,
    ...revision.steps,
    revision.domain,
    ...revision.tags,
  ];
}

function hasUnsafeSkillProcedureContent(revision: SkillRevision): boolean {
  return skillProcedureContentFields(revision).some((value) =>
    firstThreatMessage(value, "strict") !== null
    || redactSensitiveText(value, { strictHistorical: true }) !== value);
}

function blockedSkillRevision(revision: SkillRevision): SkillRevision {
  const { content_hash: _contentHash, ...body } = revision;
  const safeBody: Omit<SkillRevision, "content_hash"> = {
    ...body,
    title: "Blocked promotion candidate",
    summary: "Procedure content was omitted by the pre-persistence safety gate.",
    steps: ["Create a new proposal from current authoritative evidence."],
    domain: "security-review",
    tags: ["blocked-candidate"],
  };
  return SkillRevisionSchema.parse({
    ...safeBody,
    content_hash: skillRevisionContentHash(safeBody),
  });
}

interface SkillCandidatePreflight {
  proposedRevision: SkillRevision;
  risk: SkillCandidateDraft["risk"];
  riskReasons: string[];
}

function preflightSkillCandidateDraft(
  store: ReflectionStore,
  draft: SkillCandidateDraft,
  candidateId: string,
): SkillCandidatePreflight {
  const classifications: string[] = [];
  const unsafe = hasUnsafeSkillProcedureContent(draft.proposed_revision);
  const proposedRevision = unsafe ? blockedSkillRevision(draft.proposed_revision) : draft.proposed_revision;
  if (unsafe) classifications.push("unsafe_or_sensitive_content");

  let authoritative: ReturnType<typeof assertSkillCandidateEvidence> | undefined;
  try {
    authoritative = assertSkillCandidateEvidence(store, {
      id: candidateId,
      scope: draft.scope,
      source_heuristic_ids: draft.source_heuristic_ids,
      source_reflection_ids: draft.source_reflection_ids,
      evidence_fingerprint: draft.evidence_fingerprint,
      proposed_revision: proposedRevision,
      cluster_algorithm: draft.cluster_algorithm,
      cluster_fingerprint: draft.cluster_fingerprint,
      confidence: draft.confidence,
    });
  } catch {
    classifications.push("stale_or_invalid_evidence");
  }
  if (authoritative) {
    if (!unsafe && !isPromotionProcedureGrounded(authoritative.cluster, proposedRevision)) {
      classifications.push("content_not_grounded_in_evidence");
    }
    const targetMatch = matchPromotionTarget(authoritative.cluster, authoritative.snapshot.skills);
    if (targetMatch.risk_reasons.length > 0) classifications.push("ambiguous_target_match");
    if (targetMatch.action !== draft.action
        || targetMatch.target_skill_id !== draft.target_skill_id
        || targetMatch.expected_target_revision !== draft.expected_target_revision) {
      classifications.push("stale_action_or_target_match");
    }
  }

  const prioritized = stableUniqueSorted(classifications);
  const existing = stableUniqueSorted(draft.risk_reasons)
    .filter((reason) => !prioritized.includes(reason));
  const riskReasons = [...prioritized, ...existing].slice(0, 50);
  return {
    proposedRevision,
    risk: classifications.length > 0 ? "high" : draft.risk,
    riskReasons,
  };
}

/** Persist skill candidates and approval mutations in one locked store write. */
export async function enqueueSkillCandidateRecords(
  drafts: SkillCandidateDraft[],
): Promise<SkillPromotionCandidate[]> {
  if (drafts.length > MAX_SKILL_CANDIDATES_PER_BATCH) {
    throw new SkillCandidateCapacityError(`Skill candidate batch exceeds ${MAX_SKILL_CANDIDATES_PER_BATCH}`);
  }
  return mutateStore((store) => {
    const metadata = store.metadata;
    if (!metadata) throw new Error("Store metadata is unavailable");
    const candidates = metadata.skill_candidates ?? [];
    const pending = metadata.pending_mutations ?? [];
    const saved: SkillPromotionCandidate[] = [];
    for (const draft of drafts) {
      const candidateId = draft.proposed_revision.origin_candidate_id;
      const preflight = preflightSkillCandidateDraft(store, draft, candidateId);
      const existingById = candidates.find((candidate) => candidate.id === candidateId);
      const existingMutationId = existingById?.mutation_id;
      const mutationId = existingMutationId ?? (preflight.risk !== "low" || preflight.riskReasons.length > 0
        ? undefined
        : randomUUID());
      const candidate = createSkillPromotionCandidate({
        ...draft,
        id: candidateId,
        proposed_revision: preflight.proposedRevision,
        risk: preflight.risk,
        risk_reasons: preflight.riskReasons,
        ...(mutationId ? { mutation_id: mutationId } : {}),
      });
      if (candidate.state === "pending") assertSkillCandidateEvidence(store, candidate);

      if (existingById) {
        if (existingById.fingerprint !== candidate.fingerprint) {
          throw new Error(`Skill candidate id collision: ${candidateId}`);
        }
        if ((existingById.state === "pending" || existingById.state === "approved")
            && (!existingMutationId || !pending.some((mutation) => mutation.id === existingMutationId))) {
          throw new Error(`Skill candidate ${candidateId} has no matching pending mutation`);
        }
        saved.push(structuredClone(existingById));
        continue;
      }

      const duplicate = candidates.find((item) => item.fingerprint === candidate.fingerprint);
      if (duplicate) {
        saved.push(structuredClone(duplicate));
        continue;
      }

      if (candidate.state === "pending") {
        const pendingForScope = candidates.filter((item) => item.scope === candidate.scope
          && (item.state === "pending" || item.state === "approved")).length;
        const superseded = candidates.filter((item) => item.state === "pending"
          && sameSkillCandidateCluster(item, candidate));
        if (pendingForScope - superseded.length >= SKILL_CANDIDATE_PENDING_PER_SCOPE_MAX) {
          throw new SkillCandidateCapacityError(`Pending skill candidate limit reached for ${candidate.scope}`);
        }
        const now = new Date().toISOString();
        for (const stale of superseded) {
          const index = candidates.findIndex((item) => item.id === stale.id);
          const finalized = transitionSkillPromotionCandidate(stale, "superseded", now, `superseded by ${candidate.id}`);
          candidates.splice(index, 1, finalized);
          if (stale.mutation_id) {
            const mutationIndex = pending.findIndex((mutation) => mutation.id === stale.mutation_id);
            if (mutationIndex >= 0) pending.splice(mutationIndex, 1);
          }
        }
        const payload = skillCandidateMutationPayload(candidate);
        pending.push({
          id: candidate.mutation_id!,
          created_at: candidate.created_at,
          operation: "apply_skill_candidate",
          preview: `Apply skill candidate ${candidate.id}`,
          payload,
          payload_hash: pendingMutationPayloadHash(payload),
          state: "pending",
        });
      }
      candidates.push(candidate);
      saved.push(structuredClone(candidate));
    }
    metadata.skill_candidates = boundSkillCandidateAudit(candidates, metadata.skills ?? []);
    metadata.pending_mutations = pending;
    return saved;
  }, "none");
}

export async function getSkillPromotionSnapshot(scope: MemoryScope): Promise<PromotionSnapshot> {
  await mutationQueue;
  const store = await getCachedStore();
  return currentPromotionSnapshotMut(store, scope);
}

export async function listSkillRecords(scope?: MemoryScope): Promise<SkillRecord[]> {
  await mutationQueue;
  const store = await getCachedStore();
  return structuredClone((store.metadata?.skills ?? []).filter((skill) => !scope || skill.scope === scope));
}

export async function getSkillRecord(id: string): Promise<SkillRecord | null> {
  const skills = await listSkillRecords();
  return skills.find((skill) => skill.id === id) ?? null;
}

export async function listSkillCandidateRecords(scope?: MemoryScope): Promise<SkillPromotionCandidate[]> {
  await mutationQueue;
  const store = await getCachedStore();
  return structuredClone((store.metadata?.skill_candidates ?? [])
    .filter((candidate) => !scope || candidate.scope === scope));
}

export async function getSkillCandidateRecord(id: string): Promise<SkillPromotionCandidate | null> {
  const candidates = await listSkillCandidateRecords();
  return candidates.find((candidate) => candidate.id === id) ?? null;
}

export async function skillCandidateIdsExist(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const candidates = await listSkillCandidateRecords();
  const known = new Set(candidates.map((candidate) => candidate.id));
  return ids.every((id) => known.has(id));
}

export async function dirtySkillPromotionScopes(): Promise<SkillPromotionDirtyScope[]> {
  await mutationQueue;
  const store = await getCachedStore();
  return structuredClone((store.metadata?.skill_promotion?.dirty_scopes ?? [])
    .filter(isSkillPromotionScopeDirty));
}

/** Bounded promotion lifecycle metadata for compact administrative status. */
export async function skillPromotionScopeStates(): Promise<SkillPromotionDirtyScope[]> {
  await mutationQueue;
  const store = await getCachedStore();
  return structuredClone(store.metadata?.skill_promotion?.dirty_scopes ?? []);
}

function reconcileStaleSkillCandidateMutationsMut(
  store: ReflectionStore,
  scope: MemoryScope,
): Set<string> {
  const metadata = store.metadata;
  if (!metadata) return new Set();
  const candidates = metadata.skill_candidates ?? [];
  const pending = metadata.pending_mutations ?? [];
  const invalidated = new Set<string>();
  const now = new Date().toISOString();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate.scope !== scope || (candidate.state !== "pending" && candidate.state !== "approved")) continue;
    const mutationIndex = pending.findIndex((mutation) => mutation.id === candidate.mutation_id
      && mutation.operation === "apply_skill_candidate");
    const mutation = mutationIndex >= 0 ? pending[mutationIndex] : undefined;
    let current = mutation !== undefined;
    if (mutation) {
      try {
        assertSkillMutationBinding(store, mutation, candidate);
      } catch {
        current = false;
      }
    }
    if (current) continue;
    candidates[index] = transitionSkillPromotionCandidate(
      candidate,
      "superseded",
      now,
      "authoritative promotion evidence, content, or target changed",
    );
    if (mutationIndex >= 0) pending.splice(mutationIndex, 1);
    invalidated.add(candidate.id);
  }
  metadata.skill_candidates = boundSkillCandidateAudit(candidates, metadata.skills ?? []);
  metadata.pending_mutations = pending;
  return invalidated;
}

export async function commitSkillPromotionFingerprint(
  scope: MemoryScope,
  dirtyAt: string,
  fingerprint: string,
  outcomeClass: string,
  candidateIds: string[],
): Promise<boolean> {
  if (!SHA256_RE.test(fingerprint) || !outcomeClass.trim() || outcomeClass.length > 100) {
    throw new Error("Invalid skill promotion completion metadata");
  }
  return mutateStore((store) => {
    const metadata = store.metadata;
    const item = metadata?.skill_promotion?.dirty_scopes.find((entry) => entry.scope === scope);
    if (!metadata || !item || item.dirty_at !== dirtyAt) return false;
    const invalidated = reconcileStaleSkillCandidateMutationsMut(store, scope);
    if (candidateIds.some((id) => invalidated.has(id))) return false;
    const candidates = new Map((metadata.skill_candidates ?? []).map((candidate) => [candidate.id, candidate]));
    if (!candidateIds.every((id) => candidates.get(id)?.scope === scope)) return false;
    item.completed_fingerprint = fingerprint;
    item.completed_at = new Date(Math.max(Date.now(), Date.parse(item.dirty_at))).toISOString();
    item.last_outcome_class = outcomeClass.trim();
    metadata.skill_promotion = SkillPromotionMetadataSchema.parse(metadata.skill_promotion);
    return true;
  }, "none");
}

function assertSkillMutationBinding(
  store: ReflectionStore,
  mutation: PendingMutation,
  candidate: SkillPromotionCandidate,
): void {
  if (!mutation.payload || !mutation.payload_hash
      || !fingerprintsEqual(pendingMutationPayloadHash(mutation.payload), mutation.payload_hash)) {
    throw new Error(`Pending mutation ${mutation.id} payload hash mismatch`);
  }
  const expected = skillCandidateMutationPayload(candidate);
  if (!fingerprintsEqual(pendingMutationPayloadHash(expected), mutation.payload_hash)) {
    throw new Error(`Skill candidate ${candidate.id} mutation binding mismatch`);
  }
  if (candidate.risk !== "low" || candidate.risk_reasons.length > 0) {
    throw new Error(`Skill candidate ${candidate.id} is not approvable`);
  }
  if (hasUnsafeSkillProcedureContent(candidate.proposed_revision)) {
    throw new Error(`Skill candidate ${candidate.id} content is unsafe or contains sensitive data`);
  }
  const authoritative = assertSkillCandidateEvidence(store, candidate);
  if (!isPromotionProcedureGrounded(authoritative.cluster, candidate.proposed_revision)) {
    throw new Error(`Skill candidate ${candidate.id} content is not grounded in its evidence cluster`);
  }
  const targetMatch = matchPromotionTarget(authoritative.cluster, authoritative.snapshot.skills);
  if (targetMatch.risk_reasons.length > 0
      || targetMatch.action !== candidate.action
      || targetMatch.target_skill_id !== candidate.target_skill_id
      || targetMatch.expected_target_revision !== candidate.expected_target_revision) {
    throw new Error(`Skill candidate ${candidate.id} action or target match is stale or ambiguous`);
  }
}

export async function applyClaimedSkillCandidateMutation(
  mutationId: string,
  claimToken: string,
): Promise<{ candidate: SkillPromotionCandidate; skill: SkillRecord } | null> {
  return mutateStore((store) => {
    const metadata = store.metadata;
    if (!metadata) return null;
    const pending = metadata.pending_mutations ?? [];
    const mutationIndex = pending.findIndex((item) => item.id === mutationId
      && item.operation === "apply_skill_candidate"
      && item.state === "processing"
      && item.claim_token === claimToken);
    if (mutationIndex < 0) return null;
    const mutation = pending[mutationIndex];
    const candidates = metadata.skill_candidates ?? [];
    const candidateIndex = candidates.findIndex((item) => item.mutation_id === mutationId && item.state === "pending");
    const candidate = candidateIndex >= 0 ? SkillPromotionCandidateSchema.parse(candidates[candidateIndex]) : undefined;
    if (!candidate) throw new Error(`Skill candidate for mutation ${mutationId} is missing or finalized`);
    assertSkillMutationBinding(store, mutation, candidate);

    const skills = metadata.skills ?? [];
    const now = new Date().toISOString();
    let skill: SkillRecord;
    if (candidate.action === "create") {
      if (skills.filter((item) => item.scope === candidate.scope).length >= SKILL_RECORDS_PER_SCOPE_MAX) {
        throw new Error(`Skill capacity reached for ${candidate.scope}`);
      }
      const skillId = `skill:${pendingMutationPayloadHash({ candidate_id: candidate.id }).slice(0, 40)}`;
      if (skills.some((item) => item.id === skillId)) throw new Error(`Skill ID collision: ${skillId}`);
      skill = SkillRecordSchema.parse({
        id: skillId,
        scope: candidate.scope,
        status: "active",
        current_revision: 1,
        revisions: [candidate.proposed_revision],
        compacted_revision_audit: [],
        created_at: now,
        updated_at: now,
      });
      skills.push(skill);
    } else {
      const skillIndex = skills.findIndex((item) => item.id === candidate.target_skill_id
        && item.scope === candidate.scope);
      const target = skillIndex >= 0 ? skills[skillIndex] : undefined;
      if (!target || target.status !== "active"
          || target.current_revision !== candidate.expected_target_revision) {
        throw new Error(`Skill candidate ${candidate.id} target revision is stale or unavailable`);
      }
      skill = appendSkillRevision(target, candidate.proposed_revision, now);
      skills.splice(skillIndex, 1, skill);
    }

    const approved = transitionSkillPromotionCandidate(candidate, "approved", now, "explicit mutation approval");
    const applied = transitionSkillPromotionCandidate(approved, "applied", now, `applied revision ${skill.current_revision}`);
    candidates.splice(candidateIndex, 1, applied);
    pending.splice(mutationIndex, 1);
    metadata.skills = skills;
    metadata.skill_candidates = boundSkillCandidateAudit(candidates, skills);
    metadata.pending_mutations = pending;
    reconcileStaleSkillCandidateMutationsMut(store, candidate.scope);
    return { candidate: structuredClone(applied), skill: structuredClone(skill) };
  }, "none");
}

export async function rejectSkillCandidateMutation(
  mutationId: string,
): Promise<SkillPromotionCandidate | null> {
  return mutateStore((store) => {
    const metadata = store.metadata;
    if (!metadata) return null;
    const pending = metadata.pending_mutations ?? [];
    const mutationIndex = pending.findIndex((mutation) => mutation.id === mutationId
      && mutation.operation === "apply_skill_candidate"
      && ((mutation.state ?? "pending") === "pending" || isPendingClaimStale(mutation)));
    if (mutationIndex < 0) return null;
    const candidates = metadata.skill_candidates ?? [];
    const candidateIndex = candidates.findIndex((candidate) => candidate.mutation_id === mutationId
      && candidate.state === "pending");
    const candidate = candidateIndex >= 0 ? candidates[candidateIndex] : undefined;
    if (!candidate) return null;
    const rejected = transitionSkillPromotionCandidate(
      candidate,
      "rejected",
      new Date().toISOString(),
      "explicit mutation rejection",
    );
    pending.splice(mutationIndex, 1);
    candidates.splice(candidateIndex, 1, rejected);
    metadata.pending_mutations = pending;
    metadata.skill_candidates = boundSkillCandidateAudit(candidates, metadata.skills ?? []);
    return structuredClone(rejected);
  }, "none");
}

export async function rollbackAppliedSkillCandidate(
  mutationId: string,
): Promise<{ candidate: SkillPromotionCandidate; skill: SkillRecord; idempotent: boolean } | null> {
  return mutateStore((store) => {
    const metadata = store.metadata;
    if (!metadata) return null;
    const candidates = metadata.skill_candidates ?? [];
    const candidateIndex = candidates.findIndex((item) => item.mutation_id === mutationId
      && (item.state === "applied" || item.state === "rolled_back"));
    const candidate = candidateIndex >= 0 ? candidates[candidateIndex] : undefined;
    if (!candidate) return null;
    const skills = metadata.skills ?? [];
    const skill = appliedSkillForCandidate(skills, candidate);
    if (!skill) throw new Error(`Applied skill for candidate ${candidate.id} is missing`);
    const appliedRevision = skill.revisions.find((revision) =>
      revision.revision === candidate.proposed_revision.revision);
    if (!appliedRevision
        || appliedRevision.origin_candidate_id !== candidate.id
        || !fingerprintsEqual(appliedRevision.content_hash, candidate.proposed_revision.content_hash)) {
      throw new Error(`Rollback binding for candidate ${candidate.id} does not match the applied skill revision`);
    }
    if (candidate.state === "rolled_back") {
      const current = skill.revisions.find((revision) => revision.revision === skill.current_revision);
      if (!current || current.rollback_of_candidate_id !== candidate.id) {
        throw new Error(`Rollback audit for candidate ${candidate.id} is inconsistent with the current revision`);
      }
      return { candidate: structuredClone(candidate), skill: structuredClone(skill), idempotent: true };
    }
    if (skill.current_revision !== candidate.proposed_revision.revision) {
      throw new Error(`Cannot rollback candidate ${candidate.id}: a newer revision is current`);
    }
    const previous = candidate.action === "update"
      ? skill.revisions.find((revision) => revision.revision === candidate.proposed_revision.revision - 1)
      : candidate.proposed_revision;
    if (!previous) throw new Error(`Cannot rollback candidate ${candidate.id}: prior revision is unavailable`);
    const now = new Date().toISOString();
    const rollbackBody: Omit<SkillRevision, "content_hash"> = {
      revision: skill.current_revision + 1,
      title: previous.title,
      summary: previous.summary,
      steps: [...previous.steps],
      domain: previous.domain,
      tags: [...previous.tags],
      confidence: previous.confidence,
      provenance: previous.provenance.map((item) => ({ ...item })),
      origin_candidate_id: candidate.id,
      created_at: now,
      rollback_of_candidate_id: candidate.id,
    };
    const revision = SkillRevisionSchema.parse({
      ...rollbackBody,
      content_hash: skillRevisionContentHash(rollbackBody),
    });
    const skillIndex = skills.findIndex((item) => item.id === skill.id);
    const rolledSkill = appendSkillRevision(skill, revision, now);
    if (candidate.action === "create") rolledSkill.status = "disabled";
    const validatedSkill = SkillRecordSchema.parse(rolledSkill);
    const rolledCandidate = transitionSkillPromotionCandidate(candidate, "rolled_back", now, "explicit rollback");
    skills.splice(skillIndex, 1, validatedSkill);
    candidates.splice(candidateIndex, 1, rolledCandidate);
    metadata.skills = skills;
    metadata.skill_candidates = boundSkillCandidateAudit(candidates, skills);
    reconcileStaleSkillCandidateMutationsMut(store, candidate.scope);
    return {
      candidate: structuredClone(rolledCandidate),
      skill: structuredClone(validatedSkill),
      idempotent: false,
    };
  }, "none");
}

export async function rejectPendingMutation(mutationId: string): Promise<PendingMutation | null> {
  return mutateStore((store) => {
    const pending = store.metadata?.pending_mutations ?? [];
    // A live claim may still be replaying. A stale claim is safe to discard
    // (rather than replay) after an approver crash or process termination.
    const index = pending.findIndex((mutation) => mutation.id === mutationId
      && ((mutation.state ?? "pending") === "pending" || isPendingClaimStale(mutation)));
    if (index < 0) return null;
    const [removed] = pending.splice(index, 1);
    if (store.metadata) store.metadata.pending_mutations = pending;
    return removed;
  }, "none");
}

export interface PendingMutationClaim {
  mutation: PendingMutation;
  claimToken: string;
}

/** Atomically reserve a pending mutation so only one approver can replay it. */
export async function claimPendingMutation(mutationId: string): Promise<PendingMutationClaim | null> {
  return mutateStore((store) => {
    const pending = store.metadata?.pending_mutations ?? [];
    const mutation = pending.find((item) => {
      if (item.id !== mutationId) return false;
      if ((item.state ?? "pending") === "pending") return true;
      const receipt = committedReceiptFor(store, item.id);
      return item.state === "processing" && !!receipt && !!item.payload_hash && receipt.input_hash === item.payload_hash;
    });
    if (!mutation) return null;
    const claimToken = randomUUID();
    mutation.state = "processing";
    mutation.claim_token = claimToken;
    mutation.claimed_at = new Date().toISOString();
    return { mutation: structuredClone(mutation), claimToken };
  }, "none");
}

/** Remove a successfully replayed mutation only when held by this approver. */
export async function completePendingMutation(mutationId: string, claimToken: string): Promise<PendingMutation | null> {
  return mutateStore((store) => {
    const pending = store.metadata?.pending_mutations ?? [];
    const index = pending.findIndex((item) => item.id === mutationId
      && item.state === "processing" && item.claim_token === claimToken);
    if (index < 0) return null;
    const [removed] = pending.splice(index, 1);
    if (store.metadata) store.metadata.pending_mutations = pending;
    return removed;
  }, "none");
}

/** Return a failed replay to the queue without making its payload invisible. */
export async function releasePendingMutation(mutationId: string, claimToken: string): Promise<boolean> {
  // Releasing an approval claim changes only queue metadata, which is excluded
  // from journaled collection hashes. It must remain possible after an
  // interrupted journaled replay so the approval is never stranded.
  return withOperationJournalStoreMutation(() => mutateStore((store) => {
      const mutation = (store.metadata?.pending_mutations ?? []).find((item) => item.id === mutationId
        && item.state === "processing" && item.claim_token === claimToken);
      if (!mutation) return false;
      mutation.state = "pending";
      delete mutation.claim_token;
      delete mutation.claimed_at;
      return true;
    }, "none"));
}

export async function listPendingMutations(): Promise<PendingMutation[]> {
  await mutationQueue;
  const store = await getCachedStore();
  return structuredClone(store.metadata?.pending_mutations ?? []);
}

export async function upsertHeuristic(input: HeuristicInput, operationName?: string): Promise<Heuristic> {
  return mutateStore((store) => {
    const result = upsertHeuristicMut(store, input);
    pruneHeuristicsMut(store);
    return sanitizeHeuristicForOutput(result);
  }, "none", operationName, { ...input });
}

/** Upsert a bounded set of heuristics in one cross-process storage transaction. */
export async function upsertHeuristicsBatch(inputs: HeuristicInput[]): Promise<Heuristic[]> {
  return mutateStore((store) => {
    const saved = inputs.map((input) => upsertHeuristicMut(store, input));
    if (store.heuristics.length > HEURISTIC_MAX_COUNT) pruneHeuristicsMut(store);
    return saved.map((item) => sanitizeHeuristicForOutput(item));
  });
}

function safeAutomaticLesson(lesson: string): string | null {
  const redacted = redactSensitiveText(lesson, { strictHistorical: true }).trim();
  if (!redacted || firstHeuristicThreatMessage(redacted, "strict") !== null) return null;
  return redacted;
}

function planHeuristicFeedback(
  store: ReflectionStore,
  reflection: ReflectionFrame,
  feedbackInputs: HeuristicFeedbackInput[],
  preexistingIds: Set<string>,
): Array<{ heuristic: Heuristic; input: HeuristicFeedbackInput }> {
  const deduplicated = new Map<string, HeuristicFeedbackInput>();
  for (const input of feedbackInputs) {
    const previous = deduplicated.get(input.heuristic_id);
    if (previous && previous.value !== input.value) {
      throw new Error(`Conflicting feedback values for heuristic ${input.heuristic_id}.`);
    }
    deduplicated.set(input.heuristic_id, input);
  }

  const targets: Array<{ heuristic: Heuristic; input: HeuristicFeedbackInput }> = [];
  const byId = getOrBuildHeuristicByIdMap(store);
  for (const input of deduplicated.values()) {
    if (!preexistingIds.has(input.heuristic_id)) {
      throw new Error(`Heuristic feedback target is not a preexisting ID: ${input.heuristic_id}.`);
    }
    const heuristic = byId.get(input.heuristic_id);
    if (!heuristic) throw new Error(`Unknown heuristic feedback target: ${input.heuristic_id}.`);
    if (heuristic.scope !== "global" && heuristic.scope !== reflection.scope) {
      throw new Error(`Heuristic feedback target is outside reflection scope: ${input.heuristic_id}.`);
    }
    if (heuristic.evidence.some((item) => item.source_reflection_id === reflection.id)) {
      throw new Error(`Heuristic feedback cannot target a heuristic created by the same reflection: ${input.heuristic_id}.`);
    }
    targets.push({ heuristic, input });
  }
  return targets;
}

function applyHeuristicFeedbackMut(
  store: ReflectionStore,
  reflection: ReflectionFrame,
  feedbackInputs: HeuristicFeedbackInput[],
  preexistingIds: Set<string>,
): void {
  for (const { heuristic, input } of planHeuristicFeedback(store, reflection, feedbackInputs, preexistingIds)) {
    const duplicate = heuristic.feedback.some((item) =>
      item.reflection_id === reflection.id && item.heuristic_id === heuristic.id);
    if (duplicate) continue;
    heuristic.feedback.push({
      heuristic_id: heuristic.id,
      reflection_id: reflection.id,
      value: input.value,
      created_at: reflection.timestamp,
    });
    markSkillPromotionDirtyMut(store, heuristic.scope);
  }
}

export async function saveReflectionAndHeuristics(
  reflectionInput: ReflectionFrame,
  lessons: string[],
  domain: string,
  sourceTask: string,
  confidence: number,
  tags: string[],
  operationName?: string,
  heuristicFeedback: HeuristicFeedbackInput[] = [],
  idempotency?: ReflectionIdempotencyContext,
  normalizedInputHash?: string,
): Promise<{ session: Session; reflectionCount: number; nearSoftLimit: boolean; receipt?: CommittedReceipt; idempotentReplay?: boolean }> {
  const reflection: ReflectionFrame = {
    ...reflectionInput,
    scope: reflectionInput.scope ?? "global",
  };
  return mutateStore((store) => {
    const preexistingIds = new Set(store.heuristics.map((item) => item.id));
    applyHeuristicFeedbackMut(store, reflection, heuristicFeedback, preexistingIds);
    const session = ensureSession(store, reflection.session_id);
    session.reflection_count++;
    store.reflections.push(reflection);

    for (const gap of reflection.affordance_gaps) {
      const { isNew } = upsertAffordanceGapMut(store, gap);
      if (isNew) session.affordance_gap_count++;
    }

    const safeLessons = lessons
      .map(safeAutomaticLesson)
      .filter((lesson): lesson is string => lesson !== null);
    for (const lesson of safeLessons) {
      upsertHeuristicMut(store, {
        domain,
        heuristic: lesson,
        source_task: sourceTask,
        session_id: reflection.session_id,
        scope: reflection.scope,
        evidence: [{
          id: evidenceId(sourceTask, lesson),
          source_reflection_id: reflection.id,
          source_task: sourceTask,
          content_hash: lessonContentHash(lesson),
          created_at: reflection.timestamp,
        }],
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
  }, "append-only", operationName, { reflection, lessons, domain, sourceTask, confidence, tags, heuristicFeedback }, (store) => {
    planHeuristicFeedback(store, reflection, heuristicFeedback, new Set(store.heuristics.map((item) => item.id)));
  }, undefined, idempotency ? {
    ...idempotency,
    reflection_ids: [reflection.id],
    replay: (store, receipt) => {
      const committedReflection = store.reflections.find((item) => item.id === receipt.reflection_ids[0]);
      const session = committedReflection ? store.sessions[committedReflection.session_id] : undefined;
      if (!session || !committedReflection) {
        throw new Error("Committed idempotency receipt does not match authoritative reflection state");
      }
      return {
        session: { ...session },
        reflectionCount: store.reflections.length,
        nearSoftLimit: store.reflections.length >= REFLECTION_SOFT_LIMIT,
      };
    },
    decorate: (result, receipt, replayed) => ({ ...result, receipt, idempotentReplay: replayed }),
  } : undefined, normalizedInputHash);
}

export interface BatchReflectionSaveInput {
  reflection: ReflectionFrame;
  lessons: string[];
  domain: string;
  sourceTask: string;
  confidence: number;
  tags: string[];
  heuristicFeedback?: HeuristicFeedbackInput[];
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
  const reflection: ReflectionFrame = {
    ...input.reflection,
    scope: input.reflection.scope ?? "global",
  };
  const preexistingIds = new Set(store.heuristics.map((item) => item.id));
  applyHeuristicFeedbackMut(store, reflection, input.heuristicFeedback ?? [], preexistingIds);
  const session = ensureSession(store, reflection.session_id);
  session.reflection_count++;
  store.reflections.push(reflection);

  for (const gap of reflection.affordance_gaps) {
    const { isNew } = upsertAffordanceGapMut(store, gap);
    if (isNew) session.affordance_gap_count++;
  }

  const safeLessons = input.lessons
    .map(safeAutomaticLesson)
    .filter((lesson): lesson is string => lesson !== null);
  for (const lesson of safeLessons) {
    upsertHeuristicMut(store, {
      domain: input.domain,
      heuristic: lesson,
      source_task: input.sourceTask,
      session_id: reflection.session_id,
      scope: reflection.scope,
      evidence: [{
        id: evidenceId(input.sourceTask, lesson),
        source_reflection_id: reflection.id,
        source_task: input.sourceTask,
        content_hash: lessonContentHash(lesson),
        created_at: reflection.timestamp,
      }],
      confidence: input.confidence,
      tags: input.tags,
    });
  }

  return {
    id: reflection.id,
    task_goal: reflection.task_goal,
    outcome: reflection.task_outcome,
    heuristics_extracted: safeLessons.length,
  };
}

export async function batchSaveReflections(
  inputs: BatchReflectionSaveInput[],
  operationName?: string,
): Promise<{ results: BatchReflectionSaveResult[]; reflectionCount: number; nearSoftLimit: boolean }> {
  if (inputs.length === 0) {  // B20: skip disk write for empty batch
    const store = await getCachedStore();
    return { results: [], reflectionCount: store.reflections.length, nearSoftLimit: false };
  }
  return mutateStore((store) => {
    const results = inputs.map((input) => saveReflectionAndHeuristicsMut(store, input));
    if (store.heuristics.length > HEURISTIC_MAX_COUNT) pruneHeuristicsMut(store);
    return {
      results,
      reflectionCount: store.reflections.length,
      nearSoftLimit: store.reflections.length >= REFLECTION_SOFT_LIMIT,
    };
  }, inputs.length > 0 ? "append-only" : "none", operationName, { inputs });
}

function pruneHeuristicsMut(store: ReflectionStore): number {
  if (store.heuristics.length <= HEURISTIC_MAX_COUNT) return 0;

  const totalBefore = store.heuristics.length;
  const scopeById = new Map(store.heuristics.map((heuristic) => [heuristic.id, heuristic.scope]));
  const markRemovedScopes = (): void => {
    const remaining = new Set(store.heuristics.map((heuristic) => heuristic.id));
    const scopes = new Set<MemoryScope>();
    for (const [id, scope] of scopeById) if (!remaining.has(id)) scopes.add(scope);
    for (const scope of scopes) markSkillPromotionDirtyMut(store, scope);
  };
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
      markRemovedScopes();
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
  // B6-fix: clear all WeakMap caches, not just dedup cache
  _heuristicDedupCache.delete(store);
  _heuristicByIdCache.delete(store);
  _heuristicSearchTextCache.delete(store);
  _heuristicTagSetCache.delete(store);
  markRemovedScopes();
  return removedInPhase1 + toRemove.size;
}

export async function contradictHeuristic(id: string, reason?: string, operationName?: string): Promise<Heuristic | null> {
  return mutateStore((store) => {
    const heuristic = getOrBuildHeuristicByIdMap(store).get(id);
    if (!heuristic) return null;
    heuristic.contradiction_count++;
    heuristic.confidence = Math.max(0.0, heuristic.confidence - 0.1);
    heuristic.updated_at = new Date().toISOString();
    if (!heuristic.contradiction_notes) heuristic.contradiction_notes = [];
    if (reason) {
      const date = new Date().toISOString().slice(0, 10);
      heuristic.contradiction_notes.push(`[${date}] ${reason}`);
    }
    markSkillPromotionDirtyMut(store, heuristic.scope);
    return sanitizeHeuristicForOutput(heuristic);
  }, "none", operationName, { id, reason });
}

export async function deleteHeuristic(id: string, operationName?: string): Promise<boolean> {
  return mutateStore((store) => {
    const byId = getOrBuildHeuristicByIdMap(store);
    const removed = byId.get(id);
    if (!removed) return false;
    const affectedScopes = new Set<MemoryScope>([removed.scope]);
    // I1-fix: clean up dangling references from other heuristics before removing
    for (const h of store.heuristics) {
      if (h.superseded_by === id) {
        delete h.superseded_by;
        affectedScopes.add(h.scope);
      }
      if (h.supersedes?.includes(id)) {
        h.supersedes = h.supersedes.filter((sid) => sid !== id);
        affectedScopes.add(h.scope);
      }
    }
    store.heuristics = store.heuristics.filter((heuristic) => heuristic.id !== id);
    byId.delete(id);
    for (const scope of affectedScopes) markSkillPromotionDirtyMut(store, scope);
    return true;
  }, "none", operationName, { id });
}

export async function pinHeuristic(id: string, pin: boolean, operationName?: string): Promise<Heuristic | null> {
  return mutateStore((store) => {
    const heuristic = getOrBuildHeuristicByIdMap(store).get(id);
    if (!heuristic || heuristic.superseded_by) return null;
    if (pin) {
      heuristic.pinned = true;
    } else {
      delete heuristic.pinned;
    }
    heuristic.updated_at = new Date().toISOString();
    return sanitizeHeuristicForOutput(heuristic);
  }, "none", operationName, { id, pin });
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
  operationName?: string,
): Promise<Heuristic | null> {
  return mutateStore((store) => {
    const h = getOrBuildHeuristicByIdMap(store).get(id);
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
        h.superseded_by = undefined;          // restore h as active
        h.updated_at = now;
        if (normalizedTags !== undefined) h.tags = normalizedTags;
        if (normalizedConfidence !== undefined) h.confidence = normalizedConfidence;
        if (normalizedDomain !== undefined) h.domain = normalizedDomain;
        getOrBuildHeuristicByIdMap(store).delete(replacement.id);
        markSkillPromotionDirtyMut(store, h.scope);
        return sanitizeHeuristicForOutput(h);
      }
      markSkillPromotionDirtyMut(store, replacement.scope);
      return sanitizeHeuristicForOutput(replacement);
    }

    if (update.heuristic !== undefined) h.heuristic = update.heuristic;
    if (normalizedTags !== undefined) h.tags = normalizedTags;
    if (normalizedConfidence !== undefined) h.confidence = normalizedConfidence;
    if (normalizedDomain !== undefined) h.domain = normalizedDomain;
    h.version = h.version ?? 1;
    h.supersedes = h.supersedes ?? [];
    h.updated_at = new Date().toISOString();
    markSkillPromotionDirtyMut(store, h.scope);
    return sanitizeHeuristicForOutput(h);
  }, "none", operationName, { id, ...update });
}

export async function mergeHeuristics(targetId: string, sourceIds: string[], operationName?: string): Promise<Heuristic | null> {
  return mutateStore((store) => {
    const byId = getOrBuildHeuristicByIdMap(store);
    const target = byId.get(targetId);
    if (!target || target.superseded_by) return null;
    const now = new Date().toISOString();

    for (const sourceId of sourceIds) {
      if (sourceId === targetId) continue;
      const source = byId.get(sourceId);
      if (!source || source.superseded_by) continue;

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
      markSkillPromotionDirtyMut(store, source.scope);
      target.supersedes = target.supersedes ?? [];
      if (!target.supersedes.includes(sourceId)) target.supersedes.push(sourceId);
    }

    target.updated_at = now;
    markSkillPromotionDirtyMut(store, target.scope);
    if (store.heuristics.length > HEURISTIC_MAX_COUNT) pruneHeuristicsMut(store);
    return sanitizeHeuristicForOutput(target);
  }, "none", operationName, { target_id: targetId, source_ids: sourceIds });
}

export type HeuristicSort = "confidence" | "updated_at" | "created_at" | "reinforcement";
export type TagFilterMode = "and" | "or";

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
  scope?: MemoryScope;
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
  const scope = options.scope ?? "global";

  const compare = (a: Heuristic, b: Heuristic): number => {
    switch (sort) {
      case "updated_at":
        return compareStableText(b.updated_at, a.updated_at);
      case "created_at":
        return compareStableText(b.created_at, a.created_at);
      case "reinforcement":
        return b.reinforcement_count - a.reinforcement_count;
      case "confidence":
        return b.confidence - a.confidence;
    }
  };

  const topItems: Heuristic[] = [];
  for (const heuristic of store.heuristics) {
    if (heuristic.superseded_by) continue;
    if (heuristic.scope !== "global" && heuristic.scope !== scope) continue;
    if (normalizedDomain && normalizeDomain(heuristic.domain) !== normalizedDomain) continue;
    if (filterTags.length > 0 && !matchesTagSet(cache.heuristicTagSetById.get(heuristic.id), filterTags, tagMode)) continue;
    if (heuristic.confidence < minConfidence) continue;
    insertSorted(topItems, heuristic, compare, limit);
  }

  return topItems.map((heuristic) => ({
    ...sanitizeHeuristicForOutput(heuristic),
  }));
}

export async function getHeuristicHistory(
  id: string,
  includeArchived = true,
): Promise<Heuristic[] | null> {
  const cache = await getCachedStoreEntry();
  const byId = cache.heuristicById;
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

export async function getHeuristicById(id: string): Promise<Heuristic | null> {
  const heuristic = (await getCachedStoreEntry()).heuristicById.get(id);
  return heuristic ? sanitizeHeuristicForOutput(heuristic) : null;
}

export type SearchHeuristicResult = Heuristic & { score: number };

export interface RetrieveHeuristicsQuery {
  taskDescription: string;
  domain?: string;
  tags?: string[];
  tagMode?: TagFilterMode;
  limit?: number;
  minConfidence?: number;
  scope?: MemoryScope;
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
  scope: MemoryScope = "global",
): Promise<SearchHeuristicResult[]> {
  const cache = await getCachedStoreEntry();
  const store = cache.store;
  const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
  const filterTags = normalizeTags(tags);

  let candidates = store.heuristics.filter(
    (heuristic) => !heuristic.superseded_by
      && heuristic.confidence >= minConfidence
      && (heuristic.scope === "global" || heuristic.scope === scope)
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
  scope: MemoryScope = "global",
): Promise<HeuristicWithScore[]> {
  const cache = await getCachedStoreEntry();
  const topItems = scoreHeuristicsForQuery(
    cache.store,
    { taskDescription, domain, tags, tagMode, limit, minConfidence, scope },
    cache.heuristicSearchTextById,
    cache.heuristicTagSetById,
  );
  return topItems.map((item) => ({
    ...sanitizeHeuristicForOutput(item.heuristic),
    ...(includeScores ? { _score: item.scoreDetail } : {}),
  }));
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
  const scope = query.scope ?? "global";

  const topItems: ScoredHeuristic[] = [];
  const scoreCompare = (a: ScoredHeuristic, b: ScoredHeuristic): number =>
    b.score - a.score
    || b.heuristic.confidence - a.heuristic.confidence
    || compareStableText(a.heuristic.id, b.heuristic.id);

  for (const heuristic of store.heuristics) {
    if (heuristic.superseded_by) continue;
    if (heuristic.confidence < minConfidence) continue;
    if (heuristic.scope !== "global" && heuristic.scope !== scope) continue;
    if (normalizedDomain && normalizeDomain(heuristic.domain) !== normalizedDomain) continue;
    if (filterTags.length > 0 && !matchesTagSet(tagSetMap.get(heuristic.id), filterTags, tagMode)) continue;

    const textScore = similarity(
      searchTextMap.get(heuristic.id) ?? heuristicSearchText(heuristic),
      query.taskDescription,
      1.5,
      0.75,
      AVG_HEURISTIC_DOC_LEN,
    );
    if (textScore < SEARCH_MIN_TEXT_SCORE) continue;

    const evidence = evidenceSignal(heuristic.evidence ?? []);
    const feedback = feedbackSignal(heuristic.feedback ?? []);
    const finalScore = textScore * 0.70
      + heuristic.confidence * 0.15
      + evidence * 0.10
      + feedback * 0.05;

    insertSorted(topItems, {
      heuristic,
      score: finalScore,
      scoreDetail: {
        text: textScore,
        confidence: heuristic.confidence,
        evidence,
        feedback,
        final: finalScore,
      },
    }, scoreCompare, limit);
  }

  return topItems;
}

export async function bulkRetrieveHeuristics(
  queries: RetrieveHeuristicsQuery[],
  includeScores = false,
): Promise<HeuristicWithScore[][]> {
  const cache = await getCachedStoreEntry();
  return queries.map((query) => scoreHeuristicsForQuery(
    cache.store,
    query,
    cache.heuristicSearchTextById,
    cache.heuristicTagSetById,
  ).map((item) => ({
    ...sanitizeHeuristicForOutput(item.heuristic),
    ...(includeScores ? { _score: item.scoreDetail } : {}),
  })));
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
    .sort((a, b) => compareStableText(b.timestamp, a.timestamp))
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
  scope: MemoryScope = "global",
): Promise<ReflectionFrame[]> {
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  const store = cache.store;
  const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
  let candidates = store.reflections.filter((reflection) =>
    reflection.scope === "global" || reflection.scope === scope
  );

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
    const sliced = newestFirstSlice(candidates, limit, 0, cache.reflectionsAreAscending);
    return sliced.map((reflection) => sanitizeReflectionForOutput(reflection, resolvedIndex));
  }

  const scored = candidates
    .map((reflection) => {
      const haystack = cache.reflectionSearchTextById.get(reflection.id) ?? reflectionSearchText(reflection);
      const textScore = similarity(haystack, query, 1.5, 0.75, AVG_REFLECTION_DOC_LEN);
      if (textScore < SEARCH_MIN_TEXT_SCORE) return null;
      const ageMs = Date.now() - new Date(reflection.timestamp).getTime();
      // Clock skew or imported future timestamps must not turn the exponential
      // recency term into an unbounded boost. Rank by distance from the current
      // clock so far-future records decay just like equally old records.
      const ageDays = Math.abs(ageMs) / (1000 * 60 * 60 * 24);
      const recencyFactor = 0.5 + 0.5 * Math.exp(-ageDays / 90);
      return { reflection, score: textScore * recencyFactor };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => sanitizeReflectionForOutput(item.reflection, resolvedIndex));
}

export interface ListReflectionsOptions {
  domain?: string;
  outcome?: ReflectionFrame["task_outcome"];
  failureMode?: ReflectionFrame["failure_mode"];
  tags?: string[];
  tagMode?: TagFilterMode;
  sessionId?: string;
  scope?: MemoryScope;
  sinceDays?: number;
  limit?: number;
  offset?: number;
}

export async function listReflections(options: ListReflectionsOptions = {}): Promise<ReflectionFrame[]> {
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
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

  const scope = options.scope ?? "global";
  let candidates = base.filter((reflection) =>
    reflection.scope === "global" || reflection.scope === scope
  );
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

  const sliced = newestFirstSlice(candidates, limit, offset, cache.reflectionsAreAscending);
  return sliced.map((reflection) => sanitizeReflectionForOutput(reflection, resolvedIndex));
}

function sanitizeReflectionLessonsForOutput(reflection: ReflectionFrame): ReflectionFrame {
  const isolated = structuredClone(reflection);
  return {
    ...isolated,
    lessons_learned: isolated.lessons_learned.map(safeHeuristicText),
  };
}

/**
 * B3-fix: Apply resolved_questions overlay to a reflection's open_questions,
 * then sanitize lessons. Used by all reflection output paths to ensure
 * resolved questions display consistently across all retrieval functions.
 */
function sanitizeReflectionForOutput(
  reflection: ReflectionFrame,
  resolvedIndex: ResolvedQuestionIndex,
): ReflectionFrame {
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
  const cache = await getCachedStoreEntry();
  const store = cache.store;

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
    top_gaps: structuredClone(topGaps),
    recent_lessons: recentLessons,
    outcome_distribution: outcomeDist,
    failure_distribution: failureDist,
    domain_distribution: domainDist,
    tag_distribution: tagDist,
    metadata: structuredClone(store.metadata),
  };
}

export async function getAffordanceGaps(minOccurrences = 1, includeResolved = false, limit?: number): Promise<AffordanceGap[]> {
  const store = await getCachedStore();
  const filtered = store.affordance_gaps
    .filter((gap) => gap.occurrence_count >= minOccurrences && (includeResolved || !gap.resolved));
  if (limit != null) {
    const top: AffordanceGap[] = [];
    for (const gap of filtered) {
      insertSorted(top, gap, (a, b) => b.occurrence_count - a.occurrence_count, limit);
    }
    return structuredClone(top);
  }
  return structuredClone(filtered.sort((a, b) => b.occurrence_count - a.occurrence_count));
}

export async function resolveAffordanceGap(
  id: string,
  resolutionNotes?: string,
  operationName?: string,
): Promise<AffordanceGap | null> {
  return mutateStore((store) => {
    const gap = getOrBuildAffordanceGapByIdIndex(store).get(id);
    if (!gap) return null;
    gap.resolved = true;
    gap.resolved_at = new Date().toISOString();
    if (resolutionNotes) gap.resolution_notes = resolutionNotes;
    return { ...gap, available_tools: [...gap.available_tools] };
  }, "none", operationName, { id, resolution_notes: resolutionNotes });
}

export async function getRecentReflections(limit = 20, scope: MemoryScope = "global"): Promise<ReflectionFrame[]> {
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  const recent = cache.store.reflections
    .filter((reflection) => reflection.scope === "global" || reflection.scope === scope)
    .sort((a, b) => compareStableText(b.timestamp, a.timestamp))
    .slice(0, limit);
  return recent.map((reflection) => sanitizeReflectionForOutput(reflection, resolvedIndex));
}

export async function getSessionReflections(sessionId: string, limit = 20): Promise<ReflectionFrame[]> {
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  const indexes = cache.sessionIndex.get(sessionId) ?? [];
  const sliced = indexes.slice(-limit).reverse().map((index) => cache.store.reflections[index]);
  return sliced.map((reflection) => sanitizeReflectionForOutput(reflection, resolvedIndex));
}

export interface ReflectionChainEntry {
  reflection: ReflectionFrame;
  similarity: number;
  is_seed: boolean;
}

export async function getReflectionChain(
  id: string,
  similarityThreshold = 0.2,
  limit = 10,
  includeSelf = true,
): Promise<ReflectionChainEntry[] | null> {
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  const seed = cache.reflectionById.get(id);
  if (!seed) return null;

  const sessionIndexes = cache.sessionIndex.get(seed.session_id) ?? [];
  const seedText = cache.reflectionSearchTextById.get(id) ?? reflectionSearchText(seed);

  let seedEntry: ReflectionChainEntry | undefined;
  const others: ReflectionChainEntry[] = [];

  for (const index of sessionIndexes) {
    const reflection = cache.store.reflections[index];

    if (reflection.id === id) {
      if (includeSelf) {
        const sanitizedSeed = sanitizeReflectionForOutput(reflection, resolvedIndex);
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
      const sanitizedOther = sanitizeReflectionForOutput(reflection, resolvedIndex);
      others.push({
        reflection: sanitizedOther,
        similarity: Number(sim.toFixed(3)),
        is_seed: false,
      });
    }
  }

  others.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    return compareStableText(a.reflection.timestamp, b.reflection.timestamp);
  });

  if (!seedEntry) {
    return others.slice(0, limit);
  }

  return [seedEntry, ...others.slice(0, Math.max(0, limit - 1))];
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
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  const store = cache.store;
  const session = getOwnSession(store.sessions, sessionId);
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
    return pd !== 0 ? pd : compareStableText(b.timestamp, a.timestamp);
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
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  const reflection = cache.reflectionById.get(id);
  if (!reflection) return null;
  if (!applyResolvedOverlay) {
    const isolated = structuredClone(reflection);
    return {
      ...isolated,
      lessons_learned: isolated.lessons_learned.map(safeHeuristicText),
    };
  }
  const isolated = structuredClone(reflection);
  return {
    ...isolated,
    lessons_learned: isolated.lessons_learned.map(safeHeuristicText),
    open_questions: isolated.open_questions.map((question, index) => {
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
  operationName?: string,
): Promise<ReflectionFrame | null> {
  const result = await mutateStore((store) => {
    const reflection = getOrBuildReflectionByIdMap(store).get(id);
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

    return reflection;
  }, "rewrite", operationName, { id, ...update }, undefined, undefined, undefined, undefined,
  (reflection, resolved) => reflection ? sanitizeReflectionForOutput(reflection, resolved) : null);
  return result;
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
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  const a = cache.reflectionById.get(idA);
  const b = cache.reflectionById.get(idB);
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

  const sanitizedA = sanitizeReflectionForOutput(a, resolvedIndex);
  const sanitizedB = sanitizeReflectionForOutput(b, resolvedIndex);

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
  const cache = await getCachedStoreEntry();
  const store = cache.store;
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

  const orderedReflections = cache.reflectionsAreAscending
    ? store.reflections
    : [...store.reflections].sort((a, b) => compareStableText(a.timestamp, b.timestamp));

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

  facts.sort((a, b) => compareStableText(b.timestamp, a.timestamp));
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
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
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
  scope: MemoryScope = "global",
): Promise<OpenQuestionSummary[]> {
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  const store = cache.store;
  const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
  const cutoff = sinceDays !== undefined
    ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
    : undefined;
  const results: OpenQuestionSummary[] = [];
  const openQCompare = (a: OpenQuestionSummary, b: OpenQuestionSummary): number => {
    const priorityDelta = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (priorityDelta !== 0) return priorityDelta;
    return compareStableText(b.timestamp, a.timestamp);
  };

  for (const reflection of store.reflections) {
    if (reflection.scope !== "global" && reflection.scope !== scope) continue;
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
  const cache = await getCachedStoreEntry();
  const reflection = cache.reflectionById.get(reflectionId);
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
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  return mergeResolvedQuestionsIntoStore(cache.store, resolvedIndex);
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
  len += strSize(reflection.context_notes);

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
  const cache = await getCachedStoreEntry();
  const store = cache.store;
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

  const heuristicById = cache.heuristicById;
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

  let suspiciousHeuristics = 0;
  for (const heuristic of store.heuristics) {
    if (scanHeuristicThreats(heuristic.heuristic, "strict").length > 0) suspiciousHeuristics++;
  }
  if (suspiciousHeuristics > 0) {
    issues.push(`${suspiciousHeuristics} heuristic(s) contain blocked context-injection or exfiltration patterns. Normal list/search/retrieve output hides their raw text; inspect with export_data(collection:"heuristics").`);
  }

  let totalReflectionBytes = 0;
  let largestReflection: { id: string; bytes: number } | undefined;
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

export async function createSnapshot(outputDir?: string, label?: string): Promise<SnapshotResult> {
  return withOperationJournalBarrier(() => withFileLock(STORE_PATH, async () => {
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
  }));
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function fileFingerprint(path: string): Promise<FileFingerprint> {
  if (process.env.NODE_ENV === "test" && process.env.HERMES_TEST_FILE_FINGERPRINT_ERROR) {
    const resources: Record<string, string> = {
      store: STORE_PATH,
      reflections: REFLECTIONS_PATH,
      resolved_questions: RESOLVED_QUESTIONS_PATH,
    };
    const [resource, code, extra] = process.env.HERMES_TEST_FILE_FINGERPRINT_ERROR.split(":");
    if (!extra && resources[resource] === path && ["EACCES", "EPERM", "EIO"].includes(code)) {
      throw Object.assign(new Error(`injected fingerprint ${code} for ${resource}`), { code });
    }
  }
  try {
    const info = await stat(path);
    return { exists: true, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false, dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 };
    }
    throw error;
  }
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.exists === right.exists
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function resolvedQuestionKey(reflectionId: string, questionIndex: number): string {
  return `${reflectionId}:${questionIndex}`;
}

async function loadResolvedQuestionsUnderBarrier(): Promise<ResolvedQuestionIndex> {
  const loaded = await readAuthoritativeJson<unknown>(RESOLVED_QUESTIONS_PATH, "resolved-question overlay");
  if (!loaded.exists) return {};
    const parsed = loaded.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const backup = await preserveCorruptUtf8(RESOLVED_QUESTIONS_PATH, loaded.raw);
      throw new AuthoritativeStateError(
        `Refusing to continue: resolved_questions.json must contain an object. Evidence backup: ${backup}. Nothing was changed.`,
      );
    }
    const now = new Date().toISOString();
    const normalized: ResolvedQuestionIndex = Object.create(null) as ResolvedQuestionIndex;
    for (const [key, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.includes(":")) continue;
      const entry = recordValue(rawEntry);
      normalized[key] = {
        resolved_at: normalizeIsoTimestamp(entry.resolved_at, now),
        ...(typeof entry.resolved_by === "string" && entry.resolved_by
          ? { resolved_by: entry.resolved_by }
          : {}),
      };
    }
    return normalized;
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
  const run = resolvedQuestionsMutationQueue.then(() => withOperationJournalBarrier(async () => {
    await withFileLock(RESOLVED_QUESTIONS_PATH, async () => {
      // Reload inside the process-shared transaction so every writer merges
      // against the latest committed overlay rather than a local cache.
      const index = await loadResolvedQuestionsUnderBarrier();
      await mutator(index);
      await saveResolvedQuestions(index);
      _resolvedQuestionsCache = {
        index,
        loadedAt: Date.now(),
        fingerprint: await fileFingerprint(RESOLVED_QUESTIONS_PATH),
      };
    });
  }));
  resolvedQuestionsMutationQueue = run.then(
    () => undefined,
    (error) => {
      console.error(
        "[hermes] resolved questions error:",
        error instanceof Error ? error.message : String(error),
      );
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

function mergeResolvedQuestionsIntoStore(
  store: ReflectionStore,
  resolvedIndex: ResolvedQuestionIndex,
): ReflectionStore {
  const isolated = structuredClone(store);
  return {
    ...isolated,
    reflections: isolated.reflections.map((reflection) => ({
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

function assertImportObject(incoming: Partial<ReflectionStore>): void {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw new Error("importData requires a non-null 'incoming' object");
  }
}

function applyReplaceImportFields(
  store: ReflectionStore,
  incoming: Partial<ReflectionStore>,
): ResolvedQuestionIndex | undefined {
  let replacementResolvedIndex: ResolvedQuestionIndex | undefined;
  const affectedPromotionScopes = new Set<MemoryScope>();
  if (incoming.reflections) {
    for (const reflection of store.reflections) affectedPromotionScopes.add(reflection.scope);
    store.reflections = uniqueById(
      (incoming.reflections as Partial<ReflectionFrame>[]).map(normalizeReflectionFrame),
    );
    for (const reflection of store.reflections) affectedPromotionScopes.add(reflection.scope);
    replacementResolvedIndex = resolvedQuestionsFromReflections(store.reflections);
  }
  if (incoming.heuristics) {
    for (const heuristic of store.heuristics) affectedPromotionScopes.add(heuristic.scope);
    store.heuristics = uniqueById(
      (incoming.heuristics as Partial<Heuristic>[]).map(normalizeHeuristicRecord),
    );
    for (const heuristic of store.heuristics) affectedPromotionScopes.add(heuristic.scope);
  }
  if (incoming.affordance_gaps) {
    store.affordance_gaps = uniqueById(
      (incoming.affordance_gaps as Partial<AffordanceGap>[]).map((gap) => normalizeAffordanceGapRecord(gap)),
    );
  }
  if (incoming.sessions) store.sessions = normalizeSessionsRecord(incoming.sessions as Record<string, Partial<Session>>);
  if (incoming.memory_board) store.memory_board = normalizeMemoryBoard(incoming.memory_board as Partial<MemoryBoard>);
  if (incoming.user_profile) store.user_profile = normalizeMemoryBoard(incoming.user_profile as Partial<MemoryBoard>, 1800);
  reconcileSessionCounters(store, true);
  for (const scope of affectedPromotionScopes) markSkillPromotionDirtyMut(store, scope);
  return replacementResolvedIndex;
}

export async function previewReplaceImportData(
  incoming: Partial<ReflectionStore>,
  base?: ReflectionStore,
): Promise<ReflectionStore> {
  assertImportObject(incoming);
  const preview = structuredClone(base ?? await exportData()) as ReflectionStore;
  const replacementResolvedIndex = applyReplaceImportFields(preview, incoming);
  if (replacementResolvedIndex) {
    preview.reflections = preview.reflections.map((reflection) => ({
      ...reflection,
      open_questions: reflection.open_questions.map((question, index) => {
        const resolved = replacementResolvedIndex[resolvedQuestionKey(reflection.id, index)];
        return resolved
          ? {
              ...question,
              resolved: true,
              resolved_at: resolved.resolved_at,
              ...(resolved.resolved_by ? { resolved_by: resolved.resolved_by } : {}),
            }
          : question;
      }),
    }));
  }
  return preview;
}

export interface StoreSnapshotReplacementResult {
  store: ReflectionStore;
  resolvedQuestions: ResolvedQuestionIndex;
}

function normalizeStoreDataSnapshotReplacement(snapshot: ReflectionStore): StoreSnapshotReplacementResult {
  assertImportObject(snapshot);
  const normalized = structuredClone(snapshot) as ReflectionStore;
  normalized.sessions = normalizeSessionsRecord(snapshot.sessions);
  normalized.reflections = uniqueById(
    asArray<Partial<ReflectionFrame>>(snapshot.reflections).map(normalizeReflectionFrame),
  );
  normalized.heuristics = uniqueById(
    asArray<Partial<Heuristic>>(snapshot.heuristics).map(normalizeHeuristicRecord),
  );
  normalized.affordance_gaps = uniqueById(
    asArray<Partial<AffordanceGap>>(snapshot.affordance_gaps).map((gap) => normalizeAffordanceGapRecord(gap)),
  );
  normalized.memory_board = normalizeMemoryBoard(snapshot.memory_board);
  normalized.user_profile = normalizeMemoryBoard(snapshot.user_profile, 1800);
  normalized.version = VERSION;
  const replacementResolvedIndex = resolvedQuestionsFromReflections(normalized.reflections);
  return { store: normalized, resolvedQuestions: replacementResolvedIndex };
}

export async function replaceStoreDataSnapshot(snapshot: ReflectionStore): Promise<StoreSnapshotReplacementResult> {
  const plan = normalizeStoreDataSnapshotReplacement(snapshot);
  await mutateStore((store) => {
    store.sessions = plan.store.sessions;
    store.reflections = plan.store.reflections;
    store.heuristics = plan.store.heuristics;
    store.affordance_gaps = plan.store.affordance_gaps;
    store.memory_board = plan.store.memory_board;
    store.user_profile = plan.store.user_profile;
    store.version = plan.store.version;
  }, "rewrite", undefined, undefined, undefined, async (resolved) => {
    for (const key of Object.keys(resolved)) delete resolved[key];
    Object.assign(resolved, plan.resolvedQuestions);
  });
  return structuredClone(plan);
}

export async function importData(
  incoming: Partial<ReflectionStore>,
  mode: ImportMode,
  operationName?: string,
): Promise<{ reflections: number; heuristics: number; affordance_gaps: number; sessions: number }> {
  // B4-fix: validate incoming is a non-null object before accessing properties
  assertImportObject(incoming);
  const mutationResult = await mutateStore((store) => {
    const originalSessionIds = new Set(Object.keys(store.sessions));
    const affectedPromotionScopes = new Set<MemoryScope>();
    let replacementResolvedIndex: ResolvedQuestionIndex | undefined;
    let mergedResolvedIndex: ResolvedQuestionIndex | undefined;
    const mergedNewReflections: ReflectionFrame[] = [];
    let newReflections = 0;
    let newHeuristics = 0;
    let newGaps = 0;
    let newSessions = 0;
    let newMemoryBoard = 0;  // E4-fix: track memory_board/user_profile additions
    let newUserProfile = 0;

    if (mode === "replace") {
      replacementResolvedIndex = applyReplaceImportFields(store, incoming);
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
            affectedPromotionScopes.add(r.scope);
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
        for (const h of incoming.heuristics as Partial<Heuristic>[]) {
          const normalized = normalizeHeuristicRecord(h);
          if (existingIds.has(normalized.id)) continue;
          const textLower = normalized.heuristic.toLowerCase().trim();
          if (existingTexts.has(textLower)) continue; // skip content duplicate
          store.heuristics.push(normalized);
          existingIds.add(normalized.id);
          existingTexts.add(textLower);
          affectedPromotionScopes.add(normalized.scope);
          newHeuristics++;
        }
        // B7-fix: enforce HEURISTIC_MAX_COUNT after merge
        pruneHeuristicsMut(store);
      }
      if (incoming.affordance_gaps) {
        const existingIds = new Set(store.affordance_gaps.map((g) => g.id));
        for (const rawG of incoming.affordance_gaps as Partial<AffordanceGap>[]) {
          const g = normalizeAffordanceGapRecord(rawG);
          if (!existingIds.has(g.id)) {
            store.affordance_gaps.push(g);
            existingIds.add(g.id);
            newGaps++;
          }
        }
      }
      if (incoming.sessions) {
        for (const [id, session] of Object.entries(incoming.sessions as Record<string, Partial<Session>>)) {
          if (!getOwnSession(store.sessions, id)) {
            setOwnSession(store.sessions, id, normalizeSessionRecord(id, session));
            newSessions++;
          }
        }
      }
      if (incoming.memory_board) {
        const normalized = normalizeMemoryBoard(incoming.memory_board as Partial<MemoryBoard>);
        const existingIds = new Set(store.memory_board?.entries.map((e) => e.id) ?? []);
        const board = store.memory_board ?? normalizeMemoryBoard(undefined);
        store.memory_board = board;
        board.used_chars = computeMemoryBoardUsedChars(board.entries);  // B8-fix: recompute before merge
        for (const entry of normalized.entries) {
          if (existingIds.has(entry.id)) continue;
          if (board.used_chars + entry.content.length <= board.char_limit) {
            board.entries.push(entry);
            existingIds.add(entry.id);
            board.used_chars += entry.content.length;
            newMemoryBoard++;  // E4-fix
          }
        }
      }
      if (incoming.user_profile) {
        const normalized = normalizeMemoryBoard(incoming.user_profile as Partial<MemoryBoard>, 1800);
        const existingIds = new Set(store.user_profile?.entries.map((e) => e.id) ?? []);
        const profile = store.user_profile ?? normalizeMemoryBoard(undefined, 1800);
        store.user_profile = profile;
        profile.used_chars = computeMemoryBoardUsedChars(profile.entries);  // B8-fix
        for (const entry of normalized.entries) {
          if (existingIds.has(entry.id)) continue;
          if (profile.used_chars + entry.content.length <= profile.char_limit) {
            profile.entries.push(entry);
            existingIds.add(entry.id);
            profile.used_chars += entry.content.length;
            newUserProfile++;  // E4-fix
          }
        }
      }
    }

    // Session counters are derived from the records actually present in the
    // store. Partial imports must not leave orphan references or stale counts.
    reconcileSessionCounters(store, true);
    for (const scope of affectedPromotionScopes) markSkillPromotionDirtyMut(store, scope);
    newSessions = Object.keys(store.sessions)
      .filter((id) => !originalSessionIds.has(id))
      .length;

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
  }, incoming.reflections ? "rewrite" : "none", operationName, { incoming, mode }, undefined,
  incoming.reflections ? async (resolved, result) => {
    if (mode === "replace") {
      for (const key of Object.keys(resolved)) delete resolved[key];
      Object.assign(resolved, result.replacementResolvedIndex ?? {});
    } else if (result.mergedNewReflections.length > 0) {
      const newResolvedEntries = result.mergedResolvedIndex ?? {};
      if (Object.keys(newResolvedEntries).length > 0) {
        for (const [key, entry] of Object.entries(newResolvedEntries)) {
          if (!resolved[key]) resolved[key] = entry;
        }
      }
    }
  } : undefined);

  return mutationResult.counts;
}

export async function clearData(collection: ClearCollection, operationName?: string): Promise<void> {
  await mutateStore((store) => {
    const affectedScopes = collection === "heuristics" || collection === "reflections"
      ? new Set<MemoryScope>([
        ...store.heuristics.map((heuristic) => heuristic.scope),
        ...store.reflections.map((reflection) => reflection.scope),
      ])
      : new Set<MemoryScope>();
    applyClearDataFields(store, collection);
    for (const scope of affectedScopes) markSkillPromotionDirtyMut(store, scope);
  }, collection === "reflections" || collection === "all" ? "rewrite" : "none", operationName, { collection }, undefined,
  collection === "reflections" || collection === "all" ? async (resolved) => {
      for (const key of Object.keys(resolved)) delete resolved[key];
    } : undefined);
}

function applyClearDataFields(store: ReflectionStore, collection: ClearCollection): void {
  switch (collection) {
    case "reflections":
      store.reflections = [];
      for (const session of Object.values(store.sessions)) session.reflection_count = 0;
      break;
    case "heuristics":
      store.heuristics = [];
      break;
    case "affordance_gaps":
      store.affordance_gaps = [];
      for (const session of Object.values(store.sessions)) session.affordance_gap_count = 0;
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
      if (store.metadata) {
        store.metadata.skills = [];
        store.metadata.skill_candidates = [];
        store.metadata.skill_promotion = { dirty_scopes: [] };
        store.metadata.pending_mutations = (store.metadata.pending_mutations ?? [])
          .filter((mutation) => mutation.operation !== "apply_skill_candidate");
      }
      break;
  }
}

export async function previewClearData(collection: ClearCollection, base?: ReflectionStore): Promise<ReflectionStore> {
  const preview = structuredClone(base ?? await exportData()) as ReflectionStore;
  applyClearDataFields(preview, collection);
  return preview;
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
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  const store = cache.store;
  const limit = options.limit ?? 200;

  // --- Select reflections ---
  let selected: ReflectionFrame[];

  if (options.session_id) {
    selected = (cache.sessionIndex.get(options.session_id) ?? [])
      .map((index) => store.reflections[index]);

    if (selected.length === 0) return null;

    // Newest-first for presentation, dedupe, apply limit
    selected.sort((a, b) => compareStableText(b.timestamp, a.timestamp));
    selected = dedupeNewestFirst(selected);
    selected = selected.slice(0, limit);
  } else {
    // Pre-compute filter predicates once
    const normalizedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
    const filterTags = options.tags && options.tags.length > 0 ? normalizeTags(options.tags) : [];
    const tagMode: TagFilterMode = options.tag_mode ?? "and";
    const cutoff = options.since_days !== undefined
      ? new Date(Date.now() - options.since_days * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    if (cache.reflectionsAreAscending) {
      // Scan from end (newest) toward start; early-stop once limit is reached
      const seenIds = new Set<string>();
      selected = [];
      for (let i = store.reflections.length - 1; i >= 0 && selected.length < limit; i--) {
        const r = store.reflections[i];
        if (seenIds.has(r.id)) continue;
        if (normalizedDomain && normalizeDomain(r.domain) !== normalizedDomain) continue;
        if (filterTags.length > 0 && !matchesTagSet(cache.reflectionTagSetById.get(r.id), filterTags, tagMode)) continue;
        if (cutoff !== undefined && r.timestamp < cutoff) continue;
        seenIds.add(r.id);
        selected.push(r);
      }
    } else {
      // Correctness fallback: single-pass filter, sort newest-first, dedupe, limit
      const filtered: ReflectionFrame[] = [];
      for (const r of store.reflections) {
        if (normalizedDomain && normalizeDomain(r.domain) !== normalizedDomain) continue;
        if (filterTags.length > 0 && !matchesTagSet(cache.reflectionTagSetById.get(r.id), filterTags, tagMode)) continue;
        if (cutoff !== undefined && r.timestamp < cutoff) continue;
        filtered.push(r);
      }
      filtered.sort((a, b) => compareStableText(b.timestamp, a.timestamp));
      selected = dedupeNewestFirst(filtered).slice(0, limit);
    }

    if (selected.length === 0) return null;
  }

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
      if (r.context_notes) rawLines.push(`- **Context notes:** ${r.context_notes}`);
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
  /**
   * Global unresolved affordance gaps across the entire store.
   * AffordanceGap records are not attributed to a domain.
   */
  active_affordance_gaps_global: number;
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

// ============================================================
// Heuristics export (Markdown / plaintext)
// ============================================================

export type HeuristicsExportFormat = "markdown" | "plaintext";

export interface HeuristicsExportOptions {
  domain?: string;
  tags?: string[];
  tag_mode?: TagFilterMode;
  min_confidence?: number;
  sort?: HeuristicSort;
  limit_per_domain?: number;
  format?: HeuristicsExportFormat;
}

export interface HeuristicsExportResult {
  content: string;
  format: HeuristicsExportFormat;
  heuristic_count: number;
  domain_count: number;
  scope: string;
}

/**
 * Build a Markdown or plaintext document of active heuristics grouped by domain.
 * Returns null when no active heuristics match the filters.
 */
export async function generateHeuristicsExport(
  options: HeuristicsExportOptions = {},
): Promise<HeuristicsExportResult | null> {
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
    candidates = candidates.filter((h) =>
      matchesTagSet(cache.heuristicTagSetById.get(h.id), filterTags, tagMode)
    );
  }
  candidates = candidates.filter((h) => h.confidence >= minConfidence);

  if (candidates.length === 0) return null;

  // --- Sort ---
  const sortCompare = (a: Heuristic, b: Heuristic): number => {
    switch (sort) {
      case "updated_at":
        return compareStableText(b.updated_at, a.updated_at);
      case "created_at":
        return compareStableText(b.created_at, a.created_at);
      case "reinforcement":
        return b.reinforcement_count - a.reinforcement_count;
      case "confidence":
        return b.confidence - a.confidence;
    }
  };
  candidates.sort(sortCompare);

  // --- Group by domain (alphabetical) ---
  const domainMap = new Map<string, Heuristic[]>();
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
  const scopeParts: string[] = [];
  if (options.domain) scopeParts.push(`domain: ${options.domain}`);
  if (options.tags && options.tags.length > 0) scopeParts.push(`tags: [${options.tags.join(", ")}]`);
  if (minConfidence > 0) scopeParts.push(`min_confidence: ${minConfidence}`);
  scopeParts.push(`sort: ${sort}`);
  scopeParts.push(`limit_per_domain: ${limitPerDomain}`);
  const scope = scopeParts.join(", ");

  // --- Render content ---
  const lines: string[] = [];
  const md = format === "markdown";
  const heading = md
    ? (level: number, text: string) => `${"#".repeat(level)} ${text}`
    : (_level: number, text: string) => text;
  const bold = md ? (t: string) => `**${t}**` : (t: string) => t;
  const bullet = (t: string) => `- ${t}`;

  lines.push(heading(1, "Active Heuristics Export"));
  lines.push("");
  lines.push(`${bold("Generated")}: ${fmtDate(new Date().toISOString())}`);
  lines.push(`${bold("Hermes version")}: ${VERSION}`);
  lines.push(`${bold("Scope")}: ${scope}`);
  lines.push(`${bold("Format")}: ${format}`);
  lines.push("");

  let totalCount = 0;
  for (const d of sortedDomains) {
    const group = domainMap.get(d)!;
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

export async function getDomainSummary(
  domain?: string,
  topN = 10,
  includeOpenQuestionsDetail = false,
): Promise<DomainSummary | DomainSummary[]> {
  const { cache, resolvedIndex } = await getCachedStoreAndResolvedQuestions();
  const store = cache.store;
  const hasAnyResolved = Object.keys(resolvedIndex).length > 0;

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
    return compareStableText(b.timestamp, a.timestamp);
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
      } else {
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

  const summaries: DomainSummary[] = [];
  for (const [d, entry] of domainMap.entries()) {
    summaries.push(buildSummary(d, entry));
  }
  summaries.sort((a, b) => b.reflection_count - a.reflection_count);
  return summaries.slice(0, topN);
}

export interface ContradictionReportEntry {
  id: string;
  domain: string;
  heuristic: string;
  contradiction_count: number;
  reinforcement_count: number;
  confidence: number;
  contradiction_notes: string[];
  superseded_by?: string;
  tags: string[];
}

export async function getContradictionReport(
  domain?: string,
  minContradictions = 1,
  limit = 20,
  includeArchived = false,
): Promise<ContradictionReportEntry[]> {
  const cache = await getCachedStoreEntry();
  const store = cache.store;
  const normalizedDomain = domain ? normalizeDomain(domain) : undefined;

  const results: ContradictionReportEntry[] = [];
  const compare = (a: ContradictionReportEntry, b: ContradictionReportEntry): number => {
    if (b.contradiction_count !== a.contradiction_count) return b.contradiction_count - a.contradiction_count;
    return a.confidence - b.confidence;
  };

  for (const h of store.heuristics) {
    if (h.contradiction_count < minContradictions) continue;
    if (!includeArchived && h.superseded_by) continue;
    if (normalizedDomain && normalizeDomain(h.domain) !== normalizedDomain) continue;

    insertSorted(
      results,
      {
        id: h.id,
        domain: h.domain,
        heuristic: safeHeuristicText(h.heuristic).slice(0, 200),
        contradiction_count: h.contradiction_count,
        reinforcement_count: h.reinforcement_count,
        confidence: h.confidence,
        contradiction_notes: [...(h.contradiction_notes ?? [])],
        superseded_by: h.superseded_by,
        tags: [...(h.tags ?? [])],
      },
      compare,
      limit,
    );
  }

  return results;
}

export interface StaleHeuristicEntry {
  id: string;
  domain: string;
  heuristic: string;
  retention: number;
  reinforcement_count: number;
  retrieval_count: number;
  confidence: number;
  days_since_last_activity: number;
  tags: string[];
}

export async function getStaleHeuristics(
  domain?: string,
  retentionThreshold = 0.3,
  minAgeDays = 7,
  limit = 20,
  includePinned = false,
): Promise<StaleHeuristicEntry[]> {
  const cache = await getCachedStoreEntry();
  const store = cache.store;
  const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
  const now = Date.now();

  const results: StaleHeuristicEntry[] = [];
  const compare = (a: StaleHeuristicEntry, b: StaleHeuristicEntry): number => a.retention - b.retention;

  for (const h of store.heuristics) {
    if (h.superseded_by) continue;
    if (!includePinned && h.pinned) continue;
    if (normalizedDomain && normalizeDomain(h.domain) !== normalizedDomain) continue;

    const retention = ebbinghausRetention(h);
    if (retention >= retentionThreshold) continue;

    const referenceTime = h.last_retrieved_at ?? h.updated_at ?? h.created_at;
    const referenceMs = Date.parse(referenceTime);
    let daysSinceLastActivity: number;
    if (!Number.isFinite(referenceMs)) {
      daysSinceLastActivity = -1;
    } else {
      daysSinceLastActivity = Math.max(0, (now - referenceMs) / (1000 * 60 * 60 * 24));
    }

    const effectiveDays = Number.isFinite(referenceMs) ? daysSinceLastActivity : Infinity;
    if (effectiveDays < minAgeDays) continue;

    insertSorted(
      results,
      {
        id: h.id,
        domain: h.domain,
        heuristic: safeHeuristicText(h.heuristic).slice(0, 200),
        retention: Number(retention.toFixed(3)),
        reinforcement_count: h.reinforcement_count,
        retrieval_count: h.retrieval_count ?? 0,
        confidence: h.confidence,
        days_since_last_activity: Number.isFinite(daysSinceLastActivity) ? Math.floor(daysSinceLastActivity) : -1,
        tags: [...(h.tags ?? [])],
      },
      compare,
      limit,
    );
  }

  return results;
}
