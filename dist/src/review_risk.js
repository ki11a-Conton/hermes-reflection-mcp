/** Shared, deliberately narrow semantic risk classifier for review candidates. */
export function semanticReviewRiskReasons(value) {
    const risks = [];
    const checks = [
        [/\b(?:api[ _-]?key|token|password|secret|credential)s?\b|凭据|密钥|密码/i, "secret_or_credential"],
        [/\b(?:delete|remove|erase|clear|drop|purge)\b|删除|清除/i, "deletion"],
        [/\b(?:overwrite|replace existing|truncate)\b|覆盖/i, "overwrite"],
        [/\b(?:identity|impersonat|user profile|memory board)\b|身份/i, "identity_change"],
        [/\b(?:permission|privilege|administrator|sudo|chmod)\b|权限/i, "permission_change"],
    ];
    for (const [pattern, reason] of checks)
        if (pattern.test(value))
            risks.push(reason);
    const transientOrEnvironmental = /\b(?:auth(?:entication|orization)?\s+(?:failed|failure|error)|network\s+(?:error|failure|timeout)|(?:temporary|transient)\s+(?:error|failure|issue)|quota\s+(?:was\s+)?(?:exceeded|exhausted)|rate\s+limit(?:ed|ing)?|(?:package|dependency|tool)\s+(?:was\s+)?not\s+installed|missing\s+(?:package|dependency)|(?:install(?:ation)?|environment|configuration)\s+(?:error|failure|issue))\b/i.test(value);
    const permanentProhibition = /\b(?:never\s+(?:use|trust|call)|always\s+avoid|disable\b.{0,80}\bpermanently|(?:tool\s+)?[\p{L}\p{N}._-]+\s+never\s+works|permanently\s+(?:avoid|disable))\b/iu.test(value);
    if (transientOrEnvironmental && permanentProhibition) {
        risks.push("transient_or_environmental_failure");
        if (/\b(?:tool|command|api|provider)\b/i.test(value))
            risks.push("unverified_tool_negation");
        if (/\b(?:once|one[- ]time|temporary|transient)\b/i.test(value))
            risks.push("single_event_overgeneralization");
    }
    return [...new Set(risks)];
}
