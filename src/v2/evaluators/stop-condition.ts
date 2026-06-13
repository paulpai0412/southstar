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
};

export function evaluateStopCondition(db: SouthstarDb, input: StopConditionInput): StopConditionResult {
  const rows = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and resource_type = 'evaluator_pipeline_result' and status = 'passed'
  `).all(input.runId) as Array<{ payload_json: string }>;
  const passed = new Set(rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as { pipelineId?: string };
    return payload.pipelineId;
  }).filter((pipelineId): pipelineId is string => Boolean(pipelineId)));
  const missingEvaluatorPipelineIds = input.requiredEvaluatorPipelineIds.filter((id) => !passed.has(id));
  const result = { ok: missingEvaluatorPipelineIds.length === 0, missingEvaluatorPipelineIds };
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
