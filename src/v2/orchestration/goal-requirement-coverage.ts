import type { EvidenceKind } from "../artifacts/types.ts";
import { criterionValidationCheckKey, type AssuranceRiskAcceptanceV1 } from "../design-library/types.ts";
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
  assuranceRiskAcceptances?: AssuranceRiskAcceptanceV1[];
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
    criterionBindings: Array<{
      criterionId: string;
      criterionVersion: number;
      blocking: boolean;
      artifactContractRef: string;
      artifactContractVersionRef: string;
      evaluatorProfileRef: string;
      evaluatorProfileVersionRef: string;
      verificationMode: "deterministic" | "browser_interaction" | "semantic_review" | "human_approval";
      procedureRef: string;
      procedureVersionRef?: string;
      oracleRef?: string;
      oracleVersionRef?: string;
      typedParameters?: Record<string, unknown>;
      expectedEvidenceKinds: EvidenceKind[];
    }>;
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
  if (coverage.assuranceRiskAcceptances !== undefined && !isAssuranceRiskAcceptanceArray(coverage.assuranceRiskAcceptances)) return undefined;
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
      || !isCriterionBindingArray(entry.criterionBindings)
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
      criterionBindings: entry.criterionBindings,
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
  goalDesignPackage: GoalDesignPackage;
  targetRequirementIds?: string[];
}): GoalRequirementCoverageV1 {
  const requirements = coverageRequirements(input.goalContract, input.targetRequirementIds);
  return {
    schemaVersion: "southstar.goal_requirement_coverage.v1",
    goalContractHash: goalContractHash(input.goalContract),
    ...(input.goalDesignPackage.assuranceRiskAcceptances
      ? { assuranceRiskAcceptances: input.goalDesignPackage.assuranceRiskAcceptances.map((acceptance) => ({
          ...acceptance,
          omittedAssurance: [...acceptance.omittedAssurance],
        })) }
      : {}),
    entries: requirements.map((requirement) => {
      const linkedTasks = input.composition.tasks.filter((task) => task.requirementIds?.includes(requirement.id));
      const producerTasks = linkedTasks.filter(isProducerTask);
      const evaluatorTasks = linkedTasks.filter(isEvaluatorTask);
      if (!input.goalDesignPackage || input.goalDesignPackage.schemaVersion !== "southstar.goal_design_package.v3") {
        throw new Error("Goal Requirement coverage requires southstar.goal_design_package.v3");
      }
      const frozenBindings = input.goalDesignPackage.validationBindings.filter((binding) => (
        binding.requirementId === requirement.id
      ));
      if (frozenBindings.length > 1) {
        throw new Error(`multiple frozen validation bindings for ${requirement.id}`);
      }
      const frozenBinding = frozenBindings[0];
      const criterionBindings = frozenBinding?.criterionBindings.map((binding) => ({
        criterionId: binding.criterionContract.id,
        criterionVersion: binding.criterionContract.version,
        blocking: binding.criterionContract.blocking,
        artifactContractRef: binding.artifactContractRef,
        artifactContractVersionRef: binding.artifactContractVersionRef,
        evaluatorProfileRef: binding.evaluatorProfileRef,
        evaluatorProfileVersionRef: binding.evaluatorProfileVersionRef,
        verificationMode: binding.verificationMode,
        procedureRef: binding.procedureRef,
        ...(binding.procedureVersionRef ? { procedureVersionRef: binding.procedureVersionRef } : {}),
        ...(binding.oracleRef ? { oracleRef: binding.oracleRef, oracleVersionRef: binding.oracleVersionRef } : {}),
        ...(binding.typedParameters ? { typedParameters: binding.typedParameters } : {}),
        expectedEvidenceKinds: [...binding.expectedEvidenceKinds] as EvidenceKind[],
      })) ?? [];
      const frozenEvidenceKinds = criterionBindings.flatMap((binding) => binding.expectedEvidenceKinds);
      const criterionIds = uniqueInOrder(criterionBindings.map((binding) => binding.criterionId));
      const firstBindingByCriterion = new Map(
        frozenBinding?.criterionBindings.map((binding) => [binding.criterionContract.id, binding]) ?? [],
      );
      if (frozenEvidenceKinds.some((kind) => !isEvidenceKind(kind))) {
        throw new Error(`validation binding contains unsupported evidence kind for ${requirement.id}`);
      }
      return {
        requirementId: requirement.id,
        producerTaskIds: uniqueSorted(producerTasks.map((task) => task.id)),
        artifactRefs: uniqueSorted(producerTasks.flatMap((task) => task.outputArtifactRefs)),
        artifactContractRefs: uniqueSorted(criterionBindings.map((binding) => binding.artifactContractRef)),
        evaluatorTaskIds: uniqueSorted(evaluatorTasks.map((task) => task.id)),
        evaluatorProfileRefs: uniqueSorted(criterionBindings.map((binding) => binding.evaluatorProfileRef)),
        evaluatorProfileVersionRefs: uniqueSorted(criterionBindings.map((binding) => binding.evaluatorProfileVersionRef)),
        validationBindingId: frozenBinding?.id,
        criterionBindings,
        criterionIds,
        acceptanceCriteria: criterionIds.map((criterionId) => firstBindingByCriterion.get(criterionId)?.criterionContract.observableClaim ?? criterionId),
        requiredEvidenceKinds: uniqueSorted(frozenEvidenceKinds) as EvidenceKind[],
        ...(requirement.semanticTags ? { semanticTags: [...requirement.semanticTags] } : {}),
      };
    }),
  };
}

