# Changelog

## 19.3.0 - 2026-07-22

### Added

- Added opt-in OpenAI-compatible LLM reflection review with bounded redacted requests, strict output validation, safe retry classes, and local mock coverage.
- Added an opt-in durable background scheduler with dirty-session tracking, unreferenced timers, cross-process leases, fencing tokens, unchanged-source skipping, and bounded shutdown.
- Added snapshot content fingerprints and live-change diagnostics.

### Fixed

- Prevented context handoffs from recursively selecting earlier assistant/user handoff blocks as current anchors.
- Preserved newest-first bounded reflection ordering and the legacy deterministic review source label.
- Fixed simultaneous Codex processes racing on first SQLite WAL/schema initialization.
- Closed the lease validation/apply TOCTOU window by holding the lifecycle state lock through automatic heuristic upsert.

### Security and compatibility

- Preserved exactly 28 public tools and existing v19.2 storage formats.
- LLM and background features are disabled by default; background auto-apply is a separate opt-in.
- Production dependency audit reports zero known vulnerabilities; the stdio-only package pins the patched Hono Node adapter through an override.

## 19.2.0 - 2026-07-10

### Added

- Restored `compact_session_context`, `list_pending_mutations`, and `approve_pending_mutation`; the public surface now contains 28 tools.
- Added explicit snapshot reads for Memory Board and User Profile.
- Added a two-process shared-store concurrency regression.

### Changed

- Memory threat auditing now scans raw imported entries while keeping unsafe text masked in normal output.
- Store mutations acquire an atomic cross-process lock and reload disk state before applying a working-copy mutation.
- Background review is bounded, deterministic, heuristic-only, and uses one atomic batch for auto-apply.
- Runtime support is documented as Node.js 20+.

### Fixed

- Fixed imported malicious memory records being hidden from the scanner by safe rendering.
- Fixed frozen snapshots having no public read path and silently falling back to live state.
- Fixed legacy write-approval stores pointing at hidden recovery tools.
- Removed unused drift/consolidation modules and the documentation claims that described them as active.

### Security and compatibility

- Existing v19.1.0 stores remain readable without destructive migration.
- Release archives exclude user memory, databases, credentials, internal plans, logs, dependencies, and local machine paths.

### Release contract

- Transport is local stdio MCP.
- Runtime data remains outside the package under `~/.hermes-reflection`.
- Session search uses better-sqlite3 and degrades with an explicit session-tool error if SQLite is unavailable.
- Lifecycle/session-turn capture requires explicit client calls.
- Compaction creates a deterministic reference-only handoff and does not control host context.
- Background review calls no LLM and writes no skills.
- The required standalone guides are `readmecn.md` and `readmeen.md`.
- No project license is included or granted by this package.
