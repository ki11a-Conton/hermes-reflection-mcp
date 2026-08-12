import { createHash } from "node:crypto";
import {
  codePointLength,
  redactSensitiveText,
  truncateCodePoints,
} from "./redaction.js";
import { scanForThreats } from "./threat_patterns.js";

export const MAX_CAPTURE_CODE_POINTS = 12_000;

export interface PreparedTurnContent {
  content: string;
  content_hash: string;
  original_code_points: number;
  content_truncated: boolean;
  content_blocked: boolean;
}

function normalizedTurnContent(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function codexTurnCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env.HERMES_REFLECTION_CODEX_TURN_CAPTURE?.trim() ?? "");
}

export function prepareTurnContent(raw: string): PreparedTurnContent {
  const normalized = normalizedTurnContent(raw);
  const originalCodePoints = codePointLength(normalized);
  const bounded = truncateCodePoints(normalized, MAX_CAPTURE_CODE_POINTS);
  const redacted = redactSensitiveText(bounded, { strictHistorical: true });
  // Identity must cover only the bounded, safe projection that can be stored.
  // Hashing the original would retain a durable derivative of discarded tails
  // and make semantically identical retries conflict after truncation/redaction.
  const contentHash = sha256(redacted);
  const blocked = scanForThreats(redacted, "strict").length > 0;
  return {
    content: blocked ? `[BLOCKED_UNSAFE_CAPTURE sha256:${contentHash}]` : redacted,
    content_hash: contentHash,
    original_code_points: originalCodePoints,
    content_truncated: originalCodePoints > MAX_CAPTURE_CODE_POINTS,
    content_blocked: blocked,
  };
}
