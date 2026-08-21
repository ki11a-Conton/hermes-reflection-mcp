import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcp } from "./v20-test-helpers.mjs";
import {
  SkillRevisionSchema,
  skillRevisionContentHash,
} from "../dist/src/learning/skill_candidate.js";
import {
  buildPromotionClusters,
  matchPromotionTarget,
  normalizePromotionText,
} from "../dist/src/learning/skill_promotion.js";
import { RESPONSE_LIMITS } from "../dist/src/response_budget.js";
import {
  listRegisteredTools,
  profileToolNames,
} from "../dist/src/tool_registry.js";

const NOW = "2026-08-16T00:00:00.000Z";
const SCOPE = "project:alpha";
const PRIVATE_MARKER = "FULL_PRIVATE_PROCEDURE_BODY_MUST_NOT_APPEAR_IN_RECALL";
const STEP_ONLY_MARKER = "zxqv987654321";

function reflection(id, session, domain, goal) {
  return {
    id,
    timestamp: NOW,
    session_id: session,
    scope: SCOPE,
    task_goal: goal,
    task_outcome: "success",
    failure_mode: "success",
    task_state: {
      summary: `${goal} succeeded`,
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
    domain,
    tags: ["schema", "release"],
  };
}

function largeSteps(procedureText) {
  return Array.from({ length: 8 }, () =>
    `${procedureText} ${PRIVATE_MARKER} ${STEP_ONLY_MARKER} ${`${procedureText} `.repeat(12)}`);
}

function assertModelVisibleBudget(result, mode, label) {
  const serialized = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
  const limits = RESPONSE_LIMITS[mode];
  assert.ok(Array.from(serialized).length <= limits.code_points, `${label} exceeded ${mode} code-point budget`);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= limits.utf8_bytes, `${label} exceeded ${mode} UTF-8 budget`);
}

function assertPortableSchema(value, path = "schema") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortableSchema(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Object.hasOwn(value, "pattern")) {
    assert.equal(typeof value.pattern, "string", `${path}.pattern must be a string`);
    assert.equal(value.pattern.includes("\\0"), false, `${path}.pattern contains provider-incompatible \\0`);
    assert.doesNotThrow(() => new RegExp(value.pattern, "u"), `${path}.pattern is not a portable regex`);
  }
  for (const [key, item] of Object.entries(value)) assertPortableSchema(item, `${path}.${key}`);
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

