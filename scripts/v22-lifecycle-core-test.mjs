import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CANONICAL_LIFECYCLE_EVENT_TYPES,
  MAX_LIFECYCLE_CAPTURE_CODE_POINTS,
} from "../dist/src/lifecycle/events.js";
import {
  CanonicalLifecycleEventSchema,
  parseCanonicalLifecycleEvent,
} from "../dist/src/lifecycle/validation.js";
import {
  canonicalSha256,
  canonicalStringify,
  classifyCompletedLifecycleIdentity,
  completeLifecycleIdentity,
  lifecycleEventHash,
  lifecycleIdentityHash,
} from "../dist/src/lifecycle/dedupe.js";

const EVENT_TYPES = [
  "session_start",
  "turn_start",
  "turn_end",
  "pre_compact",
  "post_compact",
  "session_end",
];

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const USER_CAPTURE = {
  side: "user",
  content: "bounded [REDACTED] prompt",
  content_hash: digest("bounded [REDACTED] prompt"),
  original_code_points: 25,
  content_truncated: false,
  content_blocked: false,
};

const ASSISTANT_CAPTURE = {
  side: "assistant",
  content: "bounded assistant answer",
  content_hash: digest("bounded assistant answer"),
  original_code_points: 24,
  content_truncated: false,
  content_blocked: false,
};

const COMPACTION_RECEIPT = {
  generation: 2,
  before_turn_count: 12,
  after_turn_count: 5,
  handoff_hash: digest("handoff"),
  truncated: true,
  source_fingerprint: digest("source"),
};

const PAYLOADS = {
  session_start: { kind: "session_start" },
  turn_start: { kind: "turn_start", capture: USER_CAPTURE },
  turn_end: { kind: "turn_end", capture: ASSISTANT_CAPTURE },
  pre_compact: { kind: "pre_compact", observation: { trigger: "manual" } },
  post_compact: {
    kind: "post_compact",
    observation: { trigger: "auto" },
    trusted_receipt: COMPACTION_RECEIPT,
  },
  session_end: { kind: "session_end", reason: "completed" },
};

function lifecycleEvent(type, overrides = {}) {
  const turn = type === "turn_start" || type === "turn_end";
  return {
    schema_version: 1,
    type,
    host: { name: "test-host", version: "1.2.3" },
    session_id: "session-alpha",
    ...(turn ? { turn_id: "turn-alpha" } : {}),
    occurred_at: "2026-08-12T12:34:56+08:00",
    occurred_at_source: "host",
    scope: "project:alpha",
    identity: { key: `${type}:alpha`, source: "host" },
    payload: structuredClone(PAYLOADS[type]),
    host_metadata: {
      model: "model-1",
      platform: "windows",
      user_id: "local-user",
    },
    ...overrides,
  };
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]),
  );
}

assert.deepEqual(
  [...CANONICAL_LIFECYCLE_EVENT_TYPES],
  EVENT_TYPES,
  "the canonical lifecycle type set changed",
);

for (const type of EVENT_TYPES) {
  const parsed = parseCanonicalLifecycleEvent(lifecycleEvent(type));
  assert.equal(parsed.type, type, `${type} did not validate`);
  assert.equal(parsed.payload.kind, type, `${type} payload lost its discriminator`);
  assert.equal(
    parsed.occurred_at,
    "2026-08-12T04:34:56.000Z",
    `${type} occurred_at was not canonicalized`,
  );
  assert.deepEqual(CanonicalLifecycleEventSchema.parse(parsed), parsed);
}

for (let index = 0; index < EVENT_TYPES.length; index += 1) {
  const type = EVENT_TYPES[index];
  const wrongKind = EVENT_TYPES[(index + 1) % EVENT_TYPES.length];
  assert.throws(
    () => parseCanonicalLifecycleEvent(lifecycleEvent(type, {
      payload: structuredClone(PAYLOADS[wrongKind]),
    })),
    `${type} accepted a ${wrongKind} payload`,
  );
}

assert.throws(
  () => parseCanonicalLifecycleEvent(lifecycleEvent("unknown", {
    payload: { kind: "unknown" },
  })),
  "an unknown lifecycle type was accepted",
);

