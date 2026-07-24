import { EVIDENCE_KINDS, type EvidenceKind } from "../artifacts/types.ts";
import type { WorkflowComposerMode } from "../orchestration/composer-registry.ts";
import {
  type GoalDesignMode,
  type WorkflowTemplatePolicyV1,
} from "../orchestration/goal-design.ts";
import type {
  GoalRequirementDraftRevisionOperation,
  GoalRequirementDraftRevisionPatchV1,
} from "../orchestration/goal-requirement-draft.ts";
import { CRITERION_ASSURANCE_CLASSES } from "../orchestration/goal-requirement-draft.ts";
import type { GoalSlicePatchV1 } from "../orchestration/goal-design-draft-service.ts";
import type {
  UiInteractionContractInputV1,
  UiInteractionContractRevisionOperation,
} from "../orchestration/ui-interaction-contract.ts";

export type AssuranceRiskAcceptanceInput = {
  criterionId: string;
  criterionVersion: number;
  omittedAssurance: Array<(typeof CRITERION_ASSURANCE_CLASSES)[number]>;
  reason: string;
  approvedBy: string;
};

export function parseAssuranceRiskAcceptanceInput(value: unknown): AssuranceRiskAcceptanceInput {
  if (!isRecord(value)) throw new Error("acceptance must be an object");
  assertAllowedFields(value, ["criterionId", "criterionVersion", "omittedAssurance", "reason", "approvedBy"], "acceptance");
  if (typeof value.criterionVersion !== "number" || !Number.isInteger(value.criterionVersion) || value.criterionVersion < 1) {
    throw new Error("acceptance.criterionVersion must be a positive integer");
  }
  return {
    criterionId: requiredString(value.criterionId, "acceptance.criterionId"),
    criterionVersion: value.criterionVersion,
    omittedAssurance: parseRequiredAssurance(value.omittedAssurance, "acceptance.omittedAssurance"),
    reason: requiredString(value.reason, "acceptance.reason"),
    approvedBy: requiredString(value.approvedBy, "acceptance.approvedBy"),
  };
}

export function optionalOrchestrationMode(value: unknown): "llm-constrained" | undefined {
  if (value === undefined) return undefined;
  if (value === "llm-constrained") return value;
  throw new Error("orchestrationMode must be llm-constrained");
}

export function optionalComposerMode(value: unknown): WorkflowComposerMode | undefined {
  if (value === undefined) return undefined;
  if (value === "llm") return value;
  throw new Error("composerMode must be llm");
}

export function optionalGoalDesignMode(value: unknown): GoalDesignMode | undefined {
  if (value === undefined) return undefined;
  if (value === "review_before_compose" || value === "auto_until_blocked") return value;
  throw new Error("goalDesignMode must be review_before_compose or auto_until_blocked");
}

export function optionalWorkflowTemplatePolicy(value: unknown): WorkflowTemplatePolicyV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("templatePolicy must be an object");
  if (value.mode === "auto") return { mode: "auto" };
  if (value.mode === "prefer" || value.mode === "require") {
    return {
      mode: value.mode,
      templateRef: requiredString(value.templateRef, "templatePolicy.templateRef"),
      versionRef: requiredString(value.versionRef, "templatePolicy.versionRef"),
    };
  }
  throw new Error("templatePolicy.mode must be auto, prefer, or require");
}

export function parseGoalSlicePatch(value: unknown): GoalSlicePatchV1 {
  if (!isRecord(value)) throw new Error("patch must be an object");
  const patch: GoalSlicePatchV1 = {};
  if (value.outcome !== undefined) patch.outcome = requiredString(value.outcome, "patch.outcome");
  if (value.requirementIds !== undefined) patch.requirementIds = parseRequiredStringArray(value.requirementIds, "patch.requirementIds");
  if (value.stateOrArtifactOwner !== undefined) patch.stateOrArtifactOwner = requiredString(value.stateOrArtifactOwner, "patch.stateOrArtifactOwner");
  if (value.mutationBoundary !== undefined) patch.mutationBoundary = requiredString(value.mutationBoundary, "patch.mutationBoundary");
  if (value.expectedArtifactRefs !== undefined) patch.expectedArtifactRefs = parseRequiredStringArray(value.expectedArtifactRefs, "patch.expectedArtifactRefs");
  if (value.evaluatorContractRefs !== undefined) patch.evaluatorContractRefs = parseRequiredStringArray(value.evaluatorContractRefs, "patch.evaluatorContractRefs");
  if (value.dependsOnSliceIds !== undefined) patch.dependsOnSliceIds = parseRequiredStringArray(value.dependsOnSliceIds, "patch.dependsOnSliceIds");
  if (value.dependencyArtifactRefs !== undefined) patch.dependencyArtifactRefs = parseRequiredStringArray(value.dependencyArtifactRefs, "patch.dependencyArtifactRefs");
  if (value.mergeReason !== undefined) patch.mergeReason = requiredString(value.mergeReason, "patch.mergeReason");
  return patch;
}

