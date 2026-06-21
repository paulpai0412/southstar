import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import type { BrainProvider, BrainSessionBinding, WakeBrainInput } from "../../../src/v2/brain/types.ts";
import type { ExecutorProvider, ExecutorSubmitRequest } from "../../../src/v2/executor/provider.ts";
import { createTorkHandProvider } from "../../../src/v2/hands/tork-hand-provider.ts";
import { createPostgresSessionStore } from "../../../src/v2/session/postgres-session-store.ts";
import { createRunnableTaskScheduler } from "../../../src/v2/scheduler/runnable-task-scheduler.ts";
import { createSouthstarRuntimeServer, type SouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";

test("13 managed per-task Tork runtime: scheduling queues hand execution and callback gates completion", async () => {
  const harness = await createInitializedRealPostgresE2E();
  const runId = "real-managed-per-task-tork-runtime";
  const taskId = "implement";
  const submitted: ExecutorSubmitRequest[] = [];
  let server: SouthstarRuntimeServer | undefined;
  try {
    await seedRun(harness.db, runId, taskId);

    server = await createTestRuntimeServer(harness.db);
    const scheduled = await post<{ runId: string; status: "scheduling"; schedulerWakeRequested: true }>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/execute`,
      {},
    );
    assert.deepEqual(scheduled, {
      runId,
      status: "scheduling",
      schedulerWakeRequested: true,
    });
    const afterExecute = await harness.db.one<{ status: string; executor_job_id: string | null }>(
      "select status, executor_job_id from southstar.workflow_runs where id = $1",
      [runId],
    );
    assert.equal(afterExecute.status, "scheduling");
    assert.equal(afterExecute.executor_job_id, null);

    const scheduler = createRunnableTaskScheduler(harness.db, {
      sessionStore: createPostgresSessionStore(harness.db),
      brainProvider: deterministicBrainProvider(),
      handProvider: createTorkHandProvider({
        executorProvider: recordingTorkExecutorProvider(submitted),
        callbackUrl: `${server.url}/api/v2/tork/callback`,
        heartbeatUrl: `${server.url}/api/v2/executor/heartbeat`,
      }),
    });

    const scheduledTasks = await scheduler.runOnce({ runId });
    assert.deepEqual(scheduledTasks.dispatchedTaskIds, [taskId]);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.runId, runId);
    assert.equal(submitted[0]?.attemptId, `${taskId}-attempt-1`);
    assert.equal(submitted[0]?.workflow.tasks.length, 1);
    assert.equal(submitted[0]?.workflow.tasks[0]?.id, taskId);

    const handExecutions = await listResourcesPg(harness.db, { resourceType: "hand_execution" });
    assert.equal(handExecutions.length, 1);
    assert.equal(handExecutions[0]?.status, "queued");
    assert.equal(handExecutions[0]?.payload.handExecutionId, `hand-execution:${runId}:${taskId}:${taskId}-attempt-1`);
    assert.equal(handExecutions[0]?.payload.externalJobId, `job-${taskId}`);

    const intents = await listResourcesPg(harness.db, { resourceType: "task_execution_intent" });
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.status, "created");
    assert.equal(intents[0]?.payload.handProviderId, "tork");

    const bindings = await listResourcesPg(harness.db, { resourceType: "executor_binding" });
    assert.equal(bindings.length, 0);

    await post(server.url, "/api/v2/tork/callback", {
      runId,
      taskId,
      rootSessionId: `root-${runId}-${taskId}`,
      ok: true,
      attempts: 1,
      attemptId: `${taskId}-attempt-1`,
      artifact: { kind: "implementation_report", summary: "completed by per-task hand" },
      metrics: { durationMs: 1 },
      events: [],
      receivedAt: "2026-06-21T00:00:00.000Z",
    });

    const artifactRefs = await listResourcesPg(harness.db, { resourceType: "artifact_ref" });
    assert.equal(artifactRefs.length, 1);
    assert.equal(artifactRefs[0]?.status, "accepted");
    assert.equal(artifactRefs[0]?.payload.handExecutionId, `hand-execution:${runId}:${taskId}:${taskId}-attempt-1`);

    const completedHand = await listResourcesPg(harness.db, { resourceType: "hand_execution" });
    assert.equal(completedHand[0]?.status, "completed");
    assert.equal(completedHand[0]?.payload.terminalAt, "2026-06-21T00:00:00.000Z");

    const finalRun = await harness.db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
    assert.equal(finalRun.status, "passed");
    const history = await listHistoryForRunPg(harness.db, runId);
    assert.equal(history.some((event) => event.eventType === "run.scheduling_started"), true);
    assert.equal(history.some((event) => event.eventType === "brain.intent_created"), true);
    assert.equal(history.some((event) => event.eventType === "hand.execute_queued"), true);
    assert.equal(history.some((event) => event.eventType === "run.execution_submitted"), false);
  } finally {
    await server?.close();
    await harness.close();
  }
});

async function seedRun(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  const manifest = {
    schemaVersion: "southstar.v2",
    workflowId: "wf-managed-per-task-tork-runtime",
    title: "Managed per-task Tork runtime",
    goalPrompt: "complete one bounded task",
    tasks: [{
      id: taskId,
      name: "Implement",
      domain: "software",
      dependsOn: [],
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
      skillRefs: ["software.implementation"],
      subagents: [{ id: "impl", harnessId: "codex", prompt: "complete the task", requiredArtifacts: ["implementation_report"] }],
    }],
    harnessDefinitions: [{
      id: "codex",
      kind: "codex",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v1",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation_report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: [] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    executionPolicy: { maxParallelTasks: 1 },
  };
  await createWorkflowRunPg(db, {
    id: runId,
    status: "created",
    domain: "software",
    goalPrompt: "managed per-task Tork runtime",
    workflowManifestJson: JSON.stringify(manifest),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: "pending",
    sortOrder: 1,
    dependsOn: [],
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "context_packet",
    resourceKey: `context-${runId}-${taskId}`,
    runId,
    taskId,
    scope: "brain",
    status: "ready",
    title: `Context ${taskId}`,
    payload: { id: `context-${runId}-${taskId}` },
  });
}

async function createTestRuntimeServer(db: SouthstarDb): Promise<SouthstarRuntimeServer> {
  return await createSouthstarRuntimeServer({
    db: db as never,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("whole-workflow executor not used"); } },
    createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
  });
}

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

function deterministicBrainProvider(): BrainProvider {
  return {
    providerId: "deterministic-brain",
    async wake(input: WakeBrainInput): Promise<BrainSessionBinding> {
      return {
        id: `brain-${input.runId}-${input.taskId}`,
        providerId: "deterministic-brain",
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        contextPacketId: input.contextPacketId,
        status: "running",
        createdAt: "2026-06-21T00:00:00.000Z",
        payload: { effortPolicy: input.effortPolicy },
      };
    },
    async cancel(binding) {
      binding.status = "cancelled";
    },
    capabilities() {
      return {
        supportsWakeFromSession: true,
        supportsCancel: true,
        supportsSteering: true,
        supportsNativeRewind: false,
      };
    },
  };
}

function recordingTorkExecutorProvider(submitted: ExecutorSubmitRequest[]): ExecutorProvider {
  return {
    executorType: "tork",
    async submit(request) {
      submitted.push(request);
      const taskId = request.workflow.tasks[0]?.id ?? "unknown";
      return {
        executorType: "tork",
        externalJobId: `job-${taskId}`,
        status: "queued",
        projectionFingerprint: `projection-${taskId}`,
        providerPayload: { taskId },
      };
    },
  };
}
