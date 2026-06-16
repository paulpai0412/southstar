import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { appendRuntimeEvent } from "../../src/v2/signals/events.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { buildRuntimeMonitorData } from "../../src/v2/read-models/runtime-monitor.ts";
import { buildTaskDetailData } from "../../src/v2/read-models/task-detail.ts";
import { buildWorkflowCanvasData } from "../../src/v2/read-models/workflow-canvas.ts";
import { buildSessionsMemoryData } from "../../src/v2/read-models/sessions-memory.ts";
import { buildVaultMcpData } from "../../src/v2/read-models/vault-mcp.ts";
import { buildExecutorOpsData } from "../../src/v2/read-models/executor-ops.ts";

test("builds workflow canvas from SQLite run and tasks", () => {
  const db = seededDb();

  assert.deepEqual(buildWorkflowCanvasData(db, "run-1"), {
    runId: "run-1",
    status: "running",
    nodes: [{
      id: "task-1",
      label: "task-implement",
      status: "running",
      dependsOn: [],
    }],
  });
});

test("builds runtime monitor from history and executor binding", () => {
  const db = seededDb();
  appendRuntimeEvent(db, {
    runId: "run-1",
    taskId: "task-1",
    eventType: "progress.commentary",
    actorType: "agent",
    payload: { message: "running tests" },
  });
  appendRuntimeEvent(db, {
    runId: "run-1",
    eventType: "steering.received",
    actorType: "user",
    payload: { message: "keep minimal" },
  });
  upsertRuntimeResource(db, {
    resourceType: "executor_binding",
    resourceKey: "binding-1",
    runId: "run-1",
    taskId: "task-1",
    scope: "executor",
    status: "running",
    payload: { executorType: "tork", torkJobId: "job-1" },
  });

  assert.deepEqual(buildRuntimeMonitorData(db, "run-1"), {
    runId: "run-1",
    status: "running",
    latestProgress: "running tests",
    latestSteering: "keep minimal",
    executorJobIds: ["job-1"],
    runningTaskIds: ["task-1"],
  });
});

test("builds task, sessions-memory, vault-mcp, and executor models", () => {
  const db = seededDb();
  upsertRuntimeResource(db, {
    resourceType: "session",
    resourceKey: "session-root",
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-root",
    scope: "task",
    status: "active",
    payload: { summary: "root session" },
  });
  upsertRuntimeResource(db, {
    resourceType: "session_node",
    resourceKey: "session-node-1",
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-root",
    scope: "session",
    status: "active",
    payload: { baseCheckpointId: "checkpoint-1" },
  });
  upsertRuntimeResource(db, {
    resourceType: "recovery_decision",
    resourceKey: "recovery-1",
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-root",
    scope: "session",
    status: "recorded",
    payload: { strategy: "fork-from-checkpoint" },
  });
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "mem-1",
    runId: "run-1",
    scope: "software",
    status: "approved",
    payload: { preference: "minimal" },
  });
  upsertRuntimeResource(db, {
    resourceType: "vault_lease",
    resourceKey: "lease-1",
    runId: "run-1",
    taskId: "task-1",
    scope: "task",
    status: "active",
    payload: { secretRef: "github-token" },
  });
  upsertRuntimeResource(db, {
    resourceType: "mcp_grant",
    resourceKey: "mcp-1",
    runId: "run-1",
    taskId: "task-1",
    scope: "task",
    status: "active",
    payload: { serverId: "github", allowedTools: ["issues.read"] },
  });
  upsertRuntimeResource(db, {
    resourceType: "executor_binding",
    resourceKey: "binding-1",
    runId: "run-1",
    taskId: "task-1",
    scope: "executor",
    status: "running",
    payload: { executorType: "tork", torkJobId: "job-1" },
  });

  assert.equal(buildTaskDetailData(db, "run-1", "task-1")?.taskKey, "task-implement");
  assert.deepEqual(buildSessionsMemoryData(db, "run-1").sessions.map((resource) => resource.resourceType), [
    "session",
    "session_node",
    "recovery_decision",
  ]);
  assert.equal(buildSessionsMemoryData(db, "run-1").memoryItems.length, 1);
  assert.equal(buildVaultMcpData(db, "run-1").vaultLeases.length, 1);
  assert.equal(buildVaultMcpData(db, "run-1").mcpGrants.length, 1);
  assert.deepEqual(buildExecutorOpsData(db, "run-1").bindings.map((binding) => binding.torkJobId), ["job-1"]);
});

function seededDb() {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-1",
    runId: "run-1",
    taskKey: "task-implement",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
  return db;
}
