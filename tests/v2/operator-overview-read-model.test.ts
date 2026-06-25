import assert from "node:assert/strict";
import test from "node:test";
import { buildOperatorOverviewReadModelPg } from "../../src/v2/read-models/operator-overview.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

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

test("ui route exposes /api/v2/ui/operator-overview", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-overview-route";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "operator overview route",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-operator-route",
      runId,
      scope: "runtime",
      status: "observed",
      payload: { kind: "scheduler_claim_stale", severity: "blocking" },
    });

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/ui/operator-overview`);
      assert.equal(response.status, 200);
      const envelope = await response.json() as { ok: true; kind: string; result: Awaited<ReturnType<typeof buildOperatorOverviewReadModelPg>> };
      assert.equal(envelope.kind, "ui-operator-overview");
      assert.equal(envelope.result.activeRuns[0]?.runId, runId);
      assert.equal(envelope.result.attentionItems.some((item) => item.kind === "runtime_exception"), true);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});
