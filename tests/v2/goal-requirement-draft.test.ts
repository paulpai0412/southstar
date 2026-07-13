import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmGoalRequirementDraft,
  finalizeGoalRequirementDraft,
  goalRequirementDraftHash,
  reviseGoalRequirementDraft,
  validateGoalRequirementDraft,
  type GoalRequirementDraftInputV1,
  type GoalRequirementDraftV1,
} from "../../src/v2/orchestration/goal-requirement-draft.ts";

function validInput(overrides: Partial<GoalRequirementDraftInputV1> = {}): GoalRequirementDraftInputV1 {
  return {
    goalPrompt: "Create an offline article",
    cwd: "/workspace/article",
    summary: "Create an offline article",
    requirements: [{
      title: "Offline delivery",
      statement: "The article opens without a network",
      source: "explicit",
      blocking: true,
      userVisibleBehaviors: ["Reader opens the article locally"],
      businessRules: ["No network dependency"],
      acceptanceCriteria: [{
        statement: "article.html opens while the network is disabled",
        evidenceIntent: ["browser interaction", "screenshot"],
      }],
      expectedOutcomeArtifacts: [{ description: "Offline HTML", mediaType: "text/html" }],
      verificationIntent: ["Open the file with network disabled"],
      assumptions: [],
      openQuestions: [],
      riskTags: [],
      interactionContractRefs: [],
    }],
    nonGoals: [],
    blockingInputs: [],
    ...overrides,
  };
}

function validDraft(overrides: Partial<GoalRequirementDraftInputV1> = {}): GoalRequirementDraftV1 {
  return finalizeGoalRequirementDraft({ ...validInput(), ...overrides });
}

test("Requirement Draft preserves host ids and projects confirmed criteria to GoalContractV1", () => {
  const draft = finalizeGoalRequirementDraft(validInput());

  assert.match(draft.requirements[0]!.id, /^req-/);
  assert.match(draft.requirements[0]!.acceptanceCriteria[0]!.id, /^criterion-/);
  const confirmed = confirmGoalRequirementDraft(draft, {
    domain: "design/article",
    intent: "create_offline_article",
    workType: "general",
    expectedArtifactRefs: [],
    requiredCapabilities: [],
    assumptions: [],
    requestedSideEffects: ["workspace-write"],
  });
  assert.deepEqual(confirmed.requirements[0]!.acceptanceCriteria, [
    "article.html opens while the network is disabled",
  ]);
  assert.equal(confirmed.requirements[0]!.id, draft.requirements[0]!.id);
  assert.equal(confirmed.workspace.cwd, "/workspace/article");
});

test("Requirement revision preserves ids for edits and creates lineage for split requirements", () => {
  const first = validDraft();
  const edited = reviseGoalRequirementDraft(first, {
    kind: "update",
    requirementId: first.requirements[0]!.id,
    patch: { statement: "The revised observable outcome" },
  });
  assert.equal(edited.requirements[0]!.id, first.requirements[0]!.id);
  assert.equal(edited.parentRevision, first.revision);
  assert.notEqual(edited.draftHash, first.draftHash);

  const split = reviseGoalRequirementDraft(first, {
    kind: "split",
    requirementId: first.requirements[0]!.id,
    requirements: [
      { ...validInput().requirements[0]!, title: "Offline shell", statement: "The shell opens offline" },
      { ...validInput().requirements[0]!, title: "Offline content", statement: "The content is readable offline" },
    ],
  });
  assert.equal(split.parentRevision, first.revision);
  assert.equal(split.requirements.find((item) => item.id === first.requirements[0]!.id)?.status, "superseded");
  assert.equal(split.requirements.filter((item) => item.status !== "superseded").length, 2);
});

test("blocking requirements reject empty criteria and unresolved questions", () => {
  const issues = validateGoalRequirementDraft(validDraft({
    requirements: [{
      ...validInput().requirements[0]!,
      acceptanceCriteria: [],
      openQuestions: ["Which output is required?"],
    }],
  }));
  assert.deepEqual(new Set(issues.map((issue) => issue.code)), new Set([
    "blocking_requirement_missing_criteria",
    "blocking_requirement_has_open_question",
  ]));
});

