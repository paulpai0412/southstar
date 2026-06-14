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
  findings.push(...failedCommandEvidenceFindings(input.artifact));

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

function failedCommandEvidenceFindings(artifact: Record<string, unknown>): Array<{ field: string; message: string }> {
  const findings: Array<{ field: string; message: string }> = [];
  collectFailedEvidence(artifact.testResults, "testResults", findings);
  if (isRecord(artifact.artifactEvidence)) {
    collectFailedEvidence(artifact.artifactEvidence.testResults, "artifactEvidence.testResults", findings);
  }
  collectFailedEvidence(artifact.tests, "tests", findings);
  return findings;
}

function collectFailedEvidence(
  value: unknown,
  field: string,
  findings: Array<{ field: string; message: string }>,
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    if (!isRecord(entry) || !isFailedEvidence(entry)) return;
    const command = typeof entry.command === "string" ? ` ${entry.command}` : "";
    findings.push({
      field,
      message: `failed command evidence at ${field}[${index}]${command}`,
    });
  });
}

function isFailedEvidence(entry: Record<string, unknown>): boolean {
  if (entry.passed === false || entry.ok === false) return true;
  const status = typeof entry.status === "string" ? entry.status.toLowerCase() : "";
  const result = typeof entry.result === "string" ? entry.result.toLowerCase() : "";
  if (["fail", "failed", "error", "errored", "cancelled"].includes(status)) return true;
  if (["fail", "failed", "error", "errored", "cancelled"].includes(result)) return true;
  return isNonZeroNumber(entry.exitCode) || isNonZeroNumber(entry.code);
}

function isNonZeroNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value !== 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
