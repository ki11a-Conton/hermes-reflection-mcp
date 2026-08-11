import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "fs";
import { join } from "path";
import { STORE_DIR } from "./storage.js";
import { withFileLock } from "./src/file_lock.js";
import { redactSensitiveText } from "./src/redaction.js";
import { OperationJournalStoreUnavailableError } from "./src/operation_journal.js";
import { createCompactionReceipt, parseCompactionReceipt, } from "./src/compaction_handoff.js";
import { assertSessionScopeVisibility, lifecycleNotReady, normalizePersistedSessionScope, normalizeRequestedSessionScope, } from "./src/session_scope.js";
const DB_PATH = join(STORE_DIR, "sessions.db");
const operationJournalMutationContext = new AsyncLocalStorage();
async function withCoordinatorReadBarrier(callback) {
    const { withOperationJournalBarrier } = await import("./src/operation_journal.js");
    return withOperationJournalBarrier(callback);
}
async function withCoordinatorMutationBarrier(callback) {
    if (operationJournalMutationContext.getStore() === true)
        return callback();
    return withCoordinatorReadBarrier(() => operationJournalMutationContext.run(true, callback));
}
export const SESSION_STORAGE_UNAVAILABLE = "Session storage is unavailable: better-sqlite3 native module could not be loaded.";
let _db = null;
let _dbLoadPromise = null;
let _loadFailed = false;
let _lastFailureTime = null;
let _closed = false; // J1-fix: track explicit close to prevent leaked connections
const configuredRetryIntervalMs = Number.parseInt(process.env.HERMES_SESSION_RETRY_MS ?? "", 10);
const RETRY_INTERVAL_MS = configuredRetryIntervalMs > 0 ? configuredRetryIntervalMs : 60_000;
const SESSION_META_COLUMNS = `
  session_id, started_at, turn_count, last_turn_at, scope,
  parent_session_id, start_event_id, end_reason, ended_at, updated_at,
  compaction_generation, last_compaction_receipt
`;
function initializeSessionSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      turn_count INTEGER NOT NULL DEFAULT 0,
      last_turn_at TEXT,
      scope TEXT NOT NULL DEFAULT 'legacy-unscoped',
      parent_session_id TEXT,
      start_event_id TEXT,
      end_reason TEXT,
      ended_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      compaction_generation INTEGER NOT NULL DEFAULT 0,
      last_compaction_receipt TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      session_id UNINDEXED,
      turn_index UNINDEXED,
      role,
      content,
      timestamp UNINDEXED,
      tokenize = "unicode61"
    );
  `);
    const migrate = db.transaction(() => {
        const existing = new Set(db.prepare("PRAGMA table_info(session_meta)").all().map((column) => column.name));
        const additions = [
            ["scope", "TEXT NOT NULL DEFAULT 'legacy-unscoped'"],
            ["parent_session_id", "TEXT"],
            ["start_event_id", "TEXT"],
            ["end_reason", "TEXT"],
            ["ended_at", "TEXT"],
            ["updated_at", "TEXT NOT NULL DEFAULT ''"],
            ["compaction_generation", "INTEGER NOT NULL DEFAULT 0"],
            ["last_compaction_receipt", "TEXT"],
        ];
        for (const [name, declaration] of additions) {
            if (!existing.has(name))
                db.exec(`ALTER TABLE session_meta ADD COLUMN ${name} ${declaration}`);
        }
        db.prepare("UPDATE session_meta SET updated_at = COALESCE(last_turn_at, started_at) WHERE updated_at = ''").run();
    });
    migrate.immediate();
}
async function withSessionWriteLock(operation) {
    return withFileLock(DB_PATH, operation, {
        timeout_ms: 30_000,
        retry_ms: 10,
        stale_ms: 120_000,
    });
}
function sqliteErrorCode(error) {
    return error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
}
/** Retry a complete, rollback-safe SQLite transaction on cross-process lock contention. */
export async function withSqliteContentionRetry(operation, options = {}) {
    const attempts = Math.max(1, Math.min(20, Math.trunc(options.attempts ?? 8)));
    const baseDelayMs = Math.max(0, Math.min(1_000, Math.trunc(options.base_delay_ms ?? 15)));
    const maxDelayMs = Math.max(baseDelayMs, Math.min(5_000, Math.trunc(options.max_delay_ms ?? 250)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return operation();
        }
        catch (error) {
            const retryable = /^SQLITE_(?:BUSY|LOCKED)$/.test(sqliteErrorCode(error) ?? "");
            if (!retryable || attempt === attempts - 1)
                throw error;
            const backoff = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
            const jitter = baseDelayMs === 0 ? 0 : (process.pid + attempt) % Math.max(2, baseDelayMs);
            await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
        }
    }
    throw new Error("SQLite contention retry exhausted without a result");
}
async function getDb() {
    if (_db)
        return _db;
    // J1-fix: if closeSessionStorage was called, don't create new connections
    if (_closed)
        return null;
    // B12-fix: use a shared load promise to prevent concurrent instantiation
    if (_dbLoadPromise)
        return _dbLoadPromise;
    if (_loadFailed) {
        if (_lastFailureTime !== null && Date.now() - _lastFailureTime < RETRY_INTERVAL_MS) {
            return null;
        }
        _loadFailed = false;
        _lastFailureTime = null;
    }
    // J1-fix: use local promise variable so finally only clears if still pointing to us
    const myPromiseRef = { current: null };
    const myPromise = (async () => {
        try {
            const { default: DatabaseCtor } = await import("better-sqlite3");
            mkdirSync(STORE_DIR, { recursive: true });
            // J1-fix: don't assign _db if closeSessionStorage was called during await
            if (_closed)
                return null;
            let candidate = null;
            let lastError;
            for (let attempt = 0; attempt < 6; attempt += 1) {
                try {
                    candidate = new DatabaseCtor(DB_PATH, { timeout: 5_000 });
                    // Configure waiting before WAL/schema pragmas because simultaneous
                    // Codex Desktop processes can race during their first open.
                    candidate.pragma("busy_timeout = 5000");
                    candidate.pragma("journal_mode = WAL");
                    initializeSessionSchema(candidate);
                    break;
                }
                catch (error) {
                    lastError = error;
                    candidate?.close();
                    candidate = null;
                    const code = error && typeof error === "object" && "code" in error
                        ? String(error.code)
                        : "";
                    if (!/^SQLITE_(?:BUSY|LOCKED)$/.test(code) || attempt === 5)
                        throw error;
                    await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
                }
            }
            if (!candidate)
                throw lastError ?? new Error("SQLite initialization failed");
            if (_closed) {
                candidate.close();
                return null;
            }
            _db = candidate;
            return candidate;
        }
        catch (error) {
            _loadFailed = true;
            _lastFailureTime = Date.now();
            console.error("[hermes] session storage unavailable.", error);
            return null;
        }
        finally {
            // J1-fix: only clear if still pointing to our promise (not overwritten by a later getDb)
            if (_dbLoadPromise === myPromiseRef.current)
                _dbLoadPromise = null;
        }
    })();
    myPromiseRef.current = myPromise;
    _dbLoadPromise = myPromise;
    return myPromise;
}
function sessionMetaFromRow(row) {
    return {
        session_id: row.session_id,
        started_at: row.started_at,
        turn_count: row.turn_count,
        ...(row.last_turn_at === null ? {} : { last_turn_at: row.last_turn_at }),
        scope: row.scope,
        ...(row.parent_session_id === null ? {} : { parent_session_id: row.parent_session_id }),
        ...(row.start_event_id === null ? {} : { start_event_id: row.start_event_id }),
        ...(row.end_reason === null ? {} : { end_reason: row.end_reason }),
        ...(row.ended_at === null ? {} : { ended_at: row.ended_at }),
        updated_at: row.updated_at,
        compaction_generation: row.compaction_generation,
        ...(row.last_compaction_receipt === null ? {} : { last_compaction_receipt: row.last_compaction_receipt }),
    };
}
function readSessionMeta(db, sessionId) {
    const row = db.prepare(`SELECT ${SESSION_META_COLUMNS} FROM session_meta WHERE session_id = ?`)
        .get(sessionId);
    return row ? sessionMetaFromRow(row) : null;
}
export async function getSessionMeta(sessionId) {
    return withCoordinatorReadBarrier(async () => {
        const db = await getDb();
        if (!db)
            return null;
        return readSessionMeta(db, sessionId);
    });
}
export async function resolveSessionScope(sessionId) {
    const meta = await getSessionMeta(sessionId);
    if (!meta)
        throw lifecycleNotReady(`Session lifecycle metadata is not ready for ${sessionId}.`);
    return meta.scope;
}
export async function persistSessionStart(sessionId, provenance) {
    return withCoordinatorMutationBarrier(async () => {
        const scope = normalizeRequestedSessionScope(provenance.scope);
        const startedAt = provenance.started_at === undefined
            ? new Date().toISOString()
            : isoTimestamp(provenance.started_at, "started_at");
        const parentSessionId = provenance.parent_session_id === undefined
            ? undefined
            : boundedString(provenance.parent_session_id, "parent_session_id", 200);
        const startEventId = provenance.start_event_id === undefined
            ? undefined
            : boundedString(provenance.start_event_id, "start_event_id", 200);
        const db = await getDb();
        if (!db)
            return false;
        return withSessionWriteLock(async () => {
            const persist = db.transaction(() => {
                const existing = readSessionMeta(db, sessionId);
                if (existing) {
                    assertSessionScopeVisibility(existing.scope, scope);
                    if ((parentSessionId !== undefined && existing.parent_session_id !== parentSessionId)
                        || (startEventId !== undefined && existing.start_event_id !== startEventId)
                        || (provenance.started_at !== undefined && existing.started_at !== startedAt)) {
                        throw new Error("Session start provenance is immutable once persisted.");
                    }
                    return;
                }
                db.prepare(`
        INSERT INTO session_meta (
          session_id, started_at, turn_count, last_turn_at, scope, parent_session_id,
          start_event_id, end_reason, ended_at, updated_at, compaction_generation,
          last_compaction_receipt
        ) VALUES (?, ?, 0, NULL, ?, ?, ?, NULL, NULL, ?, 0, NULL)
      `).run(sessionId, startedAt, scope, parentSessionId ?? null, startEventId ?? null, startedAt);
            });
            await withSqliteContentionRetry(() => persist());
            return true;
        });
    });
}
export async function persistSessionEnd(sessionId, provenance) {
    return withCoordinatorMutationBarrier(async () => {
        const scope = normalizeRequestedSessionScope(provenance.scope);
        const endReason = boundedString(provenance.end_reason, "end_reason", 200);
        const endedAt = provenance.ended_at === undefined
            ? new Date().toISOString()
            : isoTimestamp(provenance.ended_at, "ended_at");
        const db = await getDb();
        if (!db)
            return false;
        return withSessionWriteLock(async () => {
            const persist = db.transaction(() => {
                const existing = readSessionMeta(db, sessionId);
                if (!existing)
                    throw lifecycleNotReady(`Session lifecycle metadata is not ready for ${sessionId}.`);
                assertSessionScopeVisibility(existing.scope, scope);
                if (existing.ended_at !== undefined) {
                    if (existing.end_reason !== endReason
                        || (provenance.ended_at !== undefined && existing.ended_at !== endedAt)) {
                        throw new Error("Session end provenance is immutable once persisted.");
                    }
                    return;
                }
                db.prepare("UPDATE session_meta SET end_reason = ?, ended_at = ?, updated_at = ? WHERE session_id = ?").run(endReason, endedAt, endedAt, sessionId);
            });
            await withSqliteContentionRetry(() => persist());
            return true;
        });
    });
}
/** Atomically advance one scope-bound session's canonical compaction receipt. */
export async function persistCompactionReceipt(sessionId, metadata, requestedScope) {
    return withCoordinatorMutationBarrier(async () => {
        const receipt = createCompactionReceipt(metadata);
        const scope = requestedScope === undefined ? undefined : normalizeRequestedSessionScope(requestedScope);
        const db = await getDb();
        if (!db)
            return null;
        return withSessionWriteLock(async () => {
            let committed;
            const persist = db.transaction(() => {
                const existing = readSessionMeta(db, sessionId);
                if (!existing)
                    throw lifecycleNotReady(`Session lifecycle metadata is not ready for ${sessionId}.`);
                if (scope !== undefined)
                    assertSessionScopeVisibility(existing.scope, scope);
                if (receipt.generation === existing.compaction_generation) {
                    if (!existing.last_compaction_receipt) {
                        throw new Error("COMPACTION_RECEIPT_CONFLICT: generation has no canonical receipt");
                    }
                    const prior = parseCompactionReceipt(existing.last_compaction_receipt);
                    if (prior.receipt_hash !== receipt.receipt_hash) {
                        throw new Error("COMPACTION_RECEIPT_CONFLICT: generation is already committed with different metadata");
                    }
                    committed = prior;
                    return;
                }
                if (receipt.generation !== existing.compaction_generation + 1) {
                    throw new Error(`COMPACTION_GENERATION_INVALID: expected ${existing.compaction_generation + 1}, received ${receipt.generation}`);
                }
                const serialized = JSON.stringify(receipt);
                if (Buffer.byteLength(serialized, "utf8") > 2_048) {
                    throw new Error("COMPACTION_RECEIPT_INVALID: canonical receipt exceeds 2048 bytes");
                }
                db.prepare(`
          UPDATE session_meta
          SET compaction_generation = ?, last_compaction_receipt = ?, updated_at = ?
          WHERE session_id = ?
        `).run(receipt.generation, serialized, new Date().toISOString(), sessionId);
                committed = receipt;
            });
            await withSqliteContentionRetry(() => persist.immediate());
            return committed;
        });
    });
}
export async function appendSessionTurn(sessionId, role, content, timestamp, provenance = {}) {
    try {
        return await withCoordinatorMutationBarrier(async () => {
            const db = await getDb();
            if (!db)
                return false;
            return withSessionWriteLock(async () => {
                const timestampDate = timestamp ? new Date(timestamp) : new Date();
                if (Number.isNaN(timestampDate.getTime())) {
                    throw new Error("timestamp must be a valid ISO-8601 date string");
                }
                const ts = timestampDate.toISOString();
                const requestedScope = provenance.scope === undefined
                    ? undefined
                    : normalizeRequestedSessionScope(provenance.scope);
                // G4-fix: wrap SELECT + INSERT/UPDATE + INSERT in a transaction for atomicity
                const tx = db.transaction(() => {
                    const meta = readSessionMeta(db, sessionId);
                    const turnIndex = meta ? meta.turn_count : 0;
                    if (!meta) {
                        const newSessionScope = normalizeRequestedSessionScope(requestedScope);
                        db.prepare(`INSERT INTO session_meta (
             session_id, started_at, turn_count, last_turn_at, scope, updated_at,
             compaction_generation
           ) VALUES (?, ?, 1, ?, ?, ?, 0)`).run(sessionId, ts, ts, newSessionScope, ts);
                    }
                    else {
                        if (requestedScope !== undefined)
                            assertSessionScopeVisibility(meta.scope, requestedScope);
                        db.prepare(`UPDATE session_meta
           SET turn_count = turn_count + 1,
               started_at = CASE WHEN ? < started_at THEN ? ELSE started_at END,
               last_turn_at = CASE WHEN last_turn_at IS NULL OR ? > last_turn_at THEN ? ELSE last_turn_at END,
               updated_at = CASE WHEN ? > updated_at THEN ? ELSE updated_at END
           WHERE session_id = ?`).run(ts, ts, ts, ts, ts, ts, sessionId);
                    }
                    db.prepare("INSERT INTO sessions_fts (session_id, turn_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(sessionId, turnIndex, role, content, ts);
                });
                await withSqliteContentionRetry(() => tx());
                return true;
            });
        });
    }
    catch (error) {
        if (error instanceof OperationJournalStoreUnavailableError)
            return false;
        throw error;
    }
}
function quoteFtsTerm(term) {
    const cleaned = term.replace(/[\x00-\x1F\x7F]/g, "").replace(/"/g, '""');
    return `"${cleaned}"`;
}
function queryTerms(query) {
    const matches = query.match(/"([^"]+)"|[^\s"]+/g) ?? [];
    return matches
        .map((term) => term.replace(/^"|"$/g, "").replace(/\*$/g, ""))
        .filter((term) => term.length > 0 && !["AND", "OR", "NOT"].includes(term));
}
function buildLiteralFtsQuery(query) {
    const terms = queryTerms(query);
    if (terms.length === 0)
        return quoteFtsTerm(query);
    return terms.map(quoteFtsTerm).join(" AND ");
}
function buildFtsQuery(query) {
    const trimmed = query.trim();
    if (trimmed.length === 0)
        return quoteFtsTerm("");
    const hasExplicitOperator = /(^|\s)(AND|OR|NOT)(\s|$)/.test(trimmed);
    const hasPrefix = /(?:^|\s)[^\s"]+\*/.test(trimmed);
    const isPhrase = /^"[^"]+"$/.test(trimmed);
    if (hasExplicitOperator || hasPrefix || isPhrase)
        return trimmed;
    return buildLiteralFtsQuery(trimmed);
}
function buildSafeSnippet(query, content) {
    const safeContent = redactSensitiveText(content, { strictHistorical: true });
    const lowerContent = safeContent.toLowerCase();
    let matchIndex = 0;
    let matchLength = Math.min(query.length, safeContent.length);
    for (const term of queryTerms(query)) {
        const idx = lowerContent.indexOf(term.toLowerCase());
        if (idx >= 0) {
            matchIndex = idx;
            matchLength = term.length;
            break;
        }
    }
    const beforePoints = Array.from(safeContent.slice(0, matchIndex)).length;
    const matchedPoints = Array.from(safeContent.slice(matchIndex, matchIndex + matchLength)).length;
    const points = Array.from(safeContent);
    const start = Math.max(0, beforePoints - 80);
    const end = Math.min(points.length, beforePoints + matchedPoints + 80);
    return `${start > 0 ? "..." : ""}${points.slice(start, end).join("").replace(/\n/g, " ")}${end < points.length ? "..." : ""}`;
}
async function searchSessionsInternal(query, limit = 10, sinceDays, scope) {
    const db = await getDb();
    if (!db)
        return null;
    const safeLimit = Math.max(1, Math.min(limit, 100));
    let sql = `
    SELECT sessions_fts.session_id, turn_index, role, content, timestamp,
           rank AS fts_rank
    FROM sessions_fts
    ${scope === undefined ? "" : "JOIN session_meta ON session_meta.session_id = sessions_fts.session_id"}
    WHERE sessions_fts MATCH ?
  `;
    const params = [buildFtsQuery(query)];
    if (scope !== undefined) {
        sql += " AND session_meta.scope = ?";
        params.push(scope);
    }
    // G8-fix: reject invalid sinceDays (negative or zero produces meaningless future cutoff)
    if (sinceDays !== undefined && sinceDays < 1) {
        console.warn(`[hermes] searchSessions: sinceDays=${sinceDays} is invalid, ignoring time filter`);
        sinceDays = undefined;
    }
    if (sinceDays !== undefined) {
        const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();
        sql += " AND timestamp >= ?";
        params.push(cutoff);
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(safeLimit);
    let rows;
    try {
        rows = db.prepare(sql).all(...params);
    }
    catch (error) {
        console.warn("[hermes] FTS query failed, trying literal fallback:", query);
        try {
            params[0] = buildLiteralFtsQuery(query);
            rows = db.prepare(sql).all(...params);
        }
        catch (fallbackError) {
            console.error("[hermes] FTS search failed with fallback query too:", fallbackError);
            return null; // A11-fix: return null (unavailable) instead of [] (no match)
        }
    }
    return rows.map((row) => {
        return {
            session_id: row.session_id,
            turn_index: row.turn_index,
            role: row.role,
            timestamp: row.timestamp,
            snippet: buildSafeSnippet(query, row.content),
            rank: row.fts_rank,
        };
    });
}
export async function searchSessions(query, limit = 10, sinceDays) {
    try {
        return await withCoordinatorReadBarrier(() => searchSessionsInternal(query, limit, sinceDays));
    }
    catch (error) {
        if (error instanceof OperationJournalStoreUnavailableError)
            return null;
        throw error;
    }
}
export async function searchSessionsInScope(query, scope, limit = 10, sinceDays) {
    try {
        return await withCoordinatorReadBarrier(() => searchSessionsInternal(query, limit, sinceDays, normalizeRequestedSessionScope(scope)));
    }
    catch (error) {
        if (error instanceof OperationJournalStoreUnavailableError)
            return null;
        throw error;
    }
}
export async function listRecentSessions(limit = 20, sinceDays) {
    return withCoordinatorReadBarrier(async () => {
        const db = await getDb();
        if (!db)
            return null;
        const safeLimit = Math.max(1, Math.min(limit, 100));
        // E2-fix: support sinceDays filter for empty-query search_sessions
        if (sinceDays !== undefined && sinceDays >= 1) {
            const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();
            const rows = db.prepare(`SELECT ${SESSION_META_COLUMNS} FROM session_meta WHERE last_turn_at >= ? ORDER BY last_turn_at DESC LIMIT ?`).all(cutoff, safeLimit);
            return rows.map(sessionMetaFromRow);
        }
        const rows = db.prepare(`SELECT ${SESSION_META_COLUMNS} FROM session_meta ORDER BY last_turn_at DESC LIMIT ?`).all(safeLimit);
        return rows.map(sessionMetaFromRow);
    });
}
export async function listRecentSessionsInScope(scope, limit = 20, sinceDays) {
    return withCoordinatorReadBarrier(async () => {
        const db = await getDb();
        if (!db)
            return null;
        const requestedScope = normalizeRequestedSessionScope(scope);
        const safeLimit = Math.max(1, Math.min(limit, 100));
        if (sinceDays !== undefined && sinceDays >= 1) {
            const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();
            const rows = db.prepare(`SELECT ${SESSION_META_COLUMNS} FROM session_meta
       WHERE scope = ? AND last_turn_at >= ? ORDER BY last_turn_at DESC LIMIT ?`).all(requestedScope, cutoff, safeLimit);
            return rows.map(sessionMetaFromRow);
        }
        const rows = db.prepare(`SELECT ${SESSION_META_COLUMNS} FROM session_meta
     WHERE scope = ? ORDER BY last_turn_at DESC LIMIT ?`).all(requestedScope, safeLimit);
        return rows.map(sessionMetaFromRow);
    });
}
export async function listSessionTurns(sessionId, limit = 50) {
    return withCoordinatorReadBarrier(async () => {
        const db = await getDb();
        if (!db)
            return null;
        const safeLimit = Math.max(1, Math.min(limit, 200));
        const rows = db.prepare(`SELECT session_id, turn_index, role, content, timestamp
     FROM sessions_fts
     WHERE session_id = ?
     ORDER BY turn_index DESC
     LIMIT ?`).all(sessionId, safeLimit);
        return rows.reverse().map((row) => ({
            ...row,
            role: row.role,
        }));
    });
}
export async function getSessionTurn(sessionId, turnIndex) {
    return withCoordinatorReadBarrier(async () => {
        const db = await getDb();
        if (!db)
            return null;
        if (!Number.isInteger(turnIndex) || turnIndex < 0)
            return null;
        const row = db.prepare(`SELECT session_id, turn_index, role, content, timestamp
     FROM sessions_fts
     WHERE session_id = ? AND turn_index = ?
     LIMIT 1`).get(sessionId, turnIndex);
        return row ? { ...row, role: row.role } : null;
    });
}
export async function listSessionTurnsAround(sessionId, anchorTurnIndex, window = 5) {
    return withCoordinatorReadBarrier(async () => {
        const db = await getDb();
        if (!db)
            return null;
        const safeWindow = Math.max(1, Math.min(window, 50));
        const start = Math.max(0, anchorTurnIndex - safeWindow);
        const end = anchorTurnIndex + safeWindow;
        const rows = db.prepare(`SELECT session_id, turn_index, role, content, timestamp
     FROM sessions_fts
     WHERE session_id = ? AND turn_index >= ? AND turn_index <= ?
     ORDER BY turn_index ASC`).all(sessionId, start, end);
        const bounds = db.prepare(`SELECT MIN(turn_index) AS first_turn_index, MAX(turn_index) AS last_turn_index
     FROM sessions_fts
     WHERE session_id = ?`).get(sessionId);
        const first = bounds?.first_turn_index;
        const last = bounds?.last_turn_index;
        const availableRange = first === null || first === undefined || last === null || last === undefined
            ? null
            : { first_turn_index: first, last_turn_index: last };
        return {
            turns: rows.map((row) => ({
                ...row,
                role: row.role,
            })),
            has_before: availableRange ? start > availableRange.first_turn_index : false,
            has_after: availableRange ? end < availableRange.last_turn_index : false,
            available_range: availableRange,
        };
    });
}
export function closeSessionStorage() {
    // G6-fix: also reset load state to prevent leaked connections after async load
    _closed = true; // J1-fix: mark as closed so getDb won't create new connections
    if (_db) {
        _db.close();
        _db = null;
    }
    _dbLoadPromise = null;
    _loadFailed = false;
    _lastFailureTime = null;
}
/**
 * E1-fix: Clear all session data from SQLite (session_meta + sessions_fts).
 * Called by clearData when collection is "sessions" or "all".
 */
export async function clearSessionStorage() {
    return replaceSessionStorageSnapshot(emptySessionStorageSnapshot());
}
export async function withOperationJournalSessionMutation(callback) {
    const journal = await import("./src/operation_journal.js");
    journal.assertOperationJournalCoordinatorContext();
    return operationJournalMutationContext.run(true, callback);
}
export function emptySessionStorageSnapshot() {
    return { schema_version: 2, sessions: [], turns: [] };
}
function exactKeys(value, expected, label) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new Error(`${label} contains unknown or missing fields`);
    }
}
function boundedString(value, label, max, allowEmpty = false) {
    if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max) {
        throw new Error(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${max} characters`);
    }
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) {
        throw new Error(`${label} contains forbidden control characters`);
    }
    return value;
}
function isoTimestamp(value, label) {
    const text = boundedString(value, label, 100);
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) {
        throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
    }
    return text;
}
export function validateSessionStorageSnapshot(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("session snapshot must be an object");
    }
    const input = value;
    exactKeys(input, ["schema_version", "sessions", "turns"], "session snapshot");
    if (input.schema_version !== 1 && input.schema_version !== 2) {
        throw new Error("unsupported session snapshot schema_version");
    }
    const inputSchemaVersion = input.schema_version;
    if (!Array.isArray(input.sessions) || input.sessions.length > 100_000) {
        throw new Error("session snapshot sessions must be an array of at most 100000 items");
    }
    if (!Array.isArray(input.turns) || input.turns.length > 1_000_000) {
        throw new Error("session snapshot turns must be an array of at most 1000000 items");
    }
    const sessions = input.sessions.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error(`session snapshot sessions[${index}] must be an object`);
        }
        const row = raw;
        const v1Expected = row.last_turn_at === undefined
            ? ["session_id", "started_at", "turn_count"]
            : ["session_id", "started_at", "turn_count", "last_turn_at"];
        const optionalV2 = [
            "last_turn_at",
            "parent_session_id",
            "start_event_id",
            "end_reason",
            "ended_at",
            "last_compaction_receipt",
        ].filter((key) => row[key] !== undefined);
        const expected = inputSchemaVersion === 1
            ? v1Expected
            : [
                "session_id",
                "started_at",
                "turn_count",
                "scope",
                "updated_at",
                "compaction_generation",
                ...optionalV2,
            ];
        exactKeys(row, expected, `session snapshot sessions[${index}]`);
        if (!Number.isInteger(row.turn_count) || row.turn_count < 0 || row.turn_count > 1_000_000) {
            throw new Error(`session snapshot sessions[${index}].turn_count is invalid`);
        }
        const startedAt = isoTimestamp(row.started_at, `session snapshot sessions[${index}].started_at`);
        const lastTurnAt = row.last_turn_at === undefined
            ? undefined
            : isoTimestamp(row.last_turn_at, `session snapshot sessions[${index}].last_turn_at`);
        const scope = inputSchemaVersion === 1
            ? "legacy-unscoped"
            : normalizePersistedSessionScope(row.scope);
        const updatedAt = inputSchemaVersion === 1
            ? lastTurnAt ?? startedAt
            : isoTimestamp(row.updated_at, `session snapshot sessions[${index}].updated_at`);
        const compactionGeneration = inputSchemaVersion === 1 ? 0 : row.compaction_generation;
        if (!Number.isInteger(compactionGeneration)
            || compactionGeneration < 0
            || compactionGeneration > 1_000_000) {
            throw new Error(`session snapshot sessions[${index}].compaction_generation is invalid`);
        }
        const serializedReceipt = row.last_compaction_receipt === undefined
            ? undefined
            : boundedString(row.last_compaction_receipt, `session snapshot sessions[${index}].last_compaction_receipt`, 2_048);
        if (compactionGeneration === 0 && serializedReceipt !== undefined) {
            throw new Error(`session snapshot sessions[${index}] generation 0 must not contain a compaction receipt`);
        }
        if (compactionGeneration > 0 && serializedReceipt === undefined) {
            throw new Error(`session snapshot sessions[${index}] positive generation requires a compaction receipt`);
        }
        if (serializedReceipt !== undefined) {
            let receipt;
            try {
                receipt = parseCompactionReceipt(serializedReceipt);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`session snapshot sessions[${index}].last_compaction_receipt is invalid: ${message}`);
            }
            if (receipt.generation !== compactionGeneration) {
                throw new Error(`session snapshot sessions[${index}] compaction receipt generation mismatch`);
            }
        }
        return {
            session_id: boundedString(row.session_id, `session snapshot sessions[${index}].session_id`, 200),
            started_at: startedAt,
            turn_count: row.turn_count,
            ...(lastTurnAt === undefined ? {} : { last_turn_at: lastTurnAt }),
            scope,
            ...(row.parent_session_id === undefined ? {} : {
                parent_session_id: boundedString(row.parent_session_id, `session snapshot sessions[${index}].parent_session_id`, 200),
            }),
            ...(row.start_event_id === undefined ? {} : {
                start_event_id: boundedString(row.start_event_id, `session snapshot sessions[${index}].start_event_id`, 200),
            }),
            ...(row.end_reason === undefined ? {} : {
                end_reason: boundedString(row.end_reason, `session snapshot sessions[${index}].end_reason`, 200),
            }),
            ...(row.ended_at === undefined ? {} : {
                ended_at: isoTimestamp(row.ended_at, `session snapshot sessions[${index}].ended_at`),
            }),
            updated_at: updatedAt,
            compaction_generation: compactionGeneration,
            ...(serializedReceipt === undefined ? {} : { last_compaction_receipt: serializedReceipt }),
        };
    });
    const turns = input.turns.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error(`session snapshot turns[${index}] must be an object`);
        }
        const row = raw;
        exactKeys(row, ["session_id", "turn_index", "role", "content", "timestamp"], `session snapshot turns[${index}]`);
        if (!Number.isInteger(row.turn_index) || row.turn_index < 0 || row.turn_index > 1_000_000) {
            throw new Error(`session snapshot turns[${index}].turn_index is invalid`);
        }
        if (row.role !== "user" && row.role !== "assistant") {
            throw new Error(`session snapshot turns[${index}].role is invalid`);
        }
        return {
            session_id: boundedString(row.session_id, `session snapshot turns[${index}].session_id`, 200),
            turn_index: row.turn_index,
            role: row.role,
            content: boundedString(row.content, `session snapshot turns[${index}].content`, 100_000, true),
            timestamp: isoTimestamp(row.timestamp, `session snapshot turns[${index}].timestamp`),
        };
    });
    sessions.sort((left, right) => left.session_id.localeCompare(right.session_id));
    turns.sort((left, right) => left.session_id.localeCompare(right.session_id) || left.turn_index - right.turn_index);
    const sessionIds = new Set();
    for (const session of sessions) {
        if (sessionIds.has(session.session_id))
            throw new Error(`duplicate session metadata: ${session.session_id}`);
        sessionIds.add(session.session_id);
    }
    const counts = new Map();
    const turnKeys = new Set();
    for (const turn of turns) {
        if (!sessionIds.has(turn.session_id))
            throw new Error(`turn references missing session metadata: ${turn.session_id}`);
        const key = `${turn.session_id}\u0000${turn.turn_index}`;
        if (turnKeys.has(key))
            throw new Error(`duplicate session turn: ${turn.session_id}:${turn.turn_index}`);
        turnKeys.add(key);
        const expectedIndex = counts.get(turn.session_id) ?? 0;
        if (turn.turn_index !== expectedIndex)
            throw new Error(`non-contiguous turn index for session: ${turn.session_id}`);
        counts.set(turn.session_id, expectedIndex + 1);
    }
    for (const session of sessions) {
        if (session.turn_count !== (counts.get(session.session_id) ?? 0)) {
            throw new Error(`turn_count mismatch for session: ${session.session_id}`);
        }
    }
    return { schema_version: 2, sessions, turns };
}
export async function snapshotSessionStorage() {
    return withCoordinatorReadBarrier(async () => {
        const db = await getDb();
        if (!db)
            return null;
        const sessions = db.prepare(`SELECT ${SESSION_META_COLUMNS} FROM session_meta ORDER BY session_id ASC`).all().map(sessionMetaFromRow);
        const turns = db.prepare(`SELECT session_id, turn_index, role, content, timestamp
     FROM sessions_fts
     ORDER BY session_id ASC, turn_index ASC`).all();
        return validateSessionStorageSnapshot({ schema_version: 2, sessions, turns });
    });
}
export async function snapshotSessionStorageAfterWriteBarrier() {
    return withCoordinatorReadBarrier(async () => {
        const db = await getDb();
        if (!db)
            return null;
        return withSessionWriteLock(async () => {
            const capture = db.transaction(() => {
                const sessions = db.prepare(`SELECT ${SESSION_META_COLUMNS} FROM session_meta ORDER BY session_id ASC`).all().map(sessionMetaFromRow);
                const turns = db.prepare(`SELECT session_id, turn_index, role, content, timestamp
         FROM sessions_fts
         ORDER BY session_id ASC, turn_index ASC`).all();
                return validateSessionStorageSnapshot({ schema_version: 2, sessions, turns });
            });
            return withSqliteContentionRetry(() => capture.immediate());
        });
    });
}
export async function replaceSessionStorageSnapshot(value) {
    return withCoordinatorMutationBarrier(async () => {
        const snapshot = validateSessionStorageSnapshot(value);
        const db = await getDb();
        if (!db)
            return false;
        return withSessionWriteLock(async () => {
            const replace = db.transaction(() => {
                db.prepare("DELETE FROM session_meta").run();
                db.prepare("DELETE FROM sessions_fts").run();
                const insertMeta = db.prepare(`INSERT INTO session_meta (
          session_id, started_at, turn_count, last_turn_at, scope, parent_session_id,
          start_event_id, end_reason, ended_at, updated_at, compaction_generation,
          last_compaction_receipt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                const insertTurn = db.prepare("INSERT INTO sessions_fts (session_id, turn_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
                for (const session of snapshot.sessions) {
                    insertMeta.run(session.session_id, session.started_at, session.turn_count, session.last_turn_at ?? null, session.scope, session.parent_session_id ?? null, session.start_event_id ?? null, session.end_reason ?? null, session.ended_at ?? null, session.updated_at, session.compaction_generation, session.last_compaction_receipt ?? null);
                }
                for (const turn of snapshot.turns) {
                    insertTurn.run(turn.session_id, turn.turn_index, turn.role, turn.content, turn.timestamp);
                }
            });
            await withSqliteContentionRetry(() => replace());
            return true;
        });
    });
}
