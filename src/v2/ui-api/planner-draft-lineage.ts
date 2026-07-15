import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { goalContractHash, type GoalContractV1 } from "../orchestration/goal-contract.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";

export type PlannerDraftLineage = {
  goalContractHash: string;
  workflowManifestHash: string;
  goalRequirementCoverageHash: string;
};

export function buildPlannerDraftLineage(input: {
  goalContract: GoalContractV1;
  workflow: SouthstarWorkflowManifest;
  coverage: unknown;
}): PlannerDraftLineage {
  return {
    goalContractHash: goalContractHash(input.goalContract),
    workflowManifestHash: contentHashForPayload(input.workflow),
    goalRequirementCoverageHash: contentHashForPayload(input.coverage),
  };
}

export function assertPlannerDraftLineage(input: {
  payload: Record<string, unknown>;
  summary: Record<string, unknown>;
  lineage: PlannerDraftLineage;
  draftId?: string;
}): void {
  const contractHashes = [
    { label: "payload.goalContractHash", value: input.payload.goalContractHash },
    { label: "summary.goalContractHash", value: input.summary.goalContractHash },
    {
      label: "goalRequirementCoverage.goalContractHash",
      value: recordValue(input.payload.goalRequirementCoverage).goalContractHash,
    },
    {
      label: "orchestrationSnapshot.goalContractHash",
      value: recordValue(input.payload.orchestrationSnapshot).goalContractHash,
    },
  ];
  for (const hash of contractHashes) {
    if (hash.value === undefined) continue;
    if (hash.value === input.lineage.goalContractHash) continue;
    throw new Error(
      `Goal Contract hash mismatch at ${hash.label}: expected ${input.lineage.goalContractHash}, received ${String(hash.value)}`,
    );
  }

  if (input.payload.goalRequirementCoverageHash !== input.lineage.goalRequirementCoverageHash) {
    throw new Error(`planner draft Goal Requirement Coverage hash mismatch${draftSuffix(input.draftId)}`);
  }
  if (input.payload.workflowManifestHash !== input.lineage.workflowManifestHash) {
    throw new Error(`planner draft workflow manifest hash mismatch${draftSuffix(input.draftId)}`);
  }
}

function draftSuffix(draftId: string | undefined): string {
  return draftId ? `: ${draftId}` : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
