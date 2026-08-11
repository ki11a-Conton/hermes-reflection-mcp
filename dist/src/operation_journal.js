import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
export const OPERATION_RESOURCE_NAMES = [
    "reflections", "store_index", "resolved_questions", "session_storage",
];
const RESOURCE_FAILPOINTS = OPERATION_RESOURCE_NAMES.flatMap((name) => [
    `before_stage_write:${name}`,
    `after_stage_write:${name}`,
    `before_stage_fsync:${name}`,
    `after_stage_fsync:${name}`,
    `before_replace:${name}`,
    `after_replace:${name}`,
    `before_verify:${name}`,
    `after_verify:${name}`,
    `recovery_before_replace:${name}`,
    `recovery_after_replace:${name}`,
    `recovery_before_verify:${name}`,
    `recovery_after_verify:${name}`,
]);
export const OPERATION_FAILPOINTS = Object.freeze([
    ...RESOURCE_FAILPOINTS,
    "before_prepare_journal_write", "before_prepare_journal_fsync",
    "after_prepare_journal_write", "after_prepare_journal_fsync",
    "before_committing_journal_write", "before_committing_journal_fsync",
    "after_committing_journal_write", "after_committing_journal_fsync",
    "before_commit_marker_write", "before_commit_marker_fsync",
    "after_commit_marker_write", "after_commit_marker_fsync",
    "before_cleanup", "after_cleanup",
    "recovery_before_commit_marker_write", "recovery_before_commit_marker_fsync",
    "recovery_after_commit_marker_write", "recovery_after_commit_marker_fsync",
    "recovery_before_cleanup", "recovery_after_cleanup",
]);
const FAILPOINT_SET = new Set(OPERATION_FAILPOINTS);
const STORE_DIR = join(homedir(), ".hermes-reflection");
const JOURNAL_PATH = join(STORE_DIR, "operation_journal.json");
const LOCK_PATH = join(STORE_DIR, "operation_journal.lock");
const RECLAIM_GUARD_PATH = join(STORE_DIR, "operation_journal.reclaim.guard");
const OPERATIONS_DIR = join(STORE_DIR, "operations");
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V1_PHASES = new Set(["prepared", "json_staged", "sqlite_staged", "committing", "complete"]);
const NEXT_V1 = {
    prepared: "json_staged", json_staged: "sqlite_staged", sqlite_staged: "committing", committing: "complete",
};
const coordinatorContext = new AsyncLocalStorage();
export class OperationJournalStoreUnavailableError extends Error {
    code = "OPERATION_JOURNAL_STORE_UNAVAILABLE";
    constructor(cause) {
        super("Operation journal store directory is temporarily unavailable.", { cause });
        this.name = "OperationJournalStoreUnavailableError";
    }
}
function isStoreDirectoryObstruction(error) {
    if (!error || typeof error !== "object" || !("code" in error) || !("path" in error))
        return false;
    const code = String(error.code);
    return (code === "EEXIST" || code === "ENOTDIR")
        && resolve(String(error.path)) === resolve(STORE_DIR);
}
export function assertOperationJournalCoordinatorContext() {
    if (coordinatorContext.getStore() !== true)
        throw new Error("operation journal session mutation requires coordinator barrier ownership");
}
let durabilityTrace = [];
function traceDurability(event) { if (process.env.NODE_ENV === "test")
    durabilityTrace.push(event); }
