import type { SouthstarDb } from "../db/postgres.ts";
import {
  appendHistoryEventOncePg,
  getResourceByKeyPg,
  updateWorkflowRunStatusPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";

export type GoalOutcomeStatus = "satisfied" | "unsatisfied" | "blocked";

export type GoalOutcomePayloadV1 = {
  schemaVersion: "southstar.goal_outcome.v1";
  outcomeStatus: GoalOutcomeStatus;
  coveredRequirementIds: string[];
  failedRequirementIds: string[];
  findings: string[];
};

export async function persistTerminalGoalOutcomePg(
  db: SouthstarDb,
  input: {
    runId: string;
    outcomeStatus: GoalOutcomeStatus;
    coveredRequirementIds?: string[];
    failedRequirementIds?: string[];
    findings?: string[];
    mergeExisting?: boolean;
    actorType: string;
    idempotencyKey: string;
  },
): Promise<GoalOutcomePayloadV1> {
  const existing = input.mergeExisting
    ? await getResourceByKeyPg(db, "goal_outcome", `goal-outcome:${input.runId}`)
    : undefined;
  const previous = asRecord(existing?.payload);
  const failedRequirementIds = unique([
    ...(input.mergeExisting ? stringArray(previous.failedRequirementIds) : []),
    ...(input.failedRequirementIds ?? []),
  ]).sort();
  const payload: GoalOutcomePayloadV1 = {
    schemaVersion: "southstar.goal_outcome.v1",
    outcomeStatus: input.outcomeStatus,
    coveredRequirementIds: unique([
      ...(input.mergeExisting ? stringArray(previous.coveredRequirementIds) : []),
      ...(input.coveredRequirementIds ?? []),
    ]).filter((id) => !failedRequirementIds.includes(id)).sort(),
    failedRequirementIds,
    findings: unique([
      ...(input.mergeExisting ? stringArray(previous.findings) : []),
      ...(input.findings ?? []),
    ]),
  };
  await upsertRuntimeResourcePg(db, {
    id: `goal-outcome:${input.runId}`,
    resourceType: "goal_outcome",
    resourceKey: `goal-outcome:${input.runId}`,
    runId: input.runId,
    scope: "outcome",
    status: input.outcomeStatus,
    title: `Goal outcome ${input.runId}`,
    payload,
    summary: {
      covered: payload.coveredRequirementIds.length,
      failed: payload.failedRequirementIds.length,
    },
  });
  await updateWorkflowRunStatusPg(db, input.runId, "completed");
  await appendHistoryEventOncePg(db, {
    runId: input.runId,
    eventType: "run.completed",
    actorType: input.actorType,
    idempotencyKey: input.idempotencyKey,
    payload,
  });
  return payload;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
