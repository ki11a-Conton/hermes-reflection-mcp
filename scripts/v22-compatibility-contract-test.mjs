import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  listRegisteredTools,
  profileToolNames,
} from "../dist/src/tool_registry.js";

const EXPECTED_CORE_NAMES = [
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

const EXPECTED_REGISTERED_NAMES = [
  "reflect_on_task",
  "search_reflections",
  "list_reflections",
  "retrieve_heuristics",
  "list_heuristics",
  "search_heuristics",
  "add_heuristic",
  "delete_heuristic",
  "memory_board_write",
  "memory_board_read",
  "user_profile_write",
  "user_profile_read",
  "get_open_questions",
  "get_memory_item",
  "resolve_open_question",
  "search_sessions",
  "append_session_turn",
  "get_recent_reflections",
  "export_data",
  "import_data",
  "clear_data",
  "capture_memory_snapshot",
  "session_lifecycle_hook",
  "scan_memory_threats",
  "scroll_session_context",
  "trigger_background_review",
  "list_pending_mutations",
  "approve_pending_mutation",
  "compact_session_context",
];

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const EXPECTED_ANNOTATIONS = {
  reflect_on_task: MUTATING,
  search_reflections: READ_ONLY,
  list_reflections: READ_ONLY,
  retrieve_heuristics: READ_ONLY,
  list_heuristics: READ_ONLY,
  search_heuristics: READ_ONLY,
  add_heuristic: MUTATING,
  delete_heuristic: DESTRUCTIVE,
  memory_board_write: DESTRUCTIVE,
  memory_board_read: READ_ONLY,
  user_profile_write: DESTRUCTIVE,
  user_profile_read: READ_ONLY,
  get_open_questions: READ_ONLY,
  get_memory_item: READ_ONLY,
  resolve_open_question: MUTATING,
  search_sessions: READ_ONLY,
  append_session_turn: MUTATING,
  get_recent_reflections: READ_ONLY,
  export_data: MUTATING,
  import_data: DESTRUCTIVE,
  clear_data: DESTRUCTIVE,
  capture_memory_snapshot: MUTATING,
  session_lifecycle_hook: MUTATING,
  scan_memory_threats: READ_ONLY,
  scroll_session_context: READ_ONLY,
  trigger_background_review: MUTATING,
  list_pending_mutations: READ_ONLY,
  approve_pending_mutation: DESTRUCTIVE,
  compact_session_context: READ_ONLY,
};

const EXPECTED_CONTRACT_SHA256 = "fd6e58e082bd1b4971d35060526ec88103a517b3e5d3af540a2cfb515c111b0c";
const MAX_CORE_METADATA_CODE_POINTS = 12_500;
const STANDARD_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJson(value[key])]),
  );
}

function assertPortableSchema(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortableSchema(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  if (Object.hasOwn(value, "pattern")) {
    assert.equal(typeof value.pattern, "string", `${path}.pattern must be a string`);
    assert.equal(
      value.pattern.includes("\\0"),
      false,
      `${path}.pattern exports the provider-incompatible legacy \\0 escape: ${value.pattern}`,
    );
  }

  if (Object.hasOwn(value, "type")) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    assert.ok(types.length > 0, `${path}.type must not be empty`);
    for (const type of types) {
      assert.equal(typeof type, "string", `${path}.type entries must be strings`);
      assert.ok(
        STANDARD_SCHEMA_TYPES.has(type),
        `${path}.type contains non-standard JSON Schema type ${JSON.stringify(type)}`,
      );
    }
  }

  for (const [key, item] of Object.entries(value)) {
    assertPortableSchema(item, `${path}.${key}`);
  }
}

const registered = listRegisteredTools();
const registeredNames = registered.map((tool) => tool.name);

assert.deepEqual(profileToolNames("core"), EXPECTED_CORE_NAMES, "Agent-first core tool order drifted");
assert.deepEqual(profileToolNames("extended"), EXPECTED_REGISTERED_NAMES, "extended tool order drifted");
assert.deepEqual(registeredNames, EXPECTED_REGISTERED_NAMES, "registered tool order drifted");
assert.equal(new Set(registeredNames).size, registeredNames.length, "registered tool names contain duplicates");
assert.deepEqual(
  Object.keys(EXPECTED_ANNOTATIONS),
  EXPECTED_REGISTERED_NAMES,
  "expected annotation contract is incomplete or out of order",
);

const byName = new Map(registered.map((tool) => [tool.name, tool]));
for (const tool of registered) {
  assert.deepEqual(
    tool.annotations,
    EXPECTED_ANNOTATIONS[tool.name],
    `${tool.name} annotations drifted from the reviewed public contract`,
  );
  assert.equal(tool.inputSchema?.type, "object", `${tool.name}.inputSchema must have top-level type object`);
  assertPortableSchema(tool.inputSchema, `${tool.name}.inputSchema`);
  if (tool.outputSchema !== undefined) {
    assertPortableSchema(tool.outputSchema, `${tool.name}.outputSchema`);
  }
}

const expectedDestructiveNames = EXPECTED_REGISTERED_NAMES.filter(
  (name) => EXPECTED_ANNOTATIONS[name].destructiveHint,
);
assert.deepEqual(
  expectedDestructiveNames,
  [
    "delete_heuristic",
    "memory_board_write",
    "user_profile_write",
    "import_data",
    "clear_data",
    "approve_pending_mutation",
  ],
  "reviewed destructive annotation contract is incomplete",
);
assert.deepEqual(
  registered.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name),
  expectedDestructiveNames,
  "destructive annotation set or order drifted",
);
assert.deepEqual(
  registered.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name),
  EXPECTED_REGISTERED_NAMES.filter((name) => EXPECTED_ANNOTATIONS[name].readOnlyHint),
  "known read-only tools drifted to mutating or the read-only set changed",
);

const publicContract = registered.map((tool) => ({
  name: tool.name,
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
  annotations: {
    readOnlyHint: tool.annotations.readOnlyHint,
    destructiveHint: tool.annotations.destructiveHint,
    idempotentHint: tool.annotations.idempotentHint,
    openWorldHint: tool.annotations.openWorldHint,
  },
}));
const contractJson = JSON.stringify(normalizeJson(publicContract));
const contractSha256 = createHash("sha256").update(contractJson, "utf8").digest("hex");
assert.equal(
  contractSha256,
  EXPECTED_CONTRACT_SHA256,
  `Public tool schema/annotation contract changed (actual SHA-256 ${contractSha256}). Review every intentional schema or annotation change, then update EXPECTED_CONTRACT_SHA256.`,
);

const coreMetadataCodePoints = EXPECTED_CORE_NAMES.reduce((sum, name) => {
  const tool = byName.get(name);
  assert.ok(tool, `core tool ${name} is not registered`);
  return sum
    + Array.from(tool.description ?? "").length
    + Array.from(JSON.stringify(tool.inputSchema)).length;
}, 0);
assert.ok(
  coreMetadataCodePoints <= MAX_CORE_METADATA_CODE_POINTS,
  `Agent-first schema-inclusive metadata is ${coreMetadataCodePoints} Unicode code points; budget is ${MAX_CORE_METADATA_CODE_POINTS}.`,
);

console.log(
  `[PASS] v22 compatibility contract (${EXPECTED_CORE_NAMES.length} core, ${registered.length} registered, SHA-256 ${contractSha256}, core metadata ${coreMetadataCodePoints} code points)`,
);
