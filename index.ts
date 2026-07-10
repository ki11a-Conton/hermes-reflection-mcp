#!/usr/bin/env node
// ============================================================
// Hermes Reflection MCP Server
// Compatible with: Claude Desktop, Codex Desktop, Claude Code
//
// Tools (28):
//   reflect_on_task
//   search_reflections
//   list_reflections
//   retrieve_heuristics
//   list_heuristics
//   search_heuristics
//   add_heuristic
//   delete_heuristic
//   memory_board_write
//   memory_board_read
//   user_profile_write
//   user_profile_read
//   get_open_questions
//   resolve_open_question
//   search_sessions
//   append_session_turn
//   get_recent_reflections
//   export_data
//   import_data
//   clear_data
//   capture_memory_snapshot         (v19)
//   session_lifecycle_hook          (v19)
//   scan_memory_threats             (v19)
//   scroll_session_context          (v19)
//   trigger_background_review       (v19)
//   list_pending_mutations          (v19.2)
//   approve_pending_mutation        (v19.2)
//   compact_session_context         (v19.2)
// ============================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, isAbsolute as pathIsAbsolute, join, relative, resolve } from "path";
import { z } from "zod";
import {
  saveReflectionAndHeuristics,
  type BatchReflectionSaveInput,
  upsertHeuristic,
  deleteHeuristic,
  listHeuristics,
  searchHeuristics,
  retrieveRelevantHeuristics,
  type HeuristicWithScore,
  searchReflections,
  listReflections,
  getRecentReflections,
  getOpenQuestions,
  resolveOpenQuestion,
  generateId,
  firstHeuristicThreatMessage,
  safeHeuristicText,
  STORE_DIR,
  HEURISTIC_MAX_COUNT,
  REFLECTION_SOFT_LIMIT,
  exportData,
  importData,
  clearData,
  type ClearCollection,
  type ImportMode,
  memoryBoardWrite,
  memoryBoardBatchWrite,
  memoryBoardRead,
  userProfileWrite,
  userProfileBatchWrite,
  userProfileRead,
  listPendingMutations,
  rejectPendingMutation,
} from "./storage.js";
import { appendSessionTurn, searchSessions, listRecentSessions, clearSessionStorage, SESSION_STORAGE_UNAVAILABLE } from "./session_storage.js";
import type { ReflectionFrame, AffordanceGap, ReflectionStore, PendingMutation, MemoryBoard, SessionTurn } from "./types.js";
// v19 integration imports
import {
  handleCaptureMemorySnapshot,
  handleSessionLifecycleHook,
  handleScanMemoryThreats,
  handleScrollSessionContext,
  handleTriggerBackgroundReview,
  handleCompactSessionContext,
  NEW_TOOL_DEFINITIONS,
} from "./src/v19_tools.js";
import {
  memoryBoardBatchWriteEnhanced,
  memoryBoardReadEnhanced,
  memoryBoardWriteEnhanced,
  userProfileBatchWriteEnhanced,
  userProfileReadEnhanced,
  userProfileWriteEnhanced,
} from "./src/storage_enhanced.js";
import { safeJsonPreview } from "./src/redaction.js";

const SERVER_VERSION = "19.2.0";
const EXPORT_INLINE_LIMIT_BYTES = 500 * 1024;

const SERVER_INSTRUCTIONS = `Hermes Reflection MCP provides persistent reflection memory with Codex Desktop integration.

Core Workflow:
1. Before significant work, call retrieve_heuristics with the current task description, optional domain, and optional tags.
2. After significant work, call reflect_on_task with an honest task_outcome, failure_mode, summary, and lessons learned. Submit at most 50 lessons in one call.
3. Use get_recent_reflections or search_reflections before repeating a similar investigation.
4. Before starting a repeated or similar task, call get_open_questions to surface unresolved follow-ups from past work. Use resolve_open_question when a question has been answered.
5. Use list_reflections to browse reflections with filters and pagination.
6. Use search_sessions to search stored conversation turns via FTS; use append_session_turn to store a turn.
7. Use memory_board_write / memory_board_read for lightweight bounded context and user_profile_write / user_profile_read for stable user preferences.
8. Use export_data / import_data to backup or transfer data. Use clear_data (requires confirm:true) to reset collections.
9. Node.js 20 or newer is required for the supported better-sqlite3 session tools.

v19.2.0 Client Integration Features:
- capture_memory_snapshot and session_lifecycle_hook require explicit client calls. Installing this MCP does not make Codex Desktop invoke them automatically.
- append_session_turn is also an explicit client call; only turns submitted to it are indexed.
- Snapshot reads require mode:"snapshot" together with the matching session_id. Missing snapshots return an error instead of falling back to live memory.
- compact_session_context creates a deterministic reference-only historical handoff. It does not control Codex's actual context window or compaction.
- trigger_background_review deterministically derives heuristic candidates from stored reflections. It calls no LLM, writes no skills, and generates no Memory Board or User Profile candidates.
- When write approval is enabled, use list_pending_mutations and approve_pending_mutation to inspect, approve/replay, or reject queued writes.
- scan_memory_threats: Audit memory board or user profile for injection/exfiltration patterns. Use scope='strict' for comprehensive security audit.
- scroll_session_context: Navigate session history around anchor points with pagination.
- trigger_background_review: Analyze recent reflections and preview or apply safe heuristic candidates.

Memory Snapshot Pattern:
- An explicit start lifecycle call freezes Memory Board and User Profile for that session id.
- Mid-session writes persist to disk immediately while the captured snapshot remains stable.
- Live reads remain the default; clients must request snapshot mode explicitly.
- An explicit end lifecycle call releases the snapshot.

Batch Operations:
- Use operations[] array in memory_board_write / user_profile_write
- Final-state budget checking: remove old entries + add new ones in ONE call
- Atomic execution: all operations succeed or all fail together

Quality:
- Lessons should be concrete, transferable, and tied to a source task.
- Use task_outcome honestly: success, partial, or failure.
- reflect_on_task.summary_sections can store structured long summaries.
- reflect_on_task.tags labels reflections and extracted heuristics for later filtering.
- retrieve_heuristics defaults to min_confidence=0.3; pass a lower value to include tentative lessons.

Search and Retrieval:
- retrieve_heuristics.tags filters heuristics by tag; tag_mode:"and" requires all tags, tag_mode:"or" accepts any tag.
- list_heuristics inspects stored heuristics directly with domain, tag, confidence, limit, and sort filters.
- search_heuristics searches stored heuristics by query relevance with optional domain, tag, and confidence filters.
- search_reflections.since_days restricts results to recent reflections.
- search_reflections.tags and list_reflections.tags support tag_mode:"and" (all tags) or tag_mode:"or" (any tag).
- get_open_questions lists unresolved questions from past reflections, sorted by priority.
- add_heuristic manually adds a lesson to the knowledge base.
- delete_heuristic permanently removes a heuristic by id.
- Tool metadata includes read-only, mutating, and destructive annotations for safer clients.

How the system gets smarter over time:
- New lessons start with a confidence score and are reinforced when similar lessons are added again.
- Retrieval increments usage counters and records last_retrieved_at, so frequently useful lessons become easier to surface.
- Ebbinghaus-style decay slightly lowers stale lessons unless reinforcement keeps them stable.
- Open questions keep unresolved follow-ups visible until an agent answers or closes the underlying investigation.

Data Management:
- export_data can return JSON inline or write it to output_path.
- import_data can merge or replace from a JSON snapshot.
- clear_data is destructive and requires confirm:true.
- Keep secrets, credentials, tokens, and private config out of reflections and heuristics.`;

function outcomeBadge(outcome: ReflectionFrame["task_outcome"]): string {
  switch (outcome) {
    case "success":
      return "+";
    case "partial":
      return "~";
    case "failure":
      return "!";
    default:
      return "?";  // D3: defensive default for corrupted data
  }
}

function nullableArray<T extends z.ZodTypeAny>(schema: T) {
  return z.array(schema).nullable().default([]).transform((value) => value ?? []);
}

const WorldModelUpdateSchema = z.object({
  fact: z.string().max(1000),
  polarity: z.enum(["affirm", "negate"]),
  source: z.string().max(500),
  evidence: z.string().max(1000),
});

const ToolInsightSchema = z.object({
  tool: z.string().max(200),
  insight: z.string().max(1000),
  status: z.enum(["confirmed", "needs_verification"]),
  evidence: z.string().max(1000),
});

const OpenQuestionSchema = z.object({
  question: z.string().max(1000),
  priority: z.enum(["high", "medium", "low"]),
  requires_environment_interaction: z.boolean(),
  resolved: z.boolean().optional(),
  resolved_at: z.string().max(100).optional(),
  resolved_by: z.string().max(100).optional(),
});

const ContextForgetSchema = z.object({
  item: z.string().max(1000),
  reason: z.string().max(1000),
});

const domainSchema = z.string()
  .max(100)
  .default("general")
  .transform((value) => value.toLowerCase().trim() || "general");

const optionalDomainSchema = z.string()
  .max(100)
  .optional()
  .transform((value) => value?.toLowerCase().trim());

const ReflectOnTaskSchema = z.object({
  session_id: z.string().min(1).max(200),  // E10-fix: was max(200) without min(1)
  task_goal: z.string().min(1).max(1000),  // E10-fix: was max(1000) without min(1)
  task_outcome: z.enum(["success", "partial", "failure"]),
  failure_mode: z.enum([
    "incorrect_task_interpretation",
    "incorrect_world_assumption",
    "missing_affordance",
    "tool_limitation_or_misbehavior",
    "exhausted_or_misdirected_search",
    "success",
  ]),
  summary: z.string().max(8000),
  summary_sections: nullableArray(z.object({ title: z.string().max(200), content: z.string().max(8000) })),
  immediate_blockers: nullableArray(z.string().max(500)),
  active_hypotheses: nullableArray(z.string().max(500)),
  proven_safe_paths: nullableArray(z.string().max(500)),
  exhausted_search: nullableArray(z.string().max(500)),
  world_model_updates: nullableArray(WorldModelUpdateSchema),
  tool_insights: nullableArray(ToolInsightSchema),
  context_forget: nullableArray(ContextForgetSchema),
  open_questions: nullableArray(OpenQuestionSchema),
  lessons_learned: nullableArray(z.string().max(1000)).refine((value) => value.length <= 50, "lessons_learned accepts at most 50 items."),
  context_notes: z.string().max(2000).optional(),
  missing_capability: z.string().max(500).optional(),
  available_tools: nullableArray(z.string().max(200)),
  auto_extract_heuristics: z.boolean().default(true),
  domain: domainSchema,
  tags: nullableArray(z.string().max(100)),
  dry_run: z.boolean().default(false),
});

const RetrieveHeuristicsSchema = z.object({
  task_description: z.string().max(1000),
  domain: optionalDomainSchema,
  limit: z.number().int().min(1).max(50).default(10),
  tags: nullableArray(z.string().max(100)),
  tag_mode: z.enum(["and", "or"]).default("and"),
  show_scores: z.boolean().default(false),
  min_confidence: z.number().min(0).max(1).default(0.3),
});

const ListHeuristicsSchema = z.object({
  domain: optionalDomainSchema,
  tags: nullableArray(z.string().max(100)),
  tag_mode: z.enum(["and", "or"]).default("and"),
  min_confidence: z.number().min(0).max(1).default(0),
  limit: z.number().int().min(1).max(100).default(20),
  sort: z.enum(["confidence", "updated_at", "created_at", "reinforcement"]).default("confidence"),
});

