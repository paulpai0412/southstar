import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { appendRuntimeEvent } from "../../src/v2/signals/events.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { buildReadModel } from "../../src/v2/read-models/registry.ts";

const runId = "run-read-model-1";

test("read model registry wraps workflow canvas in a versioned envelope", () => {
  const db = seededDb();

  const envelope = buildReadModel(db, { kind: "workflow-canvas", runId });

  assert.equal(envelope.schemaVersion, "southstar.read_model.workflow_canvas.v1");
  assert.equal(envelope.kind, "workflow-canvas");
  assert.equal(typeof envelope.generatedAt, "string");
  assert.deepEqual(envelope.diagnostics, { stale: false, warnings: [] });
  assert.deepEqual(envelope.data, {
    runId,
    status: "running",
    nodes: [{ id: "task-1", label: "task-implement", status: "running", dependsOn: [] }],
  });
});

test("read model registry builds task-detail and run-inspection envelopes", () => {
  const db = seededDb();
  upsertRuntimeResource(db, {
    resourceType: "executor_binding",
    resourceKey: "binding-1",
    runId,
    taskId: "task-1",
    scope: "executor",
    status: "running",
    payload: { executorType: "tork", torkJobId: "job-1" },
  });

  const taskDetail = buildReadModel(db, { kind: "task-detail", runId, taskId: "task-1" });
  const inspection = buildReadModel(db, { kind: "run-inspection", runId });

  assert.equal(taskDetail.schemaVersion, "southstar.read_model.task_detail.v1");
  assert.equal(taskDetail.kind, "task-detail");
  assert.equal((taskDetail.data as { taskKey?: string }).taskKey, "task-implement");
  assert.equal(inspection.schemaVersion, "southstar.read_model.run_inspection.v1");
  assert.equal(inspection.kind, "run-inspection");
  assert.equal((inspection.data as { runId?: string }).runId, runId);
});

test("read model registry rejects missing taskId for task-detail", () => {
  const db = seededDb();

  assert.throws(
    () => buildReadModel(db, { kind: "task-detail", runId }),
    /taskId is required for task-detail read model/,
  );
});

test("read model registry exposes runtime-monitor, executor-ops, sessions-memory, and vault-mcp", () => {
  const db = seededDb();
  appendRuntimeEvent(db, {
    runId,
    taskId: "task-1",
    eventType: "progress.commentary",
    actorType: "agent",
    payload: { message: "running tests" },
  });
  upsertRuntimeResource(db, {
    resourceType: "session",
    resourceKey: "session-1",
    runId,
    taskId: "task-1",
    sessionId: "session-1",
    scope: "task",
    status: "active",
    payload: { summary: "root" },
  });
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "memory-1",
    runId,
    scope: "software",
    status: "approved",
    payload: { preference: "minimal" },
  });
  upsertRuntimeResource(db, {
    resourceType: "vault_lease",
    resourceKey: "lease-1",
    runId,
    taskId: "task-1",
    scope: "task",
    status: "active",
    payload: { secretRef: "github-token" },
  });
  upsertRuntimeResource(db, {
    resourceType: "mcp_grant",
    resourceKey: "mcp-1",
    runId,
    taskId: "task-1",
    scope: "task",
    status: "active",
    payload: { serverId: "github" },
  });

  assert.equal(buildReadModel(db, { kind: "runtime-monitor", runId }).kind, "runtime-monitor");
  assert.equal(buildReadModel(db, { kind: "executor-ops", runId }).kind, "executor-ops");
  assert.equal(buildReadModel(db, { kind: "sessions-memory", runId }).kind, "sessions-memory");
  assert.equal(buildReadModel(db, { kind: "vault-mcp", runId }).kind, "vault-mcp");
});

function seededDb() {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "inspect read models",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-1",
    runId,
    taskKey: "task-implement",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
  return db;
}
