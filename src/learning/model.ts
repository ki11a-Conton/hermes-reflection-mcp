import { z } from "zod";
import type { Heuristic, MemoryEntry, MemoryScope } from "../../types.js";
import { EvidenceReferenceSchema, type EvidenceReference, type EvidenceReferenceInput } from "./provenance.js";

const ScopeSchema = z.union([
  z.literal("global"),
  z.string().regex(/^project:[A-Za-z0-9._:-]{1,128}$/),
]);
const TimestampSchema = z.string().datetime({ offset: true });
const ConfidenceSchema = z.number().min(0).max(1);

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function boundedCodePoints(minimum: number, maximum: number, label: string) {
  return z.string().superRefine((value, context) => {
    const length = codePointLength(value);
    if (length < minimum || length > maximum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must contain ${minimum}-${maximum} Unicode code points`,
      });
    }
    if (value.trim().length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must contain non-whitespace text`,
      });
    }
  });
}

const SharedLearningFields = {
  id: z.string().min(1).max(200),
  scope: ScopeSchema,
  confidence: ConfidenceSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  provenance: z.array(EvidenceReferenceSchema).max(100),
};

export const MemoryLearningItemSchema = z.object({
  ...SharedLearningFields,
  type: z.literal("memory"),
  content: z.object({
    kind: z.literal("fact"),
    text: z.string().min(1).max(12_000),
  }).strict(),
}).strict();

export const HeuristicLearningItemSchema = z.object({
  ...SharedLearningFields,
  type: z.literal("heuristic"),
  content: z.object({
    kind: z.literal("guidance"),
    text: z.string().min(1).max(12_000),
    domain: z.string().min(1).max(200),
    tags: z.array(z.string().min(1).max(100)).max(50),
  }).strict(),
}).strict();

export const SkillProcedureContentSchema = z.object({
    kind: z.literal("procedure"),
    title: boundedCodePoints(1, 200, "title"),
    summary: boundedCodePoints(1, 2_000, "summary"),
    steps: z.array(boundedCodePoints(1, 1_500, "step")).min(1).max(40),
    domain: boundedCodePoints(1, 200, "domain").default("general"),
    tags: z.array(boundedCodePoints(1, 100, "tag")).max(50).default([]),
  }).strict().superRefine((content, context) => {
    const procedureLength = [
      content.title,
      content.summary,
      ...content.steps,
      content.domain,
      ...content.tags,
    ].reduce((total, value) => total + codePointLength(value), 0);
    if (procedureLength > 24_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "complete procedure content must not exceed 24,000 Unicode code points",
      });
    }
  });

export const SkillLearningItemSchema = z.object({
  ...SharedLearningFields,
  type: z.literal("skill"),
  provenance: z.array(EvidenceReferenceSchema).min(1).max(100),
  content: SkillProcedureContentSchema,
}).strict();

export const LearningItemSchema = z.discriminatedUnion("type", [
  MemoryLearningItemSchema,
  HeuristicLearningItemSchema,
  SkillLearningItemSchema,
]);

export type LearningItem = z.infer<typeof LearningItemSchema>;
export type SkillLearningItem = z.infer<typeof SkillLearningItemSchema>;

export function projectMemoryEntry(
  entry: MemoryEntry,
  scope: MemoryScope,
  confidence: number,
  provenance: EvidenceReferenceInput[] = [],
): LearningItem {
  return MemoryLearningItemSchema.parse({
    id: entry.id,
    type: "memory",
    scope,
    confidence,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    provenance,
    content: { kind: "fact", text: entry.content },
  });
}

export function projectHeuristic(heuristic: Heuristic): LearningItem {
  const provenance = heuristic.evidence.map((item): EvidenceReference => ({
    source_type: item.source_reflection_id ? "reflection" : "heuristic",
    source_id: item.source_reflection_id ?? item.id,
    content_hash: item.content_hash,
    observed_at: item.created_at,
    status: "active",
  }));
  return HeuristicLearningItemSchema.parse({
    id: heuristic.id,
    type: "heuristic",
    scope: heuristic.scope,
    confidence: heuristic.confidence,
    created_at: heuristic.created_at,
    updated_at: heuristic.updated_at,
    provenance,
    content: {
      kind: "guidance",
      text: heuristic.heuristic,
      domain: heuristic.domain,
      tags: heuristic.tags,
    },
  });
}
