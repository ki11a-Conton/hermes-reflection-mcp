# Changelog

## v14.0.0

### Performance

- `upsertHeuristicMut` now stores direct heuristic references in the
  write-lifetime dedup cache, removing the post-Jaccard `find(...)` scan.
- Empty-query `search_reflections` and `list_reflections` now reuse cached
  reflection order information instead of checking order on every call.
- `getReflectionTimeline`, `getOpenQuestions`, `getReflectionSummary`,
  `getDomainSummary`, `pruneHeuristicsMut`, and `checkStoreHealth` now avoid
  avoidable full sorts or temporary arrays on hot paths.
- Tag filters now use normalized tag-set indexes for heuristics and
  reflections.

### Additions

- Added `bulk_retrieve_heuristics` for batched lesson retrieval across multiple
  task descriptions with deduplicated retrieval-stat increments.
- Added `update_reflection` for correcting mutable reflection metadata and
  optionally re-extracting heuristics from corrected lessons.
- `get_domain_summary` now supports `include_open_questions_detail:true`.

### Tests

- `scripts/smoke.mjs` now validates the 37-tool surface and covers
  `bulk_retrieve_heuristics`, `update_reflection`, and detailed domain open
  questions.

### Tool Count

- 35 -> 37 tools with `bulk_retrieve_heuristics` and `update_reflection`.

## v13.0.0

### Performance

- `getHeuristicStats` now maintains top retrieval and reinforcement lists with
  `insertSorted(...)` instead of repeated `push/sort/pop`.
- `getCachedResolvedQuestions` now trusts the in-process cache inside the TTL
  window and only re-stats after expiry.
- Store-index persistence now uses a dirty-flag path instead of serializing a
  comparison snapshot on every write.
- Affordance-gap upserts now use a write-lifetime capability index instead of
  repeatedly scanning every gap.
- Empty-query `search_reflections` and `list_reflections` now reuse
  newest-first slicing for already ordered reflections.
- `get_open_questions` applies `priority` filtering before constructing
  result objects.
- Search hot paths now cache heuristic and reflection search text.

### Additions

- `reflect_on_task` now supports `dry_run:true` for validation and preview
  without persisting data.
- `export_project_experience_md` now supports `tag_mode:"and"|"or"` for
  multi-tag filter parity.
- Added `get_domain_summary`, a read-only domain activity summary tool.

### Tests

- `scripts/smoke.mjs` now validates the 35-tool surface and covers
  `get_domain_summary`.

### Tool Count

- 34 -> 35 tools with `get_domain_summary`.

## v12.0.0

### Performance

- `upsertHeuristicMut` now uses a write-lifetime domain/token dedup cache so bulk reflection writes avoid repeated full candidate tokenization.
- Affordance-gap writes now get `isNew` from `upsertAffordanceGapMut`, avoiding duplicate scans and preserving session gap counts.
- `checkStoreHealth` finds the largest reflection with a linear scan instead of sorting the full size array.
- `generateProjectExperienceMarkdown(session_id)` now uses the cached session index.
- `getSessionSummary` keeps only top candidates and uses cached session heuristic counts.
- `getHeuristicStats` computes active, archived, suspicious, domain, and top-list data in one pass.
- Resolved-question writes reuse a serialized write cache, and store reads trust the short-lived in-process cache within the TTL before doing file-size checks.

### Additions

- `search_reflections` and `list_reflections` now support `tag_mode:"and"|"or"`.
- `get_reflection` now accepts `apply_resolved_overlay:false` to inspect raw open-question state.
- Added `snapshot`, a mutating recovery tool that copies `store.json`, `reflections.jsonl`, and `resolved_questions.json` to a timestamped backup directory.

### Tests

- `scripts/smoke.mjs` now covers bulk dedup, duplicate affordance-gap session counts, largest-reflection health reporting, reflection OR tag filters, raw/overlay `get_reflection`, and snapshot file creation.

### Tool Count

- 33 -> 34 tools with `snapshot`.

## v11.0.1

### Bug Fixes

- `import_data(mode:"merge")` now strips resolved open-question fields from imported reflections before persisting `reflections.jsonl`, keeping resolved state in `resolved_questions.json` overlay storage.
- `scripts/smoke.mjs` now covers merge-imported resolved open questions and verifies the JSONL reflection log stays free of embedded resolved-state fields.

