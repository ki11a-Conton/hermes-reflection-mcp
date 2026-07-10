import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../dist/src/file_lock.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function text(result) {
  return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

async function connect(name, home) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name} failed:\n${text(result)}`);
  return result;
}

async function runStaleOwnershipRegression(home) {
  const target = join(home, "stale-owner-probe.json");
  let active = 0;
  let overlapDetected = false;
  let signalAcquired;
  const acquired = new Promise((resolve) => {
    signalAcquired = resolve;
  });

  const enter = async (holdMs, signal = false) => {
    active += 1;
    if (active > 1) overlapDetected = true;
    if (signal) signalAcquired();
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    active -= 1;
  };

  const first = withFileLock(target, () => enter(200, true), {
    timeout_ms: 1000,
    retry_ms: 5,
    stale_ms: 30,
  });
  await acquired;
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = withFileLock(target, () => enter(40), {
    timeout_ms: 1000,
    retry_ms: 5,
    stale_ms: 30,
  });
  await Promise.all([first, second]);

  assert(!overlapDetected, "an active lock owner must not be replaced merely because the transaction is long-running");
  const rootFiles = await readdir(home);
  assert(!rootFiles.some((name) => name.startsWith("stale-owner-probe.json.lock")), "ownership probe left a lock artifact");
}

const home = await mkdtemp(join(tmpdir(), "hermes-cross-process-"));
const peers = [];

try {
  await runStaleOwnershipRegression(home);

  const a = await connect("cross-process-a", home);
  const b = await connect("cross-process-b", home);
  peers.push(a, b);

  for (let index = 0; index < 20; index++) {
    await Promise.all([
      call(a.client, "add_heuristic", {
        domain: "cross-process",
        heuristic: `peer_a_heuristic_${index}`,
        source_task: "cross-process-a",
        confidence: 0.8,
      }),
      call(b.client, "add_heuristic", {
        domain: "cross-process",
        heuristic: `peer_b_heuristic_${index}`,
        source_task: "cross-process-b",
        confidence: 0.8,
      }),
      call(a.client, "reflect_on_task", {
        session_id: "cross-process-a",
        task_goal: `peer-a-reflection-${index}`,
        task_outcome: "success",
        failure_mode: "success",
        summary: "Cross-process preservation probe.",
        domain: "cross-process",
        auto_extract_heuristics: false,
      }),
      call(b.client, "reflect_on_task", {
        session_id: "cross-process-b",
        task_goal: `peer-b-reflection-${index}`,
        task_outcome: "success",
        failure_mode: "success",
        summary: "Cross-process preservation probe.",
        domain: "cross-process",
        auto_extract_heuristics: false,
      }),
    ]);
  }

  await Promise.all(peers.map(({ client }) => client.close().catch(() => undefined)));
  peers.length = 0;

  const verifier = await connect("cross-process-verifier", home);
  peers.push(verifier);
  const exported = JSON.parse(text(await call(verifier.client, "export_data", { collection: "all" })));
  const heuristics = exported.heuristics.filter((item) => item.domain === "cross-process");
  const reflections = exported.reflections.filter((item) => item.domain === "cross-process");
  const expectedHeuristics = Array.from(
    { length: 20 },
    (_, index) => [`peer_a_heuristic_${index}`, `peer_b_heuristic_${index}`],
  ).flat();
  const presentHeuristics = new Set(heuristics.map((item) => item.heuristic));
  const missingHeuristics = expectedHeuristics.filter((item) => !presentHeuristics.has(item));
  const rawStore = JSON.parse(await readFile(join(home, ".hermes-reflection", "store.json"), "utf8"));
  assert(
    heuristics.length === 40 && reflections.length === 40,
    `expected 40 heuristics and 40 reflections, got ${heuristics.length} and ${reflections.length}; `
      + `write_count=${rawStore.metadata?.write_count}; missing heuristics: ${missingHeuristics.join(", ")}`,
  );

  const storeFiles = await readdir(join(home, ".hermes-reflection"));
  assert(
    !storeFiles.some((name) => name.endsWith(".lock") || name.endsWith(".tmp")),
    `stale lock/temp files: ${storeFiles.join(", ")}`,
  );
  console.log("Hermes cross-process concurrency test passed: 40 heuristics and 40 reflections preserved.");
} finally {
  await Promise.all(peers.map(({ client }) => client.close().catch(() => undefined)));
  await rm(home, { recursive: true, force: true });
}
