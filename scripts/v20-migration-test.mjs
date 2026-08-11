import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  evidenceId,
  evidenceSignal,
  feedbackSignal,
  normalizedLesson,
} from "../dist/src/evidence.js";
import {
  FileProjectScopeRepository,
  projectScope,
} from "../dist/src/project_scope.js";

const execFileAsync = promisify(execFile);
const storageUrl = new URL("../dist/storage.js", import.meta.url).href;
const timestamp = "2026-07-28T00:00:00.000Z";

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reflection(overrides = {}) {
  return {
    id: "reflection-legacy-1",
    timestamp,
    session_id: "session-legacy-1",
    task_goal: "Preserve the exact legacy reflection",
    task_outcome: "success",
    failure_mode: "success",
    task_state: {
      summary: "Legacy summary must survive migration byte-for-field.",
      immediate_blockers: [],
      active_hypotheses: [],
      proven_safe_paths: ["validated migration"],
      exhausted_search: [],
    },
    world_model_updates: [],
    tool_insights: [],
    context_forget: [],
    open_questions: [],
    lessons_learned: ["  Keep   stable IDs  "],
    affordance_gaps: [],
    domain: "migration",
    tags: ["legacy"],
    ...overrides,
  };
}

function heuristic(overrides = {}) {
  return {
    id: "heuristic-legacy-1",
    created_at: timestamp,
    updated_at: timestamp,
    domain: "migration",
    heuristic: "  Keep   stable IDs  ",
    source_task: "Preserve the exact legacy reflection",
    session_id: "session-legacy-1",
    reinforcement_count: 1,
    contradiction_count: 0,
    contradiction_notes: [],
    confidence: 0.8,
    retrieval_count: 4,
    last_retrieved_at: timestamp,
    version: 1,
    tags: ["legacy"],
    ...overrides,
  };
}

function legacyStore(overrides = {}) {
  return {
    sessions: {
      "session-legacy-1": {
        id: "session-legacy-1",
        started_at: timestamp,
        reflection_count: 1,
        affordance_gap_count: 0,
      },
    },
    reflections: [reflection()],
    affordance_gaps: [],
    heuristics: [heuristic()],
    version: "19.5.0",
    memory_board: { entries: [], char_limit: 2200, used_chars: 0 },
    user_profile: { entries: [], char_limit: 1800, used_chars: 0 },
    metadata: {
      created_at: timestamp,
      last_written_at: timestamp,
      write_count: 7,
      pending_mutations: [],
    },
    ...overrides,
  };
}

async function prepareHome(prefix, store, jsonlRows = store.reflections ?? []) {
  const home = await mkdtemp(join(tmpdir(), `hermes-v20-${prefix}-`));
  const dir = join(home, ".hermes-reflection");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "store.json"), JSON.stringify(store, null, 2), "utf8");
  await writeFile(join(dir, "reflections.jsonl"), jsonlRows.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  return { home, dir };
}

async function initialize(home, expectFailure = false) {
  const script = `
    const storage = await import(${JSON.stringify(storageUrl)} + "?migration=" + Date.now());
    await storage.initializeStoreV20();
  `;
  try {
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(expectFailure, false, "migration unexpectedly succeeded");
  } catch (error) {
    if (!expectFailure) throw error;
    return `${error.stderr ?? ""}${error.stdout ?? ""}${error.message ?? ""}`;
  }
  return "";
}

