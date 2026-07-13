import { contentHashForPayload } from "../design-library/canonical-json.ts";
import {
  finalizeGoalContract,
  type GoalContractV1,
} from "./goal-contract.ts";
import type { RequirementSpecV2 } from "../design-library/types.ts";

export type GoalAcceptanceCriterionDraftV1 = {
  id: string;
  statement: string;
  evidenceIntent: string[];
};

export type GoalAcceptanceCriterionDraftInputV1 = Omit<GoalAcceptanceCriterionDraftV1, "id"> & {
  id?: string;
};

export type GoalRequirementDraftItemV1 = {
  id: string;
  title: string;
  statement: string;
  source: "explicit" | "inferred";
  blocking: boolean;
  userVisibleBehaviors: string[];
  businessRules: string[];
  acceptanceCriteria: GoalAcceptanceCriterionDraftV1[];
  expectedOutcomeArtifacts: Array<{ description: string; mediaType?: string }>;
  verificationIntent: string[];
  assumptions: string[];
  openQuestions: string[];
  riskTags: string[];
  interactionContractRefs: string[];
  status: "needs_clarification" | "ready" | "confirmed" | "superseded";
};

export type GoalRequirementDraftItemInputV1 = Omit<
  GoalRequirementDraftItemV1,
  "id" | "status" | "acceptanceCriteria"
> & {
  id?: string;
  status?: GoalRequirementDraftItemV1["status"];
  acceptanceCriteria: GoalAcceptanceCriterionDraftInputV1[];
};

export type GoalRequirementDraftV1 = {
  schemaVersion: "southstar.goal_requirement_draft.v1";
  revision: number;
  parentRevision?: number;
  originalPrompt: string;
  workspace: { cwd: string; projectRef?: string };
  summary: string;
  requirements: GoalRequirementDraftItemV1[];
  nonGoals: string[];
  blockingInputs: string[];
  draftHash: string;
};

export type GoalRequirementDraftInputV1 = {
  goalPrompt: string;
  cwd: string;
  projectRef?: string;
  summary: string;
  requirements: GoalRequirementDraftItemInputV1[];
  nonGoals: string[];
  blockingInputs: string[];
};

export type GoalRequirementDraftIssueCode =
  | "invalid_draft"
  | "invalid_schema_version"
  | "invalid_revision"
  | "invalid_parent_revision"
  | "invalid_original_prompt"
  | "invalid_workspace"
  | "invalid_summary"
  | "empty_requirements"
  | "duplicate_requirement_id"
  | "duplicate_criterion_id"
  | "invalid_requirement"
  | "invalid_criterion"
  | "invalid_artifact"
  | "invalid_requirement_status"
  | "invalid_non_goals"
  | "invalid_blocking_inputs"
  | "blocking_requirement_missing_criteria"
  | "blocking_requirement_has_open_question"
  | "no_active_requirements"
  | "missing_draft_hash"
  | "invalid_draft_hash"
  | "draft_hash_mismatch";

export type GoalRequirementDraftIssue = {
  code: GoalRequirementDraftIssueCode;
  path: string;
  message: string;
};

export type GoalRequirementDraftRevisionOperation =
  | {
      kind: "update";
      requirementId: string;
      patch: GoalRequirementDraftRevisionPatchV1;
    }
  | {
      kind: "create";
      requirement: GoalRequirementDraftItemInputV1;
    }
  | {
      kind: "supersede";
      requirementId: string;
    }
  | {
      kind: "restore";
      requirementId: string;
    }
  | {
      kind: "split";
      requirementId: string;
      requirements: GoalRequirementDraftItemInputV1[];
    }
  | {
      kind: "merge";
      requirementIds: string[];
      requirement: GoalRequirementDraftItemInputV1;
    };

export type GoalRequirementDraftRevisionPatchV1 = Partial<Omit<GoalRequirementDraftItemInputV1, "id" | "status">>;

type DraftWithoutHash = Omit<GoalRequirementDraftV1, "draftHash">;

export function goalRequirementDraftHash(draft: DraftWithoutHash): string {
  return contentHashForPayload(draft);
}

