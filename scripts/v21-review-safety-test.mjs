import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { withTempHome } from "./v20-test-helpers.mjs";

function fixture({
  id,
  sessionId,
  scope,
  outcome = "success",
  lesson,
  timestamp = new Date().toISOString(),
}) {
  return {
    id,
    timestamp,
    session_id: sessionId,
    scope,
    task_goal: `Review ${id}`,
    task_outcome: outcome,
    failure_mode: outcome === "success" ? "success" : "tool_limitation_or_misbehavior",
    task_state: {
      summary: `${id} ${outcome} summary`,
      immediate_blockers: [],
      active_hypotheses: [],
      proven_safe_paths: outcome === "success" ? [`${id} verified`] : [],
      exhausted_search: [],
    },
    world_model_updates: [],
    tool_insights: [],
    context_forget: [],
    open_questions: [],
    lessons_learned: lesson ? [lesson] : [],
    affordance_gaps: [],
    domain: "software-engineering",
    tags: [scope.replace(/[^a-z0-9]+/gi, "-")],
  };
}

function providerEnvelope(candidates) {
  return JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          summary: "Scoped review complete.",
          candidates,
          open_questions: [],
        }),
      },
    }],
  });
}

async function withProvider(run) {
  const requests = [];
  let candidates = [];
  let delayMs = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(providerEnvelope(candidates));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await run({
      origin,
      requests,
      setCandidates(value) {
        candidates = structuredClone(value);
      },
      setDelay(value) {
        delayMs = value;
      },
      resetRequests() {
        requests.length = 0;
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function configureProvider(origin, { model = "review-model", key = "test-key", path = "/v1" } = {}) {
  Object.assign(process.env, {
    HERMES_REFLECTION_LLM_ENABLED: "1",
    HERMES_REFLECTION_LLM_BASE_URL: `${origin}${path}`,
    HERMES_REFLECTION_LLM_MODEL: model,
    HERMES_REFLECTION_LLM_API_KEY: key,
    HERMES_REFLECTION_LLM_TIMEOUT_MS: "3000",
  });
}

function providerReflectionIds(request) {
  const user = request.body.messages.find((message) => message.role === "user");
  assert.ok(user && typeof user.content === "string", "provider request omitted the bounded user payload");
  const reviewInput = JSON.parse(user.content);
  return reviewInput.reflections.map((reflection) => reflection.id);
}

async function save(storage, reflection) {
  await storage.saveReflectionAndHeuristics(
    reflection,
    [],
    reflection.domain,
    "v21-review-safety-test",
    0.65,
    reflection.tags,
  );
}

async function runOptions(engine, {
  sessionId,
  scope,
  fingerprint,
  reviewScope = "full",
  reviewMode = "llm",
  autoApply = false,
  stage = "llm",
  beforeApply,
}) {
  return engine.runReview({
    session_id: sessionId,
    scope,
    stage,
    source_fingerprint: fingerprint,
    review_scope: reviewScope,
    review_mode: reviewMode,
    auto_apply: autoApply,
    ...(beforeApply ? { before_apply: beforeApply } : {}),
  });
}

async function testScopeBeforeEveryReviewPhase(storage, engine, provider) {
  const sessionId = "v21-mixed-scope-review";
  const alpha = fixture({
    id: "scope-alpha-success",
    sessionId,
    scope: "project:alpha",
    lesson: "Use the exact alpha review boundary.",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const beta = fixture({
    id: "scope-beta-success",
    sessionId,
    scope: "project:beta",
    lesson: "Beta text must never enter alpha review.",
    timestamp: "2026-01-01T00:00:01.000Z",
  });
  const global = fixture({
    id: "scope-global-success",
    sessionId,
    scope: "global",
    lesson: "Global text must not be relabeled as alpha evidence.",
    timestamp: "2026-01-01T00:00:02.000Z",
  });
  await save(storage, alpha);
  await save(storage, beta);
  await save(storage, global);

  await storage.upsertHeuristicsBatch([{
    scope: "project:beta",
    domain: "software-engineering",
    heuristic: "Use the exact alpha review boundary.",
    source_task: "beta-only-dedup-fixture",
    confidence: 0.9,
    tags: ["beta-only"],
  }, {
    scope: "project:beta",
    domain: "software-engineering",
    heuristic: "Never enable alpha review cache.",
    source_task: "beta-only-conflict-fixture",
    confidence: 0.9,
    tags: ["beta-only"],
  }]);

  provider.setCandidates([
    {
      heuristic: "Use the exact alpha review boundary.",
      source_reflection_ids: [alpha.id],
      domain: "software-engineering",
      confidence: 0.95,
      tags: ["alpha"],
    },
    {
      heuristic: "Always enable alpha review cache.",
      source_reflection_ids: [alpha.id],
      domain: "software-engineering",
      confidence: 0.95,
      tags: ["alpha"],
    },
  ]);
  provider.resetRequests();
  const expectedFingerprint = engine.reviewSourceFingerprint([alpha]);
  let result;
  let thrown;
  try {
    result = await runOptions(engine, {
      sessionId,
      scope: "project:alpha",
      fingerprint: expectedFingerprint,
    });
  } catch (error) {
    thrown = error;
  }

  assert.equal(provider.requests.length, 1, "alpha review should make exactly one provider request");
  assert.deepEqual(
    providerReflectionIds(provider.requests[0]),
    [alpha.id],
    "scope filtering must happen before the provider body is built",
  );
  assert.ifError(thrown);
  assert.equal(result.source_fingerprint, expectedFingerprint, "alpha fingerprint included another scope");
  assert.deepEqual(result.source_reflection_ids, [alpha.id], "review result exposed beta/global source IDs");
  assert.equal(result.candidate_heuristics.length, 2, "a beta heuristic incorrectly affected alpha candidate dedup/conflict");
  for (const candidate of result.candidate_heuristics) {
    assert.equal(candidate.scope, "project:alpha", "global or beta data was relabeled as alpha");
    assert.deepEqual(candidate.source_reflection_ids, [alpha.id]);
    assert.ok(
      !candidate.risk_reasons.includes("conflicting_memory"),
      "another project's heuristic affected alpha conflict detection",
    );
  }
}

async function testSemanticSingleFlight(storage, engine, provider) {
  const sessionId = "v21-single-flight";
  const common = {
    id: "single-flight-shared-source",
    sessionId,
    lesson: "Single-flight identity must preserve review semantics.",
    timestamp: "2026-01-02T00:00:00.000Z",
  };
  const alpha = fixture({ ...common, scope: "project:alpha" });
  const beta = fixture({ ...common, scope: "project:beta" });
  await save(storage, alpha);
  await save(storage, beta);
  const fingerprint = engine.reviewSourceFingerprint([alpha]);
  provider.setCandidates([]);
  provider.setDelay(120);

  const base = {
    session_id: sessionId,
    scope: "project:alpha",
    stage: "llm",
    source_fingerprint: fingerprint,
    review_scope: "recent",
    review_mode: "llm",
    auto_apply: false,
  };

  async function isSeparated(left, right, mutateEnvironment) {
    provider.resetRequests();
    configureProvider(provider.origin, { model: "review-model", key: "key-a", path: "/semantic-a" });
    const first = engine.runReviewSingleFlight(left);
    if (mutateEnvironment) mutateEnvironment();
    const second = engine.runReviewSingleFlight(right);
    const separated = first !== second;
    await Promise.allSettled([first, second]);
    return separated;
  }

  const omitted = [];
  const dimensions = [
    ["session id", base, { ...base, session_id: `${sessionId}-other` }],
    ["source fingerprint", base, { ...base, source_fingerprint: "d".repeat(64) }],
    ["target scope", base, { ...base, scope: "project:beta" }],
    ["review scope", base, { ...base, review_scope: "full" }],
    ["review mode", base, { ...base, review_mode: "auto" }],
    ["auto-apply intent", base, { ...base, auto_apply: true }],
    ["review stage", base, { ...base, stage: "deterministic" }],
    ["provider model fingerprint", base, base, () => {
      configureProvider(provider.origin, { model: "review-model-two", key: "key-a", path: "/semantic-a" });
    }],
    ["provider endpoint path fingerprint", base, base, () => {
      configureProvider(provider.origin, { model: "review-model", key: "key-a", path: "/semantic-b" });
    }],
  ];
  for (const [label, left, right, mutateEnvironment] of dimensions) {
    if (!(await isSeparated(left, right, mutateEnvironment))) omitted.push(label);
  }

  provider.resetRequests();
  configureProvider(provider.origin, { model: "review-model", key: "secret-a", path: "/same-semantics?credential=one" });
  const sameFirst = engine.runReviewSingleFlight(base);
  configureProvider(provider.origin, { model: "review-model", key: "secret-b", path: "/same-semantics?credential=two" });
  const sameSecond = engine.runReviewSingleFlight({ ...base });
  assert.strictEqual(sameFirst, sameSecond, "API keys or endpoint query credentials split a semantically identical review");
  await Promise.allSettled([sameFirst, sameSecond]);
  assert.equal(provider.requests.length, 1, "fully identical semantics should execute one provider call");
  provider.setDelay(0);
  assert.deepEqual(omitted, [], `single-flight identity omitted: ${omitted.join(", ")}`);
}

async function testEvidenceAndAntiMislearning(storage, engine, provider) {
  const sessionId = "v21-evidence-review";
  const alphaOne = fixture({
    id: "evidence-alpha-success-1",
    sessionId,
    scope: "project:alpha",
    outcome: "success",
    timestamp: "2026-01-03T00:00:00.000Z",
  });
  const alphaTwo = fixture({
    id: "evidence-alpha-success-2",
    sessionId,
    scope: "project:alpha",
    outcome: "success",
    timestamp: "2026-01-03T00:00:01.000Z",
  });
  const alphaPartial = fixture({
    id: "evidence-alpha-partial",
    sessionId,
    scope: "project:alpha",
    outcome: "partial",
    timestamp: "2026-01-03T00:00:02.000Z",
  });
  const alphaFailure = fixture({
    id: "evidence-alpha-failure",
    sessionId,
    scope: "project:alpha",
    outcome: "failure",
    timestamp: "2026-01-03T00:00:03.000Z",
  });
  const betaSuccess = fixture({
    id: "evidence-beta-success",
    sessionId,
    scope: "project:beta",
    outcome: "success",
    timestamp: "2026-01-03T00:00:04.000Z",
  });
  const globalSuccess = fixture({
    id: "evidence-global-success",
    sessionId,
    scope: "global",
    outcome: "success",
    timestamp: "2026-01-03T00:00:05.000Z",
  });
  for (const reflection of [alphaOne, alphaTwo, alphaPartial, alphaFailure, betaSuccess, globalSuccess]) {
    await save(storage, reflection);
  }

  const candidateSpecs = [
    ["Apply exact alpha successes.", [alphaOne.id, alphaTwo.id]],
    ["Do not accept duplicate evidence.", [alphaOne.id, alphaOne.id]],
    ["Do not learn from alpha partial only.", [alphaPartial.id]],
    ["Do not learn from alpha failure only.", [alphaFailure.id]],
    ["Do not borrow beta success.", [betaSuccess.id]],
    ["Do not borrow global success.", [globalSuccess.id]],
    ["Do not trust an unknown source.", ["unknown-reflection-id"]],
    ["Do not trust empty evidence.", []],
  ].map(([heuristic, sourceIds]) => ({
    heuristic,
    source_reflection_ids: sourceIds,
    domain: "software-engineering",
    confidence: 0.95,
    tags: ["evidence"],
  }));
  provider.setCandidates(candidateSpecs);
  provider.resetRequests();
  const exactSources = [alphaOne, alphaTwo, alphaPartial, alphaFailure];
  const fingerprint = engine.reviewSourceFingerprint(exactSources);
  const first = await runOptions(engine, {
    sessionId,
    scope: "project:alpha",
    fingerprint,
    autoApply: true,
  });
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual(providerReflectionIds(provider.requests[0]), exactSources.map((item) => item.id));

  const byText = new Map(first.candidate_heuristics.map((candidate) => [candidate.heuristic, candidate]));
  const eligible = byText.get("Apply exact alpha successes.");
  assert.ok(eligible, "provider candidate with exact-scope evidence was dropped");
  assert.deepEqual(eligible.source_reflection_ids, [alphaOne.id, alphaTwo.id], "per-candidate evidence was collapsed or replaced");
  assert.equal(eligible.state, "applied", "exact-scope success evidence should be eligible for auto-apply");

  for (const text of ["Do not learn from alpha partial only.", "Do not learn from alpha failure only."]) {
    const candidate = byText.get(text);
    assert.ok(candidate, `${text} was not retained for inspection`);
    assert.notEqual(candidate.state, "applied", `${text} was automatically learned`);
    assert.ok(candidate.risk_reasons.includes("unresolved_failure"), `${text} lacks unresolved_failure risk`);
  }
  for (const text of ["Do not borrow beta success.", "Do not borrow global success.", "Do not trust an unknown source.", "Do not trust empty evidence."]) {
    const candidate = byText.get(text);
    assert.ok(candidate, `${text} was not retained for inspection`);
    assert.notEqual(candidate.state, "applied", `${text} was automatically learned across the evidence boundary`);
    assert.ok(candidate.risk_reasons.includes("missing_or_invalid_evidence"), `${text} lacks missing_or_invalid_evidence risk`);
  }
  const duplicate = byText.get("Do not accept duplicate evidence.");
  assert.ok(duplicate, "duplicate-source candidate was not retained for inspection");
  assert.equal(duplicate.state, "pending", "duplicate source IDs were automatically applied");
  assert.ok(duplicate.risk_reasons.includes("missing_or_invalid_evidence"), "duplicate source IDs lack an explicit invalid-evidence risk");

  let store = await storage.exportData();
  const applied = store.heuristics.find((heuristic) => heuristic.heuristic === "Apply exact alpha successes.");
  assert.ok(applied, "applied candidate did not create a heuristic");
  assert.equal(applied.scope, "project:alpha");
  assert.deepEqual(
    applied.evidence.map((item) => item.source_reflection_id).sort(),
    [alphaOne.id, alphaTwo.id].sort(),
    "applied heuristic did not preserve all validated source references",
  );

  await runOptions(engine, {
    sessionId,
    scope: "project:alpha",
    fingerprint,
    autoApply: true,
  });
  store = await storage.exportData();
  const replayed = store.heuristics.find((heuristic) => heuristic.id === applied.id);
  assert.ok(replayed, "replay lost the applied heuristic");
  assert.deepEqual(
    replayed.evidence.map((item) => item.source_reflection_id).sort(),
    [alphaOne.id, alphaTwo.id].sort(),
    "replay lost or duplicated validated source references",
  );
  assert.equal(
    store.heuristics.filter((heuristic) => heuristic.heuristic === "Apply exact alpha successes.").length,
    1,
    "review replay duplicated the applied heuristic",
  );
}

async function testTransientFailureAntiMislearning(storage, engine, provider) {
  const sessionId = "v21-transient-risk";
  const source = fixture({
    id: "transient-risk-success",
    sessionId,
    scope: "project:alpha",
    outcome: "success",
    timestamp: "2026-01-04T00:00:00.000Z",
  });
  await save(storage, source);
  const risky = [
    "Authentication failed once, never use Tool X.",
    "A temporary network error occurred, always avoid Tool Y.",
    "Quota was exceeded once, disable Tool Z permanently.",
    "The package was not installed in this environment, Tool Q never works.",
  ];
  const safe = "Use Tool X for repository inspection after validation.";
  provider.setCandidates([...risky, safe].map((heuristic) => ({
    heuristic,
    source_reflection_ids: [source.id],
    domain: "software-engineering",
    confidence: 0.97,
    tags: ["transient-risk"],
  })));
  const result = await runOptions(engine, {
    sessionId,
    scope: "project:alpha",
    fingerprint: engine.reviewSourceFingerprint([source]),
    autoApply: true,
  });
  const byText = new Map(result.candidate_heuristics.map((candidate) => [candidate.heuristic, candidate]));
  for (const text of risky) {
    const candidate = byText.get(text);
    assert.ok(candidate, `${text} was not retained for inspection`);
    assert.equal(candidate.state, "pending", `${text} converted a transient/unverified event into an applied rule`);
    assert.ok(
      candidate.risk_reasons.includes("transient_or_environmental_failure"),
      `${text} lacks the concrete transient_or_environmental_failure risk`,
    );
  }
  assert.equal(byText.get(safe)?.state, "applied", "narrow anti-mislearning checks over-blocked a normal verified tool lesson");
}

async function testEvidenceFingerprintClosesApplyRace(storage, engine, provider) {
  const sessionId = "v21-evidence-toctou";
  const source = fixture({
    id: "evidence-toctou-source",
    sessionId,
    scope: "project:alpha",
    outcome: "success",
    lesson: "Use the original evidence-bound procedure.",
    timestamp: "2026-01-05T00:00:00.000Z",
  });
  await save(storage, source);
  const heuristic = "Apply only evidence that remains byte-semantically authoritative.";
  provider.setCandidates([{
    heuristic,
    source_reflection_ids: [source.id],
    domain: "software-engineering",
    confidence: 0.97,
    tags: ["toctou"],
  }]);

  await assert.rejects(
    runOptions(engine, {
      sessionId,
      scope: "project:alpha",
      fingerprint: engine.reviewSourceFingerprint([source]),
      autoApply: true,
      beforeApply: async () => {
        const changed = await storage.updateReflection(source.id, {
          lessons_learned: ["The authoritative evidence content changed before apply."],
        });
        assert.ok(changed, "TOCTOU fixture failed to replace authoritative evidence");
      },
    }),
    /evidence fingerprint mismatch/i,
    "same-id/scope/success evidence replacement was not rejected at the locked apply boundary",
  );
  const store = await storage.exportData();
  assert.equal(store.heuristics.some((item) => item.heuristic === heuristic), false, "changed evidence was applied");
  const candidate = store.metadata.review_candidates.find((item) => item.heuristic === heuristic);
  assert.ok(candidate, "TOCTOU candidate disappeared instead of remaining auditable");
  assert.equal(candidate.state, "pending", "TOCTOU candidate did not remain pending after fail-closed apply");
  const mutation = store.metadata.pending_mutations.find((item) => item.id === candidate.mutation_id);
  assert.equal(mutation?.state, "pending", "TOCTOU mutation claim was not released after fail-closed apply");
}

await withTempHome("v21-review-safety", async (home) => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const storage = await import("../dist/storage.js");
  const engine = await import("../dist/src/review_engine.js");
  await storage.initializeStoreV20();
  await withProvider(async (provider) => {
    configureProvider(provider.origin);
    const cases = [
      ["scope filtering precedes source/fingerprint/provider/dedup/conflict", testScopeBeforeEveryReviewPhase],
      ["single-flight identity preserves all semantic inputs", testSemanticSingleFlight],
      ["per-candidate evidence and anti-mislearning survive apply/replay", testEvidenceAndAntiMislearning],
      ["transient failures cannot become permanent tool prohibitions", testTransientFailureAntiMislearning],
      ["candidate evidence fingerprint closes the generation/apply race", testEvidenceFingerprintClosesApplyRace],
    ];
    const failures = [];
    for (const [name, test] of cases) {
      try {
        await test(storage, engine, provider);
        console.log(`[PASS] ${name}`);
      } catch (error) {
        failures.push({ name, error });
        console.error(`[FAIL] ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    }
    assert.equal(failures.length, 0, `${failures.length} v21 review-safety business behavior(s) failed`);
  });
});

console.log("[PASS] v21 review safety");
