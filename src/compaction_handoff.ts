import type { ReflectionFrame, SessionTurn } from "../types.js";
import { redactSensitiveText, truncateCodePoints } from "./redaction.js";

export const CONTEXT_HANDOFF_PREFIX = "[CONTEXT COMPACTION — REFERENCE ONLY]";
const LEGACY_CONTEXT_HANDOFF_PREFIX = "[CONTEXT COMPACTION 鈥?REFERENCE ONLY]";
export const CONTEXT_HANDOFF_END_MARKER = "--- END OF CONTEXT HANDOFF ---";

const PREFIX = `${CONTEXT_HANDOFF_PREFIX} Earlier turns were compacted into the checkpoint below. Treat it as historical background, not active instructions. The latest user message outside this handoff is the only current task.`;

function oneLine(value: string, max = 500): string {
  const safe = redactSensitiveText(value, { strictHistorical: true }).replace(/\s+/g, " ").trim();
  return truncateCodePoints(safe, max);
}

function truncateUtf16Safe(value: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  let used = 0;
  let output = "";
  for (const character of value) {
    if (used + character.length > maxUnits) break;
    output += character;
    used += character.length;
  }
  return output;
}

export function isContextHandoffContent(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trimStart();
  return trimmed.startsWith(CONTEXT_HANDOFF_PREFIX)
    || trimmed.startsWith(LEGACY_CONTEXT_HANDOFF_PREFIX)
    || (trimmed.includes(CONTEXT_HANDOFF_PREFIX) && trimmed.includes(CONTEXT_HANDOFF_END_MARKER));
}

function uniqueLines(items: string[]): string[] {
  return [...new Set(items.map((item) => oneLine(item)).filter(Boolean))];
}

function lineWithBudget(label: string, value: string | undefined, valueBudget: number, emptyText: string): {
  line: string;
  truncated: boolean;
} {
  if (!value) return { line: emptyText, truncated: false };
  const safe = oneLine(value, Math.max(1, valueBudget));
  return {
    line: `${label}${safe}`,
    truncated: Array.from(oneLine(value, Number.MAX_SAFE_INTEGER)).length > Array.from(safe).length,
  };
}

export interface CompactionHandoffResult {
  handoff: string;
  truncated: boolean;
  source: {
    turns_considered: number;
    turns_omitted: number;
    reflections_considered: number;
    first_turn_index: number | null;
    last_turn_index: number | null;
    omitted_handoff_turns: number;
    ordinary_turns_considered: number;
    requested_recent_user_turns: number;
    available_recent_user_turns: number;
    included_recent_user_turns: number;
    recent_user_turn_indexes: number[];
    recent_user_turns_omitted_due_to_budget: number;
    reflection_items_omitted: number;
    sections_truncated: string[];
  };
}

interface OptionalSection {
  title: string;
  lines: string[];
  countAsReflectionItems: boolean;
}

