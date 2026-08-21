import { applyClaimedSkillCandidateMutation, claimPendingMutation, enqueueSkillCandidateRecords, getSkillCandidateRecord, getSkillRecord, listSkillCandidateRecords, listSkillRecords, rejectSkillCandidateMutation, releasePendingMutation, rollbackAppliedSkillCandidate, } from "../storage.js";
export function enqueueSkillCandidates(drafts) {
    return enqueueSkillCandidateRecords(drafts);
}
export function listSkillCandidates(scope) {
    return listSkillCandidateRecords(scope);
}
export function getSkillCandidate(id) {
    return getSkillCandidateRecord(id);
}
export async function claimSkillCandidateMutation(mutationId) {
    const claim = await claimPendingMutation(mutationId);
    if (!claim || claim.mutation.operation === "apply_skill_candidate")
        return claim;
    await releasePendingMutation(mutationId, claim.claimToken);
    return null;
}
export function completeSkillCandidateMutation(mutationId, claimToken) {
    return applyClaimedSkillCandidateMutation(mutationId, claimToken);
}
async function appliedReplayResult(mutationId) {
    const candidates = await listSkillCandidateRecords();
    const candidate = candidates.find((item) => item.mutation_id === mutationId && item.state === "applied");
    if (!candidate)
        return null;
    const skill = candidate.target_skill_id
        ? await getSkillRecord(candidate.target_skill_id)
        : (await listSkillRecords(candidate.scope)).find((item) => item.revisions.some((revision) => revision.origin_candidate_id === candidate.id)) ?? null;
    return skill ? { candidate, skill, idempotent: true } : null;
}
export async function replaySkillCandidateMutation(mutationId) {
    const claim = await claimSkillCandidateMutation(mutationId);
    if (!claim)
        return appliedReplayResult(mutationId);
    try {
        const result = await completeSkillCandidateMutation(mutationId, claim.claimToken);
        if (result)
            return { ...result, idempotent: false };
        await releasePendingMutation(mutationId, claim.claimToken);
        return null;
    }
    catch (error) {
        await releasePendingMutation(mutationId, claim.claimToken);
        throw error;
    }
}
export function rejectSkillCandidate(mutationId) {
    return rejectSkillCandidateMutation(mutationId);
}
export function rollbackSkillCandidate(mutationId) {
    return rollbackAppliedSkillCandidate(mutationId);
}