export function operationJournalDurabilityTraceForTest() { return [...durabilityTrace]; }
export function assertConfiguredOperationFailpoint() {
    if (process.env.NODE_ENV !== "test")
        return;
    const value = process.env.HERMES_TEST_OPERATION_FAILPOINT ?? process.env.HERMES_TEST_REFLECTION_TX_FAILPOINT;
    if (value && !FAILPOINT_SET.has(value))
        throw new Error(`Unknown operation failpoint: ${value}`);
}
function failpoint(name) {
    assertConfiguredOperationFailpoint();
    if (process.env.NODE_ENV !== "test")
        return;
    const configured = process.env.HERMES_TEST_OPERATION_FAILPOINT ?? process.env.HERMES_TEST_REFLECTION_TX_FAILPOINT;
    if (configured === name)
        throw new Error(`Recoverable operation interrupted at failpoint: ${name}`);
}
function exactKeys(value, expected, label) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new Error(`${label} contains unknown or missing fields`);
    }
}
function stableValue(value) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        return value;
    if (Array.isArray(value))
        return value.map((item) => stableValue(item === undefined ? null : item));
    if (value && typeof value === "object") {
        const result = Object.create(null);
        for (const key of Object.keys(value).sort()) {
            const child = value[key];
            if (child !== undefined)
                result[key] = stableValue(child);
        }
        return result;
    }
    throw new Error("operation value is not JSON-serializable");
}
function canonicalJson(value) { return JSON.stringify(stableValue(value)); }
function sha(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function operationResultHash(value) { return sha(canonicalJson(value === undefined ? null : value)); }
function rawHash(value) { return sha(value === null ? "\0missing" : `\0present\0${value}`); }
function jsonProjection(store) {
    return {
        sessions: store.sessions, reflections: store.reflections, affordance_gaps: store.affordance_gaps,
        heuristics: store.heuristics, version: store.version, memory_board: store.memory_board, user_profile: store.user_profile,
    };
}
export function hashJournalJsonState(store) { return sha(canonicalJson(jsonProjection(store))); }
export function hashLegacyV1JsonState(store) { return hashJournalJsonState(store); }
export function hashJournalSqliteState(snapshot) {
    return sha(canonicalJson(snapshot));
}
export function hashLegacyV1SqliteState(snapshot) { return sha(canonicalJson(snapshot)); }
function v1Paths(id) {
    const base = `operations/${id}`;
    return {
        staged: [`${base}/after-json.json`, `${base}/after-sqlite.json`],
        backups: [`${base}/before-json.json`, `${base}/before-sqlite.json`],
    };
}
function safeOperationPath(path, id) {
    if (!path || path.length > 300 || isAbsolute(path) || path.includes("\\") || path.includes(":") || path.split("/").includes("..")) {
        throw new Error("operation journal contains an unsafe path");
    }
    if (!path.startsWith(`operations/${id}/`))
        throw new Error("operation journal path is outside its transaction directory");
    const absolute = resolve(STORE_DIR, ...path.split("/"));
    const rel = relative(resolve(STORE_DIR), absolute);
    if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error("operation journal path escapes the store directory");
    return absolute;
}
export function decodeOperationJournal(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("operation journal must be an object");
    const input = value;
    exactKeys(input, ["schema_version", "id", "operation", "phase", "created_at", "before", "after", "staged_paths", "backup_paths"], "operation journal v1");
    if (input.schema_version !== 1)
        throw new Error("unsupported operation journal schema_version");
    if (typeof input.id !== "string" || !UUID_RE.test(input.id))
        throw new Error("operation journal id is invalid");
    if (input.operation !== "clear" && input.operation !== "replace_import")
        throw new Error("operation journal operation is invalid");
    if (typeof input.phase !== "string" || !V1_PHASES.has(input.phase))
        throw new Error("operation journal phase is invalid");
    if (typeof input.created_at !== "string" || new Date(input.created_at).toISOString() !== input.created_at)
        throw new Error("operation journal timestamp is invalid");
    const hashes = (raw, label) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error(`${label} must be an object`);
        const map = raw;
        exactKeys(map, ["json", "sqlite"], label);
        if (typeof map.json !== "string" || !SHA_RE.test(map.json) || typeof map.sqlite !== "string" || !SHA_RE.test(map.sqlite))
            throw new Error(`${label} contains an invalid SHA-256 hash`);
        return { json: map.json, sqlite: map.sqlite };
    };
    if (!Array.isArray(input.staged_paths) || !Array.isArray(input.backup_paths))
        throw new Error("operation journal artifact paths are invalid");
    const expected = v1Paths(input.id);
    if (JSON.stringify(input.staged_paths) !== JSON.stringify(expected.staged) || JSON.stringify(input.backup_paths) !== JSON.stringify(expected.backups))
        throw new Error("operation journal artifact paths do not match id");
    for (const path of [...expected.staged, ...expected.backups])
        safeOperationPath(path, input.id);
    return {
        schema_version: 1, id: input.id, operation: input.operation, phase: input.phase,
        created_at: input.created_at, before: hashes(input.before, "operation journal before"),
        after: hashes(input.after, "operation journal after"), staged_paths: expected.staged, backup_paths: expected.backups,
    };
}
export function assertOperationPhaseTransition(current, next) {
    if (NEXT_V1[current] !== next)
        throw new Error(`non-monotonic operation phase transition: ${current} -> ${next}`);
}
function targetPathFor(name) {
    if (name === "reflections")
        return "reflections.jsonl";
    if (name === "store_index")
        return "store.json";
    if (name === "resolved_questions")
        return "resolved_questions.json";
    return "authority:session_storage";
}
export function decodeOperationJournalV2(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("operation journal v2 must be an object");
    const input = value;
    exactKeys(input, ["schema_version", "transaction_id", "operation", "phase", "created_at", "resources", "result_receipt"], "operation journal v2");
    if (input.schema_version !== 2)
        throw new Error("unsupported operation journal v2 schema_version");
    if (typeof input.transaction_id !== "string" || !UUID_RE.test(input.transaction_id))
        throw new Error("operation journal transaction_id is invalid");
    if (typeof input.operation !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(input.operation))
        throw new Error("operation journal operation is invalid");
    if (input.phase !== "prepared" && input.phase !== "committing" && input.phase !== "committed")
        throw new Error("operation journal phase is invalid");
    if (typeof input.created_at !== "string" || new Date(input.created_at).toISOString() !== input.created_at)
        throw new Error("operation journal timestamp is invalid");
    if (!Array.isArray(input.resources) || input.resources.length === 0 || input.resources.length > OPERATION_RESOURCE_NAMES.length)
        throw new Error("operation journal resources are invalid");
    const seen = new Set();
    const resources = input.resources.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("operation journal resource must be an object");
        const item = raw;
        exactKeys(item, ["name", "target_path", "before_sha256", "after_sha256", "staged_after_path"], "operation journal resource");
        if (typeof item.name !== "string" || !OPERATION_RESOURCE_NAMES.includes(item.name) || seen.has(item.name))
            throw new Error("operation journal resource name is invalid or duplicated");
        seen.add(item.name);
        const name = item.name;
        if (item.target_path !== targetPathFor(name))
            throw new Error("operation journal resource target path is unsafe or invalid");
        if (typeof item.before_sha256 !== "string" || !SHA_RE.test(item.before_sha256) || typeof item.after_sha256 !== "string" || !SHA_RE.test(item.after_sha256))
            throw new Error("operation journal resource SHA-256 is invalid");
        const staged = `operations/${input.transaction_id}/after-${index}.bin`;
        if (item.staged_after_path !== staged)
            throw new Error("operation journal staged path is unsafe or invalid");
        safeOperationPath(staged, input.transaction_id);
        return { name, target_path: item.target_path, before_sha256: item.before_sha256, after_sha256: item.after_sha256, staged_after_path: staged };
    });
    if (!input.result_receipt || typeof input.result_receipt !== "object" || Array.isArray(input.result_receipt))
        throw new Error("operation result receipt is invalid");
    const receipt = input.result_receipt;
    exactKeys(receipt, ["transaction_id", "result_id", "operation", "reflection_ids", "result_hash"], "operation result receipt");
    if (receipt.transaction_id !== input.transaction_id || typeof receipt.result_id !== "string" || !UUID_RE.test(receipt.result_id))
        throw new Error("operation result receipt IDs are invalid");
    if (receipt.operation !== input.operation || !Array.isArray(receipt.reflection_ids) || receipt.reflection_ids.length > 256
        || !receipt.reflection_ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100)
        || new Set(receipt.reflection_ids).size !== receipt.reflection_ids.length)
        throw new Error("operation result receipt reflection IDs are invalid");
    if (typeof receipt.result_hash !== "string" || !SHA_RE.test(receipt.result_hash))
        throw new Error("operation result receipt hash is invalid");
    return {
        schema_version: 2, transaction_id: input.transaction_id, operation: input.operation, phase: input.phase,
        created_at: input.created_at, resources, result_receipt: {
            transaction_id: receipt.transaction_id,
            result_id: receipt.result_id,
            operation: receipt.operation,
            reflection_ids: [...receipt.reflection_ids],
            result_hash: receipt.result_hash,
        },
    };
}
async function readOptional(path) {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error(`${relative(STORE_DIR, path)} must be a regular file`);
        return await readFile(path, "utf8");
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return null;
        throw error;
    }
}
async function syncDirectory(path) {
    try {
        const handle = await open(path, "r");
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        return "synced";
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EISDIR" || code === "EBADF"))
            return "unsupported";
        throw error;
    }
}
async function durableStage(path, content, name) {
    const handle = await open(path, "wx", 0o600);
    try {
        failpoint(`before_stage_write:${name}`);
        await handle.writeFile(content, "utf8");
        failpoint(`after_stage_write:${name}`);
        failpoint(`before_stage_fsync:${name}`);
        await handle.sync();
        failpoint(`after_stage_fsync:${name}`);
    }
    finally {
        await handle.close();
    }
}
function journalPoint(prefix, when, action) {
    if (prefix === "recovery_commit_marker")
        return `recovery_${when}_commit_marker_${action}`;
    if (prefix === "commit_marker")
        return `${when}_commit_marker_${action}`;
    return `${when}_${prefix}_journal_${action}`;
}
async function durableReplace(target, content) {
    const temporary = `${target}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await rename(temporary, target);
        await syncDirectory(resolve(target, ".."));
    }
    catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}
async function writeJournal(record, prefix) {
    const temporary = `${JOURNAL_PATH}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
    let renamed = false;
    try {
        const handle = await open(temporary, "wx", 0o600);
        try {
            failpoint(journalPoint(prefix, "before", "write"));
            await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
            failpoint(journalPoint(prefix, "after", "write"));
            failpoint(journalPoint(prefix, "before", "fsync"));
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, JOURNAL_PATH);
        renamed = true;
        await syncDirectory(STORE_DIR);
        if (prefix === "prepare")
            traceDurability("prepared_journal_published");
        failpoint(journalPoint(prefix, "after", "fsync"));
    }
    finally {
        if (!renamed)
            await rm(temporary, { force: true }).catch(() => undefined);
    }
}
async function readJournal() {
    const raw = await readOptional(JOURNAL_PATH);
    if (raw === null)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new Error("TRANSACTION_RECOVERY_PENDING: malformed operation journal", { cause: error });
    }
    if (parsed && typeof parsed === "object" && parsed.schema_version === 1)
        return { version: 1, record: decodeOperationJournal(parsed) };
    return { version: 2, record: decodeOperationJournalV2(parsed) };
}
async function validateSessionSnapshot(value) {
    const session = await import("../session_storage.js");
    return session.validateSessionStorageSnapshot(value);
}
async function resourceHash(name, staged) {
    if (name === "session_storage") {
        const session = await import("../session_storage.js");
        const value = staged === undefined ? await session.snapshotSessionStorage() : await validateSessionSnapshot(JSON.parse(staged));
        if (!value)
            throw new Error("session storage is unavailable during transaction authority read");
        return hashJournalSqliteState(value);
    }
    const target = join(STORE_DIR, targetPathFor(name));
    return rawHash(staged === undefined ? await readOptional(target) : staged);
}
async function replaceResource(resource, staged) {
    if (resource.name === "session_storage") {
        const session = await import("../session_storage.js");
        const snapshot = await validateSessionSnapshot(JSON.parse(staged));
        const replaced = await session.withOperationJournalSessionMutation(() => session.replaceSessionStorageSnapshot(snapshot));
        if (!replaced)
            throw new Error("session storage is unavailable during transaction replace");
        return;
    }
    await durableReplace(join(STORE_DIR, resource.target_path), staged);
}
async function readStaged(resource, required) {
    const staged = await readOptional(safeOperationPath(resource.staged_after_path, resource.staged_after_path.split("/")[1]));
    if (staged === null && required)
        throw new Error(`TRANSACTION_RECOVERY_PENDING: staged after-image missing for ${resource.name}`);
    if (staged !== null && await resourceHash(resource.name, staged) !== resource.after_sha256)
        throw new Error(`TRANSACTION_RECOVERY_PENDING: staged after-image hash mismatch for ${resource.name}`);
    return staged;
}
async function cleanupV2(record, recovery) {
    failpoint(recovery ? "recovery_before_cleanup" : "before_cleanup");
    await unlink(JOURNAL_PATH).catch((error) => {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
            throw error;
    });
    await syncDirectory(STORE_DIR);
    await rm(join(OPERATIONS_DIR, record.transaction_id), { recursive: true, force: true });
    failpoint(recovery ? "recovery_after_cleanup" : "after_cleanup");
}
async function recoverV2(record) {
    if (record.phase !== "committed") {
        if (record.phase === "prepared") {
            record = { ...record, phase: "committing" };
            await writeJournal(record, "committing");
        }
        for (const resource of record.resources) {
            const current = await resourceHash(resource.name);
            if (current === resource.after_sha256)
                continue;
            if (current !== resource.before_sha256)
                throw new Error(`TRANSACTION_RECOVERY_PENDING: ${resource.name} matches neither before nor after authority hash`);
            const staged = await readStaged(resource, true);
            failpoint(`recovery_before_replace:${resource.name}`);
            await replaceResource(resource, staged);
            failpoint(`recovery_after_replace:${resource.name}`);
            failpoint(`recovery_before_verify:${resource.name}`);
            if (await resourceHash(resource.name) !== resource.after_sha256)
                throw new Error(`TRANSACTION_RECOVERY_PENDING: recovery verification failed for ${resource.name}`);
            failpoint(`recovery_after_verify:${resource.name}`);
        }
        record = { ...record, phase: "committed" };
        await writeJournal(record, "recovery_commit_marker");
    }
    for (const resource of record.resources) {
        if (await resourceHash(resource.name) !== resource.after_sha256)
            throw new Error(`TRANSACTION_RECOVERY_PENDING: committed authority mismatch for ${resource.name}`);
    }
    const receipt = record.result_receipt;
    recoveryGeneration += 1;
    await cleanupV2(record, true);
    return receipt;
}
async function readJsonArtifact(path) {
    const raw = await readOptional(path);
    if (raw === null)
        throw new Error(`legacy operation artifact missing: ${relative(STORE_DIR, path)}`);
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        throw new Error("legacy operation artifact is malformed", { cause: error });
    }
}
function parseV1AuthorityObject(raw, label) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`TRANSACTION_RECOVERY_PENDING: legacy v1 ${label} authority is malformed`, { cause: error });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`TRANSACTION_RECOVERY_PENDING: legacy v1 ${label} authority must be an object`);
    }
    return value;
}
function parseV1ReflectionRows(raw) {
    const rows = [];
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
        if (!line.trim())
            continue;
        try {
            rows.push(JSON.parse(line));
        }
        catch (error) {
            throw new Error(`TRANSACTION_RECOVERY_PENDING: legacy v1 reflections authority row ${index + 1} is malformed`, { cause: error });
        }
    }
    return rows;
}
async function recoverV1(record) {
    const useAfter = record.phase === "committing" || record.phase === "complete";
    const jsonPath = useAfter ? record.staged_paths[0] : record.backup_paths[0];
    const sqlitePath = useAfter ? record.staged_paths[1] : record.backup_paths[1];
    const json = await readJsonArtifact(safeOperationPath(jsonPath, record.id));
    const rawSqlite = await readJsonArtifact(safeOperationPath(sqlitePath, record.id));
    const sqlite = await validateSessionSnapshot(rawSqlite);
    const expected = useAfter ? record.after : record.before;
    if (hashLegacyV1JsonState(json) !== expected.json || hashLegacyV1SqliteState(rawSqlite) !== expected.sqlite)
        throw new Error("TRANSACTION_RECOVERY_PENDING: legacy v1 artifact hash mismatch");
    const storage = await import("../storage.js");
    const session = await import("../session_storage.js");
    const expectedSqliteCanonical = canonicalJson(sqlite);
    const replacement = await storage.withOperationJournalStoreMutation(() => storage.replaceStoreDataSnapshot(json));
    const expectedJsonAuthority = replacement.store;
    const replaced = await session.withOperationJournalSessionMutation(() => session.replaceSessionStorageSnapshot(sqlite));
    if (!replaced)
        throw new Error("legacy v1 session storage unavailable");
    const mismatchMode = process.env.NODE_ENV === "test" ? process.env.HERMES_TEST_V1_POST_WRITE_MISMATCH : undefined;
    if (mismatchMode === "store_index") {
        const target = join(STORE_DIR, "store.json");
        const raw = await readOptional(target);
        if (raw === null)
            throw new Error("legacy v1 mismatch seam authority missing: store_index");
        const value = parseV1AuthorityObject(raw, "store_index");
        value.version = "21.0.0-v1-mismatch";
        await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    }
    if (mismatchMode === "reflections") {
        const target = join(STORE_DIR, "reflections.jsonl");
        const raw = await readOptional(target);
        if (raw === null)
            throw new Error("legacy v1 mismatch seam authority missing: reflections");
        const rows = parseV1ReflectionRows(raw);
        if (!rows[0])
            throw new Error("legacy v1 reflections mismatch seam requires a fixture row");
        rows[0] = { ...rows[0], task_goal: "injected v1 reflection mismatch" };
        await writeFile(target, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    }
    if (mismatchMode === "resolved_questions") {
        const target = join(STORE_DIR, "resolved_questions.json");
        const raw = await readOptional(target);
        if (raw === null)
            throw new Error("legacy v1 mismatch seam authority missing: resolved_questions");
        const value = parseV1AuthorityObject(raw, "resolved_questions");
        value["injected-reflection:0"] = { resolved_at: "2026-08-11T00:00:00.000Z" };
        await writeFile(target, JSON.stringify(value, null, 2), "utf8");
    }
    if (mismatchMode === "session_storage") {
        const mismatched = await session.withOperationJournalSessionMutation(() => session.replaceSessionStorageSnapshot({
            schema_version: 2, sessions: [], turns: [],
        }));
        if (!mismatched)
            throw new Error("legacy v1 mismatch seam could not replace session storage");
    }
    if (mismatchMode === "missing_store_index")
        await unlink(join(STORE_DIR, "store.json"));
    if (mismatchMode === "missing_reflections")
        await unlink(join(STORE_DIR, "reflections.jsonl"));
    if (mismatchMode === "missing_resolved_questions")
        await unlink(join(STORE_DIR, "resolved_questions.json"));
    const actualSqlite = await session.snapshotSessionStorage();
    if (!actualSqlite || canonicalJson(actualSqlite) !== expectedSqliteCanonical) {
        throw new Error("TRANSACTION_RECOVERY_PENDING: legacy v1 post-write authority mismatch for session_storage");
    }
    const reflection = await import("./reflection_transaction.js");
    const actualStoreIndex = await readOptional(join(STORE_DIR, "store.json"));
    const actualReflections = await readOptional(join(STORE_DIR, "reflections.jsonl"));
    const actualResolvedQuestions = await readOptional(join(STORE_DIR, "resolved_questions.json"));
    if (actualStoreIndex === null)
        throw new Error("TRANSACTION_RECOVERY_PENDING: legacy v1 post-write authority missing for store_index");
    if (actualReflections === null)
        throw new Error("TRANSACTION_RECOVERY_PENDING: legacy v1 post-write authority missing for reflections");
    if (actualResolvedQuestions === null)
        throw new Error("TRANSACTION_RECOVERY_PENDING: legacy v1 post-write authority missing for resolved_questions");
    const expectedResources = reflection.serializeReflectionResources(expectedJsonAuthority, replacement.resolvedQuestions);
    const actualStoreObject = parseV1AuthorityObject(actualStoreIndex, "store_index");
    const expectedStoreObject = parseV1AuthorityObject(expectedResources.store_index, "expected store_index");
    if (canonicalJson(parseV1ReflectionRows(actualReflections)) !== canonicalJson(parseV1ReflectionRows(expectedResources.reflections))) {
        throw new Error("TRANSACTION_RECOVERY_PENDING: legacy v1 post-write authority mismatch for reflections");
    }
    if (canonicalJson(parseV1AuthorityObject(actualResolvedQuestions, "resolved_questions"))
        !== canonicalJson(parseV1AuthorityObject(expectedResources.resolved_questions, "expected resolved_questions"))) {
        throw new Error("TRANSACTION_RECOVERY_PENDING: legacy v1 post-write authority mismatch for resolved_questions");
    }
    try {
        await storage.loadStore();
    }
    catch (error) {
        throw new Error("TRANSACTION_RECOVERY_PENDING: legacy v1 post-write authority validation failed for store_index", { cause: error });
    }
    delete actualStoreObject.metadata;
    delete actualStoreObject.reflections;
    delete expectedStoreObject.metadata;
    delete expectedStoreObject.reflections;
    if (canonicalJson(actualStoreObject) !== canonicalJson(expectedStoreObject)) {
        throw new Error("TRANSACTION_RECOVERY_PENDING: legacy v1 post-write authority mismatch for store_index");
    }
    recoveryGeneration += 1;
    await unlink(JOURNAL_PATH);
    await rm(join(OPERATIONS_DIR, record.id), { recursive: true, force: true });
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
    }
}
async function readLockOwner(path, label = "operation lock") {
    const value = JSON.parse(await readFile(path, "utf8"));
    exactKeys(value, ["schema_version", "pid", "token"], label);
    if (value.schema_version !== 1 || typeof value.pid !== "number" || !Number.isInteger(value.pid)
        || value.pid <= 0 || typeof value.token !== "string" || !UUID_RE.test(value.token)) {
        throw new Error(`${label} is malformed`);
    }
    return value;
}
function staleReclaimGuardError(reason) {
    return Object.assign(new Error(`STALE_RECLAIM_GUARD: ${reason}`), { code: "STALE_RECLAIM_GUARD" });
}
async function readReclaimGuard() {
    try {
        const owner = await readLockOwner(RECLAIM_GUARD_PATH, "operation reclaim guard");
        if (!processAlive(owner.pid))
            throw staleReclaimGuardError("guard owner is not alive; manual or startup recovery required");
        return owner;
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return null;
        if (error && typeof error === "object" && "code" in error && error.code === "STALE_RECLAIM_GUARD")
            throw error;
        throw staleReclaimGuardError("guard is unreadable or malformed; manual or startup recovery required");
    }
}
async function createOwnedFile(path, owner, onVisible, publishLink = link, afterCollisionLstat) {
    const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
    let handle;
    try {
        handle = await open(temporaryPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify(owner), "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
            await publishLink(temporaryPath, path);
        }
        catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "EPERM"))
                throw error;
            let targetInfo;
            try {
                targetInfo = await lstat(path);
            }
            catch (targetError) {
                if (targetError && typeof targetError === "object" && "code" in targetError && targetError.code === "ENOENT")
                    throw error;
                throw targetError;
            }
            if (!targetInfo.isFile() || targetInfo.isSymbolicLink())
                throw new Error("owned-file collision target is not a regular file");
            await afterCollisionLstat?.();
            try {
                await readLockOwner(path);
            }
            catch (ownerError) {
                if (ownerError && typeof ownerError === "object" && "code" in ownerError && ownerError.code === "ENOENT") {
                    throw Object.assign(new Error("owned-file collision target vanished during verification", { cause: ownerError }), { code: "EAGAIN" });
                }
                throw ownerError;
            }
            throw Object.assign(new Error("owned-file target already exists", { cause: error }), { code: "EEXIST" });
        }
        await onVisible?.();
    }
    finally {
        await handle?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}
