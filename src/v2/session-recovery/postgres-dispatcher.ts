import type { SouthstarDb } from "../db/postgres.ts";
import { buildTaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import type { ExecutorProvider } from "../executor/provider.ts";
import { createExecutorBindingPg } from "../executor/postgres-bindings.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { getPostgresTaskEnvelope } from "../ui-api/postgres-task-envelope.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import type { RecoveryExecutionPlan } from "./execution-planner.ts";
import type { RecoveryStrategy, SessionCheckpointV1 } from "./types.ts";
import { validateSessionCheckpoint } from "./types.ts";

export type RecoveryDispatchInputPg = {
  runId: string;
  failedTaskId: string;
  plan: RecoveryExecutionPlan;
  executorProvider: ExecutorProvider;
  runRoot?: string;
  callbackUrl: string;
  heartbeatUrl?: string;
  contextRefreshUrl?: string;
  harnessEndpoint?: string;
};

export type RecoveryDispatchResultPg = {
  recoveryExecutionId: string;
  externalJobId: string;
  targetTaskIds: string[];
  attemptId: string;
};

export async function dispatchRecoveryExecutionPg(db: SouthstarDb, input: RecoveryDispatchInputPg): Promise<RecoveryDispatchResultPg> {
  const workflow = await readWorkflowManifest(db, input.runId);
  const attemptId = `attempt-${input.plan.attemptNumber}`;
  const targetTaskIds = [...input.plan.targetTaskIds];
  if (targetTaskIds.length === 0) throw new Error(`recovery plan for ${input.failedTaskId} has no target tasks`);
  const targetSet = new Set(targetTaskIds);
  const subsetWorkflow = workflowForRecoveryTargets(workflow, targetSet, input);
  if (subsetWorkflow.tasks.length !== targetTaskIds.length) throw new Error(`recovery plan references unknown target task(s): ${targetTaskIds.join(",")}`);

  const checkpointId = await createRecoveryCheckpointPg(db, {
    runId: input.runId,
    taskId: input.failedTaskId,
    sessionId: await currentSessionId(db, input.runId, input.failedTaskId),
    strategy: input.plan.strategy,
    reason: input.plan.reason,
    attemptNumber: input.plan.attemptNumber,
  });

  for (const task of subsetWorkflow.tasks) {
    const baseEnvelope = await getPostgresTaskEnvelope(db, { runId: input.runId, taskId: task.id });
    const sessionId = `root-${input.runId}-${task.id}-recovery-${input.plan.attemptNumber}`;
    const contextPacket = {
      ...baseEnvelope.contextPacket,
      id: `ctx-${input.runId}-${task.id}-recovery-${input.plan.attemptNumber}`,
      rootSessionId: sessionId,
      executionAttempt: input.plan.attemptNumber,
      checkpointSummary: {
        id: checkpointId,
        sourceType: "checkpoint" as const,
        title: "Recovery checkpoint",
        text: `Recovery attempt ${input.plan.attemptNumber}: ${input.plan.reason}`,
        sourceRef: checkpointId,
        tokenEstimate: estimateTokens(input.plan.reason),
      },
      workspaceSummary: {
        id: `workspace-${input.runId}-${task.id}-recovery-${input.plan.attemptNumber}`,
        sourceType: "workspace" as const,
        title: "Recovery workspace",
        text: "Recovery reruns this workflow slice from persisted Southstar context and checkpoint state.",
        tokenEstimate: 14,
      },
    };
    const envelope = buildTaskEnvelopeV2({
      ...baseEnvelope,
      contextPacket,
      session: {
        ...baseEnvelope.session,
        sessionId,
        baseCheckpointId: checkpointId,
      },
    });
    await upsertRuntimeResourcePg(db, {
      id: contextPacket.id,
      resourceType: "context_packet",
      resourceKey: contextPacket.id,
      runId: input.runId,
      taskId: task.id,
      sessionId,
      scope: task.domain,
      status: "created",
      title: "Recovery context packet",
      payload: contextPacket,
      summary: { checkpointId, executionAttempt: input.plan.attemptNumber },
    });
    const envelopeId = `task-envelope-${input.runId}-${task.id}-recovery-${input.plan.attemptNumber}`;
    await upsertRuntimeResourcePg(db, {
      id: envelopeId,
      resourceType: "task_envelope",
      resourceKey: envelopeId,
      runId: input.runId,
      taskId: task.id,
      sessionId,
      scope: task.domain,
      status: "created",
      title: "Recovery TaskEnvelopeV2",
      payload: envelope,
      summary: { schemaVersion: envelope.schemaVersion, contextPacketId: contextPacket.id, checkpointId },
    });
    await resetTaskForRecovery(db, input.runId, task.id, sessionId);
  }

  const submission = await input.executorProvider.submit({
    runId: input.runId,
    workflow: subsetWorkflow,
    callbackUrl: input.callbackUrl,
    heartbeatUrl: input.heartbeatUrl,
    attemptId,
  });

  for (const task of subsetWorkflow.tasks) {
    await createExecutorBindingPg(db, {
      runId: input.runId,
      taskId: task.id,
      attemptId,
      torkJobId: submission.externalJobId,
      status: submission.status === "queued" ? "queued" : "submitted",
      queueTimeoutSeconds: 120,
      hardTimeoutSeconds: task.execution.timeoutSeconds,
    });
  }

  const recoveryExecutionId = `recovery-execution-${input.runId}-${input.failedTaskId}-${attemptId}`;
  await upsertRuntimeResourcePg(db, {
    id: recoveryExecutionId,
    resourceType: "recovery_execution",
    resourceKey: recoveryExecutionId,
    runId: input.runId,
    taskId: input.failedTaskId,
    scope: "recovery",
    status: "submitted",
    title: `Recovery execution ${attemptId}`,
    payload: {
      runId: input.runId,
      failedTaskId: input.failedTaskId,
      targetTaskIds,
      attemptId,
      strategy: input.plan.strategy,
      externalJobId: submission.externalJobId,
      projectionFingerprint: submission.projectionFingerprint,
      executionProjection: submission.executionProjection,
      baseCheckpointId: checkpointId,
    },
    summary: { targetTaskIds, attemptId, strategy: input.plan.strategy, externalJobId: submission.externalJobId },
  });
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.failedTaskId,
    eventType: "recovery.execution_submitted",
    actorType: "orchestrator",
    payload: { recoveryExecutionId, targetTaskIds, attemptId, strategy: input.plan.strategy, externalJobId: submission.externalJobId, checkpointId },
  });

  return { recoveryExecutionId, externalJobId: submission.externalJobId, targetTaskIds, attemptId };
}

