import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { buildOperatorOverviewReadModelPg } from "../../src/v2/read-models/operator-overview.ts";

test("operator overview returns active runs and attention items", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-overview";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "operator overview",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-build", runId, taskKey: "Build", status: "running", sortOrder: 0, dependsOn: [] });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-operator",
      runId,
      taskId: "task-build",
      scope: "runtime",
      status: "observed",
      title: "Heartbeat lost",
      payload: { kind: "tork_running_hang", severity: "blocking", handExecutionId: "job-build" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "approval",
      resourceKey: "approval-operator",
      runId,
      taskId: "task-build",
      scope: "approval",
      status: "pending",
      title: "Approve recovery",
      payload: { actionType: "recovery" },
    });

    const model = await buildOperatorOverviewReadModelPg(db);
    assert.deepEqual(model.activeRuns.map((run) => run.runId), [runId]);
    assert.equal(model.attentionItems.some((item) => item.kind === "runtime_exception" && item.severity === "blocked"), true);
    assert.equal(model.attentionItems.some((item) => item.kind === "approval" && item.severity === "warning"), true);
    assert.equal(model.defaultSelection?.runId, runId);
  } finally {
    await db.close();
  }
});
