# Changelog

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