async function readWorkflowManifest(db: SouthstarDb, runId: string): Promise<SouthstarWorkflowManifest> {
  const row = await db.maybeOne<{ workflow_manifest_json: SouthstarWorkflowManifest }>("select workflow_manifest_json from southstar.workflow_runs where id = $1", [runId]);
  if (!row) throw new Error(`workflow run not found: ${runId}`);
  return row.workflow_manifest_json;
}

function workflowForRecoveryTargets(workflow: SouthstarWorkflowManifest, targetSet: Set<string>, input: Pick<RecoveryDispatchInputPg, "contextRefreshUrl" | "harnessEndpoint" | "runRoot">): SouthstarWorkflowManifest {
  return {
    ...workflow,
    tasks: workflow.tasks.filter((task) => targetSet.has(task.id)).map((task) => ({
      ...task,
      dependsOn: task.dependsOn.filter((dependency) => targetSet.has(dependency)),
      execution: {
        ...task.execution,
        env: {
          ...task.execution.env,
          SOUTHSTAR_RECOVERY_ATTEMPT: "true",
          ...(input.runRoot ? { SOUTHSTAR_MATERIALIZATION_ROOT: input.runRoot } : {}),
          ...(input.contextRefreshUrl ? { SOUTHSTAR_CONTEXT_REFRESH_URL: input.contextRefreshUrl } : {}),
          ...(input.harnessEndpoint ? { SOUTHSTAR_HARNESS_ENDPOINT: input.harnessEndpoint } : {}),
        },
      },
    })),
  };
}

async function createRecoveryCheckpointPg(db: SouthstarDb, input: {
  runId: string;
  taskId: string;
  sessionId: string;
  strategy: RecoveryStrategy;
  reason: string;
  attemptNumber: number;
}): Promise<string> {
  const checkpointId = `checkpoint-${input.runId}-${input.taskId}-before-recovery-${input.attemptNumber}`;
  const checkpoint = validateSessionCheckpoint({
    schemaVersion: "southstar.session-checkpoint.v1",
    checkpointId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    kind: "before-recovery",
    createdBy: "orchestrator",
    artifactRefs: [],
    evidencePacketRefs: [],
    validatorResultRefs: [],
    summaries: {
      checkpointSummary: `Recovery strategy ${input.strategy}: ${input.reason}`,
      decisions: [`attempt ${input.attemptNumber}`, input.strategy],
      filesTouched: [],
      filesInspected: [],
      nextAttemptHint: "Use compact persisted context and avoid repeating the failing approach.",
    },
    tokenTelemetry: {
      contextTokenEstimate: estimateTokens(input.reason),
      checkpointSummaryTokenEstimate: estimateTokens(input.reason),
    },
    policy: {
      safeForAutoRetry: input.strategy === "retry-same-agent",
      safeForFork: input.strategy === "fork-from-checkpoint",
      safeForReset: input.strategy === "reset-from-checkpoint" || input.strategy === "retry-same-agent",
      safeForWorkspaceRollback: input.strategy === "rollback-workspace",
    },
  });
  await upsertRuntimeResourcePg(db, {
    id: checkpointId,
    resourceType: "session_checkpoint",
    resourceKey: checkpointId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "session",
    status: "created",
    title: "before-recovery checkpoint",
    payload: checkpoint,
    summary: { kind: checkpoint.kind, checkpointSummary: checkpoint.summaries.checkpointSummary, tokenTelemetry: checkpoint.tokenTelemetry },
  });
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "checkpoint.created",
    actorType: "orchestrator",
    payload: { checkpointId, kind: "before-recovery" },
  });
  return checkpointId;
}

async function currentSessionId(db: SouthstarDb, runId: string, taskId: string): Promise<string> {
  const row = await db.maybeOne<{ root_session_id: string | null }>("select root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2", [runId, taskId]);
  if (!row) throw new Error(`task not found: ${runId}/${taskId}`);
  return row.root_session_id ?? `root-${runId}-${taskId}`;
}

async function resetTaskForRecovery(db: SouthstarDb, runId: string, taskId: string, sessionId: string): Promise<void> {
  await db.query(
    "update southstar.workflow_tasks set status = 'running', root_session_id = $1, updated_at = now(), completed_at = null where run_id = $2 and id = $3",
    [sessionId, runId, taskId],
  );
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.4));
}
