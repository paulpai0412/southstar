import { createHash } from "node:crypto";
import {
  CANONICAL_DIAGNOSTIC_CODES,
  canonicalDiagnostic,
  canonicalDiagnosticCode,
  type CanonicalDiagnostic,
} from "../canonical-diagnostics.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import { criterionValidationCheckKey } from "../design-library/types.ts";
import type { RequirementValidationMode } from "../design-library/types.ts";
import {
  listUnresolvedRuntimeExceptionsPg,
  recordRuntimeExceptionInTxPg,
} from "../exceptions/postgres-runtime-exceptions.ts";
import {
  acceptedProducerArtifactRefsPg,
  loadFrozenCoverageContextPg,
  frozenCoverageUnavailableDiagnosticPg,
  normalizeRequirementEvidenceRef,
  requirementEvaluatorResultIncompatibility,
  type FrozenCoverageContext,
} from "./requirement-evaluator-results.ts";
import {
  appendHistoryEventOncePg,
  updateWorkflowRunStatusPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";
import { persistTerminalGoalOutcomePg } from "./goal-outcome.ts";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "lost", "blocked"]);
const CRITICAL_EXCEPTION_SEVERITIES = new Set(["blocking", "terminal"]);

export type CompletionGateResult = {
  runId: string;
  executionStatus: "completed" | "not_ready";
  outcomeStatus: "in_progress" | "satisfied" | "unsatisfied" | "blocked";
  findings: string[];
};

type ArtifactRow = { task_id: string };
type EvaluatorRow = { task_id: string | null; resource_key: string; status: string; payload_json: unknown };
type EvidenceRow = { resource_key: string; payload_json: unknown };

