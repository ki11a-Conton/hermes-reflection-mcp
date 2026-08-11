import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startMcp } from "./v20-test-helpers.mjs";
import {
  OPERATION_FAILPOINTS,
  assertConfiguredOperationFailpoint,
  decodeOperationJournalV2,
} from "../dist/src/operation_journal.js";

const execFileAsync = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const WINDOWS_LOCK_HOLDER = fileURLToPath(new URL("./v21-lock-holder.ps1", import.meta.url));

function testV2CoordinatorContract() {
  const transactionId = "12345678-1234-4123-8123-123456789abc";
  const valid = {
    schema_version: 2,
    transaction_id: transactionId,
    operation: "reflection_mutation",
    phase: "prepared",
    created_at: "2026-08-03T00:00:00.000Z",
    resources: [{
      name: "store_index",
      target_path: "store.json",
      before_sha256: "a".repeat(64),
      after_sha256: "b".repeat(64),
      staged_after_path: `operations/${transactionId}/after-0.bin`,
    }],
    result_receipt: {
      transaction_id: transactionId,
      result_id: "22345678-1234-4123-8123-123456789abc",
      operation: "reflection_mutation",
      reflection_ids: ["reflection-1"],
      result_hash: "c".repeat(64),
    },
  };
  assert.deepEqual(decodeOperationJournalV2(valid), valid);
  assert.throws(() => decodeOperationJournalV2({ ...valid, extra: true }), /unknown|missing/i);
  assert.throws(() => decodeOperationJournalV2({ ...valid, resources: [{ ...valid.resources[0], target_path: "../store.json" }] }), /path|unsafe/i);
  assert.throws(() => decodeOperationJournalV2({ ...valid, result_receipt: { kind: "json", value: { task_goal: "must never persist" } } }), /receipt/i);
  assert.throws(() => decodeOperationJournalV2({ ...valid, result_receipt: { ...valid.result_receipt, reflection_ids: Array(257).fill("x") } }), /receipt|reflection/i);
  assert.ok(OPERATION_FAILPOINTS.includes("before_stage_write:store_index"));
  assert.ok(OPERATION_FAILPOINTS.includes("before_prepare_journal_write"));
  assert.ok(OPERATION_FAILPOINTS.includes("after_stage_fsync:store_index"));
  assert.ok(OPERATION_FAILPOINTS.includes("recovery_after_verify:store_index"));
  const oldNodeEnv = process.env.NODE_ENV;
  const oldFailpoint = process.env.HERMES_TEST_OPERATION_FAILPOINT;
  process.env.NODE_ENV = "test";
  process.env.HERMES_TEST_OPERATION_FAILPOINT = "not-a-real-failpoint";
  assert.throws(() => assertConfiguredOperationFailpoint(), /unknown.*failpoint/i);
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
  if (oldFailpoint === undefined) delete process.env.HERMES_TEST_OPERATION_FAILPOINT;
  else process.env.HERMES_TEST_OPERATION_FAILPOINT = oldFailpoint;
}

function reflection(id, sessionId = "v21-session") {
  return {
    id,
    timestamp: "2026-08-02T00:00:00.000Z",
    session_id: sessionId,
    scope: "global",
    task_goal: `goal-${id}`,
    task_outcome: "success",
    failure_mode: "success",
    task_state: {
      summary: `summary-${id}`,
      immediate_blockers: [],
      active_hypotheses: [],
      proven_safe_paths: [],
      exhausted_search: [],
    },
    world_model_updates: [],
    tool_insights: [],
    context_forget: [],
    open_questions: [],
    lessons_learned: [],
    affordance_gaps: [],
    domain: "v21",
    tags: ["v21"],
  };
}

async function save(storage, item) {
  return storage.saveReflectionAndHeuristics(
    item, [], item.domain, item.task_goal, 0.8, item.tags,
  );
}

async function runChild(home, scenario, failpoint, extraEnv = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [SELF, "--child", scenario], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: "test",
      ...(failpoint ? { HERMES_TEST_REFLECTION_TX_FAILPOINT: failpoint } : {}),
      ...extraEnv,
    },
    timeout: 30_000,
    windowsHide: true,
  });
  const line = stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(line, `child produced no result: ${stderr}`);
  return JSON.parse(line);
}

async function withHome(label, callback) {
  const home = await mkdtemp(join(tmpdir(), `hermes-v21-${label}-`));
  let result;
  let callbackError;
  try {
    result = await callback(home);
  } catch (error) {
    callbackError = error;
  }
  try {
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 10 : 0,
      retryDelay: 50,
    });
  } catch (cleanupError) {
    if (callbackError !== undefined) {
      throw new AggregateError([callbackError, cleanupError], `v21 test and cleanup both failed for ${label}`);
    }
    throw cleanupError;
  }
  if (callbackError !== undefined) throw callbackError;
  return result;
}

function startProtocolChild(home, scenario, extraEnv = {}) {
  const child = spawn(process.execPath, [SELF, "--child", scenario], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: "test",
      HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdoutBuffer = "";
  let stderr = "";
  const messages = [];
  const waiters = [];
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes("\n")) {
      const newline = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message); else messages.push(message);
    }
  });
  const nextMessage = (timeoutMs = 5_000) => {
    if (messages.length > 0) return Promise.resolve(messages.shift());
    return new Promise((resolvePromise, reject) => {
      const waiter = { resolve: resolvePromise, reject };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`protocol child ${scenario} timed out after ${timeoutMs}ms; stderr: ${stderr}`));
      }, timeoutMs);
      waiter.resolve = (value) => { clearTimeout(timer); resolvePromise(value); };
    });
  };
  const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
  const stop = async () => {
    child.stdin.end();
    if (child.exitCode !== null) return;
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => { child.kill(); resolvePromise(); }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
    });
  };
  return { child, messages, nextMessage, send, stop };
}

async function waitForTestMarker(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(path, "utf8"); return; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`test hook did not publish marker within ${timeoutMs}ms: ${path}`);
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveClose, rejectClose) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveClose(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectClose(error);
    };
    const onClose = (code, signal) => finish({ code, signal });
    const onError = (error) => fail(error);
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function terminateChild(child, label, timeoutMs = 3_000) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  const outcome = await waitForChildClose(child, timeoutMs);
  if (outcome === null) throw new Error(`${label} did not terminate within ${timeoutMs}ms`);
  return outcome;
}

async function startWindowsLockHolder(lockPath, token, holdMilliseconds = 0) {
  const holder = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-File", WINDOWS_LOCK_HOLDER,
    "-LockPath", lockPath, "-Token", token,
    "-HoldMilliseconds", String(holdMilliseconds),
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  holder.stdout.setEncoding("utf8");
  holder.stderr.setEncoding("utf8");
  holder.stdout.on("data", (chunk) => { stdout += chunk; });
  holder.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        holder.stdout.removeListener("data", inspect);
        holder.removeListener("close", onClose);
        holder.removeListener("error", onError);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const inspect = () => {
        if (stdout.includes("READY")) finish(resolveReady);
      };
      const onClose = (code, signal) => finish(
        rejectReady,
        new Error(`Windows lock holder exited before READY: ${code} (${signal ?? "no signal"}): ${stderr}`),
      );
      const onError = (error) => finish(rejectReady, error);
      const timer = setTimeout(
        () => finish(rejectReady, new Error(`timed out waiting for Windows lock holder: ${stderr}`)),
        10_000,
      );
      holder.stdout.on("data", inspect);
      holder.once("close", onClose);
      holder.once("error", onError);
      inspect();
    });
  } catch (readyError) {
    try { await terminateChild(holder, "failed Windows lock holder", 3_000); }
    catch (cleanupError) {
      throw new AggregateError([readyError, cleanupError], "Windows lock holder startup and cleanup both failed");
    }
    throw readyError;
  }
  return holder;
}

