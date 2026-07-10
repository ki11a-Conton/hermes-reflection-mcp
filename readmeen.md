# Hermes Reflection MCP v19.2.0 English Guide

Hermes Reflection MCP is a local stdio MCP server with 28 public tools for persistent task reflections, heuristics, bounded Memory Board/User Profile data, and searchable sessions. It does not upload user data.

## Requirements

- Windows, macOS, or Linux
- Node.js 20 or newer
- npm
- A client that supports stdio MCP servers

Session recall depends on better-sqlite3. If the native module cannot initialize, session tools return a clear unavailable error; reflection, heuristic, JSON memory, and import/export tools continue to work.

## Codex Desktop installation

1. Extract the ZIP into a clean directory that contains no user data.
2. Run <code>npm ci --omit=dev</code> in the extracted directory.
3. Place the project at <code>%USERPROFILE%\.codex\mcp\hermes-reflection-mcp</code>, or use your own absolute path in the configuration.
4. Add:

~~~toml
[mcp_servers.hermes-reflection]
command = 'node'
args = ['C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js']
~~~

5. Restart Codex Desktop so a new MCP process loads v19.2.0.

Installing this MCP does not make Codex Desktop call session_lifecycle_hook or append_session_turn automatically. Lifecycle, snapshot, and session-turn capture require explicit client calls.

## Verification

After installing production dependencies, run these commands from the project directory:

~~~powershell
node scripts\smoke.mjs
node scripts\concurrency-test.mjs
node scripts\cross-process-concurrency-test.mjs
~~~

Expected results: smoke reports v19.2.0 and 28 public tools; the single-process test passes; the cross-process test preserves exactly 40 heuristics and 40 reflections. Tests use temporary user profiles and do not write to the real <code>~/.hermes-reflection</code> directory.

For source development, install development dependencies and run:

~~~powershell
npm ci
npx tsc --noEmit
npm run build
~~~

## Recommended workflow

1. Call <code>retrieve_heuristics</code> before significant work.
2. Explicitly call <code>append_session_turn</code> when persistent conversation recall is wanted.
3. Optionally call <code>session_lifecycle_hook(event:"start")</code> at session start to capture a frozen snapshot.
4. For frozen memory reads, pass both <code>mode:"snapshot"</code> and the same <code>session_id</code> to memory_board_read or user_profile_read. Missing snapshots fail instead of falling back to live content.
5. Before client-side compaction or handoff, call <code>compact_session_context</code> for a historical reference-only summary. It does not control Codex's context window.
6. After meaningful work, call <code>reflect_on_task</code>; optionally preview <code>trigger_background_review</code> candidates.
7. Background review calls no model and writes no skills. It only derives heuristic candidates from stored reflections.
8. If write approval is enabled, inspect redacted previews with <code>list_pending_mutations</code>, then approve or reject an id with <code>approve_pending_mutation</code>.

## Data and privacy

Runtime data is stored in <code>~/.hermes-reflection</code>, including JSON/JSONL records and the local SQLite session index. The release ZIP excludes that directory as well as user configuration, logs, databases, dependencies, internal plans, local machine paths, and credentials.

Before sharing an archive, compare its SHA-256 and exact file manifest with the publisher's values. Never copy a real config.toml, environment file, or user memory into the project directory.

## Licensing

No project license is included or granted by this package. A repository publisher must choose a license separately and only when authorized to grant those rights. The upstream Hermes Agent license does not automatically become the license for this project.

This implementation is inspired by the memory and reflection systems in a local source snapshot of NousResearch Hermes Agent. Hermes Agent is not bundled.
