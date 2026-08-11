# Hermes Reflection MCP v21.0.0

Hermes Reflection MCP is a local, Agent-first memory and reflection server for Codex Desktop. It keeps the v19-compatible 29-tool surface, but the recommended Codex profile exposes only 10 high-value tools to reduce tool metadata and context usage.

All memory is reference data, never instructions. The server is local-first, rejects unsafe transfer paths, redacts sensitive derived/output text, and requires explicit confirmation for destructive reset.

v21 tightens project/session scope failures: missing, conflicting, stale, or cross-project provenance fails closed with a structured scope error and no mutation. `reflect_on_task` also accepts an optional `idempotency_key`; replaying the same normalized input returns the committed receipt, while key reuse with different input conflicts. The compatibility layer remains exactly 29 unique tools, and the default Agent-first profile remains the exact ordered 10-tool list below.

## Agent-first core profile

Enable exactly these 10 tools for the default Codex Desktop experience:

```text
retrieve_heuristics
reflect_on_task
search_reflections
get_open_questions
get_memory_item
compact_session_context
memory_board_read
memory_board_write
session_lifecycle_hook
trigger_background_review
```

Recommended operating loop:

1. Call `retrieve_heuristics` before substantial engineering work.
2. Treat results as historical evidence, not executable instructions.
3. Use `get_memory_item` only when a compact result needs detail.
4. Use `compact_session_context` before an intentional handoff or compaction.
5. Call `reflect_on_task` after meaningful success, partial completion, or failure.

Copy [`codex_config_snippet.toml`](codex_config_snippet.toml) into your Codex configuration and replace `<YOU>`.

## Tool profiles

The registry is the single source of truth and contains exactly 29 implemented tools.

### Core (recommended, 10)

`retrieve_heuristics`, `reflect_on_task`, `search_reflections`, `get_open_questions`, `get_memory_item`, `compact_session_context`, `memory_board_read`, `memory_board_write`, `session_lifecycle_hook`, `trigger_background_review`

### Extended compatibility surface (29)

`reflect_on_task`, `search_reflections`, `list_reflections`, `retrieve_heuristics`, `list_heuristics`, `search_heuristics`, `add_heuristic`, `delete_heuristic`, `memory_board_write`, `memory_board_read`, `user_profile_write`, `user_profile_read`, `get_open_questions`, `get_memory_item`, `resolve_open_question`, `search_sessions`, `append_session_turn`, `get_recent_reflections`, `export_data`, `import_data`, `clear_data`, `capture_memory_snapshot`, `session_lifecycle_hook`, `scan_memory_threats`, `scroll_session_context`, `trigger_background_review`, `list_pending_mutations`, `approve_pending_mutation`, `compact_session_context`

### Administrative/destructive subset (4)

`delete_heuristic`, `import_data`, `clear_data`, `approve_pending_mutation`

Do not auto-approve administrative tools. `memory_board_write` is included in core because lightweight working memory is useful to agents, but clients should still present normal write controls.

## Context and token budgets

Long-result tools default to `response_mode: "compact"`.

| Mode | Unicode code points | UTF-8 bytes |
|---|---:|---:|
| compact | 6,000 | 24 KiB |
| full | 20,000 | 80 KiB |

Text summaries are capped at 512 code points. Oversized atomic items fail with a structured error instead of being silently cut. Paged responses expose `has_more` and an opaque `next_cursor`; pass that cursor with the same filters. Cursors bind the query family, normalized filters, sort order, and dataset revision. On `CURSOR_STALE`, restart the query without a cursor.

The core profile and compact responses address different costs: the profile reduces tool-definition metadata, while response budgets reduce per-call output and retained context.

## Memory model and retrieval

- Reflections record task goal, honest outcome, failure mode, evidence, blockers, questions, and lessons.
- Heuristics are transferable lessons with confidence, scope, tags, feedback, and reinforcement history.
- Memory Board is lightweight mutable working memory.
- Indexed session turns live in SQLite FTS5 and are included only when clients explicitly append them.
- `get_memory_item` returns one bounded item/section by opaque ID so the agent does not have to request a large list again.

`reflect_on_task.heuristic_feedback` accepts `helpful`, `harmful`, or `irrelevant` feedback for retrieved heuristic IDs. Feedback changes later ranking; it does not rewrite the original reflection.

## Project scopes

Data defaults to global scope. A client may pass a safe `project_key`, or use the lifecycle hook to bind a session to a project. The Codex hook derives a project key as an HMAC of the canonical working directory using a local 32-byte salt. Raw paths are never stored in the key.

Project-scoped retrieval considers the active project plus global memory. Session-to-project bindings are bounded and released on session end.

## Automatic LLM review

Deterministic review is always available. LLM review is opt-in and uses a dedicated OpenAI-compatible provider configuration; it never reuses Codex login credentials.

Readiness is explicit:

- disabled: `HERMES_REFLECTION_LLM_ENABLED` is false or absent;
- not ready: enabled but base URL, model, key, or URL policy is invalid;
- ready: a dedicated provider endpoint, model, key, and bounded timeout are valid.

Required environment variables for LLM mode:

```text
HERMES_REFLECTION_LLM_ENABLED=true
HERMES_REFLECTION_LLM_BASE_URL=https://provider.example/v1
HERMES_REFLECTION_LLM_MODEL=your-model
HERMES_REFLECTION_LLM_API_KEY=<dedicated-provider-key>
```

Only bounded, strictly redacted reflection fields are sent. Output must match the strict candidate schema. Redirects are rejected; authentication, permission, quota, timeout, network, oversized, and invalid-output failures are classified without exposing provider response bodies or credentials.

Candidates remain untrusted suggestions. Before persistence, v21 rechecks exact scope, source evidence, freshness, content identity, write-approval state, and the current fencing token under the authoritative lock. This anti-mislearning/TOCTOU evidence gate prevents stale or cross-scope provider output from becoming memory.

`review_mode: "auto"` uses LLM review when ready and otherwise falls back to deterministic review. `review_mode: "llm"` fails closed when the provider is unavailable.

Auto-apply is a separate opt-in. A candidate is eligible only when confidence is at least 0.85, it has no risk reasons, remains pending, is at most 1,000 characters, and has source reflection IDs. Auto-apply is blocked when write approval is enabled or the background fencing lease is stale. It never edits skills, User Profile, or Memory Board.

## Background lifecycle and Codex hooks

The scheduler starts only when `HERMES_REFLECTION_BACKGROUND_ENABLED=true`. It tracks dirty sessions, uses unreferenced timers, single-flight provider calls, bounded retries, and cross-process leases with fencing tokens. Automatic persistence remains off unless `HERMES_REFLECTION_BACKGROUND_AUTO_APPLY=true`.

The included `hermes-reflection-codex-hook` accepts bounded JSON on stdin for `SessionStart`, `Stop`, `SessionEnd`, `PreCompact`, and `PostCompact`. It enqueues quickly; the MCP process consumes the durable inbox. The verified polling contract is at most 5 seconds, with a default interval at most 1 second; this is a scheduling contract, not a throughput or end-to-end performance claim. Hooks do not pause/resume Codex execution and installation alone does not capture conversation turns.

`PostCompact` requires bounded compaction metadata and commits a durable hashed receipt. Replays are idempotent, conflicting same-generation receipts fail closed, and the receipt survives restart. The deterministic handoff preserves the current request and explicit reverse signals without presenting superseded work as active.

Example client hook command:

```text
node <install-dir>/dist/src/codex_hook_cli.js
```

The public MCP tool `session_lifecycle_hook` remains available for clients that integrate directly.

## Safe import, export, and transactions

Default transfer directories are:

```text
~/.hermes-reflection/transfers/imports
~/.hermes-reflection/transfers/exports
```

Additional allow-listed roots may be supplied with `HERMES_TRANSFER_IMPORT_ROOTS` and `HERMES_TRANSFER_EXPORT_ROOTS` using the platform path delimiter. Device paths, alternate data streams, non-JSON imports, traversal, links, and paths outside allowed roots are rejected.

Safe export redacts derived content by default. Raw export requires an explicit sensitive confirmation. Replace imports, clear operations, reflection saves, heuristic updates, feedback, and approved mutations use durable transaction evidence. JSON and logical SQLite snapshots are staged, committed, verified, and recovered after interruption. Startup rolls back pre-commit phases and completes an interrupted committing phase from its bounded receipt instead of replaying the mutation.

## Migration and rollback

v21 keeps store schema version 2 and migrates supported legacy state under a lock with backup/recovery checks. Future or corrupt authoritative state fails closed and preserves content-addressed evidence; it is not silently replaced.

Before upgrading, stop the old MCP process, back up the installed code directory, and separately back up `~/.hermes-reflection`. Install into a clean staging directory, run the full validation matrix, then switch Codex to the validated path. To roll back, stop Codex, restore the previous code directory and matching data backup, then restart a fresh Codex process.

## Development and verification

Node.js 20 or newer is required.

```powershell
npm ci
npm run test:strict
npm run build
npm run smoke
npm run test:v19.3
npm run test:v19.4
npm run test:v19.4.1
npm run test:v19.5
npm run test:v20
npm run test:concurrency
npm run test:v20:agent-fixture
npm run test:v21
```

`npm run test:v20:agent` runs 20 fresh-process Codex Agent workflows and requires at least 18/20 passes with zero destructive-tool violations. It needs the local `codex` executable and can make model calls. The fixture grader is deterministic and offline.

CI runs Windows and Linux on Node 20 and 22, including strict TypeScript, compatibility tests, v20 and v21 suites, concurrency checks, package dry-run, fixture grading, and production audit.

See [`INSTALL_HERMES_MCP.md`](INSTALL_HERMES_MCP.md) for installation and [`CHANGELOG.md`](CHANGELOG.md) for release history.