export function finalizeGoalRequirementDraft(input: GoalRequirementDraftInputV1): GoalRequirementDraftV1 {
  validateDraftInput(input);
  const requirements = input.requirements.map((requirement) => materializeRequirement(requirement));
  assertUniqueIds(requirements);
  const draft: DraftWithoutHash = {
    schemaVersion: "southstar.goal_requirement_draft.v1",
    revision: 1,
    originalPrompt: input.goalPrompt,
    workspace: {
      cwd: input.cwd,
      ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
    },
    summary: input.summary,
    requirements,
    nonGoals: [...input.nonGoals],
    blockingInputs: [...input.blockingInputs],
  };
  return { ...draft, draftHash: goalRequirementDraftHash(draft) };
}

export function validateGoalRequirementDraft(draft: GoalRequirementDraftV1): GoalRequirementDraftIssue[] {
  const issues: GoalRequirementDraftIssue[] = [];
  if (!isRecord(draft)) {
    return [issue("invalid_draft", "draft", "Goal Requirement Draft must be an object")];
  }
  if (draft.schemaVersion !== "southstar.goal_requirement_draft.v1") {
    issues.push(issue("invalid_schema_version", "schemaVersion", "unsupported Goal Requirement Draft schema version"));
  }
  if (!Number.isInteger(draft.revision) || draft.revision < 1) {
    issues.push(issue("invalid_revision", "revision", "revision must be a positive integer"));
  }
  if (draft.parentRevision !== undefined && (!Number.isInteger(draft.parentRevision) || draft.parentRevision < 1 || draft.parentRevision >= draft.revision)) {
    issues.push(issue("invalid_parent_revision", "parentRevision", "parentRevision must be an earlier positive revision"));
  }
  if (!nonEmptyString(draft.originalPrompt)) issues.push(issue("invalid_original_prompt", "originalPrompt", "originalPrompt must be non-empty"));
  if (!isRecord(draft.workspace) || !nonEmptyString(draft.workspace.cwd)) {
    issues.push(issue("invalid_workspace", "workspace.cwd", "workspace.cwd must be non-empty"));
  } else if ("projectRef" in draft.workspace && !nonEmptyString(draft.workspace.projectRef)) {
    issues.push(issue("invalid_workspace", "workspace.projectRef", "workspace.projectRef must be a non-empty string when present"));
  }
  if (!nonEmptyString(draft.summary)) issues.push(issue("invalid_summary", "summary", "summary must be non-empty"));
  if (!stringArrayValid(draft.nonGoals)) issues.push(issue("invalid_non_goals", "nonGoals", "nonGoals must be an array of non-empty strings"));
  if (!stringArrayValid(draft.blockingInputs)) issues.push(issue("invalid_blocking_inputs", "blockingInputs", "blockingInputs must be an array of non-empty strings"));
  const requirements = Array.isArray(draft.requirements) ? draft.requirements : [];
  if (requirements.length === 0) {
    issues.push(issue("empty_requirements", "requirements", "requirements must contain at least one requirement"));
  }

  const requirementIds = new Set<string>();
  const criterionIds = new Set<string>();
  for (const [requirementIndex, rawRequirement] of requirements.entries()) {
    const path = `requirements.${requirementIndex}`;
    if (!isRecord(rawRequirement)) {
      issues.push(issue("invalid_requirement", path, "requirement must be an object"));
      continue;
    }
    const requirement = rawRequirement as unknown as GoalRequirementDraftItemV1;
    if (!nonEmptyString(requirement.id)) issues.push(issue("invalid_requirement", `${path}.id`, "requirement id must be non-empty"));
    if (requirement.id && requirementIds.has(requirement.id)) issues.push(issue("duplicate_requirement_id", `${path}.id`, `duplicate requirement id: ${requirement.id}`));
    if (requirement.id) requirementIds.add(requirement.id);
    if (!validateRequirementShape(requirement)) {
      issues.push(issue("invalid_requirement", path, "requirement is missing a valid field or field type"));
      collectNestedRequirementIssues(requirement, path, issues);
      continue;
    }
    if (!VALID_STATUSES.has(requirement.status)) {
      issues.push(issue("invalid_requirement_status", `${path}.status`, `unsupported status: ${String(requirement.status)}`));
    }
    if (requirement.blocking && requirement.acceptanceCriteria.length === 0) {
      issues.push(issue("blocking_requirement_missing_criteria", `${path}.acceptanceCriteria`, "blocking requirements need at least one acceptance criterion"));
    }
    if (requirement.blocking && requirement.openQuestions.length > 0) {
      issues.push(issue("blocking_requirement_has_open_question", `${path}.openQuestions`, "blocking requirements cannot retain unresolved questions"));
    }
    for (const [criterionIndex, criterion] of requirement.acceptanceCriteria.entries()) {
      const criterionPath = `${path}.acceptanceCriteria.${criterionIndex}`;
      if (!nonEmptyString(criterion.id) || !nonEmptyString(criterion.statement) || !stringArrayValid(criterion.evidenceIntent)) {
        issues.push(issue("invalid_criterion", criterionPath, "criterion needs id, statement, and evidenceIntent"));
      }
      if (criterion.id && criterionIds.has(criterion.id)) issues.push(issue("duplicate_criterion_id", `${criterionPath}.id`, `duplicate criterion id: ${criterion.id}`));
      if (criterion.id) criterionIds.add(criterion.id);
    }
  }
  if (requirements.length > 0 && requirements.every((requirement) => isRecord(requirement) && requirement.status === "superseded")) {
    issues.push(issue("no_active_requirements", "requirements", "at least one requirement must remain active"));
  }
  if (draft.draftHash === undefined || draft.draftHash === null || (typeof draft.draftHash === "string" && draft.draftHash.trim().length === 0)) {
    issues.push(issue("missing_draft_hash", "draftHash", "draftHash must be a non-empty canonical hash"));
  } else if (typeof draft.draftHash !== "string" || !/^[a-f0-9]{64}$/.test(draft.draftHash)) {
    issues.push(issue("invalid_draft_hash", "draftHash", "draftHash must be a lowercase SHA-256 hex hash"));
  } else {
    const { draftHash: _draftHash, ...withoutHash } = draft;
    if (goalRequirementDraftHash(withoutHash) !== draft.draftHash) {
      issues.push(issue("draft_hash_mismatch", "draftHash", "draftHash does not match the canonical draft payload"));
    }
  }
  return issues;
}