export async function evaluateRunCompletionGatePg(
  db: SouthstarDb,
  input: { runId: string },
): Promise<CompletionGateResult> {
  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ id: string; status: string; runtime_context_json: unknown; workflow_manifest_json: unknown }>(
      "select id, status, runtime_context_json, workflow_manifest_json from southstar.workflow_runs where id = $1 for update",
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);
    if (run.status === "cancelled") return notReady(input.runId, "run is cancelled");
    if (run.status === "awaiting_approval" || await hasUnresolvedBlockingApprovalPg(tx, input.runId)) {
      return notReady(input.runId, "run is awaiting blocking approval");
    }

    const tasks = (await tx.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order, id for update",
      [input.runId],
    )).rows;
    if (tasks.length === 0) return notReady(input.runId, "run has no tasks");
    if (tasks.some((task) => !TERMINAL_TASK_STATUSES.has(task.status))) {
      return notReady(input.runId, "tasks are not terminal");
    }

    const artifacts = (await tx.query<ArtifactRow>(
      `select distinct task_id
         from southstar.runtime_resources
        where run_id = $1 and task_id is not null
          and resource_type = $2 and status = 'accepted'
        order by task_id`,
      [input.runId, ARTIFACT_REF_RESOURCE_TYPE],
    )).rows;
    const acceptedArtifactTaskIds = new Set(artifacts.map((row) => row.task_id));
    const supersededTaskIds = await supersededDynamicRepairTaskIdsPg(tx, input.runId, acceptedArtifactTaskIds);
    const evaluatorRows = (await tx.query<EvaluatorRow>(
      `select task_id, resource_key, status, payload_json
         from southstar.runtime_resources
        where run_id = $1 and resource_type = 'requirement_evaluator_result'
        order by created_at, resource_key`,
      [input.runId],
    )).rows;
    const coverageContext = await loadFrozenCoverageContextPg(tx, input.runId);
    const unavailableDiagnostic = coverageContext
      ? undefined
      : await frozenCoverageUnavailableDiagnosticPg(tx, input.runId);
    const evaluation = coverageContext
      ? await evaluateCoveragePg(tx, input.runId, coverageContext, evaluatorRows)
      : { coveredRequirementIds: [], failedRequirementIds: [], findings: [], diagnostics: [], totalBlockingRequirements: 0 };

    const diagnostics: CanonicalDiagnostic[] = [
      ...(!coverageContext
        ? [unavailableDiagnostic ?? canonicalDiagnostic(
          CANONICAL_DIAGNOSTIC_CODES.goalRequirementCoverageMissing,
          `run ${input.runId} has no frozen goal requirement coverage`,
        )]
        : evaluation.diagnostics),
      ...evaluatorRows.flatMap((row) => {
        const diagnostic = requirementEvaluatorResultIncompatibility({
          resourceKey: row.resource_key,
          payload: row.payload_json,
        });
        return diagnostic ? [diagnostic] : [];
      }),
    ];
    await persistCanonicalCompletionDiagnosticsPg(tx, input.runId, diagnostics);

    const criticalFindings: string[] = diagnostics.map((diagnostic) => diagnostic.message);
    const blockingViolations = (await tx.query<{ id: string }>(
      `select id from southstar.runtime_resources
        where run_id = $1 and resource_type = 'tool_proxy_violation' and status = 'blocking'
        order by created_at, id`,
      [input.runId],
    )).rows;
    for (const violation of blockingViolations) criticalFindings.push(`blocking tool proxy violation ${violation.id}`);

    const unresolvedExceptions = await listUnresolvedRuntimeExceptionsPg(tx, { runId: input.runId });
    for (const exception of unresolvedExceptions) {
      if (exception.taskId && supersededTaskIds.has(exception.taskId)) continue;
      if (!CRITICAL_EXCEPTION_SEVERITIES.has(exception.payload.severity)) continue;
      const providerEvidence = asRecord(exception.payload.providerEvidence);
      if (canonicalDiagnosticCode(providerEvidence.code)) {
        const message = stringValue(providerEvidence.message);
        if (message && !criticalFindings.includes(message)) criticalFindings.push(message);
        continue;
      }
      criticalFindings.push(`unresolved critical runtime exception ${exception.resourceKey}: ${exception.payload.kind}`);
    }

    const findings = [...evaluation.findings, ...criticalFindings];
    const outcomeStatus = criticalFindings.length > 0
      ? "blocked" as const
      : evaluation.failedRequirementIds.length > 0 || evaluation.findings.length > 0
        ? "unsatisfied" as const
        : "satisfied" as const;
    const outcomePayload = {
      outcomeStatus,
      coveredRequirementIds: evaluation.coveredRequirementIds,
      failedRequirementIds: evaluation.failedRequirementIds,
      findings,
    };
    const fingerprint = shortHash(stableStringify({ tasks, outcomePayload }));

    await updateWorkflowRunStatusPg(tx, input.runId, "evaluating");
    await appendHistoryEventOncePg(tx, {
      runId: input.runId,
      eventType: "run.evaluating_started",
      actorType: "evaluator",
      idempotencyKey: `completion-gate:${input.runId}:evaluating_started:${fingerprint}`,
      payload: {},
    });
    await upsertRuntimeResourcePg(tx, {
      id: `completion-gate:${input.runId}`,
      resourceType: "evaluator_result",
      resourceKey: `completion-gate:${input.runId}`,
      runId: input.runId,
      scope: "evaluator",
      status: outcomeStatus,
      title: `Completion gate ${input.runId}`,
      payload: { executionStatus: "completed", outcomeStatus, findings },
      summary: { findingCount: findings.length },
    });
    await persistTerminalGoalOutcomePg(tx, {
      runId: input.runId,
      outcomeStatus,
      coveredRequirementIds: evaluation.coveredRequirementIds,
      failedRequirementIds: evaluation.failedRequirementIds,
      findings,
      actorType: "evaluator",
      idempotencyKey: `completion-gate:${input.runId}:completed:${fingerprint}`,
    });
    await persistStopConditionResultsPg(tx, input.runId, stopConditionsFromManifest(run.workflow_manifest_json), outcomeStatus);
    return { runId: input.runId, executionStatus: "completed", outcomeStatus, findings };
  });
}

type StopConditionResultDefinition = {
  id: string;
  type: string;
  evaluatorRefs: string[];
};

function stopConditionsFromManifest(value: unknown): StopConditionResultDefinition[] {
  const manifest = asRecord(value);
  if (!Array.isArray(manifest.stopConditions)) return [];
  return manifest.stopConditions.flatMap((raw) => {
    const condition = asRecord(raw);
    const id = stringValue(condition.id);
    const type = stringValue(condition.type);
    if (!id || !type) return [];
    return [{ id, type, evaluatorRefs: stringArray(condition.evaluatorRefs) }];
  });
}

