import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const ownedRoot = await mkdtemp(join(tmpdir(), "hermes-v21.1-lifecycle-"));
const home = join(ownedRoot, "profile");
const project = join(ownedRoot, "Project With Spaces", "工程");
const failures = [];

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertOwned(path) {
  const suffix = relative(resolve(ownedRoot), resolve(path));
  assert.equal(isAbsolute(suffix), false, `path escaped owned root: ${path}`);
  assert.notEqual(suffix, "..", `path escaped owned root: ${path}`);
  assert.equal(suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), false,
    `path escaped owned root: ${path}`);
}

async function check(name, callback) {
  try {
    await callback();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function event(eventName, overrides = {}) {
  const sessionId = overrides.session_id ?? "lifecycle-session";
  return {
    schema_version: 1,
    event_id: `${eventName.toLowerCase()}-${sessionId}-${overrides.turn_id ?? "event"}-${overrides.suffix ?? "1"}`,
    event: eventName,
    session_id: sessionId,
    occurred_at: overrides.occurred_at ?? "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function captured(side, content) {
  return {
    side,
    content,
    content_hash: sha256(content),
    original_code_points: Array.from(content).length,
    content_truncated: false,
    content_blocked: false,
  };
}

try {
  assertOwned(home);
  await Promise.all([mkdir(home, { recursive: true }), mkdir(project, { recursive: true })]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.HERMES_REFLECTION_CODEX_TURN_CAPTURE = "true";

  const storage = await import("../dist/storage.js");
  const sessions = await import("../dist/session_storage.js");
  const { memoryBoardWriteEnhanced, memoryBoardReadEnhanced } = await import("../dist/src/storage_enhanced.js");
  const { getMemorySnapshot } = await import("../dist/src/memory_snapshot.js");
  const { HookInbox } = await import("../dist/src/hook_inbox.js");
  const { BackgroundLifecycle } = await import("../dist/src/background_lifecycle.js");
  const { BackgroundStateStore } = await import("../dist/src/background_state.js");
  const { handleSessionLifecycleHook } = await import("../dist/src/v19_tools.js");
  const {
    deriveProjectKey,
    loadOrCreateProjectSalt,
    projectScopeRepository,
  } = await import("../dist/src/project_scope.js");

  await storage.initializeStoreV20();
  const projectKey = deriveProjectKey(project, await loadOrCreateProjectSalt());
  const inbox = new HookInbox(join(home, "lifecycle-hook-inbox"));
  const state = new BackgroundStateStore(join(home, "lifecycle-background.json"));
  let reviewCalls = 0;
  let reflectionCount = 0;
  const lifecycle = new BackgroundLifecycle({
    enabled: false,
    interval_ms: 60_000,
    idle_ms: 5_000,
    lease_ms: 60_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store: state,
    hook_inbox: inbox,
    source_state: async () => ({
      source_fingerprint: "a".repeat(64),
      reflection_count: reflectionCount,
      scope: projectKey,
    }),
    review: async () => {
      reviewCalls += 1;
      return {
        success: true,
        source_fingerprint: "a".repeat(64),
        outcome_class: "success",
        candidate_ids: [],
      };
    },
    candidates_durable: async () => true,
  });

  try {
    await inbox.enqueue(event("SessionStart", {
      project_key: projectKey,
      source: "startup",
      occurred_at: "2026-08-10T00:00:00.000Z",
    }));
    await lifecycle.consumeInboxNow();
    const initialSnapshot = getMemorySnapshot("lifecycle-session");
    assert.ok(initialSnapshot, "SessionStart did not capture a snapshot");
    assert.equal(await projectScopeRepository.active("lifecycle-session"), projectKey);

    await check("Stop stages the assistant side but never ends or releases the session", async () => {
      await inbox.enqueue(event("UserPromptSubmit", {
        turn_id: "turn-1",
        captured: captured("user", "user prompt"),
        occurred_at: "2026-08-10T00:01:00.000Z",
      }));
      await inbox.enqueue(event("Stop", {
        turn_id: "turn-1",
        stop_hook_active: false,
        captured: captured("assistant", "assistant answer"),
        occurred_at: "2026-08-10T00:02:00.000Z",
      }));
      await lifecycle.consumeInboxNow();
      const meta = await sessions.getSessionMeta("lifecycle-session");
      assert.equal(meta?.ended_at, undefined, "Stop persisted session end");
      assert.equal(meta?.turn_count, 2, "captured pair did not commit exactly two turns");
      assert.deepEqual((await sessions.listSessionTurns("lifecycle-session", 10))?.map((turn) => turn.role),
        ["user", "assistant"]);
      assert.ok(getMemorySnapshot("lifecycle-session"), "Stop released the frozen snapshot");
      assert.equal(await projectScopeRepository.active("lifecycle-session"), projectKey,
        "Stop released project scope");
      assert.equal((await state.status()).dirty_session_count, 0, "Stop marked the session review-dirty");
    });

    await check("public lifecycle stop is a non-destructive compatibility alias", async () => {
      const before = await sessions.getSessionMeta("lifecycle-session");
      const result = JSON.parse(await handleSessionLifecycleHook({
        event: "stop",
        session_id: "lifecycle-session",
        project_key: projectKey,
      }));
      const after = await sessions.getSessionMeta("lifecycle-session");
      assert.equal(result.success, true);
      assert.equal(result.snapshot_changed, false);
      assert.equal(after?.ended_at, before?.ended_at, "public stop persisted session end");
      assert.ok(getMemorySnapshot("lifecycle-session"), "public stop released the frozen snapshot");
      assert.equal(await projectScopeRepository.active("lifecycle-session"), projectKey,
        "public stop released project scope");
    });

    await check("PreCompact observes without refreshing; official PostCompact refreshes without a trusted receipt", async () => {
      const write = await memoryBoardWriteEnhanced("add", "post-start memory value");
      assert.equal(write.success, true);
      const beforePre = await memoryBoardReadEnhanced("lifecycle-session", true);
      assert.equal(beforePre.live_changed_since_capture, true, "fixture did not make the snapshot stale");
      const fingerprintBeforePre = beforePre.captured_combined_fingerprint;

      const directPre = JSON.parse(await handleSessionLifecycleHook({
        event: "precompact",
        session_id: "lifecycle-session",
        project_key: projectKey,
      }));
      assert.equal(directPre.snapshot_changed, false);
      assert.equal((await memoryBoardReadEnhanced("lifecycle-session", true)).captured_combined_fingerprint,
        fingerprintBeforePre, "public precompact refreshed the frozen snapshot");

      await inbox.enqueue(event("PreCompact", {
        turn_id: "turn-1",
        trigger: "auto",
        occurred_at: "2026-08-10T00:03:00.000Z",
      }));
      await lifecycle.consumeInboxNow();
      const afterPre = await memoryBoardReadEnhanced("lifecycle-session", true);
      assert.equal(afterPre.captured_combined_fingerprint, fingerprintBeforePre,
        "PreCompact refreshed the frozen snapshot within the same context generation");
      assert.equal(afterPre.live_changed_since_capture, true);

      const beforeMeta = await sessions.getSessionMeta("lifecycle-session");
      await inbox.enqueue(event("PostCompact", {
        turn_id: "turn-1",
        trigger: "auto",
        occurred_at: "2026-08-10T00:04:00.000Z",
      }));
      await lifecycle.consumeInboxNow();
      const afterPost = await memoryBoardReadEnhanced("lifecycle-session", true);
      assert.equal(afterPost.live_changed_since_capture, false, "PostCompact did not refresh the snapshot");
      assert.match(afterPost.content, /post-start memory value/);
      const afterMeta = await sessions.getSessionMeta("lifecycle-session");
      assert.equal(afterMeta?.compaction_generation, beforeMeta?.compaction_generation,
        "official observation fabricated a trusted receipt generation");
      assert.equal(afterMeta?.last_compaction_receipt, beforeMeta?.last_compaction_receipt);
      assert.deepEqual(
        (await sessions.listCompactionObservations("lifecycle-session")).map(({ phase }) => phase),
        ["pre", "post"],
      );
    });

    await check("SessionEnd alone ends lifecycle and skips review dirty state without reflections", async () => {
      reflectionCount = 0;
      await inbox.enqueue(event("SessionEnd", {
        reason: "complete",
        occurred_at: "2026-08-10T00:05:00.000Z",
      }));
      await lifecycle.consumeInboxNow();
      assert.equal((await sessions.getSessionMeta("lifecycle-session"))?.ended_at,
        "2026-08-10T00:05:00.000Z");
      assert.equal(getMemorySnapshot("lifecycle-session"), null);
      assert.equal(await projectScopeRepository.active("lifecycle-session"), undefined);
      assert.equal((await state.status()).dirty_session_count, 0,
        "captured chat without reflection material scheduled background review");
      assert.equal(reviewCalls, 0);
    });

    await check("SessionEnd preserves an existing reflection-dirty signal", async () => {
      const sessionId = "reflection-session";
      await inbox.enqueue(event("SessionStart", {
        session_id: sessionId,
        project_key: projectKey,
        source: "startup",
        occurred_at: "2026-08-10T01:00:00.000Z",
      }));
      await lifecycle.consumeInboxNow();
      reflectionCount = 1;
      await lifecycle.notifyReflectionSaved(sessionId);
      const beforeEnd = await state.dirtySessions();
      assert.equal(beforeEnd.some((item) => item.session_id === sessionId), true);
      await inbox.enqueue(event("SessionEnd", {
        session_id: sessionId,
        reason: "complete",
        occurred_at: "2026-08-10T01:01:00.000Z",
      }));
      await lifecycle.consumeInboxNow();
      const afterEnd = await state.dirtySessions();
      assert.equal(afterEnd.some((item) => item.session_id === sessionId), true,
        "SessionEnd discarded an existing reflection-dirty signal");
    });

    assert.equal(failures.length, 0,
      `${failures.length} lifecycle behavior(s) failed:\n${failures.map(({ name, error }) =>
        `- ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`).join("\n")}`);
    console.log("[PASS] v21.1 Codex lifecycle semantics");
  } finally {
    await lifecycle.shutdown();
    sessions.closeSessionStorage();
  }
} finally {
  assertOwned(ownedRoot);
  await rm(ownedRoot, { recursive: true, force: true });
}