export function reviseGoalRequirementDraft(
  draft: GoalRequirementDraftV1,
  operation: GoalRequirementDraftRevisionOperation,
): GoalRequirementDraftV1 {
  const currentIssues = validateGoalRequirementDraft(draft).filter((entry) => !REVISION_REVIEWABLE_ISSUES.has(entry.code));
  if (currentIssues.length > 0) throw new Error(`goal_requirement_draft_invalid: ${JSON.stringify(currentIssues)}`);
  const requirements = draft.requirements.map((requirement) => cloneRequirement(requirement));
  switch (operation.kind) {
    case "update": {
      const index = findRequirementIndex(requirements, operation.requirementId);
      const existing = requirements[index]!;
      const patch = operation.patch;
      if ("id" in patch || "status" in patch) {
        throw new Error("goal requirement revision patch cannot modify host-owned id or status; use supersede or restore");
      }
      const merged: GoalRequirementDraftItemInputV1 = {
        ...toRequirementInput(existing),
        ...patch,
        acceptanceCriteria: patch.acceptanceCriteria ?? toRequirementInput(existing).acceptanceCriteria,
      };
      requirements[index] = materializeRequirement(merged, existing.id, existing.status === "superseded" ? "superseded" : undefined, existing);
      break;
    }
    case "create":
      requirements.push(materializeRequirement(operation.requirement));
      break;
    case "supersede": {
      const index = findRequirementIndex(requirements, operation.requirementId);
      requirements[index] = { ...requirements[index]!, status: "superseded" };
      break;
    }
    case "restore": {
      const index = findRequirementIndex(requirements, operation.requirementId);
      const existing = requirements[index]!;
      if (existing.status !== "superseded") throw new Error(`requirement is not superseded: ${operation.requirementId}`);
      requirements[index] = { ...existing, status: statusFor(existing.openQuestions) };
      break;
    }
    case "split": {
      const index = findRequirementIndex(requirements, operation.requirementId);
      const existing = requirements[index]!;
      if (operation.requirements.length < 2) throw new Error("split requires at least two requirements");
      requirements[index] = { ...existing, status: "superseded" };
      requirements.push(...operation.requirements.map((requirement) => materializeRequirement(requirement)));
      break;
    }
    case "merge": {
      if (operation.requirementIds.length < 2) throw new Error("merge requires at least two requirements");
      const indexes = operation.requirementIds.map((id) => findRequirementIndex(requirements, id));
      const uniqueIndexes = new Set(indexes);
      if (uniqueIndexes.size !== indexes.length) throw new Error("merge requirement ids must be unique");
      for (const index of indexes) requirements[index] = { ...requirements[index]!, status: "superseded" };
      requirements.push(materializeRequirement(operation.requirement));
      break;
    }
    default:
      assertNever(operation);
  }
  assertUniqueIds(requirements);
  return finalizeRevision(draft, requirements);
}

