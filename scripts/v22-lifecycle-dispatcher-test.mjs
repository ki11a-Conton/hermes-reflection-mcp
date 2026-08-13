import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  isActionableCodexHookEvent,
  mapCodexHookEvent,
} from "../dist/src/adapters/codex/event_mapper.js";
import { mapMcpLifecycleEvent } from "../dist/src/adapters/mcp/event_mapper.js";
import { dispatchLifecycleEvent } from "../dist/src/lifecycle/dispatcher.js";

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const project = `project:${"a".repeat(64)}`;

function hook(event, overrides = {}) {
  return {
    schema_version: 1,
    event_id: `event:${event}`,
    event,
    session_id: "session-1",
    occurred_at: "2026-08-12T12:00:00Z",
    project_key: project,
    ...overrides,
  };
}

const expectedTypes = {
  SessionStart: "session_start",
  UserPromptSubmit: "turn_start",
  Stop: "turn_end",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionEnd: "session_end",
};

assert.equal(isActionableCodexHookEvent(hook("UserPromptSubmit", { turn_id: "turn-1" }), false), false);
assert.equal(isActionableCodexHookEvent(hook("Stop", { turn_id: "turn-1" }), false), false);
assert.equal(isActionableCodexHookEvent(hook("UserPromptSubmit"), true), false);
assert.equal(isActionableCodexHookEvent(hook("PreCompact"), true), false);
assert.equal(isActionableCodexHookEvent(hook("SessionStart"), false), true);

for (const [codexEvent, canonicalType] of Object.entries(expectedTypes)) {
  const input = hook(codexEvent, {
    ...(codexEvent === "SessionStart" ? { source: "startup" } : {}),
    ...(["UserPromptSubmit", "Stop", "PreCompact", "PostCompact"].includes(codexEvent)
      ? { turn_id: "turn-1" }
      : {}),
    ...(["PreCompact", "PostCompact"].includes(codexEvent) ? { trigger: "manual" } : {}),
    ...(codexEvent === "SessionEnd" ? { reason: "finished" } : {}),
  });
  const mapped = mapCodexHookEvent(input);
  assert.equal(mapped.type, canonicalType);
  assert.equal(mapped.host.name, "codex");
  assert.equal(mapped.identity.key, input.event_id);
  assert.equal(mapped.scope, project);
}

const receivedA = mapCodexHookEvent(hook("SessionStart", {
  event_id: "generated-start",
  event_id_source: "generated",
  occurred_at: "2026-08-12T12:00:00Z",
  occurred_at_source: "received",
}));
const receivedB = mapCodexHookEvent(hook("SessionStart", {
  event_id: "generated-start",
  event_id_source: "generated",
  occurred_at: "2026-08-12T12:05:00Z",
  occurred_at_source: "received",
}));
assert.equal(receivedA.identity.source, "generated");
assert.equal(receivedB.identity.source, "generated");

const userCapture = {
  side: "user",
  content: "safe user projection",
  content_hash: digest("safe user projection"),
  original_code_points: 20,
  content_truncated: false,
  content_blocked: false,
};
const assistantCapture = { ...userCapture, side: "assistant", content: "safe answer", content_hash: digest("safe answer") };
assert.equal(mapCodexHookEvent(hook("UserPromptSubmit", { turn_id: "turn-a", captured: userCapture })).payload.capture.side, "user");
assert.equal(mapCodexHookEvent(hook("Stop", { turn_id: "turn-a", captured: assistantCapture })).payload.capture.side, "assistant");

const receipt = {
  generation: 2,
  before_turn_count: 10,
  after_turn_count: 4,
  handoff_hash: digest("handoff"),
  truncated: true,
  source_fingerprint: digest("source"),
};

const mcpStart = mapMcpLifecycleEvent({
  event: "start",
  session_id: "mcp-session",
  scope: "project:mcp",
  occurred_at: "2026-08-12T12:00:00Z",
  host_metadata: { model: "model-1", platform: "opencode", user_id: "user-1" },
});
assert.equal(mcpStart.type, "session_start");
assert.equal(mcpStart.host.name, "mcp");
assert.deepEqual(mcpStart.host_metadata, { model: "model-1", platform: "opencode", user_id: "user-1" });

const mcpEnd = mapMcpLifecycleEvent({
  event: "end",
  session_id: "mcp-session",
  scope: "project:mcp",
  occurred_at: "2026-08-12T12:05:00Z",
});
assert.equal(mcpEnd.type, "session_end");
assert.equal(mcpEnd.payload.reason, "client_end");

const mcpPost = mapMcpLifecycleEvent({
  event: "postcompact",
  session_id: "mcp-session",
  scope: "project:mcp",
  occurred_at: "2026-08-12T12:04:00Z",
  compaction_metadata: receipt,
});
assert.equal(mcpPost.type, "post_compact");
assert.deepEqual(mcpPost.payload.trusted_receipt, receipt);
const post = mapCodexHookEvent(hook("PostCompact", {
  turn_id: "turn-a",
  trigger: "auto",
  metadata: receipt,
}));
assert.deepEqual(post.payload.observation, { trigger: "auto" });
assert.deepEqual(post.payload.trusted_receipt, receipt);

