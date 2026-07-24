import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { findApprovedLibraryObjectsByKind } from "../design-library/library-graph-store.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { criterionValidationCheckKey } from "../design-library/types.ts";
import type { AssuranceRiskAcceptanceV1, RequirementValidationBindingV3, RequirementValidationMode } from "../design-library/types.ts";
import {
  goalContractHash,
  type GoalContractV1,
  type GoalExpectedArtifactV1,
} from "./goal-contract.ts";
import type { LlmTextClient } from "./llm-composer.ts";
import type { WorkspaceGoalDiscoveryV1 } from "./goal-workspace-discovery.ts";
import {
  GOAL_REQUIREMENT_CRITERION_PROMPT_VERSION,
  GOAL_REQUIREMENT_CRITERION_SCHEMA_HASH,
  goalRequirementDraftHash,
  type GoalRequirementDraftV1,
} from "./goal-requirement-draft.ts";

export type { GoalExpectedArtifactV1, WorkspaceGoalDiscoveryV1 };

export type GoalDesignMode = "review_before_compose" | "auto_until_blocked";

export type ResolvedGoalDesignSkillV1 = {
  objectKey: string;
  versionRef: string;
  stateHash: string;
  body: string;
};

export type WorkflowTemplatePolicyV1 =
  | { mode: "auto" }
  | { mode: "prefer" | "require"; templateRef: string; versionRef: string };

export type GoalSliceV1 = {
  id: string;
  requirementIds: string[];
  outcome: string;
  stateOrArtifactOwner: string;
  mutationBoundary: string;
  expectedArtifactRefs: string[];
  evaluatorContractRefs: string[];
  dependsOnSliceIds: string[];
  dependencyArtifactRefs: string[];
  mergeReason?: string;
};

export type GoalSlicePlanV1 = {
  schemaVersion: "southstar.goal_slice_plan.v1";
  goalContractHash: string;
  revision: number;
  slices: GoalSliceV1[];
};

export type CompositionStrategyV1 =
  | { mode: "single-run"; sliceIds: string[]; rationale: string }
  | { mode: "per-slice-runs"; sliceIds: string[]; rationale: string };

export type GoalDesignPackageV3 = {
  schemaVersion: "southstar.goal_design_package.v3";
  revision: number;
  parentRevision?: number;
  goalContract: GoalContractV1;
  requirementDraftHash: string;
  validationBindings: RequirementValidationBindingV3[];
  assuranceRiskAcceptances?: AssuranceRiskAcceptanceV1[];
  slicePlan: GoalSlicePlanV1;
  compositionStrategy: CompositionStrategyV1;
  templatePolicy: WorkflowTemplatePolicyV1;
  goalContractHash: string;
  validationBindingsHash: string;
  slicePlanHash: string;
  packageHash: string;
  goalDesignSkillRef: string;
  goalDesignSkillVersionRef: string;
  criterionPromptVersion: string;
  criterionSchemaHash: string;
  workspaceDiscoveryHash: string;
  mode: GoalDesignMode;
};

// Package V3 is the only persisted Goal Design contract. Older packages are
// intentionally not readable by the runtime and must be regenerated through
// the staged Requirement/Validation/Slice flow.
export type GoalDesignPackage = GoalDesignPackageV3;

export type GoalSliceDesignRevisionProposal =
  | {
      kind: "revision";
      slicePlan: Pick<GoalSlicePlanV1, "slices">;
      compositionStrategy: CompositionStrategyV1;
      summary: string;
      changedSliceIds: string[];
    }
  | {
      kind: "needs_input";
      question: string;
    };

export type GoalSliceDesigner = {
  design(input: {
    goalContract: GoalContractV1;
    requirementDraft: GoalRequirementDraftV1;
    validationBindings: RequirementValidationBindingV3[];
    workspaceDiscovery: WorkspaceGoalDiscoveryV1;
    mode: GoalDesignMode;
    templatePolicy: WorkflowTemplatePolicyV1;
    skill: ResolvedGoalDesignSkillV1;
    onDelta?: (text: string) => void;
  }): Promise<GoalDesignPackageV3>;
  revise(input: {
    currentPackage: GoalDesignPackageV3;
    requirementDraft: GoalRequirementDraftV1;
    validationBindings: RequirementValidationBindingV3[];
    workspaceDiscovery: WorkspaceGoalDiscoveryV1;
    mode: GoalDesignMode;
    templatePolicy: WorkflowTemplatePolicyV1;
    skill: ResolvedGoalDesignSkillV1;
    message: string;
    selectedSliceId?: string;
    onDelta?: (text: string) => void;
  }): Promise<GoalSliceDesignRevisionProposal>;
};

export type GoalDesignValidationIssue = {
  code:
    | "invalid_schema_version"
    | "goal_contract_hash_mismatch"
    | "slice_plan_hash_mismatch"
    | "package_hash_mismatch"
    | "duplicate_slice_id"
    | "unknown_slice_requirement"
    | "requirement_owner_count"
    | "unknown_evaluator_requirement"
    | "unknown_evaluator_ref"
    | "unknown_dependency_slice"
    | "dependency_without_artifact_flow"
    | "slice_dependency_cycle"
    | "strategy_slice_mismatch"
    | "invalid_template_policy"
    | "invalid_mode"
    | "empty_rationale"
    | "invalid_requirement_draft_hash"
    | "invalid_criterion_prompt_version"
    | "invalid_criterion_schema_hash"
    | "validation_bindings_hash_mismatch"
    | "duplicate_validation_binding_id"
    | "invalid_validation_binding"
    | "binding_criteria_mismatch"
    | "requirement_missing_validation_binding"
    | "slice_missing_validation_binding"
    | "invalid_assurance_risk_acceptance";
  path: string;
  message: string;
};

type DesignGoalSlicesWithLlmInput = {
  goalContract: GoalContractV1;
  requirementDraft: GoalRequirementDraftV1;
  validationBindings: RequirementValidationBindingV3[];
  workspaceDiscovery: WorkspaceGoalDiscoveryV1;
  mode: GoalDesignMode;
  templatePolicy: WorkflowTemplatePolicyV1;
  skill: ResolvedGoalDesignSkillV1;
  client: LlmTextClient;
  model: string;
  onDelta?: (text: string) => void;
};

