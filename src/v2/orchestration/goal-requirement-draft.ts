import { contentHashForPayload } from "../design-library/canonical-json.ts";
import {
  finalizeGoalContract,
  type GoalContractV1,
} from "./goal-contract.ts";
import type { RequirementSpecV2 } from "../design-library/types.ts";
import type { ResolvedGoalDesignSkillV1 } from "./goal-design.ts";
import type { LlmTextClient } from "./llm-composer.ts";
import type { WorkspaceGoalDiscoveryV1 } from "./goal-workspace-discovery.ts";

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
    }
  | {
      kind: "replace";
      draft: GoalRequirementDraftV1;
    };

export type GoalRequirementDraftRevisionPatchV1 = Partial<Omit<GoalRequirementDraftItemInputV1, "id" | "status">>;

export type GoalRequirementDraftInterpreter = {
  interpret(input: {
    goalPrompt: string;
    cwd: string;
    projectRef?: string;
    workspaceDiscovery: WorkspaceGoalDiscoveryV1;
    goalDesignSkill: ResolvedGoalDesignSkillV1;
    onDelta?: (text: string) => void;
  }): Promise<GoalRequirementDraftV1>;
  revise(input: {
    currentDraft: GoalRequirementDraftV1;
    message: string;
    selectedRequirementId?: string;
    selectedRequirementIds?: string[];
    onDelta?: (text: string) => void;
  }): Promise<
    | { kind: "revision"; draft: GoalRequirementDraftV1; summary: string }
    | { kind: "needs_input"; question: string }
  >;
};

export type LlmGoalRequirementDraftOptions = {
  model: string;
  client: LlmTextClient;
  maxOutputChars?: number;
};

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

/**
 * Create the production Goal Requirement interpreter. The model only supplies
 * semantic requirement content; all lineage, status, hashes and revisions are
 * materialized by the host finalizers below.
 */
export function createLlmGoalRequirementDraftInterpreter(
  options: LlmGoalRequirementDraftOptions,
): GoalRequirementDraftInterpreter {
  return {
    async interpret(input) {
      return interpretGoalRequirementDraftWithLlm({ ...input, ...options });
    },
    async revise(input) {
      return reviseGoalRequirementDraftWithLlm({ ...input, ...options });
    },
  };
}

export async function interpretGoalRequirementDraftWithLlm(input: {
  goalPrompt: string;
  cwd: string;
  projectRef?: string;
  workspaceDiscovery: WorkspaceGoalDiscoveryV1;
  goalDesignSkill: ResolvedGoalDesignSkillV1;
  onDelta?: (text: string) => void;
} & LlmGoalRequirementDraftOptions): Promise<GoalRequirementDraftV1> {
  const basePrompt = renderRequirementInterpretationPrompt(input);
  let prompt = basePrompt;
  const maxOutputChars = input.maxOutputChars ?? MAX_REQUIREMENT_RESPONSE_CHARS;
  for (let attempt = 1; attempt <= MAX_REQUIREMENT_ATTEMPTS; attempt += 1) {
    const deltas: string[] = [];
    const response = input.client.generateTextStream
      ? await input.client.generateTextStream(
        { model: input.model, prompt, temperature: 0, cwd: input.cwd },
        { onDelta: (delta) => deltas.push(delta) },
      )
      : await input.client.generateText({ model: input.model, prompt, temperature: 0, cwd: input.cwd });
    try {
      if (response.length > maxOutputChars) throw new Error(`response exceeds ${maxOutputChars} characters`);
      const semantic = parseRequirementDraftSemantic(response);
      const draft = finalizeGoalRequirementDraft({
        goalPrompt: input.goalPrompt,
        cwd: input.cwd,
        ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
        ...semantic,
      });
      for (const delta of deltas) input.onDelta?.(delta);
      return draft;
    } catch (error) {
      if (attempt === MAX_REQUIREMENT_ATTEMPTS) {
        throw new Error(`invalid Goal Requirement draft: ${error instanceof Error ? error.message : String(error)}`);
      }
      prompt = renderRequirementRepairPrompt(basePrompt, response, error);
    }
  }
  throw new Error("Goal Requirement interpreter exhausted attempts");
}

