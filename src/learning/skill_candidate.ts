import { createHash } from "node:crypto";
import { z } from "zod";
import { SkillLearningItemSchema } from "./model.js";

export const SkillCandidateActionSchema = z.enum([
  "create",
  "update",
  "add_reference",
  "add_script",
  "add_template",
]);
export const SkillCandidateStateSchema = z.enum([
  "pending",
  "approved",
  "applied",
  "rejected",
  "superseded",
  "rolled_back",
]);

const TransitionSchema = z.object({
  from: SkillCandidateStateSchema,
  to: SkillCandidateStateSchema,
  at: z.string().datetime({ offset: true }),
  reason: z.string().min(1).max(500),
}).strict();

export const SkillCandidateSchema = z.object({
  id: z.string().min(1).max(200),
  action: SkillCandidateActionSchema,
  target_skill_id: z.string().min(1).max(200).optional(),
  proposed_skill: SkillLearningItemSchema,
  confidence: z.number().min(0).max(1),
  risk: z.enum(["low", "medium", "high"]),
  state: SkillCandidateStateSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  history: z.array(TransitionSchema).max(100),
}).strict().superRefine((candidate, context) => {
  if (candidate.action === "create" && candidate.target_skill_id !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target_skill_id"], message: "create must not set target_skill_id" });
  }
  if (candidate.action !== "create" && candidate.target_skill_id === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target_skill_id"], message: "target_skill_id is required for this action" });
  }
  const expectedFingerprint = candidateFingerprint({
    action: candidate.action,
    target_skill_id: candidate.target_skill_id,
    proposed_skill: candidate.proposed_skill,
    confidence: candidate.confidence,
    risk: candidate.risk,
  });
  if (candidate.fingerprint !== expectedFingerprint) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fingerprint"], message: "fingerprint does not match candidate content" });
  }
  let state: SkillCandidateState = "pending";
  for (let index = 0; index < candidate.history.length; index += 1) {
    const entry = candidate.history[index];
    if (entry.from !== state || !ALLOWED_TRANSITIONS[state].includes(entry.to)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["history", index], message: "history contains an illegal transition" });
      return;
    }
    state = entry.to;
  }
  if (candidate.state !== state) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "state does not match transition history" });
  }
});

export type SkillCandidate = z.infer<typeof SkillCandidateSchema>;
export type SkillCandidateState = z.infer<typeof SkillCandidateStateSchema>;

interface CreateSkillCandidateInput {
  id: string;
  action: z.infer<typeof SkillCandidateActionSchema>;
  target_skill_id?: string;
  proposed_skill: z.infer<typeof SkillLearningItemSchema>;
  confidence: number;
  risk: "low" | "medium" | "high";
  created_at: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function candidateFingerprint(input: Omit<CreateSkillCandidateInput, "id" | "created_at">): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
}

export function createSkillCandidate(input: CreateSkillCandidateInput): SkillCandidate {
  const { id, created_at, ...fingerprinted } = input;
  return SkillCandidateSchema.parse({
    ...input,
    state: "pending",
    fingerprint: candidateFingerprint(fingerprinted),
    updated_at: created_at,
    history: [],
  });
}

const ALLOWED_TRANSITIONS: Readonly<Record<SkillCandidateState, readonly SkillCandidateState[]>> = {
  pending: ["approved", "rejected", "superseded"],
  approved: ["applied", "rejected", "superseded"],
  applied: ["rolled_back", "superseded"],
  rejected: [],
  superseded: [],
  rolled_back: [],
};

export function transitionSkillCandidate(
  candidate: SkillCandidate,
  next: SkillCandidateState,
  at: string,
  reason: string,
): SkillCandidate {
  const current = SkillCandidateSchema.parse(candidate);
  if (!ALLOWED_TRANSITIONS[current.state].includes(next)) {
    throw new Error(`Illegal skill-candidate transition: ${current.state} -> ${next}`);
  }
  return SkillCandidateSchema.parse({
    ...current,
    state: next,
    updated_at: at,
    history: [...current.history, { from: current.state, to: next, at, reason }],
  });
}