type ReviseGoalSlicesWithLlmInput = Omit<DesignGoalSlicesWithLlmInput, "onDelta"> & {
  currentPackage: GoalDesignPackageV3;
  message: string;
  selectedSliceId?: string;
  onDelta?: (text: string) => void;
};

type LlmGoalSlicePayload = {
  slicePlan: { slices: GoalSliceV1[] };
  compositionStrategy: CompositionStrategyV1;
};

type LlmGoalSliceRevisionPayload =
  | { kind: "needs_input"; question: string }
  | {
      kind: "revision";
      slicePlan: { slices: GoalSliceV1[] };
      compositionStrategy: CompositionStrategyV1;
      summary: string;
      changedSliceIds: string[];
    };

const MAX_DESIGN_RESPONSE_CHARS = 60_000;
const MAX_DESIGN_ATTEMPTS = 2;

export async function loadGoalDesignSkillPg(db: SouthstarDb): Promise<ResolvedGoalDesignSkillV1> {
  const skills = (await findApprovedLibraryObjectsByKind(db, "skill_spec"))
    .filter((skill) => skill.state.purpose === "goal_design");
  if (skills.length !== 1) {
    throw new Error(`expected exactly one approved Goal Design skill, found ${skills.length}`);
  }
  const skill = skills[0]!;
  if (!skill.headVersionId) throw new Error(`Goal Design skill missing version ref: ${skill.objectKey}`);
  const body = typeof skill.state.body === "string"
    ? skill.state.body
    : typeof skill.state.instructions === "string"
      ? skill.state.instructions
      : "";
  if (body.trim().length === 0) throw new Error(`Goal Design skill missing body: ${skill.objectKey}`);
  return {
    objectKey: skill.objectKey,
    versionRef: skill.headVersionId,
    stateHash: contentHashForPayload(skill.state),
    body,
  };
}

export async function designGoalSlicesWithLlm(
  input: DesignGoalSlicesWithLlmInput,
): Promise<GoalDesignPackageV3> {
  assertConfirmedSliceDesignInputs(input);
  const basePrompt = renderSliceDesignPrompt(input);
  let prompt = basePrompt;
  for (let attempt = 1; attempt <= MAX_DESIGN_ATTEMPTS; attempt += 1) {
    const deltas: string[] = [];
    const textInput = {
      model: input.model,
      prompt,
      temperature: 0,
      cwd: input.goalContract.workspace.cwd,
    };
    const response = input.client.generateTextStream
      ? await input.client.generateTextStream(textInput, { onDelta: (delta) => deltas.push(delta) })
      : await input.client.generateText(textInput);
    try {
      const payload = parseGoalSlicePayload(response);
      const hostFinalized = hostFinalizeSlicePayload(payload, input.goalContract);
      const pkg = finalizeGoalDesignPackageV3({
        schemaVersion: "southstar.goal_design_package.v3",
        revision: 1,
        goalContract: input.goalContract,
        requirementDraftHash: input.requirementDraft.draftHash,
        validationBindings: input.validationBindings,
        slicePlan: {
          schemaVersion: "southstar.goal_slice_plan.v1",
          goalContractHash: "host-filled",
          revision: 1,
          slices: hostFinalized.slices,
        },
        compositionStrategy: hostFinalized.compositionStrategy,
        templatePolicy: input.templatePolicy,
        goalDesignSkillRef: input.skill.objectKey,
        goalDesignSkillVersionRef: input.skill.versionRef,
        workspaceDiscoveryHash: input.workspaceDiscovery.discoveryHash,
        mode: input.mode,
      });
      for (const delta of deltas) input.onDelta?.(delta);
      return pkg;
    } catch (error) {
      if (attempt === MAX_DESIGN_ATTEMPTS) throw error;
      prompt = [
        basePrompt,
        "",
        `The previous Slice response was invalid: ${error instanceof Error ? error.message : String(error)}`,
        "Return one corrected JSON object only.",
        `PreviousResponse: ${response.slice(0, MAX_DESIGN_RESPONSE_CHARS)}`,
      ].join("\n");
    }
  }
  throw new Error("Goal Slice Design exhausted attempts");
}

export async function reviseGoalSlicesWithLlm(
  input: ReviseGoalSlicesWithLlmInput,
): Promise<GoalSliceDesignRevisionProposal> {
  assertConfirmedSliceDesignInputs(input);
  if (input.currentPackage.schemaVersion !== "southstar.goal_design_package.v3") {
    throw new Error("staged Slice revision requires Goal Design Package V3");
  }
  if (input.currentPackage.requirementDraftHash !== input.requirementDraft.draftHash
    || input.currentPackage.goalContractHash !== goalContractHash(input.goalContract)
    || input.currentPackage.validationBindingsHash !== contentHashForPayload(input.validationBindings)) {
    throw new Error("staged Slice revision inputs do not match the reviewed package");
  }
  const basePrompt = renderSliceRevisionPrompt(input);
  let prompt = basePrompt;
  for (let attempt = 1; attempt <= MAX_DESIGN_ATTEMPTS; attempt += 1) {
    const deltas: string[] = [];
    const textInput = {
      model: input.model,
      prompt,
      temperature: 0,
      cwd: input.goalContract.workspace.cwd,
    };
    const response = input.client.generateTextStream
      ? await input.client.generateTextStream(textInput, { onDelta: (delta) => deltas.push(delta) })
      : await input.client.generateText(textInput);
    try {
      const payload = parseGoalSliceRevisionPayload(response);
      if (payload.kind === "needs_input") return payload;
      const hostFinalized = hostFinalizeSlicePayload(payload, input.goalContract);
      const changedSliceIds = payload.changedSliceIds.map((id) => hostFinalized.canonicalSliceIds.get(id) ?? id);
      for (const delta of deltas) input.onDelta?.(delta);
      return {
        kind: "revision",
        slicePlan: { slices: hostFinalized.slices },
        compositionStrategy: hostFinalized.compositionStrategy,
        summary: payload.summary,
        changedSliceIds,
      };
    } catch (error) {
      if (attempt === MAX_DESIGN_ATTEMPTS) throw error;
      prompt = [
        basePrompt,
        "",
        `The previous Slice revision response was invalid: ${error instanceof Error ? error.message : String(error)}`,
        "Return one corrected JSON object only.",
        `PreviousResponse: ${response.slice(0, MAX_DESIGN_RESPONSE_CHARS)}`,
      ].join("\n");
    }
  }
  throw new Error("Goal Slice revision exhausted attempts");
}

