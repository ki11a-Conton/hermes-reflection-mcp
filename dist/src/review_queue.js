import { createHash } from "node:crypto";
import { applyClaimedReviewCandidateMutation, completeReviewCandidateMutation, claimPendingMutation, enqueueReviewCandidateRecords, getReviewCandidateRecord, listReviewCandidateRecords, rejectReviewCandidateMutation, releasePendingMutation, reviewCandidateCounts, reviewCandidateIdsExist, } from "../storage.js";
function candidateId(input) {
    const digest = createHash("sha256").update(JSON.stringify({
        scope: input.scope,
        stage: input.stage,
        source_fingerprint: input.source_fingerprint,
        evidence_fingerprint: input.evidence_fingerprint,
        source_reflection_ids: [...input.source_reflection_ids].sort(),
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
    if (!mutation.claim_token)
        throw new Error(`Review candidate mutation ${mutation.id} is not claimed`);
    const applied = await applyClaimedReviewCandidateMutation(mutation.id, mutation.claim_token);
    if (!applied)
        throw new Error(`Review candidate mutation ${mutation.id} lost its claim`);
    return { candidate: applied.candidate, heuristic_id: applied.heuristic.id };
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
        return { heuristic_id: replayed.heuristic_id };
    }
    catch (error) {
        await releasePendingMutation(claim.mutation.id, claim.claimToken);
        throw error;
    }
}
