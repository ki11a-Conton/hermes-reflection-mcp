import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSkillPromotionSingleFlight,
} from "../dist/src/skill_promotion_coordinator.js";
import { BackgroundLifecycle } from "../dist/src/background_lifecycle.js";
import { BackgroundStateStore } from "../dist/src/background_state.js";
import {
  SkillRevisionSchema,
  skillRevisionContentHash,
} from "../dist/src/learning/skill_candidate.js";

const NOW = "2026-08-16T00:00:00.000Z";
const SCOPE = "project:hermes";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function reflection(id, session) {
  return {
    id,
    timestamp: NOW,
    session_id: session,
    scope: SCOPE,
    task_goal: `validate schema ${id}`,
    task_outcome: "success",
    failure_mode: "success",
    task_state: { summary: "success", immediate_blockers: [], active_hypotheses: [], proven_safe_paths: [], exhausted_search: [] },
    world_model_updates: [], tool_insights: [], context_forget: [], open_questions: [], lessons_learned: [], affordance_gaps: [],
    domain: "mcp-testing",
    tags: ["schema", "release"],
  };
}

const reflections = [reflection("r-1", "session-a"), reflection("r-2", "session-b")];
const heuristic = {
  id: "h-1",
  created_at: NOW,
  updated_at: NOW,
  domain: "mcp-testing",
  heuristic: "Validate exported MCP provider schemas before packaging every release.",
  source_task: "release validation",
  scope: SCOPE,
  evidence: reflections.map((item, index) => ({
    id: hash(`e-${index}`),
    source_reflection_id: item.id,
    source_task: "release validation",
    content_hash: hash(`content-${index}`),
    created_at: NOW,
  })),
  feedback: [], reinforcement_count: 2, contradiction_count: 0, contradiction_notes: [],
  confidence: 0.9, retrieval_count: 0, version: 1, tags: ["schema", "release"],
};
const snapshot = { scope: SCOPE, heuristics: [heuristic], reflections, skills: [] };

function revisionFor(cluster, candidateId) {
  const body = {
    revision: 1,
    title: "Validate MCP provider schemas",
    summary: "Validate provider schemas before release packaging.",
    steps: ["Build the package.", "Run schema compatibility checks."],
    domain: cluster.domain,
    tags: cluster.tags,
    confidence: cluster.confidence,
    provenance: reflections.map((item) => ({
      source_type: "reflection",
      source_id: item.id,
      content_hash: hash(`reflection:${item.id}`),
      observed_at: item.timestamp,
      status: "active",
    })),
    origin_candidate_id: candidateId,
    created_at: NOW,
  };
  return SkillRevisionSchema.parse({ ...body, content_hash: skillRevisionContentHash(body) });
}

function fakeDependencies({
  beforeSynthesis,
  promotionSnapshot = snapshot,
  maxEnqueueBatch,
  forcedCandidateState,
  enqueueErrorCode,
} = {}) {
  const state = {
    dirty: [{ scope: SCOPE, dirty_at: NOW }],
    enqueues: 0,
    syntheses: 0,
    commits: 0,
    candidates: new Map(),
  };
  const dependencies = {
    dirty_scopes: async () => state.dirty,
    snapshot: async () => structuredClone(promotionSnapshot),
    semantic_fingerprint: () => hash("semantic-v1"),
    evidence_fingerprint: () => hash("evidence-v1"),
    synthesize: async (cluster) => {
      state.syntheses += 1;
      await beforeSynthesis?.();
      const candidateId = `skill-candidate:${cluster.fingerprint.slice(0, 24)}`;
      return {
        success: true,
        mode: "llm",
        revision: revisionFor(cluster, candidateId),
        source_fingerprint: hash(`source:${cluster.fingerprint}`),
      };
    },
    enqueue: async (drafts) => {
      if (maxEnqueueBatch !== undefined && drafts.length > maxEnqueueBatch) {
        throw new Error(`test enqueue batch exceeds ${maxEnqueueBatch}`);
      }
      if (enqueueErrorCode) {
        throw Object.assign(new Error("bounded candidate capacity reached"), { code: enqueueErrorCode });
      }
      state.enqueues += 1;
      return drafts.map((draft) => {
        const candidate = {
          id: draft.proposed_revision.origin_candidate_id,
          state: forcedCandidateState
            ?? (draft.risk === "low" && draft.risk_reasons.length === 0 ? "pending" : "rejected"),
        };
        state.candidates.set(candidate.id, candidate);
        return candidate;
      });
    },
    candidates_exist: async (ids) => ids.every((id) => state.candidates.has(id)),
    commit: async (_scope, dirtyAt, fingerprint, outcomeClass) => {
      const item = state.dirty.find((entry) => entry.scope === SCOPE);
      if (!item || item.dirty_at !== dirtyAt) return false;
      state.commits += 1;
      item.completed_fingerprint = fingerprint;
      item.completed_at = new Date(Date.parse(item.dirty_at) + 1).toISOString();
      item.last_outcome_class = outcomeClass;
      return true;
    },
  };
  return { state, dependencies };
}

