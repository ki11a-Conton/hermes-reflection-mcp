import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverEntry = process.env.HERMES_SERVER_ENTRY
  ? resolve(process.env.HERMES_SERVER_ENTRY)
  : join(root, "dist", "index.js");
const home = await mkdtemp(join(tmpdir(), "hermes-v19-5-context-budget-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: root,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HERMES_BACKGROUND_ENABLED: "0",
  },
  stderr: "pipe",
});
const client = new Client({ name: "v19.5-context-budget-test", version: "1.0.0" });

function textOf(result) {
  const summary = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
  return result.structuredContent
    ? `${summary}\n${JSON.stringify(result.structuredContent)}`
    : summary;
}

async function callTool(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

try {
  await client.connect(transport);
  const instructions = client.getInstructions() ?? "";
  const listed = await client.listTools();

  assert.equal(listed.tools.length, 29, "public tool count changed");
  assert.ok(instructions.trim().length > 0, "server instructions must remain discoverable");
  for (const tool of listed.tools) {
    assert.ok((tool.description ?? "").trim().length > 0, `${tool.name} description must remain discoverable`);
  }
  const responseModeTools = new Set([
    "retrieve_heuristics",
    "list_heuristics",
    "search_heuristics",
    "search_reflections",
    "list_reflections",
    "get_recent_reflections",
    "get_open_questions",
    "search_sessions",
    "scroll_session_context",
    "compact_session_context",
    "memory_board_read",
    "user_profile_read",
    "reflect_on_task",
    "get_memory_item",
    "trigger_background_review",
    "list_pending_mutations",
    "scan_memory_threats",
  ]);
  for (const tool of listed.tools) {
    const property = tool.inputSchema?.properties?.response_mode;
    if (responseModeTools.has(tool.name)) {
      assert.deepEqual(property?.enum, ["compact", "full"], `${tool.name} response_mode enum`);
      assert.equal(property?.default, "compact", `${tool.name} compact default`);
      assert.match(tool.description ?? "", /compact by default/i, `${tool.name} description must advertise compact default`);
    } else {
      assert.equal(property, undefined, `${tool.name} unexpectedly exposes response_mode`);
    }
  }
  assert.ok(instructions.length <= 512, `instructions=${instructions.length}`);

  const exposedDescriptionLengths = listed.tools.map((tool) =>
    instructions.length + (tool.description?.length ?? 0));
  const maxDescription = Math.max(...exposedDescriptionLengths);
  assert.ok(maxDescription <= 2_000, `max exposed description=${maxDescription}`);

  const aggregate = instructions.length + listed.tools.reduce((sum, tool) => sum
    + (tool.description?.length ?? 0)
    + JSON.stringify(tool.inputSchema).length, 0);
  assert.ok(aggregate <= 35_000, `aggregate exposed metadata=${aggregate}`);

  const longLesson = (number) =>
    `Lesson ${number}: keep protocol projections deterministic and preserve stable identifiers while removing repeated diagnostic metadata from model context.`;
  const baseReflection = {
    session_id: "context-budget-fixture",
    task_goal: "Validate compact response rendering",
    task_outcome: "success",
    failure_mode: "success",
    summary: "A deliberately detailed summary used to prove that compact output does not echo long submitted content.",
    lessons_learned: [longLesson(1), longLesson(2), longLesson(3)],
    open_questions: [{
      question: "Which client-side metadata cache must be refreshed after installation?",
      priority: "medium",
      requires_environment_interaction: false,
    }],
    domain: "mcp-context-budget",
    tags: ["v19.5"],
    auto_extract_heuristics: true,
  };
  const compactDryRun = await callTool("reflect_on_task", { ...baseReflection, dry_run: true });
  const explicitCompactDryRun = await callTool("reflect_on_task", {
    ...baseReflection,
    dry_run: true,
    response_mode: "compact",
  });
  const fullDryRun = await callTool("reflect_on_task", {
    ...baseReflection,
    dry_run: true,
    response_mode: "full",
  });
  assert.equal(compactDryRun.isError, undefined);
  assert.ok(!textOf(compactDryRun).includes(longLesson(1)), "default compact dry-run echoed a lesson");
  assert.ok(!textOf(explicitCompactDryRun).includes(longLesson(1)), "explicit compact dry-run echoed a lesson");
  assert.ok(textOf(fullDryRun).includes(longLesson(1)), "full dry-run lost lesson detail");
  assert.match(textOf(compactDryRun), /Would-be id: [a-f0-9-]+/);

  const compactReflect = await callTool("reflect_on_task", baseReflection);
  assert.equal(compactReflect.isError, undefined);
  assert.match(textOf(compactReflect), /Reflection saved \[[a-f0-9-]+\]/);
  assert.ok(!textOf(compactReflect).includes(longLesson(1)), "compact persisted receipt echoed a lesson");

  const heuristicQuery = {
    task_description: "protocol projections deterministic stable identifiers",
    domain: "mcp-context-budget",
    limit: 5,
  };
  const compactHeuristics = await callTool("retrieve_heuristics", heuristicQuery);
  const fullHeuristics = await callTool("retrieve_heuristics", { ...heuristicQuery, response_mode: "full" });
  assert.match(textOf(compactHeuristics), /id:/);
  assert.match(textOf(compactHeuristics), /Confidence:/);
  assert.ok(!textOf(compactHeuristics).includes("Retrieved x"));
  assert.ok(textOf(fullHeuristics).includes("Retrieved x"));

  const compactHeuristicList = await callTool("list_heuristics", { domain: "mcp-context-budget", limit: 5 });
  const fullHeuristicList = await callTool("list_heuristics", {
    domain: "mcp-context-budget", limit: 5, response_mode: "full",
  });
  assert.ok(!textOf(compactHeuristicList).includes("Retrieved x"));
  assert.ok(textOf(fullHeuristicList).includes("Retrieved x"));

  const compactHeuristicSearch = await callTool("search_heuristics", {
    query: "protocol projections", domain: "mcp-context-budget", limit: 5,
  });
  const fullHeuristicSearch = await callTool("search_heuristics", {
    query: "protocol projections", domain: "mcp-context-budget", limit: 5, response_mode: "full",
  });
  assert.ok(!textOf(compactHeuristicSearch).includes("Confirmed x"));
  assert.ok(textOf(fullHeuristicSearch).includes("Confirmed x"));

  const compactReflectionSearch = await callTool("search_reflections", {
    query: "compact response rendering", domain: "mcp-context-budget", limit: 5,
  });
  const fullReflectionSearch = await callTool("search_reflections", {
    query: "compact response rendering", domain: "mcp-context-budget", limit: 5, response_mode: "full",
  });
  assert.match(textOf(compactReflectionSearch), /id:/);
  assert.ok(!textOf(compactReflectionSearch).includes("Lessons:"));
  assert.ok(textOf(fullReflectionSearch).includes("Lessons:"));

  const compactReflectionList = await callTool("list_reflections", {
    domain: "mcp-context-budget", limit: 5,
  });
  const fullReflectionList = await callTool("list_reflections", {
    domain: "mcp-context-budget", limit: 5, response_mode: "full",
  });
  assert.ok(textOf(compactReflectionList).length < textOf(fullReflectionList).length);
  assert.match(textOf(compactReflectionList), /id:/);

  const compactRecent = await callTool("get_recent_reflections", { limit: 5 });
  const fullRecent = await callTool("get_recent_reflections", { limit: 5, response_mode: "full" });
  assert.ok(textOf(compactRecent).length < textOf(fullRecent).length);
  assert.match(textOf(compactRecent), /id:/);

  const compactQuestions = await callTool("get_open_questions", { domain: "mcp-context-budget", limit: 5 });
  const fullQuestions = await callTool("get_open_questions", {
    domain: "mcp-context-budget", limit: 5, response_mode: "full",
  });
  assert.match(textOf(compactQuestions), /Reflection: [a-f0-9-]+ question_index:0/);
  assert.ok(!textOf(compactQuestions).includes("Task:"));
  assert.ok(textOf(fullQuestions).includes("Task:"));

  const longTurn = `anchor ${"safe historical detail ".repeat(60)}`;
  await callTool("append_session_turn", {
    session_id: "context-budget-fixture",
    role: "user",
    content: longTurn,
  });
  await callTool("append_session_turn", {
    session_id: "context-budget-fixture",
    role: "assistant",
    content: `answer ${"bounded assistant context ".repeat(40)}`,
  });
  const compactSearch = await callTool("search_sessions", { query: "anchor", limit: 5 });
  const fullSearch = await callTool("search_sessions", { query: "anchor", limit: 5, response_mode: "full" });
  assert.match(textOf(compactSearch), /context-budget-fixture/);
  assert.ok(textOf(compactSearch).length < textOf(fullSearch).length);

  const compactScroll = await callTool("scroll_session_context", {
    session_id: "context-budget-fixture", around_turn_index: 0, window: 1,
  });
  const fullScroll = await callTool("scroll_session_context", {
    session_id: "context-budget-fixture", around_turn_index: 0, window: 1, response_mode: "full",
  });
  assert.ok(textOf(compactScroll).length < textOf(fullScroll).length);
  assert.match(textOf(compactScroll), /"turn_index"\s*:\s*0/);

  const compactHandoff = await callTool("compact_session_context", {
    session_id: "context-budget-fixture", max_chars: 1200,
  });
  const fullHandoff = await callTool("compact_session_context", {
    session_id: "context-budget-fixture", max_chars: 1200, response_mode: "full",
  });
  assert.match(textOf(compactHandoff), /"handoff"/);
  assert.ok(!textOf(compactHandoff).includes("sections_truncated"));
  assert.ok(textOf(fullHandoff).includes("sections_truncated"));

  const memoryText = "v19.5 compact mode must preserve this complete memory sentence.";
  const profileText = "The user prefers context-efficient MCP responses.";
  await callTool("memory_board_write", { action: "add", content: memoryText });
  await callTool("user_profile_write", { action: "add", content: profileText });
  await callTool("capture_memory_snapshot", { session_id: "context-budget-snapshot" });
  const compactMemory = await callTool("memory_board_read", {
    mode: "snapshot", session_id: "context-budget-snapshot",
  });
  const fullMemory = await callTool("memory_board_read", {
    mode: "snapshot", session_id: "context-budget-snapshot", response_mode: "full",
  });
  assert.ok(textOf(compactMemory).includes(memoryText));
  assert.ok(textOf(fullMemory).includes(memoryText));
  assert.ok(!textOf(compactMemory).includes("captured_at:"));
  assert.ok(textOf(fullMemory).includes("captured_at:"));
  const compactProfile = await callTool("user_profile_read", {
    mode: "snapshot", session_id: "context-budget-snapshot",
  });
  const fullProfile = await callTool("user_profile_read", {
    mode: "snapshot", session_id: "context-budget-snapshot", response_mode: "full",
  });
  assert.ok(textOf(compactProfile).includes(profileText));
  assert.ok(textOf(fullProfile).includes(profileText));
  assert.ok(!textOf(compactProfile).includes("captured_at:"));
  assert.ok(textOf(fullProfile).includes("captured_at:"));

  const missingSnapshotId = await callTool("memory_board_read", { mode: "snapshot" });
  assert.equal(missingSnapshotId.isError, true);
  assert.match(textOf(missingSnapshotId), /session_id is required/);

  for (const result of [compactReflect, compactHeuristics, compactScroll, compactHandoff]) {
    const renderedText = textOf(result);
    assert.ok(
      !(result.structuredContent && JSON.stringify(result.structuredContent).includes(renderedText)),
      "duplicated full payload in text and structuredContent",
    );
  }

  const repeatA = await callTool("get_recent_reflections", { limit: 5 });
  const repeatB = await callTool("get_recent_reflections", { limit: 5 });
  assert.equal(textOf(repeatA), textOf(repeatB));

  const compactChars = [compactDryRun, compactHeuristics, compactSearch, compactScroll]
    .reduce((sum, result) => sum + textOf(result).length, 0);
  const fullChars = [fullDryRun, fullHeuristics, fullSearch, fullScroll]
    .reduce((sum, result) => sum + textOf(result).length, 0);
  assert.ok(compactChars <= fullChars * 0.60, `compact=${compactChars} full=${fullChars}`);

  const brokenHome = await mkdtemp(join(tmpdir(), "hermes-v19-5-broken-session-"));
  const brokenStore = join(brokenHome, ".hermes-reflection");
  await mkdir(join(brokenStore, "sessions.db"), { recursive: true });
  const brokenTransport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: root,
    env: {
      ...process.env,
      HOME: brokenHome,
      USERPROFILE: brokenHome,
      HERMES_BACKGROUND_ENABLED: "0",
      HERMES_SESSION_RETRY_MS: "60000",
    },
    stderr: "pipe",
  });
  const brokenClient = new Client({ name: "v19.5-error-test", version: "1.0.0" });
  try {
    await brokenClient.connect(brokenTransport);
    const unavailableLifecycle = await brokenClient.callTool({
      name: "session_lifecycle_hook",
      arguments: { event: "start", session_id: "unavailable-session" },
    });
    assert.equal(unavailableLifecycle.isError, true);
    assert.match(textOf(unavailableLifecycle), /Session storage is unavailable/);
    const unavailable = await brokenClient.callTool({
      name: "compact_session_context",
      arguments: { session_id: "unavailable-session" },
    });
    assert.equal(unavailable.isError, true);
    assert.match(textOf(unavailable), /LIFECYCLE_NOT_READY/);
    assert.match(textOf(unavailable), /unavailable-session/);
  } finally {
    await brokenClient.close().catch(() => {});
    await rm(brokenHome, { recursive: true, force: true });
  }

  console.log(`METADATA instructions=${instructions.length} max_description=${maxDescription} aggregate=${aggregate} tools=${listed.tools.length}`);
  console.log(`RESPONSES compact=${compactChars} full=${fullChars} saved=${(1 - compactChars / fullChars).toFixed(3)}`);
} finally {
  await client.close().catch(() => {});
  await rm(home, { recursive: true, force: true });
}
