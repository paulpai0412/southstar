import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeLoopController } from "../../src/v2/server/runtime-loops.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { createExecutorBinding } from "../../src/v2/executor/bindings.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";

test("runtime loop starts once and stops cleanly", async () => {
  let calls = 0;
  const loop = createRuntimeLoopController({
    intervalMs: 10,
    runOnce: async () => {
      calls += 1;
    },
  });

  loop.start();
  await sleep(35);
  await loop.stop();

  assert.ok(calls >= 1);
});

test("runtime loop is single-flight while previous tick still running", async () => {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const loop = createRuntimeLoopController({
    intervalMs: 5,
    runOnce: async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(20);
      inFlight -= 1;
    },
  });

  loop.start();
  await sleep(70);
  await loop.stop();

  assert.ok(calls >= 2);
  assert.equal(maxInFlight, 1);
});

test("runtime server starts default reconcile loop when observation client is configured", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-loop",
    status: "running",
    domain: "software",
    goalPrompt: "loop",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-loop",
    runId: "run-loop",
    taskKey: "task-loop",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
  createExecutorBinding(db, {
    runId: "run-loop",
    taskId: "task-loop",
    attemptId: "attempt-1",
    torkJobId: "job-loop",
    status: "running",
    queueTimeoutSeconds: 60,
    hardTimeoutSeconds: 120,
  });

  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: { generate: async () => { throw new Error("not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("not used"); } },
    torkObservationClient: {
      capabilities: () => ({
        supportsJobInspect: true,
        supportsTaskInspect: false,
        supportsJobCancel: true,
        supportsTaskCancel: false,
        supportsJobLogs: true,
        supportsTaskLogs: false,
        supportsWorkerHealth: false,
      }),
      getJob: async () => ({ jobId: "job-loop", status: "COMPLETED" }),
      getJobLogs: async () => "done",
      cancelJob: async () => undefined,
    },
    reconcileIntervalMs: 20,
  });

  try {
    await sleep(80);
    const results = listResources(db, { resourceType: "executor_reconcile_result" })
      .filter((resource) => resource.runId === "run-loop" && resource.taskId === "task-loop");
    assert.ok(results.length >= 1);
  } finally {
    await server.close();
  }
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
