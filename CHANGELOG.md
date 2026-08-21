# Changelog

## 22.1.0 - 2026-08-16

### MCP-managed Skill promotion

- Added deterministic complete-link promotion of repeated successful procedures, with exact-scope evidence, contradiction/harm/transient-state gates, stable fingerprints, bounded LLM synthesis, and deterministic fallback.
- Added durable Skill records, audited revisions, approval-bound candidates, duplicate/supersession limits, atomic create/update application, and idempotent rollback that refuses newer-revision overwrite. Newly created skills are disabled when rolled back.
- Added cancellable, same-scope single-flight promotion to the existing fenced background lifecycle. Automatic provider work stays disabled when the scheduler is disabled; manual review processes eligible promotion under the same lease.

### Agent-first MCP integration

- Added at most two compact active Skill references to heuristic retrieval without exposing full procedure steps. `get_memory_item` now supports bounded, scope-authorized `skill` and `skill_candidate` detail with historical safety and stale-cursor checks.
- Extended the existing approval tool with typed Skill approval, rejection, and rollback routing; no public tool was added. The MCP never writes external Skill files or executes learned procedures.
- Preserved the exact ordered 10-tool core profile, all 29 registered compatibility tools, store schema 2, compact/full response budgets, and provider-compatible public JSON Schema. The reviewed public contract hash is `a1165d06e2fcee90ce3af574860cd634ec51017cfa80d2b675ec1a4ef3302b26`.

### Verification

- Added focused Skill model, clustering, synthesis/transport, storage, lifecycle, and MCP subprocess suites covering restart, fencing loss, shutdown cancellation, scope isolation, provider fallback, approval races, rollback, response budgets, and OpenCode schema compatibility.

## 22.0.0 - 2026-08-13

### Portable learning core

- Added a strict host-independent lifecycle event model, deterministic identity hashing, replay/conflict classification, and an injected side-effect dispatcher.
- Moved Codex hook mapping and direct MCP lifecycle mapping behind adapters while preserving the 10-tool Agent-first and 29-tool compatibility profiles.
- Added a unified internal Memory / Heuristic / Skill model with traceable evidence, evidence-aware confidence projection, and a persistence-free skill-candidate state machine.

### Compatibility and safety

- Replaced provider-incompatible public metadata regex patterns with runtime refinements, fixing OpenCode/provider schema rejection without weakening CR/LF/NUL validation.
- Added frozen public-tool compatibility, provider-schema, fake-host lifecycle parity, learning-model, fingerprint-integrity, and candidate-transition tests.
- Kept v21 storage formats and public MCP behavior compatible; skill candidates are internal only and cannot apply or execute learned content.

## 21.1.0 - 2026-08-12

### Codex lifecycle and privacy

- Corrected `Stop` to be a turn boundary only; `SessionEnd` is now the sole teardown and background-review scheduling event.
- Accepted official `PreCompact`/`PostCompact` shapes without private metadata, separated observations from trustworthy receipts, and refreshed frozen context only after `PostCompact`.
- Strengthened derived event identity with turn IDs, triggers/status, and normalized content hashes while keeping lifecycle mutations replay-safe.
- Added explicitly opt-in, 12,000-code-point per-side prompt/assistant capture with strict redaction/threat blocking, atomic pairing, replay/conflict handling, expiry cleanup, and no `transcript_path` reads.

### Agent cost and review lifecycle

- Reduced omitted-limit heuristic retrieval from ten to three compact records, removed redundant compact projection fields, and tightened first-512 server guidance around live-source priority and negative-use cases.
- Limited automatic LLM input to the latest ten scoped reflections and 24,000 serialized characters; captured turns are excluded.
- Added provider-semantic review fingerprints, unchanged source/model suppression, explicit LLM-mode configuration cooldowns, bounded retry/cancellation, and shutdown lease release. Candidates remain approval-pending by default.

### Installation and compatibility

- Added a structural Codex `hooks.json` installer with dry-run, timestamped backup, atomic replacement, exact Hermes command cleanup, and preservation of unrelated handlers/order.
- Kept the exact ordered 10-tool Agent-first profile, all 29 compatibility tools, main store schema 2, and in-place v21 session database migration.
- Added focused v21.1 hook, storage, lifecycle, context/review, and installer regressions plus release-package coverage.

## 21.0.0 - 2026-08-09

### Agent-first safety and compatibility

- Preserved the exact ordered 10-tool default profile and exact 29-tool unique compatibility surface.
- Tightened missing, conflicting, stale, and cross-project session-scope failures so they return structured errors without mutation.
- Added optional reflection idempotency keys with durable bounded receipts, replay equivalence, conflict detection, and restart-safe garbage collection.

### Lifecycle, review, and recovery

- Added a bounded hook inbox pump with a verified polling contract of no more than five seconds and a default no more than one second; no throughput or end-to-end latency claim is made.
- Added strict `PostCompact` metadata, durable hashed receipts, replay/conflict checks, restart persistence, and deterministic current-request/reverse-signal handoffs.
- Added forward transaction recovery for reflection, heuristic, feedback, and approval writes. Committing recovery consumes a bounded durable receipt instead of replaying mutations.
- Revalidated LLM candidates under the authoritative lock against exact scope, evidence, freshness, content identity, approval state, and fencing tokens to prevent mislearning and close TOCTOU windows.

### Operations

- Kept deterministic review available while LLM review, background lifecycle, and automatic persistence remain separately configurable.
- Documented clean staging, separate code/data backup, migration validation, and matched code/data rollback while retaining the v20 compatibility layer and store schema 2.
- Refreshed the locked `fast-uri`, `hono`, and `ip-address` transitive dependencies to audited versions that remove known production advisories.
- Updated the current regression harness to use explicit session scope, close SQLite on every exit path, and assert malformed overlay writes fail closed.
- Made GitHub CI latest-first for v21 and kept historical compatibility suites opt-in instead of release-blocking.
- Hardened the v21 Windows operation lock against transient `lstat` sharing violations with a wall-clock attempt deadline, and made the current cross-platform harness use contention-confirmed, self-releasing Windows-only probes plus bounded, root-cause-preserving process cleanup.

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