export function createLlmGoalSliceDesigner(input: {
  client: LlmTextClient;
  model: string;
}): GoalSliceDesigner {
  return {
    async design(designInput) {
      return await designGoalSlicesWithLlm({
        ...designInput,
        client: input.client,
        model: input.model,
      });
    },
    async revise(revisionInput) {
      return await reviseGoalSlicesWithLlm({
        ...revisionInput,
        goalContract: revisionInput.currentPackage.goalContract,
        client: input.client,
        model: input.model,
      });
    },
  };
}

export function finalizeGoalDesignPackageV3(
  input: Omit<GoalDesignPackageV3,
    | "goalContractHash"
    | "validationBindingsHash"
    | "slicePlanHash"
    | "packageHash"
    | "criterionPromptVersion"
    | "criterionSchemaHash"
  >,
): GoalDesignPackageV3 {
  const goalHash = goalContractHash(input.goalContract);
  const validationBindingsHash = contentHashForPayload(input.validationBindings);
  const slicePlan: GoalSlicePlanV1 = {
    ...input.slicePlan,
    schemaVersion: "southstar.goal_slice_plan.v1",
    goalContractHash: goalHash,
  };
  const slicePlanHash = contentHashForPayload(slicePlan);
  const withoutPackageHash = {
    ...input,
    criterionPromptVersion: GOAL_REQUIREMENT_CRITERION_PROMPT_VERSION,
    criterionSchemaHash: GOAL_REQUIREMENT_CRITERION_SCHEMA_HASH,
    goalContractHash: goalHash,
    validationBindingsHash,
    slicePlan,
    slicePlanHash,
  };
  const pkg: GoalDesignPackageV3 = {
    ...withoutPackageHash,
    packageHash: contentHashForPayload(withoutPackageHash),
  };
  const issues = validateGoalDesignPackageV3(pkg);
  if (issues.length > 0) {
    throw new Error(`invalid Goal Design package v3: ${issues.map((entry) => `${entry.code} at ${entry.path}`).join("; ")}`);
  }
  return pkg;
}

export function goalDesignPackageV3Hash(pkg: GoalDesignPackageV3): string {
  const { packageHash: _packageHash, ...withoutPackageHash } = pkg;
  return contentHashForPayload(withoutPackageHash);
}

export function validateGoalDesignPackageV3(pkg: GoalDesignPackageV3): GoalDesignValidationIssue[] {
  const issues: GoalDesignValidationIssue[] = [];
  if (pkg.schemaVersion !== "southstar.goal_design_package.v3") {
    issues.push(issue("invalid_schema_version", "schemaVersion", "schemaVersion must be southstar.goal_design_package.v3"));
  }
  const expectedGoalHash = goalContractHash(pkg.goalContract);
  if (pkg.goalContractHash !== expectedGoalHash || pkg.slicePlan.goalContractHash !== expectedGoalHash) {
    issues.push(issue("goal_contract_hash_mismatch", "goalContractHash", "goal contract hashes must match package goalContract"));
  }
  if (!nonEmpty(pkg.requirementDraftHash)) {
    issues.push(issue("invalid_requirement_draft_hash", "requirementDraftHash", "confirmed requirement draft hash is required"));
  }
  if (pkg.criterionPromptVersion !== GOAL_REQUIREMENT_CRITERION_PROMPT_VERSION) {
    issues.push(issue("invalid_criterion_prompt_version", "criterionPromptVersion", "Criterion prompt version is not canonical"));
  }
  if (pkg.criterionSchemaHash !== GOAL_REQUIREMENT_CRITERION_SCHEMA_HASH) {
    issues.push(issue("invalid_criterion_schema_hash", "criterionSchemaHash", "Criterion schema hash is not canonical"));
  }
  if (pkg.validationBindingsHash !== contentHashForPayload(pkg.validationBindings)) {
    issues.push(issue("validation_bindings_hash_mismatch", "validationBindingsHash", "validation bindings hash is not canonical"));
  }
  if (pkg.slicePlanHash !== contentHashForPayload(pkg.slicePlan)) {
    issues.push(issue("slice_plan_hash_mismatch", "slicePlanHash", "slice plan hash is not canonical"));
  }
  if (pkg.packageHash !== goalDesignPackageV3Hash(pkg)) {
    issues.push(issue("package_hash_mismatch", "packageHash", "package hash is not canonical"));
  }
  if (pkg.mode !== "review_before_compose" && pkg.mode !== "auto_until_blocked") {
    issues.push(issue("invalid_mode", "mode", "mode is not supported"));
  }
  validateTemplatePolicy(pkg.templatePolicy, issues);
  validateAssuranceRiskAcceptances(pkg, issues);
  validateValidationBindings(pkg, issues);
  validateSlicesV2(pkg, issues);
  validateStrategyShape(pkg.slicePlan.slices, pkg.compositionStrategy, issues);
  return issues;
}

export function goalDesignPackageV3FromUnknown(value: unknown): GoalDesignPackageV3 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pkg = value as GoalDesignPackageV3;
  if (pkg.schemaVersion !== "southstar.goal_design_package.v3") return undefined;
  try {
    return validateGoalDesignPackageV3(pkg).length === 0 ? pkg : undefined;
  } catch {
    return undefined;
  }
}

