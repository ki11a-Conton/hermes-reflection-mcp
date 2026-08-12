import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "hermes-v21.1-hook-contract-"));
const home = join(root, "profile");
const cwd = join(root, "Project With Spaces", "工程");
const hookCli = resolve("dist/src/codex_hook_cli.js");
const failures = [];

function assertOwnedTempPath(path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const suffix = relative(resolvedRoot, resolvedPath);
  assert.equal(isAbsolute(suffix), false, `temporary path escaped owned root: ${resolvedPath}`);
  assert.notEqual(suffix, "..", `temporary path escaped owned root: ${resolvedPath}`);
  assert.equal(suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), false,
    `temporary path escaped owned root: ${resolvedPath}`);
}

async function runHook(input, captureEnabled = false) {
  const child = spawn(process.execPath, [hookCli], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HERMES_REFLECTION_CODEX_TURN_CAPTURE: captureEnabled ? "true" : "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  const timeout = setTimeout(() => child.kill(), 10_000);
  timeout.unref();
  const [code] = await once(child, "close");
  clearTimeout(timeout);
  let output;
  try {
    output = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`hook CLI emitted invalid JSON (code ${code}): ${stdout}\n${stderr}`, { cause: error });
  }
  return { code, output, stderr };
}

async function storeContains(needle) {
  const target = Buffer.from(needle, "utf8");
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (await visit(child)) return true;
      } else if ((await readFile(child)).includes(target)) {
        return true;
      }
    }
    return false;
  }
  return visit(join(home, ".hermes-reflection"));
}

async function check(name, callback) {
  try {
    await callback();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  await Promise.all([mkdir(home, { recursive: true }), mkdir(cwd, { recursive: true })]);
  assertOwnedTempPath(home);
  assertOwnedTempPath(cwd);

  await check("capture-disabled events discard content before durable enqueue", async () => {
    const marker = "PRIVATE-DISABLED-MARKER-7b58a7";
    const prompt = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "capture-disabled-session",
      turn_id: "turn-1",
      prompt: marker,
    });
    assert.equal(prompt.code, 0, prompt.stderr);
    assert.deepEqual(prompt.output, {
      ok: true,
      accepted: false,
      duplicate: false,
      status: "capture_disabled",
    });
    assert.equal(await storeContains(marker), false, "disabled prompt entered durable state");

    const assistantMarker = "PRIVATE-DISABLED-ASSISTANT-4fc911";
    const stop = await runHook({
      hook_event_name: "Stop",
      session_id: "capture-disabled-session",
      turn_id: "turn-1",
      stop_hook_active: false,
      last_assistant_message: assistantMarker,
    });
    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(stop.output, {
      ok: true,
      accepted: false,
      duplicate: false,
      status: "capture_disabled",
    });
    assert.equal(await storeContains(assistantMarker), false, "disabled assistant message entered durable state");
  });

  await check("official PostCompact succeeds without Hermes extension metadata", async () => {
    const post = await runHook({
      hook_event_name: "PostCompact",
      session_id: "official-postcompact-session",
      turn_id: "turn-9",
      trigger: "auto",
    });
    assert.equal(post.code, 0, post.stderr);
    assert.equal(post.output.ok, true);
    assert.equal(post.output.accepted, true);
  });

  await check("turn-scoped derived identities deduplicate exact retry and separate turns", async () => {
    const base = {
      hook_event_name: "UserPromptSubmit",
      session_id: "identity-session",
      turn_id: "turn-a",
      prompt: "bounded prompt",
    };
    const first = await runHook(base, true);
    const duplicate = await runHook(base, true);
    const nextTurn = await runHook({ ...base, turn_id: "turn-b" }, true);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(nextTurn.code, 0, nextTurn.stderr);
    assert.equal(first.output.accepted, true);
    assert.equal(duplicate.output.duplicate, true);
    assert.equal(nextTurn.output.accepted, true);
    assert.equal(first.output.event_id, duplicate.output.event_id);
    assert.notEqual(first.output.event_id, nextTurn.output.event_id);
  });

  await check("enabled capture hashes only the bounded redacted projection", async () => {
    const shared = "x".repeat(12_000);
    const first = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "bounded-hash-session",
      turn_id: "turn-bounded",
      prompt: `${shared}PRIVATE-TAIL-ONE`,
    }, true);
    const sameProjectionRetry = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "bounded-hash-session",
      turn_id: "turn-bounded",
      prompt: `${shared}PRIVATE-TAIL-TWO`,
    }, true);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(sameProjectionRetry.code, 0, sameProjectionRetry.stderr);
    assert.equal(sameProjectionRetry.output.duplicate, true,
      "discarded text beyond the capture limit changed durable identity");
    assert.equal(first.output.event_id, sameProjectionRetry.output.event_id);
    assert.equal(await storeContains("PRIVATE-TAIL-ONE"), false);
    assert.equal(await storeContains("PRIVATE-TAIL-TWO"), false);

    const secret = "ghp_" + "S".repeat(36);
    const secretCapture = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "redacted-hash-session",
      turn_id: "turn-secret",
      prompt: `credential ${secret}`,
    }, true);
    assert.equal(secretCapture.code, 0, secretCapture.stderr);
    assert.equal(await storeContains(secret), false, "raw secret survived capture preparation");
  });

  await check("lifecycle events without retry keys do not collapse distinct compact starts", async () => {
    const input = {
      hook_event_name: "SessionStart",
      session_id: "compact-start-session",
      source: "compact",
    };
    const first = await runHook(input);
    const second = await runHook(input);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(first.output.accepted, true);
    assert.equal(second.output.accepted, true);
    assert.notEqual(first.output.event_id, second.output.event_id);
  });

  assert.equal(failures.length, 0,
    `${failures.length} hook contract behavior(s) failed:\n${failures.map(({ name, error }) =>
      `- ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`).join("\n")}`);
  console.log("[PASS] v21.1 Codex hook contract");
} finally {
  assertOwnedTempPath(root);
  await rm(root, { recursive: true, force: true });
}
