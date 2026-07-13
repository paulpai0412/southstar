import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { findApprovedLibraryObjectsByKind } from "../design-library/library-graph-store.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { RequirementValidationBindingV1 } from "../design-library/types.ts";
import {
  goalContractHash,
  type GoalContractV1,
  type GoalExpectedArtifactV1,
} from "./goal-contract.ts";
import type { LlmTextClient } from "./llm-composer.ts";
import type { WorkspaceGoalDiscoveryV1 } from "./goal-workspace-discovery.ts";
import {
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

export type RequirementEvaluatorContractV1 = {
  schemaVersion: "southstar.requirement_evaluator_contract.v1";
  id: string;
  requirementId: string;
  acceptanceCriteria: string[];
  requiredEvidenceKinds: string[];
  independence: "independent";
  failureClassifications: string[];
};

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

export type GoalDesignPackageV1 = {
  schemaVersion: "southstar.goal_design_package.v1";
  revision: number;
  parentRevision?: number;
  goalContract: GoalContractV1;
  evaluatorContracts: RequirementEvaluatorContractV1[];
  slicePlan: GoalSlicePlanV1;
  compositionStrategy: CompositionStrategyV1;
  templatePolicy: WorkflowTemplatePolicyV1;
  goalContractHash: string;
  evaluatorContractsHash: string;
  slicePlanHash: string;
  packageHash: string;
  goalDesignSkillRef: string;
  goalDesignSkillVersionRef: string;
  workspaceDiscoveryHash: string;
  mode: GoalDesignMode;
};

export type GoalDesignPackageV2 = {
  schemaVersion: "southstar.goal_design_package.v2";
  revision: number;
  parentRevision?: number;
  goalContract: GoalContractV1;
  requirementDraftHash: string;
  validationBindings: RequirementValidationBindingV1[];
  slicePlan: GoalSlicePlanV1;
  compositionStrategy: CompositionStrategyV1;
  templatePolicy: WorkflowTemplatePolicyV1;
  goalContractHash: string;
  validationBindingsHash: string;
  slicePlanHash: string;
  packageHash: string;
  goalDesignSkillRef: string;
  goalDesignSkillVersionRef: string;
  workspaceDiscoveryHash: string;
  mode: GoalDesignMode;
};

export type GoalDesignPackage = GoalDesignPackageV1 | GoalDesignPackageV2;

export type GoalSliceDesigner = {
  design(input: {
    goalContract: GoalContractV1;
    requirementDraft: GoalRequirementDraftV1;
    validationBindings: RequirementValidationBindingV1[];
    workspaceDiscovery: WorkspaceGoalDiscoveryV1;
    mode: GoalDesignMode;
    templatePolicy: WorkflowTemplatePolicyV1;
    skill: ResolvedGoalDesignSkillV1;
    onDelta?: (text: string) => void;
  }): Promise<GoalDesignPackageV2>;
};

export type GoalDesignSteeringProposalV1 =
  | {
      kind: "revision";
      package: GoalDesignPackageV1;
      summary: string;
      changedSliceIds: string[];
    }
  | {
      kind: "needs_input";
      question: string;
    };

export type GoalDesigner = {
  design(input: {
    goalContract: GoalContractV1;
    workspaceDiscovery: WorkspaceGoalDiscoveryV1;
    mode: GoalDesignMode;
    templatePolicy: WorkflowTemplatePolicyV1;
    skill: ResolvedGoalDesignSkillV1;
  }): Promise<GoalDesignPackageV1>;
  revise(input: {
    currentPackage: GoalDesignPackageV1;
    message: string;
    selectedSliceId?: string;
  }): Promise<GoalDesignSteeringProposalV1>;
};

export type GoalDesignValidationIssue = {
  code:
    | "invalid_schema_version"
    | "goal_contract_hash_mismatch"
    | "evaluator_contracts_hash_mismatch"
    | "slice_plan_hash_mismatch"
    | "package_hash_mismatch"
    | "duplicate_evaluator_id"
    | "unknown_evaluator_requirement"
    | "evaluator_criteria_mismatch"
    | "duplicate_slice_id"
    | "unknown_slice_requirement"
    | "requirement_owner_count"
    | "unknown_evaluator_ref"
    | "unknown_dependency_slice"
    | "dependency_without_artifact_flow"
    | "slice_dependency_cycle"
    | "strategy_slice_mismatch"
    | "invalid_template_policy"
    | "invalid_mode"
    | "empty_rationale"
    | "invalid_requirement_draft_hash"
    | "validation_bindings_hash_mismatch"
    | "duplicate_validation_binding_id"
    | "invalid_validation_binding"
    | "binding_criteria_mismatch"
    | "requirement_missing_validation_binding"
    | "slice_missing_validation_binding";
  path: string;
  message: string;
};

type DesignGoalWithLlmInput = {
  goalContract: GoalContractV1;
  workspaceDiscovery: WorkspaceGoalDiscoveryV1;
  mode: GoalDesignMode;
  templatePolicy: WorkflowTemplatePolicyV1;
  skill?: ResolvedGoalDesignSkillV1;
  client: LlmTextClient;
  model: string;
};

type DesignGoalSlicesWithLlmInput = {
  goalContract: GoalContractV1;
  requirementDraft: GoalRequirementDraftV1;
  validationBindings: RequirementValidationBindingV1[];
  workspaceDiscovery: WorkspaceGoalDiscoveryV1;
  mode: GoalDesignMode;
  templatePolicy: WorkflowTemplatePolicyV1;
  skill: ResolvedGoalDesignSkillV1;
  client: LlmTextClient;
  model: string;
  onDelta?: (text: string) => void;
};

type LlmGoalDesignPayload = {
  evaluatorContracts: Array<Omit<RequirementEvaluatorContractV1, "schemaVersion"> & { schemaVersion?: string }>;
  slicePlan: { revision: number; slices: GoalSliceV1[] };
  compositionStrategy: CompositionStrategyV1;
};

type LlmGoalDesignRevisionPayload =
  | {
      kind: "revision";
      package: {
        evaluatorContracts: Array<Omit<RequirementEvaluatorContractV1, "schemaVersion"> & { schemaVersion?: string }>;
        slicePlan: { slices: GoalSliceV1[] };
        compositionStrategy: CompositionStrategyV1;
      };
      summary: string;
      changedSliceIds: string[];
    }
  | {
      kind: "needs_input";
      question: string;
    };

type LlmGoalSlicePayload = {
  slicePlan: { slices: GoalSliceV1[] };
  compositionStrategy: CompositionStrategyV1;
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

export async function designGoalWithLlm(
  db: SouthstarDb,
  input: DesignGoalWithLlmInput,
): Promise<{ package: GoalDesignPackageV1; skill: ResolvedGoalDesignSkillV1 }> {
  const skill = input.skill ?? await loadGoalDesignSkillPg(db);
  const basePrompt = renderDesignPrompt({ ...input, skill });
  let prompt = basePrompt;
  for (let attempt = 1; attempt <= MAX_DESIGN_ATTEMPTS; attempt += 1) {
    const response = await input.client.generateText({
      model: input.model,
      prompt,
      temperature: 0,
      cwd: input.goalContract.workspace.cwd,
    });
    try {
      const payload = parseGoalDesignPayload(response);
      const pkg = finalizeGoalDesignPackage({
        schemaVersion: "southstar.goal_design_package.v1",
        revision: payload.slicePlan.revision,
        goalContract: input.goalContract,
        evaluatorContracts: payload.evaluatorContracts.map((contract) => ({
          ...contract,
          schemaVersion: "southstar.requirement_evaluator_contract.v1",
        })),
        slicePlan: {
          schemaVersion: "southstar.goal_slice_plan.v1",
          goalContractHash: "host-filled",
          revision: payload.slicePlan.revision,
          slices: payload.slicePlan.slices,
        },
        compositionStrategy: payload.compositionStrategy,
        templatePolicy: input.templatePolicy,
        goalDesignSkillRef: skill.objectKey,
        goalDesignSkillVersionRef: skill.versionRef,
        workspaceDiscoveryHash: input.workspaceDiscovery.discoveryHash,
        mode: input.mode,
      });
      return { package: pkg, skill };
    } catch (error) {
      if (attempt === MAX_DESIGN_ATTEMPTS) throw error;
      prompt = [
        basePrompt,
        "",
        `The previous response was invalid: ${error instanceof Error ? error.message : String(error)}`,
        "Return one corrected JSON object only.",
        `PreviousResponse: ${response.slice(0, MAX_DESIGN_RESPONSE_CHARS)}`,
      ].join("\n");
    }
  }
  throw new Error("Goal Design exhausted attempts");
}

export async function designGoalSlicesWithLlm(
  input: DesignGoalSlicesWithLlmInput,
): Promise<GoalDesignPackageV2> {
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
      const pkg = finalizeGoalDesignPackageV2({
        schemaVersion: "southstar.goal_design_package.v2",
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
  };
}

export function createLlmGoalDesigner(
  db: SouthstarDb,
  input: { client: LlmTextClient; model: string },
): GoalDesigner {
  return {
    async design(designInput) {
      return (await designGoalWithLlm(db, {
        goalContract: designInput.goalContract,
        workspaceDiscovery: designInput.workspaceDiscovery,
        mode: designInput.mode,
        templatePolicy: designInput.templatePolicy,
        skill: designInput.skill,
        client: input.client,
        model: input.model,
      })).package;
    },
    async revise(revisionInput) {
      const skill = await loadGoalDesignSkillPg(db);
      if (
        skill.objectKey !== revisionInput.currentPackage.goalDesignSkillRef
        || skill.versionRef !== revisionInput.currentPackage.goalDesignSkillVersionRef
      ) {
        throw new Error("Goal Design skill version no longer matches the reviewed package");
      }
      const prompt = renderRevisionPrompt({
        skill,
        currentPackage: revisionInput.currentPackage,
        message: revisionInput.message,
        selectedSliceId: revisionInput.selectedSliceId,
      });
      const response = await input.client.generateText({
        model: input.model,
        prompt,
        temperature: 0,
        cwd: revisionInput.currentPackage.goalContract.workspace.cwd,
      });
      const payload = parseGoalDesignRevisionPayload(response);
      if (payload.kind === "needs_input") return payload;
      const current = revisionInput.currentPackage;
      const nextRevision = current.revision + 1;
      return {
        kind: "revision",
        summary: payload.summary,
        changedSliceIds: payload.changedSliceIds,
        package: finalizeGoalDesignPackage({
          schemaVersion: "southstar.goal_design_package.v1",
          revision: nextRevision,
          parentRevision: current.revision,
          goalContract: current.goalContract,
          evaluatorContracts: payload.package.evaluatorContracts.map((contract) => ({
            ...contract,
            schemaVersion: "southstar.requirement_evaluator_contract.v1",
          })),
          slicePlan: {
            schemaVersion: "southstar.goal_slice_plan.v1",
            goalContractHash: "host-filled",
            revision: nextRevision,
            slices: payload.package.slicePlan.slices,
          },
          compositionStrategy: payload.package.compositionStrategy,
          templatePolicy: current.templatePolicy,
          goalDesignSkillRef: current.goalDesignSkillRef,
          goalDesignSkillVersionRef: current.goalDesignSkillVersionRef,
          workspaceDiscoveryHash: current.workspaceDiscoveryHash,
          mode: current.mode,
        }),
      };
    },
  };
}

export function finalizeGoalDesignPackage(
  input: Omit<GoalDesignPackageV1,
    | "goalContractHash"
    | "evaluatorContractsHash"
    | "slicePlanHash"
    | "packageHash"
  >,
): GoalDesignPackageV1 {
  const goalHash = goalContractHash(input.goalContract);
  const evaluatorContractsHash = contentHashForPayload(input.evaluatorContracts);
  const slicePlan: GoalSlicePlanV1 = {
    ...input.slicePlan,
    schemaVersion: "southstar.goal_slice_plan.v1",
    goalContractHash: goalHash,
  };
  const slicePlanHash = contentHashForPayload(slicePlan);
  const withoutPackageHash = {
    ...input,
    goalContractHash: goalHash,
    evaluatorContractsHash,
    slicePlan,
    slicePlanHash,
  };
  const pkg: GoalDesignPackageV1 = {
    ...withoutPackageHash,
    packageHash: contentHashForPayload(withoutPackageHash),
  };
  const issues = validateGoalDesignPackage(pkg);
  if (issues.length > 0) {
    throw new Error(`invalid Goal Design package: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ")}`);
  }
  return pkg;
}

export function goalDesignPackageHash(pkg: GoalDesignPackageV1): string {
  const { packageHash: _packageHash, ...withoutPackageHash } = pkg;
  return contentHashForPayload(withoutPackageHash);
}

export function finalizeGoalDesignPackageV2(
  input: Omit<GoalDesignPackageV2,
    | "goalContractHash"
    | "validationBindingsHash"
    | "slicePlanHash"
    | "packageHash"
  >,
): GoalDesignPackageV2 {
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
    goalContractHash: goalHash,
    validationBindingsHash,
    slicePlan,
    slicePlanHash,
  };
  const pkg: GoalDesignPackageV2 = {
    ...withoutPackageHash,
    packageHash: contentHashForPayload(withoutPackageHash),
  };
  const issues = validateGoalDesignPackageV2(pkg);
  if (issues.length > 0) {
    throw new Error(`invalid Goal Design package v2: ${issues.map((entry) => `${entry.code} at ${entry.path}`).join("; ")}`);
  }
  return pkg;
}

export function goalDesignPackageV2Hash(pkg: GoalDesignPackageV2): string {
  const { packageHash: _packageHash, ...withoutPackageHash } = pkg;
  return contentHashForPayload(withoutPackageHash);
}

export function validateGoalDesignPackage(pkg: GoalDesignPackageV1): GoalDesignValidationIssue[] {
  const issues: GoalDesignValidationIssue[] = [];
  if (pkg.schemaVersion !== "southstar.goal_design_package.v1") {
    issues.push(issue("invalid_schema_version", "schemaVersion", "schemaVersion must be southstar.goal_design_package.v1"));
  }
  const expectedGoalHash = goalContractHash(pkg.goalContract);
  if (pkg.goalContractHash !== expectedGoalHash || pkg.slicePlan.goalContractHash !== expectedGoalHash) {
    issues.push(issue("goal_contract_hash_mismatch", "goalContractHash", "goal contract hashes must match package goalContract"));
  }
  if (pkg.evaluatorContractsHash !== contentHashForPayload(pkg.evaluatorContracts)) {
    issues.push(issue("evaluator_contracts_hash_mismatch", "evaluatorContractsHash", "evaluator contract hash is not canonical"));
  }
  if (pkg.slicePlanHash !== contentHashForPayload(pkg.slicePlan)) {
    issues.push(issue("slice_plan_hash_mismatch", "slicePlanHash", "slice plan hash is not canonical"));
  }
  if (pkg.packageHash !== goalDesignPackageHash(pkg)) {
    issues.push(issue("package_hash_mismatch", "packageHash", "package hash is not canonical"));
  }
  if (pkg.mode !== "review_before_compose" && pkg.mode !== "auto_until_blocked") {
    issues.push(issue("invalid_mode", "mode", "mode is not supported"));
  }
  validateTemplatePolicy(pkg.templatePolicy, issues);
  validateEvaluatorContracts(pkg, issues);
  validateSlices(pkg, issues);
  validateStrategy(pkg, issues);
  return issues;
}

export function validateGoalDesignPackageV2(pkg: GoalDesignPackageV2): GoalDesignValidationIssue[] {
  const issues: GoalDesignValidationIssue[] = [];
  if (pkg.schemaVersion !== "southstar.goal_design_package.v2") {
    issues.push(issue("invalid_schema_version", "schemaVersion", "schemaVersion must be southstar.goal_design_package.v2"));
  }
  const expectedGoalHash = goalContractHash(pkg.goalContract);
  if (pkg.goalContractHash !== expectedGoalHash || pkg.slicePlan.goalContractHash !== expectedGoalHash) {
    issues.push(issue("goal_contract_hash_mismatch", "goalContractHash", "goal contract hashes must match package goalContract"));
  }
  if (!nonEmpty(pkg.requirementDraftHash)) {
    issues.push(issue("invalid_requirement_draft_hash", "requirementDraftHash", "confirmed requirement draft hash is required"));
  }
  if (pkg.validationBindingsHash !== contentHashForPayload(pkg.validationBindings)) {
    issues.push(issue("validation_bindings_hash_mismatch", "validationBindingsHash", "validation bindings hash is not canonical"));
  }
  if (pkg.slicePlanHash !== contentHashForPayload(pkg.slicePlan)) {
    issues.push(issue("slice_plan_hash_mismatch", "slicePlanHash", "slice plan hash is not canonical"));
  }
  if (pkg.packageHash !== goalDesignPackageV2Hash(pkg)) {
    issues.push(issue("package_hash_mismatch", "packageHash", "package hash is not canonical"));
  }
  if (pkg.mode !== "review_before_compose" && pkg.mode !== "auto_until_blocked") {
    issues.push(issue("invalid_mode", "mode", "mode is not supported"));
  }
  validateTemplatePolicy(pkg.templatePolicy, issues);
  validateValidationBindings(pkg, issues);
  validateSlicesV2(pkg, issues);
  validateStrategyShape(pkg.slicePlan.slices, pkg.compositionStrategy, issues);
  return issues;
}

function goalDesignOutputSchemaPrompt(goalContract: GoalContractV1): string {
  return [
    "GoalDesignOutputSchema:",
    "{",
    "  evaluatorContracts: [{",
    "    id: string,",
    "    requirementId: string,",
    "    acceptanceCriteria: string[],",
    "    requiredEvidenceKinds: string[],",
    "    independence: \"independent\",",
    "    failureClassifications: string[]",
    "  }],",
    "  slicePlan: {",
    "    revision: integer,",
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
    "  compositionStrategy: {",
    "    mode: \"single-run\" | \"per-slice-runs\",",
    "    sliceIds: string[],",
    "    rationale: string",
    "  }",
    "}",
    `AllowedRequirementIds: ${JSON.stringify(goalContract.requirements.map((requirement) => requirement.id))}`,
    `AllowedGoalArtifactRefs: ${JSON.stringify(goalContract.expectedArtifactRefs)}`,
    "compositionStrategy.mode: \"single-run\" | \"per-slice-runs\"",
    "evaluatorContracts[].requirementId must use AllowedRequirementIds.",
    "evaluatorContracts[].acceptanceCriteria must include every acceptance criterion from its referenced GoalContract requirement; do not invent unrelated criteria.",
    "evaluatorContracts[].independence must be \"independent\".",
    "slicePlan.slices[].requirementIds must use AllowedRequirementIds.",
    "slicePlan.slices[].expectedArtifactRefs and dependencyArtifactRefs must use AllowedGoalArtifactRefs.",
    "slicePlan.slices[].evaluatorContractRefs may reference only evaluatorContracts[].id declared in this response.",
    "Every blocking requirement in GoalContract must be owned by exactly one slice.",
    "Only add dependsOnSliceIds when dependencyArtifactRefs consumes an upstream slice artifact.",
  ].join("\n");
}

function goalDesignRevisionOutputSchemaPrompt(goalContract: GoalContractV1): string {
  return [
    goalDesignOutputSchemaPrompt(goalContract),
    "RevisionResponseSchema:",
    "{\"kind\":\"revision\",\"package\":{\"evaluatorContracts\":[],\"slicePlan\":{\"slices\":[]},\"compositionStrategy\":{}},\"summary\":\"string\",\"changedSliceIds\":[\"slice-id\"]}",
    "NeedsInputResponseSchema:",
    "{\"kind\":\"needs_input\",\"question\":\"string\"}",
    "For revision responses, omit slicePlan.revision; the host owns package revision and hashes.",
  ].join("\n");
}

function renderDesignPrompt(input: DesignGoalWithLlmInput & { skill: ResolvedGoalDesignSkillV1 }): string {
  return [
    "Use the approved Library Goal Design SOP to design this Goal Contract.",
    `GoalDesignSkillRef: ${input.skill.objectKey}`,
    `GoalDesignSkillVersionRef: ${input.skill.versionRef}`,
    input.skill.body,
    "",
    "Decompose the Goal Contract into the smallest cohesive outcome slices.",
    goalDesignOutputSchemaPrompt(input.goalContract),
    "Return JSON only with exactly evaluatorContracts, slicePlan, and compositionStrategy.",
    `Mode: ${input.mode}`,
    `TemplatePolicy: ${JSON.stringify(input.templatePolicy)}`,
    `WorkspaceDiscovery: ${JSON.stringify(input.workspaceDiscovery)}`,
    `GoalContract: ${JSON.stringify(input.goalContract)}`,
  ].join("\n");
}

function renderSliceDesignPrompt(input: DesignGoalSlicesWithLlmInput): string {
  const allowedRequirementIds = input.goalContract.requirements.map((requirement) => requirement.id);
  const allowedBindingIds = input.validationBindings.map((binding) => binding.id);
  const allowedArtifactRefs = [...new Set([
    ...input.goalContract.expectedArtifactRefs,
    ...input.validationBindings.flatMap((binding) => binding.artifactContractRefs),
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
    "evaluatorContractRefs is a legacy field name: fill it only with AllowedValidationBindingIds.",
    "Every blocking requirement must belong to exactly one slice and that slice must include its frozen validation binding ids.",
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

function renderRevisionPrompt(input: {
  skill: ResolvedGoalDesignSkillV1;
  currentPackage: GoalDesignPackageV1;
  message: string;
  selectedSliceId?: string;
}): string {
  return [
    "Use the approved Library Goal Design SOP to revise this reviewed Goal Design package.",
    `GoalDesignSkillRef: ${input.skill.objectKey}`,
    `GoalDesignSkillVersionRef: ${input.skill.versionRef}`,
    input.skill.body,
    "",
    "Return JSON only.",
    goalDesignRevisionOutputSchemaPrompt(input.currentPackage.goalContract),
    "If the request is ambiguous, return {\"kind\":\"needs_input\",\"question\":\"...\"}.",
    "If the request is actionable, return {\"kind\":\"revision\",\"package\":{\"evaluatorContracts\":[],\"slicePlan\":{\"slices\":[]},\"compositionStrategy\":{}},\"summary\":\"...\",\"changedSliceIds\":[]}.",
    "The package must contain complete evaluatorContracts, complete slicePlan.slices, and complete compositionStrategy.",
    "Do not change templatePolicy, goalContract, workspace cwd, mode, skill refs, hashes, package revision, or parent revision; the host owns those fields.",
    `SelectedSliceId: ${input.selectedSliceId ?? ""}`,
    `UserMessage: ${input.message}`,
    `CurrentGoalDesignPackage: ${JSON.stringify(input.currentPackage)}`,
  ].join("\n");
}

function parseGoalDesignPayload(text: string): LlmGoalDesignPayload {
  if (text.length > MAX_DESIGN_RESPONSE_CHARS) throw new Error("Goal Design response is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error("Goal Design returned invalid JSON");
  }
  const object = record(parsed, "$");
  exactKeys(object, ["evaluatorContracts", "slicePlan", "compositionStrategy"], "$");
  const slicePlan = record(object.slicePlan, "slicePlan");
  const compositionStrategy = record(object.compositionStrategy, "compositionStrategy");
  return {
    evaluatorContracts: array(object.evaluatorContracts, "evaluatorContracts").map(parseEvaluatorContract),
    slicePlan: {
      revision: integer(slicePlan.revision, "slicePlan.revision"),
      slices: array(slicePlan.slices, "slicePlan.slices").map(parseSlice),
    },
    compositionStrategy: parseCompositionStrategy(compositionStrategy),
  };
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
    if (!draftRequirement
      || normalizedCriteria(draftRequirement.statement) !== normalizedCriteria(requirement.statement)
      || !sameCriteria(
        draftRequirement.acceptanceCriteria.map((criterion) => criterion.statement),
        requirement.acceptanceCriteria,
      )) {
      throw new Error(`confirmed requirement does not match Goal Contract: ${requirement.id}`);
    }
  }
  if (input.validationBindings.length === 0 && input.goalContract.requirements.some((requirement) => requirement.blocking)) {
    throw new Error("blocking Goal Contract requires frozen validation bindings before Slice Design");
  }
}

function hostFinalizeSlicePayload(
  payload: LlmGoalSlicePayload,
  goalContract: GoalContractV1,
): { slices: GoalSliceV1[]; compositionStrategy: CompositionStrategyV1 } {
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
  };
}

function parseGoalDesignRevisionPayload(text: string): LlmGoalDesignRevisionPayload {
  if (text.length > MAX_DESIGN_RESPONSE_CHARS) throw new Error("Goal Design revision response is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error("Goal Design revision returned invalid JSON");
  }
  const object = record(parsed, "$");
  const kind = string(object.kind, "kind");
  if (kind === "needs_input") {
    exactKeys(object, ["kind", "question"], "$");
    return { kind, question: string(object.question, "question") };
  }
  if (kind !== "revision") throw new Error("Goal Design revision kind must be revision or needs_input");
  exactKeys(object, ["kind", "package", "summary", "changedSliceIds"], "$");
  const pkg = record(object.package, "package");
  exactKeys(pkg, ["evaluatorContracts", "slicePlan", "compositionStrategy"], "package");
  const slicePlan = record(pkg.slicePlan, "package.slicePlan");
  exactKeys(slicePlan, ["slices"], "package.slicePlan");
  return {
    kind,
    summary: string(object.summary, "summary"),
    changedSliceIds: stringArray(object.changedSliceIds, "changedSliceIds"),
    package: {
      evaluatorContracts: array(pkg.evaluatorContracts, "package.evaluatorContracts").map(parseEvaluatorContract),
      slicePlan: {
        slices: array(slicePlan.slices, "package.slicePlan.slices").map(parseSlice),
      },
      compositionStrategy: parseCompositionStrategy(record(pkg.compositionStrategy, "package.compositionStrategy")),
    },
  };
}

function parseEvaluatorContract(value: unknown, index: number): LlmGoalDesignPayload["evaluatorContracts"][number] {
  const object = record(value, `evaluatorContracts.${index}`);
  return {
    id: string(object.id, `evaluatorContracts.${index}.id`),
    requirementId: string(object.requirementId, `evaluatorContracts.${index}.requirementId`),
    acceptanceCriteria: stringArray(object.acceptanceCriteria, `evaluatorContracts.${index}.acceptanceCriteria`),
    requiredEvidenceKinds: stringArray(object.requiredEvidenceKinds, `evaluatorContracts.${index}.requiredEvidenceKinds`),
    independence: object.independence === "independent" ? "independent" : fail(`evaluatorContracts.${index}.independence must be independent`),
    failureClassifications: stringArray(object.failureClassifications, `evaluatorContracts.${index}.failureClassifications`),
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

function validateEvaluatorContracts(pkg: GoalDesignPackageV1, issues: GoalDesignValidationIssue[]): void {
  const requirementsById = new Map(pkg.goalContract.requirements.map((requirement) => [requirement.id, requirement]));
  const evaluatorIds = new Set<string>();
  for (const [index, evaluator] of pkg.evaluatorContracts.entries()) {
    if (evaluatorIds.has(evaluator.id)) issues.push(issue("duplicate_evaluator_id", `evaluatorContracts.${index}.id`, `duplicate evaluator id: ${evaluator.id}`));
    evaluatorIds.add(evaluator.id);
    const requirement = requirementsById.get(evaluator.requirementId);
    if (!requirement) {
      issues.push(issue("unknown_evaluator_requirement", `evaluatorContracts.${index}.requirementId`, `unknown requirement id: ${evaluator.requirementId}`));
      continue;
    }
    const evaluatorCriteria = new Set(evaluator.acceptanceCriteria.map(normalizedCriteria));
    const missingCriteria = requirement.acceptanceCriteria.filter((criterion) => !evaluatorCriteria.has(normalizedCriteria(criterion)));
    if (missingCriteria.length > 0) {
      issues.push(issue(
        "evaluator_criteria_mismatch",
        `evaluatorContracts.${index}.acceptanceCriteria`,
        `evaluator criteria must cover requirement criteria for ${evaluator.requirementId}`,
      ));
    }
  }
}

function validateValidationBindings(pkg: GoalDesignPackageV2, issues: GoalDesignValidationIssue[]): void {
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
    if (!sameCriteria(binding.acceptanceCriteria, requirement.acceptanceCriteria)) {
      issues.push(issue("binding_criteria_mismatch", `${path}.acceptanceCriteria`, `binding criteria must equal requirement criteria for ${binding.requirementId}`));
    }
    const criterionIds = new Set(binding.criterionIds);
    const checkCriterionIds = binding.criterionChecks.map((check) => check.criterionId);
    const invalid = binding.schemaVersion !== "southstar.requirement_validation_binding.v1"
      || !nonEmpty(binding.id)
      || binding.criterionIds.length === 0
      || binding.criterionIds.length !== binding.acceptanceCriteria.length
      || criterionIds.size !== binding.criterionIds.length
      || binding.artifactContractRefs.length === 0
      || binding.artifactContractRefs.length !== binding.artifactContractVersionRefs.length
      || binding.artifactContractRefs.some((ref) => !nonEmpty(ref))
      || binding.artifactContractVersionRefs.some((ref) => !nonEmpty(ref))
      || !nonEmpty(binding.evaluatorProfileRef)
      || !nonEmpty(binding.evaluatorProfileVersionRef)
      || !verificationModes.has(binding.verificationMode)
      || binding.independence !== "independent"
      || binding.requiredEvidenceKinds.length === 0
      || binding.requiredEvidenceKinds.some((kind) => !nonEmpty(kind))
      || binding.criterionChecks.length !== binding.criterionIds.length
      || new Set(checkCriterionIds).size !== checkCriterionIds.length
      || !sameStringSet(checkCriterionIds, binding.criterionIds)
      || binding.criterionChecks.some((check) => (
        !nonEmpty(check.procedureRef)
        || check.expectedEvidenceKinds.length === 0
        || check.expectedEvidenceKinds.some((kind) => !nonEmpty(kind))
      ));
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
    if (requirement.blocking && bindingCount === 0) {
      issues.push(issue(
        "requirement_missing_validation_binding",
        "validationBindings",
        `blocking requirement has no frozen validation binding: ${requirement.id}`,
      ));
    }
  }
}

function normalizedCriteria(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function sameCriteria(left: string[], right: string[]): boolean {
  return sameStringSet(left.map(normalizedCriteria), right.map(normalizedCriteria));
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === new Set(sortedLeft).size
    && sortedRight.length === new Set(sortedRight).size
    && JSON.stringify(sortedLeft) === JSON.stringify(sortedRight);
}

function validateSlices(pkg: GoalDesignPackageV1, issues: GoalDesignValidationIssue[]): void {
  const requirementIds = new Set(pkg.goalContract.requirements.map((requirement) => requirement.id));
  const blockingRequirementIds = new Set(pkg.goalContract.requirements.filter((requirement) => requirement.blocking).map((requirement) => requirement.id));
  const evaluatorIds = new Set(pkg.evaluatorContracts.map((evaluator) => evaluator.id));
  const contractArtifactRefs = new Set(pkg.goalContract.expectedArtifactRefs);
  const slicesById = new Map<string, GoalSliceV1>();
  const ownerCounts = new Map<string, number>();
  for (const [index, slice] of pkg.slicePlan.slices.entries()) {
    if (slicesById.has(slice.id)) issues.push(issue("duplicate_slice_id", `slicePlan.slices.${index}.id`, `duplicate slice id: ${slice.id}`));
    slicesById.set(slice.id, slice);
    for (const requirementId of slice.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        issues.push(issue("unknown_slice_requirement", `slicePlan.slices.${index}.requirementIds`, `unknown requirement id: ${requirementId}`));
      }
      ownerCounts.set(requirementId, (ownerCounts.get(requirementId) ?? 0) + 1);
    }
    for (const evaluatorRef of slice.evaluatorContractRefs) {
      if (!evaluatorIds.has(evaluatorRef)) issues.push(issue("unknown_evaluator_ref", `slicePlan.slices.${index}.evaluatorContractRefs`, `unknown evaluator ref: ${evaluatorRef}`));
    }
    for (const artifactRef of slice.expectedArtifactRefs) {
      if (!contractArtifactRefs.has(artifactRef)) {
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

function validateSlicesV2(pkg: GoalDesignPackageV2, issues: GoalDesignValidationIssue[]): void {
  const requirementIds = new Set(pkg.goalContract.requirements.map((requirement) => requirement.id));
  const blockingRequirementIds = new Set(pkg.goalContract.requirements
    .filter((requirement) => requirement.blocking)
    .map((requirement) => requirement.id));
  const bindingsById = new Map(pkg.validationBindings.map((binding) => [binding.id, binding]));
  const bindingsByRequirement = new Map<string, RequirementValidationBindingV1[]>();
  for (const binding of pkg.validationBindings) {
    bindingsByRequirement.set(binding.requirementId, [
      ...(bindingsByRequirement.get(binding.requirementId) ?? []),
      binding,
    ]);
  }
  const allowedArtifactRefs = new Set([
    ...pkg.goalContract.expectedArtifactRefs,
    ...pkg.validationBindings.flatMap((binding) => binding.artifactContractRefs),
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

function validateStrategy(pkg: GoalDesignPackageV1, issues: GoalDesignValidationIssue[]): void {
  validateStrategyShape(pkg.slicePlan.slices, pkg.compositionStrategy, issues);
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

function integer(value: unknown, path: string): number {
  if (!Number.isInteger(value)) throw new Error(`${path} must be an integer`);
  return value as number;
}

function string(value: unknown, path: string): string {
  if (!nonEmpty(value)) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(message: string): never {
  throw new Error(message);
}
