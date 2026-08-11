import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HermesError } from "./errors.js";
// Cursors are process-local capabilities. A restart intentionally invalidates
// outstanding cursors instead of accepting client-edited pagination state.
const CURSOR_AUTH_SECRET = randomBytes(32);
function cursorMac(payload) {
    return createHmac("sha256", CURSOR_AUTH_SECRET).update(payload, "utf8").digest();
}
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]));
    }
    return value;
}
export function queryHash(value) {
    return createHash("sha256")
        .update(JSON.stringify(canonical(value)) ?? "null", "utf8")
        .digest("hex");
}
export function encodeCursor(value) {
    const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    return `${payload}.${cursorMac(payload).toString("base64url")}`;
}
function stale(reason) {
    return new HermesError("CURSOR_STALE", reason, false, "Restart the query without a cursor.");
}
function cursorPayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw stale("Cursor is invalid.");
    }
    const item = value;
    const keys = ["v", "family", "query_hash", "revision", "sort", "id"];
    if (Object.keys(item).length !== keys.length || keys.some((key) => !(key in item))) {
        throw stale("Cursor is invalid.");
    }
    if (item.v !== 1)
        throw stale("Cursor version is unsupported.");
    for (const key of keys.slice(1)) {
        const field = item[key];
        if (typeof field !== "string" || field.length === 0 || field.length > 512) {
            throw stale("Cursor is invalid.");
        }
    }
    if (!/^[a-f0-9]{64}$/.test(String(item.query_hash))) {
        throw stale("Cursor query fingerprint is invalid.");
    }
    return item;
}
export function decodeCursor(raw, expected) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096) {
        throw stale("Cursor is invalid.");
    }
    const separator = raw.indexOf(".");
    if (separator <= 0 || separator !== raw.lastIndexOf("."))
        throw stale("Cursor authentication failed.");
    const payload = raw.slice(0, separator);
    const encodedMac = raw.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(encodedMac)) {
        throw stale("Cursor authentication failed.");
    }
    let suppliedMac;
    try {
        suppliedMac = Buffer.from(encodedMac, "base64url");
    }
    catch {
        throw stale("Cursor authentication failed.");
    }
    const expectedMac = cursorMac(payload);
    if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) {
        throw stale("Cursor authentication failed.");
    }
    let parsed;
    try {
        parsed = cursorPayload(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    }
    catch (error) {
        if (error instanceof HermesError)
            throw error;
        throw stale("Cursor is invalid.");
    }
    if (parsed.family !== expected.family
        || parsed.query_hash !== expected.query_hash
        || parsed.revision !== expected.revision) {
        throw stale("Cursor no longer matches this query or dataset.");
    }
    return parsed;
}
