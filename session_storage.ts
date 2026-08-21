// session_storage.ts
import type Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "fs";
import { join } from "path";
import { STORE_DIR } from "./storage.js";
import type {
  CapturedTurnSide,
  CompactionObservation,
  SessionSearchResult,
  SessionMeta,
  SessionTurn,
} from "./types.js";
import { withFileLock } from "./src/file_lock.js";
import { codePointLength, redactSensitiveText } from "./src/redaction.js";
import { compareStableText } from "./src/stable_order.js";
import { OperationJournalStoreUnavailableError } from "./src/operation_journal.js";
import {
  createCompactionReceipt,
  parseCompactionReceipt,
  type CompactionMetadata,
  type CompactionReceipt,
} from "./src/compaction_handoff.js";
import {
  assertSessionScopeVisibility,
  lifecycleNotReady,
  normalizePersistedSessionScope,
  normalizeRequestedSessionScope,
  type RequestedSessionScope,
} from "./src/session_scope.js";

const DB_PATH = join(STORE_DIR, "sessions.db");
const operationJournalMutationContext = new AsyncLocalStorage<boolean>();

async function withCoordinatorReadBarrier<T>(callback: () => Promise<T>): Promise<T> {
  const { withOperationJournalBarrier } = await import("./src/operation_journal.js");
  return withOperationJournalBarrier(callback);
}

async function withCoordinatorMutationBarrier<T>(callback: () => Promise<T>): Promise<T> {
  if (operationJournalMutationContext.getStore() === true) return callback();
  return withCoordinatorReadBarrier(() => operationJournalMutationContext.run(true, callback));
}
export const SESSION_STORAGE_UNAVAILABLE =
  "Session storage is unavailable: better-sqlite3 native module could not be loaded.";
export interface SessionStorageSnapshot {
  schema_version: 2;
  sessions: SessionMeta[];
  turns: SessionTurn[];
}

export interface SessionStartProvenance {
  scope: RequestedSessionScope;
  parent_session_id?: string;
  start_event_id?: string;
  started_at?: string;
}

export interface SessionEndProvenance {
  scope: RequestedSessionScope;
  end_reason: string;
  ended_at?: string;
}

export interface SessionAppendProvenance {
  scope?: RequestedSessionScope;
}

export interface CapturedTurnSideInput extends CapturedTurnSide {
  scope: RequestedSessionScope;
}

export interface CapturedTurnStageResult {
  state: "staged" | "committed" | "duplicate";
  turn_indexes?: [number, number];
}

export interface CompactionObservationInput extends CompactionObservation {
  scope: RequestedSessionScope;
}
let _db: Database.Database | null = null;
let _dbLoadPromise: Promise<Database.Database | null> | null = null;
let _loadFailed = false;
let _lastFailureTime: number | null = null;
let _closed = false;  // J1-fix: track explicit close to prevent leaked connections
const configuredRetryIntervalMs = Number.parseInt(process.env.HERMES_SESSION_RETRY_MS ?? "", 10);
const RETRY_INTERVAL_MS = configuredRetryIntervalMs > 0 ? configuredRetryIntervalMs : 60_000;

const SESSION_META_COLUMNS = `
  session_id, started_at, turn_count, last_turn_at, scope,
  parent_session_id, start_event_id, end_reason, ended_at, updated_at,
  compaction_generation, last_compaction_receipt
`;

