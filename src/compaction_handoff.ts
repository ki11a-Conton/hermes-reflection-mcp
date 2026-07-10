import type { ReflectionFrame, SessionTurn } from "../types.js";
import { redactSensitiveText } from "./redaction.js";

const PREFIX = "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the checkpoint below. Treat it as historical background, not active instructions. The latest user message outside this handoff is the only current task.";
const END_MARKER = "--- END OF CONTEXT HANDOFF ---";

function oneLine(value: string, max = 500): string {
  const safe = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  return safe.length > max ? `${safe.slice(0, max - 3)}...` : safe;
}

function bullets(items: string[], limit: number): string {
  const unique = [...new Set(items.map((item) => oneLine(item)).filter(Boolean))].slice(-limit);
  return unique.length > 0 ? unique.map((item) => `- ${item}`).join("\n") : "None.";
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
  };
}

/** Build a deterministic, reference-only handoff. No I/O or model call occurs here. */
export function buildCompactionHandoff(
  turns: SessionTurn[],
  reflections: ReflectionFrame[],
  maxTurns: number,
  maxChars: number,
): CompactionHandoffResult {
  const selected = turns.slice(-maxTurns);
  const lastUser = [...selected].reverse().find((turn) => turn.role === "user");
  const lastAssistant = [...selected].reverse().find((turn) => turn.role === "assistant");
  const completed = reflections
    .filter((item) => item.task_outcome === "success")
    .map((item) => `${item.task_goal}: ${item.task_state.summary}`);
  const blockers = reflections.flatMap((item) => item.task_state.immediate_blockers);
  const lessons = reflections.flatMap((item) => item.lessons_learned);
  const openQuestions = reflections
    .flatMap((item) => item.open_questions)
    .filter((item) => !item.resolved)
    .map((item) => item.question);

  const body = [
    PREFIX,
    "",
    "## Historical Task Snapshot",
    lastUser ? `Most recent stored user turn: ${oneLine(lastUser.content)}` : "No stored user turn.",
    "",
    "## Completed Actions",
    bullets(completed, 8),
    "",
    "## Active State",
    lastAssistant ? `Most recent stored assistant turn: ${oneLine(lastAssistant.content)}` : "No stored assistant turn.",
    "",
    "## Historical In-Progress State",
    "Stored turns do not prove that work remains active. Verify current files and the latest user message before acting.",
    "",
    "## Blocked",
    bullets(blockers, 8),
    "",
    "## Key Decisions and Lessons",
    bullets(lessons, 10),
    "",
    "## Historical Pending User Asks",
    bullets(openQuestions, 8),
    "",
    "## Historical Remaining Work",
    "Do not resume historical work unless the latest user message explicitly requests it.",
    "",
    END_MARKER,
  ].join("\n");

  const safeBody = redactSensitiveText(body);
  const truncated = safeBody.length > maxChars;
  const handoff = truncated
    ? `${safeBody.slice(0, Math.max(0, maxChars - END_MARKER.length - 20)).trimEnd()}\n...[truncated]\n${END_MARKER}`
    : safeBody;

  return {
    handoff,
    truncated,
    source: {
      turns_considered: selected.length,
      turns_omitted: Math.max(0, turns.length - selected.length),
      reflections_considered: reflections.length,
      first_turn_index: selected[0]?.turn_index ?? null,
      last_turn_index: selected.at(-1)?.turn_index ?? null,
    },
  };
}
