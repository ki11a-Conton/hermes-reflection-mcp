import { codePointLength, redactSensitiveText, truncateCodePoints } from "./redaction.js";
export const BLOCKED_HISTORICAL_INSTRUCTION = "[BLOCKED: untrusted historical instruction]";
export const HISTORICAL_PROJECTION_TRUNCATED = "[TRUNCATED: historical projection budget exhausted]";
const HISTORICAL_FENCE_TAG_RE = /\[\s*(\/?)\s*(MEMORY CONTEXT|SYSTEM INSTRUCTIONS)(?=[\s\]])[^\]\r\n]*\]/gi;
const MAX_FENCE_SCAN_CHARS = 1_000_000;
const MAX_FENCE_DEPTH = 64;
const ROLE_LINE_RE = /\b(?:system|developer|assistant)\s*:\s*[^\r\n]*/gi;
const DIRECTIVE_ACTION_RE = /\b(?:ignore|disregard|override|exfiltrat(?:e(?:s|d)?|ing)(?:-[A-Za-z0-9_-]+)*|reveal|send)\b/gi;
const PREVIOUS_INSTRUCTION_DIRECTIVE_RE = /\b(?:ignore|disregard|override)\b.{0,80}?\b(?:previous|system)\b.{0,30}?\binstructions?\b(?:\s+and\b)?/gi;
const SECRET_DISCLOSURE_RE = /\b(?:exfiltrat(?:e(?:s|d)?|ing)(?:-[A-Za-z0-9_-]+)*|reveal|send)\b.{0,40}?\b(?:secret|credential|token|key)s?\b/gi;
const CROSS_FIELD_DIRECTIVE_RE = /\b(?:ignore|disregard|override)\b.{0,120}?\b(?:previous|system)\b.{0,60}?\binstructions?\b(?:\s+and\s+(?:(?:execute|follow|run)\s+(?:the\s+)?(?:following\s+)?(?:command|instructions?|steps?|code)|(?:send|reveal|exfiltrat(?:e(?:s|d)?|ing))\s+(?:the\s+)?(?:secret|credential|token|key)s?))?/gi;
function corpusView(leaves, separator) {
    const parts = [];
    const starts = [];
    const ends = [];
    let cursor = 0;
    for (let index = 0; index < leaves.length; index += 1) {
        if (index > 0) {
            parts.push(separator);
            cursor += separator.length;
        }
        starts.push(cursor);
        parts.push(leaves[index].value);
        cursor += leaves[index].value.length;
        ends.push(cursor);
    }
    return { text: parts.join(""), starts, ends };
}
function leafAt(view, position) {
    let low = 0;
    let high = view.ends.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (position < view.ends[middle])
            high = middle;
        else
            low = middle + 1;
    }
    return low;
}
function crossLeafSpan(view, span) {
    if (span.end <= span.start || view.ends.length < 2)
        return null;
    const first = leafAt(view, span.start);
    const last = leafAt(view, Math.max(span.start, span.end - 1));
    return first < last ? { first, last } : null;
}
function splitFenceSpans(view) {
    const spans = [];
    const pattern = new RegExp(HISTORICAL_FENCE_TAG_RE.source, "gi");
    const stack = [];
    let overflowDepth = 0;
    let overflowStart = -1;
    let match;
    while ((match = pattern.exec(view.text)) !== null) {
        const tagEnd = pattern.lastIndex;
        const kind = match[2].toUpperCase();
        if (match[1] !== "/") {
            if (stack.length < MAX_FENCE_DEPTH)
                stack.push({ kind, start: match.index });
            else {
                if (overflowDepth === 0)
                    overflowStart = match.index;
                overflowDepth += 1;
            }
            continue;
        }
        if (overflowDepth > 0) {
            overflowDepth -= 1;
            if (overflowDepth === 0) {
                const overflowEnvelope = { start: overflowStart, end: tagEnd };
                if (crossLeafSpan(view, overflowEnvelope))
                    spans.push(overflowEnvelope);
            }
            continue;
        }
        let matchingDepth = -1;
        for (let index = stack.length - 1; index >= 0; index -= 1) {
            if (stack[index].kind === kind) {
                matchingDepth = index;
                break;
            }
        }
        if (matchingDepth < 0) {
            const closing = { start: match.index, end: tagEnd };
            if (crossLeafSpan(view, closing))
                spans.push(closing);
            continue;
        }
        const opening = stack[matchingDepth];
        stack.length = matchingDepth;
        const envelope = { start: opening.start, end: tagEnd };
        if (crossLeafSpan(view, envelope))
            spans.push(envelope);
    }
    for (const opening of stack.slice(0, MAX_FENCE_DEPTH)) {
        const unclosed = { start: opening.start, end: view.text.length };
        if (crossLeafSpan(view, unclosed))
            spans.push(unclosed);
    }
    if (overflowDepth > 0) {
        const unclosedOverflow = { start: overflowStart, end: view.text.length };
        if (crossLeafSpan(view, unclosedOverflow))
            spans.push(unclosedOverflow);
    }
    return spans;
}
function splitRoleDirectiveSpans(view) {
    const spans = [];
    const rolePattern = new RegExp(ROLE_LINE_RE.source, "gi");
    let roleMatch;
    while ((roleMatch = rolePattern.exec(view.text)) !== null) {
        const roleSpan = { start: roleMatch.index, end: rolePattern.lastIndex };
        if (!crossLeafSpan(view, roleSpan))
            continue;
        const colonOffset = roleMatch[0].indexOf(":");
        const contentOffset = colonOffset + 1;
        const threatSpans = [];
        for (const source of [PREVIOUS_INSTRUCTION_DIRECTIVE_RE, SECRET_DISCLOSURE_RE, DIRECTIVE_ACTION_RE]) {
            const threatPattern = new RegExp(source.source, "gi");
            let threatMatch;
            while ((threatMatch = threatPattern.exec(roleMatch[0].slice(contentOffset))) !== null) {
                threatSpans.push({
                    start: roleMatch.index + contentOffset + threatMatch.index,
                    end: roleMatch.index + contentOffset + threatPattern.lastIndex,
                });
            }
        }
        if (threatSpans.length === 0)
            continue;
        spans.push({ start: roleMatch.index, end: roleMatch.index + contentOffset }, ...threatSpans);
    }
    return spans;
}
function mergeSpans(spans) {
    const ordered = spans.filter((span) => span.end > span.start).sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const span of ordered) {
        const previous = merged.at(-1);
        if (previous && span.start <= previous.end)
            previous.end = Math.max(previous.end, span.end);
        else
            merged.push({ ...span });
    }
    return merged;
}
function replaceSpans(value, spans) {
    const merged = mergeSpans(spans);
    if (merged.length === 0)
        return { value, replacements: 0 };
    let cursor = 0;
    const output = [];
    for (const span of merged) {
        output.push(value.slice(cursor, span.start), BLOCKED_HISTORICAL_INSTRUCTION);
        cursor = span.end;
    }
    output.push(value.slice(cursor));
    return { value: output.join(""), replacements: merged.length };
}
function blockCrossFieldThreats(leaves) {
    const ranges = new Map();
    const mark = (index, span) => {
        if (span.end <= span.start)
            return;
        const current = ranges.get(index) ?? [];
        current.push(span);
        ranges.set(index, current);
    };
    for (const separator of ["", " "]) {
        const view = corpusView(leaves, separator);
        const spans = [];
        for (const pattern of [CROSS_FIELD_DIRECTIVE_RE, SECRET_DISCLOSURE_RE]) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(view.text)) !== null) {
                const span = { start: match.index, end: pattern.lastIndex };
                if (crossLeafSpan(view, span))
                    spans.push(span);
                if (match[0].length === 0)
                    pattern.lastIndex += 1;
            }
        }
        spans.push(...splitFenceSpans(view));
        if (separator === "")
            spans.push(...splitRoleDirectiveSpans(view));
        for (const span of spans) {
            if (span.end <= span.start || view.ends.length === 0)
                continue;
            const first = leafAt(view, span.start);
            const last = leafAt(view, Math.max(span.start, span.end - 1));
            for (let index = first; index <= last; index += 1) {
                mark(index, {
                    start: Math.max(span.start, view.starts[index]) - view.starts[index],
                    end: Math.min(span.end, view.ends[index]) - view.starts[index],
                });
            }
        }
    }
    let blockedCount = 0;
    const affected = [];
    for (const [index, spans] of ranges) {
        const leaf = leaves[index];
        const replaced = replaceSpans(leaf.value, spans);
        if (replaced.replacements === 0)
            continue;
        leaf.set(replaced.value);
        leaf.value = replaced.value;
        blockedCount += replaced.replacements;
        if (affected.length < 16)
            affected.push(leaf.path);
    }
    return { blockedCount, affected };
}
function blockRoleLineDirectives(value) {
    return value.replace(ROLE_LINE_RE, (line) => {
        const colon = line.indexOf(":");
        const content = line.slice(colon + 1);
        const blockedContent = content
            .replace(PREVIOUS_INSTRUCTION_DIRECTIVE_RE, `${BLOCKED_HISTORICAL_INSTRUCTION} `)
            .replace(SECRET_DISCLOSURE_RE, BLOCKED_HISTORICAL_INSTRUCTION)
            .replace(DIRECTIVE_ACTION_RE, BLOCKED_HISTORICAL_INSTRUCTION);
        if (blockedContent === content)
            return line;
        return `${BLOCKED_HISTORICAL_INSTRUCTION} ${blockedContent.trimStart()}`;
    });
}
function blockHistoricalFences(value) {
    const scanEnd = Math.min(value.length, MAX_FENCE_SCAN_CHARS);
    const scanned = value.slice(0, scanEnd);
    const output = [];
    const stack = [];
    let overflowDepth = 0;
    let cursor = 0;
    let match;
    // Never share /g lastIndex across projections. List/detail responses may
    // sanitize many records in one turn, and this boundary must be call-local.
    const pattern = new RegExp(HISTORICAL_FENCE_TAG_RE.source, "gi");
    while ((match = pattern.exec(scanned)) !== null) {
        const closing = match[1] === "/";
        const kind = match[2].toUpperCase();
        if (!closing) {
            if (stack.length === 0)
                output.push(scanned.slice(cursor, match.index));
            if (stack.length < MAX_FENCE_DEPTH)
                stack.push(kind);
            else
                overflowDepth += 1;
            continue;
        }
        if (stack.length === 0) {
            output.push(scanned.slice(cursor, match.index), BLOCKED_HISTORICAL_INSTRUCTION);
            cursor = pattern.lastIndex;
            continue;
        }
        if (overflowDepth > 0) {
            overflowDepth -= 1;
            continue;
        }
        const matchingDepth = stack.lastIndexOf(kind);
        if (matchingDepth < 0)
            continue;
        stack.length = matchingDepth;
        if (stack.length === 0) {
            output.push(BLOCKED_HISTORICAL_INSTRUCTION);
            cursor = pattern.lastIndex;
        }
    }
    if (stack.length > 0) {
        output.push(BLOCKED_HISTORICAL_INSTRUCTION);
    }
    else {
        output.push(scanned.slice(cursor));
        if (scanEnd < value.length)
            output.push(BLOCKED_HISTORICAL_INSTRUCTION);
    }
    return output.join("");
}
function occurrences(value, marker) {
    return value.split(marker).length - 1;
}
function needsStrictHistoricalUrlRedaction(value) {
    return (value.includes("//") && value.includes("@"))
        || (value.includes("=") && /[?&#;]/.test(value));
}
/**
 * The single trust boundary for persisted text before it becomes model-visible.
 * Sanitization deliberately happens before truncation so a removed hostile span
 * cannot consume the output budget and hide safe text that follows it.
 */
export function safeHistoricalText(value, field, maxChars) {
    const raw = typeof value === "string" ? value : String(value ?? "");
    let blocked = blockHistoricalFences(raw);
    // Replace only hostile spans. A safe fact later on the same line must remain
    // visible and must not lose the output budget to an earlier directive.
    blocked = blockRoleLineDirectives(blocked)
        .replace(PREVIOUS_INSTRUCTION_DIRECTIVE_RE, `${BLOCKED_HISTORICAL_INSTRUCTION} `)
        .replace(SECRET_DISCLOSURE_RE, BLOCKED_HISTORICAL_INSTRUCTION);
    const blockedCount = occurrences(blocked, BLOCKED_HISTORICAL_INSTRUCTION);
    // The strict URL regexes are intentionally skipped when their required
    // delimiters are absent. Besides being equivalent, this prevents V8's URL
    // candidate scan from becoming quadratic on very large ordinary text.
    const redacted = redactSensitiveText(blocked, {
        strictHistorical: needsStrictHistoricalUrlRedaction(blocked),
    });
    const redactedCount = redacted === blocked ? 0 : 1;
    const bounded = truncateCodePoints(redacted, Math.max(0, maxChars));
    return {
        text: bounded,
        threat: {
            blocked_instruction_count: blockedCount,
            redacted_secret_count: redactedCount,
            affected_fields: blockedCount > 0 || redactedCount > 0 ? [field].slice(0, 16) : [],
        },
        truncated: codePointLength(redacted) > Math.max(0, maxChars),
    };
}
/** Recursively projects a copy; the at-rest record is never mutated. */
export function safeHistoricalRecord(record, policy = {}) {
    const defaultMax = policy.defaultMaxChars ?? (policy.mode === "compact" ? 800 : 4_000);
    let remainingScanChars = Math.max(0, Math.min(policy.maxScanChars ?? MAX_FENCE_SCAN_CHARS, MAX_FENCE_SCAN_CHARS));
    const maxDepth = Math.max(0, policy.maxDepth ?? Number.MAX_SAFE_INTEGER);
    const maxNodes = Math.max(1, policy.maxNodes ?? Number.MAX_SAFE_INTEGER);
    let visitedNodes = 0;
    const affected = new Set();
    const truncationReasons = new Set();
    const fieldMaxByPath = new Map();
    let blockedCount = 0;
    let redactedCount = 0;
    let projectionTruncated = false;
    const noteTruncation = (path, reason) => {
        projectionTruncated = true;
        if (truncationReasons.size < 8)
            truncationReasons.add(reason);
        if (affected.size < 16)
            affected.add(path || "$record");
    };
    const exhaustedValue = (value) => {
        if (Array.isArray(value))
            return [HISTORICAL_PROJECTION_TRUNCATED];
        if (value && typeof value === "object") {
            return { historical_projection_truncated: HISTORICAL_PROJECTION_TRUNCATED };
        }
        return HISTORICAL_PROJECTION_TRUNCATED;
    };
    const visit = (value, path, field, depth) => {
        visitedNodes += 1;
        if (visitedNodes > maxNodes) {
            noteTruncation(path, "max_nodes");
            return exhaustedValue(value);
        }
        if (depth > maxDepth) {
            noteTruncation(path, "max_depth");
            return exhaustedValue(value);
        }
        if (typeof value === "string") {
            const maxChars = policy.fieldMaxChars?.[path] ?? policy.fieldMaxChars?.[field] ?? defaultMax;
            fieldMaxByPath.set(path, maxChars);
            let source = value;
            let scanTruncated = false;
            if (remainingScanChars !== Number.MAX_SAFE_INTEGER) {
                const points = [];
                for (const point of value) {
                    if (points.length >= remainingScanChars)
                        break;
                    points.push(point);
                }
                source = points.join("");
                remainingScanChars -= points.length;
                scanTruncated = points.length < codePointLength(value);
            }
            if (scanTruncated) {
                noteTruncation(path, "max_scan_chars");
                const markerLength = codePointLength(HISTORICAL_PROJECTION_TRUNCATED);
                return `${truncateCodePoints(source, Math.max(0, maxChars - markerLength))}${HISTORICAL_PROJECTION_TRUNCATED}`;
            }
            return source;
        }
        if (Array.isArray(value)) {
            const output = [];
            for (let index = 0; index < value.length; index += 1) {
                if (visitedNodes >= maxNodes) {
                    const childPath = `${path}[${index}]`;
                    noteTruncation(childPath, "max_nodes");
                    output.push(HISTORICAL_PROJECTION_TRUNCATED);
                    break;
                }
                output.push(visit(value[index], `${path}[${index}]`, field, depth + 1));
            }
            return output;
        }
        if (!value || typeof value !== "object")
            return value;
        const output = {};
        for (const [key, entry] of Object.entries(value)) {
            if (key === "historical_safety")
                continue;
            const childPath = path ? `${path}.${key}` : key;
            if (visitedNodes >= maxNodes) {
                noteTruncation(childPath, "max_nodes");
                output.historical_projection_truncated = HISTORICAL_PROJECTION_TRUNCATED;
                break;
            }
            output[key] = visit(entry, childPath, key, depth + 1);
        }
        return output;
    };
    let projected = visit(record, "", "", 0);
    if (typeof projected === "string") {
        const safe = safeHistoricalText(projected, "", fieldMaxByPath.get("") ?? defaultMax);
        projected = safe.text;
    }
    else if (projected && typeof projected === "object") {
        const leaves = [];
        const collect = (value, path) => {
            if (typeof value === "string")
                return;
            if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index += 1) {
                    const entry = value[index];
                    const childPath = `${path}[${index}]`;
                    if (typeof entry === "string" && entry !== HISTORICAL_PROJECTION_TRUNCATED) {
                        leaves.push({ path: childPath, value: entry, set: (next) => { value[index] = next; } });
                    }
                    else
                        collect(entry, childPath);
                }
                return;
            }
            if (!value || typeof value !== "object")
                return;
            for (const [key, entry] of Object.entries(value)) {
                if (key === "historical_safety" || key === "historical_projection_truncated")
                    continue;
                const childPath = path ? `${path}.${key}` : key;
                if (typeof entry === "string" && entry !== HISTORICAL_PROJECTION_TRUNCATED) {
                    leaves.push({
                        path: childPath,
                        value: entry,
                        set: (next) => { value[key] = next; },
                    });
                }
                else
                    collect(entry, childPath);
            }
        };
        collect(projected, "");
        const crossField = blockCrossFieldThreats(leaves);
        for (const path of crossField.affected)
            if (affected.size < 16)
                affected.add(path);
        for (const leaf of leaves) {
            const safe = safeHistoricalText(leaf.value, leaf.path, fieldMaxByPath.get(leaf.path) ?? defaultMax);
            leaf.set(safe.text);
            blockedCount += safe.threat.blocked_instruction_count;
            redactedCount += safe.threat.redacted_secret_count;
            if (safe.threat.affected_fields.length > 0 && affected.size < 16)
                affected.add(leaf.path);
        }
    }
    const includeMetadata = projectionTruncated
        || ((blockedCount > 0 || redactedCount > 0) && policy.includeThreatMetadata !== false);
    if (includeMetadata && projected && typeof projected === "object" && !Array.isArray(projected)) {
        projected.historical_safety = {
            blocked_instruction_count: blockedCount,
            redacted_secret_count: redactedCount,
            affected_fields: [...affected],
            ...(projectionTruncated ? {
                projection_truncated: true,
                budget_exhausted: true,
                reasons: [...truncationReasons],
            } : {}),
        };
    }
    return projected;
}
