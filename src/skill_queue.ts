import type { MemoryScope, SkillPromotionCandidate, SkillRecord } from "../types.js";
import {
  applyClaimedSkillCandidateMutation,
  claimPendingMutation,
  enqueueSkillCandidateRecords,
  getSkillCandidateRecord,
  getSkillRecord,
  listSkillCandidateRecords,
  listSkillRecords,
  rejectSkillCandidateMutation,
  releasePendingMutation,
  rollbackAppliedSkillCandidate,
  type PendingMutationClaim,
  type SkillCandidateDraft,
} from "../storage.js";

export function enqueueSkillCandidates(drafts: SkillCandidateDraft[]): Promise<SkillPromotionCandidate[]> {
  return enqueueSkillCandidateRecords(drafts);
}

export function listSkillCandidates(scope?: MemoryScope): Promise<SkillPromotionCandidate[]> {
  return listSkillCandidateRecords(scope);
}

export function getSkillCandidate(id: string): Promise<SkillPromotionCandidate | null> {
  return getSkillCandidateRecord(id);
}

export async function claimSkillCandidateMutation(mutationId: string): Promise<PendingMutationClaim | null> {
  const claim = await claimPendingMutation(mutationId);
  if (!claim || claim.mutation.operation === "apply_skill_candidate") return claim;
  await releasePendingMutation(mutationId, claim.claimToken);
  return null;
}

export function completeSkillCandidateMutation(
  mutationId: string,
  claimToken: string,
): Promise<{ candidate: SkillPromotionCandidate; skill: SkillRecord } | null> {
  return applyClaimedSkillCandidateMutation(mutationId, claimToken);
}

async function appliedReplayResult(
  mutationId: string,
): Promise<{ candidate: SkillPromotionCandidate; skill: SkillRecord; idempotent: true } | null> {
  const candidates = await listSkillCandidateRecords();
  const candidate = candidates.find((item) => item.mutation_id === mutationId && item.state === "applied");
  if (!candidate) return null;
  const skill = candidate.target_skill_id
    ? await getSkillRecord(candidate.target_skill_id)
    : (await listSkillRecords(candidate.scope)).find((item) =>
      item.revisions.some((revision) => revision.origin_candidate_id === candidate.id)) ?? null;
  return skill ? { candidate, skill, idempotent: true } : null;
}

export async function replaySkillCandidateMutation(
  mutationId: string,
): Promise<{ candidate: SkillPromotionCandidate; skill: SkillRecord; idempotent: boolean } | null> {
  const claim = await claimSkillCandidateMutation(mutationId);
  if (!claim) return appliedReplayResult(mutationId);
  try {
    const result = await completeSkillCandidateMutation(mutationId, claim.claimToken);
    if (result) return { ...result, idempotent: false };
    await releasePendingMutation(mutationId, claim.claimToken);
    return null;
  } catch (error) {
    await releasePendingMutation(mutationId, claim.claimToken);
    throw error;
  }
}

export function rejectSkillCandidate(mutationId: string): Promise<SkillPromotionCandidate | null> {
  return rejectSkillCandidateMutation(mutationId);
}

export function rollbackSkillCandidate(
  mutationId: string,
): Promise<{ candidate: SkillPromotionCandidate; skill: SkillRecord; idempotent: boolean } | null> {
  return rollbackAppliedSkillCandidate(mutationId);
}
