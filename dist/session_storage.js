import { mkdirSync } from "fs";
import { join } from "path";
import { STORE_DIR } from "./storage.js";
const DB_PATH = join(STORE_DIR, "sessions.db");
export const SESSION_STORAGE_UNAVAILABLE = "Session storage is unavailable: better-sqlite3 native module could not be loaded.";
let _db = null;
let _dbLoadPromise = null;
let _loadFailed = false;
let _lastFailureTime = null;
let _closed = false; // J1-fix: track explicit close to prevent leaked connections
const configuredRetryIntervalMs = Number.parseInt(process.env.HERMES_SESSION_RETRY_MS ?? "", 10);
const RETRY_INTERVAL_MS = configuredRetryIntervalMs > 0 ? configuredRetryIntervalMs : 60_000;
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
            _db = new DatabaseCtor(DB_PATH);
            _db.pragma("journal_mode = WAL");
            _db.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        last_turn_at TEXT
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
            return _db;
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
export async function appendSessionTurn(sessionId, role, content, timestamp) {
    const db = await getDb();
    if (!db)
        return false;
    const ts = timestamp ?? new Date().toISOString();
    // G4-fix: wrap SELECT + INSERT/UPDATE + INSERT in a transaction for atomicity
    const tx = db.transaction(() => {
        const meta = db.prepare("SELECT turn_count FROM session_meta WHERE session_id = ?").get(sessionId);
        const turnIndex = meta ? meta.turn_count : 0;
        if (!meta) {
            db.prepare("INSERT INTO session_meta (session_id, started_at, turn_count, last_turn_at) VALUES (?, ?, 1, ?)").run(sessionId, ts, ts);
        }
        else {
            db.prepare("UPDATE session_meta SET turn_count = turn_count + 1, last_turn_at = ? WHERE session_id = ?").run(ts, sessionId);
        }
        db.prepare("INSERT INTO sessions_fts (session_id, turn_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(sessionId, turnIndex, role, content, ts);
    });
    tx();
    return true;
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
function firstSnippetNeedle(query, content) {
    const lowerContent = content.toLowerCase();
    for (const term of queryTerms(query)) {
        const idx = lowerContent.indexOf(term.toLowerCase());
        if (idx >= 0)
            return { index: idx, length: term.length };
    }
    return { index: 0, length: Math.min(query.length, content.length) };
}
export async function searchSessions(query, limit = 10, sinceDays) {
    const db = await getDb();
    if (!db)
        return null;
    const safeLimit = Math.max(1, Math.min(limit, 100));
    let sql = `
    SELECT session_id, turn_index, role, content, timestamp,
           rank AS fts_rank
    FROM sessions_fts
    WHERE sessions_fts MATCH ?
  `;
    const params = [buildFtsQuery(query)];
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
        const needle = firstSnippetNeedle(query, row.content);
        const start = Math.max(0, needle.index - 80);
        const end = Math.min(row.content.length, needle.index + needle.length + 80);
        const snippet = (start > 0 ? "..." : "") +
            row.content.slice(start, end).replace(/\n/g, " ") +
            (end < row.content.length ? "..." : "");
        return {
            session_id: row.session_id,
            turn_index: row.turn_index,
            role: row.role,
            timestamp: row.timestamp,
            snippet,
            rank: row.fts_rank,
        };
    });
}
export async function listRecentSessions(limit = 20, sinceDays) {
    const db = await getDb();
    if (!db)
        return null;
    const safeLimit = Math.max(1, Math.min(limit, 100));
    // E2-fix: support sinceDays filter for empty-query search_sessions
    if (sinceDays !== undefined && sinceDays >= 1) {
        const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();
        return db.prepare("SELECT session_id, started_at, turn_count, last_turn_at FROM session_meta WHERE last_turn_at >= ? ORDER BY last_turn_at DESC LIMIT ?").all(cutoff, safeLimit);
    }
    return db.prepare("SELECT session_id, started_at, turn_count, last_turn_at FROM session_meta ORDER BY last_turn_at DESC LIMIT ?").all(safeLimit);
}
export async function listSessionTurns(sessionId, limit = 50) {
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
}
export async function listSessionTurnsAround(sessionId, anchorTurnIndex, window = 5) {
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
    const db = await getDb();
    if (!db)
        return false;
    // J2-fix: wrap both DELETEs in a transaction for atomicity
    db.transaction(() => {
        db.prepare("DELETE FROM session_meta").run();
        db.prepare("DELETE FROM sessions_fts").run();
    })();
    return true;
}