for (const type of ["turn_start", "turn_end"]) {
  const missingTurn = lifecycleEvent(type);
  delete missingTurn.turn_id;
  assert.throws(
    () => parseCanonicalLifecycleEvent(missingTurn),
    `${type} accepted a missing turn_id`,
  );
}

for (const [field, value] of [
  ["model", "bad\rmodel"],
  ["platform", "bad\nplatform"],
  ["user_id", "bad\0user"],
]) {
  assert.throws(
    () => parseCanonicalLifecycleEvent(lifecycleEvent("session_start", {
      host_metadata: { [field]: value },
    })),
    `host_metadata.${field} accepted CR, LF, or NUL`,
  );
}

assert.throws(
  () => parseCanonicalLifecycleEvent(lifecycleEvent("session_start", {
    host_metadata: { model: "m".repeat(101) },
  })),
  "host metadata was not bounded",
);
assert.throws(
  () => parseCanonicalLifecycleEvent(lifecycleEvent("session_start", {
    scope: "project:unsafe scope",
  })),
  "a non-canonical project scope was accepted",
);
assert.throws(
  () => parseCanonicalLifecycleEvent(lifecycleEvent("session_start", {
    host: { name: "unsafe host name" },
  })),
  "unsafe host names were accepted",
);

for (const rawField of ["prompt", "raw_prompt", "transcript", "transcript_path"]) {
  const rawCapture = lifecycleEvent("turn_start");
  rawCapture.payload.capture[rawField] = "raw input must never enter the core";
  assert.throws(
    () => parseCanonicalLifecycleEvent(rawCapture),
    `capture accepted forbidden raw field ${rawField}`,
  );
}

const oversizedCapture = lifecycleEvent("turn_start");
oversizedCapture.payload.capture.content = "x".repeat(MAX_LIFECYCLE_CAPTURE_CODE_POINTS + 1);
assert.throws(
  () => parseCanonicalLifecycleEvent(oversizedCapture),
  "capture accepted an unbounded content projection",
);

assert.throws(
  () => parseCanonicalLifecycleEvent(lifecycleEvent("turn_start", {
    payload: { kind: "turn_start", capture: ASSISTANT_CAPTURE },
  })),
  "turn_start accepted assistant-side capture",
);
assert.throws(
  () => parseCanonicalLifecycleEvent(lifecycleEvent("turn_end", {
    payload: { kind: "turn_end", capture: USER_CAPTURE },
  })),
  "turn_end accepted user-side capture",
);

assert.doesNotThrow(
  () => parseCanonicalLifecycleEvent(lifecycleEvent("pre_compact")),
  "pre_compact observation was rejected",
);
assert.throws(
  () => parseCanonicalLifecycleEvent(lifecycleEvent("pre_compact", {
    payload: {
      kind: "pre_compact",
      observation: { trigger: "manual" },
      trusted_receipt: COMPACTION_RECEIPT,
    },
  })),
  "pre_compact accepted a trusted receipt",
);
assert.doesNotThrow(
  () => parseCanonicalLifecycleEvent(lifecycleEvent("post_compact")),
  "post_compact rejected a separate observation and trusted receipt",
);
assert.throws(
  () => parseCanonicalLifecycleEvent(lifecycleEvent("post_compact", {
    payload: { kind: "post_compact", observation: COMPACTION_RECEIPT },
  })),
  "a compaction receipt was accepted as an observation",
);

for (const reason of ["", "   ", "x".repeat(201)]) {
  assert.throws(
    () => parseCanonicalLifecycleEvent(lifecycleEvent("session_end", {
      payload: { kind: "session_end", reason },
    })),
    "session_end accepted an empty or unbounded reason",
  );
}

assert.equal(
  canonicalStringify({ z: 1, a: { y: 2, x: [3, { b: false, a: true }] } }),
  canonicalStringify({ a: { x: [3, { a: true, b: false }], y: 2 }, z: 1 }),
  "canonical serialization depends on object-key order",
);
assert.equal(
  canonicalSha256({ z: 1, a: 2 }),
  canonicalSha256({ a: 2, z: 1 }),
  "canonical hashing depends on object-key order",
);

