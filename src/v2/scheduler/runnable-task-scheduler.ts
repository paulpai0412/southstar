import type { BrainProvider } from "../brain/types.ts";
import { createDefaultTaskExecutionIntent } from "../brain/task-intent.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";
import type { HandBinding, HandExecutionPayload, HandProvider } from "../hands/types.ts";
import { acceptedArtifactTaskIdsForRunPg } from "../artifacts/artifact-ref-store.ts";
import { createManagedContextAssembler } from "../context/managed-context-assembler.ts";
import { persistBrainBindingPg, persistHandBindingPg } from "../meta-harness/postgres-bindings.ts";
import type { SessionStore } from "../session/types.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { enforcePreExecutionToolProxyPolicyPg, isPreExecutionToolProxyPolicyError } from "../tool-proxy/runtime-enforcement.ts";
import { observeDispatchPreparationException, redactProviderErrorExcerpt } from "./dispatch-preparation-exception.ts";
import type { RunnableTaskSchedulerRunInput, RunnableTaskSchedulerRunResult } from "./types.ts";

export type { RunnableTaskSchedulerRunInput, RunnableTaskSchedulerRunResult } from "./types.ts";

export type RunnableTaskSchedulerDeps = {
  sessionStore: SessionStore;
  brainProvider: BrainProvider;
  handProvider: HandProvider;
};

type TaskRow = {
  id: string;
  status: string;
  sort_order: number;
  depends_on_json: unknown;
  root_session_id: string | null;
};

type ExistingHistoryRow = {
  id: string;
  run_id: string;
  sequence: number;
};

type HandExecutionAttemptRow = {
  resource_key: string;
  attempt_id: string | null;
};

export function createRunnableTaskScheduler(db: SouthstarDb, deps: RunnableTaskSchedulerDeps): {
  runOnce(input: RunnableTaskSchedulerRunInput): Promise<RunnableTaskSchedulerRunResult>;
} {
  return {
    async runOnce(input) {
      const run = await db.maybeOne<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
        "select workflow_manifest_json from southstar.workflow_runs where id = $1",
        [input.runId],
      );
      if (!run) throw new Error(`run not found: ${input.runId}`);

      const tasks = await db.query<TaskRow>(
        `select id, status, sort_order, depends_on_json, root_session_id
           from southstar.workflow_tasks
          where run_id = $1
          order by sort_order, id`,
        [input.runId],
      );
      const acceptedArtifactTaskIds = await acceptedArtifactTaskIdsForRunPg(db, input.runId);
      const maxParallelTasks = maxParallelTasksForManifest(run.workflow_manifest_json);
      const result: RunnableTaskSchedulerRunResult = { runId: input.runId, dispatchedTaskIds: [], skippedTaskIds: [] };

      for (const task of tasks.rows) {
        if (task.status !== "pending") {
          result.skippedTaskIds.push({ taskId: task.id, reason: `status:${task.status}` });
          continue;
        }

        if (!dependenciesReady(dependsOn(task), acceptedArtifactTaskIds)) {
          result.skippedTaskIds.push({ taskId: task.id, reason: "dependencies-not-accepted" });
          continue;
        }

        const sessionId = task.root_session_id ?? `root-${input.runId}-${task.id}`;
        const claim = await claimRunnableTask(db, {
          runId: input.runId,
          taskId: task.id,
          sessionId,
          maxParallelTasks,
        });
        if (claim !== "claimed") {
          result.skippedTaskIds.push({ taskId: task.id, reason: claim });
          continue;
        }

        await dispatchTask(db, deps, {
          runId: input.runId,
          taskId: task.id,
          sessionId,
          manifest: run.workflow_manifest_json,
          dependsOn: dependsOn(task),
        });
        result.dispatchedTaskIds.push(task.id);
      }

      return result;
    },
  };
}

