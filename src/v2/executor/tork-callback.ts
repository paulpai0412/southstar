import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import { recomputeManagementMetrics, type ManagementMetrics } from "../stores/metrics-store.ts";
import type { TaskRunnerEvent } from "../agent-runner/task-runner.ts";
import { createSqliteSessionGraphProvider } from "../session-graph/sqlite-provider.ts";
import type { ArtifactContract, DomainPack, EvaluatorPipelineDefinition } from "../domain-packs/types.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { runEvaluatorPipeline, type EvaluatorPipelineRunResult } from "../evaluators/pipeline.ts";
import { evaluateStopCondition } from "../evaluators/stop-condition.ts";
import { acceptTaskRunArtifact } from "../artifacts/acceptance.ts";
import type { EvidenceKind } from "../artifacts/types.ts";
import { computeDownstreamReadiness } from "../artifacts/downstream-readiness.ts";
import { createSessionCheckpoint } from "../session-recovery/checkpoints.ts";
import { rebuildTaskEnvelopeFromCheckpoint } from "../session-recovery/context-rebuild.ts";
import { commitRecoveryDecision, recordSessionOperation } from "../session-recovery/operations.ts";
import type { RecoveryStrategy, SessionOperationV1 } from "../session-recovery/types.ts";
import { planRecoveryExecution, type RecoveryExecutionPlan } from "../session-recovery/execution-planner.ts";

export type TaskRunCallbackResult = {
  runId: string;
  taskId: string;
  rootSessionId: string;
  ok: boolean;
  attempts: number;
  attemptId?: string;
  artifact: Record<string, unknown>;
  metrics: Partial<ManagementMetrics>;
  events: TaskRunnerEvent[];
  materializationRoot?: string;
};

export type CallbackIngestionResult = {
  recoveryDispatch?: {
    runId: string;
    failedTaskId: string;
    plan: RecoveryExecutionPlan;
  };
};

