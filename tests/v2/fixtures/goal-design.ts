import { createHash } from "node:crypto";
import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";
import { contentHashForPayload } from "../../../src/v2/design-library/canonical-json.ts";
import {
  finalizeGoalDesignPackageV3,
  type GoalDesignPackageV3,
} from "../../../src/v2/orchestration/goal-design.ts";
import { goalContractHash, type GoalContractV1 } from "../../../src/v2/orchestration/goal-contract.ts";
import { upsertRuntimeResourcePg } from "../../../src/v2/stores/postgres-runtime-store.ts";

export interface CanonicalGoalDesignLineageFixture {
  draftId: string;
  goalContract: GoalContractV1;
  goalContractHash: string;
  goalDesignPackage: GoalDesignPackageV3;
  runtimeContext: {
    draftId: string;
    goalContractHash: string;
    goalDesignPackageHash: string;
  };
}

export function canonicalNonBlockingGoalDesignLineageFixture(
  runId: string,
  originalPrompt: string,
  cwd = "/workspace",
): CanonicalGoalDesignLineageFixture {
  const goalContract: GoalContractV1 = {
    schemaVersion: "southstar.goal_contract.v2",
    originalPrompt,
    promptHash: createHash("sha256").update(originalPrompt).digest("hex"),
    revision: 1,
    workspace: { cwd },
    domain: "software",
    intent: "exercise_runtime_fixture",
    workType: "general",
    summary: originalPrompt,
    requirements: [{
      id: "req-runtime-fixture",
      statement: originalPrompt,
      acceptanceCriteria: [{
        id: "criterion-runtime-fixture",
        version: 1,
        observableClaim: "The runtime behavior under test is observed.",
        blocking: false,
        verificationIntent: ["Observe the runtime behavior under test."],
        requiredAssurance: ["deterministic"],
      }],
      blocking: false,
      source: "explicit",
      expectedArtifacts: [],
    }],
    expectedArtifactRefs: [],
    requiredCapabilities: [],
    nonGoals: [],
    assumptions: [],
    blockingInputs: [],
    riskTags: [],
    requestedSideEffects: [],
  };
  const canonicalContractHash = goalContractHash(goalContract);
  const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract);
  const draftId = `draft-${runId}`;
  return {
    draftId,
    goalContract,
    goalContractHash: canonicalContractHash,
    goalDesignPackage,
    runtimeContext: {
      draftId,
      goalContractHash: canonicalContractHash,
      goalDesignPackageHash: goalDesignPackage.packageHash,
    },
  };
}

export async function persistCanonicalGoalDesignLineageFixture(
  db: SouthstarDb,
  runId: string,
  lineage: CanonicalGoalDesignLineageFixture,
): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    resourceType: "planner_draft",
    resourceKey: lineage.draftId,
    scope: "planner",
    status: "validated",
    payload: {
      goalContract: lineage.goalContract,
      goalContractHash: lineage.goalContractHash,
      goalDesignPackage: lineage.goalDesignPackage,
    },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "goal_requirement_coverage",
    resourceKey: runId,
    runId,
    scope: "run",
    status: "frozen",
    payload: {
      schemaVersion: "southstar.goal_requirement_coverage.v1",
      goalContractHash: lineage.goalContractHash,
      entries: [],
    },
  });
}

export function canonicalGoalDesignPackageFixture(
  goalContract: GoalContractV1,
  requirementDraftHash = contentHashForPayload({ goalContract }),
  options: {
    artifactContractRef?: string;
    artifactContractVersionRef?: string;
    evaluatorProfileRef?: string;
    evaluatorProfileVersionRef?: string;
    procedureRef?: string;
    expectedEvidenceKinds?: Array<"file-diff" | "test-result" | "command-output" | "url" | "screenshot" | "human-approval" | "artifact-ref" | "workspace-snapshot" | "policy-decision">;
  } = {},
): GoalDesignPackageV3 {
  const requirements = goalContract.requirements.filter((requirement) => (
    requirement.acceptanceCriteria.some((criterion) => criterion.blocking)
  ));
  const validationBindings = requirements.map((requirement, requirementIndex) => {
    const artifactRef = options.artifactContractRef ?? "artifact.implementation_report";
    const evaluatorRef = options.evaluatorProfileRef ?? "evaluator.software-feature-quality";
    const artifactVersionRef = options.artifactContractVersionRef ?? `${artifactRef}@test`;
    const evaluatorVersionRef = options.evaluatorProfileVersionRef ?? `${evaluatorRef}@test`;
    return {
      schemaVersion: "southstar.requirement_validation_binding.v3" as const,
      id: `binding-${requirementIndex + 1}`,
      requirementId: requirement.id,
      criterionBindings: requirement.acceptanceCriteria.map((criterion) => ({
        criterionContract: { ...criterion },
        artifactContractRef: artifactRef,
        artifactContractVersionRef: artifactVersionRef,
        evaluatorProfileRef: evaluatorRef,
        evaluatorProfileVersionRef: evaluatorVersionRef,
        verificationMode: criterion.requiredAssurance[0]!,
        procedureRef: options.procedureRef ?? "procedure.test",
        expectedEvidenceKinds: options.expectedEvidenceKinds ?? ["test-result"],
        independence: "independent" as const,
        failureClassifications: ["implementation_gap"],
      })),
    };
  });
  const slices = validationBindings.map((binding, index) => {
    const requirement = requirements[index]!;
    return {
      id: `slice-${index + 1}`,
      requirementIds: [requirement.id],
      outcome: requirement.statement,
      stateOrArtifactOwner: binding.criterionBindings[0]!.artifactContractRef,
      mutationBoundary: `requirement ${requirement.id}`,
      expectedArtifactRefs: [...new Set(binding.criterionBindings.map((item) => item.artifactContractRef))],
      evaluatorContractRefs: [binding.id],
      dependsOnSliceIds: [],
      dependencyArtifactRefs: [],
    };
  });
  return finalizeGoalDesignPackageV3({
    schemaVersion: "southstar.goal_design_package.v3",
    revision: 1,
    goalContract,
    requirementDraftHash,
    validationBindings,
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: 1,
      slices,
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: slices.map((slice) => slice.id),
      rationale: "Test fixture preserves one canonical validation boundary per blocking requirement.",
    },
    templatePolicy: { mode: "auto" },
    goalDesignSkillRef: "skill.southstar-goal-design",
    goalDesignSkillVersionRef: "skill.southstar-goal-design@test",
    workspaceDiscoveryHash: "workspace-discovery@test",
    mode: "review_before_compose",
  });
}