async function dispatchTask(
  db: SouthstarDb,
  deps: RunnableTaskSchedulerDeps,
  input: { runId: string; taskId: string; sessionId: string; manifest: SouthstarWorkflowManifest; dependsOn: string[] },
): Promise<void> {
  const attemptId = await nextDispatchAttemptId(db, input.runId, input.taskId);
  const baseRecoveryKey = `task-dispatch:${input.runId}:${input.taskId}`;
  const recoveryKey = attemptId === firstDispatchAttemptId(input.taskId) ? baseRecoveryKey : `${baseRecoveryKey}:${attemptId}`;
  const handExecutionId = `hand-execution:${input.runId}:${input.taskId}:${attemptId}`;
  const queueTimeoutSeconds = 120;
  const heartbeatTimeoutSeconds = 60;
  let contextPacketId = `context-${input.runId}-${input.taskId}`;
  let taskEnvelopeId = "";
  let taskStartCheckpointId = "";
  let brainBindingId = "";
  let handBindingId = "";
  let handAccepted = false;
  let handRejected = false;

  try {
    const checkpointRefs = await latestSessionRecoveryCheckpointRefsForTask(db, {
      runId: input.runId,
      taskId: input.taskId,
    });
    const assembler = createManagedContextAssembler(db);
    const assembly = await assembler.buildForTask({
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId,
      handExecutionId,
      dependsOn: input.dependsOn,
      checkpointRefs,
    });
    contextPacketId = assembly.contextPacket.id;
    taskEnvelopeId = assembly.taskEnvelopeId;

    const taskStartCheckpoint = await deps.sessionStore.createCheckpoint({
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      resourceKey: `checkpoint:${input.runId}:${input.taskId}:${attemptId}:task-start`,
      checkpointType: "task-start",
      summary: `Task ${input.taskId} start for ${attemptId}`,
      eventRange: { fromSequence: 0, toSequence: 0 },
      refs: {
        contextPacketIds: [contextPacketId],
        taskEnvelopeIds: [taskEnvelopeId],
        artifactRefs: assembly.contextPacket.priorArtifacts
          .map((block) => block.sourceRef)
          .filter((value): value is string => Boolean(value)),
      },
      metrics: { tokenEstimate: assembly.contextPacket.tokenEstimate.total },
    });
    taskStartCheckpointId = taskStartCheckpoint.id;

    brainBindingId = await ensureBrainBinding(db, deps, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      contextPacketId,
      recoveryKey,
      effortPolicy: effortPolicyForBrain(input.manifest),
    });
    await emitSessionEventOnce(db, deps.sessionStore, {
      eventType: "brain.woke",
      actorType: "orchestrator",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      idempotencyKey: `${recoveryKey}:brain-woke`,
      payload: { brainBindingId, contextPacketId },
    });

    const handBinding = await ensureHandBinding(db, deps, {
      runId: input.runId,
      taskId: input.taskId,
      recoveryKey,
    });
    handBindingId = handBinding.id;
    await emitSessionEventOnce(db, deps.sessionStore, {
      eventType: "hand.provisioned",
      actorType: "orchestrator",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      idempotencyKey: `${recoveryKey}:hand-provisioned`,
      payload: { handBindingId, handName: "workspace" },
    });

    const acceptedInputArtifactRefs = await acceptedArtifactRefsForDependencies(db, input.runId, input.dependsOn);
    const toolProxyPolicyRef = `tool-proxy-policy:${input.runId}:${input.sessionId}`;
    const intent = createDefaultTaskExecutionIntent({
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      contextPacketId,
      attemptId,
      expectedArtifactContracts: ["task_result"],
      allowedToolNames: [],
      toolProxyPolicyRef,
      handProviderId: deps.handProvider.providerId,
      instructionsRef: contextPacketId,
      inputArtifactRefs: acceptedInputArtifactRefs,
    });
    await enforcePreExecutionToolProxyPolicyPg(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      handExecutionId,
      value: {
        intent,
        acceptedInputArtifactRefs,
        toolProxyPolicyRef,
        contextPacketId,
      },
    });
    const intentResourceKey = `task-intent:${input.runId}:${input.taskId}:${attemptId}`;
    await upsertRuntimeResourcePg(db, {
      id: intentResourceKey,
      resourceType: "task_execution_intent",
      resourceKey: intentResourceKey,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      scope: "task",
      status: "created",
      title: `Task execution intent ${input.taskId}`,
      payload: intent,
      summary: { handProviderId: intent.handProviderId, expectedArtifactContracts: intent.expectedArtifactContracts },
      metrics: {},
    });
    await appendHistoryEventOnce(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      eventType: "brain.intent_created",
      actorType: "brain",
      idempotencyKey: `${recoveryKey}:brain-intent-created`,
      payload: { attemptId, handExecutionId, intentResourceKey },
    });

    if (!deps.handProvider.executeTask) throw new Error(`hand provider ${deps.handProvider.providerId} does not support executeTask`);

    const handResult = await deps.handProvider.executeTask(handBinding, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId,
      handExecutionId,
      brainBindingId,
      handBindingId,
      intent,
      contextPacketRef: contextPacketId,
      acceptedInputArtifactRefs,
      toolProxyPolicyRef,
      workflow: input.manifest,
      queueTimeoutSeconds,
      heartbeatTimeoutSeconds,
    });
    if (!handResult.ok) {
      handRejected = true;
      await persistHandBindingPg(db, handBinding);
      await markTaskDispatchFailed(db, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        attemptId,
        handExecutionId,
        brainBindingId,
        handBindingId,
        providerId: deps.handProvider.providerId,
        queueTimeoutSeconds,
        heartbeatTimeoutSeconds,
        recoveryKey,
        errorMessage: handResult.output,
      });
      throw new Error(handResult.output);
    }
    handAccepted = true;
    await persistHandBindingPg(db, handBinding);

    const externalJobId = stringValue(handResult.metadata.externalJobId) ?? handResult.output;
    await persistHandExecution(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId,
      brainBindingId,
      handBindingId,
      handExecutionId,
      providerId: deps.handProvider.providerId,
      status: "queued",
      externalJobId,
      queueTimeoutSeconds,
      heartbeatTimeoutSeconds,
    });
    await db.query("update southstar.workflow_tasks set status = 'queued', updated_at = now() where run_id = $1 and id = $2", [input.runId, input.taskId]);
    await appendHistoryEventOnce(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      eventType: "hand.execute_queued",
      actorType: "hand",
      idempotencyKey: `${recoveryKey}:hand-execute-queued`,
      payload: { attemptId, handExecutionId, externalJobId, taskStartCheckpointId },
    });
    await appendHistoryEventOnce(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      eventType: "task.dispatch_submitted",
      actorType: "orchestrator",
      idempotencyKey: `${recoveryKey}:dispatch-submitted`,
      payload: { brainBindingId, handBindingId, contextPacketId, taskEnvelopeId, taskStartCheckpointId, attemptId, handExecutionId },
    });
  } catch (error) {
    const dispatchErrorMessage = errorMessage(error);
    if (isPreExecutionToolProxyPolicyError(error)) {
      await blockTaskDispatchPreparation(db, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        recoveryKey,
        errorMessage: dispatchErrorMessage,
      });
      throw error;
    }
    if (handAccepted || handRejected) throw error;
    await observeDispatchPreparationException(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId,
      recoveryKey,
      errorMessage: dispatchErrorMessage,
    });
    await releaseTaskDispatchPreparation(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      recoveryKey,
      errorMessage: dispatchErrorMessage,
    });
    throw error;
  }
}

