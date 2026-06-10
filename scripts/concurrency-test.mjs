import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "fs/promises";
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
});
const client = new Client({ name: "hermes-concurrency", version: "1.0.0" });

try {
  await client.connect(transport);

  await call(client, "add_heuristic", {
    domain: "concurrency",
    heuristic: "concurrent retrieval count survives mixed reflection writes",
    source_task: "concurrency test setup",
    confidence: 0.9,
    tags: ["concurrency"],
  });

  await Promise.all([
    ...Array.from({ length: 5 }, (_, index) =>
      call(client, "retrieve_heuristics", {
        task_description: "concurrent retrieval count survives mixed reflection writes",
        domain: "concurrency",
        tags: ["concurrency"],
        min_confidence: 0.3,
      })
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      call(client, "reflect_on_task", {
        session_id: "concurrency-session",
        task_goal: `concurrency mixed reflection ${index}`,
        task_outcome: "success",
        failure_mode: "success",
        summary: "Concurrent reflection write while retrieval stats are being persisted.",
        domain: "concurrency",
        tags: ["concurrency"],
      })
    ),
  ]);

  const exported = JSON.parse(text(await call(client, "export_data", { collection: "all" })));
  const target = exported.heuristics.find(
    (item) => item.heuristic === "concurrent retrieval count survives mixed reflection writes"
  );
  assert(target, "target heuristic should exist after concurrent calls.");
  assert(
    (target.retrieval_count ?? 0) >= 5,
    `expected retrieval_count >= 5, got ${target.retrieval_count ?? 0}`
  );
  const reflectionCount = exported.reflections.filter(
    (item) => item.session_id === "concurrency-session"
  ).length;
  assert(reflectionCount === 5, `expected 5 concurrent reflections, got ${reflectionCount}`);

  console.log(`Hermes concurrency test passed with temporary HOME: ${tempHome}`);
} finally {
  await client.close().catch(() => undefined);
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  await rm(tempHome, { recursive: true, force: true });
}
