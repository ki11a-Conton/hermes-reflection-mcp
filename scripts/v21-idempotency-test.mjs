import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMcp, withTempHome } from "./v20-test-helpers.mjs";

function text(result) {
  return (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function reflectArgs(key, overrides = {}) {
  return {
    session_id: "v21-idempotency-session",
    task_goal: "prove public reflection idempotency",
    task_outcome: "success",
    failure_mode: "success",
    summary: "the same semantic mutation must commit once",
    summary_sections: [], immediate_blockers: [], active_hypotheses: [], proven_safe_paths: [], exhausted_search: [],
    world_model_updates: [], tool_insights: [], context_forget: [], open_questions: [],
    lessons_learned: ["A durable idempotency receipt prevents duplicate reinforcement."],
    available_tools: [], heuristic_feedback: [], auto_extract_heuristics: true,
    domain: "v21-idempotency", tags: ["receipt"], dry_run: false, response_mode: "full",
    idempotency_key: key,
    ...overrides,
  };
}

async function call(client, key, overrides) {
  return client.callTool({ name: "reflect_on_task", arguments: reflectArgs(key, overrides) });
}

async function readAuthorities(home) {
  const root = join(home, ".hermes-reflection");
  const store = JSON.parse(await readFile(join(root, "store.json"), "utf8"));
  const reflections = (await readFile(join(root, "reflections.jsonl"), "utf8"))
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
  return { store, reflections };
}

function assertNarrowLedger(store) {
  const ledger = store.metadata?.committed_receipts;
  assert.ok(ledger && typeof ledger === "object" && !Array.isArray(ledger), "committed receipt ledger must live in store metadata");
  for (const [keyHash, receipt] of Object.entries(ledger)) {
    assert.match(keyHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(receipt).sort(), ["committed_at", "input_hash", "reflection_ids", "result_id", "transaction_id"]);
    assert.match(receipt.transaction_id, /^[0-9a-f-]{36}$/);
    assert.match(receipt.result_id, /^[0-9a-f-]{36}$/);
    assert.match(receipt.input_hash, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(receipt.reflection_ids));
  }
  const serialized = JSON.stringify(ledger);
  assert.doesNotMatch(serialized, /prove public reflection idempotency|same semantic mutation|secret/i,
    "ledger must not persist raw goal, summary, or secret text");
}

await withTempHome("v21-public-idempotency", async (home) => {
  let first;
  let server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    first = await call(server.client, "public-key-1");
    assert.notEqual(first.isError, true, text(first));
    const second = await call(server.client, "public-key-1", {
      response_mode: "compact",
      tags: ["RECEIPT", "receipt"],
      lessons_learned: ["  A durable idempotency receipt prevents duplicate reinforcement.  "],
    });
    assert.notEqual(second.isError, true, text(second));
    assert.equal(second.structuredContent?.reflection_id, first.structuredContent?.reflection_id);
    assert.deepEqual(second.structuredContent?.receipt, first.structuredContent?.receipt,
      "same key and normalized input must return the original receipt");

    const beforeConflict = await readAuthorities(home);
    const conflict = await call(server.client, "public-key-1", { summary: "different semantic mutation" });
    assert.equal(conflict.isError, true);
    assert.match(text(conflict), /IDEMPOTENCY_CONFLICT/);
    const afterConflict = await readAuthorities(home);
    assert.deepEqual(afterConflict, beforeConflict, "idempotency conflict must not mutate state");
  } finally { await server.close().catch(() => undefined); }

  server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    const restarted = await call(server.client, "public-key-1");
    assert.notEqual(restarted.isError, true, text(restarted));
    assert.equal(restarted.structuredContent?.reflection_id, first.structuredContent?.reflection_id);
    assert.deepEqual(restarted.structuredContent?.receipt, first.structuredContent?.receipt,
      "idempotency must survive process restart");
  } finally { await server.close().catch(() => undefined); }

  const { store, reflections } = await readAuthorities(home);
  assert.equal(reflections.length, 1, "reflection must commit exactly once");
  const heuristic = store.heuristics.find((item) => item.heuristic === "A durable idempotency receipt prevents duplicate reinforcement.");
  assert.ok(heuristic, "auto-extracted heuristic must exist");
  assert.equal(heuristic.evidence.length, 1, "evidence must commit exactly once");
  assert.equal(heuristic.reinforcement_count, 1, "idempotent replay must leave the single committed reinforcement unchanged");
  assertNarrowLedger(store);
});

