import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { syncLibraryFileToGraph } from "../../src/v2/design-library/files/library-file-store.ts";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import {
  finalizeGoalContract,
  type GoalContractV1,
} from "../../src/v2/orchestration/goal-contract.ts";
import {
  createLlmGoalDesigner,
  designGoalWithLlm,
  finalizeGoalDesignPackage,
  goalDesignPackageHash,
  loadGoalDesignSkillPg,
  validateGoalDesignPackage,
  type GoalDesignPackageV1,
  type GoalSliceV1,
  type WorkflowTemplatePolicyV1,
  type WorkspaceGoalDiscoveryV1,
} from "../../src/v2/orchestration/goal-design.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("Goal Design uses the approved Library SOP and derives variable outcome slices", async () => {
  const db = await createTestPostgresDb();
  try {
    await syncGoalDesignSkill(db);
    const prompts: string[] = [];
    const contract = articleGoalContract();
    const requirementId = contract.requirements[0]!.id;

    const designed = await designGoalWithLlm(db, {
      goalContract: contract,
      workspaceDiscovery: discovery(contract.workspace.cwd),
      mode: "review_before_compose",
      templatePolicy: { mode: "auto" },
      client: {
        async generateText({ prompt }) {
          prompts.push(prompt);
          return JSON.stringify({
            evaluatorContracts: [{
              id: "eval-offline",
              requirementId,
              acceptanceCriteria: [...contract.requirements[0]!.acceptanceCriteria],
              requiredEvidenceKinds: ["screenshot"],
              independence: "independent",
              failureClassifications: ["network_dependency"],
            }],
            slicePlan: {
              revision: 1,
              slices: [{
                id: "slice-article",
                requirementIds: [requirementId],
                outcome: "deliver the offline article",
                stateOrArtifactOwner: "article.html",
                mutationBoundary: "one self-contained HTML artifact",
                expectedArtifactRefs: [contract.expectedArtifactRefs[0]!],
                evaluatorContractRefs: ["eval-offline"],
                dependsOnSliceIds: [],
                dependencyArtifactRefs: [],
              }],
            },
            compositionStrategy: {
              mode: "single-run",
              sliceIds: ["slice-article"],
              rationale: "one atomic artifact boundary",
            },
          });
        },
      },
      model: "inline-goal-design-test",
    });

    assert.match(prompts[0] ?? "", /smallest cohesive outcome slices/i);
    assert.match(prompts[0] ?? "", /Southstar Goal Design/);
    assert.match(prompts[0] ?? "", /GoalDesignOutputSchema:/);
    assert.match(prompts[0] ?? "", /AllowedRequirementIds:/);
    assert.match(prompts[0] ?? "", new RegExp(requirementId));
    assert.match(prompts[0] ?? "", new RegExp(`AllowedGoalArtifactRefs: ${escapeRegExp(JSON.stringify(contract.expectedArtifactRefs))}`));
    assert.match(prompts[0] ?? "", /compositionStrategy\.mode: "single-run" \| "per-slice-runs"/);
    assert.match(prompts[0] ?? "", /evaluatorContracts\[\]\.independence must be "independent"/);
    assert.equal(designed.package.slicePlan.slices.length, 1);
    assert.equal(designed.package.goalDesignSkillVersionRef, designed.skill.versionRef);
    assert.equal(validateGoalDesignPackage(designed.package).length, 0);
  } finally {
    await db.close();
  }
});

