import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalCodexHooksJson, mergeCodexHooks } from "../dist/src/codex_hooks_config.js";

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage: node scripts/install-codex-hooks.mjs --hooks <hooks.json> --install-dir <dir> [--node <node>] [--capture] [--dry-run]\n");
  process.exitCode = 2;
}

function parseArgs(argv) {
  const parsed = { capture: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--capture") parsed.capture = true;
    else if (item === "--dry-run") parsed.dryRun = true;
    else if (item === "--hooks" || item === "--install-dir" || item === "--node") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${item} requires a value`);
      parsed[item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${item}`);
  }
  if (!parsed.hooks || !parsed.installDir) throw new Error("--hooks and --install-dir are required");
  return parsed;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function requireRegularFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new Error(`${label} must be an existing regular file: ${path}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be an existing regular file: ${path}`);
  }
  return realpath(path);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage(error instanceof Error ? error.message : "Invalid arguments");
    return;
  }
  const hooksPath = resolve(args.hooks);
  const installDir = resolve(args.installDir);
  const nodePath = await requireRegularFile(resolve(args.node ?? process.execPath), "Node executable");
  const hookCliPath = await requireRegularFile(
    join(installDir, "dist", "src", "codex_hook_cli.js"),
    "Hermes hook CLI",
  );
  const raw = await readFile(hooksPath, "utf8");
  const existing = JSON.parse(raw);
  const merged = mergeCodexHooks(existing, {
    node_path: nodePath,
    hook_cli_path: hookCliPath,
    capture_enabled: args.capture,
  });
  const output = canonicalCodexHooksJson(merged);
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dry_run: true,
      changed: output !== raw,
      hooks_path: hooksPath,
      capture_enabled: args.capture,
    }, null, 2)}\n`);
    return;
  }

  const directory = dirname(hooksPath);
  await mkdir(directory, { recursive: true });
  const backupPath = `${hooksPath}.pre-hermes-v22.0.0-${timestamp()}.bak`;
  const tempPath = join(directory, `.${randomUUID()}.hermes-hooks.tmp`);
  let handle;
  try {
    await copyFile(hooksPath, backupPath);
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(output, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    JSON.parse(await readFile(tempPath, "utf8"));
    await rename(tempPath, hooksPath);
    await syncDirectory(directory);
    JSON.parse(await readFile(hooksPath, "utf8"));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dry_run: false,
    hooks_path: hooksPath,
    backup_path: backupPath,
    capture_enabled: args.capture,
  }, null, 2)}\n`);
}

await main().catch((error) => {
  process.stderr.write(`Hermes Codex hook install failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
