import test from "node:test";
import assert from "node:assert/strict";
import type { QueryResultRow } from "pg";
import { createFakeBrainProvider } from "../../src/v2/brain/fake-brain-provider.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";
import {
  contextPolicy,
  implementationReportContract,
  makerAgentProfile,
  makerRole,
  memoryPolicy,
  sessionPolicy,
  softwareFeatureQualityPipeline,
  workspacePolicy,
} from "./fixtures/runtime-manifest-primitives.ts";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";
import type { ExecuteTaskInput, HandBinding, HandProvider } from "../../src/v2/hands/types.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createRunnableTaskScheduler } from "../../src/v2/scheduler/runnable-task-scheduler.ts";
import { ingestTaskRunResultPg } from "../../src/v2/executor/postgres-tork-callback.ts";
import { captureRunLibrarySnapshotPg } from "../../src/v2/orchestration/run-library-snapshot.ts";
import { listManagedBindingsForRunPg } from "../../src/v2/meta-harness/postgres-bindings.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  appendHistoryEventPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";

test("runnable scheduler dispatches a dependent pending task when dependencies have accepted artifacts", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-dependent-ready",
      maxParallelTasks: 2,
      tasks: [
        { id: "discover", status: "completed", sortOrder: 0, dependsOn: [] },
        { id: "implement", status: "pending", sortOrder: 1, dependsOn: ["discover"] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-dependent-ready", "implement");
    await seedAcceptedArtifact(db, "run-scheduler-dependent-ready", "discover");

    const fixture = scheduler(db);
    const result = await fixture.scheduler.runOnce({ runId: "run-scheduler-dependent-ready" });

    assert.deepEqual(result.dispatchedTaskIds, ["implement"]);
    assert.deepEqual(fixture.executeTaskCalls.map((call) => call.taskId), ["implement"]);
    assert.equal(result.skippedTaskIds.find((entry) => entry.taskId === "discover")?.reason, "status:completed");
    const task = await taskRow(db, "run-scheduler-dependent-ready", "implement");
    assert.equal(task.status, "queued");
    assert.equal(task.root_session_id, "root-run-scheduler-dependent-ready-implement");

    const bindings = await listManagedBindingsForRunPg(db, "run-scheduler-dependent-ready");
    assert.deepEqual(bindings.brainBindings.map((binding) => binding.taskId), ["implement"]);
    assert.deepEqual(bindings.handBindings.map((binding) => binding.taskId), ["implement"]);
    assert.equal(bindings.brainBindings[0]?.payload.effortPolicy.complexity, "standard");
    assert.equal(bindings.brainBindings[0]?.payload.effortPolicy.maxToolCallsPerTask, 10);

    const history = await listHistoryForRunPg(db, "run-scheduler-dependent-ready");
    assert.equal(history.some((event) => event.eventType === "brain.woke" && event.taskId === "implement"), true);
    assert.equal(history.some((event) => event.eventType === "brain.intent_created" && event.taskId === "implement"), true);
    assert.equal(history.some((event) => event.eventType === "hand.provisioned" && event.taskId === "implement"), true);
    assert.equal(history.some((event) => event.eventType === "task.dispatch_submitted" && event.taskId === "implement"), true);

    const handExecutions = await listResourcesPg(db, { resourceType: "hand_execution" });
    const implementHandExecution = handExecutions.find((resource) => resource.runId === "run-scheduler-dependent-ready" && resource.taskId === "implement");
    assert.equal(implementHandExecution?.status, "queued");
    assert.equal(implementHandExecution?.payload.externalJobId, "job-implement");
    assert.equal(implementHandExecution?.payload.queueTimeoutSeconds, 3600);
    assert.equal(implementHandExecution?.payload.heartbeatTimeoutSeconds, 60);

    const intents = await listResourcesPg(db, { resourceType: "task_execution_intent" });
    const implementIntent = intents.find((resource) => resource.runId === "run-scheduler-dependent-ready" && resource.taskId === "implement");
    assert.equal(implementIntent?.status, "created");
    assert.equal(implementIntent?.payload.taskId, "implement");
    assert.deepEqual(implementIntent?.payload.inputArtifactRefs, ["artifact-run-scheduler-dependent-ready-discover"]);
    assert.deepEqual(fixture.executeTaskCalls[0]?.acceptedInputArtifactRefs, ["artifact-run-scheduler-dependent-ready-discover"]);

    const retryResult = await fixture.scheduler.runOnce({ runId: "run-scheduler-dependent-ready" });
    assert.deepEqual(retryResult.dispatchedTaskIds, []);
    assert.equal(retryResult.skippedTaskIds.find((entry) => entry.taskId === "implement")?.reason, "status:queued");
    const bindingsAfterRetry = await listManagedBindingsForRunPg(db, "run-scheduler-dependent-ready");
    assert.equal(bindingsAfterRetry.brainBindings.length, 1);
    assert.equal(bindingsAfterRetry.handBindings.length, 1);
  } finally {
    await db.close();
  }
});

