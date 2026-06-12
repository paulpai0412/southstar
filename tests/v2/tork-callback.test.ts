import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun, getWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { ingestTaskRunResult } from "../../src/v2/executor/tork-callback.ts";

test("Tork callback ingests container task result into durable SQLite state", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());
  createWorkflowTask(db, {
    id: "task-1",
    runId: "run-1",
    taskKey: "task-implement",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-root",
  });

  ingestTaskRunResult(db, {
    runId: "run-1",
    taskId: "task-1",
    rootSessionId: "session-root",
    ok: true,
    attempts: 1,
    artifact: { summary: "done", commandsRun: ["npm test"], risks: [] },
    metrics: { tokens: 42, costMicrosUsd: 420, toolCalls: 3, retryCount: 0, durationMs: 1000 },
    events: [
      { eventType: "session.entry", actorType: "root-session", payload: { rootSessionId: "session-root" } },
      { eventType: "subagent.completed", actorType: "subagent", payload: { subagentId: "impl" } },
      { eventType: "evaluator.completed", actorType: "evaluator", payload: { ok: true, missingFields: [] } },
    ],
  });

  assert.deepEqual(listHistoryForRun(db, "run-1").map((event) => event.eventType), [
    "session.entry",
    "subagent.completed",
    "evaluator.completed",
    "artifact.created",
    "checkpoint.created",
    "run.completed",
  ]);
  assert.equal(listResources(db, { resourceType: "artifact", status: "accepted" }).length, 1);
  assert.equal(listResources(db, { resourceType: "session_checkpoint", status: "created" }).length, 1);
  assert.equal(JSON.parse(getWorkflowRun(db, "run-1")?.metricsJson ?? "{}").aggregate.tokens, 42);
  const task = db.prepare("select status, metrics_json from workflow_tasks where id = ?").get("task-1") as {
    status: string;
    metrics_json: string;
  };
  assert.equal(task.status, "completed");
  assert.equal(JSON.parse(task.metrics_json).aggregate.costMicrosUsd, 420);
  assert.equal(getWorkflowRun(db, "run-1")?.status, "passed");
});

test("Tork callback cleans ephemeral task materialization after ingest", () => {
  const db = openSouthstarDb(":memory:");
  const runRoot = mkdtempSync(join(tmpdir(), "southstar-callback-cleanup-"));
  const taskDir = join(runRoot, "run-1", "task-1");
  mkdirSync(taskDir, { recursive: true });
  createWorkflowRun(db, minimalRun());
  createWorkflowTask(db, {
    id: "task-1",
    runId: "run-1",
    taskKey: "task-implement",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-root",
  });

  ingestTaskRunResult(db, {
    runId: "run-1",
    taskId: "task-1",
    rootSessionId: "session-root",
    ok: true,
    attempts: 1,
    artifact: { summary: "done", commandsRun: ["npm test"], risks: [] },
    metrics: { tokens: 42, costMicrosUsd: 420, toolCalls: 3, retryCount: 0, durationMs: 1000 },
    events: [],
    materializationRoot: runRoot,
  });

  assert.equal(existsSync(taskDir), false);
});

function minimalRun() {
  return {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
