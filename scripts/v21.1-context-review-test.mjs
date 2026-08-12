import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.argv.includes("--review") ? "review" : "context";
const ownedRoot = await mkdtemp(join(tmpdir(), `hermes-v21.1-${mode}-`));
const home = join(ownedRoot, "profile");

function assertOwned(path) {
  const suffix = relative(resolve(ownedRoot), resolve(path));
  assert.equal(isAbsolute(suffix), false, `path escaped owned root: ${path}`);
  assert.notEqual(suffix, "..", `path escaped owned root: ${path}`);
  assert.equal(suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), false,
    `path escaped owned root: ${path}`);
}

async function contextContract() {
  const { profileToolNames } = await import("../dist/src/tool_registry.js");
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
  const client = new Client({ name: "hermes-v21.1-context-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HERMES_REFLECTION_BACKGROUND_ENABLED: "false",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const instructions = client.getInstructions() ?? "";
    assert.deepEqual(profileToolNames("core"), core);
    assert.equal(listed.tools.length, 29);
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const retrieve = byName.get("retrieve_heuristics");
    assert.ok(retrieve, "retrieve_heuristics is missing");
    assert.equal(retrieve.inputSchema?.properties?.limit?.default, 3,
      "retrieve_heuristics omitted-limit default is not 3");
    assert.match(retrieve.description ?? "", /compact by default/i);
    assert.match(retrieve.description ?? "", /(?:do not use|avoid|skip)/i,
      "retrieve description lacks negative call guidance");
    assert.match(retrieve.description ?? "", /(?:current|live).*(?:source|file|url)|(?:source|file|url).*(?:current|live)/i,
      "retrieve description does not prioritize live sources");

    const first512 = Array.from(instructions).slice(0, 512).join("");
    assert.match(first512, /current user/i);
    assert.match(first512, /current (?:files|sources)|live systems/i);
    assert.match(first512, /historical reference/i);
    assert.match(first512, /never store secrets/i);
    assert.match(first512, /reflect after meaningful work/i);
    assert.ok(Array.from(instructions).length <= 512, `server instructions=${Array.from(instructions).length}`);
    const coreMetadata = Array.from(instructions).length + core.reduce((sum, name) => {
      const tool = byName.get(name);
      assert.ok(tool, `core tool ${name} is missing`);
      return sum
        + Array.from(tool.description ?? "").length
        + Array.from(JSON.stringify(tool.inputSchema)).length;
    }, 0);
    assert.ok(coreMetadata <= 15_000, `core schema-inclusive metadata=${coreMetadata}`);

    const lessons = [
      "For Codex context cost optimization, cap automatic recall at three high-value lessons.",
      "When MCP retrieval consumes context, expose opaque IDs and fetch supporting evidence on demand.",
      "Keep tool descriptions concise so agent metadata stays below the schema budget.",
      "Avoid repeated same-session memory lookup when current source files already answer the question.",
      "Prefer compact heuristic projections with confidence and identifier instead of full score breakdowns.",
    ];
    for (let index = 0; index < lessons.length; index += 1) {
      const saved = await client.callTool({
        name: "add_heuristic",
        arguments: {
          domain: "context-cost",
          heuristic: lessons[index],
          source_task: `v21.1 context fixture ${index}`,
          confidence: 0.9 - index * 0.01,
          tags: ["context-cost", `fixture-${index}`],
        },
      });
      assert.notEqual(saved.isError, true, JSON.stringify(saved));
    }
    const result = await client.callTool({
      name: "retrieve_heuristics",
      arguments: {
        task_description: "Optimize Codex MCP context cost, compact retrieval, metadata, and live-source memory lookup",
        domain: "context-cost",
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const items = result.structuredContent?.items ?? [];
    assert.equal(items.length, 3, "omitted limit did not return exactly three compact items");
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ["confidence", "heuristic", "id"],
        `compact heuristic duplicated drill-down metadata: ${JSON.stringify(item)}`);
      assert.match(item.id, /\S/);
      assert.equal(typeof item.heuristic, "string");
      assert.equal(typeof item.confidence, "number");
    }
    const detail = await client.callTool({
      name: "get_memory_item",
      arguments: { kind: "heuristic", id: items[0].id, response_mode: "full" },
    });
    assert.notEqual(detail.isError, true, JSON.stringify(detail));
    assert.equal(detail.structuredContent?.items?.[0]?.id, items[0].id);
    console.log(`[PASS] v21.1 context contract (${coreMetadata} core metadata chars)`);
  } finally {
    await client.close();
  }
}

function reflectionFixture(index, sessionId) {
  const id = `v21-1-review-${String(index).padStart(2, "0")}`;
  return {
    id,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    session_id: sessionId,
    scope: "global",
    task_goal: `Review bounded source ${index}`,
    task_outcome: "success",
    failure_mode: "success",
    task_state: {
      summary: `${id} ${"bounded-summary ".repeat(35)}`,
      immediate_blockers: [],
      active_hypotheses: [],
      proven_safe_paths: [`${id} verified`],
      exhausted_search: [],
    },
    world_model_updates: [],
    tool_insights: [],
    context_forget: [],
    open_questions: [],
    lessons_learned: [`Keep automatic review bounded to recent reflection evidence ${index}.`],
    affordance_gaps: [],
    domain: "software-engineering",
    tags: ["v21.1-review"],
  };
}

async function withReviewProvider(run) {
  const requests = [];
  const waiters = [];
  let scenario = "success";
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    while (waiters.length > 0) waiters.shift()();
    if (scenario === "authentication") {
      response.writeHead(401).end("rejected");
      return;
    }
    if (scenario === "quota") {
      response.writeHead(429).end("rate limited");
      return;
    }
    if (scenario === "delayed") {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    }
    const user = parsed.messages.find((message) => message.role === "user");
    const reviewInput = JSON.parse(user?.content ?? "{}");
    const sourceId = reviewInput.reflections?.at(-1)?.id;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "Bounded review complete.",
            candidates: sourceId ? [{
              heuristic: "Use bounded provider input for automatic review.",
              source_reflection_ids: [sourceId],
              domain: "software-engineering",
              confidence: 0.95,
              tags: ["bounded-review"],
            }] : [],
            open_questions: [],
          }),
        },
      }],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      requests,
      setScenario(value) { scenario = value; },
      waitForRequest(expected) {
        return requests.length >= expected
          ? Promise.resolve()
          : new Promise((resolveWait) => waiters.push(resolveWait));
      },
    });
  } finally {
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function reviewContract() {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.HERMES_REFLECTION_BACKGROUND_ENABLED = "0";
  process.env.HERMES_REFLECTION_LLM_ENABLED = "1";
  process.env.HERMES_REFLECTION_LLM_MODEL = "review-model-a";
  process.env.HERMES_REFLECTION_LLM_API_KEY = "test-only-provider-key";
  process.env.HERMES_REFLECTION_LLM_TIMEOUT_MS = "3000";

  let sessionStorage;
  try {
  await withReviewProvider(async ({ endpoint, requests, setScenario, waitForRequest }) => {
    process.env.HERMES_REFLECTION_LLM_BASE_URL = endpoint;
    const storage = await import("../dist/storage.js");
    sessionStorage = await import("../dist/session_storage.js");
    const { BackgroundLifecycle } = await import("../dist/src/background_lifecycle.js");
    const { BackgroundStateStore } = await import("../dist/src/background_state.js");
    const engine = await import("../dist/src/review_engine.js");
    await storage.initializeStoreV20();

    const sessionId = "v21-1-bounded-review";
    await sessionStorage.persistSessionStart(sessionId, { scope: "global" });
    const marker = "CAPTURED-RAW-TURN-MARKER";
    const capturedAt = new Date().toISOString();
    for (const [side, content] of [["user", marker], ["assistant", `${marker}-assistant`]]) {
      await sessionStorage.stageCapturedTurnSide({
        session_id: sessionId,
        scope: "global",
        turn_id: "captured-turn-not-review-source",
        side,
        content,
        content_hash: createHash("sha256").update(content, "utf8").digest("hex"),
        occurred_at: capturedAt,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        original_code_points: Array.from(content).length,
        content_truncated: false,
        content_blocked: false,
      });
    }
    const reflections = Array.from({ length: 12 }, (_, index) => reflectionFixture(index, sessionId));
    for (const reflection of reflections) {
      await storage.saveReflectionAndHeuristics(
        reflection, [], reflection.domain, "v21.1-review-contract", 0.65, reflection.tags,
      );
    }

    const state = new BackgroundStateStore(join(home, ".hermes-reflection", "v21.1-review-state.json"));
    const lifecycle = new BackgroundLifecycle({
      enabled: true,
      interval_ms: 60_000,
      idle_ms: 0,
      lease_ms: 5_000,
      max_sessions_per_run: 4,
      review_mode: "llm",
      auto_apply: false,
      store: state,
    });
    const old = new Date(Date.now() - 10_000).toISOString();
    await state.markDirty(sessionId, old);
    await lifecycle.runNow();
    assert.equal(requests.length, 1, "first reflection/config generation did not call the provider exactly once");
    const firstUser = requests[0].messages.find((message) => message.role === "user");
    const firstInput = JSON.parse(firstUser?.content ?? "{}");
    assert.equal(firstInput.reflections.length, 10, "automatic LLM review did not keep exactly the latest ten reflections");
    assert.deepEqual(firstInput.reflections.map((item) => item.id), reflections.slice(-10).map((item) => item.id));
    const serializedReflectionPayload = JSON.stringify(firstInput.reflections);
    assert.ok(serializedReflectionPayload.length <= 24_000, `reflection payload=${serializedReflectionPayload.length}`);
    assert.doesNotMatch(serializedReflectionPayload, /CAPTURED-RAW-TURN-MARKER/,
      "captured turn text leaked into automatic review input");

    const savedAfterFirst = await storage.exportData();
    const pending = savedAfterFirst.metadata.review_candidates
      .find((candidate) => candidate.heuristic === "Use bounded provider input for automatic review.");
    assert.equal(pending?.state, "pending", "automatic review bypassed approval while auto_apply=false");

    await state.markDirty(sessionId, old);
    await lifecycle.runNow();
    assert.equal(requests.length, 1, "unchanged reflection/config source repeated the provider call");

    const beforeModelChange = await engine.getReviewSourceState(sessionId, "recent", "global", "llm");
    process.env.HERMES_REFLECTION_LLM_MODEL = "review-model-b";
    const afterModelChange = await engine.getReviewSourceState(sessionId, "recent", "global", "llm");
    assert.notEqual(beforeModelChange.source_fingerprint, afterModelChange.source_fingerprint,
      "semantic provider model is missing from the durable review fingerprint");
    await state.markDirty(sessionId, old);
    await lifecycle.runNow();
    assert.equal(requests.length, 2, "semantic model change did not invalidate unchanged-source suppression");

    const emptySession = "v21-1-empty-review";
    await sessionStorage.persistSessionStart(emptySession, { scope: "global" });
    await state.markDirty(emptySession, old);
    await lifecycle.runNow();
    assert.equal(requests.length, 2, "a session with no reflections called the provider");

    const authSession = "v21-1-auth-review";
    await sessionStorage.persistSessionStart(authSession, { scope: "global" });
    await storage.saveReflectionAndHeuristics(
      reflectionFixture(30, authSession), [], "software-engineering", "v21.1-auth", 0.65, [],
    );
    setScenario("authentication");
    await state.markDirty(authSession, old);
    await lifecycle.runNow();
    let authDirty = (await state.dirtySessions()).find((item) => item.session_id === authSession);
    assert.equal(authDirty?.outcome_class, "authentication");
    assert.ok(Date.parse(authDirty?.retry_after ?? "") > Date.now(), "authentication failure lacks cooldown state");

    const quotaSession = "v21-1-quota-review";
    await sessionStorage.persistSessionStart(quotaSession, { scope: "global" });
    await storage.saveReflectionAndHeuristics(
      reflectionFixture(31, quotaSession), [], "software-engineering", "v21.1-quota", 0.65, [],
    );
    setScenario("quota");
    const beforeQuota = requests.length;
    await state.markDirty(quotaSession, old);
    await lifecycle.runNow();
    assert.equal(requests.length - beforeQuota, 2, "quota retry was not bounded to one retry");
    const quotaDirty = (await state.dirtySessions()).find((item) => item.session_id === quotaSession);
    assert.equal(quotaDirty?.outcome_class, "quota");
    assert.ok(Date.parse(quotaDirty?.retry_after ?? "") > Date.now(), "quota failure lacks cooldown state");

    const configSession = "v21-1-config-review";
    await sessionStorage.persistSessionStart(configSession, { scope: "global" });
    await storage.saveReflectionAndHeuristics(
      reflectionFixture(32, configSession), [], "software-engineering", "v21.1-config", 0.65, [],
    );
    process.env.HERMES_REFLECTION_LLM_BASE_URL = "not-a-provider-url";
    await state.markDirty(configSession, old);
    await lifecycle.runNow();
    const configDirty = (await state.dirtySessions()).find((item) => item.session_id === configSession);
    assert.equal(configDirty?.outcome_class, "configuration");
    assert.ok(Date.parse(configDirty?.retry_after ?? "") > Date.now(), "configuration failure lacks cooldown state");

    process.env.HERMES_REFLECTION_LLM_BASE_URL = endpoint;
    const delayedSession = "v21-1-shutdown-review";
    await sessionStorage.persistSessionStart(delayedSession, { scope: "global" });
    await storage.saveReflectionAndHeuristics(
      reflectionFixture(33, delayedSession), [], "software-engineering", "v21.1-shutdown", 0.65, [],
    );
    setScenario("delayed");
    await state.markDirty(delayedSession, old);
    const delayedExpected = requests.length + 1;
    const run = lifecycle.runNow();
    await Promise.race([
      waitForRequest(delayedExpected),
      new Promise((_, reject) => setTimeout(() => reject(new Error("delayed provider request was not observed")), 2_000)),
    ]);
    const shutdownStarted = Date.now();
    await lifecycle.shutdown(1_500);
    await run;
    assert.ok(Date.now() - shutdownStarted < 2_000, "shutdown did not bound provider cancellation");
    assert.equal((await state.status()).lease.active, false, "shutdown left a background lease active");
    console.log("[PASS] v21.1 bounded provider-aware review contract");
  });
  } finally {
    sessionStorage?.closeSessionStorage();
  }
}

try {
  assertOwned(home);
  if (mode === "context") {
    await contextContract();
  } else {
    await reviewContract();
  }
} finally {
  assertOwned(ownedRoot);
  await rm(ownedRoot, { recursive: true, force: true });
}
