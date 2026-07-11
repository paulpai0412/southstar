import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { findApprovedLibraryObjectsByKind } from "../design-library/library-graph-store.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  goalContractHash,
  type GoalContractV1,
  type GoalExpectedArtifactV1,
} from "./goal-contract.ts";
import type { LlmTextClient } from "./llm-composer.ts";
import type { WorkspaceGoalDiscoveryV1 } from "./goal-workspace-discovery.ts";

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
    | "empty_rationale";
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

type LlmGoalDesignPayload = {
  evaluatorContracts: Array<Omit<RequirementEvaluatorContractV1, "schemaVersion"> & { schemaVersion?: string }>;
  slicePlan: { revision: number; slices: GoalSliceV1[] };
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
    async revise() {
      throw new Error("Goal Design revision LLM flow is not implemented yet");
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

function renderDesignPrompt(input: DesignGoalWithLlmInput & { skill: ResolvedGoalDesignSkillV1 }): string {
  return [
    "Use the approved Library Goal Design SOP to design this Goal Contract.",
    `GoalDesignSkillRef: ${input.skill.objectKey}`,
    `GoalDesignSkillVersionRef: ${input.skill.versionRef}`,
    input.skill.body,
    "",
    "Decompose the Goal Contract into the smallest cohesive outcome slices.",
    "Return JSON only with exactly evaluatorContracts, slicePlan, and compositionStrategy.",
    `Mode: ${input.mode}`,
    `TemplatePolicy: ${JSON.stringify(input.templatePolicy)}`,
    `WorkspaceDiscovery: ${JSON.stringify(input.workspaceDiscovery)}`,
    `GoalContract: ${JSON.stringify(input.goalContract)}`,
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
  const requirementIds = new Set(pkg.goalContract.requirements.map((requirement) => requirement.id));
  const evaluatorIds = new Set<string>();
  for (const [index, evaluator] of pkg.evaluatorContracts.entries()) {
    if (evaluatorIds.has(evaluator.id)) issues.push(issue("duplicate_evaluator_id", `evaluatorContracts.${index}.id`, `duplicate evaluator id: ${evaluator.id}`));
    evaluatorIds.add(evaluator.id);
    if (!requirementIds.has(evaluator.requirementId)) {
      issues.push(issue("unknown_evaluator_requirement", `evaluatorContracts.${index}.requirementId`, `unknown requirement id: ${evaluator.requirementId}`));
    }
  }
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
  if (!nonEmpty(pkg.compositionStrategy.rationale)) {
    issues.push(issue("empty_rationale", "compositionStrategy.rationale", "composition strategy rationale is required"));
  }
  const strategyIds = [...pkg.compositionStrategy.sliceIds].sort();
  const sliceIds = pkg.slicePlan.slices.map((slice) => slice.id).sort();
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
  return value;
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