test("runnable scheduler persists hand execution before invoking the external provider", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-persist-before-effect",
      maxParallelTasks: 1,
      tasks: [{ id: "task-a", status: "pending", sortOrder: 0, dependsOn: [] }],
    });
    await seedContextPacket(db, "run-scheduler-persist-before-effect", "task-a");

    const fixture = scheduler(db, { assertHandExecutionBeforeProvider: true });
    await fixture.scheduler.runOnce({ runId: "run-scheduler-persist-before-effect" });

    assert.equal(fixture.persistedBeforeProvider, true);
  } finally {
    await db.close();
  }
});

test("runnable scheduler dispatches recovered task with latest provisioned hand binding after reprovision", async () => {
  const db = await createTestPostgresDb();
  const runId = "run-scheduler-reprovisioned-hand";
  const taskId = "task-a";
  const sessionId = `root-${runId}-${taskId}`;
  const oldAttemptId = `${taskId}-attempt-1`;
  const oldHandExecutionId = `hand-execution:${runId}:${taskId}:${oldAttemptId}`;
  const lostHandBindingId = "hand-binding-lost-old";
  const replacementHandBindingId = "hand-binding-replacement-new";
  const dispatchRecoveryKey = `task-dispatch:${runId}:${taskId}`;
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId,
      maxParallelTasks: 1,
      tasks: [
        { id: taskId, status: "pending", sortOrder: 0, dependsOn: [] },
      ],
    });
    await seedContextPacket(db, runId, taskId);
    await seedHandExecution(db, {
      handExecutionId: oldHandExecutionId,
      runId,
      taskId,
      sessionId,
      attemptId: oldAttemptId,
      handBindingId: lostHandBindingId,
      status: "lost",
      externalJobId: "job-lost-old",
    });
    await appendHistoryEventPg(db, {
      runId,
      taskId,
      sessionId,
      eventType: "hand.execute_queued",
      actorType: "hand",
      idempotencyKey: `${dispatchRecoveryKey}:hand-execute-queued`,
      payload: { attemptId: oldAttemptId, handExecutionId: oldHandExecutionId, externalJobId: "job-lost-old" },
    });
    await appendHistoryEventPg(db, {
      runId,
      taskId,
      sessionId,
      eventType: "task.dispatch_submitted",
      actorType: "orchestrator",
      idempotencyKey: `${dispatchRecoveryKey}:dispatch-submitted`,
      payload: { attemptId: oldAttemptId, handExecutionId: oldHandExecutionId, handBindingId: lostHandBindingId },
    });
    await seedHandBinding(db, {
      id: lostHandBindingId,
      runId,
      taskId,
      status: "lost",
      createdAt: "2026-06-21T14:00:00.000Z",
    });
    await seedHandBinding(db, {
      id: replacementHandBindingId,
      runId,
      taskId,
      status: "provisioned",
      createdAt: "2026-06-21T14:01:00.000Z",
    });

    const fixture = scheduler(db);
    const result = await fixture.scheduler.runOnce({ runId });

    assert.deepEqual(result.dispatchedTaskIds, [taskId]);
    assert.deepEqual(fixture.executeTaskBindings.map((binding) => binding.id), [replacementHandBindingId]);
    assert.deepEqual(fixture.executeTaskCalls.map((call) => call.handBindingId), [replacementHandBindingId]);

    const handExecutions = await listResourcesPg(db, { resourceType: "hand_execution" });
    const oldHandExecution = handExecutions.find((resource) => resource.resourceKey === oldHandExecutionId);
    assert.equal(oldHandExecution?.status, "lost");
    assert.equal(oldHandExecution?.payload.handBindingId, lostHandBindingId);

    const newHandExecution = handExecutions.find((resource) => (
      resource.runId === runId &&
      resource.taskId === taskId &&
      resource.resourceKey !== oldHandExecutionId
    ));
    assert.ok(newHandExecution, "expected recovered dispatch to create a distinct hand_execution resource");
    assert.equal(newHandExecution.payload.attemptId, `${taskId}-attempt-2`);
    assert.equal(newHandExecution.payload.handBindingId, replacementHandBindingId);
    assert.deepEqual(fixture.executeTaskCalls.map((call) => call.attemptId), [`${taskId}-attempt-2`]);

    const history = await listHistoryForRunPg(db, runId);
    assert.equal(
      history.filter((event) => event.eventType === "hand.execute_queued").length,
      2,
      "expected old queued history and new recovered queued history",
    );
    assert.equal(
      history.filter((event) => event.eventType === "task.dispatch_submitted").length,
      2,
      "expected old dispatch history and new recovered dispatch history",
    );
    assert.equal(
      history.some((event) => event.eventType === "hand.execute_queued" && event.idempotencyKey === `${dispatchRecoveryKey}:${taskId}-attempt-2:hand-execute-queued`),
      true,
    );
    assert.equal(
      history.some((event) => event.eventType === "task.dispatch_submitted" && event.idempotencyKey === `${dispatchRecoveryKey}:${taskId}-attempt-2:dispatch-submitted`),
      true,
    );
  } finally {
    await db.close();
  }
});

