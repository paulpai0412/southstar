import assert from "node:assert/strict";
import test from "node:test";
import {
  createLlmGoalRequirementDraftInterpreter,
  confirmGoalRequirementDraft,
  finalizeGoalRequirementDraft,
  goalRequirementDraftHash,
  reviseGoalRequirementDraft,
  validateGoalRequirementDraft,
  type GoalRequirementDraftInputV1,
  type GoalRequirementDraftV1,
} from "../../src/v2/orchestration/goal-requirement-draft.ts";
import type { ResolvedGoalDesignSkillV1 } from "../../src/v2/orchestration/goal-design.ts";
import type { WorkspaceGoalDiscoveryV1 } from "../../src/v2/orchestration/goal-workspace-discovery.ts";

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
        evidenceIntent: ["url", "screenshot"],
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

function discovery(cwd: string): WorkspaceGoalDiscoveryV1 {
  return {
    schemaVersion: "southstar.workspace_goal_discovery.v1",
    cwd,
    entries: [{ path: "article.html", kind: "file", size: 100, contentHash: "a".repeat(64) }],
    instructionDocuments: [],
    projectMetadata: [],
    truncated: false,
    discoveryHash: "b".repeat(64),
  };
}

function skill(): ResolvedGoalDesignSkillV1 {
  return {
    objectKey: "skill.goal-design",
    versionRef: "skill.goal-design@1",
    stateHash: "c".repeat(64),
    body: "Clarify the requested outcome into independently verifiable requirements.",
  };
}

test("LLM Requirement interpreter returns rich requirements without Library refs or Slices", async () => {
  const prompts: string[] = [];
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-requirement-test",
    client: {
      async generateText({ prompt }) {
        prompts.push(prompt);
        return JSON.stringify({
          summary: "Create an offline article",
          requirements: [{
            title: "Offline delivery",
            statement: "The article opens without a network",
            source: "explicit",
            blocking: true,
            userVisibleBehaviors: ["Open locally"],
            businessRules: ["No network"],
            acceptanceCriteria: [{
              statement: "article.html opens with network disabled",
              evidenceIntent: ["screenshot"],
            }],
            expectedOutcomeArtifacts: [{ description: "Offline HTML", mediaType: "text/html" }],
            verificationIntent: ["Open in a browser"],
            assumptions: [],
            openQuestions: [],
            riskTags: [],
            interactionContractRefs: [],
          }],
          nonGoals: [],
          blockingInputs: [],
        });
      },
    },
  });
  const draft = await interpreter.interpret({
    goalPrompt: "Create an offline article",
    cwd: "/workspace/article",
    workspaceDiscovery: discovery("/workspace/article"),
    goalDesignSkill: skill(),
  });
  assert.equal(draft.revision, 1);
  assert.match(prompts[0] ?? "", /GoalRequirementDraftOutputSchema/);
  assert.match(prompts[0] ?? "", /Do not return host-owned fields/);
  assert.match(prompts[0] ?? "", /file-diff, test-result, command-output, url, screenshot/);
  assert.match(prompts[0] ?? "", /Do not attach interactionContractRefs to persistence, data integrity, offline operation/);
  assert.doesNotMatch(prompts[0] ?? "", /evaluatorContracts|slicePlan|agentDefinitionRef/);
  assert.match(draft.requirements[0]!.id, /^req-/);
  assert.equal(draft.requirements[0]!.status, "ready");
});

test("LLM revision cannot supply host ids, hashes or status", async () => {
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-invalid-revision",
    client: { async generateText() {
      return JSON.stringify({ kind: "revision", requirementId: "req-invented", draftHash: "bad" });
    } },
  });
  await assert.rejects(
    () => interpreter.revise({ currentDraft: validDraft(), message: "change it" }),
    /invalid Goal Requirement revision/,
  );
});

test("LLM Requirement interpreter performs at most one schema repair", async () => {
  let calls = 0;
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-repair-test",
    client: {
      async generateText() {
        calls += 1;
        if (calls === 1) return JSON.stringify({ ...validInput(), id: "host-field" });
        return JSON.stringify({
          summary: "Create an offline article",
          requirements: [validInput().requirements[0]!],
          nonGoals: [],
          blockingInputs: [],
        });
      },
    },
  });
  const draft = await interpreter.interpret({
    goalPrompt: "Create an offline article",
    cwd: "/workspace/article",
    workspaceDiscovery: discovery("/workspace/article"),
    goalDesignSkill: skill(),
  });
  assert.equal(calls, 2);
  assert.equal(draft.requirements.length, 1);
});

