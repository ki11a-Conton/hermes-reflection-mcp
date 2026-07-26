import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTempHome(run) {
  const home = await mkdtemp(join(tmpdir(), "hermes-v19-4-"));
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await run(home);
  } finally {
    if (before.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = before.HOME;
    if (before.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = before.USERPROFILE;
    await rm(home, { recursive: true, force: true });
  }
}

function heuristic(text) {
  return {
    domain: "v19.4-probe",
    heuristic: text,
    source_task: "v19.4-regression",
    confidence: 0.7,
    tags: ["v19.4"],
  };
}

async function freshStorage() {
  return import(`../dist/storage.js?v19_4=${Date.now()}-${Math.random()}`);
}

async function testCorruptMainStoreFailsClosed() {
  await withTempHome(async (home) => {
    const storage = await freshStorage();
    await storage.upsertHeuristic(heuristic("first durable heuristic"));
    const storePath = join(home, ".hermes-reflection", "store.json");
    const corrupt = '{"heuristics":[';
    await writeFile(storePath, corrupt, "utf8");

    await assert.rejects(
      () => storage.upsertHeuristic(heuristic("must not persist")),
      /Refusing to continue/i,
    );
    assert.equal(await readFile(storePath, "utf8"), corrupt);
  });
}

async function testAuthoritativeStateHelper() {
  await withTempHome(async (home) => {
    const state = await import(`../dist/src/authoritative_state.js?helper=${Date.now()}`);
    const missing = await state.readAuthoritativeUtf8(join(home, "missing.json"));
    assert.deepEqual(missing, { exists: false });

    const path = join(home, "state.json");
    await writeFile(path, "{broken", "utf8");
    await assert.rejects(() => state.readAuthoritativeJson(path, "test state"), /cannot be parsed/i);
    await assert.rejects(() => state.readAuthoritativeJson(path, "test state"), /cannot be parsed/i);
    const backups = (await readdir(home)).filter((name) => /^state\.json\.corrupt\.[a-f0-9]{16}\.bak$/.test(name));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(home, backups[0]), "utf8"), "{broken");
  });
}

async function testCorruptReflectionsFailClosed() {
  await withTempHome(async (home) => {
    const storage = await freshStorage();
    await storage.upsertHeuristic(heuristic("seed store index"));
    const reflectionsPath = join(home, ".hermes-reflection", "reflections.jsonl");
    const corrupt = '{"id":"incomplete"';
    await writeFile(reflectionsPath, corrupt, "utf8");
    await assert.rejects(() => storage.loadStore(), /reflections\.jsonl line 1 cannot be parsed/i);
    await assert.rejects(() => storage.loadStore(), /reflections\.jsonl line 1 cannot be parsed/i);
    assert.equal(await readFile(reflectionsPath, "utf8"), corrupt);
    const storeFiles = await readdir(join(home, ".hermes-reflection"));
    assert.equal(
      storeFiles.filter((name) => /^reflections\.jsonl\.corrupt\.[a-f0-9]{16}\.bak$/.test(name)).length,
      1,
    );
  });
}