test("runnable scheduler leaves a pending task queued when dependency artifacts are missing", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-dependent-missing",
      maxParallelTasks: 2,
      tasks: [
        { id: "discover", status: "completed", sortOrder: 0, dependsOn: [] },
        { id: "implement", status: "pending", sortOrder: 1, dependsOn: ["discover"] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-dependent-missing", "implement");

    const fixture = scheduler(db);
    const result = await fixture.scheduler.runOnce({ runId: "run-scheduler-dependent-missing" });

    assert.deepEqual(result.dispatchedTaskIds, []);
    assert.deepEqual(fixture.executeTaskCalls, []);
    assert.equal(result.skippedTaskIds.find((entry) => entry.taskId === "implement")?.reason, "dependencies-not-accepted");
    const task = await taskRow(db, "run-scheduler-dependent-missing", "implement");
    assert.equal(task.status, "pending");
    assert.equal(task.root_session_id, null);
    const bindings = await listManagedBindingsForRunPg(db, "run-scheduler-dependent-missing");
    assert.equal(bindings.brainBindings.length, 0);
    assert.equal(bindings.handBindings.length, 0);
  } finally {
    await db.close();
  }
});

test("runnable scheduler gates ready tasks by manifest maxParallelTasks", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-parallel-limit",
      maxParallelTasks: 1,
      tasks: [
        { id: "task-a", status: "pending", sortOrder: 0, dependsOn: [] },
        { id: "task-b", status: "pending", sortOrder: 1, dependsOn: [] },
        { id: "task-c", status: "pending", sortOrder: 2, dependsOn: [] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-parallel-limit", "task-a");
    await seedContextPacket(db, "run-scheduler-parallel-limit", "task-b");
    await seedContextPacket(db, "run-scheduler-parallel-limit", "task-c");

    const fixture = scheduler(db);
    const result = await fixture.scheduler.runOnce({ runId: "run-scheduler-parallel-limit" });

    assert.deepEqual(result.dispatchedTaskIds, ["task-a"]);
    assert.deepEqual(fixture.executeTaskCalls.map((call) => call.taskId), ["task-a"]);
    assert.deepEqual(
      result.skippedTaskIds.filter((entry) => entry.reason === "parallel-limit").map((entry) => entry.taskId),
      ["task-b", "task-c"],
    );
    assert.equal((await taskRow(db, "run-scheduler-parallel-limit", "task-a")).status, "queued");
    assert.equal((await taskRow(db, "run-scheduler-parallel-limit", "task-b")).status, "pending");
    assert.equal((await taskRow(db, "run-scheduler-parallel-limit", "task-c")).status, "pending");
  } finally {
    await db.close();
  }
});

