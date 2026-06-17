import assert from "node:assert/strict";
import type { SouthstarDb } from "../../../src/v2/stores/sqlite.ts";
import { assertProductizedUiLibraryPlannerGates } from "../../../src/v2/quality/productized-ui-library-planner-gates.ts";

export const todoWebFeatureScenario = {
  id: "todo-web-feature",
  goalPrompt: "在 todo-web fixture repo 中新增 priority labels、due dates、overdue filter，保持 localStorage persistence，並更新 README usage。需要瀏覽器層級 QA 與 spec alignment review。",
  assertPlannerDraft(db: SouthstarDb, draftId: string) {
    const row = db.prepare("select payload_json from runtime_resources where resource_type = 'planner_draft' and resource_key = ?")
      .get(draftId) as { payload_json: string } | undefined;
    assert.ok(row, `planner draft not found: ${draftId}`);
    const payload = JSON.parse(row.payload_json) as { workflow: { tasks: Array<{ id: string }> } };
    const taskIds = payload.workflow.tasks.map((task) => task.id);
    assert.equal(taskIds.includes("coding-review"), true);
    assert.equal(taskIds.includes("spec-alignment"), true);
    assert.equal(taskIds.includes("browser-qa"), true);
    assert.equal(taskIds.includes("release-merge-operation"), false);
  },
  assertFinalGates(db: SouthstarDb, runId: string, timings: Parameters<typeof assertProductizedUiLibraryPlannerGates>[1]["timings"]) {
    const result = assertProductizedUiLibraryPlannerGates(db, {
      runId,
      scenarioId: "todo-web-feature",
      timings,
      visitedUiSurfaces: ["chat-tab", "workflow-new-goal", "workflow-planning", "workflow-draft-review", "operations-tab", "task-inspector", "library-alternatives", "context-sources", "operator-sheet"],
    });
    assert.equal(result.ok, true, result.failures.join("\n"));
  },
};
