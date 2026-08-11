import { assert, startMcp, withTempHome } from "./v20-test-helpers.mjs";
import {
  parseToolInput,
  profileToolNames,
} from "../dist/src/tool_registry.js";

const core = [
  "retrieve_heuristics",
  "reflect_on_task",
  "search_reflections",
  "get_open_questions",
  "get_memory_item",
  "compact_session_context",
  "memory_board_read",
  "memory_board_write",
  "session_lifecycle_hook",
  "trigger_background_review",
];

const standardTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

function assertStandardSchema(value, path = "inputSchema") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStandardSchema(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  assert.notEqual(value.integer, true, `${path} must not use non-standard integer:true`);
  if (typeof value.type === "string") {
    assert.ok(standardTypes.has(value.type), `${path}.type must be a standard JSON Schema type`);
  }
  for (const [key, item] of Object.entries(value)) {
    assertStandardSchema(item, `${path}.${key}`);
  }
}

function registryAccepts(name, args) {
  try {
    parseToolInput(name, args);
    return true;
  } catch {
    return false;
  }
}

async function mcpAccepts(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return result.isError !== true;
}

await withTempHome("registry", async (home) => {
  const peer = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "false" });
  try {
    const listed = await peer.client.listTools();
    const instructions = peer.client.getInstructions() ?? "";
    assert.ok(instructions.trim().length > 0, "server instructions must not be empty");
    assert.ok(Array.from(instructions).length <= 512, `server instructions=${Array.from(instructions).length}`);
    const names = listed.tools.map((tool) => tool.name);
    assert.equal(names.length, 29, "v20 complete surface must contain 29 tools");
    assert.ok(names.includes("get_memory_item"));
    assert.deepEqual(profileToolNames("core"), core);

    for (const tool of listed.tools) assertStandardSchema(tool.inputSchema, `${tool.name}.inputSchema`);
    assert.ok(Math.max(...listed.tools.map((tool) => Array.from(tool.description ?? "").length)) <= 512);

    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const coreMetadata = Array.from(instructions).length + core.reduce((sum, name) => {
      const tool = byName.get(name);
      assert.ok(tool, `core tool ${name} must be registered`);
      assert.ok((tool.description ?? "").trim().length > 0, `core tool ${name} description must not be empty`);
      return sum
        + Array.from(tool.description ?? "").length
        + Array.from(JSON.stringify(tool.inputSchema)).length;
    }, 0);
    assert.ok(coreMetadata <= 15_000, `core schema-inclusive metadata=${coreMetadata}`);
    assert.equal(byName.get("retrieve_heuristics")?.annotations?.readOnlyHint, true);
    for (const name of ["delete_heuristic", "import_data", "approve_pending_mutation", "clear_data"]) {
      assert.equal(byName.get(name)?.annotations?.destructiveHint, true, `${name} must be destructive`);
    }

    const lifecycle = await peer.client.callTool({
      name: "session_lifecycle_hook",
      arguments: { event: "start", session_id: "schema-parity" },
    });
    assert.notEqual(lifecycle.isError, true, "schema parity session must have explicit global lifecycle provenance");

    const parityCases = [
      ["scroll_session_context", { session_id: "schema-parity", around_turn_index: 0, window: 1 }, true],
      ["scroll_session_context", { session_id: "schema-parity", around_turn_index: 0.5, window: 1 }, false],
      ["memory_board_write", { action: "add", content: "schema parity fixture" }, true],
      ["memory_board_write", { action: "add" }, false],
      ["trigger_background_review", { action: "status" }, true],
    ];
    for (const [name, args, expected] of parityCases) {
      assert.equal(registryAccepts(name, args), expected, `${name} registry boundary result`);
      assert.equal(await mcpAccepts(peer.client, name, args), expected, `${name} MCP boundary result`);
    }

    const reflection = {
      session_id: "feedback-schema",
      task_goal: "validate feedback bounds",
      task_outcome: "success",
      failure_mode: "success",
      summary: "schema only",
    };
    const feedback = (count) => Array.from({ length: count }, (_, index) => ({
      heuristic_id: `heuristic-${index}`,
      value: index % 3 === 0 ? "helpful" : index % 3 === 1 ? "harmful" : "irrelevant",
    }));
    assert.equal(registryAccepts("reflect_on_task", { ...reflection, heuristic_feedback: feedback(50) }), true);
    assert.equal(registryAccepts("reflect_on_task", { ...reflection, heuristic_feedback: feedback(51) }), false);
  } finally {
    await peer.close();
  }
});
