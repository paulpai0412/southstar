import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { ToolProxyViolationPayload, ToolProxyViolationReason } from "./types.ts";

export type CredentialLeakFinding = {
  reason: ToolProxyViolationReason;
  redactedExcerpt: string;
};

export type ToolProxyViolationInput = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  handExecutionId?: string;
  severity: "blocking" | "warning";
  reason: ToolProxyViolationReason;
  evidenceRef: string;
  redactedExcerpt?: string;
};

export type RawCredentialAssertionInput = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  handExecutionId?: string;
  evidenceRef: string;
  value: unknown;
};

const SENSITIVE_KEY_PATTERN = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|API[_-]?KEY)/i;
const SENSITIVE_KEY_JSON_PATTERN = /"[^"]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|API[_-]?KEY)[^"]*"\s*:/i;
const COMMON_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/;
const COMMON_TOKEN_REDACTION_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g;

export function scanForCredentialLeak(value: unknown): CredentialLeakFinding | null {
  const text = stringifyForScanning(value);
  if (!text) return null;
  if (SENSITIVE_KEY_JSON_PATTERN.test(text) || COMMON_TOKEN_PATTERN.test(text)) {
    return {
      reason: "raw_credential_in_envelope",
      redactedExcerpt: redactText(text),
    };
  }
  return null;
}

export async function assertNoRawCredentialPayloadPg(db: SouthstarDb, input: RawCredentialAssertionInput): Promise<void> {
  const finding = scanForCredentialLeak(input.value);
  if (!finding) return;
  await createToolProxyViolationPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    handExecutionId: input.handExecutionId,
    severity: "blocking",
    reason: "callback_payload_leak",
    evidenceRef: input.evidenceRef,
    redactedExcerpt: finding.redactedExcerpt,
  });
  throw new Error(`raw credential detected in ${input.evidenceRef}`);
}

export async function createToolProxyViolationPg(db: SouthstarDb, input: ToolProxyViolationInput): Promise<{ id: string }> {
  const id = violationResourceId(input);
  const now = new Date().toISOString();
  const payload: ToolProxyViolationPayload = {
    schemaVersion: "southstar.tool_proxy_violation.v1",
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    handExecutionId: input.handExecutionId,
    severity: input.severity,
    reason: input.reason,
    evidenceRef: input.evidenceRef,
    redactedExcerpt: input.redactedExcerpt,
    detectedAt: now,
  };

  await upsertRuntimeResourcePg(db, {
    id,
    resourceType: "tool_proxy_violation",
    resourceKey: id,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "security",
    status: input.severity,
    title: `Tool proxy violation ${input.reason}`,
    payload,
    summary: { reason: input.reason, severity: input.severity },
    metrics: {},
  });
  await appendViolationHistoryOncePg(db, input.runId, id, input.taskId, input.sessionId, payload);
  return { id };
}

async function appendViolationHistoryOncePg(
  db: SouthstarDb,
  runId: string,
  violationId: string,
  taskId: string | undefined,
  sessionId: string | undefined,
  payload: ToolProxyViolationPayload,
): Promise<void> {
  const idempotencyKey = `${violationId}:history`;
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [runId, idempotencyKey],
  );
  if (existing) return;
  await appendHistoryEventPg(db, {
    runId,
    taskId,
    sessionId,
    eventType: "tool_proxy.violation",
    actorType: "tool-proxy",
    idempotencyKey,
    payload,
  });
}

function violationResourceId(input: ToolProxyViolationInput): string {
  const fingerprint = createHash("sha256")
    .update(stableStringify({
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      handExecutionId: input.handExecutionId,
      reason: input.reason,
      evidenceRef: input.evidenceRef,
    }))
    .digest("hex")
    .slice(0, 24);
  return `tool-proxy-violation:${input.runId}:${fingerprint}`;
}

function stringifyForScanning(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return stableStringify(value);
  }
}

function redactText(value: string): string {
  return value
    .replace(COMMON_TOKEN_REDACTION_PATTERN, "[REDACTED]")
    .replace(
      /("[^"]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|API[_-]?KEY)[^"]*"\s*:\s*)"[^"]*"/gi,
      "$1\"[REDACTED]\"",
    )
    .replace(
      /("[^"]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|API[_-]?KEY)[^"]*"\s*:\s*)([^,}\]]+)/gi,
      "$1\"[REDACTED]\"",
    )
    .slice(0, 500);
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  if (typeof value === "object") {
    if (seen.has(value)) return "\"[Circular]\"";
    seen.add(value);
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function isSensitivePolicyKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
