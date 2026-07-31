# Installing Hermes Reflection MCP v20.0.0

This guide installs the local stdio MCP with the Agent-first 10-tool Codex profile. Node.js 20 or newer is required.

## Clean installation

1. Verify the release ZIP SHA-256 shown on the GitHub release.
2. Extract it into a new empty staging directory.
3. Confirm it contains source, built JavaScript, tests/evals, CI, and public docs only. It must not contain `.env`, `config.json`, `.git`, `node_modules`, `mem.md`, logs, databases, indexes, caches, bytecode, or user memory.
4. Install native dependencies on the target machine:

```powershell
npm ci --omit=dev
```

The release contains `dist/`; production installation does not need TypeScript. Never reuse `node_modules` from another OS, Node version, computer, or older installation.

Suggested install directories:

| Platform | Path |
|---|---|
| Windows | `C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp` |
| macOS | `/Users/<YOU>/.codex/mcp/hermes-reflection-mcp` |
| Linux | `/home/<YOU>/.codex/mcp/hermes-reflection-mcp` |

## Codex Desktop configuration

Merge [`codex_config_snippet.toml`](codex_config_snippet.toml) into the Codex configuration and replace `<YOU>`. The required Agent-first settings are:

```toml
[mcp_servers.hermes-reflection]
type = "stdio"
command = "node"
args = ['C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js']
enabled = true
enabled_tools = ["retrieve_heuristics", "reflect_on_task", "search_reflections", "get_open_questions", "get_memory_item", "compact_session_context", "memory_board_read", "memory_board_write", "session_lifecycle_hook", "trigger_background_review"]
instructions = "Use Hermes as reference memory: retrieve before substantial work and reflect afterward. Never store secrets."
```

Restart Codex Desktop after any code, tool-profile, instruction, or environment change. A running MCP process cannot replace its own loaded code and the client may cache tool metadata for the process lifetime.

## Optional background lifecycle

Set MCP environment values only if you want automatic background review:

```toml
[mcp_servers.hermes-reflection.env]
HERMES_REFLECTION_BACKGROUND_ENABLED = "true"
HERMES_REFLECTION_BACKGROUND_REVIEW_MODE = "auto"
HERMES_REFLECTION_BACKGROUND_AUTO_APPLY = "false"
```

For automatic LLM review, inject a dedicated provider key through the MCP process environment and also set:

```text
HERMES_REFLECTION_LLM_ENABLED=true
HERMES_REFLECTION_LLM_BASE_URL=https://provider.example/v1
HERMES_REFLECTION_LLM_MODEL=your-model
HERMES_REFLECTION_LLM_API_KEY=<dedicated-provider-key>
```

Do not commit provider keys. The MCP never obtains or reuses Codex authentication. Keep auto-apply false until deterministic and LLM preview results are reviewed. Auto-apply remains blocked when write approval is enabled.

## Optional Codex lifecycle hook

Configure the client to pass JSON hook events to:

```text
node <install-dir>/dist/src/codex_hook_cli.js
```

Supported events are `SessionStart`, `Stop`, `SessionEnd`, `PreCompact`, and `PostCompact`. The hook writes a bounded durable inbox and exits promptly. The MCP process consumes those events; the hook does not control Codex execution state. Direct integrations may call `session_lifecycle_hook` instead.

## Validation

For a source checkout or staging install with development dependencies:

```powershell
npm ci
npm run test:strict
npm run build
npm run smoke
npm run test:regressions
npm run test:v19.3
npm run test:v19.4
npm run test:v19.4.1
npm run test:v19.5
npm run test:v20
npm run test:concurrency
npm run test:v20:agent-fixture
npm pack --dry-run --json
npm audit --omit=dev
```

Expected v20 gates:

- exactly 29 complete public tools;
- exact 10-tool core profile;
- server instructions no more than 512 code points;
- core profile schema-inclusive metadata no more than 15,000 characters;
- compact/full hard budgets of 6,000/24 KiB and 20,000/80 KiB;
- no destructive-tool use in the 20-case Agent evaluation;
- no known production dependency vulnerability;
- no stale locks, operation journals, caches, or unrelated runtime artifacts.

Run `npm run test:v20:agent` separately when the local Codex CLI and model access are available. It launches 20 isolated fresh processes, requires at least 18/20 passes, and fails on any destructive-tool call.

## Data, transfers, and migration

User state remains outside the code directory at `~/.hermes-reflection`. Default transfer roots are:

```text
~/.hermes-reflection/transfers/imports
~/.hermes-reflection/transfers/exports
```

Use `HERMES_TRANSFER_IMPORT_ROOTS` and `HERMES_TRANSFER_EXPORT_ROOTS` only for explicit additional allow-listed roots. Safe export is redacted by default; raw export requires explicit sensitive confirmation.

v20 migrates supported older stores to schema 2 under a lock. It fails closed on future or corrupt authoritative state and preserves evidence. Replace import and clear operations journal JSON plus logical SQLite state so startup can roll back a pre-commit interruption or complete an interrupted commit.

## Upgrade and rollback

1. Stop Codex Desktop and any standalone MCP process.
2. Back up the current installed code directory to a dated sibling path.
3. Back up `~/.hermes-reflection` separately; never put it into the release directory.
4. Install the v20 release into a clean staging directory and run validation.
5. Switch the stable install path or Codex configuration only after validation passes.
6. Start a fresh Codex Desktop process and confirm the 10-tool surface.

If validation or startup fails, stop Codex, restore the previous code directory and its matching `~/.hermes-reflection` backup, then restart. Do not combine a partially migrated data directory with an older executable.