const orderedEvent = lifecycleEvent("turn_start");
const reversedEvent = reverseKeys(orderedEvent);
assert.equal(
  lifecycleIdentityHash(orderedEvent),
  lifecycleIdentityHash(reversedEvent),
  "identity hash depends on event object-key order",
);
assert.equal(
  lifecycleEventHash(orderedEvent),
  lifecycleEventHash(reversedEvent),
  "full event hash depends on event object-key order",
);

const receivedA = lifecycleEvent("turn_start", {
  occurred_at: "2026-08-12T04:34:56Z",
  occurred_at_source: "received",
  identity: { key: "received-retry", source: "generated" },
});
const receivedB = lifecycleEvent("turn_start", {
  occurred_at: "2026-08-12T04:35:30Z",
  occurred_at_source: "received",
  identity: { key: "received-retry", source: "generated" },
});
assert.equal(
  lifecycleIdentityHash(receivedA),
  lifecycleIdentityHash(receivedB),
  "received timestamps changed lifecycle identity",
);
assert.notEqual(
  lifecycleEventHash(receivedA),
  lifecycleEventHash(receivedB),
  "the full event hash excluded a received timestamp",
);

const hostTimestampA = lifecycleEvent("turn_start", {
  occurred_at: "2026-08-12T04:34:56Z",
  occurred_at_source: "host",
  identity: { key: "host-timestamp", source: "host" },
});
const hostTimestampB = lifecycleEvent("turn_start", {
  occurred_at: "2026-08-12T04:35:30Z",
  occurred_at_source: "host",
  identity: { key: "host-timestamp", source: "host" },
});
assert.notEqual(
  lifecycleIdentityHash(hostTimestampA),
  lifecycleIdentityHash(hostTimestampB),
  "a host timestamp was incorrectly excluded from lifecycle identity",
);
assert.notEqual(
  lifecycleEventHash(hostTimestampA),
  lifecycleEventHash(hostTimestampB),
  "the full event hash excluded a host timestamp",
);

const turnA = lifecycleEvent("turn_start", {
  turn_id: "turn-a",
  identity: { key: "same-host-key", source: "host" },
});
const turnB = lifecycleEvent("turn_start", {
  turn_id: "turn-b",
  identity: { key: "same-host-key", source: "host" },
});
assert.notEqual(
  lifecycleIdentityHash(turnA),
  lifecycleIdentityHash(turnB),
  "different turn IDs collapsed to one identity hash",
);
assert.equal(
  classifyCompletedLifecycleIdentity(
    completeLifecycleIdentity(turnA),
    completeLifecycleIdentity(turnB),
  ),
  "conflict",
  "different turns with one identity key were not classified as a conflict",
);

const original = lifecycleEvent("session_end", {
  identity: { key: "session-end-key", source: "derived" },
});
const exactDuplicate = structuredClone(original);
const changedInput = lifecycleEvent("session_end", {
  identity: { key: "session-end-key", source: "derived" },
  payload: { kind: "session_end", reason: "different reason" },
});
const differentKey = lifecycleEvent("session_end", {
  identity: { key: "another-key", source: "derived" },
});
const completed = completeLifecycleIdentity(original);
assert.match(completed.identity_hash, /^[a-f0-9]{64}$/);
assert.match(completed.event_hash, /^[a-f0-9]{64}$/);
assert.equal(
  classifyCompletedLifecycleIdentity(completed, completeLifecycleIdentity(exactDuplicate)),
  "duplicate",
  "an exact replay was not classified as a duplicate",
);
assert.equal(
  classifyCompletedLifecycleIdentity(completed, completeLifecycleIdentity(changedInput)),
  "conflict",
  "changed input under one identity key was not classified as a conflict",
);
assert.equal(
  classifyCompletedLifecycleIdentity(completed, completeLifecycleIdentity(differentKey)),
  "new",
  "a different identity key was not classified as new",
);
assert.equal(
  classifyCompletedLifecycleIdentity(undefined, completed),
  "new",
  "a first-seen identity was not classified as new",
);

process.stdout.write("v22 lifecycle core test passed\n");