function renderSliceDesignPrompt(input: DesignGoalSlicesWithLlmInput): string {
  const allowedRequirementIds = input.goalContract.requirements.map((requirement) => requirement.id);
  const allowedBindingIds = input.validationBindings.map((binding) => binding.id);
  const allowedArtifactRefs = [...new Set([
    ...input.goalContract.expectedArtifactRefs,
    ...input.validationBindings.flatMap((binding) => (
      binding.criterionBindings.map((item) => item.artifactContractRef)
    )),
  ])];
  return [
    "Use the approved Library Goal Design SOP to design outcome slices from the confirmed Goal Contract and frozen validation bindings.",
    `GoalDesignSkillRef: ${input.skill.objectKey}`,
    `GoalDesignSkillVersionRef: ${input.skill.versionRef}`,
    input.skill.body,
    "",
    "Return one JSON object only with exactly slicePlan and compositionStrategy.",
    "The host owns canonical slice ids, revisions, contracts, bindings, versions, and hashes.",
    "Treat each slice id you return as a response-local alias only. Use those aliases in dependsOnSliceIds and compositionStrategy.sliceIds.",
    "SliceDesignOutputSchema:",
    "{",
    "  slicePlan: {",
    "    slices: [{",
    "      id: string,",
    "      requirementIds: string[],",
    "      outcome: string,",
    "      stateOrArtifactOwner: string,",
    "      mutationBoundary: string,",
    "      expectedArtifactRefs: string[],",
    "      evaluatorContractRefs: string[],",
    "      dependsOnSliceIds: string[],",
    "      dependencyArtifactRefs: string[],",
    "      mergeReason?: string",
    "    }]",
    "  },",
    "  compositionStrategy: { mode: \"single-run\" | \"per-slice-runs\", sliceIds: string[], rationale: string }",
    "}",
    `AllowedRequirementIds: ${JSON.stringify(allowedRequirementIds)}`,
    `AllowedValidationBindingIds: ${JSON.stringify(allowedBindingIds)}`,
    `AllowedArtifactRefs: ${JSON.stringify(allowedArtifactRefs)}`,
    "evaluatorContractRefs is the canonical Slice field for frozen validation binding ids. Fill it only with AllowedValidationBindingIds; never put an evaluator profile ref or a criterion id here.",
    "Every blocking requirement must belong to exactly one slice and that slice must include its frozen validation binding ids. The binding carries the immutable per-Criterion artifact/evaluator/version/procedure/evidence contract; Slice design may arrange ownership and dependencies but must not reinterpret or merge those Criterion contracts.",
    "Do not add requirements, acceptance criteria, validation bindings, evaluator profiles, artifact contracts, or version refs.",
    "Only add a slice dependency when dependencyArtifactRefs consumes an expectedArtifactRef produced by that dependency.",
    `Mode: ${input.mode}`,
    `TemplatePolicy: ${JSON.stringify(input.templatePolicy)}`,
    `WorkspaceDiscovery: ${JSON.stringify(input.workspaceDiscovery)}`,
    `RequirementDraftHash: ${input.requirementDraft.draftHash}`,
    `GoalContract: ${JSON.stringify(input.goalContract)}`,
    `ValidationBindings: ${JSON.stringify(input.validationBindings)}`,
  ].join("\n");
}

function renderSliceRevisionPrompt(input: ReviseGoalSlicesWithLlmInput): string {
  const allowedRequirementIds = input.goalContract.requirements.map((requirement) => requirement.id);
  const allowedBindingIds = input.validationBindings.map((binding) => binding.id);
  const allowedArtifactRefs = [...new Set([
    ...input.goalContract.expectedArtifactRefs,
    ...input.validationBindings.flatMap((binding) => (
      binding.criterionBindings.map((item) => item.artifactContractRef)
    )),
  ])];
  return [
    "Use the approved Library Goal Design SOP to revise the reviewed Slice Plan.",
    `GoalDesignSkillRef: ${input.skill.objectKey}`,
    `GoalDesignSkillVersionRef: ${input.skill.versionRef}`,
    input.skill.body,
    "",
    "Return one JSON object only.",
    "RevisionSliceDesignResponseSchema:",
    "{kind: \"revision\", slicePlan: {slices: []}, compositionStrategy: {}, summary: string, changedSliceIds: string[]}",
    "If the request is ambiguous, return {kind: \"needs_input\", question: string}.",
    "The host owns package revision, canonical ids, hashes, Goal Contract, and frozen validation bindings.",
    "Do not add or change requirements, acceptance criteria, validation bindings, evaluator profiles, artifact contracts, or version refs.",
    `AllowedRequirementIds: ${JSON.stringify(allowedRequirementIds)}`,
    `AllowedValidationBindingIds: ${JSON.stringify(allowedBindingIds)}`,
    `AllowedArtifactRefs: ${JSON.stringify(allowedArtifactRefs)}`,
    "evaluatorContractRefs is the canonical Slice field for frozen validation binding ids. Fill it only with AllowedValidationBindingIds; never put an evaluator profile ref or a criterion id here.",
    "Return the complete revised Slice Plan and composition strategy, not a patch. Preserve every frozen Criterion contract exactly; only slice ownership, outcome, mutation boundary, dependencies, and strategy may change.",
    `Mode: ${input.mode}`,
    `TemplatePolicy: ${JSON.stringify(input.templatePolicy)}`,
    `WorkspaceDiscovery: ${JSON.stringify(input.workspaceDiscovery)}`,
    `GoalContract: ${JSON.stringify(input.goalContract)}`,
    `ValidationBindings: ${JSON.stringify(input.validationBindings)}`,
    `CurrentGoalDesignPackage: ${JSON.stringify(input.currentPackage)}`,
    `SelectedSliceId: ${input.selectedSliceId ?? ""}`,
    `UserMessage: ${input.message}`,
  ].join("\n");
}

function parseGoalSlicePayload(text: string): LlmGoalSlicePayload {
  if (text.length > MAX_DESIGN_RESPONSE_CHARS) throw new Error("Goal Slice Design response is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error("Goal Slice Design returned invalid JSON");
  }
  const object = record(parsed, "$");
  exactKeys(object, ["slicePlan", "compositionStrategy"], "$");
  const slicePlan = record(object.slicePlan, "slicePlan");
  exactKeys(slicePlan, ["slices"], "slicePlan");
  return {
    slicePlan: {
      slices: array(slicePlan.slices, "slicePlan.slices").map(parseSlice),
    },
    compositionStrategy: parseCompositionStrategy(record(object.compositionStrategy, "compositionStrategy")),
  };
}

function parseGoalSliceRevisionPayload(text: string): LlmGoalSliceRevisionPayload {
  if (text.length > MAX_DESIGN_RESPONSE_CHARS) throw new Error("Goal Slice revision response is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error("Goal Slice revision returned invalid JSON");
  }
  const object = record(parsed, "$");
  const kind = string(object.kind, "kind");
  if (kind === "needs_input") {
    exactKeys(object, ["kind", "question"], "$");
    return { kind, question: string(object.question, "question") };
  }
  if (kind !== "revision") throw new Error("Goal Slice revision kind must be revision or needs_input");
  exactKeys(object, ["kind", "slicePlan", "compositionStrategy", "summary", "changedSliceIds"], "$");
  const slicePlan = record(object.slicePlan, "slicePlan");
  exactKeys(slicePlan, ["slices"], "slicePlan");
  return {
    kind,
    slicePlan: { slices: array(slicePlan.slices, "slicePlan.slices").map(parseSlice) },
    compositionStrategy: parseCompositionStrategy(record(object.compositionStrategy, "compositionStrategy")),
    summary: string(object.summary, "summary"),
    changedSliceIds: stringArray(object.changedSliceIds, "changedSliceIds"),
  };
}

