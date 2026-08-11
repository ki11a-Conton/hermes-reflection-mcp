import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  assert,
  resultText,
  startMcp,
  withTempHome,
} from "./v20-test-helpers.mjs";
import { BackgroundLifecycle } from "../dist/src/background_lifecycle.js";
import { BackgroundStateStore } from "../dist/src/background_state.js";
import { withFileLock } from "../dist/src/file_lock.js";
import { HookInbox } from "../dist/src/hook_inbox.js";
import { HookInboxPump } from "../dist/src/hook_inbox_pump.js";

const PROJECT_KEY = `project:${"a".repeat(64)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function event(eventId, sessionId, overrides = {}) {
  return {
    schema_version: 1,
    event_id: eventId,
    event: "SessionStart",
    session_id: sessionId,
    occurred_at: new Date().toISOString(),
    project_key: PROJECT_KEY,
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await predicate()) return Date.now() - startedAt;
    await delay(25);
  }
  return undefined;
}

async function provenanceCase(home) {
  const inbox = new HookInbox(join(home, "provenance-inbox"));
  const missing = event("missing-provenance", "missing-provenance-session");
  delete missing.project_key;
  await assert.rejects(
    () => inbox.enqueue(missing),
    /scope_intent|project_key|provenance/i,
    "SessionStart without project or explicit global intent must fail closed",
  );

  const explicitGlobal = { ...missing, event_id: "explicit-global", scope_intent: "global" };
  assert.equal((await inbox.enqueue(explicitGlobal)).accepted, true);
  await inbox.consume(async () => undefined);

  await assert.rejects(
    () => inbox.enqueue(event("conflicting-provenance", "conflicting-provenance-session", { scope_intent: "global" })),
    /scope_intent|project_key|conflict/i,
  );
}

async function eventIdCollisionCase(home) {
  const inbox = new HookInbox(join(home, "event-id-collision"));
  const original = event("stable-event-id", "collision-session");
  assert.equal((await inbox.enqueue(original)).accepted, true);
  assert.equal((await inbox.enqueue({ ...original })).duplicate, true);
  await assert.rejects(
    () => inbox.enqueue({ ...original, session_id: "other-session" }),
    /HOOK_EVENT_ID_CONFLICT|event.id.*conflict/i,
    "same event ID with different canonical input must not be treated as a duplicate",
  );
  await inbox.consume(async () => undefined);
  assert.equal((await inbox.enqueue({ ...original })).duplicate, true);
  await assert.rejects(
    () => inbox.enqueue({ ...original, project_key: `project:${"b".repeat(64)}` }),
    /HOOK_EVENT_ID_CONFLICT|event.id.*conflict/i,
  );
}

async function completedLedgerRetentionCase(home) {
  const inbox = new HookInbox(join(home, "completed-ledger-retention"));
  await mkdir(inbox.root, { recursive: true });
  const occurredAt = new Date().toISOString();
  const completed = Array.from({ length: 1_000 }, (_, index) => {
    const item = event(`completed-ledger-${index}`, `completed-ledger-session-${index}`, { occurred_at: occurredAt });
    const canonical = JSON.stringify({
      schema_version: 1,
      event_id: item.event_id,
      event: item.event,
      session_id: item.session_id,
      occurred_at: occurredAt,
      project_key: PROJECT_KEY,
      scope_intent: "project",
    });
    return {
      event_id: item.event_id,
      event: item.event,
      session_id: item.session_id,
      occurred_at: occurredAt,
      completed_at: occurredAt,
      event_hash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    };
  });
  const staged = `${inbox.dedupPath}.fixture`;
  await writeFile(staged, JSON.stringify({ schema_version: 1, completed }), "utf8");
  await rename(staged, inbox.dedupPath);
  const first = event("completed-ledger-0", "completed-ledger-session-0", { occurred_at: occurredAt });
  let applied = 0;
  const overflow = event("completed-ledger-1000", "completed-ledger-session-1000", { occurred_at: occurredAt });
  assert.equal((await inbox.enqueue(overflow)).accepted, true);
  await inbox.consume(async () => { applied += 1; });
  assert.equal(applied, 1);

  const replay = await inbox.enqueue(first);
  assert.equal(replay.duplicate, true, "a completed event ID must never be forgotten after more than 1000 completions");
  assert.equal(replay.accepted, false);
}

async function completedLedgerCapacityFailClosedCase(home) {
  const inbox = new HookInbox(join(home, "completed-ledger-capacity"));
  await mkdir(inbox.root, { recursive: true });
  const occurredAt = new Date().toISOString();
  const completed = Array.from({ length: 4_096 }, (_, index) => {
    const item = event(`capacity-${index}`, `capacity-session-${index}`, { occurred_at: occurredAt });
    const canonical = JSON.stringify({
      schema_version: 1,
      event_id: item.event_id,
      event: item.event,
      session_id: item.session_id,
      occurred_at: occurredAt,
      project_key: PROJECT_KEY,
      scope_intent: "project",
    });
    return {
      event_id: item.event_id,
      event: item.event,
      session_id: item.session_id,
      occurred_at: occurredAt,
      completed_at: occurredAt,
      event_hash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    };
  });
  const serialized = JSON.stringify({ schema_version: 1, completed });
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 4 * 1024 * 1024, "capacity fixture must fit the hard ledger byte limit");
  await writeFile(inbox.dedupPath, serialized, "utf8");

  const original = event("capacity-0", "capacity-session-0", { occurred_at: occurredAt });
  const replay = await inbox.enqueue(original);
  assert.equal(replay.accepted, false);
  assert.equal(replay.duplicate, true, "an existing completion must remain replayable at full capacity");
  await assert.rejects(
    () => inbox.enqueue({ ...original, session_id: "capacity-conflict" }),
    /HOOK_EVENT_ID_CONFLICT|event.id.*conflict/i,
    "a conflicting reuse of a completed event ID must still fail closed at full capacity",
  );

  const overflow = event("capacity-overflow", "capacity-overflow-session", { occurred_at: occurredAt });
  await assert.rejects(
    () => inbox.enqueue(overflow),
    /HOOK_COMPLETION_LEDGER_FULL/,
    "a new event must be rejected before it can become pending when completion capacity is exhausted",
  );
  let handled = 0;
  let claimed = 0;
  const consumed = await inbox.consume(async () => { handled += 1; }, {
    onClaimed: () => { claimed += 1; },
  });
  assert.deepEqual(consumed, { processed: 0, skipped: 0 });
  assert.equal(handled, 0, "the handler must not run after capacity rejection");
  assert.equal(claimed, 0, "the claim observer must not run after capacity rejection");

  const status = await inbox.status();
  assert.equal(status.queued, 0, "capacity rejection must not create a queued event");
  assert.equal(status.processing, 0, "capacity rejection must not create a processing event");
  assert.equal(status.deduplicated, 4_096);
  const persisted = JSON.parse(await readFile(inbox.dedupPath, "utf8"));
  assert.deepEqual(persisted.completed, completed, "capacity rejection must preserve every prior completion record");
}

function legacyCompleted(item) {
  return {
    schema_version: 1,
    completed: [{
      event_id: item.event_id,
      event: item.event,
      session_id: item.session_id,
      occurred_at: item.occurred_at,
      completed_at: new Date().toISOString(),
    }],
  };
}

async function legacyCompletedFailClosedCase(home) {
  const occurredAt = new Date().toISOString();
  for (const [suffix, projectKey] of [["without-project", undefined], ["with-project", PROJECT_KEY]]) {
    const root = join(home, `legacy-completed-${suffix}`);
    const inbox = new HookInbox(root);
    await mkdir(root, { recursive: true });
    const stop = {
      schema_version: 1,
      event_id: `legacy-stop-${suffix}`,
      event: "Stop",
      session_id: `legacy-stop-session-${suffix}`,
      occurred_at: occurredAt,
      ...(projectKey ? { project_key: projectKey } : {}),
    };
    await writeFile(inbox.dedupPath, JSON.stringify(legacyCompleted(stop)), "utf8");
    await assert.rejects(
      () => inbox.enqueue(stop),
      /HOOK_EVENT_ID_CONFLICT|event.id.*conflict/i,
      `legacy completion ${suffix} cannot prove canonical equality`,
    );
    await writeFile(inbox.queuePath, `${JSON.stringify(stop)}\n`, "utf8");
    await assert.rejects(
      () => inbox.status(),
      /HOOK_EVENT_ID_CONFLICT|event.id.*conflict/i,
      `status must fail closed for a legacy completed/queued collision ${suffix}`,
    );
  }

  const startRoot = join(home, "legacy-completed-pending-start");
  const startInbox = new HookInbox(startRoot);
  await mkdir(startRoot, { recursive: true });
  const start = event("legacy-start", "legacy-start-session");
  await writeFile(startInbox.dedupPath, JSON.stringify(legacyCompleted(start)), "utf8");
  await writeFile(startInbox.processingPath, `${JSON.stringify(start)}\n`, "utf8");
  await assert.rejects(
    () => startInbox.hasPendingSessionStart(start.session_id),
    /HOOK_EVENT_ID_CONFLICT|event.id.*conflict/i,
    "pending-start lookup must fail closed for a legacy completed/processing collision",
  );
}

async function deadConsumerRecoveryCase(home) {
  const root = join(home, "dead-consumer-recovery");
  const inbox = new HookInbox(root);
  await mkdir(root, { recursive: true });
  const pending = event("dead-consumer-event", "dead-consumer-session");
  await writeFile(inbox.processingPath, `${JSON.stringify(pending)}\n`, "utf8");
  await writeFile(join(root, "hook_inbox.consumer.lock"), JSON.stringify({
    pid: 2_147_483_647,
    token: "dead-owner",
    created_at: new Date().toISOString(),
  }), "utf8");

  let applied = 0;
  const pump = new HookInboxPump(inbox, async () => { applied += 1; }, 100);
  pump.start();
  try {
    const recovered = await waitFor(async () => (await inbox.status()).deduplicated === 1, 5_000);
    assert.notEqual(recovered, undefined, "fresh dead consumer ownership must recover within five seconds");
    assert.equal(applied, 1, "crash recovery must apply the processing event exactly once");
  } finally {
    await pump.shutdown(500);
  }
}

async function timerUnrefCase(home) {
  const pump = new HookInboxPump(new HookInbox(join(home, "timer-unref")), async () => undefined, 100);
  pump.start();
  try {
    assert.equal((await pump.status()).timer_unrefed, true, "poll timer must not keep Codex Desktop alive");
  } finally {
    await pump.shutdown(500);
  }
}

async function waitForCompleted(root, eventId, timeoutMs = 5_250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const state = JSON.parse(await readFile(join(root, "hook_dedup.json"), "utf8"));
      if (state.completed?.some((item) => item.event_id === eventId)) {
        return Date.now() - startedAt;
      }
    } catch {}
    await delay(25);
  }
  return undefined;
}

async function postReadyConsumptionCase(home, enabled) {
  const root = join(home, ".hermes-reflection");
  const inbox = new HookInbox(root);
  const barrierId = `startup-barrier-${enabled ? "enabled" : "disabled"}`;
  // Put one event in the pre-start queue so observing its completion proves the
  // one-shot startup drain has ended. The event under test is enqueued only
  // after that barrier, eliminating a connect/startup scheduling race.
  await inbox.enqueue(event(barrierId, `session-${barrierId}`));
  const mcp = await startMcp(home, {
    HERMES_REFLECTION_BACKGROUND_ENABLED: enabled ? "1" : "0",
    // The Hook pump must not wait for this review-only interval.
    HERMES_REFLECTION_BACKGROUND_INTERVAL_MS: "60000",
    HERMES_REFLECTION_BACKGROUND_IDLE_MS: "60000",
  });
  try {
    const barrierElapsed = await waitForCompleted(root, barrierId);
    assert.notEqual(barrierElapsed, undefined, "startup drain did not complete its barrier event");
    const eventId = `post-ready-${enabled ? "enabled" : "disabled"}`;
    const acceptedAt = Date.now();
    const receipt = await inbox.enqueue(event(eventId, `session-${eventId}`));
    assert.equal(receipt.accepted, true);
    const elapsed = await waitForCompleted(root, eventId);
    assert.notEqual(
      elapsed,
      undefined,
      `post-ready SessionStart was not consumed within five seconds when review was ${enabled ? "enabled" : "disabled"}`,
    );
    assert.ok(Date.now() - acceptedAt <= 5_000, `Hook consumption exceeded five seconds (${Date.now() - acceptedAt}ms)`);
  } finally {
    await mcp.close();
  }
}

async function pendingStartCase(home, state) {
  const root = join(home, ".hermes-reflection");
  const inbox = new HookInbox(root);
  const sessionId = `pending-${state}-session`;
  const queued = event(`pending-${state}-event`, sessionId);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  let held;
  if (state === "queued") {
    held = withFileLock(join(root, "hook_inbox.consumer"), async () => {
      readyResolve();
      await gate;
    });
    await ready;
    await inbox.enqueue(queued);
  } else {
    await inbox.enqueue(queued);
    held = inbox.consume(async () => {
      readyResolve();
      await gate;
    });
    await ready;
  }

  const mcp = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    const result = await mcp.client.callTool({
      name: "append_session_turn",
      arguments: {
        session_id: sessionId,
        project_key: PROJECT_KEY,
        role: "user",
        content: `must wait for ${state} SessionStart`,
      },
    });
    assert.equal(result.isError, true, `${state} SessionStart must block unknown-session writes: ${JSON.stringify(result)}`);
    assert.match(resultText(result), /LIFECYCLE_NOT_READY/, `${state} start returned the wrong failure: ${resultText(result)}`);
  } finally {
    await mcp.close();
    release();
    await held;
  }
}

function lifecycleOptions(home, inbox, processHookEvent, enabled = false) {
  return {
    enabled,
    interval_ms: 60_000,
    idle_ms: 60_000,
    lease_ms: 60_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store: new BackgroundStateStore(join(home, "background-state.json")),
    hook_inbox: inbox,
    process_hook_event: processHookEvent,
    source_state: async () => ({ source_fingerprint: "b".repeat(64), reflection_count: 0, scope: "global" }),
    review: async () => {
      throw new Error("Hook pumping must not invoke the review provider");
    },
    candidates_durable: async () => true,
  };
}

async function singleFlightCase(home) {
  const inbox = new HookInbox(join(home, "single-flight-inbox"));
  await inbox.enqueue(event("single-flight-1", "single-flight-session-1"));
  await inbox.enqueue(event("single-flight-2", "single-flight-session-2"));
  let active = 0;
  let maximumActive = 0;
  const seen = [];
  const lifecycle = new BackgroundLifecycle(lifecycleOptions(home, inbox, async (hookEvent) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    seen.push(hookEvent.event_id);
    await delay(40);
    active -= 1;
  }));
  try {
    await Promise.all(Array.from({ length: 8 }, () => lifecycle.consumeInboxNow()));
    assert.equal(maximumActive, 1, "concurrent drain requests must share one in-process consumer flight");
    assert.deepEqual(seen, ["single-flight-1", "single-flight-2"], "durable inbox order and exactly-once application must be preserved");
  } finally {
    await lifecycle.shutdown();
  }
}

function findInboxTelemetry(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  const keys = ["queued", "processing", "deduplicated", "abandoned"];
  if (keys.every((key) => Number.isInteger(value[key]) && value[key] >= 0)) return value;
  for (const child of Object.values(value)) {
    const found = findInboxTelemetry(child, seen);
    if (found) return found;
  }
  return undefined;
}

async function shutdownDrainCase(home) {
  const inbox = new HookInbox(join(home, "shutdown-inbox"));
  await inbox.enqueue(event("shutdown-claimed", "shutdown-session"));
  let claimedResolve;
  const claimed = new Promise((resolve) => { claimedResolve = resolve; });
  const lifecycle = new BackgroundLifecycle(lifecycleOptions(home, inbox, async () => {
    claimedResolve();
    await delay(120);
  }));

  const drain = lifecycle.consumeInboxNow();
  await claimed;
  const startedAt = Date.now();
  await lifecycle.shutdown(500);
  const elapsed = Date.now() - startedAt;
  await drain;
  assert.ok(elapsed >= 80, `shutdown returned before its claimed Hook completed (${elapsed}ms)`);
  assert.ok(elapsed < 500, `shutdown exceeded its bounded drain deadline (${elapsed}ms)`);

  const status = await lifecycle.status();
  const telemetry = findInboxTelemetry(status);
  assert.ok(telemetry, `Hook queue telemetry is absent from lifecycle status: ${JSON.stringify(status)}`);
  assert.equal(telemetry.processing, 0);
  assert.equal(telemetry.abandoned, 0);
  assert.ok(telemetry.deduplicated >= 1);
}

async function shutdownAbandonCase(home) {
  const inbox = new HookInbox(join(home, "shutdown-abandon-inbox"));
  await inbox.enqueue(event("shutdown-abandoned", "shutdown-abandoned-session"));
  let claimedResolve;
  const claimed = new Promise((resolve) => { claimedResolve = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const lifecycle = new BackgroundLifecycle(lifecycleOptions(home, inbox, async () => {
    claimedResolve();
    await gate;
  }));

  const drain = lifecycle.consumeInboxNow();
  await claimed;
  const startedAt = Date.now();
  await lifecycle.shutdown(100);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 70, `shutdown did not honor the bounded claim-drain window (${elapsed}ms)`);
  assert.ok(elapsed < 500, `shutdown did not return after its bounded claim-drain window (${elapsed}ms)`);

  const telemetry = findInboxTelemetry(await lifecycle.status());
  assert.ok(telemetry, "Hook queue telemetry is absent after a shutdown deadline");
  assert.ok(telemetry.processing >= 1 || telemetry.abandoned >= 1, JSON.stringify(telemetry));
  assert.ok(telemetry.abandoned >= 1, `claimed work that exceeded shutdown must be reported abandoned: ${JSON.stringify(telemetry)}`);

  release();
  await drain;
}

async function shutdownDeadlineLockCase(home) {
  const root = join(home, "shutdown-deadline-lock");
  const inbox = new HookInbox(root);
  await inbox.enqueue(event("shutdown-deadline-lock-event", "shutdown-deadline-lock-session"));
  let claimedResolve;
  const claimed = new Promise((resolve) => { claimedResolve = resolve; });
  let releaseHandler;
  const handlerGate = new Promise((resolve) => { releaseHandler = resolve; });
  const pump = new HookInboxPump(inbox, async () => {
    claimedResolve();
    await handlerGate;
  }, 100);
  const drain = pump.drainNow();
  await claimed;

  let stateLockedResolve;
  const stateLocked = new Promise((resolve) => { stateLockedResolve = resolve; });
  const lockHolder = withFileLock(join(root, "hook_inbox.state"), async () => {
    stateLockedResolve();
    await delay(800);
  });
  await stateLocked;
  const startedAt = Date.now();
  await pump.shutdown(100);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 500, `shutdown waited on status lock after its deadline (${elapsed}ms)`);
  releaseHandler();
  await Promise.allSettled([drain, lockHolder]);
}

async function memoizedShutdownCase(home) {
  const inbox = new HookInbox(join(home, "memoized-shutdown"));
  await inbox.enqueue(event("memoized-shutdown-event", "memoized-shutdown-session"));
  let claimedResolve;
  const claimed = new Promise((resolve) => { claimedResolve = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pump = new HookInboxPump(inbox, async () => {
    claimedResolve();
    await gate;
  }, 100);
  const drain = pump.drainNow();
  await claimed;
  await Promise.all([pump.shutdown(100), pump.shutdown(100), pump.shutdown(100)]);
  assert.equal((await pump.status()).abandoned, 1, "concurrent shutdown calls must count one abandoned claim once");
  release();
  await drain;
}

async function waitingToClaimCase(home) {
  const root = join(home, "waiting-to-claim");
  const inbox = new HookInbox(root);
  await inbox.enqueue(event("waiting-to-claim-event", "waiting-to-claim-session"));
  let lockedResolve;
  const locked = new Promise((resolve) => { lockedResolve = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const holder = withFileLock(join(root, "hook_inbox.consumer"), async () => {
    lockedResolve();
    await gate;
  });
  await locked;
  const pump = new HookInboxPump(inbox, async () => undefined, 100);
  const drain = pump.drainNow();
  await pump.shutdown(100);
  assert.equal((await pump.status()).abandoned, 0, "waiting for claim ownership is not abandoned claimed work");
  release();
  await Promise.allSettled([holder, drain]);
}

async function schedulerSharesPumpFlightCase(home) {
  const inbox = new HookInbox(join(home, "scheduler-shared-flight"));
  await inbox.enqueue(event("scheduler-shared-flight-event", "scheduler-shared-flight-session"));
  const originalConsume = inbox.consume.bind(inbox);
  let consumeCalls = 0;
  inbox.consume = async (...args) => {
    consumeCalls += 1;
    return originalConsume(...args);
  };
  const options = lifecycleOptions(home, inbox, async () => { await delay(50); }, true);
  const originalDirtySessions = options.store.dirtySessions.bind(options.store);
  let dirtyReads = 0;
  let queuedRearmResolve;
  const queuedRearm = new Promise((resolve) => { queuedRearmResolve = resolve; });
  let releaseRearm;
  const rearmGate = new Promise((resolve) => { releaseRearm = resolve; });
  options.store.dirtySessions = async (...args) => {
    dirtyReads += 1;
    if (dirtyReads === 3) {
      queuedRearmResolve();
      await rearmGate;
    }
    return originalDirtySessions(...args);
  };
  const lifecycle = new BackgroundLifecycle(options);
  try {
    await Promise.all([lifecycle.consumeInboxNow(), lifecycle.runNow()]);
    assert.equal(consumeCalls, 1, "scheduler and prompt pump must share the same in-process consume flight");
    await queuedRearm;
    let shutdownSettled = false;
    const shutdown = lifecycle.shutdown(500).then(() => { shutdownSettled = true; });
    await delay(25);
    assert.equal(shutdownSettled, false, "shutdown must drain queued deadline rearm work before returning");
    releaseRearm();
    await shutdown;
  } finally {
    releaseRearm();
    await lifecycle.shutdown(500);
  }
}

async function crossProcessClaimCase(home) {
  const root = join(home, "cross-process-claim");
  const inbox = new HookInbox(root);
  await inbox.enqueue(event("cross-process-event", "cross-process-session"));
  const moduleUrl = new URL("../dist/src/hook_inbox.js", import.meta.url).href;
  const worker = `
    import { appendFile } from 'node:fs/promises';
    import { HookInbox } from ${JSON.stringify(moduleUrl)};
    const inbox = new HookInbox(process.argv[1]);
    await inbox.consume(async (event) => appendFile(process.argv[2], event.event_id + '\\n', 'utf8'));
  `;
  const output = join(root, "applied.txt");
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker, root, output], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`claim worker exited ${code}: ${stderr}`)));
  });
  await Promise.all([run(), run()]);
  const applied = (await readFile(output, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(applied, ["cross-process-event"], "cross-process consumers must claim and apply exactly once");
}

async function failedHandlerRestartCase(home) {
  const root = join(home, "failed-handler-restart");
  const sessionId = "failed-handler-session";
  const inbox = new HookInbox(root);
  await inbox.enqueue(event("failed-handler-event", sessionId));
  let attempts = 0;
  await assert.rejects(() => inbox.consume(async () => {
    attempts += 1;
    throw new Error("test handler failure");
  }), /test handler failure/);
  assert.equal(await inbox.hasPendingSessionStart(sessionId), true, "failed SessionStart must remain pending");

  const restarted = new HookInbox(root);
  await restarted.consume(async () => { attempts += 1; });
  assert.equal(attempts, 2, "restart must retry the failed event exactly once");
  assert.equal(await restarted.hasPendingSessionStart(sessionId), false, "completed retry must leave no stale pending start");
  assert.equal((await restarted.status()).deduplicated, 1);
}

async function sharedShutdownDeadlineCase(home) {
  const root = join(home, "shared-shutdown-deadline");
  const inbox = new HookInbox(root);
  const store = new BackgroundStateStore(join(home, "shared-shutdown-background.json"));
  let reviewStartedResolve;
  const reviewStarted = new Promise((resolve) => { reviewStartedResolve = resolve; });
  let releaseReview;
  const reviewGate = new Promise((resolve) => { releaseReview = resolve; });
  let hookClaimedResolve;
  const hookClaimed = new Promise((resolve) => { hookClaimedResolve = resolve; });
  let releaseHook;
  const hookGate = new Promise((resolve) => { releaseHook = resolve; });
  const lifecycle = new BackgroundLifecycle({
    ...lifecycleOptions(home, inbox, async () => {
      hookClaimedResolve();
      await hookGate;
    }, true),
    store,
    idle_ms: 0,
    source_state: async () => ({ source_fingerprint: "c".repeat(64), reflection_count: 1, scope: "global" }),
    review: async () => {
      reviewStartedResolve();
      await reviewGate;
      return { success: false, source_fingerprint: "c".repeat(64), outcome_class: "released" };
    },
  });
  await store.markDirty("shared-shutdown-review-session", new Date(0).toISOString());
  const reviewRun = lifecycle.runNow();
  await reviewStarted;
  await inbox.enqueue(event("shared-shutdown-hook", "shared-shutdown-hook-session"));
  const hookRun = lifecycle.consumeInboxNow();
  await hookClaimed;
  const startedAt = Date.now();
  await lifecycle.shutdown(100);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 175, `Hook and review drains did not share one absolute shutdown deadline (${elapsed}ms)`);
  releaseHook();
  releaseReview();
  await Promise.allSettled([hookRun, reviewRun]);
}

const cases = [
  ["SessionStart provenance is explicit and fail-closed", provenanceCase],
  ["event ID dedup requires identical canonical payload", eventIdCollisionCase],
  ["completed ledger retains event IDs beyond 1000 completions", completedLedgerRetentionCase],
  ["completed ledger capacity fails closed without losing history", completedLedgerCapacityFailClosedCase],
  ["legacy completions without hashes fail closed consistently", legacyCompletedFailClosedCase],
  ["fresh dead consumer ownership recovers promptly", deadConsumerRecoveryCase],
  ["poll timer is unreferenced", timerUnrefCase],
  ["post-ready consumption with review disabled", (home) => postReadyConsumptionCase(home, false)],
  ["post-ready consumption with review enabled but scheduler idle", (home) => postReadyConsumptionCase(home, true)],
  ["queued SessionStart blocks unknown-session write", (home) => pendingStartCase(home, "queued")],
  ["processing SessionStart blocks unknown-session write", (home) => pendingStartCase(home, "processing")],
  ["concurrent drains are single-flight", singleFlightCase],
  ["shutdown drains a claimed Hook and reports queue telemetry", shutdownDrainCase],
  ["shutdown deadline reports abandoned claimed work", shutdownAbandonCase],
  ["shutdown deadline does not wait for status locks", shutdownDeadlineLockCase],
  ["pump shutdown is memoized", memoizedShutdownCase],
  ["waiting to claim is not abandoned", waitingToClaimCase],
  ["scheduler and pump share one consume flight", schedulerSharesPumpFlightCase],
  ["cross-process consumers claim exactly once", crossProcessClaimCase],
  ["failed handler remains pending and recovers after restart", failedHandlerRestartCase],
  ["Hook and review drains share one shutdown deadline", sharedShutdownDeadlineCase],
];

const failures = [];
for (const [name, run] of cases) {
  try {
    await withTempHome(`v21-hook-pump-${name.replace(/[^a-z0-9]+/gi, "-")}`, run);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  throw new AggregateError(failures.map((item) => item.error), `${failures.length} v21 Hook pump behavior case(s) failed`);
}

console.log("v21 Hook inbox pump test passed");