async function persistStopConditionResultsPg(
  db: SouthstarDb,
  runId: string,
  conditions: StopConditionResultDefinition[],
  outcomeStatus: CompletionGateResult["outcomeStatus"],
): Promise<void> {
  for (const condition of conditions) {
    const derivedFromCompletion = new Set(["artifact-accepted", "tests-passed", "checker-passed"]).has(condition.type);
    const passed = outcomeStatus === "satisfied" && derivedFromCompletion;
    const status = passed ? "passed" : outcomeStatus === "blocked" ? "blocked" : "failed";
    await upsertRuntimeResourcePg(db, {
      id: `stop-condition:${runId}:${condition.id}`,
      resourceType: "stop_condition_result",
      resourceKey: `stop-condition:${runId}:${condition.id}`,
      runId,
      scope: "stop-condition",
      status,
      title: `Stop condition ${condition.id}`,
      payload: {
        schemaVersion: "southstar.stop_condition_result.v1",
        conditionId: condition.id,
        conditionType: condition.type,
        evaluatorRefs: condition.evaluatorRefs,
        outcomeStatus,
        passed,
      },
      summary: { passed, evaluatorRefCount: condition.evaluatorRefs.length },
    });
  }
}

async function hasUnresolvedBlockingApprovalPg(db: SouthstarDb, runId: string): Promise<boolean> {
  return Boolean(await db.maybeOne(
    `select id from southstar.runtime_resources
      where run_id = $1 and resource_type = 'approval'
        and status in ('pending', 'waiting_operator_approval')
        and coalesce(payload_json->>'actionType', '') in ('dynamic_repair_authority_expansion', 'workflow_revision')
      limit 1`,
    [runId],
  ));
}

