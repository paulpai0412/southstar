import assert from "node:assert/strict";
import test from "node:test";
import { buildOperatorTaskDebugReadModelPg } from "../../src/v2/read-models/operator-task-debug.ts";
import { buildOperatorOverviewReadModelPg } from "../../src/v2/read-models/operator-overview.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { appendHistoryEventPg, createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { DeterministicFixtureComposer, seedDeterministicWorkflowGraph } from "./fixtures/deterministic-workflow-composer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("operator task debug route returns task detail, descending task history, resources, artifact refs, and actions", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-task-debug";
    const taskId = "task-implement";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "operator task debug route",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [] }),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({ cwd: "/workspace/southstar", projectRoot: "/workspace/southstar" }),
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: taskId,
      runId,
      taskKey: "Implement feature",
      status: "blocked",
      sortOrder: 1,
      dependsOn: ["task-plan"],
      rootSessionId: "session-root",
      executorTaskId: "executor-task-1",
      snapshot: { roleRef: "maker", agentProfileRef: "software-maker" },
      metrics: { attempts: 2 },
    });
    await appendHistoryEventPg(db, {
      runId,
      eventType: "run.created",
      actorType: "orchestrator",
      payload: { ignored: true },
    });
    const firstTaskEvent = await appendHistoryEventPg(db, {
      runId,
      taskId,
      sessionId: "session-root",
      eventType: "task.started",
      actorType: "orchestrator",
      payload: { step: "start" },
    });
    const secondTaskEvent = await appendHistoryEventPg(db, {
      runId,
      taskId,
      sessionId: "session-root",
      eventType: "task.blocked",
      actorType: "system",
      payload: { reason: "needs operator" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "exception-task-debug",
      runId,
      taskId,
      sessionId: "session-root",
      scope: "runtime",
      status: "observed",
      title: "Task stalled",
      payload: { kind: "callback_missing", severity: "blocking" },
      summary: { message: "callback missing" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: "artifact-task-debug",
      runId,
      taskId,
      sessionId: "session-root",
      scope: "artifact",
      status: "accepted",
      title: "Implementation artifact",
      payload: { artifactRefId: "artifact_ref:task-debug" },
      summary: { summary: "implemented" },
    });

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/ui/operator-task-debug?runId=${runId}&taskId=${taskId}`);
      assert.equal(response.status, 200);
      const envelope = await response.json() as {
        ok: true;
        kind: string;
        result: {
          schemaVersion: string;
          task: { taskId: string; taskKey: string; status: string; dependsOn: string[]; rootSessionId?: string; executorTaskId?: string };
          history: Array<{ sequence: number; eventType: string; taskId?: string; payload: unknown }>;
          resources: Array<{ resourceType: string; resourceKey: string; title?: string; summary: unknown }>;
          artifactRefs: Array<{ resourceKey: string; artifactRefId?: string; status: string }>;
          actions: Array<{ id: string; endpoint?: string; enabled: boolean; requiresConfirmation: boolean }>;
        };
      };
      assert.equal(envelope.kind, "ui-operator-task-debug");
      assert.equal(envelope.result.schemaVersion, "southstar.read_model.operator_task_debug.v1");
      assert.equal(envelope.result.task.taskId, taskId);
      assert.equal(envelope.result.task.taskKey, "Implement feature");
      assert.equal(envelope.result.task.status, "blocked");
      assert.deepEqual(envelope.result.task.dependsOn, ["task-plan"]);
      assert.equal(envelope.result.task.rootSessionId, "session-root");
      assert.equal(envelope.result.task.executorTaskId, "executor-task-1");
      assert.deepEqual(envelope.result.history.map((event) => event.sequence), [secondTaskEvent.sequence, firstTaskEvent.sequence]);
      assert.deepEqual(envelope.result.history.map((event) => event.eventType), ["task.blocked", "task.started"]);
      assert.equal(envelope.result.history.every((event) => event.taskId === taskId), true);
      assert.equal(envelope.result.resources.some((resource) =>
        resource.resourceType === "runtime_exception" &&
        resource.resourceKey === "exception-task-debug" &&
        resource.title === "Task stalled"
      ), true);
      assert.deepEqual(envelope.result.artifactRefs.map((artifact) => artifact.resourceKey), ["artifact-task-debug"]);
      assert.equal(envelope.result.artifactRefs[0]?.artifactRefId, "artifact_ref:task-debug");
      assert.equal(envelope.result.actions.some((action) =>
        action.id === "task.retry" &&
        action.endpoint === `/api/v2/runs/${runId}/tasks/${taskId}/retry` &&
        action.enabled === true &&
        action.requiresConfirmation === true
      ), true);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

test("run creation preserves planner draft cwd and operator overview exposes cwd and projectRoot", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with cwd",
      cwd: "/home/timmypai/apps/customer-todo-web",
      composer: new DeterministicFixtureComposer(),
    });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const row = await db.one<{ runtime_context_json: { cwd?: string; projectRoot?: string } }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      [run.runId],
    );
    assert.equal(row.runtime_context_json.cwd, "/home/timmypai/apps/customer-todo-web");
    assert.equal(row.runtime_context_json.projectRoot, "/home/timmypai/apps/customer-todo-web");

    const overview = await buildOperatorOverviewReadModelPg(db);
    assert.equal(overview.activeRuns[0]?.runId, run.runId);
    assert.equal(overview.activeRuns[0]?.cwd, "/home/timmypai/apps/customer-todo-web");
    assert.equal(overview.activeRuns[0]?.projectRoot, "/home/timmypai/apps/customer-todo-web");
  } finally {
    await db.close();
  }
});

test("operator task debug disables retry and request-revision for completed tasks", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDebugRunTask(db, {
      runId: "run-operator-task-debug-completed",
      taskId: "task-completed",
      status: "completed",
    });

    const model = await buildOperatorTaskDebugReadModelPg(db, {
      runId: "run-operator-task-debug-completed",
      taskId: "task-completed",
    });
    assert.equal(model.actions.find((action) => action.id === "task.retry")?.enabled, false);
    assert.equal(model.actions.find((action) => action.id === "task.request-revision")?.enabled, false);
  } finally {
    await db.close();
  }
});

test("operator task debug enables retry and request-revision for running and queued tasks", async () => {
  const db = await createTestPostgresDb();
  try {
    for (const status of ["running", "queued"] as const) {
      await seedDebugRunTask(db, {
        runId: `run-operator-task-debug-${status}`,
        taskId: `task-${status}`,
        status,
      });

      const model = await buildOperatorTaskDebugReadModelPg(db, {
        runId: `run-operator-task-debug-${status}`,
        taskId: `task-${status}`,
      });
      assert.equal(model.actions.find((action) => action.id === "task.retry")?.enabled, true, status);
      assert.equal(model.actions.find((action) => action.id === "task.request-revision")?.enabled, true, status);
    }
  } finally {
    await db.close();
  }
});

async function seedDebugRunTask(db: Awaited<ReturnType<typeof createTestPostgresDb>>, input: {
  runId: string;
  taskId: string;
  status: string;
}): Promise<void> {
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: "running",
    domain: "software",
    goalPrompt: "operator task debug action status",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [] }),
    executionProjectionJson: JSON.stringify({}),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: input.taskId,
    runId: input.runId,
    taskKey: input.taskId,
    status: input.status,
    sortOrder: 0,
    dependsOn: [],
  });
}
