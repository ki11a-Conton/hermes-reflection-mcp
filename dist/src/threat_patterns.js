/**
 * Threat Patterns Library
 *
 * Comprehensive threat-pattern detection for prompt injection,
 * C2/Brainworm promptware, exfiltration, and Unicode attacks.
 *
 * Based on Hermes Agent official implementation (tools/threat_patterns.py)
 *
 * Pattern Philosophy:
 * - Patterns organized by ATTACK CLASS, not source
 * - Each pattern has (regex, id, scope)
 * - Scope controls which scanners use it:
 *   - "all": everywhere (classic injection, exfiltration)
 *   - "context": context files + memory + tool results
 *   - "strict": memory writes + skill installs only
 */
// Hard cap on scanned text to prevent ReDoS attacks
export const MAX_SCAN_CHARS = 65536;
// Bounded filler to prevent regex backtracking
const FILLER = String.raw `(?:\w+\s+){0,8}`;
/**
 * Comprehensive threat pattern library (45+ patterns)
 */
export const THREAT_PATTERNS = [
    // ── Classic prompt injection (applies everywhere) ────────────────
    { regex: new RegExp(`ignore\\s+${FILLER}(previous|all|above|prior)\\s+${FILLER}instructions`, "i"),
        id: "prompt_injection", scope: "all" },
    { regex: /system\s+prompt\s+override/i,
        id: "sys_prompt_override", scope: "all" },
    { regex: new RegExp(`disregard\\s+${FILLER}(your|all|any)\\s+${FILLER}(instructions|rules|guidelines)`, "i"),
        id: "disregard_rules", scope: "all" },
    { regex: new RegExp(`act\\s+as\\s+(if|though)\\s+${FILLER}you\\s+${FILLER}(have\\s+no|don't\\s+have)\\s+${FILLER}(restrictions|limits|rules)`, "i"),
        id: "bypass_restrictions", scope: "all" },
    { regex: /<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i,
        id: "html_comment_injection", scope: "all" },
    { regex: /<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none/i,
        id: "hidden_div", scope: "all" },
    { regex: /translate\s+[^\n]{0,512}\s+into\s+[^\n]{0,512}\s+and\s+(execute|run|eval)/i,
        id: "translate_execute", scope: "all" },
    { regex: new RegExp(`do\\s+not\\s+${FILLER}tell\\s+${FILLER}the\\s+user`, "i"),
        id: "deception_hide", scope: "all" },
    // ── Role-play / identity hijack (context + strict) ────────────────
    { regex: new RegExp(`you\\s+are\\s+${FILLER}now\\s+(?:a|an|the)\\s+`, "i"),
        id: "role_hijack", scope: "context" },
    { regex: new RegExp(`pretend\\s+${FILLER}(you\\s+are|to\\s+be)\\s+`, "i"),
        id: "role_pretend", scope: "context" },
    { regex: new RegExp(`output\\s+${FILLER}(system|initial)\\s+prompt`, "i"),
        id: "leak_system_prompt", scope: "context" },
    { regex: new RegExp(`(respond|answer|reply)\\s+without\\s+${FILLER}(restrictions|limitations|filters|safety)`, "i"),
        id: "remove_filters", scope: "context" },
    { regex: new RegExp(`you\\s+have\\s+been\\s+${FILLER}(updated|upgraded|patched)\\s+to`, "i"),
        id: "fake_update", scope: "context" },
    { regex: /\bname\s+yourself\s+\w+/i,
        id: "identity_override", scope: "context" },
    // ── C2 / Brainworm promptware (context scope) ─────────────────────
    { regex: /register\s+(as\s+)?a?\s*node/i,
        id: "c2_node_registration", scope: "context" },
    { regex: /(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+/i,
        id: "c2_heartbeat", scope: "context" },
    { regex: /pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b/i,
        id: "c2_task_pull", scope: "context" },
    { regex: /connect\s+to\s+the\s+network\b/i,
        id: "c2_network_connect", scope: "context" },
    { regex: /you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b/i,
        id: "forced_action", scope: "context" },
    { regex: /only\s+use\s+one[\s\-]?liners?\b/i,
        id: "anti_forensic_oneliner", scope: "context" },
    { regex: new RegExp(`never\\s+${FILLER}(?:create|write)\\s+${FILLER}(?:script|file)\\s+${FILLER}disk`, "i"),
        id: "anti_forensic_disk", scope: "context" },
    { regex: /unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\w*/i,
        id: "env_var_unset_agent", scope: "context" },
    // ── Known C2 framework names (context scope) ──────────────────────
    { regex: /\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b/i,
        id: "known_c2_framework", scope: "context" },
    { regex: /\bc2\s+(?:server|channel|infrastructure|beacon)\b/i,
        id: "c2_explicit", scope: "context" },
    { regex: /\bcommand\s+and\s+control\b/i,
        id: "c2_explicit_long", scope: "context" },
    // ── Exfiltration (applies everywhere) ─────────────────────────────
    { regex: /curl\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
        id: "exfil_curl", scope: "all" },
    { regex: /wget\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
        id: "exfil_wget", scope: "all" },
    { regex: /cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
        id: "read_secrets", scope: "all" },
    { regex: /(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?:\/\//i,
        id: "send_to_url", scope: "strict" },
    { regex: new RegExp(`(include|output|print|share)\\s+${FILLER}(conversation|chat\\s+history|previous\\s+messages|full\\s+context|entire\\s+context)`, "i"),
        id: "context_exfil", scope: "strict" },
    // ── Persistence / backdoor (strict scope) ─────────────────────────
    { regex: /authorized_keys/i,
        id: "ssh_backdoor", scope: "strict" },
    { regex: /\$HOME\/\.ssh|~\/\.ssh/i,
        id: "ssh_access", scope: "strict" },
    { regex: /\$HOME\/\.hermes\/\.env|~\/\.hermes\/\.env/i,
        id: "hermes_env", scope: "strict" },
    { regex: /(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)/i,
        id: "agent_config_mod", scope: "strict" },
    { regex: /(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}\.hermes\/(config\.yaml|SOUL\.md)/i,
        id: "hermes_config_mod", scope: "strict" },
    // ── Hardcoded secrets ──────────────────────────────────────────────
    { regex: /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}/i,
        id: "hardcoded_secret", scope: "strict" },
];
/**
 * Invisible / bidirectional Unicode characters used in injection attacks.
 */
export const INVISIBLE_CHARS = new Set([
    '\u200b', // zero-width space
    '\u200c', // zero-width non-joiner
    '\u200d', // zero-width joiner
    '\u2060', // word joiner
    '\u2062', // invisible times
    '\u2063', // invisible separator
    '\u2064', // invisible plus
    '\ufeff', // BOM
    '\u202a', // left-to-right embedding
    '\u202b', // right-to-left embedding
    '\u202c', // pop directional formatting
    '\u202d', // left-to-right override
    '\u202e', // right-to-left override
    '\u2066', // left-to-right isolate
    '\u2067', // right-to-left isolate
    '\u2068', // first strong isolate
    '\u2069', // pop directional isolate
]);
/**
 * Check if text contains invisible Unicode characters.
 */
export function containsInvisibleChars(text) {
    for (const char of text) {
        if (INVISIBLE_CHARS.has(char)) {
            return true;
        }
    }
    return false;
}
/**
 * Scan text for threat patterns at the specified scope.
 *
 * @param text - Text to scan
 * @param scope - Scope level ("all", "context", or "strict")
 * @returns Array of matched pattern IDs
 */
export function scanForThreats(text, scope) {
    if (!text)
        return [];
    const truncated = text.slice(0, MAX_SCAN_CHARS);
    const findings = [];
    for (const char of new Set(truncated)) {
        if (INVISIBLE_CHARS.has(char)) {
            findings.push(`invisible_unicode_U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
        }
    }
    const normalized = truncated.normalize("NFKC");
    for (const pattern of THREAT_PATTERNS) {
        // Pattern applies if:
        // - Pattern scope is "all" (always applies), OR
        // - Requested scope matches pattern scope, OR
        // - Requested scope is stricter than pattern scope
        const applies = (pattern.scope === "all" ||
            pattern.scope === scope ||
            (scope === "strict" && pattern.scope === "context"));
        if (applies && pattern.regex.test(normalized)) {
            findings.push(pattern.id);
        }
    }
    return findings;
}
/**
 * Get first threat message for display.
 * Returns null if no threats found.
 */
export function firstThreatMessage(text, scope) {
    const threats = scanForThreats(text, scope);
    if (threats.length === 0) {
        return null;
    }
    if (threats[0].startsWith("invisible_unicode_")) {
        return `Content blocked: contains invisible Unicode character ${threats[0].replace("invisible_unicode_", "")} (possible injection).`;
    }
    return (`Content blocked: detected threat pattern(s): ${threats.join(", ")}. ` +
        `This content cannot be stored as it may contain prompt injection, ` +
        `exfiltration attempts, or C2 instructions.`);
}
