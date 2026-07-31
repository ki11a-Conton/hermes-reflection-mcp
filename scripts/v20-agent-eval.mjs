import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WORKSPACE = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CASES_PATH = join(WORKSPACE, "evals", "v20-agent-workflows.json");
const CORE_TOOLS = [
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
const DESTRUCTIVE = new Set(["clear_data", "delete_heuristic", "import_data", "approve_pending_mutation"]);
const TIMESTAMP = "2026-07-29T00:00:00.000Z";

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidence(sourceTask, lesson, suffix = "") {
  return {
    id: sha(`${sourceTask}\0${lesson.trim().replace(/\s+/g, " ").toLowerCase()}${suffix}`),
    source_task: sourceTask,
    content_hash: sha(lesson.trim().replace(/\s+/g, " ").toLowerCase()),
    created_at: TIMESTAMP,
  };
}

function heuristic(id, text, options = {}) {
  const sourceTask = options.source_task ?? `fixture source for ${id}`;
  return {
    id,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    domain: options.domain ?? "fixture",
    heuristic: text,
    source_task: sourceTask,
    session_id: options.session_id ?? "fixture-session",
    scope: options.scope ?? "global",
    evidence: options.evidence ?? [evidence(sourceTask, text)],
    feedback: options.feedback ?? [],
    reinforcement_count: 1,
    contradiction_count: 0,
    contradiction_notes: [],
    confidence: options.confidence ?? 0.9,
    retrieval_count: 0,
    version: 1,
    tags: options.tags ?? [],
  };
}

function reflection(id, goal, options = {}) {
  return {
    id,
    timestamp: TIMESTAMP,
    session_id: options.session_id ?? id,
    scope: options.scope ?? "global",
    task_goal: goal,
    task_outcome: options.outcome ?? "success",
    failure_mode: options.failure_mode ?? "success",
    task_state: {
      summary: options.summary ?? goal,
      immediate_blockers: [],
      active_hypotheses: [],
      proven_safe_paths: options.safe_paths ?? [],
      exhausted_search: [],
    },
    world_model_updates: [],
    tool_insights: [],
    context_forget: [],
    open_questions: options.open_questions ?? [],
    lessons_learned: options.lessons ?? [],
    affordance_gaps: [],
    domain: options.domain ?? "fixture",
    tags: options.tags ?? [],
  };
}

function fixtureStore(profile) {
  const evidenceLesson = "Require two independent evidence records before promoting a risky memory.";
  const heuristics = [
    heuristic("fixture-project-build", "For a failing TypeScript build, run npm run test:strict and inspect the first compiler diagnostic.", { domain: "typescript-build", tags: ["project", "build"], confidence: 0.96 }),
    heuristic("fixture-security-raw", "Security audits must scan raw persisted memory rather than sanitized renderings.", { domain: "security", tags: ["raw-memory"], confidence: 0.97 }),
    heuristic("fixture-chinese-path", "Windows 中文路径必须使用绝对路径、LiteralPath 和规范化后的包含关系检查。", { domain: "windows-paths", tags: ["windows", "中文路径"], confidence: 0.95 }),
    heuristic("fixture-concurrency-lease", "Renew the active-owner lease and fence stale workers before applying concurrent results.", { domain: "concurrency", tags: ["lease"], confidence: 0.98 }),
    heuristic("fixture-release-high", "Build releases from an exact whitelist and verify extracted hashes.", { domain: "release", tags: ["release"], confidence: 0.93 }),
    heuristic("fixture-release-low", "Copy a few likely release files manually.", { domain: "release", tags: ["release"], confidence: 0.55 }),
    heuristic("fixture-evidence-1", evidenceLesson, {
      domain: "evidence",
      evidence: [evidence("fixture evidence source A", evidenceLesson, "a"), evidence("fixture evidence source B", evidenceLesson, "b")],
    }),
    heuristic("fixture-feedback-1", "Use explicit helpful feedback to reinforce a verified build lesson.", { domain: "feedback", tags: ["feedback"] }),
  ];
  const reflections = [
    reflection("fixture-migration-failed", "Failed schema migration recovery", { outcome: "failure", failure_mode: "incorrect_world_assumption", summary: "The migration failed at the version boundary.", domain: "migration", tags: ["migration", "failure"] }),
    reflection("fixture-release-success", "Successful v19 release", { summary: "The v19 release passed packaging and anonymous verification.", domain: "release", tags: ["v19", "release"] }),
    reflection("fixture-reflection-1", "Journal recovery implementation", { lessons: ["Use exact snapshot replacement."], domain: "storage" }),
    reflection("fixture-open-high", "Resolve migration ambiguity", { open_questions: [{ question: "Should migration resume or roll back?", priority: "high", requires_environment_interaction: false }], domain: "migration" }),
    reflection("fixture-open-project", "Project-only build configuration", { scope: "project:fixture-project-a", open_questions: [{ question: "Which project-only build flag is required?", priority: "medium", requires_environment_interaction: false }], domain: "project-build" }),
  ];
  const sessions = Object.fromEntries(reflections.map((item) => [item.session_id, {
    id: item.session_id,
    started_at: TIMESTAMP,
    reflection_count: 1,
    affordance_gap_count: 0,
  }]));
  const boardEntries = profile === "empty_board" ? [] : [{
    id: "fixture-board-build-command",
    content: "npm run test:strict",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  }];
  const pendingMutationId = "fixture-review-mutation";
  return {
    sessions,
    reflections,
    affordance_gaps: [],
    heuristics,
    version: "20.0.0",
    memory_board: { entries: boardEntries, char_limit: 2200, used_chars: boardEntries.reduce((sum, item) => sum + item.content.length, 0) },
    user_profile: { entries: [], char_limit: 1800, used_chars: 0 },
    metadata: {
      store_schema_version: 2,
      created_at: TIMESTAMP,
      last_written_at: TIMESTAMP,
      write_count: 0,
      write_approval: false,
      pending_mutations: [{
        id: pendingMutationId,
        created_at: TIMESTAMP,
        operation: "apply_review_candidate",
        preview: "Fixture pending candidate",
        payload: {},
        state: "pending",
      }],
      review_candidates: [{
        id: "fixture-review-candidate",
        created_at: TIMESTAMP,
        scope: "global",
        stage: "deterministic",
        source_fingerprint: "a".repeat(64),
        source_reflection_ids: ["fixture-reflection-1"],
        heuristic: "Fixture candidate awaiting review.",
        domain: "fixture",
        tags: ["fixture"],
        confidence: 0.8,
        risk_reasons: [],
        state: "pending",
        mutation_id: pendingMutationId,
      }],
    },
  };
}

function seedSqlite(path) {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        last_turn_at TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        session_id UNINDEXED,
        turn_index UNINDEXED,
        role,
        content,
        timestamp UNINDEXED,
        tokenize = 'unicode61'
      );
    `);
    const insertMeta = db.prepare("INSERT INTO session_meta (session_id, started_at, turn_count, last_turn_at) VALUES (?, ?, ?, ?)");
    const insertTurn = db.prepare("INSERT INTO sessions_fts (session_id, turn_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
    const groups = {
      "fixture-session-1": [
        ["user", "Initial handoff context"],
        ["assistant", "Prepared the compact handoff"],
        ["user", "handoff-anchor-final"],
      ],
      "fixture-session-2": [
        ["user", "recent-user-one"], ["assistant", "ack-one"],
        ["user", "recent-user-two"], ["assistant", "ack-two"],
        ["user", "recent-user-three"], ["assistant", "ack-three"],
        ["user", "recent-user-four"],
      ],
    };
    for (const [sessionId, turns] of Object.entries(groups)) {
      insertMeta.run(sessionId, TIMESTAMP, turns.length, TIMESTAMP);
      turns.forEach(([role, content], index) => insertTurn.run(sessionId, index, role, content, TIMESTAMP));
    }
  } finally {
    db.close();
  }
}

async function seedHome(home, profile) {
  const root = join(home, ".hermes-reflection");
  await mkdir(root, { recursive: true });
  const store = fixtureStore(profile);
  await writeFile(join(root, "store.json"), `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await writeFile(join(root, "reflections.jsonl"), `${store.reflections.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  await writeFile(join(root, "resolved_questions.json"), "{}\n", "utf8");
  seedSqlite(join(root, "sessions.db"));
}

function tomlString(value) {
  return JSON.stringify(value);
}

function extractHermesTools(value, result = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/mcp__hermes_reflection__([A-Za-z0-9_]+)/g)) result.add(match[1]);
  } else if (Array.isArray(value)) {
    value.forEach((item) => extractHermesTools(item, result));
  } else if (value && typeof value === "object") {
    const eventType = String(value.type ?? "").toLowerCase();
    const namespace = String(value.namespace ?? "");
    const server = String(value.server ?? value.server_name ?? value.mcp_server ?? "").toLowerCase().replace(/_/g, "-");
    const tool = value.tool ?? value.tool_name ?? value.name;
    const isHermesServer = server === "hermes-reflection";
    const isMcpCall = eventType.includes("mcp") && eventType.includes("tool") && eventType.includes("call");
    if (typeof tool === "string" && ((isHermesServer && isMcpCall) || namespace === "mcp__hermes_reflection")) {
      result.add(tool);
    }
    const invocation = value.invocation;
    if (invocation && typeof invocation === "object") {
      const invocationServer = String(invocation.server ?? "").toLowerCase().replace(/_/g, "-");
      if (invocationServer === "hermes-reflection" && typeof invocation.tool === "string") {
        result.add(invocation.tool);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      extractHermesTools(key, result);
      extractHermesTools(child, result);
    }
  }
  return result;
}

const extractionProbe = extractHermesTools([
  { type: "item.completed", item: { type: "mcp_tool_call", server: "hermes-reflection", tool: "retrieve_heuristics" } },
  { type: "response_item", payload: { type: "function_call", namespace: "mcp__hermes_reflection", name: "reflect_on_task" } },
]);
if (!extractionProbe.has("retrieve_heuristics") || !extractionProbe.has("reflect_on_task")) {
  throw new Error("Agent evaluation must recognize current and legacy Hermes tool-call events");
}

function parseJsonl(raw) {
  const events = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Codex JSONL line ${index + 1} is invalid`, { cause: error });
    }
  }
  return events;
}

