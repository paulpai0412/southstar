import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBrainProvider } from "../../src/v2/brain/fake-brain-provider.ts";
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";
import {
  RECOVERY_DECISION_RESOURCE_TYPE,
  RECOVERY_DECISION_SCHEMA_VERSION,
} from "../../src/v2/exceptions/types.ts";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createDefaultManagedRuntimeLoop } from "../../src/v2/server/http-server.ts";
import { createManagedRuntimeLoopController, createManagedRuntimeLoopPlan } from "../../src/v2/server/runtime-loops.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, getResourceByKeyPg, listResourcesPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";

test("managed runtime loop plan includes scheduler and recovery loops", () => {
  const plan = createManagedRuntimeLoopPlan({ schedulerIntervalMs: 1000, recoveryIntervalMs: 5000 });

  assert.deepEqual(plan.map((item) => item.id), ["executor-reconciler", "runnable-task-scheduler", "recovery-controller", "tork-exception-observer", "recovery-decision-applier"]);
  assert.deepEqual(plan.map((item) => item.intervalMs), [30_000, 1000, 5000, 5000, 5000]);
});

test("managed runtime loop dispatches runnable Postgres tasks through scheduler", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await createWorkflowRunPg(db, {
      id: "run-managed-loop-1",
      status: "running",
      domain: "software",
      goalPrompt: "managed loop",
      workflowManifestJson: JSON.stringify({
        schemaVersion: "southstar.v2",
        workflowId: "wf-managed-loop",
        tasks: [],
        effortPolicy: { maxParallelTasks: 1, complexity: "standard", maxToolCallsPerTask: 20 },
      }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-managed-loop-1",
      runId: "run-managed-loop-1",
      taskKey: "task-managed-loop-1",
      status: "pending",
      sortOrder: 0,
      dependsOn: [],
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "context_packet",
      resourceKey: "ctx-managed-loop-1",
      runId: "run-managed-loop-1",
      taskId: "task-managed-loop-1",
      scope: "task",
      status: "created",
      payload: { id: "ctx-managed-loop-1" },
    });

    const loop = createManagedRuntimeLoopController({
      db,
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain-loop" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand-loop" }),
      schedulerIntervalMs: 10,
      recoveryIntervalMs: 50,
    });
    loop.start();
    await sleep(120);
    await loop.stop();

    const brainBindings = await listResourcesPg(db, { resourceType: "brain_binding" });
    const handBindings = await listResourcesPg(db, { resourceType: "hand_binding" });
    assert.equal(brainBindings.some((resource) => resource.runId === "run-managed-loop-1"), true);
    assert.equal(handBindings.some((resource) => resource.runId === "run-managed-loop-1"), true);
  } finally {
    await db.close();
  }
});

test("managed runtime loop dispatches scheduling Postgres runs through scheduler", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await createWorkflowRunPg(db, {
      id: "run-managed-loop-scheduling",
      status: "scheduling",
      domain: "software",
      goalPrompt: "managed loop scheduling",
      workflowManifestJson: JSON.stringify({
        schemaVersion: "southstar.v2",
        workflowId: "wf-managed-loop-scheduling",
        tasks: [],
        effortPolicy: { maxParallelTasks: 1, complexity: "standard", maxToolCallsPerTask: 20 },
      }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-managed-loop-scheduling",
      runId: "run-managed-loop-scheduling",
      taskKey: "task-managed-loop-scheduling",
      status: "pending",
      sortOrder: 0,
      dependsOn: [],
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "context_packet",
      resourceKey: "ctx-managed-loop-scheduling",
      runId: "run-managed-loop-scheduling",
      taskId: "task-managed-loop-scheduling",
      scope: "task",
      status: "created",
      payload: { id: "ctx-managed-loop-scheduling" },
    });

    const loop = createManagedRuntimeLoopController({
      db,
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain-loop-scheduling" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand-loop-scheduling" }),
      schedulerIntervalMs: 10,
      recoveryIntervalMs: 50,
    });
    loop.start();
    await sleep(120);
    await loop.stop();

    const brainBindings = await listResourcesPg(db, { resourceType: "brain_binding" });
    const handBindings = await listResourcesPg(db, { resourceType: "hand_binding" });
    assert.equal(brainBindings.some((resource) => resource.runId === "run-managed-loop-scheduling"), true);
    assert.equal(handBindings.some((resource) => resource.runId === "run-managed-loop-scheduling"), true);
  } finally {
    await db.close();
  }
});

