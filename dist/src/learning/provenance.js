import { z } from "zod";
export const EvidenceSourceTypeSchema = z.enum([
    "reflection",
    "memory",
    "heuristic",
    "external",
]);
export const EvidenceReferenceSchema = z.object({
    source_type: EvidenceSourceTypeSchema,
    source_id: z.string().min(1).max(200),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    observed_at: z.string().datetime({ offset: true }),
    status: z.enum(["active", "invalidated", "contradictory"]).default("active"),
}).strict();