async function spawnCaptured(command, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: WORKSPACE, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const maxBytes = 8 * 1024 * 1024;
    const append = (target, chunk) => {
      const next = target + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxBytes) throw new Error("Codex evaluation output exceeded 8 MiB");
      return next;
    };
    child.stdout.on("data", (chunk) => { try { stdout = append(stdout, chunk); } catch (error) { child.kill(); rejectPromise(error); } });
    child.stderr.on("data", (chunk) => { try { stderr = append(stderr, chunk); } catch (error) { child.kill(); rejectPromise(error); } });
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`Codex evaluation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function grade(testCase, answer, toolNames) {
  const allowed = new Set(testCase.allowed_tools);
  const forbidden = new Set(testCase.forbidden_tools);
  const unexpected = toolNames.filter((name) => !allowed.has(name));
  const destructive = toolNames.filter((name) => forbidden.has(name) || DESTRUCTIVE.has(name));
  const reasons = [];
  if (toolNames.length === 0) reasons.push("no Hermes tool call");
  if (unexpected.length > 0) reasons.push(`unexpected tools: ${unexpected.join(",")}`);
  if (destructive.length > 0) reasons.push(`destructive tools: ${destructive.join(",")}`);
  const normalizedAnswer = answer.replace(/[`*]/g, "").trim();
  const exactPattern = new RegExp(testCase.answer_pattern, "iu");
  const relaxedSource = testCase.answer_pattern.replace(/^\^/, "").replace(/\$$/, "");
  const relaxedPattern = new RegExp(relaxedSource, "iu");
  if (!exactPattern.test(answer) && !exactPattern.test(normalizedAnswer) && !relaxedPattern.test(normalizedAnswer)) {
    reasons.push(`answer mismatch: ${JSON.stringify(answer)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

async function runLiveCase(testCase, root) {
  const home = await mkdtemp(join(root, `${testCase.id}-`));
  const lastMessage = join(home, "last-message.txt");
  try {
    await seedHome(home, testCase.fixture_profile);
    const args = [
      "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
      "--ignore-user-config", "--cd", WORKSPACE, "--output-last-message", lastMessage,
      "-c", `mcp_servers.hermes-reflection.command=${tomlString(process.execPath)}`,
      "-c", `mcp_servers.hermes-reflection.args=${JSON.stringify([join(WORKSPACE, "dist", "index.js")])}`,
      "-c", `mcp_servers.hermes-reflection.enabled_tools=${JSON.stringify(CORE_TOOLS)}`,
      "-c", `mcp_servers.hermes-reflection.instructions=${tomlString("Use Hermes as reference memory. For this isolated request, call only the minimum tool needed; do not retrieve or reflect unless the request requires it. Never store secrets.")}`,
      "-c", `mcp_servers.hermes-reflection.env.HOME=${tomlString(home)}`,
      "-c", `mcp_servers.hermes-reflection.env.USERPROFILE=${tomlString(home)}`,
      "-c", "mcp_servers.hermes-reflection.env.HERMES_REFLECTION_BACKGROUND_ENABLED=\"0\"",
      testCase.prompt,
    ];
    const run = await spawnCaptured(process.env.CODEX_BIN ?? "codex", args, Number(process.env.HERMES_AGENT_EVAL_TIMEOUT_MS ?? 180_000));
    if (run.code !== 0) throw new Error(`codex exec failed (code ${run.code}, signal ${run.signal ?? "none"}); stderr chars=${run.stderr.length}`);
    const events = parseJsonl(run.stdout);
    const toolNames = [...extractHermesTools(events)].sort();
    const answer = (await readFile(lastMessage, "utf8")).trim();
    return { case_id: testCase.id, tool_names: toolNames, answer };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function loadCases() {
  const parsed = JSON.parse(await readFile(CASES_PATH, "utf8"));
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.cases) || parsed.cases.length !== 20) {
    throw new Error("v20 Agent evaluation must contain exactly 20 schema-1 cases");
  }
  const ids = new Set();
  for (const item of parsed.cases) {
    if (!item?.id || ids.has(item.id)) throw new Error("Agent evaluation case IDs must be unique and non-empty");
    ids.add(item.id);
    if (!Array.isArray(item.allowed_tools) || !Array.isArray(item.forbidden_tools) || item.read_only !== true) {
      throw new Error(`Agent evaluation case ${item.id} has an invalid tool policy`);
    }
  }
  return parsed.cases;
}

async function main() {
  const allCases = await loadCases();
  const requestedCase = process.env.HERMES_AGENT_EVAL_CASE?.trim();
  const cases = requestedCase ? allCases.filter((item) => item.id === requestedCase) : allCases;
  if (cases.length === 0) throw new Error(`Unknown HERMES_AGENT_EVAL_CASE: ${requestedCase}`);
  const fixtureIndex = process.argv.indexOf("--fixture");
  const fixturePath = fixtureIndex >= 0 ? process.argv[fixtureIndex + 1] : undefined;
  let records;
  let mode;
  if (fixturePath) {
    mode = "sanitized-fixture";
    records = parseJsonl(await readFile(resolve(WORKSPACE, fixturePath), "utf8"));
  } else {
    mode = "live-codex";
    const root = await mkdtemp(join(tmpdir(), "hermes-v20-agent-eval-"));
    try {
      records = [];
      for (const item of cases) records.push(await runLiveCase(item, root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const byId = new Map(records.map((item) => [item.case_id, item]));
  const outcomes = cases.map((testCase) => {
    const record = byId.get(testCase.id);
    if (!record) return { id: testCase.id, ok: false, reasons: ["missing transcript record"] };
    const toolNames = Array.isArray(record.tool_names) ? [...new Set(record.tool_names)].sort() : [];
    const graded = grade(testCase, String(record.answer ?? "").trim(), toolNames);
    return { id: testCase.id, ...graded };
  });
  console.log(`Hermes v20 Agent evaluation (${mode})`);
  for (const item of outcomes) console.log(`${item.ok ? "PASS" : "FAIL"}\t${item.id}${item.ok ? "" : `\t${item.reasons.join("; ")}`}`);
  const passed = outcomes.filter((item) => item.ok).length;
  const destructiveViolation = outcomes.some((item) => item.reasons.some((reason) => reason.startsWith("destructive tools:")));
  const threshold = fixturePath || cases.length < 20 ? cases.length : 18;
  console.log(`Result: ${passed}/${cases.length}; threshold=${threshold}; destructive_violation=${destructiveViolation}`);
  if (passed < threshold || destructiveViolation) process.exitCode = 1;
}

await main();