export function confirmGoalRequirementDraft(
  draft: GoalRequirementDraftV1,
  interpretation: {
    domain: string;
    intent: string;
    workType: RequirementSpecV2["workType"];
    expectedArtifactRefs: string[];
    requiredCapabilities: string[];
    assumptions: string[];
    requestedSideEffects: string[];
  },
): GoalContractV1 {
  const issues = validateGoalRequirementDraft(draft);
  if (issues.length > 0) throw new Error("goal_requirement_draft_invalid: " + JSON.stringify(issues));
  const active = draft.requirements.filter((requirement) => requirement.status !== "superseded");
  if (active.length === 0) throw new Error("goal_requirement_draft_invalid: no active requirements");
  return finalizeGoalContract({
    goalPrompt: draft.originalPrompt,
    cwd: draft.workspace.cwd,
    ...(draft.workspace.projectRef !== undefined ? { projectRef: draft.workspace.projectRef } : {}),
    interpretation: {
      ...interpretation,
      summary: draft.summary,
      requirements: active.map((requirement) => ({
        id: requirement.id,
        statement: requirement.statement,
        acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => criterion.statement),
        blocking: requirement.blocking,
        source: requirement.source,
        expectedArtifacts: requirement.expectedOutcomeArtifacts,
      })),
      nonGoals: draft.nonGoals,
      blockingInputs: draft.blockingInputs,
      riskTags: [...new Set(active.flatMap((requirement) => requirement.riskTags))],
    },
  });
}

const VALID_STATUSES = new Set<GoalRequirementDraftItemV1["status"]>([
  "needs_clarification",
  "ready",
  "confirmed",
  "superseded",
]);

const REVISION_REVIEWABLE_ISSUES = new Set<GoalRequirementDraftIssueCode>([
  "blocking_requirement_missing_criteria",
  "blocking_requirement_has_open_question",
  "no_active_requirements",
]);

