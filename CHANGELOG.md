# Changelog

## 20.0.0 - 2026-07-29

### Agent-first interface

- Added a registry-driven 29-tool compatibility surface and an exact 10-tool core profile for Codex Desktop.
- Added `get_memory_item` for bounded detail retrieval and moved long-result tools to strict compact/full structured budgets with opaque continuation cursors.
- Reduced the recommended Codex configuration to the core profile and a single short reference-memory instruction.

### Memory and retrieval

- Added project-aware global-plus-project retrieval with locally salted HMAC project keys, deterministic ranking, heuristic feedback, and cross-process read synchronization.
- Added schema-2 migration, review-candidate audit state, strict authoritative-state decoding, and bounded detail/continuation retrieval.
- Added cross-store JSON/SQLite operation journaling for replace imports and clear operations, including startup rollback/commit completion and exact snapshot restoration.

### Review and lifecycle

- Added provider readiness, strict redacted LLM review, schema-validated candidates, single-flight requests, classified retries/failures, and guarded confidence-based auto-apply.
- Added non-blocking Codex lifecycle hook ingestion, durable deduplication, project binding, bounded background processing, and fresh-process restart recovery.
- Preserved deterministic review as the default and kept LLM review, scheduler startup, and automatic persistence as separate opt-ins.

### Verification and release

- Added Windows/Linux Node 20/22 CI, strict unused-symbol gates, v20 registry/budget/migration/retrieval/background/lifecycle/transaction suites, and compatibility coverage through v19.5.
- Added 20 sanitized Agent workflow cases with offline fixture grading and isolated fresh-process Codex grading; the live gate requires at least 18/20 with zero destructive-tool calls.
- Added package hygiene, production audit, install/rollback documentation, and Agent-first configuration guidance.

## 19.5.0 - 2026-07-27

### Added

- Add optional `response_mode: "compact" | "full"` to 13 long-result tools; compact is the default and full preserves complete diagnostic detail.
- Add an isolated stdio regression suite that enforces the 28-tool surface, metadata budgets, compact/full semantics, complete errors, deterministic output, non-duplication, and response savings.

### Changed

- Reduce server-wide instructions from 5,288 to 421 characters. Schema-inclusive simulated Codex metadata is 33,100 characters, within the 35,000-character budget.
- Compact deterministic fixtures use 2,513 characters versus 4,568 in full mode, a 45.0% reduction.
- Preserve complete Memory Board/User Profile text while omitting redundant snapshot wrapper metadata in compact mode.
- Preserve full structured v19 error payloads, including identifiers and navigation fields, rather than returning only the top-level message.

### Compatibility

- Preserve exactly 28 public tools, all existing required inputs, storage formats, ranking/write behavior, lifecycle controls, and opt-in LLM/background settings.
- No database migration, production dependency, or global Codex limit change is required. Clients that parse verbose text can request `response_mode: "full"`.

## 19.4.1 - 2026-07-26

### Fixed

- Reject unsupported, structurally invalid, oversized, or lossy `background_lifecycle.json` state without overwriting the active file; preserve idempotent corrupt evidence.
- Reclaim expired leases regardless of the old owner's PID, reclaim unexpired same-host leases only when the PID is confirmed dead, and keep remote or uncertain owners until TTL.
- Renew long background reviews immediately and periodically using the exact original owner and fencing token. Renewal never inserts a lease or allocates a replacement fence.
- Bound transient renewal failures by the last confirmed lease expiry, stop before commit on definitive ownership loss, and make shutdown wait for refresher quiescence before the active run releases its fence.
- Reject malformed completed-review fingerprints before mutation, bound reviewed-session history to the supported 100 entries, and reject exhausted fencing-token space before it can produce invalid state.
- Keep lifecycle, refresher, and shutdown-drain timers unreferenced and clear completed drain timers so they do not keep Codex Desktop alive.

### Compatibility

- Preserve exactly 28 public MCP tools, valid v19.4/v19.3 state, the existing schema version, and all opt-in LLM/background settings. No production dependency or data migration was added.

## 19.4.0 - 2026-07-26

### Fixed

- Refuse mutations when an existing authoritative JSON/JSONL file is unreadable, syntactically corrupt, or has an invalid root shape; missing files remain valid first-run initialization.
- Preserve one content-addressed corrupt evidence backup without treating that backup as permission to overwrite the active store from an empty view.
- Keep the last known-good target intact when bounded Windows rename retries fail.
- Make corrupt background lifecycle state fail closed so dirty sessions and fencing state are not silently reset.
- Enforce both UTF-16 and Unicode-safe compaction budgets without splitting surrogate pairs.

### Added

- Add optional `preserve_recent_user_turns` (1-5, default 3) to deterministic reference-only session handoffs.
- Add v19.4 regression coverage for storage corruption, idempotent evidence backups, replacement failure, background state, multi-user anchors, and Unicode budgets.

### Compatibility

- Preserve exactly 28 public MCP tools, existing data formats, opt-in LLM review/background lifecycle, and all v19.3 strict-redaction behavior. No production dependency or migration was added.

## 19.3.1 - 2026-07-23

### Fixed

- Added strict URL credential redaction at historical, automatic-derived, and external LLM boundaries.
- Preserved the latest nonblank user and assistant compaction anchors.
- Bounded scroll output to 4,000 Unicode code points for the anchor and 1,200 for neighboring turns, with optional truncation metadata.
- Made background review fingerprints content-aware while ignoring credential-only value changes after strict redaction.
- Sanitized direct, batch, deterministic, and LLM-derived heuristic candidates before persistence.
- Retried transient Windows `EPERM`/`EACCES` lock-creation contention instead of dropping background lifecycle dirty notifications.

### Security and compatibility

- Preserved raw reflections, SQLite turns, explicit heuristic writes, existing v19.3.0/v19.2 storage, opt-in LLM/background settings, and exactly 28 public tools.
- Added no production dependency and requires no data migration.

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
