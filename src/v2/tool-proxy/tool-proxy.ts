import { createHash, randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { ToolHandler, ToolProxy, ToolProxyCallInput, ToolProxyResult, Vault } from "./types.ts";

export function createToolProxy(
  db: SouthstarDb,
  deps: { vault: Pick<Vault, "getLease">; handlers?: Record<string, ToolHandler> },
): ToolProxy {
  return {
    execute: (input) => executeTool(db, deps, input),
  };
}

export async function executeTool(
  db: SouthstarDb,
  deps: { vault: Pick<Vault, "getLease">; handlers?: Record<string, ToolHandler> },
  input: ToolProxyCallInput,
): Promise<ToolProxyResult> {
  const lease = await deps.vault.getLease(input.leaseId);
  if (!lease) throw new Error(`vault lease not found or inactive: ${input.leaseId}`);
  if (lease.runId !== input.runId) throw new Error(`vault lease run mismatch: ${input.leaseId}`);
  if (lease.sessionId !== input.sessionId) throw new Error(`vault lease session mismatch: ${input.leaseId}`);
  if (!lease.allowedTools.includes(input.toolName)) throw new Error(`tool is not allowed by lease: ${input.toolName}`);
  const expiresAtMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw new Error(`vault lease expired or invalid: ${input.leaseId}`);

  const handler = deps.handlers?.[input.toolName];
  if (!handler) throw new Error(`tool proxy handler is not configured: ${input.toolName}`);
  const rawResult = await handler(input.input, { lease, toolName: input.toolName });
  const redactionDigests = lease.secretDigest ? [lease.secretDigest] : [];
  const redactedInput = redact(input.input, redactionDigests);
  const redactedResult = redact(rawResult, redactionDigests);
  const inputSummary = summarizeValue(redactedInput);
  const resultSummary = summarizeValue(redactedResult);
  const callId = randomUUID();
  const result: ToolProxyResult = {
    ok: true,
    output: `tool ${input.toolName} executed with vault lease ${lease.id}`,
    summary: {
      callId,
      leaseId: lease.id,
      toolName: input.toolName,
      secretRef: lease.secretRef,
      inputKeys: Object.keys(input.input),
      result: resultSummary,
    },
  };

  await db.tx(async (tx) => {
    await upsertRuntimeResourcePg(tx, {
      id: callId,
      resourceType: "tool_proxy_call",
      resourceKey: callId,
      runId: lease.runId,
      sessionId: lease.sessionId,
      scope: "task",
      status: "completed",
      title: `Tool proxy call ${input.toolName}`,
      payload: {
        callId,
        leaseId: lease.id,
        toolName: input.toolName,
        input: inputSummary,
        result,
      },
      summary: result.summary,
    });
    await appendHistoryEventPg(tx, {
      runId: lease.runId,
      sessionId: lease.sessionId,
      eventType: "tool_proxy.called",
      actorType: "tool-proxy",
      payload: {
        callId,
        leaseId: lease.id,
        toolName: input.toolName,
        ok: result.ok,
        secretRef: lease.secretRef,
      },
    });
  });

  return result;
}

export function redact(value: unknown, secretDigests: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, secretDigests));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : redact(child, secretDigests),
      ]),
    );
  }
  if (typeof value === "string" && (matchesKnownSecretDigest(value, secretDigests) || isSensitiveString(value))) return "[REDACTED]";
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /secret|token|password|credential|authorization|api[_-]?key/i.test(key);
}

function isSensitiveString(value: string): boolean {
  return /\b(secret|token|password|credential|authorization|api[_-]?key)\b/i.test(value)
    || /\b(ghp|gho|ghu|ghs|ghr|sk)-?[A-Za-z0-9_]{16,}\b/.test(value);
}

function matchesKnownSecretDigest(value: string, secretDigests: string[]): boolean {
  if (secretDigests.length === 0) return false;
  const digest = createHash("sha256").update(value).digest("hex");
  return secretDigests.includes(digest);
}

function summarizeValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value && typeof value === "object") return { type: "object", keys: Object.keys(value).sort() };
  return { type: typeof value };
}