function materializeRequirement(
  input: GoalRequirementDraftItemInputV1,
  preservedId?: string,
  preservedStatus?: GoalRequirementDraftItemV1["status"],
  previous?: GoalRequirementDraftItemV1,
): GoalRequirementDraftItemV1 {
  const semanticCriteria = input.acceptanceCriteria.map((criterion) => ({
    statement: criterion.statement,
    evidenceIntent: [...criterion.evidenceIntent],
  }));
  const semantic = {
    title: input.title,
    statement: input.statement,
    source: input.source,
    blocking: input.blocking,
    userVisibleBehaviors: [...input.userVisibleBehaviors],
    businessRules: [...input.businessRules],
    acceptanceCriteria: semanticCriteria,
    expectedOutcomeArtifacts: input.expectedOutcomeArtifacts.map((artifact) => ({ ...artifact })),
    verificationIntent: [...input.verificationIntent],
    assumptions: [...input.assumptions],
    openQuestions: [...input.openQuestions],
    riskTags: [...input.riskTags],
    interactionContractRefs: [...input.interactionContractRefs],
  };
  const id = preservedId ?? `req-${contentHashForPayload(semantic).slice(0, 12)}`;
  const criteria = input.acceptanceCriteria.map((criterion, index) => {
    const previousCriterion = previous?.acceptanceCriteria.find((item) => normalize(item.statement) === normalize(criterion.statement));
    const semanticCriterion = semanticCriteria[index]!;
    return {
      id: previousCriterion?.id ?? `criterion-${contentHashForPayload({ requirementId: id, ...semanticCriterion }).slice(0, 12)}`,
      ...semanticCriterion,
    };
  });
  return {
    ...semantic,
    id,
    acceptanceCriteria: criteria,
    status: preservedStatus ?? statusFor(input.openQuestions),
  };
}

function finalizeRevision(draft: GoalRequirementDraftV1, requirements: GoalRequirementDraftItemV1[]): GoalRequirementDraftV1 {
  const withoutHash: DraftWithoutHash = {
    schemaVersion: "southstar.goal_requirement_draft.v1",
    revision: draft.revision + 1,
    parentRevision: draft.revision,
    originalPrompt: draft.originalPrompt,
    workspace: { ...draft.workspace },
    summary: draft.summary,
    requirements,
    nonGoals: [...draft.nonGoals],
    blockingInputs: [...draft.blockingInputs],
  };
  return { ...withoutHash, draftHash: goalRequirementDraftHash(withoutHash) };
}

function validateDraftInput(input: GoalRequirementDraftInputV1): void {
  if (!nonEmptyString(input.goalPrompt)) throw new Error("goalPrompt must be a non-empty string");
  if (!nonEmptyString(input.cwd)) throw new Error("cwd must be a non-empty string");
  if (input.projectRef !== undefined && !nonEmptyString(input.projectRef)) throw new Error("projectRef must be a non-empty string when present");
  if (!nonEmptyString(input.summary)) throw new Error("summary must be a non-empty string");
  if (!Array.isArray(input.requirements) || input.requirements.length === 0) throw new Error("requirements must contain at least one requirement");
  if (!stringArrayValid(input.nonGoals) || !stringArrayValid(input.blockingInputs)) throw new Error("nonGoals and blockingInputs must be arrays of non-empty strings");
  for (const [index, requirement] of input.requirements.entries()) {
    if (!validateRequirementInputShape(requirement)) throw new Error(`requirements.${index} is invalid`);
  }
}

function validateRequirementInputShape(requirement: unknown): boolean {
  if (!isRecord(requirement)) return false;
  return Boolean(
    nonEmptyString(requirement.title)
    && nonEmptyString(requirement.statement)
    && (requirement.source === "explicit" || requirement.source === "inferred")
    && typeof requirement.blocking === "boolean"
    && stringArrayValid(requirement.userVisibleBehaviors)
    && stringArrayValid(requirement.businessRules)
    && Array.isArray(requirement.acceptanceCriteria)
    && requirement.acceptanceCriteria.every(criterionInputShape)
    && Array.isArray(requirement.expectedOutcomeArtifacts)
    && requirement.expectedOutcomeArtifacts.every(artifactInputShape)
    && stringArrayValid(requirement.verificationIntent)
    && stringArrayValid(requirement.assumptions)
    && stringArrayValid(requirement.openQuestions)
    && stringArrayValid(requirement.riskTags)
    && stringArrayValid(requirement.interactionContractRefs)
  );
}

function validateRequirementShape(requirement: unknown): boolean {
  if (!isRecord(requirement)) return false;
  return Boolean(
    validateRequirementInputShape(requirement)
    && nonEmptyString(requirement.id)
    && Array.isArray(requirement.acceptanceCriteria)
    && requirement.acceptanceCriteria.every(criterionDraftShape)
  );
}

function criterionInputShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return nonEmptyString(value.statement) && stringArrayValid(value.evidenceIntent);
}

