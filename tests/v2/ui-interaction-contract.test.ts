import test from "node:test";
import assert from "node:assert/strict";
import { finalizeGoalRequirementDraft } from "../../src/v2/orchestration/goal-requirement-draft.ts";
import {
  finalizeUiInteractionContract,
  reviseUiInteractionContract,
  uiInteractionContractHash,
  validateUiInteractionContract,
  type UiInteractionContractInputV1,
  type UiInteractionContractV1,
} from "../../src/v2/orchestration/ui-interaction-contract.ts";

test("UI contract binds required states and actions to real criteria", () => {
  const draft = knownRequirementDraft();
  const contract = finalizeUiInteractionContract(knownContractInput(draft), draft);
  assert.equal(contract.id, "ui-review");
  assert.equal(contract.status, "draft");
  assert.equal(validateUiInteractionContract(contract, draft).length, 0);
});

test("UI contract rejects unknown elements, states, actions and criteria", () => {
  const draft = knownRequirementDraft();
  const valid = finalizeUiInteractionContract(knownContractInput(draft), draft);
  const invalid = structuredClone(valid) as UiInteractionContractV1;
  invalid.screens[0]!.actions[0]!.triggerElementId = "element-missing";
  invalid.screens[0]!.actions[0]!.toState = "missing";
  invalid.flows[0]!.steps = ["action-missing"];
  invalid.criterionBindings[0]!.criterionId = "criterion-missing";
  invalid.contractHash = hashWithoutContractHash(invalid);
  const issues = validateUiInteractionContract(invalid, draft);
  assert.ok(issues.some((entry) => entry.code === "unknown_criterion"));
  assert.ok(issues.some((entry) => entry.code === "unknown_action_element"));
  assert.ok(issues.some((entry) => entry.code === "unknown_transition_state"));
  assert.ok(issues.some((entry) => entry.code === "unknown_flow_action"));
});

test("UI contract freezes the bound Criterion version and rejects stale bindings", () => {
  const draft = knownRequirementDraft();
  const contract = finalizeUiInteractionContract(knownContractInput(draft), draft);
  assert.equal(contract.criterionBindings[0]!.criterionVersion, 1);

  const revisedDraft = structuredClone(draft);
  revisedDraft.requirements[0]!.acceptanceCriteria[0]!.version = 2;
  const issues = validateUiInteractionContract(contract, revisedDraft);
  assert.ok(issues.some((entry) => entry.code === "stale_criterion_binding"));
});

test("UI contract revisions preserve identity and lineage and confirmation is hashed", () => {
  const draft = knownRequirementDraft();
  const initial = finalizeUiInteractionContract(knownContractInput(draft), draft);
  const edited = reviseUiInteractionContract(initial, {
    kind: "update_element",
    screenId: "screen-review",
    elementId: "element-reveal",
    patch: { label: "Show answer" },
  }, draft);
  assert.equal(edited.id, initial.id);
  assert.equal(edited.revision, 2);
  assert.equal(edited.parentRevision, 1);
  assert.equal(edited.status, "draft");
  assert.notEqual(edited.contractHash, initial.contractHash);

  const confirmed = reviseUiInteractionContract(edited, { kind: "confirm" }, draft);
  assert.equal(confirmed.revision, 3);
  assert.equal(confirmed.parentRevision, 2);
  assert.equal(confirmed.status, "confirmed");
  assert.notEqual(confirmed.contractHash, edited.contractHash);

  const reopened = reviseUiInteractionContract(confirmed, {
    kind: "update_screen",
    screenId: "screen-review",
    patch: { purpose: "Review and reveal one card" },
  }, draft);
  assert.equal(reopened.status, "draft");
});

test("UI contract cannot bind an undeclared contract id to a requirement", () => {
  const draft = knownRequirementDraft();
  assert.throws(
    () => finalizeUiInteractionContract(knownContractInput(draft), draft, { id: "ui-other" }),
    /unlinked_requirement/,
  );
});

function knownRequirementDraft() {
  return finalizeGoalRequirementDraft({
    goalPrompt: "Build a review interaction",
    cwd: "/workspace",
    summary: "Review a card and reveal its answer.",
    requirements: [{
      title: "Review card",
      statement: "A learner can reveal the answer for a card.",
      source: "explicit",
      blocking: true,
      userVisibleBehaviors: ["The answer is hidden until requested."],
      businessRules: [],
      acceptanceCriteria: [{
        observableClaim: "Activating reveal changes the question state to the answer state.",
        blocking: true,
        verificationIntent: ["Exercise reveal and inspect the resulting answer state."],
        requiredAssurance: ["browser_interaction"],
        evidenceIntent: ["screenshot", "url"],
      }],
      expectedOutcomeArtifacts: [{ description: "Review interaction" }],
      verificationIntent: ["Exercise the reveal action."],
      assumptions: [],
      openQuestions: [],
      riskTags: [],
      interactionContractRefs: ["ui-review"],
    }],
    nonGoals: [],
    blockingInputs: [],
  });
}

function knownContractInput(draft: ReturnType<typeof knownRequirementDraft>): UiInteractionContractInputV1 {
  const requirement = draft.requirements[0]!;
  return {
    requirementIds: [requirement.id],
    screens: [{
      id: "screen-review",
      title: "Review",
      purpose: "Review one card",
      layout: { regions: [{ id: "region-main", role: "main", position: "center", childRefs: ["element-reveal"] }] },
      elements: [{
        id: "element-reveal",
        type: "button",
        label: "Reveal answer",
        visibleInStates: ["question"],
        enabledInStates: ["question"],
      }],
      states: ["loading", "empty", "question", "answer", "error"],
      actions: [{
        id: "action-reveal",
        triggerElementId: "element-reveal",
        fromState: "question",
        toState: "answer",
        expectedEffect: "Show the answer",
      }],
      responsiveRules: ["main action remains visible at 375px"],
      accessibilityRules: ["reveal action has button role"],
    }],
    flows: [{ id: "flow-review", steps: ["action-reveal"], successOutcome: "Answer is visible" }],
    criterionBindings: [{
      criterionId: requirement.acceptanceCriteria[0]!.id,
      screenIds: ["screen-review"],
      elementIds: ["element-reveal"],
      actionIds: ["action-reveal"],
    }],
  };
}

function hashWithoutContractHash(contract: UiInteractionContractV1): string {
  const { contractHash: _contractHash, ...withoutHash } = contract;
  return uiInteractionContractHash(withoutHash);
}
