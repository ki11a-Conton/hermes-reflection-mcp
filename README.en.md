# Hermes Reflection MCP v14.0.0

English | [简体中文](README.md)

Hermes Reflection MCP is a local stdio MCP server that gives coding agents a
durable, queryable memory for work they have already done.

It is designed for agents that repeatedly code, debug, maintain RAG indexes,
ship releases, run smoke tests, use worker agents, or troubleshoot the same
project over time. Instead of losing lessons at the end of a chat, the agent can
store structured reflections, retrieve relevant lessons before similar work,
track unresolved questions, export project experience notes, and inspect the
health of its memory store.

The server is local-first. It does not call remote APIs. It writes JSON files
under the user's home directory and communicates with MCP clients over stdio.

## Table of Contents

- [What This Solves](#what-this-solves)
- [Feature Overview](#feature-overview)
- [What's New in v14.0.0](#whats-new-in-v1400)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Install From a Release Zip](#install-from-a-release-zip)
- [Install From Source](#install-from-source)
- [Codex Desktop Configuration](#codex-desktop-configuration)
- [Generic MCP Client Configuration](#generic-mcp-client-configuration)
- [First Smoke Test](#first-smoke-test)
- [Recommended Agent Workflow](#recommended-agent-workflow)
- [Data Model](#data-model)
- [Tool Reference](#tool-reference)
- [Security and Safety](#security-and-safety)
- [Backup, Restore, and Migration](#backup-restore-and-migration)
- [Project Experience Markdown Export](#project-experience-markdown-export)
- [Development](#development)
- [Release Packaging](#release-packaging)
- [Troubleshooting](#troubleshooting)
- [Repository Layout](#repository-layout)
- [Publishing to GitHub](#publishing-to-github)
- [Version History](#version-history)

## What This Solves

Long-running engineering work produces lessons that are easy to forget:

- A smoke test needs `HOME` and `USERPROFILE` set together.
- A worker agent timed out when asked to do too much.
- A release zip accidentally included a cache directory.
- A legacy data import missed fields added in a later version.
- A recurring debugging step has a known safe command sequence.
- A project has open questions that should be revisited later.

Hermes Reflection MCP stores those lessons as structured memory. An agent can
then retrieve them before starting the next similar task.

The core loop is:

1. Retrieve relevant lessons before significant work.
2. Do the work and verify it.
3. Reflect on what happened after the task.
4. Reuse the stored lessons next time.

## Feature Overview

- **Structured post-task reflection** with outcome, failure mode, blockers,
  safe paths, open questions, world-model updates, tool insights, tags, and
  lessons learned.
- **Heuristic memory** extracted from reflections and retrievable by task
  description, domain, confidence, and tags.
- **Retrieval usage tracking** with `retrieval_count`, `last_retrieved_at`, and
  Ebbinghaus-style decay so useful lessons stay discoverable.
- **Reflection search and browsing** by query, domain, outcome, failure mode,
  tags, session id, and recency.
- **Session summaries** for handoff, review, and agent self-evaluation.
- **Open-question tracking** with individual resolution state.
- **Affordance-gap tracking** for missing tools, permissions, or environment
  capabilities.
- **World-model aggregation** from stored facts with polarity-aware deduping.
- **Project-experience Markdown export** for RAG ingestion or durable project
  writeups.
- **Store health checks** for orphaned records, broken heuristic version links,
  file sizes, suspicious heuristic counts, and large reflection records.
- **Import/export** for backup, restore, migration, and inspection.
- **MCP tool annotations** marking read-only, mutating, and destructive tools.
- **Reusable smoke tests** that run with temporary profile directories so real
  memory is not modified.

## What's New in v14.0.0

v14.0.0 is a performance and agent-workflow release on top of the v13 storage
architecture. Tool count increases from 35 to 37.

### Performance improvements (TASK-01 through TASK-09)

- Heuristic deduplication now keeps direct candidate references after the
  Jaccard prefilter, avoiding repeated full-array lookup on write hot paths.
- Empty-query reflection browsing reuses a cached ordered-reflection hint, so
  common list/search calls avoid repeated order scans.
- Timeline, open-question, reflection-summary, domain-summary, pruning, and
  store-health paths avoid unnecessary full sorts or temporary arrays.
- Tag filtering now uses normalized tag-set indexes for heuristic and
  reflection filters instead of normalizing item tags on every match.

### New and expanded tools

- New `bulk_retrieve_heuristics` retrieves lessons for multiple task
  descriptions in one call and increments retrieval stats once per matched
  heuristic.
- New `update_reflection` lets agents correct mutable reflection metadata
  (`domain`, `tags`, and `lessons_learned`) and optionally re-extract
  heuristics from corrected lessons.
- `get_domain_summary` now accepts `include_open_questions_detail:true` to
  include the top unresolved open questions for each domain.

### Previous highlights

v13.0.0 added `reflect_on_task(dry_run:true)`,
`export_project_experience_md.tag_mode`, and `get_domain_summary`.

v12.0.0 added write-lifetime heuristic dedup caching, tag-mode parity for
search/list reflections, `get_reflection.apply_resolved_overlay`, and
`snapshot` recovery-point tooling.

## Architecture

Hermes Reflection MCP is a TypeScript MCP server using:

- `@modelcontextprotocol/sdk`
- `zod`
- Node.js filesystem APIs

Runtime flow:

```text
MCP client
  |
  | stdio JSON-RPC
  v
dist/index.js
  |
  | validates tool input and formats tool output
  v
dist/storage.js
  |
  | serialized mutations, JSONL reflection storage, import/export
  v
~/.hermes-reflection/
```

Main source files:

- `index.ts` - MCP tool definitions, schemas, handlers, and output formatting.
- `storage.ts` - store loading, persistence, search, scoring, pruning, import,
  export, health checks, and Markdown export.
- `types.ts` - TypeScript data model definitions.
- `scripts/smoke.mjs` - end-to-end MCP smoke test.
- `scripts/concurrency-test.mjs` - mixed read/write concurrency smoke test.

Compiled files live in `dist/`.

## Requirements

- Node.js 18 or newer.
- npm.
- An MCP client that supports stdio servers, such as Codex Desktop or another
  local MCP-compatible agent.
- Windows, macOS, or Linux. The examples below use Windows paths where relevant
  because Codex Desktop installs commonly live under `C:\Users\<YOU>\.codex`.

## Install From a Release Zip

Use this path when another agent gives you a packaged release such as:

```text
hermes-reflection-mcp-v14.0.0.zip
```

1. Extract the zip to a stable location.

   Recommended Codex Desktop path on Windows:

   ```text
   C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp
   ```

2. Open a terminal in that directory.

3. Install production dependencies:

   ```powershell
   npm ci --omit=dev
   ```

4. Add the MCP server to your MCP client configuration.

5. Restart the MCP client.

Do not copy `node_modules` from the machine that created the zip. Always run
`npm ci --omit=dev` on the target machine.

## Install From Source

Use this path when cloning from GitHub.

```powershell
git clone <REPO_URL> hermes-reflection-mcp
cd hermes-reflection-mcp
npm ci
npm run build
npm run smoke
```

After the build, configure your MCP client to run:

```text
node <repo-or-install-dir>\dist\index.js
```

For production use, you can copy only the release whitelist to a stable MCP
directory:

- `dist/`
- `scripts/smoke.mjs`
- `scripts/concurrency-test.mjs`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `README.md`
- `CHANGELOG.md`
- `INSTALL_HERMES_MCP.md`
- `codex_config_snippet.toml`
- `index.ts`
- `storage.ts`
- `types.ts`

Then run:

```powershell
npm ci --omit=dev
```

## Codex Desktop Configuration

Example `C:\Users\<YOU>\.codex\config.toml` block:

```toml
[mcp_servers.hermes-reflection]
type = "stdio"
command = "node"
args = ['C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js']
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 300
```

The server emits its own instructions during MCP `initialize`. A config-level
`instructions` field is optional and should be treated as an override.

Suggested Codex Desktop approval policy:

```toml
[mcp_servers.hermes-reflection.tools.retrieve_heuristics]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_reflection_summary]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.search_reflections]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.list_reflections]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_recent_reflections]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_affordance_gaps]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_open_questions]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_world_model]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_reflection_timeline]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_heuristic_history]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_heuristic_stats]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.diff_reflections]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_store_health]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.export_project_experience_md]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.export_data]
approval_mode = "auto"
```

Do not auto-approve `clear_data`. It is destructive and already requires
`confirm:true`, but the client should still treat it as a high-risk action.

## Generic MCP Client Configuration

For any stdio MCP client, the important parts are:

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["<INSTALL_DIR>/dist/index.js"]
}
```

Set the working directory to the install directory if your MCP client supports
it. The server itself stores data under the user's home directory, not under the
repository, unless `HOME` or `USERPROFILE` is overridden.

## First Smoke Test

The safest smoke test uses a temporary profile. This prevents the test from
touching the real memory store.

From a source checkout with dev dependencies installed:

```powershell
npm run smoke
```

Expected:

```text
Hermes smoke passed with temporary HOME: <temp path>
hermes-reflection-mcp v14.0.0 ready (store: <temp path>/.hermes-reflection)
```

Also run:

```powershell
node scripts\concurrency-test.mjs
```

For production-only installs created with `npm ci --omit=dev`, do not use
`npm run smoke` unless dev dependencies are installed. `npm run smoke` runs
`npm run build`, and building requires TypeScript. Instead, use an MCP SDK or
client smoke that starts `node dist/index.js` directly.

Minimum installed-entrypoint checks:

- `initialize` returns version `14.0.0`.
- `tools/list` returns 37 tools.
- `get_store_health` is present and read-only.
- `get_heuristic_stats` is present and read-only.
- `get_store_health` output includes `suspicious_heuristics: 0` for a clean
  temporary store.
- `get_heuristic_stats` output includes `Suspicious active: 0` for a clean
  temporary store.

## Recommended Agent Workflow

Use Hermes for meaningful engineering work, not every tiny chat.

Before significant work:

```text
retrieve_heuristics({
  "task_description": "Fix failing package release smoke for Hermes MCP",
  "domain": "hermes-reflection-mcp",
  "limit": 5
})
```

During work:

```text
log_affordance_gap({
  "session_id": "release-2026-06-08",
  "goal_description": "Verify package zip on a clean machine",
  "failure_description": "No tool can launch an isolated VM",
  "missing_capability": "clean-machine verification environment"
})
```

After work:

```text
reflect_on_task({
  "session_id": "release-2026-06-08",
  "task_goal": "Package Hermes Reflection MCP v14.0.0",
  "task_outcome": "success",
  "failure_mode": "success",
  "summary": "Built, installed, packaged, scanned, and verified v14.0.0.",
  "lessons_learned": [
    "Validate production-only MCP installs with a direct dist/index.js smoke."
  ],
  "domain": "hermes-reflection-mcp",
  "tags": ["release", "mcp"]
})
```

At project/session boundaries:

```text
get_session_summary({ "session_id": "release-2026-06-08" })
export_project_experience_md({
  "session_id": "release-2026-06-08",
  "output_dir": "D:\\RAG\\documents"
})
```

## Data Model

Hermes stores five main concepts.

### Reflection

A reflection is a structured record of one task:

- task goal,
- outcome,
- failure mode,
- summary,
- optional long summary sections,
- blockers,
- active hypotheses,
- proven safe paths,
- exhausted searches,
- world-model updates,
- tool insights,
- context to forget,
- open questions,
- lessons learned,
- related affordance gaps,
- domain and tags.

Reflections are append-friendly and stored in `reflections.jsonl`.

### Heuristic

A heuristic is a reusable lesson:

- text,
- confidence,
- domain,
- tags,
- source task,
- reinforcement and contradiction counts,
- retrieval count,
- last retrieved timestamp,
- version-chain metadata for updates.

Heuristics are extracted from `reflect_on_task` by default, unless
`auto_extract_heuristics:false` is passed.

### Session

A session groups reflections under a `session_id`.

Session tools make it easier to hand off work or summarize a full run.

### Affordance Gap

An affordance gap records missing capability:

- missing tool,
- missing permission,
- missing environment support,
- missing integration,
- repeated blocker.

Recurring gaps get auto-suggestions.

### Open Question

Open questions are unresolved follow-ups captured during reflection. They can be
listed, filtered, and resolved individually.

## Storage Files

Default location:

```text
~/.hermes-reflection/store.json
~/.hermes-reflection/reflections.jsonl
~/.hermes-reflection/resolved_questions.json
```

On Windows this usually resolves to:

```text
C:\Users\<YOU>\.hermes-reflection
```

`store.json` contains sessions, heuristics, affordance gaps, version, and store
metadata. `reflections.jsonl` contains reflections. `resolved_questions.json`
contains the overlay for resolved open questions.

If invalid JSON is found in the store, Hermes preserves the corrupt file as:

```text
store.json.corrupt.<timestamp>.<uuid>
```

and starts from an empty store.

Writes are serialized inside the process. Replacement writes use atomic file
replacement where needed.

## Tool Reference

The server exposes 37 tools.

### Reflection Write Tools

#### `reflect_on_task`

Stores one structured post-task reflection. It can also extract lessons into the
heuristic knowledge base.

Required:

- `session_id`
- `task_goal`
- `task_outcome`: `success`, `partial`, or `failure`
- `failure_mode`
- `summary`

Optional:

- `summary_sections`
- `immediate_blockers`
- `active_hypotheses`
- `proven_safe_paths`
- `exhausted_search`
- `world_model_updates`
- `tool_insights`
- `context_forget`
- `open_questions`
- `lessons_learned`
- `missing_capability`
- `available_tools`
- `auto_extract_heuristics`
- `domain`
- `tags`

Notes:

- `summary` can be up to 8000 characters.
- `task_goal` can be up to 1000 characters.
- Up to 50 lessons are accepted per call.
- Lessons are deduplicated before storage and heuristic extraction.
- Suspicious lesson text is preserved in the audit log but masked in immediate
  normal output.

#### `bulk_reflect`

Stores multiple reflections in one write. Maximum 20 reflections per call.

Use this when importing or batching a set of task outcomes.

#### `log_affordance_gap`

Records a missing capability, tool, permission, or environment affordance.

Required:

- `session_id`
- `goal_description`
- `failure_description`
- `missing_capability`

Optional:

- `available_tools`
- `suggested_solution`

#### `resolve_affordance_gap`

Marks an affordance gap resolved.

Required:

- `id`

Optional:

- `resolution_notes`

### Heuristic Retrieval and Maintenance

#### `retrieve_heuristics`

Retrieves relevant lessons before starting work. This tool is mutating because
it records retrieval usage stats.

Required:

- `task_description`

Optional:

- `domain`
- `limit`
- `tags`
- `tag_mode`: `and` or `or`
- `show_scores`
- `min_confidence`

Default `min_confidence` is `0.3`.
Default `tag_mode` is `and` for backward compatibility.

#### `bulk_retrieve_heuristics`

Retrieves relevant lessons for multiple task descriptions in one call. This is
useful when an agent is planning several related work items and wants one
batched memory lookup instead of repeated tool calls.

Required:

- `queries`: one to 20 query objects, each with `task_description`.

Per-query optional fields:

- `domain`
- `limit`
- `tags`
- `tag_mode`: `and` or `or`
- `min_confidence`

Optional:

- `show_scores`

Retrieval usage stats are recorded once per matched heuristic per bulk call,
even if the same heuristic appears in multiple query result sections.

#### `list_heuristics`

Lists stored heuristics.

Filters:

- `domain`
- `tags`
- `tag_mode`: `and` or `or`
- `min_confidence`
- `limit`
- `sort`: `confidence`, `updated_at`, `created_at`, or `reinforcement`

Superseded heuristic versions are hidden from normal listing.

#### `search_heuristics`

Searches heuristics by query relevance.

Required:

- `query`

Filters:

- `domain`
- `tags`
- `tag_mode`
- `min_confidence`
- `limit`

Low-relevance noise is filtered.

#### `get_heuristic_stats`

Returns read-only heuristic statistics:

- active count,
- archived count,
- suspicious active count,
- confidence distribution,
- never-retrieved count,
- stale count,
- domain breakdown,
- top heuristics by retrieval,
- top heuristics by reinforcement.

#### `add_heuristic`

Manually adds one lesson.

Required:

- `heuristic`
- `source_task`

Optional:

- `domain`
- `tags`
- `confidence`

Suspicious heuristic text is rejected.

#### `contradict_heuristic`

Marks a heuristic contradicted and lowers confidence.

Required:

- `id`

Optional:

- `reason`

#### `delete_heuristic`

Permanently deletes a heuristic by id.

This is mutating and should be used carefully.

#### `update_heuristic`

Edits a heuristic's text, tags, confidence, or domain.

Required:

- `id`

Optional:

- `heuristic`
- `tags`
- `confidence`
- `domain`

Text edits create a new version and archive the old version with
`superseded_by`. Passing `tags:[]` clears tags. Omitting `tags` or passing
`null` leaves tags unchanged.

#### `pin_heuristic`

Pins or unpins an active heuristic to protect it from automatic pruning.

Required:

- `id`

Optional:

- `pin`: `true` to pin, `false` to unpin. Default is `true`.

Use this sparingly for critical invariants that must survive pruning.

#### `merge_heuristics`

Merges one or more source heuristics into a target heuristic.

Required:

- `target_id`
- `source_ids`

Sources are archived. The target absorbs tags, reinforcement counts,
contradiction counts, and contradiction notes.

#### `get_heuristic_history`

Returns a supersedes chain starting from any heuristic id.

Required:

- `id`

Optional:

- `include_archived`

### Reflection Read Tools

#### `search_reflections`

Full-text search over stored reflections.

Required:

- `query`

Use `query:""` to browse filtered reflections without text scoring.

Filters:

- `domain`
- `outcome`
- `failure_mode`
- `since_days`
- `tags`
- `tag_mode`: `and` for all tags, `or` for any tag
- `limit`

#### `list_reflections`

Browse reflections without full-text search.

Filters:

- `domain`
- `outcome`
- `failure_mode`
- `tags`
- `tag_mode`: `and` for all tags, `or` for any tag
- `session_id`
- `since_days`
- `limit`
- `offset`

Results are reverse chronological.

#### `diff_reflections`

Compares two reflections.

Required:

- `id_a`
- `id_b`

Returns field changes, lesson additions/removals/unchanged matches, world-model
polarity shifts, common open questions, and time delta.

#### `get_reflection_summary`

Dashboard summary:

- total reflections,
- sessions,
- active and archived heuristics,
- active and resolved affordance gaps,
- top gaps,
- recent lessons,
- outcome distribution,
- failure distribution,
- domain distribution,
- tag distribution,
- store metadata.

#### `get_recent_reflections`

Returns recent reflections in reverse chronological order.

Optional:

- `limit`

#### `get_session_reflections`

Returns recent reflections for one session.

Required:

- `session_id`

Optional:

- `limit`

#### `get_session_summary`

Returns a compact session digest:

- outcome distribution,
- domains,
- top lessons,
- open questions,
- affordance gaps logged,
- heuristics extracted.

Required:

- `session_id`

#### `get_reflection`

Returns full details for one reflection.

Required:

- `id`

Optional:

- `apply_resolved_overlay`: default `true`; pass `false` to inspect raw
  open-question state without the resolved overlay.

Useful after `search_reflections`, `list_reflections`, or
`get_recent_reflections`.

#### `update_reflection`

Updates mutable metadata on a saved reflection.

Required:

- `id`

Optional:

- `domain`
- `tags`
- `lessons_learned`
- `re_extract_heuristics`: default `false`
- `confidence`: confidence to use when re-extracting heuristics

Immutable audit fields such as task goal, outcome, timestamp, and session id
cannot be changed. Unsafe lessons are filtered before storage. When
`re_extract_heuristics:true` is passed, corrected lessons are also upserted into
the heuristic knowledge base.

### Open Question Tools

#### `get_open_questions`

Lists unresolved questions by priority.

Filters:

- `domain`
- `priority`
- `limit`
- `since_days`
- `include_resolved`

#### `resolve_open_question`

Marks one open question resolved.

Required:

- `reflection_id`
- `question_index`

Optional:

- `resolved_by_reflection_id`

### World Model and Timeline

#### `get_world_model`

Aggregates `world_model_updates` into a current world model.

Filters:

- `domain`
- `polarity`: `affirm` or `negate`
- `limit`
- `since_days`

Deduplication keeps latest same-polarity facts while preserving opposite-polarity
facts separately.

#### `get_reflection_timeline`

Returns day, week, or month buckets.

Options:

- `bucket`: `day`, `week`, or `month`
- `domain`
- `since_days`
- `limit`

Buckets include reflection count, outcome counts, top failure mode, lesson
count, unresolved question count, and domains.

#### `get_domain_summary`

Returns either one domain detail view or a ranked list of top domains by
reflection count.

Options:

- `domain`: return detail for a single domain.
- `top_n`: maximum domains for ranked-list mode.
- `include_open_questions_detail`: include top unresolved questions for each
  returned domain.

The open-question detail option is off by default so the usual summary stays
compact.

### Health, Export, Import, and Destructive Tools

#### `get_store_health`

Checks store integrity and size.

Reports:

- healthy status,
- orphan reflections,
- orphan affordance gaps,
- broken heuristic links,
- suspicious heuristic count,
- file sizes,
- reflection count,
- average reflection size,
- largest reflection.

#### `export_project_experience_md`

Generates Markdown from completed reflections for project handoff or RAG
ingestion.

Filters:

- `session_id`
- `domain`
- `tags`
- `since_days`
- `limit`

Output options:

- no output path: return content inline,
- `format`: `markdown`, `plaintext`, or `json`,
- `output_path`: write exact path,
- `output_dir`: write a safe generated filename,
- `include_raw_reflections`: append compact per-reflection details.

This tool is mutating when it writes files.

#### `export_data`

Exports store data as JSON.

Options:

- `collection`: `reflections`, `heuristics`, `affordance_gaps`, `sessions`, or
  `all`
- `format`: currently `json`
- `output_path`

Large inline exports return counts unless `output_path` is provided.

This tool is annotated mutating because `output_path` can write a file.

#### `import_data`

Imports JSON previously exported by Hermes.

Required:

- `input_path`

Optional:

- `mode`: `merge` or `replace`

Legacy reflection and heuristic records are normalized on import.

#### `snapshot`

Creates a timestamped recovery-point directory containing the current store
files.

Optional:

- `output_dir`: directory where the timestamped snapshot subdirectory is
  created. Defaults to `~/.hermes-reflection/snapshots/`.
- `label`: safe label appended to the snapshot directory name, such as
  `before-import`.

Use before `clear_data` or `import_data` with `mode:"replace"`.

#### `clear_data`

Clears a collection.

Required:

- `collection`
- `confirm:true`

Collections:

- `reflections`
- `heuristics`
- `affordance_gaps`
- `sessions`
- `all`

This is destructive. Do not auto-approve it.

## Tool Annotations

Hermes exposes MCP annotations so clients can reason about risk.

Read-only tools include:

- `list_heuristics`
- `search_heuristics`
- `get_heuristic_stats`
- `get_heuristic_history`
- `search_reflections`
- `list_reflections`
- `diff_reflections`
- `get_reflection_summary`
- `get_affordance_gaps`
- `get_recent_reflections`
- `get_session_reflections`
- `get_session_summary`
- `get_reflection`
- `get_open_questions`
- `get_world_model`
- `get_reflection_timeline`
- `get_store_health`

Mutating tools include:

- `reflect_on_task`
- `bulk_reflect`
- `log_affordance_gap`
- `resolve_affordance_gap`
- `retrieve_heuristics`
- `add_heuristic`
- `contradict_heuristic`
- `delete_heuristic`
- `update_heuristic`
- `pin_heuristic`
- `merge_heuristics`
- `resolve_open_question`
- `export_project_experience_md`
- `export_data`
- `import_data`
- `snapshot`

Destructive tool:

- `clear_data`

`retrieve_heuristics` is mutating because it records usage stats.
`export_data`, `export_project_experience_md`, and `snapshot` are mutating
because they can write output files.

## Security and Safety

Hermes is a local memory server. Treat its store as agent-readable context.

### Do Not Store Secrets

Do not store:

- API keys,
- auth tokens,
- passwords,
- cookies,
- private config values,
- private SSH keys,
- proprietary secrets that future agents should not read.

Reflections are meant for transferable engineering lessons, not secret storage.

### Suspicious Heuristic Text

Heuristics may be retrieved as future agent context. For that reason, Hermes
detects and blocks suspicious heuristic text on normal write paths.

Examples of risky patterns include:

- prompt-injection text,
- hidden instructions,
- attempts to exfiltrate context,
- hardcoded secret-looking assignments,
- hidden unicode control characters,
- C2 or command-and-control phrasing.

Normal output paths mask suspicious heuristic text with a `[BLOCKED: ...]`
placeholder. Raw imported records can still be audited with:

```text
export_data({ "collection": "heuristics" })
```

Use raw export only for explicit audit, migration, or repair.

### Destructive Operations

`clear_data` requires `confirm:true`. MCP clients should still avoid automatic
approval for it.

Before destructive maintenance:

```text
export_data({ "output_path": "<backup-file>.json" })
get_store_health({})
```

### Import Safety

`import_data` can add or replace store content. Review imported files before
using them.

Use `merge` when possible. Use `replace` only after exporting a backup.

### File Output Safety

`export_data` and `export_project_experience_md` can write files. Choose output
paths deliberately and avoid writing into release package staging directories
unless that is your intent.

## Backup, Restore, and Migration

### Backup

```text
export_data({
  "collection": "all",
  "output_path": "C:\\Users\\<YOU>\\Desktop\\hermes-backup.json"
})
```

### Restore by Merge

```text
import_data({
  "input_path": "C:\\Users\\<YOU>\\Desktop\\hermes-backup.json",
  "mode": "merge"
})
```

### Restore by Replace

```text
import_data({
  "input_path": "C:\\Users\\<YOU>\\Desktop\\hermes-backup.json",
  "mode": "replace"
})
```

### Verify After Restore

```text
get_store_health({})
get_reflection_summary({})
get_heuristic_stats({})
```

## Project Experience Markdown Export

`export_project_experience_md` turns reflection memory into a reusable Markdown
document.

Typical use cases:

- hand off a project to another agent,
- create a RAG ingestion document,
- summarize repeated failures and fixes,
- archive a completed session.

Example:

```text
export_project_experience_md({
  "domain": "hermes-reflection-mcp",
  "limit": 50,
  "output_dir": "D:\\RAG\\documents",
  "title": "Hermes Reflection MCP Experience"
})
```

The generated document contains:

- scope metadata,
- executive summary,
- recurring lessons,
- safe paths,
- tool insights,
- world-model updates,
- open questions,
- failure rows,
- RAG keywords,
- source reflection ids,
- optional raw reflection details.

Resolved open questions are hidden from aggregate and raw sections.

## Development

Install dependencies:

```powershell
npm ci
```

Build:

```powershell
npm run build
```

Run the server:

```powershell
npm start
```

Run full smoke:

```powershell
npm run smoke
```

Run concurrency smoke:

```powershell
node scripts\concurrency-test.mjs
```

The smoke scripts set temporary `HOME` and `USERPROFILE` values. They should not
modify the real `~/.hermes-reflection` store.

## Verification Checklist

Before publishing or packaging, run:

```powershell
npm run build
npm run smoke
node scripts\concurrency-test.mjs
```

Then check:

- version in `package.json`,
- version in `package-lock.json`,
- `SERVER_VERSION` in `index.ts`,
- `VERSION` in `storage.ts`,
- expected version in `scripts/smoke.mjs`,
- README and CHANGELOG release notes,
- install guide version,
- config snippet version.

Useful hygiene checks:

```powershell
@'
import { readFileSync } from "fs";

const files = [
  "index.ts",
  "storage.ts",
  "types.ts",
  "README.md",
  "CHANGELOG.md",
  "INSTALL_HERMES_MCP.md"
];

let failed = false;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const hasNonAscii = [...text].some((char) => char.charCodeAt(0) > 127);
  const hasTodoMarker = text.includes("TO" + "DO");
  const hasFixmeMarker = text.includes("FIX" + "ME");
  if (hasNonAscii || hasTodoMarker || hasFixmeMarker) {
    console.log(`${file}: nonAscii=${hasNonAscii} todo=${hasTodoMarker} fixme=${hasFixmeMarker}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("TEXT_HYGIENE=OK");
'@ | node -
```

Check for runtime artifacts:

```powershell
Get-ChildItem -Force -Directory -Recurse -Include '.pytest_cache','__pycache__','logs'
```

## Release Packaging

Use a whitelist packaging strategy.

Include:

- `dist/`
- `scripts/smoke.mjs`
- `scripts/concurrency-test.mjs`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `README.md`
- `CHANGELOG.md`
- `INSTALL_HERMES_MCP.md`
- `codex_config_snippet.toml`
- `index.ts`
- `storage.ts`
- `types.ts`

Exclude:

- `node_modules/`
- `.git/`
- `.claude/`
- memory files,
- task docs,
- local logs,
- caches,
- bytecode,
- coverage,
- build staging directories,
- old zips,
- local machine paths,
- credentials.

After creating a zip:

1. List the archive contents.
2. Scan for forbidden entries.
3. Scan for local paths and secret-looking assignments.
4. Compare source, install, and stage hashes for whitelisted files.
5. Extract into a clean temp directory.
6. Run `npm ci`.
7. Run `npm run build`.
8. Run `npm run smoke`.
9. Run `node scripts\concurrency-test.mjs`.

## Troubleshooting

### The MCP server does not start

Check:

- Node.js is installed and on `PATH`.
- The configured `args` path points to `dist/index.js`.
- `npm ci --omit=dev` was run in the install directory.
- The file exists:

```powershell
Test-Path 'C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js'
```

### Codex Desktop still shows the old version

Restart Codex Desktop after replacing files.

Verify the configured path in `config.toml` points to the directory you updated.

Run an installed-entrypoint smoke against:

```text
C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js
```

### `npm run smoke` fails in a production install

Production installs often use:

```powershell
npm ci --omit=dev
```

That omits TypeScript. `npm run smoke` starts with `npm run build`, so it needs
dev dependencies. Either install dev dependencies with `npm ci`, or smoke the
installed `dist/index.js` directly with an MCP client.

### Real memory changed during testing

Smoke tests should set temporary `HOME` and `USERPROFILE`.

If a manual test used the real profile by accident, inspect:

```text
~/.hermes-reflection
```

Use `export_data`, `get_store_health`, and backups to inspect or repair.

### `get_store_health` reports orphan records

This usually means sessions, reflections, or gaps were imported separately.

Recommended flow:

1. Export a backup.
2. Inspect the missing session ids or records.
3. Re-import a complete snapshot with sessions included, or repair the source
   JSON and import again.

### `get_store_health` reports suspicious heuristics

Normal output masks suspicious text. To audit raw records:

```text
export_data({ "collection": "heuristics" })
```

Then decide whether to delete, update, or keep the raw record for audit
purposes.

### `search_reflections` returns too much

Use filters:

```text
search_reflections({
  "query": "release package",
  "domain": "hermes-reflection-mcp",
  "since_days": 30,
  "tags": ["release"],
  "limit": 10
})
```

Use `query:""` only when you intentionally want filtered browsing without text
scoring.

### `retrieve_heuristics` returns low-value lessons

Try:

- increasing `min_confidence`,
- filtering by `domain`,
- filtering by `tags`,
- using `show_scores:true` to inspect ranking.

### `clear_data` fails

`clear_data` requires:

```json
{ "confirm": true }
```

This is intentional.

## Repository Layout

```text
.
|-- index.ts
|-- storage.ts
|-- types.ts
|-- scripts/
|   |-- smoke.mjs
|   `-- concurrency-test.mjs
|-- dist/
|   |-- index.js
|   |-- storage.js
|   `-- types.js
|-- package.json
|-- package-lock.json
|-- tsconfig.json
|-- README.md
|-- CHANGELOG.md
|-- INSTALL_HERMES_MCP.md
`-- codex_config_snippet.toml
```

## Publishing to GitHub

Before publishing publicly:

- Add a `LICENSE` file. This repository currently documents functionality but
  does not grant public reuse rights unless a license is added.
- Review `README.md`, `CHANGELOG.md`, and `INSTALL_HERMES_MCP.md` for any local
  machine paths.
- Do not commit `node_modules`.
- Do not commit local memory stores.
- Do not commit release staging directories.
- Do not commit secrets or private config.
- Run the full verification checklist.
- Create a GitHub Release with the validated zip and SHA-256 hash.

Suggested `.gitignore` entries:

```gitignore
node_modules/
.hermes-reflection/
release/*.tmp
*.log
.pytest_cache/
__pycache__/
coverage/
```

## Version History

### v13.0.0

- Add top-k and cache-path performance improvements across heuristic stats,
  resolved-question reads, store-index writes, affordance-gap upserts,
  reflection browsing, open-question filtering, and search-text reuse.
- Add `reflect_on_task(dry_run:true)` for validation and preview without
  persisting data.
- Add `export_project_experience_md.tag_mode` for AND/OR multi-tag filters.
- Add `get_domain_summary`.
- Increase tool count to 35.

### v12.0.0

- Add write-lifetime heuristic dedup caching for bulk reflection hot paths.
- Optimize affordance-gap counting, session summaries, experience export,
  heuristic stats, store health, resolved-question writes, and short-lived read
  caching.
- Add `search_reflections.tag_mode` and `list_reflections.tag_mode`.
- Add `get_reflection.apply_resolved_overlay`.
- Add `snapshot` recovery-point tool.
- Increase tool count to 34.

### v11.0.1

- Fix merge imports of resolved open questions so `reflections.jsonl` does not
  retain embedded `resolved` fields.
- Add smoke coverage for the merge-import resolved-question overlay path.

### v11.0.0

- Add write-cache and resolved-question-cache optimizations.
- Improve health, summary, world-model, timeline, import, and search hot paths.
- Add `retrieve_heuristics.tag_mode`.
- Add `pin_heuristic`.
- Add `export_project_experience_md.format` for Markdown, plaintext, and JSON output.
- Increase tool count to 33.

### v10.0.2

- Mask suspicious lesson text in `reflect_on_task` immediate responses.
- Add `suspicious_heuristics` to `get_store_health` output.
- Add `Suspicious active` to `get_heuristic_stats` output.
- Expand smoke coverage for suspicious imported heuristic records.

### v10.0.1

- Normalize legacy reflection imports at load/import boundaries.
- Add smoke coverage for minimal legacy reflection records.

### v10.0.0

- Make retrieval ranking and retrieval-stat updates one serialized mutation.
- Add concurrency smoke tests.
- Improve heuristic pruning.
- Add read cache and session index.
- Add `list_reflections`.
- Add `get_heuristic_stats`.
- Add `merge_heuristics`.
- Keep tool count at 32 after the new additions.

### v9.x and earlier highlights

- Add `get_world_model`.
- Add `export_project_experience_md`.
- Move reflections to `reflections.jsonl`.
- Add open-question resolution.
- Add bulk reflection writes.
- Add heuristic version chains.
- Add store health checks.
- Add CJK tokenization and BM25 improvements.
- Add tool annotations.
- Add `list_heuristics`, `search_heuristics`, `get_reflection`, and
  `get_open_questions`.

See `CHANGELOG.md` for detailed release notes.
