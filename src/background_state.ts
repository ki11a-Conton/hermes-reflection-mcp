import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { withFileLock } from "./file_lock.js";
import { AuthoritativeStateError, preserveCorruptUtf8, readAuthoritativeJson } from "./authoritative_state.js";

const SCHEMA_VERSION = 1 as const;
const MAX_DIRTY_SESSIONS = 100;
const MAX_RECENT_RUNS = 20;

interface DirtySessionState {
  dirty_at: string;
  last_reviewed_fingerprint?: string;
  last_reviewed_at?: string;
  retry_after?: string;
}

interface BackgroundLease {
  owner_id: string;
  pid: number;
  host: string;
  acquired_at: string;
  expires_at: string;
  fencing_token: number;
}

interface BackgroundRunAudit {
  session_id: string;
  finished_at: string;
  outcome_class: string;
}

interface BackgroundState {
  schema_version: typeof SCHEMA_VERSION;
  next_fencing_token: number;
  dirty_sessions: Record<string, DirtySessionState>;
  reviewed_sessions: Record<string, Pick<DirtySessionState, "last_reviewed_fingerprint" | "last_reviewed_at">>;
  lease?: BackgroundLease;
  recent_runs: BackgroundRunAudit[];
}

export interface LeaseResult {
  acquired: boolean;
  fencing_token: number;
  expires_at?: string;
  owner_active?: boolean;
}

export interface LeaseRenewalResult {
  renewed: boolean;
  expires_at?: string;
}

