import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evidenceId,
  evidenceSignal,
  feedbackSignal,
  lessonContentHash,
} from "../dist/src/evidence.js";
import { withinBudget } from "../dist/src/response_budget.js";
import { resultText, startMcp } from "./v20-test-helpers.mjs";

const timestamp = "2026-07-28T00:00:00.000Z";
const topics = [
  ["deterministic cursor pagination", "Use deterministic opaque cursor pagination for stable agent continuation", "protocol", ["cursor"], "global"],
  ["atomic windows file replacement", "Stage bytes then use atomic Windows file replacement with retry bounds", "storage", ["windows"], "global"],
  ["redact bearer credentials", "Redact bearer credentials before memory persistence and model output", "security", ["redaction"], "global"],
  ["singleflight provider requests", "Coalesce identical provider requests through fingerprint singleflight", "review", ["concurrency"], "global"],
  ["cross process fencing lease", "Protect cross process review commits with a fencing lease", "review", ["lease"], "global"],
  ["bounded unicode response", "Budget complete responses by Unicode scalars and UTF-8 bytes", "protocol", ["budget"], "global"],
  ["schema runtime parity", "Generate model-visible JSON Schema from canonical runtime validation", "protocol", ["schema"], "global"],
  ["approval replay success", "Delete approval queue entries only after replay succeeds", "safety", ["approval"], "global"],
  ["file export allowlist", "Restrict file export to an explicit allow-listed transfer directory", "safety", ["export"], "global"],
  ["corrupt state evidence backup", "Preserve a hash-named evidence backup before rejecting corrupt state", "storage", ["corruption"], "global"],
  ["检索 不得 修改 存储", "检索过程必须保持只读，不能修改权威存储", "retrieval", ["中文"], "global"],
  ["项目 范围 隔离", "项目范围是硬过滤条件，必须隔离不同项目的记忆", "retrieval", ["中文"], "project:alpha"],
  ["后台 空闲 截止 唤醒", "后台生命周期应当在空闲截止时间准确唤醒", "lifecycle", ["中文"], "global"],
  ["持久 候选 审批", "自动复盘候选必须持久保存并按风险审批", "review", ["中文"], "global"],
  ["上下文 压缩 交接", "上下文压缩应保留最近用户请求和稳定交接标记", "session", ["中文"], "global"],
  ["idempotent store migration", "Run store migration idempotently and preserve record identity", "storage", ["migration"], "global"],
  ["explicit helpful feedback", "Use explicit helpful harmful or irrelevant task feedback for ranking", "retrieval", ["feedback"], "global"],
  ["independent evidence diversity", "Rank lessons using unique independent evidence diversity", "retrieval", ["evidence"], "global"],
  ["nonblocking codex hook", "Keep the Codex lifecycle hook nonblocking by enqueueing bounded events", "codex", ["hook"], "global"],
  ["compact default metadata", "Expose a compact default tool profile with concise metadata", "codex", ["metadata"], "global"],
  ["never enable unsafe cache", "Never enable an unsafe cache when state integrity is uncertain", "conflict", ["negative"], "global"],
  ["always enable verified cache", "Always enable a verified cache after integrity checks pass", "conflict", ["positive"], "global"],
  ["stable tie break identifier", "Break equal retrieval scores by confidence then stable identifier", "retrieval", ["ranking"], "global"],
  ["llm completion token bound", "Set an explicit completion token bound on every LLM review request", "review", ["llm"], "global"],
  ["retry bounded exponential backoff", "Retry transient provider failures with bounded exponential backoff", "review", ["retry"], "global"],
  ["session project binding restart", "Persist session to project binding across process restart", "scope", ["binding"], "project:alpha"],
  ["global memory visible project", "Global memory remains visible inside a project-scoped retrieval", "scope", ["global"], "global"],
  ["tag special retrieval filter", "Apply normalized tag filters before retrieval scoring", "retrieval", ["tag-special"], "global"],
  ["domain hard retrieval filter", "Apply domain as a hard retrieval filter rather than a score bonus", "domain-special", ["domain"], "global"],
  ["project beta isolated memory", "Beta-only deployment memory must remain isolated from alpha", "scope", ["beta"], "project:beta"],
];

