import { createHash } from "node:crypto";
import { completeReviewCandidateMutation, claimPendingMutation, enqueueReviewCandidateRecords, getReviewCandidateRecord, listReviewCandidateRecords, rejectReviewCandidateMutation, releasePendingMutation, reviewCandidateCounts, reviewCandidateIdsExist, upsertHeuristicsBatch, validateReviewCandidateMutation, } from "../storage.js";
function candidateId(input) {
    const digest = createHash("sha256").update(JSON.stringify({
        scope: input.scope,
        stage: input.stage,
        source_fingerprint: input.source_fingerprint,
        heuristic: input.heuristic.trim().replace(/\s+/g, " ").toLowerCase(),
        domain: input.domain,
    }), "utf8").digest("hex");
    return `review:${digest.slice(0, 32)}`;
}
export async function enqueueReviewCandidates(inputs) {
    return enqueueReviewCandidateRecords(inputs.map((input) => ({ ...input, id: candidateId(input) })));
}
export async function enqueueReviewCandidateMutation(input) {
    const [candidate] = await enqueueReviewCandidates([input]);
    if (!candidate)
        throw new Error("Review candidate was not persisted");
    return candidate;
}
export async function getReviewCandidate(id) {
    return getReviewCandidateRecord(id);
}
export async function listReviewCandidates(scope) {
    return listReviewCandidateRecords(scope);
}
export async function durableReviewCandidateIds(ids) {
    return reviewCandidateIdsExist(ids);
}
export async function reviewQueueCounts(scope) {
    return reviewCandidateCounts(scope);
}
export async function replayReviewCandidateMutation(mutation) {
    const candidate = await validateReviewCandidateMutation(mutation);
    const [saved] = await upsertHeuristicsBatch([{
            scope: candidate.scope,
            domain: candidate.domain,
            heuristic: candidate.heuristic,
            source_task: `${candidate.stage}_background_review:${candidate.source_fingerprint.slice(0, 12)}`,
            confidence: candidate.confidence,
            tags: candidate.tags,
        }]);
    if (!saved)
        throw new Error(`Review candidate ${candidate.id} did not produce a heuristic`);
    return { candidate, heuristic_id: saved.id };
}
export async function completeReviewCandidate(mutationId, claimToken) {
    return completeReviewCandidateMutation(mutationId, claimToken);
}
export async function rejectReviewCandidate(mutationId) {
    return rejectReviewCandidateMutation(mutationId);
}
export async function autoApplyReviewCandidate(candidate) {
    if (candidate.state !== "pending" || !candidate.mutation_id)
        return null;
    const claim = await claimPendingMutation(candidate.mutation_id);
    if (!claim)
        return null;
    try {
        const replayed = await replayReviewCandidateMutation(claim.mutation);
        const completed = await completeReviewCandidate(claim.mutation.id, claim.claimToken);
        if (!completed)
            throw new Error(`Review candidate ${candidate.id} replayed but was not finalized`);
        return { heuristic_id: replayed.heuristic_id };
    }
    catch (error) {
        await releasePendingMutation(claim.mutation.id, claim.claimToken);
        throw error;
    }
}
