import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function text(result) {
  return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

async function connect(name, home) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name} failed:\n${text(result)}`);
  return result;
}

async function runDirectCacheAndSessionRegressions() {
  const home = await mkdtemp(join(tmpdir(), "hermes-regression-direct-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  try {
    const blockedHome = join(home, "home-is-a-file");
    await writeFile(blockedHome, "blocks creation of the storage directory", "utf8");
    const enhancedUrl = new URL("../dist/src/storage_enhanced.js", import.meta.url).href;
    const snapshotUrl = new URL("../dist/src/memory_snapshot.js", import.meta.url).href;
    const failureProbe = `
      const enhanced = await import(${JSON.stringify(enhancedUrl)});
      const snapshots = await import(${JSON.stringify(snapshotUrl)});
      let failed = false;
      try {
        await enhanced.captureSessionSnapshot("failed-capture");
      } catch {
        failed = true;
      }
      if (!failed) throw new Error("capture unexpectedly succeeded");
      if (snapshots.isCapturePending("failed-capture")) {
        throw new Error("failed capture left pending lifecycle state");
      }
    `;
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", failureProbe], {
      env: { ...process.env, HOME: blockedHome, USERPROFILE: blockedHome },
    });

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const parent = await import(`../dist/storage.js?cache-parent=${Date.now()}`);
    const child = await import(`../dist/storage.js?cache-child=${Date.now()}`);
    const saved = await parent.upsertHeuristic({
      domain: "regression",
      heuristic: "same-size cache invalidation probe",
      source_task: "regression",
      confidence: 0.6,
      tags: [],
    });
    await parent.listHeuristics({ domain: "regression" });
    await child.contradictHeuristic(saved.id);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const refreshed = await parent.listHeuristics({ domain: "regression" });
    assert(refreshed[0]?.contradiction_count === 1, "store cache must refresh after a same-size external mutation");

    const sessions = await import(`../dist/session_storage.js?timestamp-order=${Date.now()}`);
    const newest = "2026-07-20T12:00:00.000Z";
    const oldest = "2020-01-01T00:00:00.000Z";
    await sessions.appendSessionTurn("timestamp-order", "user", "newest timestamp", newest);
    await sessions.appendSessionTurn("timestamp-order", "assistant", "oldest timestamp", oldest);
    const metas = await sessions.listRecentSessions(10);
    const meta = metas?.find((item) => item.session_id === "timestamp-order");
    assert(meta?.started_at === oldest, "session started_at must retain the earliest turn timestamp");
    assert(meta?.last_turn_at === newest, "session last_turn_at must retain the latest turn timestamp");
    sessions.closeSessionStorage();

    const snapshots = await import(`../dist/src/memory_snapshot.js?snapshot-race=${Date.now()}`);
    const emptyBoard = { entries: [], char_limit: 2200, used_chars: 0 };
    snapshots.clearAllSnapshots();
    snapshots.markPendingCapture("clear-pending");
    snapshots.clearAllSnapshots();
    assert(
      snapshots.isCapturePending("clear-pending") === false,
      "clearAllSnapshots must also clear pending lifecycle state",
    );
    snapshots.markPendingCapture("concurrent-capture");
    snapshots.markPendingCapture("concurrent-capture");
    snapshots.releaseMemorySnapshot("concurrent-capture");
    snapshots.captureMemorySnapshot("concurrent-capture", emptyBoard, emptyBoard);
    snapshots.captureMemorySnapshot("concurrent-capture", emptyBoard, emptyBoard);
    assert(
      snapshots.getMemorySnapshot("concurrent-capture") === null,
      "an end event during concurrent captures must prevent every late capture from reviving the snapshot",
    );
    snapshots.clearAllSnapshots();

    const compaction = await import(`../dist/src/compaction_handoff.js?recent-order=${Date.now()}`);
    const newestFirstReflections = Array.from({ length: 10 }, (_, index) => ({
      id: `compact-${index}`,
      timestamp: new Date(Date.now() - index * 1000).toISOString(),
      session_id: "compact-order",
      task_goal: `completed-${index}`,
      task_outcome: "success",
      failure_mode: "success",
      task_state: {
        summary: `summary-${index}`,
        immediate_blockers: [],
        active_hypotheses: [],
        proven_safe_paths: [],
        exhausted_search: [],
      },
      world_model_updates: [],
      tool_insights: [],
      context_forget: [],
      open_questions: [],
      lessons_learned: [`lesson-${index}`],
      affordance_gaps: [],
      domain: "regression",
      tags: [],
    }));
    const handoff = compaction.buildCompactionHandoff([], newestFirstReflections, 20, 6000).handoff;
    assert(handoff.includes("completed-0"), "compaction must retain the newest completed reflection when bounded");
    assert(!handoff.includes("completed-9"), "compaction must discard the oldest completed reflection first when bounded");
  } finally {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    await rm(home, { recursive: true, force: true });
  }
}

async function runInputAndMemoryRegressions() {
  const home = await mkdtemp(join(tmpdir(), "hermes-regression-input-"));
  const outsideHome = await mkdtemp(join(tmpdir(), "hermes-regression-outside-"));
  const peer = await connect("regression-input", home);
  try {
    const now = new Date().toISOString();
    const malformedPath = join(home, "malformed-import.json");
    await writeFile(malformedPath, JSON.stringify({
      reflections: [{
        id: "malformed-sections", timestamp: "not-a-date", session_id: "regression",
        task_goal: "malformed summary section", task_outcome: "success", failure_mode: "success",
        task_state: { summary: "safe", summary_sections: [null] },
        open_questions: [{
          question: "Malformed resolution date",
          priority: "medium",
          requires_environment_interaction: false,
          resolved: true,
          resolved_at: "not-a-date",
        }],
      }, {
        id: "malformed-sections", timestamp: now, session_id: "regression",
        task_goal: "duplicate reflection id", task_outcome: "success", failure_mode: "success",
        task_state: { summary: "duplicate" },
      }],
      heuristics: [{
        id: "malformed-dates-heuristic",
        created_at: "not-a-date",
        updated_at: "still-not-a-date",
        domain: "regression",
        heuristic: "Malformed imported dates must be normalized",
        source_task: "regression",
        reinforcement_count: -4,
        contradiction_count: -3,
        retrieval_count: -2,
        version: 0,
      }, {
        id: "malformed-dates-heuristic",
        domain: "regression",
        heuristic: "Duplicate heuristic id",
        source_task: "regression",
      }],
      affordance_gaps: [{
        id: "malformed-gap-date",
        timestamp: "not-a-date",
        session_id: "regression",
        goal_description: "normalize import dates",
        failure_description: "invalid date",
        missing_capability: "date normalization",
        available_tools: [],
        occurrence_count: 1,
        resolved: true,
        resolved_at: "not-a-date",
      }],
      sessions: {
        regression: {
          id: "wrong-imported-session-id",
          started_at: "not-a-date",
          reflection_count: 1,
          affordance_gap_count: 1,
        },
      },
      memory_board: { entries: [
        { id: "replace-duplicate-board", content: "first replace board", created_at: "not-a-date", updated_at: "not-a-date" },
        { id: "replace-duplicate-board", content: "second replace board", created_at: now, updated_at: now },
      ], char_limit: 2200, used_chars: 0 },
      user_profile: { entries: [
        { id: "replace-duplicate-profile", content: "first replace profile", created_at: "not-a-date", updated_at: "not-a-date" },
        { id: "replace-duplicate-profile", content: "second replace profile", created_at: now, updated_at: now },
      ], char_limit: 1800, used_chars: 0 },
    }), "utf8");
    await call(peer.client, "import_data", { input_path: malformedPath, mode: "replace" });
    await call(peer.client, "list_reflections", { limit: 10 });
    const normalizedDates = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" })));
    assert(
      Number.isFinite(Date.parse(normalizedDates.reflections[0].timestamp)),
      "imported reflection timestamps must be valid ISO dates after normalization",
    );
    assert(
      Number.isFinite(Date.parse(normalizedDates.heuristics[0].created_at))
        && Number.isFinite(Date.parse(normalizedDates.heuristics[0].updated_at)),
      "imported heuristic timestamps must be valid ISO dates after normalization",
    );
    assert(
      normalizedDates.heuristics[0].reinforcement_count === 1
        && normalizedDates.heuristics[0].contradiction_count === 0
        && normalizedDates.heuristics[0].retrieval_count === 0
        && normalizedDates.heuristics[0].version === 1,
      "imported heuristic counters and versions must be normalized to valid non-negative values",
    );
    assert(
      Number.isFinite(Date.parse(normalizedDates.reflections[0].open_questions[0].resolved_at)),
      "imported open-question resolution timestamps must be valid ISO dates after normalization",
    );
    assert(
      Number.isFinite(Date.parse(normalizedDates.affordance_gaps[0].timestamp))
        && Number.isFinite(Date.parse(normalizedDates.affordance_gaps[0].resolved_at)),
      "imported affordance-gap timestamps must be valid ISO dates after normalization",
    );
    assert(
      Number.isFinite(Date.parse(normalizedDates.sessions.regression.started_at)),
      "imported session timestamps must be valid ISO dates after normalization",
    );
    assert(
      Number.isFinite(Date.parse(normalizedDates.memory_board.entries[0].created_at))
        && Number.isFinite(Date.parse(normalizedDates.memory_board.entries[0].updated_at))
        && Number.isFinite(Date.parse(normalizedDates.user_profile.entries[0].created_at))
        && Number.isFinite(Date.parse(normalizedDates.user_profile.entries[0].updated_at)),
      "imported memory timestamps must be valid ISO dates after normalization",
    );
    assert(normalizedDates.reflections.length === 1, "replace import must deduplicate reflection ids");
    assert(normalizedDates.heuristics.length === 1, "replace import must deduplicate heuristic ids");
    assert(normalizedDates.memory_board.entries.length === 1, "replace import must deduplicate Memory Board ids");
    assert(normalizedDates.user_profile.entries.length === 1, "replace import must deduplicate User Profile ids");

    const partialImportPath = join(home, "partial-session-import.json");
    await writeFile(partialImportPath, JSON.stringify({
      reflections: [{
        id: "partial-session-reflection",
        timestamp: now,
        session_id: "partial-session",
        task_goal: "partial import session reconciliation",
        task_outcome: "success",
        failure_mode: "success",
        task_state: { summary: "session metadata omitted intentionally" },
      }],
      affordance_gaps: [{
        id: "partial-session-gap",
        timestamp: now,
        session_id: "partial-session",
        goal_description: "partial import session reconciliation",
        failure_description: "session metadata omitted",
        missing_capability: "session reconciliation",
        available_tools: [],
        occurrence_count: 1,
      }],
    }), "utf8");
    await call(peer.client, "import_data", { input_path: partialImportPath, mode: "merge" });
    const afterPartialImport = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" })));
    assert(
      afterPartialImport.sessions["partial-session"]?.reflection_count === 1,
      "partial reflection imports must create and count their session",
    );
    assert(
      afterPartialImport.sessions["partial-session"]?.affordance_gap_count === 1,
      "partial affordance-gap imports must create and count their session",
    );

    await call(peer.client, "reflect_on_task", {
      session_id: "__proto__",
      task_goal: "prototype-safe session id",
      task_outcome: "success",
      failure_mode: "success",
      summary: "Special object keys must be stored as ordinary session identifiers.",
      auto_extract_heuristics: false,
    });
    const afterSpecialSession = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" })));
    assert(
      Object.hasOwn(afterSpecialSession.sessions, "__proto__")
        && afterSpecialSession.sessions["__proto__"].reflection_count === 1,
      "special object-property names must be persisted as own session ids without prototype pollution",
    );

    const futureSearchPath = join(home, "future-search-import.json");
    await writeFile(futureSearchPath, JSON.stringify({
      reflections: [{
        id: "normal-search-time",
        timestamp: now,
        session_id: "future-search",
        task_goal: "temporal ranking normal",
        task_outcome: "success",
        failure_mode: "success",
        task_state: { summary: "unique temporal weighting probe" },
      }, {
        id: "future-search-time",
        timestamp: "9999-12-31T23:59:59.999Z",
        session_id: "future-search",
        task_goal: "temporal ranking future",
        task_outcome: "success",
        failure_mode: "success",
        task_state: { summary: "unique temporal weighting probe" },
      }],
    }), "utf8");
    await call(peer.client, "import_data", { input_path: futureSearchPath, mode: "merge" });
    const temporalSearch = text(await call(peer.client, "search_reflections", {
      query: "unique temporal weighting probe",
      limit: 1,
    }));
    assert(
      temporalSearch.includes("temporal ranking normal"),
      "future reflection timestamps must not receive an unbounded recency boost",
    );

    const duplicatePath = join(home, "duplicate-memory-import.json");
    await writeFile(duplicatePath, JSON.stringify({
      memory_board: { entries: [
        { id: "duplicate-board", content: "first board", created_at: now, updated_at: now },
        { id: "duplicate-board", content: "second board", created_at: now, updated_at: now },
      ], char_limit: 2200, used_chars: 0 },
      user_profile: { entries: [
        { id: "duplicate-profile", content: "first profile", created_at: now, updated_at: now },
        { id: "duplicate-profile", content: "second profile", created_at: now, updated_at: now },
      ], char_limit: 1800, used_chars: 0 },
    }), "utf8");
    await call(peer.client, "import_data", { input_path: duplicatePath, mode: "merge" });
    const exported = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" })));
    assert(exported.memory_board.entries.filter((entry) => entry.id === "duplicate-board").length === 1, "memory board import must reject duplicate ids within one payload");
    assert(exported.user_profile.entries.filter((entry) => entry.id === "duplicate-profile").length === 1, "user profile import must reject duplicate ids within one payload");

    await call(peer.client, "memory_board_write", { action: "add", content: "replace duplicate source" });
    await call(peer.client, "memory_board_write", { action: "add", content: "replace duplicate target" });
    await call(peer.client, "memory_board_write", {
      action: "replace", old_text: "replace duplicate target", content: "replace duplicate source",
    });
    const board = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" }))).memory_board.entries;
    assert(board.filter((entry) => entry.content === "replace duplicate source").length === 1, "single memory-board replace must not create duplicate content");

    await call(peer.client, "add_heuristic", {
      domain: "review-count",
      heuristic: "Always validate cache invalidation after cross process writes",
      source_task: "review-count-existing",
      confidence: 0.7,
    });
    await call(peer.client, "reflect_on_task", {
      session_id: "review-count",
      task_goal: "background review dedup count",
      task_outcome: "success",
      failure_mode: "success",
      domain: "review-count",
      summary: "Seed a semantically duplicate background review candidate.",
      lessons_learned: ["Validate cache invalidation after cross process writes"],
      auto_extract_heuristics: false,
    });
    const review = JSON.parse(text(await call(peer.client, "trigger_background_review", {
      session_id: "review-count",
      review_scope: "recent",
      auto_apply: true,
    })));
    assert(
      review.applied.heuristics_added === 0,
      "background review must not report a reinforced existing heuristic as newly added",
    );

    const blankHeuristic = await peer.client.callTool({
      name: "add_heuristic",
      arguments: { domain: "blank-lesson", heuristic: "   ", source_task: "   " },
    });
    assert(blankHeuristic.isError === true, "add_heuristic must reject blank heuristic/source text");
    const blankTaskGoal = await peer.client.callTool({
      name: "reflect_on_task",
      arguments: {
        session_id: "blank-input",
        task_goal: "   ",
        task_outcome: "success",
        failure_mode: "success",
        summary: "blank task goal",
        dry_run: true,
      },
    });
    assert(blankTaskGoal.isError === true, "reflect_on_task must reject whitespace-only task goals");
    const blankSessionId = await peer.client.callTool({
      name: "reflect_on_task",
      arguments: {
        session_id: "   ",
        task_goal: "blank session id",
        task_outcome: "success",
        failure_mode: "success",
        summary: "blank session id",
        dry_run: true,
      },
    });
    assert(blankSessionId.isError === true, "reflect_on_task must reject whitespace-only session ids");
    const blankCapability = await peer.client.callTool({
      name: "reflect_on_task",
      arguments: {
        session_id: "blank-input",
        task_goal: "blank missing capability",
        task_outcome: "failure",
        failure_mode: "missing_affordance",
        summary: "blank missing capability",
        missing_capability: "   ",
        dry_run: true,
      },
    });
    assert(blankCapability.isError === true, "missing_affordance reflections must reject blank missing_capability");
    await call(peer.client, "reflect_on_task", {
      session_id: "blank-lesson",
      task_goal: "blank lesson filtering",
      task_outcome: "success",
      failure_mode: "success",
      domain: "blank-lesson",
      summary: "Blank lessons should not become heuristics.",
      lessons_learned: ["   "],
    });
    const afterBlankLesson = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" })));
    assert(
      afterBlankLesson.heuristics.filter((item) => item.domain === "blank-lesson").length === 0,
      "reflect_on_task must not persist blank lessons as heuristics",
    );

    await call(peer.client, "add_heuristic", {
      domain: "order-independent-dedup",
      heuristic: "Validate cache invalidation",
      source_task: "short-first",
    });
    await call(peer.client, "add_heuristic", {
      domain: "order-independent-dedup",
      heuristic: "Validate cache invalidation after cross process writes",
      source_task: "long-second",
    });
    const afterOrderDedup = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" })));
    assert(
      afterOrderDedup.heuristics.filter((item) => item.domain === "order-independent-dedup").length === 1,
      "heuristic deduplication must not depend on whether the short or long wording was stored first",
    );

    const escapeLink = join(home, "escape-link");
    const escapedExport = join(escapeLink, "escaped-export.json");
    await symlink(outsideHome, escapeLink, "junction");
    const escapedResult = await peer.client.callTool({
      name: "export_data",
      arguments: { collection: "all", output_path: escapedExport },
    });
    assert(escapedResult.isError === true, "export_data must reject a junction that escapes the allowed directory");
    let outsideFileExists = true;
    try {
      await readFile(join(outsideHome, "escaped-export.json"), "utf8");
    } catch {
      outsideFileExists = false;
    }
    assert(outsideFileExists === false, "rejected export must not write through an escaping junction");
  } finally {
    await peer.client.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(outsideHome, { recursive: true, force: true });
  }
}

async function runApprovalAndClearRegressions() {
  const home = await mkdtemp(join(tmpdir(), "hermes-regression-approval-"));
  const storeDir = join(home, ".hermes-reflection");
  let peer;
  try {
    const now = new Date().toISOString();
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, "store.json"), JSON.stringify({
      sessions: {}, reflections: [], affordance_gaps: [], heuristics: [], version: "19.3.0",
      memory_board: { entries: [], char_limit: 2200, used_chars: 0 },
      user_profile: { entries: [], char_limit: 1800, used_chars: 0 },
      metadata: {
        created_at: "not-a-date",
        last_written_at: "not-a-date",
        write_count: -1,
        write_approval: true,
        pending_mutations: { malformed: true },
      },
    }), "utf8");
    peer = await connect("regression-approval", home);

    const queued = await peer.client.callTool({ name: "reflect_on_task", arguments: {
      session_id: "approval", task_goal: "exactly once approval", task_outcome: "success", failure_mode: "success",
      summary: "approval concurrency", auto_extract_heuristics: false,
    } });
    assert(queued.isError === true, "write approval must queue reflection");
    const pending = JSON.parse(text(await call(peer.client, "list_pending_mutations"))).pending;
    assert(pending.length === 1, "expected one queued reflection");
    const results = await Promise.all([
      peer.client.callTool({ name: "approve_pending_mutation", arguments: { mutation_id: pending[0].id, decision: "approve" } }),
      peer.client.callTool({ name: "approve_pending_mutation", arguments: { mutation_id: pending[0].id, decision: "approve" } }),
    ]);
    assert(results.filter((result) => !result.isError).length === 1, "concurrent approvals must execute exactly once");
    const afterApproval = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" })));
    assert(afterApproval.reflections.filter((reflection) => reflection.task_goal === "exactly once approval").length === 1, "concurrent approvals must persist one reflection");

    await call(peer.client, "append_session_turn", { session_id: "clear-approved", role: "user", content: "must disappear" });
    const clearQueued = await peer.client.callTool({ name: "clear_data", arguments: { collection: "all", confirm: true } });
    assert(clearQueued.isError === true, "clear_data must queue while approval is enabled");
    const clearPending = JSON.parse(text(await call(peer.client, "list_pending_mutations"))).pending;
    await call(peer.client, "approve_pending_mutation", { mutation_id: clearPending[0].id, decision: "approve" });
    assert(text(await call(peer.client, "search_sessions", { query: "must disappear", limit: 10 })).includes("No session turns matched"), "approved clear_data(all) must also clear SQLite sessions");
  } finally {
    await peer?.client.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

async function runResolvedQuestionsCrossProcessRegression() {
  const home = await mkdtemp(join(tmpdir(), "hermes-regression-resolved-"));
  const peers = [];
  try {
    for (let index = 0; index < 6; index++) peers.push(await connect(`resolved-${index}`, home));
    for (let index = 0; index < peers.length; index++) {
      await call(peers[index].client, "reflect_on_task", {
        session_id: `resolved-${index}`, task_goal: `resolve-${index}`, task_outcome: "success", failure_mode: "success",
        summary: "cross process resolved question", auto_extract_heuristics: false,
        open_questions: [{ question: `question-${index}`, priority: "low", requires_environment_interaction: false }],
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 550));
    const exported = JSON.parse(text(await call(peers[0].client, "export_data", { collection: "all" })));
    const reflections = exported.reflections.filter((reflection) => reflection.task_goal.startsWith("resolve-"));
    await Promise.all(reflections.map((reflection) => {
      const index = Number(reflection.session_id.replace("resolved-", ""));
      return call(peers[index].client, "resolve_open_question", {
        reflection_id: reflection.id, question_index: 0,
      });
    }));
    await Promise.all(peers.map(({ client }) => client.close()));
    peers.length = 0;
    const verifier = await connect("resolved-verifier", home);
    peers.push(verifier);
    const verified = JSON.parse(text(await call(verifier.client, "export_data", { collection: "all" })));
    const unresolved = verified.reflections
      .filter((reflection) => reflection.task_goal.startsWith("resolve-"))
      .filter((reflection) => !reflection.open_questions[0]?.resolved);
    const rawResolved = JSON.parse(await readFile(join(home, ".hermes-reflection", "resolved_questions.json"), "utf8"));
    assert(unresolved.length === 0, `cross-process resolved_questions writes must preserve every update (unresolved: ${unresolved.map((item) => item.task_goal).join(", ")}; raw keys: ${Object.keys(rawResolved).length})`);
  } finally {
    await Promise.all(peers.map(({ client }) => client.close().catch(() => undefined)));
    await rm(home, { recursive: true, force: true });
  }
}

async function runMalformedResolvedIndexRegression() {
  const home = await mkdtemp(join(tmpdir(), "hermes-regression-resolved-shape-"));
  const storeDir = join(home, ".hermes-reflection");
  let peer;
  try {
    await mkdir(storeDir, { recursive: true });
    const resolvedPath = join(storeDir, "resolved_questions.json");
    await writeFile(resolvedPath, "[]", "utf8");
    peer = await connect("resolved-shape-writer", home);
    await call(peer.client, "reflect_on_task", {
      session_id: "resolved-shape",
      task_goal: "persist resolution across restart",
      task_outcome: "success",
      failure_mode: "success",
      summary: "A malformed but valid JSON overlay must block derived reads and writes.",
      auto_extract_heuristics: false,
      open_questions: [{
        question: "Will this resolution survive restart?",
        priority: "high",
        requires_environment_interaction: false,
      }],
    });
    const first = await peer.client.callTool({ name: "export_data", arguments: { collection: "all" } });
    assert(
      first.isError === true && /Refusing to continue/.test(text(first)),
      "a malformed resolved-question overlay must fail closed instead of being normalized to empty",
    );
    assert(await readFile(resolvedPath, "utf8") === "[]", "fail-closed overlay handling must preserve exact active bytes");
    const second = await peer.client.callTool({ name: "export_data", arguments: { collection: "all" } });
    assert(second.isError === true, "repeated malformed-overlay reads must keep failing closed");
    const backups = (await readdir(storeDir)).filter((name) => /^resolved_questions\.json\.corrupt\.[a-f0-9]{16}\.bak$/.test(name));
    assert(backups.length === 1, `malformed overlay must create one idempotent evidence backup, found ${backups.length}`);
  } finally {
    await peer?.client.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

async function runDuplicateJsonlRecoveryRegression() {
  const home = await mkdtemp(join(tmpdir(), "hermes-regression-jsonl-recovery-"));
  const storeDir = join(home, ".hermes-reflection");
  let peer;
  try {
    const now = new Date().toISOString();
    const reflection = {
      id: "duplicate-jsonl-id",
      timestamp: now,
      session_id: "jsonl-recovery",
      task_goal: "recover duplicate jsonl rows",
      task_outcome: "success",
      failure_mode: "success",
      task_state: {
        summary: "same immutable reflection was appended twice",
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
      domain: "regression",
      tags: [],
    };
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, "store.json"), JSON.stringify({
      sessions: {
        "jsonl-recovery": {
          id: "jsonl-recovery",
          started_at: now,
          reflection_count: 99,
          affordance_gap_count: 0,
        },
      },
      affordance_gaps: [],
      heuristics: [],
      version: "19.3.0",
      memory_board: { entries: [], char_limit: 2200, used_chars: 0 },
      user_profile: { entries: [], char_limit: 1800, used_chars: 0 },
      metadata: { created_at: now, last_written_at: now, write_count: 0, pending_mutations: [] },
    }), "utf8");
    await writeFile(
      join(storeDir, "reflections.jsonl"),
      `${JSON.stringify(reflection)}\n${JSON.stringify(reflection)}\n`,
      "utf8",
    );
    peer = await connect("jsonl-recovery", home);
    const recovered = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" })));
    assert(recovered.reflections.length === 1, "duplicate reflection ids in JSONL must be deduplicated during recovery");
    assert(
      recovered.sessions["jsonl-recovery"]?.reflection_count === 1,
      "session counters must be rebuilt from recovered reflection records",
    );
  } finally {
    await peer?.client.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

async function runClearedSessionsStayClearedRegression() {
  const home = await mkdtemp(join(tmpdir(), "hermes-regression-session-clear-"));
  let peer;
  try {
    peer = await connect("session-clear-writer", home);
    await call(peer.client, "reflect_on_task", {
      session_id: "must-stay-cleared",
      task_goal: "clear session metadata without deleting reflections",
      task_outcome: "success",
      failure_mode: "success",
      summary: "Session metadata should remain cleared after restart.",
      auto_extract_heuristics: false,
    });
    await call(peer.client, "clear_data", { collection: "sessions", confirm: true });
    await peer.client.close();
    peer = await connect("session-clear-reader", home);
    const afterRestart = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" })));
    assert(Object.keys(afterRestart.sessions).length === 0, "cleared session metadata must not be recreated after restart");
    assert(afterRestart.reflections.length === 1, "clearing sessions must continue to preserve reflections");
  } finally {
    await peer?.client.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

async function runMalformedCollectionIsolationRegression() {
  const home = await mkdtemp(join(tmpdir(), "hermes-regression-collection-shape-"));
  const storeDir = join(home, ".hermes-reflection");
  let peer;
  try {
    const now = new Date().toISOString();
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, "store.json"), JSON.stringify({
      sessions: {},
      affordance_gaps: { malformed: true },
      heuristics: [{
        id: "valid-neighbor-heuristic",
        created_at: now,
        updated_at: now,
        domain: "regression",
        heuristic: "Preserve valid collections when a neighboring collection has the wrong JSON shape",
        source_task: "malformed collection isolation",
        reinforcement_count: 1,
        contradiction_count: 0,
        contradiction_notes: [],
        confidence: 0.7,
        retrieval_count: 0,
        supersedes: [],
        version: 1,
        tags: [],
      }],
      version: "19.3.0",
      memory_board: { entries: [], char_limit: 2200, used_chars: 0 },
      user_profile: { entries: [], char_limit: 1800, used_chars: 0 },
      metadata: { created_at: now, last_written_at: now, write_count: 0, pending_mutations: [] },
    }), "utf8");
    peer = await connect("collection-shape", home);
    const recovered = JSON.parse(text(await call(peer.client, "export_data", { collection: "all" })));
    assert(recovered.affordance_gaps.length === 0, "malformed collection shapes must normalize to an empty collection");
    assert(
      recovered.heuristics.some((item) => item.id === "valid-neighbor-heuristic"),
      "one malformed collection must not discard valid neighboring collections",
    );
  } finally {
    await peer?.client.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

await runDirectCacheAndSessionRegressions();
await runInputAndMemoryRegressions();
await runApprovalAndClearRegressions();
await runResolvedQuestionsCrossProcessRegression();
await runMalformedResolvedIndexRegression();
await runDuplicateJsonlRecoveryRegression();
await runClearedSessionsStayClearedRegression();
await runMalformedCollectionIsolationRegression();
console.log("Hermes regression test passed.");
