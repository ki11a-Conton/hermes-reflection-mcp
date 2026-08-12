import { createHash } from "node:crypto";
import type { MemoryScope, ReflectionFrame, ReviewCandidate } from "../types.js";
import {
  exportData,
  reviewCandidateEvidenceFingerprint,
  safeHeuristicText,
  scanHeuristicThreats,
} from "../storage.js";
import {
  getLlmReviewReadiness,
  getLlmReviewSemanticFingerprint,
  getLlmReviewSourceFingerprint,
  runLlmReview,
  type LlmReviewResult,
} from "./llm_review.js";
import { redactSensitiveText } from "./redaction.js";
import { autoApplyReviewCandidate, enqueueReviewCandidates } from "./review_queue.js";
import { semanticReviewRiskReasons } from "./review_risk.js";

export const MAX_RECENT_REFLECTIONS = 10;
export const MAX_FULL_REFLECTIONS = 200;
export const MAX_REVIEW_CANDIDATES = 50;

interface ExtractedReviewCandidate {
  heuristic: string;
  source_reflection_ids: string[];
  domain: string;
  confidence: number;
  tags: string[];
  skipped_reason?: string;
  threat_patterns?: string[];
  risk_reasons?: string[];
}

const inFlight = new Map<string, Promise<ReviewEngineResult>>();

export interface RunReviewOptions {
  session_id: string;
  scope: MemoryScope;
  stage: "deterministic" | "llm";
  source_fingerprint: string;
  review_scope: "recent" | "full";
  review_mode: "deterministic" | "llm" | "auto";
  auto_apply: boolean;
  signal?: AbortSignal;
  beforeApply?: () => Promise<boolean>;
  before_apply?: () => Promise<void>;
  withApplyLease?: <T>(operation: () => Promise<T>) => Promise<T | undefined>;
}

export interface ReviewEngineResult {
  success: boolean;
  session_id: string;
  review_scope: "recent" | "full";
  review_mode_requested: "deterministic" | "llm" | "auto";
  review_mode_used?: "deterministic" | "llm";
  auto_apply: boolean;
  auto_apply_blocked?: string;
  fallback_reason?: string;
  error_class?: string;
  error?: string;
  capabilities: {
    heuristic_candidates: true;
    memory_candidates: false;
    user_profile_candidates: false;
    skill_suggestions: false;
    llm_review: boolean;
  };
  limits: {
    max_recent_reflections: number;
    max_full_reflections: number;
    max_candidates: number;
  };
  source_reflection_ids: string[];
  source_fingerprint: string;
  review_summary?: string;
  review_open_questions?: string[];
  candidate_heuristics: ReviewCandidate[];
  candidate_memory_entries: [];
  candidate_user_profile_entries: [];
  skipped_items: ReviewCandidate[];
  llm?: Omit<LlmReviewResult, "candidates" | "open_questions" | "summary">;
  applied: {
    heuristics_added: number;
    heuristics_reinforced: number;
    heuristic_ids: string[];
    all_processed_heuristic_ids: string[];
  };
}

export function normalizeCandidateText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function reviewSingleFlightKey(options: RunReviewOptions): string {
  return createHash("sha256").update(JSON.stringify({
    session_id: options.session_id,
    target_scope: options.scope,
    review_scope: options.review_scope,
    stage: options.stage,
    review_mode: options.review_mode,
    source_fingerprint: options.source_fingerprint,
    auto_apply: options.auto_apply,
    provider_semantic_fingerprint: options.review_mode === "deterministic"
      ? "not-applicable"
      : getLlmReviewSemanticFingerprint(),
  }), "utf8").digest("hex");
}

export function inFlightReview(options: RunReviewOptions): Promise<ReviewEngineResult> | undefined {
  return inFlight.get(reviewSingleFlightKey(options));
}

export function mayAutoApply(candidate: ReviewCandidate): boolean {
  return candidate.confidence >= 0.85
    && candidate.risk_reasons.length === 0
    && candidate.state === "pending"
    && candidate.heuristic.length <= 1_000
    && candidate.source_reflection_ids.length > 0;
}

function strictDerivedText(value: string): string {
  return redactSensitiveText(value, { strictHistorical: true }).trim();
}

function boundedCandidateText(value: string): string {
  return Array.from(value).slice(0, 1_000).join("");
}