const first = fakeDependencies();
const generated = await runSkillPromotionSingleFlight({ scope: SCOPE }, first.dependencies);
assert.equal(generated.success, true);
assert.equal(generated.generated, 1);
assert.equal(first.state.enqueues, 1);
assert.equal(first.state.commits, 1);

first.state.dirty = [{
  scope: SCOPE,
  dirty_at: "2026-08-16T00:00:01.000Z",
  completed_fingerprint: generated.source_fingerprint,
  completed_at: NOW,
}];
const synthesesBeforeUnchanged = first.state.syntheses;
const unchanged = await runSkillPromotionSingleFlight({ scope: SCOPE }, first.dependencies);
assert.equal(unchanged.outcome_class, "unchanged");
assert.equal(first.state.syntheses, synthesesBeforeUnchanged, "unchanged source must skip synthesis");

const unchangedLease = fakeDependencies();
const unchangedSeed = await runSkillPromotionSingleFlight({ scope: SCOPE }, unchangedLease.dependencies);
unchangedLease.state.dirty = [{
  scope: SCOPE,
  dirty_at: "2026-08-16T00:00:02.000Z",
  completed_fingerprint: unchangedSeed.source_fingerprint,
  completed_at: NOW,
}];
unchangedLease.state.commits = 0;
const unchangedAfterLeaseLoss = await runSkillPromotionSingleFlight({
  scope: SCOPE,
  before_apply: async () => false,
}, unchangedLease.dependencies);
assert.equal(unchangedAfterLeaseLoss.success, false);
assert.equal(unchangedAfterLeaseLoss.outcome_class, "lease_lost");
assert.equal(unchangedLease.state.commits, 0, "unchanged reconciliation must not commit after lease loss");

let releaseSynthesis;
const synthesisGate = new Promise((resolve) => { releaseSynthesis = resolve; });
const concurrent = fakeDependencies({ beforeSynthesis: () => synthesisGate });
const concurrentOne = runSkillPromotionSingleFlight({ scope: SCOPE }, concurrent.dependencies);
const concurrentTwo = runSkillPromotionSingleFlight({ scope: SCOPE }, concurrent.dependencies);
assert.strictEqual(concurrentOne, concurrentTwo, "same-scope runs must join one promise");
releaseSynthesis();
await concurrentOne;
assert.equal(concurrent.state.syntheses, 1);

const lostLease = fakeDependencies();
const lost = await runSkillPromotionSingleFlight({
  scope: SCOPE,
  before_apply: async () => false,
}, lostLease.dependencies);
assert.equal(lost.success, false);
assert.equal(lost.outcome_class, "lease_lost");
assert.equal(lostLease.state.enqueues, 0);
assert.equal(lostLease.state.commits, 0);
assert.equal(lostLease.state.dirty.length, 1);

const abortedRun = fakeDependencies();
const abortedController = new AbortController();
abortedController.abort(new Error("shutdown"));
const aborted = await runSkillPromotionSingleFlight({
  scope: SCOPE,
  signal: abortedController.signal,
}, abortedRun.dependencies);
assert.equal(aborted.outcome_class, "aborted");
assert.equal(abortedRun.state.enqueues, 0);
assert.equal(abortedRun.state.commits, 0);

