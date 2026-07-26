import { createHash } from "node:crypto";
import type { ReflectionFrame } from "../types.js";
import {
  exportData,
  safeHeuristicText,
  scanHeuristicThreats,
  upsertHeuristicsBatch,
} from "../storage.js";
import { getLlmReviewReadiness, runLlmReview, type LlmReviewResult } from "./llm_review.js";
import { redactSensitiveText } from "./redaction.js";

export const MAX_RECENT_REFLECTIONS = 10;
export const MAX_FULL_REFLECTIONS = 200;
export const MAX_REVIEW_CANDIDATES = 50;

export interface ReviewCandidate {
  heuristic: string;
  source_reflection_id: string;
  domain: string;
  confidence: number;
  tags: string[];
  skipped_reason?: string;
  threat_patterns?: string[];
}

export interface RunReviewOptions {
  session_id: string;
  review_scope: "recent" | "full";
  review_mode: "deterministic" | "llm" | "auto";
  auto_apply: boolean;
  signal?: AbortSignal;
  beforeApply?: () => Promise<boolean>;
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

function strictDerivedText(value: string): string {
  return redactSensitiveText(value, { strictHistorical: true }).trim();
}

export function buildDeterministicReviewCandidates(
  reflections: ReflectionFrame[],
  existingHeuristics: Set<string>,
): ReviewCandidate[] {
  const seen = new Set(existingHeuristics);
  const candidates: ReviewCandidate[] = [];
  for (const reflection of reflections) {
    for (const lesson of reflection.lessons_learned) {
      const heuristic = strictDerivedText(lesson);
      if (!heuristic) continue;
      const normalized = normalizeCandidateText(heuristic);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const threatPatterns = scanHeuristicThreats(heuristic, "strict");
      candidates.push({
        heuristic: threatPatterns.length > 0 ? safeHeuristicText(heuristic) : heuristic,
        source_reflection_id: reflection.id,
        domain: reflection.domain,
        confidence: 0.65,
        tags: [...new Set([...(reflection.tags ?? []), "background-review"])],
        skipped_reason: threatPatterns.length > 0 ? "threat_pattern_detected" : undefined,
        threat_patterns: threatPatterns.length > 0 ? threatPatterns : undefined,
      });
    }
  }
  return candidates;
}

export function reviewSourceFingerprint(reflections: ReflectionFrame[]): string {
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
  fallbackSourceId: string,
): ReviewCandidate[] {
  const seen = new Set(existingHeuristics);
  const candidates: ReviewCandidate[] = [];
  for (const item of llm.candidates) {
    const heuristic = strictDerivedText(item.heuristic);
    if (!heuristic) continue;
    const normalized = normalizeCandidateText(heuristic);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const threatPatterns = scanHeuristicThreats(heuristic, "strict");
    candidates.push({
      heuristic: threatPatterns.length > 0 ? safeHeuristicText(heuristic) : heuristic,
      source_reflection_id: llm.source_reflection_ids[0] ?? fallbackSourceId,
      domain: item.domain,
      confidence: item.confidence,
      tags: [...new Set([...item.tags, "background-review"])],
      skipped_reason: threatPatterns.length > 0 ? "threat_pattern_detected" : undefined,
      threat_patterns: threatPatterns.length > 0 ? threatPatterns : undefined,
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
  const allSessionReflections = store.reflections
    .filter((reflection) => reflection.session_id === options.session_id)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const reviewedReflections = options.review_scope === "recent"
    ? allSessionReflections.slice(-MAX_RECENT_REFLECTIONS)
    : allSessionReflections.slice(-MAX_FULL_REFLECTIONS);
  const existingHeuristics = new Set(
    store.heuristics
      .filter((heuristic) => !heuristic.superseded_by)
      .map((heuristic) => normalizeCandidateText(heuristic.heuristic)),
  );
  const fingerprint = reviewSourceFingerprint(reviewedReflections);
  let modeUsed: "deterministic" | "llm" = "deterministic";
  let fallbackReason: string | undefined;
  let llmResult: LlmReviewResult | undefined;
  let candidateHeuristics: ReviewCandidate[];

  if (options.review_mode === "llm" || options.review_mode === "auto") {
    llmResult = await runLlmReview(reviewedReflections, { signal: options.signal });
    if (llmResult.success) {
      modeUsed = "llm";
      candidateHeuristics = llmCandidates(llmResult, existingHeuristics, options.session_id);
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
  const skipped = candidateHeuristics.filter((candidate) => candidate.skipped_reason);
  const safeCandidates = candidateHeuristics.filter((candidate) => !candidate.skipped_reason);
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
  } else if (options.auto_apply && safeCandidates.length > 0) {
    const apply = () => upsertHeuristicsBatch(safeCandidates.map((candidate) => ({
        domain: candidate.domain,
        heuristic: candidate.heuristic,
        source_task: modeUsed === "deterministic"
          ? `background_review:${options.session_id}`
          : `llm_background_review:${options.session_id}`,
        session_id: options.session_id,
        confidence: candidate.confidence,
        tags: candidate.tags,
      })));
    const leaseCurrent = options.beforeApply ? await options.beforeApply() : true;
    const saved = leaseCurrent
      ? (options.withApplyLease ? await options.withApplyLease(apply) : await apply())
      : undefined;
    if (!saved) {
      autoApplyBlocked = "stale_background_lease";
    } else {
      const added = saved.filter((item) => !existingHeuristicIds.has(item.id));
      applied.heuristics_added = added.length;
      applied.heuristics_reinforced = saved.length - added.length;
      applied.heuristic_ids = added.map((item) => item.id);
      applied.all_processed_heuristic_ids = saved.map((item) => item.id);
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
    candidate_heuristics: candidateHeuristics,
    candidate_memory_entries: [],
    candidate_user_profile_entries: [],
    skipped_items: skipped,
    llm: llmResult ? sanitizeLlmAudit(llmResult) : undefined,
    applied,
  };
}

export async function getReviewSourceState(
  sessionId: string,
  reviewScope: "recent" | "full" = "recent",
): Promise<{ source_fingerprint: string; reflection_count: number }> {
  const store = await exportData();
  const allSessionReflections = store.reflections
    .filter((reflection) => reflection.session_id === sessionId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const reviewed = reviewScope === "recent"
    ? allSessionReflections.slice(-MAX_RECENT_REFLECTIONS)
    : allSessionReflections.slice(-MAX_FULL_REFLECTIONS);
  return { source_fingerprint: reviewSourceFingerprint(reviewed), reflection_count: reviewed.length };
}

export function getReviewReadinessStatus(): ReturnType<typeof getLlmReviewReadiness> {
  return getLlmReviewReadiness();
}
