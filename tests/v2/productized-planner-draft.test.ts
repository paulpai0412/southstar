import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareEngineeringStarterLibrary } from "../../src/v2/design-library/software-engineering-starter.ts";
import { createPlannerDraft } from "../../src/v2/ui-api/local-api.ts";

test("createPlannerDraft persists library-aware planner traces for non-calc feature goal", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });

  const draft = await createPlannerDraft(db, {
    goalPrompt: "在 todo-web fixture repo 中新增 priority labels、due dates、overdue filter，保持 localStorage persistence，並更新 README usage。需要瀏覽器層級 QA 與 spec alignment review。",
    plannerClient: { generate: async () => "{}" },
  });

  assert.match(draft.draftId, /^draft-/);
  const resources = db.prepare("select resource_type, resource_key, payload_json from runtime_resources order by resource_type, resource_key").all() as Array<{ resource_type: string; resource_key: string; payload_json: string }>;
  assert.equal(resources.some((row) => row.resource_type === "planner_draft" && row.resource_key === draft.draftId), true);
  assert.equal(resources.some((row) => row.resource_type === "library_search_trace"), true);
  assert.equal(resources.some((row) => row.resource_type === "agent_composition_trace"), true);
  assert.equal(resources.some((row) => row.resource_type === "template_selection_trace"), true);
  assert.equal(resources.some((row) => row.resource_type === "planner_decision_trace"), true);

  const draftPayload = JSON.parse(resources.find((row) => row.resource_type === "planner_draft" && row.resource_key === draft.draftId)!.payload_json) as { workflow: { tasks: Array<{ id: string; agentProfileRef?: string }> }; plannerTrace: { model: string } };
  assert.equal(draftPayload.plannerTrace.model, "southstar-library-aware-planner");
  assert.equal(draftPayload.workflow.tasks.some((task) => task.id === "browser-qa"), true);
  assert.equal(draftPayload.workflow.tasks.some((task) => task.id === "coding-review"), true);
  assert.equal(draftPayload.workflow.tasks.some((task) => task.id === "spec-alignment"), true);
});
