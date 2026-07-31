import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function text(result) {
  return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name} returned an error:\n${text(result)}`);
  return result;
}

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHome = await mkdtemp(join(tmpdir(), "hermes-concurrency-"));

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
  stderr: "pipe",
});
const client = new Client({ name: "hermes-concurrency", version: "1.0.0" });
let serverStderr = "";
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => { serverStderr += chunk; });

try {
  await client.connect(transport);

  await call(client, "add_heuristic", {
    domain: "concurrency",
    heuristic: "concurrent retrieval remains byte stable across readers",
    source_task: "concurrency test setup",
    confidence: 0.9,
    tags: ["concurrency"],
  });

  const storePath = join(tempHome, ".hermes-reflection", "store.json");
  const beforeRetrieval = await readFile(storePath);
  const retrievals = await Promise.all(
    Array.from({ length: 5 }, () =>
      call(client, "retrieve_heuristics", {
        task_description: "concurrent retrieval remains byte stable across readers",
        domain: "concurrency",
        tags: ["concurrency"],
        min_confidence: 0.3,
      })
    )
  );
  const afterRetrieval = await readFile(storePath);
  assert(beforeRetrieval.equals(afterRetrieval), "concurrent retrieval readers must not modify store bytes");
  const firstProjection = text(retrievals[0]);
  assert(
    retrievals.every((result) => text(result) === firstProjection),
    "concurrent retrieval readers must return identical result order and scores",
  );

  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      call(client, "reflect_on_task", {
        session_id: "concurrency-session",
        task_goal: `concurrency mixed reflection ${index}`,
        task_outcome: "success",
        failure_mode: "success",
        summary: "Concurrent reflection writes remain serialized independently of read-only retrieval.",
        domain: "concurrency",
        tags: ["concurrency"],
      })
    )
  );

  const exportResult = await call(client, "export_data", { collection: "all" });
  const exported = exportResult.structuredContent?.data
    ?? JSON.parse(await readFile(join(
      tempHome,
      ".hermes-reflection",
      "transfers",
      "exports",
      exportResult.structuredContent.file,
    ), "utf8"));
  const target = exported.heuristics.find(
    (item) => item.heuristic === "concurrent retrieval remains byte stable across readers"
  );
  assert(target, "target heuristic should exist after concurrent calls.");
  assert((target.retrieval_count ?? 0) === 0, "read-only retrieval must leave legacy retrieval_count unchanged");
  const reflectionCount = exported.reflections.filter(
    (item) => item.session_id === "concurrency-session"
  ).length;
  assert(reflectionCount === 5, `expected 5 concurrent reflections, got ${reflectionCount}`);
  assert(
    !/background lifecycle notification failed|background_lifecycle\.json\.lock.*(?:EPERM|EACCES)/i.test(serverStderr),
    `background lifecycle lock contention must not escape as an error:\n${serverStderr}`,
  );

  console.log(`Hermes concurrency test passed with temporary HOME: ${tempHome}`);
} finally {
  await client.close().catch(() => undefined);
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  await rm(tempHome, { recursive: true, force: true });
}
