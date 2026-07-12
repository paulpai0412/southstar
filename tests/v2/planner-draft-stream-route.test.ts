import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicFixtureComposer } from "./fixtures/deterministic-workflow-composer.ts";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { finalizeGoalContract, type GoalContractInterpreter, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import {
  finalizeGoalDesignPackage,
  type GoalDesignMode,
  type GoalDesigner,
  type GoalDesignPackageV1,
  type ResolvedGoalDesignSkillV1,
  type WorkflowTemplatePolicyV1,
} from "../../src/v2/orchestration/goal-design.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

type SseFrame = { event: string; data: Record<string, unknown> };

test("legacy planner draft stream route creates a reviewable Goal Design draft", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedGoalDesignSkill(db);
    const context = {
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Generate a todo webapp")),
      goalDesigner: inlineGoalDesigner(),
      workflowComposer: new DeterministicFixtureComposer(),
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };

    const response = await handleRuntimeRoute(context, new Request("http://127.0.0.1/api/v2/planner/drafts/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goalPrompt: "generate todo webapp",
        orchestrationMode: "llm-constrained",
        composerMode: "llm",
        cwd: process.cwd(),
      }),
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const frames = parseSse(await response.text());
    assert.ok(frames.some((frame) => frame.event === "planner.stage" && frame.data.stage === "goal_contract.interpreted"));
    assert.ok(frames.some((frame) => frame.event === "planner.stage" && frame.data.stage === "goal_design.persisted"));
    const draft = frames.find((frame) => frame.event === "draft")?.data.draft as { draftId?: unknown; status?: unknown; goalDesignPackageHash?: unknown } | undefined;
    assert.match(String(draft?.draftId), /^draft-goal-design-/);
    assert.equal(draft?.status, "ready_for_review");
    assert.match(String(draft?.goalDesignPackageHash), /^[a-f0-9]{64}$/);
    assert.equal(frames.some((frame) => frame.event === "orchestration"), false);
    assert.equal(frames.at(-1)?.event, "done");
    assert.equal((frames.at(-1)?.data as { draftStatus?: string }).draftStatus, "ready_for_review");
  } finally {
    await db.close();
  }
});