async function latestSessionRecoveryCheckpointRefsForTask(
  db: SouthstarDb,
  input: { runId: string; taskId: string },
): Promise<string[]> {
  const rows = await db.query<{ payload_json: unknown }>(
    `select payload_json
       from southstar.runtime_resources
      where run_id = $1
        and task_id = $2
        and resource_type = any($3::text[])
        and status = 'succeeded'
      order by updated_at desc, created_at desc, resource_key desc
      limit 1`,
    [input.runId, input.taskId, ["session_fork", "session_reset", "session_rollback"]],
  );
  const checkpointId = stringValue(asRecord(rows.rows[0]?.payload_json).checkpointId);
  return checkpointId ? [checkpointId] : [];
}

async function nextDispatchAttemptId(db: SouthstarDb, runId: string, taskId: string): Promise<string> {
  const rows = await db.query<HandExecutionAttemptRow>(
    `select resource_key, payload_json ->> 'attemptId' as attempt_id
       from southstar.runtime_resources
      where resource_type = 'hand_execution'
        and run_id = $1
        and task_id = $2`,
    [runId, taskId],
  );
  let maxAttemptNumber = 0;
  for (const row of rows.rows) {
    maxAttemptNumber = Math.max(
      maxAttemptNumber,
      attemptNumber(row.attempt_id),
      attemptNumber(row.resource_key),
    );
  }
  const nextAttemptNumber = maxAttemptNumber > 0 ? maxAttemptNumber + 1 : rows.rows.length + 1;
  return dispatchAttemptId(taskId, nextAttemptNumber);
}

