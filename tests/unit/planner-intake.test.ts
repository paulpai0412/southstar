import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRunGoalRequestFromPlannerDraftBody,
  plannerDraftReceiptFromGoalResult,
} from "../../src/v2/orchestration/planner-intake.ts";

test("planner intake normalizes JSON and SSE callers into one idempotent request", () => {
  const json = buildRunGoalRequestFromPlannerDraftBody({ goalPrompt: "  Ship feature ", cwd: " /tmp/demo ", projectRef: "demo" });
  const sse = buildRunGoalRequestFromPlannerDraftBody({ goalPrompt: "Ship feature", cwd: "/tmp/demo", projectRef: "demo" });
  assert.deepEqual(json, sse);
  assert.match(json.idempotencyKey, /^planner-draft-[a-f0-9]{24}$/);
});

test("planner intake receipt keeps phase result fields at one transport seam", () => {
  const receipt = plannerDraftReceiptFromGoalResult({
    draftId: "draft-1",
    draftStatus: "requirements_review",
    goalContractHash: "goal-hash",
    goalRequirementDraftId: "requirements-1",
    goalRequirementDraftHash: "requirements-hash",
    goalDesignPhase: "requirements_review",
    blockers: ["review"],
    validationIssues: [],
  }, "Ship feature");
  assert.deepEqual(receipt, {
    draftId: "draft-1",
    goalPrompt: "Ship feature",
    workflowId: "",
    status: "requirements_review",
    goalContractHash: "goal-hash",
    goalRequirementDraftId: "requirements-1",
    goalRequirementDraftHash: "requirements-hash",
    goalDesignPhase: "requirements_review",
    blockers: ["review"],
    validationIssues: [],
    taskSummaries: [],
  });
});
