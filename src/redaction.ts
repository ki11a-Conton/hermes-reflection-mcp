const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/gi;
const PROVIDER_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_.-]{8,})\b/g;
const SECRET_ASSIGNMENT_RE = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\b\s*[:=]\s*["']?[^\s,"']{8,}["']?/gi;
const CREDENTIAL_URI_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@:]+:[^\s\/@]+@/gi;
const WINDOWS_USER_RE = /\b[A-Za-z]:\\Users\\[^\\\s]+/gi;

export interface RedactionOptions {
  strictHistorical?: boolean;
}

const STRICT_URL_PARAM_NAMES = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "api_key",
  "apikey",
  "client_secret",
  "password",
  "auth",
  "jwt",
  "session",
  "secret",
  "key",
  "code",
  "signature",
  "x_amz_signature",
]);
const STRICT_URL_USERINFO_RE = /((?:[a-z][a-z0-9+.-]*:)?\/\/)[^\s/?#@]+@/gi;
const STRICT_URL_PARAM_RE = /([?&#;])([^?&#;=\s]+)=([^?&#;\s]*)/g;
// Keep strict URL values shorter than SECRET_ASSIGNMENT_RE's minimum while
// compatibility redaction runs, then replace the sentinel with the public
// fixed marker. This preserves following public URL parameters.
const STRICT_URL_VALUE_SENTINEL = "\uE000\uE001,";

function normalizedUrlParameterName(rawName: string): string {
  let decoded = rawName.replace(/\+/g, " ");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded.toLowerCase().replace(/-/g, "_");
}

function redactStrictUrlCredentials(value: string): string {
  return value
    .replace(STRICT_URL_USERINFO_RE, "$1[REDACTED]@")
    .replace(STRICT_URL_PARAM_RE, (match, separator: string, name: string) =>
      STRICT_URL_PARAM_NAMES.has(normalizedUrlParameterName(name))
        ? `${separator}${name}=${STRICT_URL_VALUE_SENTINEL}`
        : match);
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function truncateCodePoints(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const points = Array.from(value);
  if (points.length <= maxChars) return value;
  if (maxChars <= 3) return points.slice(0, maxChars).join("");
  return `${points.slice(0, maxChars - 3).join("")}...`;
}

export function redactSensitiveText(value: string, options: RedactionOptions = {}): string {
  const input = options.strictHistorical ? redactStrictUrlCredentials(value) : value;
  const compatible = input
    .replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]")
    .replace(PROVIDER_TOKEN_RE, "[REDACTED TOKEN]")
    .replace(SECRET_ASSIGNMENT_RE, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(CREDENTIAL_URI_RE, "$1[REDACTED]@")
    .replace(WINDOWS_USER_RE, "C:\\Users\\<USER>");
  return options.strictHistorical
    ? compatible.replaceAll(STRICT_URL_VALUE_SENTINEL, "[REDACTED]")
    : compatible;
}

export function safeJsonPreview(value: unknown, maxChars = 500): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "undefined";
  } catch {
    serialized = "[unserializable payload]";
  }
  const safe = redactSensitiveText(serialized);
  return safe.length > maxChars ? `${safe.slice(0, Math.max(0, maxChars - 3))}...` : safe;
}