async function claimRunnableTask(
  db: SouthstarDb,
  input: { runId: string; taskId: string; sessionId: string; maxParallelTasks: number },
): Promise<"claimed" | "parallel-limit" | "status-changed"> {
  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const task = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [input.runId, input.taskId],
    );
    if (!task || task.status !== "pending") return "status-changed";

    const active = await tx.one<{ running_count: number | string }>(
      "select count(*) as running_count from southstar.workflow_tasks where run_id = $1 and status in ('claimed', 'queued', 'running')",
      [input.runId],
    );
    if (Number(active.running_count) >= input.maxParallelTasks) return "parallel-limit";

    await tx.query(
      "update southstar.workflow_tasks set status = 'claimed', root_session_id = $1, updated_at = now() where run_id = $2 and id = $3",
      [input.sessionId, input.runId, input.taskId],
    );
    return "claimed";
  });
}

async function ensureBrainBinding(
  db: SouthstarDb,
  deps: RunnableTaskSchedulerDeps,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    contextPacketId: string;
    recoveryKey: string;
    effortPolicy: { complexity: "simple" | "standard" | "broad" | "deep"; maxToolCallsPerTask: number };
  },
): Promise<string> {
  const existing = await firstBindingId(db, "brain_binding", input.runId, input.taskId);
  if (existing) return existing;
  const binding = await deps.brainProvider.wake({
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    contextPacketId: input.contextPacketId,
    recoveryKey: input.recoveryKey,
    effortPolicy: input.effortPolicy,
  });
  await persistBrainBindingPg(db, binding);
  return binding.id;
}

async function ensureHandBinding(
  db: SouthstarDb,
  deps: RunnableTaskSchedulerDeps,
  input: { runId: string; taskId: string; recoveryKey: string },
): Promise<HandBinding> {
  const existing = await latestProvisionedHandBinding(db, input.runId, input.taskId);
  if (existing) return existing;
  const binding = await deps.handProvider.provision({
    runId: input.runId,
    taskId: input.taskId,
    handName: "workspace",
    resources: {},
    recoveryKey: input.recoveryKey,
  });
  await persistHandBindingPg(db, binding);
  return binding;
}

async function acceptedArtifactRefsForDependencies(db: SouthstarDb, runId: string, dependencyTaskIds: string[]): Promise<string[]> {
  if (dependencyTaskIds.length === 0) return [];
  const rows = await db.query<{ task_id: string; resource_key: string; payload_json: unknown }>(
    `select task_id, resource_key, payload_json
       from southstar.runtime_resources
      where resource_type = 'artifact_ref'
        and run_id = $1
        and task_id = any($2::text[])
        and status = 'accepted'
      order by created_at, resource_key`,
    [runId, dependencyTaskIds],
  );
  const byTaskId = new Map<string, string[]>();
  for (const row of rows.rows) {
    const payload = asRecord(row.payload_json);
    const ref = stringValue(payload.ref) ?? row.resource_key;
    const refs = byTaskId.get(row.task_id) ?? [];
    refs.push(ref);
    byTaskId.set(row.task_id, refs);
  }
  return dependencyTaskIds.flatMap((taskId) => byTaskId.get(taskId) ?? []);
}

