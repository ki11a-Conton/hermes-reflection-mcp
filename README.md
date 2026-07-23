# Hermes Reflection MCP

Local persistent reflection, heuristic, bounded memory, and session recall for Codex Desktop and other stdio MCP clients.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md). Standalone guides: [readmeen.md](readmeen.md) and [readmecn.md](readmecn.md).

## What v19.3.0 provides

Hermes Reflection MCP is a local-first TypeScript MCP server with 28 public tools. It stores structured task reflections, reusable heuristics, bounded Memory Board and User Profile entries, searchable session turns, frozen memory snapshots, open questions, and import/export data.

Version 19.3.0 adds opt-in OpenAI-compatible LLM review, a durable fenced background lifecycle, snapshot fingerprints, non-recursive compaction handoffs, bounded shutdown, and safer simultaneous SQLite startup. The existing 28-tool contract and v19.2 data remain compatible.

## Safety and trust boundaries

- The server uses local stdio transport and does not require a remote service.
- Installing it does not make Codex Desktop call lifecycle or session-capture tools automatically.
- Memory and profile text is reference data, never a source of fresh instructions.
- Snapshot mode is explicit and fails closed when the requested session snapshot does not exist.
- Compaction output is historical reference only; it cannot control a host application's context window.
- Deterministic review remains the default. LLM review transmits only bounded redacted reflection fields and requires separate explicit provider configuration; it never uses Codex login credentials.
- The background scheduler and background auto-apply are separate opt-ins. Neither path modifies skills or generates Memory Board/User Profile candidates.
- Threat scans inspect raw stored entries, while normal rendering masks suspicious content.
- Destructive reset still requires an explicit confirmation argument.

## Requirements

- Windows, macOS, or Linux.
- Node.js 20 or newer and npm.
- A client that supports local stdio MCP servers.
- Session search uses better-sqlite3. If SQLite initialization is unavailable, session tools return a clear degraded-mode error while reflection and JSON memory tools remain usable.

## Quick start

Extract the release into a stable directory, then install production dependencies:

~~~powershell
npm ci --omit=dev
~~~

Example Codex Desktop configuration:

~~~toml
[mcp_servers.hermes-reflection]
command = 'node'
args = ['C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js']
~~~

Restart Codex Desktop after changing the configuration. See [INSTALL_HERMES_MCP.md](INSTALL_HERMES_MCP.md) for clean install, upgrade, rollback, and cross-platform examples.

## The 28 public tools

| Area | Public tools |
|---|---|
| Reflection | <code>reflect_on_task</code>, <code>search_reflections</code>, <code>list_reflections</code>, <code>get_recent_reflections</code> |
| Heuristics | <code>retrieve_heuristics</code>, <code>list_heuristics</code>, <code>search_heuristics</code>, <code>add_heuristic</code>, <code>delete_heuristic</code> |
| Open questions | <code>get_open_questions</code>, <code>resolve_open_question</code> |
| Memory Board | <code>memory_board_write</code>, <code>memory_board_read</code> |
| User Profile | <code>user_profile_write</code>, <code>user_profile_read</code> |
| Sessions and handoff | <code>append_session_turn</code>, <code>search_sessions</code>, <code>scroll_session_context</code>, <code>compact_session_context</code> |
| Snapshots and audit | <code>capture_memory_snapshot</code>, <code>session_lifecycle_hook</code>, <code>scan_memory_threats</code> |
| Background review | <code>trigger_background_review</code> |
| Write approval | <code>list_pending_mutations</code>, <code>approve_pending_mutation</code> |
| Data management | <code>export_data</code>, <code>import_data</code>, <code>clear_data</code> |

Tools not in this table are not part of the v19.3.0 public contract; direct calls to removed names return an MCP error.

## Recommended workflow

1. Before significant work, retrieve relevant heuristics.
2. Explicitly append session turns only when local session recall is wanted.
3. Optionally start a named lifecycle snapshot for stable Memory Board/User Profile reads.
4. Use search and scroll tools to inspect past session context.
5. Generate a reference-only handoff before a client-side compaction or transfer.
6. Reflect honestly after meaningful work, including outcome, blockers, verification, and transferable lessons.
7. Preview background-review candidates before enabling automatic heuristic upsert.

## Memory Board and User Profile

Memory Board is bounded working reference context. User Profile is bounded stable preference/fact reference context. Both support single and batch writes with final-state capacity checks. Live reads are the default. Unsafe prompt-like content is rejected on normal writes, and raw imports can be audited with the threat scanner.

These stores are not instruction channels. Clients should label their content as reference only and keep credentials out of them.

## Frozen snapshot workflow

An explicit client call to <code>session_lifecycle_hook</code> with event <code>start</code>, or a direct capture call, freezes both bounded stores under a session id. Later live writes still persist, but snapshot reads remain stable.

