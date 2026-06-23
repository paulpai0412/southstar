import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
import { writeRunLocalMemoryPg } from "../../../src/v2/memory/postgres-memory-service.ts";
import type { SouthstarWorkflowManifest } from "../../../src/v2/manifests/types.ts";
import { createPostgresSessionStore } from "../../../src/v2/session/postgres-session-store.ts";
import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
  type RuntimeResourceRecord,
  updateWorkflowManifestPg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  dockerReachableUrl,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
  waitForTorkJob,
} from "../postgres-real-harness.ts";
import {
  createRealRecoveryScheduler,
  firstAttemptId,
  latestHandExecutionForTask,
  waitForHandExecutionStatus,
} from "../recovery-scheduler-helpers.ts";

type ContextPacketPayload = {
  id?: string;
  executionAttempt?: number;
  priorArtifacts?: unknown[];
  checkpointSummary?: { sourceRef?: string };
  selectedMemories?: Array<{ sourceRef?: string }>;
  managedSourceRefs?: {
    artifactRefs?: string[];
    checkpointRefs?: string[];
    memoryRefs?: string[];
  };
};

type TaskEnvelopePayload = {
  envelope?: {
    contextPacket?: { id?: string };
    session?: { baseCheckpointId?: string };
  };
};

test("26 abnormal context/session/memory recovery: validator failure rebuilds producer context through real Tork/Pi", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const runId = "real-abnormal-context-session-memory-recovery";
    const producerTaskId = "produce-context-artifact";
    const taskId = "repair-context-artifact";
    await seedRun(env.db, { runId, producerTaskId, consumerTaskId: taskId });

    const scheduler = createRealRecoveryScheduler(env.db, {
      infra,
      callbackBase: dockerReachableUrl(server, infra),
    });

    const initialAttemptId = firstAttemptId(taskId);
    const firstDispatch = await scheduler.runOnce({ runId });
    assert.deepEqual(firstDispatch.dispatchedTaskIds, [producerTaskId]);

    const producerHand = await latestHandExecutionForTask(env.db, { runId, taskId: producerTaskId });
    assert.doesNotMatch(producerHand.externalJobId, /^seeded-/);
    await waitForTorkJob(infra.torkBaseUrl, producerHand.externalJobId);
    const producerHandStatus = await waitForHandExecutionStatus(env.db, producerHand.resourceKey, ["completed", "failed"]);
    assert.equal(producerHandStatus, "completed");

    const producerTask = await taskRow(env.db, { runId, taskId: producerTaskId });
    assert.equal(producerTask.status, "completed");
    assert.ok(producerTask.root_session_id);

    const producerArtifact = await latestArtifact(env.db, {
      runId,
      taskId: producerTaskId,
      status: "accepted",
    });
    assert.equal((producerArtifact.payload as { handExecutionId?: string }).handExecutionId, producerHand.resourceKey);

    await updateConsumerRuntimeFault(env.db, {
      runId,
      producerTaskId,
      consumerTaskId: taskId,
      failedArtifactRef: producerArtifact.resourceKey,
    });

    const consumerDispatch = await scheduler.runOnce({ runId });
    assert.deepEqual(consumerDispatch.dispatchedTaskIds, [taskId]);

    const firstHand = await latestHandExecutionForTask(env.db, { runId, taskId });
    assert.equal(firstHand.attemptId, initialAttemptId);
    assert.doesNotMatch(firstHand.externalJobId, /^seeded-/);
    await waitForTorkJob(infra.torkBaseUrl, firstHand.externalJobId, undefined, ["failed"]);
    const firstHandStatus = await waitForHandExecutionStatus(env.db, firstHand.resourceKey, ["completed", "failed"]);
    assert.equal(firstHandStatus, "failed");

    const firstTask = await taskRow(env.db, { runId, taskId });
    assert.equal(firstTask.status, "failed");
    assert.ok(firstTask.root_session_id);

    const rejectedArtifact = await latestArtifact(env.db, {
      runId,
      taskId,
      status: "rejected",
    });
    assert.notEqual(rejectedArtifact.resourceKey, firstHand.resourceKey);
    assert.equal((rejectedArtifact.payload as { handExecutionId?: string }).handExecutionId, firstHand.resourceKey);
    assert.deepEqual((rejectedArtifact.payload as { failedArtifactRefs?: string[] }).failedArtifactRefs, [producerArtifact.resourceKey]);

    const repairMarker = await artifactRepairMarkerForArtifact(env.db, {
      runId,
      producerTaskId,
      artifactRefId: producerArtifact.resourceKey,
    });
    assert.equal(repairMarker.status, "open");
    assert.equal((repairMarker.payload as { consumerTaskId?: string }).consumerTaskId, taskId);
    assert.equal((repairMarker.payload as { rejectedArtifactRefId?: string }).rejectedArtifactRefId, rejectedArtifact.resourceKey);

    const checkpointResourceKey = `checkpoint:${runId}:${taskId}:before-recovery`;
    await createPostgresSessionStore(env.db).createCheckpoint({
      runId,
      taskId,
      sessionId: firstTask.root_session_id,
      resourceKey: checkpointResourceKey,
      checkpointType: "before-recovery",
      summary: "Validator failure checkpoint before resetting the producer session.",
      eventRange: { fromSequence: 0, toSequence: 0 },
      refs: {
        contextPacketIds: [],
        taskEnvelopeIds: [],
        artifactRefs: [rejectedArtifact.resourceKey],
      },
      metrics: {},
    });

    const memory = await writeRunLocalMemoryPg(env.db, {
      runId,
      taskId,
      sessionId: firstTask.root_session_id,
      scope: "software",
      kind: "failure_lesson",
      text: "abnormal managed context memory: retry must include checkpoint and rejected validation evidence for command proof",
      tags: ["abnormal", "managed", "context", "memory", "recovery"],
      sourceRefs: [rejectedArtifact.resourceKey, checkpointResourceKey],
      confidence: 1,
      successScore: 0.8,
    });
    const memoryRef = `memory_item:${memory.id}`;

    const controller = createRuntimeExceptionController({ db: env.db });
    const exception = await controller.observe({
      runId,
      taskId,
      sessionId: firstTask.root_session_id,
      attemptId: initialAttemptId,
      handExecutionId: firstHand.resourceKey,
      source: "callback",
      kind: "validation_failed",
      severity: "recoverable",
      observedAt: "2026-06-22T02:01:00.000Z",
      evidenceRefs: [checkpointResourceKey, rejectedArtifact.resourceKey, memoryRef],
      providerEvidence: {
        rejectedArtifactRef: rejectedArtifact.resourceKey,
        checkpointRef: checkpointResourceKey,
      },
    });
    const decision = await controller.decide(await controller.classify(exception));
    assert.equal(decision.payload.path, "reset-session");
    assert.equal(decision.payload.evidenceRefs.includes(checkpointResourceKey), true);

    const applied = await api<{ status: string }>(
      server.port,
      `/api/v2/runs/${encodeURIComponent(runId)}/recovery-decisions/${encodeURIComponent(decision.decisionId)}/apply`,
      { method: "POST", body: JSON.stringify({}) },
    );
    assert.equal(applied.status, "applied");

    const releasedTask = await taskRow(env.db, { runId, taskId });
    assert.equal(releasedTask.status, "pending");
    assert.ok(releasedTask.root_session_id);
    assert.notEqual(releasedTask.root_session_id, firstTask.root_session_id);
    assert.match(releasedTask.root_session_id, new RegExp(`^root-${escapeRegExp(runId)}-${taskId}-reset-session-`));

    const resetResource = await latestResource(env.db, { runId, taskId, resourceType: "session_reset" });
    assert.equal(resetResource.status, "succeeded");
    assert.equal((resetResource.payload as { checkpointId?: string }).checkpointId, checkpointResourceKey);

    const secondDispatch = await scheduler.runOnce({ runId });
    assert.deepEqual(secondDispatch.dispatchedTaskIds, [taskId]);

    const retryContext = await latestContextPacket(env.db, { runId, taskId });
    assert.equal(retryContext.executionAttempt, 2);
    assert.equal((retryContext.priorArtifacts?.length ?? 0) > 0, true);
    assert.equal(retryContext.checkpointSummary?.sourceRef, checkpointResourceKey);
    assert.equal((retryContext.selectedMemories?.length ?? 0) > 0, true);
    assert.equal(retryContext.managedSourceRefs?.artifactRefs?.includes(producerArtifact.resourceKey), true);
    assert.equal(retryContext.managedSourceRefs?.checkpointRefs?.includes(checkpointResourceKey), true);
    assert.equal(retryContext.managedSourceRefs?.memoryRefs?.includes(memoryRef), true);

    const retryEnvelope = await latestTaskEnvelope(env.db, { runId, taskId });
    assert.equal(retryEnvelope.envelope?.session?.baseCheckpointId, checkpointResourceKey);
    assert.equal(retryEnvelope.envelope?.contextPacket?.id, retryContext.id);

    const secondHand = await latestHandExecutionForTask(env.db, { runId, taskId });
    assert.equal(secondHand.attemptId, `${taskId}-attempt-2`);
    await waitForTorkJob(infra.torkBaseUrl, secondHand.externalJobId);
    const secondHandStatus = await waitForHandExecutionStatus(env.db, secondHand.resourceKey, ["completed", "failed"]);
    assert.equal(secondHandStatus, "completed");

    const finalTask = await taskRow(env.db, { runId, taskId });
    assert.equal(finalTask.status, "completed");

    const retryAcceptedArtifact = await latestArtifact(env.db, {
      runId,
      taskId,
      status: "accepted",
    });
    assert.notEqual(retryAcceptedArtifact.resourceKey, rejectedArtifact.resourceKey);

    const rejectedArtifacts = artifactsForTask(await listResourcesPg(env.db, { resourceType: "artifact_ref" }), {
      runId,
      taskId,
      status: "rejected",
    });
    assert.equal(rejectedArtifacts.some((artifact) => artifact.resourceKey === rejectedArtifact.resourceKey), true);
    assert.equal(rejectedArtifacts.some((artifact) => {
      const payload = artifact.payload as { handExecutionId?: string };
      return payload.handExecutionId === firstHand.resourceKey;
    }), true);

    assert.equal((await latestResource(env.db, { runId, taskId, resourceType: "recovery_execution" })).status, "succeeded");
    assert.equal((await latestResource(env.db, { runId, taskId, resourceType: "runtime_exception" })).status, "resolved");

    const history = await listHistoryForRunPg(env.db, runId);
    for (const eventType of ["runtime.fault_injected", "checkpoint.created", "session.reset", "task.dispatch_submitted", "executor.callback_received"]) {
      assert.equal(history.some((event) => event.taskId === taskId && event.eventType === eventType), true);
    }
    assert.equal(history.some((event) => event.taskId === producerTaskId && event.eventType === "artifact.repair_marker_recorded"), true);
  } finally {
    await server.close();
    await env.close();
  }
});