function assertConfirmedSliceDesignInputs(input: DesignGoalSlicesWithLlmInput): void {
  const { draftHash: _draftHash, ...withoutDraftHash } = input.requirementDraft;
  if (input.requirementDraft.draftHash !== goalRequirementDraftHash(withoutDraftHash)) {
    throw new Error("confirmed Goal Requirement draft hash is not canonical");
  }
  if (input.requirementDraft.workspace.cwd !== input.goalContract.workspace.cwd) {
    throw new Error("confirmed Goal Requirement draft workspace does not match Goal Contract");
  }
  const activeDraftRequirements = input.requirementDraft.requirements
    .filter((requirement) => requirement.status !== "superseded");
  const draftById = new Map(activeDraftRequirements.map((requirement) => [requirement.id, requirement]));
  if (draftById.size !== input.goalContract.requirements.length) {
    throw new Error("confirmed Goal Requirement draft does not match Goal Contract requirements");
  }
  for (const requirement of input.goalContract.requirements) {
    const draftRequirement = draftById.get(requirement.id);
    const draftContractRequirement = draftRequirement
      ? {
          statement: draftRequirement.statement,
          acceptanceCriteria: draftRequirement.acceptanceCriteria.map((criterion) => ({
            id: criterion.id,
            version: criterion.version,
            observableClaim: criterion.observableClaim,
            blocking: criterion.blocking,
            verificationIntent: [...criterion.verificationIntent],
            requiredAssurance: [...criterion.requiredAssurance],
          })),
          ...(draftRequirement.semanticTags !== undefined ? { semanticTags: [...draftRequirement.semanticTags] } : {}),
          blocking: draftRequirement.blocking,
          source: draftRequirement.source,
          expectedArtifacts: draftRequirement.expectedOutcomeArtifacts.map((artifact) => ({ ...artifact })),
        }
      : undefined;
    const confirmedContractRequirement = {
      statement: requirement.statement,
      acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        version: criterion.version,
        observableClaim: criterion.observableClaim,
        blocking: criterion.blocking,
        verificationIntent: [...criterion.verificationIntent],
        requiredAssurance: [...criterion.requiredAssurance],
      })),
      ...(requirement.semanticTags !== undefined ? { semanticTags: [...requirement.semanticTags] } : {}),
      blocking: requirement.blocking,
      source: requirement.source,
      expectedArtifacts: requirement.expectedArtifacts.map((artifact) => ({ ...artifact })),
    };
    if (!draftContractRequirement
      || contentHashForPayload(draftContractRequirement) !== contentHashForPayload(confirmedContractRequirement)) {
      throw new Error(`confirmed requirement does not match Goal Contract: ${requirement.id}`);
    }
  }
  if (input.validationBindings.length === 0 && input.goalContract.requirements.some((requirement) => (
    requirement.acceptanceCriteria.some((criterion) => criterion.blocking)
  ))) {
    throw new Error("blocking Goal Contract requires frozen validation bindings before Slice Design");
  }
}

function hostFinalizeSlicePayload(
  payload: LlmGoalSlicePayload,
  goalContract: GoalContractV1,
): {
  slices: GoalSliceV1[];
  compositionStrategy: CompositionStrategyV1;
  canonicalSliceIds: Map<string, string>;
} {
  const aliasToCanonical = new Map<string, string>();
  for (const slice of payload.slicePlan.slices) {
    if (aliasToCanonical.has(slice.id)) throw new Error(`duplicate slice alias: ${slice.id}`);
    const canonicalId = `slice-${contentHashForPayload({
      goalContractHash: goalContractHash(goalContract),
      requirementIds: [...slice.requirementIds].sort(),
      outcome: slice.outcome,
      stateOrArtifactOwner: slice.stateOrArtifactOwner,
      mutationBoundary: slice.mutationBoundary,
      expectedArtifactRefs: [...slice.expectedArtifactRefs].sort(),
      validationBindingIds: [...slice.evaluatorContractRefs].sort(),
      ...(slice.mergeReason !== undefined ? { mergeReason: slice.mergeReason } : {}),
    }).slice(0, 16)}`;
    if ([...aliasToCanonical.values()].includes(canonicalId)) {
      throw new Error("two Slice proposals have the same host-owned identity");
    }
    aliasToCanonical.set(slice.id, canonicalId);
  }
  const canonicalSliceId = (alias: string, path: string): string => {
    const value = aliasToCanonical.get(alias);
    if (!value) throw new Error(`${path} references unknown response-local slice alias: ${alias}`);
    return value;
  };
  const slices = payload.slicePlan.slices.map((slice, index) => ({
    ...slice,
    id: canonicalSliceId(slice.id, `slicePlan.slices.${index}.id`),
    dependsOnSliceIds: slice.dependsOnSliceIds.map((alias) => canonicalSliceId(alias, `slicePlan.slices.${index}.dependsOnSliceIds`)),
  }));
  return {
    slices,
    compositionStrategy: {
      ...payload.compositionStrategy,
      sliceIds: payload.compositionStrategy.sliceIds.map((alias) => canonicalSliceId(alias, "compositionStrategy.sliceIds")),
    },
    canonicalSliceIds: aliasToCanonical,
  };
}