test("Goal Design revision prompt returns a host-finalized package or clarification", async () => {
  const db = await createTestPostgresDb();
  try {
    await syncGoalDesignSkill(db);
    const prompts: string[] = [];
    const skill = await loadGoalDesignSkillPg(db);
    const base = packageValue(articleGoalContract());
    const current = packageWithSkill(base, skill);
    const designer = createLlmGoalDesigner(db, {
      model: "inline-goal-revision-test",
      client: {
        async generateText({ prompt }) {
          prompts.push(prompt);
          return JSON.stringify({
            kind: "revision",
            summary: "Updated the outcome boundary.",
            changedSliceIds: ["slice-article"],
            package: {
              evaluatorContracts: current.evaluatorContracts,
              slicePlan: {
                slices: [{
                  ...current.slicePlan.slices[0]!,
                  outcome: "deliver revised offline article",
                }],
              },
              compositionStrategy: current.compositionStrategy,
            },
          });
        },
      },
    });

    const result = await designer.revise({
      currentPackage: current,
      message: "make the article outcome more explicit",
      selectedSliceId: "slice-article",
    });

    assert.equal(result.kind, "revision");
    if (result.kind !== "revision") assert.fail("expected revision");
    assert.match(prompts[0] ?? "", /CurrentGoalDesignPackage/);
    assert.match(prompts[0] ?? "", /Do not change templatePolicy/);
    assert.equal(result.package.revision, current.revision + 1);
    assert.equal(result.package.parentRevision, current.revision);
    assert.equal(result.package.templatePolicy.mode, current.templatePolicy.mode);
    assert.equal(result.package.slicePlan.slices[0]!.outcome, "deliver revised offline article");
  } finally {
    await db.close();
  }
});

test("Goal Design skill resolution fails closed for zero or multiple approved SOPs", async () => {
  const db = await createTestPostgresDb();
  try {
    await assert.rejects(loadGoalDesignSkillPg(db), /exactly one approved Goal Design skill/);
    await upsertGoalDesignSkillObject(db, "skill.goal-design-a");
    await upsertGoalDesignSkillObject(db, "skill.goal-design-b");
    await assert.rejects(loadGoalDesignSkillPg(db), /exactly one approved Goal Design skill/);
  } finally {
    await db.close();
  }
});

test("Goal Design rejects duplicate requirement ownership and artifact-free dependencies", () => {
  const contract = articleGoalContract();
  const requirementId = contract.requirements[0]!.id;
  const pkg = packageValue(contract);
  const duplicateOwner: GoalDesignPackageV1 = {
    ...pkg,
    slicePlan: {
      ...pkg.slicePlan,
      slices: [
      slice("a", [requirementId], contract.expectedArtifactRefs),
      slice("b", [requirementId], contract.expectedArtifactRefs),
      ],
    },
  };

  assert.equal(
    validateGoalDesignPackage(duplicateOwner).some((issue) => issue.code === "requirement_owner_count"),
    true,
  );

  const falseDependency: GoalDesignPackageV1 = {
    ...pkg,
    slicePlan: {
      ...pkg.slicePlan,
      slices: [
      slice("a", [requirementId], contract.expectedArtifactRefs),
      slice("b", [], [], { dependsOnSliceIds: ["a"], dependencyArtifactRefs: [] }),
      ],
    },
    compositionStrategy: {
      ...pkg.compositionStrategy,
      sliceIds: ["a", "b"],
    },
  };
  assert.equal(
    validateGoalDesignPackage(falseDependency).some((issue) => issue.code === "dependency_without_artifact_flow"),
    true,
  );
});

test("Goal Design requires evaluator criteria to cover requirement criteria", () => {
  const contract = articleGoalContract();
  const pkg = packageValue(contract);
  const drifted: GoalDesignPackageV1 = {
    ...pkg,
    evaluatorContracts: [{
      ...pkg.evaluatorContracts[0]!,
      acceptanceCriteria: ["A different criterion invented by the evaluator"],
    }],
  };

  assert.equal(
    validateGoalDesignPackage(drifted).some((issue) => issue.code === "evaluator_criteria_mismatch"),
    true,
  );
});

test("Goal Design package hash is host-owned and tamper-evident", () => {
  const contract = articleGoalContract();
  const pkg = packageValue(contract);

  assert.equal(pkg.packageHash, goalDesignPackageHash(pkg));
  assert.equal(validateGoalDesignPackage({ ...pkg, packageHash: "bad" }).some((issue) => issue.code === "package_hash_mismatch"), true);
});