test("runnable scheduler counts already claimed, queued, and running tasks against maxParallelTasks", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-existing-active",
      maxParallelTasks: 3,
      tasks: [
        { id: "task-claimed", status: "claimed", sortOrder: 0, dependsOn: [], rootSessionId: "root-claimed" },
        { id: "task-queued", status: "queued", sortOrder: 1, dependsOn: [], rootSessionId: "root-queued" },
        { id: "task-running", status: "running", sortOrder: 2, dependsOn: [], rootSessionId: "root-running" },
        { id: "task-ready", status: "pending", sortOrder: 3, dependsOn: [] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-existing-active", "task-ready");

    const fixture = scheduler(db);
    const result = await fixture.scheduler.runOnce({ runId: "run-scheduler-existing-active" });

    assert.deepEqual(result.dispatchedTaskIds, []);
    assert.deepEqual(fixture.executeTaskCalls, []);
    assert.equal(result.skippedTaskIds.find((entry) => entry.taskId === "task-claimed")?.reason, "status:claimed");
    assert.equal(result.skippedTaskIds.find((entry) => entry.taskId === "task-queued")?.reason, "status:queued");
    assert.equal(result.skippedTaskIds.find((entry) => entry.taskId === "task-running")?.reason, "status:running");
    assert.equal(result.skippedTaskIds.find((entry) => entry.taskId === "task-ready")?.reason, "parallel-limit");
    assert.equal((await taskRow(db, "run-scheduler-existing-active", "task-ready")).status, "pending");
  } finally {
    await db.close();
  }
});

test("runnable scheduler queues two independent tasks when maxParallelTasks allows two active hands", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-parallel-two",
      maxParallelTasks: 2,
      tasks: [
        { id: "task-a", status: "pending", sortOrder: 0, dependsOn: [] },
        { id: "task-b", status: "pending", sortOrder: 1, dependsOn: [] },
        { id: "task-c", status: "pending", sortOrder: 2, dependsOn: [] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-parallel-two", "task-a");
    await seedContextPacket(db, "run-scheduler-parallel-two", "task-b");
    await seedContextPacket(db, "run-scheduler-parallel-two", "task-c");

    const fixture = scheduler(db);
    const result = await fixture.scheduler.runOnce({ runId: "run-scheduler-parallel-two" });

    assert.deepEqual(result.dispatchedTaskIds, ["task-a", "task-b"]);
    assert.deepEqual(fixture.executeTaskCalls.map((call) => call.taskId), ["task-a", "task-b"]);
    assert.equal(result.skippedTaskIds.find((entry) => entry.taskId === "task-c")?.reason, "parallel-limit");
    assert.equal((await taskRow(db, "run-scheduler-parallel-two", "task-a")).status, "queued");
    assert.equal((await taskRow(db, "run-scheduler-parallel-two", "task-b")).status, "queued");
    assert.equal((await taskRow(db, "run-scheduler-parallel-two", "task-c")).status, "pending");
  } finally {
    await db.close();
  }
});

test("runnable scheduler does not terminal-fail a task after hand execution was accepted and local queued persistence fails", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-post-submit-failure",
      maxParallelTasks: 1,
      tasks: [
        { id: "task-a", status: "pending", sortOrder: 0, dependsOn: [] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-post-submit-failure", "task-a");

    const fixture = scheduler(dbFailingQueuedTaskUpdate(db));
    await assert.rejects(
      () => fixture.scheduler.runOnce({ runId: "run-scheduler-post-submit-failure" }),
      /queued task update failed/,
    );

    assert.deepEqual(fixture.executeTaskCalls.map((call) => call.taskId), ["task-a"]);
    assert.equal((await taskRow(db, "run-scheduler-post-submit-failure", "task-a")).status, "claimed");

    const handExecutions = await listResourcesPg(db, { resourceType: "hand_execution" });
    const handExecution = handExecutions.find((resource) => resource.runId === "run-scheduler-post-submit-failure" && resource.taskId === "task-a");
    assert.equal(handExecution?.status, "queued");

    const history = await listHistoryForRunPg(db, "run-scheduler-post-submit-failure");
    assert.equal(history.some((event) => event.eventType === "hand.execute_failed" && event.taskId === "task-a"), false);
  } finally {
    await db.close();
  }
});