export function parseUiInteractionContractInput(value: unknown): UiInteractionContractInputV1 {
  if (!isRecord(value)) throw new Error("contract must be an object");
  assertAllowedFields(value, ["requirementIds", "screens", "flows", "criterionBindings"], "contract");
  if (!Array.isArray(value.screens) || !Array.isArray(value.flows) || !Array.isArray(value.criterionBindings)) {
    throw new Error("contract screens, flows, and criterionBindings must be arrays");
  }
  return {
    requirementIds: parseRequiredStringArray(value.requirementIds, "contract.requirementIds"),
    screens: structuredClone(value.screens) as UiInteractionContractInputV1["screens"],
    flows: structuredClone(value.flows) as UiInteractionContractInputV1["flows"],
    criterionBindings: structuredClone(value.criterionBindings) as UiInteractionContractInputV1["criterionBindings"],
  };
}

export function parseUiInteractionContractPatch(value: unknown): UiInteractionContractRevisionOperation {
  if (!isRecord(value)) throw new Error("patch must be an object");
  const kind = requiredString(value.kind, "patch.kind");
  if (kind === "confirm") {
    assertAllowedFields(value, ["kind"], "patch");
    return { kind };
  }
  if (kind === "replace") {
    assertAllowedFields(value, ["kind", "contract"], "patch");
    return { kind, contract: parseUiInteractionContractInput(value.contract) };
  }
  if (kind === "update_element") {
    assertAllowedFields(value, ["kind", "screenId", "elementId", "patch"], "patch");
    if (!isRecord(value.patch)) throw new Error("patch.patch must be an object");
    assertAllowedFields(value.patch, ["type", "label", "visibleInStates", "enabledInStates"], "patch.patch");
    return {
      kind,
      screenId: requiredString(value.screenId, "patch.screenId"),
      elementId: requiredString(value.elementId, "patch.elementId"),
      patch: structuredClone(value.patch),
    } as UiInteractionContractRevisionOperation;
  }
  if (kind === "update_action") {
    assertAllowedFields(value, ["kind", "screenId", "actionId", "patch"], "patch");
    if (!isRecord(value.patch)) throw new Error("patch.patch must be an object");
    assertAllowedFields(value.patch, ["triggerElementId", "fromState", "toState", "targetScreenId", "expectedEffect"], "patch.patch");
    return {
      kind,
      screenId: requiredString(value.screenId, "patch.screenId"),
      actionId: requiredString(value.actionId, "patch.actionId"),
      patch: structuredClone(value.patch),
    } as UiInteractionContractRevisionOperation;
  }
  if (kind === "update_screen") {
    assertAllowedFields(value, ["kind", "screenId", "patch"], "patch");
    if (!isRecord(value.patch)) throw new Error("patch.patch must be an object");
    assertAllowedFields(value.patch, ["title", "purpose", "responsiveRules", "accessibilityRules"], "patch.patch");
    return {
      kind,
      screenId: requiredString(value.screenId, "patch.screenId"),
      patch: structuredClone(value.patch),
    } as UiInteractionContractRevisionOperation;
  }
  throw new Error("patch.kind must be replace, update_element, update_action, update_screen, or confirm");
}

