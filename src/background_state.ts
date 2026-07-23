import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { withFileLock } from "./file_lock.js";

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

function normalizeState(value: unknown): BackgroundState {
  const state = initialState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return state;
  const raw = value as Record<string, unknown>;
  if (Number.isSafeInteger(raw.next_fencing_token) && Number(raw.next_fencing_token) > 0) {
    state.next_fencing_token = Number(raw.next_fencing_token);
  }

  if (raw.dirty_sessions && typeof raw.dirty_sessions === "object" && !Array.isArray(raw.dirty_sessions)) {
    const entries = Object.entries(raw.dirty_sessions as Record<string, unknown>).slice(-MAX_DIRTY_SESSIONS);
    for (const [sessionId, item] of entries) {
      if (!sessionId || sessionId.length > 200 || !item || typeof item !== "object" || Array.isArray(item)) continue;
      const data = item as Record<string, unknown>;
      const dirtyAt = safeIso(data.dirty_at);
      if (!dirtyAt) continue;
      state.dirty_sessions[sessionId] = {
        dirty_at: dirtyAt,
        last_reviewed_fingerprint: safeText(data.last_reviewed_fingerprint, 64),
        last_reviewed_at: safeIso(data.last_reviewed_at),
        retry_after: safeIso(data.retry_after),
      };
    }
  }

  if (raw.reviewed_sessions && typeof raw.reviewed_sessions === "object" && !Array.isArray(raw.reviewed_sessions)) {
    for (const [sessionId, item] of Object.entries(raw.reviewed_sessions as Record<string, unknown>).slice(-MAX_DIRTY_SESSIONS)) {
      if (!sessionId || sessionId.length > 200 || !item || typeof item !== "object" || Array.isArray(item)) continue;
      const data = item as Record<string, unknown>;
      state.reviewed_sessions[sessionId] = {
        last_reviewed_fingerprint: safeText(data.last_reviewed_fingerprint, 64),
        last_reviewed_at: safeIso(data.last_reviewed_at),
      };
    }
  }

  if (raw.lease && typeof raw.lease === "object" && !Array.isArray(raw.lease)) {
    const lease = raw.lease as Record<string, unknown>;
    const ownerId = safeText(lease.owner_id, 200);
    const host = safeText(lease.host, 200);
    const acquiredAt = safeIso(lease.acquired_at);
    const expiresAt = safeIso(lease.expires_at);
    const pid = Number(lease.pid);
    const token = Number(lease.fencing_token);
    if (ownerId && host && acquiredAt && expiresAt && Number.isInteger(pid) && pid > 0 && Number.isSafeInteger(token) && token > 0) {
      state.lease = { owner_id: ownerId, host, acquired_at: acquiredAt, expires_at: expiresAt, pid, fencing_token: token };
      state.next_fencing_token = Math.max(state.next_fencing_token, token + 1);
    }
  }

  if (Array.isArray(raw.recent_runs)) {
    for (const item of raw.recent_runs.slice(-MAX_RECENT_RUNS)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const run = item as Record<string, unknown>;
      const sessionId = safeText(run.session_id, 200);
      const finishedAt = safeIso(run.finished_at);
      const outcomeClass = safeText(run.outcome_class, 80);
      if (sessionId && finishedAt && outcomeClass) {
        state.recent_runs.push({ session_id: sessionId, finished_at: finishedAt, outcome_class: outcomeClass });
      }
    }
  }
  return state;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EPERM");
  }
}

export class BackgroundStateStore {
  constructor(readonly path: string) {}

  private async readUnlocked(): Promise<{ state: BackgroundState; recovered: boolean }> {
    try {
      const raw = await readFile(this.path, "utf8");
      return { state: normalizeState(JSON.parse(raw)), recovered: false };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
      if (code === "ENOENT") return { state: initialState(), recovered: true };
      if (error instanceof SyntaxError) {
        const corruptPath = `${this.path}.corrupt.${Date.now()}.${randomUUID()}`;
        await rename(this.path, corruptPath).catch(() => undefined);
        return { state: initialState(), recovered: true };
      }
      throw error;
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
      if (current?.owner_id === ownerId && current.pid === process.pid) {
        current.expires_at = new Date(now + duration).toISOString();
        return { acquired: true, fencing_token: current.fencing_token, expires_at: current.expires_at };
      }
      const currentAlive = current?.host === hostname() && isProcessAlive(current.pid);
      if (current && (Date.parse(current.expires_at) > now || currentAlive)) {
        return { acquired: false, fencing_token: current.fencing_token, expires_at: current.expires_at, owner_active: true };
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
      const finishedAt = new Date().toISOString();
      if (!retryAfterMs || retryAfterMs <= 0) {
        state.reviewed_sessions[sessionId] = {
          last_reviewed_fingerprint: safeText(fingerprint, 64),
          last_reviewed_at: finishedAt,
        };
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
