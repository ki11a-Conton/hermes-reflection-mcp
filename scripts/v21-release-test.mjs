import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_VERSION = "21.1.0";
const runtimeRequested = process.argv.includes("--runtime") || Boolean(process.env.HERMES_SERVER_ENTRY);
const explicitProjectRoot = process.env.HERMES_PROJECT_ROOT;

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function canonicalRuntimeLayout() {
  const entryInput = process.env.HERMES_SERVER_ENTRY
    || join(explicitProjectRoot ? resolve(explicitProjectRoot) : process.cwd(), "dist", "index.js");
  const resolvedEntry = resolve(entryInput);
  const entryStat = await lstat(resolvedEntry);
  assert.equal(entryStat.isSymbolicLink(), false, `HERMES_SERVER_ENTRY must not be a symlink: ${resolvedEntry}`);
  assert.equal(entryStat.isFile(), true, `HERMES_SERVER_ENTRY is not a regular file: ${resolvedEntry}`);
  const canonicalEntry = await realpath(resolvedEntry);
  assert.equal(comparablePath(resolvedEntry), comparablePath(canonicalEntry),
    `HERMES_SERVER_ENTRY contains a symlink or junction: ${resolvedEntry}`);

  const inferredRoot = await realpath(dirname(dirname(canonicalEntry)));
  const packageRoot = explicitProjectRoot ? await realpath(resolve(explicitProjectRoot)) : inferredRoot;
  const expectedEntry = await realpath(join(packageRoot, "dist", "index.js"));
  assert.equal(comparablePath(canonicalEntry), comparablePath(expectedEntry),
    `HERMES_SERVER_ENTRY must be the selected package root's dist/index.js: ${canonicalEntry}`);
  assert.equal(comparablePath(inferredRoot), comparablePath(packageRoot),
    `HERMES_SERVER_ENTRY and HERMES_PROJECT_ROOT select different package trees`);
  return { root: packageRoot, serverEntry: canonicalEntry };
}

const layout = runtimeRequested
  ? await canonicalRuntimeLayout()
  : { root: await realpath(resolve(explicitProjectRoot || process.cwd())), serverEntry: undefined };
const root = layout.root;
const serverEntry = layout.serverEntry ?? join(root, "dist", "index.js");
const runtimeRoot = dirname(serverEntry);
const tempHome = await mkdtemp(join(tmpdir(), "hermes-v21-release-"));
const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

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

const extended = [
  "reflect_on_task", "search_reflections", "list_reflections", "retrieve_heuristics",
  "list_heuristics", "search_heuristics", "add_heuristic", "delete_heuristic",
  "memory_board_write", "memory_board_read", "user_profile_write", "user_profile_read",
  "get_open_questions", "get_memory_item", "resolve_open_question", "search_sessions",
  "append_session_turn", "get_recent_reflections", "export_data", "import_data", "clear_data",
  "capture_memory_snapshot", "session_lifecycle_hook", "scan_memory_threats",
  "scroll_session_context", "trigger_background_review", "list_pending_mutations",
  "approve_pending_mutation", "compact_session_context",
];

const v21Tests = [
  "scripts/v21-session-scope-test.mjs",
  "scripts/v21-session-integration-test.mjs",
  "scripts/v21-hook-pump-test.mjs",
  "scripts/v21-idempotency-test.mjs",
  "scripts/v21-reflection-transaction-test.mjs",
  "scripts/v21-lock-holder.ps1",
  "scripts/v21-review-safety-test.mjs",
  "scripts/v21-model-visible-safety-test.mjs",
  "scripts/v21-compaction-test.mjs",
  "scripts/v21-release-test.mjs",
  "scripts/v21.1-hook-contract-test.mjs",
  "scripts/v21.1-session-storage-test.mjs",
  "scripts/v21.1-lifecycle-test.mjs",
  "scripts/v21.1-context-review-test.mjs",
  "scripts/v21.1-hooks-install-test.mjs",
  "scripts/install-codex-hooks.mjs",
];

const retainedLegacyTests = [
  "scripts/v19.3-regression-test.mjs",
  "scripts/v19.3-integration-test.mjs",
  "scripts/v19.4-regression-test.mjs",
  "scripts/v19.4.1-regression-test.mjs",
  "scripts/v19.5-context-budget-regression-test.mjs",
  "scripts/v20-test-helpers.mjs",
  "scripts/v20-tool-registry-test.mjs",
  "scripts/v20-response-budget-test.mjs",
  "scripts/v20-migration-test.mjs",
  "scripts/v20-retrieval-test.mjs",
  "scripts/v20-background-test.mjs",
  "scripts/v20-lifecycle-test.mjs",
  "scripts/v20-storage-transaction-test.mjs",
  "scripts/v20-agent-eval.mjs",
];