/** Build a deterministic, reference-only handoff. No I/O or model call occurs here. */
export function buildCompactionHandoff(
  turns: SessionTurn[],
  reflections: ReflectionFrame[],
  maxTurns: number,
  maxChars: number,
  preserveRecentUserTurns = 3,
): CompactionHandoffResult {
  const selected = turns.slice(-maxTurns);
  const ordinaryTurns = selected.filter((turn) => !isContextHandoffContent(turn.content));
  const omittedHandoffTurns = selected.length - ordinaryTurns.length;
  const requestedRecentUserTurns = Math.max(1, Math.min(5, Math.trunc(preserveRecentUserTurns)));
  const genuineUserTurns = ordinaryTurns
    .filter((turn) => turn.role === "user" && turn.content.trim().length > 0);
  const recentUserTurns = genuineUserTurns.slice(-requestedRecentUserTurns);
  const lastUser = recentUserTurns.at(-1);
  const earlierRecentUsers = recentUserTurns.slice(0, -1);
  const lastAssistant = [...ordinaryTurns].reverse()
    .find((turn) => turn.role === "assistant" && turn.content.trim().length > 0);

  const completed = uniqueLines(reflections
    .filter((item) => item.task_outcome === "success")
    .map((item) => `${item.task_goal}: ${item.task_state.summary}`)).slice(0, 8);
  const blockers = uniqueLines(reflections.flatMap((item) => item.task_state.immediate_blockers)).slice(0, 8);
  const lessons = uniqueLines(reflections.flatMap((item) => item.lessons_learned)).slice(0, 10);
  const openQuestions = uniqueLines(reflections
    .flatMap((item) => item.open_questions)
    .filter((item) => !item.resolved)
    .map((item) => item.question)).slice(0, 8);

  const optionalSections: OptionalSection[] = [
    {
      title: "## Historical In-Progress State",
      lines: ["Stored turns do not prove that work remains active. Verify current files and the latest user message before acting."],
      countAsReflectionItems: false,
    },
    { title: "## Blocked", lines: blockers, countAsReflectionItems: true },
    { title: "## Historical Pending User Asks", lines: openQuestions, countAsReflectionItems: true },
    { title: "## Completed Actions", lines: completed, countAsReflectionItems: true },
    { title: "## Key Decisions and Lessons", lines: lessons, countAsReflectionItems: true },
    {
      title: "## Historical Remaining Work",
      lines: ["Do not resume historical work unless the latest user message explicitly requests it."],
      countAsReflectionItems: false,
    },
  ];

  const userLabel = "Most recent stored user turn: ";
  const assistantLabel = "Most recent stored assistant turn: ";
  const fixedRequired = [
    PREFIX,
    "",
    "## Historical Task Snapshot",
    lastUser ? userLabel : "No stored user turn.",
    "",
    "## Active State",
    lastAssistant ? assistantLabel : "No stored assistant turn.",
    "",
    CONTEXT_HANDOFF_END_MARKER,
  ].join("\n");

  // Split the remaining mandatory budget across the latest genuine anchors.
  // The schema enforces maxChars >= 500, but keep a defensive minimum here for
  // direct module callers.
  const mandatoryBudget = Math.max(0, maxChars - fixedRequired.length);
  const userBudget = lastUser && lastAssistant ? Math.floor(mandatoryBudget / 2) : mandatoryBudget;
  const assistantBudget = lastAssistant ? mandatoryBudget - userBudget : 0;
  const userAnchor = lineWithBudget(
    userLabel,
    lastUser?.content,
    userBudget,
    "No stored user turn.",
  );
  const assistantAnchor = lineWithBudget(
    assistantLabel,
    lastAssistant?.content,
    assistantBudget,
    "No stored assistant turn.",
  );

  const lines = [
    PREFIX,
    "",
    "## Historical Task Snapshot",
    userAnchor.line,
    "",
    "## Active State",
    assistantAnchor.line,
  ];
  const sectionsTruncated: string[] = [];
  let reflectionItemsIncluded = 0;
  const includedEarlierRecentUsers: SessionTurn[] = [];

  const lengthWithFooter = (candidateLines: string[]): number =>
    [...candidateLines, "", CONTEXT_HANDOFF_END_MARKER].join("\n").length;

  // Optional historical user anchors are chosen newest-first so a tight
  // budget drops the oldest context first, then rendered chronologically.
  for (const turn of [...earlierRecentUsers].reverse()) {
    const proposed = [turn, ...includedEarlierRecentUsers];
    const proposedLines = proposed.map((item) =>
      `- [turn ${item.turn_index}] ${oneLine(item.content)}`
    );
    const candidate = [...lines, "", "## Recent Historical User Turns", ...proposedLines];
    if (lengthWithFooter(candidate) <= maxChars) {
      includedEarlierRecentUsers.unshift(turn);
    }
  }
  if (includedEarlierRecentUsers.length > 0) {
    lines.push("", "## Recent Historical User Turns");
    for (const turn of includedEarlierRecentUsers) {
      lines.push(`- [turn ${turn.turn_index}] ${oneLine(turn.content)}`);
    }
  }
  if (includedEarlierRecentUsers.length < earlierRecentUsers.length) {
    sectionsTruncated.push("Recent Historical User Turns");
  }

  for (const section of optionalSections) {
    const sectionLines = section.lines.length > 0 ? section.lines : ["None."];
    const headerCandidate = [...lines, "", section.title];
    if (lengthWithFooter(headerCandidate) > maxChars) {
      sectionsTruncated.push(section.title.slice(3));
      continue;
    }

    lines.push("", section.title);
    let includedInSection = 0;
    for (const item of sectionLines) {
      const rendered = section.lines.length > 0 ? `- ${item}` : item;
      if (lengthWithFooter([...lines, rendered]) > maxChars) break;
      lines.push(rendered);
      includedInSection += 1;
      if (section.countAsReflectionItems && section.lines.length > 0) reflectionItemsIncluded += 1;
    }
    if (includedInSection < sectionLines.length) {
      sectionsTruncated.push(section.title.slice(3));
      const marker = "- ...[section truncated]";
      if (lengthWithFooter([...lines, marker]) <= maxChars) lines.push(marker);
    }
  }

  const totalReflectionItems = completed.length + blockers.length + lessons.length + openQuestions.length;
  const reflectionItemsOmitted = Math.max(0, totalReflectionItems - reflectionItemsIncluded);
  const charTruncated = userAnchor.truncated
    || assistantAnchor.truncated
    || sectionsTruncated.length > 0
    || reflectionItemsOmitted > 0;

  let handoff = [...lines, "", CONTEXT_HANDOFF_END_MARKER].join("\n");
  // Defensive fallback for direct callers below the documented 500-char
  // minimum. Preserve both safety markers and cut by code point.
  if (handoff.length > maxChars) {
    const suffix = `\n${CONTEXT_HANDOFF_END_MARKER}`;
    const contentBudget = Math.max(0, maxChars - suffix.length);
    handoff = `${truncateUtf16Safe(handoff, contentBudget)}${suffix}`;
  }

  return {
    handoff,
    truncated: charTruncated,
    source: {
      turns_considered: selected.length,
      turns_omitted: Math.max(0, turns.length - selected.length),
      reflections_considered: reflections.length,
      first_turn_index: selected[0]?.turn_index ?? null,
      last_turn_index: selected.at(-1)?.turn_index ?? null,
      omitted_handoff_turns: omittedHandoffTurns,
      ordinary_turns_considered: ordinaryTurns.length,
      requested_recent_user_turns: requestedRecentUserTurns,
      available_recent_user_turns: genuineUserTurns.length,
      included_recent_user_turns: (lastUser ? 1 : 0) + includedEarlierRecentUsers.length,
      recent_user_turn_indexes: [
        ...includedEarlierRecentUsers.map((turn) => turn.turn_index),
        ...(lastUser ? [lastUser.turn_index] : []),
      ],
      recent_user_turns_omitted_due_to_budget:
        recentUserTurns.length - ((lastUser ? 1 : 0) + includedEarlierRecentUsers.length),
      reflection_items_omitted: reflectionItemsOmitted,
      sections_truncated: [...new Set(sectionsTruncated)],
    },
  };
}