## v11.0.0

### Performance

- `mutateStore` now reuses a serialized in-process mutation store and refreshes the read cache after successful writes, avoiding repeated cold JSONL reloads on write-heavy workflows.
- Resolved open-question overlays now use a short-lived cache with invalidation after `resolve_open_question`, `import_data`, and reflection clears.
- `get_store_health`, `get_reflection_summary`, `get_world_model`, `get_reflection_timeline`, and search hot paths now avoid avoidable full scans, full sorts, or repeated tokenization where possible.
- `import_data` no longer relies on mutable outer closure variables for resolved-question follow-up state.

### Additions

- `retrieve_heuristics` now supports `tag_mode:"and"|"or"`. The default remains `and` for backward compatibility.
- Added `pin_heuristic`, a mutating tool that pins or unpins active heuristics so critical lessons can be protected from automatic pruning.
- `export_project_experience_md` now supports `format:"markdown"`, `format:"plaintext"`, and `format:"json"` for RAG-friendly exports.

### Tests

- `scripts/smoke.mjs` now checks tag-mode retrieval, pinned prune protection, plaintext export, JSON export, and plaintext file output.

### Tool Count

- 32 -> 33 tools with `pin_heuristic`.

## v10.0.2

### Bug Fixes

- `reflect_on_task` immediate responses now mask suspicious lesson text with the same safe output formatter used by read tools, while preserving raw lessons in the reflection audit log.
- `get_store_health` output now includes `suspicious_heuristics: N`.
- `get_heuristic_stats` output now includes `Suspicious active: N`.
- `scripts/smoke.mjs` now covers suspicious lesson masking, clean suspicious count zero, imported suspicious heuristic count one, and no raw suspicious text in normal health/stats output.

## v10.0.1

### Bug Fixes

- Legacy reflection records are now normalized when loaded from old combined stores, `reflections.jsonl`, and `import_data` replace/merge paths. Older snapshots missing newer array fields such as `open_questions`, `context_forget`, `world_model_updates`, `tool_insights`, `affordance_gaps`, or expanded `task_state` lists no longer crash import or read tools.
- `scripts/smoke.mjs` now includes a regression case for importing a minimal legacy reflection and reading it through `get_reflection`, `get_session_summary`, and `list_reflections`.

## v10.0.0

### Bug Fixes

- `retrieve_heuristics` now computes ranking and updates `retrieval_count` / `last_retrieved_at` inside one serialized store mutation, avoiding lost updates during concurrent writes.
- Heuristic pruning now triggers whenever the store exceeds `HEURISTIC_MAX_COUNT`, regardless of whether the current reflection contains extracted lessons.
- `pruneHeuristicsMut` Phase 1 now bases its early-exit condition on active heuristic count instead of total heuristic count, preventing archived cleanup from masking an active over-cap store.
- `search_reflections` now documents the supported `query:""` browse behavior in both tool and parameter descriptions.
- `diff_reflections` uses a less brittle lesson similarity threshold so short near-equivalent lessons are kept in `lessons.unchanged`.

### Improvements

- `get_world_model` now uses polarity and normalized-prefix buckets to reduce semantic-dedup comparisons while preserving same-polarity deduplication semantics.
- Read-only store tools now share a short-lived in-process cache with `store.json` and `reflections.jsonl` size validation; mutating writes invalidate the cache before returning.
- `get_session_reflections` and `get_session_summary` now use a session index from the cached store instead of scanning every reflection.
- Added `scripts/concurrency-test.mjs` to stress mixed `retrieve_heuristics` and `reflect_on_task` calls with a temporary profile.
- `scripts/smoke.mjs` now covers `list_reflections`, `get_heuristic_stats`, and `merge_heuristics`.

### Additions

- **list_reflections** tool: read-only filtered reflection browsing with domain, outcome, failure_mode, tags, session_id, since_days, limit, and offset.
- **get_heuristic_stats** tool: read-only heuristic quality statistics, including confidence distribution, domain breakdown, stale/never-retrieved counts, and top heuristics by retrieval and reinforcement.
- **merge_heuristics** tool: mutating manual consolidation for near-duplicate lessons. Sources are archived with `superseded_by`, and the target absorbs tags, reinforcement, contradiction counts, and contradiction notes.

