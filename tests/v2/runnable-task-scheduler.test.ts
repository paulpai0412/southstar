import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBrainProvider } from "../../src/v2/brain/fake-brain-provider.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createRunnableTaskScheduler } from "../../src/v2/scheduler/runnable-task-scheduler.ts";
import { listManagedBindingsForRunPg } from "../../src/v2/meta-harness/postgres-bindings.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
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

    const result = await scheduler(db).runOnce({ runId: "run-scheduler-dependent-ready" });

    assert.deepEqual(result.dispatchedTaskIds, ["implement"]);
    assert.equal(result.skippedTaskIds.find((entry) => entry.taskId === "discover")?.reason, "status:completed");
    const task = await taskRow(db, "run-scheduler-dependent-ready", "implement");
    assert.equal(task.status, "running");
    assert.equal(task.root_session_id, "root-run-scheduler-dependent-ready-implement");

    const bindings = await listManagedBindingsForRunPg(db, "run-scheduler-dependent-ready");
    assert.deepEqual(bindings.brainBindings.map((binding) => binding.taskId), ["implement"]);
    assert.deepEqual(bindings.handBindings.map((binding) => binding.taskId), ["implement"]);
    assert.equal(bindings.brainBindings[0]?.payload.effortPolicy.complexity, "standard");
    assert.equal(bindings.brainBindings[0]?.payload.effortPolicy.maxToolCallsPerTask, 10);

    const history = await listHistoryForRunPg(db, "run-scheduler-dependent-ready");
    assert.equal(history.some((event) => event.eventType === "brain.woke" && event.taskId === "implement"), true);
    assert.equal(history.some((event) => event.eventType === "hand.provisioned" && event.taskId === "implement"), true);
    assert.equal(history.some((event) => event.eventType === "task.dispatch_submitted" && event.taskId === "implement"), true);

    const retryResult = await scheduler(db).runOnce({ runId: "run-scheduler-dependent-ready" });
    assert.deepEqual(retryResult.dispatchedTaskIds, []);
    assert.equal(retryResult.skippedTaskIds.find((entry) => entry.taskId === "implement")?.reason, "status:running");
    const bindingsAfterRetry = await listManagedBindingsForRunPg(db, "run-scheduler-dependent-ready");
    assert.equal(bindingsAfterRetry.brainBindings.length, 1);
    assert.equal(bindingsAfterRetry.handBindings.length, 1);
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

    const result = await scheduler(db).runOnce({ runId: "run-scheduler-dependent-missing" });

    assert.deepEqual(result.dispatchedTaskIds, []);
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

    const result = await scheduler(db).runOnce({ runId: "run-scheduler-parallel-limit" });

    assert.deepEqual(result.dispatchedTaskIds, ["task-a"]);
    assert.deepEqual(
      result.skippedTaskIds.filter((entry) => entry.reason === "parallel-limit").map((entry) => entry.taskId),
      ["task-b", "task-c"],
    );
    assert.equal((await taskRow(db, "run-scheduler-parallel-limit", "task-a")).status, "running");
    assert.equal((await taskRow(db, "run-scheduler-parallel-limit", "task-b")).status, "pending");
    assert.equal((await taskRow(db, "run-scheduler-parallel-limit", "task-c")).status, "pending");
  } finally {
    await db.close();
  }
});

test("runnable scheduler counts already running tasks against maxParallelTasks", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, {
      runId: "run-scheduler-existing-running",
      maxParallelTasks: 1,
      tasks: [
        { id: "task-running", status: "running", sortOrder: 0, dependsOn: [], rootSessionId: "root-running" },
        { id: "task-ready", status: "pending", sortOrder: 1, dependsOn: [] },
      ],
    });
    await seedContextPacket(db, "run-scheduler-existing-running", "task-ready");

    const result = await scheduler(db).runOnce({ runId: "run-scheduler-existing-running" });

    assert.deepEqual(result.dispatchedTaskIds, []);
    assert.equal(result.skippedTaskIds.find((entry) => entry.taskId === "task-running")?.reason, "status:running");
    assert.equal(result.skippedTaskIds.find((entry) => entry.taskId === "task-ready")?.reason, "parallel-limit");
    assert.equal((await taskRow(db, "run-scheduler-existing-running", "task-ready")).status, "pending");
  } finally {
    await db.close();
  }
});

function scheduler(db: SouthstarDb) {
  return createRunnableTaskScheduler(db, {
    sessionStore: createPostgresSessionStore(db),
    brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
    handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
  });
}

async function seedRun(
  db: SouthstarDb,
  input: {
    runId: string;
    maxParallelTasks: number;
    tasks: Array<{ id: string; status: string; sortOrder: number; dependsOn: string[]; rootSessionId?: string }>;
  },
): Promise<void> {
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
      tasks: input.tasks.map((task) => ({
        id: task.id,
        name: task.id,
        domain: "software",
        dependsOn: task.dependsOn,
        execution: {
          engine: "tork",
          image: "node:20",
          command: ["true"],
          env: {},
          mounts: [],
          timeoutSeconds: 600,
          infraRetry: { maxAttempts: 1 },
        },
        rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
        subagents: [],
      })),
      harnessDefinitions: [],
      evaluators: [],
      memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true },
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

async function seedAcceptedArtifact(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    resourceType: "artifact_ref",
    resourceKey: `artifact-${runId}-${taskId}`,
    runId,
    taskId,
    scope: "task",
    status: "accepted",
    title: `Artifact ${taskId}`,
    payload: { ref: `artifact-${runId}-${taskId}` },
  });
}

async function taskRow(db: SouthstarDb, runId: string, taskId: string): Promise<{ status: string; root_session_id: string | null }> {
  return await db.one(
    "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
    [runId, taskId],
  );
}
