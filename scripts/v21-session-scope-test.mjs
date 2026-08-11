import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { startMcp } from "./v20-test-helpers.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const roundtripCompactionMetadata = {
  generation: 3,
  before_turn_count: 3,
  after_turn_count: 0,
  handoff_hash: "a".repeat(64),
  truncated: true,
  source_fingerprint: "b".repeat(64),
};
const roundtripCompactionReceipt = JSON.stringify({
  ...roundtripCompactionMetadata,
  status: "committed",
  receipt_hash: createHash("sha256").update(JSON.stringify(roundtripCompactionMetadata), "utf8").digest("hex"),
});

async function withTempHome(label, callback) {
  const home = await mkdtemp(join(tmpdir(), `hermes-v21-${label}-`));
  try {
    return await callback(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runChild(home, mode) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, "--child", mode], {
    cwd: dirname(scriptPath),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HERMES_REFLECTION_BACKGROUND_ENABLED: "0",
    },
    windowsHide: true,
  });
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
  return stdout.trim();
}

function seedV20Database(home) {
  const storeDir = join(home, ".hermes-reflection");
  const dbPath = join(storeDir, "sessions.db");
  return mkdir(storeDir, { recursive: true }).then(() => {
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE session_meta (
          session_id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          turn_count INTEGER NOT NULL DEFAULT 0,
          last_turn_at TEXT
        );
      `);
      db.prepare(
        "INSERT INTO session_meta (session_id, started_at, turn_count, last_turn_at) VALUES (?, ?, 0, NULL)",
      ).run("v20-row", "2026-08-01T00:00:00.000Z");
    } finally {
      db.close();
    }
  });
}

async function expectScopeError(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

async function childMain(mode) {
  if (mode === "baseline-v20") {
    const baselineRoot = process.env.HERMES_V20_BASELINE_ROOT;
    assert(baselineRoot, "HERMES_V20_BASELINE_ROOT is required for the explicit v20 baseline mode");
    const sessions = await import(pathToFileURL(join(baselineRoot, "dist", "session_storage.js")).href);
    const meta = (await sessions.listRecentSessions(10))
      ?.find((item) => item.session_id === "v20-row");
    assert(meta, "installed v20 must read the seeded v20 session metadata");
    assert.equal(
      meta.scope,
      "legacy-unscoped",
      "v20 session metadata lacks durable scope and must fail this v21 provenance contract",
    );
    sessions.closeSessionStorage();
    return;
  }

  if (mode === "platform-case") {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(originalPlatform?.configurable, "process.platform must be configurable for the platform branch probe");
    const salt = Buffer.alloc(32, 7);
    const upper = join(process.env.HOME, "CaseSensitiveProject");
    const lower = join(process.env.HOME, "casesensitiveproject");
    try {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
      const { deriveProjectKey } = await import("../dist/src/project_scope.js");
      assert.notEqual(
        deriveProjectKey(upper, salt),
        deriveProjectKey(lower, salt),
        "Linux project identity must preserve path case",
      );
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
      assert.equal(
        deriveProjectKey(upper, salt),
        deriveProjectKey(lower, salt),
        "Windows project identity must fold path case",
      );
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    return;
  }

  const sessions = await import("../dist/session_storage.js");
  const scopes = await import("../dist/src/session_scope.js").catch(() => ({}));

  if (mode === "background-persisted-scope") {
    const storage = await import("../dist/storage.js");
    const { BackgroundLifecycle } = await import("../dist/src/background_lifecycle.js");
    const { BackgroundStateStore } = await import("../dist/src/background_state.js");
    const { HookInbox } = await import("../dist/src/hook_inbox.js");
    await storage.initializeStoreV20();
    await sessions.persistSessionStart("background-project", { scope: "project:alpha" });
    const reflection = (id, scope, lesson) => ({
      id,
      timestamp: "2026-08-02T05:00:00.000Z",
      session_id: "background-project",
      scope,
      task_goal: `Review ${id}`,
      task_outcome: "success",
      failure_mode: "success",
      task_state: {
        summary: lesson,
        immediate_blockers: [], active_hypotheses: [], proven_safe_paths: [], exhausted_search: [],
      },
      world_model_updates: [], tool_insights: [], context_forget: [], open_questions: [],
      lessons_learned: [lesson], affordance_gaps: [], domain: "software-engineering", tags: [],
    });
    await storage.saveReflectionAndHeuristics(
      reflection("background-alpha", "project:alpha", "BACKGROUND_ALPHA_ONLY: retain persisted project evidence."),
      [], "software-engineering", "v21-session-scope-test", 0.65, [],
    );
    await storage.saveReflectionAndHeuristics(
      reflection("background-rogue-global", "global", "BACKGROUND_GLOBAL_ROGUE: must not select scope from reflections."),
      [], "software-engineering", "v21-session-scope-test", 0.65, [],
    );
    await sessions.persistSessionEnd("background-project", {
      scope: "project:alpha",
      end_reason: "completed",
    });
    const lifecycle = new BackgroundLifecycle({
      enabled: true,
      interval_ms: 60_000,
      idle_ms: 0,
      lease_ms: 60_000,
      max_sessions_per_run: 1,
      review_mode: "deterministic",
      auto_apply: false,
      store: new BackgroundStateStore(join(process.env.HOME, ".hermes-reflection", "background-test.json")),
      hook_inbox: new HookInbox(join(process.env.HOME, ".hermes-reflection", "background-hook-inbox")),
    });
    try {
      await lifecycle.notifyReflectionSaved("background-project");
      await lifecycle.runNow();
      const exported = await storage.exportData();
      const candidates = exported.metadata.review_candidates.filter((item) => item.source_reflection_ids.includes("background-alpha"));
      assert.equal(candidates.length, 1, "automatic review did not use persisted project provenance");
      assert.equal(candidates[0].scope, "project:alpha");
      assert.equal(
        exported.metadata.review_candidates.some((item) => item.source_reflection_ids.includes("background-rogue-global")),
        false,
        "automatic review selected a foreign reflection scope instead of persisted provenance",
      );
    } finally {
      await lifecycle.shutdown();
      sessions.closeSessionStorage();
    }
    return;
  }

  if (mode === "legacy") {
    const meta = await sessions.getSessionMeta?.("v20-row")
      ?? (await sessions.listRecentSessions(10))?.find((item) => item.session_id === "v20-row");
    assert(meta, "migrated v20 session metadata must remain readable");
    assert.equal(meta.scope, "legacy-unscoped", "v20 rows must migrate fail-closed, never become global");
    sessions.closeSessionStorage();
    const db = new Database(join(process.env.HOME, ".hermes-reflection", "sessions.db"), { readonly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(session_meta)").all().map((column) => column.name);
      process.stdout.write(`${JSON.stringify({ columns, meta })}\n`);
    } finally {
      db.close();
    }
    return;
  }

  if (mode === "lifecycle-write") {
    assert.equal(scopes.normalizeRequestedSessionScope("global"), "global");
    assert.equal(scopes.normalizeRequestedSessionScope("project:alpha"), "project:alpha");
    assert.equal(scopes.requestedSessionScope({}), undefined);
    assert.equal(scopes.requestedSessionScope({ bound_scope: "global" }), "global");
    assert.equal(scopes.requestedSessionScope({ project_key: "alpha" }), "project:alpha");
    assert.equal(
      scopes.requestedSessionScope({ project_key: "alpha", bound_scope: "project:alpha" }),
      "project:alpha",
    );
    assert.throws(
      () => scopes.requestedSessionScope({ project_key: "alpha", bound_scope: "global" }),
      (error) => error?.code === "SCOPE_MISMATCH",
    );
    assert.equal(scopes.assertSessionScopeVisible("global", "global"), "global");
    assert.equal(scopes.assertSessionScopeVisible("global", undefined), "global");
    assert.throws(
      () => scopes.assertSessionScopeVisible("project:alpha", undefined),
      (error) => error?.code === "SCOPE_REQUIRED",
    );
    assert.throws(
      () => scopes.assertSessionScopeVisible("project:alpha", "global"),
      (error) => error?.code === "SCOPE_MISMATCH",
    );
    assert.throws(
      () => scopes.assertSessionScopeVisible("legacy-unscoped"),
      (error) => error?.code === "LEGACY_SCOPE_DENIED",
    );
    assert.equal(
      scopes.assertSessionScopeVisible("legacy-unscoped", undefined, { allow_legacy_unscoped: true }),
      "legacy-unscoped",
    );
    assert.throws(
      () => scopes.normalizeRequestedSessionScope(undefined),
      (error) => error?.code === "SCOPE_REQUIRED",
    );
    assert.throws(
      () => scopes.assertSessionScopeVisibility("project:alpha", "global"),
      (error) => error?.code === "SCOPE_MISMATCH",
      "global authority must not bypass a project session",
    );
    assert.throws(
      () => scopes.assertSessionScopeVisibility("legacy-unscoped", "global"),
      (error) => error?.code === "LEGACY_SCOPE_DENIED",
    );

    await expectScopeError(
      () => sessions.appendSessionTurn(
        "unscoped-new-session",
        "user",
        "must not create legacy data",
      ),
      "SCOPE_REQUIRED",
    );
    assert.equal(await sessions.getSessionMeta("unscoped-new-session"), null);
    assert.deepEqual(await sessions.listSessionTurns("unscoped-new-session"), []);

    assert.equal(await sessions.persistSessionStart("global-session", {
      scope: "global",
      started_at: "2026-08-02T01:00:00.000Z",
      start_event_id: "global-start",
    }), true);
    assert.equal(await sessions.appendSessionTurn(
      "global-session",
      "user",
      "explicit global turn",
      "2026-08-02T01:01:00.000Z",
      { scope: "global" },
    ), true);

    assert.equal(await sessions.persistSessionStart("alpha-session", {
      scope: "project:alpha",
      parent_session_id: "parent-session",
      start_event_id: "alpha-start",
      started_at: "2026-08-02T02:00:00.000Z",
    }), true);
    assert.equal(await sessions.appendSessionTurn(
      "alpha-session",
      "assistant",
      "alpha private turn",
      "2026-08-02T02:01:00.000Z",
      { scope: "project:alpha" },
    ), true);
    await expectScopeError(
      () => sessions.appendSessionTurn("alpha-session", "user", "global bypass", undefined, { scope: "global" }),
      "SCOPE_MISMATCH",
    );
    await expectScopeError(
      () => sessions.persistSessionStart("alpha-session", { scope: "project:beta" }),
      "SCOPE_MISMATCH",
    );
    assert.equal(await sessions.persistSessionEnd("alpha-session", {
      scope: "project:alpha",
      end_reason: "completed",
      ended_at: "2026-08-02T02:02:00.000Z",
    }), true);
    await expectScopeError(
      () => sessions.persistSessionEnd("missing-session", { scope: "global", end_reason: "missing" }),
      "LIFECYCLE_NOT_READY",
    );

    const globalMeta = await sessions.getSessionMeta("global-session");
    assert.equal(globalMeta.scope, "global", "new global sessions require explicit global provenance");
    const alphaMeta = await sessions.getSessionMeta("alpha-session");
    assert.deepEqual({
      scope: alphaMeta.scope,
      parent_session_id: alphaMeta.parent_session_id,
      start_event_id: alphaMeta.start_event_id,
      end_reason: alphaMeta.end_reason,
      ended_at: alphaMeta.ended_at,
      compaction_generation: alphaMeta.compaction_generation,
    }, {
      scope: "project:alpha",
      parent_session_id: "parent-session",
      start_event_id: "alpha-start",
      end_reason: "completed",
      ended_at: "2026-08-02T02:02:00.000Z",
      compaction_generation: 0,
    });
    assert.equal(await sessions.resolveSessionScope("alpha-session"), "project:alpha");
    assert.equal((await sessions.snapshotSessionStorage()).schema_version, 2);
    sessions.closeSessionStorage();
    return;
  }

  if (mode === "lifecycle-read") {
    const alphaMeta = await sessions.getSessionMeta("alpha-session");
    assert(alphaMeta, "alpha metadata must survive a process restart");
    assert.equal(alphaMeta.scope, "project:alpha");
    assert.equal(alphaMeta.end_reason, "completed");
    assert.equal(await sessions.resolveSessionScope("alpha-session"), "project:alpha");
    sessions.closeSessionStorage();
    return;
  }

  if (mode === "snapshot-v1") {
    const fixture = {
      schema_version: 1,
      sessions: [{
        session_id: "snapshot-v1-session",
        started_at: "2026-08-01T03:00:00.000Z",
        turn_count: 1,
        last_turn_at: "2026-08-01T03:01:00.000Z",
      }],
      turns: [{
        session_id: "snapshot-v1-session",
        turn_index: 0,
        role: "user",
        content: "v1 fixture",
        timestamp: "2026-08-01T03:01:00.000Z",
      }],
    };
    const migrated = sessions.validateSessionStorageSnapshot(fixture);
    assert.equal(migrated.schema_version, 2);
    assert.equal(migrated.sessions[0].scope, "legacy-unscoped");
    assert.equal(await sessions.replaceSessionStorageSnapshot(fixture), true);
    const snapshot = await sessions.snapshotSessionStorage();
    assert.equal(snapshot.schema_version, 2);
    assert.equal(snapshot.sessions[0].scope, "legacy-unscoped");
    assert.equal((await sessions.getSessionMeta("snapshot-v1-session")).scope, "legacy-unscoped");
    sessions.closeSessionStorage();
    return;
  }

  if (mode === "snapshot-v2-write") {
    const fixture = {
      schema_version: 2,
      sessions: [{
        session_id: "snapshot-v2-project",
        started_at: "2026-08-01T04:00:00.000Z",
        turn_count: 0,
        scope: "project:roundtrip",
        parent_session_id: "parent-roundtrip",
        start_event_id: "start-roundtrip",
        end_reason: "compacted",
        ended_at: "2026-08-01T04:10:00.000Z",
        updated_at: "2026-08-01T04:10:00.000Z",
        compaction_generation: 3,
        last_compaction_receipt: roundtripCompactionReceipt,
      }],
      turns: [],
    };
    assert.deepEqual(sessions.validateSessionStorageSnapshot(fixture), fixture);
    assert.equal(await sessions.replaceSessionStorageSnapshot(fixture), true);
    assert.deepEqual(await sessions.snapshotSessionStorage(), fixture);
    sessions.closeSessionStorage();
    return;
  }

  if (mode === "snapshot-v2-read") {
    const meta = await sessions.getSessionMeta("snapshot-v2-project");
    assert.deepEqual(meta, {
      session_id: "snapshot-v2-project",
      started_at: "2026-08-01T04:00:00.000Z",
      turn_count: 0,
      scope: "project:roundtrip",
      parent_session_id: "parent-roundtrip",
      start_event_id: "start-roundtrip",
      end_reason: "compacted",
      ended_at: "2026-08-01T04:10:00.000Z",
      updated_at: "2026-08-01T04:10:00.000Z",
      compaction_generation: 3,
      last_compaction_receipt: roundtripCompactionReceipt,
    });
    sessions.closeSessionStorage();
    return;
  }

  throw new Error(`unknown child mode: ${mode}`);
}

function structured(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.ok(result.structuredContent && typeof result.structuredContent === "object", JSON.stringify(result));
  return result.structuredContent;
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

async function createEndedReviewSession(client, { sessionId, projectKey, lesson }) {
  structured(await call(client, "session_lifecycle_hook", {
    event: "start",
    session_id: sessionId,
    ...(projectKey ? { project_key: projectKey } : {}),
  }));
  structured(await call(client, "reflect_on_task", {
    session_id: sessionId,
    task_goal: `Verify persisted review scope for ${sessionId}`,
    task_outcome: "success",
    failure_mode: "success",
    summary: lesson,
    lessons_learned: [lesson],
    auto_extract_heuristics: false,
    ...(projectKey ? { project_key: projectKey } : {}),
  }));
  structured(await call(client, "session_lifecycle_hook", {
    event: "end",
    session_id: sessionId,
    ...(projectKey ? { project_key: projectKey } : {}),
  }));
}

async function runEndedSessionReview(client, sessionId, projectKey) {
  return structured(await call(client, "trigger_background_review", {
    action: "run",
    session_id: sessionId,
    review_scope: "full",
    review_mode: "deterministic",
    auto_apply: false,
    response_mode: "full",
    ...(projectKey ? { project_key: projectKey } : {}),
  }));
}

async function expectMcpScopeError(client, name, args, code) {
  const result = await call(client, name, args);
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(JSON.stringify(result), new RegExp(code));
}

async function persistedReviewScopeTest(home) {
  const mcp = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    structured(await call(mcp.client, "reflect_on_task", {
      session_id: "review-global-without-lifecycle",
      task_goal: "Preserve global review compatibility",
      task_outcome: "success",
      failure_mode: "success",
      summary: "GLOBAL_NO_LIFECYCLE: existing global sessions remain reviewable.",
      lessons_learned: ["GLOBAL_NO_LIFECYCLE: existing global sessions remain reviewable."],
      auto_extract_heuristics: false,
    }));
    assert.match(
      JSON.stringify(await runEndedSessionReview(mcp.client, "review-global-without-lifecycle")),
      /GLOBAL_NO_LIFECYCLE/,
      "global sessions without lifecycle metadata lost manual review compatibility",
    );
    const fixtures = [
      { sessionId: "review-global", lesson: "GLOBAL_ONLY_LESSON: preserve global review evidence." },
      { sessionId: "review-alpha", projectKey: "alpha", lesson: "ALPHA_ONLY_LESSON: preserve alpha review evidence." },
      { sessionId: "review-beta", projectKey: "beta", lesson: "BETA_ONLY_LESSON: preserve beta review evidence." },
    ];
    for (const fixture of fixtures) await createEndedReviewSession(mcp.client, fixture);
    await expectMcpScopeError(mcp.client, "trigger_background_review", {
      action: "run", session_id: "review-alpha", review_scope: "full",
      review_mode: "deterministic", auto_apply: false, response_mode: "full",
    }, "SCOPE_REQUIRED");
    await expectMcpScopeError(mcp.client, "trigger_background_review", {
      action: "run", session_id: "review-alpha", project_key: "beta", review_scope: "full",
      review_mode: "deterministic", auto_apply: false, response_mode: "full",
    }, "SCOPE_MISMATCH");
    for (const fixture of fixtures) {
      const review = await runEndedSessionReview(mcp.client, fixture.sessionId, fixture.projectKey);
      const serialized = JSON.stringify(review);
      assert.match(serialized, new RegExp(fixture.lesson.split(":", 1)[0]));
      for (const foreign of fixtures.filter((item) => item !== fixture)) {
        assert.doesNotMatch(serialized, new RegExp(foreign.lesson.split(":", 1)[0]));
      }
    }

    const alphaStatus = structured(await call(mcp.client, "trigger_background_review", {
      action: "status",
      session_id: "review-alpha",
      project_key: "alpha",
      response_mode: "full",
    }));
    assert.deepEqual(alphaStatus.review_queue, {
      pending: 1,
      applied: 0,
      rejected: 0,
      admin_hint: "Use list_pending_mutations, then approve_pending_mutation to approve or reject candidates.",
    }, "status after lifecycle release must count only the persisted alpha scope");
    assert.deepEqual(
      alphaStatus.background_lifecycle.durable.recent_runs.map((item) => item.session_id),
      ["review-alpha"],
      "session-authorized status leaked durable runs from another scope",
    );

    const alphaProjectStatus = structured(await call(mcp.client, "trigger_background_review", {
      action: "status",
      project_key: "alpha",
      response_mode: "full",
    }));
    assert.equal(alphaProjectStatus.review_queue.pending, 1,
      "project-only status ignored its explicit project_key");
    assert.deepEqual(
      alphaProjectStatus.background_lifecycle.durable.recent_runs.map((item) => item.session_id),
      ["review-alpha"],
      "project-only status leaked durable runs from another scope",
    );

    const globalStatus = structured(await call(mcp.client, "trigger_background_review", {
      action: "status",
      response_mode: "full",
    }));
    assert.equal(globalStatus.review_queue.pending, 2,
      "status without session_id or project_key must be limited to global scope");
    assert.deepEqual(
      globalStatus.background_lifecycle.durable.recent_runs.map((item) => item.session_id).sort(),
      ["review-global", "review-global-without-lifecycle"],
      "global status leaked durable runs from a project scope",
    );
  } finally {
    await mcp.close();
  }
}

async function main() {
  if (process.argv[2] === "--persisted-review") {
    await withTempHome("persisted-review-scope", persistedReviewScopeTest);
    return;
  }
  if (process.argv[2] === "--background-persisted") {
    await withTempHome("background-persisted-scope", (home) => runChild(home, "background-persisted-scope"));
    return;
  }
  if (process.argv[2] === "--baseline") {
    if (!process.env.HERMES_V20_BASELINE_ROOT) {
      console.log(
        "SKIP v20 baseline: set HERMES_V20_BASELINE_ROOT to a verified v20 installation root, then rerun with --baseline.",
      );
      return;
    }
    await withTempHome("baseline", async (home) => {
      await seedV20Database(home);
      await runChild(home, "baseline-v20");
    });
    return;
  }
  await withTempHome("legacy", async (home) => {
    await seedV20Database(home);
    const first = await runChild(home, "legacy");
    const second = await runChild(home, "legacy");
    assert.equal(second, first, "idempotent migration must preserve PRAGMA columns and legacy metadata");
  });
  await withTempHome("platform-case", (home) => runChild(home, "platform-case"));
  await withTempHome("lifecycle", async (home) => {
    await runChild(home, "lifecycle-write");
    await runChild(home, "lifecycle-read");
  });
  await withTempHome("snapshot", (home) => runChild(home, "snapshot-v1"));
  await withTempHome("snapshot-v2", async (home) => {
    await runChild(home, "snapshot-v2-write");
    await runChild(home, "snapshot-v2-read");
  });
  await withTempHome("persisted-review-scope", persistedReviewScopeTest);
  await withTempHome("background-persisted-scope", (home) => runChild(home, "background-persisted-scope"));
  console.log("v21 session scope tests passed");
}

if (process.argv[2] === "--child") {
  await childMain(process.argv[3]);
} else {
  await main();
}
