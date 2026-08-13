import { createHash } from "node:crypto";
import type { CanonicalLifecycleEvent } from "./events.js";
import { parseCanonicalLifecycleEvent } from "./validation.js";

export interface CompletedLifecycleIdentity {
  identity_key: string;
  identity_hash: string;
  event_hash: string;
}

export function canonicalStringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("value is not JSON serializable");
  const normalized = JSON.parse(serialized) as unknown;

  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.keys(input as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((input as Record<string, unknown>)[key])]),
    );
  };

  return JSON.stringify(sortKeys(normalized));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

function identityProjection(value: unknown): CanonicalLifecycleEvent | Omit<CanonicalLifecycleEvent, "occurred_at"> {
  const event = parseCanonicalLifecycleEvent(value);
  if (event.occurred_at_source !== "received") return event;
  const { occurred_at: _receivedAt, ...identity } = event;
  return identity;
}

export function lifecycleIdentityHash(value: unknown): string {
  return canonicalSha256(identityProjection(value));
}

export function lifecycleEventHash(value: unknown): string {
  return canonicalSha256(parseCanonicalLifecycleEvent(value));
}

export function completeLifecycleIdentity(value: unknown): CompletedLifecycleIdentity {
  const event = parseCanonicalLifecycleEvent(value);
  return {
    identity_key: event.identity.key,
    identity_hash: lifecycleIdentityHash(event),
    event_hash: lifecycleEventHash(event),
  };
}

export function classifyCompletedLifecycleIdentity(
  previous: CompletedLifecycleIdentity | undefined,
  current: CompletedLifecycleIdentity,
): "new" | "duplicate" | "conflict" {
  if (!previous || previous.identity_key !== current.identity_key) return "new";
  return previous.identity_hash === current.identity_hash ? "duplicate" : "conflict";
}
