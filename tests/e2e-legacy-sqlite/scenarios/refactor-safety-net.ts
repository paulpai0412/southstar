import assert from "node:assert/strict";
import type { SouthstarDb } from "../../../src/v2/stores/sqlite.ts";

export const refactorSafetyNetScenario = {
  id: "refactor-safety-net",
  goalPrompt: "在 task-runner fixture repo 中重構 command execution module，降低重複邏輯但不可改變公開 CLI 行為。先建立 baseline tests，再重構，最後跑 regression suite。",
  assertPlannerDraft(db: SouthstarDb, draftId: string) {
    const row = db.prepare(`
      select payload_json
      from runtime_resources
      where resource_type = 'planner_draft' and resource_key = ?
    `).get(draftId) as { payload_json: string } | undefined;
    assert.ok(row, `planner draft not found: ${draftId}`);
    const payload = JSON.parse(row.payload_json) as {
      workflow?: { tasks?: Array<{ id?: string }> };
    };
    const taskIds = (payload.workflow?.tasks ?? []).flatMap((task) => task.id ? [task.id] : []);
    assert.equal(taskIds.includes("baseline-check"), true);
    assert.equal(taskIds.includes("refactor"), true);
    assert.equal(taskIds.includes("regression-check"), true);
    assert.equal(taskIds.includes("coding-review"), true);
    assert.equal(taskIds.includes("spec-alignment"), true);
  },
};