async function evaluateCoveragePg(
  db: SouthstarDb,
  runId: string,
  context: FrozenCoverageContext,
  results: EvaluatorRow[],
): Promise<{
  coveredRequirementIds: string[];
  failedRequirementIds: string[];
  findings: string[];
  diagnostics: CanonicalDiagnostic[];
  totalBlockingRequirements: number;
}> {
  const completeEvidenceRows = (await db.query<EvidenceRow>(
    `select resource_key
          , payload_json
       from southstar.runtime_resources
      where run_id = $1 and resource_type = 'evidence_packet' and status = 'complete'
      order by resource_key`,
    [runId],
  )).rows;
  const completeEvidenceRefs = new Set(completeEvidenceRows.map((row) => row.resource_key));
  const completeEvidenceByRef = new Map(completeEvidenceRows.map((row) => [row.resource_key, asRecord(row.payload_json)]));
  const coveredRequirementIds: string[] = [];
  const failedRequirementIds: string[] = [];
  const findings: string[] = [];
  const diagnostics: CanonicalDiagnostic[] = [];
  const entries = new Map(context.coverage.entries.map((entry) => [entry.requirementId, entry]));
  const blockingRequirements = context.goalContract.requirements.filter((requirement) => (
    requirement.acceptanceCriteria.some((criterion) => criterion.blocking)
  ));

  for (const requirement of blockingRequirements) {
    const entry = entries.get(requirement.id);
    if (!entry) {
      failedRequirementIds.push(requirement.id);
      findings.push(`blocking requirement ${requirement.id} is missing frozen coverage`);
      continue;
    }
    const blockingBindings = entry.criterionBindings.filter((binding) => binding.blocking);
    if (blockingBindings.length === 0) {
      failedRequirementIds.push(requirement.id);
      diagnostics.push(canonicalDiagnostic(
        CANONICAL_DIAGNOSTIC_CODES.criterionCoverageRequired,
        `requirement ${requirement.id} has no frozen criterion coverage`,
      ));
      continue;
    }
    const producerTaskIds = new Set(entry.producerTaskIds);
    const acceptedRefs = await acceptedProducerArtifactRefsPg(db, runId, entry, context.manifest);
    const acceptedRefSet = new Set(acceptedRefs);
    const evaluatorTaskIds = new Set(entry.evaluatorTaskIds);
    const passed = entry.evaluatorTaskIds.every((taskId) => !producerTaskIds.has(taskId))
      && acceptedRefs.length > 0
      && blockingBindings.every((binding) => results.some((row) => {
        const payload = asRecord(row.payload_json);
        const normalizedProfileRef = normalizeRequirementEvidenceRef(binding.evaluatorProfileRef, "evaluator");
        const expectedBindings = entry.criterionBindings
          .filter((candidate) => (
            normalizeRequirementEvidenceRef(candidate.evaluatorProfileRef, "evaluator") === normalizedProfileRef
            && candidate.evaluatorProfileVersionRef === binding.evaluatorProfileVersionRef
          ));
        const expectedCheckKeys = expectedBindings
          .map((candidate) => criterionValidationCheckKey(candidate.criterionId, candidate.verificationMode))
          .sort();
        const identityMatches = row.task_id !== null
          && evaluatorTaskIds.has(row.task_id)
          && payload.evaluatorTaskId === row.task_id
          && stringValue(payload.attemptId) !== undefined
          && normalizeRequirementEvidenceRef(stringValue(payload.evaluatorProfileRef) ?? "", "evaluator") === normalizedProfileRef
          && payload.evaluatorProfileVersionRef === binding.evaluatorProfileVersionRef
          && stringArray(payload.artifactRefs).some((ref) => acceptedRefSet.has(ref));
        if (!identityMatches) return false;
        if (
          payload.schemaVersion !== "southstar.requirement_evaluator_result.v2"
          || payload.requirementId !== requirement.id
          || payload.validationBindingId !== entry.validationBindingId
          || !stringArray(payload.evidenceRefs).every((ref) => completeEvidenceRefs.has(ref))
          || stringArray(payload.evidenceRefs).length === 0
          || !stringArray(payload.evidenceRefs).every((ref) => evidencePacketMatchesEvaluatorLineage(
            completeEvidenceByRef.get(ref),
            {
              runId,
              requirementId: requirement.id,
              validationBindingId: entry.validationBindingId,
              evaluatorTaskId: row.task_id!,
              evaluatorAttemptId: stringValue(payload.attemptId)!,
              evaluatorArtifactRef: stringValue(payload.evaluatorArtifactRef) ?? "",
              artifactRefs: stringArray(payload.artifactRefs),
              goalContractHash: context.coverage.goalContractHash,
              bindings: expectedBindings,
            },
          ))
        ) return false;
        const criteriaResults = Array.isArray(payload.criteriaResults)
          ? payload.criteriaResults.map(asRecord)
          : [];
        const resultCheckKeys = criteriaResults.map((result) => {
          const criterionId = stringValue(result.criterionId);
          const verificationMode = stringValue(result.verificationMode);
          if (!criterionId) return undefined;
          if (verificationMode) return criterionValidationCheckKey(
            criterionId,
            verificationMode as RequirementValidationMode,
          );
          const unambiguousBinding = expectedBindings.filter((candidate) => candidate.criterionId === criterionId);
          return unambiguousBinding.length === 1
            ? criterionValidationCheckKey(criterionId, unambiguousBinding[0]!.verificationMode)
            : undefined;
        });
        if (
          resultCheckKeys.some((key) => key === undefined)
          || criteriaResults.length !== expectedCheckKeys.length
          || new Set(resultCheckKeys).size !== resultCheckKeys.length
          || (resultCheckKeys as string[]).sort().join("\u0000") !== expectedCheckKeys.join("\u0000")
        ) return false;
        const bindingCheckKey = criterionValidationCheckKey(binding.criterionId, binding.verificationMode);
        const criterionResult = criteriaResults.find((result, index) => resultCheckKeys[index] === bindingCheckKey);
        return criterionResult?.verdict === "passed" && stringArray(criterionResult.evidenceRefs).length > 0;
      }));
    if (passed) coveredRequirementIds.push(requirement.id);
    else {
      failedRequirementIds.push(requirement.id);
      findings.push(`blocking requirement ${requirement.id} lacks complete passed criterion evidence from the frozen evaluator version`);
    }
  }
  return {
    coveredRequirementIds: coveredRequirementIds.sort(),
    failedRequirementIds: failedRequirementIds.sort(),
    findings,
    diagnostics,
    totalBlockingRequirements: blockingRequirements.length,
  };
}