function criterionDraftShape(value: unknown): boolean {
  return isRecord(value) && nonEmptyString(value.id) && criterionInputShape(value);
}

function artifactInputShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return nonEmptyString(value.description)
    && (value.mediaType === undefined || nonEmptyString(value.mediaType));
}

function collectNestedRequirementIssues(
  requirement: unknown,
  path: string,
  issues: GoalRequirementDraftIssue[],
): void {
  if (!isRecord(requirement)) return;
  if (!Array.isArray(requirement.acceptanceCriteria)) {
    issues.push(issue("invalid_criterion", `${path}.acceptanceCriteria`, "acceptanceCriteria must be an array"));
  } else {
    for (const [criterionIndex, criterion] of requirement.acceptanceCriteria.entries()) {
      if (!criterionDraftShape(criterion)) {
        issues.push(issue("invalid_criterion", `${path}.acceptanceCriteria.${criterionIndex}`, "criterion needs id, statement, and evidenceIntent"));
      }
    }
  }
  if (!Array.isArray(requirement.expectedOutcomeArtifacts)) {
    issues.push(issue("invalid_artifact", `${path}.expectedOutcomeArtifacts`, "expectedOutcomeArtifacts must be an array"));
  } else {
    for (const [artifactIndex, artifact] of requirement.expectedOutcomeArtifacts.entries()) {
      if (!artifactInputShape(artifact)) {
        issues.push(issue("invalid_artifact", `${path}.expectedOutcomeArtifacts.${artifactIndex}`, "artifact needs description and an optional non-empty mediaType"));
      }
    }
  }
}

function assertUniqueIds(requirements: GoalRequirementDraftItemV1[]): void {
  const requirementIds = new Set<string>();
  const criterionIds = new Set<string>();
  for (const requirement of requirements) {
    if (requirementIds.has(requirement.id)) throw new Error(`duplicate requirement id: ${requirement.id}`);
    requirementIds.add(requirement.id);
    for (const criterion of requirement.acceptanceCriteria) {
      if (criterionIds.has(criterion.id)) throw new Error(`duplicate criterion id: ${criterion.id}`);
      criterionIds.add(criterion.id);
    }
  }
}

function findRequirementIndex(requirements: GoalRequirementDraftItemV1[], id: string): number {
  const index = requirements.findIndex((requirement) => requirement.id === id);
  if (index < 0) throw new Error(`unknown requirement id: ${id}`);
  return index;
}

function toRequirementInput(requirement: GoalRequirementDraftItemV1): GoalRequirementDraftItemInputV1 {
  return {
    id: requirement.id,
    title: requirement.title,
    statement: requirement.statement,
    source: requirement.source,
    blocking: requirement.blocking,
    userVisibleBehaviors: [...requirement.userVisibleBehaviors],
    businessRules: [...requirement.businessRules],
    acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      statement: criterion.statement,
      evidenceIntent: [...criterion.evidenceIntent],
    })),
    expectedOutcomeArtifacts: requirement.expectedOutcomeArtifacts.map((artifact) => ({ ...artifact })),
    verificationIntent: [...requirement.verificationIntent],
    assumptions: [...requirement.assumptions],
    openQuestions: [...requirement.openQuestions],
    riskTags: [...requirement.riskTags],
    interactionContractRefs: [...requirement.interactionContractRefs],
    status: requirement.status,
  };
}

function cloneRequirement(requirement: GoalRequirementDraftItemV1): GoalRequirementDraftItemV1 {
  return materializeRequirement(toRequirementInput(requirement), requirement.id, requirement.status);
}

function statusFor(openQuestions: string[]): GoalRequirementDraftItemV1["status"] {
  return openQuestions.length > 0 ? "needs_clarification" : "ready";
}

function stringArrayValid(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function issue(code: GoalRequirementDraftIssueCode, path: string, message: string): GoalRequirementDraftIssue {
  return { code, path, message };
}

function assertNever(value: never): never {
  throw new Error(`unsupported requirement draft operation: ${JSON.stringify(value)}`);
}
