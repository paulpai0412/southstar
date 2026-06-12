import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun, getWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { recomputeManagementMetrics } from "../../src/v2/stores/metrics-store.ts";

test("aggregates token, cost, tool call, retry, and duration metrics into task and run JSON", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  createWorkflowTask(db, {
    id: "task-1",
    runId: "run-1",
    taskKey: "task-1",
    status: "completed",
    sortOrder: 0,
    dependsOn: [],
  });
  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: "artifact-1",
    runId: "run-1",
    taskId: "task-1",
    scope: "task",
    status: "accepted",
    title: "Artifact",
    payload: {},
    metrics: { tokens: 120, costMicrosUsd: 2500, toolCalls: 3, retryCount: 1, durationMs: 4000 },
  });

  const metrics = recomputeManagementMetrics(db, "run-1");

  assert.deepEqual(metrics.aggregate, {
    tokens: 120,
    costMicrosUsd: 2500,
    costUsd: 0.0025,
    toolCalls: 3,
    retryCount: 1,
    durationMs: 4000,
  });
  assert.equal(JSON.parse(getWorkflowRun(db, "run-1")?.metricsJson ?? "{}").aggregate.tokens, 120);
  const task = db.prepare("select metrics_json from workflow_tasks where id = ?").get("task-1") as { metrics_json: string };
  assert.equal(JSON.parse(task.metrics_json).aggregate.costMicrosUsd, 2500);
});