export async function runOwnedFilePublishRaceForTest(legacyOpenTarget = false) {
    if (process.env.NODE_ENV !== "test")
        throw new Error("owned-file publish race seam is test-only");
    await mkdir(STORE_DIR, { recursive: true });
    await rm(LOCK_PATH, { force: true });
    const owner = { schema_version: 1, pid: process.pid, token: randomUUID() };
    const readyPath = `${LOCK_PATH}.watcher-ready`;
    const donePath = `${LOCK_PATH}.watcher-done`;
    const resultPath = `${LOCK_PATH}.watcher-result`;
    const malformedPath = `${LOCK_PATH}.watcher-malformed`;
    const watcher = new Promise((resolveWatcher, rejectWatcher) => {
        execFile(process.execPath, ["--input-type=module", "--eval", `
      import { readFile, writeFile } from "node:fs/promises";
      const target = ${JSON.stringify(LOCK_PATH)};
      const ready = ${JSON.stringify(readyPath)};
      const done = ${JSON.stringify(donePath)};
      const result = ${JSON.stringify(resultPath)};
      const malformed = ${JSON.stringify(malformedPath)};
      const counts = { missing_reads: 0, valid_reads: 0, malformed_reads: 0 };
      await writeFile(ready, "ready", "utf8");
      for (;;) {
        try {
          const value = JSON.parse(await readFile(target, "utf8"));
          const keys = Object.keys(value).sort().join("|");
          if (keys === "pid|schema_version|token" && value.schema_version === 1
              && Number.isInteger(value.pid) && value.pid > 0
              && typeof value.token === "string" && /^[0-9a-f-]{36}$/.test(value.token)) counts.valid_reads += 1;
          else counts.malformed_reads += 1;
        } catch (error) {
          if (error?.code === "ENOENT") counts.missing_reads += 1;
          else {
            counts.malformed_reads += 1;
            await writeFile(malformed, "observed", "utf8");
          }
        }
        try { await readFile(done, "utf8"); break; }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await writeFile(result, JSON.stringify(counts), "utf8");
    `], { windowsHide: true }, (error) => error ? rejectWatcher(error) : resolveWatcher());
    });
    let counts = { missing_reads: 0, valid_reads: 0, malformed_reads: 0 };
    try {
        for (let attempt = 0; attempt < 1_000; attempt += 1) {
            try {
                await readFile(readyPath, "utf8");
                break;
            }
            catch (error) {
                if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
                    throw error;
                if (attempt === 999)
                    throw new Error("timed out waiting for owned-file watcher");
                await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
            }
        }
        if (legacyOpenTarget) {
            const handle = await open(LOCK_PATH, "wx", 0o600);
            try {
                for (let attempt = 0; attempt < 1_000; attempt += 1) {
                    try {
                        await readFile(malformedPath, "utf8");
                        break;
                    }
                    catch (error) {
                        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
                            throw error;
                        if (attempt === 999)
                            throw new Error("timed out waiting for legacy partial-payload observation");
                        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
                    }
                }
                await handle.writeFile(JSON.stringify(owner), "utf8");
                await handle.sync();
            }
            finally {
                await handle.close();
            }
        }
        else {
            await createOwnedFile(LOCK_PATH, owner, async () => {
                await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
            });
        }
        await writeFile(donePath, "done", "utf8");
        await watcher;
        counts = JSON.parse(await readFile(resultPath, "utf8"));
    }
    finally {
        await Promise.all([LOCK_PATH, readyPath, donePath, resultPath, malformedPath].map((path) => rm(path, { force: true }).catch(() => undefined)));
    }
    return {
        reader_state: counts.malformed_reads > 0 ? "malformed" : counts.valid_reads > 0 ? "valid" : "missing",
        ...counts,
    };
}
export async function runOwnedFileWindowsCollisionForTest(mode) {
    if (process.env.NODE_ENV !== "test")
        throw new Error("owned-file collision seam is test-only");
    await mkdir(STORE_DIR, { recursive: true });
    await rm(LOCK_PATH, { force: true });
    const existing = { schema_version: 1, pid: process.pid, token: randomUUID() };
    if (mode !== "missing-target-eperm") {
        await writeFile(LOCK_PATH, mode === "malformed-target-eperm" ? "{" : JSON.stringify(existing), "utf8");
    }
    const injectedCode = mode === "valid-target-eacces" ? "EACCES" : "EPERM";
    let errorCode = "";
    let errorMessage = "";
    try {
        await createOwnedFile(LOCK_PATH, { schema_version: 1, pid: process.pid, token: randomUUID() }, undefined, async () => {
            throw Object.assign(new Error(`injected ${injectedCode}`), { code: injectedCode });
        }, mode === "vanishing-target-eperm" ? async () => { await rm(LOCK_PATH, { force: true }); } : undefined);
    }
    catch (error) {
        errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        errorMessage = error instanceof Error ? error.message : String(error);
    }
    let ownerVerified = false;
    try {
        ownerVerified = (await readLockOwner(LOCK_PATH)).token === existing.token;
    }
    catch (error) {
        if (mode !== "malformed-target-eperm" && mode !== "missing-target-eperm" && mode !== "vanishing-target-eperm")
            throw error;
        errorMessage = errorMessage || (error instanceof Error ? error.message : String(error));
    }
    finally {
        await rm(LOCK_PATH, { force: true });
    }
    return { error_code: errorCode, error_message: errorMessage, owner_verified: ownerVerified };
}
async function removeOwnedFile(path, token) {
    try {
        if ((await readLockOwner(path)).token === token)
            await unlink(path);
    }
    catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
            throw error;
    }
}
async function tryReclaimStaleLock(replacement, hooks = {}) {
    let expected;
    try {
        expected = await readLockOwner(LOCK_PATH);
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return false;
        if (error instanceof SyntaxError)
            return false;
        throw error;
    }
    if (processAlive(expected.pid))
        return false;
    await hooks.afterRead?.();
    const guard = { schema_version: 1, pid: process.pid, token: randomUUID() };
    try {
        await createOwnedFile(RECLAIM_GUARD_PATH, guard);
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
            await readReclaimGuard();
            return false;
        }
        throw error;
    }
    try {
        await hooks.afterGuardAcquired?.();
        let current;
        try {
            current = await readLockOwner(LOCK_PATH);
        }
        catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
                return false;
            throw error;
        }
        if (current.pid !== expected.pid || current.token !== expected.token || processAlive(current.pid))
            return false;
        await unlink(LOCK_PATH);
        await hooks.afterUnlink?.();
        await createOwnedFile(LOCK_PATH, replacement);
        return true;
    }
    finally {
        await removeOwnedFile(RECLAIM_GUARD_PATH, guard.token);
    }
}
export async function runStaleLockAbaRaceForTest() {
    if (process.env.NODE_ENV !== "test")
        throw new Error("stale lock race seam is test-only");
    await mkdir(STORE_DIR, { recursive: true });
    const stale = { schema_version: 1, pid: 2_147_483_647, token: randomUUID() };
    await writeFile(LOCK_PATH, JSON.stringify(stale), { encoding: "utf8", flag: "wx" });
    let arrivals = 0;
    let bothReadResolve;
    const bothRead = new Promise((resolvePromise) => { bothReadResolve = resolvePromise; });
    let releaseBResolve;
    const releaseB = new Promise((resolvePromise) => { releaseBResolve = resolvePromise; });
    let cEntered = false;
    let aTokenAlwaysInMain = true;
    const aOwner = { schema_version: 1, pid: process.pid, token: randomUUID() };
    const afterReadA = async () => { arrivals += 1; if (arrivals === 2)
        bothReadResolve(); await bothRead; };
    const afterReadB = async () => { arrivals += 1; if (arrivals === 2)
        bothReadResolve(); await bothRead; await releaseB; };
    const a = tryReclaimStaleLock(aOwner, { afterRead: afterReadA, afterUnlink: async () => {
            const cOwner = { schema_version: 1, pid: process.pid, token: randomUUID() };
            cEntered = await tryAcquireMainOnce(cOwner);
            if (cEntered)
                await removeOwnedFile(LOCK_PATH, cOwner.token);
        } });
    const bOwner = { schema_version: 1, pid: process.pid, token: randomUUID() };
    const b = tryReclaimStaleLock(bOwner, { afterRead: afterReadB, afterGuardAcquired: async () => {
            aTokenAlwaysInMain = aTokenAlwaysInMain && (await readLockOwner(LOCK_PATH)).token === aOwner.token;
        } });
    await a;
    releaseBResolve();
    const bReclaimed = await b;
    try {
        aTokenAlwaysInMain = aTokenAlwaysInMain && (await readLockOwner(LOCK_PATH)).token === aOwner.token;
    }
    finally {
        await rm(LOCK_PATH, { force: true });
    }
    return { c_entered_during_reclaim: cEntered, a_token_always_in_main: aTokenAlwaysInMain, b_reclaimed_a: bReclaimed };
}
async function tryAcquireMainOnce(owner) {
    if (await readReclaimGuard())
        return false;
    try {
        await createOwnedFile(LOCK_PATH, owner);
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EAGAIN")
            return false;
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
            try {
                await readLockOwner(LOCK_PATH);
            }
            catch (readError) {
                await classifyLockReadFailure(readError);
                return false;
            }
            return false;
        }
        if (error && typeof error === "object" && "code" in error
            && (error.code === "EPERM" || error.code === "EBUSY")) {
            await classifyLockReadFailure(error);
            return false;
        }
        throw error;
    }
    if (await readReclaimGuard()) {
        await removeOwnedFile(LOCK_PATH, owner.token);
        return false;
    }
    return true;
}
async function markLockContentionForTest() {
    const marker = process.env.HERMES_TEST_OPERATION_LOCK_CONTENTION_MARKER;
    if (process.env.NODE_ENV === "test" && marker)
        await writeFile(marker, "observed\n", "utf8");
}
async function classifyLockReadFailure(error, statTarget = () => lstat(LOCK_PATH), platform = process.platform) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return "missing";
    if (!(error && typeof error === "object" && "code" in error
        && (error.code === "EPERM" || error.code === "EBUSY") && platform === "win32"))
        throw error;
    let target;
    try {
        target = await statTarget();
    }
    catch (targetError) {
        if (targetError && typeof targetError === "object" && "code" in targetError && targetError.code === "ENOENT")
            return "missing";
        // A Windows process may hold the lock with FileShare.None, which can make
        // both the original operation and this lstat probe fail transiently. Do
        // not grant ownership in that state: report contention so the bounded
        // acquire loop waits and re-validates the target after sharing resumes.
        if (targetError && typeof targetError === "object" && "code" in targetError
            && (targetError.code === "EPERM" || targetError.code === "EBUSY") && platform === "win32") {
            await markLockContentionForTest();
            return "contention";
        }
        throw targetError;
    }
    if (!target.isFile() || target.isSymbolicLink())
        throw new Error("operation lock target is not a regular file", { cause: error });
    await markLockContentionForTest();
    return "contention";
}
async function acquireLock() {
    try {
        await mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
    }
    catch (error) {
        if (isStoreDirectoryObstruction(error))
            throw new OperationJournalStoreUnavailableError(error);
        throw error;
    }
    const owner = { schema_version: 1, pid: process.pid, token: randomUUID() };
    const deadline = Date.now() + 10_000;
    for (let attempt = 0; attempt < 400; attempt += 1) {
        if (Date.now() >= deadline)
            break;
        if (await tryAcquireMainOnce(owner))
            return async () => removeOwnedFile(LOCK_PATH, owner.token);
        try {
            const current = await readLockOwner(LOCK_PATH);
            if (!processAlive(current.pid) && await tryReclaimStaleLock(owner))
                return async () => removeOwnedFile(LOCK_PATH, owner.token);
        }
        catch (readError) {
            if (await classifyLockReadFailure(readError) === "missing") {
                if (Date.now() >= deadline)
                    break;
                continue;
            }
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0)
            break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(25, remainingMs)));
    }
    throw new Error("timed out waiting for operation journal lock");
}
export async function runLockReadEpermRetryForTest(mode) {
    if (process.env.NODE_ENV !== "test")
        throw new Error("lock read EPERM retry seam is test-only");
    let readAttempts = 0;
    let waits = 0;
    let ownerRead = false;
    let caught;
    const contentionCode = mode.endsWith("-ebusy") ? "EBUSY" : "EPERM";
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            readAttempts += 1;
            if (mode.startsWith("transient") && readAttempts >= 3) {
                ownerRead = true;
                break;
            }
            if (mode === "missing" && readAttempts >= 2) {
                ownerRead = true;
                break;
            }
            if (mode === "malformed")
                throw new SyntaxError("injected malformed lock owner");
            if (mode === "eacces")
                throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
            if (mode === "unexpected")
                throw Object.assign(new Error("injected EIO"), { code: "EIO" });
            throw Object.assign(new Error(`injected ${contentionCode}`), { code: contentionCode });
        }
        catch (error) {
            try {
                const disposition = await classifyLockReadFailure(error, async () => {
                    if (mode === "missing")
                        throw Object.assign(new Error("injected ENOENT"), { code: "ENOENT" });
                    if (mode.startsWith("stat-contention")) {
                        throw Object.assign(new Error(`injected lstat ${contentionCode}`), { code: contentionCode });
                    }
                    return {
                        isFile: () => mode !== "nonregular",
                        isSymbolicLink: () => mode === "symlink",
                    };
                }, "win32");
                if (disposition === "missing")
                    continue;
            }
            catch (failure) {
                caught = failure;
                break;
            }
        }
        waits += 1;
    }
    if (!ownerRead && caught === undefined)
        caught = new Error("timed out waiting for operation journal lock");
    return {
        owner_read: ownerRead,
        read_attempts: readAttempts,
        waits,
        error_code: caught && typeof caught === "object" && "code" in caught ? String(caught.code) : "",
        error_message: caught instanceof Error ? caught.message : caught === undefined ? "" : String(caught),
        store_unavailable: caught instanceof OperationJournalStoreUnavailableError,
    };
}
let lastRecoveredReceipt = null;
// Process-local authority epoch: advances after every verified journal commit,
// whether reached normally or by recovery, so readers can invalidate hot caches.
let recoveryGeneration = 0;
async function recoverUnlocked() {
    const found = await readJournal();
    if (!found)
        return;
    if (found.version === 1) {
        await recoverV1(found.record);
        return;
    }
    lastRecoveredReceipt = await recoverV2(found.record);
}
export async function withOperationJournalBarrier(callback, _options = {}) {
    if (coordinatorContext.getStore() === true)
        return callback();
    const release = await acquireLock();
    try {
        return await coordinatorContext.run(true, async () => { assertConfiguredOperationFailpoint(); await recoverUnlocked(); return callback(); });
    }
    finally {
        await release();
    }
}
export async function recoverPendingOperation() { await withOperationJournalBarrier(async () => undefined); }
export function consumeRecoveredResultReceipt() {
    return lastRecoveredReceipt ? structuredClone(lastRecoveredReceipt) : null;
}
export function operationRecoveryGeneration() { return recoveryGeneration; }
export function reserveOperationTransaction() {
    return { transaction_id: randomUUID(), result_id: randomUUID(), created_at: new Date().toISOString() };
}
export async function commitResourceTransaction(operation, resources, resultReceipt, reservation = reserveOperationTransaction()) {
    if (coordinatorContext.getStore() !== true)
        throw new Error("resource transaction requires operation journal barrier");
    assertConfiguredOperationFailpoint();
    durabilityTrace = [];
    if (await readJournal())
        throw new Error("another recoverable operation is pending");
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(operation))
        throw new Error("invalid operation name");
    if (!UUID_RE.test(reservation.transaction_id) || !UUID_RE.test(reservation.result_id)
        || new Date(reservation.created_at).toISOString() !== reservation.created_at) {
        throw new Error("operation transaction reservation is invalid");
    }
    const transactionId = reservation.transaction_id;
    const directory = join(OPERATIONS_DIR, transactionId);
    const reflectionIds = [...new Set(resultReceipt.reflection_ids ?? [])];
    if (reflectionIds.length > 256 || reflectionIds.some((id) => !id || id.length > 100) || !SHA_RE.test(resultReceipt.result_hash)) {
        throw new Error("operation result receipt input is invalid");
    }
    const receipt = {
        transaction_id: transactionId,
        result_id: reservation.result_id,
        operation,
        reflection_ids: reflectionIds,
        result_hash: resultReceipt.result_hash,
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const records = [];
    let journal;
    try {
        for (const [index, input] of resources.entries()) {
            if (records.some((item) => item.name === input.name))
                throw new Error("duplicate transaction resource");
            const stagedPath = `operations/${transactionId}/after-${index}.bin`;
            const record = {
                name: input.name, target_path: targetPathFor(input.name), before_sha256: await resourceHash(input.name),
                after_sha256: await resourceHash(input.name, input.after), staged_after_path: stagedPath,
            };
            await durableStage(safeOperationPath(stagedPath, transactionId), input.after, input.name);
            records.push(record);
        }
        traceDurability("stage_files_fsynced");
        await syncDirectory(directory);
        traceDurability("transaction_directory_fsynced");
        await syncDirectory(OPERATIONS_DIR);
        traceDurability("operations_directory_fsynced");
        journal = decodeOperationJournalV2({
            schema_version: 2, transaction_id: transactionId, operation, phase: "prepared", created_at: reservation.created_at,
            resources: records, result_receipt: receipt,
        });
        await writeJournal(journal, "prepare");
    }
    catch (error) {
        let published = false;
        try {
            const found = await readJournal();
            published = found?.version === 2 && found.record.transaction_id === transactionId;
        }
        catch {
            published = true;
        }
        if (!published)
            await rm(directory, { recursive: true, force: true });
        throw error;
    }
    journal = { ...journal, phase: "committing" };
    await writeJournal(journal, "committing");
    for (const resource of journal.resources) {
        const staged = await readStaged(resource, true);
        failpoint(`before_replace:${resource.name}`);
        await replaceResource(resource, staged);
        failpoint(`after_replace:${resource.name}`);
        failpoint(`before_verify:${resource.name}`);
        if (await resourceHash(resource.name) !== resource.after_sha256)
            throw new Error(`verification failed for ${resource.name}`);
        failpoint(`after_verify:${resource.name}`);
    }
    journal = { ...journal, phase: "committed" };
    await writeJournal(journal, "commit_marker");
    recoveryGeneration += 1;
    await cleanupV2(journal, false);
    return journal.result_receipt;
}
export async function executeJournaledClear(collection) {
    await withOperationJournalBarrier(async () => {
        const storage = await import("../storage.js");
        const session = await import("../session_storage.js");
        const reflection = await import("./reflection_transaction.js");
        const before = await storage.exportData();
        const afterJson = await storage.previewClearData(collection, before);
        const beforeSqlite = await session.snapshotSessionStorageAfterWriteBarrier();
        if (!beforeSqlite)
            throw new Error("session storage unavailable; no transaction created");
        const afterSqlite = session.emptySessionStorageSnapshot();
        const serialized = reflection.serializeReflectionResources(afterJson);
        await commitResourceTransaction("clear", [
            { name: "reflections", after: serialized.reflections },
            { name: "store_index", after: serialized.store_index },
            { name: "resolved_questions", after: serialized.resolved_questions },
            { name: "session_storage", after: `${JSON.stringify(afterSqlite)}\n` },
        ], { reflection_ids: [], result_hash: operationResultHash(null) });
    });
}
export async function executeJournaledReplaceImport(incoming) {
    return withOperationJournalBarrier(async () => {
        const storage = await import("../storage.js");
        const session = await import("../session_storage.js");
        const reflection = await import("./reflection_transaction.js");
        const before = await storage.exportData();
        const afterJson = await storage.previewReplaceImportData(incoming, before);
        const beforeSqlite = await session.snapshotSessionStorageAfterWriteBarrier();
        if (!beforeSqlite)
            throw new Error("session storage unavailable; no transaction created");
        const afterSqlite = session.emptySessionStorageSnapshot();
        const result = { reflections: afterJson.reflections.length, heuristics: afterJson.heuristics.length, affordance_gaps: afterJson.affordance_gaps.length, sessions: Object.keys(afterJson.sessions).length };
        const serialized = reflection.serializeReflectionResources(afterJson);
        const receipt = await commitResourceTransaction("replace_import", [
            { name: "reflections", after: serialized.reflections },
            { name: "store_index", after: serialized.store_index },
            { name: "resolved_questions", after: serialized.resolved_questions },
            { name: "session_storage", after: `${JSON.stringify(afterSqlite)}\n` },
        ], { reflection_ids: afterJson.reflections.slice(0, 256).map((item) => item.id), result_hash: operationResultHash(result) });
        void receipt;
        return result;
    });
}
