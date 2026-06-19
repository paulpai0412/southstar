import assert from "node:assert/strict";
import type { SouthstarDb } from "../../../src/v2/stores/sqlite.ts";

export const docsCliUsageScenario = {
  id: "docs-cli-usage",
  goalPrompt: "在 notes-cli fixture repo 中更新 README 與 docs，補上 import/export 指令的使用範例、錯誤處理說明與常見問題。不要修改 runtime code。",
  assertPlannerDraft(db: SouthstarDb, draftId: string) {
    const row = db.prepare(`
      select payload_json
      from runtime_resources
      where resource_type = 'planner_draft' and resource_key = ?
    `).get(draftId) as { payload_json: string } | undefined;
    assert.ok(row, `planner draft not found: ${draftId}`);
    const payload = JSON.parse(row.payload_json) as {
      workflow?: { tasks?: Array<{ id?: string; agentProfileRef?: string }> };
    };
    const tasks = payload.workflow?.tasks ?? [];
    const taskIds = tasks.flatMap((task) => task.id ? [task.id] : []);
    assert.equal(taskIds.includes("write-docs"), true);
    assert.equal(taskIds.includes("doc-check"), true);
    assert.equal(
      tasks.some((task) => task.agentProfileRef === "software.implementer.pi.workspace-write" && task.id !== "write-docs"),
      false,
    );
  },
};
