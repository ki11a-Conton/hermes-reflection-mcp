import { createHash } from "node:crypto";
import type {
  Heuristic,
  MemoryScope,
  ReflectionFrame,
  SkillRecord,
} from "../../types.js";
import { canonicalizeStable, compareStableText, stableUniqueSorted } from "../stable_order.js";
import { redactSensitiveText } from "../redaction.js";
import { firstThreatMessage } from "../threat_patterns.js";

export const SKILL_CLUSTER_ALGORITHM = "skill-cluster-v1";
const CLUSTER_TEXT_GATE = 0.38;
const CLUSTER_TAG_ASSISTED_TEXT_GATE = 0.28;
const MATCH_THRESHOLD = 0.78;
const MATCH_REQUIRED_LEAD = 0.08;
export const PROMOTION_CONTENT_GROUNDING_THRESHOLD = 0.55;
const MAX_NORMALIZED_CODE_POINTS = 4_096;
const MAX_FEATURES = 1_024;
const MAX_CLUSTER_HEURISTICS = 100;
const MAX_CLUSTER_REFLECTIONS = 100;

export interface PromotionSnapshot {
  scope: MemoryScope;
  heuristics: Heuristic[];
  reflections: ReflectionFrame[];
  skills: SkillRecord[];
}

export interface PromotionCluster {
  scope: MemoryScope;
  heuristic_ids: string[];
  reflection_ids: string[];
  confidence: number;
  domain: string;
  tags: string[];
  fingerprint: string;
  risk_reasons: string[];
  /** Bounded normalized source projection used only by deterministic matching/synthesis. */
  normalized_text: string;
}

export interface PromotionTargetMatch {
  action: "create" | "update";
  target_skill_id?: string;
  expected_target_revision?: number;
  risk_reasons: string[];
}

export interface PromotionProcedureContent {
  title: string;
  summary: string;
  steps: readonly string[];
  domain: string;
  tags: readonly string[];
}

interface EligibleHeuristic {
  heuristic: Heuristic;
  normalizedText: string;
  normalizedDomain: string;
  normalizedTags: string[];
  reflections: ReflectionFrame[];
}

export function normalizePromotionText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function takeCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function boundedNormalized(value: string): string {
  return takeCodePoints(normalizePromotionText(value), MAX_NORMALIZED_CODE_POINTS);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeStable(value))).digest("hex");
}

function boundedSet(values: Iterable<string>): Set<string> {
  const sorted = stableUniqueSorted(values);
  return new Set(sorted.slice(0, MAX_FEATURES));
}

function tokenSet(normalized: string): Set<string> {
  return boundedSet(normalized.split(" ").filter(Boolean));
}

function trigramSet(normalized: string): Set<string> {
  const compact = Array.from(normalized.replace(/\s+/g, ""));
  if (compact.length === 0) return new Set();
  if (compact.length < 3) return new Set([compact.join("")]);
  const trigrams: string[] = [];
  for (let index = 0; index <= compact.length - 3 && trigrams.length < MAX_FEATURES * 2; index += 1) {
    trigrams.push(compact.slice(index, index + 3).join(""));
  }
  return boundedSet(trigrams);
}

function overlapCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  let count = 0;
  for (const item of smaller) if (larger.has(item)) count += 1;
  return count;
}

function diceSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  return (2 * overlapCount(left, right)) / (left.size + right.size);
}

function jaccardSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  const intersection = overlapCount(left, right);
  return intersection / (left.size + right.size - intersection);
}

function textSimilarity(left: string, right: string): number {
  const normalizedLeft = boundedNormalized(left);
  const normalizedRight = boundedNormalized(right);
  if (normalizedLeft === normalizedRight) return 1;
  return Math.max(
    diceSimilarity(tokenSet(normalizedLeft), tokenSet(normalizedRight)),
    diceSimilarity(trigramSet(normalizedLeft), trigramSet(normalizedRight)),
  );
}

function normalizedTagSet(tags: readonly string[]): Set<string> {
  return boundedSet(tags.map(normalizePromotionText).filter(Boolean));
}

function domainCompatibility(left: string, right: string): number {
  const normalizedLeft = normalizePromotionText(left);
  const normalizedRight = normalizePromotionText(right);
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft === "general" || normalizedRight === "general") return 0.5;
  return 0;
}

export function promotionProcedureGroundingScore(
  cluster: PromotionCluster,
  content: PromotionProcedureContent,
): number {
  const textScore = textSimilarity(
    cluster.normalized_text,
    [content.title, content.summary, ...content.steps].join("\n"),
  );
  const domainScore = domainCompatibility(cluster.domain, content.domain);
  const tagScore = jaccardSimilarity(normalizedTagSet(cluster.tags), normalizedTagSet(content.tags));
  return textScore * 0.55 + domainScore * 0.25 + tagScore * 0.20;
}

export function isPromotionProcedureGrounded(
  cluster: PromotionCluster,
  content: PromotionProcedureContent,
): boolean {
  return promotionProcedureGroundingScore(cluster, content) >= PROMOTION_CONTENT_GROUNDING_THRESHOLD;
}