function recorder() {
  const calls = [];
  const ports = {
    persist_session_start: async (event) => { calls.push(["start", event.session_id]); return true; },
    bind_scope: async (event) => { calls.push(["bind", event.scope]); },
    capture_snapshot: async (sessionId) => { calls.push(["snapshot", sessionId]); },
    stage_turn_side: async (event) => { calls.push(["turn", event.type, event.turn_id]); },
    persist_compaction_observation: async (event, phase) => { calls.push(["observation", phase, event.identity.key]); },
    persist_compaction_receipt: async (event) => { calls.push(["receipt", event.payload.trusted_receipt.generation]); return true; },
    persist_session_end: async (event) => { calls.push(["end", event.payload.reason]); return true; },
    cleanup_pending_turn_sides: async (sessionId) => { calls.push(["cleanup", sessionId]); },
    release_snapshot: (sessionId) => { calls.push(["release_snapshot", sessionId]); },
    notify_session_end: async (sessionId) => { calls.push(["notify", sessionId]); },
    release_scope: async (sessionId) => { calls.push(["release_scope", sessionId]); },
  };
  return { calls, ports };
}

{
  const { calls, ports } = recorder();
  await dispatchLifecycleEvent(mapCodexHookEvent(hook("SessionStart", { source: "startup" })), ports);
  assert.deepEqual(calls.map((call) => call[0]), ["start", "bind", "snapshot"]);
}

for (const codexEvent of ["UserPromptSubmit", "Stop"]) {
  const { calls, ports } = recorder();
  const captured = codexEvent === "UserPromptSubmit" ? userCapture : assistantCapture;
  await dispatchLifecycleEvent(mapCodexHookEvent(hook(codexEvent, { turn_id: "turn-a", captured })), ports);
  assert.deepEqual(calls.map((call) => call[0]), ["turn"]);
  assert.equal(calls.some((call) => call[0] === "end" || call[0].startsWith("release")), false);
}

{
  const sequence = [
    mapCodexHookEvent(hook("SessionStart", { source: "startup" })),
    mapCodexHookEvent(hook("UserPromptSubmit", { turn_id: "turn-a", captured: userCapture })),
    mapCodexHookEvent(hook("Stop", { turn_id: "turn-a", captured: assistantCapture })),
    mapCodexHookEvent(hook("PreCompact", { turn_id: "turn-a", trigger: "manual" })),
    mapCodexHookEvent(hook("PostCompact", { turn_id: "turn-a", trigger: "auto", metadata: receipt })),
    mapCodexHookEvent(hook("SessionEnd", { reason: "finished" })),
  ];
  const codex = recorder();
  const fakeHost = recorder();
  for (const event of sequence) {
    await dispatchLifecycleEvent(event, codex.ports);
    await dispatchLifecycleEvent({ ...event, host: { name: "fake-host", version: "1" } }, fakeHost.ports);
  }
  assert.deepEqual(
    fakeHost.calls,
    codex.calls,
    "host-independent core produced different effects for an equivalent fake-host sequence",
  );
}

{
  const { calls, ports } = recorder();
  await dispatchLifecycleEvent(mapCodexHookEvent(hook("PreCompact", { turn_id: "turn-a", trigger: "manual" })), ports);
  assert.deepEqual(calls.map((call) => call[0]), ["observation"]);
}

{
  const { calls, ports } = recorder();
  await dispatchLifecycleEvent(mapCodexHookEvent(hook("PostCompact", {
    turn_id: "turn-a", trigger: "auto", metadata: receipt,
  })), ports);
  assert.deepEqual(calls.map((call) => call[0]), ["observation", "receipt", "snapshot"]);
}

{
  const { calls, ports } = recorder();
  await dispatchLifecycleEvent(mapCodexHookEvent(hook("SessionEnd", { reason: "finished" })), ports);
  assert.deepEqual(calls.map((call) => call[0]), [
    "end", "cleanup", "release_snapshot", "notify", "release_scope",
  ]);
}

{
  const { calls, ports } = recorder();
  ports.persist_session_start = async () => false;
  await assert.rejects(() => dispatchLifecycleEvent(mapCodexHookEvent(hook("SessionStart")), ports));
  assert.deepEqual(calls, []);
}

const backgroundLifecycleSource = await readFile(
  new URL("../src/background_lifecycle.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  backgroundLifecycleSource,
  /case\s+"(?:SessionStart|UserPromptSubmit|Stop|PreCompact|PostCompact|SessionEnd)"/,
  "background lifecycle must not retain a second Codex-specific lifecycle state machine",
);
assert.match(backgroundLifecycleSource, /mapCodexHookEvent/);
assert.match(backgroundLifecycleSource, /dispatchLifecycleEvent/);

const legacyToolSource = await readFile(new URL("../src/v19_tools.ts", import.meta.url), "utf8");
assert.doesNotMatch(
  legacyToolSource,
  /case\s+"(?:start|end|postcompact)"/,
  "direct MCP lifecycle mutations must use the canonical dispatcher",
);
assert.match(legacyToolSource, /mapMcpLifecycleEvent/);
assert.match(legacyToolSource, /dispatchLifecycleEvent/);

process.stdout.write("v22 lifecycle mapper/dispatcher test passed\n");