async function assertNoTransactionOrphans(home) {
  const root = join(home, ".hermes-reflection");
  let operationEntries = [];
  try { operationEntries = await readdir(join(root, "operations")); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  assert.deepEqual(operationEntries, [], "pre-prepare failure must remove its transaction directory");
  let rootEntries = [];
  try { rootEntries = await readdir(root); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  assert.deepEqual(rootEntries.filter((name) => /^operation_journal\.json\.tmp\./.test(name)), [], "journal temp files must be removed");
}

function mcpText(result) {
  return (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function approvalReflectionArgs() {
  return {
    session_id: "v21-approval-session",
    task_goal: "recover an approved reflection exactly once",
    task_outcome: "success",
    failure_mode: "success",
    summary: "approval recovery must consume the durable transaction receipt",
    summary_sections: [], immediate_blockers: [], active_hypotheses: [], proven_safe_paths: [], exhausted_search: [],
    world_model_updates: [], tool_insights: [], context_forget: [], open_questions: [],
    lessons_learned: ["Approval recovery consumes a committed receipt instead of replaying the mutation."],
    available_tools: [], heuristic_feedback: [], auto_extract_heuristics: true,
    domain: "v21-approval", tags: ["approval", "receipt"], dry_run: false, response_mode: "full",
  };
}

async function testApprovalReceiptRecovery(failpointName) {
  await withHome(`approval-receipt-${failpointName.replace(/[^a-z0-9_-]/gi, "-")}`, async (home) => {
    let server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
    try {
      const initialized = await server.client.callTool({
        name: "add_heuristic",
        arguments: { domain: "v21-approval", heuristic: "approval fixture seed", source_task: "initialize isolated store", confidence: 0.8, tags: [] },
      });
      assert.notEqual(initialized.isError, true, mcpText(initialized));
    } finally { await server.close().catch(() => undefined); }

    const storePath = join(home, ".hermes-reflection", "store.json");
    const seeded = JSON.parse(await readFile(storePath, "utf8"));
    seeded.metadata.write_approval = true;
    await writeFile(storePath, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");

    server = await startMcp(home, {
      HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
      NODE_ENV: "test",
      HERMES_TEST_OPERATION_FAILPOINT: failpointName,
    });
    let mutationId;
    try {
      const queued = await server.client.callTool({ name: "reflect_on_task", arguments: approvalReflectionArgs() });
      assert.equal(queued.isError, true, "write approval must queue reflection");
      const pending = await server.client.callTool({ name: "list_pending_mutations", arguments: { response_mode: "full" } });
      mutationId = pending.structuredContent?.items?.[0]?.id;
      assert.ok(mutationId, "queued reflection must expose a pending mutation ID");
      const interrupted = await server.client.callTool({
        name: "approve_pending_mutation",
        arguments: { mutation_id: mutationId, decision: "approve" },
      });
      assert.equal(interrupted.isError, true, "approval must surface the configured transaction interruption");
    } finally { await server.close().catch(() => undefined); }

    server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
    try {
      const barrier = await server.client.callTool({ name: "list_reflections", arguments: { limit: 20, response_mode: "full" } });
      assert.notEqual(barrier.isError, true, `read barrier must forward-recover: ${mcpText(barrier)}`);
      const approved = await server.client.callTool({
        name: "approve_pending_mutation",
        arguments: { mutation_id: mutationId, decision: "approve" },
      });
      assert.notEqual(approved.isError, true, `recovery retry must consume the durable receipt: ${mcpText(approved)}`);
      assert.match(mcpText(approved), new RegExp(mutationId));
      const duplicate = await server.client.callTool({
        name: "approve_pending_mutation",
        arguments: { mutation_id: mutationId, decision: "approve" },
      });
      assert.equal(duplicate.isError, true, "the same pending mutation ID must complete exactly once");
    } finally { await server.close().catch(() => undefined); }

    const raw = JSON.parse(await readFile(storePath, "utf8"));
    const rows = (await readFile(join(home, ".hermes-reflection", "reflections.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(rows.length, 1, "approval recovery must not replay the reflection mutation");
    const heuristic = raw.heuristics.find((item) => item.heuristic === "Approval recovery consumes a committed receipt instead of replaying the mutation.");
    assert.equal(heuristic?.evidence?.length, 1, "approval recovery must not duplicate evidence");
    assert.equal(heuristic?.reinforcement_count, 1, "approval recovery must retain one committed reinforcement");
    await assert.rejects(readFile(join(home, ".hermes-reflection", "operation_journal.json"), "utf8"), { code: "ENOENT" });
  });
}

async function testApprovalClaimReceiptGuards() {
  await withHome("approval-claim-receipt-guards", async (home) => {
    let server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
    try {
      const initialized = await server.client.callTool({
        name: "add_heuristic",
        arguments: { domain: "v21-approval", heuristic: "claim fixture seed", source_task: "initialize isolated store", confidence: 0.8, tags: [] },
      });
      assert.notEqual(initialized.isError, true, mcpText(initialized));
    } finally { await server.close().catch(() => undefined); }
    const storePath = join(home, ".hermes-reflection", "store.json");
    let raw = JSON.parse(await readFile(storePath, "utf8"));
    raw.metadata.write_approval = true;
    await writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
    let mutationId;
    try {
      const queued = await server.client.callTool({ name: "reflect_on_task", arguments: approvalReflectionArgs() });
      assert.equal(queued.isError, true);
      mutationId = (await server.client.callTool({ name: "list_pending_mutations", arguments: { response_mode: "full" } }))
        .structuredContent?.items?.[0]?.id;
      assert.ok(mutationId);
    } finally { await server.close().catch(() => undefined); }

    const interrupted = await runChild(home, "approval-storage-interrupt", "after_prepare_journal_fsync");
    assert.equal(interrupted.interrupted, true);
    assert.equal(interrupted.mutation_id, mutationId);
    const oldToken = interrupted.old_token;
    assert.ok(oldToken);
    raw = JSON.parse(await readFile(storePath, "utf8"));
    assert.equal(raw.metadata.pending_mutations[0].state, "processing");
    assert.equal(raw.metadata.pending_mutations[0].claim_token, oldToken);

    await runChild(home, "read");
    raw = JSON.parse(await readFile(storePath, "utf8"));
    const pending = raw.metadata.pending_mutations[0];
    const originalInputHash = pending.payload_hash;
    assert.equal(pending.state, "processing", "recovery must preserve the durable in-flight claim until receipt-aware reclaim");

    const wrongId = await runChild(home, "approval-claim-probe", undefined, {
      V21_ACTION: "claim", V21_MUTATION_ID: "wrong-pending-id",
    });
    assert.equal(wrongId.claimed, false);

    pending.payload_hash = "f".repeat(64);
    await writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const wrongHash = await runChild(home, "approval-claim-probe", undefined, {
      V21_ACTION: "claim", V21_MUTATION_ID: mutationId,
    });
    assert.equal(wrongHash.claimed, false, "a mismatched pending input hash must not consume the committed receipt");
    pending.payload_hash = originalInputHash;
    await writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const reclaimed = await runChild(home, "approval-claim-probe", undefined, {
      V21_ACTION: "claim", V21_MUTATION_ID: mutationId,
    });
    assert.equal(reclaimed.claimed, true);
    assert.notEqual(reclaimed.token, oldToken, "receipt-aware processing recovery must issue a fresh claim token");

    const stale = await runChild(home, "approval-claim-probe", undefined, {
      V21_ACTION: "complete", V21_MUTATION_ID: mutationId, V21_CLAIM_TOKEN: oldToken,
    });
    assert.equal(stale.completed, false, "the stale pre-recovery token must not finalize or consume");
    const wrongFinalize = await runChild(home, "approval-claim-probe", undefined, {
      V21_ACTION: "complete", V21_MUTATION_ID: "wrong-pending-id", V21_CLAIM_TOKEN: reclaimed.token,
    });
    assert.equal(wrongFinalize.completed, false);
    const completed = await runChild(home, "approval-claim-probe", undefined, {
      V21_ACTION: "complete", V21_MUTATION_ID: mutationId, V21_CLAIM_TOKEN: reclaimed.token,
    });
    assert.equal(completed.completed, true);
    const duplicate = await runChild(home, "approval-claim-probe", undefined, {
      V21_ACTION: "complete", V21_MUTATION_ID: mutationId, V21_CLAIM_TOKEN: reclaimed.token,
    });
    assert.equal(duplicate.completed, false, "a pending mutation finalizes exactly once");

    raw = JSON.parse(await readFile(storePath, "utf8"));
    const rows = (await readFile(join(home, ".hermes-reflection", "reflections.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(Object.keys(raw.metadata.committed_receipts).length, 1, "failed claims must leave the durable receipt available");
  });
}

async function childMain(scenario) {
  assert.ok(process.env.HOME, "child HOME must be set before dynamic imports");
  assert.equal(process.env.USERPROFILE, process.env.HOME, "child USERPROFILE must match its isolated HOME");
  const ownedHome = resolve(process.env.HOME);
  const root = resolve(ownedHome, ".hermes-reflection");
  assert.equal(relative(ownedHome, root), ".hermes-reflection", "resolved store must remain inside the owned temp HOME");
  const storage = await import("../dist/storage.js");
  if (scenario === "protocol-cache-reader") {
    await storage.memoryBoardWrite("add", "cross-process-old", undefined, "cache-red-reader");
    const frozenNow = Date.now();
    Date.now = () => frozenNow;
    const primed = await storage.exportData();
    console.log(JSON.stringify({ state: "ready", board: primed.memory_board?.entries.map((item) => item.content) ?? [] }));
    await new Promise((resolvePromise) => process.stdin.once("data", resolvePromise));
    const observed = await storage.exportData();
    console.log(JSON.stringify({ state: "read", board: observed.memory_board?.entries.map((item) => item.content) ?? [] }));
    return;
  }
  if (scenario === "protocol-cache-writer") {
    console.log(JSON.stringify({ state: "ready" }));
    await new Promise((resolvePromise) => process.stdin.once("data", resolvePromise));
    const result = await storage.memoryBoardWrite("replace", "cross-process-new", "cross-process-old", "cache-red-writer");
    console.log(JSON.stringify({ state: "committed", success: result.success }));
    return;
  }
  if (scenario === "protocol-fingerprint-reader") {
    await storage.memoryBoardRead();
    console.log(JSON.stringify({ state: "ready" }));
    await new Promise((resolvePromise) => process.stdin.once("data", resolvePromise));
    process.env.HERMES_TEST_FILE_FINGERPRINT_ERROR = "store:EACCES";
    let code = "";
    let error = "";
    try { await storage.memoryBoardRead(); }
    catch (caught) { code = caught?.code ?? ""; error = String(caught); }
    console.log(JSON.stringify({ state: "read", code, error }));
    return;
  }
  if (scenario === "seed-unresolved-reflection") {
    const item = reflection(process.env.V21_ID);
    item.open_questions = [{
      question: "must remain snapshot-consistent?",
      priority: "high",
      requires_environment_interaction: false,
    }];
    await save(storage, item);
    console.log(JSON.stringify({ saved: item.id }));
    return;
  }
  if (scenario === "protocol-overlay-cache-reader") {
    const frozenNow = Date.now();
    Date.now = () => frozenNow;
    const primed = await storage.getReflectionById(process.env.V21_ID);
    console.log(JSON.stringify({ state: "ready", resolved: primed?.open_questions[0]?.resolved === true }));
    await new Promise((resolvePromise) => process.stdin.once("data", resolvePromise));
    const observed = await storage.getReflectionById(process.env.V21_ID);
    console.log(JSON.stringify({ state: "read", resolved: observed?.open_questions[0]?.resolved === true }));
    return;
  }
  if (scenario === "protocol-overlay-writer") {
    console.log(JSON.stringify({ state: "ready" }));
    await new Promise((resolvePromise) => process.stdin.once("data", resolvePromise));
    const result = await storage.resolveOpenQuestion(process.env.V21_ID, 0);
    console.log(JSON.stringify({ state: "committed", found: result?.found === true }));
    return;
  }
  if (scenario === "overlay-read-by-id") {
    const observed = await storage.getReflectionById(process.env.V21_ID);
    console.log(JSON.stringify({ resolved: observed?.open_questions[0]?.resolved === true }));
    return;
  }
  if (scenario === "protocol-update-reader") {
    const result = await storage.updateReflection(process.env.V21_ID, { tags: ["updated-under-barrier"] });
    console.log(JSON.stringify({ state: "updated", resolved: result?.open_questions[0]?.resolved === true }));
    return;
  }
  if (scenario === "return-isolation") {
    const item = reflection("isolation-reflection");
    item.open_questions = [{ question: "isolated?", priority: "high", requires_environment_interaction: false }];
    await storage.saveReflectionAndHeuristics(item, ["isolation lesson"], item.domain, item.task_goal, 0.8, item.tags);
    await storage.memoryBoardWrite("add", "isolation board", undefined, "isolation");
    const first = await storage.exportData();
    first.reflections[0].task_state.immediate_blockers.push("caller mutation");
    first.reflections[0].tags.push("caller mutation");
    first.reflections[0].open_questions[0].question = "caller mutation";
    first.memory_board.entries[0].content = "caller mutation";
    first.heuristics[0].tags.push("caller mutation");
    first.metadata.pending_mutations.push({ id: "caller mutation" });
    const second = await storage.exportData();
    const firstById = await storage.getReflectionById(item.id, false);
    firstById.task_state.immediate_blockers.push("by-id caller mutation");
    firstById.tags.push("by-id caller mutation");
    firstById.open_questions[0].question = "by-id caller mutation";
    const secondById = await storage.getReflectionById(item.id, false);
    console.log(JSON.stringify({
      export_clean: !JSON.stringify(second).includes("caller mutation"),
      by_id_clean: !JSON.stringify(secondById).includes("by-id caller mutation"),
    }));
    return;
  }
  if (scenario === "memory-wrapper-return-isolation") {
    const memoryA = `memory-alpha-${"x".repeat(80)}`;
    const memoryB = `memory-beta-${"x".repeat(80)}`;
    const profileA = `profile-alpha-${"y".repeat(80)}`;
    const profileB = `profile-beta-${"y".repeat(80)}`;
    const memorySingle = await storage.memoryBoardWrite("add", memoryA, undefined, "return-isolation");
    memorySingle.entries[0].content = "caller-mutated-memory-single";
    const memoryBatch = await storage.memoryBoardBatchWrite([{ action: "add", content: memoryB }], "return-isolation");
    memoryBatch.entries.at(-1).content = "caller-mutated-memory-batch";
    const memoryFailure = await storage.memoryBoardWrite("add", "z".repeat(3_000), undefined, "return-isolation");
    memoryFailure.current_entries[0].content = "caller-mutated-memory-failure";
    assert.ok(memoryFailure.consolidation_hints?.length, "memory failure fixture must produce consolidation hints");
    memoryFailure.consolidation_hints[0].entry_ids[0] = "caller-mutated-memory-hint";
    memoryFailure.consolidation_hints[0].reason = "caller-mutated-memory-hint";

    const profileSingle = await storage.userProfileWrite("add", profileA, undefined, "return-isolation");
    profileSingle.entries[0].content = "caller-mutated-profile-single";
    const profileBatch = await storage.userProfileBatchWrite([{ action: "add", content: profileB }], "return-isolation");
    profileBatch.entries.at(-1).content = "caller-mutated-profile-batch";
    const profileFailure = await storage.userProfileWrite("add", "q".repeat(2_000), undefined, "return-isolation");
    profileFailure.current_entries[0].content = "caller-mutated-profile-failure";
    assert.ok(profileFailure.consolidation_hints?.length, "profile failure fixture must produce consolidation hints");
    profileFailure.consolidation_hints[0].entry_ids[0] = "caller-mutated-profile-hint";
    profileFailure.consolidation_hints[0].reason = "caller-mutated-profile-hint";

    const memoryRead = await storage.memoryBoardRead();
    const profileRead = await storage.userProfileRead();
    const exported = await storage.exportData();
    const serialized = JSON.stringify(exported);
    console.log(JSON.stringify({
      memory_clean: memoryRead.includes(memoryA) && memoryRead.includes(memoryB) && !memoryRead.includes("caller-mutated"),
      profile_clean: profileRead.includes(profileA) && profileRead.includes(profileB) && !profileRead.includes("caller-mutated"),
      export_clean: !serialized.includes("caller-mutated"),
    }));
    return;
  }
  if (scenario === "protocol-authority-reader") {
    const observed = await storage.exportData();
    console.log(JSON.stringify({ state: "read", ids: observed.reflections.map((item) => item.id) }));
    return;
  }
  if (scenario === "protocol-overlay-authority-reader") {
    const observed = await storage.exportData();
    console.log(JSON.stringify({ state: "read", resolved: observed.reflections[0]?.open_questions[0]?.resolved === true }));
    return;
  }
  if (scenario === "protocol-authority-writer") {
    console.log(JSON.stringify({ state: "ready" }));
    await new Promise((resolvePromise) => process.stdin.once("data", resolvePromise));
    await save(storage, reflection("authority-new"));
    console.log(JSON.stringify({ state: "committed" }));
    return;
  }
  if (scenario === "lock-read-eperm-retry") {
    const journal = await import("../dist/src/operation_journal.js");
    const result = await journal.runLockReadEpermRetryForTest(process.env.V21_LOCK_EPERM_MODE);
    console.log(JSON.stringify(result)); return;
  }
  if (scenario === "recover-lock-contention") {
    const journal = await import("../dist/src/operation_journal.js");
    const started = Date.now();
    let recovered = false;
    let error = "";
    let storeUnavailable = false;
    try { await journal.recoverPendingOperation(); recovered = true; }
    catch (caught) {
      error = String(caught);
      storeUnavailable = caught?.name === "OperationJournalStoreUnavailableError";
    }
    console.log(JSON.stringify({ recovered, error, store_unavailable: storeUnavailable, elapsed_ms: Date.now() - started }));
    return;
  }
  if (scenario === "v1-post-write-mismatch") {
    const journal = await import("../dist/src/operation_journal.js");
    await storage.memoryBoardWrite("add", "legacy expected board", undefined, "v1-recovery-test");
    await save(storage, reflection("v1-expected-reflection"));
    const expectedStore = await storage.exportData();
    expectedStore.heuristics = [{
      id: "v1-legacy-heuristic",
      domain: "v1-legacy",
      heuristic: "legacy fixture intentionally omits generated timestamps",
      source_task: "v1 single-normalization fixture",
      confidence: 0.8,
      tags: [],
    }];
    const session = await import("../dist/session_storage.js");
    await session.appendSessionTurn(
      "v1-recovery-session", "user", "legacy expected turn", "2026-08-11T00:00:00.000Z",
      { scope: "global" },
    );
    const expectedSessions = await session.snapshotSessionStorage();
    assert.ok(expectedSessions, "v1 recovery fixture requires session storage");
    const transactionId = "12345678-1234-4123-8123-123456789abc";
    const transactionDir = join(root, "operations", transactionId);
    await mkdir(transactionDir, { recursive: true });
    await writeFile(join(transactionDir, "before-json.json"), JSON.stringify(expectedStore), "utf8");
    await writeFile(join(transactionDir, "before-sqlite.json"), JSON.stringify(expectedSessions), "utf8");
    await writeFile(join(root, "operation_journal.json"), JSON.stringify({
      schema_version: 1,
      id: transactionId,
      operation: "clear",
      phase: "prepared",
      created_at: "2026-08-11T00:00:00.000Z",
      before: {
        json: journal.hashLegacyV1JsonState(expectedStore),
        sqlite: journal.hashLegacyV1SqliteState(expectedSessions),
      },
      after: {
        json: journal.hashLegacyV1JsonState(expectedStore),
        sqlite: journal.hashLegacyV1SqliteState(expectedSessions),
      },
      staged_paths: [
        `operations/${transactionId}/after-json.json`,
        `operations/${transactionId}/after-sqlite.json`,
      ],
      backup_paths: [
        `operations/${transactionId}/before-json.json`,
        `operations/${transactionId}/before-sqlite.json`,
      ],
    }), "utf8");
    if (process.env.V21_V1_MISMATCH_MODE) {
      process.env.HERMES_TEST_V1_POST_WRITE_MISMATCH = process.env.V21_V1_MISMATCH_MODE;
    }
    const generationBefore = journal.operationRecoveryGeneration();
    let error = "";
    try { await journal.recoverPendingOperation(); }
    catch (caught) { error = String(caught); }
    finally { delete process.env.HERMES_TEST_V1_POST_WRITE_MISMATCH; }
    let journalPresent = true;
    let evidencePresent = true;
    try { await readFile(join(root, "operation_journal.json"), "utf8"); }
    catch (caught) { if (caught?.code === "ENOENT") journalPresent = false; else throw caught; }
    try { await readFile(join(transactionDir, "before-json.json"), "utf8"); }
    catch (caught) { if (caught?.code === "ENOENT") evidencePresent = false; else throw caught; }
    console.log(JSON.stringify({
      error,
      journal_present: journalPresent,
      evidence_present: evidencePresent,
      generation_advanced: journal.operationRecoveryGeneration() !== generationBefore,
    }));
    return;
  }
  if (scenario === "public-operation-save") {
    const operationName = process.env.V21_OPERATION_NAME;
    const item = reflection(`public-operation-${process.env.V21_STORAGE_API ?? "save"}`);
    let error = "";
    try {
      if (process.env.V21_STORAGE_API === "batch") {
        await storage.batchSaveReflections([{
          reflection: item, lessons: [], domain: item.domain, sourceTask: item.task_goal, confidence: 0.8, tags: item.tags,
        }], operationName);
      } else {
        await storage.saveReflectionAndHeuristics(
          item, [], item.domain, item.task_goal, 0.8, item.tags, operationName,
        );
      }
    } catch (caught) { error = String(caught); }
    console.log(JSON.stringify({ error })); return;
  }
  if (scenario === "public-operation-approval") {
    const operationName = process.env.V21_OPERATION_NAME;
    await save(storage, reflection("public-operation-approval-baseline"));
    const storePath = join(root, "store.json");
    const state = JSON.parse(await readFile(storePath, "utf8"));
    state.metadata.write_approval = true;
    await writeFile(storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    let queued = false;
    try {
      const item = reflection("public-operation-approval");
      await storage.saveReflectionAndHeuristics(
        item, [], item.domain, item.task_goal, 0.8, item.tags, operationName,
      );
    } catch (caught) { queued = caught?.isPendingApproval === true; }
    const pending = await storage.listPendingMutations();
    console.log(JSON.stringify({ queued, operation: pending[0]?.operation, preview: pending[0]?.preview })); return;
  }
  if (scenario === "v20-split-write") {
    await save(storage, reflection("baseline"));
    const target = join(root, "store.json");
    const holder = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$fs=[IO.File]::Open($env:HERMES_LOCK_TARGET,'Open','Read','Read');[Console]::Out.WriteLine('READY');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null;$fs.Dispose()",
    ], {
      env: { ...process.env, HERMES_LOCK_TARGET: target },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    await new Promise((resolveReady, rejectReady) => {
      let output = "";
      const timer = setTimeout(() => rejectReady(new Error("timed out waiting for store lock holder")), 10_000);
      holder.stdout.setEncoding("utf8");
      holder.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("READY")) {
          clearTimeout(timer);
          resolveReady();
        }
      });
      holder.once("error", rejectReady);
      holder.once("exit", (code) => rejectReady(new Error(`store lock holder exited early: ${code}`)));
    });
    let failed = false;
    try {
      const item = reflection("orphan");
      await storage.saveReflectionAndHeuristics(item, ["paired heuristic"], "v21", item.task_goal, 0.8, []);
    } catch {
      failed = true;
    } finally {
      holder.stdin.end("release\n");
      await new Promise((resolveExit) => holder.once("exit", resolveExit));
    }
    let journalPresent = false;
    try { await readFile(join(root, "operation_journal.json"), "utf8"); journalPresent = true; } catch {}
    console.log(JSON.stringify({ failed, journalPresent }));
    return;
  }
  if (scenario === "inspect-split") {
    const state = await storage.exportData();
    console.log(JSON.stringify({
      reflectionVisible: state.reflections.some((item) => item.id === "orphan"),
      heuristicVisible: state.heuristics.some((item) => item.heuristic === "paired heuristic"),
    }));
    return;
  }
  if (scenario === "save-and-read") {
    let interrupted = false;
    try {
      await save(storage, reflection("single"));
    } catch (error) {
      interrupted = /failpoint|interrupted/i.test(String(error));
    }
    let index = {};
    try { index = JSON.parse(await readFile(join(root, "store.json"), "utf8")); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const rows = (await readFile(join(root, "reflections.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const splitBeforeBarrier = rows.length === 1
      && (index.sessions?.["v21-session"]?.reflection_count ?? 0) === 0;
    delete process.env.HERMES_TEST_REFLECTION_TX_FAILPOINT;
    const first = await storage.exportData();
    const second = await storage.exportData();
    console.log(JSON.stringify({
      interrupted,
      splitBeforeBarrier,
      firstIds: first.reflections.map((item) => item.id),
      secondIds: second.reflections.map((item) => item.id),
    }));
    return;
  }
  if (scenario === "save-only") {
    let interrupted = false;
    try {
      await save(storage, reflection("prepared-forward"));
    } catch (error) {
      interrupted = /failpoint|interrupted/i.test(String(error));
    }
    console.log(JSON.stringify({ interrupted }));
    return;
  }
  if (scenario === "batch-save-only") {
    let interrupted = false;
    try {
      await storage.batchSaveReflections([
        { reflection: reflection("batch-a"), lessons: [], domain: "v21", sourceTask: "a", confidence: 0.8, tags: [] },
        { reflection: reflection("batch-b"), lessons: [], domain: "v21", sourceTask: "b", confidence: 0.8, tags: [] },
      ]);
    } catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    console.log(JSON.stringify({ interrupted })); return;
  }
  if (scenario === "update-only") {
    let interrupted = false;
    try { await storage.updateReflection("baseline", { tags: ["updated"] }); }
    catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    console.log(JSON.stringify({ interrupted })); return;
  }
  if (scenario === "import-only") {
    let interrupted = false;
    try { await storage.importData({ reflections: [reflection("imported")] }, "merge"); }
    catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    console.log(JSON.stringify({ interrupted })); return;
  }
  if (scenario === "clear-only") {
    let interrupted = false;
    try { await storage.clearData("reflections"); }
    catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    console.log(JSON.stringify({ interrupted })); return;
  }
  if (scenario === "snapshot-replace-only") {
    const state = await storage.exportData();
    state.reflections = [reflection("snapshot-replaced")];
    let interrupted = false;
    try { await storage.replaceStoreDataSnapshot(state); }
    catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    console.log(JSON.stringify({ interrupted })); return;
  }
  if (scenario === "snapshot-replacement-result-isolated") {
    const journal = await import("../dist/src/operation_journal.js");
    const state = await storage.exportData();
    const replacement = await journal.withOperationJournalBarrier(() =>
      storage.withOperationJournalStoreMutation(() => storage.replaceStoreDataSnapshot(state)));
    const returnedVersion = replacement.store.version;
    replacement.store.version = "caller-mutated-version";
    replacement.store.memory_board.entries.push({
      id: "caller-mutated-entry",
      content: "must not leak into internal state",
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
    });
    replacement.resolvedQuestions["caller-mutated:0"] = { resolved_at: "2026-08-11T00:00:00.000Z" };
    const actual = await storage.loadStore();
    console.log(JSON.stringify({
      returned_version: returnedVersion,
      actual_version: actual.version,
      leaked_entry: actual.memory_board.entries.some((entry) => entry.id === "caller-mutated-entry"),
    }));
    return;
  }
  if (scenario === "save-concurrent") {
    await save(storage, reflection(process.env.V21_ID));
    console.log(JSON.stringify({ saved: process.env.V21_ID })); return;
  }
  if (scenario === "durability-order") {
    let interrupted = false;
    try { await save(storage, reflection("durable")); }
    catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    const journal = await import("../dist/src/operation_journal.js");
    console.log(JSON.stringify({ interrupted, trace: journal.operationJournalDurabilityTraceForTest() }));
    return;
  }
  if (scenario === "lock-aba") {
    const journal = await import("../dist/src/operation_journal.js");
    const result = await journal.runStaleLockAbaRaceForTest();
    console.log(JSON.stringify(result)); return;
  }
  if (scenario === "owned-file-publish-race") {
    const journal = await import("../dist/src/operation_journal.js");
    console.log(JSON.stringify(await journal.runOwnedFilePublishRaceForTest(process.env.V21_PUBLISH_MODE === "legacy"))); return;
  }
  if (scenario === "owned-file-windows-collision") {
    const journal = await import("../dist/src/operation_journal.js");
    console.log(JSON.stringify(await journal.runOwnedFileWindowsCollisionForTest(process.env.V21_COLLISION_MODE))); return;
  }
  if (scenario === "approval-storage-interrupt") {
    const mutation = (await storage.listPendingMutations())[0];
    const claim = mutation ? await storage.claimPendingMutation(mutation.id) : null;
    let interrupted = false;
    if (claim) {
      const payload = claim.mutation.payload;
      try {
        await storage.saveReflectionAndHeuristics(
          payload.reflection, payload.lessons, payload.domain, payload.sourceTask,
          payload.confidence, payload.tags, undefined, payload.heuristicFeedback,
          { key: claim.mutation.id, input_hash: claim.mutation.payload_hash },
          claim.mutation.payload_hash,
        );
      } catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    }
    console.log(JSON.stringify({ interrupted, mutation_id: mutation?.id, old_token: claim?.claimToken })); return;
  }
  if (scenario === "approval-claim-probe") {
    const mutationId = process.env.V21_MUTATION_ID;
    if (process.env.V21_ACTION === "claim") {
      const claim = await storage.claimPendingMutation(mutationId);
      console.log(JSON.stringify({ claimed: !!claim, token: claim?.claimToken })); return;
    }
    const removed = await storage.completePendingMutation(mutationId, process.env.V21_CLAIM_TOKEN);
    console.log(JSON.stringify({ completed: !!removed })); return;
  }
  if (scenario === "session-prepare-read") {
    const session = await import("../dist/session_storage.js");
    const journal = await import("../dist/src/operation_journal.js");
    await session.appendSessionTurn("session-before", "user", "before", undefined, { scope: "global" });
    let interrupted = false;
    try { await journal.executeJournaledClear("sessions"); }
    catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    delete process.env.HERMES_TEST_OPERATION_FAILPOINT;
    delete process.env.HERMES_TEST_REFLECTION_TX_FAILPOINT;
    const rows = await session.listRecentSessions(10);
    console.log(JSON.stringify({ interrupted, ids: (rows ?? []).map((item) => item.session_id) })); return;
  }
  if (scenario === "session-prepare-only") {
    const session = await import("../dist/session_storage.js");
    const journal = await import("../dist/src/operation_journal.js");
    await session.appendSessionTurn("session-before", "user", "before", undefined, { scope: "global" });
    let interrupted = false;
    try { await journal.executeJournaledClear("sessions"); }
    catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    console.log(JSON.stringify({ interrupted })); return;
  }
  if (scenario === "session-read-only") {
    const session = await import("../dist/session_storage.js");
    const rows = await session.listRecentSessions(10);
    console.log(JSON.stringify({ ids: (rows ?? []).map((item) => item.session_id) })); return;
  }
  if (scenario === "session-prepare-append") {
    const session = await import("../dist/session_storage.js");
    const journal = await import("../dist/src/operation_journal.js");
    await session.appendSessionTurn("session-before", "user", "before", undefined, { scope: "global" });
    let interrupted = false;
    try { await journal.executeJournaledClear("sessions"); }
    catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    delete process.env.HERMES_TEST_OPERATION_FAILPOINT;
    delete process.env.HERMES_TEST_REFLECTION_TX_FAILPOINT;
    const appended = await session.appendSessionTurn("session-after", "user", "after", undefined, { scope: "global" });
    const snapshot = await session.snapshotSessionStorage();
    let journalPresent = true;
    try { await readFile(join(root, "operation_journal.json"), "utf8"); } catch (error) {
      if (error?.code === "ENOENT") journalPresent = false; else throw error;
    }
    console.log(JSON.stringify({ interrupted, appended, snapshot, journalPresent })); return;
  }
  if (scenario === "session-malformed-mutations") {
    const session = await import("../dist/session_storage.js");
    await session.appendSessionTurn("session-stable", "user", "stable", undefined, { scope: "global" });
    const before = await session.snapshotSessionStorage();
    await writeFile(join(root, "operation_journal.json"), "{}\n", "utf8");
    let appendError = "";
    let replaceError = "";
    try { await session.appendSessionTurn("session-mutated", "user", "must-not-write", undefined, { scope: "global" }); }
    catch (error) { appendError = String(error); }
    try { await session.replaceSessionStorageSnapshot({ schema_version: 2, sessions: [], turns: [] }); }
    catch (error) { replaceError = String(error); }
    await rm(join(root, "operation_journal.json"), { force: true });
    const after = await session.snapshotSessionStorage();
    console.log(JSON.stringify({ appendError, replaceError, before, after })); return;
  }
  if (scenario === "session-coordinator-replace") {
    const session = await import("../dist/session_storage.js");
    const journal = await import("../dist/src/operation_journal.js");
    await session.appendSessionTurn("session-replace", "user", "replace", undefined, { scope: "global" });
    const before = await session.snapshotSessionStorage();
    const replaced = await journal.withOperationJournalBarrier(() =>
      session.withOperationJournalSessionMutation(() => session.replaceSessionStorageSnapshot(before)));
    const after = await session.snapshotSessionStorage();
    console.log(JSON.stringify({ replaced, before, after })); return;
  }
  if (scenario === "session-direct-bypass") {
    const session = await import("../dist/session_storage.js");
    let callbackEntered = false;
    let error = "";
    try {
      await session.withOperationJournalSessionMutation(async () => { callbackEntered = true; });
    } catch (caught) { error = String(caught); }
    console.log(JSON.stringify({ callbackEntered, error })); return;
  }
  if (scenario === "read") {
    const first = await storage.exportData();
    await storage.recoverReflectionTransactionsForTest?.();
    const second = await storage.exportData();
    console.log(JSON.stringify({
      firstIds: first.reflections.map((item) => item.id),
      secondIds: second.reflections.map((item) => item.id),
    }));
    return;
  }
  if (scenario === "read-error") {
    let first = "";
    let second = "";
    try { await storage.exportData(); } catch (error) { first = String(error); }
    try { await storage.exportData(); } catch (error) { second = String(error); }
    console.log(JSON.stringify({ first, second }));
    return;
  }
  if (scenario === "overlay-save") {
    const item = reflection("overlay");
    item.open_questions = [{
      question: "resolved during import?",
      priority: "high",
      requires_environment_interaction: false,
      resolved: true,
      resolved_at: "2026-08-02T00:00:00.000Z",
    }];
    let interrupted = false;
    try { await storage.importData({ reflections: [item] }, "replace"); }
    catch (error) { interrupted = /failpoint|interrupted/i.test(String(error)); }
    console.log(JSON.stringify({ interrupted }));
    return;
  }
  if (scenario === "overlay-read") {
    const state = await storage.exportData();
    console.log(JSON.stringify({ resolved: state.reflections[0]?.open_questions[0]?.resolved === true }));
    return;
  }
  if (scenario === "snapshot") {
    const snapshot = await storage.createSnapshot(undefined, "barrier");
    const rows = (await readFile(join(snapshot.snapshot_dir, "reflections.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    console.log(JSON.stringify({ ids: rows.map((item) => item.id) }));
    return;
  }
  if (scenario === "matrix") {
    await storage.batchSaveReflections([
      { reflection: reflection("batch-a"), lessons: [], domain: "v21", sourceTask: "batch-a", confidence: 0.8, tags: [] },
      { reflection: reflection("batch-b"), lessons: [], domain: "v21", sourceTask: "batch-b", confidence: 0.8, tags: [] },
    ]);
    await storage.updateReflection("batch-a", { tags: ["updated"] });
    await storage.importData({ reflections: [reflection("merge")] }, "merge");
    await storage.importData({ reflections: [reflection("replace")] }, "replace");
    const replaced = await storage.exportData();
    await storage.clearData("reflections");
    const cleared = await storage.exportData();
    console.log(JSON.stringify({
      replacedIds: replaced.reflections.map((item) => item.id),
      replacedCount: replaced.sessions["v21-session"]?.reflection_count,
      clearedIds: cleared.reflections.map((item) => item.id),
      clearedCount: cleared.sessions["v21-session"]?.reflection_count,
    }));
    return;
  }
  if (scenario === "journal-cache-coherence") {
    const journal = await import("../dist/src/operation_journal.js");
    const session = await import("../dist/session_storage.js");
    await storage.memoryBoardWrite("add", "old cached board", undefined, "cache-regression");
    await session.appendSessionTurn("old-session", "user", "old cached session", undefined, { scope: "global" });
    await storage.exportData();
    await journal.executeJournaledReplaceImport({
      memory_board: {
        entries: [{
          id: "replacement-entry",
          content: "replacement board",
          created_at: "2026-08-10T00:00:00.000Z",
          updated_at: "2026-08-10T00:00:00.000Z",
          source: "cache-regression",
        }],
        char_limit: 2200,
        used_chars: "replacement board".length,
      },
    });
    const replaced = await storage.exportData();
    const replacedSessions = await session.snapshotSessionStorage();
    await journal.executeJournaledClear("all");
    const cleared = await storage.exportData();
    const clearedSessions = await session.snapshotSessionStorage();
    console.log(JSON.stringify({
      replaced_board: replaced.memory_board?.entries.map((item) => item.content) ?? [],
      replaced_session_count: replacedSessions?.sessions.length,
      cleared_board: cleared.memory_board?.entries.map((item) => item.content) ?? [],
      cleared_session_count: clearedSessions?.sessions.length,
    }));
    return;
  }
  if (scenario === "journal-recovery-cache-coherence") {
    const journal = await import("../dist/src/operation_journal.js");
    await storage.memoryBoardWrite("add", "old cached board", undefined, "cache-regression");
    await storage.exportData();
    process.env.HERMES_TEST_OPERATION_FAILPOINT = "after_prepare_journal_fsync";
    let interrupted = false;
    try {
      await journal.executeJournaledReplaceImport({ memory_board: { entries: [], char_limit: 2200, used_chars: 0 } });
    } catch (error) {
      interrupted = /failpoint|interrupted/i.test(String(error));
    }
    delete process.env.HERMES_TEST_OPERATION_FAILPOINT;
    const recovered = await storage.exportData();
    console.log(JSON.stringify({
      interrupted,
      recovered_board: recovered.memory_board?.entries.map((item) => item.content) ?? [],
    }));
    return;
  }
  throw new Error(`unknown scenario: ${scenario}`);
}

if (process.argv[2] === "--child") {
  await childMain(process.argv[3]);
} else {
  testV2CoordinatorContract();
  const publicOperationCases = [
    ["hyphen-save", "test-direct", "save"],
    ["hyphen-batch", "test-batch", "batch"],
    ["uppercase", "TEST_DIRECT", "save"],
    ["spaces", "test direct operation", "save"],
    ["unicode", "测试-Δ-operation", "save"],
    ["overlong", `operation-${"x".repeat(100)}`, "save"],
  ];
  for (const [label, operationName, api] of publicOperationCases) {
    await withHome(`public-operation-${label}`, async (home) => {
      const result = await runChild(home, "public-operation-save", "after_prepare_journal_fsync", {
        V21_OPERATION_NAME: operationName,
        V21_STORAGE_API: api,
      });
      assert.match(result.error, /failpoint|interrupted/i,
        `${label} public operation name did not reach the journal commit boundary`);
      const raw = JSON.parse(await readFile(join(home, ".hermes-reflection", "operation_journal.json"), "utf8"));
      const decoded = decodeOperationJournalV2(raw);
      assert.equal(decoded.operation, "reflection_mutation");
      assert.equal(decoded.result_receipt.operation, decoded.operation);
      assert.match(decoded.operation, /^[a-z][a-z0-9_]{0,63}$/);
      assert.ok(decoded.operation.length <= 64);
    });
  }

  await withHome("public-operation-approval-name", async (home) => {
    const operationName = "User Facing-审批 Δ";
    const result = await runChild(home, "public-operation-approval", undefined, {
      V21_OPERATION_NAME: operationName,
    });
    assert.equal(result.queued, true, "write approval did not queue the public operation");
    assert.equal(result.operation, operationName, "journal normalization changed the pending approval operation name");
    assert.match(result.preview, new RegExp(operationName), "pending approval preview lost the public operation name");
  });

  if (process.platform === "win32") {
    await withHome("v20-real-split", async (home) => {
      const write = await runChild(home, "v20-split-write");
      assert.equal(write.failed, true, "Windows held store.json must reject the index replace");
      assert.equal(write.journalPresent, true, "Windows denied replace must retain the prepared journal");
      const state = await runChild(home, "inspect-split");
      assert.equal(
        state.reflectionVisible,
        state.heuristicVisible,
        `reflection/store business pair diverged after restart: ${JSON.stringify(state)}`,
      );
    });
  }

  await withHome("split", async (home) => {
    const result = await runChild(home, "save-and-read", "after_replace:reflections");
    assert.equal(result.interrupted, true, "test failpoint must interrupt after JSONL replace");
    assert.equal(result.splitBeforeBarrier, true, "the v20 write order must be shown to expose a partial pair");
    assert.deepEqual(result.firstIds, ["single"], "same-process authoritative read must finish forward recovery");
    assert.deepEqual(result.secondIds, ["single"], "repeat recovery/read must be idempotent");
  });

  await withHome("prepared", async (home) => {
    const interrupted = await runChild(home, "save-only", "after_prepare_journal_fsync");
    assert.equal(interrupted.interrupted, true);
    const journal = JSON.parse(await readFile(join(home, ".hermes-reflection", "operation_journal.json"), "utf8"));
    assert.equal(journal.phase, "prepared");
    for (const relativePath of journal.resources.map((resource) => resource.staged_after_path)) {
      await readFile(join(home, ".hermes-reflection", ...relativePath.split("/")), "utf8");
    }
    const recovered = await runChild(home, "read");
    assert.deepEqual(recovered.firstIds, ["prepared-forward"], "prepared is an irreversible commit decision");
    assert.deepEqual(recovered.secondIds, ["prepared-forward"]);
  });

  for (const failpoint of [
    "before_stage_write:reflections",
    "after_stage_write:reflections",
    "before_stage_fsync:reflections",
    "after_stage_fsync:store_index",
    "before_prepare_journal_write",
    "after_prepare_journal_write",
    "before_prepare_journal_fsync",
  ]) {
    await withHome(`pre-prepare-${failpoint.replace(/[^a-z0-9]/gi, "-")}`, async (home) => {
      const interrupted = await runChild(home, "save-only", failpoint);
      assert.equal(interrupted.interrupted, true);
      await assert.rejects(readFile(join(home, ".hermes-reflection", "operation_journal.json"), "utf8"), /ENOENT/);
      const state = await runChild(home, "read");
      assert.deepEqual(state.firstIds, [], `${failpoint} must not change any authority`);
      await assertNoTransactionOrphans(home);
    });
  }

  await withHome("durability-order", async (home) => {
    const result = await runChild(home, "durability-order", "after_prepare_journal_fsync");
    assert.equal(result.interrupted, true);
    const ordered = ["stage_files_fsynced", "transaction_directory_fsynced", "operations_directory_fsynced", "prepared_journal_published"];
    assert.deepEqual(result.trace.filter((item) => ordered.includes(item)), ordered);
  });

  await withHome("stale-lock-aba", async (home) => {
    const result = await runChild(home, "lock-aba");
    assert.equal(result.c_entered_during_reclaim, false, "C must not enter while a stale main lock is being reclaimed");
    assert.equal(result.a_token_always_in_main, true, "A's replacement token must remain continuously in main");
    assert.equal(result.b_reclaimed_a, false, "B must not reclaim A's live replacement token");
  });

  await withHome("owned-file-atomic-publish", async (home) => {
    const legacy = await runChild(home, "owned-file-publish-race", undefined, { V21_PUBLISH_MODE: "legacy" });
    assert.ok(legacy.malformed_reads > 0, "legacy open(target, wx) must deterministically expose an empty partial payload");
    const result = await runChild(home, "owned-file-publish-race");
    assert.equal(result.reader_state, "valid", "an owned lock file must become visible only after its complete JSON inode is durable");
    assert.equal(result.malformed_reads, 0, "continuous readers must never observe a partial owned-file payload");
    assert.ok(result.valid_reads > 0, "continuous readers must observe the published complete owner");
  });

  await withHome("owned-file-windows-collision", async (home) => {
    const valid = await runChild(home, "owned-file-windows-collision", undefined, { V21_COLLISION_MODE: "valid-target-eperm" });
    assert.equal(valid.error_code, "EEXIST", "Windows EPERM is competition only after a valid existing owner is verified");
    assert.equal(valid.owner_verified, true);
    const missing = await runChild(home, "owned-file-windows-collision", undefined, { V21_COLLISION_MODE: "missing-target-eperm" });
    assert.equal(missing.error_code, "EPERM", "EPERM without an existing target must fail closed");
    const vanished = await runChild(home, "owned-file-windows-collision", undefined, { V21_COLLISION_MODE: "vanishing-target-eperm" });
    assert.equal(vanished.error_code, "EAGAIN", "a target that vanishes after successful lstat must request a bounded retry, not leak ENOENT");
    const malformed = await runChild(home, "owned-file-windows-collision", undefined, { V21_COLLISION_MODE: "malformed-target-eperm" });
    assert.equal(malformed.owner_verified, false);
    assert.match(malformed.error_message, /malformed|JSON|Unexpected/i);
    const denied = await runChild(home, "owned-file-windows-collision", undefined, { V21_COLLISION_MODE: "valid-target-eacces" });
    assert.equal(denied.error_code, "EACCES", "unrelated permission failures must not be downgraded to lock competition");
  });

  await withHome("lock-read-transient-eperm", async (home) => {
    for (const [code, suffix] of [["EPERM", ""], ["EBUSY", "-ebusy"]]) {
      const transient = await runChild(home, "lock-read-eperm-retry", undefined, { V21_LOCK_EPERM_MODE: `transient${suffix}` });
      assert.equal(transient.owner_read, true, `a bounded retry must recover after transient Windows lock-file ${code}`);
      assert.equal(transient.read_attempts, 3);
      assert.equal(transient.waits, 2);
      const permanent = await runChild(home, "lock-read-eperm-retry", undefined, { V21_LOCK_EPERM_MODE: `permanent${suffix}` });
      assert.equal(permanent.owner_read, false, `persistent ${code} contention must fail closed`);
      assert.match(permanent.error_message, /timed out waiting for operation journal lock/i);
      assert.equal(permanent.store_unavailable, false, `persistent ${code} is contention, not a store-directory obstruction`);
      assert.equal(permanent.read_attempts, 3, `persistent ${code} must exhaust only the deterministic bounded retry budget`);
      assert.equal(permanent.waits, 3);
      const statContention = await runChild(home, "lock-read-eperm-retry", undefined, {
        V21_LOCK_EPERM_MODE: `stat-contention${suffix}`,
      });
      assert.equal(statContention.owner_read, false, `transient lstat ${code} must remain bounded contention`);
      assert.match(statContention.error_message, /timed out waiting for operation journal lock/i);
      assert.equal(statContention.error_code, "");
      assert.equal(statContention.read_attempts, 3);
      assert.equal(statContention.waits, 3);
    }
    const missing = await runChild(home, "lock-read-eperm-retry", undefined, { V21_LOCK_EPERM_MODE: "missing" });
    assert.equal(missing.owner_read, true, "ENOENT after EPERM lstat must retry immediately");
    assert.equal(missing.read_attempts, 2);
    assert.equal(missing.waits, 0);
    for (const mode of ["nonregular", "symlink"]) {
      const rejected = await runChild(home, "lock-read-eperm-retry", undefined, { V21_LOCK_EPERM_MODE: mode });
      assert.equal(rejected.owner_read, false);
      assert.match(rejected.error_message, /not a regular file/i, `${mode} lock target must fail closed`);
    }
    const malformed = await runChild(home, "lock-read-eperm-retry", undefined, { V21_LOCK_EPERM_MODE: "malformed" });
    assert.match(malformed.error_message, /malformed lock owner/i);
    const denied = await runChild(home, "lock-read-eperm-retry", undefined, { V21_LOCK_EPERM_MODE: "eacces" });
    assert.equal(denied.error_code, "EACCES");
    const unexpected = await runChild(home, "lock-read-eperm-retry", undefined, { V21_LOCK_EPERM_MODE: "unexpected" });
    assert.equal(unexpected.error_code, "EIO");
  });

  await withHome("windows-fileshare-none-lock", async (home) => {
    if (process.platform !== "win32") return;
    const storeRoot = resolve(home, ".hermes-reflection");
    assert.equal(relative(resolve(home), storeRoot), ".hermes-reflection");
    await mkdir(storeRoot, { recursive: true });
    const lockPath = resolve(storeRoot, "operation_journal.lock");
    const contentionMarker = resolve(storeRoot, "test-lock-contention.marker");
    assert.equal(relative(resolve(home), lockPath), join(".hermes-reflection", "operation_journal.lock"));
    const holder = await startWindowsLockHolder(lockPath, "32345678-1234-4123-8123-123456789abc", 10_000);
    try {
      const recovering = runChild(home, "recover-lock-contention", undefined, {
        HERMES_TEST_OPERATION_LOCK_CONTENTION_MARKER: contentionMarker,
      }).then((value) => ({ value }), (error) => ({ error }));
      await waitForTestMarker(contentionMarker, 5_000);
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      await terminateChild(holder, "Windows FileShare.None holder");
      const outcome = await recovering;
      if (outcome.error) throw outcome.error;
      const result = outcome.value;
      assert.equal(result.recovered, true, `actual Windows FileShare.None contention must recover: ${result.error}`);
      assert.equal(result.store_unavailable, false);
      assert.ok(result.elapsed_ms >= 100, "contention marker must precede holder release by a measurable interval");
      assert.ok(result.elapsed_ms < 5_000, `real OS contention recovery exceeded its wall-clock budget: ${result.elapsed_ms}ms`);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        await terminateChild(holder, "Windows FileShare.None holder");
      }
    }
  });

  for (const mismatchMode of ["store_index", "reflections", "resolved_questions", "session_storage"]) {
    await withHome(`v1-post-write-mismatch-${mismatchMode}`, async (home) => {
      const result = await runChild(home, "v1-post-write-mismatch", undefined, { V21_V1_MISMATCH_MODE: mismatchMode });
      assert.match(result.error, new RegExp(`legacy v1 post-write authority mismatch for ${mismatchMode}`, "i"),
        `v1 recovery must reread and reject a mismatched ${mismatchMode} authority`);
      assert.equal(result.journal_present, true, "failed v1 post-write verification must retain the journal");
      assert.equal(result.evidence_present, true, "failed v1 post-write verification must retain recovery evidence");
      assert.equal(result.generation_advanced, false, "failed v1 verification must not advance the recovery generation");
    });
  }

  for (const resourceName of ["store_index", "reflections", "resolved_questions"]) {
    await withHome(`v1-post-write-missing-${resourceName}`, async (home) => {
      const result = await runChild(home, "v1-post-write-mismatch", undefined, {
        V21_V1_MISMATCH_MODE: `missing_${resourceName}`,
      });
      assert.match(result.error, new RegExp(`legacy v1 post-write authority missing for ${resourceName}`, "i"),
        `v1 recovery must identify a missing ${resourceName} authority`);
      assert.equal(result.journal_present, true, "missing v1 authority must retain the journal");
      assert.equal(result.evidence_present, true, "missing v1 authority must retain recovery evidence");
      assert.equal(result.generation_advanced, false, "missing v1 authority must not advance generation");
    });
  }

  await withHome("v1-post-write-normal", async (home) => {
    const result = await runChild(home, "v1-post-write-mismatch");
    assert.equal(result.error, "", `normal v1 recovery must remain compatible: ${result.error}`);
    assert.equal(result.journal_present, false, "successful v1 recovery must remove its journal");
    assert.equal(result.evidence_present, false, "successful v1 recovery must remove its evidence");
    assert.equal(result.generation_advanced, true, "successful v1 recovery must advance generation");
  });

  await withHome("snapshot-replacement-result-isolated", async (home) => {
    const result = await runChild(home, "snapshot-replacement-result-isolated");
    assert.equal(result.returned_version, "21.0.0", "replacement result must represent writer VERSION intent");
    assert.equal(result.actual_version, "21.0.0");
    assert.equal(result.leaked_entry, false, "mutating the returned replacement plan must not leak into storage state");
  });

  await withHome("session-read-barrier", async (home) => {
    const result = await runChild(home, "session-prepare-read", "after_prepare_journal_fsync");
    assert.equal(result.interrupted, true);
    assert.deepEqual(result.ids, [], "same-process session read must forward-recover prepared clear");
  });

  await withHome("session-concurrent-readers", async (home) => {
    const prepared = await runChild(home, "session-prepare-only", "after_prepare_journal_fsync");
    assert.equal(prepared.interrupted, true);
    const readers = await Promise.all([runChild(home, "session-read-only"), runChild(home, "session-read-only")]);
    assert.deepEqual(readers.map((item) => item.ids), [[], []], "concurrent session readers must both observe recovered after-state");
  });

  await withHome("session-mutation-barrier", async (home) => {
    const result = await runChild(home, "session-prepare-append", "after_prepare_journal_fsync");
    assert.equal(result.interrupted, true);
    assert.equal(result.appended, true, "session append must recover the prepared operation before mutating");
    assert.equal(result.journalPresent, false, "session append barrier must finish journal recovery");
    assert.deepEqual(result.snapshot.sessions.map((item) => item.session_id), ["session-after"]);
    assert.deepEqual(result.snapshot.turns.map((item) => item.session_id), ["session-after"]);
  });

  await withHome("session-malformed-journal-barrier", async (home) => {
    const result = await runChild(home, "session-malformed-mutations");
    assert.match(result.appendError, /operation journal/i, "append must fail closed on a malformed coordinator journal");
    assert.match(result.replaceError, /operation journal/i, "snapshot replace must fail closed on a malformed coordinator journal");
    assert.deepEqual(result.after, result.before, "failed session mutations must leave authoritative state unchanged");
  });

  await withHome("session-coordinator-owned-replace", async (home) => {
    const result = await runChild(home, "session-coordinator-replace");
    assert.equal(result.replaced, true, "the coordinator-owned mutation seam must permit its own snapshot replacement");
    assert.deepEqual(result.after, result.before);
  });

  await withHome("session-direct-bypass-rejected", async (home) => {
    const result = await runChild(home, "session-direct-bypass");
    assert.equal(result.callbackEntered, false, "arbitrary callers must not enter the session mutation bypass");
    assert.match(result.error, /coordinator|operation journal barrier/i);
  });

  for (const failpoint of [
    "after_commit_marker_write",
    "before_commit_marker_fsync",
    "after_commit_marker_fsync",
    "before_cleanup",
    "after_cleanup",
  ]) {
    await withHome(`terminal-${failpoint}`, async (home) => {
      const interrupted = await runChild(home, "save-only", failpoint);
      assert.equal(interrupted.interrupted, true);
      const recovered = await runChild(home, "read");
      assert.deepEqual(recovered.firstIds, ["prepared-forward"], `${failpoint} must preserve committed after-state`);
    });
  }

  await withHome("neither", async (home) => {
    await runChild(home, "save-only", "after_prepare_journal_fsync");
    await writeFile(join(home, ".hermes-reflection", "store.json"), "{}\n", "utf8");
    const rejected = await runChild(home, "read-error");
    assert.match(rejected.first, /TRANSACTION_RECOVERY_PENDING/);
    assert.match(rejected.second, /TRANSACTION_RECOVERY_PENDING/);
    await readFile(join(home, ".hermes-reflection", "operation_journal.json"), "utf8");
  });

  await withHome("after-missing-stage", async (home) => {
    await runChild(home, "save-only", "after_replace:reflections");
    const journalPath = join(home, ".hermes-reflection", "operation_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const reflectionResource = journal.resources.find((resource) => resource.name === "reflections");
    await rm(join(home, ".hermes-reflection", ...reflectionResource.staged_after_path.split("/")), { force: true });
    const recovered = await runChild(home, "read");
    assert.deepEqual(recovered.firstIds, ["prepared-forward"], "after-authority does not require its stage during recovery");
  });

  await withHome("corrupt-stage", async (home) => {
    await runChild(home, "save-only", "after_prepare_journal_fsync");
    const journal = JSON.parse(await readFile(join(home, ".hermes-reflection", "operation_journal.json"), "utf8"));
    const resource = journal.resources.find((item) => item.name === "store_index");
    await writeFile(join(home, ".hermes-reflection", ...resource.staged_after_path.split("/")), "corrupt-stage", "utf8");
    const rejected = await runChild(home, "read-error");
    assert.match(rejected.first, /staged after-image hash mismatch/i);
    assert.match(rejected.second, /staged after-image hash mismatch/i);
  });

  await withHome("malformed", async (home) => {
    await runChild(home, "save-only", "after_prepare_journal_fsync");
    await writeFile(join(home, ".hermes-reflection", "operation_journal.json"), "{", "utf8");
    const rejected = await runChild(home, "read-error");
    assert.match(rejected.first, /malformed operation journal/i);
    assert.match(rejected.second, /malformed operation journal/i);
  });

  await withHome("recovery-retry", async (home) => {
    await runChild(home, "save-only", "after_prepare_journal_fsync");
    const interrupted = await runChild(home, "read-error", "recovery_before_replace:reflections");
    assert.match(interrupted.first, /failpoint|interrupted/i);
    const recovered = await runChild(home, "read");
    assert.deepEqual(recovered.firstIds, ["prepared-forward"]);
  });

  await withHome("recovery-after-verify", async (home) => {
    await runChild(home, "save-only", "after_prepare_journal_fsync");
    const interrupted = await runChild(home, "read-error", "recovery_after_verify:reflections");
    assert.match(interrupted.first, /failpoint|interrupted/i);
    const recovered = await runChild(home, "read");
    assert.deepEqual(recovered.firstIds, ["prepared-forward"]);
  });

  await withHome("snapshot-barrier", async (home) => {
    await runChild(home, "save-only", "after_prepare_journal_fsync");
    const snapshot = await runChild(home, "snapshot");
    assert.deepEqual(snapshot.ids, ["prepared-forward"], "createSnapshot must recover before copying authorities");
  });

  for (const [label, scenario, expectedIds, seed] of [
    ["batch-path", "batch-save-only", ["batch-a", "batch-b"], false],
    ["update-path", "update-only", ["baseline"], true],
    ["import-path", "import-only", ["imported"], false],
    ["clear-path", "clear-only", [], true],
    ["snapshot-replace-path", "snapshot-replace-only", ["snapshot-replaced"], true],
  ]) {
    await withHome(label, async (home) => {
      if (seed) await runChild(home, "save-concurrent", undefined, { V21_ID: "baseline" });
      const interrupted = await runChild(home, scenario, "after_prepare_journal_fsync");
      assert.equal(interrupted.interrupted, true, `${scenario} must reach prepared failpoint`);
      const recovered = await runChild(home, "read");
      assert.deepEqual(recovered.firstIds.sort(), [...expectedIds].sort(), `${scenario} must forward recover`);
    });
  }

  await withHome("concurrent-restart", async (home) => {
    await runChild(home, "save-only", "after_prepare_journal_fsync");
    await Promise.all([
      runChild(home, "read"),
      runChild(home, "save-concurrent", undefined, { V21_ID: "concurrent" }),
    ]);
    const final = await runChild(home, "read");
    assert.deepEqual(final.firstIds.sort(), ["concurrent", "prepared-forward"]);
  });

  await withHome("matrix", async (home) => {
    const result = await runChild(home, "matrix");
    assert.deepEqual(result.replacedIds, ["replace"]);
    assert.equal(result.replacedCount, 1);
    assert.deepEqual(result.clearedIds, []);
    assert.equal(result.clearedCount, 0);
  });

  await withHome("cross-process-cache-fast-path-red", async (home) => {
    const reader = startProtocolChild(home, "protocol-cache-reader");
    const writer = startProtocolChild(home, "protocol-cache-writer");
    try {
      const [readerReady, writerReady] = await Promise.all([
        reader.nextMessage(),
        writer.nextMessage(),
      ]);
      assert.equal(readerReady.state, "ready");
      assert.deepEqual(readerReady.board, ["cross-process-old"]);
      assert.equal(writerReady.state, "ready");
      writer.send({ action: "commit" });
      const committed = await writer.nextMessage();
      assert.deepEqual(committed, { state: "committed", success: true });
      reader.send({ action: "read" });
      const observed = await reader.nextMessage();
      assert.deepEqual(
        observed.board,
        ["cross-process-new"],
        "a reader whose cache age is frozen at zero must still observe an ordinary mutation committed by another process",
      );
    } finally {
      await Promise.allSettled([reader.stop(), writer.stop()]);
    }
  });

  await withHome("fingerprint-permission-fail-closed", async (home) => {
    const reader = startProtocolChild(home, "protocol-fingerprint-reader");
    try {
      assert.equal((await reader.nextMessage()).state, "ready");
      reader.send({ action: "read-with-eacces" });
      const observed = await reader.nextMessage();
      assert.equal(observed.code, "EACCES", `fingerprint permission failure was not propagated: ${observed.error}`);
    } finally {
      await reader.stop();
    }
  });

  await withHome("public-return-isolation", async (home) => {
    const result = await runChild(home, "return-isolation");
    assert.equal(result.export_clean, true, "mutating nested export_data results must not corrupt the hot cache");
    assert.equal(result.by_id_clean, true, "mutating nested getReflectionById(false) results must not corrupt the hot cache");
  });

  await withHome("memory-wrapper-return-isolation", async (home) => {
    const result = await runChild(home, "memory-wrapper-return-isolation");
    assert.equal(result.memory_clean, true, "memory-board wrapper results must not expose hot-cache entries or hints");
    assert.equal(result.profile_clean, true, "user-profile wrapper results must not expose hot-cache entries or hints");
    assert.equal(result.export_clean, true, "wrapper result mutation must not affect exported authority state");
  });

  await withHome("overlay-only-cross-process-cache", async (home) => {
    const id = "overlay-cache-reflection";
    await runChild(home, "seed-unresolved-reflection", undefined, { V21_ID: id });
    const reader = startProtocolChild(home, "protocol-overlay-cache-reader", { V21_ID: id });
    const writer = startProtocolChild(home, "protocol-overlay-writer", { V21_ID: id });
    try {
      const [readerReady, writerReady] = await Promise.all([reader.nextMessage(), writer.nextMessage()]);
      assert.equal(readerReady.resolved, false);
      assert.equal(writerReady.state, "ready");
      writer.send({ action: "resolve" });
      assert.deepEqual(await writer.nextMessage(), { state: "committed", found: true });
      reader.send({ action: "read" });
      assert.equal((await reader.nextMessage()).resolved, true, "overlay cache must stat even while Date.now is frozen");
    } finally {
      await Promise.allSettled([reader.stop(), writer.stop()]);
    }
  });

  await withHome("multi-authority-read-barrier-red", async (home) => {
    await runChild(home, "save-concurrent", undefined, { V21_ID: "authority-old" });
    const hookDir = join(home, ".hermes-reflection", "test-hooks", "authority-read-hook");
    await mkdir(hookDir, { recursive: true });
    const readyMarker = join(hookDir, "after_store_index_read.ready");
    const continueMarker = join(hookDir, "after_store_index_read.continue");
    const writer = startProtocolChild(home, "protocol-authority-writer");
    let reader;
    try {
      assert.equal((await writer.nextMessage()).state, "ready");
      reader = startProtocolChild(home, "protocol-authority-reader", {
        HERMES_TEST_AUTHORITY_READ_HOOK_DIR: hookDir,
        HERMES_TEST_AUTHORITY_READ_HOOK_POINT: "after_store_index_read",
      });
      await waitForTestMarker(readyMarker, 5_000);
      writer.send({ action: "commit" });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      assert.equal(
        writer.messages.length,
        0,
        "writer must remain blocked while the reader holds the multi-authority journal barrier",
      );
      await writeFile(continueMarker, "continue\n", "utf8");
      const beforeCommit = await reader.nextMessage();
      assert.deepEqual(beforeCommit.ids, ["authority-old"], "barrier-held reader must return the complete old snapshot");
      assert.equal((await writer.nextMessage()).state, "committed");
      const afterCommit = await runChild(home, "read");
      assert.deepEqual(afterCommit.firstIds.sort(), ["authority-new", "authority-old"]);
    } finally {
      await writeFile(continueMarker, "continue\n", "utf8").catch(() => undefined);
      await Promise.allSettled([reader?.stop() ?? Promise.resolve(), writer.stop()]);
    }
  });

  await withHome("store-overlay-read-barrier", async (home) => {
    const id = "overlay-barrier-reflection";
    await runChild(home, "seed-unresolved-reflection", undefined, { V21_ID: id });
    const hookDir = join(home, ".hermes-reflection", "test-hooks", "overlay-authority-read");
    await mkdir(hookDir, { recursive: true });
    const readyMarker = join(hookDir, "after_store_index_read.ready");
    const continueMarker = join(hookDir, "after_store_index_read.continue");
    const writer = startProtocolChild(home, "protocol-overlay-writer", { V21_ID: id });
    let reader;
    try {
      assert.equal((await writer.nextMessage()).state, "ready");
      reader = startProtocolChild(home, "protocol-overlay-authority-reader", {
        HERMES_TEST_AUTHORITY_READ_HOOK_DIR: hookDir,
        HERMES_TEST_AUTHORITY_READ_HOOK_POINT: "after_store_index_read",
      });
      await waitForTestMarker(readyMarker, 5_000);
      writer.send({ action: "resolve" });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      assert.equal(writer.messages.length, 0, "overlay writer must block behind the reader authority barrier");
      await writeFile(continueMarker, "continue\n", "utf8");
      assert.equal((await reader.nextMessage()).resolved, false, "reader must return the complete old unresolved snapshot");
      assert.equal((await writer.nextMessage()).found, true);
      const after = await runChild(home, "overlay-read-by-id", undefined, { V21_ID: id });
      assert.equal(after.resolved, true, "next reader must observe the committed resolved overlay");
    } finally {
      await writeFile(continueMarker, "continue\n", "utf8").catch(() => undefined);
      await Promise.allSettled([reader?.stop() ?? Promise.resolve(), writer.stop()]);
    }
  });

  await withHome("update-result-overlay-finalizer", async (home) => {
    const id = "update-finalizer-reflection";
    await runChild(home, "seed-unresolved-reflection", undefined, { V21_ID: id });
    const hookDir = join(home, ".hermes-reflection", "test-hooks", "mutation-finalizer");
    await mkdir(hookDir, { recursive: true });
    const readyMarker = join(hookDir, "before_mutation_result_finalize.ready");
    const continueMarker = join(hookDir, "before_mutation_result_finalize.continue");
    const writer = startProtocolChild(home, "protocol-overlay-writer", { V21_ID: id });
    let reader;
    try {
      assert.equal((await writer.nextMessage()).state, "ready");
      reader = startProtocolChild(home, "protocol-update-reader", {
        V21_ID: id,
        HERMES_TEST_AUTHORITY_READ_HOOK_DIR: hookDir,
        HERMES_TEST_AUTHORITY_READ_HOOK_POINT: "before_mutation_result_finalize",
      });
      await waitForTestMarker(readyMarker, 5_000);
      writer.send({ action: "resolve" });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      assert.equal(writer.messages.length, 0, "overlay mutation must not enter before update result finalization releases the barrier");
      await writeFile(continueMarker, "continue\n", "utf8");
      assert.equal((await reader.nextMessage()).resolved, false, "update result must use the overlay snapshot captured inside its mutation barrier");
      assert.equal((await writer.nextMessage()).found, true);
    } finally {
      await writeFile(continueMarker, "continue\n", "utf8").catch(() => undefined);
      await Promise.allSettled([reader?.stop() ?? Promise.resolve(), writer.stop()]);
    }
  });

  await withHome("journal-cache-coherence", async (home) => {
    const result = await runChild(home, "journal-cache-coherence");
    assert.deepEqual(result.replaced_board, ["replacement board"], "same-process read after journaled replace must not reuse the pre-commit store cache");
    assert.equal(result.replaced_session_count, 0, "journaled replace must be visible through the existing SQLite handle");
    assert.deepEqual(result.cleared_board, [], "same-process read after journaled clear must not reuse the replacement store cache");
    assert.equal(result.cleared_session_count, 0, "journaled clear must remain visible through the existing SQLite handle");
  });

  await withHome("journal-recovery-cache-coherence", async (home) => {
    const result = await runChild(home, "journal-recovery-cache-coherence");
    assert.equal(result.interrupted, true, "the recovery cache regression must leave a prepared journal");
    assert.deepEqual(result.recovered_board, [], "same-process recovery commit must invalidate the pre-recovery store cache");
  });

  await withHome("overlay", async (home) => {
    const interrupted = await runChild(home, "overlay-save", "after_replace:store_index");
    assert.equal(interrupted.interrupted, true);
    const recovered = await runChild(home, "overlay-read");
    assert.equal(recovered.resolved, true, "resolved-question overlay must forward-recover with reflection state");
  });

  await testApprovalReceiptRecovery("after_prepare_journal_fsync");
  await testApprovalReceiptRecovery("after_replace:store_index");
  await testApprovalClaimReceiptGuards();

  console.log("Hermes v21 reflection transaction tests passed.");
}
