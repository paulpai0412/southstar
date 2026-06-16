import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { appendDraftEvent, createLibraryObject, listLibraryHistory } from "../../src/v2/design-library/store.ts";
import { applyWorkflowTemplatePatch } from "../../src/v2/design-library/patch.ts";

test("LLM and UI patches mutate drafts through the same typed model and audit events", () => {
  const db = openSouthstarDb(":memory:");
  const draft = createLibraryObject(db, {
    objectKey: "draft.workflow.todo-web",
    objectKind: "workflow_template",
    status: "draft",
    state: {
      schemaVersion: "southstar.library.workflow_template.v1",
      templateType: "exact",
      inputContractRef: "software-dev.contract.issue-input",
      flow: { primaryPattern: "maker_checker", secondaryPatterns: [], nodes: [], edges: [], recovery: { onValidatorFailure: "request_workflow_revision", maxAttempts: 2 } },
      outputContractRefs: ["software-dev.contract.completion-artifact"],
      evidenceContractRefs: ["software-dev.contract.implementation-artifact"],
      stopConditionValidatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"],
      lifecycle: { status: "draft", validatedByRunIds: [], failureEvidenceRefs: [] },
      reuse: { signature: "todo-web", tags: ["software"], requiredInputs: ["issueTitle"], assumptionDefaults: {}, clarificationPolicy: { askOnlyWhenMissingRequiredInput: true, askWhenSimilarityBelow: 0.85, askWhenRiskAbove: "low" }, requirementSpecSnapshot: { summary: "todo", requiredInputs: ["issueTitle"], clarifiedInputs: {}, assumptions: [], acceptanceCriteria: ["ok"], nonGoals: [], riskNotes: [] } },
    },
    actorType: "llm",
  });
  appendDraftEvent(db, {
    objectId: draft.objectId,
    eventType: "draft.opened",
    status: "draft",
    payload: { source: "llm" },
    actorType: "llm",
  });

  applyWorkflowTemplatePatch(db, {
    baseDraftId: draft.objectId,
    actor: "llm",
    rationale: "Add browser UX verification for todo-web feature acceptance.",
    operations: [{ op: "add-node", node: { id: "browser-ux-verification", nodeType: "agent_task", name: "Browser UX Verification", roleRef: "checker", agentSpecRef: "software-dev.agent.checker@1.0.0", contractRefs: ["software-dev.contract.verification-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"], capabilityRefs: ["software-dev.capability.browser-ux-verification@1.0.0"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork@1.0.0" } }],
  });
  applyWorkflowTemplatePatch(db, {
    baseDraftId: draft.objectId,
    actor: "user",
    rationale: "Connect implementation output to browser checker.",
    operations: [{ op: "add-edge", edge: { id: "implementer-to-browser-ux", from: "implementer", to: "browser-ux-verification", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.implementation-artifact"], workspaceStateRequired: true } }],
  });

  const history = listLibraryHistory(db, { objectId: draft.objectId });
  assert.equal(history.filter((event) => event.eventType === "draft.patch_applied").length, 2);
  assert.deepEqual(history.map((event) => event.sequence), [1, 2, 3, 4]);
});
