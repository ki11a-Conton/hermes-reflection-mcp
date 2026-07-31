import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ReflectionStore } from "../types.js";
import {
  STORE_DIR,
  exportData,
  previewClearData,
  previewReplaceImportData,
  replaceStoreDataSnapshot,
  withOperationJournalStoreMutation,
  withStoreSnapshotBarrier,
  type ClearCollection,
} from "../storage.js";
import {
  emptySessionStorageSnapshot,
  replaceSessionStorageSnapshot,
  snapshotSessionStorage,
  snapshotSessionStorageAfterWriteBarrier,
  validateSessionStorageSnapshot,
  withOperationJournalSessionMutation,
  type SessionStorageSnapshot,
} from "../session_storage.js";

export type OperationPhase = "prepared" | "json_staged" | "sqlite_staged" | "committing" | "complete";

export interface OperationJournalRecord {
  schema_version: 1;
  id: string;
  operation: "clear" | "replace_import";
  phase: OperationPhase;
  created_at: string;
  before: Record<string, string>;
  after: Record<string, string>;
  staged_paths: string[];
  backup_paths: string[];
}

interface OperationSnapshots {
  beforeJson: ReflectionStore;
  afterJson: ReflectionStore;
  beforeSqlite: SessionStorageSnapshot;
  afterSqlite: SessionStorageSnapshot;
}

const JOURNAL_PATH = join(STORE_DIR, "operation_journal.json");
const LOCK_PATH = join(STORE_DIR, "operation_journal.lock");
const OPERATIONS_DIR = join(STORE_DIR, "operations");
const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PHASES = new Set<OperationPhase>(["prepared", "json_staged", "sqlite_staged", "committing", "complete"]);
const NEXT_PHASE: Partial<Record<OperationPhase, OperationPhase>> = {
  prepared: "json_staged",
  json_staged: "sqlite_staged",
  sqlite_staged: "committing",
  committing: "complete",
};

export function assertOperationPhaseTransition(current: OperationPhase, next: OperationPhase): void {
  if (NEXT_PHASE[current] !== next) {
    throw new Error(`non-monotonic operation phase transition: ${current} -> ${next}`);
  }
}

class InjectedOperationFailure extends Error {
  constructor(failpoint: string) {
    super(`Recoverable operation interrupted at failpoint: ${failpoint}`);
    this.name = "InjectedOperationFailure";
  }
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function operationPaths(id: string): { staged: string[]; backups: string[]; directory: string } {
  const base = `operations/${id}`;
  return {
    staged: [`${base}/after-json.json`, `${base}/after-sqlite.json`],
    backups: [`${base}/before-json.json`, `${base}/before-sqlite.json`],
    directory: base,
  };
}

function validateRelativePath(path: string, id: string): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 300) {
    throw new Error("operation journal contains an invalid path");
  }
  if (isAbsolute(path) || path.includes("\\") || path.includes(":") || path.split("/").includes("..")) {
    throw new Error("operation journal contains an unsafe path");
  }
  const prefix = `operations/${id}/`;
  if (!path.startsWith(prefix)) throw new Error("operation journal path is outside its operation directory");
  const absolute = resolve(STORE_DIR, ...path.split("/"));
  const rel = relative(resolve(STORE_DIR), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("operation journal path escapes the store directory");
  return absolute;
}

function validateHashMap(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const map = value as Record<string, unknown>;
  exactKeys(map, ["json", "sqlite"], label);
  if (typeof map.json !== "string" || !SHA256_RE.test(map.json)
      || typeof map.sqlite !== "string" || !SHA256_RE.test(map.sqlite)) {
    throw new Error(`${label} contains an invalid SHA-256 hash`);
  }
  return { json: map.json, sqlite: map.sqlite };
}