const SearchHeuristicsSchema = z.object({
  query: z.string().max(1000),
  domain: optionalDomainSchema,
  tags: nullableArray(z.string().max(100)),
  tag_mode: z.enum(["and", "or"]).default("and"),
  min_confidence: z.number().min(0).max(1).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

const AddHeuristicSchema = z.object({
  domain: domainSchema,
  heuristic: z.string().max(1000),
  source_task: z.string().max(500),
  tags: nullableArray(z.string().max(100)),
  confidence: z.number().min(0).max(1).default(0.7),
});

const ContradictHeuristicSchema = z.object({
  id: z.string().max(100),
  reason: z.string().max(1000).optional(),
});

const DeleteHeuristicSchema = z.object({
  id: z.string().max(100),
});

const SearchReflectionsSchema = z.object({
  query: z.string().max(1000),
  domain: optionalDomainSchema,
  outcome: z.enum(["success", "partial", "failure"]).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  since_days: z.number().int().min(1).max(3650).optional(),
  tags: nullableArray(z.string().max(100)),
  tag_mode: z.enum(["and", "or"]).default("and"),
  failure_mode: z.enum([
    "incorrect_task_interpretation",
    "incorrect_world_assumption",
    "missing_affordance",
    "tool_limitation_or_misbehavior",
    "exhausted_or_misdirected_search",
    "success",
  ]).optional(),
});

const ListReflectionsSchema = z.object({
  domain: optionalDomainSchema,
  outcome: z.enum(["success", "partial", "failure"]).optional(),
  failure_mode: z.enum([
    "incorrect_task_interpretation",
    "incorrect_world_assumption",
    "missing_affordance",
    "tool_limitation_or_misbehavior",
    "exhausted_or_misdirected_search",
    "success",
  ]).optional(),
  tags: nullableArray(z.string().max(100)),
  tag_mode: z.enum(["and", "or"]).default("and"),
  session_id: z.string().max(200).optional(),
  since_days: z.number().int().min(1).max(3650).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

const GetRecentReflectionsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
});

const GetOpenQuestionsSchema = z.object({
  domain: optionalDomainSchema,
  priority: z.enum(["high", "medium", "low"]).optional(),
  limit: z.number().int().min(1).max(100).default(30),
  since_days: z.number().int().min(1).max(3650).optional(),
  include_resolved: z.boolean().default(false),
});

const ResolveOpenQuestionSchema = z.object({
  reflection_id: z.string().max(100),
  question_index: z.number().int().min(0).max(1000),
  resolved_by_reflection_id: z.string().max(100).optional(),
});

const ExportDataSchema = z.object({
  collection: z.enum(["reflections", "heuristics", "affordance_gaps", "sessions", "all"]).default("all"),
  format: z.enum(["json"]).default("json"),
  output_path: z.string().min(1).max(500).optional(),  // H3-fix: was max(500) without min(1)
});

const ClearDataSchema = z.object({
  collection: z.enum(["reflections", "heuristics", "affordance_gaps", "sessions", "all"]),
  confirm: z.boolean().default(false),
});

const ImportDataSchema = z.object({
  input_path: z.string().min(1).max(500),  // H4-fix: was max(500) without min(1)
  mode: z.enum(["merge", "replace"]).default("merge"),
});

const MemoryBoardOperationSchema = z.object({
  action: z.enum(["add", "replace", "remove"]),
  content: z.string().min(1).max(2200).optional(),
  old_text: z.string().min(1).max(1000).optional(),
});

const MemoryBoardWriteSchema = MemoryBoardOperationSchema.extend({
  action: z.enum(["add", "replace", "remove"]).optional(),
  operations: z.array(MemoryBoardOperationSchema).min(1).max(20).optional(),
}).superRefine((value, ctx) => {
  if (!value.operations?.length && !value.action) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "memory_board_write requires either action or operations.",
      path: ["action"],
    });
  }
  // E6-fix: validate per-action required fields
  if (!value.operations?.length && value.action) {
    if ((value.action === "add" || value.action === "replace") && !value.content?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `content is required for action '${value.action}'`, path: ["content"] });
    }
    if ((value.action === "replace" || value.action === "remove") && !value.old_text?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `old_text is required for action '${value.action}'`, path: ["old_text"] });
    }
  }
});

// A8-fix: UserProfileWriteSchema has its own content limit (1800, not 2200)
const UserProfileOperationSchema = z.object({
  action: z.enum(["add", "replace", "remove"]),
  content: z.string().min(1).max(1800).optional(),
  old_text: z.string().min(1).max(1000).optional(),
});

const UserProfileWriteSchema = UserProfileOperationSchema.extend({
  action: z.enum(["add", "replace", "remove"]).optional(),
  operations: z.array(UserProfileOperationSchema).min(1).max(20).optional(),
}).superRefine((value, ctx) => {
  if (!value.operations?.length && !value.action) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "user_profile_write requires either action or operations.",
      path: ["action"],
    });
  }
  // E6-fix: validate per-action required fields
  if (!value.operations?.length && value.action) {
    if ((value.action === "add" || value.action === "replace") && !value.content?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `content is required for action '${value.action}'`, path: ["content"] });
    }
    if ((value.action === "replace" || value.action === "remove") && !value.old_text?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `old_text is required for action '${value.action}'`, path: ["old_text"] });
    }
  }
});

const MemoryReadSchema = z.object({
  mode: z.enum(["live", "snapshot"]).default("live"),
  session_id: z.string().min(1).max(200).optional(),
}).superRefine((value, ctx) => {
  if (value.mode === "snapshot" && !value.session_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["session_id"],
      message: "session_id is required for snapshot mode",
    });
  }
});

const AppendSessionTurnSchema = z.object({
  session_id: z.string().min(1).max(200),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(100000),
  timestamp: z.string().max(30).optional(),
});

const SearchSessionsSchema = z.object({
  query: z.string().max(1000).optional().default(""),
  limit: z.number().int().min(1).max(100).default(10),
  since_days: z.number().int().min(1).max(3650).optional(),  // E5-fix: was min(0) and non-integer
});

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * B3-fix / A1-fix: Validate that a file path is safe — must resolve within
 * STORE_DIR or its parent directory. Prevents path traversal attacks via
 * export_data(output_path) and import_data(input_path).
 */
function safePath(userPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = resolve(userPath);
  const storeDirResolved = resolve(STORE_DIR);
  const parentDirResolved = dirname(storeDirResolved);
  // Path must be within STORE_DIR or its parent directory.
  const rel = relative(parentDirResolved, resolved);
  if (rel.startsWith("..") || pathIsAbsolute(rel)) {
    return { ok: false, error: `Path must be within ${parentDirResolved}: ${userPath}` };
  }
  return { ok: true, path: resolved };
}

/**
 * B5-fix: Helper for v19 tools that return JSON with a `success` field.
 * If the result is JSON with success === false, convert to an MCP error response.
 */