const restart = fakeDependencies();
const restarted = await runSkillPromotionSingleFlight({ scope: SCOPE }, restart.dependencies);
assert.equal(restarted.generated, 1, "a durable dirty scope must be processed after a runner restart");

const reclassified = fakeDependencies({ forcedCandidateState: "rejected" });
const reclassifiedResult = await runSkillPromotionSingleFlight({ scope: SCOPE }, reclassified.dependencies);
assert.equal(reclassifiedResult.success, true);
assert.equal(reclassifiedResult.outcome_class, "blocked_candidates",
  "completion metadata must reflect the candidate state actually persisted under the storage lock");
assert.equal(reclassified.state.dirty[0].last_outcome_class, "blocked_candidates");

const capacityBlocked = fakeDependencies({ enqueueErrorCode: "SKILL_CANDIDATE_CAPACITY" });
const capacityBlockedResult = await runSkillPromotionSingleFlight({ scope: SCOPE }, capacityBlocked.dependencies);
assert.equal(capacityBlockedResult.success, false);
assert.equal(capacityBlockedResult.outcome_class, "candidate_capacity_exhausted",
  "a full approval queue is a stable recoverable outcome, not an internal error");
assert.equal(capacityBlockedResult.source_fingerprint, generated.source_fingerprint,
  "a post-snapshot capacity result must retain the authoritative source fingerprint");
assert.equal(capacityBlocked.state.dirty[0].completed_at, undefined,
  "capacity exhaustion must leave the scope dirty for continuation after queue cleanup");

const batchReflections = [reflection("r-batch-1", "session-batch-1"), reflection("r-batch-2", "session-batch-2")];
const batchHeuristics = Array.from({ length: 51 }, (_, index) => ({
  ...heuristic,
  id: `h-batch-${String(index).padStart(2, "0")}`,
  domain: `batch-domain-${String(index).padStart(2, "0")}`,
  heuristic: `Validate MCP release batch marker ${String(index).padStart(2, "0")} before packaging.`,
  evidence: batchReflections.map((item, evidenceIndex) => ({
    id: hash(`batch-evidence:${index}:${evidenceIndex}`),
    source_reflection_id: item.id,
    source_task: "release batch validation",
    content_hash: hash(`batch-content:${index}:${evidenceIndex}`),
    created_at: NOW,
  })),
}));
const batched = fakeDependencies({
  promotionSnapshot: { scope: SCOPE, heuristics: batchHeuristics, reflections: batchReflections, skills: [] },
  maxEnqueueBatch: 50,
});
const batchedResult = await runSkillPromotionSingleFlight({ scope: SCOPE }, batched.dependencies);
assert.equal(batchedResult.success, true,
  "the coordinator must persist more than one storage batch without degrading to internal_error");
assert.equal(batchedResult.generated, 51);
assert.equal(batched.state.enqueues, 2);