function parseSlice(value: unknown, index: number): GoalSliceV1 {
  const object = record(value, `slicePlan.slices.${index}`);
  exactOptionalKeys(object, [
    "id",
    "requirementIds",
    "outcome",
    "stateOrArtifactOwner",
    "mutationBoundary",
    "expectedArtifactRefs",
    "evaluatorContractRefs",
    "dependsOnSliceIds",
    "dependencyArtifactRefs",
  ], ["mergeReason"], `slicePlan.slices.${index}`);
  const parsed: GoalSliceV1 = {
    id: string(object.id, `slicePlan.slices.${index}.id`),
    requirementIds: stringArray(object.requirementIds, `slicePlan.slices.${index}.requirementIds`),
    outcome: string(object.outcome, `slicePlan.slices.${index}.outcome`),
    stateOrArtifactOwner: string(object.stateOrArtifactOwner, `slicePlan.slices.${index}.stateOrArtifactOwner`),
    mutationBoundary: string(object.mutationBoundary, `slicePlan.slices.${index}.mutationBoundary`),
    expectedArtifactRefs: stringArray(object.expectedArtifactRefs, `slicePlan.slices.${index}.expectedArtifactRefs`),
    evaluatorContractRefs: stringArray(object.evaluatorContractRefs, `slicePlan.slices.${index}.evaluatorContractRefs`),
    dependsOnSliceIds: stringArray(object.dependsOnSliceIds, `slicePlan.slices.${index}.dependsOnSliceIds`),
    dependencyArtifactRefs: stringArray(object.dependencyArtifactRefs, `slicePlan.slices.${index}.dependencyArtifactRefs`),
  };
  if (object.mergeReason !== undefined) parsed.mergeReason = string(object.mergeReason, `slicePlan.slices.${index}.mergeReason`);
  return parsed;
}

function parseCompositionStrategy(object: Record<string, unknown>): CompositionStrategyV1 {
  exactKeys(object, ["mode", "sliceIds", "rationale"], "compositionStrategy");
  const mode = string(object.mode, "compositionStrategy.mode");
  if (mode !== "single-run" && mode !== "per-slice-runs") {
    throw new Error("compositionStrategy.mode is not supported");
  }
  return {
    mode,
    sliceIds: stringArray(object.sliceIds, "compositionStrategy.sliceIds"),
    rationale: string(object.rationale, "compositionStrategy.rationale"),
  };
}

function validateTemplatePolicy(policy: WorkflowTemplatePolicyV1, issues: GoalDesignValidationIssue[]): void {
  if (policy.mode === "auto") return;
  if (
    (policy.mode !== "prefer" && policy.mode !== "require")
    || !nonEmpty(policy.templateRef)
    || !nonEmpty(policy.versionRef)
  ) {
    issues.push(issue("invalid_template_policy", "templatePolicy", "template policy must be auto or pinned prefer/require"));
  }
}

function validateValidationBindings(pkg: GoalDesignPackageV3, issues: GoalDesignValidationIssue[]): void {
  const requirementsById = new Map(pkg.goalContract.requirements.map((requirement) => [requirement.id, requirement]));
  const bindingIds = new Set<string>();
  const requirementBindingCounts = new Map<string, number>();
  const verificationModes = new Set(["deterministic", "browser_interaction", "semantic_review", "human_approval"]);
  for (const [index, binding] of pkg.validationBindings.entries()) {
    const path = `validationBindings.${index}`;
    if (bindingIds.has(binding.id)) {
      issues.push(issue("duplicate_validation_binding_id", `${path}.id`, `duplicate validation binding id: ${binding.id}`));
    }
    bindingIds.add(binding.id);
    const requirement = requirementsById.get(binding.requirementId);
    if (!requirement) {
      issues.push(issue("unknown_evaluator_requirement", `${path}.requirementId`, `unknown requirement id: ${binding.requirementId}`));
      continue;
    }
    requirementBindingCounts.set(binding.requirementId, (requirementBindingCounts.get(binding.requirementId) ?? 0) + 1);
    const expectedCriterionContracts = requirement.acceptanceCriteria;
    const expectedById = new Map(expectedCriterionContracts.map((criterion, criterionIndex) => [
      criterion.id,
      { criterion, criterionIndex },
    ]));
    const criterionBindings = Array.isArray(binding.criterionBindings) ? binding.criterionBindings : [];
    const boundCriterionIds = new Set<string>();
    const boundCheckKeys = new Set<string>();
    const coveredAssurances = new Map<string, Set<string>>();
    let previousCriterionIndex = -1;
    let criteriaMatch = criterionBindings.length > 0;
    let childrenValid = criterionBindings.length > 0;
    for (const child of criterionBindings) {
      if (!child || typeof child !== "object" || Array.isArray(child)
        || !child.criterionContract || typeof child.criterionContract !== "object" || Array.isArray(child.criterionContract)
      ) {
        childrenValid = false;
        criteriaMatch = false;
        continue;
      }
      const expected = expectedById.get(child.criterionContract.id);
      if (!expected
        || expected.criterionIndex < previousCriterionIndex
        || !sameCriterionContracts([child.criterionContract], [expected.criterion])
      ) {
        criteriaMatch = false;
      } else {
        previousCriterionIndex = expected.criterionIndex;
      }
      boundCriterionIds.add(child.criterionContract.id);
      const checkKey = criterionValidationCheckKey(child.criterionContract.id, child.verificationMode);
      if (boundCheckKeys.has(checkKey)) criteriaMatch = false;
      boundCheckKeys.add(checkKey);
      const assuranceCoverage = coveredAssurances.get(child.criterionContract.id) ?? new Set<string>();
      assuranceCoverage.add(child.verificationMode);
      coveredAssurances.set(child.criterionContract.id, assuranceCoverage);
      if (
        !Array.isArray(child.criterionContract.requiredAssurance)
        || child.criterionContract.requiredAssurance.length !== 1
        || new Set(child.criterionContract.requiredAssurance).size !== child.criterionContract.requiredAssurance.length
        || child.criterionContract.requiredAssurance[0] !== child.verificationMode
        || !nonEmpty(child.artifactContractRef)
        || !nonEmpty(child.artifactContractVersionRef)
        || !nonEmpty(child.evaluatorProfileRef)
        || !nonEmpty(child.evaluatorProfileVersionRef)
        || !verificationModes.has(child.verificationMode)
        || !nonEmpty(child.procedureRef)
        || !Array.isArray(child.expectedEvidenceKinds)
        || child.expectedEvidenceKinds.length === 0
        || child.expectedEvidenceKinds.some((kind) => !nonEmpty(kind))
        || child.independence !== "independent"
        || !Array.isArray(child.failureClassifications)
        || child.failureClassifications.some((kind) => !nonEmpty(kind))
      ) childrenValid = false;
    }
    if (expectedCriterionContracts.some((criterion) => (
      (!boundCriterionIds.has(criterion.id)
        && !riskAcceptedAssurance(pkg, criterion.id, criterion.version, criterion.requiredAssurance[0]!))
      || (boundCriterionIds.has(criterion.id)
        && criterion.requiredAssurance.length === 1
        && !coveredAssurances.get(criterion.id)?.has(criterion.requiredAssurance[0]!))
    ))) {
      criteriaMatch = false;
    }
    if (!criteriaMatch) {
      issues.push(issue("binding_criteria_mismatch", `${path}.criterionBindings`, `binding criteria must preserve confirmed Criterion identity and order for ${binding.requirementId}`));
    }
    const invalid = binding.schemaVersion !== "southstar.requirement_validation_binding.v3"
      || !nonEmpty(binding.id)
      || !childrenValid;
    if (invalid) {
      issues.push(issue("invalid_validation_binding", path, `validation binding is incomplete or malformed: ${binding.id}`));
    }
  }
  for (const requirement of pkg.goalContract.requirements) {
    const bindingCount = requirementBindingCounts.get(requirement.id) ?? 0;
    if (bindingCount > 1) {
      issues.push(issue(
        "duplicate_validation_binding_id",
        "validationBindings",
        `requirement must have exactly one frozen validation binding: ${requirement.id}`,
      ));
    }
    if (requirement.acceptanceCriteria.some((criterion) => criterion.blocking) && bindingCount === 0) {
      issues.push(issue(
        "requirement_missing_validation_binding",
        "validationBindings",
        `requirement has a blocking Criterion without a frozen validation binding: ${requirement.id}`,
      ));
    }
  }
}

