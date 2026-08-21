import { createHash } from "node:crypto";
import {
  commitSkillPromotionFingerprint,
  dirtySkillPromotionScopes,
  enqueueSkillCandidateRecords,
  getSkillPromotionSnapshot,
  MAX_SKILL_CANDIDATES_PER_BATCH,
  SKILL_CANDIDATE_CAPACITY_CODE,
  skillCandidateIdsExist,
  skillPromotionEvidenceFingerprint,
  type SkillCandidateDraft,
} from "../storage.js";
import type {
  MemoryScope,
  SkillPromotionCandidate,
  SkillPromotionDirtyScope,
  SkillRecord,
} from "../types.js";
import {
  buildPromotionClusters,
  matchPromotionTarget,
  SKILL_CLUSTER_ALGORITHM,
  type PromotionCluster,
  type PromotionSnapshot,
} from "./learning/skill_promotion.js";
import {
  getSkillSynthesisSemanticFingerprint,
  synthesizeSkillRevision,
  type SkillSynthesisResult,
} from "./skill_synthesis.js";
import { canonicalizeStable, compareStableText } from "./stable_order.js";

export interface SkillPromotionRunOptions {
  scope: MemoryScope;
  signal?: AbortSignal;
  before_apply?: () => Promise<boolean>;
  with_apply_lease?: <T>(operation: () => Promise<T>) => Promise<T | undefined>;
}

export interface SkillPromotionRunResult {
  success: boolean;
  scope: MemoryScope;
  source_fingerprint: string;
  outcome_class: string;
  candidate_ids: string[];
  generated: number;
  skipped: number;
}

export interface SkillPromotionDependencies {
  dirty_scopes: () => Promise<SkillPromotionDirtyScope[]>;
  snapshot: (scope: MemoryScope) => Promise<PromotionSnapshot>;
  semantic_fingerprint: () => string;
  evidence_fingerprint: (
    snapshot: PromotionSnapshot,
    sourceHeuristicIds: string[],
    sourceReflectionIds: string[],
  ) => string;
  synthesize: (
    cluster: PromotionCluster,
    snapshot: PromotionSnapshot,
    target: SkillRecord | undefined,
    options: { signal?: AbortSignal },
  ) => Promise<SkillSynthesisResult>;
  enqueue: (drafts: SkillCandidateDraft[]) => Promise<SkillPromotionCandidate[]>;
  candidates_exist: (ids: string[]) => Promise<boolean>;
  commit: (
    scope: MemoryScope,
    dirtyAt: string,
    fingerprint: string,
    outcomeClass: string,
    candidateIds: string[],
  ) => Promise<boolean>;
}

const defaultDependencies: SkillPromotionDependencies = {
  dirty_scopes: dirtySkillPromotionScopes,
  snapshot: getSkillPromotionSnapshot,
  semantic_fingerprint: getSkillSynthesisSemanticFingerprint,
  evidence_fingerprint: skillPromotionEvidenceFingerprint,
  synthesize: synthesizeSkillRevision,
  enqueue: enqueueSkillCandidateRecords,
  candidates_exist: skillCandidateIdsExist,
  commit: commitSkillPromotionFingerprint,
};

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeStable(value)), "utf8").digest("hex");
}

function currentSkillProjection(skill: SkillRecord): Record<string, unknown> {
  const revision = skill.revisions.find((item) => item.revision === skill.current_revision);
  return {
    id: skill.id,
    status: skill.status,
    current_revision: skill.current_revision,
    current_content_hash: revision?.content_hash,
    updated_at: skill.updated_at,
  };
}

function promotionSourceFingerprint(
  snapshot: PromotionSnapshot,
  clusters: readonly PromotionCluster[],
  semanticFingerprint: string,
): string {
  return fingerprint({
    algorithm: SKILL_CLUSTER_ALGORITHM,
    scope: snapshot.scope,
    cluster_fingerprints: clusters.map((cluster) => cluster.fingerprint).sort(compareStableText),
    skills: [...snapshot.skills]
      .sort((left, right) => compareStableText(left.id, right.id))
      .map(currentSkillProjection),
    synthesis_semantic_fingerprint: semanticFingerprint,
  });
}