async function seedRun(
  db: SouthstarDb,
  input: { runId: string; producerTaskId: string; consumerTaskId: string },
): Promise<void> {
  const manifest = workflowManifest(input);
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: "created",
    domain: "software",
    goalPrompt: "abnormal managed context session memory recovery",
    workflowManifestJson: JSON.stringify(manifest),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: input.producerTaskId,
    runId: input.runId,
    taskKey: input.producerTaskId,
    status: "pending",
    sortOrder: 1,
    dependsOn: [],
  });
  await createWorkflowTaskPg(db, {
    id: input.consumerTaskId,
    runId: input.runId,
    taskKey: input.consumerTaskId,
    status: "pending",
    sortOrder: 2,
    dependsOn: [input.producerTaskId],
  });
}

function workflowManifest(input: {
  producerTaskId: string;
  consumerTaskId: string;
  consumerFault?: { failedArtifactRef: string };
}): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-abnormal-context-session-memory-recovery",
    title: "Abnormal context session memory recovery",
    goalPrompt: "abnormal managed context session memory recovery",
    domain: "software",
    intent: "implement_feature",
    tasks: [
      workflowTask(input.producerTaskId, "Produce abnormal managed context artifact", []),
      workflowTask(input.consumerTaskId, "Repair abnormal managed context artifact", [input.producerTaskId], input.consumerFault),
    ],
    harnessDefinitions: [{
      id: "pi",
      kind: "pi-agent",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation_report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: [] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    effortPolicy: {
      complexity: "standard",
      maxBrains: 1,
      maxHandsPerBrain: 1,
      maxParallelTasks: 1,
      maxToolCallsPerTask: 10,
      maxInputTokensPerBrain: 20_000,
      maxCostMicrosUsd: 500_000,
      stopWhenEvidenceSufficient: true,
    },
  };
}

