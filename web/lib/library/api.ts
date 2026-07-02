export function unwrapEnvelope<T>(payload: unknown): T {
  if (!payload || typeof payload !== "object") {
    throw new Error("API response is not an object");
  }

  const record = payload as { ok?: unknown; result?: unknown; error?: unknown };
  if (record.ok !== true) {
    throw new Error(typeof record.error === "string" ? record.error : "API request failed");
  }

  return record.result as T;
}