function initializeSessionSchema(db: Database.Database): void {
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
    const existing = new Set(
      (db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    const additions: Array<[string, string]> = [
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
      if (!existing.has(name)) db.exec(`ALTER TABLE session_meta ADD COLUMN ${name} ${declaration}`);
    }
    db.prepare(
      "UPDATE session_meta SET updated_at = COALESCE(last_turn_at, started_at) WHERE updated_at = ''",
    ).run();
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_turn_sides (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('user', 'assistant')),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        original_code_points INTEGER NOT NULL,
        content_truncated INTEGER NOT NULL CHECK (content_truncated IN (0, 1)),
        content_blocked INTEGER NOT NULL CHECK (content_blocked IN (0, 1)),
        PRIMARY KEY (session_id, turn_id, side)
      );
      CREATE INDEX IF NOT EXISTS pending_turn_expiry_idx
        ON pending_turn_sides(expires_at);
      CREATE TABLE IF NOT EXISTS committed_turn_pairs (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        user_hash TEXT NOT NULL,
        assistant_hash TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id)
      );
      CREATE TABLE IF NOT EXISTS compaction_observations (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('pre', 'post')),
        trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
        occurred_at TEXT NOT NULL,
        scope TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS compaction_observation_session_idx
        ON compaction_observations(session_id, occurred_at);
    `);
  });
  migrate.immediate();
}

async function withSessionWriteLock<T>(operation: () => Promise<T> | T): Promise<T> {
  return withFileLock(DB_PATH, operation, {
    timeout_ms: 30_000,
    retry_ms: 10,
    stale_ms: 120_000,
  });
}

export interface SqliteContentionRetryOptions {
  attempts?: number;
  base_delay_ms?: number;
  max_delay_ms?: number;
}

function sqliteErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Retry a complete, rollback-safe SQLite transaction on cross-process lock contention. */
export async function withSqliteContentionRetry<T>(
  operation: () => T,
  options: SqliteContentionRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.min(20, Math.trunc(options.attempts ?? 8)));
  const baseDelayMs = Math.max(0, Math.min(1_000, Math.trunc(options.base_delay_ms ?? 15)));
  const maxDelayMs = Math.max(baseDelayMs, Math.min(5_000, Math.trunc(options.max_delay_ms ?? 250)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      const retryable = /^SQLITE_(?:BUSY|LOCKED)$/.test(sqliteErrorCode(error) ?? "");
      if (!retryable || attempt === attempts - 1) throw error;
      const backoff = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      const jitter = baseDelayMs === 0 ? 0 : (process.pid + attempt) % Math.max(2, baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }
  throw new Error("SQLite contention retry exhausted without a result");
}

async function getDb(): Promise<Database.Database | null> {
  if (_db) return _db;
  // J1-fix: if closeSessionStorage was called, don't create new connections
  if (_closed) return null;
  // B12-fix: use a shared load promise to prevent concurrent instantiation
  if (_dbLoadPromise) return _dbLoadPromise;
  if (_loadFailed) {
    if (_lastFailureTime !== null && Date.now() - _lastFailureTime < RETRY_INTERVAL_MS) {
      return null;
    }
    _loadFailed = false;
    _lastFailureTime = null;
  }
  // J1-fix: use local promise variable so finally only clears if still pointing to us
  const myPromiseRef: { current: Promise<Database.Database | null> | null } = { current: null };
  const myPromise = (async () => {
    try {
      const { default: DatabaseCtor } = await import("better-sqlite3");
      mkdirSync(STORE_DIR, { recursive: true });
      // J1-fix: don't assign _db if closeSessionStorage was called during await
      if (_closed) return null;
      let candidate: Database.Database | null = null;
      let lastError: unknown;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          candidate = new DatabaseCtor(DB_PATH, { timeout: 5_000 });
          // Configure waiting before WAL/schema pragmas because simultaneous
          // Codex Desktop processes can race during their first open.
          candidate.pragma("busy_timeout = 5000");
          candidate.pragma("journal_mode = WAL");
          initializeSessionSchema(candidate);
          break;
        } catch (error) {
          lastError = error;
          candidate?.close();
          candidate = null;
          const code = error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
          if (!/^SQLITE_(?:BUSY|LOCKED)$/.test(code) || attempt === 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
      if (!candidate) throw lastError ?? new Error("SQLite initialization failed");
      if (_closed) {
        candidate.close();
        return null;
      }
      _db = candidate;
      return candidate;
    } catch (error) {
      _loadFailed = true;
      _lastFailureTime = Date.now();
      console.error("[hermes] session storage unavailable.", error);
      return null;
    } finally {
      // J1-fix: only clear if still pointing to our promise (not overwritten by a later getDb)
      if (_dbLoadPromise === myPromiseRef.current) _dbLoadPromise = null;
    }
  })();
  myPromiseRef.current = myPromise;
  _dbLoadPromise = myPromise;
  return myPromise;
}

type SessionMetaRow = Omit<SessionMeta, "last_turn_at" | "parent_session_id" | "start_event_id" |
  "end_reason" | "ended_at" | "last_compaction_receipt"> & {
    last_turn_at: string | null;
    parent_session_id: string | null;
    start_event_id: string | null;
    end_reason: string | null;
    ended_at: string | null;
    last_compaction_receipt: string | null;
  };

function sessionMetaFromRow(row: SessionMetaRow): SessionMeta {
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

function readSessionMeta(db: Database.Database, sessionId: string): SessionMeta | null {
  const row = db.prepare(`SELECT ${SESSION_META_COLUMNS} FROM session_meta WHERE session_id = ?`)
    .get(sessionId) as SessionMetaRow | undefined;
  return row ? sessionMetaFromRow(row) : null;
}

export async function getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  return withCoordinatorReadBarrier(async () => {
    const db = await getDb();
    if (!db) return null;
    return readSessionMeta(db, sessionId);
  });
}

export async function resolveSessionScope(sessionId: string): Promise<SessionMeta["scope"]> {
  const meta = await getSessionMeta(sessionId);
  if (!meta) throw lifecycleNotReady(`Session lifecycle metadata is not ready for ${sessionId}.`);
  return meta.scope;
}

export async function persistSessionStart(
  sessionId: string,
  provenance: SessionStartProvenance,
): Promise<boolean> {
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
  if (!db) return false;
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

export async function persistSessionEnd(
  sessionId: string,
  provenance: SessionEndProvenance,
): Promise<boolean> {
  return withCoordinatorMutationBarrier(async () => {
  const scope = normalizeRequestedSessionScope(provenance.scope);
  const endReason = boundedString(provenance.end_reason, "end_reason", 200);
  const endedAt = provenance.ended_at === undefined
    ? new Date().toISOString()
    : isoTimestamp(provenance.ended_at, "ended_at");
  const db = await getDb();
  if (!db) return false;
  return withSessionWriteLock(async () => {
    const persist = db.transaction(() => {
      const existing = readSessionMeta(db, sessionId);
      if (!existing) throw lifecycleNotReady(`Session lifecycle metadata is not ready for ${sessionId}.`);
      assertSessionScopeVisibility(existing.scope, scope);
      if (existing.ended_at !== undefined) {
        if (existing.end_reason !== endReason
          || (provenance.ended_at !== undefined && existing.ended_at !== endedAt)) {
          throw new Error("Session end provenance is immutable once persisted.");
        }
        return;
      }
      db.prepare(
        "UPDATE session_meta SET end_reason = ?, ended_at = ?, updated_at = ? WHERE session_id = ?",
      ).run(endReason, endedAt, endedAt, sessionId);
    });
    await withSqliteContentionRetry(() => persist());
    return true;
  });
  });
}

/** Atomically advance one scope-bound session's canonical compaction receipt. */
export async function persistCompactionReceipt(
  sessionId: string,
  metadata: CompactionMetadata,
  requestedScope?: RequestedSessionScope,
): Promise<CompactionReceipt | null> {
  return withCoordinatorMutationBarrier(async () => {
    const receipt = createCompactionReceipt(metadata);
    const scope = requestedScope === undefined ? undefined : normalizeRequestedSessionScope(requestedScope);
    const db = await getDb();
    if (!db) return null;
    return withSessionWriteLock(async () => {
      let committed!: CompactionReceipt;
      const persist = db.transaction(() => {
        const existing = readSessionMeta(db, sessionId);
        if (!existing) throw lifecycleNotReady(`Session lifecycle metadata is not ready for ${sessionId}.`);
        if (scope !== undefined) assertSessionScopeVisibility(existing.scope, scope);

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
          throw new Error(
            `COMPACTION_GENERATION_INVALID: expected ${existing.compaction_generation + 1}, received ${receipt.generation}`,
          );
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

export async function appendSessionTurn(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  timestamp?: string,
  provenance: SessionAppendProvenance = {},
): Promise<boolean> {
  try {
    return await withCoordinatorMutationBarrier(async () => {
  const db = await getDb();
  if (!db) return false;
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
        db.prepare(
          `INSERT INTO session_meta (
             session_id, started_at, turn_count, last_turn_at, scope, updated_at,
             compaction_generation
           ) VALUES (?, ?, 1, ?, ?, ?, 0)`
        ).run(sessionId, ts, ts, newSessionScope, ts);
      } else {
        if (requestedScope !== undefined) assertSessionScopeVisibility(meta.scope, requestedScope);
        db.prepare(
          `UPDATE session_meta
           SET turn_count = turn_count + 1,
               started_at = CASE WHEN ? < started_at THEN ? ELSE started_at END,
               last_turn_at = CASE WHEN last_turn_at IS NULL OR ? > last_turn_at THEN ? ELSE last_turn_at END,
               updated_at = CASE WHEN ? > updated_at THEN ? ELSE updated_at END
           WHERE session_id = ?`
        ).run(ts, ts, ts, ts, ts, ts, sessionId);
      }

      db.prepare(
        "INSERT INTO sessions_fts (session_id, turn_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)"
      ).run(sessionId, turnIndex, role, content, ts);
    });
    await withSqliteContentionRetry(() => tx());
    return true;
  });
    });
  } catch (error) {
    if (error instanceof OperationJournalStoreUnavailableError) return false;
    throw error;
  }
}

type PendingTurnSideRow = Omit<CapturedTurnSide, "content_truncated" | "content_blocked"> & {
  content_truncated: number;
  content_blocked: number;
};

type CommittedTurnPairRow = {
  user_hash: string;
  assistant_hash: string;
};

function safeCoordinationId(value: unknown, label: string): string {
  const text = boundedString(value, label, 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw new Error(`${label} must contain only safe identifier characters`);
  }
  return text;
}

function sha256Digest(value: unknown, label: string): string {
  const digest = boundedString(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

function capturedBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function capturedCount(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
    throw new Error(`${label} must be an integer between 0 and 1000000`);
  }
  return value as number;
}

function validateCapturedTurnSide(input: CapturedTurnSideInput): CapturedTurnSideInput {
  const content = boundedString(input.content, "content", 24_000, true);
  if (codePointLength(content) > 12_000) {
    throw new Error("content must contain at most 12000 Unicode code points");
  }
  if (input.side !== "user" && input.side !== "assistant") {
    throw new Error("side must be user or assistant");
  }
  const occurredAt = isoTimestamp(input.occurred_at, "occurred_at");
  const expiresAt = isoTimestamp(input.expires_at, "expires_at");
  if (expiresAt <= occurredAt) throw new Error("expires_at must be later than occurred_at");
  return {
    session_id: safeCoordinationId(input.session_id, "session_id"),
    turn_id: safeCoordinationId(input.turn_id, "turn_id"),
    side: input.side,
    content,
    content_hash: sha256Digest(input.content_hash, "content_hash"),
    occurred_at: occurredAt,
    expires_at: expiresAt,
    original_code_points: capturedCount(input.original_code_points, "original_code_points"),
    content_truncated: capturedBoolean(input.content_truncated, "content_truncated"),
    content_blocked: capturedBoolean(input.content_blocked, "content_blocked"),
    scope: normalizeRequestedSessionScope(input.scope),
  };
}

function pendingSideFromRow(row: PendingTurnSideRow): CapturedTurnSide {
  return {
    ...row,
    side: row.side as "user" | "assistant",
    content_truncated: row.content_truncated === 1,
    content_blocked: row.content_blocked === 1,
  };
}

function sameCapturedProjection(left: CapturedTurnSide, right: CapturedTurnSide): boolean {
  return left.content_hash === right.content_hash
    && left.content === right.content
    && left.original_code_points === right.original_code_points
    && left.content_truncated === right.content_truncated
    && left.content_blocked === right.content_blocked;
}

function maxTimestamp(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => value !== undefined).sort().at(-1)!;
}

function minTimestamp(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => value !== undefined).sort().at(0)!;
}

export async function stageCapturedTurnSide(
  rawInput: CapturedTurnSideInput,
): Promise<CapturedTurnStageResult> {
  return withCoordinatorMutationBarrier(async () => {
    const input = validateCapturedTurnSide(rawInput);
    const db = await getDb();
    if (!db) throw new Error(SESSION_STORAGE_UNAVAILABLE);
    return withSessionWriteLock(async () => {
      let result: CapturedTurnStageResult = { state: "staged" };
      const stage = db.transaction(() => {
        const meta = readSessionMeta(db, input.session_id);
        if (!meta) throw lifecycleNotReady(`Session lifecycle metadata is not ready for ${input.session_id}.`);
        assertSessionScopeVisibility(meta.scope, input.scope);

        const committed = db.prepare(`
          SELECT user_hash, assistant_hash FROM committed_turn_pairs
          WHERE session_id = ? AND turn_id = ?
        `).get(input.session_id, input.turn_id) as CommittedTurnPairRow | undefined;
        if (committed) {
          const canonicalHash = input.side === "user" ? committed.user_hash : committed.assistant_hash;
          if (canonicalHash !== input.content_hash) {
            throw new Error("CAPTURED_TURN_CONFLICT: committed turn side has different content");
          }
          result = { state: "duplicate" };
          return;
        }

        const existingRow = db.prepare(`
          SELECT session_id, turn_id, side, content, content_hash, occurred_at, expires_at,
                 original_code_points, content_truncated, content_blocked
          FROM pending_turn_sides WHERE session_id = ? AND turn_id = ? AND side = ?
        `).get(input.session_id, input.turn_id, input.side) as PendingTurnSideRow | undefined;
        if (existingRow) {
          const existing = pendingSideFromRow(existingRow);
          if (!sameCapturedProjection(existing, input)) {
            throw new Error("CAPTURED_TURN_CONFLICT: pending turn side has different content or safety projection");
          }
        } else {
          db.prepare(`
            INSERT INTO pending_turn_sides (
              session_id, turn_id, side, content, content_hash, occurred_at, expires_at,
              original_code_points, content_truncated, content_blocked
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            input.session_id,
            input.turn_id,
            input.side,
            input.content,
            input.content_hash,
            input.occurred_at,
            input.expires_at,
            input.original_code_points,
            input.content_truncated ? 1 : 0,
            input.content_blocked ? 1 : 0,
          );
        }

        const rows = db.prepare(`
          SELECT session_id, turn_id, side, content, content_hash, occurred_at, expires_at,
                 original_code_points, content_truncated, content_blocked
          FROM pending_turn_sides WHERE session_id = ? AND turn_id = ? ORDER BY side
        `).all(input.session_id, input.turn_id) as PendingTurnSideRow[];
        const userRow = rows.find((row) => row.side === "user");
        const assistantRow = rows.find((row) => row.side === "assistant");
        if (!userRow || !assistantRow) {
          result = { state: "staged" };
          return;
        }
        const user = pendingSideFromRow(userRow);
        const assistant = pendingSideFromRow(assistantRow);
        const userIndex = meta.turn_count;
        const assistantIndex = userIndex + 1;
        const insertTurn = db.prepare(
          "INSERT INTO sessions_fts (session_id, turn_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
        );
        insertTurn.run(input.session_id, userIndex, "user", user.content, user.occurred_at);
        insertTurn.run(input.session_id, assistantIndex, "assistant", assistant.content, assistant.occurred_at);
        const updatedAt = maxTimestamp(meta.updated_at, user.occurred_at, assistant.occurred_at);
        const lastTurnAt = maxTimestamp(meta.last_turn_at, user.occurred_at, assistant.occurred_at);
        const startedAt = minTimestamp(meta.started_at, user.occurred_at, assistant.occurred_at);
        db.prepare(`
          UPDATE session_meta SET turn_count = turn_count + 2, started_at = ?, last_turn_at = ?, updated_at = ?
          WHERE session_id = ?
        `).run(startedAt, lastTurnAt, updatedAt, input.session_id);
        db.prepare(`
          INSERT INTO committed_turn_pairs (session_id, turn_id, user_hash, assistant_hash, committed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(input.session_id, input.turn_id, user.content_hash, assistant.content_hash, updatedAt);
        db.prepare("DELETE FROM pending_turn_sides WHERE session_id = ? AND turn_id = ?")
          .run(input.session_id, input.turn_id);
        result = { state: "committed", turn_indexes: [userIndex, assistantIndex] };
      });
      await withSqliteContentionRetry(() => stage.immediate());
      return result;
    });
  });
}

export async function cleanupPendingTurnSides(options: {
  session_id?: string;
  now?: string;
} = {}): Promise<number> {
  return withCoordinatorMutationBarrier(async () => {
    const sessionId = options.session_id === undefined
      ? undefined
      : safeCoordinationId(options.session_id, "session_id");
    const now = options.now === undefined ? new Date().toISOString() : isoTimestamp(options.now, "now");
    const db = await getDb();
    if (!db) throw new Error(SESSION_STORAGE_UNAVAILABLE);
    return withSessionWriteLock(async () => {
      let removed = 0;
      const clean = db.transaction(() => {
        const info = sessionId === undefined
          ? db.prepare("DELETE FROM pending_turn_sides WHERE expires_at <= ?").run(now)
          : db.prepare("DELETE FROM pending_turn_sides WHERE session_id = ?").run(sessionId);
        removed = info.changes;
      });
      await withSqliteContentionRetry(() => clean.immediate());
      return removed;
    });
  });
}

function validateCompactionObservation(input: CompactionObservationInput): CompactionObservationInput {
  if (input.phase !== "pre" && input.phase !== "post") throw new Error("phase must be pre or post");
  if (input.trigger !== "auto" && input.trigger !== "manual") throw new Error("trigger must be auto or manual");
  return {
    event_id: safeCoordinationId(input.event_id, "event_id"),
    session_id: safeCoordinationId(input.session_id, "session_id"),
    turn_id: safeCoordinationId(input.turn_id, "turn_id"),
    phase: input.phase,
    trigger: input.trigger,
    occurred_at: isoTimestamp(input.occurred_at, "occurred_at"),
    scope: normalizeRequestedSessionScope(input.scope),
  };
}

function sameCompactionObservation(left: CompactionObservation, right: CompactionObservation): boolean {
  return left.event_id === right.event_id
    && left.session_id === right.session_id
    && left.turn_id === right.turn_id
    && left.phase === right.phase
    && left.trigger === right.trigger
    && left.occurred_at === right.occurred_at
    && left.scope === right.scope;
}

export async function persistCompactionObservation(
  rawInput: CompactionObservationInput,
): Promise<"inserted" | "duplicate"> {
  return withCoordinatorMutationBarrier(async () => {
    const input = validateCompactionObservation(rawInput);
    const db = await getDb();
    if (!db) throw new Error(SESSION_STORAGE_UNAVAILABLE);
    return withSessionWriteLock(async () => {
      let result: "inserted" | "duplicate" = "inserted";
      const persist = db.transaction(() => {
        const meta = readSessionMeta(db, input.session_id);
        if (!meta) throw lifecycleNotReady(`Session lifecycle metadata is not ready for ${input.session_id}.`);
        assertSessionScopeVisibility(meta.scope, input.scope);
        const existing = db.prepare(`
          SELECT event_id, session_id, turn_id, phase, trigger, occurred_at, scope
          FROM compaction_observations WHERE event_id = ?
        `).get(input.event_id) as CompactionObservation | undefined;
        if (existing) {
          if (!sameCompactionObservation(existing, input)) {
            throw new Error("COMPACTION_OBSERVATION_CONFLICT: event_id is already bound to different input");
          }
          result = "duplicate";
          return;
        }
        db.prepare(`
          INSERT INTO compaction_observations (
            event_id, session_id, turn_id, phase, trigger, occurred_at, scope
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.event_id,
          input.session_id,
          input.turn_id,
          input.phase,
          input.trigger,
          input.occurred_at,
          input.scope,
        );
      });
      await withSqliteContentionRetry(() => persist.immediate());
      return result;
    });
  });
}

