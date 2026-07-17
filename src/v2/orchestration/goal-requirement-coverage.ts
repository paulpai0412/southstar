import type { EvidenceKind } from "../artifacts/types.ts";
import type { WorkflowCompositionPlan, WorkflowCompositionTask } from "../design-library/types.ts";
import type { GoalDesignPackage } from "./goal-design.ts";
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
    artifactContractRefs?: string[];
    evaluatorTaskIds: string[];
    evaluatorProfileRefs: string[];
    evaluatorProfileVersionRefs: string[];
    semanticTags?: string[];
    validationBindingId?: string;
    criterionIds: string[];
    acceptanceCriteria: string[];
    requiredEvidenceKinds: EvidenceKind[];
  }>;
};

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "file-diff",
  "test-result",
  "command-output",
  "url",
  "screenshot",
  "human-approval",
  "artifact-ref",
  "workspace-snapshot",
  "policy-decision",
];

export function storedGoalRequirementCoverage(value: unknown): GoalRequirementCoverageV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const coverage = value as Record<string, unknown>;
  if (coverage.schemaVersion !== "southstar.goal_requirement_coverage.v1") return undefined;
  if (typeof coverage.goalContractHash !== "string" || coverage.goalContractHash.length === 0) return undefined;
  if (!Array.isArray(coverage.entries)) return undefined;
  const requirementIds = new Set<string>();
  const entries: GoalRequirementCoverageV1["entries"] = [];
  for (const value of coverage.entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entry = value as Record<string, unknown>;
    if (typeof entry.requirementId !== "string" || entry.requirementId.length === 0 || requirementIds.has(entry.requirementId)) return undefined;
    requirementIds.add(entry.requirementId);
    if (!isStringArray(entry.producerTaskIds)
      || !isStringArray(entry.artifactRefs)
      || (entry.artifactContractRefs !== undefined && !isStringArray(entry.artifactContractRefs))
      || !isStringArray(entry.evaluatorTaskIds)
      || !isStringArray(entry.evaluatorProfileRefs)
      || (entry.evaluatorProfileVersionRefs !== undefined && !isStringArray(entry.evaluatorProfileVersionRefs))
      || (entry.semanticTags !== undefined && !isStringArray(entry.semanticTags))
      || (entry.validationBindingId !== undefined && (typeof entry.validationBindingId !== "string" || entry.validationBindingId.length === 0))
      || (entry.criterionIds !== undefined && !isStringArray(entry.criterionIds))
      || (entry.acceptanceCriteria !== undefined && !isStringArray(entry.acceptanceCriteria))
      || !isEvidenceKindArray(entry.requiredEvidenceKinds)) return undefined;
    entries.push({
      requirementId: entry.requirementId,
      producerTaskIds: entry.producerTaskIds,
      artifactRefs: entry.artifactRefs,
      artifactContractRefs: (entry.artifactContractRefs as string[] | undefined) ?? [],
      evaluatorTaskIds: entry.evaluatorTaskIds,
      evaluatorProfileRefs: entry.evaluatorProfileRefs,
      evaluatorProfileVersionRefs: (entry.evaluatorProfileVersionRefs as string[] | undefined) ?? [],
      ...(entry.semanticTags !== undefined ? { semanticTags: entry.semanticTags as string[] } : {}),
      validationBindingId: entry.validationBindingId as string | undefined,
      criterionIds: (entry.criterionIds as string[] | undefined) ?? [],
      acceptanceCriteria: (entry.acceptanceCriteria as string[] | undefined) ?? [],
      requiredEvidenceKinds: entry.requiredEvidenceKinds,
    });
  }
  return {
    schemaVersion: "southstar.goal_requirement_coverage.v1",
    goalContractHash: coverage.goalContractHash,
    entries,
  };
}

export function buildGoalRequirementCoverage(input: {
  goalContract: GoalContractV1;
  composition: WorkflowCompositionPlan;
  goalDesignPackage?: GoalDesignPackage;
  targetRequirementIds?: string[];
}): GoalRequirementCoverageV1 {
  const requirements = coverageRequirements(input.goalContract, input.targetRequirementIds);
  return {
    schemaVersion: "southstar.goal_requirement_coverage.v1",
    goalContractHash: goalContractHash(input.goalContract),
    entries: requirements.map((requirement) => {
      const linkedTasks = input.composition.tasks.filter((task) => task.requirementIds?.includes(requirement.id));
      const producerTasks = linkedTasks.filter(isProducerTask);
      const evaluatorTasks = linkedTasks.filter(isEvaluatorTask);
      const frozenBindings = input.goalDesignPackage?.schemaVersion === "southstar.goal_design_package.v2"
        ? input.goalDesignPackage.validationBindings.filter((binding) => binding.requirementId === requirement.id)
        : [];
      if (frozenBindings.length > 1) {
        throw new Error(`multiple frozen validation bindings for ${requirement.id}`);
      }
      const frozenBinding = frozenBindings[0];
      const frozenEvidenceKinds = frozenBindings.flatMap((binding) => binding.requiredEvidenceKinds);
      if (frozenEvidenceKinds.some((kind) => !isEvidenceKind(kind))) {
        throw new Error(`validation binding contains unsupported evidence kind for ${requirement.id}`);
      }
      return {
        requirementId: requirement.id,
        producerTaskIds: uniqueSorted(producerTasks.map((task) => task.id)),
        artifactRefs: uniqueSorted(producerTasks.flatMap((task) => task.outputArtifactRefs)),
        artifactContractRefs: uniqueSorted(frozenBindings.flatMap((binding) => binding.artifactContractRefs)),
        evaluatorTaskIds: uniqueSorted(evaluatorTasks.map((task) => task.id)),
        evaluatorProfileRefs: uniqueSorted(frozenBindings.length > 0
          ? frozenBindings.map((binding) => binding.evaluatorProfileRef)
          : evaluatorTasks.map((task) => task.evaluatorProfileRef)),
        evaluatorProfileVersionRefs: uniqueSorted(frozenBindings.map((binding) => binding.evaluatorProfileVersionRef)),
        validationBindingId: frozenBinding?.id,
        criterionIds: frozenBinding ? [...frozenBinding.criterionIds] : [],
        acceptanceCriteria: frozenBinding
          ? [...frozenBinding.acceptanceCriteria]
          : [],
        requiredEvidenceKinds: uniqueSorted(frozenBindings.length > 0
          ? frozenEvidenceKinds
          : evaluatorTasks.flatMap(requiredEvidenceKindsForTask)) as EvidenceKind[],
        ...(requirement.semanticTags ? { semanticTags: [...requirement.semanticTags] } : {}),
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

export function isProducerTask(task: WorkflowCompositionTask): boolean {
  const nodeType = classifyWorkflowCompositionTask(task);
  return (nodeType === "implement" || nodeType === "repair" || nodeType === "general")
    && !isCoverageExceptionTask(task);
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isEvidenceKindArray(value: unknown): value is EvidenceKind[] {
  return Array.isArray(value) && value.every(isEvidenceKind);
}

function isEvidenceKind(kind: unknown): kind is EvidenceKind {
  return typeof kind === "string" && EVIDENCE_KINDS.some((candidate) => candidate === kind);
}