export function decodeOperationJournal(value: unknown): OperationJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("operation journal must be an object");
  }
  const input = value as Record<string, unknown>;
  exactKeys(input, [
    "schema_version", "id", "operation", "phase", "created_at",
    "before", "after", "staged_paths", "backup_paths",
  ], "operation journal");
  if (input.schema_version !== 1) throw new Error("unsupported operation journal schema_version");
  if (typeof input.id !== "string" || !UUID_RE.test(input.id)) throw new Error("operation journal id is invalid");
  if (input.operation !== "clear" && input.operation !== "replace_import") {
    throw new Error("operation journal operation is invalid");
  }
  if (typeof input.phase !== "string" || !PHASES.has(input.phase as OperationPhase)) {
    throw new Error("operation journal phase is invalid");
  }
  if (typeof input.created_at !== "string") throw new Error("operation journal created_at is invalid");
  const timestamp = new Date(input.created_at);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== input.created_at) {
    throw new Error("operation journal created_at must be a canonical ISO-8601 timestamp");
  }
  if (!Array.isArray(input.staged_paths) || !input.staged_paths.every((item) => typeof item === "string")) {
    throw new Error("operation journal staged_paths is invalid");
  }
  if (!Array.isArray(input.backup_paths) || !input.backup_paths.every((item) => typeof item === "string")) {
    throw new Error("operation journal backup_paths is invalid");
  }
  const expected = operationPaths(input.id);
  const staged = input.staged_paths as string[];
  const backups = input.backup_paths as string[];
  if (JSON.stringify(staged) !== JSON.stringify(expected.staged)
      || JSON.stringify(backups) !== JSON.stringify(expected.backups)) {
    throw new Error("operation journal artifact paths do not match the operation id");
  }
  for (const path of [...staged, ...backups]) validateRelativePath(path, input.id);
  return {
    schema_version: 1,
    id: input.id,
    operation: input.operation,
    phase: input.phase as OperationPhase,
    created_at: input.created_at,
    before: validateHashMap(input.before, "operation journal before"),
    after: validateHashMap(input.after, "operation journal after"),
    staged_paths: [...staged],
    backup_paths: [...backups],
  };
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => stableValue(item === undefined ? null : item));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = stableValue(child);
    }
    return result;
  }
  throw new Error("operation snapshot contains a non-JSON value");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonProjection(store: ReflectionStore): Record<string, unknown> {
  return {
    sessions: store.sessions,
    reflections: store.reflections,
    affordance_gaps: store.affordance_gaps,
    heuristics: store.heuristics,
    version: store.version,
    memory_board: store.memory_board,
    user_profile: store.user_profile,
  };
}

export function hashJournalJsonState(store: ReflectionStore): string {
  return sha256(canonicalJson(jsonProjection(store)));
}

