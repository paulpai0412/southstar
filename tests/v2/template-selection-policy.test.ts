import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { templateFallbackDecision } from "../../src/v2/ui-api/postgres-run-api.ts";

const plan = (selectedWorkflowTemplateRef?: string) => ({
  selectedWorkflowTemplateRef,
} as unknown as WorkflowCompositionPlan);

test("preferred template fallback becomes an explicit blocking decision", () => {
  const decision = templateFallbackDecision({
    draftId: "draft-1",
    goalDesignPackage: {
      templatePolicy: {
        mode: "prefer",
        templateRef: "template.authored",
        versionRef: "template.authored@v1",
      },
    } as never,
    attempts: [{
      composition: plan("template.authored"),
      validation: { ok: false, issues: [{ code: "template_slot_mismatch", path: "tasks", message: "incompatible" }] },
    }],
    finalComposition: plan("template.generated"),
  });

  assert.equal(decision?.draftId, "draft-1");
  assert.equal(decision?.policy.mode, "prefer");
  assert.equal(decision?.finalSelectedWorkflowTemplateRef, "template.generated");
  assert.equal(decision?.rejectedAttempt.validation.ok, false);
});

test("template fallback decision is absent when the preferred template is selected", () => {
  const decision = templateFallbackDecision({
    draftId: "draft-2",
    goalDesignPackage: {
      templatePolicy: {
        mode: "prefer",
        templateRef: "template.authored",
        versionRef: "template.authored@v1",
      },
    } as never,
    attempts: [{
      composition: plan("template.authored"),
      validation: { ok: true, issues: [] },
    }],
    finalComposition: plan("template.authored"),
  });

  assert.equal(decision, null);
});
