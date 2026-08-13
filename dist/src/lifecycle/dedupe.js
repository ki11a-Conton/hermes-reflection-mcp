import { createHash } from "node:crypto";
import { parseCanonicalLifecycleEvent } from "./validation.js";
export function canonicalStringify(value) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
        throw new TypeError("value is not JSON serializable");
    const normalized = JSON.parse(serialized);
    const sortKeys = (input) => {
        if (Array.isArray(input))
            return input.map(sortKeys);
        if (!input || typeof input !== "object")
            return input;
        return Object.fromEntries(Object.keys(input)
            .sort()
            .map((key) => [key, sortKeys(input[key])]));
    };
    return JSON.stringify(sortKeys(normalized));
}
export function canonicalSha256(value) {
    return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}
function identityProjection(value) {
    const event = parseCanonicalLifecycleEvent(value);
    if (event.occurred_at_source !== "received")
        return event;
    const { occurred_at: _receivedAt, ...identity } = event;
    return identity;
}
export function lifecycleIdentityHash(value) {
    return canonicalSha256(identityProjection(value));
}
export function lifecycleEventHash(value) {
    return canonicalSha256(parseCanonicalLifecycleEvent(value));
}
export function completeLifecycleIdentity(value) {
    const event = parseCanonicalLifecycleEvent(value);
    return {
        identity_key: event.identity.key,
        identity_hash: lifecycleIdentityHash(event),
        event_hash: lifecycleEventHash(event),
    };
}
export function classifyCompletedLifecycleIdentity(previous, current) {
    if (!previous || previous.identity_key !== current.identity_key)
        return "new";
    return previous.identity_hash === current.identity_hash ? "duplicate" : "conflict";
}