test("runnable scheduler releases claimed task without hand execution when dispatch preparation fails before hand acceptance", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-pre-hand-failure",
      maxParallelTasks: 1,
      tasks: [
        { id: "task-a", status: "pending", sortOrder: 0, dependsOn: [] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-pre-hand-failure", "task-a");

    const fixture = scheduler(db, {
      failBrainWake: true,
      brainProviderId: "sk-1234567890abcdefghijklmnopqrstuv",
    });
    await assert.rejects(
      () => fixture.scheduler.runOnce({ runId: "run-scheduler-pre-hand-failure" }),
      /fake brain wake failed/,
    );

    assert.deepEqual(fixture.executeTaskCalls, []);
    assert.equal((await taskRow(db, "run-scheduler-pre-hand-failure", "task-a")).status, "pending");

    const handExecutions = await listResourcesPg(db, { resourceType: "hand_execution" });
    assert.equal(handExecutions.some((resource) => resource.runId === "run-scheduler-pre-hand-failure" && resource.taskId === "task-a"), false);

    const history = await listHistoryForRunPg(db, "run-scheduler-pre-hand-failure");
    assert.equal(history.some((event) => event.eventType === "task.dispatch_prepare_failed" && event.taskId === "task-a"), true);

    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === "run-scheduler-pre-hand-failure");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "dispatch_preparation_failed");
    assert.equal(exceptions[0]?.payload.source, "scheduler");
    assert.equal(exceptions[0]?.payload.severity, "recoverable");
    assert.equal(exceptions[0]?.payload.attemptId, "task-a-attempt-1");
    assert.deepEqual(exceptions[0]?.payload.evidenceRefs, ["task-dispatch:run-scheduler-pre-hand-failure:task-a"]);
    assert.deepEqual(exceptions[0]?.payload.providerEvidence, {
      errorExcerpt: "fake brain wake failed: [REDACTED]",
    });

    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-scheduler-pre-hand-failure");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.payload.exceptionId, exceptions[0]?.payload.exceptionId);
    assert.equal(decisions[0]?.payload.path, "retry-same-task-new-attempt");
  } finally {
    await db.close();
  }
});

test("runnable scheduler marks dispatch failure explicitly instead of leaving claimed task stuck", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-hand-fails",
      maxParallelTasks: 1,
      tasks: [
        { id: "task-a", status: "pending", sortOrder: 0, dependsOn: [] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-hand-fails", "task-a");

    const fixture = scheduler(db, { failExecuteTask: true });
    await assert.rejects(
      () => fixture.scheduler.runOnce({ runId: "run-scheduler-hand-fails" }),
      /hand execution failed for task-a/,
    );

    assert.deepEqual(fixture.executeTaskCalls.map((call) => call.taskId), ["task-a"]);
    assert.equal((await taskRow(db, "run-scheduler-hand-fails", "task-a")).status, "failed");
    const history = await listHistoryForRunPg(db, "run-scheduler-hand-fails");
    assert.equal(history.some((event) => event.eventType === "hand.execute_failed" && event.taskId === "task-a"), true);
    const handExecutions = await listResourcesPg(db, { resourceType: "hand_execution" });
    const handExecution = handExecutions.find((resource) => resource.runId === "run-scheduler-hand-fails" && resource.taskId === "task-a");
    assert.equal(handExecution?.status, "failed");
  } finally {
    await db.close();
  }
});

test("runnable scheduler records runtime exception and reprovision decision when hand submit fails", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-hand-submit-exception",
      maxParallelTasks: 1,
      tasks: [
        { id: "task-a", status: "pending", sortOrder: 0, dependsOn: [] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-hand-submit-exception", "task-a");

    const rawFailure = "Tork task execution failed: provider unreachable token sk-1234567890abcdefghijklmnopqrstuvwxyz";
    const fixture = scheduler(db, { executeTaskFailureOutput: rawFailure });
    await assert.rejects(
      () => fixture.scheduler.runOnce({ runId: "run-scheduler-hand-submit-exception" }),
      /provider unreachable/,
    );

    assert.deepEqual(fixture.executeTaskCalls.map((call) => call.taskId), ["task-a"]);
    assert.equal((await taskRow(db, "run-scheduler-hand-submit-exception", "task-a")).status, "failed");
    const history = await listHistoryForRunPg(db, "run-scheduler-hand-submit-exception");
    assert.equal(history.some((event) => event.eventType === "hand.execute_failed" && event.taskId === "task-a"), true);

    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === "run-scheduler-hand-submit-exception");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "hand_submit_failed");
    assert.equal(exceptions[0]?.payload.source, "scheduler");
    assert.equal(exceptions[0]?.payload.severity, "recoverable");
    assert.equal(exceptions[0]?.payload.handExecutionId, "hand-execution:run-scheduler-hand-submit-exception:task-a:task-a-attempt-1");
    assert.deepEqual(exceptions[0]?.payload.evidenceRefs, ["hand-execution:run-scheduler-hand-submit-exception:task-a:task-a-attempt-1"]);
    assert.deepEqual(exceptions[0]?.payload.providerEvidence, {
      errorExcerpt: "Tork task execution failed: provider unreachable token [REDACTED]",
    });

    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-scheduler-hand-submit-exception");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.payload.path, "reprovision-hand");
    assert.equal(decisions[0]?.payload.exceptionId, exceptions[0]?.payload.exceptionId);
  } finally {
    await db.close();
  }
});

