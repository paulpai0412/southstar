// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import type { SouthstarDb } from "../stores/sqlite.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";

export type StopConditionInput = {
  runId: string;
  stopConditionId: string;
  requiredEvaluatorPipelineIds: string[];
};

export type StopConditionResult = {
  ok: boolean;
  missingEvaluatorPipelineIds: string[];
  recoveredEvaluatorPipelineIds: string[];
};

export function evaluateStopCondition(db: SouthstarDb, input: StopConditionInput): StopConditionResult {
  const rows = db.prepare(`
    select task_id, status, payload_json, updated_at from runtime_resources
    where run_id = ? and resource_type = 'evaluator_pipeline_result'
    order by updated_at desc
  `).all(input.runId) as Array<{ task_id: string | null; status: string; payload_json: string; updated_at: string }>;

  const eventsByPipeline = new Map<string, Array<{
    status: string;
    taskId?: string;
    recoveryStrategy?: string;
    updatedAt: string;
  }>>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as { pipelineId?: string; recoveryStrategy?: string };
    if (!payload.pipelineId) continue;
    const bucket = eventsByPipeline.get(payload.pipelineId) ?? [];
    bucket.push({
      status: row.status,
      taskId: row.task_id ?? undefined,
      recoveryStrategy: payload.recoveryStrategy,
      updatedAt: row.updated_at,
    });
    eventsByPipeline.set(payload.pipelineId, bucket);
  }

  const passed = new Set<string>();
  const recovered = new Set<string>();
  for (const [pipelineId, events] of eventsByPipeline.entries()) {
    const latestStatus = events[0]?.status;
    if (latestStatus !== "passed") continue;
    passed.add(pipelineId);
    if (pipelineRecoveredByDecisionAndRerun(db, input.runId, events)) {
      recovered.add(pipelineId);
    }
  }

  const missingEvaluatorPipelineIds = input.requiredEvaluatorPipelineIds
    .filter((id) => !passed.has(id));
  const result = {
    ok: missingEvaluatorPipelineIds.length === 0,
    missingEvaluatorPipelineIds,
    recoveredEvaluatorPipelineIds: [...recovered].sort(),
  };
  upsertRuntimeResource(db, {
    resourceType: "stop_condition_result",
    resourceKey: `stop-${input.runId}-${input.stopConditionId}`,
    runId: input.runId,
    scope: "software",
    status: result.ok ? "passed" : "blocked",
    title: input.stopConditionId,
    payload: result,
  });
  return result;
}

function pipelineRecoveredByDecisionAndRerun(
  db: SouthstarDb,
  runId: string,
  events: Array<{ status: string; taskId?: string; recoveryStrategy?: string; updatedAt: string }>,
): boolean {
  const passedAt = events.find((event) => event.status === "passed")?.updatedAt;
  if (!passedAt) return false;

  const failedCandidates = events
    .filter((event) => event.status === "failed" && event.taskId && event.recoveryStrategy)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

  for (const failed of failedCandidates) {
    if (failed.updatedAt >= passedAt) continue;
    if (!failed.taskId || !failed.recoveryStrategy) continue;
    if (pipelineRecoveredByDecision(db, runId, failed.taskId, failed.recoveryStrategy, failed.updatedAt)) {
      return true;
    }
  }
  return false;
}

function pipelineRecoveredByDecision(
  db: SouthstarDb,
  runId: string,
  taskId: string,
  strategy: string,
  afterUpdatedAt: string,
): boolean {
  const decisionRows = db.prepare(`
    select payload_json, updated_at from runtime_resources
    where run_id = ? and task_id = ? and resource_type = 'recovery_decision'
  `).all(runId, taskId) as Array<{ payload_json: string; updated_at: string }>;
  const strategyMatched = decisionRows.some((row) => {
    if (row.updated_at < afterUpdatedAt) return false;
    const payload = JSON.parse(row.payload_json) as {
      strategy?: string;
      selectedStrategy?: string;
      requestedStrategy?: string;
    };
    return payload.strategy === strategy || payload.selectedStrategy === strategy || payload.requestedStrategy === strategy;
  });
  if (!strategyMatched) return false;

  const operationType = operationTypeForStrategy(strategy);
  if (!operationType) return true;
  const operationRows = db.prepare(`
    select payload_json, status, updated_at from runtime_resources
    where run_id = ? and task_id = ? and resource_type = 'session_operation'
  `).all(runId, taskId) as Array<{ payload_json: string; status: string; updated_at: string }>;
  return operationRows.some((row) => {
    if (row.updated_at < afterUpdatedAt) return false;
    if (!["succeeded", "fallback-used"].includes(row.status)) return false;
    const payload = JSON.parse(row.payload_json) as { type?: string; status?: string };
    return payload.type === operationType;
  });
}

function operationTypeForStrategy(strategy: string): string | undefined {
  if (strategy === "fork-from-checkpoint") return "fork";
  if (strategy === "retry-same-agent" || strategy === "reset-from-checkpoint") return "reset";
  if (strategy === "rollback-workspace") return "replay";
  if (strategy === "host-native-rewind") return "rewind";
  return undefined;
}