### Tool Count

- 29 -> 32 tools with `list_reflections`, `get_heuristic_stats`, and `merge_heuristics`.

## v9.0.0

### Bug Fixes

- `mutateResolvedQuestions` now persists `resolved_questions.json` inside the mutation helper instead of relying on each caller to remember `saveResolvedQuestions`.
- `get_world_model` now removes stale exact-key mappings when semantic deduplication replaces an existing fact.
- `get_world_model` now only semantically deduplicates facts with the same polarity, so affirm and negate facts remain independently visible.
- `export_project_experience_md(include_raw_reflections:true)` now hides resolved open questions in raw reflection sections.
- `pruneHeuristicsMut` now records Phase 1 removals explicitly instead of inferring them from later list lengths.

### Improvements

- World-model fact similarity now normalizes compact time units such as `30s` and `30 seconds`.
- `scripts/smoke.mjs` now covers resolved open questions, resolved affordance gaps, reflection diffs, timeline output, context forget output, bulk reflection writes, and export/clear/import roundtrips.
- `list_heuristics` and `search_heuristics` now support `tag_mode:"and"|"or"` for tag filters. The default remains `and` for backward compatibility.

### Tool Count

- Tool count remains 29.

## v8.0.0

### Bug Fixes

- `resolve_open_question` now serializes writes to `resolved_questions.json`, preventing concurrent calls from dropping overlay entries.
- `export_project_experience_md` now filters resolved open questions out of the aggregated Open Questions section while keeping raw reflection data available in `include_raw_reflections`.
- `get_reflection_summary` now separates active and resolved affordance-gap counts so dashboard totals match unresolved `top_gaps`.
- `get_reflection_timeline` now counts only unresolved open questions.
- `import_data(mode="merge")` now restores resolved-question overlay entries from imported reflections.
- `retrieve_heuristics.min_confidence` now uses inclusive `>=` semantics instead of excluding exact-threshold heuristics.
- `retrieve_heuristics`, `export_data`, and `export_project_experience_md` annotations now reflect their write behavior: retrieval records usage stats, and export tools can write files.
- `retrieve_heuristics` now waits for retrieval usage stats to persist before returning, so immediate follow-up exports see the updated `retrieval_count`.

### Improvements

- `get_reflection_timeline` still selects the most recent buckets but now renders them oldest-first, and the header explicitly says `oldest first`.
- Number-token conflict checks now allow subset/superset numeric facts through to semantic matching instead of treating them as automatic conflicts.
- Removed the last dead storage helpers and extra exports that were no longer used by the MCP surface.
- Added `npm run smoke`, a reusable MCP SDK smoke test that always runs with temporary `HOME` and `USERPROFILE`.

### Tool Count

- Tool count remains 29.

## v7.0.0

### Bug Fixes

- `get_reflection` now includes `context_forget` entries and resolved open-question status.
- `clear_data("reflections")`, `clear_data("all")`, and `import_data(mode="replace")` keep the resolved-question overlay consistent with active reflections.

### Improvements

- `get_world_model` accepts `since_days` for recent world-model snapshots.
- `retrieve_heuristics` accepts `min_confidence`, defaulting to `0.3`.
- Initialize instructions now mention `resolve_open_question`, `resolve_affordance_gap`, `diff_reflections`, and proactive `get_store_health` usage.
- File headers no longer carry the old internal `v3` label.

### Additions

- **resolve_affordance_gap** tool: mark a capability gap as resolved and hide it from default gap listings/dashboard top gaps.
- **get_reflection_timeline** tool: read-only day/week/month reflection metrics with optional domain and time filters.

### Tool Count

- 27 -> 29 tools with `resolve_affordance_gap` and `get_reflection_timeline`.

## v6.0.0

### Bug Fixes

- `export_project_experience_md` is now annotated as read-only and allows limit-only recent export calls.
- `diff_reflections` now treats semantically similar lessons as unchanged instead of requiring exact string equality.
- `get_session_summary.heuristics_extracted` now counts heuristics by `session_id`, avoiding cross-session leakage when task goals match.