test("runnable scheduler terminalizes the pre-persisted hand execution when provider throws", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-provider-throws",
      maxParallelTasks: 1,
      tasks: [{ id: "task-a", status: "pending", sortOrder: 0, dependsOn: [] }],
    });
    await seedContextPacket(db, "run-scheduler-provider-throws", "task-a");

    const fixture = scheduler(db, { throwExecuteTask: true });
    await assert.rejects(
      fixture.scheduler.runOnce({ runId: "run-scheduler-provider-throws" }),
      /provider submit threw/,
    );

    const handExecution = (await listResourcesPg(db, { resourceType: "hand_execution" }))
      .find((resource) => resource.runId === "run-scheduler-provider-throws" && resource.taskId === "task-a");
    assert.equal(handExecution?.status, "failed");
    assert.equal(handExecution?.payload.status, "failed");
    assert.equal((await taskRow(db, "run-scheduler-provider-throws", "task-a")).status, "failed");
  } finally {
    await db.close();
  }
});

test("runnable scheduler does not reopen task or hand state after a fast callback", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-fast-callback",
      maxParallelTasks: 1,
      tasks: [{ id: "task-a", status: "pending", sortOrder: 0, dependsOn: [] }],
    });
    await seedContextPacket(db, "run-scheduler-fast-callback", "task-a");

    const fixture = scheduler(db, { fastCallback: true });
    await fixture.scheduler.runOnce({ runId: "run-scheduler-fast-callback" });

    assert.equal((await taskRow(db, "run-scheduler-fast-callback", "task-a")).status, "completed");
    const handExecution = (await listResourcesPg(db, { resourceType: "hand_execution" }))
      .find((resource) => resource.runId === "run-scheduler-fast-callback" && resource.taskId === "task-a");
    assert.equal(handExecution?.status, "completed");
    assert.equal(handExecution?.payload.status, "completed");
    assert.equal(handExecution?.payload.externalJobId, "job-task-a");
    const history = await listHistoryForRunPg(db, "run-scheduler-fast-callback");
    assert.equal(history.some((event) => event.eventType === "hand.execute_queued"), false);
  } finally {
    await db.close();
  }
});

test("runnable scheduler blocks pre-execution tool proxy violations without persisting leaked intent or retrying", async () => {
  const db = await createTestPostgresDb();
  const rawToken = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const runId = "run-scheduler-tool-proxy-pre-exec-block";
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId,
      maxParallelTasks: 1,
      tasks: [
        { id: "discover", status: "completed", sortOrder: 0, dependsOn: [] },
        { id: "implement", status: "pending", sortOrder: 1, dependsOn: ["discover"] },
      ],
    });
    await seedContextPacket(db, runId, "implement");
    await seedAcceptedArtifact(db, runId, "discover", rawToken);

    const fixture = scheduler(db);
    await assert.rejects(
      () => fixture.scheduler.runOnce({ runId }),
      /raw credential payload/i,
    );

    assert.deepEqual(fixture.executeTaskCalls, []);
    assert.equal((await taskRow(db, runId, "implement")).status, "blocked");

    const intents = (await listResourcesPg(db, { resourceType: "task_execution_intent" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(intents.length, 0);
    assert.doesNotMatch(JSON.stringify(intents), new RegExp(rawToken));

    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === runId);
    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(exceptions.length, 1);
    assert.equal(decisions.length, 1);

    const retryResult = await fixture.scheduler.runOnce({ runId });
    assert.deepEqual(retryResult.dispatchedTaskIds, []);
    assert.equal(retryResult.skippedTaskIds.find((entry) => entry.taskId === "implement")?.reason, "status:blocked");
    assert.deepEqual(fixture.executeTaskCalls, []);
    assert.equal((await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === runId).length, 1);
    assert.equal((await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === runId).length, 1);
  } finally {
    await db.close();
  }
});

test("runnable scheduler releases unsupported hand providers without writing hand execution", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-hand-unsupported",
      maxParallelTasks: 1,
      tasks: [
        { id: "task-a", status: "pending", sortOrder: 0, dependsOn: [] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-hand-unsupported", "task-a");

    const fixture = scheduler(db, { omitExecuteTask: true });
    await assert.rejects(
      () => fixture.scheduler.runOnce({ runId: "run-scheduler-hand-unsupported" }),
      /does not support executeTask/,
    );

    assert.equal((await taskRow(db, "run-scheduler-hand-unsupported", "task-a")).status, "pending");
    const history = await listHistoryForRunPg(db, "run-scheduler-hand-unsupported");
    assert.equal(history.some((event) => event.eventType === "task.dispatch_prepare_failed" && event.taskId === "task-a"), true);
    assert.equal(history.some((event) => event.eventType === "hand.execute_failed" && event.taskId === "task-a"), false);
    const handExecutions = await listResourcesPg(db, { resourceType: "hand_execution" });
    assert.equal(handExecutions.some((resource) => resource.runId === "run-scheduler-hand-unsupported" && resource.taskId === "task-a"), false);
  } finally {
    await db.close();
  }
});

