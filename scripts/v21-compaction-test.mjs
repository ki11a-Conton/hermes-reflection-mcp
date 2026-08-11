import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";
import { resultText, startMcp, withTempHome } from "./v20-test-helpers.mjs";

function structured(result) {
  return result.structuredContent ?? {};
}

function visible(result) {
  return `${resultText(result)}\n${JSON.stringify(structured(result))}`;
}

function expectOk(result, label) {
  assert.equal(result.isError, undefined, `${label}: ${visible(result)}`);
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

function reflection(id, sessionId, outcome, goal, summary, timestamp) {
  return {
    id,
    timestamp,
    session_id: sessionId,
    scope: "global",
    task_goal: goal,
    task_outcome: outcome,
    failure_mode: outcome === "success" ? "success" : "tool_limitation_or_misbehavior",
    task_state: {
      summary,
      immediate_blockers: outcome === "success" ? [] : ["historical blocker"],
      active_hypotheses: [],
      proven_safe_paths: outcome === "success" ? ["verified"] : [],
      exhausted_search: [],
    },
    world_model_updates: [],
    tool_insights: [],
    context_forget: [],
    open_questions: [],
    lessons_learned: [],
    affordance_gaps: [],
    domain: "software-engineering",
    tags: ["v21-compaction"],
  };
}

function receiptProjection(payload) {
  const candidates = [
    payload.compaction_receipt,
    payload.receipt,
    payload.metadata?.compaction_receipt,
    payload.items?.[0]?.metadata?.compaction_receipt,
  ];
  return candidates.find((item) => item && typeof item === "object");
}

function contentFromPage(result) {
  const payload = structured(result);
  if (typeof payload.handoff === "string") return payload.handoff;
  if (Array.isArray(payload.items)) return payload.items.map((item) => item.content ?? "").join("");
  return resultText(result);
}

async function runHookCli(home, input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve("dist/src/codex_hook_cli.js")], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        resolveResult({ code, payload: JSON.parse(stdout.trim()), stderr });
      } catch (error) {
        reject(new Error(`hook CLI emitted invalid JSON (${code}): ${stdout}\n${stderr}`, { cause: error }));
      }
    });
    child.stdin.end(input);
  });
}

