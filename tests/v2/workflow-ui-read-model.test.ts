import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { buildWorkflowUiReadModelPg } from "../../src/v2/read-models/workflow-ui.ts";

test("workflow ui read model exposes semantic canvas and selected definition", async () => {
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
    assert.equal(model.canvasModel.nodes.find((node) => node.id === "task-build")?.agentProfileRef, "builder-codex");
    assert.equal(model.selectedDefinition?.taskId, "task-build");
    assert.equal(model.selectedDefinition?.artifactContract?.kind, "implementation_result");
    assert.deepEqual(model.selectedDefinition?.materializedLibraryRefs?.skillRefs, ["southstar"]);
  } finally {
    await db.close();
  }
});