function sourceVersion(source, label) {
  const match = source.match(/(?:SERVER_VERSION|VERSION)\s*=\s*["']([^"']+)["']/);
  assert.ok(match, `${label} does not declare a version constant`);
  return match[1];
}

function scalarSchemaAccepts(schema, value) {
  if (schema.anyOf) return schema.anyOf.some((candidate) => scalarSchemaAccepts(candidate, value));
  if (schema.oneOf) return schema.oneOf.filter((candidate) => scalarSchemaAccepts(candidate, value)).length === 1;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (schema.minLength !== undefined && Array.from(value).length < schema.minLength) return false;
    if (schema.maxLength !== undefined && Array.from(value).length > schema.maxLength) return false;
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) return false;
  }
  return true;
}

function generatedAccepts(tool, field, value, present = true) {
  const property = tool.inputSchema?.properties?.[field];
  assert.ok(property, `${tool.name}.${field} is missing from generated JSON Schema`);
  if (!present) return !(tool.inputSchema.required ?? []).includes(field);
  return scalarSchemaAccepts(property, value);
}

function canonicalRelative(rootReal, targetReal) {
  const path = relative(rootReal, targetReal).replaceAll("\\", "/");
  assert.ok(path && path !== ".." && !path.startsWith("../") && !isAbsolute(path),
    `package entry escapes project root: ${targetReal}`);
  return path;
}

const forbiddenPackagePath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|config\.json|mem\.md|AGENTS\.md|SKILL\.md|\.git|\.claude|node_modules|logs?|indexes?|cache|caches|\.cache|\.pytest_cache|__pycache__|databases?|backup|backups|release|output)(?:\/|$)|(?:^|\/)docs\/superpowers(?:\/|$)|(?:^|\/)(?:TASKS?[^/]*|(?:internal[-_])?(?:spec|plan)[^/]*)\.md$|\.(?:log|pyc|pyo|db|sqlite|sqlite3|bak|backup|zip|tar|tgz|gz|7z|rar)$/i;

for (const path of [
  "src/mem.md", "dist/logs/app.log", "src/cache/item.json", "dist/state.sqlite",
  "docs/superpowers/plan.md", "src/TASKS_v21.md", "dist/backup/store.json", "output/archive.zip",
]) {
  assert.equal(forbiddenPackagePath.test(path), true, `hygiene policy failed to reject nested path: ${path}`);
}
for (const path of ["src/index.ts", "dist/index.js", "scripts/v21-release-test.mjs"]) {
  assert.equal(forbiddenPackagePath.test(path), false, `hygiene policy rejected public source: ${path}`);
}

async function expandPackageFiles(projectRoot, entries) {
  const rootReal = await realpath(projectRoot);
  const expanded = [];
  const seen = new Set();

  async function visit(candidate) {
    const stat = await lstat(candidate);
    assert.equal(stat.isSymbolicLink(), false, `package entry must not be a symlink: ${candidate}`);
    const targetReal = await realpath(candidate);
    const canonical = canonicalRelative(rootReal, targetReal);
    assert.equal(forbiddenPackagePath.test(canonical), false, `package contains forbidden path: ${canonical}`);
    if (stat.isDirectory()) {
      const children = (await readdir(candidate)).sort();
      for (const child of children) await visit(join(candidate, child));
      return;
    }
    assert.equal(stat.isFile(), true, `package entry is not a regular file: ${canonical}`);
    assert.equal(seen.has(canonical), false, `package manifest expands the same file twice: ${canonical}`);
    seen.add(canonical);
    expanded.push({ absolute: targetReal, relative: canonical, size: stat.size });
  }

  for (const entry of entries) {
    assert.equal(typeof entry, "string", "package files entries must be strings");
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    assert.ok(normalized && !isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith("../"),
      `unsafe package files entry: ${entry}`);
    assert.equal(forbiddenPackagePath.test(normalized), false, `package files allow-list contains forbidden entry: ${entry}`);
    await visit(resolve(projectRoot, normalized));
  }
  return expanded;
}