function scheduler(
  db: SouthstarDb,
  input: {
    failExecuteTask?: boolean;
    executeTaskFailureOutput?: string;
    failBrainWake?: boolean;
    omitExecuteTask?: boolean;
    brainProviderId?: string;
    assertHandExecutionBeforeProvider?: boolean;
    throwExecuteTask?: boolean;
    fastCallback?: boolean;
  } = {},
) {
  const executeTaskCalls: ExecuteTaskInput[] = [];
  const executeTaskBindings: HandBinding[] = [];
  let persistedBeforeProvider = false;
  const handProvider: HandProvider = createFakeHandProvider({ providerId: "fake-hand" });
  if (!input.omitExecuteTask) {
    handProvider.executeTask = async (binding, executeTaskInput) => {
      executeTaskBindings.push(binding);
      executeTaskCalls.push(executeTaskInput);
      if (input.assertHandExecutionBeforeProvider) {
        const persisted = await db.maybeOne<{ status: string; payload_json: unknown }>(
          "select status, payload_json from southstar.runtime_resources where resource_type = 'hand_execution' and resource_key = $1",
          [executeTaskInput.handExecutionId],
        );
        assert.equal(persisted?.status, "queued");
        assert.equal((persisted?.payload_json as { externalJobId?: string } | undefined)?.externalJobId, undefined);
        persistedBeforeProvider = true;
      }
      if (input.throwExecuteTask) throw new Error("provider submit threw");
      if (input.fastCallback) {
        await ingestTaskRunResultPg(db, {
          runId: executeTaskInput.runId,
          taskId: executeTaskInput.taskId,
          rootSessionId: executeTaskInput.sessionId,
          ok: true,
          attempts: 1,
          attemptId: executeTaskInput.attemptId,
          artifact: { kind: "implementation_report", summary: "fast callback completed" },
          metrics: {},
          events: [],
          receivedAt: "2026-07-11T00:00:00.000Z",
        });
      }
      if (input.failExecuteTask || input.executeTaskFailureOutput) {
        return { ok: false, output: input.executeTaskFailureOutput ?? `hand execution failed for ${executeTaskInput.taskId}`, metadata: {} };
      }
      return {
        ok: true,
        output: `job-${executeTaskInput.taskId}`,
        metadata: {
          externalJobId: `job-${executeTaskInput.taskId}`,
          handExecutionId: executeTaskInput.handExecutionId,
        },
      };
    };
  }
  return {
    executeTaskCalls,
    executeTaskBindings,
    get persistedBeforeProvider() { return persistedBeforeProvider; },
    scheduler: createRunnableTaskScheduler(db, {
    sessionStore: createPostgresSessionStore(db),
    brainProvider: createFakeBrainProvider({
      providerId: input.brainProviderId ?? "fake-brain",
      failWake: input.failBrainWake,
    }),
      handProvider,
    }),
  };
}

function dbFailingQueuedTaskUpdate(db: SouthstarDb): SouthstarDb {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) {
      if (sql.includes("update southstar.workflow_tasks set status = 'queued'")) {
        throw new Error("queued task update failed");
      }
      return await db.query<T>(sql, params);
    },
    one: db.one.bind(db),
    maybeOne: db.maybeOne.bind(db),
    tx: async (run) => await db.tx(async (tx) => await run(dbFailingQueuedTaskUpdate(tx))),
    close: db.close.bind(db),
  };
}

