import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBrainProvider } from "../../src/v2/brain/fake-brain-provider.ts";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createManagedRuntimeLoopController, createManagedRuntimeLoopPlan } from "../../src/v2/server/runtime-loops.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";

test("managed runtime loop plan includes scheduler and recovery loops", () => {
  const plan = createManagedRuntimeLoopPlan({ schedulerIntervalMs: 1000, recoveryIntervalMs: 5000 });

  assert.deepEqual(plan.map((item) => item.id), ["executor-reconciler", "runnable-task-scheduler", "recovery-controller"]);
  assert.deepEqual(plan.map((item) => item.intervalMs), [30_000, 1000, 5000]);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