function evidencePacketMatchesEvaluatorLineage(
  packet: Record<string, unknown> | undefined,
  expected: {
    runId: string;
    requirementId: string;
    validationBindingId: string | undefined;
    evaluatorTaskId: string;
    evaluatorAttemptId: string;
    evaluatorArtifactRef: string;
    artifactRefs: string[];
    goalContractHash: string;
    bindings: FrozenCoverageContext["coverage"]["entries"][number]["criterionBindings"];
  },
): boolean {
  if (!packet || packet.runId !== expected.runId || packet.taskId !== expected.evaluatorTaskId) return false;
  if (packet.artifactRef !== stringValue(asRecord(packet.lineage).evaluatorArtifactRef)) return false;
  const lineage = asRecord(packet.lineage);
  if (
    lineage.goalContractHash !== expected.goalContractHash
    || lineage.evaluatorTaskId !== expected.evaluatorTaskId
    || lineage.evaluatorAttemptId !== expected.evaluatorAttemptId
    || lineage.evaluatorArtifactRef !== expected.evaluatorArtifactRef
  ) return false;
  const checks = Array.isArray(lineage.checks) ? lineage.checks.map(asRecord) : [];
  return expected.bindings.every((binding) => {
    const checkKey = criterionValidationCheckKey(binding.criterionId, binding.verificationMode);
    return checks.some((check) => (
      check.checkKey === checkKey
      && check.requirementId === expected.requirementId
      && check.validationBindingId === expected.validationBindingId
      && check.criterionId === binding.criterionId
      && check.criterionVersion === binding.criterionVersion
      && check.verificationMode === binding.verificationMode
      && check.artifactContractRef === binding.artifactContractRef
      && check.artifactContractVersionRef === binding.artifactContractVersionRef
      && check.procedureRef === binding.procedureRef
      && (binding.procedureVersionRef === undefined || check.procedureVersionRef === binding.procedureVersionRef)
      && (binding.oracleRef === undefined || (check.oracleRef === binding.oracleRef && check.oracleVersionRef === binding.oracleVersionRef))
      && check.evaluatorTaskId === expected.evaluatorTaskId
      && check.evaluatorAttemptId === expected.evaluatorAttemptId
      && check.evaluatorArtifactRef === expected.evaluatorArtifactRef
      && check.evaluatorProfileRef === binding.evaluatorProfileRef
      && check.evaluatorProfileVersionRef === binding.evaluatorProfileVersionRef
      && sameStringValues(stringArray(check.artifactInstanceRefs), expected.artifactRefs)
    ));
  });
}

function sameStringValues(left: string[], right: string[]): boolean {
  return [...new Set(left)].sort().join("\u0000") === [...new Set(right)].sort().join("\u0000");
}

async function persistCanonicalCompletionDiagnosticsPg(
  db: SouthstarDb,
  runId: string,
  diagnostics: CanonicalDiagnostic[],
): Promise<void> {
  const grouped = new Map<string, CanonicalDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const rows = grouped.get(diagnostic.code) ?? [];
    rows.push(diagnostic);
    grouped.set(diagnostic.code, rows);
  }
  for (const [code, rows] of grouped) {
    const existing = await db.maybeOne<{ id: string }>(
      `select id
         from southstar.runtime_resources
        where run_id = $1
          and resource_type = 'runtime_exception'
          and status in ('observed', 'blocked')
          and payload_json->'providerEvidence'->>'code' = $2
        limit 1`,
      [runId, code],
    );
    if (existing) continue;
    await recordRuntimeExceptionInTxPg(db, {
      runId,
      source: "completion-gate",
      kind: code === CANONICAL_DIAGNOSTIC_CODES.requirementEvaluatorResultIncompatible
        ? "callback_contract_violation"
        : "validation_failed",
      severity: "blocking",
      status: "blocked",
      observedAt: new Date().toISOString(),
      evidenceRefs: rows.map((row) => row.message),
      providerEvidence: {
        code,
        message: rows[0]!.message,
        diagnostics: rows,
      },
    });
  }
}

function notReady(runId: string, finding: string): CompletionGateResult {
  return { runId, executionStatus: "not_ready", outcomeStatus: "in_progress", findings: [finding] };
}

async function supersededDynamicRepairTaskIdsPg(db: SouthstarDb, runId: string, acceptedArtifactRefs: Set<string>): Promise<Set<string>> {
  const rows = (await db.query<{ payload_json: unknown }>(
    `select payload_json from southstar.runtime_resources
      where run_id = $1 and resource_type = 'workflow_dynamic_repair_revision' and status = 'applied'
      order by created_at, resource_key`,
    [runId],
  )).rows;
  const superseded = new Set<string>();
  for (const row of rows) {
    const payload = asRecord(row.payload_json);
    const rootFailedTaskId = stringValue(payload.rootFailedTaskId) ?? stringValue(payload.originalFailedTaskId);
    const reconnectTargetTaskId = lastStringValue(payload.newTaskIds);
    if (rootFailedTaskId && reconnectTargetTaskId && acceptedArtifactRefs.has(reconnectTargetTaskId)) superseded.add(rootFailedTaskId);
  }
  return superseded;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function lastStringValue(value: unknown): string | undefined {
  return Array.isArray(value) ? stringValue(value.at(-1)) : undefined;
}
