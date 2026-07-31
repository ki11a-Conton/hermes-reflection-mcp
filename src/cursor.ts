import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { HermesError } from "./errors.js";

export interface CursorPayload {
  v: 1;
  family: string;
  query_hash: string;
  revision: string;
  sort: string;
  id: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function queryHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)) ?? "null", "utf8")
    .digest("hex");
}

export function encodeCursor(value: CursorPayload): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function stale(reason: string): HermesError {
  return new HermesError(
    "CURSOR_STALE",
    reason,
    false,
    "Restart the query without a cursor.",
  );
}

function cursorPayload(value: unknown): CursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw stale("Cursor is invalid.");
  }
  const item = value as Record<string, unknown>;
  const keys = ["v", "family", "query_hash", "revision", "sort", "id"];
  if (Object.keys(item).length !== keys.length || keys.some((key) => !(key in item))) {
    throw stale("Cursor is invalid.");
  }
  if (item.v !== 1) throw stale("Cursor version is unsupported.");
  for (const key of keys.slice(1)) {
    const field = item[key];
    if (typeof field !== "string" || field.length === 0 || field.length > 512) {
      throw stale("Cursor is invalid.");
    }
  }
  if (!/^[a-f0-9]{64}$/.test(String(item.query_hash))) {
    throw stale("Cursor query fingerprint is invalid.");
  }
  return item as unknown as CursorPayload;
}

export function decodeCursor(
  raw: string,
  expected: Pick<CursorPayload, "family" | "query_hash" | "revision">,
): CursorPayload {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096) {
    throw stale("Cursor is invalid.");
  }
  let parsed: CursorPayload;
  try {
    parsed = cursorPayload(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch (error) {
    if (error instanceof HermesError) throw error;
    throw stale("Cursor is invalid.");
  }
  if (
    parsed.family !== expected.family
    || parsed.query_hash !== expected.query_hash
    || parsed.revision !== expected.revision
  ) {
    throw stale("Cursor no longer matches this query or dataset.");
  }
  return parsed;
}
