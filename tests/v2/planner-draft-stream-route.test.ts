import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { finalizeGoalRequirementDraft, reviseGoalRequirementDraft } from "../../src/v2/orchestration/goal-requirement-draft.ts";
import { preparePostgresGoalRequirementDraft } from "../../src/v2/orchestration/goal-design-draft-service.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";

type SseFrame = { event: string; data: Record<string, unknown> };

test("planner Requirement PATCH versions canonical Criteria and rejects the removed criterion shape", async () => {
  const db = await createTestPostgresDb();
  const cwd = process.cwd();
  try {
    await seedGoalDesignSkill(db);
    const initial = finalizeGoalRequirementDraft({
      goalPrompt: "Create a review flow",
      cwd,
      summary: "Review flow",
      requirements: [{
        id: "req-review",
        title: "Review flow",
        statement: "A learner can review a word.",
        source: "explicit",
        blocking: true,
        userVisibleBehaviors: ["Show a word"],
        businessRules: [],
        acceptanceCriteria: [reviewCriterion()],
        expectedOutcomeArtifacts: [{ description: "review UI", mediaType: "text/html" }],
        verificationIntent: ["complete one review"],
        assumptions: [],
        openQuestions: [],
        riskTags: [],
        interactionContractRefs: [],
      }],
      nonGoals: [],
      blockingInputs: [],
    });
    const prepared = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: initial.originalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return initial; },
        async revise() { return { kind: "needs_input" as const, question: "No chat revision expected." }; },
      },
    });
    const requirement = prepared.goalRequirementDraft.requirements[0]!;
    const criterion = requirement.acceptanceCriteria[0]!;
    const context = {
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };
    const route = `http://127.0.0.1/api/v2/planner/drafts/${prepared.draftId}/goal-requirements/${requirement.id}`;
    const revisedResponse = await handleRuntimeRoute(context, new Request(route, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedDraftHash: prepared.goalRequirementDraftHash,
        patch: {
          acceptanceCriteria: [{
            id: criterion.id,
            observableClaim: "A review is persisted with its selected result.",
            blocking: true,
            verificationIntent: ["Complete one review and read the persisted result."],
            requiredAssurance: ["deterministic"],
            evidenceIntent: ["artifact-ref"],
          }],
        },
      }),
    }));
    assert.equal(revisedResponse.status, 200, await revisedResponse.clone().text());
    const revised = (await revisedResponse.json() as {
      result: { goalRequirementDraftHash: string; goalRequirementDraft: typeof prepared.goalRequirementDraft };
    }).result;
    const revisedCriterion = revised.goalRequirementDraft.requirements[0]!.acceptanceCriteria[0]!;
    assert.equal(revisedCriterion.id, criterion.id);
    assert.equal(revisedCriterion.version, criterion.version + 1);

    const legacyResponse = await handleRuntimeRoute(context, new Request(route, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedDraftHash: revised.goalRequirementDraftHash,
        patch: { acceptanceCriteria: [{ statement: "legacy criterion", evidenceIntent: ["artifact-ref"] }] },
      }),
    }));
    assert.equal(legacyResponse.status, 422);
    assert.match(await legacyResponse.text(), /observableClaim/);
  } finally {
    await db.close();
  }
});