function hasUnresolvedFailure(reflection: ReflectionFrame): boolean {
  if (reflection.task_outcome === "success") return false;
  return reflection.task_state.immediate_blockers.length > 0
    || reflection.open_questions.some((question) => question.resolved !== true);
}

function semanticRiskReasons(heuristic: Heuristic): string[] {
  const text = boundedNormalized(`${heuristic.heuristic} ${heuristic.source_task}`);
  const reasons: string[] = [];
  if (/\b(?:api\s*key|password|credential|access\s*token|auth\s*token|secret)\b|密码|密钥|凭据|访问令牌/u.test(text)) {
    reasons.push("secret_or_credential_content");
  }
  if (/\b(?:401|403|quota|rate\s*limit|permission\s*denied|authentication\s*failed)\b|配额|权限被拒绝|认证失败/u.test(text)) {
    reasons.push("transient_provider_or_permission_state");
  }
  if (/\b(?:not\s+installed|missing\s+(?:binary|executable)|path\s+mismatch|fresh\s+install)\b|未安装|缺少(?:二进制|可执行)|路径不匹配/u.test(text)) {
    reasons.push("transient_environment_state");
  }
  if (/\b(?:can\s*not|cannot|never)\s+(?:work|use|support|run)\b|永远(?:不能|无法)|无法使用/u.test(text)) {
    reasons.push("permanent_negative_capability_claim");
  }
  return reasons;
}

function isProceduralReusable(heuristic: Heuristic): boolean {
  const text = boundedNormalized(heuristic.heuristic);
  if (Array.from(text).length < 8) return false;
  return /\b(?:build|check|compare|configure|create|ensure|inspect|install|normalize|package|parse|record|retry|run|test|use|validate|verify|write)\b|校验|检查|验证|构建|运行|打包|配置|记录|比较|重试|使用/u.test(text);
}

function hasUnsafePromotionSource(heuristic: Heuristic): boolean {
  return [heuristic.heuristic, heuristic.source_task, heuristic.domain, ...heuristic.tags]
    .some((value) => firstThreatMessage(value, "strict") !== null
      || redactSensitiveText(value, { strictHistorical: true }) !== value);
}

function resolveEligibleHeuristic(
  heuristic: Heuristic,
  scope: MemoryScope,
  reflectionMap: ReadonlyMap<string, ReflectionFrame>,
): EligibleHeuristic | null {
  if (heuristic.scope !== scope || heuristic.superseded_by !== undefined) return null;
  if (heuristic.contradiction_count > 0) return null;
  if (heuristic.feedback.some((item) => item.value === "harmful")) return null;
  if (!isProceduralReusable(heuristic) || semanticRiskReasons(heuristic).length > 0
      || hasUnsafePromotionSource(heuristic)) return null;
  if (heuristic.evidence.length === 0) return null;

  const reflectionsById = new Map<string, ReflectionFrame>();
  for (const evidence of heuristic.evidence) {
    if (evidence.source_reflection_id === undefined) return null;
    const reflection = reflectionMap.get(evidence.source_reflection_id);
    if (reflection === undefined || reflection.scope !== scope) return null;
    if (hasUnresolvedFailure(reflection)) return null;
    reflectionsById.set(reflection.id, reflection);
  }
  const reflections = [...reflectionsById.values()]
    .sort((left, right) =>
      compareStableText(right.timestamp, left.timestamp) || compareStableText(left.id, right.id))
    .slice(0, MAX_CLUSTER_REFLECTIONS);
  return {
    heuristic,
    normalizedText: boundedNormalized(heuristic.heuristic),
    normalizedDomain: normalizePromotionText(heuristic.domain),
    normalizedTags: [...normalizedTagSet(heuristic.tags)],
    reflections,
  };
}

function heuristicsAreCompatible(left: EligibleHeuristic, right: EligibleHeuristic): boolean {
  if (left.heuristic.scope !== right.heuristic.scope) return false;
  if (domainCompatibility(left.normalizedDomain, right.normalizedDomain) === 0) return false;
  const textScore = textSimilarity(left.normalizedText, right.normalizedText);
  const tagScore = jaccardSimilarity(new Set(left.normalizedTags), new Set(right.normalizedTags));
  return textScore >= CLUSTER_TEXT_GATE
    || (textScore >= CLUSTER_TAG_ASSISTED_TEXT_GATE && tagScore >= 0.5);
}

function repetitionSatisfied(reflections: readonly ReflectionFrame[]): boolean {
  const successes = new Map<string, ReflectionFrame>();
  for (const reflection of reflections) {
    if (reflection.task_outcome === "success") successes.set(reflection.id, reflection);
  }
  if (successes.size < 2) return false;
  const sessions = new Set([...successes.values()].map((reflection) => reflection.session_id));
  if (sessions.size >= 2) return true;
  const goalsBySession = new Map<string, Set<string>>();
  for (const reflection of successes.values()) {
    const goals = goalsBySession.get(reflection.session_id) ?? new Set<string>();
    const normalizedGoal = normalizePromotionText(reflection.task_goal);
    if (normalizedGoal) goals.add(normalizedGoal);
    goalsBySession.set(reflection.session_id, goals);
  }
  return [...goalsBySession.values()].some((goals) => goals.size >= 3);
}