test("legacy planner draft revise stream route edits the reviewed Goal Design package", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedGoalDesignSkill(db);
    const context = {
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Generate a todo webapp")),
      goalDesigner: inlineGoalDesigner(),
      workflowComposer: new DeterministicFixtureComposer(),
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };

    const initialResponse = await handleRuntimeRoute(context, new Request("http://127.0.0.1/api/v2/planner/drafts/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goalPrompt: "generate todo webapp",
        orchestrationMode: "llm-constrained",
        composerMode: "llm",
        cwd: process.cwd(),
      }),
    }));
    const initialFrames = parseSse(await initialResponse.text());
    const initialDraft = initialFrames.find((frame) => frame.event === "draft")?.data.draft as { draftId?: string; goalDesignPackageHash?: string } | undefined;
    const initialDraftId = initialDraft?.draftId;
    const packageHash = initialDraft?.goalDesignPackageHash;
    assert.ok(initialDraftId);
    assert.ok(packageHash);

    const reviseResponse = await handleRuntimeRoute(context, new Request(`http://127.0.0.1/api/v2/planner/drafts/${initialDraftId}/revise/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "split frontend and backend into parallel tasks",
        orchestrationMode: "llm-constrained",
        composerMode: "llm",
        expectedPackageHash: packageHash,
      }),
    }));

    assert.equal(reviseResponse.status, 200);
    assert.equal(reviseResponse.headers.get("content-type"), "text/event-stream");
    const reviseFrames = parseSse(await reviseResponse.text());
    assert.ok(reviseFrames.some((frame) => frame.event === "planner.stage" && frame.data.stage === "goal_design.revision.requested"));
    assert.ok(reviseFrames.some((frame) => frame.event === "message.delta" && /Updated slice plan/.test(String(frame.data.text))));
    const revised = reviseFrames.find((frame) => frame.event === "goal_design")?.data as { changedSliceIds?: string[]; goalDesignPackageHash?: string } | undefined;
    assert.deepEqual(revised?.changedSliceIds, ["slice-implementation"]);
    assert.match(String(revised?.goalDesignPackageHash), /^[a-f0-9]{64}$/);
    assert.equal(reviseFrames.at(-1)?.event, "done");
  } finally {
    await db.close();
  }
});

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

function fixedGoalInterpreter(contract: GoalContractV1): GoalContractInterpreter {
  return { interpret: async () => contract };
}

function goalContract(goalPrompt: string): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt,
    cwd: process.cwd(),
    interpretation: {
      domain: "software",
      intent: "implement_feature",
      workType: "software_feature",
      summary: goalPrompt,
      requirements: [{ statement: goalPrompt, acceptanceCriteria: [goalPrompt], blocking: true, source: "explicit" }],
      expectedArtifactRefs: ["artifact.implementation_report"],
      requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
      nonGoals: [],
      assumptions: [],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: ["workspace-write"],
    },
  });
}

function inlineGoalDesigner(): GoalDesigner {
  return {
    async design(input) {
      return goalDesignPackage({
        goalContract: input.goalContract,
        mode: input.mode,
        templatePolicy: input.templatePolicy,
        skill: input.skill,
        workspaceDiscoveryHash: input.workspaceDiscovery.discoveryHash,
      });
    },
    async revise(input) {
      const next = goalDesignPackage({
        goalContract: input.currentPackage.goalContract,
        mode: input.currentPackage.mode,
        templatePolicy: input.currentPackage.templatePolicy,
        skill: {
          objectKey: input.currentPackage.goalDesignSkillRef,
          versionRef: input.currentPackage.goalDesignSkillVersionRef,
          stateHash: "",
          body: "",
        },
        workspaceDiscoveryHash: input.currentPackage.workspaceDiscoveryHash,
        revision: input.currentPackage.revision + 1,
        parentRevision: input.currentPackage.revision,
      });
      return { kind: "revision", package: next, summary: "Updated slice plan.", changedSliceIds: ["slice-implementation"] };
    },
  };
}

function goalDesignPackage(input: {
  goalContract: GoalContractV1;
  mode: GoalDesignMode;
  templatePolicy: WorkflowTemplatePolicyV1;
  skill: ResolvedGoalDesignSkillV1;
  workspaceDiscoveryHash: string;
  revision?: number;
  parentRevision?: number;
}): GoalDesignPackageV1 {
  const requirement = input.goalContract.requirements[0]!;
  const artifactRef = input.goalContract.expectedArtifactRefs[0]!;
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: input.revision ?? 1,
    ...(input.parentRevision ? { parentRevision: input.parentRevision } : {}),
    goalContract: input.goalContract,
    evaluatorContracts: [{
      schemaVersion: "southstar.requirement_evaluator_contract.v1",
      id: "eval-implementation",
      requirementId: requirement.id,
      acceptanceCriteria: [...requirement.acceptanceCriteria],
      requiredEvidenceKinds: ["test_result"],
      independence: "independent",
      failureClassifications: ["implementation_gap"],
    }],
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: input.revision ?? 1,
      slices: [{
        id: "slice-implementation",
        requirementIds: [requirement.id],
        outcome: requirement.statement,
        stateOrArtifactOwner: artifactRef,
        mutationBoundary: "one cohesive implementation boundary",
        expectedArtifactRefs: [artifactRef],
        evaluatorContractRefs: ["eval-implementation"],
        dependsOnSliceIds: [],
        dependencyArtifactRefs: [],
      }],
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: ["slice-implementation"],
      rationale: "one atomic requirement boundary",
    },
    templatePolicy: input.templatePolicy,
    goalDesignSkillRef: input.skill.objectKey,
    goalDesignSkillVersionRef: input.skill.versionRef,
    workspaceDiscoveryHash: input.workspaceDiscoveryHash,
    mode: input.mode,
  });
}