### Data Model

- New extracted heuristics include optional `session_id` in exported JSON.

## v5.0.0

### Bug Fixes

- `resolve_open_question` and `get_open_questions.include_resolved` let agents close individual open questions while preserving old unresolved-question compatibility.
- `pruneHeuristicsMut` now always trims the heuristic list back to the 500 soft cap, even when all active heuristics are high confidence.
- `get_world_model` now short-circuits exact duplicate facts and uses trigram filtering before BM25 similarity for better performance on large stores.

### Architecture

- Reflections now live in `reflections.jsonl`, while `store.json` keeps sessions, heuristics, affordance gaps, version, and metadata. Old combined `store.json.reflections` data migrates automatically and export/import preserve the combined JSON shape.

### Additions

- **bulk_reflect** tool: submit up to 20 reflections in one MCP call and one store-index write.
- **get_heuristic_history** tool: inspect a full `update_heuristic` supersedes chain from any version id.
- **diff_reflections** tool: compare two reflections by key fields, lessons, world-model polarity changes, common open questions, and timestamp delta.
- **get_store_health** tool: read-only store integrity and size report.
- `log_affordance_gap.suggested_solution` supports manual suggestions, and recurring auto-suggestions include goal/failure context.

### Limits

- `reflect_on_task.task_goal` max length increased to 1000.
- `reflect_on_task.summary` and `summary_sections[].content` max length increased to 8000.
- `reflect_on_task.lessons_learned` is capped at 50 items per call.

### Tool Count

- 22 -> 27 tools with `resolve_open_question`, `bulk_reflect`, `get_heuristic_history`, `diff_reflections`, and `get_store_health`.

## v4.1.0

### Additions

- **export_project_experience_md** tool: generate a reusable Markdown project-experience document from completed reflections. Accepts optional filters for session_id, domain, tags, since_days, limit, title, include_raw_reflections, output_path, and output_dir.
- `output_dir` parameter writes the generated Markdown to a directory with an auto-generated safe filename, e.g. `<RAG_DOCUMENTS_DIR>`.
- The export is deterministic and generated only from stored reflections. The tool does not run automatically; the client or agent must call it explicitly per the initialize instructions.

### Tool Count

- 21 -> 22 tools with `export_project_experience_md`.

## v4.0.0

### Bug Fixes

- `similarity()` now accepts an optional corpus-level average document length, and retrieval/search callers pass corpus averages so BM25 length normalization actually takes effect.
- `get_world_model` now uses BM25 semantic deduplication for near-equivalent facts and keeps the newest matching world model update.

### Improvements

- `get_reflection_summary` now collects recent lessons and distribution counters in a single pass over reflections.
- `retrieve_heuristics` accepts `show_scores:true` to include text, confidence, retention, retrieval, reinforcement, domain bonus, and final score details for ranking debugging.
- `get_open_questions` accepts `since_days` to filter unresolved questions by recent reflections.

### Additions

- **get_session_summary** tool: read-only session digest with outcome distribution, normalized domains, recent lessons, top open questions, logged gaps, and extracted heuristic count.

### Tool Count

- 20 -> 21 tools with `get_session_summary`.

## v3.9.0

### Bug Fixes

- `import_data` replace and merge modes now apply heuristic-field fallback defaults for `retrieval_count`, `last_retrieved_at`, `supersedes`, `superseded_by`, and `version` so older snapshots import cleanly.
- `search_reflections` with an empty query now returns filter-matched candidates sorted by recency instead of returning an empty result set.
- `pruneHeuristicsMut` prunes superseded (archived) versions first before falling back to low-confidence active heuristics.
- `upsertHeuristicMut` filters candidates by domain before computing BM25 similarity, preventing cross-domain false-positive deduplication.

### Improvements

- `get_reflection_summary` dashboard now reports active and archived heuristic counts separately.

### Additions

- **get_world_model** tool: read-only tool that aggregates `world_model_updates` from all reflections into the agent's current world model, deduplicating facts to latest, with optional domain and polarity filters.

### Tool Count

- 19 -> 20 tools with `get_world_model`.

## v3.8.0

### Bug Fixes

