import { Buffer } from "node:buffer";
import { HermesError } from "./errors.js";
import type { ResponseMode } from "./response_mode.js";

export const RESPONSE_LIMITS = {
  compact: { code_points: 6_000, utf8_bytes: 24 * 1024 },
  full: { code_points: 20_000, utf8_bytes: 80 * 1024 },
} as const;

export interface PageEnvelope<T> {
  schema_version: 1;
  items: T[];
  has_more: boolean;
  next_cursor?: string;
  truncated: boolean;
  warnings: string[];
}

export function modelVisibleSize(value: unknown): { code_points: number; utf8_bytes: number } {
  const serialized = JSON.stringify(value) ?? "null";
  return {
    code_points: Array.from(serialized).length,
    utf8_bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

export function withinBudget(value: unknown, mode: ResponseMode): boolean {
  const size = modelVisibleSize(value);
  const limit = RESPONSE_LIMITS[mode];
  return size.code_points <= limit.code_points && size.utf8_bytes <= limit.utf8_bytes;
}

function shortSummary(value: string): string {
  return Array.from(value).slice(0, 512).join("");
}

export interface StructuredToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

function canonicalRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { value: payload };
}

export function structuredResult(
  payload: unknown,
  summary: string,
  mode: ResponseMode = "compact",
  isError = false,
): StructuredToolResult {
  const result: StructuredToolResult = {
    content: [{ type: "text", text: shortSummary(summary) }],
    structuredContent: canonicalRecord(payload),
    ...(isError ? { isError: true } : {}),
  };
  if (!withinBudget(result, mode)) {
    throw new HermesError(
      "OUTPUT_BUDGET_EXHAUSTED",
      "An atomic tool result exceeds the selected response budget.",
      false,
      "Request a smaller detail section or use a file-backed export.",
    );
  }
  return result;
}

function visiblePage<T>(page: PageEnvelope<T>, summary: string): unknown {
  return {
    content: [{ type: "text", text: shortSummary(summary) }],
    structuredContent: page,
  };
}

export function fitPage<T>(
  items: readonly T[],
  mode: ResponseMode,
  cursorFor: (last: T, index: number) => string,
  warnings: string[] = [],
  summary = "",
): PageEnvelope<T> {
  let accepted: T[] = [];
  const safeWarnings = [...warnings];

  for (let index = 0; index < items.length; index += 1) {
    const candidateItems = [...accepted, items[index]];
    const hasMore = index + 1 < items.length;
    const candidate: PageEnvelope<T> = {
      schema_version: 1,
      items: candidateItems,
      has_more: hasMore,
      ...(hasMore ? { next_cursor: cursorFor(items[index], index) } : {}),
      truncated: hasMore,
      warnings: safeWarnings,
    };
    if (!withinBudget(visiblePage(candidate, summary), mode)) break;
    accepted = candidateItems;
  }

  if (items.length > 0 && accepted.length === 0) {
    throw new HermesError(
      "OUTPUT_BUDGET_EXHAUSTED",
      "The first atomic item exceeds the response budget.",
      false,
      "Request a smaller detail section.",
    );
  }

  const hasMore = accepted.length < items.length;
  const page: PageEnvelope<T> = {
    schema_version: 1,
    items: accepted,
    has_more: hasMore,
    ...(hasMore ? { next_cursor: cursorFor(accepted.at(-1)!, accepted.length - 1) } : {}),
    truncated: hasMore,
    warnings: safeWarnings,
  };
  if (!withinBudget(visiblePage(page, summary), mode)) {
    throw new HermesError(
      "OUTPUT_BUDGET_EXHAUSTED",
      "Response metadata exceeds the response budget.",
      false,
      "Reduce warning or cursor metadata.",
    );
  }
  return page;
}