function heuristic([query, text, domain, tags, scope], index) {
  const sourceTask = `benchmark source ${index}`;
  const id = `bench-${String(index).padStart(2, "0")}`;
  return {
    id,
    created_at: timestamp,
    updated_at: timestamp,
    domain,
    heuristic: text,
    source_task: sourceTask,
    scope,
    evidence: [{
      id: evidenceId(sourceTask, text),
      source_task: sourceTask,
      content_hash: lessonContentHash(text),
      created_at: timestamp,
    }],
    feedback: index === 0 ? [{
      heuristic_id: id,
      reflection_id: "feedback-reflection",
      value: "helpful",
      created_at: timestamp,
    }] : [],
    reinforcement_count: 1,
    contradiction_count: 0,
    contradiction_notes: [],
    confidence: index === 29 ? 0.85 : 0.8,
    retrieval_count: 17,
    last_retrieved_at: timestamp,
    supersedes: [],
    version: 1,
    tags,
  };
}

const sha = (value) => createHash("sha256").update(value).digest("hex");
const home = await mkdtemp(join(tmpdir(), "hermes-v20-retrieval-"));
const beforeEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home;
process.env.USERPROFILE = home;

try {
  const dir = join(home, ".hermes-reflection");
  const storePath = join(dir, "store.json");
  await mkdir(dir, { recursive: true });
  const heuristics = topics.map(heuristic);
  heuristics[4].evidence[0].source_reflection_id = "feedback-same-source";
  heuristics.push({
    ...heuristic(["bounded unicode response", "Budget complete responses by Unicode scalars and UTF-8 bytes", "protocol", ["budget"], "global"], 98),
    id: "low-confidence-decoy",
    confidence: 0.1,
    evidence: [],
  });
  const store = {
    sessions: {
      "detail-session": {
        id: "detail-session",
        started_at: timestamp,
        reflection_count: 1,
        affordance_gap_count: 0,
      },
    },
    affordance_gaps: [],
    heuristics,
    version: "20.0.0",
    memory_board: { entries: [], char_limit: 2200, used_chars: 0 },
    user_profile: { entries: [], char_limit: 1800, used_chars: 0 },
    metadata: {
      store_schema_version: 2,
      created_at: timestamp,
      last_written_at: timestamp,
      write_count: 0,
      pending_mutations: [],
    },
  };
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
  const detailReflection = {
    id: "detail-reflection",
    timestamp,
    session_id: "detail-session",
    scope: "global",
    task_goal: "Paginate one oversized reflection section",
    task_outcome: "success",
    failure_mode: "success",
    task_state: {
      summary: "界".repeat(30_000),
      immediate_blockers: [],
      active_hypotheses: [],
      proven_safe_paths: [],
      exhausted_search: [],
    },
    world_model_updates: [],
    tool_insights: [],
    context_forget: [],
    open_questions: [],
    lessons_learned: [],
    affordance_gaps: [],
    domain: "detail",
    tags: [],
  };
  const scopedReflection = (id, sessionId, scope) => ({
    id,
    timestamp: scope === "global" ? "2026-07-28T00:02:00.000Z" : scope.endsWith("alpha") ? "2026-07-28T00:03:00.000Z" : "2026-07-28T00:04:00.000Z",
    session_id: sessionId,
    scope,
    task_goal: `scope isolation sentinel ${scope}`,
    task_outcome: "success",
    failure_mode: "success",
    task_state: {
      summary: `scope isolation sentinel summary ${scope}`,
      immediate_blockers: [],
      active_hypotheses: [],
      proven_safe_paths: [],
      exhausted_search: [],
    },
    world_model_updates: [],
    tool_insights: [],
    context_forget: [],
    open_questions: [{
      question: `scope isolation sentinel question ${scope}`,
      priority: "medium",
      requires_environment_interaction: false,
    }],
    lessons_learned: [],
    affordance_gaps: [],
    domain: "scope-isolation",
    tags: ["scope-isolation"],
  });
  const globalScopeReflection = scopedReflection("scope-global-reflection", "global-session", "global");
  const alphaScopeReflection = scopedReflection("scope-alpha-reflection", "alpha-session", "project:alpha");
  const betaScopeReflection = scopedReflection("scope-beta-reflection", "beta-session", "project:beta");
  const jsonlPath = join(dir, "reflections.jsonl");
  await writeFile(jsonlPath, [
    detailReflection,
    globalScopeReflection,
    alphaScopeReflection,
    betaScopeReflection,
  ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

  const storage = await import(`../dist/storage.js?v20-retrieval=${Date.now()}`);
  const retrieve = (query, options = {}) => storage.retrieveRelevantHeuristics(
    query,
    options.domain,
    options.limit ?? 5,
    options.tags,
    true,
    options.minConfidence ?? 0.3,
    options.tagMode ?? "and",
    options.scope ?? "global",
  );

  const beforeBytes = await readFile(storePath, "utf8");
  const beforeStat = await stat(storePath);
  const hit = await retrieve("deterministic cursor pagination");
  const miss = await retrieve("utterly absent zephyr vocabulary");
  const afterBytes = await readFile(storePath, "utf8");
  const afterStat = await stat(storePath);
  assert.ok(hit.length > 0);
  assert.deepEqual(miss, []);
  assert.equal(sha(afterBytes), sha(beforeBytes), "retrieval hit/miss must not change store bytes");
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "retrieval hit/miss must not change store mtime");

  const repeated = await Promise.all(Array.from({ length: 5 }, () => retrieve("deterministic cursor pagination")));
  const projection = (items) => items.map((item) => [item.id, item._score?.final]);
  repeated.slice(1).forEach((items) => assert.deepEqual(projection(items), projection(repeated[0])));

  const exact = hit.find((item) => item.id === "bench-00");
  assert.ok(exact?._score);
  const expected = exact._score.text * 0.70
    + exact.confidence * 0.15
    + evidenceSignal(exact.evidence) * 0.10
    + feedbackSignal(exact.feedback) * 0.05;
  assert.ok(Math.abs(exact._score.final - expected) < 1e-9, `${exact._score.final} != ${expected}`);

  const scoped = await retrieve("project memory binding", { scope: "project:alpha", limit: 50, minConfidence: 0 });
  assert.ok(scoped.every((item) => item.scope === "global" || item.scope === "project:alpha"));
  assert.ok(scoped.some((item) => item.scope === "global"), "project retrieval must include relevant global memory");
  assert.ok(scoped.some((item) => item.scope === "project:alpha"), "project retrieval must include current-project memory");
  assert.ok(!scoped.some((item) => item.scope === "project:beta"));

  const cases = topics.map(([query, _text, domain, tags, scope], index) => ({
    query,
    expectedId: `bench-${String(index).padStart(2, "0")}`,
    options: {
      scope: scope === "global" ? "global" : scope,
      ...(index === 27 ? { tags } : {}),
      ...(index === 28 ? { domain } : {}),
    },
  }));
  let hitsAt5 = 0;
  let reciprocalRank = 0;
  for (const item of cases) {
    const results = await retrieve(item.query, item.options);
    const rank = results.findIndex((candidate) => candidate.id === item.expectedId) + 1;
    if (rank > 0 && rank <= 5) hitsAt5 += 1;
    if (rank > 0) reciprocalRank += 1 / rank;
  }
  const recallAt5 = hitsAt5 / cases.length;
  const mrr = reciprocalRank / cases.length;
  assert.ok(recallAt5 >= 0.90, `Recall@5 ${recallAt5}`);
  assert.ok(mrr >= 0.75, `MRR ${mrr}`);

  const evidenceProbe = {
    domain: "evidence-dedup-probe",
    heuristic: "Count one independent evidence source exactly once for reinforcement.",
    source_task: "evidence-source-a",
    scope: "global",
    confidence: 0.7,
    tags: ["evidence-dedup"],
  };
  const firstEvidence = await storage.upsertHeuristic(evidenceProbe);
  const duplicateEvidence = await storage.upsertHeuristic(evidenceProbe);
  assert.equal(duplicateEvidence.reinforcement_count, firstEvidence.reinforcement_count, "duplicate evidence reinforced twice");
  assert.equal(duplicateEvidence.confidence, firstEvidence.confidence, "duplicate evidence increased confidence twice");
  assert.equal(duplicateEvidence.evidence.length, firstEvidence.evidence.length, "duplicate evidence was stored twice");
  const independentEvidence = await storage.upsertHeuristic({ ...evidenceProbe, source_task: "evidence-source-b" });
  assert.equal(independentEvidence.reinforcement_count, firstEvidence.reinforcement_count + 1);
  assert.equal(independentEvidence.confidence, Math.min(1, firstEvidence.confidence + 0.05));
  assert.equal(independentEvidence.evidence.length, firstEvidence.evidence.length + 1);

  const feedbackReflection = (id) => ({
    id,
    timestamp: "2026-07-28T00:01:00.000Z",
    session_id: "feedback-session",
    scope: "global",
    task_goal: "Persist explicit feedback atomically",
    task_outcome: "success",
    failure_mode: "success",
    task_state: {
      summary: "feedback fixture",
      immediate_blockers: [], active_hypotheses: [], proven_safe_paths: [], exhausted_search: [],
    },
    world_model_updates: [], tool_insights: [], context_forget: [], open_questions: [],
    lessons_learned: [], affordance_gaps: [], domain: "retrieval", tags: [],
  });
  const scoreBefore = (await retrieve("atomic windows file replacement", { limit: 10 }))
    .find((item) => item.id === "bench-01")._score;
  await storage.saveReflectionAndHeuristics(
    feedbackReflection("feedback-reflection-1"),
    [], "retrieval", "feedback task", 0.8, [], undefined,
    [
      { heuristic_id: "bench-01", value: "helpful" },
      { heuristic_id: "bench-01", value: "helpful" },
      { heuristic_id: "bench-02", value: "harmful" },
      { heuristic_id: "bench-03", value: "irrelevant" },
    ],
  );
  const withFeedback = await storage.exportData();
  assert.deepEqual(withFeedback.heuristics.find((item) => item.id === "bench-01").feedback.map((item) => item.value), ["helpful"]);
  assert.deepEqual(withFeedback.heuristics.find((item) => item.id === "bench-02").feedback.map((item) => item.value), ["harmful"]);
  assert.deepEqual(withFeedback.heuristics.find((item) => item.id === "bench-03").feedback.map((item) => item.value), ["irrelevant"]);
  const scoreAfter = (await retrieve("atomic windows file replacement", { limit: 10 }))
    .find((item) => item.id === "bench-01")._score;
  assert.equal(scoreAfter.text, scoreBefore.text);
  assert.equal(scoreAfter.confidence, scoreBefore.confidence);
  assert.equal(scoreAfter.evidence, scoreBefore.evidence);
  assert.ok(Math.abs((scoreAfter.final - scoreBefore.final) - 0.05 * (scoreAfter.feedback - scoreBefore.feedback)) < 1e-9);

  for (const [id, target] of [["feedback-unknown", "missing-id"], ["feedback-same-source", "bench-04"]]) {
    const beforeStore = await readFile(storePath);
    const beforeJsonl = await readFile(jsonlPath);
    await assert.rejects(() => storage.saveReflectionAndHeuristics(
      feedbackReflection(id), [], "retrieval", "invalid feedback", 0.8, [], undefined,
      [{ heuristic_id: target, value: "helpful" }],
    ), /feedback|preexisting|same reflection|unknown/i);
    assert.ok(beforeStore.equals(await readFile(storePath)), `${id} must not change store.json`);
    assert.ok(beforeJsonl.equals(await readFile(jsonlPath)), `${id} must not change reflections.jsonl`);
  }

  const concurrentFeedbackCount = 12;
  const feedbackCountBefore = (await storage.exportData()).heuristics
    .find((item) => item.id === "bench-00").feedback.length;
  await Promise.all(Array.from({ length: concurrentFeedbackCount }, (_, index) =>
    storage.saveReflectionAndHeuristics(
      feedbackReflection(`feedback-concurrent-${index}`), [], "retrieval", "concurrent feedback", 0.8, [], undefined,
      [{ heuristic_id: "bench-00", value: "helpful" }],
    )
  ));
  const concurrentFeedback = (await storage.exportData()).heuristics
    .find((item) => item.id === "bench-00").feedback;
  assert.equal(concurrentFeedback.length, feedbackCountBefore + concurrentFeedbackCount, "concurrent feedback updates were lost");
  assert.equal(new Set(concurrentFeedback.map((item) => item.reflection_id)).size, concurrentFeedback.length, "concurrent feedback duplicated a reflection source");

  const [reviewCandidate] = await storage.enqueueReviewCandidateRecords([{
    id: "candidate-pending",
    scope: "global",
    stage: "deterministic",
    source_fingerprint: "a".repeat(64),
    source_reflection_ids: ["detail-reflection"],
    heuristic: "Keep pending review candidates available through bounded detail retrieval.",
    domain: "review",
    tags: ["pending"],
    confidence: 0.8,
    risk_reasons: [],
  }]);
  assert.equal(reviewCandidate.state, "pending");
  const [oversizedReviewCandidate] = await storage.enqueueReviewCandidateRecords([{
    id: "candidate-oversized",
    scope: "global",
    stage: "deterministic",
    source_fingerprint: "b".repeat(64),
    source_reflection_ids: ["detail-reflection"],
    heuristic: "Paginate a valid review candidate whose bounded tag set exceeds one compact response.",
    domain: "review",
    tags: Array.from({ length: 100 }, (_, index) => `tag-${index}-${"x".repeat(90)}`),
    confidence: 0.8,
    risk_reasons: [],
  }]);
  assert.equal(oversizedReviewCandidate.state, "pending");
  const [betaReviewCandidate] = await storage.enqueueReviewCandidateRecords([{
    id: "candidate-beta",
    scope: "project:beta",
    stage: "deterministic",
    source_fingerprint: "c".repeat(64),
    source_reflection_ids: ["scope-beta-reflection"],
    heuristic: "Keep beta review candidates isolated from alpha and global callers.",
    domain: "scope-isolation",
    tags: ["beta"],
    confidence: 0.8,
    risk_reasons: [],
  }]);
  assert.equal(betaReviewCandidate.state, "pending");

  const sessionStorage = await import(`../dist/session_storage.js?v20-detail=${Date.now()}`);
  assert.equal(await sessionStorage.appendSessionTurn(
    "detail-session", "user", "detail session turn", timestamp, { scope: "global" },
  ), true);
  assert.equal(await sessionStorage.appendSessionTurn(
    "beta-session", "user", "beta private session turn", timestamp, { scope: "project:beta" },
  ), true);
  sessionStorage.closeSessionStorage();
  const scopeStorage = await import(`../dist/src/project_scope.js?v20-scope=${Date.now()}`);
  await scopeStorage.projectScopeRepository.bind("alpha-session", "alpha");
  await scopeStorage.projectScopeRepository.bind("beta-session", "beta");
  const peer = await startMcp(home, { HERMES_REFLECTION_BACKGROUND_ENABLED: "false" });
  try {
    const itemIds = (result) => result.structuredContent?.items?.map((item) => item.id) ?? [];
    const globalSearch = await peer.client.callTool({
      name: "search_reflections",
      arguments: { query: "scope isolation sentinel", limit: 20 },
    });
    assert.deepEqual(itemIds(globalSearch), ["scope-global-reflection"], "global reflection search leaked project records");

    const alphaSearch = await peer.client.callTool({
      name: "search_reflections",
      arguments: { query: "scope isolation sentinel", limit: 20, session_id: "alpha-session" },
    });
    assert.deepEqual(new Set(itemIds(alphaSearch)), new Set(["scope-global-reflection", "scope-alpha-reflection"]));
    assert.ok(!itemIds(alphaSearch).includes("scope-beta-reflection"), "alpha reflection search leaked beta records");

    const globalQuestions = await peer.client.callTool({
      name: "get_open_questions",
      arguments: { domain: "scope-isolation", limit: 20 },
    });
    assert.deepEqual(itemIds(globalQuestions), ["scope-global-reflection:0"], "global open-question search leaked project records");

    const alphaQuestions = await peer.client.callTool({
      name: "get_open_questions",
      arguments: { domain: "scope-isolation", limit: 20, project_key: "alpha" },
    });
    assert.deepEqual(new Set(itemIds(alphaQuestions)), new Set(["scope-global-reflection:0", "scope-alpha-reflection:0"]));
    assert.ok(!itemIds(alphaQuestions).includes("scope-beta-reflection:0"), "alpha open-question search leaked beta records");

    const globalHeuristicList = await peer.client.callTool({
      name: "list_heuristics",
      arguments: { tags: ["beta"], limit: 20 },
    });
    assert.deepEqual(itemIds(globalHeuristicList), [], "global heuristic list leaked a beta record");

    const alphaHeuristicSearch = await peer.client.callTool({
      name: "search_heuristics",
      arguments: { query: "project beta isolated memory", limit: 20, project_key: "alpha" },
    });
    assert.ok(!itemIds(alphaHeuristicSearch).includes("bench-29"), "alpha heuristic search leaked a beta record");

    const betaHeuristicSearch = await peer.client.callTool({
      name: "search_heuristics",
      arguments: { query: "project beta isolated memory", limit: 20, project_key: "beta" },
    });
    assert.ok(itemIds(betaHeuristicSearch).includes("bench-29"), "beta heuristic search hid its own record");

    const deniedResolve = await peer.client.callTool({
      name: "resolve_open_question",
      arguments: {
        reflection_id: "scope-beta-reflection",
        question_index: 0,
        project_key: "alpha",
      },
    });
    assert.equal(deniedResolve.isError, true, "alpha resolved a beta open question by known reflection ID");
    assert.match(resultText(deniedResolve), /SCOPE_MISMATCH/);

    const betaQuestions = await peer.client.callTool({
      name: "get_open_questions",
      arguments: { domain: "scope-isolation", limit: 20, project_key: "beta" },
    });
    const betaQuestion = betaQuestions.structuredContent.items.find((item) => item.id === "scope-beta-reflection:0");
    assert.equal(betaQuestion?.resolved, false, "denied cross-scope resolution mutated beta state");

    const heuristicDetail = await peer.client.callTool({
      name: "get_memory_item",
      arguments: { kind: "heuristic", id: "bench-00" },
    });
    assert.equal(heuristicDetail.isError, undefined);
    assert.ok(heuristicDetail.structuredContent, "heuristic detail must expose structuredContent");
    assert.equal(heuristicDetail.structuredContent.items[0].id, "bench-00");

    for (const [kind, id] of [
      ["heuristic", "bench-29"],
      ["reflection", "scope-beta-reflection"],
      ["review_candidate", "candidate-beta"],
      ["session_turn", "beta-session:0"],
    ]) {
      const denied = await peer.client.callTool({
        name: "get_memory_item",
        arguments: { kind, id, project_key: "alpha" },
      });
      assert.equal(denied.isError, true, `${kind} detail leaked a beta item to alpha`);
      assert.match(resultText(denied), /SCOPE_MISMATCH/);
    }

    const betaDetail = await peer.client.callTool({
      name: "get_memory_item",
      arguments: { kind: "reflection", id: "scope-beta-reflection", project_key: "beta" },
    });
    assert.equal(betaDetail.isError, undefined, resultText(betaDetail));
    assert.equal(betaDetail.structuredContent.items[0].id, "scope-beta-reflection");

    const firstPageResult = await peer.client.callTool({
      name: "get_memory_item",
      arguments: { kind: "reflection", id: "detail-reflection", section: "summary" },
    });
    assert.equal(firstPageResult.isError, undefined);
    assert.ok(firstPageResult.structuredContent, "reflection detail must expose structuredContent");
    const firstPage = firstPageResult.structuredContent;
    const firstPageVisible = JSON.stringify(firstPageResult);
    assert.ok(Buffer.byteLength(firstPageVisible, "utf8") <= 24 * 1024);
    assert.ok(Array.from(firstPageVisible).length <= 6_000);
    assert.equal(firstPage.has_more, true);
    assert.ok(firstPage.next_cursor);
    const secondPageResult = await peer.client.callTool({
      name: "get_memory_item",
      arguments: {
        kind: "reflection", id: "detail-reflection", section: "summary", cursor: firstPage.next_cursor,
      },
    });
    assert.equal(secondPageResult.isError, undefined);
    assert.ok(secondPageResult.structuredContent, "continued reflection detail must expose structuredContent");
    const secondPage = secondPageResult.structuredContent;
    assert.notEqual(secondPage.items[0].offset, firstPage.items[0].offset);

    const turnDetail = await peer.client.callTool({
      name: "get_memory_item",
      arguments: { kind: "session_turn", id: "detail-session:0" },
    });
    assert.equal(turnDetail.isError, undefined);
    assert.ok(turnDetail.structuredContent, "session turn detail must expose structuredContent");
    assert.match(JSON.stringify(turnDetail.structuredContent), /detail session turn/);

    const pending = await peer.client.callTool({
      name: "get_memory_item",
      arguments: { kind: "review_candidate", id: "candidate-pending" },
    });
    assert.equal(pending.isError, undefined);
    assert.ok(pending.structuredContent, "review candidate detail must expose structuredContent");
    assert.equal(pending.structuredContent.items[0].id, "candidate-pending");
    assert.equal(pending.structuredContent.items[0].state, "pending");

    const pendingWithInvalidCursor = await peer.client.callTool({
      name: "get_memory_item",
      arguments: { kind: "review_candidate", id: "candidate-pending", cursor: "not-a-cursor" },
    });
    assert.equal(pendingWithInvalidCursor.isError, true, "review candidate silently ignored an invalid cursor");
    assert.match(resultText(pendingWithInvalidCursor), /CURSOR_STALE/);

    const oversizedCandidatePage = await peer.client.callTool({
      name: "get_memory_item",
      arguments: { kind: "review_candidate", id: "candidate-oversized" },
    });
    assert.equal(oversizedCandidatePage.isError, undefined, resultText(oversizedCandidatePage));
    assert.equal(oversizedCandidatePage.structuredContent.has_more, true);
    assert.ok(oversizedCandidatePage.structuredContent.next_cursor);
    assert.equal(withinBudget(oversizedCandidatePage, "compact"), true);
  } finally {
    await peer.close();
  }
  console.log(`[PASS] v20 retrieval read-only Recall@5=${recallAt5.toFixed(3)} MRR=${mrr.toFixed(3)}`);
} finally {
  if (beforeEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = beforeEnv.HOME;
  if (beforeEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = beforeEnv.USERPROFILE;
  await rm(home, { recursive: true, force: true });
}