async function seedRun(
  db: SouthstarDb,
  input: {
    runId: string;
    maxParallelTasks: number;
    tasks: Array<{ id: string; status: string; sortOrder: number; dependsOn: string[]; rootSessionId?: string }>;
  },
): Promise<void> {
  await seedSoftwareLibraryGraph(db);
  const role = makerRole();
  const agentProfile = makerAgentProfile();
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: "running",
    domain: "software",
    goalPrompt: "schedule runnable tasks",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: input.runId,
      title: "Scheduler fixture",
      goalPrompt: "schedule runnable tasks",
      domain: "software",
      intent: "implement_feature",
      roles: [role],
      agentProfiles: [agentProfile],
      tasks: input.tasks.map((task) => ({
        id: task.id,
        name: task.id,
        domain: "software",
        dependsOn: task.dependsOn,
        roleRef: "maker",
        agentProfileRef: "software-maker-pi",
        evaluatorPipelineRef: "software-feature-quality",
        requiredArtifactRefs: ["implementation_report"],
        skillRefs: ["skill.software-implementation"],
        mcpGrantRefs: [],
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
        subagents: [],
      })),
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
      evaluators: [],
      memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true },
      vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
      mcpServers: [],
      mcpGrants: [],
      progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
      steeringPolicy: { enabled: true, acceptedSignals: [] },
      learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
      artifactContracts: [implementationReportContract()],
      evaluatorPipelines: [softwareFeatureQualityPipeline()],
      contextPolicies: [contextPolicy()],
      sessionPolicies: [sessionPolicy()],
      memoryPolicies: [memoryPolicy()],
      workspacePolicies: [workspacePolicy()],
      stopConditions: [],
      effortPolicy: {
        complexity: "standard",
        maxBrains: 1,
        maxHandsPerBrain: 1,
        maxParallelTasks: input.maxParallelTasks,
        maxToolCallsPerTask: 10,
        maxInputTokensPerBrain: 20_000,
        maxCostMicrosUsd: 100_000,
        stopWhenEvidenceSufficient: true,
      },
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await captureRunLibrarySnapshotPg(db, {
    runId: input.runId,
    manifestHash: `manifest-${input.runId}`,
    libraryObjectVersionRefs: [{
      objectKey: "skill.software-implementation",
      versionRef: "skill.software-implementation@v1",
    }],
  });

  for (const task of input.tasks) {
    await createWorkflowTaskPg(db, {
      id: task.id,
      runId: input.runId,
      taskKey: task.id,
      status: task.status,
      sortOrder: task.sortOrder,
      dependsOn: task.dependsOn,
      rootSessionId: task.rootSessionId,
    });
  }
}

async function seedContextPacket(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
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

async function seedAcceptedArtifact(db: SouthstarDb, runId: string, taskId: string, ref = `artifact-${runId}-${taskId}`): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    resourceType: "artifact_ref",
    resourceKey: `artifact-${runId}-${taskId}`,
    runId,
    taskId,
    scope: "task",
    status: "accepted",
    title: `Artifact ${taskId}`,
    payload: { ref },
  });
}

async function seedHandBinding(
  db: SouthstarDb,
  input: { id: string; runId: string; taskId: string; status: HandBinding["status"]; createdAt: string },
): Promise<void> {
  const binding: HandBinding = {
    id: input.id,
    providerId: "fake-hand",
    runId: input.runId,
    taskId: input.taskId,
    handName: "workspace",
    status: input.status,
    createdAt: input.createdAt,
    payload: { seeded: true },
  };
  await upsertRuntimeResourcePg(db, {
    id: input.id,
    resourceType: "hand_binding",
    resourceKey: input.id,
    runId: input.runId,
    taskId: input.taskId,
    scope: "hand",
    status: input.status,
    title: `Hand ${input.id}`,
    payload: binding,
    summary: { providerId: binding.providerId, taskId: binding.taskId, handName: binding.handName },
  });
  await db.query(
    "update southstar.runtime_resources set created_at = $1, updated_at = $1 where resource_type = 'hand_binding' and resource_key = $2",
    [input.createdAt, input.id],
  );
}

async function seedHandExecution(
  db: SouthstarDb,
  input: {
    handExecutionId: string;
    runId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    handBindingId: string;
    status: "queued" | "running" | "lost" | "failed";
    externalJobId: string;
  },
): Promise<void> {
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
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId: input.handExecutionId,
      providerId: "fake-hand",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      brainBindingId: "brain-binding-old",
      handBindingId: input.handBindingId,
      externalJobId: input.externalJobId,
      status: input.status,
      queuedAt: "2026-06-21T14:00:00.000Z",
      queueTimeoutSeconds: 120,
      heartbeatTimeoutSeconds: 60,
    },
    summary: { providerId: "fake-hand", attemptId: input.attemptId },
    metrics: {},
  });
}

async function taskRow(db: SouthstarDb, runId: string, taskId: string): Promise<{ status: string; root_session_id: string | null }> {
  return await db.one(
    "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
    [runId, taskId],
  );
}
