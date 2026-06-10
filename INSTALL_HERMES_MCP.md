# Hermes Reflection MCP v14.0.0 Agent Install Guide

This package contains a ready-to-run stdio MCP server for Codex Desktop and other MCP clients. It is written for agents or humans who need to install Hermes Reflection MCP into their own local Codex profile.

## Requirements

- Node.js 18 or newer.
- A Codex Desktop profile directory, usually:

```text
C:\Users\<YOU>\.codex
```

## Files In This Package

- `dist/` - compiled JavaScript entrypoint.
- `package.json` and `package-lock.json` - dependency manifest.
- `README.md` and `CHANGELOG.md` - tool reference and release notes.
- `scripts/smoke.mjs` - reusable temporary-profile MCP smoke test.
- `codex_config_snippet.toml` - example Codex Desktop config.
- `index.ts`, `storage.ts`, `types.ts` - source files for review or rebuild.

## Install

1. Extract the package to a stable directory, for example:

```text
C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp
```

2. Install production dependencies from inside that directory:

```powershell
npm ci --omit=dev
```

3. Add or update this block in `C:\Users\<YOU>\.codex\config.toml`:

```toml
[mcp_servers.hermes-reflection]
type = "stdio"
command = "node"
args = ['C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js']
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 300
```

4. Restart Codex Desktop.

For another agent: do not copy `node_modules` from the zip producer's machine. Run `npm ci --omit=dev` locally after extraction so the dependency tree matches the target machine.

## Verify

Run this from the package directory. It uses a temporary profile directory so it does not modify the real memory store.

```powershell
$tmp = Join-Path $env:TEMP ("hermes-smoke-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$env:HOME = $tmp
$env:USERPROFILE = $tmp
node dist/index.js
```

Then send MCP JSON-RPC over stdio from your client:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

Expected results:

- `initialize` returns server version `14.0.0`.
- `tools/list` returns 37 tools.
- `get_session_summary`, `get_open_questions`, `get_world_model`, `get_reflection_timeline`, `get_heuristic_history`, `diff_reflections`, and `get_store_health` are present and marked read-only.
- `list_reflections` and `get_heuristic_stats` are present and marked read-only.
- `resolve_affordance_gap` is present and mutating.
- `merge_heuristics`, `pin_heuristic`, and `snapshot` are present and mutating.
- `retrieve_heuristics`, `export_data`, and `export_project_experience_md` are marked mutating because retrieval records usage stats and export tools can write files.
- `retrieve_heuristics` persists retrieval stats before returning, so an immediate `export_data(collection:"heuristics")` can see the updated `retrieval_count`.
- `node scripts/concurrency-test.mjs` passes when dev dependencies are installed.
- `export_project_experience_md` supports limit-only recent exports.
- `get_reflection_timeline` shows `oldest first` in its header and reports unresolved question counts.
- `resolve_open_question` survives concurrent calls without dropping resolved overlay entries.
- `retrieve_heuristics`, `list_heuristics`, `search_heuristics`, `search_reflections`, and `list_reflections` support `tag_mode:"and"|"or"` for multi-tag filters.
- `bulk_retrieve_heuristics` retrieves heuristics for multiple task descriptions in one call.
- `update_reflection` can correct reflection `domain`, `tags`, and `lessons_learned`, with optional heuristic re-extraction.
- `export_project_experience_md` supports `tag_mode:"and"|"or"` for multi-tag filters.
- `get_reflection` supports `apply_resolved_overlay:false` to inspect raw open-question state.
- `reflect_on_task(dry_run:true)` validates and previews a reflection without writing to disk.
- `snapshot` can create a timestamped recovery point before `clear_data` or `import_data(mode:"replace")`.
- `pin_heuristic` protects critical active heuristics from automatic pruning.
- `export_project_experience_md` supports `format:"markdown"`, `format:"plaintext"`, and `format:"json"`.
- `get_domain_summary` reports one-domain detail or a ranked domain list and supports `include_open_questions_detail:true`.
- `export_project_experience_md(include_raw_reflections:true)` hides resolved open questions in raw reflection sections.
- `list_reflections` supports filters and offset pagination.
- `get_heuristic_stats` reports confidence distribution and domain breakdown.
- `get_store_health` reports `suspicious_heuristics`, and `get_heuristic_stats` reports `Suspicious active`.
- Normal tool output masks suspicious heuristic text; use `export_data(collection:"heuristics")` only when an explicit audit of raw imported records is needed.
- `merge_heuristics` archives source heuristics and records them in the target's `supersedes` chain.
- Legacy reflection imports missing newer optional arrays are normalized and should not crash `import_data` or read tools.

If the package includes source and dev dependencies are installed, agents can also run:

```powershell
npm run smoke
```

The smoke command builds the server and runs MCP checks with temporary `HOME` and `USERPROFILE`.

## Data Store

By default, data is stored at:

```text
~\.hermes-reflection\store.json
~\.hermes-reflection\reflections.jsonl
```

For tests, set `HOME` and `USERPROFILE` to a temporary directory before starting the server.

## Safety Notes For Agents

- Do not put credentials or private config values in reflections or heuristics.
- Do not auto-approve `clear_data`; it is destructive and requires `confirm:true`.
- Use `export_data` before risky migrations.
- Use temporary `HOME` and `USERPROFILE` values for smoke tests so the target user's real `~\.hermes-reflection` memory is not modified.
- If you package or redistribute this MCP, use a whitelist copy strategy and exclude local memory, task files, caches, logs, `node_modules`, and machine-specific paths.