function workflowTask(
  id: string,
  name: string,
  dependsOn: string[],
  fault?: { failedArtifactRef: string },
): SouthstarWorkflowManifest["tasks"][number] {
  return {
    id,
    name,
    domain: "software",
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    dependsOn,
    requiredArtifactRefs: ["implementation_report"],
    evaluatorPipelineRef: "software-feature-quality",
    contextPolicyRef: "software-context-default",
    sessionPolicyRef: "software-session-default",
    execution: {
      engine: "tork",
      image: "southstar/pi-agent:local",
      command: ["southstar-agent-runner"],
      env: fault ? {
        SOUTHSTAR_AGENT_RUNNER_FAULT: JSON.stringify({
          kind: "validation_missing_fields",
          fields: ["summary"],
          attemptIds: [firstAttemptId(id)],
          failedArtifactRefs: [fault.failedArtifactRef],
          reason: "real E2E consumer validation failure against producer artifact before managed context recovery",
        }),
      } : {},
      mounts: [],
      timeoutSeconds: 600,
      infraRetry: { maxAttempts: 1 },
    },
    rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
    skillRefs: ["software.calc-cli"],
    memoryScopeRefs: ["software"],
    mcpGrantRefs: [],
    subagents: [{
      id: `${id}-hand`,
      harnessId: "pi",
      prompt: "Complete the task artifact using the managed recovery context packet.",
      requiredArtifacts: ["implementation_report"],
    }],
  };
}