test("LLM Requirement interpreter repairs prose evidence intent into canonical evidence kinds", async () => {
  let calls = 0;
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-evidence-repair-test",
    client: {
      async generateText() {
        calls += 1;
        const requirement = structuredClone(validInput().requirements[0]!);
        requirement.acceptanceCriteria[0]!.evidenceIntent = (calls === 1
          ? ["Functional browser verification"]
          : ["screenshot", "url"]) as typeof requirement.acceptanceCriteria[0]["evidenceIntent"];
        return JSON.stringify({
          summary: "Create an offline article",
          requirements: [requirement],
          nonGoals: [],
          blockingInputs: [],
        });
      },
    },
  });
  const draft = await interpreter.interpret({
    goalPrompt: "Create an offline article",
    cwd: "/workspace/article",
    workspaceDiscovery: discovery("/workspace/article"),
    goalDesignSkill: skill(),
  });
  assert.equal(calls, 2);
  assert.deepEqual(draft.requirements[0]!.acceptanceCriteria[0]!.evidenceIntent, ["screenshot", "url"]);
});

test("LLM Requirement interpreter designs every declared UI interaction contract for host validation", async () => {
  const requirementDraft = finalizeGoalRequirementDraft({
    ...validInput(),
    requirements: [{
      ...validInput().requirements[0]!,
      interactionContractRefs: ["ui.offline-reader"],
    }],
  });
  const requirement = requirementDraft.requirements[0]!;
  const criterion = requirement.acceptanceCriteria[0]!;
  const prompts: string[] = [];
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-ui-contract-design",
    client: {
      async generateText({ prompt }) {
        prompts.push(prompt);
        return JSON.stringify({
          contracts: [{
            id: "ui.offline-reader",
            requirementIds: [requirement.id],
            screens: [{
              id: "screen-reader",
              title: "Offline reader",
              purpose: "Read the article locally",
              layout: { regions: [{ id: "region-main", role: "main", position: "center", childRefs: ["element-article"] }] },
              elements: [{ id: "element-article", type: "text", label: "Article", visibleInStates: ["ready"], enabledInStates: ["ready"] }],
              states: ["ready"],
              actions: [],
              responsiveRules: ["Content remains readable on narrow screens"],
              accessibilityRules: ["Article text uses semantic content"],
            }],
            flows: [],
            criterionBindings: [{ criterionId: criterion.id, screenIds: ["screen-reader"], elementIds: ["element-article"], actionIds: [] }],
          }],
        });
      },
    },
  });
  const contracts = await interpreter.designUiInteractionContracts!({ requirementDraft, goalDesignSkill: skill() });
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0]!.id, "ui.offline-reader");
  assert.equal(contracts[0]!.status, "draft");
  assert.deepEqual(contracts[0]!.requirementIds, [requirement.id]);
  assert.match(prompts[0] ?? "", /ExpectedInteractionContractRefs/);
  assert.match(prompts[0] ?? "", /button \| input \| textarea/);
});

test("LLM revision finalizes semantic content while preserving host lineage", async () => {
  const current = validDraft();
  const existingId = current.requirements[0]!.id;
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-valid-revision",
    client: {
      async generateText() {
        return JSON.stringify({
          kind: "revision",
          summary: "Clarified the article behavior.",
          draft: {
            summary: "Clarified offline article",
            requirements: [{
              ...validInput().requirements[0]!,
              statement: "The revised article opens without a network",
            }],
            nonGoals: [],
            blockingInputs: [],
          },
        });
      },
    },
  });
  const result = await interpreter.revise({
    currentDraft: current,
    message: "clarify the article behavior",
    selectedRequirementId: existingId,
  });
  assert.equal(result.kind, "revision");
  if (result.kind !== "revision") assert.fail("expected revision");
  assert.equal(result.draft.revision, current.revision + 1);
  assert.equal(result.draft.parentRevision, current.revision);
  assert.equal(result.draft.requirements[0]!.id, existingId);
  assert.equal(result.draft.requirements[0]!.statement, "The revised article opens without a network");
});

