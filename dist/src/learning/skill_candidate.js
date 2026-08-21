import { createHash } from "node:crypto";
import { z } from "zod";
import { SkillLearningItemSchema, SkillProcedureContentSchema } from "./model.js";
import { EvidenceReferenceSchema } from "./provenance.js";
import { canonicalizeStable, compareStableText, stableUniqueSorted } from "../stable_order.js";
const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const ScopeSchema = z.union([
    z.literal("global"),
    z.string().regex(/^project:[A-Za-z0-9._:-]{1,128}$/),
]);
function sha256Canonical(value) {
    return createHash("sha256").update(JSON.stringify(canonicalizeStable(value))).digest("hex");
}
function uniqueSorted(values) {
    return stableUniqueSorted(values);
}
export const SkillRevisionAuditSchema = z.object({
    revision: z.number().int().positive(),
    content_hash: HashSchema,
    origin_candidate_id: IdentifierSchema,
    created_at: TimestampSchema,
}).strict();
const SkillRevisionObjectSchema = z.object({
    revision: z.number().int().positive(),
    title: z.string(),
    summary: z.string(),
    steps: z.array(z.string()).min(1).max(40),
    domain: z.string(),
    tags: z.array(z.string()).max(50),
    confidence: z.number().min(0).max(1),
    provenance: z.array(EvidenceReferenceSchema).min(2).max(100),
    content_hash: HashSchema,
    origin_candidate_id: IdentifierSchema,
    created_at: TimestampSchema,
    rollback_of_candidate_id: IdentifierSchema.optional(),
}).strict();
export function skillRevisionContentHash(input) {
    return sha256Canonical(input);
}
export const SkillRevisionSchema = SkillRevisionObjectSchema.superRefine((revision, context) => {
    const procedure = SkillProcedureContentSchema.safeParse({
        kind: "procedure",
        title: revision.title,
        summary: revision.summary,
        steps: revision.steps,
        domain: revision.domain,
        tags: revision.tags,
    });
    if (!procedure.success) {
        for (const issue of procedure.error.issues) {
            context.addIssue({ ...issue, path: issue.path.filter((part) => part !== "kind") });
        }
    }
    const provenanceIds = new Set();
    revision.provenance.forEach((item, index) => {
        const identity = `${item.source_type}\u0000${item.source_id}`;
        if (provenanceIds.has(identity)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["provenance", index],
                message: "provenance source identities must be unique",
            });
        }
        provenanceIds.add(identity);
    });
    const { content_hash: _contentHash, ...body } = revision;
    const expected = skillRevisionContentHash(body);
    if (revision.content_hash !== expected) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["content_hash"],
            message: "content_hash does not match revision content",
        });
    }
});
export const SkillRecordSchema = z.object({
    id: IdentifierSchema,
    scope: ScopeSchema,
    status: z.enum(["active", "disabled"]),
    current_revision: z.number().int().positive(),
    revisions: z.array(SkillRevisionSchema).min(1).max(20),
    compacted_revision_audit: z.array(SkillRevisionAuditSchema).max(100),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
}).strict().superRefine((record, context) => {
    const newest = record.revisions.at(-1);
    if (newest === undefined || newest.revision !== record.current_revision) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["current_revision"],
            message: "current_revision must equal the newest retained full revision",
        });
    }
    for (let index = 1; index < record.revisions.length; index += 1) {
        if (record.revisions[index].revision !== record.revisions[index - 1].revision + 1) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["revisions", index, "revision"],
                message: "full revision numbers must be contiguous and monotonic",
            });
            break;
        }
    }
    const seen = new Set(record.revisions.map((revision) => revision.revision));
    let previousAuditRevision = 0;
    const oldestFullRevision = record.revisions[0]?.revision ?? Number.POSITIVE_INFINITY;
    record.compacted_revision_audit.forEach((audit, index) => {
        if (audit.revision <= previousAuditRevision || audit.revision >= oldestFullRevision || seen.has(audit.revision)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["compacted_revision_audit", index, "revision"],
                message: "compacted revision audit must be unique, monotonic, and older than full revisions",
            });
        }
        previousAuditRevision = audit.revision;
        seen.add(audit.revision);
    });
});
export const SkillPromotionActionSchema = z.enum(["create", "update"]);
export const SkillPromotionStateSchema = z.enum([
    "pending",
    "approved",
    "applied",
    "rejected",
    "superseded",
    "rolled_back",
]);
export const SkillPromotionTransitionSchema = z.object({
    from: SkillPromotionStateSchema,
    to: SkillPromotionStateSchema,
    at: TimestampSchema,
    reason: z.string().min(1).max(500),
}).strict();
export const SkillPromotionDirtyScopeSchema = z.object({
    scope: ScopeSchema,
    dirty_at: TimestampSchema,
    completed_fingerprint: HashSchema.optional(),
    completed_at: TimestampSchema.optional(),
    last_outcome_class: z.string().min(1).max(100).optional(),
}).strict().superRefine((item, context) => {
    if ((item.completed_fingerprint === undefined) !== (item.completed_at === undefined)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["completed_fingerprint"],
            message: "completed_fingerprint and completed_at must be present together",
        });
    }
});
export const SkillPromotionMetadataSchema = z.object({
    dirty_scopes: z.array(SkillPromotionDirtyScopeSchema).max(1_000),
}).strict();
/** Compare normalized instants; valid RFC 3339 offsets are not lexically chronological. */
export function isSkillPromotionScopeDirty(item) {
    if (item.completed_at === undefined)
        return true;
    const dirtyAt = Date.parse(item.dirty_at);
    const completedAt = Date.parse(item.completed_at);
    return !Number.isFinite(dirtyAt) || !Number.isFinite(completedAt) || dirtyAt > completedAt;
}
const PROMOTION_TRANSITIONS = {
    pending: ["approved", "rejected", "superseded"],
    approved: ["applied", "rejected", "superseded"],
    applied: ["rolled_back", "superseded"],
    rejected: [],
    superseded: [],
    rolled_back: [],
};
function promotionFingerprintProjection(input) {
    const revision = input.proposed_revision;
    return {
        action: input.action,
        scope: input.scope,
        target_skill_id: input.target_skill_id,
        expected_target_revision: input.expected_target_revision,
        proposed_revision: {
            revision: revision.revision,
            title: revision.title,
            summary: revision.summary,
            steps: revision.steps,
            domain: revision.domain,
            tags: revision.tags,
            confidence: revision.confidence,
            provenance: [...revision.provenance].sort((left, right) => {
                const leftKey = `${left.source_type}\u0000${left.source_id}\u0000${left.content_hash}`;
                const rightKey = `${right.source_type}\u0000${right.source_id}\u0000${right.content_hash}`;
                return compareStableText(leftKey, rightKey);
            }),
            rollback_of_candidate_id: revision.rollback_of_candidate_id,
        },
        source_heuristic_ids: uniqueSorted(input.source_heuristic_ids),
        source_reflection_ids: uniqueSorted(input.source_reflection_ids),
        cluster_algorithm: input.cluster_algorithm,
        cluster_fingerprint: input.cluster_fingerprint,
        evidence_fingerprint: input.evidence_fingerprint,
        confidence: input.confidence,
        risk: input.risk,
        risk_reasons: uniqueSorted(input.risk_reasons),
    };
}
export function skillPromotionCandidateFingerprint(input) {
    return sha256Canonical(promotionFingerprintProjection(input));
}
const SkillPromotionCandidateObjectSchema = z.object({
    id: IdentifierSchema,
    action: SkillPromotionActionSchema,
    scope: ScopeSchema,
    target_skill_id: IdentifierSchema.optional(),
    expected_target_revision: z.number().int().positive().optional(),
    proposed_revision: SkillRevisionSchema,
    source_heuristic_ids: z.array(IdentifierSchema).min(1).max(100),
    source_reflection_ids: z.array(IdentifierSchema).min(2).max(100),
    cluster_algorithm: z.string().min(1).max(100),
    cluster_fingerprint: HashSchema,
    evidence_fingerprint: HashSchema,
    confidence: z.number().min(0).max(1),
    risk: z.enum(["low", "medium", "high"]),
    risk_reasons: z.array(z.string().min(1).max(500)).max(50),
    state: SkillPromotionStateSchema,
    fingerprint: HashSchema,
    mutation_id: IdentifierSchema.optional(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    history: z.array(SkillPromotionTransitionSchema).max(100),
}).strict();
export const SkillPromotionCandidateSchema = SkillPromotionCandidateObjectSchema.superRefine((candidate, context) => {
    if (candidate.action === "create") {
        if (candidate.target_skill_id !== undefined || candidate.expected_target_revision !== undefined) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["target_skill_id"],
                message: "create must not set target_skill_id or expected_target_revision",
            });
        }
        if (candidate.proposed_revision.revision !== 1) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["proposed_revision", "revision"],
                message: "create must propose revision 1",
            });
        }
    }
    else {
        if (candidate.target_skill_id === undefined || candidate.expected_target_revision === undefined) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["target_skill_id"],
                message: "update requires target_skill_id and expected_target_revision",
            });
        }
        else if (candidate.proposed_revision.revision !== candidate.expected_target_revision + 1) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["proposed_revision", "revision"],
                message: "update must propose the revision after expected_target_revision",
            });
        }
    }
    if (candidate.proposed_revision.origin_candidate_id !== candidate.id) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["proposed_revision", "origin_candidate_id"],
            message: "revision origin_candidate_id must match the candidate ID",
        });
    }
    if (uniqueSorted(candidate.source_heuristic_ids).length !== candidate.source_heuristic_ids.length) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["source_heuristic_ids"],
            message: "source heuristic IDs must be unique",
        });
    }
    if (uniqueSorted(candidate.source_reflection_ids).length !== candidate.source_reflection_ids.length) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["source_reflection_ids"],
            message: "source reflection IDs must be unique",
        });
    }
    const expectedFingerprint = skillPromotionCandidateFingerprint(candidate);
    if (candidate.fingerprint !== expectedFingerprint) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["fingerprint"],
            message: "fingerprint does not match candidate content",
        });
    }
    let state = "pending";
    candidate.history.forEach((entry, index) => {
        if (entry.from !== state || !PROMOTION_TRANSITIONS[state].includes(entry.to)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["history", index],
                message: "history contains an illegal transition",
            });
            return;
        }
        state = entry.to;
    });
    if (candidate.state !== state) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["state"],
            message: "state does not match transition history",
        });
    }
    const expectedUpdatedAt = candidate.history.at(-1)?.at ?? candidate.created_at;
    if (candidate.updated_at !== expectedUpdatedAt) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["updated_at"],
            message: "updated_at must match the latest transition timestamp",
        });
    }
    if (["pending", "approved", "applied", "rolled_back"].includes(candidate.state)
        && candidate.mutation_id === undefined) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["mutation_id"],
            message: "an approvable or applied candidate requires mutation_id",
        });
    }
    if (candidate.risk === "high" && (candidate.state !== "rejected" || candidate.mutation_id !== undefined)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["risk"],
            message: "high-risk candidates must be terminal rejected without a mutation_id",
        });
    }
});
const CreateSkillPromotionCandidateInputSchema = SkillPromotionCandidateObjectSchema.omit({
    state: true,
    fingerprint: true,
    updated_at: true,
    history: true,
});
export function createSkillPromotionCandidate(input) {
    const parsed = CreateSkillPromotionCandidateInputSchema.parse(input);
    const normalized = {
        ...parsed,
        source_heuristic_ids: uniqueSorted(parsed.source_heuristic_ids),
        source_reflection_ids: uniqueSorted(parsed.source_reflection_ids),
        risk_reasons: uniqueSorted(parsed.risk_reasons),
    };
    const blocked = normalized.mutation_id === undefined
        && (normalized.risk !== "low" || normalized.risk_reasons.length > 0);
    const history = blocked
        ? [{
                from: "pending",
                to: "rejected",
                at: normalized.created_at,
                reason: normalized.risk_reasons.join("; ").slice(0, 500) || "blocked proposal",
            }]
        : [];
    return SkillPromotionCandidateSchema.parse({
        ...normalized,
        state: blocked ? "rejected" : "pending",
        fingerprint: skillPromotionCandidateFingerprint(normalized),
        updated_at: normalized.created_at,
        history,
    });
}
export function transitionSkillPromotionCandidate(candidate, next, at, reason) {
    const current = SkillPromotionCandidateSchema.parse(candidate);
    if (!PROMOTION_TRANSITIONS[current.state].includes(next)) {
        throw new Error(`Illegal skill-promotion transition: ${current.state} -> ${next}`);
    }
    return SkillPromotionCandidateSchema.parse({
        ...current,
        state: next,
        updated_at: at,
        history: [...current.history, { from: current.state, to: next, at, reason }],
    });
}
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
    let state = "pending";
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
function candidateFingerprint(input) {
    return createHash("sha256").update(JSON.stringify(canonicalizeStable(input))).digest("hex");
}
export function createSkillCandidate(input) {
    const { id, created_at, ...fingerprinted } = input;
    return SkillCandidateSchema.parse({
        ...input,
        state: "pending",
        fingerprint: candidateFingerprint(fingerprinted),
        updated_at: created_at,
        history: [],
    });
}
const ALLOWED_TRANSITIONS = {
    pending: ["approved", "rejected", "superseded"],
    approved: ["applied", "rejected", "superseded"],
    applied: ["rolled_back", "superseded"],
    rejected: [],
    superseded: [],
    rolled_back: [],
};
export function transitionSkillCandidate(candidate, next, at, reason) {
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