function okOrErr(result: string) {
  try {
    const parsed = JSON.parse(result);
    if (parsed && parsed.success === false) {
      // A14-fix: support both 'error' and 'message' fields; handle non-string values
      const msg = parsed.error ?? parsed.message ?? "Operation failed (no error message provided).";
      return err(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
  } catch { /* not JSON, pass through as success */ }
  return ok(result);
}

// E8: removed dead code stripMarkdown (no live callers)

type ReflectInput = z.infer<typeof ReflectOnTaskSchema>;
type ReflectionSaveInput = Omit<ReflectInput, "dry_run"> & { dry_run?: boolean };

function prepareReflectionSave(input: ReflectionSaveInput): { save: BatchReflectionSaveInput; extractedCount: number; skippedUnsafeCount: number; gapLine: string; heuristicLine: string } {
  const gaps: AffordanceGap[] = [];
  if (input.failure_mode === "missing_affordance") {
    if (!input.missing_capability) {
      throw new Error("missing_capability is required when failure_mode is missing_affordance.");
    }
    gaps.push({
      id: generateId(),
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      goal_description: input.task_goal,
      failure_description: input.summary,
      missing_capability: input.missing_capability,
      available_tools: input.available_tools,
      occurrence_count: 1,
    });
  }

  const deduplicatedLessons = [...new Map(
    input.lessons_learned.map((lesson) => [lesson.toLowerCase().trim(), lesson])
  ).values()];
  const tags = [...new Set(input.tags.map((tag) => tag.toLowerCase().trim()).filter(Boolean))];

  const reflection: ReflectionFrame = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    task_goal: input.task_goal,
    task_outcome: input.task_outcome,
    failure_mode: input.failure_mode,
    domain: input.domain,
    tags,
    task_state: {
      summary: input.summary,
      summary_sections: input.summary_sections.length > 0 ? input.summary_sections : undefined,
      immediate_blockers: input.immediate_blockers,
      active_hypotheses: input.active_hypotheses,
      proven_safe_paths: input.proven_safe_paths,
      exhausted_search: input.exhausted_search,
    },
    world_model_updates: input.world_model_updates,
    tool_insights: input.tool_insights,
    context_forget: input.context_forget,
    open_questions: input.open_questions,
    lessons_learned: deduplicatedLessons,
    affordance_gaps: gaps,
    context_notes: input.context_notes || undefined,
  };

  const confidence =
    input.task_outcome === "success" ? 0.75 :
    input.task_outcome === "partial" ? 0.60 :
    0.50;
  const lessons = input.auto_extract_heuristics
    ? deduplicatedLessons.filter((lesson) => firstHeuristicThreatMessage(lesson, "strict") === null)
    : [];
  const skippedUnsafeCount = input.auto_extract_heuristics
    ? deduplicatedLessons.length - lessons.length
    : 0;
  const skippedLine = skippedUnsafeCount > 0
    ? `\n${skippedUnsafeCount} lesson(s) kept in the reflection audit log but skipped as heuristics because they matched context-injection/exfiltration safety patterns.`
    : "";

  return {
    save: {
      reflection,
      lessons,
      domain: input.domain,
      sourceTask: input.task_goal,
      confidence,
      tags,
    },
    extractedCount: lessons.length,
    skippedUnsafeCount,
    gapLine: gaps.length > 0 ? `\nAffordance gap logged: "${input.missing_capability}"` : "",
    heuristicLine: lessons.length > 0
      ? `\n${lessons.length} heuristic(s) saved to [${input.domain}]${skippedLine}`
      : skippedLine,
  };
}

const stringArraySchema = (maxLength = 500) => ({
  anyOf: [
    { type: "array" as const, items: { type: "string" as const, maxLength } },
    { type: "null" as const },
  ],
  default: [],
});

const objectArraySchema = (itemSchema: Record<string, unknown>) => ({
  anyOf: [
    { type: "array" as const, items: itemSchema },
    { type: "null" as const },
  ],
  default: [],
});

const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const MUTATING_TOOL = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const DESTRUCTIVE_TOOL = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const worldModelUpdateJsonSchema = {
  type: "object",
  required: ["fact", "polarity", "source", "evidence"],
  properties: {
    fact: { type: "string", maxLength: 1000 },
    polarity: { type: "string", enum: ["affirm", "negate"] },
    source: { type: "string", maxLength: 500 },
    evidence: { type: "string", maxLength: 1000 },
  },
};

const toolInsightJsonSchema = {
  type: "object",
  required: ["tool", "insight", "status", "evidence"],
  properties: {
    tool: { type: "string", maxLength: 200 },
    insight: { type: "string", maxLength: 1000 },
    status: { type: "string", enum: ["confirmed", "needs_verification"] },
    evidence: { type: "string", maxLength: 1000 },
  },
};

const contextForgetJsonSchema = {
  type: "object",
  required: ["item", "reason"],
  properties: {
    item: { type: "string", maxLength: 1000 },
    reason: { type: "string", maxLength: 1000 },
  },
};

const openQuestionJsonSchema = {
  type: "object",
  required: ["question", "priority", "requires_environment_interaction"],
  properties: {
    question: { type: "string", maxLength: 1000 },
    priority: { type: "string", enum: ["high", "medium", "low"] },
    requires_environment_interaction: { type: "boolean" },
  },
};

const TOOL_DEFS = [
  {
    name: "reflect_on_task",
    description: `Structured post-task reflection. Call after significant work.
Stores a ReflectionFrame, optionally extracts lessons as heuristics, and tracks affordance gaps.
Optional context_notes is stored but not used for heuristic extraction or search ranking.`,
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["session_id", "task_goal", "task_outcome", "failure_mode", "summary"],
      properties: {
        session_id: { type: "string", maxLength: 200 },
        task_goal: { type: "string", maxLength: 1000 },
        task_outcome: { type: "string", enum: ["success", "partial", "failure"] },
        failure_mode: {
          type: "string",
          enum: [
            "incorrect_task_interpretation",
            "incorrect_world_assumption",
            "missing_affordance",
            "tool_limitation_or_misbehavior",
            "exhausted_or_misdirected_search",
            "success",
          ],
        },
        summary: { type: "string", maxLength: 8000 },
        summary_sections: {
          ...objectArraySchema({
            type: "object",
            required: ["title", "content"],
            properties: {
              title: { type: "string", maxLength: 200 },
              content: { type: "string", maxLength: 8000 },
            },
          }),
          description: "Optional structured sections for long summaries. Each section has a title and content (max 8000 chars each).",
        },
        immediate_blockers: stringArraySchema(),
        active_hypotheses: stringArraySchema(),
        proven_safe_paths: stringArraySchema(),
        exhausted_search: stringArraySchema(),
        world_model_updates: objectArraySchema(worldModelUpdateJsonSchema),
        tool_insights: objectArraySchema(toolInsightJsonSchema),
        context_forget: objectArraySchema(contextForgetJsonSchema),
        open_questions: objectArraySchema(openQuestionJsonSchema),
        lessons_learned: { ...stringArraySchema(1000), maxItems: 50 },
        missing_capability: { type: "string", maxLength: 500 },
        available_tools: stringArraySchema(200),
        auto_extract_heuristics: { type: "boolean", default: true },
        domain: { type: "string", maxLength: 100, default: "general" },
        tags: stringArraySchema(100),
        context_notes: { type: "string", maxLength: 2000, description: "Optional free-form agent context. Stored on the reflection but not used for heuristic extraction or search ranking." },
        dry_run: { type: "boolean", default: false, description: "If true, validate and preview the reflection structure without persisting it. Returns what would be saved without writing to disk." },
      },
    },
  },
  {
    name: "bulk_reflect",
    description: "Submit multiple task reflections in one call and one store write. Maximum 20 reflections per call. Optional context_notes is stored but not used for heuristic extraction or search ranking. Per-reflection dry_run is not supported; use reflect_on_task with dry_run:true to preview individual reflections before including them in a batch.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["sessions"],
      properties: {
        sessions: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: ["session_id", "reflections"],
            properties: {
              session_id: { type: "string", maxLength: 200 },
              reflections: {
                type: "array",
                minItems: 1,
                maxItems: 20,
                items: {
                  type: "object",
                  required: ["task_goal", "task_outcome", "failure_mode", "summary"],
                  properties: {
                    task_goal: { type: "string", maxLength: 1000 },
                    task_outcome: { type: "string", enum: ["success", "partial", "failure"] },
                    failure_mode: {
                      type: "string",
                      enum: [
                        "incorrect_task_interpretation",
                        "incorrect_world_assumption",
                        "missing_affordance",
                        "tool_limitation_or_misbehavior",
                        "exhausted_or_misdirected_search",
                        "success",
                      ],
                    },
                    summary: { type: "string", maxLength: 8000 },
                    summary_sections: {
                      ...objectArraySchema({
                        type: "object",
                        required: ["title", "content"],
                        properties: {
                          title: { type: "string", maxLength: 200 },
                          content: { type: "string", maxLength: 8000 },
                        },
                      }),
                    },
                    immediate_blockers: stringArraySchema(),
                    active_hypotheses: stringArraySchema(),
                    proven_safe_paths: stringArraySchema(),
                    exhausted_search: stringArraySchema(),
                    world_model_updates: objectArraySchema(worldModelUpdateJsonSchema),
                    tool_insights: objectArraySchema(toolInsightJsonSchema),
                    context_forget: objectArraySchema(contextForgetJsonSchema),
                    open_questions: objectArraySchema(openQuestionJsonSchema),
                    lessons_learned: { ...stringArraySchema(1000), maxItems: 50 },
                    missing_capability: { type: "string", maxLength: 500 },
                    available_tools: stringArraySchema(200),
                    auto_extract_heuristics: { type: "boolean", default: true },
                    domain: { type: "string", maxLength: 100, default: "general" },
                    tags: stringArraySchema(100),
                    context_notes: { type: "string", maxLength: 2000, description: "Optional free-form agent context. Stored on the reflection but not used for heuristic extraction or search ranking." },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "log_affordance_gap",
    description: "Log a capability gap mid-task. Gaps at 3 or more occurrences get an auto-suggestion.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["session_id", "goal_description", "failure_description", "missing_capability"],
      properties: {
        session_id: { type: "string", maxLength: 200 },
        goal_description: { type: "string", maxLength: 500 },
        failure_description: { type: "string", maxLength: 500 },
        missing_capability: { type: "string", maxLength: 500 },
        available_tools: stringArraySchema(200),
        suggested_solution: { type: "string", maxLength: 1000, description: "Optional manual suggestion. When provided, it is stored instead of an auto-generated suggestion." },
      },
    },
  },
  {
    name: "resolve_affordance_gap",
    description: "Mark an affordance gap as resolved. Use when the missing capability has been added or the blocker removed.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", maxLength: 100 },
        resolution_notes: { type: "string", maxLength: 500, description: "Optional note describing how the gap was resolved." },
      },
    },
  },
  {
    name: "retrieve_heuristics",
    description: "Retrieve relevant lessons before starting a task. This records retrieval usage stats.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["task_description"],
      properties: {
        task_description: { type: "string", maxLength: 1000 },
        domain: { type: "string", maxLength: 100 },
        limit: { type: "number", default: 10 },
        tags: { ...stringArraySchema(100), description: "Optional. Filter to heuristics by tag." },
        tag_mode: { type: "string", enum: ["and", "or"], default: "and", description: "How to match multiple tags: 'and' requires all tags, 'or' accepts any tag. Default: 'and'." },
        show_scores: { type: "boolean", default: false, description: "When true, include retrieval score details for debugging ranking decisions." },
        min_confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.3,
          description: "Minimum confidence threshold for retrieval. Default 0.3 matches the automatic exclusion threshold.",
        },
      },
    },
  },
  {
    name: "bulk_retrieve_heuristics",
    description: "Retrieve relevant heuristics for multiple task descriptions in a single call. Returns one result section per query and records retrieval usage stats once per matched heuristic.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["queries"],
      properties: {
        queries: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            required: ["task_description"],
            properties: {
              task_description: { type: "string", minLength: 1, maxLength: 2000 },
              domain: { type: "string", maxLength: 100 },
              tags: { ...stringArraySchema(100), description: "Optional. Filter to heuristics by tag." },
              tag_mode: { type: "string", enum: ["and", "or"], default: "and", description: "How to match multiple tags: 'and' requires all tags, 'or' accepts any tag." },
              limit: { type: "number", default: 10, minimum: 1, maximum: 20 },
              min_confidence: { type: "number", minimum: 0, maximum: 1, default: 0.3 },
            },
          },
        },
        show_scores: { type: "boolean", default: false, description: "When true, include retrieval score details for debugging ranking decisions." },
      },
    },
  },
  {
    name: "list_heuristics",
    description: "List stored heuristics with optional domain, tag, confidence, limit, and sort filters.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", maxLength: 100 },
        tags: { ...stringArraySchema(100), description: "Optional. Filter to heuristics by tag." },
        tag_mode: { type: "string", enum: ["and", "or"], default: "and", description: "How to match multiple tags: 'and' requires all tags, 'or' accepts any tag." },
        min_confidence: { type: "number", minimum: 0, maximum: 1, default: 0 },
        limit: { type: "number", default: 20, maximum: 100 },
        sort: {
          type: "string",
          enum: ["confidence", "updated_at", "created_at", "reinforcement"],
          default: "confidence",
        },
      },
    },
  },
  {
    name: "search_heuristics",
    description: "Search stored heuristics by query relevance with optional domain, tag, confidence, and limit filters.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", maxLength: 1000 },
        domain: { type: "string", maxLength: 100 },
        tags: { ...stringArraySchema(100), description: "Optional. Filter to heuristics by tag." },
        tag_mode: { type: "string", enum: ["and", "or"], default: "and", description: "How to match multiple tags: 'and' requires all tags, 'or' accepts any tag." },
        min_confidence: { type: "number", minimum: 0, maximum: 1, default: 0 },
        limit: { type: "number", default: 20, maximum: 100 },
      },
    },
  },
  {
    name: "get_heuristic_stats",
    description: "Return detailed statistics about the heuristic knowledge base: confidence distribution, domain breakdown, zombie heuristics (never retrieved after 7+ days), and top performers by retrieval and reinforcement count.",
    annotations: READ_ONLY_TOOL,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_stale_heuristics",
    description: "List heuristics with low Ebbinghaus retention that have not been retrieved or reinforced recently; sorted most forgotten first.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", maxLength: 100, description: "Optional domain to filter by." },
        retention_threshold: { type: "number", minimum: 0, maximum: 1, default: 0.3, description: "Maximum retention to include. Heuristics with retention below this threshold are considered stale. Default: 0.3." },
        min_age_days: { type: "number", integer: true, minimum: 1, default: 7, description: "Minimum days since last retrieval or update. Default: 7." },
        limit: { type: "number", integer: true, minimum: 1, maximum: 100, default: 20, description: "Maximum entries to return. Default: 20." },
        include_pinned: { type: "boolean", default: false, description: "If true, include pinned heuristics in the results. Default: false." },
      },
    },
  },
  {
    name: "get_contradiction_report",
    description: "List heuristics that have been contradicted, sorted by contradiction count descending. Useful for identifying unreliable or outdated rules that need updating or deletion. Returns contradiction notes and current confidence.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", maxLength: 100, description: "Optional domain to filter by." },
        min_contradictions: { type: "number", integer: true, minimum: 1, default: 1, description: "Minimum contradiction count to include. Default: 1." },
        limit: { type: "number", integer: true, minimum: 1, maximum: 100, default: 20, description: "Maximum entries to return. Default: 20." },
        include_archived: { type: "boolean", default: false, description: "If true, include superseded (archived) heuristics. Default: false." },
      },
    },
  },
  {
    name: "add_heuristic",
    description: "Manually add a lesson to the knowledge base.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["heuristic", "source_task"],
      properties: {
        domain: { type: "string", maxLength: 100, default: "general" },
        heuristic: { type: "string", maxLength: 1000 },
        source_task: { type: "string", maxLength: 500 },
        tags: stringArraySchema(100),
        confidence: { type: "number", minimum: 0, maximum: 1, default: 0.7 },
      },
    },
  },
  {
    name: "contradict_heuristic",
    description: "Mark a heuristic as contradicted and lower its confidence.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", maxLength: 100 },
        reason: { type: "string", maxLength: 1000 },
      },
    },
  },
  {
    name: "delete_heuristic",
    description: "Permanently delete a heuristic by id.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", maxLength: 100 },
      },
    },
  },
  {
    name: "pin_heuristic",
    description: "Pin a heuristic to protect it from automatic pruning. Pinned heuristics are never removed by the pruning algorithm regardless of confidence or reinforcement score. Use sparingly for critical invariants. To unpin, call pin_heuristic with pin: false.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", maxLength: 100 },
        pin: { type: "boolean", default: true, description: "true to pin (protect from pruning), false to unpin. Default: true." },
      },
    },
  },
  {
    name: "update_heuristic",
    description: "Edit a stored heuristic's text, tags, confidence, or domain without losing its history (reinforcement count, contradiction notes, created_at).",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", maxLength: 100 },
        heuristic: { type: "string", maxLength: 1000, description: "New heuristic text (optional)." },
        tags: {
          anyOf: [stringArraySchema(100), { type: "null" }],
          description: "Replace tags with this new list. Pass [] to clear tags; omit or pass null to leave tags unchanged.",
        },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "Override confidence value (optional)." },
        domain: { type: "string", maxLength: 100, description: "Move to a different domain (optional)." },
      },
    },
  },
  {
    name: "merge_heuristics",
    description: "Merge one or more source heuristics into a target heuristic. The target absorbs reinforcement_count, contradiction_count, contradiction_notes, and tags from all sources. Sources are archived (marked superseded_by target id). Useful for consolidating near-duplicate lessons.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["target_id", "source_ids"],
      properties: {
        target_id: { type: "string", maxLength: 100 },
        source_ids: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string", maxLength: 100 },
        },
      },
    },
  },
  {
    name: "get_heuristic_history",
    description: "Return the version history for a heuristic supersedes chain, starting from any version id.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", maxLength: 100 },
        include_archived: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "search_reflections",
    description: "Full-text search past reflections. Pass query=\"\" to browse all matching reflections without text filtering.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          maxLength: 1000,
          description: "Full-text search query. Pass an empty string '' to list all reflections matching other filters in reverse chronological order, without text scoring.",
        },
        domain: { type: "string", maxLength: 100 },
        outcome: { type: "string", enum: ["success", "partial", "failure"] },
        limit: { type: "number", default: 20 },
        since_days: { type: "number", description: "Optional. Restrict results to reflections from the last N days." },
        tags: { ...stringArraySchema(100), description: "Optional. Filter to reflections by tag." },
        tag_mode: { type: "string", enum: ["and", "or"], default: "and", description: "How to match multiple tags: 'and' requires all tags, 'or' accepts any tag." },
        failure_mode: { type: "string", enum: ["incorrect_task_interpretation", "incorrect_world_assumption", "missing_affordance", "tool_limitation_or_misbehavior", "exhausted_or_misdirected_search", "success"], description: "Optional. Filter to reflections with this specific failure_mode." },
      },
    },
  },
  {
    name: "list_reflections",
    description: "List reflections with optional domain, outcome, failure_mode, tag, session, and time filters. Returns entries in reverse chronological order with optional pagination. Use for browsing without full-text search.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", maxLength: 100 },
        outcome: { type: "string", enum: ["success", "partial", "failure"] },
        failure_mode: {
          type: "string",
          enum: [
            "incorrect_task_interpretation",
            "incorrect_world_assumption",
            "missing_affordance",
            "tool_limitation_or_misbehavior",
            "exhausted_or_misdirected_search",
            "success",
          ],
        },
        tags: { ...stringArraySchema(100), description: "Optional. Filter to reflections by tag." },
        tag_mode: { type: "string", enum: ["and", "or"], default: "and", description: "How to match multiple tags: 'and' requires all tags, 'or' accepts any tag." },
        session_id: { type: "string", maxLength: 200 },
        since_days: { type: "number", description: "Optional. Only include reflections from the last N days." },
        limit: { type: "number", default: 20, maximum: 100 },
        offset: { type: "number", default: 0, minimum: 0 },
      },
    },
  },
  {
    name: "diff_reflections",
    description: "Compare two reflections and return a structured summary of field, lesson, world-model, open-question, and time differences.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      required: ["id_a", "id_b"],
      properties: {
        id_a: { type: "string", maxLength: 100 },
        id_b: { type: "string", maxLength: 100 },
      },
    },
  },
  {
    name: "get_reflection_summary",
    description: "Dashboard: totals, distributions, top gaps, and recent lessons.",
    annotations: READ_ONLY_TOOL,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_affordance_gaps",
    description: "List capability gaps sorted by frequency.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        min_occurrences: { type: "number", default: 1 },
        include_resolved: { type: "boolean", default: false, description: "When true, include gaps already marked resolved." },
        limit: { type: "number", description: "When provided, return only the top-N gaps by occurrence_count." },
      },
    },
  },
  {
    name: "get_recent_reflections",
    description: "Return recent task reflections in reverse chronological order.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "get_session_reflections",
    description: "Return recent task reflections for one session in reverse chronological order.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string", maxLength: 200 },
        limit: { type: "number", default: 20, maximum: 100 },
      },
    },
  },
  {
    name: "get_session_summary",
    description: "Get a summary of a session: outcome distribution, top lessons, open questions, and heuristics extracted. Use at the end of a session to review work done, or to brief another agent on session context.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string", maxLength: 200, description: "The session id to summarize." },
      },
    },
  },
  {
    name: "get_reflection",
    description: "Get full details of a single reflection by its id. Use after search_reflections or get_recent_reflections to inspect a specific entry. Open questions are merged with the resolved overlay by default; pass apply_resolved_overlay:false to see raw open_question state.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", maxLength: 100 },
        apply_resolved_overlay: {
          type: "boolean",
          default: true,
          description: "If true (default), marks open questions as resolved if they appear in the resolved overlay. Pass false to see raw open_questions without overlay.",
        },
      },
    },
  },
  {
    name: "get_reflection_chain",
    description: "Given a reflection id, return related reflections from the same session that share similar task goals; useful for tracing task evolution.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", maxLength: 100 },
        similarity_threshold: { type: "number", minimum: 0, maximum: 1, default: 0.2, description: "Minimum similarity score (0-1) for non-seed reflections to be included." },
        limit: { type: "number", integer: true, minimum: 1, maximum: 50, default: 10, description: "Maximum number of entries to return." },
        include_self: { type: "boolean", default: true, description: "When true, include the seed reflection itself in the results." },
      },
    },
  },
  {
    name: "update_reflection",
    description: "Update mutable metadata of a saved reflection: domain, tags, or lessons_learned. Immutable fields (task_goal, outcome, timestamp, session_id) cannot be changed. Optionally re-extracts heuristics from updated lessons.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", maxLength: 100 },
        domain: { type: "string", maxLength: 100 },
        tags: {
          anyOf: [stringArraySchema(100), { type: "null" }],
          description: "Replace reflection tags. Pass [] to clear; omit or null to leave unchanged.",
        },
        lessons_learned: {
          type: "array",
          items: { type: "string", maxLength: 2000 },
          description: "Replace stored lessons_learned. Unsafe lesson text is filtered before storage.",
        },
        re_extract_heuristics: {
          type: "boolean",
          default: false,
          description: "When true, extract/update heuristics from the updated lessons.",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.6,
          description: "Confidence for heuristics created when re_extract_heuristics is true.",
        },
      },
    },
  },
  {
    name: "get_open_questions",
    description: "List unresolved questions captured in past reflections, sorted by priority.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", maxLength: 100 },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        limit: { type: "number", default: 30, maximum: 100 },
        since_days: { type: "number", description: "Optional. Only return open questions from reflections in the last N days." },
        include_resolved: { type: "boolean", default: false, description: "When true, include questions already marked resolved." },
      },
    },
  },
  {
    name: "resolve_open_question",
    description: "Mark an open question from a reflection as resolved.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["reflection_id", "question_index"],
      properties: {
        reflection_id: { type: "string", maxLength: 100 },
        question_index: { type: "number", minimum: 0 },
        resolved_by_reflection_id: { type: "string", maxLength: 100 },
      },
    },
  },
  {
    name: "get_world_model",
    description: "Aggregate all world_model_updates from reflections into the agent's current world model. Returns deduplicated facts (latest wins) with polarity, source, evidence, and metadata. Filters by domain and polarity are optional.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", maxLength: 100 },
        polarity: { type: "string", enum: ["affirm", "negate"] },
        limit: { type: "number", default: 50, maximum: 200 },
        since_days: { type: "number", description: "Optional. Only include world model facts from reflections in the last N days." },
      },
    },
  },
  {
    name: "get_reflection_timeline",
    description: "Return time-bucketed reflection metrics across sessions, optionally filtered by domain and time range.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", enum: ["day", "week", "month"], default: "week" },
        domain: { type: "string", maxLength: 100 },
        since_days: { type: "number", default: 90, maximum: 3650, description: "Only include reflections from the last N days." },
        limit: { type: "number", default: 20, maximum: 100, description: "Maximum number of buckets to return." },
      },
    },
  },
  {
    name: "get_store_health",
    description: "Check store integrity, JSONL/index sizes, heuristic version links, session references, and largest reflection size.",
    annotations: READ_ONLY_TOOL,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "export_project_experience_md",
    description: "Generate a Markdown experience document from completed project reflections. Use at the end of a project/session to create a reusable lesson document for RAG ingestion.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", maxLength: 200, description: "Optional. Summarize one exact session_id." },
        domain: { type: "string", maxLength: 100, description: "Optional domain filter when session_id is not provided." },
        tags: { ...stringArraySchema(100), description: "Optional. Filter to reflections by tag." },
        tag_mode: { type: "string", enum: ["and", "or"], default: "and", description: "How to match tags: 'and' (default) requires all tags present, 'or' accepts any tag." },
        since_days: { type: "number", description: "Optional. Only include reflections from the last N days." },
        limit: { type: "number", default: 50, maximum: 200, description: "Maximum reflections to include before writing the document." },
        title: { type: "string", maxLength: 200, description: "Optional Markdown title for the experience document." },
        output_path: { type: "string", maxLength: 500, description: "Optional exact .md file path to write." },
        output_dir: { type: "string", maxLength: 500, description: "Optional directory where a safe generated .md filename will be written." },
        include_raw_reflections: { type: "boolean", default: false, description: "When true, append compact per-reflection details." },
        format: {
          type: "string",
          enum: ["markdown", "plaintext", "json"],
          default: "markdown",
          description: "Output format. 'markdown' (default): full Markdown document. 'plaintext': strip Markdown syntax for cleaner RAG embedding. 'json': structured JSON with title, scope, reflection_count, and markdown.",
        },
      },
    },
  },
  {
    name: "export_heuristics_md",
    description: "Export active heuristics grouped by domain as Markdown or plaintext. Supports optional filters (domain, tags, confidence, sort) and optional file output via output_path.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", maxLength: 100, description: "Optional. Filter to heuristics in one domain." },
        tags: { ...stringArraySchema(100), description: "Optional. Filter to heuristics by tag." },
        tag_mode: { type: "string", enum: ["and", "or"], default: "and", description: "How to match tags: 'and' (default) requires all tags present, 'or' accepts any tag." },
        min_confidence: { type: "number", minimum: 0, maximum: 1, description: "Optional minimum confidence threshold (0.0-1.0)." },
        sort: { type: "string", enum: ["confidence", "updated_at", "created_at", "reinforcement"], default: "confidence", description: "Sort order within each domain group." },
        limit_per_domain: { type: "number", minimum: 1, maximum: 200, default: 50, description: "Maximum heuristics per domain." },
        format: { type: "string", enum: ["markdown", "plaintext"], default: "markdown", description: "Output format." },
        output_path: { type: "string", maxLength: 500, description: "Optional file path to write the output." },
      },
    },
  },
  {
    name: "export_data",
    description: "Export reflection store data. Pass output_path to write JSON to a file (bypasses inline size limit). Large responses without output_path return counts instead of full JSON.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          enum: ["reflections", "heuristics", "affordance_gaps", "sessions", "all"],
          default: "all",
        },
        format: { type: "string", enum: ["json"], default: "json" },
        output_path: { type: "string", maxLength: 500, description: "Optional file path to write JSON export." },
      },
    },
  },
  {
    name: "clear_data",
    description: "Clear a data collection. Requires confirm:true and should not be auto-approved. Consider calling snapshot before clearing to create a recovery point.",
    annotations: DESTRUCTIVE_TOOL,
    inputSchema: {
      type: "object",
      required: ["collection", "confirm"],
      properties: {
        collection: {
          type: "string",
          enum: ["reflections", "heuristics", "affordance_gaps", "sessions", "all"],
        },
        confirm: { type: "boolean" },
      },
    },
  },
  {
    name: "import_data",
    description: "Import reflection store data from a JSON file. Supports merge (append new items) or replace (overwrite collections) mode. Complements export_data. Consider calling snapshot before import_data with mode:\"replace\" to create a recovery point.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["input_path"],
      properties: {
        input_path: { type: "string", maxLength: 500, description: "Path to the JSON file to import." },
        mode: { type: "string", enum: ["merge", "replace"], default: "merge", description: "merge: append items with new ids. replace: overwrite collections present in the file." },
      },
    },
  },
  {
    name: "snapshot",
    description: "Create an atomic snapshot of all store files (store.json, reflections.jsonl, resolved_questions.json) into a timestamped subdirectory. Returns the snapshot directory path. Use before clear_data or import_data(replace) to create a recovery point.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        output_dir: {
          type: "string",
          maxLength: 500,
          description: "Directory to write the snapshot subdirectory into. Defaults to ~/.hermes-reflection/snapshots/.",
        },
        label: {
          type: "string",
          maxLength: 100,
          description: "Optional label appended to the snapshot directory name (e.g. 'before-import').",
        },
      },
    },
  },
  {
    name: "get_domain_summary",
    description: "Get a summary of activity for one domain or a ranked list of top domains by reflection count. Note: active_affordance_gaps_global reflects unresolved affordance gaps across the entire store (AffordanceGap records are not attributed to a domain), not gaps specific to the queried domain.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", maxLength: 100, description: "Optional domain to summarize. If omitted, returns a ranked top-domain list." },
        top_n: { type: "number", integer: true, minimum: 1, maximum: 50, default: 10, description: "Number of top domains to return when no domain is specified." },
        include_open_questions_detail: {
          type: "boolean",
          default: false,
          description: "If true, include the top 10 unresolved open questions for each domain. Default: false.",
        },
      },
    },
  },
  {
    name: "memory_board_write",
    description: "Add, replace, or remove lightweight memory board entries. Pass operations for atomic batch add/replace/remove with final capacity checks.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace", "remove"] },
        content: { type: "string", maxLength: 2200, description: "Required for add/replace." },
        old_text: { type: "string", maxLength: 1000, description: "Unique substring required for replace/remove." },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description: "Optional atomic batch. If provided, action/content/old_text at the top level are ignored.",
          items: {
            type: "object",
            required: ["action"],
            properties: {
              action: { type: "string", enum: ["add", "replace", "remove"] },
              content: { type: "string", maxLength: 2200, description: "Required for add/replace." },
              old_text: { type: "string", maxLength: 1000, description: "Unique substring required for replace/remove." },
            },
          },
        },
      },
    },
  },
  {
    name: "memory_board_read",
    description: "Read the live Memory Board by default, or an explicitly captured frozen snapshot for a session. Snapshot mode fails when session_id is missing or no active snapshot exists.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["live", "snapshot"], default: "live" },
        session_id: { type: "string", minLength: 1, maxLength: 200, description: "Required when mode is snapshot." },
      },
    },
  },
  {
    name: "user_profile_write",
    description: "Add, replace, remove, or batch-update stable user profile facts/preferences. This mirrors Hermes USER.md memory and is injected as reference-only context.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace", "remove"] },
        content: { type: "string", maxLength: 1800, description: "Required for add/replace. Store stable user facts/preferences only." },
        old_text: { type: "string", maxLength: 1000, description: "Unique substring required for replace/remove." },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description: "Optional atomic batch. If provided, action/content/old_text at the top level are ignored.",
          items: {
            type: "object",
            required: ["action"],
            properties: {
              action: { type: "string", enum: ["add", "replace", "remove"] },
              content: { type: "string", maxLength: 1800 },
              old_text: { type: "string", maxLength: 1000 },
            },
          },
        },
      },
    },
  },
  {
    name: "user_profile_read",
    description: "Read the live reference-only User Profile by default, or an explicitly captured frozen snapshot for a session. Snapshot mode fails when session_id is missing or absent.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["live", "snapshot"], default: "live" },
        session_id: { type: "string", minLength: 1, maxLength: 200, description: "Required when mode is snapshot." },
      },
    },
  },
  {
    name: "get_prompt_memory_context",
    description: "Build a Hermes-style prompt memory context block from Memory Board, User Profile, top heuristics, recent sessions, and external provider metadata.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        task_description: { type: "string", maxLength: 1000 },
        domain: { type: "string", maxLength: 100 },
        tags: { type: "array", items: { type: "string", maxLength: 100 } },
        top_heuristics: { type: "number", integer: true, minimum: 0, maximum: 20, default: 5 },
        recent_sessions: { type: "number", integer: true, minimum: 0, maximum: 20, default: 5 },
        include_memory_board: { type: "boolean", default: true },
        include_user_profile: { type: "boolean", default: true },
        include_external_provider: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "get_memory_snapshot",
    description: "Return a point-in-time memory snapshot containing the board and optionally top active heuristics.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        include_board: { type: "boolean", default: true },
        include_heuristics: { type: "boolean", default: false },
        top_heuristics: { type: "number", integer: true, minimum: 1, maximum: 50, default: 10 },
      },
    },
  },
  {
    name: "append_session_turn",
    description: "Store a conversation turn into the local SQLite FTS5 session index for later search_sessions retrieval.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["session_id", "role", "content"],
      properties: {
        session_id: { type: "string", minLength: 1, maxLength: 200 },
        role: { type: "string", enum: ["user", "assistant"] },
        content: { type: "string", minLength: 1, maxLength: 100000 },
        timestamp: { type: "string", maxLength: 30 },
      },
    },
  },
  {
    name: "search_sessions",
    description: "Search stored conversation turns using the local SQLite FTS5 session index. Omit query or pass an empty string to browse recent sessions.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 1000 },
        limit: { type: "number", integer: true, minimum: 1, maximum: 100, default: 10 },
        since_days: { type: "number", integer: true, minimum: 1, maximum: 3650 },  // H1-fix: was minimum: 0 without integer
      },
    },
  },
  {
    name: "compact_session_context",
    description: "Return a compact reference-only summary of stored turns for one indexed session, inspired by Hermes context compression.",
    annotations: READ_ONLY_TOOL,
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string", minLength: 1, maxLength: 200 },
        max_turns: { type: "number", integer: true, minimum: 1, maximum: 200, default: 40 },
        max_chars: { type: "number", integer: true, minimum: 500, maximum: 20000, default: 6000 },
      },
    },
  },
  {
    name: "list_pending_mutations",
    description: "List memory write operations waiting for manual approval when write_approval is enabled.",
    annotations: READ_ONLY_TOOL,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "approve_pending_mutation",
    description: "Approve or reject a queued write. Approval replays the bounded typed payload and removes the queue item only after replay succeeds; rejection discards it without execution.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      required: ["mutation_id", "decision"],
      properties: {
        mutation_id: { type: "string", maxLength: 100 },
        decision: { type: "string", enum: ["approve", "reject"] },
      },
    },
  },
  {
    name: "get_memory_status",
    description: "Show unified status for the reflection store, memory board, session FTS index, write approval, and external provider config.",
    annotations: READ_ONLY_TOOL,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sync_to_provider",
    description: "Prepare a local no-network reflection sync payload for a configured external memory provider.",
    annotations: MUTATING_TOOL,
    inputSchema: {
      type: "object",
      properties: {
        batch_size: { type: "number", integer: true, minimum: 1, maximum: 50, default: 10 },
        since_reflection_id: { type: "string", maxLength: 100 },
      },
    },
  },
  // v19.0.0 new tools
  NEW_TOOL_DEFINITIONS.capture_memory_snapshot,
  NEW_TOOL_DEFINITIONS.session_lifecycle_hook,
  NEW_TOOL_DEFINITIONS.scan_memory_threats,
  NEW_TOOL_DEFINITIONS.scroll_session_context,
  NEW_TOOL_DEFINITIONS.trigger_background_review,
];

