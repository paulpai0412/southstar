import test from "node:test";
import assert from "node:assert/strict";
import { contentHashForPayload } from "../../src/v2/design-library/canonical-json.ts";
import { goalContractHash, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import type { GoalRequirementCoverageV1 } from "../../src/v2/orchestration/goal-requirement-coverage.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import {
  assertPlannerDraftLineage,
  buildPlannerDraftLineage,
} from "../../src/v2/ui-api/planner-draft-lineage.ts";

const goalContract = {
  schemaVersion: "southstar.goal_contract.v1",
  originalPrompt: "Create an article",
  workspace: { cwd: "/workspace/article" },
  domain: "software",
  intent: "create",
  workType: "general",
  summary: "Create an article",
  requirements: [],
  expectedArtifactRefs: [],
  requiredCapabilities: [],
  nonGoals: [],
  assumptions: [],
  blockingInputs: [],
  riskTags: [],
  requestedSideEffects: [],
} as unknown as GoalContractV1;

const workflow = {
  schemaVersion: "southstar.v2",
  workflowId: "wf-article",
  title: "Create an article",
  goalPrompt: "Create an article",
  tasks: [],
} as unknown as SouthstarWorkflowManifest;

const coverage = {
  schemaVersion: "southstar.goal_requirement_coverage.v1",
  goalContractHash: goalContractHash(goalContract),
  entries: [],
} satisfies GoalRequirementCoverageV1;

test("planner draft lineage computes the canonical contract, manifest, and coverage hashes", () => {
  const lineage = buildPlannerDraftLineage({ goalContract, workflow, coverage });

  assert.deepEqual(lineage, {
    goalContractHash: goalContractHash(goalContract),
    workflowManifestHash: contentHashForPayload(workflow),
    goalRequirementCoverageHash: contentHashForPayload(coverage),
  });
});

test("planner draft lineage rejects stale stored hashes with the field path", () => {
  const lineage = buildPlannerDraftLineage({ goalContract, workflow, coverage });

  assert.throws(
    () => assertPlannerDraftLineage({
      payload: {
        goalContractHash: lineage.goalContractHash,
        workflowManifestHash: "stale-manifest-hash",
        goalRequirementCoverageHash: lineage.goalRequirementCoverageHash,
        goalRequirementCoverage: coverage,
        orchestrationSnapshot: { goalContractHash: lineage.goalContractHash },
      },
      summary: { goalContractHash: lineage.goalContractHash },
      lineage,
    }),
    /planner draft workflow manifest hash mismatch/,
  );
});
