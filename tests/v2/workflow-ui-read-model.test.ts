import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowUiReadModelPg } from "../../src/v2/read-models/workflow-ui.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("workflow ui read model exposes runtime DAG and selected definition", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-workflow-ui";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "build workflow canvas",
      workflowManifestJson: JSON.stringify({
        workflowId: "wf-ui",
        tasks: [
          { id: "task-plan", name: "Plan", dependsOn: [], roleRef: "planner", agentProfileRef: "planner-codex" },
          { id: "task-build", name: "Build", dependsOn: ["task-plan"], roleRef: "builder", agentProfileRef: "builder-codex" },
        ],
      }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-plan", runId, taskKey: "Plan", status: "completed", sortOrder: 0, dependsOn: [] });
    await createWorkflowTaskPg(db, { id: "task-build", runId, taskKey: "Build", status: "running", sortOrder: 1, dependsOn: ["task-plan"] });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: "artifact-ref-task-plan",
      runId,
      taskId: "task-plan",
      scope: "artifact",
      status: "accepted",
      payload: { artifactRefId: "artifact-ref-task-plan" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: "task-envelope-build",
      runId,
      taskId: "task-build",
      scope: "task",
      status: "created",
      payload: {
        envelope: {
          role: { id: "builder" },
          agentProfile: { id: "builder-codex" },
          artifactContract: { kind: "implementation_result" },
          skills: [{ id: "southstar" }],
          materializedLibraryRefs: {
            skillRefs: ["southstar"],
            mcpGrantRefs: ["github-read"],
            toolGrantRefs: ["shell"],
          },
        },
      },
    });

    const model = await buildWorkflowUiReadModelPg(db, { runId, taskId: "task-build" });
    assert.equal(model.canvasModel.mode, "runtime");
    assert.deepEqual(model.canvasModel.edges, [{ id: "task-plan->task-build", source: "task-plan", target: "task-build", status: "satisfied" }]);
    assert.equal(model.canvasModel.nodes.find((node: { id: string }) => node.id === "task-build")?.agentProfileRef, "builder-codex");
    assert.equal(model.selectedDefinition?.taskId, "task-build");
    assert.equal((model.selectedDefinition?.artifactContract as { kind?: string } | undefined)?.kind, "implementation_result");
    assert.deepEqual((model.selectedDefinition?.materializedLibraryRefs as { skillRefs?: string[] } | undefined)?.skillRefs, ["southstar"]);
    assert.equal(model.activeDraft, null);
    assert.equal(model.agentLibrarySummary.domain, "software");
    assert.ok(model.agentLibrarySummary.roleCount > 0);
    assert.equal(model.validationIssues.length, 0);
    assert.equal(model.repairAttempts, 0);
    assert.ok(model.commands.some((command: { id: string; enabled: boolean }) => command.id === "open-agent-library" && command.enabled));
  } finally {
    await db.close();
  }
});

test("ui route exposes draft workflow canvas via /api/v2/ui/workflow", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-ui";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-draft-ui",
          tasks: [
            { id: "task-plan", name: "Plan", dependsOn: [] },
            { id: "task-build", name: "Build", dependsOn: ["task-plan"], roleRef: "builder", agentProfileRef: "builder-codex" },
          ],
        },
      },
      summary: {
        goalPrompt: "draft workflow ui",
        validationIssues: [{ path: "workflow.tasks", message: "none" }],
      },
    });

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/ui/workflow?draftId=${encodeURIComponent(draftId)}&taskId=task-build`);
      assert.equal(response.status, 200);
      const envelope = await response.json() as { ok: true; kind: string; result: Awaited<ReturnType<typeof buildWorkflowUiReadModelPg>> };
      assert.equal(envelope.ok, true);
      assert.equal(envelope.kind, "ui-workflow");
      assert.equal(envelope.result.canvasModel.mode, "draft");
      assert.equal(envelope.result.canvasModel.selectedNodeId, "task-build");
      assert.equal(envelope.result.selectedDefinition?.taskId, "task-build");
      assert.equal(envelope.result.activeDraft?.draftId, draftId);
      assert.equal(envelope.result.activeDraft?.goalPrompt, "draft workflow ui");
      assert.equal(envelope.result.validationIssues.length, 1);
      assert.equal(envelope.result.validationIssues[0]?.path, "workflow.tasks");
      assert.equal(envelope.result.repairAttempts, 0);
      assert.ok(envelope.result.commands.some((command: { id: string; enabled: boolean }) => command.id === "run-draft" && command.enabled));
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

test("ui compatibility routes mirror workflow and operator overview payloads", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-compat";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-draft-compat",
          tasks: [
            { id: "task-plan", name: "Plan", dependsOn: [] },
            { id: "task-build", name: "Build", dependsOn: ["task-plan"] },
          ],
        },
      },
      summary: {
        goalPrompt: "draft workflow compatibility",
        validationIssues: [],
      },
    });
    await createWorkflowRunPg(db, {
      id: "run-workflow-compat",
      status: "running",
      domain: "software",
      goalPrompt: "operator overview compatibility",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const workflow = await fetch(`${server.url}/api/v2/ui/workflow?draftId=${encodeURIComponent(draftId)}`);
      const workflowTab = await fetch(`${server.url}/api/v2/ui/workflow-tab?draftId=${encodeURIComponent(draftId)}`);
      assert.equal(workflow.status, 200);
      assert.equal(workflowTab.status, 200);
      const workflowEnvelope = await workflow.json() as { ok: true; kind: string; result: unknown };
      const workflowTabEnvelope = await workflowTab.json() as { ok: true; kind: string; result: unknown };
      assert.equal(workflowEnvelope.kind, "ui-workflow");
      assert.equal(workflowTabEnvelope.kind, "ui-workflow");
      assert.deepEqual(workflowTabEnvelope.result, workflowEnvelope.result);

      const operator = await fetch(`${server.url}/api/v2/ui/operator-overview`);
      const operationsTab = await fetch(`${server.url}/api/v2/ui/operations-tab`);
      const operatorAttention = await fetch(`${server.url}/api/v2/ui/operator-attention`);
      assert.equal(operator.status, 200);
      assert.equal(operationsTab.status, 200);
      assert.equal(operatorAttention.status, 200);
      const operatorEnvelope = await operator.json() as { ok: true; kind: string; result: unknown };
      const operationsEnvelope = await operationsTab.json() as { ok: true; kind: string; result: unknown };
      const attentionEnvelope = await operatorAttention.json() as { ok: true; kind: string; result: unknown };
      assert.equal(operatorEnvelope.kind, "ui-operator-overview");
      assert.equal(operationsEnvelope.kind, "ui-operator-overview");
      assert.equal(attentionEnvelope.kind, "ui-operator-overview");
      assert.deepEqual(operationsEnvelope.result, operatorEnvelope.result);
      assert.deepEqual(attentionEnvelope.result, operatorEnvelope.result);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});
