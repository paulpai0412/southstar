import { createHash, randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
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

const COMMON_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/;
const COMMON_TOKEN_REDACTION_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g;

export function scanForCredentialLeak(value: unknown): CredentialLeakFinding | null {
  const redacted = redactSensitiveSubtrees(value);
  const text = stringifyForScanning(redacted.value);
  if (!text) return null;
  if (redacted.foundSensitiveKey || COMMON_TOKEN_PATTERN.test(text)) {
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

  await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    await upsertRuntimeResourcePg(tx, {
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
    await appendViolationHistoryOncePg(tx, input.runId, id, input.taskId, input.sessionId, payload);
  });
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
  await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [runId]);
    await tx.query(
      `insert into southstar.workflow_history (
        id, run_id, task_id, sequence, event_type, actor_type, session_id,
        idempotency_key, correlation_id, causation_id, payload_json, created_at
      ) values (
        $1, $2, $3,
        (select coalesce(max(sequence), 0) + 1 from southstar.workflow_history where run_id = $2),
        $4, $5, $6, $7, null, null, $8::jsonb, $9
      )
      on conflict (run_id, idempotency_key) where idempotency_key is not null do nothing`,
      [
        randomUUID(),
        runId,
        taskId ?? null,
        "tool_proxy.violation",
        "tool-proxy",
        sessionId ?? null,
        idempotencyKey,
        JSON.stringify(payload),
        new Date().toISOString(),
      ],
    );
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

function redactSensitiveSubtrees(value: unknown, seen = new WeakSet<object>()): { value: unknown; foundSensitiveKey: boolean } {
  if (value === null) return { value: null, foundSensitiveKey: false };
  if (typeof value === "string" && credentialBearingUrl(value)) {
    return { value: "[REDACTED_URL]", foundSensitiveKey: true };
  }
  if (typeof value !== "object") return { value, foundSensitiveKey: false };
  if (seen.has(value)) return { value: "[Circular]", foundSensitiveKey: false };
  seen.add(value);

  if (Array.isArray(value)) {
    let foundSensitiveKey = false;
    const redacted = value.map((item) => {
      const child = redactSensitiveSubtrees(item, seen);
      foundSensitiveKey ||= child.foundSensitiveKey;
      return child.value;
    });
    return { value: redacted, foundSensitiveKey };
  }

  const redacted: Record<string, unknown> = {};
  let foundSensitiveKey = false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitivePolicyKey(key)) {
      redacted[key] = "[REDACTED]";
      foundSensitiveKey = true;
      continue;
    }
    const redactedChild = redactSensitiveSubtrees(child, seen);
    redacted[key] = redactedChild.value;
    foundSensitiveKey ||= redactedChild.foundSensitiveKey;
  }
  return { value: redacted, foundSensitiveKey };
}

function credentialBearingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password || [...url.searchParams.keys()].some(isSensitivePolicyKey));
  } catch {
    return false;
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
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
  const parts = normalized.split(/[^A-Z0-9]+/).filter(Boolean);
  const joined = parts.join("_");
  return parts.includes("TOKEN")
    || parts.includes("SECRET")
    || parts.includes("SECRETS")
    || parts.includes("PASSWORD")
    || parts.includes("CREDENTIAL")
    || parts.includes("CREDENTIALS")
    || parts.includes("AUTHORIZATION")
    || joined.includes("API_KEY")
    || joined.includes("APIKEY");
}
