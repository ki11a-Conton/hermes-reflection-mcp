#!/usr/bin/env node
// ============================================================
// Hermes Reflection MCP Server
// Compatible with: Claude Desktop, Codex Desktop, Claude Code
//
// Tools (37):
//   reflect_on_task
//   bulk_reflect
//   log_affordance_gap
//   resolve_affordance_gap
//   retrieve_heuristics
//   bulk_retrieve_heuristics
//   list_heuristics
//   search_heuristics
//   get_heuristic_stats
//   add_heuristic
//   contradict_heuristic
//   delete_heuristic
//   update_heuristic
//   pin_heuristic
//   merge_heuristics
//   get_heuristic_history
//   search_reflections
//   list_reflections
//   diff_reflections
//   get_reflection_summary
//   get_affordance_gaps
//   get_recent_reflections
//   get_session_reflections
//   get_session_summary
//   get_reflection
//   update_reflection
//   get_open_questions
//   resolve_open_question
//   get_world_model
//   get_reflection_timeline
//   get_store_health
//   export_project_experience_md
//   export_data
//   import_data
//   snapshot
//   clear_data
//   get_domain_summary
// ============================================================
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { z } from "zod";
import { saveReflectionAndHeuristics, batchSaveReflections, upsertHeuristic, contradictHeuristic, deleteHeuristic, pinHeuristic, updateHeuristic, mergeHeuristics, getHeuristicHistory, listHeuristics, searchHeuristics, getHeuristicStats, retrieveRelevantHeuristics, bulkRetrieveHeuristics, searchReflections, listReflections, diffReflections, getReflectionSummary, getAffordanceGaps, getRecentReflections, getSessionReflections, getSessionSummary, getReflectionById, updateReflection, getOpenQuestions, resolveOpenQuestion, getWorldModel, getReflectionTimeline, checkStoreHealth, upsertAffordanceGap, resolveAffordanceGap, generateId, firstHeuristicThreatMessage, safeHeuristicText, STORE_DIR, HEURISTIC_MAX_COUNT, REFLECTION_SOFT_LIMIT, exportData, importData, createSnapshot, clearData, generateProjectExperienceMarkdown, safeMarkdownFilename, getDomainSummary, } from "./storage.js";
const SERVER_VERSION = "14.0.0";
const EXPORT_INLINE_LIMIT_BYTES = 500 * 1024;
const SERVER_INSTRUCTIONS = `Hermes Reflection MCP provides persistent reflection memory.

Core Workflow:
1. Before significant work, call retrieve_heuristics with the current task description, optional domain, and optional tags.
2. During work, call log_affordance_gap when progress is blocked by a missing capability, tool, permission, or environment affordance.
3. After significant work, call reflect_on_task with an honest task_outcome, failure_mode, summary, and lessons learned. Submit at most 50 lessons in one call.
4. Use get_recent_reflections, get_session_reflections, or search_reflections before repeating a similar investigation.
5. Before starting a repeated or similar task, call get_open_questions to surface unresolved follow-ups from past work. Use resolve_open_question when a question has been answered, and resolve_affordance_gap when a previously missing capability has been added.
6. At the end of a completed project or session, call export_project_experience_md to generate a reusable Markdown experience document. Pass output_dir to write directly into a RAG documents folder when useful.

Quality:
- Lessons should be concrete, transferable, and tied to a source task.
- Use task_outcome honestly: success, partial, or failure.
- reflect_on_task.summary_sections can store structured long summaries.
- reflect_on_task.tags labels reflections and extracted heuristics for later filtering.
- Contradict incorrect heuristics with contradict_heuristic; the optional reason is persisted in contradiction_notes.
- Merge near-duplicate heuristics with merge_heuristics when automatic deduplication kept similar lessons separate.
- Pin critical heuristics with pin_heuristic when they must be protected from automatic pruning.
- retrieve_heuristics defaults to min_confidence=0.3; pass a lower value to include tentative lessons.

Search and Retrieval:
- retrieve_heuristics.tags filters heuristics by tag; tag_mode:"and" requires all tags, tag_mode:"or" accepts any tag.
- list_heuristics inspects stored heuristics directly with domain, tag, confidence, limit, and sort filters.
- search_heuristics searches stored heuristics by query relevance with optional domain, tag, and confidence filters.
- get_heuristic_stats summarizes heuristic quality, retrieval usage, domain coverage, and stale lessons.
- search_reflections.since_days restricts results to recent reflections.
- search_reflections.tags and list_reflections.tags support tag_mode:"and" (all tags) or tag_mode:"or" (any tag).
- list_reflections browses reflections with filters and pagination without full-text search.
- get_reflection_summary reports outcome, failure, domain, tag, gap, lesson, and store metadata summaries.
- get_open_questions lists unresolved questions from past reflections, sorted by priority.
- get_world_model shows the agent's accumulated world knowledge (affirmed and negated facts across all past reflections, deduplicated to latest).
- get_reflection_timeline shows time-bucketed reflection metrics by day, week, or month.
- get_session_summary returns a session digest: outcome breakdown, top lessons, and open questions. Ideal for session handoff or self-review.
- export_project_experience_md generates a reusable Markdown project-experience document from completed reflections.
- diff_reflections compares two past reflections to find lesson additions, removals, and world-model polarity shifts; useful when repeating a task type across sessions.
- get_store_health reports file sizes, integrity issues, and data counts; run it proactively if the store feels slow or after a large import.
- Tool metadata includes read-only, mutating, and destructive annotations for safer clients.

How the system gets smarter over time:
- New lessons start with a confidence score and are reinforced when similar lessons are added again.
- Retrieval increments usage counters and records last_retrieved_at, so frequently useful lessons become easier to surface.
- Ebbinghaus-style decay slightly lowers stale lessons unless reinforcement keeps them stable.
- Text edits create a supersedes chain instead of overwriting old lessons, preserving history while hiding archived versions from normal retrieval.
- Open questions keep unresolved follow-ups visible until an agent answers or closes the underlying investigation.

Data Management:
- export_data can return JSON inline or write it to output_path.
- import_data can merge or replace from a JSON snapshot.
- clear_data is destructive and requires confirm:true.
- Keep secrets, credentials, tokens, and private config out of reflections and heuristics.`;
function outcomeBadge(outcome) {
    switch (outcome) {
        case "success":
            return "+";
        case "partial":
            return "~";
        case "failure":
            return "!";
    }
}
function nullableArray(schema) {
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
    session_id: z.string().max(200),
    task_goal: z.string().max(1000),
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
    missing_capability: z.string().max(500).optional(),
    available_tools: nullableArray(z.string().max(200)),
    auto_extract_heuristics: z.boolean().default(true),
    domain: domainSchema,
    tags: nullableArray(z.string().max(100)),
    dry_run: z.boolean().default(false),
});
const BulkReflectSchema = z.object({
    sessions: z.array(z.object({
        session_id: z.string().max(200),
        reflections: z.array(ReflectOnTaskSchema.omit({ session_id: true })).min(1).max(20),
    })).min(1).max(20),
}).superRefine((value, ctx) => {
    const count = value.sessions.reduce((sum, session) => sum + session.reflections.length, 0);
    if (count > 20) {
        ctx.addIssue({
            code: z.ZodIssueCode.too_big,
            maximum: 20,
            type: "array",
            inclusive: true,
            message: "bulk_reflect accepts at most 20 reflections per call.",
            path: ["sessions"],
        });
    }
});
const LogAffordanceGapSchema = z.object({
    session_id: z.string().max(200),
    goal_description: z.string().max(500),
    failure_description: z.string().max(500),
    missing_capability: z.string().max(500),
    available_tools: nullableArray(z.string().max(200)),
    suggested_solution: z.string().max(1000).optional(),
});
const ResolveAffordanceGapSchema = z.object({
    id: z.string().max(100),
    resolution_notes: z.string().max(500).optional(),
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
const BulkRetrieveHeuristicsSchema = z.object({
    queries: z.array(z.object({
        task_description: z.string().min(1).max(2000),
        domain: optionalDomainSchema,
        tags: nullableArray(z.string().max(100)),
        tag_mode: z.enum(["and", "or"]).default("and"),
        limit: z.number().int().min(1).max(20).default(10),
        min_confidence: z.number().min(0).max(1).default(0.3),
    })).min(1).max(5),
    show_scores: z.boolean().default(false),
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
const PinHeuristicSchema = z.object({
    id: z.string().max(100),
    pin: z.boolean().default(true),
});
const UpdateHeuristicSchema = z.object({
    id: z.string().max(100),
    heuristic: z.string().max(1000).optional(),
    tags: z.array(z.string().max(100)).nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
    domain: optionalDomainSchema,
});
const MergeHeuristicsSchema = z.object({
    target_id: z.string().max(100),
    source_ids: z.array(z.string().max(100)).min(1).max(10),
});
const GetHeuristicHistorySchema = z.object({
    id: z.string().max(100),
    include_archived: z.boolean().default(true),
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
const DiffReflectionsSchema = z.object({
    id_a: z.string().max(100),
    id_b: z.string().max(100),
});
const GetAffordanceGapsSchema = z.object({
    min_occurrences: z.number().int().min(1).default(1),
    include_resolved: z.boolean().default(false),
});
const GetRecentReflectionsSchema = z.object({
    limit: z.number().int().min(1).max(100).default(20),
});
const GetSessionReflectionsSchema = z.object({
    session_id: z.string().max(200),
    limit: z.number().int().min(1).max(100).default(20),
});
const GetSessionSummarySchema = z.object({
    session_id: z.string().max(200),
});
const GetReflectionSchema = z.object({
    id: z.string().max(100),
    apply_resolved_overlay: z.boolean().default(true),
});
const UpdateReflectionSchema = z.object({
    id: z.string().max(100),
    domain: optionalDomainSchema,
    tags: nullableArray(z.string().max(100)).optional(),
    lessons_learned: z.array(z.string().max(2000)).optional(),
    re_extract_heuristics: z.boolean().default(false),
    confidence: z.number().min(0).max(1).default(0.6),
});
const SnapshotSchema = z.object({
    output_dir: z.string().max(500).optional(),
    label: z.string().max(100).optional(),
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
const GetWorldModelSchema = z.object({
    domain: optionalDomainSchema,
    polarity: z.enum(["affirm", "negate"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    since_days: z.number().int().min(1).max(3650).optional(),
});
const GetReflectionTimelineSchema = z.object({
    bucket: z.enum(["day", "week", "month"]).default("week"),
    domain: optionalDomainSchema,
    since_days: z.number().int().min(1).max(3650).default(90),
    limit: z.number().int().min(1).max(100).default(20),
});
const ExportDataSchema = z.object({
    collection: z.enum(["reflections", "heuristics", "affordance_gaps", "sessions", "all"]).default("all"),
    format: z.enum(["json"]).default("json"),
    output_path: z.string().max(500).optional(),
});
const ClearDataSchema = z.object({
    collection: z.enum(["reflections", "heuristics", "affordance_gaps", "sessions", "all"]),
    confirm: z.boolean().default(false),
});
const ImportDataSchema = z.object({
    input_path: z.string().max(500),
    mode: z.enum(["merge", "replace"]).default("merge"),
});
const ExportProjectExperienceMdSchema = z.object({
    session_id: z.string().max(200).optional(),
    domain: optionalDomainSchema,
    tags: nullableArray(z.string().max(100)),
    tag_mode: z.enum(["and", "or"]).default("and").optional(),
    since_days: z.number().int().min(1).max(3650).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    title: z.string().max(200).optional(),
    output_path: z.string().max(500).optional(),
    output_dir: z.string().max(500).optional(),
    include_raw_reflections: z.boolean().default(false),
    format: z.enum(["markdown", "plaintext", "json"]).default("markdown"),
});
const GetDomainSummarySchema = z.object({
    domain: optionalDomainSchema,
    top_n: z.number().int().min(1).max(50).default(10),
    include_open_questions_detail: z.boolean().default(false),
});
function ok(text) {
    return { content: [{ type: "text", text }] };
}
function err(text) {
    return { content: [{ type: "text", text }], isError: true };
}
function stripMarkdown(text) {
    return text
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\|[^\n]+\|/g, (row) => row.split("|").filter(Boolean).map((cell) => cell.trim()).join("; "))
        .replace(/^[-*+]\s+/gm, "")
        .replace(/^\d+\.\s+/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function prepareReflectionSave(input) {
    const gaps = [];
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
    const deduplicatedLessons = [...new Map(input.lessons_learned.map((lesson) => [lesson.toLowerCase().trim(), lesson])).values()];
    const tags = [...new Set(input.tags.map((tag) => tag.toLowerCase().trim()).filter(Boolean))];
    const reflection = {
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
    };
    const confidence = input.task_outcome === "success" ? 0.75 :
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
        { type: "array", items: { type: "string", maxLength } },
        { type: "null" },
    ],
    default: [],
});
const objectArraySchema = (itemSchema) => ({
    anyOf: [
        { type: "array", items: itemSchema },
        { type: "null" },
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
Stores a ReflectionFrame, optionally extracts lessons as heuristics, and tracks affordance gaps.`,
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
                dry_run: { type: "boolean", default: false, description: "If true, validate and preview the reflection structure without persisting it. Returns what would be saved without writing to disk." },
            },
        },
    },
    {
        name: "bulk_reflect",
        description: "Submit multiple task reflections in one call and one store write. Maximum 20 reflections per call.",
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
        description: "Get a summary of activity for one domain or a ranked list of top domains by reflection count.",
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
];
const server = new Server({ name: "hermes-reflection-mcp", version: SERVER_VERSION }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "reflect_on_task": {
                const input = ReflectOnTaskSchema.parse(args);
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
                        : ""}${prepared.gapLine}${prepared.heuristicLine}

No data was written. Remove dry_run:true to persist this reflection.`);
                }
                const { session, reflectionCount, nearSoftLimit } = await saveReflectionAndHeuristics(prepared.save.reflection, prepared.save.lessons, prepared.save.domain, prepared.save.sourceTask, prepared.save.confidence, prepared.save.tags);
                const reflectionLimitWarning = nearSoftLimit
                    ? `\n\n[WARN] Reflection store has ${reflectionCount} entries (soft limit: ${REFLECTION_SOFT_LIMIT}). Consider exporting and archiving old data with export_data(output_path=...).`
                    : "";
                return ok(`[OK] Reflection saved [${prepared.save.reflection.id}]

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
Session [${input.session_id.slice(0, 8)}]: ${session.reflection_count} reflection(s) this session.${reflectionLimitWarning}`);
            }
            case "bulk_reflect": {
                const input = BulkReflectSchema.parse(args ?? {});
                const prepared = [];
                for (const session of input.sessions) {
                    for (const reflectionInput of session.reflections) {
                        prepared.push(prepareReflectionSave({ ...reflectionInput, session_id: session.session_id }).save);
                    }
                }
                const { results, reflectionCount, nearSoftLimit } = await batchSaveReflections(prepared);
                const lines = results.map((result, index) => `${index + 1}. [${result.id}] ${result.outcome.toUpperCase()} - ${result.task_goal} (heuristics_extracted:${result.heuristics_extracted})`);
                const reflectionLimitWarning = nearSoftLimit
                    ? `\n\n[WARN] Reflection store has ${reflectionCount} entries (soft limit: ${REFLECTION_SOFT_LIMIT}). Consider exporting and archiving old data with export_data(output_path=...).`
                    : "";
                return ok(`[OK] Bulk reflection saved ${results.length} item(s) in one store write.\n\n${lines.join("\n")}${reflectionLimitWarning}`);
            }
            case "log_affordance_gap": {
                const input = LogAffordanceGapSchema.parse(args);
                const gap = {
                    id: generateId(),
                    timestamp: new Date().toISOString(),
                    session_id: input.session_id,
                    goal_description: input.goal_description,
                    failure_description: input.failure_description,
                    missing_capability: input.missing_capability,
                    available_tools: input.available_tools,
                    occurrence_count: 1,
                    suggested_solution: input.suggested_solution,
                };
                const saved = await upsertAffordanceGap(gap);
                if (saved.occurrence_count >= 3) {
                    return ok(`[HIGH] Gap x${saved.occurrence_count}: "${saved.missing_capability}"\nSuggestion: ${saved.suggested_solution ?? "Auto-suggestion pending next occurrence"}`);
                }
                if (saved.occurrence_count >= 2) {
                    return ok(`[WARN] Gap x${saved.occurrence_count}: "${saved.missing_capability}" is recurring.`);
                }
                return ok(`[OK] Gap logged [${gap.id}]: "${input.missing_capability}"`);
            }
            case "resolve_affordance_gap": {
                const input = ResolveAffordanceGapSchema.parse(args ?? {});
                const gap = await resolveAffordanceGap(input.id, input.resolution_notes);
                if (!gap)
                    return err(`No affordance gap found with id: ${input.id}`);
                const notes = gap.resolution_notes ? `\nResolution: ${gap.resolution_notes}` : "";
                return ok(`[OK] Affordance gap resolved [${gap.id}]\n"${gap.missing_capability}"${notes}`);
            }
            case "retrieve_heuristics": {
                const input = RetrieveHeuristicsSchema.parse(args);
                const heuristics = await retrieveRelevantHeuristics(input.task_description, input.domain, input.limit, input.tags.length > 0 ? input.tags : undefined, input.show_scores, input.min_confidence, input.tag_mode);
                if (heuristics.length === 0) {
                    return ok("No relevant heuristics yet. They will accumulate as tasks complete.");
                }
                const lines = heuristics.map((heuristic, index) => {
                    const notes = (heuristic.contradiction_notes ?? []);
                    const notesLine = notes.length > 0
                        ? `\n   Contradictions: ${notes.slice(-2).join(" | ")}`
                        : "";
                    const score = heuristic._score;
                    const scoreLine = input.show_scores && score
                        ? `\n   Score: ${score.final} [text:${score.text} conf:${score.confidence} retain:${score.retention} retrieval:${score.retrieval} reinforcement:${score.reinforcement} domain_bonus:${score.domain_bonus}]`
                        : "";
                    const retrievedLine = ` | Retrieved x${heuristic.retrieval_count ?? 0}${heuristic.last_retrieved_at ? ` (last: ${heuristic.last_retrieved_at.slice(0, 10)})` : ""}`;
                    return `${index + 1}. [${heuristic.domain}] id:${heuristic.id}\n   Confidence: ${(heuristic.confidence * 100).toFixed(0)}% | Confirmed x${heuristic.reinforcement_count} | Contradicted x${heuristic.contradiction_count}${retrievedLine}${scoreLine}\n   ${heuristic.heuristic}${notesLine}`;
                });
                return ok(`${heuristics.length} heuristic(s) for "${input.task_description}":\n\n${lines.join("\n\n")}`);
            }
            case "bulk_retrieve_heuristics": {
                const input = BulkRetrieveHeuristicsSchema.parse(args ?? {});
                const allResults = await bulkRetrieveHeuristics(input.queries.map((query) => ({
                    taskDescription: query.task_description,
                    domain: query.domain,
                    tags: query.tags.length > 0 ? query.tags : undefined,
                    tagMode: query.tag_mode,
                    limit: query.limit,
                    minConfidence: query.min_confidence,
                })), input.show_scores);
                const sections = input.queries.map((query, index) => {
                    const heuristics = allResults[index] ?? [];
                    const label = query.task_description.length > 60
                        ? `${query.task_description.slice(0, 57)}...`
                        : query.task_description;
                    if (heuristics.length === 0) {
                        return `[Query ${index + 1}] "${label}"\n  No heuristics found.`;
                    }
                    const lines = heuristics.map((heuristic, heuristicIndex) => {
                        const score = heuristic._score;
                        const scoreLine = input.show_scores && score ? ` (score: ${score.final})` : "";
                        return `  ${heuristicIndex + 1}. [${heuristic.domain}] ${safeHeuristicText(heuristic.heuristic).slice(0, 120)}${scoreLine}`;
                    });
                    return `[Query ${index + 1}] "${label}"\n${lines.join("\n")}`;
                });
                return ok(`[OK] Bulk retrieved for ${input.queries.length} quer${input.queries.length === 1 ? "y" : "ies"}:\n\n${sections.join("\n\n")}`);
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
                const input = SearchHeuristicsSchema.parse(args);
                const heuristics = await searchHeuristics(input.query, input.domain, input.tags.length > 0 ? input.tags : undefined, input.tag_mode, input.min_confidence, input.limit);
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
            case "get_heuristic_stats": {
                const stats = await getHeuristicStats();
                return ok(formatHeuristicStats(stats));
            }
            case "add_heuristic": {
                const input = AddHeuristicSchema.parse(args);
                const heuristic = await upsertHeuristic({
                    domain: input.domain,
                    heuristic: input.heuristic,
                    source_task: input.source_task,
                    confidence: input.confidence,
                    tags: input.tags,
                });
                return ok(`[OK] Heuristic saved [${heuristic.id}]\n[${heuristic.domain}] ${heuristic.heuristic}\nConfidence: ${(heuristic.confidence * 100).toFixed(0)}%`);
            }
            case "contradict_heuristic": {
                const input = ContradictHeuristicSchema.parse(args);
                const heuristic = await contradictHeuristic(input.id, input.reason);
                if (!heuristic)
                    return err(`No heuristic found with id: ${input.id}`);
                const reasonLine = input.reason ? `\nReason: ${input.reason}` : "";
                return ok(`[WARN] Heuristic contradicted [${heuristic.id}]\nNew confidence: ${(heuristic.confidence * 100).toFixed(0)}% (contradicted x${heuristic.contradiction_count})\n"${heuristic.heuristic}"${reasonLine}`);
            }
            case "delete_heuristic": {
                const input = DeleteHeuristicSchema.parse(args);
                const deleted = await deleteHeuristic(input.id);
                if (!deleted)
                    return err(`No heuristic found with id: ${input.id}`);
                return ok(`[OK] Heuristic deleted [${input.id}]`);
            }
            case "pin_heuristic": {
                const input = PinHeuristicSchema.parse(args ?? {});
                const heuristic = await pinHeuristic(input.id, input.pin);
                if (!heuristic)
                    return err(`No active heuristic found with id: ${input.id}`);
                const state = input.pin ? "pinned" : "unpinned";
                return ok(`[OK] Heuristic ${state} [${heuristic.id}]\n[${heuristic.domain}] ${heuristic.heuristic}`);
            }
            case "update_heuristic": {
                const input = UpdateHeuristicSchema.parse(args);
                const updated = await updateHeuristic(input.id, {
                    heuristic: input.heuristic,
                    tags: input.tags ?? undefined,
                    confidence: input.confidence,
                    domain: input.domain,
                });
                if (!updated)
                    return err(`No heuristic found with id: ${input.id}`);
                const tagLine = updated.tags.length > 0 ? `\nTags: ${updated.tags.join(", ")}` : "";
                const versionLine = `v${updated.version ?? 1}`;
                const supersedesLine = (updated.supersedes ?? []).length > 0
                    ? `\nSupersedes: ${(updated.supersedes ?? []).join(", ")} (old version archived)`
                    : "";
                return ok(`[OK] Heuristic updated [${updated.id}] ${versionLine}${supersedesLine}\n[${updated.domain}] ${updated.heuristic}\nConfidence: ${(updated.confidence * 100).toFixed(0)}%${tagLine}`);
            }
            case "merge_heuristics": {
                const input = MergeHeuristicsSchema.parse(args ?? {});
                const result = await mergeHeuristics(input.target_id, input.source_ids);
                if (!result)
                    return err(`Target heuristic not found or already archived: ${input.target_id}`);
                const supersedes = (result.supersedes ?? []).join(", ") || "(none)";
                return ok(`[OK] Merged ${input.source_ids.length} source(s) into [${result.id}]\n[${result.domain}] ${result.heuristic}\nConfidence: ${(result.confidence * 100).toFixed(0)}% | Reinforced x${result.reinforcement_count} | Supersedes: ${supersedes}`);
            }
            case "get_heuristic_history": {
                const input = GetHeuristicHistorySchema.parse(args ?? {});
                const history = await getHeuristicHistory(input.id, input.include_archived);
                if (!history)
                    return err(`No heuristic found with id: ${input.id}`);
                const lines = history.map((heuristic, index) => {
                    const archived = heuristic.superseded_by ? " archived" : " current";
                    const tags = heuristic.tags.length > 0 ? `\n   Tags: ${heuristic.tags.join(", ")}` : "";
                    return `${index + 1}. v${heuristic.version ?? index + 1}${archived} id:${heuristic.id}\n   Created: ${heuristic.created_at} | Confidence: ${(heuristic.confidence * 100).toFixed(0)}% | Contradicted x${heuristic.contradiction_count}\n   ${heuristic.heuristic}${tags}`;
                });
                return ok(`HEURISTIC HISTORY (${history.length} version(s))\n\n${lines.join("\n\n")}`);
            }
            case "search_reflections": {
                const input = SearchReflectionsSchema.parse(args);
                const results = await searchReflections(input.query, input.domain, input.outcome, input.limit, input.since_days, input.tags.length > 0 ? input.tags : undefined, input.failure_mode, input.tag_mode);
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
                const lines = reflections.map((reflection) => `[${reflection.timestamp.slice(0, 16)}] [${reflection.domain}] ${outcomeBadge(reflection.task_outcome)} ${reflection.task_goal} id:${reflection.id}\n   ${reflection.failure_mode} - ${truncate(reflection.task_state.summary, 100)}`);
                const paginationNote = input.offset > 0 ? ` (offset: ${input.offset})` : "";
                return ok(`${reflections.length} reflection(s)${paginationNote}:\n\n${lines.join(reflections.length > 10 ? "\n\n---\n\n" : "\n\n")}`);
            }
            case "diff_reflections": {
                const input = DiffReflectionsSchema.parse(args ?? {});
                const result = await diffReflections(input.id_a, input.id_b);
                if (!result)
                    return err(`One or both reflections were not found: ${input.id_a}, ${input.id_b}`);
                if (result.diff.same_reflection) {
                    return ok(`REFLECTION DIFF\nNo differences: id_a and id_b both refer to ${input.id_a}.`);
                }
                return ok(formatReflectionDiff(result.diff));
            }
            case "get_reflection_summary": {
                const summary = await getReflectionSummary();
                const outcomeList = Object.entries(summary.outcome_distribution)
                    .sort(([, a], [, b]) => b - a)
                    .map(([key, value]) => `  ${key}: ${value}`)
                    .join("\n");
                const failureList = Object.entries(summary.failure_distribution)
                    .sort(([, a], [, b]) => b - a)
                    .map(([key, value]) => `  ${key}: ${value}`)
                    .join("\n");
                const domainList = Object.entries(summary.domain_distribution)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 8)
                    .map(([key, value]) => `  ${key}: ${value}`)
                    .join("\n");
                const tagList = Object.entries(summary.tag_distribution)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 10)
                    .map(([key, value]) => `  ${key}: ${value}`)
                    .join("\n");
                const gapList = summary.top_gaps
                    .map((gap) => `  - "${gap.missing_capability}" x${gap.occurrence_count}${gap.occurrence_count >= 3 ? " [HIGH]" : ""}`)
                    .join("\n");
                const lessonList = summary.recent_lessons.map((lesson) => `  - ${lesson}`).join("\n");
                const reflectionLimitNote = summary.total_reflections >= REFLECTION_SOFT_LIMIT
                    ? ` [WARN: >= ${REFLECTION_SOFT_LIMIT} soft limit]`
                    : ` / ${REFLECTION_SOFT_LIMIT} (soft limit)`;
                return ok(`HERMES REFLECTION DASHBOARD
Sessions: ${summary.total_sessions}
Reflections: ${summary.total_reflections}${reflectionLimitNote}
Heuristics: ${summary.total_heuristics} active / ${HEURISTIC_MAX_COUNT} soft limit${summary.total_heuristics_archived > 0 ? ` (${summary.total_heuristics_archived} archived)` : ""}
Affordance gaps: ${summary.total_affordance_gaps} active${summary.total_affordance_gaps_resolved > 0 ? ` (${summary.total_affordance_gaps_resolved} resolved)` : ""}
Data stored at: ${STORE_DIR}

Outcome distribution:
${outcomeList || "  (none yet)"}

Failure distribution:
${failureList || "  (none yet)"}

Domain distribution:
${domainList || "  (none yet)"}

Tag distribution:
${tagList || "  (none yet)"}

Top affordance gaps:
${gapList || "  (none yet)"}

Recent lessons learned:
${lessonList || "  (none yet)"}${summary.metadata ? `\nStore metadata:\n  Created: ${summary.metadata.created_at.slice(0, 10)}\n  Write count: ${summary.metadata.write_count}` : ""}`);
            }
            case "get_affordance_gaps": {
                const input = GetAffordanceGapsSchema.parse(args);
                const gaps = await getAffordanceGaps(input.min_occurrences, input.include_resolved);
                if (gaps.length === 0) {
                    return ok(`No affordance gaps with min_occurrences=${input.min_occurrences}.`);
                }
                const lines = gaps.map((gap) => {
                    const badge = gap.occurrence_count >= 3 ? " [HIGH]" : gap.occurrence_count >= 2 ? " [WARN]" : "";
                    const resolved = gap.resolved
                        ? ` [resolved${gap.resolved_at ? ` ${gap.resolved_at.slice(0, 10)}` : ""}]`
                        : "";
                    const suggestion = gap.suggested_solution
                        ? `\n   Suggestion: ${gap.suggested_solution}`
                        : "";
                    const resolution = gap.resolution_notes
                        ? `\n   Resolution: ${gap.resolution_notes}`
                        : "";
                    return `x${gap.occurrence_count}${badge}${resolved} "${gap.missing_capability}"\n   ${gap.goal_description}${suggestion}${resolution}`;
                });
                return ok(`${gaps.length} gap(s):\n\n${lines.join("\n\n")}`);
            }
            case "get_recent_reflections": {
                const input = GetRecentReflectionsSchema.parse(args);
                const reflections = await getRecentReflections(input.limit);
                if (reflections.length === 0) {
                    return ok("No reflections yet.");
                }
                const lines = reflections.map((reflection) => `[${reflection.timestamp.slice(0, 16)}] [${reflection.domain}] ${outcomeBadge(reflection.task_outcome)} ${reflection.task_goal} id:${reflection.id}\n   ${reflection.failure_mode} - ${truncate(reflection.task_state.summary, 100)}`);
                return ok(`${reflections.length} recent reflection(s):\n\n${lines.join(reflections.length > 10 ? "\n\n---\n\n" : "\n\n")}`);
            }
            case "get_session_reflections": {
                const input = GetSessionReflectionsSchema.parse(args);
                const reflections = await getSessionReflections(input.session_id, input.limit);
                if (reflections.length === 0) {
                    return ok(`No reflections found for session_id="${input.session_id}".`);
                }
                const lines = reflections.map((reflection) => `[${reflection.timestamp.slice(0, 16)}] [${reflection.domain}] ${outcomeBadge(reflection.task_outcome)} ${reflection.task_goal} id:${reflection.id}\n   ${reflection.failure_mode} - ${truncate(reflection.task_state.summary, 100)}`);
                return ok(`${reflections.length} reflection(s) for session [${input.session_id}]:\n\n${lines.join("\n\n")}`);
            }
            case "get_session_summary": {
                const input = GetSessionSummarySchema.parse(args);
                const summary = await getSessionSummary(input.session_id);
                if (!summary)
                    return err(`No session found: ${input.session_id}`);
                const outcomeLines = Object.entries(summary.outcome_distribution)
                    .map(([k, v]) => `  ${k}: ${v}`)
                    .join("\n");
                const lessonLines = summary.top_lessons.length > 0
                    ? summary.top_lessons.map((l, i) => `  ${i + 1}. ${l}`).join("\n")
                    : "  (none)";
                const qLines = summary.open_questions.length > 0
                    ? summary.open_questions.map((q) => `  [${q.priority.toUpperCase()}] ${q.question}`).join("\n")
                    : "  (none)";
                return ok(`SESSION SUMMARY [${summary.session_id.slice(0, 16)}...]
Started: ${summary.started_at.slice(0, 16)}
Reflections: ${summary.reflection_count} | Heuristics extracted: ${summary.heuristics_extracted} | Gaps logged: ${summary.affordance_gaps_logged}
Domains: ${summary.domains.join(", ") || "(none)"}

Outcome distribution:
${outcomeLines || "  (none)"}

Top lessons (last 5):
${lessonLines}

Open questions (top 5 by priority):
${qLines}`);
            }
            case "get_reflection": {
                const input = GetReflectionSchema.parse(args);
                const reflection = await getReflectionById(input.id, input.apply_resolved_overlay);
                if (!reflection)
                    return err(`No reflection found with id: ${input.id}`);
                const sections = (reflection.task_state.summary_sections ?? [])
                    .map((s) => `\n  [${s.title}]\n  ${s.content}`)
                    .join("");
                const lessons = reflection.lessons_learned.length > 0
                    ? `\nLessons:\n${reflection.lessons_learned.map((l) => `  - ${l}`).join("\n")}`
                    : "";
                const tags = (reflection.tags ?? []).length > 0
                    ? `\nTags: ${reflection.tags.join(", ")}`
                    : "";
                const worldUpdates = reflection.world_model_updates.length > 0
                    ? `\nWorld model updates:\n${reflection.world_model_updates.map((u) => `  [${u.polarity}] ${u.fact} (source: ${u.source})`).join("\n")}`
                    : "";
                const toolInsights = reflection.tool_insights.length > 0
                    ? `\nTool insights:\n${reflection.tool_insights.map((i) => `  [${i.tool}] ${i.insight}`).join("\n")}`
                    : "";
                const openQuestions = reflection.open_questions.length > 0
                    ? `\nOpen questions:\n${reflection.open_questions.map((q) => {
                        const resolvedMark = q.resolved
                            ? ` resolved${q.resolved_at ? ` (${q.resolved_at.slice(0, 10)})` : ""}${q.resolved_by ? ` by ${q.resolved_by.slice(0, 8)}` : ""}`
                            : "";
                        return `  [${q.priority}]${resolvedMark} ${q.question}`;
                    }).join("\n")}`
                    : "";
                const contextForget = reflection.context_forget.length > 0
                    ? `\nContext forget:\n${reflection.context_forget.map((c) => `  - ${c.item} (${c.reason})`).join("\n")}`
                    : "";
                const blockers = reflection.task_state.immediate_blockers.length > 0
                    ? `\n  Blockers: ${reflection.task_state.immediate_blockers.join("; ")}`
                    : "";
                const safePaths = reflection.task_state.proven_safe_paths.length > 0
                    ? `\n  Safe paths: ${reflection.task_state.proven_safe_paths.length}`
                    : "";
                const deadEnds = reflection.task_state.exhausted_search.length > 0
                    ? `\n  Dead ends: ${reflection.task_state.exhausted_search.length}`
                    : "";
                const hypotheses = reflection.task_state.active_hypotheses.length > 0
                    ? `\n  Active hypotheses: ${reflection.task_state.active_hypotheses.length}`
                    : "";
                return ok(`Reflection [${reflection.id}]
Timestamp: ${reflection.timestamp}
Domain: ${reflection.domain}
Outcome: ${reflection.task_outcome.toUpperCase()} - ${reflection.failure_mode}
Session: ${reflection.session_id}
Task: ${reflection.task_goal}
Summary: ${reflection.task_state.summary}${sections}

Task state:${blockers}${safePaths}${deadEnds}${hypotheses}${tags}${lessons}${worldUpdates}${toolInsights}${openQuestions}${contextForget}`);
            }
            case "update_reflection": {
                const input = UpdateReflectionSchema.parse(args ?? {});
                const result = await updateReflection(input.id, {
                    domain: input.domain,
                    tags: input.tags ?? undefined,
                    lessons_learned: input.lessons_learned,
                    reExtractHeuristics: input.re_extract_heuristics,
                    confidence: input.confidence,
                });
                if (!result)
                    return err(`Reflection not found: ${input.id}`);
                return ok(`[OK] Reflection [${result.id}] updated.\nDomain: ${result.domain}\nTags: ${(result.tags ?? []).join(", ") || "(none)"}\nLessons: ${result.lessons_learned.length}`);
            }
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
                return ok(`${questions.length} open question(s):\n\n${lines.join("\n\n")}`);
            }
            case "resolve_open_question": {
                const input = ResolveOpenQuestionSchema.parse(args ?? {});
                const result = await resolveOpenQuestion(input.reflection_id, input.question_index, input.resolved_by_reflection_id);
                if (!result)
                    return err(`No reflection found: ${input.reflection_id}`);
                if (!result.found)
                    return err(`No open question at index ${input.question_index} for reflection ${input.reflection_id}`);
                return ok(`[OK] Open question resolved: ${result.question}`);
            }
            case "get_world_model": {
                const input = GetWorldModelSchema.parse(args ?? {});
                const facts = await getWorldModel(input.domain, input.polarity, input.limit, input.since_days);
                if (facts.length === 0) {
                    return ok("No world model facts found.");
                }
                const affirmed = facts.filter((f) => f.polarity === "affirm");
                const negated = facts.filter((f) => f.polarity === "negate");
                const formatFact = (f) => {
                    const date = f.timestamp.slice(0, 10);
                    const evidencePart = f.evidence ? ` evidence: ${f.evidence}` : "";
                    return `  - [${f.domain}] ${f.fact} (source: ${f.source}, ${date}, id: ${f.reflection_id})${evidencePart}`;
                };
                const sections = [];
                if (!input.polarity || input.polarity === "affirm") {
                    if (affirmed.length > 0) {
                        sections.push(`AFFIRMED (${affirmed.length}):\n${affirmed.map(formatFact).join("\n")}`);
                    }
                }
                if (!input.polarity || input.polarity === "negate") {
                    if (negated.length > 0) {
                        sections.push(`NEGATED (${negated.length}):\n${negated.map(formatFact).join("\n")}`);
                    }
                }
                return ok(`WORLD MODEL SNAPSHOT (${facts.length} facts)\n\n${sections.join("\n\n")}`);
            }
            case "get_reflection_timeline": {
                const input = GetReflectionTimelineSchema.parse(args ?? {});
                const buckets = await getReflectionTimeline(input.bucket, input.domain, input.since_days, input.limit);
                if (buckets.length === 0) {
                    return ok("No reflections in the selected time range.");
                }
                const bucketLabel = input.bucket === "day" ? "daily" : input.bucket === "month" ? "monthly" : "weekly";
                const header = `REFLECTION TIMELINE (${bucketLabel}, last ${input.since_days} days, domain: ${input.domain ?? "all"}, oldest first)`;
                const lines = buckets.map((bucket) => formatTimelineBucket(bucket));
                return ok(`${header}\n\n${lines.join("\n\n")}`);
            }
            case "get_store_health": {
                const report = await checkStoreHealth();
                return ok(formatStoreHealth(report));
            }
            case "export_project_experience_md": {
                const input = ExportProjectExperienceMdSchema.parse(args ?? {});
                if (input.output_path && input.output_dir) {
                    return err("export_project_experience_md accepts output_path or output_dir, but not both.");
                }
                if (input.output_dir && input.output_dir.split(/[\\/]+/).includes("..")) {
                    return err("export_project_experience_md output_dir must not contain path traversal segments.");
                }
                const result = await generateProjectExperienceMarkdown({
                    session_id: input.session_id,
                    domain: input.domain,
                    tags: input.tags,
                    tag_mode: input.tag_mode,
                    since_days: input.since_days,
                    limit: input.limit,
                    title: input.title,
                    include_raw_reflections: input.include_raw_reflections,
                });
                if (!result) {
                    return err("No reflections matched the export_project_experience_md filters.");
                }
                const outputContent = input.format === "plaintext"
                    ? stripMarkdown(result.markdown)
                    : input.format === "json"
                        ? JSON.stringify({
                            title: result.title,
                            scope: result.scope,
                            reflection_count: result.reflection_count,
                            markdown: result.markdown,
                        }, null, 2)
                        : result.markdown;
                if (!input.output_path && !input.output_dir) {
                    return ok(outputContent);
                }
                const outputPath = input.output_path
                    ? input.output_path
                    : join(input.output_dir, safeMarkdownFilename(input.title ?? result.title));
                try {
                    await mkdir(input.output_path ? dirname(outputPath) : input.output_dir, { recursive: true });
                    await writeFile(outputPath, outputContent, "utf-8");
                }
                catch (writeErr) {
                    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
                    return err(`Failed to write project experience Markdown to ${outputPath}: ${msg}`);
                }
                return ok(`[OK] Wrote project experience ${input.format} to ${outputPath}.
Title: ${result.title}
Reflections: ${result.reflection_count}
Scope: ${result.scope}`);
            }
            case "export_data": {
                const input = ExportDataSchema.parse(args ?? {});
                const store = await exportData();
                const selected = selectCollection(store, input.collection);
                const json = JSON.stringify(selected, null, 2);
                const byteLength = Buffer.byteLength(json, "utf8");
                if (input.output_path) {
                    try {
                        await writeFile(input.output_path, json, "utf-8");
                        return ok(`[OK] Export written to ${input.output_path} (${Math.ceil(byteLength / 1024)} KiB).`);
                    }
                    catch (writeErr) {
                        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
                        return err(`Failed to write export to ${input.output_path}: ${msg}`);
                    }
                }
                if (byteLength > EXPORT_INLINE_LIMIT_BYTES) {
                    return ok(`Store export is too large to return inline (${Math.ceil(byteLength / 1024)} KiB).

Counts:
  sessions: ${Object.keys(store.sessions).length}
  reflections: ${store.reflections.length}
  affordance_gaps: ${store.affordance_gaps.length}
  heuristics: ${store.heuristics.length}
  version: ${store.version}

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
                await clearData(input.collection);
                const warning = input.collection === "sessions"
                    ? "\nWarning: reflections still retain their session_id fields."
                    : "";
                const resolvedNote = input.collection === "reflections" || input.collection === "all"
                    ? "\nNote: resolved_questions index was also cleared."
                    : "";
                return ok(`[OK] Cleared "${input.collection}".\n${formatCounts(counts)}${warning}${resolvedNote}`);
            }
            case "import_data": {
                const input = ImportDataSchema.parse(args ?? {});
                let raw;
                try {
                    raw = await readFile(input.input_path, "utf-8");
                }
                catch {
                    return err(`Cannot read file: ${input.input_path}`);
                }
                let parsed;
                try {
                    parsed = JSON.parse(raw);
                }
                catch {
                    return err(`Invalid JSON in file: ${input.input_path}`);
                }
                const counts = await importData(parsed, input.mode);
                return ok(`[OK] Imported in "${input.mode}" mode from ${input.input_path}.\n${formatCounts(counts)}`);
            }
            case "snapshot": {
                const input = SnapshotSchema.parse(args ?? {});
                const result = await createSnapshot(input.output_dir, input.label);
                const files = result.files.length > 0
                    ? result.files.map((file) => `  - ${file}`).join("\n")
                    : "  (no store files existed)";
                return ok(`[OK] Snapshot created at: ${result.snapshot_dir}
Files:
${files}
Timestamp: ${result.timestamp}`);
            }
            case "get_domain_summary": {
                const input = GetDomainSummarySchema.parse(args ?? {});
                const result = await getDomainSummary(input.domain, input.top_n, input.include_open_questions_detail);
                if (Array.isArray(result)) {
                    if (result.length === 0) {
                        return ok("No domains found.");
                    }
                    const header = `Top ${result.length} domains by reflection count:`;
                    const rows = result.map((s, i) => {
                        const detail = input.include_open_questions_detail && s.open_questions_detail?.length
                            ? `\n${s.open_questions_detail.map((q) => `     - [${q.priority}] ${q.question} (${q.reflection_id})`).join("\n")}`
                            : "";
                        return `  ${i + 1}. ${s.domain} - ${s.reflection_count} reflection(s), ${s.active_heuristics} heuristic(s), ${s.open_questions} open question(s)${detail}`;
                    });
                    return ok(`${header}\n${rows.join("\n")}`);
                }
                // Single domain
                const s = result;
                if (s.reflection_count === 0) {
                    return ok(`DOMAIN SUMMARY: ${s.domain}

Reflections: 0
Active heuristics: ${s.active_heuristics}
Open questions: 0
Active affordance gaps: ${s.active_affordance_gaps}`);
                }
                const outcomeLines = Object.entries(s.outcome_distribution)
                    .map(([k, v]) => `  ${k}: ${v}`)
                    .join("\n");
                const sections = [
                    `DOMAIN SUMMARY: ${s.domain}`,
                    `Reflections: ${s.reflection_count}`,
                    `Active heuristics: ${s.active_heuristics}`,
                    `Open questions: ${s.open_questions}`,
                    `Active affordance gaps: ${s.active_affordance_gaps}`,
                    `Outcome distribution:\n${outcomeLines}`,
                ];
                if (s.top_failure_mode) {
                    sections.push(`Top failure mode: ${s.top_failure_mode}`);
                }
                if (s.recent_lesson) {
                    sections.push(`Recent lesson: ${s.recent_lesson}`);
                }
                if (input.include_open_questions_detail && s.open_questions_detail?.length) {
                    sections.push(`Open question details:\n${s.open_questions_detail.map((q) => `  [${q.priority}] ${q.question} (reflection:${q.reflection_id}${q.requires_environment_interaction ? ", env" : ""})`).join("\n")}`);
                }
                return ok(sections.join("\n"));
            }
            default:
                return err(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(`[${name}] ${message}`);
    }
});
function truncate(value, maxLength) {
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
function selectCollection(store, collection) {
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
function collectionCounts(store, collection) {
    const allCounts = {
        sessions: Object.keys(store.sessions).length,
        reflections: store.reflections.length,
        affordance_gaps: store.affordance_gaps.length,
        heuristics: store.heuristics.length,
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
function formatCounts(counts) {
    return Object.entries(counts)
        .map(([key, value]) => `  ${key}: ${value}`)
        .join("\n");
}
function formatReflectionDiff(diff) {
    const timeDeltaSeconds = Math.round(diff.time_delta_ms / 1000);
    const unchangedLessons = diff.lessons.unchanged.length > 0
        ? diff.lessons.unchanged.map((item) => item.a === item.b ? item.a : `${item.a} ~= ${item.b}`).join(" | ")
        : "(none)";
    const lessonLines = [
        `  Added: ${diff.lessons.added.length > 0 ? diff.lessons.added.join(" | ") : "(none)"}`,
        `  Removed: ${diff.lessons.removed.length > 0 ? diff.lessons.removed.join(" | ") : "(none)"}`,
        `  Unchanged: ${unchangedLessons}`,
    ].join("\n");
    const worldLines = diff.world_model_polarity_changes.length > 0
        ? diff.world_model_polarity_changes.map((item) => `  - ${item.fact_a} [${item.polarity_a}] -> ${item.fact_b} [${item.polarity_b}]`).join("\n")
        : "  (none)";
    const questionLines = diff.common_open_questions.length > 0
        ? diff.common_open_questions.map((item) => `  - ${item.question_a} ~= ${item.question_b}`).join("\n")
        : "  (none)";
    return `REFLECTION DIFF
id_a: ${diff.id_a}
id_b: ${diff.id_b}
Time delta: ${timeDeltaSeconds}s
Same fields: ${diff.same_fields.join(", ") || "(none)"}
Changed fields: ${diff.changed_fields.join(", ") || "(none)"}

Lessons:
${lessonLines}

World model polarity changes:
${worldLines}

Common open questions:
${questionLines}`;
}
function formatStoreHealth(report) {
    const issueLines = report.issues.length > 0
        ? report.issues.map((issue) => `  - ${issue}`).join("\n")
        : "  all healthy";
    const largest = report.largest_reflection
        ? `${report.largest_reflection.id} (${report.largest_reflection.bytes} bytes)`
        : "(none)";
    return `STORE HEALTH: ${report.healthy ? "all healthy" : "issues found"}

Issues:
${issueLines}

Integrity:
  orphan_reflections: ${report.orphan_reflections}
  orphan_affordance_gaps: ${report.orphan_affordance_gaps}
  broken_heuristic_links: ${report.broken_heuristic_links}
  suspicious_heuristics: ${report.suspicious_heuristics}

File stats:
  store.json bytes: ${report.file_stats.store_json_bytes}
  reflections.jsonl bytes: ${report.file_stats.reflections_jsonl_bytes}
  resolved_questions.json bytes: ${report.file_stats.resolved_questions_json_bytes}
  reflection_count: ${report.file_stats.reflection_count}
  average_reflection_bytes: ${report.file_stats.average_reflection_bytes}
  largest_reflection: ${largest}`;
}
function formatHeuristicStats(stats) {
    const domains = Object.entries(stats.domain_breakdown)
        .sort(([, a], [, b]) => b.count - a.count)
        .map(([domain, entry]) => `  ${domain}: ${entry.count} active | avg confidence ${(entry.avg_confidence * 100).toFixed(1)}% | avg retrieved x${entry.avg_retrieval_count}`)
        .join("\n");
    const topRetrieval = stats.top_by_retrieval.length > 0
        ? stats.top_by_retrieval.map((item, index) => `  ${index + 1}. [${item.domain}] x${item.retrieval_count} id:${item.id} ${item.heuristic}`).join("\n")
        : "  (none)";
    const topReinforcement = stats.top_by_reinforcement.length > 0
        ? stats.top_by_reinforcement.map((item, index) => `  ${index + 1}. [${item.domain}] x${item.reinforcement_count} id:${item.id} ${item.heuristic}`).join("\n")
        : "  (none)";
    return `HEURISTIC STATS
Active: ${stats.total_active}
Archived: ${stats.total_archived}
Suspicious active: ${stats.suspicious_count}

Confidence distribution:
  high: ${stats.confidence_distribution.high}
  medium: ${stats.confidence_distribution.medium}
  low: ${stats.confidence_distribution.low}

Usage health:
  never_retrieved_older_than_7d: ${stats.never_retrieved}
  stale_retention_below_0.3: ${stats.stale_count}

Domain breakdown:
${domains || "  (none)"}

Top by retrieval:
${topRetrieval}

Top by reinforcement:
${topReinforcement}`;
}
function formatTimelineBucket(bucket) {
    const success = bucket.outcome_distribution.success ?? 0;
    const partial = bucket.outcome_distribution.partial ?? 0;
    const failure = bucket.outcome_distribution.failure ?? 0;
    const topFailure = bucket.top_failure_mode
        ? `\n  Top failure: ${bucket.top_failure_mode}`
        : "";
    return `${bucket.start} to ${bucket.end}:
  Reflections: ${bucket.reflection_count} | Success: ${success} | Partial: ${partial} | Failure: ${failure}${topFailure}
  Lessons extracted: ${bucket.lessons_count}
  Open questions (unresolved): ${bucket.open_questions_count}
  Domains: ${bucket.domains.join(", ") || "(none)"}`;
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
