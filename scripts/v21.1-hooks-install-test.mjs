import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const ownedRoot = await mkdtemp(join(tmpdir(), "hermes-v21.1-hooks-"));
const slash = String.fromCharCode(92);
const nodePath = ["C:", "Program Files", "nodejs", "node.exe"].join(slash);
const hookCliPath = ["C:", "Codex MCP", "dist", "src", "codex_hook_cli.js"].join(slash);
const oldHookCliPath = ["C:", "Users", "test", ".codex", "mcp", "hermes-reflection-mcp", "dist", "src", "codex_hook_cli.js"].join(slash);
const versionedOldHookCliPath = ["C:", "Users", "test", ".codex", "mcp", "hermes-reflection-mcp-v21.0.0", "dist", "src", "codex_hook_cli.js"].join(slash);
const unrelatedOne = `& "${["E:", "node", "node.exe"].join(slash)}" "${["E:", "clawd", "Clawd on Desk", "resources", "codex-hook.js"].join(slash)}"`;
const unrelatedTwo = `powershell -NoProfile -File "${["C:", "Other Product", "hook.ps1"].join(slash)}"`;

function assertOwned(path) {
  const suffix = relative(resolve(ownedRoot), resolve(path));
  assert.equal(isAbsolute(suffix), false, `path escaped owned root: ${path}`);
  assert.notEqual(suffix, "..");
  assert.equal(suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), false);
}

function fixture() {
  return {
    version: 7,
    hooks: {
      SessionStart: [{ matcher: "", hooks: [
        { type: "command", command: unrelatedOne, timeout: 30 },
        { type: "command", command: `& "${["E:", "node", "node.exe"].join(slash)}" "${oldHookCliPath}"`, timeout: 9 },
        { type: "command", command: unrelatedTwo, timeout: 40 },
      ] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: unrelatedOne, timeout: 30 }] }],
      Stop: [{ hooks: [
        { type: "command", command: unrelatedTwo, timeout: 40 },
        { type: "command", command: `node "${oldHookCliPath}"`, timeout: 3 },
      ] }],
      CustomProductEvent: [{ hooks: [{ type: "command", command: unrelatedOne, timeout: 30 }] }],
    },
    other_product_config: { enabled: true, sequence: [3, 1, 2] },
  };
}

function allCommands(value, eventName) {
  return (value.hooks?.[eventName] ?? []).flatMap((group) => group.hooks ?? [])
    .map((hook) => hook.command)
    .filter((command) => typeof command === "string");
}

function nonHermesCommands(value, isHermesHookCommand) {
  return Object.entries(value.hooks ?? {}).flatMap(([eventName, groups]) =>
    groups.flatMap((group) => (group.hooks ?? [])
      .filter((hook) => !isHermesHookCommand(hook.command ?? ""))
      .map((hook) => [eventName, structuredClone(hook)])));
}

