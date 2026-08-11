import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import {
  assert,
  startMcp,
  withTempHome,
} from "./v20-test-helpers.mjs";
import { BackgroundStateStore } from "../dist/src/background_state.js";
import { BackgroundLifecycle } from "../dist/src/background_lifecycle.js";

const SINGLE_FLIGHT_CHILD = process.argv.includes("--single-flight-child");
const MANUAL_LEASE_CHILD = process.argv.includes("--manual-lease-child");
const MANUAL_SHUTDOWN_CHILD = process.argv.includes("--manual-shutdown-child");
const MISSING_PROVENANCE_CHILD = process.argv.includes("--missing-provenance-child");

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function structured(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.ok(result.structuredContent && typeof result.structuredContent === "object", `${JSON.stringify(result)} has no structuredContent`);
  return result.structuredContent;
}

function itemValue(item) {
  return item && typeof item === "object" && "item" in item ? item.item : item;
}

function reflectionFixture(sessionId = "llm-review-session") {
  const timestamp = new Date().toISOString();
  return {
    id: `reflection-${sessionId}`,
    timestamp,
    session_id: sessionId,
    scope: "global",
    task_goal: "Verify bounded LLM review",
    task_outcome: "success",
    failure_mode: "success",
    task_state: {
      summary: "The review should extract one concrete lesson.",
      immediate_blockers: [],
      active_hypotheses: [],
      proven_safe_paths: [],
      exhausted_search: [],
    },
    world_model_updates: [],
    tool_insights: [],
    context_forget: [],
    open_questions: [],
    lessons_learned: ["Use one durable single-flight review for identical source fingerprints."],
    affordance_gaps: [],
    domain: "software-engineering",
    tags: ["v20-llm-test"],
  };
}

function providerEnvelope(candidates = [{
  heuristic: "Use a fingerprint-keyed single-flight review.",
  domain: "software-engineering",
  confidence: 0.9,
  tags: ["single-flight"],
}], sourceReflectionIds = []) {
  const evidencedCandidates = candidates.map((candidate) => ({
    ...candidate,
    source_reflection_ids: sourceReflectionIds,
  }));
  return JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({ summary: "Review complete.", candidates: evidencedCandidates, open_questions: [] }),
      },
    }],
  });
}

function requestSourceReflectionIds(requestBody) {
  const userMessage = requestBody.messages?.find((message) => message.role === "user");
  const reviewInput = JSON.parse(userMessage?.content ?? "{}");
  return (reviewInput.reflections ?? []).map((reflection) => reflection.id);
}

async function runSingleFlightChild() {
  const storage = await import("../dist/storage.js");
  const engine = await import("../dist/src/review_engine.js");
  const lifecycleModule = await import("../dist/src/background_lifecycle.js");
  await storage.initializeStoreV20();
  const reflection = reflectionFixture("single-flight-session");
  await storage.saveReflectionAndHeuristics(reflection, [], reflection.domain, "single-flight-test", 0.65, []);
  const source = await engine.getReviewSourceState(reflection.session_id, "recent");
  const lifecycle = lifecycleModule.backgroundLifecycle;
  await lifecycle.notifyReflectionSaved(reflection.session_id);
  await lifecycle.options.store.markDirty(reflection.session_id, new Date(Date.now() - 10_000).toISOString());
  const manual = {
    session_id: reflection.session_id,
    scope: "global",
    stage: "llm",
    source_fingerprint: source.source_fingerprint,
    review_scope: "recent",
    review_mode: "llm",
    auto_apply: false,
  };
  await Promise.all([
    lifecycle.runNow(),
    lifecycle.runNow(manual),
    lifecycle.runNow(manual),
  ]);
  await lifecycle.shutdown();
  process.stdout.write(JSON.stringify({ ok: true }));
}

