import type { ArtifactContract, EvaluatorPipelineDefinition } from "../domain-packs/types.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";

export type EvaluatorPipelineRunInput = {
  runId: string;
  taskId: string;
  pipeline: EvaluatorPipelineDefinition;
  artifactContract: ArtifactContract;
  artifact: Record<string, unknown>;
};

export type EvaluatorPipelineRunResult = {
  ok: boolean;
  pipelineId: string;
  findings: Array<{ field: string; message: string }>;
  recoveryStrategy?: string;
};

export function runEvaluatorPipeline(db: SouthstarDb, input: EvaluatorPipelineRunInput): EvaluatorPipelineRunResult {
  const findings = input.artifactContract.requiredFields
    .filter((field) => !hasRequiredValue(input.artifact[field]))
    .map((field) => ({ field, message: `missing required field ${field}` }));
  for (const field of input.artifactContract.evidenceFields) {
    if (!hasEvidenceValue(field, input.artifact[field]) && !findings.some((finding) => finding.field === field)) {
      findings.push({ field, message: `missing evidence field ${field}` });
    }
  }

  const ok = findings.length === 0;
  const result: EvaluatorPipelineRunResult = {
    ok,
    pipelineId: input.pipeline.id,
    findings,
    recoveryStrategy: ok ? undefined : input.pipeline.onFailure.defaultStrategy,
  };
  upsertRuntimeResource(db, {
    resourceType: "evaluator_pipeline_result",
    resourceKey: `eval-${input.runId}-${input.taskId}-${input.pipeline.id}`,
    runId: input.runId,
    taskId: input.taskId,
    scope: "software",
    status: ok ? "passed" : "failed",
    title: input.pipeline.id,
    payload: result,
    summary: { ok, findingCount: findings.length, recoveryStrategy: result.recoveryStrategy },
  });
  if (!ok && result.recoveryStrategy) {
    upsertRuntimeResource(db, {
      resourceType: "recovery_decision",
      resourceKey: `recovery-${input.runId}-${input.taskId}-${input.pipeline.id}`,
      runId: input.runId,
      taskId: input.taskId,
      scope: "software",
      status: "selected",
      title: result.recoveryStrategy,
      payload: { strategy: result.recoveryStrategy, findings },
    });
  }
  return result;
}

function hasRequiredValue(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  return value !== undefined && value !== null && value !== "";
}

const EMPTY_ARRAY_IS_EVIDENCE = new Set(["checkerFindings"]);

function hasEvidenceValue(field: string, value: unknown): boolean {
  if (Array.isArray(value) && EMPTY_ARRAY_IS_EVIDENCE.has(field)) return true;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== "";
}
