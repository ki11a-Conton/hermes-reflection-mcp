import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

const backgroundModule = await import(`../dist/src/background_state.js?v1941=${Date.now()}`);
const { BackgroundStateStore } = backgroundModule;
const { BackgroundLifecycle } = await import(`../dist/src/background_lifecycle.js?v1941=${Date.now()}`);

function validState(overrides = {}) {
  return {
    schema_version: 1,
    next_fencing_token: 1,
    dirty_sessions: {},
    reviewed_sessions: {},
    recent_runs: [],
    ...overrides,
  };
}

function validLease(overrides = {}) {
  const now = Date.now();
  return {
    owner_id: "owner-a",
    pid: process.pid,
    host: hostname(),
    acquired_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    fencing_token: 7,
    ...overrides,
  };
}

async function withTempState(prefix, run) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const path = join(root, "background_lifecycle.json");
  try {
    await run({ root, path, store: new BackgroundStateStore(path) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertFailsClosed(state, label) {
  await withTempState("hermes-v19.4.1-invalid-state-", async ({ root, path, store }) => {
    const raw = JSON.stringify(state);
    await writeFile(path, raw, "utf8");

    await assert.rejects(
      () => store.status(),
      /Refusing to continue.*Nothing was changed/i,
      `${label}: read should reject invalid authoritative state`,
    );
    assert.equal(await readFile(path, "utf8"), raw, `${label}: read changed the active file`);

    await assert.rejects(
      () => store.markDirty("must-not-persist"),
      /Refusing to continue.*Nothing was changed/i,
      `${label}: mutation should reject invalid authoritative state`,
    );
    assert.equal(await readFile(path, "utf8"), raw, `${label}: mutation changed the active file`);

    await assert.rejects(() => store.status(), /Refusing to continue/i);
    const backups = (await readdir(root)).filter((name) =>
      /^background_lifecycle\.json\.corrupt\.[a-f0-9]{16}\.bak$/.test(name));
    assert.equal(backups.length, 1, `${label}: evidence backup must be idempotent`);
    assert.equal(await readFile(join(root, backups[0]), "utf8"), raw, `${label}: evidence bytes differ`);
  });
}

async function testFutureSchemaFailsClosed() {
  await assertFailsClosed(validState({ schema_version: 2, future_data: { keep: true } }), "future schema");
}

async function testUnknownFieldsFailClosed() {
  await assertFailsClosed(validState({ unexpected: true }), "unknown root field");
  await assertFailsClosed(validState({
    dirty_sessions: {
      session: { dirty_at: new Date(0).toISOString(), unexpected: true },
    },
  }), "unknown nested field");
}

async function testInvalidCollectionsFailClosed() {
  const variants = [
    ["dirty array", validState({ dirty_sessions: [] })],
    ["reviewed array", validState({ reviewed_sessions: [] })],
    ["recent object", validState({ recent_runs: {} })],
  ];
  for (const [label, state] of variants) await assertFailsClosed(state, label);
}

async function testInvalidNestedRecordsFailClosed() {
  const variants = [
    ["invalid dirty timestamp", validState({ dirty_sessions: { session: { dirty_at: "not-a-date" } } })],
    ["invalid reviewed fingerprint", validState({
      reviewed_sessions: {
        session: {
          last_reviewed_fingerprint: "short",
          last_reviewed_at: new Date(0).toISOString(),
        },
      },
    })],
    ["invalid recent run", validState({
      recent_runs: [{ session_id: "session", finished_at: "bad", outcome_class: "success" }],
    })],
  ];
  for (const [label, state] of variants) await assertFailsClosed(state, label);
}

async function testInvalidFencingStateFailsClosed() {
  const variants = [
    ["unsafe next token", validState({ next_fencing_token: Number.MAX_SAFE_INTEGER + 1 })],
    ["next token does not exceed lease", validState({
      next_fencing_token: 7,
      lease: validLease({ fencing_token: 7 }),
    })],
    ["invalid lease pid", validState({
      next_fencing_token: 8,
      lease: validLease({ pid: 0 }),
    })],
  ];
  for (const [label, state] of variants) await assertFailsClosed(state, label);
}

async function testOversizedCollectionsFailClosed() {
  const dirty = {};
  for (let index = 0; index < 101; index += 1) {
    dirty[`session-${index}`] = { dirty_at: new Date(index).toISOString() };
  }
  await assertFailsClosed(validState({ dirty_sessions: dirty }), "oversized dirty sessions");
}

async function testValidSchemaOne() {
  await withTempState("hermes-v19.4.1-valid-state-", async ({ path, store }) => {
    const dirty = Object.create(null);
    dirty.__proto__ = {
      dirty_at: new Date(1_000).toISOString(),
      last_reviewed_fingerprint: "a".repeat(64),
      last_reviewed_at: new Date(500).toISOString(),
      retry_after: new Date(2_000).toISOString(),
    };
    const state = validState({ dirty_sessions: dirty });
    await writeFile(path, JSON.stringify(state), "utf8");

    const before = await store.status();
    assert.deepEqual(before.dirty_session_ids, ["__proto__"]);
    await store.markDirty("new-session", new Date(3_000).toISOString());
    const after = await store.status();
    assert.deepEqual(after.dirty_session_ids.sort(), ["__proto__", "new-session"].sort());
  });
}

async function testExpiredLivePidReclaim() {
  await withTempState("hermes-v19.4.1-expired-live-pid-", async ({ store }) => {
    const first = await store.acquireLease("owner-a", 1_000);
    assert.equal(first.acquired, true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await store.acquireLease("owner-b", 1_000);
    assert.equal(second.acquired, true, "TTL expiry must permit progress even while the old PID exists");
    assert.ok(second.fencing_token > first.fencing_token);
  });
}

async function testDeadSameHostReclaim() {
  await withTempState("hermes-v19.4.1-dead-owner-", async ({ path, store }) => {
    await writeFile(path, JSON.stringify(validState({
      next_fencing_token: 8,
      lease: validLease({
        pid: 2_147_483_647,
        fencing_token: 7,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    })), "utf8");
    const acquired = await store.acquireLease("replacement", 1_000);
    assert.equal(acquired.acquired, true, "a confirmed dead same-host owner should be reclaimed before TTL");
    assert.equal(acquired.fencing_token, 8);
  });
}

async function testRemoteOwnerWaitsForTtl() {
  await withTempState("hermes-v19.4.1-remote-owner-", async ({ path, store }) => {
    await writeFile(path, JSON.stringify(validState({
      next_fencing_token: 8,
      lease: validLease({
        host: `${hostname()}-remote`,
        pid: 2_147_483_647,
        fencing_token: 7,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    })), "utf8");
    const acquired = await store.acquireLease("replacement", 1_000);
    assert.equal(acquired.acquired, false, "remote owner liveness is unknown until TTL");
    assert.equal(acquired.fencing_token, 7);
  });
}

async function testTokenBoundRenewal() {
  await withTempState("hermes-v19.4.1-renew-token-", async ({ path, store }) => {
    const lease = await store.acquireLease("owner-a", 1_000);
    assert.equal(lease.acquired, true);
    assert.equal((await store.renewLease("owner-b", lease.fencing_token, 1_000)).renewed, false);
    assert.equal((await store.renewLease("owner-a", lease.fencing_token + 1, 1_000)).renewed, false);
    const renewed = await store.renewLease("owner-a", lease.fencing_token, 1_000);
    assert.equal(renewed.renewed, true);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.next_fencing_token, 2, "renewal must not allocate a new fencing token");
    assert.equal(persisted.lease.fencing_token, lease.fencing_token);
  });
}

async function testExpiredMatchingRenewal() {
  await withTempState("hermes-v19.4.1-renew-expired-", async ({ path, store }) => {
    const lease = await store.acquireLease("owner-a", 1_000);
    assert.equal(lease.acquired, true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const renewed = await store.renewLease("owner-a", lease.fencing_token, 1_000);
    assert.equal(renewed.renewed, true, "an expired but unclaimed exact row may be renewed");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.next_fencing_token, 2);
    assert.equal(persisted.lease.fencing_token, lease.fencing_token);
    assert.ok(Date.parse(persisted.lease.expires_at) > Date.now());
  });
}

async function testRenewMissingDoesNotCreate() {
  await withTempState("hermes-v19.4.1-renew-missing-", async ({ path, store }) => {
    const renewed = await store.renewLease("owner-a", 1, 1_000);
    assert.equal(renewed.renewed, false);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.next_fencing_token, 1);
    assert.equal("lease" in persisted, false, "renewal must not create a missing lease");
  });
}

async function testInvalidCommitFingerprintCannotCorruptState() {
  await withTempState("hermes-v19.4.1-invalid-commit-fingerprint-", async ({ root, store }) => {
    await store.markDirty("session");
    const lease = await store.acquireLease("owner", 1_000);
    const committed = await store.commitSession(
      "owner",
      lease.fencing_token,
      "session",
      "short",
      "success",
    );
    assert.equal(committed, false, "invalid fingerprint was accepted as a completed review");
    const status = await store.status();
    assert.equal(status.dirty_session_count, 1, "invalid commit removed the dirty session");
    assert.equal(status.recent_runs.length, 0, "invalid commit wrote an audit record");
    const files = await readdir(root);
    assert.equal(files.some((name) => name.includes(".corrupt.")), false, "writer produced corrupt evidence");
  });
}

async function testReviewedSessionLimitRemainsDecodable() {
  await withTempState("hermes-v19.4.1-reviewed-limit-", async ({ path, store }) => {
    const reviewedSessions = {};
    for (let index = 0; index < 100; index += 1) {
      reviewedSessions[`old-${index}`] = {
        last_reviewed_fingerprint: String(index).padStart(64, "0"),
        last_reviewed_at: new Date(index * 1_000).toISOString(),
      };
    }
    await writeFile(path, JSON.stringify(validState({
      next_fencing_token: 8,
      dirty_sessions: { newest: { dirty_at: new Date(100_000).toISOString() } },
      reviewed_sessions: reviewedSessions,
      lease: validLease(),
    })), "utf8");

    assert.equal(await store.commitSession("owner-a", 7, "newest", "f".repeat(64), "success"), true);
    await store.status();
    const active = JSON.parse(await readFile(path, "utf8"));
    assert.equal(Object.keys(active.reviewed_sessions).length, 100);
    assert.equal(Object.hasOwn(active.reviewed_sessions, "old-0"), false, "oldest reviewed session was not evicted");
    assert.equal(Object.hasOwn(active.reviewed_sessions, "newest"), true, "new reviewed session was evicted");
  });
}

async function testFencingTokenExhaustionCannotCorruptState() {
  await withTempState("hermes-v19.4.1-token-exhaustion-", async ({ path, store }) => {
    const raw = JSON.stringify(validState({ next_fencing_token: Number.MAX_SAFE_INTEGER }));
    await writeFile(path, raw, "utf8");
    await assert.rejects(
      () => store.acquireLease("owner", 1_000),
      /fencing token.*exhausted/i,
    );
    assert.equal(await readFile(path, "utf8"), raw, "token exhaustion changed active state");
    await store.status();
  });
}

function makeLifecycleStore({ leaseMs = 600, renew } = {}) {
  let activeToken = 1;
  let acquireCalls = 0;
  let renewCalls = 0;
  let commits = 0;
  let releases = 0;
  return {
    get acquireCalls() { return acquireCalls; },
    get renewCalls() { return renewCalls; },
    get commits() { return commits; },
    get releases() { return releases; },
    async markDirty() {},
    async dirtySessions() {
      return [{ session_id: "session", dirty_at: new Date(0).toISOString() }];
    },
    async acquireLease() {
      acquireCalls += 1;
      return {
        acquired: true,
        fencing_token: activeToken,
        expires_at: new Date(Date.now() + leaseMs).toISOString(),
      };
    },
    async renewLease(ownerId, token, duration) {
      renewCalls += 1;
      if (renew) return renew({ ownerId, token, duration, renewCalls });
      return {
        renewed: token === activeToken,
        expires_at: new Date(Date.now() + duration).toISOString(),
      };
    },
    async isLeaseCurrent(_ownerId, token) { return token === activeToken; },
    async withCurrentLease(_ownerId, token, operation) {
      return token === activeToken ? operation() : undefined;
    },
    async commitSession(_ownerId, token) {
      if (token !== activeToken) return false;
      commits += 1;
      return true;
    },
    async releaseLease(_ownerId, token) {
      if (token !== activeToken) return false;
      activeToken = 0;
      releases += 1;
      return true;
    },
    async status() {
      return { lease: { active: activeToken !== 0 }, dirty_session_count: commits ? 0 : 1, recent_runs: [] };
    },
  };
}

function lifecycleOptions(store, overrides = {}) {
  return {
    enabled: true,
    interval_ms: 60_000,
    idle_ms: 0,
    lease_ms: 600,
    max_sessions_per_run: 1,
    review_mode: "llm",
    auto_apply: false,
    store,
    source_state: async () => ({ source_fingerprint: "f".repeat(64), reflection_count: 1 }),
    ...overrides,
  };
}

async function testLongReviewStaysFenced() {
  await withTempState("hermes-v19.4.1-long-review-", async ({ store }) => {
    let beforeApply = false;
    const lifecycle = new BackgroundLifecycle(lifecycleOptions(store, {
      lease_ms: 1_000,
      review: async ({ before_apply: beforeApplyCheck }) => {
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        beforeApply = await beforeApplyCheck();
        return { success: true, source_fingerprint: "f".repeat(64), outcome_class: "success" };
      },
    }));
    await lifecycle.notifyReflectionSaved("session");
    await lifecycle.runNow();
    const status = await store.status();
    assert.equal(beforeApply, true, "long review lost its lease before apply");
    assert.equal(status.dirty_session_count, 0, "successful long review was not committed");
    assert.equal(status.recent_runs.length, 1);
    await lifecycle.shutdown();
  });
}

async function testTransientRenewalFailure() {
  const store = makeLifecycleStore({
    leaseMs: 600,
    renew: async ({ renewCalls, duration }) => {
      if (renewCalls === 1) throw new Error("transient lock contention");
      return { renewed: true, expires_at: new Date(Date.now() + duration).toISOString() };
    },
  });
  const lifecycle = new BackgroundLifecycle(lifecycleOptions(store, {
    review: async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
      return { success: true, source_fingerprint: "f".repeat(64), outcome_class: "success" };
    },
  }));
  await lifecycle.runNow();
  assert.ok(store.renewCalls >= 2, "transient renewal was not retried");
  assert.equal(store.commits, 1);
  assert.equal(store.releases, 1);
}

async function testPersistentRenewalFailure() {
  const store = makeLifecycleStore({
    leaseMs: 300,
    renew: async () => { throw new Error("persistent lock failure"); },
  });
  let observedAbort = false;
  const lifecycle = new BackgroundLifecycle(lifecycleOptions(store, {
    lease_ms: 300,
    review: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({ success: false, source_fingerprint: "f".repeat(64), outcome_class: "aborted" });
      }, { once: true });
    }),
  }));
  const started = Date.now();
  let timeout;
  try {
    await Promise.race([
      lifecycle.runNow(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("persistent renewal test timed out")), 900);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(observedAbort, true, "persistent renewal failures did not abort the review");
  assert.ok(Date.now() - started < 900, "renewal failure window exceeded the confirmed lease");
  assert.equal(store.commits, 0);
  assert.equal(store.releases, 1);
}

async function testDefinitiveRenewalLoss() {
  const store = makeLifecycleStore({ renew: async () => ({ renewed: false }) });
  let reviewCalls = 0;
  const lifecycle = new BackgroundLifecycle(lifecycleOptions(store, {
    review: async () => {
      reviewCalls += 1;
      return { success: true, source_fingerprint: "f".repeat(64), outcome_class: "success" };
    },
  }));
  await lifecycle.runNow();
  assert.equal(reviewCalls, 0, "review started after definitive renewal loss");
  assert.equal(store.commits, 0, "lost owner committed a completed review");
}

async function testShutdownNoFenceLeak() {
  let unblockRenew;
  const renewGate = new Promise((resolve) => { unblockRenew = resolve; });
  let markRenewStarted;
  const renewStarted = new Promise((resolve) => { markRenewStarted = resolve; });
  const active = new Set();
  let acquireCalls = 0;
  const store = {
    async markDirty() {},
    async dirtySessions() { return [{ session_id: "session", dirty_at: new Date(0).toISOString() }]; },
    async acquireLease() {
      acquireCalls += 1;
      const token = acquireCalls;
      active.add(token);
      return { acquired: true, fencing_token: token, expires_at: new Date(Date.now() + 1_000).toISOString() };
    },
    async renewLease(_ownerId, token) {
      markRenewStarted();
      await renewGate;
      return { renewed: active.has(token), expires_at: new Date(Date.now() + 1_000).toISOString() };
    },
    async isLeaseCurrent() { return true; },
    async withCurrentLease(_ownerId, _token, operation) { return operation(); },
    async commitSession() { return true; },
    async releaseLease(_ownerId, token) { return active.delete(token); },
    async status() { return { lease: { active: active.size > 0 } }; },
  };
  const lifecycle = new BackgroundLifecycle(lifecycleOptions(store, {
    lease_ms: 1_000,
    review: async () => ({ success: true, source_fingerprint: "f".repeat(64), outcome_class: "success" }),
  }));
  const run = lifecycle.runNow();
  await renewStarted;
  let timeout;
  try {
    await Promise.race([
      lifecycle.shutdown(0),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("shutdown drain test timed out")), 500);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  unblockRenew();
  await run;
  assert.equal(acquireCalls, 1, "renewal used acquire-or-create after initial ownership");
  assert.deepEqual([...active], [], "shutdown left a fencing token behind");
}

async function testShutdownTimeoutDoesNotKeepChildAlive() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const shutdownTimers = [];
  const cleared = new Set();
  globalThis.setTimeout = ((callback, delay, ...args) => {
    const handle = originalSetTimeout(callback, delay, ...args);
    if (delay === 5_000) shutdownTimers.push(handle);
    return handle;
  });
  globalThis.clearTimeout = ((handle) => {
    cleared.add(handle);
    return originalClearTimeout(handle);
  });

  try {
    const store = makeLifecycleStore();
    let markReviewStarted;
    const reviewStarted = new Promise((resolve) => { markReviewStarted = resolve; });
    const lifecycle = new BackgroundLifecycle(lifecycleOptions(store, {
      review: ({ signal }) => new Promise((resolve) => {
        markReviewStarted();
        signal.addEventListener("abort", () => {
          resolve({ success: false, source_fingerprint: "f".repeat(64), outcome_class: "aborted" });
        }, { once: true });
      }),
    }));
    const run = lifecycle.runNow();
    await reviewStarted;
    await lifecycle.shutdown(5_000);
    await run;
    assert.equal(shutdownTimers.length, 1, "shutdown did not create the bounded drain timer");
    const timer = shutdownTimers[0];
    assert.ok(cleared.has(timer) || !timer.hasRef(), "completed shutdown left a referenced timeout");
  } finally {
    for (const timer of shutdownTimers) originalClearTimeout(timer);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

async function testRefresherDoesNotKeepChildAlive() {
  const observed = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = originalSetTimeout(callback, delay, ...args);
    if (delay === 200) observed.push(handle);
    return handle;
  };
  try {
    const store = makeLifecycleStore({ leaseMs: 600 });
    const lifecycle = new BackgroundLifecycle(lifecycleOptions(store, {
      review: async () => {
        await new Promise((resolve) => originalSetTimeout(resolve, 250));
        return { success: true, source_fingerprint: "f".repeat(64), outcome_class: "success" };
      },
    }));
    await lifecycle.runNow();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.ok(observed.length > 0, "no lease refresher timer was observed");
  assert.ok(observed.every((handle) => !handle.hasRef()), "lease refresher timer must be unreferenced");
}

const tests = [
  ["future schema fails closed", testFutureSchemaFailsClosed],
  ["unknown fields fail closed", testUnknownFieldsFailClosed],
  ["invalid collections fail closed", testInvalidCollectionsFailClosed],
  ["invalid nested records fail closed", testInvalidNestedRecordsFailClosed],
  ["invalid fencing state fails closed", testInvalidFencingStateFailsClosed],
  ["oversized collections fail closed", testOversizedCollectionsFailClosed],
  ["valid schema one remains compatible", testValidSchemaOne],
  ["expired live-pid lease is reclaimable", testExpiredLivePidReclaim],
  ["dead same-host lease is reclaimed early", testDeadSameHostReclaim],
  ["remote lease waits for ttl", testRemoteOwnerWaitsForTtl],
  ["renewal is owner and token bound", testTokenBoundRenewal],
  ["renewal revives only an unclaimed matching row", testExpiredMatchingRenewal],
  ["renewal never creates a missing lease", testRenewMissingDoesNotCreate],
  ["invalid commit fingerprint cannot corrupt state", testInvalidCommitFingerprintCannotCorruptState],
  ["reviewed-session limit remains decodable", testReviewedSessionLimitRemainsDecodable],
  ["fencing-token exhaustion cannot corrupt state", testFencingTokenExhaustionCannotCorruptState],
  ["long review stays fenced", testLongReviewStaysFenced],
  ["transient renewal error recovers", testTransientRenewalFailure],
  ["persistent renewal errors abort by expiry", testPersistentRenewalFailure],
  ["definitive renewal loss prevents commit", testDefinitiveRenewalLoss],
  ["shutdown cannot leak a replacement fence", testShutdownNoFenceLeak],
  ["shutdown timeout does not keep child alive", testShutdownTimeoutDoesNotKeepChildAlive],
  ["lease refresher timer is unreferenced", testRefresherDoesNotKeepChildAlive],
];

for (const [name, test] of tests) {
  await test();
  console.log(`[PASS] ${name}`);
}

console.log(`v19.4.1 regression suite passed (${tests.length} tests).`);
