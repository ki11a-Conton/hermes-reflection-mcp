/** Locale-independent UTF-16 code-unit order for durable projections and hashes. */
export function compareStableText(left, right) {
    if (left === right)
        return 0;
    return left < right ? -1 : 1;
}
export function stableUniqueSorted(values) {
    return [...new Set(values)].sort(compareStableText);
}
export function canonicalizeStable(value) {
    if (Array.isArray(value))
        return value.map(canonicalizeStable);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => compareStableText(left, right))
            .map(([key, item]) => [key, canonicalizeStable(item)]));
    }
    return value;
}
