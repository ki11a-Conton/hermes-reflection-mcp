/** Locale-independent UTF-16 code-unit order for durable projections and hashes. */
export function compareStableText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function stableUniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStableText);
}

export function canonicalizeStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeStable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([key, item]) => [key, canonicalizeStable(item)]));
  }
  return value;
}
