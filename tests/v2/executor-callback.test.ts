import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { ingestExecutorCallback } from "../../src/v2/executor/callback.ts";

function db() {
  return openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-executor-callback-")), "db.sqlite3"));
}

test("executor callback rejects unknown task", () => {
  const sqlite = db();
  assert.throws(() => ingestExecutorCallback(sqlite, {
    runId: "run-missing",
    taskId: "task-missing",
    rootSessionId: "root-1",
    ok: true,
    attempts: 1,
    artifact: {},
    metrics: {},
    events: [],
  }), /callback task not found/);
});

test("executor callback rejects unknown executor binding when provided", () => {
  const sqlite = db();
  createWorkflowRun(sqlite, {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "goal",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: JSON.stringify(null),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  createWorkflowTask(sqlite, {
    id: "task-1",
    runId: "run-1",
    taskKey: "task-1",
    status: "pending",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "root-run-1-task-1",
    snapshot: {},
  });

  assert.throws(() => ingestExecutorCallback(sqlite, {
    runId: "run-1",
    taskId: "task-1",
    rootSessionId: "root-run-1-task-1",
    executorBindingId: "exec-missing",
    ok: true,
    attempts: 1,
    artifact: {},
    metrics: {},
    events: [],
  }), /executor binding not found/);

  upsertRuntimeResource(sqlite, {
    resourceType: "executor_binding",
    resourceKey: "exec-1",
    runId: "run-1",
    taskId: "task-1",
    scope: "executor",
    status: "running",
    payload: { executorType: "tork" },
  });

  ingestExecutorCallback(sqlite, {
    runId: "run-1",
    taskId: "task-1",
    rootSessionId: "root-run-1-task-1",
    executorBindingId: "exec-1",
    ok: true,
    attempts: 1,
    artifact: { status: "ok" },
    metrics: {},
    events: [],
  });

  const row = sqlite.prepare("select status from workflow_tasks where run_id = ? and id = ?").get("run-1", "task-1") as { status: string };
  assert.equal(row.status, "completed");
});
