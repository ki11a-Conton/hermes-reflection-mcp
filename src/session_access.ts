import { resolveSessionScope } from "../session_storage.js";
import { projectScopeRepository } from "./project_scope.js";
import {
  assertSessionScopeVisible,
  requestedSessionScope,
  type RequestedSessionScope,
} from "./session_scope.js";

export async function resolvePersistedSessionAccess(
  sessionId: string,
  projectKey?: string,
): Promise<RequestedSessionScope> {
  const requested = requestedSessionScope({
    project_key: projectKey,
    bound_scope: await projectScopeRepository.active(sessionId),
  });
  return assertSessionScopeVisible(await resolveSessionScope(sessionId), requested) as RequestedSessionScope;
}