export function parseGoalRequirementPatch(value: unknown): GoalRequirementDraftRevisionPatchV1 | GoalRequirementDraftRevisionOperation {
  if (!isRecord(value)) throw new Error("patch must be an object");
  if (typeof value.kind === "string") {
    if (value.kind === "supersede" || value.kind === "restore") {
      return {
        kind: value.kind,
        requirementId: requiredString(value.requirementId, "patch.requirementId"),
      } as GoalRequirementDraftRevisionOperation;
    }
    if (value.kind === "update") {
      return {
        kind: "update",
        requirementId: requiredString(value.requirementId, "patch.requirementId"),
        patch: parseGoalRequirementPatch(value.patch),
      } as GoalRequirementDraftRevisionOperation;
    }
    throw new Error("patch.kind must be update, supersede, or restore");
  }
  const patch: GoalRequirementDraftRevisionPatchV1 = {};
  const allowed = new Set([
    "title", "statement", "source", "blocking", "userVisibleBehaviors", "businessRules",
    "acceptanceCriteria", "expectedOutcomeArtifacts", "verificationIntent", "assumptions",
    "openQuestions", "riskTags", "interactionContractRefs",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`patch.${key} is not editable`);
  }
  if (value.title !== undefined) patch.title = requiredString(value.title, "patch.title");
  if (value.statement !== undefined) patch.statement = requiredString(value.statement, "patch.statement");
  if (value.source !== undefined) {
    if (value.source !== "explicit" && value.source !== "inferred") throw new Error("patch.source must be explicit or inferred");
    patch.source = value.source;
  }
  if (value.blocking !== undefined) {
    if (typeof value.blocking !== "boolean") throw new Error("patch.blocking must be boolean");
    patch.blocking = value.blocking;
  }
  for (const field of ["userVisibleBehaviors", "businessRules", "verificationIntent", "assumptions", "openQuestions", "riskTags", "interactionContractRefs"] as const) {
    if (value[field] !== undefined) patch[field] = parseRequiredStringArray(value[field], `patch.${field}`);
  }
  if (value.acceptanceCriteria !== undefined) {
    if (!Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.some((criterion) => !isRecord(criterion))) {
      throw new Error("patch.acceptanceCriteria must be an array of objects");
    }
    patch.acceptanceCriteria = value.acceptanceCriteria.map((criterion, index) => ({
      ...(criterion.id === undefined ? {} : { id: requiredString(criterion.id, `patch.acceptanceCriteria.${index}.id`) }),
      observableClaim: requiredString(criterion.observableClaim, `patch.acceptanceCriteria.${index}.observableClaim`),
      blocking: requiredBoolean(criterion.blocking, `patch.acceptanceCriteria.${index}.blocking`),
      verificationIntent: parseRequiredStringArray(criterion.verificationIntent, `patch.acceptanceCriteria.${index}.verificationIntent`),
      requiredAssurance: parseRequiredAssurance(criterion.requiredAssurance, `patch.acceptanceCriteria.${index}.requiredAssurance`),
      evidenceIntent: parseRequiredEvidenceKinds(criterion.evidenceIntent, `patch.acceptanceCriteria.${index}.evidenceIntent`),
    }));
  }
  if (value.expectedOutcomeArtifacts !== undefined) {
    if (!Array.isArray(value.expectedOutcomeArtifacts) || value.expectedOutcomeArtifacts.some((artifact) => !isRecord(artifact))) {
      throw new Error("patch.expectedOutcomeArtifacts must be an array of objects");
    }
    patch.expectedOutcomeArtifacts = value.expectedOutcomeArtifacts.map((artifact, index) => ({
      description: requiredString(artifact.description, `patch.expectedOutcomeArtifacts.${index}.description`),
      ...(artifact.mediaType === undefined ? {} : { mediaType: requiredString(artifact.mediaType, `patch.expectedOutcomeArtifacts.${index}.mediaType`) }),
    }));
  }
  return patch;
}

export function assertRequirementRouteTarget(
  routeRequirementId: string,
  patch: GoalRequirementDraftRevisionPatchV1 | GoalRequirementDraftRevisionOperation,
): void {
  if ("kind" in patch && patch.requirementId !== routeRequirementId) {
    throw new Error(`goal_requirement_route_target_conflict: ${routeRequirementId} does not match ${patch.requirementId}`);
  }
}

export function assertRawRequirementRouteTarget(routeRequirementId: string, value: unknown): void {
  if (!isRecord(value)) return;
  const targets: string[] = [];
  if (typeof value.requirementId === "string") targets.push(value.requirementId);
  if (Array.isArray(value.requirementIds)) {
    targets.push(...value.requirementIds.filter((id): id is string => typeof id === "string"));
  }
  if (targets.some((target) => target !== routeRequirementId)) {
    throw new Error(`goal_requirement_route_target_conflict: ${routeRequirementId} does not match ${targets.join(", ")}`);
  }
}

function assertAllowedFields(value: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unsupported fields: ${unknown.join(", ")}`);
}

function parseRequiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function parseRequiredEvidenceKinds(value: unknown, field: string): EvidenceKind[] {
  const values = parseRequiredStringArray(value, field);
  const allowed = new Set<string>(EVIDENCE_KINDS);
  const unsupported = values.filter((item) => !allowed.has(item));
  if (unsupported.length > 0) {
    throw new Error(`${field} contains unsupported evidence kinds: ${unsupported.join(", ")}; allowed values: ${EVIDENCE_KINDS.join(", ")}`);
  }
  return values as EvidenceKind[];
}

function parseRequiredAssurance(
  value: unknown,
  field: string,
): Array<(typeof CRITERION_ASSURANCE_CLASSES)[number]> {
  const values = parseRequiredStringArray(value, field);
  const allowed = new Set<string>(CRITERION_ASSURANCE_CLASSES);
  if (values.length === 0 || values.some((item) => !allowed.has(item)) || new Set(values).size !== values.length) {
    throw new Error(`${field} must contain unique supported assurance classes`);
  }
  return values as Array<(typeof CRITERION_ASSURANCE_CLASSES)[number]>;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