test("requirement review revise stream is phase-aware and returns a goal_requirements block", async () => {
  const db = await createTestPostgresDb();
  const cwd = process.cwd();
  try {
    await seedGoalDesignSkill(db);
    const initial = finalizeGoalRequirementDraft({
      goalPrompt: "Create a review flow",
      cwd,
      summary: "Review flow",
      requirements: [{
        id: "req-review",
        title: "Review flow",
        statement: "A learner can review a word.",
        source: "explicit",
        blocking: true,
        userVisibleBehaviors: ["Show a word"],
        businessRules: [],
        acceptanceCriteria: [reviewCriterion()],
        expectedOutcomeArtifacts: [{ description: "review UI", mediaType: "text/html" }],
        verificationIntent: ["complete one review"],
        assumptions: [],
        openQuestions: [],
        riskTags: [],
        interactionContractRefs: [],
      }],
      nonGoals: [],
      blockingInputs: [],
    });
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: "Create a review flow",
      cwd,
      requirementInterpreter: {
        async interpret() { return initial; },
        async revise(input) {
          return {
            kind: "revision" as const,
            draft: {
              ...reviseGoalRequirementDraft(input.currentDraft, { kind: "update", requirementId: "req-review", patch: { statement: "A learner can review a word and record the result." } }),
              summary: "Updated review flow",
            },
            summary: "Updated the review requirement.",
          };
        },
      },
    });
    assert.equal(draft.confirmable, true);
    const requirementId = draft.goalRequirementDraft.requirements[0]!.id;
    const context = {
      db,
      goalRequirementInterpreter: {
        async interpret() { return initial; },
        async revise(input: { currentDraft: typeof initial; message: string; selectedRequirementId?: string }) {
          return {
            kind: "revision" as const,
            draft: {
              ...reviseGoalRequirementDraft(input.currentDraft, { kind: "update", requirementId: input.selectedRequirementId ?? requirementId, patch: { statement: "A learner can review a word and record the result." } }),
              summary: "Updated review flow",
            },
            summary: "Updated the review requirement.",
          };
        },
      },
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };
    const response = await handleRuntimeRoute(context, new Request(`http://127.0.0.1/api/v2/planner/drafts/${draft.draftId}/revise/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Make the review result explicit", expectedDraftHash: draft.goalRequirementDraftHash, selectedRequirementId: requirementId }),
    }));
    assert.equal(response.status, 200);
    const frames = parseSse(await response.text());
    assert.ok(frames.some((frame) => frame.event === "planner.stage" && frame.data.stage === "requirements.revision.requested"));
    const requirements = frames.find((frame) => frame.event === "goal_requirements")?.data as { confirmable?: boolean; goalRequirementDraftHash?: string; package?: { confirmable?: boolean; goalRequirementDraft?: { summary?: string; requirements?: Array<{ statement?: string }> } } } | undefined;
    assert.equal(requirements?.confirmable, true);
    assert.equal(requirements?.package?.confirmable, true);
    assert.match(String(requirements?.goalRequirementDraftHash), /^[a-f0-9]{64}$/);
    assert.equal(requirements?.package?.goalRequirementDraft?.summary, "Updated review flow");
    assert.equal(requirements?.package?.goalRequirementDraft?.requirements?.[0]?.statement, "A learner can review a word and record the result.");
    assert.equal(frames.at(-1)?.event, "done");
  } finally {
    await db.close();
  }
});

test("requirement revision stream emits standard heartbeat frames while revision is pending", async () => {
  const db = await createTestPostgresDb();
  const cwd = process.cwd();
  try {
    await seedGoalDesignSkill(db);
    const draft = finalizeGoalRequirementDraft({
      goalPrompt: "Create a review flow",
      cwd,
      summary: "Review flow",
      requirements: [{
        title: "Review flow",
        statement: "A learner can review a word.",
        source: "explicit",
        blocking: true,
        userVisibleBehaviors: ["Show a word"],
        businessRules: [],
        acceptanceCriteria: [reviewCriterion()],
        expectedOutcomeArtifacts: [{ description: "review UI", mediaType: "text/html" }],
        verificationIntent: ["complete one review"],
        assumptions: [],
        openQuestions: [],
        riskTags: [],
        interactionContractRefs: [],
      }],
      nonGoals: [],
      blockingInputs: [],
    });
    const prepared = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: draft.originalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return draft; },
        async revise() { return { kind: "needs_input" as const, question: "No revision expected." }; },
      },
    });
    const requirementId = prepared.goalRequirementDraft.requirements[0]!.id;
    const context = {
      db,
      libraryChatHeartbeatMs: 1,
      goalRequirementInterpreter: {
        async interpret() { return draft; },
        async revise(input: { currentDraft: typeof draft }) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            kind: "revision" as const,
            draft: reviseGoalRequirementDraft(input.currentDraft, {
              kind: "update",
              requirementId,
              patch: { statement: "A learner can review a word and record the result." },
            }),
            summary: "Updated review flow.",
          };
        },
      },
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };
    const response = await handleRuntimeRoute(context, new Request(`http://127.0.0.1/api/v2/planner/drafts/${prepared.draftId}/revise/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Make the review result explicit", expectedDraftHash: prepared.goalRequirementDraftHash, selectedRequirementId: requirementId }),
    }));
    const frames = parseSse(await response.text());
    assert.ok(frames.some((frame) => frame.event === "heartbeat" && frame.data.phase === "planner_draft_revision" && typeof frame.data.elapsedMs === "number"));
    assert.equal(frames.at(-1)?.event, "done");
  } finally {
    await db.close();
  }
});