test("LLM revision operation targets only host-selected requirement", async () => {
  const current = validDraft();
  const existingId = current.requirements[0]!.id;
  const deltas: string[] = [];
  const prompts: string[] = [];
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-operation-revision",
    client: {
      async generateTextStream(input, handlers) {
        prompts.push(input.prompt);
        handlers.onDelta?.("validated-update");
        return JSON.stringify({
          kind: "revision",
          summary: "Updated the observable statement.",
          operation: {
            kind: "update",
            patch: { statement: "The article opens offline in a browser" },
          },
        });
      },
    },
  });
  const result = await interpreter.revise({
    currentDraft: current,
    message: "make the statement browser-observable",
    selectedRequirementId: existingId,
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.kind, "revision");
  if (result.kind !== "revision") assert.fail("expected revision");
  assert.equal(result.draft.requirements[0]!.id, existingId);
  assert.equal(result.draft.requirements[0]!.statement, "The article opens offline in a browser");
  assert.deepEqual(deltas, ["validated-update"]);
  assert.match(prompts[0] ?? "", /Preserve the interaction-contract policy/);
});

test("LLM revision preserves explicit host mapping for multiple edited requirements", async () => {
  const first = validDraft();
  const current = reviseGoalRequirementDraft(first, {
    kind: "create",
    requirement: {
      ...validInput().requirements[0]!,
      title: "Reader navigation",
      statement: "The reader can navigate the article",
    },
  });
  const selectedIds = current.requirements.map((requirement) => requirement.id);
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-multi-lineage-revision",
    client: {
      async generateText() {
        return JSON.stringify({
          kind: "revision",
          summary: "Changed both requirement statements.",
          draft: {
            summary: "Two clarified outcomes",
            requirements: [
              { ...validInput().requirements[0]!, statement: "The article opens offline in a browser" },
              { ...validInput().requirements[0]!, title: "Reader navigation", statement: "The reader navigates between article sections" },
            ],
            nonGoals: [],
            blockingInputs: [],
          },
        });
      },
    },
  });
  const result = await interpreter.revise({
    currentDraft: current,
    message: "clarify both outcomes",
    selectedRequirementIds: selectedIds,
  });
  assert.equal(result.kind, "revision");
  if (result.kind !== "revision") assert.fail("expected revision");
  assert.deepEqual(result.draft.requirements.slice(0, 2).map((requirement) => requirement.id), selectedIds);
  assert.equal(result.draft.requirements[0]!.statement, "The article opens offline in a browser");
  assert.equal(result.draft.requirements[1]!.statement, "The reader navigates between article sections");
});

test("stale host selection returns needs_input without streaming semantic output", async () => {
  let calls = 0;
  const deltas: string[] = [];
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-stale-selection",
    client: {
      async generateTextStream(_input, handlers) {
        calls += 1;
        handlers.onDelta?.("should-not-be-emitted");
        return JSON.stringify({ kind: "needs_input", question: "choose" });
      },
    },
  });
  const result = await interpreter.revise({
    currentDraft: validDraft(),
    message: "edit it",
    selectedRequirementId: "req-stale",
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.kind, "needs_input");
  assert.equal(calls, 0);
  assert.deepEqual(deltas, []);
});

test("equivalent singular and plural host selections are normalized before prompting the LLM", async () => {
  const current = validDraft();
  const selectedRequirementId = current.requirements[0]!.id;
  const prompts: string[] = [];
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-normalized-selection",
    client: {
      async generateText({ prompt }) {
        prompts.push(prompt);
        return JSON.stringify({
          kind: "revision",
          summary: "Updated the selected requirement.",
          operation: {
            kind: "update",
            patch: { statement: "The article opens offline from local storage" },
          },
        });
      },
    },
  });
  const result = await interpreter.revise({
    currentDraft: current,
    message: "clarify the selected requirement",
    selectedRequirementId,
    selectedRequirementIds: [selectedRequirementId],
  });
  assert.equal(result.kind, "revision");
  assert.match(prompts[0] ?? "", new RegExp(`SelectedRequirementId \\(host context only\\): ${selectedRequirementId}`));
  assert.match(prompts[0] ?? "", /SelectedRequirementIds \(host context only\): \[\]/);
});

