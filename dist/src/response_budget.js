import { Buffer } from "node:buffer";
import { HermesError } from "./errors.js";
export const RESPONSE_LIMITS = {
    compact: { code_points: 6_000, utf8_bytes: 24 * 1024 },
    full: { code_points: 20_000, utf8_bytes: 80 * 1024 },
};
export function modelVisibleSize(value) {
    const serialized = JSON.stringify(value) ?? "null";
    return {
        code_points: Array.from(serialized).length,
        utf8_bytes: Buffer.byteLength(serialized, "utf8"),
    };
}
export function withinBudget(value, mode) {
    const size = modelVisibleSize(value);
    const limit = RESPONSE_LIMITS[mode];
    return size.code_points <= limit.code_points && size.utf8_bytes <= limit.utf8_bytes;
}
function shortSummary(value) {
    return Array.from(value).slice(0, 512).join("");
}
function canonicalRecord(payload) {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        return payload;
    }
    return { value: payload };
}
export function structuredResult(payload, summary, mode = "compact", isError = false) {
    const result = {
        content: [{ type: "text", text: shortSummary(summary) }],
        structuredContent: canonicalRecord(payload),
        ...(isError ? { isError: true } : {}),
    };
    if (!withinBudget(result, mode)) {
        throw new HermesError("OUTPUT_BUDGET_EXHAUSTED", "An atomic tool result exceeds the selected response budget.", false, "Request a smaller detail section or use a file-backed export.");
    }
    return result;
}
function visiblePage(page, summary) {
    return {
        content: [{ type: "text", text: shortSummary(summary) }],
        structuredContent: page,
    };
}
export function fitPage(items, mode, cursorFor, warnings = [], summary = "") {
    let accepted = [];
    const safeWarnings = [...warnings];
    for (let index = 0; index < items.length; index += 1) {
        const candidateItems = [...accepted, items[index]];
        const hasMore = index + 1 < items.length;
        const candidate = {
            schema_version: 1,
            items: candidateItems,
            has_more: hasMore,
            ...(hasMore ? { next_cursor: cursorFor(items[index], index) } : {}),
            truncated: hasMore,
            warnings: safeWarnings,
        };
        if (!withinBudget(visiblePage(candidate, summary), mode))
            break;
        accepted = candidateItems;
    }
    if (items.length > 0 && accepted.length === 0) {
        throw new HermesError("OUTPUT_BUDGET_EXHAUSTED", "The first atomic item exceeds the response budget.", false, "Request a smaller detail section.");
    }
    const hasMore = accepted.length < items.length;
    const page = {
        schema_version: 1,
        items: accepted,
        has_more: hasMore,
        ...(hasMore ? { next_cursor: cursorFor(accepted.at(-1), accepted.length - 1) } : {}),
        truncated: hasMore,
        warnings: safeWarnings,
    };
    if (!withinBudget(visiblePage(page, summary), mode)) {
        throw new HermesError("OUTPUT_BUDGET_EXHAUSTED", "Response metadata exceeds the response budget.", false, "Reduce warning or cursor metadata.");
    }
    return page;
}
