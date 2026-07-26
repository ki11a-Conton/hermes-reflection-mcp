import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function resultText(result) {
  return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

async function callJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name} failed: ${resultText(result)}`);
  return JSON.parse(resultText(result));
}

function assertNoLoneSurrogates(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${index}`);
      index += 1;
    } else {
      assert.ok(!(code >= 0xdc00 && code <= 0xdfff), `lone low surrogate at ${index}`);
    }
  }
}

async function testMcpIntegration() {
  const home = await mkdtemp(join(tmpdir(), "hermes-v19.3-integration-"));
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HERMES_REFLECTION_BACKGROUND_ENABLED: "true",
      HERMES_REFLECTION_BACKGROUND_REVIEW_MODE: "auto",
      HERMES_REFLECTION_BACKGROUND_AUTO_APPLY: "false",
    },
  });
  const client = new Client({ name: "hermes-v19.3-integration", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 28, "public tool count must remain compatible");

    const reflected = await client.callTool({
      name: "reflect_on_task",
      arguments: {
        session_id: "integration-session",
        task_goal: "Verify automatic background lifecycle integration",
        task_outcome: "success",
        failure_mode: "success",
        summary: "Stored one reflection for lifecycle notification testing.",
        immediate_blockers: [],
        active_hypotheses: [],
        proven_safe_paths: ["Use a temporary HOME"],
        exhausted_search: [],
        world_model_updates: [],
        tool_insights: [],
        context_forget: [],
        open_questions: [],
        lessons_learned: ["Keep background lifecycle state separate from the core reflection store."],
        available_tools: [],
        auto_extract_heuristics: false,
        domain: "testing",
        tags: ["v19.3"],
      },
    });
    assert.equal(reflected.isError, undefined, resultText(reflected));

    const status = await callJson(client, "trigger_background_review", {
      action: "status",
      session_id: "integration-session",
    });
    assert.equal(status.success, true);
    assert.equal(status.background_lifecycle.runtime.enabled, true);
    assert.equal(status.background_lifecycle.runtime.timer_unrefed, true);
    assert.ok(status.background_lifecycle.durable.dirty_session_count >= 1);
    assert.equal("dirty_session_ids" in status.background_lifecycle.durable, false, "public status must not expose dirty session ids");

    const started = await callJson(client, "session_lifecycle_hook", {
      event: "start",
      session_id: "integration-session",
    });
    assert.equal(started.event, "start");
    const ended = await callJson(client, "session_lifecycle_hook", {
      event: "end",
      session_id: "integration-session",
    });
    assert.equal(ended.event, "end");
    assert.equal(ended.background_lifecycle.enabled, true);

    const neighbor = `neighbor needleword https://example.test/?code=neighbor-code&state=public ${"🙂".repeat(1_500)}`;
    const anchor = `anchor https://token-user@example.test/path?signature=anchor-signature&state=public ${"界".repeat(5_000)}`;
    for (const [role, content] of [["user", neighbor], ["assistant", anchor], ["user", neighbor]]) {
      const appended = await client.callTool({
        name: "append_session_turn",
        arguments: { session_id: "bounded-session", role, content },
      });
      assert.equal(appended.isError, undefined, resultText(appended));
    }

    const bounded = await callJson(client, "scroll_session_context", {
      session_id: "bounded-session",
      around_turn_index: 1,
      window: 1,
    });
    assert.ok(Array.from(bounded.turns[0].content).length <= 1_200);
    assert.ok(Array.from(bounded.turns[1].content).length <= 4_000);
    assert.ok(Array.from(bounded.turns[2].content).length <= 1_200);
    assert.equal(bounded.turns[1].content_truncated, true);
    assert.ok(bounded.turns[1].original_content_chars > 5_000);
    assert.doesNotMatch(JSON.stringify(bounded), /neighbor-code|token-user|anchor-signature/);
    assert.match(JSON.stringify(bounded), /state=public/);
    bounded.turns.forEach((item) => assertNoLoneSurrogates(item.content));

    const searched = await client.callTool({
      name: "search_sessions",
      arguments: { query: "needleword", limit: 10 },
    });
    assert.equal(searched.isError, undefined, resultText(searched));
    assert.doesNotMatch(resultText(searched), /neighbor-code/);
    assert.match(resultText(searched), /state=public/);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

async function testSignalShutdown() {
  const home = await mkdtemp(join(tmpdir(), "hermes-v19.3-shutdown-"));
  try {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home, HERMES_REFLECTION_BACKGROUND_ENABLED: "true" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const startedAt = Date.now();
    // Closing stdio is the native Codex Desktop lifecycle signal on Windows.
    child.stdin.end();
    const [code] = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("exit", (exitCode, signal) => resolve([exitCode, signal]));
        child.once("error", reject);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("stdio server did not stop after stdin close")), 3_000)),
    ]);
    assert.equal(code, 0, `shutdown should exit cleanly; stderr=${stderr}`);
    assert.ok(Date.now() - startedAt < 3_000, "shutdown must finish within its bounded drain");
    assert.equal(stdout, "", "server diagnostics must never corrupt MCP stdout");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

await testMcpIntegration();
await testSignalShutdown();
console.log("Hermes v19.3 MCP integration and shutdown tests passed.");
