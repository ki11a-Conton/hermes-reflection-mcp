import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryScope } from "../types.js";
import { withFileLock } from "./file_lock.js";
import {
  AuthoritativeStateError,
  preserveCorruptUtf8,
  readAuthoritativeJson,
} from "./authoritative_state.js";

const PROJECT_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_BINDINGS = 100;
const PROJECT_SALT_BYTES = 32;

export interface LifecycleMetadata {
  model?: string;
  platform?: string;
  user_id?: string;
}

export function deriveProjectKey(cwd: string, salt: Buffer): MemoryScope {
  if (salt.byteLength !== PROJECT_SALT_BYTES) throw new Error("project salt must contain exactly 32 bytes");
  const canonical = resolve(cwd).replaceAll("\\", "/").toLowerCase();
  return `project:${createHmac("sha256", salt).update(canonical, "utf8").digest("hex")}`;
}

export async function loadOrCreateProjectSalt(
  path = join(homedir(), ".hermes-reflection", "project_salt.bin"),
): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      const salt = randomBytes(PROJECT_SALT_BYTES);
      await handle.writeFile(salt);
      await handle.sync();
      return salt;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  const salt = await readFile(path);
  if (salt.byteLength !== PROJECT_SALT_BYTES) throw new Error("project salt must contain exactly 32 bytes");
  return salt;
}

export function projectScope(key?: string): MemoryScope {
  if (!key) return "global";
  if (!PROJECT_KEY.test(key)) throw new Error("project_key must contain 1-128 safe characters");
  return key.startsWith("project:") ? key as MemoryScope : `project:${key}`;
}

interface ScopeState {
  schema_version: 1;
  bindings: Record<string, { scope: MemoryScope; updated_at: string; metadata?: LifecycleMetadata }>;
}

export interface ProjectScopeRepository {
  bind(sessionId: string, key?: string, metadata?: LifecycleMetadata): Promise<MemoryScope>;
  resolve(input: { session_id?: string; project_key?: string }): Promise<MemoryScope>;
  release(sessionId: string): Promise<void>;
}

function validateSessionId(value: string): string {
  if (!SESSION_ID.test(value)) throw new Error("session_id must contain 1-200 safe characters");
  return value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeMetadata(value: unknown): LifecycleMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lifecycle metadata must be an object");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["model", "platform", "user_id"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error("lifecycle metadata contains unsupported fields");
  const result: LifecycleMetadata = {};
  for (const key of allowed) {
    const item = raw[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || item.length === 0 || item.length > 100 || /[\r\n\0]/.test(item)) {
      throw new Error(`lifecycle metadata ${key} must contain 1-100 safe characters`);
    }
    result[key as keyof LifecycleMetadata] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function decodeScopeState(value: unknown): ScopeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("project scope state must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== 1) {
    throw new Error(`project scope schema_version must be 1, got ${String(raw.schema_version)}`);
  }
  if (!raw.bindings || typeof raw.bindings !== "object" || Array.isArray(raw.bindings)) {
    throw new Error("project scope bindings must be an object");
  }
  const entries = Object.entries(raw.bindings as Record<string, unknown>);
  if (entries.length > MAX_BINDINGS) throw new Error(`project scope bindings exceed ${MAX_BINDINGS}`);
  const bindings = Object.create(null) as ScopeState["bindings"];
  for (const [sessionId, unknownBinding] of entries) {
    validateSessionId(sessionId);
    if (!unknownBinding || typeof unknownBinding !== "object" || Array.isArray(unknownBinding)) {
      throw new Error(`binding ${sessionId} must be an object`);
    }
    const binding = unknownBinding as Record<string, unknown>;
    if (typeof binding.scope !== "string"
      || (binding.scope !== "global" && projectScope(binding.scope) !== binding.scope)) {
      throw new Error(`binding ${sessionId} has invalid scope`);
    }
    if (!validTimestamp(binding.updated_at)) {
      throw new Error(`binding ${sessionId} has invalid updated_at`);
    }
    const metadata = safeMetadata(binding.metadata);
    bindings[sessionId] = {
      scope: binding.scope as MemoryScope,
      updated_at: binding.updated_at,
      ...(metadata ? { metadata } : {}),
    };
  }
  return { schema_version: 1, bindings };
}

export class FileProjectScopeRepository implements ProjectScopeRepository {
  constructor(readonly path: string) {}

  private async readUnlocked(): Promise<ScopeState> {
    const loaded = await readAuthoritativeJson<unknown>(this.path, "Hermes project scope state");
    if (!loaded.exists) return { schema_version: 1, bindings: Object.create(null) as ScopeState["bindings"] };
    try {
      return decodeScopeState(loaded.value);
    } catch (error) {
      const backup = await preserveCorruptUtf8(this.path, loaded.raw);
      const reason = error instanceof Error ? error.message : "invalid project scope state";
      throw new AuthoritativeStateError(
        `Refusing to continue: project scope state is invalid (${reason}). Evidence backup: ${backup}. Nothing was changed.`,
      );
    }
  }

  private async writeUnlocked(state: ScopeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tempPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.path);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async bind(sessionId: string, key?: string, metadata?: LifecycleMetadata): Promise<MemoryScope> {
    validateSessionId(sessionId);
    const scope = projectScope(key);
    const acceptedMetadata = safeMetadata(metadata);
    await withFileLock(this.path, async () => {
      const state = await this.readUnlocked();
      state.bindings[sessionId] = {
        scope,
        updated_at: new Date().toISOString(),
        ...(acceptedMetadata ? { metadata: acceptedMetadata } : {}),
      };
      const oldestFirst = Object.entries(state.bindings)
        .sort(([leftId, left], [rightId, right]) =>
          left.updated_at.localeCompare(right.updated_at) || leftId.localeCompare(rightId));
      while (oldestFirst.length > MAX_BINDINGS) {
        const [oldestId] = oldestFirst.shift()!;
        delete state.bindings[oldestId];
      }
      await this.writeUnlocked(state);
    });
    return scope;
  }

  async resolve(input: { session_id?: string; project_key?: string }): Promise<MemoryScope> {
    if (input.project_key !== undefined) return projectScope(input.project_key);
    if (!input.session_id) return "global";
    validateSessionId(input.session_id);
    const state = await this.readUnlocked();
    return state.bindings[input.session_id]?.scope ?? "global";
  }

  async release(sessionId: string): Promise<void> {
    validateSessionId(sessionId);
    await withFileLock(this.path, async () => {
      const state = await this.readUnlocked();
      if (!Object.prototype.hasOwnProperty.call(state.bindings, sessionId)) return;
      delete state.bindings[sessionId];
      await this.writeUnlocked(state);
    });
  }
}

export const projectScopeRepository = new FileProjectScopeRepository(
  join(homedir(), ".hermes-reflection", "project_scope.json"),
);