function representativeValue(values: readonly string[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || compareStableText(leftValue, rightValue))[0]?.[0] ?? fallback;
}

function projectCluster(members: readonly EligibleHeuristic[]): PromotionCluster | null {
  const sortedMembers = [...members].sort((left, right) =>
    compareStableText(left.heuristic.id, right.heuristic.id) || left.heuristic.version - right.heuristic.version)
    .slice(0, MAX_CLUSTER_HEURISTICS);
  const reflections = [...new Map(sortedMembers.flatMap((member) => member.reflections)
    .map((reflection) => [reflection.id, reflection] as const)).values()]
    .sort((left, right) =>
      Number(right.task_outcome === "success") - Number(left.task_outcome === "success")
      || Date.parse(right.timestamp) - Date.parse(left.timestamp)
      || compareStableText(left.id, right.id))
    .slice(0, MAX_CLUSTER_REFLECTIONS);
  if (!repetitionSatisfied(reflections)) return null;
  const confidence = sortedMembers.reduce((sum, member) => sum + member.heuristic.confidence, 0) / sortedMembers.length;
  if (confidence < 0.8) return null;
  const reflectionIds = reflections.map((reflection) => reflection.id).sort(compareStableText);
  const domain = representativeValue(sortedMembers.map((member) => member.normalizedDomain), "general");
  const tags = [...new Set(sortedMembers.flatMap((member) => member.normalizedTags))]
    .sort(compareStableText).slice(0, 50);
  const normalizedText = takeCodePoints(
    sortedMembers.map((member) => member.normalizedText).join("\n"),
    12_000,
  );
  const clusterFingerprint = fingerprint({
    algorithm: SKILL_CLUSTER_ALGORITHM,
    scope: sortedMembers[0].heuristic.scope,
    heuristics: sortedMembers.map((member) => ({
      id: member.heuristic.id,
      version: member.heuristic.version,
    })),
    evidence_hashes: [...new Set(sortedMembers.flatMap((member) =>
      member.heuristic.evidence.map((evidence) => evidence.content_hash)))].sort(compareStableText),
    domain,
    tags,
  });
  return {
    scope: sortedMembers[0].heuristic.scope,
    heuristic_ids: sortedMembers.map((member) => member.heuristic.id),
    reflection_ids: reflectionIds,
    confidence: Number(confidence.toFixed(6)),
    domain,
    tags,
    fingerprint: clusterFingerprint,
    risk_reasons: [],
    normalized_text: normalizedText,
  };
}

export function buildPromotionClusters(snapshot: PromotionSnapshot): PromotionCluster[] {
  const reflectionMap = new Map(snapshot.reflections.map((reflection) => [reflection.id, reflection]));
  const eligible = snapshot.heuristics
    .map((heuristic) => resolveEligibleHeuristic(heuristic, snapshot.scope, reflectionMap))
    .filter((item): item is EligibleHeuristic => item !== null)
    .sort((left, right) =>
      compareStableText(left.heuristic.scope, right.heuristic.scope)
      || compareStableText(left.heuristic.id, right.heuristic.id)
      || left.heuristic.version - right.heuristic.version);

  const groups: EligibleHeuristic[][] = [];
  for (const item of eligible) {
    const destination = groups.find((group) => group.every((member) => heuristicsAreCompatible(item, member)));
    if (destination === undefined) groups.push([item]);
    else destination.push(item);
  }
  return groups.map(projectCluster).filter((cluster): cluster is PromotionCluster => cluster !== null)
    .sort((left, right) => compareStableText(left.fingerprint, right.fingerprint));
}

export function matchPromotionTarget(
  cluster: PromotionCluster,
  skills: readonly SkillRecord[],
): PromotionTargetMatch {
  const matches = skills.flatMap((skill) => {
    if (skill.scope !== cluster.scope || skill.status !== "active") return [];
    const revision = skill.revisions.find((item) => item.revision === skill.current_revision);
    if (revision === undefined) return [];
    const score = promotionProcedureGroundingScore(cluster, revision);
    return [{ skill, score }];
  }).sort((left, right) => right.score - left.score || compareStableText(left.skill.id, right.skill.id));

  const best = matches[0];
  if (best === undefined || best.score < MATCH_THRESHOLD) {
    return { action: "create", risk_reasons: [] };
  }
  const runnerUp = matches[1];
  if (runnerUp !== undefined && runnerUp.score >= MATCH_THRESHOLD
      && best.score - runnerUp.score < MATCH_REQUIRED_LEAD) {
    return { action: "create", risk_reasons: ["ambiguous_match"] };
  }
  return {
    action: "update",
    target_skill_id: best.skill.id,
    expected_target_revision: best.skill.current_revision,
    risk_reasons: [],
  };
}