const secretFindings = [
  ["GitHub token", /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9]{20,}\b/g],
  ["Bearer credential", /\bBearer\s+(?!\$\{|<)([A-Za-z0-9._-]{12,})/gi],
  ["API key assignment", /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token)\s*[:=]\s*(?:["']([A-Za-z0-9_./+=-]{12,})["']|([A-Za-z0-9_+/=-]{16,}))/gi],
  ["private key header", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["URL userinfo credential", /\bhttps?:\/\/[^/\s:@'"`]+:[^/\s@'"`]+@[^/\s'"`]+(?:\/[^\s'"`]*)?/gi],
  ["Windows absolute path", /(?<![A-Za-z0-9])[A-Za-z]:(?:\\+|\/)[^\r\n'"`]+?(?=\s+(?:https?:\/\/|[A-Za-z]:(?:\\+|\/)|\/(?:Users|home)\/)|\s+\+\s+|['"`]|$)/g],
  ["macOS user path", /\/Users\/[^\r\n'"`]+/g],
  ["Linux home path", /\/home\/[^\s'"`]+/g],
];

const backslash = String.fromCharCode(92);
const requiredScannerSamples = [
  "https://" + "alice:correct-horse-battery@example.com/private",
  ["D:", "Download games", "private", "config.json"].join(backslash),
  ["D:", "Download games", "private", "config.json"].join(backslash.repeat(2)),
  "D:/" + "Download games/private/config.json",
  "/Users/" + "alice/private/config.json",
];
for (const sample of requiredScannerSamples) {
  const detected = secretFindings.some(([, pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(sample);
  });
  assert.equal(detected, true, `secret/path scanner missed a required concrete sample`);
}

const publicFixtureMatches = new Map([
  ["GitHub token\0scripts/v20-background-test.mjs", new Set([
    "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890",
  ])],
  ["Bearer credential\0scripts/v19.3-regression-test.mjs", new Set([
    "Bearer " + "fake-loopback-key",
  ])],
  ["Bearer credential\0scripts/v21-model-visible-safety-test.mjs", new Set([
    "Bearer " + "BEARER-V21-SUPER-SECRET",
  ])],
  ["API key assignment\0scripts/v20-response-budget-test.mjs", new Set([
    "api_" + "key=test_fixture_secret_123456",
  ])],
  ["API key assignment\0scripts/v21-model-visible-safety-test.mjs", new Set([
    "api_" + "key=v21-api-secret-value",
  ])],
  ["private key header\0scripts/v21-model-visible-safety-test.mjs", new Set([
    "-----BEGIN " + "PRIVATE KEY-----",
  ])],
  ["URL userinfo credential\0scripts/v21-model-visible-safety-test.mjs", new Set([
    "https://" + "url-user-v21:url-pass-v21@example.test/private",
  ])],
  ["URL userinfo credential\0scripts/v21-session-integration-test.mjs", new Set([
    "https://" + "user:pass@example.test",
  ])],
  ["Windows absolute path\0scripts/v19.3-regression-test.mjs", new Set([
    ["C:", "Users", "Alice", "private.txt"].join(backslash.repeat(2)),
  ])],
  ["Windows absolute path\0src/redaction.ts", new Set([
    ["C:", "Users", "<USER>"].join(backslash.repeat(2)),
  ])],
  ["Windows absolute path\0dist/src/redaction.js", new Set([
    ["C:", "Users", "<USER>"].join(backslash.repeat(2)),
  ])],
]);

function isExplicitFixture(label, relativePath, finding) {
  return publicFixtureMatches.get(`${label}\0${relativePath}`)?.has(finding) === true;
}

function isPlaceholderPath(label, finding) {
  if (label === "Windows absolute path") {
    return /^[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)<YOU>(?:(?:\\+|\/)|$)/i.test(finding);
  }
  if (label === "macOS user path") return /^\/Users\/<YOU>(?:\/|$)/.test(finding);
  if (label === "Linux home path") return /^\/home\/<YOU>(?:\/|$)/.test(finding);
  return false;
}

const allowedGithubFixture = "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890";
const differentGithubFinding = "ghp_" + "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
assert.equal(isExplicitFixture("GitHub token", "scripts/v20-background-test.mjs", allowedGithubFixture), true);
assert.equal(isExplicitFixture("GitHub token", "scripts/v20-background-test.mjs", differentGithubFinding), false,
  "an allowed fixture elsewhere on the same line must not allow a different token match");
assert.equal(isExplicitFixture("GitHub token", "scripts/v21-model-visible-safety-test.mjs", allowedGithubFixture), false,
  "fixture allowance must bind to its exact test path");
const slash = String.fromCharCode(92);
assert.equal(isPlaceholderPath("Windows absolute path", ["C:", "Users", "<YOU>", "safe"].join(slash)), true);
assert.equal(isPlaceholderPath("Windows absolute path", ["C:", "Users", "<YOU>", "safe"].join(slash.repeat(2))), true);
assert.equal(isPlaceholderPath("Windows absolute path", "C:/" + "Users/<YOU>/safe"), true);
assert.equal(isPlaceholderPath("macOS user path", "/" + "Users/<YOU>/safe"), true);
assert.equal(isPlaceholderPath("Linux home path", "/" + "home/<YOU>/safe"), true);
assert.equal(isPlaceholderPath("Windows absolute path", ["C:", "Users", "Alice", "private"].join(slash)), false,
  "a placeholder elsewhere on the same line must not allow a concrete path match");
assert.equal(isPlaceholderPath("Windows absolute path", ["C:", "Users", "<USER>", "safe"].join(slash)), false,
  "only the documented <YOU> placeholder is generic; <USER> requires an exact finding mapping");

function firstFinding(label, sample) {
  const pattern = secretFindings.find(([candidate]) => candidate === label)?.[1];
  assert.ok(pattern, `missing scanner pattern for ${label}`);
  pattern.lastIndex = 0;
  const finding = pattern.exec(sample)?.[0];
  assert.ok(finding, `scanner did not produce a finding for ${label}`);
  return finding;
}

const concreteWindowsLine = "Private path: "
  + ["C:", "Users", "Alice", "secret"].join(slash)
  + "; replace <YOU> in the example";
const concreteMacLine = "/" + "Users/Alice/secret; replace <YOU>";
const concreteLinuxLine = "/" + "home/alice/secret; replace <YOU>";
assert.equal(isPlaceholderPath("Windows absolute path", firstFinding("Windows absolute path", concreteWindowsLine)), false);
assert.equal(isPlaceholderPath("macOS user path", firstFinding("macOS user path", concreteMacLine)), false);
assert.equal(isPlaceholderPath("Linux home path", firstFinding("Linux home path", concreteLinuxLine)), false);

async function scanPackagedText(files) {
  for (const file of files) {
    assert.ok(file.size <= MAX_SCANNED_FILE_BYTES,
      `packaged file exceeds bounded scan limit (${MAX_SCANNED_FILE_BYTES} bytes): ${file.relative}`);
    const bytes = await readFile(file.absolute);
    assert.equal(bytes.includes(0), false, `binary packaged file is not allow-listed for safe scanning: ${file.relative}`);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      assert.fail(`packaged file is not valid UTF-8 and cannot be safely scanned: ${file.relative}`);
    }
    for (const [label, pattern] of secretFindings) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const finding = match[0];
        const placeholderPath = isPlaceholderPath(label, finding);
        assert.ok(placeholderPath || isExplicitFixture(label, file.relative, finding),
          `${label} found in packaged text: ${file.relative}`);
      }
    }
  }
}

try {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const sourceIndex = await readFile(join(root, "index.ts"), "utf8");
  const sourceStorage = await readFile(join(root, "storage.ts"), "utf8");
  const sourceRegistry = await readFile(join(root, "src", "tool_registry.ts"), "utf8");

  assert.equal(packageJson.version, EXPECTED_VERSION, "package.json release version");
  assert.equal(packageLock.version, EXPECTED_VERSION, "package-lock.json release version");
  assert.equal(packageLock.packages?.[""]?.version, EXPECTED_VERSION, "package-lock root package version");
  assert.equal(sourceVersion(sourceIndex, "index.ts SERVER_VERSION"), EXPECTED_VERSION);
  assert.equal(sourceVersion(sourceStorage, "storage.ts VERSION"), EXPECTED_VERSION);

  const coreSource = sourceRegistry.match(/export const CORE_TOOL_NAMES = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  const sourceCoreNames = [...coreSource.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
  const sourceExtendedNames = [...sourceRegistry.matchAll(/register\("([a-z0-9_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sourceCoreNames, core, "Agent-first core profile must be exact and ordered");
  assert.deepEqual(sourceExtendedNames, extended, "extended compatibility profile must be exact");
  assert.equal(new Set(extended).size, 29, "extended compatibility profile contains duplicates");

  const instructions = sourceIndex.match(/const SERVER_INSTRUCTIONS = `([^`]*)`;/)?.[1] ?? "";
  assert.ok(instructions.length > 0, "server instructions are missing");
  assert.ok(Array.from(instructions).length <= 512, `server instructions=${Array.from(instructions).length}`);

  for (const file of [...retainedLegacyTests, ...v21Tests]) {
    assert.ok(packageJson.files.includes(file), `package files allow-list is missing ${file}`);
  }
  const expandedPackageFiles = await expandPackageFiles(root, packageJson.files);
  await scanPackagedText(expandedPackageFiles);

  if (runtimeRequested) {
    const registry = await import(`${pathToFileURL(join(runtimeRoot, "src", "tool_registry.js")).href}?release=${Date.now()}`);
    const storage = await import(`${pathToFileURL(join(runtimeRoot, "storage.js")).href}?release=${Date.now()}`);
    const runtimeIndex = await readFile(serverEntry, "utf8");
    assert.equal(sourceVersion(runtimeIndex, "runtime SERVER_VERSION"), EXPECTED_VERSION);
    assert.equal(storage.VERSION, EXPECTED_VERSION, "runtime storage VERSION");
    assert.ok(resolve(storage.STORE_DIR).startsWith(`${resolve(tempHome)}${process.platform === "win32" ? "\\" : "/"}`),
      `runtime storage escaped temporary HOME: ${storage.STORE_DIR}`);
    assert.deepEqual(registry.profileToolNames("core"), core, "built core profile drifted");
    assert.deepEqual(registry.profileToolNames("extended"), extended, "built extended profile drifted");

    const listed = registry.listRegisteredTools();
    assert.deepEqual(listed.map((tool) => tool.name), extended, "generated tool registry order drifted");
    const byName = new Map(listed.map((tool) => [tool.name, tool]));
    const parityCases = [
      ["reflect_on_task", "idempotency_key", {
        session_id: "release-parity", task_goal: "release parity", task_outcome: "success",
        failure_mode: "success", summary: "release validation",
      }, undefined, false, true],
      ["reflect_on_task", "idempotency_key", {
        session_id: "release-parity", task_goal: "release parity", task_outcome: "success",
        failure_mode: "success", summary: "release validation",
      }, "release-key-1", true, true],
      ["reflect_on_task", "idempotency_key", {
        session_id: "release-parity", task_goal: "release parity", task_outcome: "success",
        failure_mode: "success", summary: "release validation",
      }, "", true, false],
      ["retrieve_heuristics", "project_key", { task_description: "release parity" }, undefined, false, true],
      ["retrieve_heuristics", "project_key", { task_description: "release parity" }, "project:release", true, true],
      ["retrieve_heuristics", "project_key", { task_description: "release parity" }, "unsafe project", true, false],
      ["compact_session_context", "project_key", { session_id: "release-parity" }, "project:release", true, true],
      ["compact_session_context", "project_key", { session_id: "release-parity" }, "unsafe project", true, false],
      ["trigger_background_review", "project_key", { action: "status", session_id: "release-parity" }, undefined, false, true],
      ["trigger_background_review", "project_key", { action: "status", session_id: "release-parity" }, "project:release", true, true],
      ["trigger_background_review", "project_key", { action: "status", session_id: "release-parity" }, "unsafe project", true, false],
    ];
    for (const [toolName, field, base, value, present, expected] of parityCases) {
      const args = present ? { ...base, [field]: value } : base;
      const runtimeAccepted = (() => {
        try { registry.parseToolInput(toolName, args); return true; } catch { return false; }
      })();
      const schemaAccepted = generatedAccepts(byName.get(toolName), field, value, present);
      assert.equal(schemaAccepted, expected, `${toolName}.${field} generated JSON Schema result`);
      assert.equal(runtimeAccepted, expected, `${toolName}.${field} runtime parse result`);
    }
    const coreMetadata = Array.from(instructions).length + core.reduce((sum, name) => {
      const tool = byName.get(name);
      assert.ok(tool, `core tool ${name} is not registered`);
      return sum + Array.from(tool.description ?? "").length + Array.from(JSON.stringify(tool.inputSchema)).length;
    }, 0);
    assert.ok(coreMetadata <= 15_000, `core schema-inclusive metadata=${coreMetadata}`);
    console.log(`[PASS] v21 built/installed release contract (${extended.length} tools, ${expandedPackageFiles.length} files, core metadata ${coreMetadata} chars)`);
  } else {
    console.log(`[PASS] v21 source/package release contract (${extended.length} tools, ${expandedPackageFiles.length} files)`);
    console.log("[SKIP] built runtime parity in static mode; rerun with --runtime or HERMES_SERVER_ENTRY (the selected entry's package tree will be scanned)");
  }
} finally {
  const safeTempHome = resolve(tempHome);
  assert.ok(safeTempHome.startsWith(resolve(tmpdir())), `unsafe temporary HOME cleanup: ${safeTempHome}`);
  await rm(safeTempHome, { recursive: true, force: true });
}
