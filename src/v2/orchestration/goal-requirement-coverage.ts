import type { EvidenceKind } from "../artifacts/types.ts";
import type { WorkflowCompositionPlan, WorkflowCompositionTask } from "../design-library/types.ts";
import { goalContractHash, type GoalContractV1 } from "./goal-contract.ts";
import {
  classifyWorkflowCompositionTask,
  isExplicitCoverageExceptionTask,
} from "./workflow-node-classifier.ts";

export type GoalRequirementCoverageV1 = {
  schemaVersion: "southstar.goal_requirement_coverage.v1";
  goalContractHash: string;
  entries: Array<{
    requirementId: string;
    producerTaskIds: string[];
    artifactRefs: string[];
    evaluatorTaskIds: string[];
    evaluatorProfileRefs: string[];
    requiredEvidenceKinds: EvidenceKind[];
  }>;
};

export function buildGoalRequirementCoverage(input: {
  goalContract: GoalContractV1;
  composition: WorkflowCompositionPlan;
  targetRequirementIds?: string[];
}): GoalRequirementCoverageV1 {
  const requirements = coverageRequirements(input.goalContract, input.targetRequirementIds);
  return {
    schemaVersion: "southstar.goal_requirement_coverage.v1",
    goalContractHash: goalContractHash(input.goalContract),
    entries: requirements.map((requirement) => {
      const linkedTasks = input.composition.tasks.filter((task) => task.requirementIds?.includes(requirement.id));
      const producerTasks = linkedTasks.filter((task) => !isEvaluatorTask(task) && !isCoverageExceptionTask(task));
      const evaluatorTasks = linkedTasks.filter(isEvaluatorTask);
      return {
        requirementId: requirement.id,
        producerTaskIds: uniqueSorted(producerTasks.map((task) => task.id)),
        artifactRefs: uniqueSorted(producerTasks.flatMap((task) => task.outputArtifactRefs)),
        evaluatorTaskIds: uniqueSorted(evaluatorTasks.map((task) => task.id)),
        evaluatorProfileRefs: uniqueSorted(evaluatorTasks.map((task) => task.evaluatorProfileRef)),
        requiredEvidenceKinds: uniqueSorted(
          evaluatorTasks.flatMap(requiredEvidenceKindsForTask),
        ) as EvidenceKind[],
      };
    }),
  };
}

function coverageRequirements(
  goalContract: GoalContractV1,
  targetRequirementIds: string[] | undefined,
): GoalContractV1["requirements"] {
  if (targetRequirementIds === undefined) return goalContract.requirements;
  const targetIds = new Set(targetRequirementIds);
  if (targetIds.size === 0) throw new Error("targetRequirementIds must contain at least one requirement id");
  const knownIds = new Set(goalContract.requirements.map((requirement) => requirement.id));
  for (const targetId of targetIds) {
    if (!knownIds.has(targetId)) throw new Error(`unknown target Goal Contract requirement: ${targetId}`);
  }
  return goalContract.requirements.filter((requirement) => targetIds.has(requirement.id));
}

export function isEvaluatorTask(task: WorkflowCompositionTask): boolean {
  const nodeType = classifyWorkflowCompositionTask(task);
  return nodeType === "verify" || nodeType === "review";
}

export function isCoverageExceptionTask(task: WorkflowCompositionTask): boolean {
  return isExplicitCoverageExceptionTask(task);
}

function requiredEvidenceKindsForTask(task: WorkflowCompositionTask): EvidenceKind[] {
  const kinds = new Set<EvidenceKind>(["artifact-ref"]);
  if (task.toolGrantRefs.some((ref) => ref.includes("shell") || ref.includes("test"))) {
    kinds.add("test-result");
    kinds.add("command-output");
  }
  if (task.mcpGrantRefs.some((ref) => ref.includes("browser") || ref.includes("playwright"))) {
    kinds.add("screenshot");
    kinds.add("url");
  }
  return [...kinds].sort();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
