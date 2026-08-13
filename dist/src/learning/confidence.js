import { EvidenceReferenceSchema } from "./provenance.js";
export function evidenceAdjustedConfidence(baseConfidence, evidence) {
    if (!Number.isFinite(baseConfidence) || baseConfidence < 0 || baseConfidence > 1) {
        throw new Error("baseConfidence must be between 0 and 1");
    }
    const parsed = evidence.map((item) => EvidenceReferenceSchema.parse(item));
    const counts = { active: 0, invalidated: 0, contradictory: 0 };
    for (const item of parsed)
        counts[item.status] += 1;
    const total = parsed.length;
    if (total === 0)
        return { confidence: baseConfidence, ...counts };
    const usableRatio = counts.active / total;
    const contradictionPenalty = counts.contradictory / total * 0.5;
    const confidence = Math.max(0, Math.min(1, baseConfidence * usableRatio - contradictionPenalty));
    return { confidence, ...counts };
}