async function latestProvisionedHandBinding(db: SouthstarDb, runId: string, taskId: string): Promise<HandBinding | null> {
  const row = await db.maybeOne<{ id: string; status: string; payload_json: unknown; created_at: Date | string }>(
    `select id, status, payload_json, created_at
       from southstar.runtime_resources
      where resource_type = 'hand_binding'
        and run_id = $1
        and task_id = $2
        and status = 'provisioned'
      order by created_at desc
      limit 1`,
    [runId, taskId],
  );
  if (!row) return null;
  const payload = asRecord(row.payload_json);
  return {
    id: row.id,
    providerId: stringValue(payload.providerId) ?? "tork",
    runId,
    taskId,
    handName: stringValue(payload.handName) ?? "workspace",
    status: row.status as HandBinding["status"],
    createdAt: new Date(row.created_at).toISOString(),
    payload,
  };
}

async function persistHandExecution(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    handExecutionId: string;
    providerId: string;
    brainBindingId: string;
    handBindingId: string;
    status: HandExecutionPayload["status"];
    externalJobId?: string;
    queueTimeoutSeconds: number;
    heartbeatTimeoutSeconds: number;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const payload: HandExecutionPayload = {
    schemaVersion: "southstar.runtime.hand_execution.v1",
    handExecutionId: input.handExecutionId,
    providerId: input.providerId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    brainBindingId: input.brainBindingId,
    handBindingId: input.handBindingId,
    externalJobId: input.externalJobId,
    status: input.status,
    queuedAt: now,
    queueTimeoutSeconds: input.queueTimeoutSeconds,
    heartbeatTimeoutSeconds: input.heartbeatTimeoutSeconds,
    ...(input.status === "failed" ? { terminalAt: now } : {}),
  };
  await upsertRuntimeResourcePg(db, {
    id: input.handExecutionId,
    resourceType: "hand_execution",
    resourceKey: input.handExecutionId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "hand",
    status: input.status,
    title: `Hand execution ${input.taskId}`,
    payload,
    summary: { providerId: input.providerId, attemptId: input.attemptId },
    metrics: {},
  });
}

async function markTaskDispatchFailed(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    handExecutionId: string;
    providerId: string;
    brainBindingId: string;
    handBindingId: string;
    queueTimeoutSeconds: number;
    heartbeatTimeoutSeconds: number;
    recoveryKey: string;
    errorMessage: string;
  },
): Promise<void> {
  await persistHandExecution(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    handExecutionId: input.handExecutionId,
    providerId: input.providerId,
    brainBindingId: input.brainBindingId,
    handBindingId: input.handBindingId,
    status: "failed",
    queueTimeoutSeconds: input.queueTimeoutSeconds,
    heartbeatTimeoutSeconds: input.heartbeatTimeoutSeconds,
  });
  const controller = createRuntimeExceptionController({ db });
  const exception = await controller.observe({
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    handExecutionId: input.handExecutionId,
    brainBindingId: input.brainBindingId,
    handBindingId: input.handBindingId,
    source: "scheduler",
    kind: "hand_submit_failed",
    severity: "recoverable",
    observedAt: new Date().toISOString(),
    evidenceRefs: [input.handExecutionId],
    providerEvidence: { errorExcerpt: redactProviderErrorExcerpt(input.errorMessage) },
  });
  await controller.decide(await controller.classify(exception));
  await db.query("update southstar.workflow_tasks set status = 'failed', updated_at = now(), completed_at = coalesce(completed_at, now()) where run_id = $1 and id = $2 and status = 'claimed'", [input.runId, input.taskId]);
  await appendHistoryEventOnce(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "hand.execute_failed",
    actorType: "hand",
    idempotencyKey: `${input.recoveryKey}:hand-execute-failed`,
    payload: { attemptId: input.attemptId, handExecutionId: input.handExecutionId, error: input.errorMessage },
  });
}

async function blockTaskDispatchPreparation(
  db: SouthstarDb,
  input: { runId: string; taskId: string; sessionId: string; recoveryKey: string; errorMessage: string },
): Promise<void> {
  await db.query(
    "update southstar.workflow_tasks set status = 'blocked', updated_at = now(), completed_at = coalesce(completed_at, now()) where run_id = $1 and id = $2 and status = 'claimed'",
    [input.runId, input.taskId],
  );
  await appendHistoryEventOnce(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "task.dispatch_blocked",
    actorType: "orchestrator",
    idempotencyKey: `${input.recoveryKey}:dispatch-blocked`,
    payload: { reason: "tool_proxy_violation", error: input.errorMessage },
  });
}

