import assert from "node:assert/strict";
import test from "node:test";
import { createUiReadModelEnvelope, uiCommand } from "../../src/v2/read-models/ui-envelope.ts";
import { buildPostgresCoreReadModel } from "../../src/v2/read-models/postgres-core.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("ui read-model compatibility shim exports legacy builder symbols", async () => {
  const shim = await import("../../src/v2/ui-api/read-models.ts");

  assert.equal(typeof shim.buildWorkflowCanvasModel, "function");
  assert.equal(typeof shim.buildRuntimeMonitorModel, "function");
  assert.equal(typeof shim.buildTaskDetailModel, "function");
  assert.equal(typeof shim.buildSessionsMemoryModel, "function");
  assert.equal(typeof shim.sessionGraphResources, "function");
  assert.equal(typeof shim.buildVaultMcpModel, "function");
  assert.equal(typeof shim.buildExecutorOpsModel, "function");
});

test("ui read-model envelope includes required UI contract fields", () => {
  const envelope = createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.run_control.v1",
    kind: "run-control",
    scope: { runId: "run-ui-contract" },
    data: { runId: "run-ui-contract", status: "running" },
    commands: [
      uiCommand({
        id: "pause-run",
        label: "Pause",
        endpoint: "/api/v2/runs/run-ui-contract/pause",
        method: "POST",
        enabled: true,
      }),
    ],
    attentionItems: [],
    sourceRefs: [{ id: "run", kind: "table-row", ref: "southstar.workflow_runs:run-ui-contract" }],
    warnings: [],
    now: "2026-06-25T00:00:00.000Z",
  });

  assert.equal(envelope.schemaVersion, "southstar.read_model.run_control.v1");
  assert.equal(envelope.kind, "run-control");
  assert.equal(envelope.generatedAt, "2026-06-25T00:00:00.000Z");
  assert.equal(envelope.commands[0]?.dangerLevel, "none");
  assert.equal(envelope.commands[0]?.requiresConfirmation, false);
});

test("disabled ui command must include disabledReason", () => {
  assert.throws(
    () => uiCommand({
      id: "resume-run",
      label: "Resume",
      endpoint: "/api/v2/runs/run-ui-contract/resume",
      method: "POST",
      enabled: false,
    }),
    /disabledReason is required/,
  );
});

test("run-control read model exposes run control contract", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-ui-control";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "ui run control",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId,
      taskKey: "task-a",
      status: "queued",
      sortOrder: 0,
      dependsOn: [],
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: `runtime-exception:${runId}:task-a`,
      runId,
      taskId: "task-a",
      scope: "task",
      status: "observed",
      payload: {
        schemaVersion: "southstar.runtime.exception.v1",
        exceptionId: "ex-ui-1",
        runId,
        taskId: "task-a",
        source: "scheduler",
        kind: "scheduler_claim_stale",
        severity: "blocking",
        status: "observed",
        observedAt: "2026-06-25T01:00:00.000Z",
        evidenceRefs: [],
      },
    });

    const model = await buildPostgresCoreReadModel(db, { kind: "run-control", runId }) as any;
    assert.equal(model.schemaVersion, "southstar.read_model.run_control.v1");
    assert.equal(model.kind, "run-control");
    assert.equal(model.scope.runId, runId);
    assert.equal(model.data.runId, runId);
    assert.equal(model.data.taskCounts.queued, 1);
    assert.equal(model.data.unresolvedExceptionCount, 1);
    assert.ok(model.commands.some((command: any) => command.id === "pause-run" && command.enabled));
    assert.ok(model.attentionItems.some((item: any) => item.id === "exception:runtime-exception:run-ui-control:task-a"));
    assert.ok(model.sourceRefs.some((ref: any) => ref.ref === `southstar.workflow_runs:${runId}`));
  } finally {
    await db.close();
  }
});

test("workflow-dag read model computes dependency readiness", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-ui-dag";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "ui workflow dag",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId,
      taskKey: "task-a",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
    });
    await createWorkflowTaskPg(db, {
      id: "task-b",
      runId,
      taskKey: "task-b",
      status: "running",
      sortOrder: 1,
      dependsOn: ["task-a"],
    });
    await createWorkflowTaskPg(db, {
      id: "task-c",
      runId,
      taskKey: "task-c",
      status: "queued",
      sortOrder: 2,
      dependsOn: ["task-b"],
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: `artifact_ref:${runId}:task-a:attempt-1:hash`,
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      scope: "artifact",
      status: "accepted",
      payload: {},
    });

    const model = await buildPostgresCoreReadModel(db, { kind: "workflow-dag", runId }) as any;
    assert.equal(model.schemaVersion, "southstar.read_model.workflow_dag.v1");
    assert.equal(model.kind, "workflow-dag");
    assert.equal(model.data.nodes.length, 3);
    assert.equal(model.data.nodes.find((node: any) => node.id === "task-b")?.dependencyReady, true);
    assert.equal(model.data.nodes.find((node: any) => node.id === "task-c")?.dependencyReady, false);
  } finally {
    await db.close();
  }
});