async function testFailedReplacementPreservesTarget() {
  await withTempHome(async (home) => {
    const storage = await freshStorage();
    const target = join(home, "target.json");
    const missingTemp = join(home, "missing-temp.json");
    await writeFile(target, "last-known-good", "utf8");
    await assert.rejects(() => storage.replaceFileAtomicallyForTest(missingTemp, target));
    assert.equal(await readFile(target, "utf8"), "last-known-good");
    const source = await readFile(new URL("../dist/storage.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /rm\(targetPath/);
  });
}

async function testCorruptBackgroundStateFailsClosed() {
  await withTempHome(async (home) => {
    const { BackgroundStateStore } = await import(`../dist/src/background_state.js?background=${Date.now()}`);
    const path = join(home, "background_lifecycle.json");
    const store = new BackgroundStateStore(path);
    await store.markDirty("durable-session");
    const corrupt = '{"dirty_sessions":';
    await writeFile(path, corrupt, "utf8");

    await assert.rejects(() => store.status(), /Refusing to continue/i);
    await assert.rejects(() => store.markDirty("must-not-persist"), /Refusing to continue/i);
    await assert.rejects(() => store.acquireLease("owner", 60_000), /Refusing to continue/i);
    assert.equal(await readFile(path, "utf8"), corrupt);
    const backups = (await readdir(home)).filter((name) => /^background_lifecycle\.json\.corrupt\.[a-f0-9]{16}\.bak$/.test(name));
    assert.equal(backups.length, 1);
  });
}

async function testRecentUserCompactionAnchors() {
  const { buildCompactionHandoff, CONTEXT_HANDOFF_END_MARKER } = await import(
    `../dist/src/compaction_handoff.js?compaction=${Date.now()}`
  );
  const ts = "2026-07-26T00:00:00.000Z";
  const turn = (turn_index, role, content) => ({ session_id: "compact-v19.4", turn_index, role, content, timestamp: ts });
  const turns = [
    turn(0, "user", "old user request"),
    turn(1, "assistant", "old assistant"),
    turn(2, "user", "recent user two"),
    turn(3, "user", "   "),
    turn(4, "user", "recent user three 😀"),
    turn(5, "user", "[CONTEXT COMPACTION — REFERENCE ONLY] nested historical handoff"),
    turn(6, "user", "latest user four"),
    turn(7, "assistant", "latest assistant state"),
  ];

  const result = buildCompactionHandoff(turns, [], 40, 6000, 3);
  assert.match(result.handoff, /recent user two/);
  assert.match(result.handoff, /recent user three/);
  assert.match(result.handoff, /latest user four/);
  assert.match(result.handoff, /latest assistant state/);
  assert.doesNotMatch(result.handoff, /old user request|nested historical handoff/);
  assert.deepEqual(result.source.recent_user_turn_indexes, [2, 4, 6]);
  assert.equal(result.source.requested_recent_user_turns, 3);
  assert.equal(result.source.included_recent_user_turns, 3);

  const tightTurns = turns.map((item) => item.role === "user" && item.content.trim()
    ? { ...item, content: `${item.content} ${"😀".repeat(300)}` }
    : item);
  const tight = buildCompactionHandoff(tightTurns, [], 40, 500, 3);
  assert.ok(tight.handoff.length <= 500);
  assert.ok(Array.from(tight.handoff).length <= 500);
  assert.match(tight.handoff, /^\[CONTEXT COMPACTION — REFERENCE ONLY\]/);
  assert.ok(tight.handoff.endsWith(CONTEXT_HANDOFF_END_MARKER));
  assert.ok(tight.source.recent_user_turns_omitted_due_to_budget >= 1);
  assert.doesNotMatch(tight.handoff, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
}

async function testLegacyMigrationValidatesJsonlBeforeWriting() {
  await withTempHome(async (home) => {
    const storage = await freshStorage();
    const dir = join(home, ".hermes-reflection");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dir, { recursive: true }));
    const reflection = {
      id: "legacy-reflection",
      timestamp: "2026-07-26T00:00:00.000Z",
      session_id: "legacy-session",
      task_goal: "preserve legacy data before validation",
      task_outcome: "success",
      failure_mode: "success",
      task_state: { summary: "legacy", immediate_blockers: [], active_hypotheses: [], proven_safe_paths: [], exhausted_search: [] },
      world_model_updates: [], tool_insights: [], context_forget: [], open_questions: [], lessons_learned: [], affordance_gaps: [],
      domain: "v19.4-probe", tags: [],
    };
    const storePath = join(dir, "store.json");
    const original = JSON.stringify({ reflections: [reflection], sessions: {}, affordance_gaps: [], heuristics: [] }, null, 2);
    await writeFile(storePath, original, "utf8");
    await writeFile(join(dir, "reflections.jsonl"), "{broken-jsonl", "utf8");
    await assert.rejects(() => storage.loadStore(), /reflections\.jsonl line 1 cannot be parsed/i);
    assert.equal(await readFile(storePath, "utf8"), original);
  });
}

async function testRecentReflectionFastPathDoesNotHideCorruption() {
  await withTempHome(async (home) => {
    const storage = await freshStorage();
    await storage.upsertHeuristic(heuristic("seed recent-reflection store"));
    const path = join(home, ".hermes-reflection", "reflections.jsonl");
    const rows = [];
    for (let index = 0; index < 120; index += 1) {
      if (index === 110) {
        rows.push('{"broken":');
        continue;
      }
      rows.push(JSON.stringify({
        id: `recent-${index}`, timestamp: "2026-07-26T00:00:00.000Z", session_id: "recent-fast-path",
        task_goal: `recent goal ${index} ${"x".repeat(200)}`, task_outcome: "success", failure_mode: "success",
        task_state: { summary: "safe", immediate_blockers: [], active_hypotheses: [], proven_safe_paths: [], exhausted_search: [] },
        world_model_updates: [], tool_insights: [], context_forget: [], open_questions: [], lessons_learned: [], affordance_gaps: [],
        domain: "v19.4-probe", tags: [],
      }));
    }
    await writeFile(path, `${rows.join("\n")}\n`, "utf8");
    await assert.rejects(() => storage.getRecentReflections(5), /reflections\.jsonl line 111 cannot be parsed/i);
  });
}

const tests = [
  ["authoritative state helper", testAuthoritativeStateHelper],
  ["corrupt main store fails closed", testCorruptMainStoreFailsClosed],
  ["corrupt reflections fail closed", testCorruptReflectionsFailClosed],
  ["failed replacement preserves target", testFailedReplacementPreservesTarget],
  ["corrupt background state fails closed", testCorruptBackgroundStateFailsClosed],
  ["recent user compaction anchors", testRecentUserCompactionAnchors],
  ["legacy migration validates JSONL before writing", testLegacyMigrationValidatesJsonlBeforeWriting],
  ["recent reflection fast path does not hide corruption", testRecentReflectionFastPathDoesNotHideCorruption],
];

for (const [name, test] of tests) {
  await test();
  console.log(`[PASS] ${name}`);
}

console.log(`v19.4 regression suite passed (${tests.length} tests).`);