function articleGoalContract(): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt: "Turn input.md into a self-contained article/article.html that opens offline",
    cwd: "/workspace/article",
    interpretation: {
      domain: "design/article",
      intent: "create_offline_article",
      workType: "general",
      summary: "Create an offline HTML article",
      requirements: [{
        statement: "The article opens without network access",
        acceptanceCriteria: ["article/article.html loads with the network disabled"],
        blocking: true,
        source: "explicit",
        expectedArtifacts: [{ description: "Self-contained article HTML", path: "article/article.html", mediaType: "text/html" }],
      }],
      expectedArtifactRefs: ["artifact.article_html"],
      requiredCapabilities: ["capability.workspace-read", "capability.workspace-write"],
      nonGoals: [],
      assumptions: [],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: ["workspace-write"],
    },
  });
}

function discovery(cwd: string): WorkspaceGoalDiscoveryV1 {
  return {
    schemaVersion: "southstar.workspace_goal_discovery.v1",
    cwd,
    entries: [],
    instructionDocuments: [],
    projectMetadata: [],
    truncated: false,
    discoveryHash: "discovery-hash",
  };
}

function packageValue(
  goalContract: GoalContractV1,
  overrides: { slices?: GoalSliceV1[]; templatePolicy?: WorkflowTemplatePolicyV1 } = {},
): GoalDesignPackageV1 {
  const requirementId = goalContract.requirements[0]!.id;
  const evaluatorId = "eval-offline";
  const slices = overrides.slices ?? [slice("slice-article", [requirementId], goalContract.expectedArtifactRefs)];
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: 1,
    goalContract,
    evaluatorContracts: [{
      schemaVersion: "southstar.requirement_evaluator_contract.v1",
      id: evaluatorId,
      requirementId,
      acceptanceCriteria: [...goalContract.requirements[0]!.acceptanceCriteria],
      requiredEvidenceKinds: ["screenshot"],
      independence: "independent",
      failureClassifications: ["network_dependency"],
    }],
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-fills",
      revision: 1,
      slices,
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: slices.map((candidate) => candidate.id),
      rationale: "one atomic artifact boundary",
    },
    templatePolicy: overrides.templatePolicy ?? { mode: "auto" },
    goalDesignSkillRef: "skill.southstar-goal-design",
    goalDesignSkillVersionRef: "skill.southstar-goal-design@v1",
    workspaceDiscoveryHash: "discovery-hash",
    mode: "review_before_compose",
  });
}

function packageWithSkill(
  current: GoalDesignPackageV1,
  skill: { objectKey: string; versionRef: string },
): GoalDesignPackageV1 {
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: current.revision,
    ...(current.parentRevision !== undefined ? { parentRevision: current.parentRevision } : {}),
    goalContract: current.goalContract,
    evaluatorContracts: current.evaluatorContracts,
    slicePlan: current.slicePlan,
    compositionStrategy: current.compositionStrategy,
    templatePolicy: current.templatePolicy,
    goalDesignSkillRef: skill.objectKey,
    goalDesignSkillVersionRef: skill.versionRef,
    workspaceDiscoveryHash: current.workspaceDiscoveryHash,
    mode: current.mode,
  });
}

function slice(
  id: string,
  requirementIds: string[],
  expectedArtifactRefs: string[],
  overrides: Partial<GoalSliceV1> = {},
): GoalSliceV1 {
  return {
    id,
    requirementIds,
    outcome: `outcome ${id}`,
    stateOrArtifactOwner: `owner ${id}`,
    mutationBoundary: `boundary ${id}`,
    expectedArtifactRefs,
    evaluatorContractRefs: ["eval-offline"],
    dependsOnSliceIds: [],
    dependencyArtifactRefs: [],
    ...overrides,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function syncGoalDesignSkill(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<void> {
  await syncLibraryFileToGraph(db, {
    root: join(import.meta.dirname, "../../library"),
    relativePath: "skills/southstar-goal-design.skill.md",
  });
}

async function upsertGoalDesignSkillObject(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  objectKey: string,
): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: `${objectKey}@v1`,
    state: {
      title: objectKey,
      scope: "global",
      purpose: "goal_design",
      body: "# Goal Design",
    },
  });
}
