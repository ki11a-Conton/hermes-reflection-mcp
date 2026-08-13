import assert from "node:assert/strict";
import {
  LearningItemSchema,
  projectHeuristic,
  projectMemoryEntry,
} from "../dist/src/learning/model.js";
import {
  SkillCandidateSchema,
  createSkillCandidate,
  transitionSkillCandidate,
} from "../dist/src/learning/skill_candidate.js";
import { evidenceAdjustedConfidence } from "../dist/src/learning/confidence.js";

const NOW = "2026-08-13T00:00:00.000Z";
const evidence = {
  source_type: "reflection",
  source_id: "reflection-1",
  content_hash: "a".repeat(64),
  observed_at: NOW,
};

const memory = projectMemoryEntry({
  id: "memory-1",
  content: "The repository uses ESM.",
  created_at: NOW,
  updated_at: NOW,
  source_reflection_id: "reflection-1",
}, "project:hermes", 0.7, [evidence]);
assert.equal(memory.type, "memory");
assert.equal(memory.content.kind, "fact");
assert.equal(memory.scope, "project:hermes");
assert.equal(memory.provenance.length, 1);
assert.equal(memory.provenance[0].status, "active");

const heuristic = projectHeuristic({
  id: "heuristic-1",
  created_at: NOW,
  updated_at: NOW,
  domain: "testing",
  heuristic: "Run the provider-schema compatibility test before release.",
  source_task: "OpenCode compatibility",
  scope: "project:hermes",
  evidence: [{
    id: "evidence-1",
    source_reflection_id: "reflection-1",
    source_task: "OpenCode compatibility",
    content_hash: "b".repeat(64),
    created_at: NOW,
  }],
  feedback: [],
  reinforcement_count: 1,
  contradiction_count: 0,
  contradiction_notes: [],
  confidence: 0.9,
  retrieval_count: 0,
  version: 1,
  tags: ["schema"],
});
assert.equal(heuristic.type, "heuristic");
assert.equal(heuristic.content.kind, "guidance");
assert.equal(heuristic.provenance[0].source_type, "reflection");

assert.throws(() => LearningItemSchema.parse({
  ...memory,
  type: "skill",
}), /procedure|skill/i, "memory content must not be relabelled as a skill");

const proposedSkill = LearningItemSchema.parse({
  id: "skill-1",
  type: "skill",
  scope: "project:hermes",
  confidence: 0.82,
  created_at: NOW,
  updated_at: NOW,
  provenance: [evidence],
  content: {
    kind: "procedure",
    title: "Validate provider schemas",
    summary: "Check public tool schemas before packaging.",
    steps: ["Build the project.", "Run the schema compatibility test."],
  },
});

assert.throws(() => LearningItemSchema.parse({
  ...proposedSkill,
  provenance: [],
}), /provenance/i, "skills require traceable provenance");

const pending = createSkillCandidate({
  id: "candidate-1",
  action: "create",
  proposed_skill: proposedSkill,
  confidence: 0.82,
  risk: "low",
  created_at: NOW,
});
assert.equal(pending.state, "pending");
assert.equal(pending.fingerprint.length, 64);
assert.deepEqual(
  createSkillCandidate({
    id: "candidate-2",
    action: "create",
    proposed_skill: proposedSkill,
    confidence: 0.82,
    risk: "low",
    created_at: NOW,
  }).fingerprint,
  pending.fingerprint,
  "candidate fingerprint must ignore record identity",
);

const approved = transitionSkillCandidate(pending, "approved", NOW, "human-review");
const applied = transitionSkillCandidate(approved, "applied", NOW, "transaction-1");
const rolledBack = transitionSkillCandidate(applied, "rolled_back", NOW, "rollback-1");
assert.deepEqual(rolledBack.history.map((entry) => entry.to), ["approved", "applied", "rolled_back"]);
assert.throws(() => transitionSkillCandidate(pending, "applied", NOW, "skip-review"), /transition/i);
assert.throws(() => transitionSkillCandidate(rolledBack, "approved", NOW, "retry"), /transition/i);

assert.throws(() => SkillCandidateSchema.parse({
  ...pending,
  action: "update",
}), /target_skill_id/i, "mutating an existing skill requires a target");

assert.throws(() => SkillCandidateSchema.parse({
  ...pending,
  state: "applied",
}), /history/i, "candidate state cannot be forged without an audited transition history");
assert.throws(() => SkillCandidateSchema.parse({
  ...pending,
  proposed_skill: { ...pending.proposed_skill, confidence: 0.99 },
}), /fingerprint/i, "candidate content cannot change without changing its fingerprint");

const activeConfidence = evidenceAdjustedConfidence(0.9, [evidence]);
const invalidatedConfidence = evidenceAdjustedConfidence(0.9, [{ ...evidence, status: "invalidated" }]);
const contradictoryConfidence = evidenceAdjustedConfidence(0.9, [{ ...evidence, status: "contradictory" }]);
assert.equal(activeConfidence.confidence, 0.9);
assert.equal(invalidatedConfidence.confidence, 0);
assert.equal(contradictoryConfidence.confidence, 0);

console.log("v22 learning object and skill-candidate tests passed");