export function hashJournalSqliteState(snapshot: SessionStorageSnapshot): string {
  return sha256(canonicalJson(validateSessionStorageSnapshot(snapshot)));
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readJournal(): Promise<OperationJournalRecord | null> {
  let raw: string;
  try {
    const info = await lstat(JOURNAL_PATH);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("operation journal must be a regular file, not a link");
    }
    raw = await readFile(JOURNAL_PATH, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("operation journal is not valid JSON; refusing unsafe recovery", { cause: error });
  }
  return decodeOperationJournal(parsed);
}

async function writeJournal(record: OperationJournalRecord): Promise<void> {
  await atomicWriteJson(JOURNAL_PATH, decodeOperationJournal(record));
}

async function ensureDirectoryIsSafe(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a link`);
}

async function prepareDirectories(id: string): Promise<string> {
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
  await mkdir(OPERATIONS_DIR, { recursive: true, mode: 0o700 });
  await ensureDirectoryIsSafe(OPERATIONS_DIR, "operations directory");
  const opDir = join(OPERATIONS_DIR, id);
  await mkdir(opDir, { recursive: false, mode: 0o700 });
  await ensureDirectoryIsSafe(opDir, "operation directory");
  return opDir;
}

async function readArtifact(path: string): Promise<unknown> {
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("operation artifact must be a regular file, not a link");
    }
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`operation artifact is unreadable: ${relative(STORE_DIR, path)}`, { cause: error });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`operation artifact is invalid JSON: ${relative(STORE_DIR, path)}`, { cause: error });
  }
}

async function transition(record: OperationJournalRecord, next: OperationPhase): Promise<OperationJournalRecord> {
  const current = await readJournal();
  if (!current || current.id !== record.id || current.phase !== record.phase) {
    throw new Error("operation journal changed concurrently");
  }
  assertOperationPhaseTransition(current.phase, next);
  const updated = { ...current, phase: next };
  await writeJournal(updated);
  return updated;
}

async function markRecoveredComplete(record: OperationJournalRecord): Promise<OperationJournalRecord> {
  const current = await readJournal();
  if (!current || current.id !== record.id || current.phase !== record.phase) {
    throw new Error("operation journal changed concurrently during recovery");
  }
  if (current.phase === "complete") return current;
  const updated = { ...current, phase: "complete" as const };
  await writeJournal(updated);
  return updated;
}

async function removeExact(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  });
}

async function cleanup(record: OperationJournalRecord): Promise<void> {
  await ensureRecordDirectoriesSafe(record);
  await removeExact(JOURNAL_PATH);
  for (const relativePath of [...record.staged_paths, ...record.backup_paths]) {
    await removeExact(validateRelativePath(relativePath, record.id));
  }
  const opDir = validateRelativePath(`${operationPaths(record.id).directory}/placeholder`, record.id);
  const directory = resolve(opDir, "..");
  if (relative(resolve(OPERATIONS_DIR), directory).startsWith("..")) throw new Error("unsafe operation cleanup directory");
  await rmdir(directory).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  });
}

async function ensureRecordDirectoriesSafe(record: OperationJournalRecord): Promise<void> {
  await ensureDirectoryIsSafe(OPERATIONS_DIR, "operations directory");
  const placeholder = validateRelativePath(`${operationPaths(record.id).directory}/placeholder`, record.id);
  await ensureDirectoryIsSafe(resolve(placeholder, ".."), "operation directory");
}

async function prepare(
  operation: OperationJournalRecord["operation"],
  snapshots: OperationSnapshots,
): Promise<OperationJournalRecord> {
  if (existsSync(JOURNAL_PATH)) throw new Error("another recoverable cross-store operation is pending");
  const id = randomUUID();
  await prepareDirectories(id);
  const paths = operationPaths(id);
  const record: OperationJournalRecord = {
    schema_version: 1,
    id,
    operation,
    phase: "prepared",
    created_at: new Date().toISOString(),
    before: {
      json: hashJournalJsonState(snapshots.beforeJson),
      sqlite: hashJournalSqliteState(snapshots.beforeSqlite),
    },
    after: {
      json: hashJournalJsonState(snapshots.afterJson),
      sqlite: hashJournalSqliteState(snapshots.afterSqlite),
    },
    staged_paths: paths.staged,
    backup_paths: paths.backups,
  };
  await atomicWriteJson(validateRelativePath(record.backup_paths[0], id), snapshots.beforeJson);
  await atomicWriteJson(validateRelativePath(record.backup_paths[1], id), snapshots.beforeSqlite);
  await writeJournal(record);
  return record;
}

function maybeFail(failpoint: string): void {
  if (process.env.HERMES_TEST_OPERATION_FAILPOINT === failpoint) throw new InjectedOperationFailure(failpoint);
}

async function stageJson(record: OperationJournalRecord, snapshot: ReflectionStore): Promise<OperationJournalRecord> {
  if (hashJournalJsonState(snapshot) !== record.after.json) throw new Error("staged JSON hash does not match journal");
  await atomicWriteJson(validateRelativePath(record.staged_paths[0], record.id), snapshot);
  return transition(record, "json_staged");
}

async function stageSqlite(record: OperationJournalRecord, snapshot: SessionStorageSnapshot): Promise<OperationJournalRecord> {
  if (hashJournalSqliteState(snapshot) !== record.after.sqlite) throw new Error("staged SQLite hash does not match journal");
  await atomicWriteJson(validateRelativePath(record.staged_paths[1], record.id), snapshot);
  return transition(record, "sqlite_staged");
}

async function loadJsonArtifact(record: OperationJournalRecord, kind: "before" | "after"): Promise<ReflectionStore> {
  const index = kind === "before" ? 0 : 0;
  const relativePath = kind === "before" ? record.backup_paths[index] : record.staged_paths[index];
  const value = await readArtifact(validateRelativePath(relativePath, record.id)) as ReflectionStore;
  if (hashJournalJsonState(value) !== record[kind].json) throw new Error(`${kind} JSON recovery artifact hash mismatch`);
  return value;
}

async function loadSqliteArtifact(record: OperationJournalRecord, kind: "before" | "after"): Promise<SessionStorageSnapshot> {
  const relativePath = kind === "before" ? record.backup_paths[1] : record.staged_paths[1];
  const value = validateSessionStorageSnapshot(await readArtifact(validateRelativePath(relativePath, record.id)));
  if (hashJournalSqliteState(value) !== record[kind].sqlite) throw new Error(`${kind} SQLite recovery artifact hash mismatch`);
  return value;
}

async function commitJson(snapshot: ReflectionStore): Promise<void> {
  await withOperationJournalStoreMutation(() => replaceStoreDataSnapshot(snapshot));
}

async function commitSqlite(snapshot: SessionStorageSnapshot): Promise<void> {
  const replaced = await withOperationJournalSessionMutation(() => replaceSessionStorageSnapshot(snapshot));
  if (!replaced) throw new Error("SQLite session storage is unavailable during recoverable operation");
}

async function verifyHashes(record: OperationJournalRecord, kind: "before" | "after"): Promise<void> {
  const liveJson = await exportData();
  const liveSqlite = await snapshotSessionStorage();
  if (!liveSqlite) throw new Error("SQLite session storage is unavailable during operation verification");
  if (hashJournalJsonState(liveJson) !== record[kind].json) throw new Error(`${kind} JSON verification hash mismatch`);
  if (hashJournalSqliteState(liveSqlite) !== record[kind].sqlite) throw new Error(`${kind} SQLite verification hash mismatch`);
}

async function recoverUnlocked(): Promise<void> {
  let record = await readJournal();
  if (!record) return;
  await ensureRecordDirectoriesSafe(record);
  if (record.phase === "complete") {
    await cleanup(record);
    return;
  }
  if (record.phase === "prepared" || record.phase === "json_staged" || record.phase === "sqlite_staged") {
    const beforeJson = await loadJsonArtifact(record, "before");
    const beforeSqlite = await loadSqliteArtifact(record, "before");
    await commitJson(beforeJson);
    await commitSqlite(beforeSqlite);
    await verifyHashes(record, "before");
    record = await markRecoveredComplete(record);
    await cleanup(record);
    return;
  }
  const afterJson = await loadJsonArtifact(record, "after");
  const afterSqlite = await loadSqliteArtifact(record, "after");
  await commitJson(afterJson);
  await commitSqlite(afterSqlite);
  await verifyHashes(record, "after");
  record = await transition(record, "complete");
  await cleanup(record);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function acquireLock(): Promise<() => Promise<void>> {
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const handle = await open(LOCK_PATH, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ schema_version: 1, pid: process.pid, token }), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = JSON.parse(await readFile(LOCK_PATH, "utf8")) as { token?: unknown };
          if (current.token === token) await unlink(LOCK_PATH);
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
      };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      let staleToken: string | undefined;
      try {
        const owner = JSON.parse(await readFile(LOCK_PATH, "utf8")) as Record<string, unknown>;
        exactKeys(owner, ["schema_version", "pid", "token"], "operation lock");
        if (owner.schema_version !== 1 || typeof owner.token !== "string" || typeof owner.pid !== "number") {
          throw new Error("operation lock is malformed");
        }
        if (!processIsAlive(owner.pid)) staleToken = owner.token;
      } catch (readError) {
        if (readError && typeof readError === "object" && "code" in readError && readError.code === "ENOENT") continue;
        throw new Error("operation lock is invalid; refusing to remove an unknown owner", { cause: readError });
      }
      if (staleToken) {
        const current = JSON.parse(await readFile(LOCK_PATH, "utf8")) as { token?: unknown };
        if (current.token === staleToken) await unlink(LOCK_PATH);
        continue;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new Error("timed out waiting for the recoverable operation lock");
}

async function withLock<T>(callback: () => Promise<T>): Promise<T> {
  const release = await acquireLock();
  try {
    return await callback();
  } finally {
    await release();
  }
}

export async function recoverPendingOperation(): Promise<void> {
  await withLock(recoverUnlocked);
}

async function execute(
  operation: OperationJournalRecord["operation"],
  prepareJson: () => Promise<{ beforeJson: ReflectionStore; afterJson: ReflectionStore }>,
): Promise<ReflectionStore> {
  return withLock(async () => {
    await recoverUnlocked();
    const { beforeJson, afterJson } = await withStoreSnapshotBarrier(prepareJson);
    const beforeSqlite = await snapshotSessionStorageAfterWriteBarrier();
    if (!beforeSqlite) throw new Error("SQLite session storage is unavailable; no operation journal was created");
    const afterSqlite = emptySessionStorageSnapshot();
    let record = await prepare(operation, { beforeJson, afterJson, beforeSqlite, afterSqlite });
    try {
      maybeFail("after_prepare");
      record = await stageJson(record, afterJson);
      maybeFail("after_json_stage");
      record = await stageSqlite(record, afterSqlite);
      maybeFail("after_sqlite_stage");
      record = await transition(record, "committing");
      await commitJson(afterJson);
      maybeFail("after_json_commit");
      await commitSqlite(afterSqlite);
      maybeFail("after_sqlite_commit");
      await verifyHashes(record, "after");
      record = await transition(record, "complete");
      await cleanup(record);
      return afterJson;
    } catch (error) {
      if (error instanceof InjectedOperationFailure) throw error;
      try {
        await recoverUnlocked();
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "cross-store operation failed and immediate recovery did not complete");
      }
      throw error;
    }
  });
}

export async function executeJournaledClear(collection: Extract<ClearCollection, "sessions" | "all">): Promise<void> {
  await execute("clear", async () => {
    const beforeJson = await exportData();
    const afterJson = await previewClearData(collection, beforeJson);
    return { beforeJson, afterJson };
  });
}

export async function executeJournaledReplaceImport(
  incoming: Partial<ReflectionStore>,
): Promise<{ reflections: number; heuristics: number; affordance_gaps: number; sessions: number }> {
  const committed = await execute("replace_import", async () => {
    const beforeJson = await exportData();
    const afterJson = await previewReplaceImportData(incoming, beforeJson);
    return { beforeJson, afterJson };
  });
  return {
    reflections: committed.reflections.length,
    heuristics: committed.heuristics.length,
    affordance_gaps: committed.affordance_gaps.length,
    sessions: Object.keys(committed.sessions).length,
  };
}