await withTempHome("v21-idempotency-validation", async (home) => {
  const server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    const tooLong = await call(server.client, "x".repeat(129));
    assert.equal(tooLong.isError, true);
    const scalarBoundary = await call(server.client, "🧠".repeat(128));
    assert.notEqual(scalarBoundary.isError, true, text(scalarBoundary));
  } finally { await server.close().catch(() => undefined); }
});

await withTempHome("v21-idempotency-cross-process", async (home) => {
  const first = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  const second = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    const same = await Promise.all([
      call(first.client, "cross-process-same"),
      call(second.client, "cross-process-same"),
    ]);
    for (const result of same) assert.notEqual(result.isError, true, text(result));
    const originalId = same[0].structuredContent?.reflection_id;
    const originalReceipt = same[0].structuredContent?.receipt;
    assert.ok(originalId && originalReceipt);
    assert.equal(same[1].structuredContent?.reflection_id, originalId);
    assert.deepEqual(same[1].structuredContent?.receipt, originalReceipt);
    for (const result of same) {
      assert.equal(result.structuredContent?.receipt?.reflection_ids?.[0], originalId);
      assert.match(text(result), new RegExp(originalId));
      assert.match(text(result), new RegExp(originalReceipt.result_id));
    }

    let state = await readAuthorities(home);
    assert.equal(state.reflections.length, 1, "two MCP processes must commit the same public key once");
    let heuristic = state.store.heuristics.find((item) => item.heuristic === "A durable idempotency receipt prevents duplicate reinforcement.");
    assert.equal(heuristic?.evidence?.length, 1);
    assert.equal(heuristic?.reinforcement_count, 1);

    const different = await Promise.all([
      call(first.client, "cross-process-conflict", { task_goal: "concurrent semantic input A" }),
      call(second.client, "cross-process-conflict", { task_goal: "concurrent semantic input B" }),
    ]);
    assert.equal(different.filter((result) => result.isError !== true).length, 1, "one different-input contender must win");
    const conflict = different.find((result) => result.isError === true);
    assert.ok(conflict);
    assert.match(text(conflict), /IDEMPOTENCY_CONFLICT/);

    state = await readAuthorities(home);
    assert.equal(state.reflections.length, 2, "the conflicting contender must add no write beyond the single winner");
    heuristic = state.store.heuristics.find((item) => item.heuristic === "A durable idempotency receipt prevents duplicate reinforcement.");
    assert.equal(heuristic?.evidence?.length, 2);
    assert.equal(heuristic?.reinforcement_count, 2);
  } finally {
    await Promise.all([first.close().catch(() => undefined), second.close().catch(() => undefined)]);
  }
});

await withTempHome("v21-idempotency-gc", async (home) => {
  let server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try { assert.notEqual((await call(server.client, "gc-seed")).isError, true); }
  finally { await server.close().catch(() => undefined); }

  const path = join(home, ".hermes-reflection", "store.json");
  const store = JSON.parse(await readFile(path, "utf8"));
  const ledger = Object.create(null);
  const now = Date.now();
  for (let index = 0; index < 2048; index++) {
    const key = createHash("sha256").update(`cap-${index}`).digest("hex");
    const suffix = index.toString(16).padStart(12, "0");
    ledger[key] = {
      transaction_id: `10000000-0000-4000-8000-${suffix}`,
      result_id: `20000000-0000-4000-8000-${suffix}`,
      reflection_ids: [`gc-${index}`], input_hash: "a".repeat(64),
      committed_at: new Date(now - (2048 - index) * 1000).toISOString(),
    };
  }
  const expiredKey = createHash("sha256").update("expired-key").digest("hex");
  ledger[expiredKey] = {
    transaction_id: "30000000-0000-4000-8000-000000000001",
    result_id: "40000000-0000-4000-8000-000000000001",
    reflection_ids: ["expired"], input_hash: "b".repeat(64),
    committed_at: new Date(now - 181 * 24 * 60 * 60 * 1000).toISOString(),
  };
  store.metadata.committed_receipts = ledger;
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");

  server = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    const fresh = await call(server.client, "gc-new", { task_goal: "gc boundary request", lessons_learned: [] });
    assert.notEqual(fresh.isError, true, text(fresh));
  } finally { await server.close().catch(() => undefined); }

  const after = (await readAuthorities(home)).store.metadata.committed_receipts;
  assert.equal(Object.keys(after).length, 2048, "ledger must retain at most 2048 committed receipts");
  assert.equal(after[expiredKey], undefined, "receipts older than 180 days must expire");
  const oldestCapKey = createHash("sha256").update("cap-0").digest("hex");
  assert.equal(after[oldestCapKey], undefined, "capacity GC must evict the oldest committed receipt");
});

console.log("Hermes v21 public idempotency tests passed.");