test("conflicting singular and plural host selections require clarification before calling the LLM", async () => {
  const first = validDraft();
  const current = reviseGoalRequirementDraft(first, {
    kind: "create",
    requirement: {
      ...validInput().requirements[0]!,
      title: "Reader navigation",
      statement: "The reader can navigate the article",
    },
  });
  let calls = 0;
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-conflicting-selection",
    client: {
      async generateText() {
        calls += 1;
        return JSON.stringify({ kind: "needs_input", question: "choose" });
      },
    },
  });
  const result = await interpreter.revise({
    currentDraft: current,
    message: "revise the selection",
    selectedRequirementId: current.requirements[0]!.id,
    selectedRequirementIds: current.requirements.map((requirement) => requirement.id),
  });
  assert.equal(result.kind, "needs_input");
  if (result.kind !== "needs_input") assert.fail("expected needs_input");
  assert.match(result.question, /choose either one requirement or multiple requirements/i);
  assert.equal(calls, 0);
});

test("LLM clarification response is returned without forwarding semantic deltas", async () => {
  const deltas: string[] = [];
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-needs-input",
    client: {
      async generateTextStream(_input, handlers) {
        handlers.onDelta?.("clarification-text");
        return JSON.stringify({ kind: "needs_input", question: "Which article language should be used?" });
      },
    },
  });
  const result = await interpreter.revise({
    currentDraft: validDraft(),
    message: "choose the language",
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.kind, "needs_input");
  if (result.kind !== "needs_input") assert.fail("expected needs_input");
  assert.match(result.question, /language/i);
  assert.deepEqual(deltas, []);
});

test("merge requires plural host selections and does not emit unvalidated deltas", async () => {
  const deltas: string[] = [];
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-merge-selection",
    client: {
      async generateTextStream(_input, handlers) {
        handlers.onDelta?.("semantic-merge");
        return JSON.stringify({
          kind: "revision",
          summary: "merge",
          operation: {
            kind: "merge",
            requirement: validInput().requirements[0]!,
          },
        });
      },
    },
  });
  const result = await interpreter.revise({
    currentDraft: validDraft(),
    message: "merge selected requirements",
    selectedRequirementIds: [],
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.kind, "needs_input");
  assert.match(result.question, /at least two/i);
  assert.deepEqual(deltas, []);
});

test("valid merge applies host-selected ids before forwarding stream deltas", async () => {
  const first = validDraft();
  const current = reviseGoalRequirementDraft(first, {
    kind: "create",
    requirement: {
      ...validInput().requirements[0]!,
      title: "Reader navigation",
      statement: "The reader can navigate the article",
    },
  });
  const selectedIds = current.requirements.map((requirement) => requirement.id);
  const deltas: string[] = [];
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: "inline-valid-merge",
    client: {
      async generateTextStream(_input, handlers) {
        handlers.onDelta?.("validated-merge");
        return JSON.stringify({
          kind: "revision",
          summary: "Merged related outcomes.",
          operation: {
            kind: "merge",
            requirement: {
              ...validInput().requirements[0]!,
              title: "Offline article",
              statement: "The complete article is available offline",
            },
          },
        });
      },
    },
  });
  const result = await interpreter.revise({
    currentDraft: current,
    message: "merge the outcomes",
    selectedRequirementIds: selectedIds,
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.kind, "revision");
  if (result.kind !== "revision") assert.fail("expected revision");
  assert.equal(result.draft.requirements.filter((requirement) => requirement.status === "superseded").length, 2);
  assert.equal(result.draft.requirements.filter((requirement) => requirement.status !== "superseded").length, 1);
  assert.deepEqual(deltas, ["validated-merge"]);
});

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

test("workspace projectRef is optional, preserved when valid, and rejected when malformed", () => {
  const draft = finalizeGoalRequirementDraft(validInput({ projectRef: "project.article" }));
  assert.equal(draft.workspace.projectRef, "project.article");
  assert.equal(validateGoalRequirementDraft(draft).some((entry) => entry.code === "invalid_workspace"), false);

  assert.throws(
    () => finalizeGoalRequirementDraft(validInput({ projectRef: " " })),
    /projectRef must be a non-empty string/,
  );
  assert.throws(
    () => finalizeGoalRequirementDraft(validInput({ projectRef: 42 as never })),
    /projectRef must be a non-empty string/,
  );

  for (const projectRef of ["", "   ", null, 42]) {
    const malformed = {
      ...draft,
      workspace: { ...draft.workspace, projectRef },
    } as unknown as GoalRequirementDraftV1;
    assert.equal(
      validateGoalRequirementDraft(malformed).some((entry) => entry.code === "invalid_workspace" && entry.path === "workspace.projectRef"),
      true,
    );
  }
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