function isCriterionBindingArray(value: unknown): value is GoalRequirementCoverageV1["entries"][number]["criterionBindings"] {
  if (!Array.isArray(value)) return false;
  const modes = new Set(["deterministic", "browser_interaction", "semantic_review", "human_approval"]);
  const criterionIds = new Set<string>();
  const checkKeys = new Set<string>();
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const binding = item as Record<string, unknown>;
    if (typeof binding.criterionId !== "string" || binding.criterionId.length === 0) return false;
    if (criterionIds.has(binding.criterionId)) return false;
    criterionIds.add(binding.criterionId);
    const checkKey = typeof binding.verificationMode === "string" && modes.has(binding.verificationMode)
      ? criterionValidationCheckKey(binding.criterionId, binding.verificationMode as Parameters<typeof criterionValidationCheckKey>[1])
      : undefined;
    if (!checkKey || checkKeys.has(checkKey)) return false;
    checkKeys.add(checkKey);
    return Number.isInteger(binding.criterionVersion)
      && Number(binding.criterionVersion) > 0
      && typeof binding.blocking === "boolean"
      && isNonEmptyString(binding.artifactContractRef)
      && isNonEmptyString(binding.artifactContractVersionRef)
      && isNonEmptyString(binding.evaluatorProfileRef)
      && isNonEmptyString(binding.evaluatorProfileVersionRef)
      && typeof binding.verificationMode === "string"
      && modes.has(binding.verificationMode)
      && isNonEmptyString(binding.procedureRef)
      && (binding.procedureVersionRef === undefined || isNonEmptyString(binding.procedureVersionRef))
      && (binding.oracleRef === undefined || isNonEmptyString(binding.oracleRef))
      && (binding.oracleVersionRef === undefined || isNonEmptyString(binding.oracleVersionRef))
      && (binding.typedParameters === undefined || Boolean(binding.typedParameters && typeof binding.typedParameters === "object" && !Array.isArray(binding.typedParameters)))
      && isEvidenceKindArray(binding.expectedEvidenceKinds);
  });
}

function isAssuranceRiskAcceptanceArray(value: unknown): value is AssuranceRiskAcceptanceV1[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  const checkKeys = new Set<string>();
  const modes = new Set(["deterministic", "browser_interaction", "semantic_review", "human_approval"]);
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const acceptance = item as Record<string, unknown>;
    if (acceptance.schemaVersion !== "southstar.assurance_risk_acceptance.v1"
      || typeof acceptance.id !== "string" || acceptance.id.length === 0 || ids.has(acceptance.id)
      || typeof acceptance.criterionId !== "string" || acceptance.criterionId.length === 0
      || !Number.isInteger(acceptance.criterionVersion) || Number(acceptance.criterionVersion) < 1
      || !Array.isArray(acceptance.omittedAssurance) || acceptance.omittedAssurance.length !== 1
      || typeof acceptance.omittedAssurance[0] !== "string" || !modes.has(acceptance.omittedAssurance[0])) return false;
    const checkKey = `${acceptance.criterionId}::${acceptance.omittedAssurance[0]}`;
    if (checkKeys.has(checkKey)) return false;
    if (!["reason", "approvalId", "approvedBy", "approvedAt", "auditEventRef"].every((key) => (
      typeof acceptance[key] === "string" && (acceptance[key] as string).length > 0
    ))) return false;
    ids.add(acceptance.id);
    checkKeys.add(checkKey);
    return true;
  });
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

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isEvidenceKindArray(value: unknown): value is EvidenceKind[] {
  return Array.isArray(value) && value.every(isEvidenceKind);
}

function isEvidenceKind(kind: unknown): kind is EvidenceKind {
  return typeof kind === "string" && EVIDENCE_KINDS.some((candidate) => candidate === kind);
}
