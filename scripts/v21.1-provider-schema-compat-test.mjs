import assert from "node:assert/strict";
import {
  listRegisteredTools,
  parseToolInput,
} from "../dist/src/tool_registry.js";

const validStart = {
  event: "start",
  session_id: "provider-schema-compat-test",
  metadata: {
    model: "gpt-5.5",
    platform: "opencode",
    user_id: "user-123",
  },
};

assert.doesNotThrow(
  () => parseToolInput("session_lifecycle_hook", validStart),
  "session_lifecycle_hook must accept ordinary start metadata strings",
);

const forbiddenCharacters = [
  ["CR", "\r"],
  ["LF", "\n"],
  ["NUL", "\u0000"],
];

for (const field of ["model", "platform", "user_id"]) {
  for (const [label, value] of [
    ["an empty string", ""],
    ["more than 100 characters", "x".repeat(101)],
  ]) {
    const invalidStart = {
      ...validStart,
      metadata: {
        ...validStart.metadata,
        [field]: value,
      },
    };
    assert.throws(
      () => parseToolInput("session_lifecycle_hook", invalidStart),
      `${field} must reject ${label} through the registered schema parser`,
    );
  }
  for (const [label, character] of forbiddenCharacters) {
    const invalidStart = {
      ...validStart,
      metadata: {
        ...validStart.metadata,
        [field]: `prefix${character}suffix`,
      },
    };
    assert.throws(
      () => parseToolInput("session_lifecycle_hook", invalidStart),
      `${field} must reject ${label} through the registered schema parser`,
    );
  }
}

function collectLegacyNulPatterns(value, path, findings) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLegacyNulPatterns(item, `${path}[${index}]`, findings));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (key === "pattern" && typeof item === "string" && item.includes("\\0")) {
      findings.push({ path: itemPath, pattern: item });
    }
    collectLegacyNulPatterns(item, itemPath, findings);
  }
}

const legacyNulPatterns = [];
const registeredTools = listRegisteredTools();
for (const tool of registeredTools) {
  collectLegacyNulPatterns(tool.inputSchema, `${tool.name}.inputSchema`, legacyNulPatterns);
}

assert.deepEqual(
  legacyNulPatterns,
  [],
  `public tool input schemas must not export legacy \\0 patterns: ${JSON.stringify(legacyNulPatterns)}`,
);

const lifecycleTool = registeredTools.find((tool) => tool.name === "session_lifecycle_hook");
assert.ok(lifecycleTool, "session_lifecycle_hook must remain registered");
const metadataBranches = lifecycleTool.inputSchema?.properties?.metadata?.anyOf ?? [];
const startMetadataBranch = metadataBranches.find((branch) =>
  branch?.properties
  && ["model", "platform", "user_id"].every((field) => Object.hasOwn(branch.properties, field))
);
assert.ok(startMetadataBranch, "session start metadata schema branch is missing");
for (const field of ["model", "platform", "user_id"]) {
  const schema = startMetadataBranch.properties[field];
  assert.equal(schema.minLength, 1, `${field} public minLength drifted`);
  assert.equal(schema.maxLength, 100, `${field} public maxLength drifted`);
  assert.equal(Object.hasOwn(schema, "pattern"), false, `${field} must not export a provider-sensitive pattern`);
}

console.log("v21.1 provider schema compatibility tests passed.");