const tempHome = await mkdtemp(join(tmpdir(), "hermes-v22.1-lifecycle-"));
try {
  const stateStore = new BackgroundStateStore(join(tempHome, "background.json"));
  let automaticPromotions = 0;
  const disabledLifecycle = new BackgroundLifecycle({
    enabled: false,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 5_000,
    max_sessions_per_run: 4,
    review_mode: "deterministic",
    auto_apply: false,
    store: stateStore,
    promotion_dirty_scopes: async () => [{ scope: SCOPE, dirty_at: NOW }],
    promote: async ({ scope }) => {
      automaticPromotions += 1;
      return { success: true, scope, source_fingerprint: hash("disabled"), outcome_class: "success", candidate_ids: [], generated: 0, skipped: 0 };
    },
  });
  disabledLifecycle.notifySkillPromotionDirty();
  await disabledLifecycle.runNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(automaticPromotions, 0, "background disabled must not start automatic provider work");
  await disabledLifecycle.shutdown();

  const scheduledState = new BackgroundStateStore(join(tempHome, "scheduled.json"));
  let scheduledPromotions = 0;
  const scheduledLifecycle = new BackgroundLifecycle({
    enabled: true,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 5_000,
    max_sessions_per_run: 4,
    review_mode: "deterministic",
    auto_apply: false,
    store: scheduledState,
    promotion_dirty_scopes: async () => [{ scope: SCOPE, dirty_at: NOW }],
    promotion_candidates_durable: async () => true,
    promote: async ({ scope, before_apply, with_apply_lease }) => {
      scheduledPromotions += 1;
      assert.equal(await before_apply(), true);
      assert.equal(await with_apply_lease(async () => "leased"), "leased");
      return { success: true, scope, source_fingerprint: hash("scheduled"), outcome_class: "success", candidate_ids: [], generated: 0, skipped: 0 };
    },
  });
  scheduledLifecycle.notifySkillPromotionDirty();
  await scheduledLifecycle.runNow();
  assert.equal(scheduledPromotions, 1);
  await scheduledLifecycle.shutdown();

  const coalescedWakeState = new BackgroundStateStore(join(tempHome, "coalesced-wake.json"));
  let visiblePromotionScope = "project:first-wake";
  let releaseFirstPromotion;
  let firstPromotionStarted;
  const firstPromotionReady = new Promise((resolve) => { firstPromotionStarted = resolve; });
  const firstPromotionGate = new Promise((resolve) => { releaseFirstPromotion = resolve; });
  const coalescedScopes = [];
  const coalescedWakeLifecycle = new BackgroundLifecycle({
    enabled: true,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 5_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store: coalescedWakeState,
    promotion_dirty_scopes: async () => [{ scope: visiblePromotionScope, dirty_at: NOW }],
    promotion_candidates_durable: async () => true,
    promote: async ({ scope }) => {
      coalescedScopes.push(scope);
      if (scope === "project:first-wake") {
        firstPromotionStarted();
        await firstPromotionGate;
      }
      return { success: true, scope, source_fingerprint: hash(scope), outcome_class: "success", candidate_ids: [], generated: 0, skipped: 0 };
    },
  });
  const firstWakeRun = coalescedWakeLifecycle.runNow();
  await firstPromotionReady;
  visiblePromotionScope = "project:second-wake";
  coalescedWakeLifecycle.notifySkillPromotionDirty();
  releaseFirstPromotion();
  await firstWakeRun;
  assert.equal(await waitFor(() => coalescedScopes.length === 2), true,
    "the coalesced follow-up promotion did not start before the bounded deadline");
  assert.deepEqual(coalescedScopes, ["project:first-wake", "project:second-wake"],
    "a promotion notification coalesced into an active run must schedule one follow-up cycle");
  await coalescedWakeLifecycle.shutdown();

  const stableOrderState = new BackgroundStateStore(join(tempHome, "stable-order.json"));
  const scheduledScopes = [];
  const stableOrderLifecycle = new BackgroundLifecycle({
    enabled: true,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 5_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store: stableOrderState,
    promotion_dirty_scopes: async () => [
      { scope: "project:b", dirty_at: NOW },
      { scope: "project:a", dirty_at: NOW },
    ],
    promotion_candidates_durable: async () => true,
    promote: async ({ scope }) => {
      scheduledScopes.push(scope);
      return { success: true, scope, source_fingerprint: hash(scope), outcome_class: "success", candidate_ids: [], generated: 0, skipped: 0 };
    },
  });
  const originalLocaleCompare = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = function localeDependentReverse(other, ...args) {
      const left = String(this);
      const right = String(other);
      if (["project:a", "project:b"].includes(left) && ["project:a", "project:b"].includes(right)) {
        return left === right ? 0 : left === "project:a" ? 1 : -1;
      }
      return originalLocaleCompare.call(left, right, ...args);
    };
    await stableOrderLifecycle.runNow();
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
    await stableOrderLifecycle.shutdown();
  }
  assert.deepEqual(scheduledScopes, ["project:a"],
    "promotion scheduling must not depend on the host locale collation");

  const offsetOrderState = new BackgroundStateStore(join(tempHome, "offset-order.json"));
  const offsetOrderedScopes = [];
  const offsetOrderLifecycle = new BackgroundLifecycle({
    enabled: true,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 5_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store: offsetOrderState,
    promotion_dirty_scopes: async () => [
      { scope: "project:older-instant", dirty_at: "2026-08-16T00:30:00.000+01:00" },
      { scope: "project:newer-instant", dirty_at: "2026-08-15T23:45:00.000Z" },
    ],
    promotion_candidates_durable: async () => true,
    promote: async ({ scope }) => {
      offsetOrderedScopes.push(scope);
      return { success: true, scope, source_fingerprint: hash(scope), outcome_class: "success", candidate_ids: [], generated: 0, skipped: 0 };
    },
  });
  try {
    await offsetOrderLifecycle.runNow();
  } finally {
    await offsetOrderLifecycle.shutdown();
  }
  assert.deepEqual(offsetOrderedScopes, ["project:older-instant"],
    "promotion scheduling must compare RFC 3339 timestamps as instants across offsets");

  const manualState = new BackgroundStateStore(join(tempHome, "manual.json"));
  await manualState.markDirty("manual-session", NOW);
  let manualPromotions = 0;
  const manualLifecycle = new BackgroundLifecycle({
    enabled: false,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 5_000,
    max_sessions_per_run: 4,
    review_mode: "deterministic",
    auto_apply: false,
    store: manualState,
    candidates_durable: async () => true,
    manual_review: async (input) => ({
      success: true,
      session_id: input.session_id,
      review_scope: input.review_scope,
      review_mode_requested: input.review_mode,
      review_mode_used: "deterministic",
      auto_apply: input.auto_apply,
      capabilities: { heuristic_candidates: true, memory_candidates: false, user_profile_candidates: false, skill_suggestions: false, llm_review: false },
      limits: { max_recent_reflections: 10, max_full_reflections: 100, max_candidates: 50 },
      source_reflection_ids: [],
      source_fingerprint: input.source_fingerprint,
      candidate_heuristics: [], candidate_memory_entries: [], candidate_user_profile_entries: [], skipped_items: [],
      applied: { heuristics_added: 0, heuristics_reinforced: 0, heuristic_ids: [], all_processed_heuristic_ids: [] },
    }),
    promotion_dirty_scopes: async () => [{ scope: SCOPE, dirty_at: NOW }],
    promote: async ({ scope, before_apply }) => {
      manualPromotions += 1;
      assert.equal(await before_apply(), true);
      return { success: true, scope, source_fingerprint: hash("manual"), outcome_class: "success", candidate_ids: [], generated: 0, skipped: 0 };
    },
  });
  await manualLifecycle.runNow({
    session_id: "manual-session",
    scope: SCOPE,
    stage: "deterministic",
    source_fingerprint: hash("manual-review"),
    review_scope: "recent",
    review_mode: "deterministic",
    auto_apply: false,
  });
  assert.equal(manualPromotions, 1, "manual review must run promotion before releasing its lease");
  await manualLifecycle.shutdown();

  const shutdownState = new BackgroundStateStore(join(tempHome, "shutdown.json"));
  let promotionStarted;
  const started = new Promise((resolve) => { promotionStarted = resolve; });
  let observedAbort = false;
  const shutdownLifecycle = new BackgroundLifecycle({
    enabled: true,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 5_000,
    max_sessions_per_run: 4,
    review_mode: "deterministic",
    auto_apply: false,
    store: shutdownState,
    promotion_dirty_scopes: async () => [{ scope: SCOPE, dirty_at: NOW }],
    promote: async ({ scope, signal }) => {
      promotionStarted();
      await new Promise((resolve) => {
        const finish = () => { observedAbort = true; resolve(); };
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted) finish();
      });
      return { success: false, scope, source_fingerprint: hash("shutdown"), outcome_class: "aborted", candidate_ids: [], generated: 0, skipped: 0 };
    },
  });
  const active = shutdownLifecycle.runNow();
  await started;
  await shutdownLifecycle.shutdown(1_500);
  await active;
  assert.equal(observedAbort, true);
} finally {
  await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

console.log("v22.1 skill promotion coordinator and lifecycle tests passed");
