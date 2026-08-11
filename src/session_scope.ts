export type PersistedSessionScope = "global" | `project:${string}` | "legacy-unscoped";
export type RequestedSessionScope = Exclude<PersistedSessionScope, "legacy-unscoped">;

export const SESSION_SCOPE_ERROR_CODES = [
  "SCOPE_REQUIRED",
  "SCOPE_MISMATCH",
  "LEGACY_SCOPE_DENIED",
  "LIFECYCLE_NOT_READY",
] as const;

export type SessionScopeErrorCode = typeof SESSION_SCOPE_ERROR_CODES[number];

export interface SessionAccessRequest {
  project_key?: string;
  bound_scope?: string;
  allow_legacy_unscoped?: boolean;
}

export interface SessionScopeVisibilityPolicy {
  allow_legacy_unscoped?: boolean;
}

export class SessionScopeError extends Error {
  readonly code: SessionScopeErrorCode;

  constructor(code: SessionScopeErrorCode, message: string) {
    super(message);
    this.name = "SessionScopeError";
    this.code = code;
  }
}

const PROJECT_SCOPE = /^project:[A-Za-z0-9._:-]{1,128}$/;
const PROJECT_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export function normalizeRequestedSessionScope(value: unknown): RequestedSessionScope {
  if (value === undefined || value === null || value === "") {
    throw new SessionScopeError("SCOPE_REQUIRED", "An explicit session scope is required.");
  }
  if (value === "legacy-unscoped") {
    throw new SessionScopeError(
      "LEGACY_SCOPE_DENIED",
      "Legacy unscoped sessions cannot be used as scoped authority.",
    );
  }
  if (value === "global" || (typeof value === "string" && PROJECT_SCOPE.test(value))) {
    return value as RequestedSessionScope;
  }
  throw new SessionScopeError("SCOPE_MISMATCH", "Session scope must be global or a canonical project:<key> value.");
}

export function normalizePersistedSessionScope(value: unknown): PersistedSessionScope {
  if (value === "legacy-unscoped") return value;
  return normalizeRequestedSessionScope(value);
}

export function assertSessionScopeVisibility(
  persistedScope: PersistedSessionScope,
  requestedScope: RequestedSessionScope,
): PersistedSessionScope {
  const persisted = normalizePersistedSessionScope(persistedScope);
  if (persisted === "legacy-unscoped") {
    throw new SessionScopeError(
      "LEGACY_SCOPE_DENIED",
      "Legacy unscoped session data is denied until explicitly migrated by trusted lifecycle authority.",
    );
  }
  const requested = normalizeRequestedSessionScope(requestedScope);
  if (persisted !== requested) {
    throw new SessionScopeError(
      "SCOPE_MISMATCH",
      `Requested session scope ${requested} does not match persisted scope ${persisted}.`,
    );
  }
  return persisted;
}

export function lifecycleNotReady(message = "Session lifecycle provenance is not ready."): SessionScopeError {
  return new SessionScopeError("LIFECYCLE_NOT_READY", message);
}

export function requestedSessionScope(request: SessionAccessRequest): RequestedSessionScope | undefined {
  const bound = request.bound_scope === undefined
    ? undefined
    : normalizeRequestedSessionScope(request.bound_scope);
  let project: RequestedSessionScope | undefined;
  if (request.project_key !== undefined) {
    if (!PROJECT_KEY.test(request.project_key)) {
      throw new SessionScopeError("SCOPE_MISMATCH", "project_key must contain 1-128 safe characters.");
    }
    project = normalizeRequestedSessionScope(
      request.project_key.startsWith("project:") ? request.project_key : `project:${request.project_key}`,
    );
  }
  if (project !== undefined && bound !== undefined && project !== bound) {
    throw new SessionScopeError(
      "SCOPE_MISMATCH",
      `Requested project scope ${project} conflicts with bound scope ${bound}.`,
    );
  }
  return project ?? bound;
}

export function assertSessionScopeVisible(
  storedScope: PersistedSessionScope,
  requestedScope?: RequestedSessionScope,
  policy: SessionScopeVisibilityPolicy = {},
): PersistedSessionScope {
  const stored = normalizePersistedSessionScope(storedScope);
  if (stored === "legacy-unscoped") {
    if (policy.allow_legacy_unscoped === true) return stored;
    throw new SessionScopeError(
      "LEGACY_SCOPE_DENIED",
      "Legacy unscoped session data requires explicit administrative authorization.",
    );
  }
  if (requestedScope === undefined) {
    if (stored === "global") return stored;
    throw new SessionScopeError(
      "SCOPE_REQUIRED",
      "An explicit project session scope is required.",
    );
  }
  const requested = normalizeRequestedSessionScope(requestedScope);
  if (stored !== requested) {
    throw new SessionScopeError(
      "SCOPE_MISMATCH",
      `Requested session scope ${requested} does not match persisted scope ${stored}.`,
    );
  }
  return stored;
}
