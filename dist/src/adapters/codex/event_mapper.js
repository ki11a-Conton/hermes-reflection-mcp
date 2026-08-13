import { parseCanonicalLifecycleEvent } from "../../lifecycle/validation.js";
export function isActionableCodexHookEvent(event, turnCaptureEnabled) {
    if (event.event === "UserPromptSubmit" || event.event === "Stop") {
        return turnCaptureEnabled && Boolean(event.turn_id && event.captured);
    }
    if (event.event === "PreCompact")
        return Boolean(event.turn_id && event.trigger);
    return true;
}
function mappedScope(event, options) {
    if (event.project_key)
        return event.project_key;
    if (event.event === "SessionStart" && event.scope_intent === "global")
        return "global";
    if (options.resolved_scope)
        return options.resolved_scope;
    throw new Error("CODEX_LIFECYCLE_SCOPE_REQUIRED: resolve the active session scope before mapping this event");
}
export function mapCodexHookEvent(event, options = {}) {
    const common = {
        schema_version: 1,
        host: { name: "codex" },
        session_id: event.session_id,
        ...(event.turn_id ? { turn_id: event.turn_id } : {}),
        occurred_at: event.occurred_at,
        occurred_at_source: event.occurred_at_source === "received" ? "received" : "host",
        scope: mappedScope(event, options),
        identity: {
            key: event.event_id,
            source: event.event_id_source === "generated" ? "generated" : "host",
        },
    };
    let mapped;
    switch (event.event) {
        case "SessionStart":
            mapped = {
                ...common,
                type: "session_start",
                payload: {
                    kind: "session_start",
                    ...(event.source ? { source: event.source } : {}),
                },
            };
            break;
        case "UserPromptSubmit":
            mapped = {
                ...common,
                type: "turn_start",
                payload: {
                    kind: "turn_start",
                    ...(event.captured ? { capture: event.captured } : {}),
                },
            };
            break;
        case "Stop":
            mapped = {
                ...common,
                type: "turn_end",
                payload: {
                    kind: "turn_end",
                    ...(event.captured ? { capture: event.captured } : {}),
                },
            };
            break;
        case "PreCompact":
            mapped = {
                ...common,
                type: "pre_compact",
                payload: {
                    kind: "pre_compact",
                    ...(event.trigger ? { observation: { trigger: event.trigger } } : {}),
                },
            };
            break;
        case "PostCompact":
            mapped = {
                ...common,
                type: "post_compact",
                payload: {
                    kind: "post_compact",
                    ...(event.trigger ? { observation: { trigger: event.trigger } } : {}),
                    ...(event.metadata ? { trusted_receipt: event.metadata } : {}),
                },
            };
            break;
        case "SessionEnd":
            mapped = {
                ...common,
                type: "session_end",
                payload: {
                    kind: "session_end",
                    reason: event.reason ?? "SessionEnd Hook",
                },
            };
            break;
    }
    return parseCanonicalLifecycleEvent(mapped);
}
