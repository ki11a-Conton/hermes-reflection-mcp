import assert from "node:assert/strict";
import {
  SkillRecordSchema,
  SkillRevisionSchema,
  SkillPromotionCandidateSchema,
  createSkillPromotionCandidate,
  isSkillPromotionScopeDirty,
  skillRevisionContentHash,
  transitionSkillPromotionCandidate,
} from "../dist/src/learning/skill_candidate.js";

const NOW = "2026-08-16T00:00:00.000Z";
const LATER = "2026-08-16T00:01:00.000Z";
const provenance = [
  {
    source_type: "reflection",
    source_id: "r-1",
    content_hash: "a".repeat(64),
    observed_at: NOW,
    status: "active",
  },
  {
    source_type: "reflection",
    source_id: "r-2",
    content_hash: "b".repeat(64),
    observed_at: NOW,
    status: "active",
  },
];

function makeRevision(overrides = {}) {
  const body = {
    revision: 1,
    title: "Validate provider schemas",
    summary: "Validate exported MCP schemas before packaging.",
    steps: ["Build the package.", "Run provider-schema compatibility checks."],
    domain: "mcp-testing",
    tags: ["schema", "release"],
    confidence: 0.9,
    provenance,
    origin_candidate_id: "skill-candidate-1",
    created_at: NOW,
    ...overrides,
  };
  return SkillRevisionSchema.parse({
    ...body,
    content_hash: skillRevisionContentHash(body),
  });
}

const revision = makeRevision();
const record = SkillRecordSchema.parse({
  id: "skill-1",
  scope: "project:hermes",
  status: "active",
  current_revision: 1,
  revisions: [revision],
  compacted_revision_audit: [],
  created_at: NOW,
  updated_at: NOW,
});
assert.equal(record.revisions[0].domain, "mcp-testing");
assert.throws(
  () => SkillRecordSchema.parse({ ...record, current_revision: 2 }),
  /current_revision/i,
  "the current revision must exist and be the newest full revision",
);

const candidateInput = {
  id: "skill-candidate-1",
  action: "create",
  scope: "project:hermes",
  proposed_revision: revision,
  source_heuristic_ids: ["h-2", "h-1"],
  source_reflection_ids: ["r-2", "r-1"],
  cluster_algorithm: "v1",
  cluster_fingerprint: "d".repeat(64),
  evidence_fingerprint: "e".repeat(64),
  confidence: 0.9,
  risk: "low",
  risk_reasons: [],
  mutation_id: "skill-mutation-1",
  created_at: NOW,
};
const candidate = createSkillPromotionCandidate(candidateInput);
assert.equal(candidate.state, "pending");
const applied = transitionSkillPromotionCandidate(
  transitionSkillPromotionCandidate(candidate, "approved", NOW, "human approval"),
  "applied",
  LATER,
  "revision 1",
);
assert.equal(applied.history.length, 2);
assert.throws(
  () => SkillPromotionCandidateSchema.parse({ ...candidate, action: "update" }),
  /target_skill_id|expected_target_revision/i,
);
assert.throws(
  () => SkillPromotionCandidateSchema.parse({
    ...candidate,
    proposed_revision: { ...revision, title: "forged" },
  }),
  /content_hash|fingerprint/i,
);

const reorderedCandidate = createSkillPromotionCandidate({
  id: "skill-candidate-2",
  action: "create",
  scope: "project:hermes",
  proposed_revision: makeRevision({ origin_candidate_id: "skill-candidate-2" }),
  source_heuristic_ids: ["h-1", "h-2"],
  source_reflection_ids: ["r-1", "r-2"],
  cluster_algorithm: "v1",
  cluster_fingerprint: "d".repeat(64),
  evidence_fingerprint: "e".repeat(64),
  confidence: 0.9,
  risk: "low",
  risk_reasons: [],
  mutation_id: "a-different-mutation-id",
  created_at: LATER,
});
assert.equal(
  reorderedCandidate.fingerprint,
  candidate.fingerprint,
  "candidate identity, timestamp, mutation ID, and source ordering must not alter its content fingerprint",
);

assert.throws(
  () => SkillRevisionSchema.parse({
    ...revision,
    steps: Array.from({ length: 41 }, (_, index) => `step-${index}`),
  }),
  /40|steps/i,
  "a revision is limited to 40 steps",
);
assert.throws(
  () => makeRevision({
    summary: "x".repeat(2_000),
    steps: Array.from({ length: 40 }, () => "y".repeat(600)),
  }),
  /24.?000|procedure|content/i,
  "aggregate procedure content is limited to 24,000 Unicode code points",
);
assert.throws(
  () => makeRevision({ provenance: [] }),
  /provenance/i,
  "a persisted revision requires provenance",
);
assert.throws(
  () => makeRevision({ provenance: [provenance[0], provenance[0]] }),
  /duplicate|unique|provenance/i,
  "a persisted revision must not count the same provenance record twice",
);
assert.throws(
  () => makeRevision({ title: "   " }),
  /title|blank|empty|whitespace/i,
  "a persisted procedure title must contain non-whitespace text",
);
assert.throws(
  () => makeRevision({ steps: ["\t\r\n"] }),
  /step|blank|empty|whitespace/i,
  "a persisted procedure step must contain non-whitespace text",
);
assert.throws(
  () => SkillRecordSchema.parse({
    ...record,
    current_revision: 3,
    revisions: [revision, makeRevision({ revision: 3, origin_candidate_id: "skill-candidate-3" })],
  }),
  /monotonic|revision/i,
  "full revisions must be contiguous and monotonic",
);
assert.throws(
  () => createSkillPromotionCandidate({ ...candidateInput, action: "add_script" }),
  /action|create|update/i,
  "external file actions are reserved and cannot enter the persisted promotion queue",
);
assert.throws(
  () => transitionSkillPromotionCandidate(candidate, "applied", LATER, "skip approval"),
  /transition/i,
);
assert.throws(
  () => createSkillPromotionCandidate({ ...candidateInput, mutation_id: undefined }),
  /mutation_id/i,
  "an approvable pending candidate requires a mutation ID",
);

const blocked = createSkillPromotionCandidate({
  ...candidateInput,
  id: "skill-candidate-blocked",
  proposed_revision: makeRevision({ origin_candidate_id: "skill-candidate-blocked" }),
  risk: "high",
  risk_reasons: ["contradictory evidence"],
  mutation_id: undefined,
});
assert.equal(blocked.mutation_id, undefined);
assert.equal(blocked.state, "rejected");
assert.equal(blocked.history[0].to, "rejected");

assert.equal(isSkillPromotionScopeDirty({
  scope: "project:hermes",
  dirty_at: "2026-08-16T00:30:00.000+01:00",
  completed_fingerprint: "f".repeat(64),
  completed_at: "2026-08-16T00:00:00.000Z",
}), false, "promotion watermark comparisons must use instants, not timestamp string collation");
assert.equal(isSkillPromotionScopeDirty({
  scope: "project:hermes",
  dirty_at: "2026-08-16T01:30:00.000+01:00",
  completed_fingerprint: "f".repeat(64),
  completed_at: "2026-08-16T00:00:00.000Z",
}), true);

console.log("v22.1 persisted skill model tests passed");
