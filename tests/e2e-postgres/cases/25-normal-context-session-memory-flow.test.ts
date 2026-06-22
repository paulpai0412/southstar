import test from "node:test";
import assert from "node:assert/strict";
import { writeRunLocalMemoryPg } from "../../../src/v2/memory/postgres-memory-service.ts";
import type { SouthstarWorkflowManifest } from "../../../src/v2/manifests/types.ts";
import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
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
  latestHandExecutionForTask,
  waitForHandExecutionStatus,
} from "../recovery-scheduler-helpers.ts";

type ContextPacketPayload = {
  id?: string;
  priorArtifacts?: unknown[];
  selectedMemories?: unknown[];
  managedSourceRefs?: {
    artifactRefs?: string[];
    memoryRefs?: string[];
  };
};

type TaskEnvelopePayload = {
  envelope?: {
    contextPacket?: {
      id?: string;
    };
  };
};

test("25 normal context/session/memory flow: downstream task receives managed sources", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const runId = "real-normal-context-session-memory-flow";
    const taskAId = "produce-context-artifact";
    const taskBId = "consume-context-artifact";
    await seedRun(env.db, { runId, taskAId, taskBId });

    const scheduler = createRealRecoveryScheduler(env.db, {
      infra,
      callbackBase: dockerReachableUrl(server, infra),
    });

    const firstDispatch = await scheduler.runOnce({ runId });
    assert.deepEqual(firstDispatch.dispatchedTaskIds, [taskAId]);

    const firstHand = await latestHandExecutionForTask(env.db, { runId, taskId: taskAId });
    await waitForTorkJob(infra.torkBaseUrl, firstHand.externalJobId);
    const firstHandStatus = await waitForHandExecutionStatus(env.db, firstHand.resourceKey, ["completed", "failed"]);
    assert.equal(firstHandStatus, "completed");

    const firstArtifact = acceptedArtifactsForTask(await listResourcesPg(env.db, { resourceType: "artifact_ref" }), runId, taskAId)[0];
    assert.ok(firstArtifact);

    const firstTask = await env.db.one<{ status: string; root_session_id: string | null }>(
      "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskAId],
    );
    assert.equal(firstTask.status, "completed");
    assert.ok(firstTask.root_session_id);

    const memory = await writeRunLocalMemoryPg(env.db, {
      runId,
      taskId: taskAId,
      sessionId: firstTask.root_session_id,
      scope: "software",
      kind: "workflow_context",
      text: "normal managed context memory artifact: downstream task should inspect accepted producer evidence before completing",
      tags: ["normal", "managed", "context", "memory", "artifact"],
      sourceRefs: [firstArtifact.resourceKey],
      confidence: 1,
      successScore: 1,
    });

    const secondDispatch = await scheduler.runOnce({ runId });
    assert.deepEqual(secondDispatch.dispatchedTaskIds, [taskBId]);

    const secondContext = await latestContextPacket(env.db, { runId, taskId: taskBId });
    assert.equal((secondContext.priorArtifacts?.length ?? 0) > 0, true);
    assert.equal((secondContext.selectedMemories?.length ?? 0) > 0, true);
    assert.equal((secondContext.managedSourceRefs?.artifactRefs?.length ?? 0) > 0, true);
    assert.equal((secondContext.managedSourceRefs?.memoryRefs?.length ?? 0) > 0, true);
    assert.equal(secondContext.managedSourceRefs?.artifactRefs?.includes(firstArtifact.resourceKey), true);
    assert.equal(secondContext.managedSourceRefs?.memoryRefs?.includes(`memory_item:${memory.id}`), true);

    const secondEnvelope = await latestTaskEnvelope(env.db, { runId, taskId: taskBId });
    assert.equal(secondEnvelope.envelope?.contextPacket?.id, secondContext.id);

    const secondHand = await latestHandExecutionForTask(env.db, { runId, taskId: taskBId });
    await waitForTorkJob(infra.torkBaseUrl, secondHand.externalJobId);
    const secondHandStatus = await waitForHandExecutionStatus(env.db, secondHand.resourceKey, ["completed", "failed"]);
    assert.equal(secondHandStatus, "completed");

    const handExecutions = (await listResourcesPg(env.db, { resourceType: "hand_execution" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(handExecutions.length, 2);
    assert.equal(handExecutions.every((resource) => resource.status === "completed"), true);

    const tasks = await env.db.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order",
      [runId],
    );
    assert.deepEqual(tasks.rows, [
      { id: taskAId, status: "completed" },
      { id: taskBId, status: "completed" },
    ]);

    const artifacts = await listResourcesPg(env.db, { resourceType: "artifact_ref" });
    assert.equal(acceptedArtifactsForTask(artifacts, runId, taskAId).length > 0, true);
    assert.equal(acceptedArtifactsForTask(artifacts, runId, taskBId).length > 0, true);

    const history = await listHistoryForRunPg(env.db, runId);
    for (const taskId of [taskAId, taskBId]) {
      assert.equal(history.some((event) => event.taskId === taskId && event.eventType === "task.dispatch_submitted"), true);
      assert.equal(history.some((event) => event.taskId === taskId && event.eventType === "executor.callback_received"), true);
    }
  } finally {
    await server.close();
    await env.close();
  }
});

async function seedRun(
  db: SouthstarDb,
  input: { runId: string; taskAId: string; taskBId: string },
): Promise<void> {
  const manifest = workflowManifest(input);
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: "created",
    domain: "software",
    goalPrompt: "normal managed context memory artifact propagation",
    workflowManifestJson: JSON.stringify(manifest),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: input.taskAId,
    runId: input.runId,
    taskKey: input.taskAId,
    status: "pending",
    sortOrder: 1,
    dependsOn: [],
  });
  await createWorkflowTaskPg(db, {
    id: input.taskBId,
    runId: input.runId,
    taskKey: input.taskBId,
    status: "pending",
    sortOrder: 2,
    dependsOn: [input.taskAId],
  });
}

function workflowManifest(input: { runId: string; taskAId: string; taskBId: string }): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-normal-context-session-memory-flow",
    title: "Normal context session memory flow",
    goalPrompt: "normal managed context memory artifact propagation",
    domain: "software",
    intent: "implement_feature",
    tasks: [
      workflowTask(input.taskAId, "Produce normal managed context artifact", []),
      workflowTask(input.taskBId, "Consume normal managed context memory artifact", [input.taskAId]),
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
    executionPolicy: { maxParallelTasks: 1 },
  } as SouthstarWorkflowManifest;
}

function workflowTask(id: string, name: string, dependsOn: string[]): SouthstarWorkflowManifest["tasks"][number] {
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
      env: {},
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
      prompt: "Complete the task artifact using the managed context packet.",
      requiredArtifacts: ["implementation_report"],
    }],
  };
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

function acceptedArtifactsForTask(
  resources: Array<{ runId?: string; taskId?: string; status: string; resourceKey: string }>,
  runId: string,
  taskId: string,
): Array<{ resourceKey: string }> {
  return resources
    .filter((resource) => resource.runId === runId && resource.taskId === taskId && resource.status === "accepted")
    .map((resource) => ({ resourceKey: resource.resourceKey }));
}