test("managed runtime loop drains applicable recovery decisions on each tick", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await createWorkflowRunPg(db, {
      id: "run-managed-loop-apply-decisions",
      status: "running",
      domain: "software",
      goalPrompt: "managed loop applies decisions",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await seedApprovedRecoveryDecision(db, {
      runId: "run-managed-loop-apply-decisions",
      decisionId: "decision-managed-loop-apply-a",
      resourceKey: "runtime_exception_recovery_decision:exception-managed-loop-a:rollback-workspace",
      exceptionId: "exception-managed-loop-a",
    });
    await seedApprovedRecoveryDecision(db, {
      runId: "run-managed-loop-apply-decisions",
      decisionId: "decision-managed-loop-apply-b",
      resourceKey: "runtime_exception_recovery_decision:exception-managed-loop-b:rollback-workspace",
      exceptionId: "exception-managed-loop-b",
    });

    const loop = createManagedRuntimeLoopController({
      db,
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain-loop-apply" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand-loop-apply" }),
      schedulerIntervalMs: 60_000,
      recoveryIntervalMs: 60_000,
    });
    loop.start();
    await sleep(120);
    await loop.stop();

    assert.equal((await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, "runtime_exception_recovery_decision:exception-managed-loop-a:rollback-workspace"))?.status, "blocked");
    assert.equal((await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, "runtime_exception_recovery_decision:exception-managed-loop-b:rollback-workspace"))?.status, "blocked");
  } finally {
    await db.close();
  }
});

test("default managed runtime loop forwards managed provider actions to recovery decision applier", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-managed-loop-provider-actions" });
    const cancelInputs: Array<{ externalJobId: string; runId: string; reason: string }> = [];
    const loop = createDefaultManagedRuntimeLoop({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      managedRuntime: {
        sessionStore: createPostgresSessionStore(db),
        brainProvider: createFakeBrainProvider({ providerId: "fake-brain-loop-provider-actions" }),
        handProvider: createFakeHandProvider({ providerId: "fake-hand-loop-provider-actions" }),
        providerActions: {
          async cancel(input) {
            cancelInputs.push(input);
          },
        },
        schedulerIntervalMs: 60_000,
        recoveryIntervalMs: 10,
      },
    });
    assert.ok(loop);

    loop.start();
    await sleep(120);
    await loop.stop();

    assert.deepEqual(cancelInputs, [{
      externalJobId: "job-queued",
      runId: fixture.runId,
      reason: "requeue-hand-execution",
    }]);
    const recoveryExecution = (await listResourcesPg(db, { resourceType: "recovery_execution" })).find(
      (resource) => resource.runId === fixture.runId,
    );
    const providerActions = recoveryExecution?.payload as {
      providerActions?: Array<{ action?: string; status?: string; succeededAt?: string }>;
    };
    assert.equal(providerActions.providerActions?.find((action) => action.action === "cancel")?.status, "succeeded");
  } finally {
    await db.close();
  }
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRequeueDecisionFixture(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  input: { runId: string },
) {
  const runId = input.runId;
  const taskId = "task-a";
  const sessionId = "session-a";
  const attemptId = "attempt-1";
  const handExecutionId = `hand-execution:${runId}:${taskId}:${attemptId}`;

  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "apply queue timeout recovery",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: "queued",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: sessionId,
  });
  await upsertRuntimeResourcePg(db, {
    id: handExecutionId,
    resourceType: "hand_execution",
    resourceKey: handExecutionId,
    runId,
    taskId,
    sessionId,
    scope: "hand",
    status: "queued",
    title: "Hand execution task-a",
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId,
      providerId: "tork",
      runId,
      taskId,
      sessionId,
      attemptId,
      brainBindingId: "brain-binding-a",
      handBindingId: "hand-binding-a",
      externalJobId: "job-queued",
      status: "queued",
      queuedAt: "2026-06-21T11:50:00.000Z",
      queueTimeoutSeconds: 300,
      heartbeatTimeoutSeconds: 300,
    },
    summary: { providerId: "tork", attemptId },
    metrics: {},
  });

  const controller = createRuntimeExceptionController({ db });
  const exception = await controller.observe({
    runId,
    taskId,
    sessionId,
    attemptId,
    handExecutionId,
    source: "tork-observer",
    kind: "tork_queue_timeout",
    severity: "recoverable",
    observedAt: "2026-06-21T11:59:00.000Z",
    evidenceRefs: [handExecutionId],
    providerEvidence: { externalJobId: "job-queued" },
  });
  const decision = await controller.decide(await controller.classify(exception));

  return { runId, taskId, sessionId, attemptId, handExecutionId, exception, decision };
}

async function seedApprovedRecoveryDecision(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  input: { runId: string; decisionId: string; resourceKey: string; exceptionId: string },
): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: input.decisionId,
    resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
    resourceKey: input.resourceKey,
    runId: input.runId,
    scope: "recovery",
    status: "approved",
    title: "Runtime recovery decision: rollback-workspace",
    payload: {
      schemaVersion: RECOVERY_DECISION_SCHEMA_VERSION,
      decisionId: input.decisionId,
      exceptionId: input.exceptionId,
      runId: input.runId,
      path: "rollback-workspace",
      reason: "operator approved rollback",
      operatorApprovalRequired: true,
      evidenceRefs: [],
      createdAt: "2026-06-21T10:00:00.000Z",
    },
    summary: {
      exceptionId: input.exceptionId,
      path: "rollback-workspace",
      operatorApprovalRequired: true,
    },
  });
}
