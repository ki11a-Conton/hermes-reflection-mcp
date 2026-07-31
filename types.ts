// ============================================================
// Hermes Reflection MCP - Type Definitions
// Inspired by NousResearch/hermes-agent & Cognitive Workbench
// ============================================================

export type FailureMode =
  | "incorrect_task_interpretation"
  | "incorrect_world_assumption"
  | "missing_affordance"
  | "tool_limitation_or_misbehavior"
  | "exhausted_or_misdirected_search"
  | "success";

export type Priority = "high" | "medium" | "low";
export type Polarity = "affirm" | "negate";
export type InsightStatus = "confirmed" | "needs_verification";
export type MemoryScope = "global" | `project:${string}`;

export interface HeuristicEvidence {
  id: string;
  source_reflection_id?: string;
  source_task: string;
  content_hash: string;
  created_at: string;
}

export type HeuristicFeedbackValue = "helpful" | "harmful" | "irrelevant";

export interface HeuristicFeedbackInput {
  heuristic_id: string;
  value: HeuristicFeedbackValue;
}

export interface HeuristicFeedback {
  heuristic_id: string;
  reflection_id: string;
  value: HeuristicFeedbackValue;
  created_at: string;
}

export interface WorldModelUpdate {
  fact: string;
  polarity: Polarity;
  source: string;
  evidence: string;
}

export interface ToolInsight {
  tool: string;
  insight: string;
  status: InsightStatus;
  evidence: string;
}

export interface ContextForget {
  item: string;
  reason: string;
}

export interface OpenQuestion {
  question: string;
  priority: Priority;
  requires_environment_interaction: boolean;
  resolved?: boolean;
  resolved_at?: string;
  resolved_by?: string;
}

export interface TaskState {
  summary: string;
  summary_sections?: Array<{ title: string; content: string }>;
  immediate_blockers: string[];
  active_hypotheses: string[];
  proven_safe_paths: string[];
  exhausted_search: string[];
}

/** Core structured output after every task. */
export interface ReflectionFrame {
  id: string;
  timestamp: string;
  session_id: string;
  scope: MemoryScope;
  task_goal: string;
  task_outcome: "success" | "partial" | "failure";
  failure_mode: FailureMode;
  task_state: TaskState;
  world_model_updates: WorldModelUpdate[];
  tool_insights: ToolInsight[];
  context_forget: ContextForget[];
  open_questions: OpenQuestion[];
  lessons_learned: string[];
  affordance_gaps: AffordanceGap[];
  domain: string;
  tags: string[];
  /** Optional free-form agent context. Stored but not used for heuristic extraction or search scoring. */
  context_notes?: string;
}

/** Capability gap logged when an agent fails due to a missing tool or skill. */
export interface AffordanceGap {
  id: string;
  timestamp: string;
  session_id: string;
  goal_description: string;
  failure_description: string;
  missing_capability: string;
  available_tools: string[];
  occurrence_count: number;
  suggested_solution?: string;
  resolved?: boolean;
  resolved_at?: string;
  resolution_notes?: string;
}

/** Extracted lesson that transfers across tasks. */
export interface Heuristic {
  id: string;
  created_at: string;
  updated_at: string;
  domain: string;
  heuristic: string;
  source_task: string;
  session_id?: string;
  scope: MemoryScope;
  evidence: HeuristicEvidence[];
  feedback: HeuristicFeedback[];
  reinforcement_count: number;
  contradiction_count: number;
  contradiction_notes: string[];
  confidence: number; // 0.0-1.0
  retrieval_count: number;
  last_retrieved_at?: string;
  supersedes?: string[];
  superseded_by?: string;
  pinned?: boolean;
  version: number;
  tags: string[];
}

export interface Session {
  id: string;
  started_at: string;
  reflection_count: number;
  affordance_gap_count: number;
}

export interface PendingMutation {
  id: string;
  created_at: string;
  operation: string;
  preview: string;
  payload?: Record<string, unknown>;
  payload_hash?: string;
  state?: "pending" | "processing";
  claim_token?: string;
  claimed_at?: string;
}

export type ReviewCandidateState = "pending" | "applied" | "rejected";

export interface ReviewCandidate {
  id: string;
  created_at: string;
  scope: MemoryScope;
  stage: "deterministic" | "llm";
  source_fingerprint: string;
  source_reflection_ids: string[];
  heuristic: string;
  domain: string;
  tags: string[];
  confidence: number;
  risk_reasons: string[];
  state: ReviewCandidateState;
  mutation_id?: string;
}

export interface MemoryEntry {
  id: string;
  content: string;
  created_at: string;
  updated_at: string;
  source_reflection_id?: string;
}

export interface MemoryBoard {
  entries: MemoryEntry[];
  char_limit: number;
  used_chars: number;
}

export interface SessionSearchResult {
  session_id: string;
  turn_index: number;
  role: "user" | "assistant";
  timestamp: string;
  snippet: string;
  rank: number;
}

export interface SessionTurn {
  session_id: string;
  turn_index: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  content_truncated?: boolean;
  original_content_chars?: number;
}

export interface SessionMeta {
  session_id: string;
  started_at: string;
  turn_count: number;
  last_turn_at?: string;
}

export interface ReflectionStore {
  sessions: Record<string, Session>;
  reflections: ReflectionFrame[];
  affordance_gaps: AffordanceGap[];
  heuristics: Heuristic[];
  version: string;
  memory_board?: MemoryBoard;
  user_profile?: MemoryBoard;
  metadata?: {
    store_schema_version: 2;
    created_at: string;
    last_written_at: string;
    write_count: number;
    write_approval?: boolean;
    pending_mutations?: PendingMutation[];
    review_candidates?: ReviewCandidate[];
    external_provider?: { name: string; endpoint?: string; db_path?: string; auto_sync?: boolean };
  };
}
