import { resolveSessionScope } from "../session_storage.js";
import { projectScopeRepository } from "./project_scope.js";
import { assertSessionScopeVisible, requestedSessionScope, } from "./session_scope.js";
export async function resolvePersistedSessionAccess(sessionId, projectKey) {
    const requested = requestedSessionScope({
        project_key: projectKey,
        bound_scope: await projectScopeRepository.active(sessionId),
    });
    return assertSessionScopeVisible(await resolveSessionScope(sessionId), requested);
}