function validateAssuranceRiskAcceptances(pkg: GoalDesignPackageV3, issues: GoalDesignValidationIssue[]): void {
  const acceptances = pkg.assuranceRiskAcceptances;
  if (acceptances === undefined) return;
  if (!Array.isArray(acceptances)) {
    issues.push(issue("invalid_assurance_risk_acceptance", "assuranceRiskAcceptances", "assuranceRiskAcceptances must be an array"));
    return;
  }
  const criteria = new Map(pkg.goalContract.requirements.flatMap((requirement) => requirement.acceptanceCriteria.map((criterion) => [criterion.id, criterion] as const)));
  const ids = new Set<string>();
  const checkKeys = new Set<string>();
  const modes = new Set<RequirementValidationMode>(["deterministic", "browser_interaction", "semantic_review", "human_approval"]);
  for (const [index, acceptance] of acceptances.entries()) {
    const path = `assuranceRiskAcceptances.${index}`;
    if (!acceptance || typeof acceptance !== "object" || Array.isArray(acceptance)) {
      issues.push(issue("invalid_assurance_risk_acceptance", path, "risk acceptance must be an object"));
      continue;
    }
    if (acceptance.schemaVersion !== "southstar.assurance_risk_acceptance.v1") issues.push(issue("invalid_assurance_risk_acceptance", `${path}.schemaVersion`, "risk acceptance schemaVersion is invalid"));
    if (!nonEmpty(acceptance.id) || ids.has(acceptance.id)) issues.push(issue("invalid_assurance_risk_acceptance", `${path}.id`, "risk acceptance id must be unique and non-empty"));
    ids.add(acceptance.id);
    const criterion = criteria.get(acceptance.criterionId);
    if (!criterion || criterion.version !== acceptance.criterionVersion) {
      issues.push(issue("invalid_assurance_risk_acceptance", `${path}.criterionId`, "risk acceptance must target an existing immutable Criterion version"));
    }
    if (!Array.isArray(acceptance.omittedAssurance) || acceptance.omittedAssurance.length !== 1
      || new Set(acceptance.omittedAssurance).size !== acceptance.omittedAssurance.length
      || acceptance.omittedAssurance.some((mode) => !modes.has(mode))) {
      issues.push(issue("invalid_assurance_risk_acceptance", `${path}.omittedAssurance`, "risk acceptance must list exactly one supported assurance class"));
    }
    for (const mode of acceptance.omittedAssurance ?? []) {
      const key = `${acceptance.criterionId}::${mode}`;
      if (checkKeys.has(key)) issues.push(issue("invalid_assurance_risk_acceptance", `${path}.omittedAssurance`, `duplicate risk acceptance for ${key}`));
      checkKeys.add(key);
      if (criterion && (criterion.requiredAssurance.length !== 1 || criterion.requiredAssurance[0] !== mode)) {
        issues.push(issue("invalid_assurance_risk_acceptance", `${path}.omittedAssurance`, `${mode} is not the required assurance for Criterion ${criterion.id}`));
      }
    }
    for (const [field, value] of Object.entries({ reason: acceptance.reason, approvalId: acceptance.approvalId, approvedBy: acceptance.approvedBy, approvedAt: acceptance.approvedAt, auditEventRef: acceptance.auditEventRef })) {
      if (!nonEmpty(value)) issues.push(issue("invalid_assurance_risk_acceptance", `${path}.${field}`, `${field} is required for audited risk acceptance`));
    }
    if (nonEmpty(acceptance.approvedAt) && Number.isNaN(Date.parse(acceptance.approvedAt))) issues.push(issue("invalid_assurance_risk_acceptance", `${path}.approvedAt`, "approvedAt must be an ISO timestamp"));
  }
}

function riskAcceptedAssurance(pkg: GoalDesignPackageV3, criterionId: string, criterionVersion: number, mode: RequirementValidationMode): boolean {
  return pkg.assuranceRiskAcceptances?.some((acceptance) => (
    acceptance.criterionId === criterionId
    && acceptance.criterionVersion === criterionVersion
    && acceptance.omittedAssurance.includes(mode)
    && nonEmpty(acceptance.approvalId)
    && nonEmpty(acceptance.auditEventRef)
  )) === true;
}

function sameCriterionContracts(left: unknown[], right: unknown[]): boolean {
  const byId = (values: unknown[]) => [...values].sort((leftValue, rightValue) => (
    criterionContractId(leftValue).localeCompare(criterionContractId(rightValue))
  ));
  return contentHashForPayload(byId(left)) === contentHashForPayload(byId(right));
}

function criterionContractId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

