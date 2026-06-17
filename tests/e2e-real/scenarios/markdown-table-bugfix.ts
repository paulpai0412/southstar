import assert from "node:assert/strict";
import type { SouthstarDb } from "../../../src/v2/stores/sqlite.ts";

export const markdownTableBugfixScenario = {
  id: "markdown-table-bugfix",
  goalPrompt: "在 markdown-notes fixture repo 中診斷並修復 table parser 在 escaped pipe 與 code span 中切欄錯誤的 bug。先重現失敗，再修復，最後補 regression tests。",
  assertPlannerDraft(db: SouthstarDb, draftId: string) {
    const row = db.prepare("select payload_json from runtime_resources where resource_type = 'planner_draft' and resource_key = ?")
      .get(draftId) as { payload_json: string } | undefined;
    assert.ok(row, `planner draft not found: ${draftId}`);
    const payload = JSON.parse(row.payload_json) as { workflow: { tasks: Array<{ id: string }> } };
    const taskIds = payload.workflow.tasks.map((task) => task.id);
    assert.equal(taskIds.includes("reproduce"), true);
    assert.equal(taskIds.includes("diagnose"), true);
    assert.equal(taskIds.includes("fix"), true);
    assert.equal(taskIds.includes("regression-check"), true);
    assert.equal(taskIds.includes("browser-qa"), false);
  },
};