- Lowered `HEURISTIC_DEDUP_THRESHOLD` from `0.8` to `0.75` so near-duplicate lessons reinforce instead of fragmenting.

### Improvements

- `retrieve_heuristics` now records `retrieval_count` and `last_retrieved_at`, and includes retrieval usage in tool output.
- Retrieval scoring applies an Ebbinghaus-style decay factor so stale heuristics are gently de-prioritized unless reinforced.
- `update_heuristic` text edits now create a versioned replacement with `version`, `supersedes`, and `superseded_by`; archived versions are hidden from normal list/search/retrieve paths.
- Initialize instructions now explain how confidence, reinforcement, retrieval usage, decay, version chains, and open questions make the memory improve over time.

### Additions

- **get_open_questions** tool: list unresolved questions captured in past reflections with optional domain, priority, and limit filters.

### Tool Count

- 18 -> 19 tools with `get_open_questions`.

## v3.7.0

### Bug Fixes

- Fixed BM25 stopword filtering so common English stopwords are excluded from tokenization and scoring.
- Hoisted the `STOPWORDS` set to module-level in `storage.ts` so it is allocated once and reused across all searches.

### Improvements

- `search_reflections` `failure_mode` filter now works correctly with an empty query string, returning timestamp-sorted results filtered by the requested failure_mode.
- Deduplicated `lessons_learned` in `reflect_on_task` before storing and before heuristic extraction, removing duplicate lessons caused by repeated input entries.
- `search_reflections` and `get_recent_reflections` output uses `---` separators between entries when more than 10 results are returned, improving readability of long lists.

### Additions

- **get_reflection** tool: retrieve full details of a single reflection by its id (17 -> 18 tools).
- `search_reflections`, `get_recent_reflections`, and `get_session_reflections` output now includes each reflection's `id` field, enabling follow-up calls to `get_reflection`.

### Tool Count

- 17 -> 18 tools with `get_reflection`.

## v3.6.0

### Bug Fixes

- Fixed `reflect_on_task` tag hygiene so `domain` and `failure_mode` are no longer mixed into stored reflection tags or auto-extracted heuristic tags.
- Fixed `update_heuristic.tags` semantics: pass `[]` to clear tags; omit `tags` or pass `null` to leave tags unchanged.
- Removed duplicate domain normalization in `getReflectionSummary` tag filtering while preserving cleanup for legacy domain/failure tags.

### Improvements

- Combined `reflect_on_task` reflection save and auto-extracted heuristic upserts into one storage mutation/write.
- Unified `retrieve_heuristics` low-relevance filtering with `SEARCH_MIN_TEXT_SCORE = 0.05`.
- Added `REFLECTION_SOFT_LIMIT = 2000` warnings to `reflect_on_task` responses and the dashboard.

### Additions

- **search_heuristics** tool: query stored heuristics by relevance with optional domain, tag, minimum-confidence, and limit filters.

### Tool Count

- 16 -> 17 tools with `search_heuristics`.

## v3.5.0

### Bug Fixes

- Fixed CJK tokenization in BM25 search; multi-byte characters are now split correctly.
- Fixed `pruneHeuristicsMut` repeated indexOf+splice removal to collecting ids and a single filter pass, reducing prune time on large stores.
- Fixed `tag_distribution` in `get_reflection_summary` filtering out legacy domain and failure_mode values from `reflection.tags`.
- Fixed `export_data` annotation to `readOnlyHint: true` at the time; current v8 behavior marks it mutating because `output_path` can write a file.
- Fixed `reflect_on_task` heuristic reinforce to merge new tags into an existing deduped heuristic.

### Additions

- **update_heuristic** tool: update an existing heuristic's lesson, confidence, tags, or domain without creating a duplicate (15 -> 16 tools).
- **search minimum relevance threshold**: `search_reflections` now applies `SEARCH_MIN_TEXT_SCORE = 0.05` to filter out near-zero relevance noise.

### Tool Count

- 15 -> 16 tools with `update_heuristic`.

## v3.4.0

### Additions

