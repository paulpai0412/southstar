import type { SouthstarDb } from "../db/postgres.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { TorkStatusCategory } from "./observability-types.ts";

export type HandExecutionTerminalStatus = "completed" | "failed" | "cancelled" | "lost";

export function canonicalHandExecutionId(runId: string, taskId: string, attemptId: string): string {
  return `hand-execution:${runId}:${taskId}:${attemptId}`;
}

export function terminalHandExecutionStatus(category: TorkStatusCategory): "failed" | "cancelled" | "lost" {
  if (category === "cancelled-like") return "cancelled";
  if (category === "completed-like") return "lost";
  return "failed";
}

export function isTerminalHandExecutionStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "lost", "superseded"].includes(status);
}

export async function settleHandExecutionPg(
  db: SouthstarDb,
  input: {
    resourceKey: string;
    runId: string;
    taskId?: string;
    sessionId?: string;
    status: HandExecutionTerminalStatus;
    terminalAt: string;
    payloadPatch?: Record<string, unknown>;
    summaryPatch?: Record<string, unknown>;
    metricsPatch?: Record<string, unknown>;
    expectedStatuses?: readonly string[];
  },
): Promise<boolean> {
  const existing = await getResourceByKeyPg(db, "hand_execution", input.resourceKey);
  if (!existing || isTerminalHandExecutionStatus(existing.status)) return false;
  if (input.expectedStatuses && !input.expectedStatuses.includes(existing.status)) return false;

  await upsertRuntimeResourcePg(db, {
    id: existing.id,
    resourceType: "hand_execution",
    resourceKey: input.resourceKey,
    runId: existing.runId ?? input.runId,
    taskId: existing.taskId ?? input.taskId,
    ...(existing.sessionId ?? input.sessionId ? { sessionId: existing.sessionId ?? input.sessionId } : {}),
    scope: existing.scope,
    status: input.status,
    title: existing.title ?? `Hand execution ${input.taskId ?? input.resourceKey}`,
    payload: {
      ...asRecord(existing.payload),
      ...input.payloadPatch,
      status: input.status,
      terminalAt: input.terminalAt,
    },
    summary: {
      ...asRecord(existing.summary),
      ...input.summaryPatch,
      status: input.status,
      terminalAt: input.terminalAt,
    },
    metrics: {
      ...asRecord(existing.metrics),
      ...input.metricsPatch,
    },
  });
  return true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