async function reviseGoalRequirementDraftWithLlm(input: {
  currentDraft: GoalRequirementDraftV1;
  message: string;
  selectedRequirementId?: string;
  selectedRequirementIds?: string[];
  onDelta?: (text: string) => void;
} & LlmGoalRequirementDraftOptions): Promise<
  | { kind: "revision"; draft: GoalRequirementDraftV1; summary: string }
  | { kind: "needs_input"; question: string }
> {
  const normalizedSelection = normalizeHostSelection(input.selectedRequirementId, input.selectedRequirementIds);
  if (normalizedSelection.kind === "needs_input") return normalizedSelection;
  const revisionInput = {
    ...input,
    selectedRequirementId: normalizedSelection.selectedRequirementId,
    selectedRequirementIds: normalizedSelection.selectedRequirementIds,
  };
  const selectionIssue = validateHostSelection(
    input.currentDraft,
    revisionInput.selectedRequirementId,
    revisionInput.selectedRequirementIds,
  );
  if (selectionIssue) return { kind: "needs_input", question: selectionIssue };
  const basePrompt = renderRequirementRevisionPrompt(revisionInput);
  let prompt = basePrompt;
  const maxOutputChars = input.maxOutputChars ?? MAX_REQUIREMENT_RESPONSE_CHARS;
  for (let attempt = 1; attempt <= MAX_REQUIREMENT_ATTEMPTS; attempt += 1) {
    const deltas: string[] = [];
    const response = input.client.generateTextStream
      ? await input.client.generateTextStream(
        {
          model: input.model,
          prompt,
          temperature: 0,
          cwd: input.currentDraft.workspace.cwd,
        },
        { onDelta: (delta) => deltas.push(delta) },
      )
      : await input.client.generateText({
        model: input.model,
        prompt,
        temperature: 0,
        cwd: input.currentDraft.workspace.cwd,
      });
    try {
      if (response.length > maxOutputChars) throw new Error(`response exceeds ${maxOutputChars} characters`);
      const payload = parseRequirementRevisionPayload(response);
      if (payload.kind === "needs_input") return payload;
      const payloadSelectionIssue = revisionSelectionQuestion(
        payload,
        revisionInput.selectedRequirementId,
        revisionInput.selectedRequirementIds,
      );
      if (payloadSelectionIssue) return { kind: "needs_input", question: payloadSelectionIssue };
      const result = "draft" in payload
        ? applySemanticRequirementRevision(
          input.currentDraft,
          payload.draft,
          revisionInput.selectedRequirementId,
          revisionInput.selectedRequirementIds,
        )
        : applySemanticRequirementOperation(
          input.currentDraft,
          payload.operation,
          revisionInput.selectedRequirementId,
          revisionInput.selectedRequirementIds,
        );
      for (const delta of deltas) input.onDelta?.(delta);
      const draft = result;
      return { kind: "revision", draft, summary: payload.summary };
    } catch (error) {
      if (attempt === MAX_REQUIREMENT_ATTEMPTS) {
        throw new Error(`invalid Goal Requirement revision: ${error instanceof Error ? error.message : String(error)}`);
      }
      prompt = renderRequirementRepairPrompt(basePrompt, response, error);
    }
  }
  throw new Error("Goal Requirement revision exhausted attempts");
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

export function goalRequirementDraftReadiness(draft: GoalRequirementDraftV1): {
  confirmable: boolean;
  issues: GoalRequirementDraftIssue[];
} {
  const issues = validateGoalRequirementDraft(draft);
  return { confirmable: issues.length === 0, issues };
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
    case "replace": {
      if (operation.draft.originalPrompt !== draft.originalPrompt
        || operation.draft.workspace.cwd !== draft.workspace.cwd
        || operation.draft.workspace.projectRef !== draft.workspace.projectRef) {
        throw new Error("goal requirement revision cannot modify host-owned prompt or workspace");
      }
      // The interpreter owns semantic changes to the draft summary and the
      // clarification/non-goal lists as well as the requirement rows. Keep
      // those values while the host still owns revision lineage and hashing.
      return finalizeRevision({
        ...draft,
        summary: operation.draft.summary,
        nonGoals: [...operation.draft.nonGoals],
        blockingInputs: [...operation.draft.blockingInputs],
      }, operation.draft.requirements.map(cloneRequirement));
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

const MAX_REQUIREMENT_ATTEMPTS = 2;
const MAX_REQUIREMENT_RESPONSE_CHARS = 40_000;
const REQUIREMENT_SEMANTIC_KEYS = [
  "title",
  "statement",
  "source",
  "blocking",
  "userVisibleBehaviors",
  "businessRules",
  "acceptanceCriteria",
  "expectedOutcomeArtifacts",
  "verificationIntent",
  "assumptions",
  "openQuestions",
  "riskTags",
  "interactionContractRefs",
] as const;
const REQUIREMENT_CRITERION_KEYS = ["statement", "evidenceIntent"] as const;
const REQUIREMENT_ARTIFACT_KEYS = ["description", "mediaType"] as const;
const REQUIREMENT_TOP_LEVEL_KEYS = ["summary", "requirements", "nonGoals", "blockingInputs"] as const;

type GoalRequirementDraftSemanticV1 = Omit<GoalRequirementDraftInputV1, "goalPrompt" | "cwd" | "projectRef">;
type GoalRequirementDraftSemanticPatchV1 = Partial<Omit<GoalRequirementDraftItemInputV1, "id" | "status">>;
type GoalRequirementDraftRevisionOperationSemanticV1 =
  | { kind: "update"; patch: GoalRequirementDraftSemanticPatchV1 }
  | { kind: "create"; requirement: GoalRequirementDraftItemInputV1 }
  | { kind: "supersede" }
  | { kind: "restore" }
  | { kind: "split"; requirements: GoalRequirementDraftItemInputV1[] }
  | { kind: "merge"; requirement: GoalRequirementDraftItemInputV1 };
type GoalRequirementDraftRevisionPayloadV1 =
  | { kind: "revision"; summary: string; draft: GoalRequirementDraftSemanticV1 }
  | { kind: "revision"; summary: string; operation: GoalRequirementDraftRevisionOperationSemanticV1 }
  | { kind: "needs_input"; question: string };

function renderRequirementInterpretationPrompt(input: {
  goalPrompt: string;
  cwd: string;
  projectRef?: string;
  workspaceDiscovery: WorkspaceGoalDiscoveryV1;
  goalDesignSkill: ResolvedGoalDesignSkillV1;
}): string {
  return [
    "Use the approved Goal Design skill to interpret the user's goal into a reviewed Requirement Draft.",
    `GoalDesignSkillRef: ${input.goalDesignSkill.objectKey}`,
    `GoalDesignSkillVersionRef: ${input.goalDesignSkill.versionRef}`,
    input.goalDesignSkill.body,
    "",
    "GoalRequirementDraftOutputSchema:",
    JSON.stringify({
      summary: "string",
      requirements: [{
        title: "string",
        statement: "string",
        source: "explicit | inferred",
        blocking: "boolean",
        userVisibleBehaviors: ["string"],
        businessRules: ["string"],
        acceptanceCriteria: [{ statement: "string", evidenceIntent: ["string"] }],
        expectedOutcomeArtifacts: [{ description: "string", mediaType: "string?" }],
        verificationIntent: ["string"],
        assumptions: ["string"],
        openQuestions: ["string"],
        riskTags: ["string"],
        interactionContractRefs: ["string"],
      }],
      nonGoals: ["string"],
      blockingInputs: ["string"],
    }),
    "Return JSON only with exactly these top-level keys: summary, requirements, nonGoals, blockingInputs.",
    "Return exactly the requirement fields shown above. Every array item must be a non-empty string unless it is an object shown in the schema.",
    "Use [] for empty arrays. Do not use null, false, objects, or empty strings as array entries.",
    "Requirements must describe independently verifiable observable outcomes, including user-visible behaviors, rules, acceptance criteria, expected artifacts, and verification intent.",
    "Do not return Library object references, workflow plans, graph nodes, agent assignments, tool grants, or execution sequencing.",
    "Do not return host-owned fields: schemaVersion, originalPrompt, workspace, projectRef, id, revision, parentRevision, status, draftHash, or any hash.",
    "blockingInputs are only unavailable decisions that require the user; do not use them for local workspace facts discoverable below.",
    `GoalPrompt: ${input.goalPrompt}`,
    `WorkspaceCwd: ${input.cwd}`,
    ...(input.projectRef !== undefined ? [`ProjectRef: ${input.projectRef}`] : []),
    "WorkspaceDiscovery:",
    JSON.stringify(input.workspaceDiscovery),
  ].join("\n");
}

function renderRequirementRevisionPrompt(input: {
  currentDraft: GoalRequirementDraftV1;
  message: string;
  selectedRequirementId?: string;
  selectedRequirementIds?: string[];
}): string {
  return [
    "Use the approved Goal Design skill already used for this Requirement Draft to revise semantic requirements.",
    "Return JSON only.",
    "RevisionResponseSchema:",
    JSON.stringify({
      kind: "revision | needs_input",
      summary: "string (revision only)",
      draft: {
        summary: "string",
        requirements: [{ "...semantic requirement fields": "same as RequirementDraftOutputSchema" }],
        nonGoals: ["string"],
        blockingInputs: ["string"],
      },
      operation: {
        kind: "update | create | supersede | restore | split | merge",
        patch: "semantic fields only (update)",
        requirement: "semantic requirement (create/merge)",
        requirements: ["semantic requirements (split)"],
      },
      question: "string (needs_input only)",
    }),
    "For kind=revision, return exactly kind, summary, and either draft or operation. Draft contains exactly summary, requirements, nonGoals, blockingInputs. Operation contains semantic fields only; the host chooses target ids from the host selections below.",
    "For kind=needs_input, return exactly kind and question.",
    "Do not return requirement ids, status, revision, parentRevision, draftHash, hashes, library references, orchestration fields, or execution fields.",
    `SelectedRequirementId (host context only): ${input.selectedRequirementId ?? ""}`,
    `SelectedRequirementIds (host context only): ${JSON.stringify(input.selectedRequirementIds ?? [])}`,
    `UserMessage: ${input.message}`,
    `CurrentRequirementDraft: ${JSON.stringify(input.currentDraft)}`,
  ].join("\n");
}

function renderRequirementRepairPrompt(basePrompt: string, response: string, error: unknown): string {
  return [
    basePrompt,
    "",
    `The previous response was invalid: ${error instanceof Error ? error.message : String(error)}`,
    "Return one corrected JSON object only. Preserve valid semantic meaning and remove every host-owned or workflow field.",
    `PreviousResponse: ${response.slice(0, MAX_REQUIREMENT_RESPONSE_CHARS)}`,
  ].join("\n");
}

function parseRequirementDraftSemantic(text: string): GoalRequirementDraftSemanticV1 {
  const parsed = parseJsonObject(text, "Goal Requirement draft");
  exactSemanticKeys(parsed, REQUIREMENT_TOP_LEVEL_KEYS, "$");
  const requirements = requiredArray(parsed.requirements, "requirements");
  if (requirements.length === 0) throw new Error("requirements must contain at least one requirement");
  const semantic = {
    summary: requiredString(parsed.summary, "summary"),
    requirements: requirements.map((value, index) => parseSemanticRequirement(value, index)),
    nonGoals: requiredStringArray(parsed.nonGoals, "nonGoals"),
    blockingInputs: requiredStringArray(parsed.blockingInputs, "blockingInputs"),
  };
  return semantic;
}

function parseRequirementRevisionPayload(text: string): GoalRequirementDraftRevisionPayloadV1 {
  const parsed = parseJsonObject(text, "Goal Requirement revision");
  const kind = requiredString(parsed.kind, "kind");
  if (kind === "needs_input") {
    exactSemanticKeys(parsed, ["kind", "question"], "$");
    return { kind, question: requiredString(parsed.question, "question") };
  }
  if (kind !== "revision") throw new Error("kind must be revision or needs_input");
  const summary = requiredString(parsed.summary, "summary");
  if ("draft" in parsed && "operation" in parsed) throw new Error("revision must contain either draft or operation, not both");
  if ("draft" in parsed) {
    exactSemanticKeys(parsed, ["kind", "summary", "draft"], "$");
    const draft = parseJsonObject(parsed.draft, "draft");
    exactSemanticKeys(draft, REQUIREMENT_TOP_LEVEL_KEYS, "draft");
    const requirements = requiredArray(draft.requirements, "draft.requirements");
    if (requirements.length === 0) throw new Error("draft.requirements must contain at least one requirement");
    return {
      kind,
      summary,
      draft: {
        summary: requiredString(draft.summary, "draft.summary"),
        requirements: requirements.map((value, index) => parseSemanticRequirement(value, index, "draft.requirements")),
        nonGoals: requiredStringArray(draft.nonGoals, "draft.nonGoals"),
        blockingInputs: requiredStringArray(draft.blockingInputs, "draft.blockingInputs"),
      },
    };
  }
  exactSemanticKeys(parsed, ["kind", "summary", "operation"], "$");
  return { kind, summary, operation: parseSemanticOperation(parsed.operation) };
}

function parseSemanticOperation(value: unknown): GoalRequirementDraftRevisionOperationSemanticV1 {
  const object = parseJsonObject(value, "operation");
  const kind = requiredString(object.kind, "operation.kind");
  switch (kind) {
    case "update":
      exactSemanticKeys(object, ["kind", "patch"], "operation");
      return { kind, patch: parseSemanticPatch(object.patch, "operation.patch") };
    case "create":
      exactSemanticKeys(object, ["kind", "requirement"], "operation");
      return { kind, requirement: parseSemanticRequirement(object.requirement, 0, "operation.requirement") };
    case "supersede":
    case "restore":
      exactSemanticKeys(object, ["kind"], "operation");
      return { kind };
    case "split": {
      exactSemanticKeys(object, ["kind", "requirements"], "operation");
      const requirements = requiredArray(object.requirements, "operation.requirements");
      if (requirements.length < 2) throw new Error("operation.requirements must contain at least two requirements");
      return { kind, requirements: requirements.map((entry, index) => parseSemanticRequirement(entry, index, "operation.requirements")) };
    }
    case "merge":
      exactSemanticKeys(object, ["kind", "requirement"], "operation");
      return { kind, requirement: parseSemanticRequirement(object.requirement, 0, "operation.requirement") };
    default:
      throw new Error("operation.kind must be update, create, supersede, restore, split, or merge");
  }
}

function parseSemanticPatch(value: unknown, path: string): GoalRequirementDraftSemanticPatchV1 {
  const object = parseJsonObject(value, path);
  exactOptionalKeys(object, REQUIREMENT_SEMANTIC_KEYS, path);
  const patch: GoalRequirementDraftSemanticPatchV1 = {};
  if ("title" in object) patch.title = requiredString(object.title, `${path}.title`);
  if ("statement" in object) patch.statement = requiredString(object.statement, `${path}.statement`);
  if ("source" in object) {
    if (object.source !== "explicit" && object.source !== "inferred") throw new Error(`${path}.source must be explicit or inferred`);
    patch.source = object.source;
  }
  if ("blocking" in object) {
    if (typeof object.blocking !== "boolean") throw new Error(`${path}.blocking must be boolean`);
    patch.blocking = object.blocking;
  }
  for (const key of ["userVisibleBehaviors", "businessRules", "verificationIntent", "assumptions", "openQuestions", "riskTags", "interactionContractRefs"] as const) {
    if (key in object) patch[key] = requiredStringArray(object[key], `${path}.${key}`);
  }
  if ("acceptanceCriteria" in object) {
    patch.acceptanceCriteria = requiredArray(object.acceptanceCriteria, `${path}.acceptanceCriteria`).map((criterion, index) => {
      const criterionPath = `${path}.acceptanceCriteria.${index}`;
      const criterionObject = parseJsonObject(criterion, criterionPath);
      exactSemanticKeys(criterionObject, REQUIREMENT_CRITERION_KEYS, criterionPath);
      return {
        statement: requiredString(criterionObject.statement, `${criterionPath}.statement`),
        evidenceIntent: requiredStringArray(criterionObject.evidenceIntent, `${criterionPath}.evidenceIntent`),
      };
    });
  }
  if ("expectedOutcomeArtifacts" in object) {
    patch.expectedOutcomeArtifacts = requiredArray(object.expectedOutcomeArtifacts, `${path}.expectedOutcomeArtifacts`).map((artifact, index) => {
      const artifactPath = `${path}.expectedOutcomeArtifacts.${index}`;
      const artifactObject = parseJsonObject(artifact, artifactPath);
      exactOptionalKeys(artifactObject, REQUIREMENT_ARTIFACT_KEYS, artifactPath);
      return {
        description: requiredString(artifactObject.description, `${artifactPath}.description`),
        ...(artifactObject.mediaType !== undefined ? { mediaType: requiredString(artifactObject.mediaType, `${artifactPath}.mediaType`) } : {}),
      };
    });
  }
  return patch;
}

function parseSemanticRequirement(value: unknown, index: number, prefix = "requirements"): GoalRequirementDraftItemInputV1 {
  const path = `${prefix}.${index}`;
  const object = parseJsonObject(value, path);
  exactSemanticKeys(object, REQUIREMENT_SEMANTIC_KEYS, path);
  const acceptanceCriteria = requiredArray(object.acceptanceCriteria, `${path}.acceptanceCriteria`).map((criterion, criterionIndex) => {
    const criterionPath = `${path}.acceptanceCriteria.${criterionIndex}`;
    const criterionObject = parseJsonObject(criterion, criterionPath);
    exactSemanticKeys(criterionObject, REQUIREMENT_CRITERION_KEYS, criterionPath);
    return {
      statement: requiredString(criterionObject.statement, `${criterionPath}.statement`),
      evidenceIntent: requiredStringArray(criterionObject.evidenceIntent, `${criterionPath}.evidenceIntent`),
    };
  });
  const artifacts = requiredArray(object.expectedOutcomeArtifacts, `${path}.expectedOutcomeArtifacts`).map((artifact, artifactIndex) => {
    const artifactPath = `${path}.expectedOutcomeArtifacts.${artifactIndex}`;
    const artifactObject = parseJsonObject(artifact, artifactPath);
    exactOptionalKeys(artifactObject, REQUIREMENT_ARTIFACT_KEYS, artifactPath);
    const output: { description: string; mediaType?: string } = {
      description: requiredString(artifactObject.description, `${artifactPath}.description`),
    };
    if (artifactObject.mediaType !== undefined) output.mediaType = requiredString(artifactObject.mediaType, `${artifactPath}.mediaType`);
    return output;
  });
  return {
    title: requiredString(object.title, `${path}.title`),
    statement: requiredString(object.statement, `${path}.statement`),
    source: object.source === "explicit" || object.source === "inferred"
      ? object.source
      : fail(`${path}.source must be explicit or inferred`),
    blocking: typeof object.blocking === "boolean" ? object.blocking : fail(`${path}.blocking must be boolean`),
    userVisibleBehaviors: requiredStringArray(object.userVisibleBehaviors, `${path}.userVisibleBehaviors`),
    businessRules: requiredStringArray(object.businessRules, `${path}.businessRules`),
    acceptanceCriteria,
    expectedOutcomeArtifacts: artifacts,
    verificationIntent: requiredStringArray(object.verificationIntent, `${path}.verificationIntent`),
    assumptions: requiredStringArray(object.assumptions, `${path}.assumptions`),
    openQuestions: requiredStringArray(object.openQuestions, `${path}.openQuestions`),
    riskTags: requiredStringArray(object.riskTags, `${path}.riskTags`),
    interactionContractRefs: requiredStringArray(object.interactionContractRefs, `${path}.interactionContractRefs`),
  };
}

function applySemanticRequirementRevision(
  currentDraft: GoalRequirementDraftV1,
  semantic: GoalRequirementDraftSemanticV1,
  selectedRequirementId?: string,
  selectedRequirementIds?: string[],
): GoalRequirementDraftV1 {
  const mappedIds = selectedRequirementIds
    ?? (selectedRequirementId !== undefined ? [selectedRequirementId] : undefined);
  if (!mappedIds || mappedIds.length !== semantic.requirements.length) {
    throw new Error("semantic replacement requires one host-selected requirement id for every edited requirement");
  }
  const existingById = new Map(currentDraft.requirements.map((requirement) => [requirement.id, requirement]));
  const uniqueIds = new Set(mappedIds);
  if (uniqueIds.size !== mappedIds.length) throw new Error("semantic replacement host requirement ids must be unique");
  const missingId = mappedIds.find((id) => !existingById.has(id));
  if (missingId) throw new Error(`unknown selected requirement id: ${missingId}`);
  const materialized = finalizeGoalRequirementDraft({
    goalPrompt: currentDraft.originalPrompt,
    cwd: currentDraft.workspace.cwd,
    ...(currentDraft.workspace.projectRef !== undefined ? { projectRef: currentDraft.workspace.projectRef } : {}),
    ...semantic,
  });
  const requirements = materialized.requirements.map((requirement, index) => {
    const existing = existingById.get(mappedIds[index]!);
    return existing
      ? materializeRequirement(toRequirementInput(requirement), existing.id, existing.status === "superseded" ? "superseded" : undefined, existing)
      : requirement;
  });
  const included = new Set(requirements.map((requirement) => requirement.id));
  for (const existing of currentDraft.requirements) {
    if (!included.has(existing.id) && existing.source === "explicit") requirements.push(cloneRequirement(existing));
  }
  return finalizeRevision(
    {
      ...currentDraft,
      summary: semantic.summary,
      nonGoals: semantic.nonGoals,
      blockingInputs: semantic.blockingInputs,
    },
    requirements,
  );
}

function applySemanticRequirementOperation(
  draft: GoalRequirementDraftV1,
  operation: GoalRequirementDraftRevisionOperationSemanticV1,
  selectedRequirementId?: string,
  selectedRequirementIds?: string[],
): GoalRequirementDraftV1 {
  switch (operation.kind) {
    case "create":
      return reviseGoalRequirementDraft(draft, { kind: "create", requirement: operation.requirement });
    case "update":
      return reviseGoalRequirementDraft(draft, {
        kind: "update",
        requirementId: requireSelectedRequirementId(selectedRequirementId ?? singleSelectedRequirementId(selectedRequirementIds)),
        patch: operation.patch,
      });
    case "supersede":
      return reviseGoalRequirementDraft(draft, {
        kind: "supersede",
        requirementId: requireSelectedRequirementId(selectedRequirementId ?? singleSelectedRequirementId(selectedRequirementIds)),
      });
    case "restore":
      return reviseGoalRequirementDraft(draft, {
        kind: "restore",
        requirementId: requireSelectedRequirementId(selectedRequirementId ?? singleSelectedRequirementId(selectedRequirementIds)),
      });
    case "split":
      return reviseGoalRequirementDraft(draft, {
        kind: "split",
        requirementId: requireSelectedRequirementId(selectedRequirementId ?? singleSelectedRequirementId(selectedRequirementIds)),
        requirements: operation.requirements,
      });
    case "merge":
      return reviseGoalRequirementDraft(draft, {
        kind: "merge",
        requirementIds: requireSelectedRequirementIds(selectedRequirementIds),
        requirement: operation.requirement,
      });
    default:
      return assertNever(operation);
  }
}

function requireSelectedRequirementId(selectedRequirementId: string | undefined): string {
  if (!selectedRequirementId || selectedRequirementId.trim().length === 0) {
    throw new Error("revision operation requires a selected requirement id supplied by the host");
  }
  return selectedRequirementId;
}

function requireSelectedRequirementIds(selectedRequirementIds: string[] | undefined): string[] {
  if (!selectedRequirementIds || selectedRequirementIds.length < 2) {
    throw new Error("merge revision requires at least two host-selected requirement ids");
  }
  const unique = new Set(selectedRequirementIds);
  if (unique.size !== selectedRequirementIds.length) throw new Error("merge revision host requirement ids must be unique");
  return [...selectedRequirementIds];
}

function singleSelectedRequirementId(selectedRequirementIds: string[] | undefined): string | undefined {
  return selectedRequirementIds?.length === 1 ? selectedRequirementIds[0] : undefined;
}

function revisionSelectionQuestion(
  payload: Exclude<GoalRequirementDraftRevisionPayloadV1, { kind: "needs_input" }>,
  selectedRequirementId: string | undefined,
  selectedRequirementIds: string[] | undefined,
): string | undefined {
  if ("draft" in payload) {
    const mappedIds = selectedRequirementIds ?? (selectedRequirementId === undefined ? undefined : [selectedRequirementId]);
    if (!mappedIds) return "Select one host requirement for each edited requirement before applying a semantic replacement.";
    if (mappedIds.length !== payload.draft.requirements.length) {
      return "Select exactly one host requirement for each edited requirement before applying a semantic replacement.";
    }
    return undefined;
  }
  switch (payload.operation.kind) {
    case "merge":
      if (!selectedRequirementIds || selectedRequirementIds.length < 2) {
        return "Select at least two host requirements before merging them.";
      }
      return undefined;
    case "update":
    case "supersede":
    case "restore":
    case "split":
      if (selectedRequirementId === undefined && singleSelectedRequirementId(selectedRequirementIds) === undefined) {
        return "Select one host requirement before applying this revision operation.";
      }
      return undefined;
    case "create":
      return undefined;
    default:
      return assertNever(payload.operation);
  }
}

function validateHostSelection(
  draft: GoalRequirementDraftV1,
  selectedRequirementId: string | undefined,
  selectedRequirementIds: string[] | undefined,
): string | undefined {
  const known = new Set(draft.requirements.map((requirement) => requirement.id));
  if (selectedRequirementId !== undefined && !known.has(selectedRequirementId)) {
    return `Selected requirement ${selectedRequirementId} is stale; choose an existing requirement before revising.`;
  }
  if (selectedRequirementIds !== undefined) {
    const unique = new Set(selectedRequirementIds);
    if (unique.size !== selectedRequirementIds.length) return "Selected requirements must be unique.";
    const missing = selectedRequirementIds.find((id) => !known.has(id));
    if (missing) return `Selected requirement ${missing} is stale; choose existing requirements before revising.`;
  }
  return undefined;
}

function normalizeHostSelection(
  selectedRequirementId: string | undefined,
  selectedRequirementIds: string[] | undefined,
):
  | { kind: "selection"; selectedRequirementId: string | undefined; selectedRequirementIds: string[] | undefined }
  | { kind: "needs_input"; question: string } {
  if (selectedRequirementId === undefined || selectedRequirementIds === undefined) {
    return { kind: "selection", selectedRequirementId, selectedRequirementIds };
  }
  if (selectedRequirementIds.length === 1 && selectedRequirementIds[0] === selectedRequirementId) {
    return { kind: "selection", selectedRequirementId, selectedRequirementIds: undefined };
  }
  return {
    kind: "needs_input",
    question: "Choose either one requirement or multiple requirements before revising; the current host selections conflict.",
  };
}

function parseJsonObject(text: unknown, label: string): Record<string, unknown> {
  let parsed: unknown = text;
  if (typeof text === "string") {
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      throw new Error(`${label} returned invalid JSON`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be an object`);
  return parsed as Record<string, unknown>;
}

function exactSemanticKeys(object: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  const unexpected = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !actual.includes(key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`${path} has invalid fields; unexpected=${unexpected.join(",")}; missing=${missing.join(",")}`);
  }
}

function exactOptionalKeys(object: Record<string, unknown>, keys: readonly string[], path: string): void {
  const unexpected = Object.keys(object).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) throw new Error(`${path} contains unexpected fields: ${unexpected.join(", ")}`);
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function requiredStringArray(value: unknown, path: string): string[] {
  return requiredArray(value, path).map((entry, index) => requiredString(entry, `${path}.${index}`));
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}
