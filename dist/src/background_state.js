import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { withFileLock } from "./file_lock.js";
import { AuthoritativeStateError, preserveCorruptUtf8, readAuthoritativeJson } from "./authoritative_state.js";
const SCHEMA_VERSION = 2;
const MAX_DIRTY_SESSIONS = 100;
const MAX_RECENT_RUNS = 20;
function emptyRecord() {
    return Object.create(null);
}
function initialState() {
    return {
        schema_version: SCHEMA_VERSION,
        next_fencing_token: 1,
        dirty_sessions: emptyRecord(),
        reviewed_sessions: emptyRecord(),
        recent_runs: [],
    };
}
function latestStageTimestamp(state) {
    return [state.deterministic?.completed_at, state.llm?.completed_at]
        .filter((value) => typeof value === "string")
        .sort()
        .at(-1) ?? "";
}
function safeIso(value) {
    if (typeof value !== "string")
        return undefined;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function safeText(value, max = 200) {
    if (typeof value !== "string")
        return undefined;
    const clean = value.replace(/[\r\n\0]/g, " ").trim();
    return clean ? clean.slice(0, max) : undefined;
}
class BackgroundStateValidationError extends Error {
}
function plainRecord(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new BackgroundStateValidationError(`${label} must be an object`);
    }
    return value;
}
function requireExactKeys(value, required, optional, label) {
    const allowed = new Set([...required, ...optional]);
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw new BackgroundStateValidationError(`${label}.${key} is required`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new BackgroundStateValidationError(`${label}.${key} is unsupported`);
    }
}
function requirePositiveSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new BackgroundStateValidationError(`${label} must be a positive safe integer`);
    }
    return Number(value);
}
function requireTimestamp(value, label) {
    const parsed = safeIso(value);
    if (!parsed)
        throw new BackgroundStateValidationError(`${label} must be a parseable timestamp`);
    return parsed;
}
function requireText(value, max, label) {
    if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n\0]/.test(value)) {
        throw new BackgroundStateValidationError(`${label} must contain 1-${max} safe characters`);
    }
    return value;
}
function requireSessionId(value, label) {
    if (value.length === 0 || value.length > 200) {
        throw new BackgroundStateValidationError(`${label} must contain 1-200 characters`);
    }
    return value;
}
function safeFingerprint(value) {
    return typeof value === "string" && value.length === 64 && !/[\r\n\0]/.test(value)
        ? value
        : undefined;
}
function optionalFingerprint(value, label) {
    if (value === undefined)
        return undefined;
    const fingerprint = safeFingerprint(value);
    if (!fingerprint) {
        throw new BackgroundStateValidationError(`${label} must be a safe 64-character fingerprint`);
    }
    return fingerprint;
}
function optionalTimestamp(value, label) {
    return value === undefined ? undefined : requireTimestamp(value, label);
}
function decodeReviewStage(value, label) {
    if (value === undefined)
        return undefined;
    const raw = plainRecord(value, label);
    requireExactKeys(raw, [], ["fingerprint", "completed_at"], label);
    const fingerprint = optionalFingerprint(raw.fingerprint, `${label}.fingerprint`);
    const completedAt = optionalTimestamp(raw.completed_at, `${label}.completed_at`);
    if (!fingerprint && !completedAt)
        throw new BackgroundStateValidationError(`${label} must not be empty`);
    return {
        ...(fingerprint ? { fingerprint } : {}),
        ...(completedAt ? { completed_at: completedAt } : {}),
    };
}
function decodeState(value) {
    const raw = plainRecord(value, "background lifecycle state");
    requireExactKeys(raw, ["schema_version", "next_fencing_token", "dirty_sessions", "reviewed_sessions", "recent_runs"], ["lease"], "background lifecycle state");
    if (raw.schema_version !== SCHEMA_VERSION) {
        throw new BackgroundStateValidationError(`schema_version must equal ${SCHEMA_VERSION}`);
    }
    const state = initialState();
    state.next_fencing_token = requirePositiveSafeInteger(raw.next_fencing_token, "next_fencing_token");
    const dirty = plainRecord(raw.dirty_sessions, "dirty_sessions");
    const dirtyEntries = Object.entries(dirty);
    if (dirtyEntries.length > MAX_DIRTY_SESSIONS) {
        throw new BackgroundStateValidationError(`dirty_sessions exceeds ${MAX_DIRTY_SESSIONS} entries`);
    }
    for (const [sessionId, item] of dirtyEntries) {
        requireSessionId(sessionId, "dirty_sessions session id");
        const data = plainRecord(item, `dirty_sessions.${sessionId}`);
        requireExactKeys(data, ["dirty_at"], ["deterministic", "llm", "retry_after", "outcome_class"], `dirty_sessions.${sessionId}`);
        const decoded = {
            dirty_at: requireTimestamp(data.dirty_at, `dirty_sessions.${sessionId}.dirty_at`),
        };
        const deterministic = decodeReviewStage(data.deterministic, `dirty_sessions.${sessionId}.deterministic`);
        const llm = decodeReviewStage(data.llm, `dirty_sessions.${sessionId}.llm`);
        const retryAfter = optionalTimestamp(data.retry_after, `dirty_sessions.${sessionId}.retry_after`);
        const outcomeClass = data.outcome_class === undefined
            ? undefined
            : requireText(data.outcome_class, 80, `dirty_sessions.${sessionId}.outcome_class`);
        if (deterministic)
            decoded.deterministic = deterministic;
        if (llm)
            decoded.llm = llm;
        if (retryAfter !== undefined)
            decoded.retry_after = retryAfter;
        if (outcomeClass !== undefined)
            decoded.outcome_class = outcomeClass;
        state.dirty_sessions[sessionId] = decoded;
    }
    const reviewed = plainRecord(raw.reviewed_sessions, "reviewed_sessions");
    const reviewedEntries = Object.entries(reviewed);
    if (reviewedEntries.length > MAX_DIRTY_SESSIONS) {
        throw new BackgroundStateValidationError(`reviewed_sessions exceeds ${MAX_DIRTY_SESSIONS} entries`);
    }
    for (const [sessionId, item] of reviewedEntries) {
        requireSessionId(sessionId, "reviewed_sessions session id");
        const data = plainRecord(item, `reviewed_sessions.${sessionId}`);
        requireExactKeys(data, [], ["deterministic", "llm"], `reviewed_sessions.${sessionId}`);
        const deterministic = decodeReviewStage(data.deterministic, `reviewed_sessions.${sessionId}.deterministic`);
        const llm = decodeReviewStage(data.llm, `reviewed_sessions.${sessionId}.llm`);
        if (!deterministic && !llm) {
            throw new BackgroundStateValidationError(`reviewed_sessions.${sessionId} must contain a completed stage`);
        }
        state.reviewed_sessions[sessionId] = {
            ...(deterministic ? { deterministic } : {}),
            ...(llm ? { llm } : {}),
        };
    }
    if (raw.lease !== undefined) {
        const lease = plainRecord(raw.lease, "lease");
        requireExactKeys(lease, ["owner_id", "pid", "host", "acquired_at", "expires_at", "fencing_token"], [], "lease");
        const token = requirePositiveSafeInteger(lease.fencing_token, "lease.fencing_token");
        state.lease = {
            owner_id: requireText(lease.owner_id, 200, "lease.owner_id"),
            pid: requirePositiveSafeInteger(lease.pid, "lease.pid"),
            host: requireText(lease.host, 200, "lease.host"),
            acquired_at: requireTimestamp(lease.acquired_at, "lease.acquired_at"),
            expires_at: requireTimestamp(lease.expires_at, "lease.expires_at"),
            fencing_token: token,
        };
        if (state.next_fencing_token <= token) {
            throw new BackgroundStateValidationError("next_fencing_token must exceed lease.fencing_token");
        }
    }
    if (!Array.isArray(raw.recent_runs)) {
        throw new BackgroundStateValidationError("recent_runs must be an array");
    }
    if (raw.recent_runs.length > MAX_RECENT_RUNS) {
        throw new BackgroundStateValidationError(`recent_runs exceeds ${MAX_RECENT_RUNS} entries`);
    }
    for (const [index, item] of raw.recent_runs.entries()) {
        const run = plainRecord(item, `recent_runs[${index}]`);
        requireExactKeys(run, ["session_id", "finished_at", "outcome_class"], [], `recent_runs[${index}]`);
        state.recent_runs.push({
            session_id: requireText(run.session_id, 200, `recent_runs[${index}].session_id`),
            finished_at: requireTimestamp(run.finished_at, `recent_runs[${index}].finished_at`),
            outcome_class: requireText(run.outcome_class, 80, `recent_runs[${index}].outcome_class`),
        });
    }
    return state;
}
function migrateSchema1(value) {
    const raw = plainRecord(value, "background lifecycle state");
    requireExactKeys(raw, ["schema_version", "next_fencing_token", "dirty_sessions", "reviewed_sessions", "recent_runs"], ["lease"], "background lifecycle state");
    if (raw.schema_version !== 1) {
        throw new BackgroundStateValidationError(`schema_version must equal ${SCHEMA_VERSION}`);
    }
    const dirtyV2 = emptyRecord();
    for (const [sessionId, item] of Object.entries(plainRecord(raw.dirty_sessions, "dirty_sessions"))) {
        requireSessionId(sessionId, "dirty_sessions session id");
        const data = plainRecord(item, `dirty_sessions.${sessionId}`);
        requireExactKeys(data, ["dirty_at"], ["last_reviewed_fingerprint", "last_reviewed_at", "retry_after"], `dirty_sessions.${sessionId}`);
        const fingerprint = optionalFingerprint(data.last_reviewed_fingerprint, `dirty_sessions.${sessionId}.last_reviewed_fingerprint`);
        const completedAt = optionalTimestamp(data.last_reviewed_at, `dirty_sessions.${sessionId}.last_reviewed_at`);
        dirtyV2[sessionId] = {
            dirty_at: requireTimestamp(data.dirty_at, `dirty_sessions.${sessionId}.dirty_at`),
            ...((fingerprint || completedAt) ? {
                deterministic: {
                    ...(fingerprint ? { fingerprint } : {}),
                    ...(completedAt ? { completed_at: completedAt } : {}),
                },
            } : {}),
            ...(data.retry_after === undefined ? {} : {
                retry_after: requireTimestamp(data.retry_after, `dirty_sessions.${sessionId}.retry_after`),
            }),
        };
    }
    const reviewedV2 = emptyRecord();
    for (const [sessionId, item] of Object.entries(plainRecord(raw.reviewed_sessions, "reviewed_sessions"))) {
        requireSessionId(sessionId, "reviewed_sessions session id");
        const data = plainRecord(item, `reviewed_sessions.${sessionId}`);
        requireExactKeys(data, ["last_reviewed_fingerprint", "last_reviewed_at"], [], `reviewed_sessions.${sessionId}`);
        reviewedV2[sessionId] = {
            deterministic: {
                fingerprint: optionalFingerprint(data.last_reviewed_fingerprint, `reviewed_sessions.${sessionId}.last_reviewed_fingerprint`),
                completed_at: requireTimestamp(data.last_reviewed_at, `reviewed_sessions.${sessionId}.last_reviewed_at`),
            },
        };
    }
    return decodeState({
        schema_version: SCHEMA_VERSION,
        next_fencing_token: raw.next_fencing_token,
        dirty_sessions: dirtyV2,
        reviewed_sessions: reviewedV2,
        recent_runs: raw.recent_runs,
        ...(raw.lease === undefined ? {} : { lease: raw.lease }),
    });
}
function errorCode(error) {
    return error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
}
function processLiveness(pid) {
    try {
        process.kill(pid, 0);
        return "alive";
    }
    catch (error) {
        return errorCode(error) === "EPERM" ? "unknown" : "dead";
    }
}
export class BackgroundStateStore {
    path;
    constructor(path) {
        this.path = path;
    }
    async readUnlocked() {
        const loaded = await readAuthoritativeJson(this.path, "Hermes background lifecycle state");
        if (!loaded.exists)
            return { state: initialState(), recovered: true };
        try {
            const raw = plainRecord(loaded.value, "background lifecycle state");
            if (raw.schema_version === 1)
                return { state: migrateSchema1(raw), recovered: true };
            return { state: decodeState(raw), recovered: false };
        }
        catch (error) {
            const backup = await preserveCorruptUtf8(this.path, loaded.raw);
            const reason = error instanceof Error ? error.message : "invalid background lifecycle state";
            throw new AuthoritativeStateError(`Refusing to continue: background_lifecycle.json is invalid (${reason}). `
                + `Evidence backup: ${backup}. Nothing was changed.`);
        }
    }
    async writeUnlocked(state) {
        await mkdir(dirname(this.path), { recursive: true });
        const tempPath = `${this.path}.tmp.${process.pid}.${randomUUID()}`;
        try {
            await writeFile(tempPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
            await rename(tempPath, this.path);
        }
        finally {
            await rm(tempPath, { force: true }).catch(() => undefined);
        }
    }
    async mutate(fn) {
        return withFileLock(this.path, async () => {
            const { state } = await this.readUnlocked();
            const result = await fn(state);
            await this.writeUnlocked(state);
            return result;
        });
    }
    async markDirty(sessionId, dirtyAt = new Date().toISOString()) {
        if (!sessionId || sessionId.length > 200)
            throw new Error("session_id must contain 1-200 characters");
        const timestamp = safeIso(dirtyAt) ?? new Date().toISOString();
        await this.mutate((state) => {
            const previous = state.reviewed_sessions[sessionId];
            state.dirty_sessions[sessionId] = { dirty_at: timestamp, ...previous };
            const ordered = Object.entries(state.dirty_sessions).sort((a, b) => a[1].dirty_at.localeCompare(b[1].dirty_at));
            while (ordered.length > MAX_DIRTY_SESSIONS) {
                const [oldest] = ordered.shift();
                delete state.dirty_sessions[oldest];
            }
        });
    }
    async acquireLease(ownerId, leaseMs) {
        const duration = Math.max(1_000, Math.min(24 * 60 * 60 * 1_000, Math.floor(leaseMs)));
        return this.mutate((state) => {
            const now = Date.now();
            const current = state.lease;
            if (current) {
                const expired = Date.parse(current.expires_at) <= now;
                if (current.owner_id === ownerId && current.pid === process.pid && !expired) {
                    return { acquired: true, fencing_token: current.fencing_token, expires_at: current.expires_at };
                }
                const confirmedDead = !expired
                    && current.host === hostname()
                    && processLiveness(current.pid) === "dead";
                if (!expired && !confirmedDead) {
                    return {
                        acquired: false,
                        fencing_token: current.fencing_token,
                        expires_at: current.expires_at,
                        owner_active: true,
                    };
                }
            }
            if (state.next_fencing_token >= Number.MAX_SAFE_INTEGER) {
                throw new Error("Background fencing token space is exhausted");
            }
            const token = state.next_fencing_token;
            state.next_fencing_token += 1;
            state.lease = {
                owner_id: ownerId,
                pid: process.pid,
                host: hostname(),
                acquired_at: new Date(now).toISOString(),
                expires_at: new Date(now + duration).toISOString(),
                fencing_token: token,
            };
            return { acquired: true, fencing_token: token, expires_at: state.lease.expires_at };
        });
    }
    async renewLease(ownerId, fencingToken, leaseMs) {
        const duration = Math.max(1_000, Math.min(24 * 60 * 60 * 1_000, Math.floor(leaseMs)));
        return this.mutate((state) => {
            const lease = state.lease;
            if (!lease || lease.owner_id !== ownerId || lease.fencing_token !== fencingToken) {
                return { renewed: false };
            }
            lease.expires_at = new Date(Date.now() + duration).toISOString();
            return { renewed: true, expires_at: lease.expires_at };
        });
    }
    async isLeaseCurrent(ownerId, fencingToken) {
        return withFileLock(this.path, async () => {
            const { state, recovered } = await this.readUnlocked();
            if (recovered)
                await this.writeUnlocked(state);
            return state.lease?.owner_id === ownerId
                && state.lease.fencing_token === fencingToken
                && Date.parse(state.lease.expires_at) > Date.now();
        });
    }
    async withCurrentLease(ownerId, fencingToken, operation) {
        return withFileLock(this.path, async () => {
            const { state, recovered } = await this.readUnlocked();
            if (recovered)
                await this.writeUnlocked(state);
            const current = state.lease?.owner_id === ownerId
                && state.lease.fencing_token === fencingToken
                && Date.parse(state.lease.expires_at) > Date.now();
            if (!current)
                return undefined;
            // Keep the lifecycle lock through the protected write. A competing
            // process cannot replace the fence between validation and apply.
            return operation();
        });
    }
    async commitStage(ownerId, fencingToken, sessionId, stage, fingerprint, outcomeClass, candidateIds, expectedDirtyAt, retryAfterMs) {
        if (candidateIds.length > 100 || candidateIds.some((id) => !/^[A-Za-z0-9._:-]{1,100}$/.test(id))) {
            return false;
        }
        return this.mutate((state) => {
            if (state.lease?.owner_id !== ownerId || state.lease.fencing_token !== fencingToken || Date.parse(state.lease.expires_at) <= Date.now()) {
                return false;
            }
            const completedReview = !retryAfterMs || retryAfterMs <= 0;
            const reviewedFingerprint = safeFingerprint(fingerprint);
            if (completedReview && !reviewedFingerprint)
                return false;
            const finishedAt = new Date().toISOString();
            if (completedReview) {
                const previous = state.reviewed_sessions[sessionId] ?? {};
                state.reviewed_sessions[sessionId] = {
                    ...previous,
                    [stage]: { fingerprint: reviewedFingerprint, completed_at: finishedAt },
                };
                const reviewed = Object.entries(state.reviewed_sessions)
                    .sort((a, b) => latestStageTimestamp(a[1]).localeCompare(latestStageTimestamp(b[1])));
                while (reviewed.length > MAX_DIRTY_SESSIONS) {
                    const [oldest] = reviewed.shift();
                    delete state.reviewed_sessions[oldest];
                }
            }
            const dirtyUnchanged = !expectedDirtyAt || state.dirty_sessions[sessionId]?.dirty_at === expectedDirtyAt;
            if (dirtyUnchanged && retryAfterMs && retryAfterMs > 0 && state.dirty_sessions[sessionId]) {
                state.dirty_sessions[sessionId].retry_after = new Date(Date.now() + retryAfterMs).toISOString();
                state.dirty_sessions[sessionId].outcome_class = safeText(outcomeClass, 80) ?? "unknown";
            }
            else if (dirtyUnchanged) {
                delete state.dirty_sessions[sessionId];
            }
            state.recent_runs.push({
                session_id: sessionId,
                finished_at: finishedAt,
                outcome_class: safeText(outcomeClass, 80) ?? "unknown",
            });
            state.recent_runs = state.recent_runs.slice(-MAX_RECENT_RUNS);
            return true;
        });
    }
    /** v19 compatibility wrapper; new code should commit an explicit stage. */
    async commitSession(ownerId, fencingToken, sessionId, fingerprint, outcomeClass, expectedDirtyAt, retryAfterMs) {
        return this.commitStage(ownerId, fencingToken, sessionId, "deterministic", fingerprint, outcomeClass, [], expectedDirtyAt, retryAfterMs);
    }
    async releaseLease(ownerId, fencingToken) {
        return this.mutate((state) => {
            if (state.lease?.owner_id !== ownerId || state.lease.fencing_token !== fencingToken)
                return false;
            delete state.lease;
            return true;
        });
    }
    async dirtySessions() {
        return withFileLock(this.path, async () => {
            const { state, recovered } = await this.readUnlocked();
            if (recovered)
                await this.writeUnlocked(state);
            return Object.entries(state.dirty_sessions)
                .map(([session_id, item]) => ({
                session_id,
                dirty_at: item.dirty_at,
                deterministic: item.deterministic,
                llm: item.llm,
                last_reviewed_fingerprint: item.deterministic?.fingerprint,
                retry_after: item.retry_after,
                outcome_class: item.outcome_class,
            }))
                .sort((a, b) => a.dirty_at.localeCompare(b.dirty_at));
        });
    }
    async status() {
        return withFileLock(this.path, async () => {
            const { state, recovered } = await this.readUnlocked();
            if (recovered)
                await this.writeUnlocked(state);
            const active = Boolean(state.lease && Date.parse(state.lease.expires_at) > Date.now());
            return {
                schema_version: state.schema_version,
                dirty_session_count: Object.keys(state.dirty_sessions).length,
                retrying_session_count: Object.values(state.dirty_sessions)
                    .filter((item) => item.retry_after && Date.parse(item.retry_after) > Date.now()).length,
                dirty_session_ids: Object.keys(state.dirty_sessions),
                lease: {
                    active,
                    owned_by_this_process: Boolean(active && state.lease?.pid === process.pid),
                    expires_at: active ? state.lease?.expires_at : undefined,
                    fencing_token: active ? state.lease?.fencing_token : undefined,
                },
                recent_runs: [...state.recent_runs],
            };
        });
    }
}
