import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, startMcp, withTempHome } from "./v20-test-helpers.mjs";
import { BackgroundLifecycle } from "../dist/src/background_lifecycle.js";
import { BackgroundStateStore } from "../dist/src/background_state.js";
import { HookInbox } from "../dist/src/hook_inbox.js";

const FINGERPRINT = "c".repeat(64);

async function deadlineWakeTest(home) {
  const store = new BackgroundStateStore(join(home, "deadline-state.json"));
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const lifecycle = new BackgroundLifecycle({
    enabled: true,
    interval_ms: 60_000,
    idle_ms: 5_000,
    lease_ms: 10_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store,
    hook_inbox: new HookInbox(join(home, "deadline-hook-inbox")),
    source_state: async () => ({ source_fingerprint: FINGERPRINT, reflection_count: 1, scope: "global" }),
    review: async () => {
      resolveStarted(Date.now());
      return {
        success: true,
        source_fingerprint: FINGERPRINT,
        outcome_class: "success",
        stage: "deterministic",
        candidate_ids: [],
      };
    },
    candidates_durable: async () => true,
  });
  const markedAt = Date.now();
  lifecycle.start();
  await lifecycle.notifyReflectionSaved("deadline-session");
  const armed = lifecycle.summary();
  assert.equal(armed.deadline_timer_unrefed, true);
  assert.ok(armed.next_deadline_at);
  const beganAt = await Promise.race([
    started,
    new Promise((_, reject) => setTimeout(() => reject(new Error("idle deadline wake exceeded 6 seconds")), 6_250)),
  ]);
  const elapsed = beganAt - markedAt;
  assert.ok(elapsed >= 4_500 && elapsed <= 6_000, `deadline wake elapsed ${elapsed}ms`);
  await lifecycle.shutdown();
}

async function retryDeadlineTest(home) {
  const store = new BackgroundStateStore(join(home, "retry-deadline-state.json"));
  await store.markDirty("retry-session", new Date(Date.now() - 10_000).toISOString());
  const lifecycle = new BackgroundLifecycle({
    enabled: true,
    interval_ms: 60_000,
    idle_ms: 5_000,
    lease_ms: 10_000,
    max_sessions_per_run: 1,
    review_mode: "deterministic",
    auto_apply: false,
    store,
    hook_inbox: new HookInbox(join(home, "retry-hook-inbox")),
    source_state: async () => ({ source_fingerprint: FINGERPRINT, reflection_count: 1, scope: "global" }),
    review: async () => ({
      success: false,
      source_fingerprint: FINGERPRINT,
      outcome_class: "internal_error",
      stage: "deterministic",
      candidate_ids: [],
    }),
    candidates_durable: async () => true,
  });
  await lifecycle.runNow();
  let summary = lifecycle.summary();
  for (let attempt = 0; attempt < 20 && !summary.next_deadline_at; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    summary = lifecycle.summary();
  }
  assert.ok(summary.next_deadline_at);
  const retryDelay = Date.parse(summary.next_deadline_at) - Date.now();
  assert.ok(retryDelay > 295_000 && retryDelay <= 300_000, `unexpected retry deadline ${retryDelay}ms`);
  assert.equal(summary.deadline_timer_unrefed, true);
  await lifecycle.shutdown();
}