export function ingestTaskRunResult(db: SouthstarDb, result: TaskRunCallbackResult): CallbackIngestionResult {
  db.exec("begin immediate");
  try {
    const callbackReceipt = callbackReceiptToken(result);
    if (historyHasIdempotencyKey(db, result.runId, callbackReceipt.idempotencyKey)) {
      db.exec("commit");
      cleanupTaskMaterialization(result);
      return {};
    }

    appendHistoryEvent(db, {
      runId: result.runId,
      taskId: result.taskId,
      sessionId: result.rootSessionId,
      eventType: "executor.callback_received",
      actorType: "executor",
      idempotencyKey: callbackReceipt.idempotencyKey,
      payload: {
        attempts: result.attempts,
        artifactHash: callbackReceipt.artifactHash,
      },
    });

    const staleAttempt = staleAttemptReason(db, result);
    if (staleAttempt) {
      appendHistoryEvent(db, {
        runId: result.runId,
        taskId: result.taskId,
        sessionId: result.rootSessionId,
        eventType: "executor.callback_ignored_stale_attempt",
        actorType: "orchestrator",
        payload: staleAttempt,
      });
      db.exec("commit");
      cleanupTaskMaterialization(result);
      return {};
    }

    const existingTaskStatus = readTaskStatus(db, result.runId, result.taskId);
    if (isTaskTerminalStatus(existingTaskStatus)) {
      appendHistoryEvent(db, {
        runId: result.runId,
        taskId: result.taskId,
        sessionId: result.rootSessionId,
        eventType: "executor.callback_ignored_terminal",
        actorType: "orchestrator",
        payload: {
          status: existingTaskStatus,
        },
      });
      db.exec("commit");
      cleanupTaskMaterialization(result);
      return {};
    }

    for (const event of result.events) {
      appendHistoryEvent(db, {
        runId: result.runId,
        taskId: result.taskId,
        sessionId: event.sessionId ?? result.rootSessionId,
        eventType: event.eventType,
        actorType: event.actorType,
        payload: event.payload,
      });
    }

    const acceptance = acceptTaskRunArtifact(db, {
      runId: result.runId,
      taskId: result.taskId,
      rootSessionId: result.rootSessionId,
      attempts: result.attempts,
      producerAgentSpecRef: producerAgentSpecRef(db, result.runId, result.taskId),
      artifactContract: taskArtifactContract(db, result.runId, result.taskId),
      requiredEvidenceKinds: requiredEvidenceKindsForTask(db, result.runId, result.taskId),
      artifact: result.artifact,
      metrics: result.metrics,
    });
    const artifactResourceId = acceptance.artifactResourceId;

    appendHistoryEvent(db, {
      runId: result.runId,
      taskId: result.taskId,
      sessionId: result.rootSessionId,
      eventType: "artifact.created",
      actorType: "orchestrator",
      payload: {
        artifactResourceId,
        attempts: result.attempts,
        accepted: acceptance.accepted,
        validatorResultIds: acceptance.validatorResultIds,
        evidencePacketId: acceptance.evidencePacketId,
      },
    });
    let recoveryDispatch: CallbackIngestionResult["recoveryDispatch"];
    if (acceptance.accepted) {
      const evaluatorResult = runTaskEvaluatorPipeline(db, result);
      if (evaluatorResult && !evaluatorResult.ok && evaluatorResult.recoveryStrategy) {
        recoveryDispatch = persistRecoveryFromEvaluatorFailure(db, result, evaluatorResult);
      }
      createSqliteSessionGraphProvider(db).checkpoint({
        sessionId: result.rootSessionId,
        runId: result.runId,
        taskId: result.taskId,
        contextPacketId: `callback-${result.runId}-${result.taskId}`,
        artifactRefs: [artifactResourceId],
        transcriptSummary: "Accepted callback artifact.",
        metrics: numericMetrics(result.metrics),
      });
    }

    updateTaskStatus(db, result.runId, result.taskId, acceptance.accepted ? "completed" : "failed");
    refreshRunDownstreamReadiness(db, result.runId);
    recomputeManagementMetrics(db, result.runId);
    if (!recoveryDispatch && allTasksTerminal(db, result.runId)) {
      const stopConditionsPassed = !allTasksPassed(db, result.runId) || evaluateRunStopConditions(db, result.runId);
      updateRunStatus(db, result.runId, allTasksPassed(db, result.runId) && stopConditionsPassed ? "passed" : "failed");
      appendHistoryEvent(db, {
        runId: result.runId,
        eventType: "run.completed",
        actorType: "orchestrator",
        payload: { status: allTasksPassed(db, result.runId) && stopConditionsPassed ? "passed" : "failed" },
      });
    }
    db.exec("commit");
    cleanupTaskMaterialization(result);
    return { recoveryDispatch };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function runTaskEvaluatorPipeline(db: SouthstarDb, result: TaskRunCallbackResult): EvaluatorPipelineRunResult | undefined {
  const workflow = readWorkflowManifest(db, result.runId);
  if (!workflow) return undefined;
  const task = workflow.tasks.find((candidate) => candidate.id === result.taskId);
  if (!task) return undefined;
  const pipeline = findEvaluatorPipeline(workflow, task.evaluatorPipelineRef);
  if (!pipeline) return undefined;
  const artifactRef = evaluatorArtifactRef(pipeline) ?? task.requiredArtifactRefs[0] ?? task.subagents[0]?.requiredArtifacts[0];
  const artifactContract = artifactRef ? findArtifactContract(workflow, artifactRef) : undefined;
  if (!artifactContract) return undefined;
  return runEvaluatorPipeline(db, {
    runId: result.runId,
    taskId: result.taskId,
    pipeline,
    artifactContract,
    artifact: result.artifact,
  });
}

function persistRecoveryFromEvaluatorFailure(
  db: SouthstarDb,
  result: TaskRunCallbackResult,
  evaluatorResult: EvaluatorPipelineRunResult,
): NonNullable<CallbackIngestionResult["recoveryDispatch"]> | undefined {
  const workflow = readWorkflowManifest(db, result.runId);
  const task = workflow?.tasks.find((candidate) => candidate.id === result.taskId);
  if (!workflow || !task) return undefined;

  const strategy = toRecoveryStrategy(evaluatorResult.recoveryStrategy);
  if (!strategy) return undefined;

  const checkpoint = createSessionCheckpoint(db, {
    runId: result.runId,
    taskId: result.taskId,
    sessionId: result.rootSessionId,
    kind: "before-recovery",
    createdBy: "evaluator",
    artifactRefs: [`artifact-${result.runId}-${result.taskId}-callback`],
    checkpointSummary: `Evaluator pipeline ${evaluatorResult.pipelineId} failed; recovery strategy ${strategy} selected.`,
    failureSummary: evaluatorResult.findings.map((finding) => finding.message).join("; "),
    nextAttemptHint: "Rebuild compact context from accepted artifacts and re-run with recovery strategy.",
    contextTokenEstimate: latestContextTokenEstimate(db, result.runId, result.taskId),
    policy: {
      safeForAutoRetry: strategy === "retry-same-agent",
      safeForFork: strategy === "fork-from-checkpoint",
      safeForReset: strategy === "reset-from-checkpoint" || strategy === "retry-same-agent",
      safeForWorkspaceRollback: strategy === "rollback-workspace",
    },
  });

  const roleRef = requiredString(task.roleRef, `task ${task.id} roleRef`);
  const agentProfileRef = requiredString(task.agentProfileRef, `task ${task.id} agentProfileRef`);
  const artifactContractRefs = (task.requiredArtifactRefs?.length ?? 0) > 0
    ? (task.requiredArtifactRefs ?? [])
    : task.subagents.flatMap((subagent) => subagent.requiredArtifacts);
  if (artifactContractRefs.length === 0) throw new Error(`task ${task.id} has no artifact contract refs for recovery`);

  const attemptNumber = Math.max(2, result.attempts + 1);
  const rebuilt = rebuildTaskEnvelopeFromCheckpoint(db, {
    runId: result.runId,
    taskId: result.taskId,
    workflowId: workflow.workflowId,
    domainPack: domainPackFromWorkflow(workflow),
    roleRef,
    agentProfileRef,
    artifactContractRefs,
    checkpointId: checkpoint.checkpointId,
    goalPrompt: workflow.goalPrompt,
    executionAttempt: attemptNumber,
  });

  commitRecoveryDecision(db, {
    runId: result.runId,
    taskId: result.taskId,
    source: "evaluator",
    requestedStrategy: strategy,
    selectedStrategy: strategy,
    beforeRecoveryCheckpointId: checkpoint.checkpointId,
    baseCheckpointId: checkpoint.checkpointId,
    reason: `Evaluator pipeline ${evaluatorResult.pipelineId} produced ${evaluatorResult.findings.length} finding(s).`,
    evaluatorFindingRefs: evaluatorResult.findings.map((finding, index) => `${evaluatorResult.pipelineId}:${index}`),
    authorization: { mode: "auto", policyReasons: ["evaluator_failure", evaluatorResult.pipelineId, strategy] },
    tokenTelemetry: rebuilt.telemetry,
  });

  const operationType = operationTypeForStrategy(strategy);
  if (operationType) {
    recordSessionOperation(db, {
      runId: result.runId,
      taskId: result.taskId,
      type: operationType,
      baseCheckpointId: checkpoint.checkpointId,
      oldSessionId: result.rootSessionId,
      newSessionId: operationType === "fork" ? `${result.rootSessionId}-fork` : result.rootSessionId,
      host: "southstar-native",
      status: "succeeded",
      fallbackUsed: false,
    });
  }

  const completedTaskIds = completedTaskIdsForRun(db, result.runId, result.taskId);
  const plan = planRecoveryExecution({
    workflow,
    failedTaskId: result.taskId,
    strategy,
    attemptNumber,
    completedTaskIds,
  });
  upsertRecoveryPlan(db, result.runId, result.taskId, plan);
  return { runId: result.runId, failedTaskId: result.taskId, plan };
}

function toRecoveryStrategy(value: string | undefined): RecoveryStrategy | undefined {
  if (!value) return undefined;
  if (value === "retry-same-agent") return value;
  if (value === "fork-from-checkpoint") return value;
  if (value === "reset-from-checkpoint") return value;
  if (value === "host-native-rewind") return value;
  if (value === "rollback-workspace") return value;
  if (value === "request-workflow-revision") return value;
  if (value === "ask-human") return value;
  return undefined;
}

function operationTypeForStrategy(strategy: RecoveryStrategy): SessionOperationV1["type"] | undefined {
  if (strategy === "fork-from-checkpoint") return "fork";
  if (strategy === "retry-same-agent" || strategy === "reset-from-checkpoint") return "reset";
  if (strategy === "host-native-rewind") return "rewind";
  if (strategy === "rollback-workspace") return "replay";
  return undefined;
}

function domainPackFromWorkflow(workflow: SouthstarWorkflowManifest): DomainPack {
  return {
    id: workflow.domain ?? "general",
    version: workflow.domainPackRef?.version ?? "workflow-embedded",
    displayName: workflow.title,
    intents: [],
    roles: requiredArray(workflow.roles, "workflow.roles"),
    agentProfiles: requiredArray(workflow.agentProfiles, "workflow.agentProfiles"),
    workflowTemplates: [],
    workflowGeneratorPolicies: [],
    artifactContracts: requiredArray(workflow.artifactContracts, "workflow.artifactContracts"),
    evaluatorPipelines: requiredArray(workflow.evaluatorPipelines, "workflow.evaluatorPipelines"),
    contextPolicies: requiredArray(workflow.contextPolicies, "workflow.contextPolicies"),
    sessionPolicies: requiredArray(workflow.sessionPolicies, "workflow.sessionPolicies"),
    memoryPolicies: requiredArray(workflow.memoryPolicies, "workflow.memoryPolicies"),
    workspacePolicies: workflow.workspacePolicies ?? [],
    stopConditions: workflow.stopConditions ?? [],
  };
}

function completedTaskIdsForRun(db: SouthstarDb, runId: string, currentTaskId: string): string[] {
  const rows = db.prepare("select id, status from workflow_tasks where run_id = ?")
    .all(runId) as Array<{ id: string; status: string }>;
  const completed = new Set(rows.filter((row) => row.status === "completed").map((row) => row.id));
  completed.add(currentTaskId);
  return [...completed];
}

function upsertRecoveryPlan(db: SouthstarDb, runId: string, taskId: string, plan: RecoveryExecutionPlan): void {
  upsertRuntimeResource(db, {
    id: `recovery-plan-${runId}-${taskId}-${plan.attemptNumber}`,
    resourceType: "recovery_execution_plan",
    resourceKey: `recovery-plan-${runId}-${taskId}-${plan.attemptNumber}`,
    runId,
    taskId,
    scope: "recovery",
    status: "planned",
    title: `${plan.strategy} recovery plan`,
    payload: plan,
    summary: { strategy: plan.strategy, targetTaskIds: plan.targetTaskIds, attemptNumber: plan.attemptNumber },
  });
}

function requiredArray<T>(value: T[] | undefined, label: string): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requiredString(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function latestContextTokenEstimate(db: SouthstarDb, runId: string, taskId: string): number {
  const row = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and task_id = ? and resource_type = 'context_packet'
    order by updated_at desc limit 1
  `).get(runId, taskId) as { payload_json: string } | undefined;
  if (!row) return 1;
  const payload = JSON.parse(row.payload_json) as { tokenEstimate?: { total?: number } };
  return typeof payload.tokenEstimate?.total === "number" ? payload.tokenEstimate.total : 1;
}

function evaluateRunStopConditions(db: SouthstarDb, runId: string): boolean {
  const workflow = readWorkflowManifest(db, runId);
  if (!workflow) return true;
  const stopConditionRefs = [...new Set(workflow.tasks.flatMap((task) => task.stopConditionRefs ?? []))];
  if (stopConditionRefs.length === 0) return true;
  const stopConditions = workflow.stopConditions ?? [];
  return stopConditionRefs.every((stopConditionRef) => {
    const stopCondition = stopConditions.find((candidate) => candidate.id === stopConditionRef);
    if (!stopCondition) return false;
    return evaluateStopCondition(db, {
      runId,
      stopConditionId: stopCondition.id,
      requiredEvaluatorPipelineIds: stopCondition.evaluatorRefs,
    }).ok;
  });
}

function readWorkflowManifest(db: SouthstarDb, runId: string): SouthstarWorkflowManifest | undefined {
  const row = db.prepare("select workflow_manifest_json from workflow_runs where id = ?")
    .get(runId) as { workflow_manifest_json: string } | undefined;
  if (!row) return undefined;
  const parsed = JSON.parse(row.workflow_manifest_json) as Partial<SouthstarWorkflowManifest>;
  return Array.isArray(parsed.tasks) ? parsed as SouthstarWorkflowManifest : undefined;
}

function findEvaluatorPipeline(
  workflow: SouthstarWorkflowManifest,
  pipelineRef: string,
): EvaluatorPipelineDefinition | undefined {
  return (workflow.evaluatorPipelines ?? []).find((candidate) => candidate.id === pipelineRef);
}

function findArtifactContract(
  workflow: SouthstarWorkflowManifest,
  artifactRef: string,
): ArtifactContract | undefined {
  const normalizedRef = normalizeArtifactRef(artifactRef);
  const matches = (candidate: ArtifactContract) => {
    const id = normalizeArtifactRef(candidate.id);
    const artifactType = normalizeArtifactRef(candidate.artifactType);
    return id === normalizedRef || artifactType === normalizedRef;
  };
  return (workflow.artifactContracts ?? []).find(matches);
}

function evaluatorArtifactRef(pipeline: EvaluatorPipelineDefinition): string | undefined {
  for (const evaluator of pipeline.evaluators) {
    const artifactRef = evaluator.config.artifactRef;
    if (typeof artifactRef === "string") return artifactRef;
  }
  return undefined;
}

function refreshRunDownstreamReadiness(db: SouthstarDb, runId: string): void {
  const workflow = readWorkflowManifest(db, runId);
  if (!workflow) return;
  for (const task of workflow.tasks) {
    const taskStatus = db.prepare("select status from workflow_tasks where run_id = ? and id = ?")
      .get(runId, task.id) as { status?: string } | undefined;
    if (taskStatus?.status !== "completed") continue;
    computeDownstreamReadiness(db, {
      runId,
      taskId: task.id,
      dependencies: task.dependsOn.map((dependencyTaskId) => {
        const dependencyTask = workflow.tasks.find((candidate) => candidate.id === dependencyTaskId);
        const artifactContractRefs = dependencyTask?.requiredArtifactRefs
          ?? dependencyTask?.subagents[0]?.requiredArtifacts
          ?? [];
        return {
          taskId: dependencyTaskId,
          artifactContractRefs,
          workspaceStateRequired: Boolean(dependencyTask?.workspacePolicyRef),
        };
      }),
    });
  }
}

function producerAgentSpecRef(db: SouthstarDb, runId: string, taskId: string): string {
  const workflow = readWorkflowManifest(db, runId);
  const task = workflow?.tasks.find((candidate) => candidate.id === taskId);
  return task?.agentProfileRef ?? task?.subagents[0]?.id ?? "unknown-agent";
}

function taskArtifactContract(db: SouthstarDb, runId: string, taskId: string): ArtifactContract {
  const workflow = readWorkflowManifest(db, runId);
  const task = workflow?.tasks.find((candidate) => candidate.id === taskId);
  if (!workflow || !task) throw new Error(`missing workflow task ${runId}/${taskId}`);
  const pipeline = task.evaluatorPipelineRef ? findEvaluatorPipeline(workflow, task.evaluatorPipelineRef) : undefined;
  const refs = [
    ...(task.requiredArtifactRefs ?? []),
    ...task.subagents.flatMap((subagent) => subagent.requiredArtifacts ?? []),
    ...(pipeline ? [evaluatorArtifactRef(pipeline)] : []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const ref of refs) {
    const contract = findArtifactContract(workflow, ref);
    if (contract) return contract;
  }

  throw new Error(`missing artifact contract for ${runId}/${taskId}`);
}

function requiredEvidenceKindsForTask(db: SouthstarDb, runId: string, taskId: string): EvidenceKind[] {
  const contract = taskArtifactContract(db, runId, taskId);
  const kinds = new Set<EvidenceKind>();
  for (const field of contract.evidenceFields) {
    if (field === "filesChanged") kinds.add("file-diff");
    if (field === "filesToInspect") kinds.add("workspace-snapshot");
    if (field === "commandsRun" || field === "commandsToRun") kinds.add("command-output");
    if (field === "testResults" || field === "tests" || field === "checkerFindings" || field === "artifactEvidence") {
      kinds.add("test-result");
    }
    if (field === "acceptedArtifacts") kinds.add("artifact-ref");
  }
  if (kinds.size === 0) kinds.add("artifact-ref");
  return [...kinds];
}

function normalizeArtifactRef(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function numericMetrics(metrics: Partial<ManagementMetrics>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(metrics).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  );
}

function cleanupTaskMaterialization(result: TaskRunCallbackResult): void {
  const runRoot = result.materializationRoot ?? "/tmp/southstar-runs";
  rmSync(join(runRoot, result.runId, result.taskId), { recursive: true, force: true });
}

function updateTaskStatus(db: SouthstarDb, runId: string, taskId: string, status: string): void {
  const current = readTaskStatus(db, runId, taskId);
  if (isTaskTerminalStatus(current)) return;
  const completedAt = status === "completed" || status === "failed" ? new Date().toISOString() : null;
  db.prepare("update workflow_tasks set status = ?, updated_at = ?, completed_at = ? where run_id = ? and id = ?")
    .run(status, new Date().toISOString(), completedAt, runId, taskId);
}

function updateRunStatus(db: SouthstarDb, runId: string, status: string): void {
  db.prepare("update workflow_runs set status = ?, updated_at = ?, completed_at = ? where id = ?")
    .run(status, new Date().toISOString(), new Date().toISOString(), runId);
}

function staleAttemptReason(db: SouthstarDb, result: TaskRunCallbackResult): { callbackAttemptId: string; latestAttemptId: string } | undefined {
  const latestAttemptId = latestExecutorAttemptId(db, result.runId, result.taskId);
  if (!latestAttemptId) return undefined;

  if (!result.attemptId) {
    const currentSessionId = currentTaskRootSessionId(db, result.runId, result.taskId);
    if (currentSessionId === result.rootSessionId) return undefined;
    return attemptNumber(latestAttemptId) > 1 ? { callbackAttemptId: "unknown", latestAttemptId } : undefined;
  }

  const callbackAttemptId = result.attemptId;
  if (attemptNumber(callbackAttemptId) < attemptNumber(latestAttemptId)) {
    return { callbackAttemptId, latestAttemptId };
  }
  return undefined;
}

function currentTaskRootSessionId(db: SouthstarDb, runId: string, taskId: string): string | undefined {
  const row = db.prepare("select root_session_id from workflow_tasks where run_id = ? and id = ?")
    .get(runId, taskId) as { root_session_id?: string | null } | undefined;
  return row?.root_session_id ?? undefined;
}

function latestExecutorAttemptId(db: SouthstarDb, runId: string, taskId: string): string | undefined {
  const rows = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and task_id = ? and resource_type = 'executor_binding'
  `).all(runId, taskId) as Array<{ payload_json: string }>;
  return rows
    .map((row) => (JSON.parse(row.payload_json) as { attemptId?: string }).attemptId)
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => attemptNumber(right) - attemptNumber(left))[0];
}

function attemptNumber(value: string): number {
  const match = value.match(/attempt-(\d+)/);
  return match ? Number(match[1]) : 1;
}

function callbackReceiptToken(result: TaskRunCallbackResult): { idempotencyKey: string; artifactHash: string } {
  const artifactHash = createHash("sha256")
    .update(JSON.stringify(result.artifact))
    .digest("hex")
    .slice(0, 16);
  return {
    idempotencyKey: `executor-callback:${result.runId}:${result.taskId}:${result.attempts}:${artifactHash}`,
    artifactHash,
  };
}

function historyHasIdempotencyKey(db: SouthstarDb, runId: string, idempotencyKey: string): boolean {
  const row = db.prepare("select 1 as found from workflow_history where run_id = ? and idempotency_key = ?")
    .get(runId, idempotencyKey) as { found: number } | undefined;
  return Boolean(row?.found);
}

function readTaskStatus(db: SouthstarDb, runId: string, taskId: string): string | undefined {
  const row = db.prepare("select status from workflow_tasks where run_id = ? and id = ?")
    .get(runId, taskId) as { status?: string } | undefined;
  return row?.status;
}

function isTaskTerminalStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function allTasksTerminal(db: SouthstarDb, runId: string): boolean {
  const row = db.prepare(`
    select count(*) as count from workflow_tasks
    where run_id = ? and status not in ('completed', 'failed', 'cancelled')
  `).get(runId) as { count: number };
  return row.count === 0;
}

function allTasksPassed(db: SouthstarDb, runId: string): boolean {
  const row = db.prepare(`
    select count(*) as count from workflow_tasks
    where run_id = ? and status != 'completed'
  `).get(runId) as { count: number };
  return row.count === 0;
}
