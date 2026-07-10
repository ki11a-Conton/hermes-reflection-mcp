# Installing Hermes Reflection MCP v19.2.0

This guide installs the local stdio server without copying user memory or machine-specific dependencies. Node.js 20 or newer is required.

## Clean extraction

1. Verify the release ZIP SHA-256 against the publisher's value.
2. Extract into a new empty staging directory.
3. Confirm the archive contains public source/build/docs only. It must not contain <code>.hermes-reflection</code>, <code>node_modules</code>, an actual Codex config, logs, databases, or environment files.
4. Install native production dependencies on the target machine:

~~~powershell
npm ci --omit=dev
~~~

Do not reuse node_modules from another computer, operating system, Node version, or older installation.

## Install locations

Suggested locations:

| Platform | Example |
|---|---|
| Windows | <code>C:\Users\&lt;YOU&gt;\.codex\mcp\hermes-reflection-mcp</code> |
| macOS | <code>/Users/&lt;YOU&gt;/.codex/mcp/hermes-reflection-mcp</code> |
| Linux | <code>/home/&lt;YOU&gt;/.codex/mcp/hermes-reflection-mcp</code> |

The location may be changed, but the MCP configuration must point to that installation's <code>dist/index.js</code>.

## Codex Desktop configuration

Windows:

~~~toml
[mcp_servers.hermes-reflection]
command = 'node'
args = ['C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js']
~~~

macOS:

~~~toml
[mcp_servers.hermes-reflection]
command = 'node'
args = ['/Users/<YOU>/.codex/mcp/hermes-reflection-mcp/dist/index.js']
~~~

Linux:

~~~toml
[mcp_servers.hermes-reflection]
command = 'node'
args = ['/home/<YOU>/.codex/mcp/hermes-reflection-mcp/dist/index.js']
~~~

Restart Codex Desktop after adding or changing the entry. A running MCP process does not replace itself when files change.

## Installed validation

From the installed code directory, run:

~~~powershell
node scripts\smoke.mjs
node scripts\concurrency-test.mjs
node scripts\cross-process-concurrency-test.mjs
~~~

The direct smoke works with production dependencies because it runs the compiled <code>dist</code> entrypoint. Expected: version 19.2.0, exactly 28 public tools, and passing single/cross-process concurrency checks.

For a source checkout with development dependencies, also run:

~~~powershell
npx tsc --noEmit
npm run build
~~~

## Client-driven lifecycle and session capture

Installation alone does not record Codex conversations or create snapshots. The client must explicitly:

- call <code>append_session_turn</code> for each turn it wants indexed;
- call <code>session_lifecycle_hook</code> or <code>capture_memory_snapshot</code> for a named session;
- pass <code>mode:"snapshot"</code> and that <code>session_id</code> when reading a frozen Memory Board/User Profile;
- call <code>compact_session_context</code> when it wants a deterministic historical handoff.

The compaction handoff is reference only and does not control Codex's host context.

## Upgrade

1. Stop or restart the MCP client so the old server process releases its files.
2. Back up the installed code directory to a separate sibling directory.
3. Keep <code>~/.hermes-reflection</code> in place. It is runtime user data, not release code.
4. Extract v19.2.0 into a new clean directory.
5. Run <code>npm ci --omit=dev</code> there.
6. Run the installed validation commands.
7. Replace the configured code path or move the validated directory into the stable install location.
8. Restart Codex Desktop and confirm the server reports v19.2.0.

Never copy old node_modules into the new installation, and never copy <code>~/.hermes-reflection</code> into the code directory. Existing v19.1.0 stores remain readable.

## Rollback

If validation fails:

1. Stop the new MCP process by restarting/exiting the client.
2. Preserve the failed code directory for diagnosis; do not delete user memory.
3. Restore the previous installed code directory or point the configuration back to its <code>dist/index.js</code>.
4. Run <code>npm ci --omit=dev</code> in the restored directory if its node_modules were not preserved.
5. Restart Codex Desktop.

Code rollback and data rollback are separate operations. Restore a <code>~/.hermes-reflection</code> backup only when you intentionally want to revert user data.

## Common failures

- “Server not found”: verify the absolute path and that <code>dist/index.js</code> exists.
- “Node not found” or unsupported syntax: install Node.js 20+ and ensure Codex sees the same PATH.
- SQLite/session unavailable: reinstall production dependencies on the target machine and confirm better-sqlite3 supports its Node ABI.
- Snapshot not found: capture/start the exact session id before requesting snapshot mode.
- PENDING write: inspect the redacted queue and explicitly approve or reject the mutation.

## Privacy and licensing

The release archive must exclude user memory, databases, credentials, actual configuration, logs, caches, dependencies, internal plans, and local machine paths.

No project license is included or granted in this package. The upstream Hermes Agent license does not automatically license this separate implementation.