function validateSlicesV2(pkg: GoalDesignPackageV3, issues: GoalDesignValidationIssue[]): void {
  const requirementIds = new Set(pkg.goalContract.requirements.map((requirement) => requirement.id));
  const blockingRequirementIds = new Set(pkg.goalContract.requirements
    .filter((requirement) => requirement.acceptanceCriteria.some((criterion) => criterion.blocking))
    .map((requirement) => requirement.id));
  const bindingsById = new Map(pkg.validationBindings.map((binding) => [binding.id, binding]));
  const bindingsByRequirement = new Map<string, RequirementValidationBindingV3[]>();
  for (const binding of pkg.validationBindings) {
    bindingsByRequirement.set(binding.requirementId, [
      ...(bindingsByRequirement.get(binding.requirementId) ?? []),
      binding,
    ]);
  }
  const allowedArtifactRefs = new Set([
    ...pkg.goalContract.expectedArtifactRefs,
    ...pkg.validationBindings.flatMap((binding) => (
      binding.criterionBindings.map((item) => item.artifactContractRef)
    )),
  ]);
  const slicesById = new Map<string, GoalSliceV1>();
  const ownerCounts = new Map<string, number>();
  for (const [index, slice] of pkg.slicePlan.slices.entries()) {
    if (slicesById.has(slice.id)) {
      issues.push(issue("duplicate_slice_id", `slicePlan.slices.${index}.id`, `duplicate slice id: ${slice.id}`));
    }
    slicesById.set(slice.id, slice);
    for (const requirementId of slice.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        issues.push(issue("unknown_slice_requirement", `slicePlan.slices.${index}.requirementIds`, `unknown requirement id: ${requirementId}`));
      }
      ownerCounts.set(requirementId, (ownerCounts.get(requirementId) ?? 0) + 1);
      if (blockingRequirementIds.has(requirementId)) {
        for (const binding of bindingsByRequirement.get(requirementId) ?? []) {
          if (!slice.evaluatorContractRefs.includes(binding.id)) {
            issues.push(issue(
              "slice_missing_validation_binding",
              `slicePlan.slices.${index}.evaluatorContractRefs`,
              `owner slice must include frozen validation binding ${binding.id}`,
            ));
          }
        }
      }
    }
    for (const bindingId of slice.evaluatorContractRefs) {
      const binding = bindingsById.get(bindingId);
      if (!binding) {
        issues.push(issue("unknown_evaluator_ref", `slicePlan.slices.${index}.evaluatorContractRefs`, `unknown validation binding id: ${bindingId}`));
      } else if (!slice.requirementIds.includes(binding.requirementId)) {
        issues.push(issue(
          "slice_missing_validation_binding",
          `slicePlan.slices.${index}.evaluatorContractRefs`,
          `validation binding ${bindingId} belongs to a requirement not owned by this slice`,
        ));
      }
    }
    for (const artifactRef of [...slice.expectedArtifactRefs, ...slice.dependencyArtifactRefs]) {
      if (!allowedArtifactRefs.has(artifactRef)) {
        issues.push(issue("unknown_dependency_slice", `slicePlan.slices.${index}.expectedArtifactRefs`, `unknown artifact ref: ${artifactRef}`));
      }
    }
  }
  for (const requirementId of blockingRequirementIds) {
    if ((ownerCounts.get(requirementId) ?? 0) !== 1) {
      issues.push(issue("requirement_owner_count", "slicePlan.slices", `blocking requirement must have exactly one owner slice: ${requirementId}`));
    }
  }
  validateSliceDependencies(pkg.slicePlan.slices, slicesById, issues);
}

function validateSliceDependencies(
  slices: GoalSliceV1[],
  slicesById: Map<string, GoalSliceV1>,
  issues: GoalDesignValidationIssue[],
): void {
  for (const [index, slice] of slices.entries()) {
    for (const dependencyId of slice.dependsOnSliceIds) {
      const dependency = slicesById.get(dependencyId);
      if (!dependency) {
        issues.push(issue("unknown_dependency_slice", `slicePlan.slices.${index}.dependsOnSliceIds`, `unknown slice dependency: ${dependencyId}`));
        continue;
      }
      if (!dependency.expectedArtifactRefs.some((ref) => slice.dependencyArtifactRefs.includes(ref))) {
        issues.push(issue("dependency_without_artifact_flow", `slicePlan.slices.${index}.dependencyArtifactRefs`, `slice ${slice.id} depends on ${dependencyId} without consuming an upstream artifact`));
      }
    }
  }
  if (hasCycle(slices)) issues.push(issue("slice_dependency_cycle", "slicePlan.slices", "slice dependencies must be acyclic"));
}

function validateStrategyShape(
  slices: GoalSliceV1[],
  strategy: CompositionStrategyV1,
  issues: GoalDesignValidationIssue[],
): void {
  if (!nonEmpty(strategy.rationale)) {
    issues.push(issue("empty_rationale", "compositionStrategy.rationale", "composition strategy rationale is required"));
  }
  const strategyIds = [...strategy.sliceIds].sort();
  const sliceIds = slices.map((slice) => slice.id).sort();
  if (strategyIds.length !== new Set(strategyIds).size || JSON.stringify(strategyIds) !== JSON.stringify(sliceIds)) {
    issues.push(issue("strategy_slice_mismatch", "compositionStrategy.sliceIds", "strategy slice ids must cover each slice exactly once"));
  }
}

function hasCycle(slices: GoalSliceV1[]): boolean {
  const graph = new Map(slices.map((slice) => [slice.id, slice.dependsOnSliceIds]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependencyId of graph.get(id) ?? []) {
      if (graph.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...graph.keys()].some(visit);
}

function issue(code: GoalDesignValidationIssue["code"], path: string, message: string): GoalDesignValidationIssue {
  return { code, path, message };
}

function exactKeys(object: Record<string, unknown>, keys: string[], path: string): void {
  const unexpected = Object.keys(object).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) throw new Error(`${path} contains unexpected fields: ${unexpected.join(", ")}`);
  const missing = keys.filter((key) => !(key in object));
  if (missing.length > 0) throw new Error(`${path} is missing required fields: ${missing.join(", ")}`);
}

function exactOptionalKeys(
  object: Record<string, unknown>,
  requiredKeys: string[],
  optionalKeys: string[],
  path: string,
): void {
  const allowedKeys = [...requiredKeys, ...optionalKeys];
  const unexpected = Object.keys(object).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) throw new Error(`${path} contains unexpected fields: ${unexpected.join(", ")}`);
  const missing = requiredKeys.filter((key) => !(key in object));
  if (missing.length > 0) throw new Error(`${path} is missing required fields: ${missing.join(", ")}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((entry, index) => string(entry, `${path}.${index}`));
}

function string(value: unknown, path: string): string {
  if (!nonEmpty(value)) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
