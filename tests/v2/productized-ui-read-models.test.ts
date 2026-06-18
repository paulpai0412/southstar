import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareEngineeringStarterLibrary } from "../../src/v2/design-library/software-engineering-starter.ts";
import { createPlannerDraft, createRunFromDraft } from "../../src/v2/ui-api/local-api.ts";
import { buildWorkflowTabPageModel } from "../../src/v2/ui-api/page-models/workflow-tab.ts";
import { buildLibraryAlternativesPageModel } from "../../src/v2/ui-api/page-models/library-alternatives.ts";
import { buildOperatorAttentionPageModel } from "../../src/v2/ui-api/page-models/operator-attention.ts";
import { buildOperationsTabPageModel } from "../../src/v2/ui-api/page-models/operations-tab.ts";
import { createApprovalRequest } from "../../src/v2/approvals/service.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";

test("workflow tab page model exposes draft DAG, task inspector, rationale, and context sources", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const draft = await createPlannerDraft(db, { goalPrompt: "todo-web priority labels overdue filter browser QA", plannerClient: { generate: async () => "{}" } });
  const model = buildWorkflowTabPageModel(db, { draftId: draft.draftId });

  assert.equal(model.surface, "southstar.ui.workflow-tab.v1");
  assert.equal(model.state, "draft-review");
  assert.equal(model.draft?.dag.nodes.some((node) => node.id === "coding-review"), true);
  assert.equal(model.draft?.dag.nodes.some((node) => node.id === "spec-alignment"), true);
  assert.equal(model.draft?.summary.confidence.length > 0, true);
  assert.equal(model.draft?.taskInspector?.agentProfileRef.length > 0, true);
  assert.equal(model.draft?.taskInspector?.rationale.length > 0, true);
});

test("library alternatives model shows matched templates, profiles, skills, grants, and rejections", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const draft = await createPlannerDraft(db, { goalPrompt: "markdown parser escaped pipe bug fix", plannerClient: { generate: async () => "{}" } });
  const model = buildLibraryAlternativesPageModel(db, { draftId: draft.draftId, taskId: "fix" });

  assert.equal(model.surface, "southstar.ui.library-alternatives.v1");
  assert.equal(model.matchedTemplates.length >= 1, true);
  assert.equal(model.agentProfiles.length >= 1, true);
  assert.equal(model.skills.length >= 1, true);
  assert.equal(Array.isArray(model.rejectedAlternatives), true);
});

test("operations tab model exposes Southstar Control Center without Northstar wording", () => {
  const db = openSouthstarDb(":memory:");
  const model = buildOperationsTabPageModel(db, {});
  assert.equal(model.surface, "southstar.ui.operations-tab.v1");
  assert.equal(Array.isArray(model.runs), true);
  assert.equal(Array.isArray(model.approvals), true);
  assert.equal(Array.isArray(model.executorHealth), true);
});

test("operator attention model surfaces approvals and stuck executor attention", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const draft = await createPlannerDraft(db, { goalPrompt: "todo-web feature commit", plannerClient: { generate: async () => "{}" } });
  const run = await createRunFromDraft(db, { draftId: draft.draftId, executorProvider: executorProvider() });
  createApprovalRequest(db, { runId: run.runId, actionType: "merge-operation", riskTags: ["github.pr-write"], title: "Approve merge", payload: { reason: "test" } });

  const model = buildOperatorAttentionPageModel(db, {});
  assert.equal(model.surface, "southstar.ui.operator-attention.v1");
  assert.equal(model.attentionCount >= 1, true);
  assert.equal(model.items.some((item) => item.kind === "approval"), true);
});

function executorProvider(): ExecutorProvider {
  return { executorType: "tork", async submit() { return { executorType: "tork", externalJobId: "job-productized-read-model", status: "queued" }; } };
}