async function runHook(home, cwd, payload) {
  const child = spawn(process.execPath, [resolve("dist/src/codex_hook_cli.js")], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const started = Date.now();
  child.stdin.end(payload);
  const [code] = await once(child, "exit");
  return { code, stdout, stderr, elapsed: Date.now() - started };
}

async function filesDigest(root) {
  const rows = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else rows.push(`${path.slice(root.length)}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
    }
  }
  await visit(root);
  return rows.sort().join("\n");
}

async function hookCliTest(home) {
  const privateCwd = join(home, "raw-private-workspace", "project-a");
  await mkdir(privateCwd, { recursive: true });
  const storeRoot = join(home, ".hermes-reflection");
  const { deriveProjectKey, loadOrCreateProjectSalt } = await import("../dist/src/project_scope.js");
  const salt = await loadOrCreateProjectSalt(join(storeRoot, "project_salt.bin"));
  const key = deriveProjectKey(privateCwd, salt);
  const events = ["SessionStart", "Stop", "PreCompact", "PostCompact"];
  const occurredAt = events.map(() => new Date().toISOString());
  const compactionMetadata = {
    generation: 1,
    before_turn_count: 4,
    after_turn_count: 2,
    handoff_hash: "a".repeat(64),
    truncated: true,
    source_fingerprint: "b".repeat(64),
  };
  for (let index = 0; index < events.length; index += 1) {
    const result = await runHook(home, privateCwd, JSON.stringify({
      hook_event_name: events[index],
      event_id: `event-${index}`,
      session_id: "hook-session",
      occurred_at: occurredAt[index],
      ...(events[index] === "SessionStart" ? { scope_intent: "project", project_key: key } : {}),
      ...(events[index] === "PostCompact" ? { metadata: compactionMetadata } : {}),
      transcript_path: join(privateCwd, "transcript-with-secret-token.txt"),
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.elapsed < 3_000, `hook ${events[index]} took ${result.elapsed}ms`);
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(receipt.ok, true);
    assert.equal(receipt.accepted, true);
  }

  const queuedEvents = (await readFile(join(storeRoot, "hook_inbox.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(queuedEvents.length, events.length);
  for (const queued of queuedEvents) {
    assert.equal(queued.project_key, key,
      `${queued.event} did not carry the cwd-derived opaque project scope`);
    assert.equal(queued.scope_intent, queued.event === "SessionStart" ? "project" : undefined);
  }

  const duplicate = await runHook(home, privateCwd, JSON.stringify({
    hook_event_name: "SessionStart",
    event_id: "event-0",
    session_id: "hook-session",
    occurred_at: occurredAt[0],
    scope_intent: "project",
    project_key: key,
    transcript_path: "must-not-be-read-or-persisted",
  }));
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.equal(JSON.parse(duplicate.stdout).duplicate, true);

  const beforeInvalid = await filesDigest(storeRoot);
  const malformed = await runHook(home, privateCwd, "{");
  assert.notEqual(malformed.code, 0);
  assert.ok(malformed.elapsed < 3_000);
  const oversized = await runHook(home, privateCwd, JSON.stringify({ payload: "x".repeat(70_000) }));
  assert.notEqual(oversized.code, 0);
  assert.ok(oversized.elapsed < 3_000);
  assert.equal(await filesDigest(storeRoot), beforeInvalid, "invalid hook input must not mutate durable state");

  const allText = (await Promise.all((await readdir(storeRoot)).map(async (name) => {
    const path = join(storeRoot, name);
    return (await stat(path)).isFile() ? readFile(path, "utf8").catch(() => "") : "";
  }))).join("\n");
  assert.doesNotMatch(allText, /raw-private-workspace|transcript-with-secret-token|must-not-be-read/i);

  const mcp = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline) {
      try {
        const state = JSON.parse(await readFile(join(storeRoot, "hook_dedup.json"), "utf8"));
        if (state.completed?.length === 4) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await mcp.close();
  }
  const { HookInbox } = await import("../dist/src/hook_inbox.js");
  const inbox = new HookInbox(storeRoot);
  const afterMcp = await inbox.consume(async () => { throw new Error("MCP must consume accepted hook events"); });
  assert.equal(afterMcp.processed, 0);
  const dedupText = await readFile(join(storeRoot, "hook_dedup.json"), "utf8");
  const dedup = JSON.parse(dedupText);
  assert.deepEqual(dedup.completed.map((item) => item.event), events);
  assert.doesNotMatch(dedupText, /raw-private-workspace|transcript/i);
  const backgroundState = JSON.parse(await readFile(join(storeRoot, "background_lifecycle.json"), "utf8"));
  assert.ok(backgroundState.dirty_sessions["hook-session"], "Stop hook must mark the session dirty");

  const completedDuplicate = await runHook(home, privateCwd, JSON.stringify({
    hook_event_name: "SessionStart",
    event_id: "event-0",
    session_id: "hook-session",
    occurred_at: occurredAt[0],
    scope_intent: "project",
    project_key: key,
  }));
  assert.equal(completedDuplicate.code, 0, completedDuplicate.stderr);
  assert.equal(JSON.parse(completedDuplicate.stdout).duplicate, true, "completed event IDs remain idempotent");

  assert.match(key, /^project:[a-f0-9]{64}$/);
  assert.equal(key, deriveProjectKey(privateCwd, salt));
  assert.notEqual(key, deriveProjectKey(join(home, "another-project"), salt));
  assert.equal((await stat(join(storeRoot, "project_salt.bin"))).size, 32);
}

async function explicitMetadataTest(home) {
  const mcp = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "0" });
  try {
    const result = await mcp.client.callTool({
      name: "session_lifecycle_hook",
      arguments: {
        event: "start",
        session_id: "metadata-session",
        metadata: {
          project_key: "project:metadata-test",
          model: "gpt-test",
          platform: "codex-desktop",
          user_id: "local-user",
        },
      },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const scopeState = JSON.parse(await readFile(join(home, ".hermes-reflection", "project_scope.json"), "utf8"));
    assert.equal(scopeState.bindings["metadata-session"].scope, "project:metadata-test");
    assert.deepEqual(scopeState.bindings["metadata-session"].metadata, {
      model: "gpt-test",
      platform: "codex-desktop",
      user_id: "local-user",
    });

    const unsupported = await mcp.client.callTool({
      name: "session_lifecycle_hook",
      arguments: { event: "pause", session_id: "metadata-session", metadata: { unsupported: "ignored-before-v20" } },
    });
    assert.equal(unsupported.isError, true, "unsupported lifecycle metadata must be rejected, not ignored");
  } finally {
    await mcp.close();
  }
}

await withTempHome("lifecycle", async (home) => {
  await deadlineWakeTest(home);
  await retryDeadlineTest(home);
  await hookCliTest(home);
});

await withTempHome("lifecycle-metadata", explicitMetadataTest);

console.log("v20 lifecycle regression test passed");