async function runInstaller(args) {
  const child = spawn(process.execPath, [resolve("scripts/install-codex-hooks.mjs"), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: ownedRoot, USERPROFILE: ownedRoot },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

try {
  const config = await import("../dist/src/codex_hooks_config.js");
  const isHermes = (command) => config.isHermesHookCommand(command, hookCliPath)
    || config.isHermesHookCommand(command);
  const installedHookCliPath = resolve("dist", "src", "codex_hook_cli.js");
  const isInstalledHermes = (command) => config.isHermesHookCommand(command, installedHookCliPath)
    || config.isHermesHookCommand(command);
  const existing = fixture();
  const options = { node_path: nodePath, hook_cli_path: hookCliPath, capture_enabled: false };
  const merged = config.mergeCodexHooks(existing, options);
  assert.deepEqual(merged.other_product_config, existing.other_product_config);
  assert.deepEqual(nonHermesCommands(merged, isHermes),
    nonHermesCommands(existing, isHermes), "unrelated hook handlers or order changed");
  assert.deepEqual(
    ["SessionStart", "SessionEnd", "PreCompact", "PostCompact"].map((event) =>
      [event, allCommands(merged, event).filter(isHermes).length]),
    [["SessionStart", 1], ["SessionEnd", 1], ["PreCompact", 1], ["PostCompact", 1]],
  );
  assert.equal(allCommands(merged, "UserPromptSubmit").filter(isHermes).length, 0);
  assert.equal(allCommands(merged, "Stop").filter(isHermes).length, 0);
  const otherHook = ["C:", "not-hermes", "codex_hook_cli.js"].join(slash);
  assert.equal(config.isHermesHookCommand(`${nodePath} "${otherHook}"`, hookCliPath), false,
    "basename-only matching would remove another product");
  assert.equal(config.isHermesHookCommand(`& "${nodePath}" "${hookCliPath}"`, hookCliPath), true);
  assert.equal(config.isHermesHookCommand(`& "${nodePath}" "${versionedOldHookCliPath}"`), true,
    "versioned obsolete Hermes hook path was not recognized exactly");

  const capture = config.mergeCodexHooks(existing, { ...options, capture_enabled: true });
  assert.equal(allCommands(capture, "UserPromptSubmit").filter(isHermes).length, 1);
  assert.equal(allCommands(capture, "Stop").filter(isHermes).length, 1);
  const canonical = config.canonicalCodexHooksJson(capture);
  assert.equal(config.canonicalCodexHooksJson(config.mergeCodexHooks(JSON.parse(canonical), {
    ...options,
    capture_enabled: true,
  })), canonical, "remerge is not byte-stable");
  assert.throws(() => config.mergeCodexHooks({ hooks: { Stop: "not-an-array" } }, options), /Stop.*array/i);
  assert.throws(() => config.mergeCodexHooks({ hooks: { Stop: [{ hooks: [{ type: "command" }] }] } }, options),
    /command/i);

  const hooksPath = join(ownedRoot, "profile with space", "hooks.json");
  assertOwned(hooksPath);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(hooksPath), { recursive: true }));
  await writeFile(hooksPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  const beforeDryRun = await readFile(hooksPath, "utf8");
  const dry = await runInstaller([
    "--hooks", hooksPath,
    "--install-dir", resolve("."),
    "--node", process.execPath,
    "--dry-run",
  ]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(await readFile(hooksPath, "utf8"), beforeDryRun, "dry-run changed hooks.json");
  assert.match(dry.stdout, /dry_run/i);
  assert.doesNotMatch(dry.stdout + dry.stderr, /Clawd on Desk|Other Product/,
    "installer printed unrelated hook content");

  const missingNode = await runInstaller([
    "--hooks", hooksPath,
    "--install-dir", resolve("dist", ".."),
    "--node", join(ownedRoot, "missing-node.exe"),
    "--dry-run",
  ]);
  assert.notEqual(missingNode.code, 0, "installer accepted a missing Node executable");
  assert.match(missingNode.stderr, /node executable.*regular file/i);

  const missingInstall = await runInstaller([
    "--hooks", hooksPath,
    "--install-dir", join(ownedRoot, "missing-install"),
    "--node", process.execPath,
    "--dry-run",
  ]);
  assert.notEqual(missingInstall.code, 0, "installer accepted a missing hook CLI");
  assert.match(missingInstall.stderr, /hook cli.*regular file/i);

  const applied = await runInstaller([
    "--hooks", hooksPath,
    "--install-dir", resolve("."),
    "--node", process.execPath,
    "--capture",
  ]);
  assert.equal(applied.code, 0, applied.stderr);
  const installed = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.deepEqual(nonHermesCommands(installed, isInstalledHermes),
    nonHermesCommands(existing, isInstalledHermes));
  assert.equal(allCommands(installed, "Stop").filter(isInstalledHermes).length, 1);
  const reported = JSON.parse(applied.stdout);
  assert.equal(reported.ok, true);
  assert.equal(reported.capture_enabled, true);
  assert.ok(reported.backup_path);
  assert.deepEqual(JSON.parse(await readFile(reported.backup_path, "utf8")), existing,
    "backup does not preserve the original parsed value");
  await stat(reported.backup_path);
  assert.doesNotMatch(applied.stdout + applied.stderr, /Clawd on Desk|Other Product/);
  console.log("[PASS] v21.1 structural Codex hooks installer");
} finally {
  assertOwned(ownedRoot);
  await rm(ownedRoot, { recursive: true, force: true });
}