export interface BackgroundStatus {
  schema_version: number;
  dirty_session_count: number;
  dirty_session_ids: string[];
  lease: {
    active: boolean;
    owned_by_this_process: boolean;
    expires_at?: string;
    fencing_token?: number;
  };
  recent_runs: BackgroundRunAudit[];
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function initialState(): BackgroundState {
  return {
    schema_version: SCHEMA_VERSION,
    next_fencing_token: 1,
    dirty_sessions: emptyRecord(),
    reviewed_sessions: emptyRecord(),
    recent_runs: [],
  };
}

function safeIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function safeText(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\r\n\0]/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

class BackgroundStateValidationError extends Error {}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackgroundStateValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new BackgroundStateValidationError(`${label}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new BackgroundStateValidationError(`${label}.${key} is unsupported`);
  }
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new BackgroundStateValidationError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function requireTimestamp(value: unknown, label: string): string {
  const parsed = safeIso(value);
  if (!parsed) throw new BackgroundStateValidationError(`${label} must be a parseable timestamp`);
  return parsed;
}

function requireText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n\0]/.test(value)) {
    throw new BackgroundStateValidationError(`${label} must contain 1-${max} safe characters`);
  }
  return value;
}

function requireSessionId(value: string, label: string): string {
  if (value.length === 0 || value.length > 200) {
    throw new BackgroundStateValidationError(`${label} must contain 1-200 characters`);
  }
  return value;
}

function safeFingerprint(value: unknown): string | undefined {
  return typeof value === "string" && value.length === 64 && !/[\r\n\0]/.test(value)
    ? value
    : undefined;
}

function optionalFingerprint(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const fingerprint = safeFingerprint(value);
  if (!fingerprint) {
    throw new BackgroundStateValidationError(`${label} must be a safe 64-character fingerprint`);
  }
  return fingerprint;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireTimestamp(value, label);
}

function decodeState(value: unknown): BackgroundState {
  const raw = plainRecord(value, "background lifecycle state");
  requireExactKeys(
    raw,
    ["schema_version", "next_fencing_token", "dirty_sessions", "reviewed_sessions", "recent_runs"],
    ["lease"],
    "background lifecycle state",
  );
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
    requireExactKeys(
      data,
      ["dirty_at"],
      ["last_reviewed_fingerprint", "last_reviewed_at", "retry_after"],
      `dirty_sessions.${sessionId}`,
    );
    const decoded: DirtySessionState = {
      dirty_at: requireTimestamp(data.dirty_at, `dirty_sessions.${sessionId}.dirty_at`),
    };
    const fingerprint = optionalFingerprint(
      data.last_reviewed_fingerprint,
      `dirty_sessions.${sessionId}.last_reviewed_fingerprint`,
    );
    const reviewedAt = optionalTimestamp(data.last_reviewed_at, `dirty_sessions.${sessionId}.last_reviewed_at`);
    const retryAfter = optionalTimestamp(data.retry_after, `dirty_sessions.${sessionId}.retry_after`);
    if (fingerprint !== undefined) decoded.last_reviewed_fingerprint = fingerprint;
    if (reviewedAt !== undefined) decoded.last_reviewed_at = reviewedAt;
    if (retryAfter !== undefined) decoded.retry_after = retryAfter;
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
    requireExactKeys(
      data,
      ["last_reviewed_fingerprint", "last_reviewed_at"],
      [],
      `reviewed_sessions.${sessionId}`,
    );
    state.reviewed_sessions[sessionId] = {
      last_reviewed_fingerprint: optionalFingerprint(
        data.last_reviewed_fingerprint,
        `reviewed_sessions.${sessionId}.last_reviewed_fingerprint`,
      ),
      last_reviewed_at: requireTimestamp(
        data.last_reviewed_at,
        `reviewed_sessions.${sessionId}.last_reviewed_at`,
      ),
    };
  }

  if (raw.lease !== undefined) {
    const lease = plainRecord(raw.lease, "lease");
    requireExactKeys(
      lease,
      ["owner_id", "pid", "host", "acquired_at", "expires_at", "fencing_token"],
      [],
      "lease",
    );
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

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

type ProcessLiveness = "alive" | "dead" | "unknown";

function processLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return errorCode(error) === "EPERM" ? "unknown" : "dead";
  }
}

export class BackgroundStateStore {
  constructor(readonly path: string) {}

  private async readUnlocked(): Promise<{ state: BackgroundState; recovered: boolean }> {
    const loaded = await readAuthoritativeJson<unknown>(this.path, "Hermes background lifecycle state");
    if (!loaded.exists) return { state: initialState(), recovered: true };
    try {
      return { state: decodeState(loaded.value), recovered: false };
    } catch (error) {
      const backup = await preserveCorruptUtf8(this.path, loaded.raw);
      const reason = error instanceof Error ? error.message : "invalid background lifecycle state";
      throw new AuthoritativeStateError(
        `Refusing to continue: background_lifecycle.json is invalid (${reason}). `
        + `Evidence backup: ${backup}. Nothing was changed.`,
      );
    }
  }

  private async writeUnlocked(state: BackgroundState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tempPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.path);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async mutate<T>(fn: (state: BackgroundState) => T | Promise<T>): Promise<T> {
    return withFileLock(this.path, async () => {
      const { state } = await this.readUnlocked();
      const result = await fn(state);
      await this.writeUnlocked(state);
      return result;
    });
  }

  async markDirty(sessionId: string, dirtyAt = new Date().toISOString()): Promise<void> {
    if (!sessionId || sessionId.length > 200) throw new Error("session_id must contain 1-200 characters");
    const timestamp = safeIso(dirtyAt) ?? new Date().toISOString();
    await this.mutate((state) => {
      const previous = state.reviewed_sessions[sessionId];
      state.dirty_sessions[sessionId] = { dirty_at: timestamp, ...previous };
      const ordered = Object.entries(state.dirty_sessions).sort((a, b) => a[1].dirty_at.localeCompare(b[1].dirty_at));
      while (ordered.length > MAX_DIRTY_SESSIONS) {
        const [oldest] = ordered.shift()!;
        delete state.dirty_sessions[oldest];
      }
    });
  }

  async acquireLease(ownerId: string, leaseMs: number): Promise<LeaseResult> {
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

  async renewLease(ownerId: string, fencingToken: number, leaseMs: number): Promise<LeaseRenewalResult> {
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

  async isLeaseCurrent(ownerId: string, fencingToken: number): Promise<boolean> {
    return withFileLock(this.path, async () => {
      const { state, recovered } = await this.readUnlocked();
      if (recovered) await this.writeUnlocked(state);
      return state.lease?.owner_id === ownerId
        && state.lease.fencing_token === fencingToken
        && Date.parse(state.lease.expires_at) > Date.now();
    });
  }

  async withCurrentLease<T>(
    ownerId: string,
    fencingToken: number,
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    return withFileLock(this.path, async () => {
      const { state, recovered } = await this.readUnlocked();
      if (recovered) await this.writeUnlocked(state);
      const current = state.lease?.owner_id === ownerId
        && state.lease.fencing_token === fencingToken
        && Date.parse(state.lease.expires_at) > Date.now();
      if (!current) return undefined;
      // Keep the lifecycle lock through the protected write. A competing
      // process cannot replace the fence between validation and apply.
      return operation();
    });
  }

  async commitSession(
    ownerId: string,
    fencingToken: number,
    sessionId: string,
    fingerprint: string,
    outcomeClass: string,
    expectedDirtyAt?: string,
    retryAfterMs?: number,
  ): Promise<boolean> {
    return this.mutate((state) => {
      if (state.lease?.owner_id !== ownerId || state.lease.fencing_token !== fencingToken || Date.parse(state.lease.expires_at) <= Date.now()) {
        return false;
      }
      const completedReview = !retryAfterMs || retryAfterMs <= 0;
      const reviewedFingerprint = safeFingerprint(fingerprint);
      if (completedReview && !reviewedFingerprint) return false;
      const finishedAt = new Date().toISOString();
      if (completedReview) {
        state.reviewed_sessions[sessionId] = {
          last_reviewed_fingerprint: reviewedFingerprint,
          last_reviewed_at: finishedAt,
        };
        const reviewed = Object.entries(state.reviewed_sessions)
          .sort((a, b) => (a[1].last_reviewed_at ?? "").localeCompare(b[1].last_reviewed_at ?? ""));
        while (reviewed.length > MAX_DIRTY_SESSIONS) {
          const [oldest] = reviewed.shift()!;
          delete state.reviewed_sessions[oldest];
        }
      }
      const dirtyUnchanged = !expectedDirtyAt || state.dirty_sessions[sessionId]?.dirty_at === expectedDirtyAt;
      if (dirtyUnchanged && retryAfterMs && retryAfterMs > 0 && state.dirty_sessions[sessionId]) {
        state.dirty_sessions[sessionId].retry_after = new Date(Date.now() + retryAfterMs).toISOString();
      } else if (dirtyUnchanged) {
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

  async releaseLease(ownerId: string, fencingToken: number): Promise<boolean> {
    return this.mutate((state) => {
      if (state.lease?.owner_id !== ownerId || state.lease.fencing_token !== fencingToken) return false;
      delete state.lease;
      return true;
    });
  }

  async dirtySessions(): Promise<Array<{ session_id: string; dirty_at: string; last_reviewed_fingerprint?: string; retry_after?: string }>> {
    return withFileLock(this.path, async () => {
      const { state, recovered } = await this.readUnlocked();
      if (recovered) await this.writeUnlocked(state);
      return Object.entries(state.dirty_sessions)
        .map(([session_id, item]) => ({
          session_id,
          dirty_at: item.dirty_at,
          last_reviewed_fingerprint: item.last_reviewed_fingerprint,
          retry_after: item.retry_after,
        }))
        .sort((a, b) => a.dirty_at.localeCompare(b.dirty_at));
    });
  }

  async status(): Promise<BackgroundStatus> {
    return withFileLock(this.path, async () => {
      const { state, recovered } = await this.readUnlocked();
      if (recovered) await this.writeUnlocked(state);
      const active = Boolean(state.lease && Date.parse(state.lease.expires_at) > Date.now());
      return {
        schema_version: state.schema_version,
        dirty_session_count: Object.keys(state.dirty_sessions).length,
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
