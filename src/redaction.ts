const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/gi;
const PROVIDER_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_.-]{8,})\b/g;
const SECRET_ASSIGNMENT_RE = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\b\s*[:=]\s*["']?[^\s,"']{8,}["']?/gi;
const CREDENTIAL_URI_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@:]+:[^\s\/@]+@/gi;
const WINDOWS_USER_RE = /\b[A-Za-z]:\\Users\\[^\\\s]+/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]")
    .replace(PROVIDER_TOKEN_RE, "[REDACTED TOKEN]")
    .replace(SECRET_ASSIGNMENT_RE, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(CREDENTIAL_URI_RE, "$1[REDACTED]@")
    .replace(WINDOWS_USER_RE, "C:\\Users\\<USER>");
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