const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "reflect_on_task",
  "search_reflections",
  "list_reflections",
  "retrieve_heuristics",
  "list_heuristics",
  "search_heuristics",
  "add_heuristic",
  "delete_heuristic",
  "memory_board_write",
  "memory_board_read",
  "user_profile_write",
  "user_profile_read",
  "get_open_questions",
  "resolve_open_question",
  "search_sessions",
  "append_session_turn",
  "get_recent_reflections",
  "export_data",
  "import_data",
  "clear_data",
  "list_pending_mutations",
  "approve_pending_mutation",
  "compact_session_context",
  // v19.0.0 new tools
  "capture_memory_snapshot",
  "session_lifecycle_hook",
  "scan_memory_threats",
  "scroll_session_context",
  "trigger_background_review",
]);

const PUBLIC_TOOL_DEFS = TOOL_DEFS.filter((def) => CORE_TOOL_NAMES.has(def.name));

// Startup sanity check: every core name must have a definition, and count must be exactly 28.
for (const name of CORE_TOOL_NAMES) {
  if (!TOOL_DEFS.find((def) => def.name === name)) {
    throw new Error(`Startup sanity check failed: core tool "${name}" has no definition in TOOL_DEFS.`);
  }
}
if (PUBLIC_TOOL_DEFS.length !== 28) {
  throw new Error(`Startup sanity check failed: expected 28 public tools but got ${PUBLIC_TOOL_DEFS.length}.`);
}