const tempHome = await mkdtemp(join(tmpdir(), "hermes-v22.1-skill-mcp-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

let close;
try {
  const storage = await import(`../dist/storage.js?skill-mcp=${Date.now()}`);
  const queue = await import(`../dist/src/skill_queue.js?skill-mcp=${Date.now()}`);
  await storage.initializeStoreV20();

  const procedures = [
    {
      domain: "schema-export",
      lesson: "Validate exported MCP provider schemas before packaging each release.",
      title: "Validate exported MCP schemas",
      summary: "Validate MCP provider schemas before release packaging.",
    },
    {
      domain: "opencode-schema",
      lesson: "Run OpenCode JSON schema compatibility checks before shipping MCP tools.",
      title: "Check OpenCode schema compatibility",
      summary: "Compile MCP tool schemas against provider-compatible JSON Schema constraints.",
    },
    {
      domain: "legacy-provider",
      lesson: "Inspect legacy provider schema metadata before publishing compatibility builds.",
      title: "Inspect legacy provider metadata",
      summary: "Inspect legacy provider metadata before compatibility publication.",
    },
  ];

  for (const [index, procedure] of procedures.entries()) {
    const left = reflection(`reflection-${index}-a`, `session-${index}-a`, procedure.domain, `schema release ${index} alpha`);
    const right = reflection(`reflection-${index}-b`, `session-${index}-b`, procedure.domain, `schema release ${index} beta`);
    await storage.saveReflectionAndHeuristics(
      left,
      [procedure.lesson],
      procedure.domain,
      `seed-${index}-a`,
      0.9,
      ["schema", "release"],
    );
    await storage.saveReflectionAndHeuristics(
      right,
      [procedure.lesson],
      procedure.domain,
      `seed-${index}-b`,
      0.9,
      ["schema", "release"],
    );
  }

  function clusterFor(snapshot, domain) {
    const cluster = buildPromotionClusters(snapshot).find((item) => item.domain === normalizePromotionText(domain));
    assert.ok(cluster, `missing authoritative cluster for ${domain}`);
    return cluster;
  }

  function draftFor({ snapshot, cluster, candidateId, target, title, summary, steps }) {
    const body = {
      revision: target ? target.current_revision + 1 : 1,
      title,
      summary,
      steps: [cluster.normalized_text, ...steps],
      domain: cluster.domain,
      tags: cluster.tags,
      confidence: cluster.confidence,
      provenance: cluster.reflection_ids.map((id) => {
        const source = snapshot.reflections.find((item) => item.id === id);
        assert.ok(source, `missing source reflection ${id}`);
        return {
          source_type: "reflection",
          source_id: id,
          content_hash: storage.skillReflectionContentHash(source),
          observed_at: source.timestamp,
          status: "active",
        };
      }),
      origin_candidate_id: candidateId,
      created_at: NOW,
    };
    const proposedRevision = SkillRevisionSchema.parse({
      ...body,
      content_hash: skillRevisionContentHash(body),
    });
    return {
      action: target ? "update" : "create",
      scope: SCOPE,
      ...(target ? { target_skill_id: target.id, expected_target_revision: target.current_revision } : {}),
      proposed_revision: proposedRevision,
      source_heuristic_ids: cluster.heuristic_ids,
      source_reflection_ids: cluster.reflection_ids,
      cluster_algorithm: "skill-cluster-v1",
      cluster_fingerprint: cluster.fingerprint,
      evidence_fingerprint: storage.skillPromotionEvidenceFingerprint(
        snapshot,
        cluster.heuristic_ids,
        cluster.reflection_ids,
      ),
      confidence: cluster.confidence,
      risk: "low",
      risk_reasons: [],
      created_at: NOW,
    };
  }

  const created = [];
  for (const [index, procedure] of procedures.entries()) {
    const snapshot = await storage.getSkillPromotionSnapshot(SCOPE);
    const cluster = clusterFor(snapshot, procedure.domain);
    const [candidate] = await queue.enqueueSkillCandidates([draftFor({
      snapshot,
      cluster,
      candidateId: `skill-candidate-create-${index}`,
      title: cluster.normalized_text,
      summary: cluster.normalized_text,
      steps: largeSteps(cluster.normalized_text),
    })]);
    assert.ok(candidate.mutation_id);
    const applied = await queue.replaySkillCandidateMutation(candidate.mutation_id);
    assert.ok(applied);
    assert.equal(matchPromotionTarget(cluster, [applied.skill]).target_skill_id, applied.skill.id,
      "an applied fixture must remain an authoritative update target for its source cluster");
    created.push({ ...applied, cluster });
  }

  const disabledMutation = created[2].candidate.mutation_id;
  const disabled = await queue.rollbackSkillCandidate(disabledMutation);
  assert.equal(disabled.skill.status, "disabled");

  let target = created[0].skill;
  const firstCluster = created[0].cluster;
  const snapshotForFirstUpdate = await storage.getSkillPromotionSnapshot(SCOPE);
  const [firstUpdateCandidate] = await queue.enqueueSkillCandidates([draftFor({
    snapshot: snapshotForFirstUpdate,
    cluster: firstCluster,
    candidateId: "skill-candidate-update-first",
    target,
    title: firstCluster.normalized_text,
    summary: firstCluster.normalized_text,
    steps: largeSteps(firstCluster.normalized_text),
  })]);
  const firstUpdate = await queue.replaySkillCandidateMutation(firstUpdateCandidate.mutation_id);
  assert.ok(firstUpdate);
  target = firstUpdate.skill;

  const snapshotForSecondUpdate = await storage.getSkillPromotionSnapshot(SCOPE);
  const [secondUpdateCandidate] = await queue.enqueueSkillCandidates([draftFor({
    snapshot: snapshotForSecondUpdate,
    cluster: firstCluster,
    candidateId: "skill-candidate-update-second",
    target,
    title: firstCluster.normalized_text,
    summary: firstCluster.normalized_text,
    steps: largeSteps(firstCluster.normalized_text),
  })]);
  const secondUpdate = await queue.replaySkillCandidateMutation(secondUpdateCandidate.mutation_id);
  assert.ok(secondUpdate);
  target = secondUpdate.skill;

  const snapshotForPending = await storage.getSkillPromotionSnapshot(SCOPE);
  const [pendingCandidate] = await queue.enqueueSkillCandidates([draftFor({
    snapshot: snapshotForPending,
    cluster: firstCluster,
    candidateId: "skill-candidate-update-pending",
    target,
    title: firstCluster.normalized_text,
    summary: firstCluster.normalized_text,
    steps: largeSteps(firstCluster.normalized_text),
  })]);
  assert.equal(pendingCandidate.state, "pending");

  const secondTarget = created[1].skill;
  const secondCluster = created[1].cluster;
  const snapshotForReject = await storage.getSkillPromotionSnapshot(SCOPE);
  const [rejectCandidate] = await queue.enqueueSkillCandidates([draftFor({
    snapshot: snapshotForReject,
    cluster: secondCluster,
    candidateId: "skill-candidate-reject-pending",
    target: secondTarget,
    title: secondCluster.normalized_text,
    summary: secondCluster.normalized_text,
    steps: [secondCluster.normalized_text],
  })]);
  assert.ok(rejectCandidate.mutation_id);

  assert.equal(profileToolNames("core").length, 10);
  assert.equal(profileToolNames("extended").length, 29);
  const registered = listRegisteredTools();
  assert.equal(registered.length, 29);
  for (const tool of registered) assertPortableSchema(tool.inputSchema, `${tool.name}.inputSchema`);

  const memoryTool = registered.find((tool) => tool.name === "get_memory_item");
  const approvalTool = registered.find((tool) => tool.name === "approve_pending_mutation");
  assert.deepEqual(memoryTool.inputSchema.properties.kind.enum,
    ["heuristic", "reflection", "session_turn", "review_candidate", "skill", "skill_candidate"]);
  assert.deepEqual(approvalTool.inputSchema.properties.decision.enum, ["approve", "reject", "rollback"]);

  const started = await startMcp(tempHome, {
    HERMES_REFLECTION_BACKGROUND_ENABLED: "false",
  });
  close = started.close;
  const { client } = started;

  const retrieval = await call(client, "retrieve_heuristics", {
    task_description: "validate MCP provider JSON schemas for an OpenCode release",
    project_key: "alpha",
    limit: 3,
    response_mode: "compact",
  });
  assert.equal(retrieval.isError, undefined);
  assertModelVisibleBudget(retrieval, "compact", "skill retrieval");
  const retrievalItems = retrieval.structuredContent?.items ?? [];
  const embeddedRefs = retrievalItems[0]?.skill_refs
    ?? retrievalItems.filter((item) => item.kind === "skill_ref");
  assert.ok(embeddedRefs.length > 0 && embeddedRefs.length <= 2, "retrieval must expose at most two compact skill refs");
  assert.equal(JSON.stringify(retrieval).includes(PRIVATE_MARKER), false, "retrieval leaked full private skill steps");
  assert.equal(embeddedRefs.some((item) => item.id === disabled.skill.id), false, "disabled skill was recalled");

  const stepOnlyRetrieval = await call(client, "retrieve_heuristics", {
    task_description: STEP_ONLY_MARKER,
    project_key: "alpha",
    limit: 3,
    response_mode: "compact",
  });
  assert.equal(stepOnlyRetrieval.isError, undefined);
  assertModelVisibleBudget(stepOnlyRetrieval, "compact", "step-only skill retrieval");
  const stepOnlyItems = stepOnlyRetrieval.structuredContent?.items ?? [];
  const stepOnlyRefs = stepOnlyItems[0]?.skill_refs
    ?? stepOnlyItems.filter((item) => item.kind === "skill_ref");
  assert.ok(stepOnlyRefs.length > 0,
    "approved skills must be discoverable from terms that occur only in their procedure steps");
  assert.equal(JSON.stringify(stepOnlyRetrieval).split(STEP_ONLY_MARKER).length - 1, 1,
    "step-aware ranking must not copy matching procedure steps into the compact response");

  const detail = await call(client, "get_memory_item", {
    kind: "skill",
    id: target.id,
    project_key: "alpha",
    response_mode: "full",
  });
  assert.equal(detail.isError, undefined);
  assert.equal(detail.structuredContent.items[0].kind, "skill");
  assertModelVisibleBudget(detail, "full", "skill detail");
  assert.ok(detail.structuredContent.next_cursor, "large skill detail must issue a continuation cursor");
  const staleCursor = detail.structuredContent.next_cursor;

  const candidateDetail = await call(client, "get_memory_item", {
    kind: "skill_candidate",
    id: pendingCandidate.id,
    project_key: "alpha",
    response_mode: "compact",
  });
  assert.equal(candidateDetail.isError, undefined);
  assert.equal(candidateDetail.structuredContent.items[0].kind, "skill_candidate");
  assertModelVisibleBudget(candidateDetail, "compact", "skill candidate detail");

  const denied = await call(client, "get_memory_item", {
    kind: "skill",
    id: target.id,
    project_key: "beta",
    response_mode: "compact",
  });
  assert.equal(denied.isError, true, "cross-scope skill detail must fail closed");

  const rejected = await call(client, "approve_pending_mutation", {
    mutation_id: rejectCandidate.mutation_id,
    decision: "reject",
  });
  assert.equal(rejected.isError, undefined);
  assert.equal(rejected.structuredContent.candidate_state, "rejected");

  const approvals = await Promise.all(Array.from({ length: 2 }, () => call(client, "approve_pending_mutation", {
    mutation_id: pendingCandidate.mutation_id,
    decision: "approve",
  })));
  for (const approved of approvals) {
    assert.equal(approved.isError, undefined);
    assert.equal(approved.structuredContent.candidate_state, "applied");
    assert.equal(approved.structuredContent.skill_id, target.id);
  }
  assert.deepEqual(approvals.map((item) => item.structuredContent.idempotent).sort(), [false, true],
    "concurrent double approval must report one application and one idempotent replay");

  const staleDetail = await call(client, "get_memory_item", {
    kind: "skill",
    id: target.id,
    project_key: "alpha",
    response_mode: "full",
    cursor: staleCursor,
  });
  assert.equal(staleDetail.isError, true, "skill revision drift must invalidate detail cursors");

  const rolledBack = await call(client, "approve_pending_mutation", {
    mutation_id: pendingCandidate.mutation_id,
    decision: "rollback",
  });
  assert.equal(rolledBack.isError, undefined);
  assert.equal(rolledBack.structuredContent.candidate_state, "rolled_back");
  assert.equal(rolledBack.structuredContent.idempotent, false);

  const repeatedRollback = await call(client, "approve_pending_mutation", {
    mutation_id: pendingCandidate.mutation_id,
    decision: "rollback",
  });
  assert.equal(repeatedRollback.isError, undefined);
  assert.equal(repeatedRollback.structuredContent.idempotent, true);

  const staleRollback = await call(client, "approve_pending_mutation", {
    mutation_id: firstUpdateCandidate.mutation_id,
    decision: "rollback",
  });
  assert.equal(staleRollback.isError, true, "rollback over a newer current revision must fail closed");

  const clearAll = await call(client, "clear_data", { collection: "all", confirm: true });
  assert.equal(clearAll.isError, undefined, "journaled clear all must succeed");
  const clearedSkill = await call(client, "get_memory_item", {
    kind: "skill",
    id: target.id,
    project_key: "alpha",
    response_mode: "compact",
  });
  assert.equal(clearedSkill.isError, true, "journaled clear all must remove MCP-managed skills");
  const pendingAfterClear = await call(client, "list_pending_mutations", { response_mode: "compact" });
  assert.equal((pendingAfterClear.structuredContent?.items ?? [])
    .some((item) => item.operation === "apply_skill_candidate"), false,
  "journaled clear all must remove dangling skill mutations");

  console.log("v22.1 skill MCP recall/detail/approval tests passed");
} finally {
  await close?.().catch(() => undefined);
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  await rm(tempHome, { recursive: true, force: true });
}
