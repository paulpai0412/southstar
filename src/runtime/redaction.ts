const tokenPattern = /\b(?:(?:ghp|gho|github_pat|sk|xoxb|xoxp)_[A-Za-z0-9_=-]{16,}|sk-[A-Za-z0-9_-]{16,})\b|Bearer\s+[A-Za-z0-9_./+=-]{20,}/g;
const rawLogFields = new Set(["raw_transcript", "raw_browser_trace", "terminal_log", "full_log"]);

export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(tokenPattern, "[REDACTED]") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      output[key] = normalizedKey.includes("authorization") || normalizedKey.includes("token")
        ? "[REDACTED]"
        : redactSecrets(nested);
    }
    return output as T;
  }
  return value;
}

export function compactHistoryPayload(payload: Record<string, unknown>, maxStringLength = 4000): Record<string, unknown> {
  for (const key of Object.keys(payload)) {
    if (rawLogFields.has(key)) {
      throw new Error(`${key} is not allowed in history payloads`);
    }
  }
  return truncateStrings(redactSecrets(payload), maxStringLength) as Record<string, unknown>;
}

function truncateStrings(value: unknown, maxStringLength: number): unknown {
  if (typeof value === "string") {
    if (value === "[REDACTED]") {
      return value;
    }
    return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}...[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateStrings(item, maxStringLength));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, truncateStrings(nested, maxStringLength)]));
  }
  return value;
}