const server = new Server(
  { name: "hermes-reflection-mcp", version: SERVER_VERSION },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PUBLIC_TOOL_DEFS }));

// D2: removed dead code memoryBoardBlock, clipForContext, compactTurns

async function replayPendingMutation(mutation: PendingMutation): Promise<string> {
  const payload = mutation.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Pending mutation ${mutation.id} has no replay payload. Reject it and re-run the original tool call.`);
  }

  switch (mutation.operation) {
    case "reflect_on_task": {
      const p = z.object({
        reflection: z.any(),
        lessons: z.array(z.string()),
        domain: z.string(),
        sourceTask: z.string(),
        confidence: z.number(),
        tags: z.array(z.string()),
      }).parse(payload);
      // A5-fix: validate reflection has required ReflectionFrame fields before casting
      const r = p.reflection;
      if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.timestamp !== "string"
          || typeof r.task_goal !== "string" || typeof r.task_outcome !== "string") {
        throw new Error(`Pending mutation ${mutation.id} has malformed reflection payload: missing required fields (id, timestamp, task_goal, task_outcome)`);
      }
      const saved = await saveReflectionAndHeuristics(
        r as ReflectionFrame,
        p.lessons,
        p.domain,
        p.sourceTask,
        p.confidence,
        p.tags,
      );
      return `executed reflect_on_task (${saved.reflectionCount} reflection(s) total)`;
    }
    case "add_heuristic": {
      const input = AddHeuristicSchema.parse(payload);
      const heuristic = await upsertHeuristic(input);
      return `executed add_heuristic (${heuristic.id})`;
    }
    case "delete_heuristic": {
      const input = DeleteHeuristicSchema.parse(payload);
      const deleted = await deleteHeuristic(input.id);
      if (!deleted) throw new Error(`No heuristic found with id: ${input.id}`);
      return `executed delete_heuristic (${input.id})`;
    }
    case "clear_data": {
      const input = ClearDataSchema.parse({ ...payload, confirm: true });
      await clearData(input.collection);
      return `executed clear_data (${input.collection})`;
    }
    case "import_data": {
      const input = z.object({
        incoming: z.any(),
        mode: z.enum(["merge", "replace"]),
      }).parse(payload);
      const counts = await importData(input.incoming as Partial<ReflectionStore>, input.mode as ImportMode);
      return `executed import_data (${formatCounts(counts)})`;
    }
    case "memory_board_write": {
      const input = MemoryBoardWriteSchema.parse(payload);
      const result = input.operations?.length
        ? await memoryBoardBatchWrite(input.operations)
        : await memoryBoardWrite(input.action!, input.content, input.old_text);
      if (result.success === false) {
        throw new Error(result.error ?? "memory_board_write replay failed");
      }
      return `executed memory_board_write (${input.operations?.length ? `${input.operations.length} operation(s)` : input.action})`;
    }
    case "user_profile_write": {
      const input = UserProfileWriteSchema.parse(payload);
      const result = input.operations?.length
        ? await userProfileBatchWrite(input.operations)
        : await userProfileWrite(input.action!, input.content, input.old_text);
      if (result.success === false) {
        throw new Error(result.error ?? "user_profile_write replay failed");
      }
      return `executed user_profile_write (${input.operations?.length ? `${input.operations.length} operation(s)` : input.action})`;
    }
    default:
      throw new Error(`Unsupported pending mutation operation: ${mutation.operation}`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // A6-fix: destructure inside try to handle null/undefined params gracefully
  const { name, arguments: args } = request.params ?? { name: "", arguments: undefined };

  // Reject non-core tools even if called by direct name
  if (!CORE_TOOL_NAMES.has(name)) {
    return err(`Unknown tool: ${name}`);
  }

  try {
    switch (name) {
      case "reflect_on_task": {
        const input = ReflectOnTaskSchema.parse(args ?? {});
        const prepared = prepareReflectionSave(input);

        if (input.dry_run) {
          const warningCount = prepared.skippedUnsafeCount;
          return ok(`[DRY RUN] Reflection preview (not persisted)

Task: ${input.task_goal}
Outcome: ${input.task_outcome.toUpperCase()} - ${input.failure_mode}
Domain: ${input.domain}
Would-be reflection id: ${prepared.save.reflection.id}

Task State:
  Blockers: ${input.immediate_blockers.length > 0 ? input.immediate_blockers.join("; ") : "none"}
  Safe paths: ${input.proven_safe_paths.length}
  Dead ends: ${input.exhausted_search.length}
  Open questions: ${input.open_questions.length}

World model updates: ${input.world_model_updates.length}
Tool insights: ${input.tool_insights.length}
Lessons to extract: ${prepared.extractedCount}
Blocked unsafe lessons (warnings): ${warningCount}
Affordance gaps: ${prepared.save.reflection.affordance_gaps.length}
${prepared.save.reflection.lessons_learned.length > 0
  ? "\nLessons:\n" + prepared.save.reflection.lessons_learned.map((lesson) => `  - ${safeHeuristicText(lesson)}`).join("\n")
  : ""}${prepared.save.reflection.affordance_gaps.length > 0
  ? `\nAffordance gap would be logged: "${input.missing_capability ?? "unspecified"}"`
  : ""}${prepared.extractedCount > 0
  ? `\n${prepared.extractedCount} heuristic(s) would be saved to [${input.domain}]`
  : ""}

No data was written. Remove dry_run:true to persist this reflection.`);
        }

        const { session, reflectionCount, nearSoftLimit } = await saveReflectionAndHeuristics(
          prepared.save.reflection,
          prepared.save.lessons,
          prepared.save.domain,
          prepared.save.sourceTask,
          prepared.save.confidence,
          prepared.save.tags,
          "reflect_on_task",
        );
        const reflectionLimitWarning = nearSoftLimit
          ? `\n\n[WARN] Reflection store has ${reflectionCount} entries (soft limit: ${REFLECTION_SOFT_LIMIT}). Consider exporting and archiving old data with export_data(output_path=...).`
          : "";

        let responseText = `[OK] Reflection saved [${prepared.save.reflection.id}]

Task: ${input.task_goal}
Outcome: ${input.task_outcome.toUpperCase()} - ${input.failure_mode}
Domain: ${input.domain}
Summary: ${input.summary}

Task State:
  Blockers: ${input.immediate_blockers.length > 0 ? input.immediate_blockers.join("; ") : "none"}
  Safe paths: ${input.proven_safe_paths.length}
  Dead ends: ${input.exhausted_search.length}
  Open questions: ${input.open_questions.length}

World model updates: ${input.world_model_updates.length}
Tool insights: ${input.tool_insights.length}
Lessons learned: ${prepared.save.reflection.lessons_learned.length}
${prepared.save.reflection.lessons_learned.map((lesson) => `  - ${safeHeuristicText(lesson)}`).join("\n")}${prepared.gapLine}${prepared.heuristicLine}
Session [${input.session_id.slice(0, 8)}]: ${session.reflection_count} reflection(s) this session.${reflectionLimitWarning}`;

        try {
          const similarQuery = [input.task_goal, ...input.lessons_learned.slice(0, 2)].join(" ").slice(0, 300);
          const similar = await searchReflections(
            similarQuery,
            undefined,
            undefined,
            4,
          );
          const filtered = similar.filter((r) => r.id !== prepared.save.reflection.id).slice(0, 3);
          if (filtered.length > 0) {
            const similarLines = ["[Similar past reflections]"];
            for (const r of filtered) {
              similarLines.push(`- [${r.timestamp.slice(0, 10)}] [${r.domain}] ${r.task_goal.slice(0, 80)} (id:${r.id})`);
            }
            responseText += `\n\n${similarLines.join("\n")}`;
          }
        } catch (searchErr) {
          // A10-fix: log search failure for observability without breaking main response
          console.warn("[hermes] similar-reflection search failed:", searchErr instanceof Error ? searchErr.message : searchErr);
        }

        return ok(responseText);
      }



//         // const saved = await upsertAffordanceGap(gap, "log_affordance_gap");

//         // if (saved.occurrence_count >= 3) {
          // return ok(`[HIGH] Gap x${saved.occurrence_count}: "${saved.missing_capability}"\nSuggestion: ${saved.suggested_solution ?? "Auto-suggestion pending next occurrence"}`);
        // }
        // if (saved.occurrence_count >= 2) {
          // return ok(`[WARN] Gap x${saved.occurrence_count}: "${saved.missing_capability}" is recurring.`);
        // }
        // return ok(`[OK] Gap logged [${gap.id}]: "${input.missing_capability}"`);
      // }


      case "retrieve_heuristics": {
        const input = RetrieveHeuristicsSchema.parse(args ?? {});
        const heuristics = await retrieveRelevantHeuristics(
          input.task_description,
          input.domain,
          input.limit,
          input.tags.length > 0 ? input.tags : undefined,
          input.show_scores,
          input.min_confidence,
          input.tag_mode,
        );
        if (heuristics.length === 0) {
          return ok("No relevant heuristics yet. They will accumulate as tasks complete.");
        }
        const lines = heuristics.map((heuristic, index) => {
          const notes = (heuristic.contradiction_notes ?? []);
          const notesLine = notes.length > 0
            ? `\n   Contradictions: ${notes.slice(-2).join(" | ")}`
            : "";
          const score = (heuristic as HeuristicWithScore)._score;
          const scoreLine = input.show_scores && score
            ? `\n   Score: ${score.final} [text:${score.text} conf:${score.confidence} retain:${score.retention} retrieval:${score.retrieval} reinforcement:${score.reinforcement} domain_bonus:${score.domain_bonus}]`
            : "";
          const retrievedLine = ` | Retrieved x${heuristic.retrieval_count ?? 0}${heuristic.last_retrieved_at ? ` (last: ${heuristic.last_retrieved_at.slice(0, 10)})` : ""}`;
          return `${index + 1}. [${heuristic.domain}] id:${heuristic.id}\n   Confidence: ${(heuristic.confidence * 100).toFixed(0)}% | Confirmed x${heuristic.reinforcement_count} | Contradicted x${heuristic.contradiction_count}${retrievedLine}${scoreLine}\n   ${heuristic.heuristic}${notesLine}`;
        });
        return ok(`${heuristics.length} heuristic(s) for "${input.task_description}":\n\n${lines.join("\n\n")}`);
      }


      case "list_heuristics": {
        const input = ListHeuristicsSchema.parse(args ?? {});
        const heuristics = await listHeuristics({
          domain: input.domain,
          tags: input.tags.length > 0 ? input.tags : undefined,
          tagMode: input.tag_mode,
          minConfidence: input.min_confidence,
          limit: input.limit,
          sort: input.sort,
        });
        if (heuristics.length === 0) {
          return ok("No heuristics matched the requested filters.");
        }
        const lines = heuristics.map((heuristic, index) => {
          const tagLine = heuristic.tags.length > 0 ? `\n   Tags: ${heuristic.tags.join(", ")}` : "";
          const notesLine = heuristic.contradiction_notes.length > 0
            ? `\n   Contradictions: ${heuristic.contradiction_notes.slice(-2).join(" | ")}`
            : "";
          const retrievedLine = ` | Retrieved x${heuristic.retrieval_count ?? 0}${heuristic.last_retrieved_at ? ` (last: ${heuristic.last_retrieved_at.slice(0, 10)})` : ""}`;
          return `${index + 1}. [${heuristic.domain}] id:${heuristic.id}\n   Confidence: ${(heuristic.confidence * 100).toFixed(0)}% | Confirmed x${heuristic.reinforcement_count} | Contradicted x${heuristic.contradiction_count}${retrievedLine}${tagLine}\n   ${heuristic.heuristic}${notesLine}`;
        });
        return ok(`${heuristics.length} heuristic(s):\n\n${lines.join("\n\n")}`);
      }

      case "search_heuristics": {
        const input = SearchHeuristicsSchema.parse(args ?? {});
        const heuristics = await searchHeuristics(
          input.query,
          input.domain,
          input.tags.length > 0 ? input.tags : undefined,
          input.tag_mode,
          input.min_confidence,
          input.limit,
        );
        if (heuristics.length === 0) {
          return ok(`No heuristics matched "${input.query}".`);
        }
        const lines = heuristics.map((heuristic, index) => {
          const tagLine = heuristic.tags.length > 0 ? `\n   Tags: ${heuristic.tags.join(", ")}` : "";
          const notesLine = heuristic.contradiction_notes.length > 0
            ? `\n   Contradictions: ${heuristic.contradiction_notes.slice(-2).join(" | ")}`
            : "";
          return `${index + 1}. [${heuristic.domain}] id:${heuristic.id}\n   Score: ${(heuristic.score * 100).toFixed(0)}% | Confidence: ${(heuristic.confidence * 100).toFixed(0)}% | Confirmed x${heuristic.reinforcement_count} | Contradicted x${heuristic.contradiction_count}${tagLine}\n   ${heuristic.heuristic}${notesLine}`;
        });
        return ok(`${heuristics.length} heuristic search result(s) for "${input.query}":\n\n${lines.join("\n\n")}`);
      }




      case "add_heuristic": {
        const input = AddHeuristicSchema.parse(args ?? {});
        const heuristic = await upsertHeuristic({
          domain: input.domain,
          heuristic: input.heuristic,
          source_task: input.source_task,
          confidence: input.confidence,
          tags: input.tags,
        }, "add_heuristic");
        return ok(`[OK] Heuristic saved [${heuristic.id}]\n[${heuristic.domain}] ${heuristic.heuristic}\nConfidence: ${(heuristic.confidence * 100).toFixed(0)}%`);
      }


      case "delete_heuristic": {
        const input = DeleteHeuristicSchema.parse(args ?? {});
        const deleted = await deleteHeuristic(input.id, "delete_heuristic");
        if (!deleted) return err(`No heuristic found with id: ${input.id}`);
        return ok(`[OK] Heuristic deleted [${input.id}]`);
      }





      case "search_reflections": {
        const input = SearchReflectionsSchema.parse(args ?? {});
        const results = await searchReflections(
          input.query,
          input.domain,
          input.outcome,
          input.limit,
          input.since_days,
          input.tags.length > 0 ? input.tags : undefined,
          input.failure_mode,
          input.tag_mode,
        );
        if (results.length === 0) {
          return ok(`No reflections matched "${input.query}".`);
        }
        const lines = results.map((reflection) => {
          const lessons = reflection.lessons_learned.length > 0
            ? `\n   Lessons: ${reflection.lessons_learned.slice(0, 2).join(" | ")}`
            : "";
          const summary = truncate(reflection.task_state.summary, 100);
          return `[${reflection.timestamp.slice(0, 10)}] [${reflection.domain}] ${outcomeBadge(reflection.task_outcome)} ${reflection.task_goal} id:${reflection.id}\n   ${reflection.failure_mode} - ${summary}${lessons}`;
        });
        return ok(`${results.length} result(s) for "${input.query}":\n\n${lines.join(results.length > 10 ? "\n\n---\n\n" : "\n\n")}`);
      }

      case "list_reflections": {
        const input = ListReflectionsSchema.parse(args ?? {});
        const reflections = await listReflections({
          domain: input.domain,
          outcome: input.outcome,
          failureMode: input.failure_mode,
          tags: input.tags.length > 0 ? input.tags : undefined,
          tagMode: input.tag_mode,
          sessionId: input.session_id,
          sinceDays: input.since_days,
          limit: input.limit,
          offset: input.offset,
        });
        if (reflections.length === 0) {
          return ok("No reflections matched the filters.");
        }
        const lines = reflections.map((reflection) =>
          `[${reflection.timestamp.slice(0, 16)}] [${reflection.domain}] ${outcomeBadge(reflection.task_outcome)} ${reflection.task_goal} id:${reflection.id}\n   ${reflection.failure_mode} - ${truncate(reflection.task_state.summary, 100)}`
        );
        const paginationNote = input.offset > 0 ? ` (offset: ${input.offset})` : "";
        return ok(`${reflections.length} reflection(s)${paginationNote}:\n\n${lines.join(reflections.length > 10 ? "\n\n---\n\n" : "\n\n")}`);
      }



//         // return ok(`HERMES REFLECTION DASHBOARD
// Sessions: ${summary.total_sessions}
// Reflections: ${summary.total_reflections}${reflectionLimitNote}
// Heuristics: ${summary.total_heuristics} active / ${HEURISTIC_MAX_COUNT} soft limit${summary.total_heuristics_archived > 0 ? ` (${summary.total_heuristics_archived} archived)` : ""}
// Affordance gaps: ${summary.total_affordance_gaps} active${summary.total_affordance_gaps_resolved > 0 ? ` (${summary.total_affordance_gaps_resolved} resolved)` : ""}
// Data stored at: ${STORE_DIR}

// // Outcome distribution:
// ${outcomeList || "  (none yet)"}

// // Failure distribution:
// ${failureList || "  (none yet)"}

// // Domain distribution:
// ${domainList || "  (none yet)"}

// // Tag distribution:
// ${tagList || "  (none yet)"}

// // Top affordance gaps:
// ${gapList || "  (none yet)"}

// // Recent lessons learned:
// ${lessonList || "  (none yet)"}${summary.metadata ? `\nStore metadata:\n  Created: ${summary.metadata.created_at.slice(0, 10)}\n  Write count: ${summary.metadata.write_count}` : ""}`);
      // }


      case "get_recent_reflections": {
        const input = GetRecentReflectionsSchema.parse(args ?? {});
        const reflections = await getRecentReflections(input.limit);
        if (reflections.length === 0) {
          return ok("No reflections yet.");
        }
        const lines = reflections.map((reflection) =>
          `[${reflection.timestamp.slice(0, 16)}] [${reflection.domain}] ${outcomeBadge(reflection.task_outcome)} ${reflection.task_goal} id:${reflection.id}\n   ${reflection.failure_mode} - ${truncate(reflection.task_state.summary, 100)}`
        );
        return ok(`${reflections.length} recent reflection(s):\n\n${lines.join(reflections.length > 10 ? "\n\n---\n\n" : "\n\n")}`);
      }



//         // const outcomeLines = Object.entries(summary.outcome_distribution)
          // .map(([k, v]) => `  ${k}: ${v}`)
          // .join("\n");
        // const lessonLines = summary.top_lessons.length > 0
          // ? summary.top_lessons.map((l, i) => `  ${i + 1}. ${l}`).join("\n")
          // : "  (none)";
        // const qLines = summary.open_questions.length > 0
          // ? summary.open_questions.map((q) => `  [${q.priority.toUpperCase()}] ${q.question}`).join("\n")
          // : "  (none)";

//         // return ok(`SESSION SUMMARY [${summary.session_id.slice(0, 16)}...]
// Started: ${summary.started_at.slice(0, 16)}
// Reflections: ${summary.reflection_count} | Heuristics extracted: ${summary.heuristics_extracted} | Gaps logged: ${summary.affordance_gaps_logged}
// Domains: ${summary.domains.join(", ") || "(none)"}

// // Outcome distribution:
// ${outcomeLines || "  (none)"}

// // Top lessons (last 5):
// ${lessonLines}

// // Open questions (top 5 by priority):
// ${qLines}`);
      // }


//         // return ok(`Reflection [${reflection.id}]
// Timestamp: ${reflection.timestamp}
// Domain: ${reflection.domain}
// Outcome: ${reflection.task_outcome.toUpperCase()} - ${reflection.failure_mode}
// Session: ${reflection.session_id}
// Task: ${reflection.task_goal}
// Summary: ${reflection.task_state.summary}${sections}

// // Task state:${blockers}${safePaths}${deadEnds}${hypotheses}${tags}${lessons}${worldUpdates}${toolInsights}${openQuestions}${contextForget}${contextNotes}`);
      // }



      case "get_open_questions": {
        const input = GetOpenQuestionsSchema.parse(args ?? {});
        const questions = await getOpenQuestions(input.domain, input.priority, input.limit, input.since_days, input.include_resolved);
        if (questions.length === 0) {
          return ok("No open questions matched the filters.");
        }
        const lines = questions.map((question, index) => {
          const environmentFlag = question.requires_environment_interaction ? " env" : "";
          const resolvedFlag = question.resolved ? " resolved" : "";
          const resolvedLine = question.resolved
            ? `\n   Resolved: ${question.resolved_at?.slice(0, 10) ?? "yes"}${question.resolved_by ? ` by ${question.resolved_by}` : ""}`
            : "";
          return `${index + 1}. [${question.priority}${environmentFlag}${resolvedFlag}] [${question.domain}] ${question.question}\n   Task: ${question.task_goal}\n   Reflection: ${question.reflection_id} question_index:${question.question_index} (${question.timestamp.slice(0, 10)})${resolvedLine}`;
        });
        // E7-fix: adjust title when include_resolved is true
        const title = input.include_resolved
          ? `${questions.length} question(s) (including resolved):`
          : `${questions.length} open question(s):`;
        return ok(`${title}\n\n${lines.join("\n\n")}`);
      }

      case "resolve_open_question": {
        const input = ResolveOpenQuestionSchema.parse(args ?? {});
        const result = await resolveOpenQuestion(
          input.reflection_id,
          input.question_index,
          input.resolved_by_reflection_id,
        );
        if (!result) return err(`No reflection found: ${input.reflection_id}`);
        if (!result.found) return err(`No open question at index ${input.question_index} for reflection ${input.reflection_id}`);
        return ok(`[OK] Open question resolved: ${result.question}`);
      }


//         // const affirmed = facts.filter((f) => f.polarity === "affirm");
        // const negated = facts.filter((f) => f.polarity === "negate");

//         // const formatFact = (f: WorldFactSummary): string => {
          // const date = f.timestamp.slice(0, 10);
          // const evidencePart = f.evidence ? ` evidence: ${f.evidence}` : "";
          // return `  - [${f.domain}] ${f.fact} (source: ${f.source}, ${date}, id: ${f.reflection_id})${evidencePart}`;
        // };

//         // const sections: string[] = [];

//         // if (!input.polarity || input.polarity === "affirm") {
          // if (affirmed.length > 0) {
            // sections.push(`AFFIRMED (${affirmed.length}):\n${affirmed.map(formatFact).join("\n")}`);
          // }
        // }

//         // if (!input.polarity || input.polarity === "negate") {
          // if (negated.length > 0) {
            // sections.push(`NEGATED (${negated.length}):\n${negated.map(formatFact).join("\n")}`);
          // }
        // }

//         // return ok(`WORLD MODEL SNAPSHOT (${facts.length} facts)\n\n${sections.join("\n\n")}`);
      // }




//         // const result = await generateProjectExperienceMarkdown({
          // session_id: input.session_id,
          // domain: input.domain,
          // tags: input.tags,
          // tag_mode: input.tag_mode,
          // since_days: input.since_days,
          // limit: input.limit,
          // title: input.title,
          // include_raw_reflections: input.include_raw_reflections,
        // });

//         // if (!result) {
          // return err("No reflections matched the export_project_experience_md filters.");
        // }

//         // const outputContent = input.format === "plaintext"
          // ? stripMarkdown(result.markdown)
          // : input.format === "json"
            // ? JSON.stringify({
                // title: result.title,
                // scope: result.scope,
                // reflection_count: result.reflection_count,
                // markdown: result.markdown,
              // }, null, 2)
            // : result.markdown;

//         // if (!input.output_path && !input.output_dir) {
          // return ok(outputContent);
        // }

//         // const outputPath = input.output_path
          // ? input.output_path
          // : join(input.output_dir!, safeMarkdownFilename(input.title ?? result.title));

//         // try {
          // await mkdir(input.output_path ? dirname(outputPath) : input.output_dir!, { recursive: true });
          // await writeFile(outputPath, outputContent, "utf-8");
        // } catch (writeErr) {
          // const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          // return err(`Failed to write project experience Markdown to ${outputPath}: ${msg}`);
        // }

//         // return ok(`[OK] Wrote project experience ${input.format} to ${outputPath}.
// Title: ${result.title}
// Reflections: ${result.reflection_count}
// Scope: ${result.scope}`);
      // }


      case "export_data": {
        const input = ExportDataSchema.parse(args ?? {});
        const store = await exportData();
        const selected = selectCollection(store, input.collection);
        const json = JSON.stringify(selected, null, 2);
        const byteLength = Buffer.byteLength(json, "utf8");
        if (input.output_path) {
          const pathCheck = safePath(input.output_path);
          if (!pathCheck.ok) return err(pathCheck.error);
          try {
            await writeFile(pathCheck.path, json, "utf-8");
            return ok(`[OK] Export written to ${pathCheck.path} (${Math.ceil(byteLength / 1024)} KiB).`);
          } catch (writeErr) {
            const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
            return err(`Failed to write export to ${pathCheck.path}: ${msg}`);
          }
        }
        if (byteLength > EXPORT_INLINE_LIMIT_BYTES) {
          // H5-fix: show counts for the selected collection, not all collections
          const selectedCounts = collectionCounts(store, input.collection);
          return ok(`The selected collection (${input.collection}) export is too large to return inline (${Math.ceil(byteLength / 1024)} KiB).

${formatCounts(selectedCounts)}

Pass output_path to write the JSON to a file, or use a smaller collection export. You can also inspect the store file directly at ${STORE_DIR}.`);
        }
        return ok(json);
      }

      case "clear_data": {
        const input = ClearDataSchema.parse(args ?? {});
        if (!input.confirm) {
          return err("clear_data requires confirm:true to proceed.");
        }
        const before = await exportData();
        const counts = collectionCounts(before, input.collection);
        await clearData(input.collection, "clear_data");
        // E1-fix: also clear SQLite session storage when clearing sessions or all
        let sessionClearedNote = "";
        if (input.collection === "sessions" || input.collection === "all") {
          const cleared = await clearSessionStorage();
          if (cleared) sessionClearedNote = "\nNote: SQLite session database was also cleared.";
        }
        const warning = input.collection === "sessions"
          ? "\nWarning: reflections still retain their session_id fields."
          : "";
        const resolvedNote = input.collection === "reflections" || input.collection === "all"
          ? "\nNote: resolved_questions index was also cleared."
          : "";
        return ok(`[OK] Cleared "${input.collection}".\n${formatCounts(counts)}${warning}${resolvedNote}${sessionClearedNote}`);
      }

      case "import_data": {
        const input = ImportDataSchema.parse(args ?? {});
        const pathCheck = safePath(input.input_path);
        if (!pathCheck.ok) return err(pathCheck.error);
        let raw: string;
        try {
          raw = await readFile(pathCheck.path, "utf-8");
        } catch (readErr) {
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          return err(`Cannot read file: ${pathCheck.path}: ${msg}`);
        }
        let parsed: Partial<ReflectionStore>;
        try {
          parsed = JSON.parse(raw) as Partial<ReflectionStore>;
        } catch (parseErr) {
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          return err(`Invalid JSON in file: ${pathCheck.path}: ${msg}`);
        }
        const counts = await importData(parsed, input.mode as ImportMode, "import_data");
        const label = input.mode === 'merge' ? 'Newly added:' : 'Store totals after import:';
        return ok(`[OK] Imported in "${input.mode}" mode from ${pathCheck.path}.\n${label}\n${formatCounts(counts)}`);
      }



//         // if (Array.isArray(result)) {
          // if (result.length === 0) {
            // return ok("No domains found.");
          // }
          // const header = `Top ${result.length} domains by reflection count:`;
          // const rows = result.map((s, i) => {
            // const detail = input.include_open_questions_detail && s.open_questions_detail?.length
              // ? `\n${s.open_questions_detail.map((q) => `     - [${q.priority}] ${q.question} (${q.reflection_id})`).join("\n")}`
              // : "";
            // return `  ${i + 1}. ${s.domain} - ${s.reflection_count} reflection(s), ${s.active_heuristics} heuristic(s), ${s.open_questions} open question(s)${detail}`;
          // });
          // return ok(`${header}\n${rows.join("\n")}`);
        // }

//         // // Single domain
        // const s = result;
        // if (s.reflection_count === 0) {
          // return ok(`DOMAIN SUMMARY: ${s.domain}

// // Reflections: 0
// Active heuristics: ${s.active_heuristics}
// Open questions: 0
// Active affordance gaps (store-wide, not domain-specific): ${s.active_affordance_gaps_global}`);
        // }

//         // const outcomeLines = Object.entries(s.outcome_distribution)
          // .map(([k, v]) => `  ${k}: ${v}`)
          // .join("\n");
        // const sections = [
          // `DOMAIN SUMMARY: ${s.domain}`,
          // `Reflections: ${s.reflection_count}`,
          // `Active heuristics: ${s.active_heuristics}`,
          // `Open questions: ${s.open_questions}`,
          // `Active affordance gaps (store-wide, not domain-specific): ${s.active_affordance_gaps_global}`,
          // `Outcome distribution:\n${outcomeLines}`,
        // ];
        // if (s.top_failure_mode) {
          // sections.push(`Top failure mode: ${s.top_failure_mode}`);
        // }
        // if (s.recent_lesson) {
          // sections.push(`Recent lesson: ${s.recent_lesson}`);
        // }
        // if (input.include_open_questions_detail && s.open_questions_detail?.length) {
          // sections.push(`Open question details:\n${s.open_questions_detail.map((q) =>
            // `  [${q.priority}] ${q.question} (reflection:${q.reflection_id}${q.requires_environment_interaction ? ", env" : ""})`
          // ).join("\n")}`);
        // }
        // return ok(sections.join("\n"));
      // }

      case "memory_board_write": {
        const input = MemoryBoardWriteSchema.parse(args ?? {});
        const result = input.operations?.length
          ? await memoryBoardBatchWriteEnhanced(input.operations, "memory_board_write")
          : await memoryBoardWriteEnhanced(input.action!, input.content, input.old_text, "memory_board_write");
        // A2-fix: propagate failure as MCP error, consistent with replayPendingMutation path
        return okOrErr(JSON.stringify(result, null, 2));
      }

      case "memory_board_read": {
        const input = MemoryReadSchema.parse(args ?? {});
        if (input.mode === "live") return ok(await memoryBoardRead());
        const result = await memoryBoardReadEnhanced(input.session_id, true);
        return ok(`source: ${result.source}\ncaptured_at: ${result.captured_at}\n${result.content}`);
      }

      case "user_profile_write": {
        const input = UserProfileWriteSchema.parse(args ?? {});
        const result = input.operations?.length
          ? await userProfileBatchWriteEnhanced(input.operations, "user_profile_write")
          : await userProfileWriteEnhanced(input.action!, input.content, input.old_text, "user_profile_write");
        // A2-fix: propagate failure as MCP error
        return okOrErr(JSON.stringify(result, null, 2));
      }

      case "user_profile_read": {
        const input = MemoryReadSchema.parse(args ?? {});
        if (input.mode === "live") return ok(await userProfileRead());
        const result = await userProfileReadEnhanced(input.session_id, true);
        return ok(`source: ${result.source}\ncaptured_at: ${result.captured_at}\n${result.content}`);
      }



      case "append_session_turn": {
        const input = AppendSessionTurnSchema.parse(args ?? {});
        const appended = await appendSessionTurn(input.session_id, input.role, input.content, input.timestamp);
        if (!appended) return err(SESSION_STORAGE_UNAVAILABLE);
        return ok(`[OK] Turn appended to session ${input.session_id} (role: ${input.role}, ${input.content.length} chars).`);
      }

      case "search_sessions": {
        const input = SearchSessionsSchema.parse(args ?? {});
        const query = input.query.trim();
        if (query.length === 0) {
          const sessions = await listRecentSessions(input.limit, input.since_days);
          if (sessions === null) return err(SESSION_STORAGE_UNAVAILABLE);
          if (sessions.length === 0) return ok("No recent indexed sessions.");
          const rows = sessions.map((session, index) =>
            `${index + 1}. session_id: ${session.session_id}\n   started_at: ${session.started_at}\n   turn_count: ${session.turn_count}\n   last_turn_at: ${session.last_turn_at ?? "unknown"}`
          );
          return ok(`${sessions.length} recent session(s):\n\n${rows.join("\n\n")}`);
        }
        const results = await searchSessions(query, input.limit, input.since_days);
        if (results === null) return err(SESSION_STORAGE_UNAVAILABLE);
        if (results.length === 0) return ok("No session turns matched.");
        const rows = results.map((result, index) =>
          `${index + 1}. [${result.session_id}#${result.turn_index}] ${result.role} ${result.timestamp}\n   ${result.snippet}`
        );
        return ok(`${results.length} session turn(s) matched:\n\n${rows.join("\n\n")}`);
      }

      case "list_pending_mutations": {
        const pending = await listPendingMutations();
        return ok(JSON.stringify({
          success: true,
          pending: pending.map((mutation) => ({
            id: mutation.id,
            created_at: mutation.created_at,
            operation: mutation.operation,
            preview: safeJsonPreview(mutation.payload ?? mutation.preview, 300),
          })),
        }, null, 2));
      }

      case "approve_pending_mutation": {
        const input = z.object({
          mutation_id: z.string().min(1).max(100),
          decision: z.enum(["approve", "reject"]),
        }).parse(args ?? {});
        const pending = await listPendingMutations();
        const mutation = pending.find((item) => item.id === input.mutation_id);
        if (!mutation) return err(`Pending mutation not found: ${input.mutation_id}`);

        if (input.decision === "reject") {
          await rejectPendingMutation(mutation.id);
          return ok(`Pending mutation rejected: ${mutation.id}`);
        }

        const replayResult = await replayPendingMutation(mutation);
        const removed = await rejectPendingMutation(mutation.id);
        if (!removed) return err(`Replay succeeded but pending record could not be removed: ${mutation.id}`);
        return ok(`Pending mutation approved and ${replayResult}`);
      }





// // Store:
  // Version: ${store.version}
  // Reflections: ${store.reflections.length}
  // Heuristics: ${store.heuristics.length}
  // Sessions: ${Object.keys(store.sessions).length}
  // Writes: ${store.metadata?.write_count ?? 0}

// // Memory Board:
  // Entries: ${board.entries.length}
  // Usage: ${liveUsedChars}/${board.char_limit} chars (${pct}%)

// // User Profile:
  // Entries: ${profile.entries.length}
  // Usage: ${profileUsedChars}/${profile.char_limit} chars (${profilePct}%)

// // Session FTS:
  // Recent indexed sessions: ${recentSessions?.length ?? 0}
// ${recentSessions === null ? `  ${SESSION_STORAGE_UNAVAILABLE}` : recentSessions.map((session) => `  - ${session.session_id}: ${session.turn_count} turn(s), last ${session.last_turn_at ?? "unknown"}`).join("\n") || "  (none)"}

// // Write Approval:
  // Enabled: ${store.metadata?.write_approval === true}
  // Pending mutations: ${store.metadata?.pending_mutations?.length ?? 0}

// // External Provider:
  // ${provider ? `${provider.name}${provider.endpoint ? ` endpoint=${provider.endpoint}` : ""}${provider.db_path ? ` db_path=${provider.db_path}` : ""}${provider.auto_sync ? " auto_sync=true" : ""}` : "(not configured)"}`);
      // }


      // v19.0.0 new tools
      case "capture_memory_snapshot": {
        const result = await handleCaptureMemorySnapshot(args ?? {});
        return okOrErr(result);
      }

      case "session_lifecycle_hook": {
        const result = await handleSessionLifecycleHook(args ?? {});
        return okOrErr(result);
      }

      case "scan_memory_threats": {
        const result = await handleScanMemoryThreats(args ?? {});
        return okOrErr(result);
      }

      case "scroll_session_context": {
        const result = await handleScrollSessionContext(args ?? {});
        return okOrErr(result);
      }

      case "compact_session_context": {
        return okOrErr(await handleCompactSessionContext(args ?? {}));
      }

      case "trigger_background_review": {
        const result = await handleTriggerBackgroundReview(args ?? {});
        return okOrErr(result);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof Error && (error as Error & { isPendingApproval?: boolean }).isPendingApproval) {
      // A15-fix: mark as error so clients know the operation hasn't completed yet
      return { content: [{ type: "text" as const, text: `[PENDING] ${error.message}` }], isError: true };
    }
    // E9-fix: handle AggregateError (Promise.any rejections) which has empty .message
    const message = error instanceof AggregateError
      ? (error.errors.map((e) => e instanceof Error ? e.message : String(e)).join("; ") || "AggregateError")
      : error instanceof Error ? error.message : String(error);
    return err(`[${name}] ${message}`);
  }
});

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function selectCollection(store: ReflectionStore, collection: ClearCollection | "all") {
  switch (collection) {
    case "reflections":
      return { reflections: store.reflections };
    case "heuristics":
      return { heuristics: store.heuristics };
    case "affordance_gaps":
      return { affordance_gaps: store.affordance_gaps };
    case "sessions":
      return { sessions: store.sessions };
    case "all":
      return store;
  }
}

function collectionCounts(store: ReflectionStore, collection: ClearCollection): Record<string, number> {
  const allCounts = {
    sessions: Object.keys(store.sessions).length,
    reflections: store.reflections.length,
    affordance_gaps: store.affordance_gaps.length,
    heuristics: store.heuristics.length,
    memory_board_entries: store.memory_board?.entries.length ?? 0,
    user_profile_entries: store.user_profile?.entries.length ?? 0,
  };
  switch (collection) {
    case "sessions":
      return { sessions: allCounts.sessions };
    case "reflections":
      return { reflections: allCounts.reflections };
    case "affordance_gaps":
      return { affordance_gaps: allCounts.affordance_gaps };
    case "heuristics":
      return { heuristics: allCounts.heuristics };
    case "all":
      return allCounts;
  }
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join("\n");
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`hermes-reflection-mcp v${SERVER_VERSION} ready (store: ${STORE_DIR})`);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