- **list_heuristics**: new read-only tool for inspecting stored heuristics with optional domain, tag, minimum-confidence, limit, and sort filters.
- **get_session_reflections**: new read-only tool for retrieving recent reflections for a single session.
- **Tag distribution**: `get_reflection_summary` now reports top reflection tags.
- **Tool annotations**: `tools/list` now marks read-only, mutating, and destructive tools with MCP annotations.

### Improvements

- Updated initialize instructions to mention direct heuristic listing, session-specific retrieval, tag summaries, and tool annotations.
- Cleaned type-definition comments to remove stale mojibake.

### Tool Count

- 13 -> 15 tools with `list_heuristics` and `get_session_reflections`.

## v3.3.0

### Bug Fixes

- Fixed `import_data` compatibility for older heuristic records that do not include `contradiction_notes`.
- Removed duplicate heuristic pruning work during batched lesson extraction while keeping single heuristic inserts pruned.

### Additions

- **search_reflections tags filter**: `search_reflections.tags` filters reflections containing ALL specified tags.
- **Outcome distribution**: `get_reflection_summary` now reports success, partial, and failure counts.
- **Outcome badges**: `search_reflections` and `get_recent_reflections` now prefix task goals with ASCII outcome badges (`+`, `~`, `!`).
- **Outcome-specific lesson confidence**: extracted lessons now use `0.75` for success, `0.60` for partial, and `0.50` for failure outcomes.
- **SERVER_INSTRUCTIONS rewrite**: initialize instructions now document the core workflow, data management, tag filters, contradiction persistence, and retrieval threshold.

### Tool Count

- Still 13 tools.

## v3.2.0

### Bug Fixes

- Fixed BM25 average document length calculation to produce correct similarity scores.
- Fixed duplicate tags being stored multiple times on the same reflection; duplicates are now deduplicated on insert.
- Fixed `get_reflection_summary` recent lessons returning oldest-first instead of newest-first ordering.

### Additions

- **import_data**: new tool to import a previously exported JSON snapshot back into the store (12 -> 13 tools).
- **contradiction_notes persistence**: contradiction notes are now persisted with the heuristic record and surfaced in `retrieve_heuristics`.
- **search_reflections recency decay**: BM25 scores are boosted toward more recent reflections so fresher results rank higher.
- **Heuristic soft limit and pruning**: the store applies a soft cap on heuristic count and prunes lowest-scoring entries automatically.
- **reflect_on_task session stats**: the response now includes the current session's cumulative reflection count.

### Tool Count

- 12 -> 13 tools with the addition of `import_data`.

## v3.1.0

### Additions

- **Reflection tags**: `reflect_on_task` accepts an optional `tags` string array, stored alongside each reflection for categorisation and later filtering.
- **Summary sections**: `reflect_on_task.summary_sections` accepts an optional array of `{ title, content }` objects for structured long summaries; stored with the reflection and searchable via `search_reflections`.
- **Tag filter on retrieve_heuristics**: `retrieve_heuristics.tags` restricts results to heuristics containing ALL specified tags (intersection semantics).
- **export_data output_path**: `export_data` accepts an optional `output_path` string; when provided the exported JSON is written directly to that file instead of being returned inline.
- **search_reflections since_days**: `search_reflections` accepts an optional `since_days` number to limit results to reflections from the last N days.
- **Store metadata in get_reflection_summary**: the summary response now includes store-level metadata: `created_at`, `last_written_at`, and `write_count`.
- **BM25 similarity**: internal search uses a BM25-based scorer for more relevant ranking of search results.

### Improvements

- Storage layer now propagates read/write errors to tool responses instead of silently swallowing them.
- Summary metadata output includes richer store-level statistics.

### Backward Compatibility

- All new parameters are optional; existing callers continue to work without changes.
- Output formats are supersets of the v3.0.0 schemas.

## v3.0.0

- Initial public release with 12 tools: `reflect_on_task`, `log_affordance_gap`, `retrieve_heuristics`, `add_heuristic`, `contradict_heuristic`, `delete_heuristic`, `search_reflections`, `get_reflection_summary`, `get_affordance_gaps`, `get_recent_reflections`, `export_data`, `clear_data`.
- Atomic JSON store at `~/.hermes-reflection/store.json`.
- Corrupt-store recovery with timestamped backup.
- stdio MCP transport for Claude Desktop, Codex Desktop, and Claude Code.