test("requirement revision needs_input keeps the current Goal Requirements block", async () => {
  const db = await createTestPostgresDb();
  const cwd = process.cwd();
  try {
    await seedGoalDesignSkill(db);
    const draft = finalizeGoalRequirementDraft({
      goalPrompt: "Create a review flow",
      cwd,
      summary: "Review flow",
      requirements: [{
        title: "Review flow",
        statement: "A learner can review a word.",
        source: "explicit",
        blocking: true,
        userVisibleBehaviors: ["Show a word"],
        businessRules: [],
        acceptanceCriteria: [reviewCriterion()],
        expectedOutcomeArtifacts: [{ description: "review UI", mediaType: "text/html" }],
        verificationIntent: ["complete one review"],
        assumptions: [],
        openQuestions: [],
        riskTags: [],
        interactionContractRefs: [],
      }],
      nonGoals: [],
      blockingInputs: ["Which project scope should be used?"],
    });
    const prepared = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: draft.originalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return draft; },
        async revise() { return { kind: "needs_input" as const, question: "Please answer the project scope." }; },
      },
    });
    const requirementId = prepared.goalRequirementDraft.requirements[0]!.id;
    const response = await handleRuntimeRoute({
      db,
      goalRequirementInterpreter: {
        async interpret() { return draft; },
        async revise() { return { kind: "needs_input" as const, question: "Please answer the project scope." }; },
      },
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    }, new Request(`http://127.0.0.1/api/v2/planner/drafts/${prepared.draftId}/revise/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Use the current workspace.", expectedDraftHash: prepared.goalRequirementDraftHash, selectedRequirementId: requirementId }),
    }));
    const frames = parseSse(await response.text());
    const block = frames.find((frame) => frame.event === "goal_requirements")?.data as { status?: string; goalRequirementDraft?: { blockingInputs?: string[] } } | undefined;
    assert.equal(block?.status, "requirements_review");
    assert.deepEqual(block?.goalRequirementDraft?.blockingInputs, ["Which project scope should be used?"]);
    assert.equal(frames.at(-1)?.event, "done");
    assert.equal((frames.at(-1)?.data as { kind?: string }).kind, "needs_input");
  } finally {
    await db.close();
  }
});

test("planner draft requirement SSE exposes host confirmable state", async () => {
  const db = await createTestPostgresDb();
  const cwd = process.cwd();
  try {
    await seedGoalDesignSkill(db);
    const draft = finalizeGoalRequirementDraft({
      goalPrompt: "Create a review flow",
      cwd,
      summary: "Review flow",
      requirements: [{
        title: "Review flow",
        statement: "A learner can review a word.",
        source: "explicit",
        blocking: true,
        userVisibleBehaviors: ["Show a word"],
        businessRules: [],
        acceptanceCriteria: [reviewCriterion()],
        expectedOutcomeArtifacts: [{ description: "review UI", mediaType: "text/html" }],
        verificationIntent: ["complete one review"],
        assumptions: [],
        openQuestions: [],
        riskTags: [],
        interactionContractRefs: [],
      }],
      nonGoals: [],
      blockingInputs: [],
    });
    const context = {
      db,
      goalRequirementInterpreter: {
        async interpret() { return draft; },
        async revise() { return { kind: "needs_input" as const, question: "No revision expected." }; },
      },
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };
    const response = await handleRuntimeRoute(context, new Request("http://127.0.0.1/api/v2/planner/drafts/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalPrompt: draft.originalPrompt, cwd, idempotencyKey: "requirement-sse-confirmable", goalDesignMode: "review_before_compose" }),
    }));
    assert.equal(response.status, 200);
    const frames = parseSse(await response.text());
    const requirements = frames.find((frame) => frame.event === "goal_requirements")?.data as { confirmable?: boolean; package?: { confirmable?: boolean } } | undefined;
    assert.equal(requirements?.confirmable, true);
  } finally {
    await db.close();
  }
});

test("planner revision routes reject drafts without a canonical V2 Goal Design package", async () => {
  const db = await createTestPostgresDb();
  const draftId = "legacy-planner-draft";
  try {
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: { workflow: { workflowId: "wf-legacy", tasks: [] } },
      summary: { goalPrompt: "Legacy draft", workflowId: "wf-legacy" },
    });
    const context = {
      db,
      plannerClient: { generate: async () => { throw new Error("planner must not run"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor must not run"); } },
    };
    const jsonResponse = await handleRuntimeRoute(context, new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${draftId}/revise`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Revise this draft" }),
      },
    ));
    assert.equal(jsonResponse.status, 409);
    assert.match(await jsonResponse.text(), /canonical_goal_design_package_required/);

    const streamResponse = await handleRuntimeRoute(context, new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${draftId}/revise/stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Revise this draft" }),
      },
    ));
    assert.equal(streamResponse.status, 200);
    const frames = parseSse(await streamResponse.text());
    assert.equal(frames.at(-1)?.event, "error");
    assert.match(String(frames.at(-1)?.data.error), /canonical_goal_design_package_required/);
    assert.equal(frames.some((frame) => frame.event === "draft"), false);
    const stored = await getResourceByKeyPg(db, "planner_draft", draftId);
    assert.equal(stored?.status, "invalid");
    assert.equal((stored?.payload as { canonicalDiagnostic?: { code?: string } }).canonicalDiagnostic?.code, "canonical_goal_design_package_required");

    const orchestrationResponse = await handleRuntimeRoute(context, new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${draftId}/orchestration`,
    ));
    const orchestration = (await orchestrationResponse.json() as { result: { blockers: string[] } }).result;
    assert.ok(orchestration.blockers.some((blocker) => blocker.includes("canonical_goal_design_package_required")));
  } finally {
    await db.close();
  }
});

function reviewCriterion() {
  return {
    observableClaim: "A review is persisted",
    blocking: true,
    verificationIntent: ["Complete one review and verify the saved result."],
    requiredAssurance: ["deterministic" as const],
    evidenceIntent: ["artifact-ref" as const],
  };
}

function parseSse(text: string): SseFrame[] {
  return text.trim().split(/\n\n/).filter(Boolean).map((frame) => {
    const lines = frame.split(/\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
    const rawData = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    return { event, data: rawData ? JSON.parse(rawData) : {} };
  });
}

async function seedGoalDesignSkill(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey: "skill.southstar-goal-design",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.southstar-goal-design@test",
    state: {
      purpose: "goal_design",
      body: "Design the smallest cohesive outcome slices and return the host schema.",
    },
  });
}