function result(
  scope: MemoryScope,
  sourceFingerprint: string,
  outcomeClass: string,
  success: boolean,
  candidateIds: string[] = [],
  generated = 0,
  skipped = 0,
): SkillPromotionRunResult {
  return {
    success,
    scope,
    source_fingerprint: sourceFingerprint,
    outcome_class: outcomeClass,
    candidate_ids: candidateIds,
    generated,
    skipped,
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function runPromotion(
  options: SkillPromotionRunOptions,
  dependencies: SkillPromotionDependencies,
): Promise<SkillPromotionRunResult> {
  const emptyFingerprint = fingerprint({ algorithm: SKILL_CLUSTER_ALGORITHM, scope: options.scope, state: "not_loaded" });
  let latestSourceFingerprint = emptyFingerprint;
  if (isAborted(options.signal)) return result(options.scope, emptyFingerprint, "aborted", false);

  try {
    const dirty = (await dependencies.dirty_scopes()).find((item) => item.scope === options.scope);
    if (dirty === undefined) {
      return result(options.scope, fingerprint({ algorithm: SKILL_CLUSTER_ALGORITHM, scope: options.scope, state: "not_dirty" }), "not_dirty", true);
    }
    if (isAborted(options.signal)) return result(options.scope, emptyFingerprint, "aborted", false);

    const snapshot = await dependencies.snapshot(options.scope);
    if (snapshot.scope !== options.scope) {
      return result(options.scope, emptyFingerprint, "scope_mismatch", false);
    }
    const clusters = buildPromotionClusters(snapshot);
    const sourceFingerprint = promotionSourceFingerprint(
      snapshot,
      clusters,
      dependencies.semantic_fingerprint(),
    );
    latestSourceFingerprint = sourceFingerprint;
    if (isAborted(options.signal)) return result(options.scope, sourceFingerprint, "aborted", false);

    if (dirty.completed_fingerprint === sourceFingerprint) {
      const reconcile = async (): Promise<"aborted" | "lease_lost" | "unchanged" | "dirty_state_changed"> => {
        if (isAborted(options.signal)) return "aborted";
        if (options.before_apply && !await options.before_apply()) return "lease_lost";
        if (isAborted(options.signal)) return "aborted";
        return await dependencies.commit(
          options.scope,
          dirty.dirty_at,
          sourceFingerprint,
          "unchanged",
          [],
        ) ? "unchanged" : "dirty_state_changed";
      };
      const reconciled = options.with_apply_lease
        ? await options.with_apply_lease(reconcile)
        : await reconcile();
      const outcome = reconciled ?? "lease_lost";
      return result(
        options.scope,
        sourceFingerprint,
        outcome,
        outcome === "unchanged",
      );
    }

    const drafts: SkillCandidateDraft[] = [];
    let providerFallbacks = 0;
    for (const cluster of clusters) {
      if (isAborted(options.signal)) return result(options.scope, sourceFingerprint, "aborted", false);
      const targetMatch = matchPromotionTarget(cluster, snapshot.skills);
      const target = targetMatch.target_skill_id
        ? snapshot.skills.find((skill) => skill.id === targetMatch.target_skill_id)
        : undefined;
      const synthesis = await dependencies.synthesize(cluster, snapshot, target, { signal: options.signal });
      if (isAborted(options.signal)) return result(options.scope, sourceFingerprint, "aborted", false);
      if (!synthesis.success) providerFallbacks += 1;
      const riskReasons = [...new Set([...cluster.risk_reasons, ...targetMatch.risk_reasons])]
        .sort(compareStableText);
      drafts.push({
        action: targetMatch.action,
        scope: options.scope,
        ...(targetMatch.target_skill_id ? { target_skill_id: targetMatch.target_skill_id } : {}),
        ...(targetMatch.expected_target_revision !== undefined
          ? { expected_target_revision: targetMatch.expected_target_revision }
          : {}),
        proposed_revision: synthesis.revision,
        source_heuristic_ids: [...cluster.heuristic_ids],
        source_reflection_ids: [...cluster.reflection_ids],
        cluster_algorithm: SKILL_CLUSTER_ALGORITHM,
        cluster_fingerprint: cluster.fingerprint,
        evidence_fingerprint: dependencies.evidence_fingerprint(
          snapshot,
          cluster.heuristic_ids,
          cluster.reflection_ids,
        ),
        confidence: cluster.confidence,
        risk: riskReasons.length === 0 ? "low" : "high",
        risk_reasons: riskReasons,
        created_at: synthesis.revision.created_at,
      });
    }

    const desiredOutcome = clusters.length === 0
      ? "no_eligible_candidates"
      : drafts.some((draft) => draft.risk_reasons.length > 0)
        ? "blocked_candidates"
        : providerFallbacks > 0
          ? "provider_fallback"
          : "success";

    type PersistResult =
      | { state: "aborted" | "lease_lost" | "candidate_persistence_unverified" | "dirty_state_changed" }
      | { state: "committed"; candidates: SkillPromotionCandidate[]; outcomeClass: string };
    const persist = async (): Promise<PersistResult> => {
      if (isAborted(options.signal)) return { state: "aborted" };
      if (options.before_apply && !await options.before_apply()) return { state: "lease_lost" };
      if (isAborted(options.signal)) return { state: "aborted" };
      const candidates: SkillPromotionCandidate[] = [];
      for (let offset = 0; offset < drafts.length; offset += MAX_SKILL_CANDIDATES_PER_BATCH) {
        if (isAborted(options.signal)) return { state: "aborted" };
        if (options.before_apply && !await options.before_apply()) return { state: "lease_lost" };
        const batch = drafts.slice(offset, offset + MAX_SKILL_CANDIDATES_PER_BATCH);
        candidates.push(...await dependencies.enqueue(batch));
      }
      const candidateIds = candidates.map((candidate) => candidate.id);
      if (!await dependencies.candidates_exist(candidateIds)) {
        return { state: "candidate_persistence_unverified" };
      }
      if (isAborted(options.signal)) return { state: "aborted" };
      const persistedOutcome = candidates.some((candidate) => candidate.state === "rejected")
        ? "blocked_candidates"
        : desiredOutcome;
      const committed = await dependencies.commit(
        options.scope,
        dirty.dirty_at,
        sourceFingerprint,
        persistedOutcome,
        candidateIds,
      );
      return committed
        ? { state: "committed", candidates, outcomeClass: persistedOutcome }
        : { state: "dirty_state_changed" };
    };

    const persisted = options.with_apply_lease
      ? await options.with_apply_lease(persist)
      : await persist();
    if (persisted === undefined) return result(options.scope, sourceFingerprint, "lease_lost", false);
    if (persisted.state !== "committed") {
      return result(options.scope, sourceFingerprint, persisted.state, false);
    }
    const candidateIds = persisted.candidates.map((candidate) => candidate.id);
    return result(
      options.scope,
      sourceFingerprint,
      persisted.outcomeClass,
      true,
      candidateIds,
      candidateIds.length,
      Math.max(0, clusters.length - candidateIds.length),
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    return result(
      options.scope,
      latestSourceFingerprint,
      isAborted(options.signal)
        ? "aborted"
        : code === SKILL_CANDIDATE_CAPACITY_CODE
          ? "candidate_capacity_exhausted"
          : "internal_error",
      false,
    );
  }
}

const dependencyIds = new WeakMap<SkillPromotionDependencies, number>();
const singleFlight = new Map<string, Promise<SkillPromotionRunResult>>();
let nextDependencyId = 1;

function dependencyId(dependencies: SkillPromotionDependencies): number {
  const existing = dependencyIds.get(dependencies);
  if (existing !== undefined) return existing;
  const created = nextDependencyId;
  nextDependencyId += 1;
  dependencyIds.set(dependencies, created);
  return created;
}

/** Join same-process, same-scope promotion runs without duplicating provider work. */
export function runSkillPromotionSingleFlight(
  options: SkillPromotionRunOptions,
  dependencies: SkillPromotionDependencies = defaultDependencies,
): Promise<SkillPromotionRunResult> {
  const key = `${dependencyId(dependencies)}:${options.scope}`;
  const current = singleFlight.get(key);
  if (current) return current;
  const started = runPromotion(options, dependencies).finally(() => {
    if (singleFlight.get(key) === started) singleFlight.delete(key);
  });
  singleFlight.set(key, started);
  return started;
}
