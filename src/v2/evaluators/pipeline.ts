// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
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
  const drill = recoveryDrillFinding(db, input);
  if (drill) findings.push(drill.finding);

  const ok = findings.length === 0;
  const result: EvaluatorPipelineRunResult = {
    ok,
    pipelineId: input.pipeline.id,
    findings,
    recoveryStrategy: ok ? undefined : drill?.strategy ?? input.pipeline.onFailure.defaultStrategy,
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

function recoveryDrillFinding(
  db: SouthstarDb,
  input: EvaluatorPipelineRunInput,
): { finding: { field: string; message: string }; strategy?: string } | undefined {
  for (const evaluator of input.pipeline.evaluators) {
    const drill = isRecord(evaluator.config.recoveryDrill) ? evaluator.config.recoveryDrill : undefined;
    if (!drill) continue;
    const trigger = typeof drill.trigger === "string" ? drill.trigger : "once";
    if (trigger !== "once") continue;
    const drillKey = `recovery-drill-${input.runId}-${input.taskId}-${input.pipeline.id}-${evaluator.id}`;
    const existing = db.prepare(`
      select 1 from runtime_resources
      where run_id = ? and task_id = ? and resource_type = 'recovery_drill' and resource_key = ?
    `).get(input.runId, input.taskId, drillKey);
    if (existing) continue;

    const strategy = typeof drill.strategy === "string" ? drill.strategy : undefined;
    const reason = typeof drill.reason === "string" && drill.reason.length > 0
      ? drill.reason
      : `Recovery drill ${evaluator.id} requested one forced evaluator failure.`;
    upsertRuntimeResource(db, {
      resourceType: "recovery_drill",
      resourceKey: drillKey,
      runId: input.runId,
      taskId: input.taskId,
      scope: "evaluator",
      status: "triggered",
      title: evaluator.id,
      payload: { pipelineId: input.pipeline.id, evaluatorId: evaluator.id, strategy, reason },
      summary: { strategy, reason },
    });
    return { finding: { field: `recoveryDrill.${evaluator.id}`, message: reason }, strategy };
  }
  return undefined;
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
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectFailedEvidence(entry, `${field}[${index}]`, findings);
    });
    return;
  }

  if (typeof value === "string") {
    if (isFailedEvidenceText(value)) {
      findings.push({
        field,
        message: `failed command evidence at ${field}`,
      });
    }
    return;
  }

  if (!isRecord(value)) return;

  if (looksLikeEvidenceEntry(value)) {
    if (!isFailedEvidence(value)) return;
    const command = typeof value.command === "string" ? ` ${value.command}` : "";
    findings.push({
      field,
      message: `failed command evidence at ${field}${command}`,
    });
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    collectFailedEvidence(nested, `${field}.${key}`, findings);
  }
}

function isFailedEvidence(entry: Record<string, unknown>): boolean {
  if (isExplicitlyPassedEvidence(entry)) return false;
  if (isNonGatingFailure(entry)) return false;

  if (entry.passed === false || entry.ok === false) return true;

  const status = normalizedStatus(entry.status);
  const result = normalizedStatus(entry.result);
  if (["fail", "failed", "error", "errored", "cancelled", "blocked", "not-verified", "not-run"].includes(status)) {
    return true;
  }
  if (["fail", "failed", "error", "errored", "cancelled", "blocked", "not-verified", "not-run"].includes(result)) {
    return true;
  }
  return isNonZeroNumber(entry.exitCode) || isNonZeroNumber(entry.code);
}

function isExplicitlyPassedEvidence(entry: Record<string, unknown>): boolean {
  if (entry.passed === true || entry.ok === true) return true;
  const status = normalizedStatus(entry.status);
  const result = normalizedStatus(entry.result);
  if (/\b0\s+failed\b/.test(`${entry.status ?? ""}`.toLowerCase()) && /(pass|success|ok)/i.test(`${entry.status ?? ""}`)) {
    return true;
  }
  return ["pass", "passed", "success", "succeeded", "ok"].includes(status)
    || ["pass", "passed", "success", "succeeded", "ok"].includes(result);
}

function isNonGatingFailure(entry: Record<string, unknown>): boolean {
  const status = normalizedStatus(entry.status);
  const result = normalizedStatus(entry.result);
  const gating = normalizedGating(entry.gating ?? entry.gate);
  if (status === "failed_non_gating" || result === "failed_non_gating") return true;
  return gating === "non-gating";
}

function looksLikeEvidenceEntry(entry: Record<string, unknown>): boolean {
  return ["status", "result", "passed", "ok", "exitCode", "code", "command", "details", "output", "gating", "gate"]
    .some((key) => key in entry);
}

function normalizedStatus(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[_\s]+/g, "-");
}

function normalizedGating(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "non-blocking" || normalized === "nonblocking") return "non-gating";
  return normalized;
}

function isFailedEvidenceText(value: string): boolean {
  const normalized = value.toLowerCase();
  if (/\b0\s+failed\b/.test(normalized) && /(pass|success|ok)/.test(normalized)) return false;
  if (/failed_non_gating|non-gating|non_gating/.test(normalized)) return false;
  return /(\bfail(ed)?\b|\berror\b|\bblocked\b|\bnot[-_ ]?verified\b|\bnot[-_ ]?run\b)/.test(normalized);
}

function isNonZeroNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value !== 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