function conflictShape(value: string): { key: string; negative: boolean } {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const negative = /\b(?:never|not|disable|avoid|forbid|without)\b/.test(normalized);
  return {
    negative,
    key: normalized
      .replace(/\b(?:always|never|not|do|must|should|enable|disable|avoid|forbid|without)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

function conflictsWithExisting(candidate: string, existing: Set<string>): boolean {
  const shape = conflictShape(candidate);
  if (!shape.key) return false;
  for (const current of existing) {
    const other = conflictShape(current);
    if (other.key === shape.key && other.negative !== shape.negative) return true;
  }
  return false;
}

function extractedRiskReasons(raw: string, sanitized: string, sourceIds: string[], threats: string[]): string[] {
  const rawNormalized = raw.trim().replace(/\s+/g, " ");
  const safeNormalized = sanitized.trim().replace(/\s+/g, " ");
  return [...new Set([
    ...(Array.from(raw).length > 1_000 ? ["oversized_payload"] : []),
    ...(rawNormalized !== safeNormalized && /\[REDACTED/i.test(sanitized) ? ["secret_or_credential"] : []),
    ...semanticReviewRiskReasons(raw),
    ...(threats.length > 0 ? ["injection_or_threat"] : []),
    ...threats.map((threat) => `threat:${threat}`),
    ...(sourceIds.length === 0 ? ["missing_evidence"] : []),
  ])];
}

export function buildDeterministicReviewCandidates(
  reflections: ReflectionFrame[],
  existingHeuristics: Set<string>,
): ExtractedReviewCandidate[] {
  const seen = new Set(existingHeuristics);
  const candidates: ExtractedReviewCandidate[] = [];
  for (const reflection of reflections) {
    for (const lesson of reflection.lessons_learned) {
      const sanitized = strictDerivedText(lesson);
      const heuristic = boundedCandidateText(sanitized);
      if (!heuristic) continue;
      const normalized = normalizeCandidateText(heuristic);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const threatPatterns = scanHeuristicThreats(lesson, "strict");
      candidates.push({
        heuristic: threatPatterns.length > 0 ? safeHeuristicText(heuristic) : heuristic,
        source_reflection_ids: [reflection.id],
        domain: reflection.domain,
        confidence: 0.65,
        tags: [...new Set([...(reflection.tags ?? []), "background-review"])],
        skipped_reason: threatPatterns.length > 0 ? "threat_pattern_detected" : undefined,
        threat_patterns: threatPatterns.length > 0 ? threatPatterns : undefined,
        risk_reasons: extractedRiskReasons(lesson, sanitized, [reflection.id], threatPatterns),
      });
    }
  }
  return candidates;
}

export function reviewSourceFingerprint(
  reflections: ReflectionFrame[],
  stage: "deterministic" | "llm" = "deterministic",
): string {
  if (stage === "llm") return getLlmReviewSourceFingerprint(reflections);
  const source = reflections.map((item) => ({
    id: item.id,
    timestamp: item.timestamp,
    domain: item.domain,
    task_goal: strictDerivedText(item.task_goal),
    outcome: item.task_outcome,
    summary: strictDerivedText(item.task_state.summary),
    summary_sections: (item.task_state.summary_sections ?? []).map((section) => ({
      title: strictDerivedText(section.title),
      content: strictDerivedText(section.content),
    })),
    blockers: item.task_state.immediate_blockers.map(strictDerivedText),
    lessons: item.lessons_learned.map(strictDerivedText),
    open_questions: item.open_questions
      .filter((question) => !question.resolved)
      .map((question) => strictDerivedText(question.question)),
  }));
  return createHash("sha256").update(JSON.stringify(source), "utf8").digest("hex");
}

function llmCandidates(
  llm: LlmReviewResult,
  existingHeuristics: Set<string>,
): ExtractedReviewCandidate[] {
  const seen = new Set(existingHeuristics);
  const candidates: ExtractedReviewCandidate[] = [];
  for (const item of llm.candidates) {
    const heuristic = strictDerivedText(item.heuristic);
    if (!heuristic) continue;
    const normalized = normalizeCandidateText(heuristic);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const threatPatterns = scanHeuristicThreats(heuristic, "strict");
    candidates.push({
      heuristic: threatPatterns.length > 0 ? safeHeuristicText(heuristic) : heuristic,
      source_reflection_ids: [...item.source_reflection_ids],
      domain: item.domain,
      confidence: item.confidence,
      tags: [...new Set([...item.tags, "background-review"])],
      skipped_reason: threatPatterns.length > 0 ? "threat_pattern_detected" : undefined,
      threat_patterns: threatPatterns.length > 0 ? threatPatterns : undefined,
      risk_reasons: item.risk_reasons,
    });
  }
  return candidates;
}

function sanitizeLlmAudit(
  result: LlmReviewResult,
): Omit<LlmReviewResult, "candidates" | "open_questions" | "summary"> {
  const { candidates: _candidates, open_questions: _openQuestions, summary: _summary, ...audit } = result;
  return audit;
}

export async function runReview(options: RunReviewOptions): Promise<ReviewEngineResult> {
  const store = await exportData();
  // Scope is an authorization boundary, not a label. Filter it before source
  // selection, fingerprinting, provider input, or heuristic comparisons.
  const allSessionReflections = store.reflections
    .filter((reflection) => reflection.session_id === options.session_id && reflection.scope === options.scope)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const reviewedReflections = options.review_scope === "recent"
    ? allSessionReflections.slice(-MAX_RECENT_REFLECTIONS)
    : allSessionReflections.slice(-MAX_FULL_REFLECTIONS);
  const existingHeuristics = new Set(
    store.heuristics
      .filter((heuristic) => !heuristic.superseded_by && heuristic.scope === options.scope)
      .map((heuristic) => normalizeCandidateText(heuristic.heuristic)),
  );
  const requestedStage: "deterministic" | "llm" = options.review_mode === "deterministic"
    ? "deterministic"
    : options.stage;
  const fingerprint = reviewSourceFingerprint(reviewedReflections, requestedStage);
  let modeUsed: "deterministic" | "llm" = "deterministic";
  let fallbackReason: string | undefined;
  let llmResult: LlmReviewResult | undefined;
  let candidateHeuristics: ExtractedReviewCandidate[];

  if (options.review_mode === "llm" || options.review_mode === "auto") {
    llmResult = await runLlmReview(reviewedReflections, { signal: options.signal });
    if (llmResult.success) {
      modeUsed = "llm";
      candidateHeuristics = llmCandidates(llmResult, existingHeuristics);
    } else if (options.review_mode === "llm") {
      return {
        success: false,
        session_id: options.session_id,
        review_scope: options.review_scope,
        review_mode_requested: options.review_mode,
        auto_apply: options.auto_apply,
        error_class: llmResult.error_class,
        error: llmResult.error,
        capabilities: {
          heuristic_candidates: true,
          memory_candidates: false,
          user_profile_candidates: false,
          skill_suggestions: false,
          llm_review: true,
        },
        limits: {
          max_recent_reflections: MAX_RECENT_REFLECTIONS,
          max_full_reflections: MAX_FULL_REFLECTIONS,
          max_candidates: MAX_REVIEW_CANDIDATES,
        },
        source_reflection_ids: reviewedReflections.map((reflection) => reflection.id),
        source_fingerprint: fingerprint,
        candidate_heuristics: [],
        candidate_memory_entries: [],
        candidate_user_profile_entries: [],
        skipped_items: [],
        llm: sanitizeLlmAudit(llmResult),
        applied: {
          heuristics_added: 0,
          heuristics_reinforced: 0,
          heuristic_ids: [],
          all_processed_heuristic_ids: [],
        },
      };
    } else {
      fallbackReason = llmResult.error_class ?? "llm_unavailable";
      candidateHeuristics = buildDeterministicReviewCandidates(reviewedReflections, existingHeuristics);
    }
  } else {
    candidateHeuristics = buildDeterministicReviewCandidates(reviewedReflections, existingHeuristics);
  }

  candidateHeuristics = candidateHeuristics.slice(0, MAX_REVIEW_CANDIDATES);
  const exactSources = new Map(reviewedReflections.map((reflection) => [reflection.id, reflection]));
  const providerSources = new Set(modeUsed === "llm"
    ? (llmResult?.source_reflection_ids ?? [])
    : reviewedReflections.map((reflection) => reflection.id));
  for (const candidate of candidateHeuristics) {
    const uniqueIds = [...new Set(candidate.source_reflection_ids)];
    const evidenceValid = candidate.source_reflection_ids.length > 0
      && uniqueIds.length === candidate.source_reflection_ids.length
      && uniqueIds.every((id) => providerSources.has(id)
        && exactSources.get(id)?.scope === options.scope);
    if (!evidenceValid) {
      candidate.risk_reasons = [...new Set([...(candidate.risk_reasons ?? []), "missing_or_invalid_evidence"] )];
    } else if (!uniqueIds.some((id) => exactSources.get(id)?.task_outcome === "success")) {
      candidate.risk_reasons = [...new Set([...(candidate.risk_reasons ?? []), "unresolved_failure"] )];
    }
  }
  for (const candidate of candidateHeuristics) {
    if (conflictsWithExisting(candidate.heuristic, existingHeuristics)) {
      candidate.risk_reasons = [...new Set([...(candidate.risk_reasons ?? []), "conflicting_memory"])];
    }
  }
  const scope = options.scope;
  if (options.source_fingerprint && options.source_fingerprint !== fingerprint) {
    throw new Error("Review source changed before candidate generation");
  }
  const persistedCandidates = await enqueueReviewCandidates(candidateHeuristics.map((candidate) => ({
    scope,
    stage: modeUsed,
    source_fingerprint: fingerprint,
    evidence_fingerprint: reviewCandidateEvidenceFingerprint(reviewedReflections, candidate.source_reflection_ids),
    source_reflection_ids: candidate.source_reflection_ids.slice(0, 50),
    heuristic: candidate.heuristic,
    domain: candidate.domain,
    tags: candidate.tags,
    confidence: candidate.confidence,
    risk_reasons: [
      ...(candidate.skipped_reason ? [candidate.skipped_reason] : []),
      ...(candidate.threat_patterns ?? []),
      ...(candidate.risk_reasons ?? []),
    ],
  })));
  const skipped = persistedCandidates.filter((candidate) => candidate.risk_reasons.length > 0);
  const autoApplyCandidates = persistedCandidates.filter(mayAutoApply);
  const existingHeuristicIds = new Set(store.heuristics.map((heuristic) => heuristic.id));
  const applied = {
    heuristics_added: 0,
    heuristics_reinforced: 0,
    heuristic_ids: [] as string[],
    all_processed_heuristic_ids: [] as string[],
  };
  let autoApplyBlocked: string | undefined;

  if (options.auto_apply && store.metadata?.write_approval === true) {
    autoApplyBlocked = "write_approval_enabled";
  } else if (options.auto_apply && autoApplyCandidates.length > 0) {
    if (options.before_apply) await options.before_apply();
    const apply = async () => {
      const results = [] as Array<{ heuristic_id: string }>;
      for (const candidate of autoApplyCandidates) {
        const result = await autoApplyReviewCandidate(candidate);
        if (result) {
          candidate.state = "applied";
          results.push(result);
        }
      }
      return results;
    };
    const leaseCurrent = options.beforeApply ? await options.beforeApply() : true;
    const saved = leaseCurrent
      ? (options.withApplyLease ? await options.withApplyLease(apply) : await apply())
      : undefined;
    if (!saved) {
      autoApplyBlocked = "stale_background_lease";
    } else {
      const added = saved.filter((item) => !existingHeuristicIds.has(item.heuristic_id));
      applied.heuristics_added = added.length;
      applied.heuristics_reinforced = saved.length - added.length;
      applied.heuristic_ids = added.map((item) => item.heuristic_id);
      applied.all_processed_heuristic_ids = saved.map((item) => item.heuristic_id);
    }
  }

  return {
    success: true,
    session_id: options.session_id,
    review_scope: options.review_scope,
    review_mode_requested: options.review_mode,
    review_mode_used: modeUsed,
    auto_apply: options.auto_apply,
    auto_apply_blocked: autoApplyBlocked,
    fallback_reason: fallbackReason,
    capabilities: {
      heuristic_candidates: true,
      memory_candidates: false,
      user_profile_candidates: false,
      skill_suggestions: false,
      llm_review: true,
    },
    limits: {
      max_recent_reflections: MAX_RECENT_REFLECTIONS,
      max_full_reflections: MAX_FULL_REFLECTIONS,
      max_candidates: MAX_REVIEW_CANDIDATES,
    },
    source_reflection_ids: reviewedReflections.map((reflection) => reflection.id),
    source_fingerprint: fingerprint,
    review_summary: modeUsed === "llm" ? llmResult?.summary : undefined,
    review_open_questions: modeUsed === "llm" ? llmResult?.open_questions : undefined,
    candidate_heuristics: persistedCandidates,
    candidate_memory_entries: [],
    candidate_user_profile_entries: [],
    skipped_items: skipped,
    llm: llmResult ? sanitizeLlmAudit(llmResult) : undefined,
    applied,
  };
}

export function runReviewSingleFlight(options: RunReviewOptions): Promise<ReviewEngineResult> {
  const key = reviewSingleFlightKey(options);
  const current = inFlight.get(key);
  if (current) return current;
  const started = runReview(options).finally(() => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

export async function getReviewSourceState(
  sessionId: string,
  reviewScope: "recent" | "full" = "recent",
  requestedScope?: MemoryScope,
  stage: "deterministic" | "llm" = "deterministic",
): Promise<{ source_fingerprint: string; reflection_count: number; scope?: MemoryScope }> {
  const store = await exportData();
  const sessionReflections = store.reflections.filter((reflection) => reflection.session_id === sessionId);
  const scopes = new Set(sessionReflections.map((reflection) => reflection.scope));
  if (!requestedScope && scopes.size > 1) {
    throw new Error("Review source scope is ambiguous; provide the persisted session scope");
  }
  const scope = requestedScope ?? sessionReflections[0]?.scope;
  const allSessionReflections = sessionReflections
    .filter((reflection) => reflection.scope === scope)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const reviewed = reviewScope === "recent"
    ? allSessionReflections.slice(-MAX_RECENT_REFLECTIONS)
    : allSessionReflections.slice(-MAX_FULL_REFLECTIONS);
  return {
    source_fingerprint: reviewSourceFingerprint(reviewed, stage),
    reflection_count: reviewed.length,
    ...(scope ? { scope } : {}),
  };
}

export function getReviewReadinessStatus(): ReturnType<typeof getLlmReviewReadiness> {
  return getLlmReviewReadiness();
}
