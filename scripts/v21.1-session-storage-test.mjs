import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";

const ownedRoot = await mkdtemp(join(tmpdir(), "hermes-v21.1-session-storage-"));
const home = join(ownedRoot, "profile");
const storeDir = join(home, ".hermes-reflection");
const dbPath = join(storeDir, "sessions.db");
const failures = [];

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertOwned(path) {
  const suffix = relative(resolve(ownedRoot), resolve(path));
  assert.equal(isAbsolute(suffix), false, `path escaped owned root: ${path}`);
  assert.notEqual(suffix, "..", `path escaped owned root: ${path}`);
  assert.equal(suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), false,
    `path escaped owned root: ${path}`);
}

async function check(name, callback) {
  try {
    await callback();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createV21Database() {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE session_meta (
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
    CREATE VIRTUAL TABLE sessions_fts USING fts5(
      session_id UNINDEXED,
      turn_index UNINDEXED,
      role,
      content,
      timestamp UNINDEXED,
      tokenize = "unicode61"
    );
  `);
  db.prepare(`
    INSERT INTO session_meta (
      session_id, started_at, turn_count, last_turn_at, scope, start_event_id,
      updated_at, compaction_generation, last_compaction_receipt
    ) VALUES (?, ?, 1, ?, 'global', ?, ?, 0, NULL)
  `).run(
    "migrated-session",
    "2026-08-10T00:00:00.000Z",
    "2026-08-10T00:00:00.000Z",
    "v21-start-event",
    "2026-08-10T00:00:00.000Z",
  );
  db.prepare(
    "INSERT INTO sessions_fts (session_id, turn_index, role, content, timestamp) VALUES (?, 0, 'user', ?, ?)",
  ).run("migrated-session", "existing v21 turn", "2026-08-10T00:00:00.000Z");
  db.close();
}

function side(overrides = {}) {
  const content = overrides.content ?? "captured side";
  return {
    session_id: "migrated-session",
    turn_id: "turn-1",
    side: "assistant",
    content,
    content_hash: sha256(content),
    occurred_at: "2026-08-10T01:01:00.000Z",
    expires_at: "2026-08-11T01:01:00.000Z",
    original_code_points: Array.from(content).length,
    content_truncated: false,
    content_blocked: false,
    scope: "global",
    ...overrides,
  };
}

try {
  assertOwned(home);
  await mkdir(storeDir, { recursive: true });
  createV21Database();
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  const sessions = await import(`../dist/session_storage.js?storage=${Date.now()}`);
  try {
    const migratedBefore = await sessions.snapshotSessionStorage();
    assert.equal(migratedBefore?.sessions.length, 1);
    assert.equal(migratedBefore?.turns[0]?.content, "existing v21 turn");

    await check("v21 database migration adds bounded coordination tables without rewriting old turns", async () => {
      const probe = new Database(dbPath, { readonly: true });
      try {
        const tables = new Set(probe.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all().map((row) => row.name));
        for (const name of ["pending_turn_sides", "committed_turn_pairs", "compaction_observations"]) {
          assert.equal(tables.has(name), true, `migration omitted ${name}`);
        }
      } finally {
        probe.close();
      }
      const migratedAfter = await sessions.snapshotSessionStorage();
      assert.deepEqual(migratedAfter, migratedBefore);
    });

    await check("assistant-first pair commits atomically in user-assistant order", async () => {
      assert.equal(typeof sessions.stageCapturedTurnSide, "function", "stageCapturedTurnSide export is missing");
      const assistant = side({ content: "assistant answer", content_hash: sha256("assistant answer") });
      assert.deepEqual(await sessions.stageCapturedTurnSide(assistant), { state: "staged" });
      assert.equal((await sessions.listSessionTurns("migrated-session", 20))?.length, 1,
        "one-sided capture leaked into FTS");
      const user = side({
        side: "user",
        content: "user request",
        content_hash: sha256("user request"),
        occurred_at: "2026-08-10T01:00:00.000Z",
        expires_at: "2026-08-11T01:00:00.000Z",
        original_code_points: 12,
      });
      assert.deepEqual(await sessions.stageCapturedTurnSide(user), {
        state: "committed",
        turn_indexes: [1, 2],
      });
      const turns = await sessions.listSessionTurns("migrated-session", 20);
      assert.deepEqual(turns?.map(({ turn_index, role, content }) => ({ turn_index, role, content })), [
        { turn_index: 0, role: "user", content: "existing v21 turn" },
        { turn_index: 1, role: "user", content: "user request" },
        { turn_index: 2, role: "assistant", content: "assistant answer" },
      ]);
      assert.equal((await sessions.getSessionMeta("migrated-session"))?.turn_count, 3);
    });

    await check("committed pair replay is idempotent and conflicting content fails closed", async () => {
      const user = side({
        side: "user", content: "user request", content_hash: sha256("user request"),
        occurred_at: "2026-08-10T01:00:00.000Z", expires_at: "2026-08-11T01:00:00.000Z",
        original_code_points: 12,
      });
      const assistant = side({ content: "assistant answer", content_hash: sha256("assistant answer") });
      assert.deepEqual(await sessions.stageCapturedTurnSide(user), { state: "duplicate" });
      assert.deepEqual(await sessions.stageCapturedTurnSide(assistant), { state: "duplicate" });
      await assert.rejects(
        sessions.stageCapturedTurnSide({
          ...user, content: "changed request", content_hash: sha256("changed request"), original_code_points: 15,
        }),
        /CAPTURED_TURN_CONFLICT/,
      );
      assert.equal((await sessions.listSessionTurns("migrated-session", 20))?.length, 3);
    });

    await check("user-first pair commits exactly once", async () => {
      const user = side({
        turn_id: "turn-2", side: "user", content: "second user", content_hash: sha256("second user"),
        occurred_at: "2026-08-10T02:00:00.000Z", expires_at: "2026-08-11T02:00:00.000Z",
        original_code_points: 11,
      });
      const assistant = side({
        turn_id: "turn-2", content: "second assistant", content_hash: sha256("second assistant"),
        occurred_at: "2026-08-10T02:01:00.000Z", expires_at: "2026-08-11T02:01:00.000Z",
        original_code_points: 16,
      });
      assert.deepEqual(await sessions.stageCapturedTurnSide(user), { state: "staged" });
      assert.deepEqual(await sessions.stageCapturedTurnSide(assistant), {
        state: "committed", turn_indexes: [3, 4],
      });
      assert.equal((await sessions.getSessionMeta("migrated-session"))?.turn_count, 5);
    });

    await check("pending sides clean up on expiry and session end", async () => {
      assert.equal(typeof sessions.cleanupPendingTurnSides, "function", "cleanupPendingTurnSides export is missing");
      await sessions.stageCapturedTurnSide(side({
        turn_id: "expires", side: "user", content: "expires", content_hash: sha256("expires"),
        occurred_at: "2026-08-10T03:00:00.000Z", expires_at: "2026-08-10T04:00:00.000Z",
        original_code_points: 7,
      }));
      assert.equal(await sessions.cleanupPendingTurnSides({ now: "2026-08-10T04:00:00.000Z" }), 1);
      await sessions.stageCapturedTurnSide(side({
        turn_id: "session-end", side: "user", content: "end cleanup", content_hash: sha256("end cleanup"),
        occurred_at: "2026-08-10T05:00:00.000Z", expires_at: "2026-08-11T05:00:00.000Z",
        original_code_points: 11,
      }));
      assert.equal(await sessions.cleanupPendingTurnSides({
        session_id: "migrated-session", now: "2026-08-10T05:30:00.000Z",
      }), 1);
    });

    await check("compaction observations are distinct from trusted receipts", async () => {
      assert.equal(typeof sessions.persistCompactionObservation, "function",
        "persistCompactionObservation export is missing");
      const observation = {
        event_id: "observation-1",
        session_id: "migrated-session",
        turn_id: "turn-2",
        phase: "post",
        trigger: "auto",
        occurred_at: "2026-08-10T06:00:00.000Z",
        scope: "global",
      };
      const before = await sessions.getSessionMeta("migrated-session");
      assert.equal(await sessions.persistCompactionObservation(observation), "inserted");
      assert.equal(await sessions.persistCompactionObservation(observation), "duplicate");
      await assert.rejects(
        sessions.persistCompactionObservation({ ...observation, phase: "pre" }),
        /COMPACTION_OBSERVATION_CONFLICT/,
      );
      assert.deepEqual(await sessions.listCompactionObservations("migrated-session"), [observation]);
      const after = await sessions.getSessionMeta("migrated-session");
      assert.equal(after?.compaction_generation, before?.compaction_generation);
      assert.equal(after?.last_compaction_receipt, before?.last_compaction_receipt);
    });

    assert.equal(failures.length, 0,
      `${failures.length} session storage behavior(s) failed:\n${failures.map(({ name, error }) =>
        `- ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`).join("\n")}`);
    console.log("[PASS] v21.1 session storage coordination");
  } finally {
    sessions.closeSessionStorage();
  }
} finally {
  assertOwned(ownedRoot);
  await rm(ownedRoot, { recursive: true, force: true });
}