test("revision operations are immutable and cover lifecycle transitions", () => {
  const first = validDraft();
  const created = reviseGoalRequirementDraft(first, {
    kind: "create",
    requirement: {
      ...validInput().requirements[0]!,
      title: "Reader navigation",
      statement: "The reader can navigate the article",
    },
  });
  assert.equal(first.revision, 1);
  assert.equal(created.revision, 2);
  assert.equal(created.requirements.length, 2);

  const createdId = created.requirements.find((item) => item.title === "Reader navigation")!.id;
  const superseded = reviseGoalRequirementDraft(created, { kind: "supersede", requirementId: createdId });
  assert.equal(superseded.requirements.find((item) => item.id === createdId)!.status, "superseded");
  const restored = reviseGoalRequirementDraft(superseded, { kind: "restore", requirementId: createdId });
  assert.equal(restored.requirements.find((item) => item.id === createdId)!.status, "ready");

  const merged = reviseGoalRequirementDraft(restored, {
    kind: "merge",
    requirementIds: [first.requirements[0]!.id, createdId],
    requirement: {
      ...validInput().requirements[0]!,
      title: "Offline article",
      statement: "The complete article is available offline",
    },
  });
  assert.equal(merged.requirements.filter((item) => item.status === "superseded").length, 2);
  assert.equal(merged.requirements.filter((item) => item.status !== "superseded").length, 1);
});

test("draft hash excludes the host hash field and validation catches tampering", () => {
  const draft = validDraft();
  const { draftHash: _draftHash, ...withoutHash } = draft;
  assert.equal(goalRequirementDraftHash(withoutHash), draft.draftHash);
  const issues = validateGoalRequirementDraft({ ...draft, draftHash: "tampered" });
  assert.equal(issues.some((issue) => issue.code === "invalid_draft_hash"), true);
  assert.equal(validateGoalRequirementDraft({ ...withoutHash, draftHash: "" }).some((issue) => issue.code === "missing_draft_hash"), true);
  assert.equal(validateGoalRequirementDraft({ ...draft, draftHash: 7 as never }).some((issue) => issue.code === "invalid_draft_hash"), true);
  assert.equal(validateGoalRequirementDraft({ ...draft, draftHash: "0".repeat(64) }).some((issue) => issue.code === "draft_hash_mismatch"), true);
  assert.throws(
    () => reviseGoalRequirementDraft({ ...draft, draftHash: "0".repeat(64) }, {
      kind: "update",
      requirementId: draft.requirements[0]!.id,
      patch: { statement: "must not apply to a stale draft" },
    }),
    /draft_hash_mismatch/,
  );
});

test("validation reports malformed nested values and top-level string arrays without throwing", () => {
  const draft = validDraft();
  const malformed = {
    ...draft,
    nonGoals: ["", 7],
    blockingInputs: [null],
    requirements: [
      null,
      {
        ...draft.requirements[0]!,
        acceptanceCriteria: [null],
        expectedOutcomeArtifacts: [null],
      },
    ],
  } as unknown as GoalRequirementDraftV1;

  const issues = validateGoalRequirementDraft(malformed);
  const codes = new Set(issues.map((entry) => entry.code));
  assert.equal(codes.has("invalid_non_goals"), true);
  assert.equal(codes.has("invalid_blocking_inputs"), true);
  assert.equal(codes.has("invalid_requirement"), true);
  assert.equal(codes.has("invalid_criterion"), true);
  assert.equal(codes.has("invalid_artifact"), true);
});

test("update patches cannot overwrite host-owned ids or lifecycle status", () => {
  const draft = validDraft();
  const requirementId = draft.requirements[0]!.id;
  assert.throws(
    () => reviseGoalRequirementDraft(draft, {
      kind: "update",
      requirementId,
      patch: { id: "req-attacker" } as never,
    }),
    /host-owned id or status/,
  );
  assert.throws(
    () => reviseGoalRequirementDraft(draft, {
      kind: "update",
      requirementId,
      patch: { status: "superseded" } as never,
    }),
    /host-owned id or status/,
  );
});