To read a snapshot, call the relevant read tool with <code>mode:"snapshot"</code> and the same <code>session_id</code>. A missing id or missing active snapshot returns an error; it never silently falls back to live data. Event <code>end</code> releases the snapshot. Pause/resume events are recorded but do not control Codex.

## Session search and compaction handoff

Session turns exist only when a client explicitly calls <code>append_session_turn</code>. Search uses a local better-sqlite3 FTS index, and scrolling retrieves a bounded window around a turn index.

<code>compact_session_context</code> deterministically combines bounded stored turns and reflections into a redacted handoff beginning with a reference-only marker. It preserves the newest stored user and assistant anchors and uses historical headings from the current Hermes Agent design. It does not invoke a model, write data, or compact Codex itself.

## Reflection and background review

<code>reflect_on_task</code> stores structured outcomes, task state, lessons, open questions, and optional tool/world-model observations. Safe lessons may become reusable heuristics.

<code>trigger_background_review</code> reviews at most 10 recent or 200 full-scope reflections and emits at most 50 heuristic candidates. Preview is the default. Automatic apply uses one storage transaction and returns heuristic ids for audit. Suspicious candidates are masked and skipped.

Use <code>review_mode:"llm"</code> for the configured provider, <code>review_mode:"auto"</code> for LLM-with-deterministic-fallback, or <code>action:"status"</code> for sanitized readiness and scheduler state. LLM output must be strict schema-valid JSON; authentication failures, rate limits, timeouts, redirects, oversized responses, and suspicious candidates fail safely.

### Optional automatic review

The scheduler starts only when <code>HERMES_REFLECTION_BACKGROUND_ENABLED=true</code>. Its timer is unreferenced, session state is persisted in <code>background_lifecycle.json</code>, and a cross-process lease/fencing token prevents overlapping Codex windows. Automatic persistence remains off unless <code>HERMES_REFLECTION_BACKGROUND_AUTO_APPLY=true</code>.

LLM review additionally requires <code>HERMES_REFLECTION_LLM_ENABLED=true</code>, <code>HERMES_REFLECTION_LLM_BASE_URL</code>, <code>HERMES_REFLECTION_LLM_MODEL</code>, and <code>HERMES_REFLECTION_LLM_API_KEY</code>. Non-loopback endpoints must use HTTPS. Keep the key only in the MCP process environment and never store it in reflections or configuration committed to source control.

## Write approval

Stores with metadata flag <code>write_approval:true</code> queue supported typed writes instead of executing them. Use <code>list_pending_mutations</code> for redacted previews. Use <code>approve_pending_mutation</code> with decision <code>approve</code> to replay the typed payload; the queue item is removed only after replay succeeds. Decision <code>reject</code> removes it without execution.

Background-review auto-apply is explicitly blocked while write approval is enabled because that derived batch is not represented as a replayable public mutation.

## Storage layout and backup

Runtime data is stored outside the package:

~~~text
~/.hermes-reflection/store.json
~/.hermes-reflection/reflections.jsonl
~/.hermes-reflection/resolved_questions.json
~/.hermes-reflection/sessions.db
~/.hermes-reflection/background_lifecycle.json
~~~

Back up this directory only when you intend to preserve user data. Do not put it in a public release. Version 19.3.0 reads existing v19.2.0 and v19.1.0 stores without a destructive migration.

## Development and verification

For a source checkout:

~~~powershell
npm ci
npx tsc --noEmit
npm run build
node scripts\smoke.mjs
node scripts\concurrency-test.mjs
node scripts\cross-process-concurrency-test.mjs
npm run test:v19.3
npm audit --omit=dev
~~~

All tests use temporary HOME/USERPROFILE locations and must not touch the real memory store.

## Privacy-safe release contents

The GitHub ZIP is assembled from an exact whitelist. It contains source, compiled JavaScript, tests, manifests, and public documentation only. It excludes user memory, SQLite databases, credentials, actual Codex configuration, logs, caches, dependencies, internal plans, project memory, backup trees, and local machine paths. The required guide aliases <code>readmecn.md</code> and <code>readmeen.md</code> are included.

## Troubleshooting

- If the server does not appear, confirm the absolute <code>dist/index.js</code> path, Node version, and restart the MCP client.
- If a session tool reports SQLite unavailable, run <code>npm ci --omit=dev</code> in the target environment and confirm the native better-sqlite3 binary supports that Node/platform combination.
- If snapshot reads fail, first capture/start the exact session id and pass both snapshot mode and that id.
- If a write returns PENDING, list the queue and explicitly approve or reject its id.
- If a lock timeout occurs, ensure no hung server owns the shared store. Locks older than the bounded stale threshold are quarantined automatically.

## Upstream inspiration and licensing

This project is inspired by a local source snapshot of NousResearch Hermes Agent's memory and reflection systems. Hermes Agent itself is not bundled in this package.

No project license is granted by this package. The upstream Hermes Agent license does not automatically license this separate implementation. A repository publisher must choose and include a license only when authorized to grant those rights.