async function testLegacyAndIdempotency() {
  const fixture = await prepareHome("legacy-migration", legacyStore());
  try {
    await initialize(fixture.home);
    const storePath = join(fixture.dir, "store.json");
    const jsonlPath = join(fixture.dir, "reflections.jsonl");
    const firstStoreBytes = await readFile(storePath, "utf8");
    const firstJsonlBytes = await readFile(jsonlPath, "utf8");
    const migrated = JSON.parse(firstStoreBytes);
    const migratedReflection = JSON.parse(firstJsonlBytes.trim());
    const migratedHeuristic = migrated.heuristics[0];

    assert.equal(migrated.metadata.store_schema_version, 2);
    assert.equal(migrated.metadata.write_count, 7, "migration must not increment write_count");
    assert.equal(migratedReflection.scope, "global");
    assert.equal(migratedHeuristic.scope, "global");
    assert.equal(migratedReflection.id, "reflection-legacy-1");
    assert.equal(migratedReflection.timestamp, timestamp);
    assert.equal(migratedReflection.task_state.summary, "Legacy summary must survive migration byte-for-field.");
    assert.equal(migratedHeuristic.id, "heuristic-legacy-1");
    assert.equal(migratedHeuristic.heuristic, "  Keep   stable IDs  ");
    assert.equal(migratedHeuristic.created_at, timestamp);
    assert.equal(migratedHeuristic.retrieval_count, 4, "legacy telemetry remains readable");
    assert.deepEqual(migratedHeuristic.feedback, []);
    assert.equal(migratedHeuristic.evidence.length, 1);
    assert.equal(
      migratedHeuristic.evidence[0].id,
      evidenceId(migratedHeuristic.source_task, migratedHeuristic.heuristic),
    );
    assert.equal(migratedHeuristic.evidence[0].source_task, migratedHeuristic.source_task);
    assert.equal(migratedHeuristic.evidence[0].content_hash, sha(normalizedLesson(migratedHeuristic.heuristic)));
    assert.equal(migratedHeuristic.evidence[0].created_at, timestamp);

    await initialize(fixture.home);
    assert.equal(await readFile(storePath, "utf8"), firstStoreBytes, "second migration must be byte-stable");
    assert.equal(await readFile(jsonlPath, "utf8"), firstJsonlBytes, "second JSONL migration must be byte-stable");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}

async function testInvalidAndFutureFailClosed() {
  const validFixture = await prepareHome("valid-seed", legacyStore());
  try {
    await initialize(validFixture.home);
    const migrated = JSON.parse(await readFile(join(validFixture.dir, "store.json"), "utf8"));
    const migratedRows = (await readFile(join(validFixture.dir, "reflections.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);

    const invalid = structuredClone(migrated);
    invalid.heuristics[0].evidence[0].content_hash = "not-a-sha256";
    const invalidFixture = await prepareHome("invalid-evidence", invalid, migratedRows);
    try {
      const path = join(invalidFixture.dir, "store.json");
      const before = await readFile(path, "utf8");
      const diagnostic = await initialize(invalidFixture.home, true);
      assert.match(diagnostic, /evidence|content_hash|invalid/i);
      assert.equal(await readFile(path, "utf8"), before);
      const names = await readdir(invalidFixture.dir);
      assert.equal(names.filter((name) => /^store\.json\.corrupt\.[a-f0-9]{16}\.bak$/.test(name)).length, 1);
    } finally {
      await rm(invalidFixture.home, { recursive: true, force: true });
    }

    const future = structuredClone(migrated);
    future.metadata.store_schema_version = 3;
    const futureFixture = await prepareHome("future-schema", future, migratedRows);
    try {
      const path = join(futureFixture.dir, "store.json");
      const before = await readFile(path, "utf8");
      const diagnostic = await initialize(futureFixture.home, true);
      assert.match(diagnostic, /future|schema|version/i);
      assert.equal(await readFile(path, "utf8"), before);
      const names = await readdir(futureFixture.dir);
      assert.equal(names.filter((name) => /^store\.json\.corrupt\.[a-f0-9]{16}\.bak$/.test(name)).length, 1);
    } finally {
      await rm(futureFixture.home, { recursive: true, force: true });
    }
  } finally {
    await rm(validFixture.home, { recursive: true, force: true });
  }
}

async function testInterruptedPreVersionWrite() {
  const row = reflection({ scope: "global" });
  const fixture = await prepareHome("interrupted", legacyStore({ reflections: [] }), [row]);
  try {
    await initialize(fixture.home);
    const migrated = JSON.parse(await readFile(join(fixture.dir, "store.json"), "utf8"));
    const migratedRow = JSON.parse((await readFile(join(fixture.dir, "reflections.jsonl"), "utf8")).trim());
    assert.equal(migrated.metadata.store_schema_version, 2);
    assert.equal(migratedRow.id, row.id);
    assert.equal(migratedRow.scope, "global");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}

async function testScopeRepository() {
  assert.equal(projectScope(), "global");
  assert.equal(projectScope("alpha"), "project:alpha");
  assert.equal(projectScope("project:alpha"), "project:alpha");
  assert.throws(() => projectScope("unsafe path/value"), /project_key/i);

  const home = await mkdtemp(join(tmpdir(), "hermes-v20-scope-"));
  const path = join(home, "project_scope.json");
  try {
    const first = new FileProjectScopeRepository(path);
    assert.equal(await first.bind("session-a", "alpha"), "project:alpha");
    const restarted = new FileProjectScopeRepository(path);
    assert.equal(await restarted.resolve({ session_id: "session-a" }), "project:alpha");
    assert.equal(await restarted.resolve({ session_id: "session-a", project_key: "beta" }), "project:beta");
    await assert.rejects(() => restarted.bind("unsafe/session", "alpha"), /session_id/i);
    for (let index = 0; index < 99; index += 1) {
      await restarted.bind(`session-${String(index).padStart(3, "0")}`, `project-${index}`);
    }
    const rejectedSession = "session-overflow";
    await assert.rejects(
      () => restarted.bind(rejectedSession, "project-overflow"),
      (error) => error?.code === "LIFECYCLE_NOT_READY" && /capacity.*full/i.test(error.message),
    );
    const fullState = JSON.parse(await readFile(path, "utf8"));
    assert.equal(Object.keys(fullState.bindings).length, 100);
    assert.equal(fullState.bindings["session-a"].scope, "project:alpha");
    assert.equal(fullState.bindings[rejectedSession], undefined);

    await restarted.release("session-a");
    assert.equal(await restarted.resolve({ session_id: "session-a" }), "global");
    assert.equal(await restarted.bind(rejectedSession, "project-overflow"), "project:project-overflow");
    const reusedState = JSON.parse(await readFile(path, "utf8"));
    assert.equal(Object.keys(reusedState.bindings).length, 100);
    assert.equal(reusedState.bindings[rejectedSession].scope, "project:project-overflow");

    const corrupt = JSON.stringify({ schema_version: 2, bindings: {} });
    await writeFile(path, corrupt, "utf8");
    await assert.rejects(() => restarted.resolve({ session_id: "session-new" }), /schema|future|invalid/i);
    assert.equal(await readFile(path, "utf8"), corrupt);
    const names = await readdir(home);
    assert.equal(names.filter((name) => /^project_scope\.json\.corrupt\.[a-f0-9]{16}\.bak$/.test(name)).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function testEvidenceMath() {
  assert.equal(normalizedLesson("  Alpha   BETA\n"), "alpha beta");
  assert.equal(evidenceId("source", " Alpha "), evidenceId("source", "alpha"));
  assert.equal(evidenceSignal([{ id: "a" }, { id: "a" }, { id: "b" }]), 0.4);
  assert.equal(feedbackSignal([
    { value: "helpful" },
    { value: "harmful" },
    { value: "irrelevant" },
  ]), -0.1);
}

await testLegacyAndIdempotency();
await testInvalidAndFutureFailClosed();
await testInterruptedPreVersionWrite();
await testScopeRepository();
testEvidenceMath();
console.log("[PASS] v20 migration, scope binding, and evidence contracts");
