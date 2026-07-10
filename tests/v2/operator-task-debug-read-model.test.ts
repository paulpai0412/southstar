import assert from "node:assert/strict";
import test from "node:test";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
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
      resourceType: "session_checkpoint",
      resourceKey: "checkpoint-task-debug",
      runId,
      taskId,
      sessionId: "session-root",
      scope: "session",
      status: "created",
      title: "Checkpoint",
      payload: { summary: "session checkpoint content" },
      summary: { message: "checkpoint summary" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "memory_item",
      resourceKey: "memory-task-debug",
      runId,
      taskId: "task-plan",
      sessionId: "session-root",
      scope: "memory",
      status: "active",
      title: "Run memory",
      payload: { text: "remember implementation plan content" },
      summary: { source: "plan" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "context_packet",
      resourceKey: "context-task-debug",
      runId,
      taskId,
      sessionId: "session-root",
      scope: "context",
      status: "created",
      title: "Context packet",
      payload: {
        id: "context-task-debug",
        selectedMemories: [{ title: "Selected memory", text: "selected memory content", sourceRef: "memory_item:memory-task-debug" }],
        priorArtifacts: [{ title: "Prior artifact", text: "prior artifact content", sourceRef: "artifact_ref:prior" }],
        managedSourceRefs: { rawEventRefs: [{ sequence: firstTaskEvent.sequence, sessionId: "session-root" }] },
      },
      summary: { tokenEstimate: 123 },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: "envelope-task-debug",
      runId,
      taskId,
      sessionId: "session-root",
      scope: "task",
      status: "materialized",
      title: "Task envelope",
      payload: { envelope: { taskId, prompt: "full task envelope content" } },
      summary: { contextPacketId: "context-task-debug" },
    });
    const writtenArtifact = await acceptOrRejectArtifactRefPg(db, {
      runId,
      taskId,
      sessionId: "session-root",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution-task-debug",
      producer: { actorType: "hand", providerId: "test" },
      artifactType: "implementation_report",
      status: "accepted",
      content: { report: "artifact blob content" },
      contractRefs: ["implementation_report"],
      summary: "implemented",
      evidenceRefs: [],
      evaluatorResultRefs: [],
      sourceEventRefs: [],
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
          debug: {
            session: { checkpoints: unknown[]; history: unknown[]; rawEventRefs: unknown[] };
            context: { packets: Array<{ payload: { selectedMemories?: unknown[] } }> };
            envelope: { envelopes: Array<{ payload: unknown }> };
            memory: { items: Array<{ payload: unknown }>; selectedMemories: unknown[] };
            artifacts: { refs: Array<{ resourceKey: string; content?: { content?: unknown }; contentError?: string }>; priorArtifacts: unknown[] };
          };
          actions: Array<{ id: string; label?: string; endpoint?: string; enabled: boolean; requiresConfirmation: boolean; disabledReason?: string }>;
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
      assert.deepEqual(envelope.result.history.map((event) => event.sequence), [secondTaskEvent.sequence + 1, secondTaskEvent.sequence, firstTaskEvent.sequence]);
      assert.deepEqual(envelope.result.history.map((event) => event.eventType), ["artifact.accepted", "task.blocked", "task.started"]);
      assert.equal(envelope.result.history.every((event) => event.taskId === taskId), true);
      assert.equal(envelope.result.resources.some((resource) =>
        resource.resourceType === "runtime_exception" &&
        resource.resourceKey === "exception-task-debug" &&
        resource.title === "Task stalled"
      ), true);
      assert.equal(envelope.result.artifactRefs.some((artifact) => artifact.resourceKey === "artifact-task-debug"), true);
      assert.equal(envelope.result.artifactRefs.some((artifact) => artifact.artifactRefId === "artifact_ref:task-debug"), true);
      assert.equal(envelope.result.debug.session.checkpoints.length > 0, true);
      assert.equal(envelope.result.debug.session.history.some((event) => JSON.stringify(event).includes("needs operator")), true);
      assert.equal(envelope.result.debug.session.rawEventRefs.length, 1);
      assert.equal(JSON.stringify(envelope.result.debug.context.packets[0]?.payload).includes("selected memory content"), true);
      assert.equal(JSON.stringify(envelope.result.debug.envelope.envelopes[0]?.payload).includes("full task envelope content"), true);
      assert.equal(JSON.stringify(envelope.result.debug.memory.items[0]?.payload).includes("remember implementation plan content"), true);
      assert.equal(JSON.stringify(envelope.result.debug.memory.selectedMemories).includes("selected memory content"), true);
      assert.equal(JSON.stringify(envelope.result.debug.artifacts.priorArtifacts).includes("prior artifact content"), true);
      assert.equal(
        envelope.result.debug.artifacts.refs.some((artifact) =>
          artifact.resourceKey === writtenArtifact.artifactRefId &&
          JSON.stringify(artifact.content?.content).includes("artifact blob content")
        ),
        true,
      );
      assert.equal(envelope.result.actions.some((action) =>
        action.id === "task.retry" &&
        action.endpoint === `/api/v2/runs/${runId}/tasks/${taskId}/retry` &&
        action.enabled === true &&
        action.requiresConfirmation === true
      ), true);
      assert.deepEqual(envelope.result.actions.map((action) => action.id), [
        "task.retry",
        "task.fork-session",
        "task.reset-session",
        "task.rollback-session",
        "task.request-revision",
      ]);
      assert.equal(envelope.result.actions.find((action) => action.id === "task.request-revision")?.label, "Request Workflow Revision");
      assert.equal(envelope.result.actions.find((action) => action.id === "task.rollback-session")?.enabled, false);
      assert.equal(envelope.result.actions.find((action) => action.id === "task.rollback-session")?.disabledReason, "rollback requires a usable workspace snapshot");
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

test("operator task debug disables task recovery actions for completed tasks", async () => {
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
    for (const id of ["task.retry", "task.fork-session", "task.reset-session", "task.rollback-session", "task.request-revision"]) {
      assert.equal(model.actions.find((action) => action.id === id)?.enabled, false, id);
    }
  } finally {
    await db.close();
  }
});

test("operator task debug enables task recovery actions for running and queued tasks", async () => {
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
      for (const id of ["task.retry", "task.fork-session", "task.reset-session", "task.request-revision"]) {
        assert.equal(model.actions.find((action) => action.id === id)?.enabled, true, `${status}:${id}`);
      }
      assert.equal(model.actions.find((action) => action.id === "task.rollback-session")?.enabled, false, status);
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
