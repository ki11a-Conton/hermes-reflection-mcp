import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ResponseModeSchema } from "./response_mode.js";
import { CompactionMetadataSchema } from "./compaction_handoff.js";
export const CORE_TOOL_NAMES = [
    "retrieve_heuristics",
    "reflect_on_task",
    "search_reflections",
    "get_open_questions",
    "get_memory_item",
    "compact_session_context",
    "memory_board_read",
    "memory_board_write",
    "session_lifecycle_hook",
    "trigger_background_review",
];
const coreToolNames = new Set(CORE_TOOL_NAMES);
const adminToolNames = new Set([
    "delete_heuristic",
    "import_data",
    "approve_pending_mutation",
    "clear_data",
]);
const READ_ONLY = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
const MUTATING = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};
const DESTRUCTIVE = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
function nullableArray(schema) {
    return z.array(schema).nullable().default([]).transform((value) => value ?? []);
}
const domainSchema = z.string()
    .max(100)
    .default("general")
    .transform((value) => value.toLowerCase().trim() || "general");
const optionalDomainSchema = z.string()
    .max(100)
    .optional()
    .transform((value) => value?.toLowerCase().trim());
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
export const ReflectOnTaskSchema = z.object({
    session_id: z.string().trim().min(1).max(200),
    task_goal: z.string().trim().min(1).max(1000),
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
    lessons_learned: nullableArray(z.string().max(1000))
        .refine((value) => value.length <= 50, "lessons_learned accepts at most 50 items."),
    context_notes: z.string().max(2000).optional(),
    missing_capability: z.string().trim().min(1).max(500).optional(),
    available_tools: nullableArray(z.string().max(200)),
    heuristic_feedback: z.array(z.object({
        heuristic_id: z.string().min(1).max(200),
        value: z.enum(["helpful", "harmful", "irrelevant"]),
    })).max(50).default([]),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    auto_extract_heuristics: z.boolean().default(true),
    domain: domainSchema,
    tags: nullableArray(z.string().max(100)),
    dry_run: z.boolean().default(false),
    response_mode: ResponseModeSchema,
    idempotency_key: z.string().min(1).refine((value) => Array.from(value).length <= 128, "idempotency_key accepts at most 128 Unicode scalars.").optional(),
});
export const RetrieveHeuristicsSchema = z.object({
    task_description: z.string().max(1000),
    session_id: z.string().min(1).max(200).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    domain: optionalDomainSchema,
    limit: z.number().int().min(1).max(50).default(3),
    tags: nullableArray(z.string().max(100)),
    tag_mode: z.enum(["and", "or"]).default("and"),
    show_scores: z.boolean().default(false),
    min_confidence: z.number().min(0).max(1).default(0.3),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const ListHeuristicsSchema = z.object({
    session_id: z.string().min(1).max(200).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    domain: optionalDomainSchema,
    tags: nullableArray(z.string().max(100)),
    tag_mode: z.enum(["and", "or"]).default("and"),
    min_confidence: z.number().min(0).max(1).default(0),
    limit: z.number().int().min(1).max(100).default(20),
    sort: z.enum(["confidence", "updated_at", "created_at", "reinforcement"]).default("confidence"),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const SearchHeuristicsSchema = z.object({
    query: z.string().max(1000),
    session_id: z.string().min(1).max(200).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    domain: optionalDomainSchema,
    tags: nullableArray(z.string().max(100)),
    tag_mode: z.enum(["and", "or"]).default("and"),
    min_confidence: z.number().min(0).max(1).default(0),
    limit: z.number().int().min(1).max(100).default(20),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const AddHeuristicSchema = z.object({
    domain: domainSchema,
    heuristic: z.string().trim().min(1).max(1000),
    source_task: z.string().trim().min(1).max(500),
    tags: nullableArray(z.string().max(100)),
    confidence: z.number().min(0).max(1).default(0.7),
});
export const DeleteHeuristicSchema = z.object({ id: z.string().max(100) });
const failureModeSchema = z.enum([
    "incorrect_task_interpretation",
    "incorrect_world_assumption",
    "missing_affordance",
    "tool_limitation_or_misbehavior",
    "exhausted_or_misdirected_search",
    "success",
]);
export const SearchReflectionsSchema = z.object({
    query: z.string().max(1000),
    session_id: z.string().min(1).max(200).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    domain: optionalDomainSchema,
    outcome: z.enum(["success", "partial", "failure"]).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    since_days: z.number().int().min(1).max(3650).optional(),
    tags: nullableArray(z.string().max(100)),
    tag_mode: z.enum(["and", "or"]).default("and"),
    failure_mode: failureModeSchema.optional(),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const ListReflectionsSchema = z.object({
    domain: optionalDomainSchema,
    outcome: z.enum(["success", "partial", "failure"]).optional(),
    failure_mode: failureModeSchema.optional(),
    tags: nullableArray(z.string().max(100)),
    tag_mode: z.enum(["and", "or"]).default("and"),
    session_id: z.string().max(200).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    since_days: z.number().int().min(1).max(3650).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const GetRecentReflectionsSchema = z.object({
    session_id: z.string().min(1).max(200).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const GetOpenQuestionsSchema = z.object({
    session_id: z.string().min(1).max(200).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    domain: optionalDomainSchema,
    priority: z.enum(["high", "medium", "low"]).optional(),
    limit: z.number().int().min(1).max(100).default(30),
    since_days: z.number().int().min(1).max(3650).optional(),
    include_resolved: z.boolean().default(false),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const ResolveOpenQuestionSchema = z.object({
    reflection_id: z.string().max(100),
    question_index: z.number().int().min(0).max(1000),
    resolved_by_reflection_id: z.string().max(100).optional(),
    session_id: z.string().min(1).max(200).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
});
export const GetMemoryItemSchema = z.object({
    kind: z.enum(["heuristic", "reflection", "session_turn", "review_candidate"]),
    id: z.string().min(1).max(300),
    session_id: z.string().min(1).max(200).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    section: z.string().min(1).max(80).optional(),
    cursor: z.string().max(4096).optional(),
    response_mode: ResponseModeSchema,
});
export const ExportDataSchema = z.object({
    collection: z.enum(["reflections", "heuristics", "affordance_gaps", "sessions", "all"]).default("all"),
    format: z.enum(["json"]).default("json"),
    output_path: z.string().min(1).max(500).optional(),
    overwrite: z.boolean().default(false),
    redaction_mode: z.enum(["safe", "raw"]).default("safe"),
    confirm_sensitive: z.boolean().default(false),
});
export const ClearDataSchema = z.object({
    collection: z.enum(["reflections", "heuristics", "affordance_gaps", "sessions", "all"]),
    confirm: z.boolean().default(false),
});
export const ImportDataSchema = z.object({
    input_path: z.string().min(1).max(500),
    mode: z.enum(["merge", "replace"]).default("merge"),
});
const MemoryBoardOperationSchema = z.object({
    action: z.enum(["add", "replace", "remove"]),
    content: z.string().min(1).max(2200).optional(),
    old_text: z.string().min(1).max(1000).optional(),
});
export const MemoryBoardWriteSchema = MemoryBoardOperationSchema.extend({
    action: z.enum(["add", "replace", "remove"]).optional(),
    operations: z.array(MemoryBoardOperationSchema).min(1).max(20).optional(),
}).superRefine((value, ctx) => {
    const operations = value.operations?.length ? value.operations : [value];
    if (!value.operations?.length && !value.action) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "memory_board_write requires either action or operations.", path: ["action"] });
        return;
    }
    operations.forEach((operation, index) => {
        const prefix = value.operations?.length ? ["operations", index] : [];
        if ((operation.action === "add" || operation.action === "replace") && !operation.content?.trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `content is required for action '${operation.action}'`, path: [...prefix, "content"] });
        }
        if ((operation.action === "replace" || operation.action === "remove") && !operation.old_text?.trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `old_text is required for action '${operation.action}'`, path: [...prefix, "old_text"] });
        }
    });
});
const UserProfileOperationSchema = z.object({
    action: z.enum(["add", "replace", "remove"]),
    content: z.string().min(1).max(1800).optional(),
    old_text: z.string().min(1).max(1000).optional(),
});
export const UserProfileWriteSchema = UserProfileOperationSchema.extend({
    action: z.enum(["add", "replace", "remove"]).optional(),
    operations: z.array(UserProfileOperationSchema).min(1).max(20).optional(),
}).superRefine((value, ctx) => {
    const operations = value.operations?.length ? value.operations : [value];
    if (!value.operations?.length && !value.action) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "user_profile_write requires either action or operations.", path: ["action"] });
        return;
    }
    operations.forEach((operation, index) => {
        const prefix = value.operations?.length ? ["operations", index] : [];
        if ((operation.action === "add" || operation.action === "replace") && !operation.content?.trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `content is required for action '${operation.action}'`, path: [...prefix, "content"] });
        }
        if ((operation.action === "replace" || operation.action === "remove") && !operation.old_text?.trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `old_text is required for action '${operation.action}'`, path: [...prefix, "old_text"] });
        }
    });
});
export const MemoryReadSchema = z.object({
    mode: z.enum(["live", "snapshot"]).default("live"),
    session_id: z.string().min(1).max(200).optional(),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
}).superRefine((value, ctx) => {
    if (value.mode === "snapshot" && !value.session_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["session_id"], message: "session_id is required for snapshot mode" });
    }
});
export const AppendSessionTurnSchema = z.object({
    session_id: z.string().min(1).max(200),
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(100000),
    timestamp: z.string().max(30).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
});
export const SearchSessionsSchema = z.object({
    query: z.string().max(1000).optional().default(""),
    limit: z.number().int().min(1).max(100).default(10),
    since_days: z.number().int().min(1).max(3650).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const ListPendingMutationsSchema = z.object({
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const ApprovePendingMutationSchema = z.object({
    mutation_id: z.string().max(100),
    decision: z.enum(["approve", "reject"]),
});
export const CaptureMemorySnapshotSchema = z.object({
    session_id: z.string().min(1).max(200),
});
const SessionStartMetadataSchema = z.object({
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    model: z.string().min(1).max(100).regex(/^[^\r\n\0]+$/).optional(),
    platform: z.string().min(1).max(100).regex(/^[^\r\n\0]+$/).optional(),
    user_id: z.string().min(1).max(100).regex(/^[^\r\n\0]+$/).optional(),
}).strict();
export const SessionLifecycleHookSchema = z.object({
    event: z.enum(["start", "end", "stop", "pause", "resume", "precompact", "postcompact"]),
    session_id: z.string().min(1).max(200),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    metadata: z.union([SessionStartMetadataSchema, CompactionMetadataSchema]).optional(),
}).strict().superRefine((value, context) => {
    const metadataProjectKey = value.metadata && "project_key" in value.metadata ? value.metadata.project_key : undefined;
    if (value.project_key && metadataProjectKey && value.project_key !== metadataProjectKey) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["metadata", "project_key"], message: "project_key values must agree" });
    }
    if (value.event === "postcompact") {
        if (!value.metadata || !("generation" in value.metadata)) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["metadata"], message: "postcompact requires bounded compaction metadata" });
        }
    }
    else if (value.metadata && value.event !== "start") {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["metadata"], message: "metadata is supported only for start or postcompact" });
    }
    else if (value.event === "start" && "generation" in (value.metadata ?? {})) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["metadata"], message: "compaction metadata is not valid for start" });
    }
});
export const ScanMemoryThreatsSchema = z.object({
    target: z.enum(["memory", "user"]),
    scope: z.enum(["all", "context", "strict"]).default("strict"),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const ScrollSessionContextSchema = z.object({
    session_id: z.string().min(1).max(200),
    around_turn_index: z.number().int().min(0),
    window: z.number().int().min(1).max(50).default(5),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
export const TriggerBackgroundReviewSchema = z.object({
    action: z.enum(["run", "status"]).default("run"),
    session_id: z.string().min(1).max(200).optional(),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    review_scope: z.enum(["recent", "full"]).default("recent"),
    review_mode: z.enum(["deterministic", "llm", "auto"]).default("deterministic"),
    auto_apply: z.boolean().default(false),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
}).superRefine((value, ctx) => {
    if (value.action === "run" && !value.session_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["session_id"], message: "session_id is required when action is run" });
    }
});
export const CompactSessionContextSchema = z.object({
    session_id: z.string().min(1).max(200),
    max_turns: z.number().int().min(1).max(200).default(40),
    max_chars: z.number().int().min(500).max(20000).default(6000),
    preserve_recent_user_turns: z.number().int().min(1).max(5).default(3),
    project_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    response_mode: ResponseModeSchema,
    cursor: z.string().max(4096).optional(),
});
const tools = new Map();
export function defineTool(tool) {
    if (tools.has(tool.name))
        throw new Error(`Duplicate tool: ${tool.name}`);
    tools.set(tool.name, tool);
    return tool;
}
function profilesFor(name) {
    const profiles = ["extended"];
    if (coreToolNames.has(name))
        profiles.unshift("core");
    if (adminToolNames.has(name))
        profiles.push("admin");
    return profiles;
}
function register(name, description, input, annotations) {
    defineTool({ name, description, input, annotations, profiles: profilesFor(name) });
}
register("reflect_on_task", "Store a scoped post-task reflection; optionally extract safe heuristics. Compact by default.", ReflectOnTaskSchema, MUTATING);
register("search_reflections", "Search scoped reflections. Compact by default; use full for detail.", SearchReflectionsSchema, READ_ONLY);
register("list_reflections", "List stored reflections with deterministic filters and pagination. Compact by default; use response_mode:'full' for detail.", ListReflectionsSchema, READ_ONLY);
register("retrieve_heuristics", "Use when prior lessons may materially change substantial work. Compact by default; get_memory_item drills into an ID. Skip trivial edits, repeated same-task lookup, sufficient prompts, or tasks where current files/URLs/live sources can be inspected first.", RetrieveHeuristicsSchema, READ_ONLY);
register("list_heuristics", "List stored heuristics with deterministic filters. Compact by default; use response_mode:'full' for detail.", ListHeuristicsSchema, READ_ONLY);
register("search_heuristics", "Search stored heuristics by relevance. Compact by default; use response_mode:'full' for detail.", SearchHeuristicsSchema, READ_ONLY);
register("add_heuristic", "Add or reinforce one validated heuristic.", AddHeuristicSchema, MUTATING);
register("delete_heuristic", "Permanently delete one heuristic by ID.", DeleteHeuristicSchema, DESTRUCTIVE);
register("memory_board_write", "Apply validated Memory Board operations.", MemoryBoardWriteSchema, { ...DESTRUCTIVE, idempotentHint: false });
register("memory_board_read", "Read the live or session-snapshot Memory Board. Compact by default.", MemoryReadSchema, READ_ONLY);
register("user_profile_write", "Apply one or more validated User Profile add, replace, or remove operations.", UserProfileWriteSchema, { ...DESTRUCTIVE, idempotentHint: false });
register("user_profile_read", "Read the live or session-snapshot User Profile. Compact by default; use response_mode:'full' for metadata.", MemoryReadSchema, READ_ONLY);
register("get_open_questions", "List scoped unresolved questions with source IDs. Compact by default.", GetOpenQuestionsSchema, READ_ONLY);
register("get_memory_item", "Fetch one scoped bounded memory item or section by ID. Compact by default.", GetMemoryItemSchema, READ_ONLY);
register("resolve_open_question", "Mark one indexed reflection question as resolved.", ResolveOpenQuestionSchema, MUTATING);
register("search_sessions", "Search or browse indexed session turns. Compact by default; use response_mode:'full' for detail.", SearchSessionsSchema, READ_ONLY);
register("append_session_turn", "Append one user or assistant turn to the local session index.", AppendSessionTurnSchema, MUTATING);
register("get_recent_reflections", "Return recent task reflections in reverse chronological order. Compact by default; use response_mode:'full' for detail.", GetRecentReflectionsSchema, READ_ONLY);
register("export_data", "Export selected reflection data inline or to an approved file path.", ExportDataSchema, MUTATING);
register("import_data", "Import reflection data by merge or destructive replace.", ImportDataSchema, DESTRUCTIVE);
register("clear_data", "Permanently clear a confirmed data collection.", ClearDataSchema, DESTRUCTIVE);
register("capture_memory_snapshot", "Capture a frozen Memory Board and User Profile snapshot for one client session.", CaptureMemorySnapshotSchema, MUTATING);
register("session_lifecycle_hook", "Enqueue a validated lifecycle event and related local work.", SessionLifecycleHookSchema, MUTATING);
register("scan_memory_threats", "Scan Memory Board or User Profile entries for suspicious persistence patterns. Compact by default; use response_mode:'full' for detail.", ScanMemoryThreatsSchema, READ_ONLY);
register("scroll_session_context", "Read indexed turns around one anchor. Compact by default; use response_mode:'full' for larger excerpts.", ScrollSessionContextSchema, READ_ONLY);
register("trigger_background_review", "Run or inspect bounded session review. Compact by default; use full for detail.", TriggerBackgroundReviewSchema, MUTATING);
register("list_pending_mutations", "List memory mutations waiting for manual approval. Compact by default; use response_mode:'full' for detail.", ListPendingMutationsSchema, READ_ONLY);
register("approve_pending_mutation", "Approve and replay, or reject, one queued mutation; replay may be destructive.", ApprovePendingMutationSchema, DESTRUCTIVE);
register("compact_session_context", "Build a bounded session handoff. Compact by default; use full for diagnostics.", CompactSessionContextSchema, READ_ONLY);
if (tools.size !== 29)
    throw new Error(`Tool registry must contain 29 tools, got ${tools.size}.`);
export function parseToolInput(name, value) {
    const tool = tools.get(name);
    if (!tool)
        throw new Error(`Unknown tool: ${name}`);
    return tool.input.parse(value ?? {});
}
export function listRegisteredTools() {
    return [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.input, { target: "jsonSchema7", $refStrategy: "none" }),
        ...(tool.output
            ? { outputSchema: zodToJsonSchema(tool.output, { target: "jsonSchema7", $refStrategy: "none" }) }
            : {}),
        annotations: tool.annotations,
    }));
}
export function profileToolNames(profile) {
    if (profile === "core")
        return [...CORE_TOOL_NAMES];
    return [...tools.values()]
        .filter((tool) => tool.profiles.includes(profile))
        .map((tool) => tool.name);
}