async function runManualLeaseChild() {
  const storage = await import("../dist/storage.js");
  const engine = await import("../dist/src/review_engine.js");
  await storage.initializeStoreV20();
  const reflection = reflectionFixture("manual-lease-session");
  await storage.saveReflectionAndHeuristics(reflection, [], reflection.domain, "manual-lease-test", 0.65, []);
  const source = await engine.getReviewSourceState(reflection.session_id, "recent");
  const state = new BackgroundStateStore(join(process.env.HOME, ".hermes-reflection", "manual-lease-state.json"));
  await state.markDirty(reflection.session_id, new Date(Date.now() - 10_000).toISOString());
  const lifecycle = new BackgroundLifecycle({
    enabled: false,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 1_000,
    max_sessions_per_run: 1,
    review_mode: "llm",
    auto_apply: false,
    store: state,
  });
  const result = await lifecycle.runNow({
    session_id: reflection.session_id,
    scope: "global",
    stage: "llm",
    source_fingerprint: source.source_fingerprint,
    review_scope: "recent",
    review_mode: "llm",
    auto_apply: false,
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(await state.dirtySessions(), [], "manual review returned success after its lease expired without committing the stage");
  await lifecycle.shutdown();
  process.stdout.write(JSON.stringify({ ok: true }));
}

async function runMissingProvenanceChild() {
  const storage = await import("../dist/storage.js");
  await storage.initializeStoreV20();
  const reflection = {
    ...reflectionFixture("missing-provenance-project-session"),
    scope: "project:alpha",
  };
  await storage.saveReflectionAndHeuristics(reflection, [], reflection.domain, "missing-provenance-test", 0.65, []);
  const state = new BackgroundStateStore(join(process.env.HOME, ".hermes-reflection", "missing-provenance-state.json"));
  await state.markDirty(reflection.session_id, new Date(Date.now() - 10_000).toISOString());
  let reviewCalls = 0;
  const lifecycle = new BackgroundLifecycle({
    enabled: true,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 5_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store: state,
    review: async () => {
      reviewCalls += 1;
      return {
        success: true,
        source_fingerprint: FINGERPRINT_A,
        outcome_class: "success",
        stage: "deterministic",
        candidate_ids: [],
      };
    },
  });
  await lifecycle.runNow();
  assert.equal(reviewCalls, 0, "missing persisted provenance inferred a project scope from reflection content");
  await lifecycle.shutdown();
}

async function runManualShutdownChild() {
  const storage = await import("../dist/storage.js");
  const engine = await import("../dist/src/review_engine.js");
  await storage.initializeStoreV20();
  const reflection = reflectionFixture("manual-shutdown-session");
  await storage.saveReflectionAndHeuristics(reflection, [], reflection.domain, "manual-shutdown-test", 0.65, []);
  const source = await engine.getReviewSourceState(reflection.session_id, "recent");
  const state = new BackgroundStateStore(join(process.env.HOME, ".hermes-reflection", "manual-shutdown-state.json"));
  await state.markDirty(reflection.session_id, new Date(Date.now() - 10_000).toISOString());
  const lifecycle = new BackgroundLifecycle({
    enabled: false,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 5_000,
    max_sessions_per_run: 1,
    review_mode: "llm",
    auto_apply: false,
    store: state,
  });
  const run = lifecycle.runNow({
    session_id: reflection.session_id,
    scope: "global",
    stage: "llm",
    source_fingerprint: source.source_fingerprint,
    review_scope: "recent",
    review_mode: "llm",
    auto_apply: false,
  });
  for (let attempt = 0; attempt < 100 && !(await state.status()).lease.active; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await state.status()).lease.active, true, "manual shutdown fixture never acquired its lease");
  await new Promise((resolve, reject) => {
    process.stdin.once("data", resolve);
    process.stdin.once("end", resolve);
    process.stdin.once("error", reject);
    process.stdin.resume();
  });
  await lifecycle.shutdown(2_000);
  assert.equal((await state.status()).lease.active, false, "shutdown returned before the manual review released its fence");
  await run.catch(() => undefined);
  process.stdout.write(JSON.stringify({ ok: true }));
}

async function withMockProvider(fn) {
  const requests = [];
  let scenario = { kind: "success", attempt: 0 };
  let signalRequest;
  let requestSeen = new Promise((resolve) => {
    signalRequest = resolve;
  });
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const requestBody = JSON.parse(body);
    requests.push(requestBody);
    signalRequest();
    scenario.attempt += 1;
    if (scenario.kind === "429" && scenario.attempt === 1) {
      response.writeHead(429).end("rate limited");
      return;
    }
    if (scenario.kind === "500" && scenario.attempt === 1) {
      response.writeHead(500).end("unavailable");
      return;
    }
    if (["400", "401", "403"].includes(scenario.kind)) {
      response.writeHead(Number(scenario.kind)).end("rejected");
      return;
    }
    if (scenario.kind === "malformed") {
      response.writeHead(200, { "content-type": "application/json" }).end("not-json");
      return;
    }
    if (scenario.kind === "oversize") {
      response.writeHead(200, { "content-type": "application/json", "content-length": 70_000 }).end("x".repeat(70_000));
      return;
    }
    if (scenario.kind === "delayed" || scenario.kind === "slow-success" || scenario.kind === "manual-slow") {
      const delay = scenario.kind === "delayed" ? 1_500 : scenario.kind === "manual-slow" ? 1_500 : 150;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const candidates = scenario.kind === "secret"
      ? [{ heuristic: "Use token ghp_TEST-ONLY-INVALID-000000000000 in the command.", domain: "security", confidence: 0.99, tags: [] }]
      : scenario.kind === "conflict"
        ? [
            { heuristic: "Always enable shared cache for build X.", domain: "build", confidence: 0.95, tags: [] },
            { heuristic: "Never enable shared cache for build X.", domain: "build", confidence: 0.95, tags: [] },
          ]
        : scenario.kind === "opposite"
          ? [{ heuristic: "Never enable shared cache for build X.", domain: "build", confidence: 0.95, tags: [] }]
        : undefined;
    response.writeHead(200, { "content-type": "application/json" })
      .end(providerEnvelope(candidates, requestSourceReflectionIds(requestBody)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const setScenario = (kind) => {
    scenario = { kind, attempt: 0 };
    requests.length = 0;
    requestSeen = new Promise((resolve) => {
      signalRequest = resolve;
    });
  };
  try {
    await fn({ endpoint, requests, setScenario, waitForRequest: () => requestSeen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testBoundedLlmAndSingleFlight(home) {
  await withMockProvider(async ({ endpoint, requests, setScenario, waitForRequest }) => {
    Object.assign(process.env, {
      HERMES_REFLECTION_LLM_ENABLED: "1",
      HERMES_REFLECTION_LLM_BASE_URL: endpoint,
      HERMES_REFLECTION_LLM_MODEL: "mock-model",
      HERMES_REFLECTION_LLM_API_KEY: "test-only-key",
      HERMES_REFLECTION_LLM_TIMEOUT_MS: "1000",
    });
    const { getLlmReviewReadiness, runLlmReview } = await import("../dist/src/llm_review.js");
    const { mayAutoApply } = await import("../dist/src/review_engine.js");
    const reflection = reflectionFixture();

    process.env.HERMES_REFLECTION_LLM_BASE_URL = "http://127.example.com/v1";
    assert.equal(getLlmReviewReadiness().ready, false, "lookalike hostnames are not loopback HTTP endpoints");
    process.env.HERMES_REFLECTION_LLM_BASE_URL = endpoint;

    const eligible = {
      id: "review:eligible",
      created_at: new Date().toISOString(),
      scope: "global",
      stage: "llm",
      source_fingerprint: FINGERPRINT_A,
      source_reflection_ids: [reflection.id],
      heuristic: "Use a bounded deterministic apply predicate.",
      domain: "testing",
      tags: [],
      confidence: 0.85,
      risk_reasons: [],
      state: "pending",
    };
    assert.equal(mayAutoApply(eligible), true);
    assert.equal(mayAutoApply({ ...eligible, confidence: 0.84 }), false);
    assert.equal(mayAutoApply({ ...eligible, risk_reasons: ["permission_change"] }), false);
    assert.equal(mayAutoApply({ ...eligible, state: "rejected" }), false);
    assert.equal(mayAutoApply({ ...eligible, source_reflection_ids: [] }), false);
    assert.equal(mayAutoApply({ ...eligible, heuristic: "x".repeat(1_001) }), false);

    setScenario("success");
    assert.equal((await runLlmReview([reflection])).success, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].max_completion_tokens, 1_200);
    assert.equal(requests[0].temperature, 0);
    assert.deepEqual(requests[0].response_format, { type: "json_object" });

    setScenario("success");
    const noEvidence = await runLlmReview([]);
    assert.equal(noEvidence.success, true);
    assert.ok(noEvidence.candidates[0].risk_reasons.includes("missing_evidence"));

    for (const retryable of ["429", "500"]) {
      setScenario(retryable);
      assert.equal((await runLlmReview([reflection])).success, true, `${retryable} should recover once`);
      assert.equal(requests.length, 2, `${retryable} should retry exactly once`);
    }

    for (const [status, errorClass] of [["400", "provider_rejected"], ["401", "authentication"], ["403", "permission"]]) {
      setScenario(status);
      const rejected = await runLlmReview([reflection]);
      assert.equal(rejected.error_class, errorClass);
      assert.equal(requests.length, 1, `${status} must not retry`);
    }

    setScenario("malformed");
    const malformed = await runLlmReview([reflection]);
    assert.equal(malformed.error_class, "invalid_response");
    assert.equal(requests.length, 1);

    setScenario("oversize");
    const oversize = await runLlmReview([reflection]);
    assert.equal(oversize.error_class, "invalid_response");
    assert.equal(requests.length, 1);

    setScenario("delayed");
    const delayed = await runLlmReview([reflection]);
    assert.equal(delayed.error_class, "timeout");
    assert.equal(requests.length, 1);

    setScenario("secret");
    const secret = await runLlmReview([reflection]);
    assert.equal(secret.success, true);
    assert.ok(secret.candidates[0].risk_reasons.includes("secret_or_credential"));
    assert.doesNotMatch(JSON.stringify(secret), /ghp_[A-Za-z0-9]+|test-only-key/);

    setScenario("secret");
    const mcp = await startMcp(home, {
      HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
      HERMES_REFLECTION_LLM_ENABLED: "1",
      HERMES_REFLECTION_LLM_BASE_URL: endpoint,
      HERMES_REFLECTION_LLM_MODEL: "mock-model",
      HERMES_REFLECTION_LLM_API_KEY: "test-only-key",
      HERMES_REFLECTION_LLM_TIMEOUT_MS: "1000",
    });
    structured(await call(mcp.client, "reflect_on_task", {
      session_id: "unsafe-llm-review",
      task_goal: "Queue an unsafe LLM candidate",
      task_outcome: "success",
      failure_mode: "success",
      summary: "Unsafe candidates must remain pending.",
      lessons_learned: [],
      auto_extract_heuristics: false,
    }));
    const unsafeReview = structured(await call(mcp.client, "trigger_background_review", {
      action: "run",
      session_id: "unsafe-llm-review",
      review_scope: "recent",
      review_mode: "llm",
      auto_apply: true,
      response_mode: "full",
    }));
    const unsafeCandidate = (unsafeReview.items ?? []).map(itemValue)
      .find((item) => item?.stage === "llm" && item?.state === "pending");
    assert.ok(unsafeCandidate);
    assert.ok(unsafeCandidate.risk_reasons.includes("secret_or_credential"));
    await mcp.close();
    const unsafeStoreText = await readFile(join(home, ".hermes-reflection", "store.json"), "utf8");
    assert.doesNotMatch(unsafeStoreText, /ghp_[A-Za-z0-9]+|test-only-key/);
    const unsafeStore = JSON.parse(unsafeStoreText);
    assert.ok(unsafeStore.metadata.review_candidates.some((candidate) => candidate.id === unsafeCandidate.id && candidate.state === "pending"));

    setScenario("opposite");
    const conflictMcp = await startMcp(home, {
      HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
      HERMES_REFLECTION_LLM_ENABLED: "1",
      HERMES_REFLECTION_LLM_BASE_URL: endpoint,
      HERMES_REFLECTION_LLM_MODEL: "mock-model",
      HERMES_REFLECTION_LLM_API_KEY: "test-only-key",
      HERMES_REFLECTION_LLM_TIMEOUT_MS: "1000",
    });
    assert.equal((await call(conflictMcp.client, "add_heuristic", {
      heuristic: "Always enable shared cache for build X.",
      domain: "build",
      confidence: 0.9,
      tags: ["conflict-fixture"],
      source_task: "v20-background-test",
    })).isError, undefined);
    structured(await call(conflictMcp.client, "reflect_on_task", {
      session_id: "conflicting-llm-review",
      task_goal: "Detect conflict with existing memory",
      task_outcome: "success",
      failure_mode: "success",
      summary: "Opposing LLM candidates require review.",
      lessons_learned: [],
      auto_extract_heuristics: false,
    }));
    const conflictingReview = structured(await call(conflictMcp.client, "trigger_background_review", {
      action: "run",
      session_id: "conflicting-llm-review",
      review_scope: "recent",
      review_mode: "llm",
      auto_apply: true,
      response_mode: "full",
    }));
    const conflictingCandidate = (conflictingReview.items ?? []).map(itemValue)
      .find((item) => item?.risk_reasons?.includes("conflicting_memory"));
    assert.ok(conflictingCandidate);
    assert.equal(conflictingCandidate.state, "pending");
    await conflictMcp.close();

    setScenario("success");
    const safeMcp = await startMcp(home, {
      HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
      HERMES_REFLECTION_LLM_ENABLED: "1",
      HERMES_REFLECTION_LLM_BASE_URL: endpoint,
      HERMES_REFLECTION_LLM_MODEL: "mock-model",
      HERMES_REFLECTION_LLM_API_KEY: "test-only-key",
      HERMES_REFLECTION_LLM_TIMEOUT_MS: "1000",
    });
    structured(await call(safeMcp.client, "reflect_on_task", {
      session_id: "safe-llm-review",
      task_goal: "Apply a high-confidence safe LLM candidate",
      task_outcome: "success",
      failure_mode: "success",
      summary: "A safe candidate should pass the exact predicate.",
      lessons_learned: [],
      auto_extract_heuristics: false,
    }));
    const safeReview = structured(await call(safeMcp.client, "trigger_background_review", {
      action: "run",
      session_id: "safe-llm-review",
      review_scope: "recent",
      review_mode: "llm",
      auto_apply: true,
      response_mode: "full",
    }));
    const appliedCandidate = (safeReview.items ?? []).map(itemValue)
      .find((item) => item?.stage === "llm" && item?.state === "applied");
    assert.ok(appliedCandidate, `eligible candidate was not applied: ${JSON.stringify(safeReview)}`);
    assert.equal(appliedCandidate.confidence, 0.9);
    assert.deepEqual(appliedCandidate.risk_reasons, []);
    await safeMcp.close();

    setScenario("conflict");
    const conflict = await runLlmReview([reflection]);
    assert.equal(conflict.success, true);
    assert.equal(conflict.candidates.length, 2);
    assert.ok(conflict.candidates.every((candidate) => candidate.risk_reasons.includes("conflicting_candidate")));

    setScenario("slow-success");
    const child = spawn(process.execPath, [process.argv[1], "--single-flight-child"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HERMES_REFLECTION_BACKGROUND_ENABLED: "1",
        HERMES_REFLECTION_BACKGROUND_IDLE_MS: "5000",
        HERMES_REFLECTION_BACKGROUND_REVIEW_MODE: "llm",
        HERMES_REFLECTION_BACKGROUND_AUTO_APPLY: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, `single-flight child failed: ${stderr}`);
    assert.equal(requests.length, 1, "two manual calls plus one scheduled call must share one provider request");

    setScenario("manual-slow");
    const manualLeaseChild = spawn(process.execPath, [process.argv[1], "--manual-lease-child"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
        HERMES_REFLECTION_LLM_ENABLED: "1",
        HERMES_REFLECTION_LLM_BASE_URL: endpoint,
        HERMES_REFLECTION_LLM_MODEL: "mock-model",
        HERMES_REFLECTION_LLM_API_KEY: "test-only-key",
        HERMES_REFLECTION_LLM_TIMEOUT_MS: "2500",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let manualStderr = "";
    manualLeaseChild.stderr.setEncoding("utf8");
    manualLeaseChild.stderr.on("data", (chunk) => { manualStderr += chunk; });
    const [manualCode] = await once(manualLeaseChild, "exit");
    assert.equal(manualCode, 0, `manual lease child failed: ${manualStderr}`);
    assert.equal(requests.length, 1, "manual lease fixture must issue one provider request");

    setScenario("manual-slow");
    const manualShutdownChild = spawn(process.execPath, [process.argv[1], "--manual-shutdown-child"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
        HERMES_REFLECTION_LLM_ENABLED: "1",
        HERMES_REFLECTION_LLM_BASE_URL: endpoint,
        HERMES_REFLECTION_LLM_MODEL: "mock-model",
        HERMES_REFLECTION_LLM_API_KEY: "test-only-key",
        HERMES_REFLECTION_LLM_TIMEOUT_MS: "2500",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let shutdownStderr = "";
    manualShutdownChild.stderr.setEncoding("utf8");
    manualShutdownChild.stderr.on("data", (chunk) => { shutdownStderr += chunk; });
    const shutdownExit = once(manualShutdownChild, "exit");
    let requestTimeout;
    try {
      await Promise.race([
        waitForRequest(),
        shutdownExit.then(([code]) => {
          throw new Error(`manual shutdown child exited before provider request (${code}): ${shutdownStderr}`);
        }),
        new Promise((_, reject) => {
          requestTimeout = setTimeout(() => reject(new Error("manual shutdown provider request timed out")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(requestTimeout);
    }
    manualShutdownChild.stdin.end("shutdown\n");
    const [shutdownCode] = await shutdownExit;
    assert.equal(shutdownCode, 0, `manual shutdown child failed: ${shutdownStderr}`);
    assert.equal(requests.length, 1, "manual shutdown fixture must issue one provider request");
  });
}

async function testBackgroundStateMigration(home) {
  const statePath = join(home, "background-v1.json");
  const now = new Date().toISOString();
  await writeFile(statePath, JSON.stringify({
    schema_version: 1,
    next_fencing_token: 1,
    dirty_sessions: {
      dirty: {
        dirty_at: now,
        last_reviewed_fingerprint: FINGERPRINT_A,
        last_reviewed_at: now,
      },
    },
    reviewed_sessions: {
      reviewed: {
        last_reviewed_fingerprint: FINGERPRINT_B,
        last_reviewed_at: now,
      },
    },
    recent_runs: [],
  }, null, 2));

  const store = new BackgroundStateStore(statePath);
  const status = await store.status();
  assert.equal(status.schema_version, 2);
  const dirty = await store.dirtySessions();
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].deterministic?.fingerprint, FINGERPRINT_A);
  assert.equal(dirty[0].llm, undefined);
  const migrated = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.reviewed_sessions.reviewed.deterministic.fingerprint, FINGERPRINT_B);
  assert.equal(migrated.reviewed_sessions.reviewed.llm, undefined);

  const futurePath = join(home, "background-future.json");
  const futureBytes = JSON.stringify({ ...migrated, schema_version: 3 }, null, 2);
  await writeFile(futurePath, futureBytes);
  await assert.rejects(() => new BackgroundStateStore(futurePath).status(), /Refusing to continue.*schema_version/i);
  assert.equal(await readFile(futurePath, "utf8"), futureBytes);
  const backups = (await readdir(home)).filter((name) => name.startsWith("background-future.json.corrupt."));
  assert.equal(backups.length, 1, "future schema must preserve exactly one evidence backup");
}

async function testCommitWaitsForDurableCandidates(home) {
  const state = new BackgroundStateStore(join(home, "background-ordering.json"));
  const dirtyAt = new Date(Date.now() - 10_000).toISOString();
  await state.markDirty("ordering-session", dirtyAt);
  const baseOptions = {
    enabled: true,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 5_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store: state,
    source_state: async () => ({ source_fingerprint: FINGERPRINT_A, reflection_count: 1, scope: "global" }),
    review: async () => ({
      success: true,
      source_fingerprint: FINGERPRINT_A,
      outcome_class: "success",
      stage: "deterministic",
      candidate_ids: ["review:ordering"],
    }),
  };
  const failing = new BackgroundLifecycle({
    ...baseOptions,
    candidates_durable: async () => false,
  });
  await failing.runNow();
  let dirty = await state.dirtySessions();
  assert.equal(dirty.length, 1, "failed durability verification must retain dirty work");
  assert.equal(dirty[0].deterministic?.fingerprint, undefined, "source fingerprint must not commit before candidates are durable");
  assert.equal(dirty[0].outcome_class, "candidate_persistence_unverified");

  await state.markDirty("ordering-session", new Date(Date.now() - 10_000).toISOString());
  const succeeding = new BackgroundLifecycle({
    ...baseOptions,
    candidates_durable: async (ids) => ids.length === 1 && ids[0] === "review:ordering",
  });
  await succeeding.runNow();
  dirty = await state.dirtySessions();
  assert.equal(dirty.length, 0, "verified candidates allow the stage fingerprint to commit");
}

async function testMissingProvenanceDoesNotInferProject(home) {
  const child = spawn(process.execPath, [process.argv[1], "--missing-provenance-child"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `missing-provenance child failed: ${stderr}`);
}

async function createPreview(client, sessionId, lesson) {
  structured(await call(client, "reflect_on_task", {
    session_id: sessionId,
    task_goal: `Create durable review candidate for ${sessionId}`,
    task_outcome: "success",
    failure_mode: "success",
    summary: "A deterministic review candidate should be queued for approval.",
    lessons_learned: [lesson],
    domain: "software-engineering",
    tags: ["v20-background-test"],
    auto_extract_heuristics: false,
  }));
  const review = structured(await call(client, "trigger_background_review", {
    action: "run",
    session_id: sessionId,
    review_scope: "recent",
    review_mode: "deterministic",
    auto_apply: false,
    response_mode: "full",
  }));
  const candidate = (review.items ?? []).map(itemValue).find((item) => item?.state === "pending");
  assert.ok(candidate?.id, `missing durable review candidate: ${JSON.stringify(review)}`);
  assert.equal(candidate.stage, "deterministic");
  assert.ok(candidate.mutation_id);
  return candidate;
}

async function testDurableQueue(home) {
  let server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  const first = await createPreview(
    server.client,
    "v20-review-preview",
    "Persist review candidates and their approval mutations atomically before recording source progress.",
  );
  await server.close();

  const storePath = join(home, ".hermes-reflection", "store.json");
  let persisted = JSON.parse(await readFile(storePath, "utf8"));
  const storedFirst = persisted.metadata.review_candidates.find((item) => item.id === first.id);
  assert.equal(storedFirst.state, "pending");
  assert.equal(storedFirst.mutation_id, first.mutation_id);
  assert.ok(persisted.metadata.pending_mutations.some((item) => item.id === first.mutation_id && item.operation === "apply_review_candidate"));

  server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  const pending = structured(await call(server.client, "list_pending_mutations", { response_mode: "full" }));
  assert.ok((pending.items ?? []).some((item) => item.id === first.mutation_id && item.operation === "apply_review_candidate"));
  const detail = structured(await call(server.client, "get_memory_item", {
    kind: "review_candidate",
    id: first.id,
    response_mode: "full",
  }));
  assert.equal(itemValue(detail.items?.[0])?.id, first.id);

  assert.equal((await call(server.client, "approve_pending_mutation", {
    mutation_id: first.mutation_id,
    decision: "approve",
  })).isError, undefined);
  await server.close();
  persisted = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(persisted.metadata.review_candidates.find((item) => item.id === first.id)?.state, "applied");
  assert.ok(!persisted.metadata.pending_mutations.some((item) => item.id === first.mutation_id));
  assert.ok(persisted.heuristics.some((item) => item.heuristic.includes("Persist review candidates")));

  server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  const second = await createPreview(
    server.client,
    "v20-review-reject",
    "Rejected review candidates must remain as bounded audit records without mutating heuristic memory.",
  );
  assert.equal((await call(server.client, "approve_pending_mutation", {
    mutation_id: second.mutation_id,
    decision: "reject",
  })).isError, undefined);
  await server.close();
  persisted = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(persisted.metadata.review_candidates.find((item) => item.id === second.id)?.state, "rejected");
  assert.ok(!persisted.metadata.pending_mutations.some((item) => item.id === second.mutation_id));
  assert.ok(!persisted.heuristics.some((item) => item.heuristic.includes("Rejected review candidates")));
}

if (SINGLE_FLIGHT_CHILD) {
  await runSingleFlightChild();
} else if (MANUAL_LEASE_CHILD) {
  await runManualLeaseChild();
} else if (MANUAL_SHUTDOWN_CHILD) {
  await runManualShutdownChild();
} else if (MISSING_PROVENANCE_CHILD) {
  await runMissingProvenanceChild();
} else {
  await withTempHome("background", async (home) => {
    await testBackgroundStateMigration(home);
    await testMissingProvenanceDoesNotInferProject(home);
    await testCommitWaitsForDurableCandidates(home);
    await testDurableQueue(home);
    await testBoundedLlmAndSingleFlight(home);
  });
  console.log("v20 background regression test passed");
}