async function updateConsumerRuntimeFault(
  db: SouthstarDb,
  input: { runId: string; producerTaskId: string; consumerTaskId: string; failedArtifactRef: string },
): Promise<void> {
  await updateWorkflowManifestPg(db, input.runId, JSON.stringify(workflowManifest({
    producerTaskId: input.producerTaskId,
    consumerTaskId: input.consumerTaskId,
    consumerFault: { failedArtifactRef: input.failedArtifactRef },
  })));
}

async function api<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

async function artifactRepairMarkerForArtifact(
  db: SouthstarDb,
  input: { runId: string; producerTaskId: string; artifactRefId: string },
): Promise<RuntimeResourceRecord> {
  const marker = (await listResourcesPg(db, { resourceType: "artifact_repair_marker" }))
    .filter((resource) => resource.runId === input.runId && resource.taskId === input.producerTaskId)
    .find((resource) => (resource.payload as { artifactRefId?: string }).artifactRefId === input.artifactRefId);
  if (!marker) throw new Error(`artifact repair marker not found for ${input.artifactRefId}`);
  return marker;
}

async function taskRow(
  db: SouthstarDb,
  input: { runId: string; taskId: string },
): Promise<{ status: string; root_session_id: string | null }> {
  return await db.one<{ status: string; root_session_id: string | null }>(
    "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
    [input.runId, input.taskId],
  );
}

async function latestArtifact(
  db: SouthstarDb,
  input: { runId: string; taskId: string; status: "accepted" | "rejected" },
): Promise<RuntimeResourceRecord> {
  const artifact = artifactsForTask(await listResourcesPg(db, { resourceType: "artifact_ref" }), input).at(-1);
  if (!artifact) throw new Error(`${input.status} artifact not found for ${input.runId}/${input.taskId}`);
  return artifact;
}

function artifactsForTask(
  resources: RuntimeResourceRecord[],
  input: { runId: string; taskId: string; status: "accepted" | "rejected" },
): RuntimeResourceRecord[] {
  return resources.filter((resource) => (
    resource.runId === input.runId &&
    resource.taskId === input.taskId &&
    resource.status === input.status
  ));
}

async function latestResource(
  db: SouthstarDb,
  input: { runId: string; taskId: string; resourceType: string },
): Promise<RuntimeResourceRecord> {
  const resource = (await listResourcesPg(db, { resourceType: input.resourceType }))
    .filter((candidate) => candidate.runId === input.runId && candidate.taskId === input.taskId)
    .at(-1);
  if (!resource) throw new Error(`${input.resourceType} not found for ${input.runId}/${input.taskId}`);
  return resource;
}

async function latestContextPacket(
  db: SouthstarDb,
  input: { runId: string; taskId: string },
): Promise<ContextPacketPayload> {
  const row = await db.maybeOne<{ payload_json: ContextPacketPayload }>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'context_packet'
        and run_id = $1
        and task_id = $2
      order by created_at desc, resource_key desc
      limit 1`,
    [input.runId, input.taskId],
  );
  if (!row) throw new Error(`context packet not found for ${input.runId}/${input.taskId}`);
  return row.payload_json;
}

async function latestTaskEnvelope(
  db: SouthstarDb,
  input: { runId: string; taskId: string },
): Promise<TaskEnvelopePayload> {
  const row = await db.maybeOne<{ payload_json: TaskEnvelopePayload }>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'task_envelope'
        and run_id = $1
        and task_id = $2
      order by created_at desc, resource_key desc
      limit 1`,
    [input.runId, input.taskId],
  );
  if (!row) throw new Error(`task envelope not found for ${input.runId}/${input.taskId}`);
  return row.payload_json;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