async function releaseTaskDispatchPreparation(
  db: SouthstarDb,
  input: { runId: string; taskId: string; sessionId: string; recoveryKey: string; errorMessage: string },
): Promise<void> {
  await db.query(
    "update southstar.workflow_tasks set status = 'pending', updated_at = now() where run_id = $1 and id = $2 and status = 'claimed'",
    [input.runId, input.taskId],
  );
  await appendHistoryEventOnce(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "task.dispatch_prepare_failed",
    actorType: "orchestrator",
    idempotencyKey: `${input.recoveryKey}:dispatch-prepare-failed`,
    payload: { error: input.errorMessage },
  });
}

async function emitSessionEventOnce(
  db: SouthstarDb,
  sessionStore: SessionStore,
  event: Parameters<SessionStore["emitEvent"]>[0],
): Promise<void> {
  const existing = event.idempotencyKey ? await historyEventByIdempotencyKey(db, event.runId, event.idempotencyKey) : null;
  if (existing) return;
  try {
    await sessionStore.emitEvent(event);
  } catch (error) {
    if (event.idempotencyKey && isUniqueViolation(error)) return;
    throw error;
  }
}

async function appendHistoryEventOnce(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    eventType: string;
    actorType: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const existing = await historyEventByIdempotencyKey(db, input.runId, input.idempotencyKey);
  if (existing) return;
  try {
    await appendHistoryEventPg(db, input);
  } catch (error) {
    if (isUniqueViolation(error)) return;
    throw error;
  }
}

async function firstBindingId(db: SouthstarDb, resourceType: "brain_binding" | "hand_binding", runId: string, taskId: string): Promise<string | null> {
  const row = await db.maybeOne<{ id: string }>(
    `select id
       from southstar.runtime_resources
      where resource_type = $1
        and run_id = $2
        and task_id = $3
      order by created_at
      limit 1`,
    [resourceType, runId, taskId],
  );
  return row?.id ?? null;
}

async function historyEventByIdempotencyKey(db: SouthstarDb, runId: string, idempotencyKey: string): Promise<ExistingHistoryRow | null> {
  return await db.maybeOne<ExistingHistoryRow>(
    "select id, run_id, sequence from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [runId, idempotencyKey],
  );
}

function dependenciesReady(dependsOn: string[], acceptedArtifactTaskIds: Set<string>): boolean {
  return dependsOn.every((dependencyTaskId) => acceptedArtifactTaskIds.has(dependencyTaskId));
}

function dependsOn(task: TaskRow): string[] {
  return Array.isArray(task.depends_on_json) && task.depends_on_json.every((item) => typeof item === "string")
    ? task.depends_on_json
    : [];
}

function maxParallelTasksForManifest(manifest: SouthstarWorkflowManifest): number {
  const value = manifest.effortPolicy?.maxParallelTasks;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function effortPolicyForBrain(manifest: SouthstarWorkflowManifest): {
  complexity: "simple" | "standard" | "broad" | "deep";
  maxToolCallsPerTask: number;
} {
  const complexity = manifest.effortPolicy?.complexity;
  return {
    complexity: complexity === "simple" || complexity === "standard" || complexity === "broad" || complexity === "deep"
      ? complexity
      : "standard",
    maxToolCallsPerTask: validPositiveInteger(manifest.effortPolicy?.maxToolCallsPerTask) ?? 10,
  };
}

function validPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function firstDispatchAttemptId(taskId: string): string {
  return dispatchAttemptId(taskId, 1);
}

function dispatchAttemptId(taskId: string, attemptNumberValue: number): string {
  return `${taskId}-attempt-${attemptNumberValue}`;
}

function attemptNumber(value: string | null | undefined): number {
  const matches = [...(value ?? "").matchAll(/(?:^|-)attempt-(\d+)(?=$|[:_-])/g)];
  const match = matches[matches.length - 1];
  if (!match?.[1]) return 0;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}