export async function listCompactionObservations(sessionId: string): Promise<CompactionObservation[]> {
  return withCoordinatorReadBarrier(async () => {
    const canonicalSessionId = safeCoordinationId(sessionId, "session_id");
    const db = await getDb();
    if (!db) throw new Error(SESSION_STORAGE_UNAVAILABLE);
    return db.prepare(`
      SELECT event_id, session_id, turn_id, phase, trigger, occurred_at, scope
      FROM compaction_observations WHERE session_id = ? ORDER BY occurred_at, event_id
    `).all(canonicalSessionId) as CompactionObservation[];
  });
}

function quoteFtsTerm(term: string): string {
  const cleaned = term.replace(/[\x00-\x1F\x7F]/g, "").replace(/"/g, '""');
  return `"${cleaned}"`;
}

function queryTerms(query: string): string[] {
  const matches = query.match(/"([^"]+)"|[^\s"]+/g) ?? [];
  return matches
    .map((term) => term.replace(/^"|"$/g, "").replace(/\*$/g, ""))
    .filter((term) => term.length > 0 && !["AND", "OR", "NOT"].includes(term));
}

function buildLiteralFtsQuery(query: string): string {
  const terms = queryTerms(query);
  if (terms.length === 0) return quoteFtsTerm(query);
  return terms.map(quoteFtsTerm).join(" AND ");
}

function buildFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return quoteFtsTerm("");
  const hasExplicitOperator = /(^|\s)(AND|OR|NOT)(\s|$)/.test(trimmed);
  const hasPrefix = /(?:^|\s)[^\s"]+\*/.test(trimmed);
  const isPhrase = /^"[^"]+"$/.test(trimmed);
  if (hasExplicitOperator || hasPrefix || isPhrase) return trimmed;
  return buildLiteralFtsQuery(trimmed);
}

function buildSafeSnippet(query: string, content: string): string {
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

async function searchSessionsInternal(
  query: string,
  limit = 10,
  sinceDays?: number,
  scope?: RequestedSessionScope,
): Promise<SessionSearchResult[] | null> {
  const db = await getDb();
  if (!db) return null;
  const safeLimit = Math.max(1, Math.min(limit, 100));
  let sql = `
    SELECT sessions_fts.session_id, turn_index, role, content, timestamp,
           rank AS fts_rank
    FROM sessions_fts
    ${scope === undefined ? "" : "JOIN session_meta ON session_meta.session_id = sessions_fts.session_id"}
    WHERE sessions_fts MATCH ?
  `;
  const params: (string | number)[] = [buildFtsQuery(query)];
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

  let rows: Array<{
    session_id: string;
    turn_index: number;
    role: string;
    content: string;
    timestamp: string;
    fts_rank: number;
  }>;
  try {
    rows = db.prepare(sql).all(...params) as typeof rows;
  } catch (error) {
    console.warn("[hermes] FTS query failed, trying literal fallback:", query);
    try {
      params[0] = buildLiteralFtsQuery(query);
      rows = db.prepare(sql).all(...params) as typeof rows;
    } catch (fallbackError) {
      console.error("[hermes] FTS search failed with fallback query too:", fallbackError);
      return null;  // A11-fix: return null (unavailable) instead of [] (no match)
    }
  }

  return rows.map((row) => {
    return {
      session_id: row.session_id,
      turn_index: row.turn_index,
      role: row.role as "user" | "assistant",
      timestamp: row.timestamp,
      snippet: buildSafeSnippet(query, row.content),
      rank: row.fts_rank,
    };
  });
}

export async function searchSessions(
  query: string,
  limit = 10,
  sinceDays?: number,
): Promise<SessionSearchResult[] | null> {
  try {
    return await withCoordinatorReadBarrier(() => searchSessionsInternal(query, limit, sinceDays));
  } catch (error) {
    if (error instanceof OperationJournalStoreUnavailableError) return null;
    throw error;
  }
}

export async function searchSessionsInScope(
  query: string,
  scope: RequestedSessionScope,
  limit = 10,
  sinceDays?: number,
): Promise<SessionSearchResult[] | null> {
  try {
    return await withCoordinatorReadBarrier(() => searchSessionsInternal(query, limit, sinceDays, normalizeRequestedSessionScope(scope)));
  } catch (error) {
    if (error instanceof OperationJournalStoreUnavailableError) return null;
    throw error;
  }
}

export async function listRecentSessions(limit = 20, sinceDays?: number): Promise<SessionMeta[] | null> {
  return withCoordinatorReadBarrier(async () => {
  const db = await getDb();
  if (!db) return null;
  const safeLimit = Math.max(1, Math.min(limit, 100));
  // E2-fix: support sinceDays filter for empty-query search_sessions
  if (sinceDays !== undefined && sinceDays >= 1) {
    const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();
    const rows = db.prepare(
      `SELECT ${SESSION_META_COLUMNS} FROM session_meta WHERE last_turn_at >= ? ORDER BY last_turn_at DESC LIMIT ?`
    ).all(cutoff, safeLimit) as SessionMetaRow[];
    return rows.map(sessionMetaFromRow);
  }
  const rows = db.prepare(
    `SELECT ${SESSION_META_COLUMNS} FROM session_meta ORDER BY last_turn_at DESC LIMIT ?`
  ).all(safeLimit) as SessionMetaRow[];
  return rows.map(sessionMetaFromRow);
  });
}

export async function listRecentSessionsInScope(
  scope: RequestedSessionScope,
  limit = 20,
  sinceDays?: number,
): Promise<SessionMeta[] | null> {
  return withCoordinatorReadBarrier(async () => {
  const db = await getDb();
  if (!db) return null;
  const requestedScope = normalizeRequestedSessionScope(scope);
  const safeLimit = Math.max(1, Math.min(limit, 100));
  if (sinceDays !== undefined && sinceDays >= 1) {
    const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();
    const rows = db.prepare(
      `SELECT ${SESSION_META_COLUMNS} FROM session_meta
       WHERE scope = ? AND last_turn_at >= ? ORDER BY last_turn_at DESC LIMIT ?`,
    ).all(requestedScope, cutoff, safeLimit) as SessionMetaRow[];
    return rows.map(sessionMetaFromRow);
  }
  const rows = db.prepare(
    `SELECT ${SESSION_META_COLUMNS} FROM session_meta
     WHERE scope = ? ORDER BY last_turn_at DESC LIMIT ?`,
  ).all(requestedScope, safeLimit) as SessionMetaRow[];
  return rows.map(sessionMetaFromRow);
  });
}

export async function listSessionTurns(sessionId: string, limit = 50): Promise<SessionTurn[] | null> {
  return withCoordinatorReadBarrier(async () => {
  const db = await getDb();
  if (!db) return null;
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const rows = db.prepare(
    `SELECT session_id, turn_index, role, content, timestamp
     FROM sessions_fts
     WHERE session_id = ?
     ORDER BY turn_index DESC
     LIMIT ?`
  ).all(sessionId, safeLimit) as SessionTurn[];
  return rows.reverse().map((row) => ({
    ...row,
    role: row.role as "user" | "assistant",
  }));
  });
}

export async function getSessionTurn(sessionId: string, turnIndex: number): Promise<SessionTurn | null> {
  return withCoordinatorReadBarrier(async () => {
  const db = await getDb();
  if (!db) return null;
  if (!Number.isInteger(turnIndex) || turnIndex < 0) return null;
  const row = db.prepare(
    `SELECT session_id, turn_index, role, content, timestamp
     FROM sessions_fts
     WHERE session_id = ? AND turn_index = ?
     LIMIT 1`
  ).get(sessionId, turnIndex) as SessionTurn | undefined;
  return row ? { ...row, role: row.role as "user" | "assistant" } : null;
  });
}

export interface SessionTurnsWindow {
  turns: SessionTurn[];
  has_before: boolean;
  has_after: boolean;
  available_range: { first_turn_index: number; last_turn_index: number } | null;
}

export async function listSessionTurnsAround(
  sessionId: string,
  anchorTurnIndex: number,
  window = 5,
): Promise<SessionTurnsWindow | null> {
  return withCoordinatorReadBarrier(async () => {
  const db = await getDb();
  if (!db) return null;
  const safeWindow = Math.max(1, Math.min(window, 50));
  const start = Math.max(0, anchorTurnIndex - safeWindow);
  const end = anchorTurnIndex + safeWindow;

  const rows = db.prepare(
    `SELECT session_id, turn_index, role, content, timestamp
     FROM sessions_fts
     WHERE session_id = ? AND turn_index >= ? AND turn_index <= ?
     ORDER BY turn_index ASC`
  ).all(sessionId, start, end) as SessionTurn[];

  const bounds = db.prepare(
    `SELECT MIN(turn_index) AS first_turn_index, MAX(turn_index) AS last_turn_index
     FROM sessions_fts
     WHERE session_id = ?`
  ).get(sessionId) as { first_turn_index: number | null; last_turn_index: number | null } | undefined;

  const first = bounds?.first_turn_index;
  const last = bounds?.last_turn_index;
  const availableRange = first === null || first === undefined || last === null || last === undefined
    ? null
    : { first_turn_index: first, last_turn_index: last };

  return {
    turns: rows.map((row) => ({
      ...row,
      role: row.role as "user" | "assistant",
    })),
    has_before: availableRange ? start > availableRange.first_turn_index : false,
    has_after: availableRange ? end < availableRange.last_turn_index : false,
    available_range: availableRange,
  };
  });
}

export function closeSessionStorage(): void {
  // G6-fix: also reset load state to prevent leaked connections after async load
  _closed = true;  // J1-fix: mark as closed so getDb won't create new connections
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
export async function clearSessionStorage(): Promise<boolean> {
  return replaceSessionStorageSnapshot(emptySessionStorageSnapshot());
}

export async function withOperationJournalSessionMutation<T>(callback: () => Promise<T>): Promise<T> {
  const journal = await import("./src/operation_journal.js");
  journal.assertOperationJournalCoordinatorContext();
  return operationJournalMutationContext.run(true, callback);
}

export function emptySessionStorageSnapshot(): SessionStorageSnapshot {
  return { schema_version: 2, sessions: [], turns: [] };
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function boundedString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new Error(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${max} characters`);
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) {
    throw new Error(`${label} contains forbidden control characters`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const text = boundedString(value, label, 100);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return text;
}

export function validateSessionStorageSnapshot(value: unknown): SessionStorageSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session snapshot must be an object");
  }
  const input = value as Record<string, unknown>;
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

  const sessions = input.sessions.map((raw, index): SessionMeta => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`session snapshot sessions[${index}] must be an object`);
    }
    const row = raw as Record<string, unknown>;
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
    if (!Number.isInteger(row.turn_count) || (row.turn_count as number) < 0 || (row.turn_count as number) > 1_000_000) {
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
      || (compactionGeneration as number) < 0
      || (compactionGeneration as number) > 1_000_000) {
      throw new Error(`session snapshot sessions[${index}].compaction_generation is invalid`);
    }
    const serializedReceipt = row.last_compaction_receipt === undefined
      ? undefined
      : boundedString(
          row.last_compaction_receipt,
          `session snapshot sessions[${index}].last_compaction_receipt`,
          2_048,
        );
    if (compactionGeneration === 0 && serializedReceipt !== undefined) {
      throw new Error(`session snapshot sessions[${index}] generation 0 must not contain a compaction receipt`);
    }
    if ((compactionGeneration as number) > 0 && serializedReceipt === undefined) {
      throw new Error(`session snapshot sessions[${index}] positive generation requires a compaction receipt`);
    }
    if (serializedReceipt !== undefined) {
      let receipt: CompactionReceipt;
      try {
        receipt = parseCompactionReceipt(serializedReceipt);
      } catch (error) {
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
      turn_count: row.turn_count as number,
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
      compaction_generation: compactionGeneration as number,
      ...(serializedReceipt === undefined ? {} : { last_compaction_receipt: serializedReceipt }),
    };
  });

  const turns = input.turns.map((raw, index): SessionTurn => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`session snapshot turns[${index}] must be an object`);
    }
    const row = raw as Record<string, unknown>;
    exactKeys(row, ["session_id", "turn_index", "role", "content", "timestamp"], `session snapshot turns[${index}]`);
    if (!Number.isInteger(row.turn_index) || (row.turn_index as number) < 0 || (row.turn_index as number) > 1_000_000) {
      throw new Error(`session snapshot turns[${index}].turn_index is invalid`);
    }
    if (row.role !== "user" && row.role !== "assistant") {
      throw new Error(`session snapshot turns[${index}].role is invalid`);
    }
    return {
      session_id: boundedString(row.session_id, `session snapshot turns[${index}].session_id`, 200),
      turn_index: row.turn_index as number,
      role: row.role,
      content: boundedString(row.content, `session snapshot turns[${index}].content`, 100_000, true),
      timestamp: isoTimestamp(row.timestamp, `session snapshot turns[${index}].timestamp`),
    };
  });

  sessions.sort((left, right) => compareStableText(left.session_id, right.session_id));
  turns.sort((left, right) => compareStableText(left.session_id, right.session_id)
    || left.turn_index - right.turn_index);
  const sessionIds = new Set<string>();
  for (const session of sessions) {
    if (sessionIds.has(session.session_id)) throw new Error(`duplicate session metadata: ${session.session_id}`);
    sessionIds.add(session.session_id);
  }
  const counts = new Map<string, number>();
  const turnKeys = new Set<string>();
  for (const turn of turns) {
    if (!sessionIds.has(turn.session_id)) throw new Error(`turn references missing session metadata: ${turn.session_id}`);
    const key = `${turn.session_id}\u0000${turn.turn_index}`;
    if (turnKeys.has(key)) throw new Error(`duplicate session turn: ${turn.session_id}:${turn.turn_index}`);
    turnKeys.add(key);
    const expectedIndex = counts.get(turn.session_id) ?? 0;
    if (turn.turn_index !== expectedIndex) throw new Error(`non-contiguous turn index for session: ${turn.session_id}`);
    counts.set(turn.session_id, expectedIndex + 1);
  }
  for (const session of sessions) {
    if (session.turn_count !== (counts.get(session.session_id) ?? 0)) {
      throw new Error(`turn_count mismatch for session: ${session.session_id}`);
    }
  }
  return { schema_version: 2, sessions, turns };
}

export async function snapshotSessionStorage(): Promise<SessionStorageSnapshot | null> {
  return withCoordinatorReadBarrier(async () => {
  const db = await getDb();
  if (!db) return null;
  const sessions = (db.prepare(
    `SELECT ${SESSION_META_COLUMNS} FROM session_meta ORDER BY session_id ASC`
  ).all() as SessionMetaRow[]).map(sessionMetaFromRow);
  const turns = db.prepare(
    `SELECT session_id, turn_index, role, content, timestamp
     FROM sessions_fts
     ORDER BY session_id ASC, turn_index ASC`
  ).all() as SessionTurn[];
  return validateSessionStorageSnapshot({ schema_version: 2, sessions, turns });
  });
}

export async function snapshotSessionStorageAfterWriteBarrier(): Promise<SessionStorageSnapshot | null> {
  return withCoordinatorReadBarrier(async () => {
  const db = await getDb();
  if (!db) return null;
  return withSessionWriteLock(async () => {
    const capture = db.transaction(() => {
      const sessions = (db.prepare(
        `SELECT ${SESSION_META_COLUMNS} FROM session_meta ORDER BY session_id ASC`
      ).all() as SessionMetaRow[]).map(sessionMetaFromRow);
      const turns = db.prepare(
        `SELECT session_id, turn_index, role, content, timestamp
         FROM sessions_fts
         ORDER BY session_id ASC, turn_index ASC`
      ).all() as SessionTurn[];
      return validateSessionStorageSnapshot({ schema_version: 2, sessions, turns });
    });
    return withSqliteContentionRetry(() => capture.immediate());
  });
  });
}

export async function replaceSessionStorageSnapshot(value: unknown): Promise<boolean> {
  return withCoordinatorMutationBarrier(async () => {
  const snapshot = validateSessionStorageSnapshot(value);
  const db = await getDb();
  if (!db) return false;
  return withSessionWriteLock(async () => {
    const replace = db.transaction(() => {
      db.prepare("DELETE FROM session_meta").run();
      db.prepare("DELETE FROM sessions_fts").run();
      const insertMeta = db.prepare(
        `INSERT INTO session_meta (
          session_id, started_at, turn_count, last_turn_at, scope, parent_session_id,
          start_event_id, end_reason, ended_at, updated_at, compaction_generation,
          last_compaction_receipt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertTurn = db.prepare(
        "INSERT INTO sessions_fts (session_id, turn_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)"
      );
      for (const session of snapshot.sessions) {
        insertMeta.run(
          session.session_id,
          session.started_at,
          session.turn_count,
          session.last_turn_at ?? null,
          session.scope,
          session.parent_session_id ?? null,
          session.start_event_id ?? null,
          session.end_reason ?? null,
          session.ended_at ?? null,
          session.updated_at,
          session.compaction_generation,
          session.last_compaction_receipt ?? null,
        );
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