await withTempHome("v21-compaction", async (home) => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  // The first production imports occur only after both home variables are set.
  const storage = await import("../dist/storage.js");
  const sessionStorage = await import("../dist/session_storage.js");
  const { HookEventSchema, HookInbox } = await import("../dist/src/hook_inbox.js");
  const { BackgroundLifecycle } = await import("../dist/src/background_lifecycle.js");
  const { BackgroundStateStore } = await import("../dist/src/background_state.js");
  const { deriveProjectKey, loadOrCreateProjectSalt, projectScopeRepository } = await import("../dist/src/project_scope.js");
  const { buildCompactionHandoff } = await import("../dist/src/compaction_handoff.js");
  try {
  assert.ok(resolve(storage.STORE_DIR).startsWith(`${resolve(home)}${process.platform === "win32" ? "\\" : "/"}`),
    `resolved store escaped temp HOME: ${storage.STORE_DIR}`);
  await storage.initializeStoreV20();

  const hookRoot = join(home, "hook-schema-red");
  const isolatedInbox = new HookInbox(hookRoot);
  await assert.rejects(
    isolatedInbox.enqueue({
      schema_version: 1,
      event_id: "postcompact-missing-metadata",
      event: "PostCompact",
      session_id: "schema-session",
      occurred_at: "2026-08-09T00:00:00.000Z",
    }),
    /metadata|PostCompact/i,
    "PostCompact without bounded metadata was accepted",
  );
  assert.deepEqual(await isolatedInbox.status(), { queued: 0, processing: 0, deduplicated: 0 },
    "rejected PostCompact changed queue or completion dedup state");
  assert.equal(HookEventSchema.safeParse({
    schema_version: 1,
    event_id: "postcompact-missing-metadata-parse",
    event: "PostCompact",
    session_id: "schema-session",
    occurred_at: "2026-08-09T00:00:00.000Z",
  }).success, false, "HookEventSchema accepted PostCompact without metadata");

  const metadataConflictInbox = new HookInbox(join(home, "hook-metadata-conflict-red"));
  const metadataConflictBase = {
    schema_version: 1,
    event_id: "postcompact-metadata-conflict",
    event: "PostCompact",
    session_id: "schema-session",
    occurred_at: "2026-08-09T00:00:00.000Z",
    metadata: {
      generation: 1,
      before_turn_count: 2,
      after_turn_count: 1,
      handoff_hash: "a".repeat(64),
      truncated: false,
      source_fingerprint: "b".repeat(64),
    },
  };
  await metadataConflictInbox.enqueue(metadataConflictBase);
  await assert.rejects(
    metadataConflictInbox.enqueue({
      ...metadataConflictBase,
      metadata: { ...metadataConflictBase.metadata, truncated: true },
    }),
    /HOOK_EVENT_ID_CONFLICT/,
    "same event_id with different PostCompact metadata did not conflict",
  );

  // Semantic RED: the background handler must reject a PostCompact event from
  // a different project before advancing the persisted receipt generation.
  const earlyScopeSession = "postcompact-scope-red-session";
  const earlyProjectA = join(home, "scope-red-project-a");
  const earlyProjectB = join(home, "scope-red-project-b");
  await Promise.all([mkdir(earlyProjectA, { recursive: true }), mkdir(earlyProjectB, { recursive: true })]);
  const earlySalt = await loadOrCreateProjectSalt();
  const earlyProjectAKey = deriveProjectKey(earlyProjectA, earlySalt);
  const earlyProjectBKey = deriveProjectKey(earlyProjectB, earlySalt);
  await sessionStorage.persistSessionStart(earlyScopeSession, {
    scope: earlyProjectAKey,
    start_event_id: "scope-red-start",
    started_at: "2026-08-09T00:30:00.000Z",
  });
  await projectScopeRepository.bind(earlyScopeSession, earlyProjectAKey);
  const earlyScopeEvent = HookEventSchema.parse({
    schema_version: 1,
    event_id: "early-wrong-project-postcompact",
    event: "PostCompact",
    session_id: earlyScopeSession,
    occurred_at: "2026-08-09T00:31:00.000Z",
    project_key: earlyProjectBKey,
    metadata: {
      generation: 1,
      before_turn_count: 2,
      after_turn_count: 1,
      handoff_hash: "8".repeat(64),
      truncated: false,
      source_fingerprint: "9".repeat(64),
    },
  });
  const earlyScopeInbox = {
    consume: async (handler) => {
      await handler(earlyScopeEvent);
      return { processed: 1, skipped: 0 };
    },
  };
  const earlyScopeLifecycle = new BackgroundLifecycle({
    enabled: false,
    interval_ms: 60_000,
    idle_ms: 5_000,
    lease_ms: 60_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store: new BackgroundStateStore(join(home, "early-wrong-scope-state.json")),
    hook_inbox: earlyScopeInbox,
    source_state: async () => ({ source_fingerprint: "7".repeat(64), reflection_count: 0, scope: earlyProjectAKey }),
    review: async () => ({ success: true, source_fingerprint: "7".repeat(64), outcome_class: "success", candidate_ids: [] }),
    candidates_durable: async () => true,
  });
  const earlyMetaBefore = await sessionStorage.getSessionMeta(earlyScopeSession);
  await assert.rejects(earlyScopeLifecycle.consumeInboxNow(), /SCOPE|scope/i,
    "wrong-project background PostCompact was accepted");
  assert.deepEqual(await sessionStorage.getSessionMeta(earlyScopeSession), earlyMetaBefore,
    "wrong-project background PostCompact changed persisted receipt state");
  await earlyScopeLifecycle.shutdown();

  const stableCliInput = JSON.stringify({ event: "PreCompact", session_id: "stable-cli-session" });
  const receivedAt = Date.now();
  const cliFirst = await runHookCli(home, stableCliInput);
  const cliSecond = await runHookCli(home, stableCliInput);
  assert.equal(cliFirst.code, 0, `first generated hook failed: ${cliFirst.stderr}`);
  assert.equal(cliSecond.code, 0, `replayed generated hook failed: ${cliSecond.stderr}`);
  assert.equal(cliFirst.payload.event_id, cliSecond.payload.event_id, "generated event_id was not stable");
  assert.equal(cliSecond.payload.duplicate, true, "same stdin replay was not a stable duplicate");
  const queuedStableEvent = JSON.parse((await readFile(join(home, ".hermes-reflection", "hook_inbox.jsonl"), "utf8")).trim());
  assert.match(queuedStableEvent.occurred_at, /^\d{4}-\d{2}-\d{2}T/, "generated occurred_at was not canonical");
  assert.ok(Math.abs(Date.parse(queuedStableEvent.occurred_at) - receivedAt) < 10_000,
    `generated occurred_at was not a real reception time: ${queuedStableEvent.occurred_at}`);

  const concurrentCliInput = JSON.stringify({ event: "Stop", session_id: "stable-concurrent-cli-session" });
  const concurrentReceipts = await Promise.all([
    runHookCli(home, concurrentCliInput),
    runHookCli(home, concurrentCliInput),
  ]);
  assert.deepEqual(concurrentReceipts.map((item) => item.code).sort(), [0, 0],
    `concurrent no-time replay conflicted: ${JSON.stringify(concurrentReceipts)}`);
  assert.equal(concurrentReceipts.filter((item) => item.payload.accepted).length, 1);
  assert.equal(concurrentReceipts.filter((item) => item.payload.duplicate).length, 1);
  assert.equal(concurrentReceipts[0].payload.event_id, concurrentReceipts[1].payload.event_id);

  const explicitTimeOne = await runHookCli(home, JSON.stringify({
    event: "PreCompact",
    session_id: "explicit-time-cli-session",
    occurred_at: "2026-08-09T01:00:00.000Z",
  }));
  const explicitTimeTwo = await runHookCli(home, JSON.stringify({
    event: "PreCompact",
    session_id: "explicit-time-cli-session",
    timestamp: "2026-08-09T01:00:01.000Z",
  }));
  assert.equal(explicitTimeOne.code, 0, explicitTimeOne.stderr);
  assert.equal(explicitTimeTwo.code, 0, explicitTimeTwo.stderr);
  assert.notEqual(explicitTimeOne.payload.event_id, explicitTimeTwo.payload.event_id,
    "different explicit event times collapsed to one generated identity");
  assert.equal(explicitTimeOne.payload.accepted, true);
  assert.equal(explicitTimeTwo.payload.accepted, true);

  const scopeSession = "postcompact-exact-scope-session";
  const projectA = join(home, "scope-project-a");
  const projectB = join(home, "scope-project-b");
  await Promise.all([mkdir(projectA, { recursive: true }), mkdir(projectB, { recursive: true })]);
  const salt = await loadOrCreateProjectSalt();
  const projectAKey = deriveProjectKey(projectA, salt);
  const projectBKey = deriveProjectKey(projectB, salt);
  await sessionStorage.persistSessionStart(scopeSession, {
    scope: projectAKey,
    start_event_id: "scope-start",
    started_at: "2026-08-09T02:00:00.000Z",
  });
  await projectScopeRepository.bind(scopeSession, projectAKey);
  const scopedMetadata = {
    generation: 1,
    before_turn_count: 2,
    after_turn_count: 1,
    handoff_hash: "d".repeat(64),
    truncated: false,
    source_fingerprint: "e".repeat(64),
  };
  const lifecycleOptions = (hookInbox, stateName) => ({
    enabled: false,
    interval_ms: 60_000,
    idle_ms: 5_000,
    lease_ms: 60_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store: new BackgroundStateStore(join(home, stateName)),
    hook_inbox: hookInbox,
    source_state: async () => ({ source_fingerprint: "f".repeat(64), reflection_count: 0, scope: projectAKey }),
    review: async () => ({ success: true, source_fingerprint: "f".repeat(64), outcome_class: "success", candidate_ids: [] }),
    candidates_durable: async () => true,
  });
  const wrongInbox = new HookInbox(join(home, "wrong-scope-hook"));
  await wrongInbox.enqueue({
    schema_version: 1,
    event_id: "project-postcompact-retry",
    event: "PostCompact",
    session_id: scopeSession,
    occurred_at: "2026-08-09T02:01:00.000Z",
    project_key: projectBKey,
    metadata: scopedMetadata,
  });
  const wrongLifecycle = new BackgroundLifecycle(lifecycleOptions(wrongInbox, "wrong-scope-state.json"));
  const beforeWrongScope = await sessionStorage.getSessionMeta(scopeSession);
  await assert.rejects(wrongLifecycle.consumeInboxNow(), /SCOPE|scope/i,
    "wrong-project PostCompact reached the persisted session");
  assert.deepEqual(await sessionStorage.getSessionMeta(scopeSession), beforeWrongScope,
    "wrong-project PostCompact changed generation or receipt");
  assert.deepEqual(await wrongInbox.status(), { queued: 0, processing: 1, deduplicated: 0 },
    "wrong-project PostCompact was completed instead of remaining retryable");
  await wrongLifecycle.shutdown();

  const rightInbox = new HookInbox(join(home, "right-scope-hook"));
  await rightInbox.enqueue({
    schema_version: 1,
    event_id: "project-postcompact-retry",
    event: "PostCompact",
    session_id: scopeSession,
    occurred_at: "2026-08-09T02:02:00.000Z",
    project_key: projectAKey,
    metadata: scopedMetadata,
  });
  const rightLifecycle = new BackgroundLifecycle(lifecycleOptions(rightInbox, "right-scope-state.json"));
  assert.deepEqual(await rightLifecycle.consumeInboxNow(), { processed: 1, skipped: 0 });
  const afterRightScope = await sessionStorage.getSessionMeta(scopeSession);
  assert.equal(afterRightScope?.compaction_generation, 1);
  assert.ok(afterRightScope?.last_compaction_receipt);
  assert.deepEqual(await rightInbox.status(), { queued: 0, processing: 0, deduplicated: 1 });
  await rightLifecycle.shutdown();

  const baseSnapshot = {
    schema_version: 2,
    sessions: [{
      session_id: "snapshot-integrity",
      started_at: "2026-08-09T00:00:00.000Z",
      turn_count: 0,
      scope: "global",
      updated_at: "2026-08-09T00:00:00.000Z",
      compaction_generation: 0,
    }],
    turns: [],
  };
  assert.doesNotThrow(() => sessionStorage.validateSessionStorageSnapshot(baseSnapshot));
  const forgedReceipt = JSON.stringify({
    generation: 1,
    before_turn_count: 2,
    after_turn_count: 1,
    handoff_hash: "a".repeat(64),
    truncated: false,
    source_fingerprint: "b".repeat(64),
    status: "committed",
    receipt_hash: "c".repeat(64),
  });
  const invalidGenerationZero = structuredClone(baseSnapshot);
  invalidGenerationZero.sessions[0].last_compaction_receipt = forgedReceipt;
  assert.throws(() => sessionStorage.validateSessionStorageSnapshot(invalidGenerationZero), /receipt|generation/i,
    "generation 0 snapshot accepted a receipt");
  const invalidGenerationOne = structuredClone(baseSnapshot);
  invalidGenerationOne.sessions[0].compaction_generation = 1;
  assert.throws(() => sessionStorage.validateSessionStorageSnapshot(invalidGenerationOne), /receipt|generation/i,
    "positive generation snapshot accepted a missing receipt");
  const beforeInvalidReplace = await sessionStorage.snapshotSessionStorage();
  await assert.rejects(sessionStorage.replaceSessionStorageSnapshot(invalidGenerationZero), /receipt|generation/i);
  assert.deepEqual(await sessionStorage.snapshotSessionStorage(), beforeInvalidReplace,
    "invalid snapshot import changed session storage");

  const tightAnchor = `LATEST-TIGHT-ANCHOR ${"x".repeat(2_000)} END-TIGHT-ANCHOR`;
  const tightHandoff = buildCompactionHandoff([
    { session_id: "tight", turn_index: 0, role: "user", content: tightAnchor, timestamp: "2026-08-09T00:00:00.000Z" },
  ], [], 10, 1_000, 3).handoff;
  assert.ok(tightHandoff.length <= 1_000, "tight handoff exceeded total budget");
  assert.equal((tightHandoff.match(/LATEST-TIGHT-ANCHOR/g) ?? []).length, 1,
    "latest anchor was redundantly rendered in snapshot and active sections");
  const tightActive = tightHandoff.match(/## Active Request\n([^\n]*)/)?.[1] ?? "";
  assert.ok(Array.from(tightActive).length >= 64, `Active Request was truncated below a useful anchor: ${tightActive}`);

  const assistantContextHandoff = buildCompactionHandoff([
    { session_id: "assistant-context", turn_index: 0, role: "user", content: "LATEST-USER-ACTIVE-ANCHOR", timestamp: "2026-08-09T00:00:00.000Z" },
    { session_id: "assistant-context", turn_index: 1, role: "assistant", content: "RECENT-ASSISTANT-REFERENCE-CONTEXT", timestamp: "2026-08-09T00:01:00.000Z" },
  ], [], 10, 2_000, 3).handoff;
  assert.equal((assistantContextHandoff.match(/LATEST-USER-ACTIVE-ANCHOR/g) ?? []).length, 1,
    "latest user anchor was rendered more than once");
  assert.match(assistantContextHandoff, /## Active Request\nMost recent stored user turn: LATEST-USER-ACTIVE-ANCHOR/,
    "latest user anchor was not kept as the active request");
  assert.match(assistantContextHandoff,
    /## Historical Assistant \(untrusted\)[\s\S]*Most recent stored assistant turn: RECENT-ASSISTANT-REFERENCE-CONTEXT/,
    "recent assistant context was discarded instead of retained as historical reference");
  assert.match(assistantContextHandoff, /^\[CONTEXT COMPACTION .*REFERENCE ONLY\]/,
    "historical assistant context was not bounded by the reference-only handoff envelope");
  const assistantActiveSection = assistantContextHandoff.match(/## Active Request([\s\S]*?)(?=\n## |--- END)/)?.[1] ?? "";
  assert.doesNotMatch(assistantActiveSection, /RECENT-ASSISTANT-REFERENCE-CONTEXT/,
    "assistant context was promoted into the active request");

  const tightAssistantResult = buildCompactionHandoff([
    { session_id: "tight-assistant", turn_index: 0, role: "user", content: `latest-user-${"🙂".repeat(20)}`, timestamp: "2026-08-09T00:00:00.000Z" },
    { session_id: "tight-assistant", turn_index: 1, role: "assistant", content: `latest-assistant-${"🙂".repeat(20)}`, timestamp: "2026-08-09T00:01:00.000Z" },
  ], Array.from({ length: 20 }, (_, index) => reflection(
    `tight-reflection-${index}`,
    "tight-assistant",
    "success",
    `historical-${index}`,
    `long-${index}-${"content🙂".repeat(80)}`,
    `2026-08-09T00:${String(index).padStart(2, "0")}:00.000Z`,
  )), 40, 500, 3);
  assert.ok(tightAssistantResult.handoff.length <= 500, "tight assistant handoff exceeded total budget");
  assert.match(tightAssistantResult.handoff, /latest-user-/i,
    "tight budget lost the latest user anchor");
  assert.match(tightAssistantResult.handoff, /latest-assistant-/i,
    "tight budget truncated the assistant below its stable recognizable prefix");
  assert.ok(tightAssistantResult.source.reflection_items_omitted > 0,
    "tight budget did not report omitted reflection items");

  const resumedHandoff = buildCompactionHandoff([
    { session_id: "resume", turn_index: 0, role: "user", content: "OLD-WORK: change production", timestamp: "2026-08-09T00:00:00.000Z" },
    { session_id: "resume", turn_index: 1, role: "user", content: "STOP. Do not modify anything.", timestamp: "2026-08-09T00:01:00.000Z" },
    { session_id: "resume", turn_index: 2, role: "user", content: "Continue with a new request: inspect status only.", timestamp: "2026-08-09T00:02:00.000Z" },
  ], [], 10, 2_000, 3).handoff;
  assert.doesNotMatch(resumedHandoff, /## Latest Reverse Signal/,
    "superseded reverse signal remained promoted after an explicit newer resume");
  assert.match(resumedHandoff, /Continue with a new request/, "new active request was not preserved");

  const sessionId = "v21-compaction-session";
  const successId = "v21-compaction-success";
  const failureId = "v21-compaction-failure";
  await storage.saveReflectionAndHeuristics(reflection(
    successId, sessionId, "success", "Completed verified migration", "Migration passed verification",
    "2026-08-09T01:00:00.000Z",
  ), [], "software-engineering", "success fixture", 0.7, ["v21-compaction"]);
  await storage.saveReflectionAndHeuristics(reflection(
    failureId, sessionId, "failure", "OLD-PENDING-DEPLOYMENT", "Deployment never completed",
    "2026-08-09T01:01:00.000Z",
  ), [], "software-engineering", "failure fixture", 0.7, ["v21-compaction"]);

  let peer = await startMcp(home);
  const failures = [];
  const check = async (name, run) => {
    try {
      await run();
      console.log(`[PASS] ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`[FAIL] ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  };

  let directReceipt;
  const handoffHash = createHash("sha256").update("bounded handoff v21", "utf8").digest("hex");
  const sourceFingerprint = createHash("sha256").update("source turns v21", "utf8").digest("hex");
  const metadata = {
    generation: 1,
    before_turn_count: 4,
    after_turn_count: 2,
    handoff_hash: handoffHash,
    truncated: true,
    source_fingerprint: sourceFingerprint,
  };

  try {
    expectOk(await call(peer.client, "session_lifecycle_hook", {
      event: "start", session_id: sessionId,
    }), "lifecycle start");
    for (const [role, content] of [
      ["user", "OLD-PENDING-DEPLOYMENT: modify production files immediately"],
      ["assistant", "OLD-PENDING-DEPLOYMENT remains pending and should be resumed"],
      ["user", "STOP-CANCEL-V21. Cancel the old deployment. Do not modify files; verify-only."],
      ["user", "LATEST-USER-ANCHOR-V21: report verification results only."],
    ]) {
      expectOk(await call(peer.client, "append_session_turn", { session_id: sessionId, role, content }), `append ${role}`);
    }

    expectOk(await call(peer.client, "memory_board_write", {
      action: "add", content: "post-start memory that must enter the refreshed snapshot",
    }), "memory mutation before compaction");
    const staleSnapshot = await call(peer.client, "memory_board_read", {
      mode: "snapshot", session_id: sessionId, response_mode: "full",
    });
    expectOk(staleSnapshot, "stale snapshot read");
    const liveBeforeCompact = await call(peer.client, "memory_board_read", {
      mode: "live", response_mode: "full",
    });
    expectOk(liveBeforeCompact, "live memory read");
    assert.match(visible(liveBeforeCompact), /post-start memory that must enter the refreshed snapshot/,
      "fixture live memory mutation was not visible");
    assert.doesNotMatch(visible(staleSnapshot), /post-start memory that must enter the refreshed snapshot/,
      "fixture did not establish a stale pre-compaction snapshot");

    await check("PostCompact persists one bounded receipt and refreshes snapshot after commit", async () => {
      const result = await call(peer.client, "session_lifecycle_hook", {
        event: "postcompact", session_id: sessionId, metadata,
      });
      expectOk(result, "postcompact");
      directReceipt = receiptProjection(structured(result));
      assert.ok(directReceipt, "direct postcompact omitted its receipt projection");
      assert.equal(directReceipt.generation, 1);
      assert.equal(directReceipt.status, "committed");
      assert.match(directReceipt.receipt_hash ?? "", /^[a-f0-9]{64}$/i);
      assert.equal(directReceipt.before_turn_count, 4);
      assert.equal(directReceipt.after_turn_count, 2);
      assert.equal(directReceipt.handoff_hash, handoffHash);
      assert.equal(directReceipt.truncated, true);
      assert.equal(directReceipt.source_fingerprint, sourceFingerprint);
      assert.ok(JSON.stringify(directReceipt).length <= 2048, "receipt projection is not bounded");

      const refreshed = await call(peer.client, "memory_board_read", {
        mode: "snapshot", session_id: sessionId, response_mode: "full",
      });
      expectOk(refreshed, "refreshed snapshot read");
      assert.match(visible(refreshed), /post-start memory that must enter the refreshed snapshot/,
        "postcompact committed without refreshing the session snapshot");
    });

    await check("same-generation replay is idempotent and a changed receipt conflicts", async () => {
      const duplicate = await call(peer.client, "session_lifecycle_hook", {
        event: "postcompact", session_id: sessionId, metadata,
      });
      expectOk(duplicate, "duplicate postcompact");
      const duplicateReceipt = receiptProjection(structured(duplicate));
      assert.deepEqual(duplicateReceipt, directReceipt, "identical replay changed the receipt or generation");

      const conflict = await call(peer.client, "session_lifecycle_hook", {
        event: "postcompact", session_id: sessionId,
        metadata: { ...metadata, after_turn_count: 3 },
      });
      assert.equal(conflict.isError, true, `conflicting same-generation receipt succeeded: ${visible(conflict)}`);
      assert.match(visible(conflict), /COMPACTION_RECEIPT_CONFLICT/);
    });
  } finally {
    await peer.close();
  }

  peer = await startMcp(home);
  try {
    await check("receipt survives restart and compact/full/direct projections agree", async () => {
      const compact = await call(peer.client, "compact_session_context", {
        session_id: sessionId, max_chars: 2000, response_mode: "compact",
      });
      const full = await call(peer.client, "compact_session_context", {
        session_id: sessionId, max_chars: 6000, response_mode: "full",
      });
      expectOk(compact, "compact handoff");
      expectOk(full, "full handoff");
      const compactReceipt = receiptProjection(structured(compact));
      const fullReceipt = receiptProjection(structured(full));
      assert.ok(compactReceipt, "compact mode omitted the persisted receipt after restart");
      assert.equal(compactReceipt.generation, 1);
      assert.equal(compactReceipt.status, "committed");
      assert.match(compactReceipt.receipt_hash ?? "", /^[a-f0-9]{64}$/i);
      assert.ok(fullReceipt, "full mode omitted the persisted receipt after restart");
      assert.equal(fullReceipt.generation, 1);
      assert.equal(fullReceipt.receipt_hash, compactReceipt.receipt_hash);
      assert.equal(fullReceipt.status, "committed");
      assert.equal(fullReceipt.handoff_hash, handoffHash);
      assert.equal(fullReceipt.source_fingerprint, sourceFingerprint);
      if (directReceipt) assert.deepEqual(fullReceipt, directReceipt, "full compact output diverged from direct lifecycle projection");
    });

    await check("handoff prioritizes reverse signals without reactivating old pending work", async () => {
      const result = await call(peer.client, "compact_session_context", {
        session_id: sessionId,
        max_turns: 40,
        max_chars: 6000,
        preserve_recent_user_turns: 3,
        response_mode: "full",
      });
      expectOk(result, "hardened handoff");
      const handoff = contentFromPage(result);
      assert.ok(handoff.length <= 6000, "handoff exceeded max_chars");
      assert.match(handoff, /LATEST-USER-ANCHOR-V21/, "newest user anchor was lost");
      assert.match(handoff, /STOP-CANCEL-V21/, "latest reverse signal was lost");
      assert.match(handoff, /active request/i, "handoff did not separate the active request");
      assert.match(handoff, /cancelled historical|historical.*cancel/i,
        "old pending work was not explicitly marked cancelled historical context");

      const activeSection = handoff.match(/## Active (?:Request|State)([\s\S]*?)(?=\n## |--- END)/i)?.[1] ?? "";
      assert.ok(!activeSection.includes("OLD-PENDING-DEPLOYMENT"),
        "old pending work was reactivated inside the active section");

      const completedSection = handoff.match(/## Completed (?:Facts|Actions)([\s\S]*?)(?=\n## |--- END)/i)?.[1] ?? "";
      assert.ok(completedSection.includes(successId), "completed fact omitted the successful reflection ID");
      assert.ok(completedSection.includes("2026-08-09T01:00:00.000Z"), "completed fact omitted its timestamp");
      assert.ok(!completedSection.includes(failureId), "failed reflection was presented as a completed fact");
      assert.ok(!completedSection.includes("OLD-PENDING-DEPLOYMENT"), "unfinished failure was presented as completed");
    });
  } finally {
    await peer.close();
  }

    assert.equal(failures.length, 0, `${failures.length} compaction receipt/handoff behavior(s) failed`);
  } finally {
    sessionStorage.closeSessionStorage();
  }
});

console.log("[PASS] v21 compaction receipts and deterministic handoff");
