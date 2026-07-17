import { createHash } from "node:crypto";
import { canonicalJson as stableStringify } from "../design-library/canonical-json.ts";
import type { RequirementSpecV2 } from "../design-library/types.ts";
import type { ResolvedGoalDesignSkillV1 } from "./goal-design.ts";
import type { WorkspaceGoalDiscoveryV1 } from "./goal-workspace-discovery.ts";
import type { LlmTextClient } from "./llm-composer.ts";

export type GoalExpectedArtifactV1 = {
  description: string;
  path?: string;
  mediaType?: string;
};

export type GoalRequirementV1 = {
  id: string;
  statement: string;
  acceptanceCriteria: string[];
  /** LLM/user-confirmed outcome vocabulary; never host-hardcoded. */
  semanticTags?: string[];
  blocking: boolean;
  source: "explicit" | "inferred";
  expectedArtifacts: GoalExpectedArtifactV1[];
};

export type GoalContractV1 = {
  schemaVersion: "southstar.goal_contract.v1";
  originalPrompt: string;
  promptHash: string;
  revision: number;
  workspace: { cwd: string; projectRef?: string };
  domain: string;
  intent: string;
  workType: RequirementSpecV2["workType"];
  summary: string;
  requirements: GoalRequirementV1[];
  expectedArtifactRefs: string[];
  requiredCapabilities: string[];
  nonGoals: string[];
  assumptions: string[];
  blockingInputs: string[];
  riskTags: string[];
  requestedSideEffects: string[];
};

export type GoalContractInterpreter = {
  interpret(input: {
    goalPrompt: string;
    cwd: string;
    projectRef?: string;
    previousContract?: GoalContractV1;
    revisionPrompt?: string;
    libraryVocabulary?: GoalContractLibraryVocabulary;
    goalDesignSkill?: ResolvedGoalDesignSkillV1;
    workspaceDiscovery?: WorkspaceGoalDiscoveryV1;
    onDelta?: (text: string) => void;
  }): Promise<GoalContractV1>;
};

export type GoalContractLibraryVocabulary = {
  scopes: string[];
  capabilityRefs: string[];
  artifactRefs: string[];
  evaluatorRefs?: string[];
};

export type GoalContractVocabularyGapV1 = {
  kind: "domain" | "capability" | "artifact";
  requestedRef: string;
  allowedRefs: string[];
};

export class GoalContractVocabularyGapError extends Error {
  readonly code = "goal_contract_vocabulary_gap";

  constructor(
    readonly goalContract: GoalContractV1,
    readonly gaps: GoalContractVocabularyGapV1[],
  ) {
    super(`Goal Contract requires unapproved Library vocabulary: ${gaps.map((gap) => gap.requestedRef).join(", ")}`);
    this.name = "GoalContractVocabularyGapError";
  }
}

/** Semantic requirement payload accepted by host finalization. It contains no lineage fields. */
export type GoalRequirementSemanticV1 = Omit<GoalRequirementV1, "id" | "expectedArtifacts"> & {
  expectedArtifacts?: GoalExpectedArtifactV1[];
};

/**
 * Legacy Goal Contract interpretation input. The optional id is accepted only
 * when a host-owned, already-confirmed draft is projected into a contract;
 * LLM-facing interpreters must use GoalRequirementSemanticV1 and reject ids.
 */
export type GoalRequirementInterpretationV1 = GoalRequirementSemanticV1 & {
  /** Host-provided lineage id. LLM interpretation payloads must not include this field. */
  id?: string;
};

export type GoalContractInterpretationV1 = {
  domain: string;
  intent: string;
  workType?: RequirementSpecV2["workType"];
  summary: string;
  requirements: GoalRequirementInterpretationV1[];
  expectedArtifactRefs: string[];
  requiredCapabilities: string[];
  nonGoals: string[];
  assumptions: string[];
  blockingInputs: string[];
  riskTags: string[];
  requestedSideEffects: string[];
};

export type FinalizeGoalContractInputV1 = {
  goalPrompt: string;
  cwd: string;
  projectRef?: string;
  interpretation: GoalContractInterpretationV1;
};

export type ReviseGoalContractInputV1 = FinalizeGoalContractInputV1 & {
  previousContract: GoalContractV1;
};

type InterpretGoalContractWithLlmInput = {
  goalPrompt: string;
  cwd: string;
  projectRef?: string;
  previousContract?: GoalContractV1;
  revisionPrompt?: string;
  libraryVocabulary?: GoalContractLibraryVocabulary;
  goalDesignSkill?: ResolvedGoalDesignSkillV1;
  workspaceDiscovery?: WorkspaceGoalDiscoveryV1;
  onDelta?: (text: string) => void;
  client: LlmTextClient;
  model: string;
};

const INTERPRETATION_KEYS = [
  "domain",
  "intent",
  "workType",
  "summary",
  "requirements",
  "expectedArtifactRefs",
  "requiredCapabilities",
  "nonGoals",
  "assumptions",
  "blockingInputs",
  "riskTags",
  "requestedSideEffects",
] as const;
const LEGACY_INTERPRETATION_KEYS = [
  "domain",
  "intent",
  "summary",
  "requirements",
  "expectedArtifactRefs",
  "requiredCapabilities",
  "nonGoals",
  "assumptions",
  "blockingInputs",
  "riskTags",
  "requestedSideEffects",
] as const;

const REQUIREMENT_KEYS = ["statement", "acceptanceCriteria", "blocking", "source", "expectedArtifacts"] as const;
const REQUIREMENT_KEYS_WITH_SEMANTIC_TAGS = [...REQUIREMENT_KEYS, "semanticTags"] as const;
const LEGACY_REQUIREMENT_KEYS = ["statement", "acceptanceCriteria", "blocking", "source"] as const;
const REQUIREMENT_KEYS_WITH_ID = ["id", ...REQUIREMENT_KEYS] as const;
const LEGACY_REQUIREMENT_KEYS_WITH_ID = ["id", ...LEGACY_REQUIREMENT_KEYS] as const;
const WORK_TYPES = new Set<RequirementSpecV2["workType"]>([
  "software_feature",
  "bugfix",
  "research",
  "data_analysis",
  "migration",
  "ops_recovery",
  "general",
]);

const INTERPRETER_INSTRUCTION = "Decompose compound outcomes into independently verifiable requirements. Requirements describe observable outcome slices; plan, implement, verify, repair, review, and release sequencing belong to workflow composition, not the Goal Contract.";
const MAX_INTERPRETER_ATTEMPTS = 2;
const MAX_REPAIR_RESPONSE_CHARS = 20_000;

export async function interpretGoalContractWithLlm(
  input: InterpretGoalContractWithLlmInput,
): Promise<GoalContractV1> {
  const originalPrompt = renderInterpreterPrompt(input);
  let prompt = originalPrompt;
  for (let attempt = 1; attempt <= MAX_INTERPRETER_ATTEMPTS; attempt += 1) {
    const deltas: string[] = [];
    const textInput = { model: input.model, prompt, temperature: 0, cwd: input.cwd };
    const text = input.client.generateTextStream
      ? await input.client.generateTextStream(textInput, { onDelta: (delta) => deltas.push(delta) })
      : await input.client.generateText(textInput);
    try {
      const interpretation = parseInterpretation(text);
      const finalizationInput = {
        goalPrompt: input.goalPrompt,
        cwd: input.cwd,
        ...(input.projectRef ? { projectRef: input.projectRef } : {}),
        interpretation,
      };
      const contract = input.previousContract
        ? reviseGoalContract({ ...finalizationInput, previousContract: input.previousContract })
        : finalizeGoalContract(finalizationInput);
      const gaps = goalContractVocabularyGaps(interpretation, input.libraryVocabulary);
      if (gaps.length > 0) throw new GoalContractVocabularyGapError(contract, gaps);
      for (const delta of deltas) input.onDelta?.(delta);
      return contract;
    } catch (error) {
      if (error instanceof GoalContractVocabularyGapError) throw error;
      if (attempt === MAX_INTERPRETER_ATTEMPTS) throw error;
      prompt = renderInterpreterRepairPrompt(originalPrompt, text, error);
    }
  }
  throw new Error("Goal Contract interpreter exhausted attempts");
}

export function finalizeGoalContract(input: FinalizeGoalContractInputV1): GoalContractV1 {
  validateHostInput(input);
  const interpretation = validateInterpretation(input.interpretation, { allowRequirementIds: true });
  return materializeContract(input, interpretation, 1);
}

export function reviseGoalContract(input: ReviseGoalContractInputV1): GoalContractV1 {
  validateHostInput(input);
  const interpretation = validateInterpretation(input.interpretation, { allowRequirementIds: true });
  const previousByStatement = new Map(
    input.previousContract.requirements.map((requirement) => [normalizeStatement(requirement.statement), requirement]),
  );
  const requirements = interpretation.requirements.map((requirement) => {
    const previous = previousByStatement.get(normalizeStatement(requirement.statement));
    return {
      ...requirement,
      id: previous?.id ?? requirementId(requirement.statement),
      source: previous?.source === "explicit" ? "explicit" as const : requirement.source,
    };
  });
  const includedStatements = new Set(requirements.map((requirement) => normalizeStatement(requirement.statement)));
  for (const requirement of input.previousContract.requirements) {
    if (requirement.source === "explicit" && !includedStatements.has(normalizeStatement(requirement.statement))) {
      requirements.push(structuredClone(requirement));
    }
  }
  return materializeContract(
    input,
    { ...interpretation, requirements },
    input.previousContract.revision + 1,
  );
}

export function goalContractHash(contract: GoalContractV1): string {
  return createHash("sha256").update(stableStringify(contract)).digest("hex");
}

export function storedGoalContract(value: unknown): GoalContractV1 | undefined {
  const contract = asRecord(value);
  const workspace = asRecord(contract.workspace);
  if (contract.schemaVersion !== "southstar.goal_contract.v1") return undefined;
  if (
    !nonEmptyString(contract.originalPrompt)
    || !nonEmptyString(contract.promptHash)
    || !Number.isInteger(contract.revision)
    || !nonEmptyString(workspace.cwd)
    || !nonEmptyString(contract.domain)
    || !nonEmptyString(contract.intent)
    || !WORK_TYPES.has(contract.workType as RequirementSpecV2["workType"])
    || !nonEmptyString(contract.summary)
  ) return undefined;
  if (workspace.projectRef !== undefined && !nonEmptyString(workspace.projectRef)) return undefined;
  const stringArrayFields = [
    "expectedArtifactRefs",
    "requiredCapabilities",
    "nonGoals",
    "assumptions",
    "blockingInputs",
    "riskTags",
    "requestedSideEffects",
  ];
  if (stringArrayFields.some((field) => !isStringArray(contract[field]))) return undefined;
  if (!Array.isArray(contract.requirements) || contract.requirements.length === 0) return undefined;
  if (!contract.requirements.every((value) => {
    const requirement = asRecord(value);
    return Boolean(
      nonEmptyString(requirement.id)
      && nonEmptyString(requirement.statement)
      && isStringArray(requirement.acceptanceCriteria)
      && (requirement.acceptanceCriteria as string[]).length > 0
      && (requirement.semanticTags === undefined || isStringArray(requirement.semanticTags))
      && typeof requirement.blocking === "boolean"
      && (requirement.source === "explicit" || requirement.source === "inferred")
      && Array.isArray(requirement.expectedArtifacts),
    );
  })) return undefined;
  return contract as GoalContractV1;
}

export function requirementSpecFromGoalContract(contract: GoalContractV1): RequirementSpecV2 {
  return {
    summary: contract.summary,
    workType: contract.workType,
    requiredCapabilities: [...contract.requiredCapabilities],
    expectedArtifacts: [...contract.expectedArtifactRefs],
    acceptanceCriteria: contract.requirements.flatMap((requirement) => requirement.acceptanceCriteria),
    nonGoals: [...contract.nonGoals],
    riskNotes: [...contract.riskTags],
    workspaceAssumptions: [...contract.assumptions],
    missingInputs: [...contract.blockingInputs],
  };
}

function materializeContract(
  input: Pick<FinalizeGoalContractInputV1, "goalPrompt" | "cwd" | "projectRef">,
  interpretation: GoalContractInterpretationV1 | (Omit<GoalContractInterpretationV1, "requirements"> & { requirements: GoalRequirementV1[] }),
  revision: number,
): GoalContractV1 {
  const requirements = materializedRequirements(interpretation.requirements);
  return {
    schemaVersion: "southstar.goal_contract.v1",
    originalPrompt: input.goalPrompt,
    promptHash: createHash("sha256").update(input.goalPrompt).digest("hex"),
    revision,
    workspace: {
      cwd: input.cwd,
      ...(input.projectRef ? { projectRef: input.projectRef } : {}),
    },
    domain: interpretation.domain,
    intent: interpretation.intent,
    workType: interpretation.workType ?? "general",
    summary: interpretation.summary,
    requirements,
    expectedArtifactRefs: expectedArtifactRefsForRequirements(requirements, interpretation.expectedArtifactRefs),
    requiredCapabilities: [...interpretation.requiredCapabilities],
    nonGoals: [...interpretation.nonGoals],
    assumptions: [...interpretation.assumptions],
    blockingInputs: [...interpretation.blockingInputs],
    riskTags: [...interpretation.riskTags],
    requestedSideEffects: [...interpretation.requestedSideEffects],
  };
}

function requirementId(statement: string): string {
  return `req-${createHash("sha256").update(statement.trim()).digest("hex").slice(0, 12)}`;
}

function materializedRequirements(
  requirements: Array<GoalRequirementInterpretationV1 | GoalRequirementV1>,
): GoalRequirementV1[] {
  const materialized = requirements.map((requirement) => ({
    ...requirement,
    id: typeof requirement.id === "string" && requirement.id.length > 0
      ? requirement.id
      : requirementId(requirement.statement),
    acceptanceCriteria: [...requirement.acceptanceCriteria],
    expectedArtifacts: [...(requirement.expectedArtifacts ?? [])],
  }));
  const ids = new Set<string>();
  for (const requirement of materialized) {
    if (ids.has(requirement.id)) throw new Error(`duplicate requirement id: ${requirement.id}`);
    ids.add(requirement.id);
  }
  return materialized;
}

function expectedArtifactRefsForRequirements(requirements: GoalRequirementV1[], fallbackRefs: string[]): string[] {
  const derived = requirements.flatMap((requirement) =>
    requirement.expectedArtifacts.map((_artifact, index) => `artifact.goal.${requirement.id}.${index + 1}`)
  );
  return derived.length > 0 ? derived : [...fallbackRefs];
}

function goalContractInterpretationSchemaPrompt(): string {
  return [
    "GoalContractInterpretationSchema:",
    "{",
    "  domain: string,",
    "  intent: string,",
    "  workType: \"software_feature\" | \"bugfix\" | \"research\" | \"data_analysis\" | \"migration\" | \"ops_recovery\" | \"general\",",
    "  summary: string,",
    "  requirements: [{",
    "    statement: string,",
    "    acceptanceCriteria: string[],",
    "    blocking: boolean,",
    "    source: \"explicit\" | \"inferred\",",
    "    semanticTags: string[] (short lower-case outcome/domain tags supplied by semantic interpretation),",
    "    expectedArtifacts: [{ description: string, path?: string, mediaType?: string }],",
    "  }],",
    "  expectedArtifactRefs: string[],",
    "  requiredCapabilities: string[],",
    "  nonGoals: string[],",
    "  assumptions: string[],",
    "  blockingInputs: string[],",
    "  riskTags: string[],",
    "  requestedSideEffects: string[]",
    "}",
    "Every array item must be a non-empty string unless the schema says it is an object.",
    "Use [] for empty arrays; do not use null, false, objects, or empty strings as array entries.",
    "requirements[].expectedArtifacts[].path must be omitted unless it is a safe relative path; never use absolute paths, URLs, artifact refs, or ../ segments.",
  ].join("\n");
}

function renderInterpreterPrompt(input: InterpretGoalContractWithLlmInput): string {
  return [
    "Interpret the user's goal as a strict Southstar Goal Contract JSON object.",
    INTERPRETER_INSTRUCTION,
    goalContractInterpretationSchemaPrompt(),
    "Return JSON only. Include exactly these fields: domain, intent, workType, summary, requirements, expectedArtifactRefs, requiredCapabilities, nonGoals, assumptions, blockingInputs, riskTags, requestedSideEffects.",
    "Each requirement must contain statement, acceptanceCriteria, semanticTags, blocking, source, and expectedArtifacts. semanticTags must be short lower-case or kebab-case concepts describing the product outcome and verification subject; do not use technical ids. Every requirement needs at least one observable acceptance criterion. source must be explicit or inferred.",
    "workType must be one of software_feature, bugfix, research, data_analysis, migration, ops_recovery, or general.",
    "expectedArtifacts are descriptions with optional relative paths and media types, not Library object refs.",
    "Set blocking=true for every requirement needed to satisfy the requested outcome; use blocking=false only when the user explicitly marks that requirement optional.",
    "Do not put details discoverable from the local workspace or Library in blockingInputs; workflow discovery tasks can inspect those sources.",
    "blockingInputs are only for information unavailable from the prompt, workspace, and Library that cannot be safely inferred without a user decision.",
    "For safe, reversible local/test implementation choices that the user did not specify, record explicit assumptions and acceptance criteria instead of blockingInputs.",
    "Reserve blockingInputs for decisions that would create irreversible external effects, legal/financial commitments, or unsafe ambiguity.",
    "Do not return host-owned fields such as schemaVersion, originalPrompt, promptHash, revision, workspace, or requirement ids.",
    `GoalPrompt: ${input.goalPrompt}`,
    `WorkspaceCwd: ${input.cwd}`,
    ...(input.projectRef ? [`ProjectRef: ${input.projectRef}`] : []),
    ...(input.previousContract ? [`PreviousGoalContract: ${stableStringify(input.previousContract)}`] : []),
    ...(input.revisionPrompt ? [`RevisionPrompt: ${input.revisionPrompt}`] : []),
    ...(input.goalDesignSkill ? [
      `GoalDesignSkillRef: ${input.goalDesignSkill.objectKey}`,
      `GoalDesignSkillVersionRef: ${input.goalDesignSkill.versionRef}`,
      input.goalDesignSkill.body,
    ] : []),
    ...(input.workspaceDiscovery ? [
      "WorkspaceDiscovery:",
      stableStringify(input.workspaceDiscovery),
    ] : []),
    ...(input.libraryVocabulary ? [
      "AvailableLibraryVocabulary:",
      stableStringify(input.libraryVocabulary),
      `AllowedScopes: ${JSON.stringify(input.libraryVocabulary.scopes)}`,
      `AllowedCapabilities: ${JSON.stringify(input.libraryVocabulary.capabilityRefs)}`,
      `AllowedArtifactRefs: ${JSON.stringify(input.libraryVocabulary.artifactRefs)}`,
      `AllowedEvaluatorRefs: ${JSON.stringify(input.libraryVocabulary.evaluatorRefs ?? [])}`,
      "Reuse listed refs when they match the requested outcome. When no listed ref truthfully represents a required concept, return one canonical proposed domain/capability/artifact ref for that concept; the host will stop composition and create a reviewable vocabulary gap. Never substitute an unrelated listed ref.",
    ] : []),
  ].join("\n");
}

function renderInterpreterRepairPrompt(originalPrompt: string, response: string, error: unknown): string {
  return [
    originalPrompt,
    "",
    `The previous response was invalid: ${error instanceof Error ? error.message : String(error)}`,
    "Return one corrected JSON object only. Preserve valid goal meaning while fixing every schema error.",
    `PreviousResponse: ${response.slice(0, MAX_REPAIR_RESPONSE_CHARS)}`,
  ].join("\n");
}

function parseInterpretation(text: string): GoalContractInterpretationV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error("Goal Contract interpreter returned invalid JSON");
  }
  return validateInterpretation(parsed, { requireWorkType: true });
}

function validateInterpretation(
  value: unknown,
  options: { requireWorkType?: boolean; allowRequirementIds?: boolean } = {},
): GoalContractInterpretationV1 {
  const object = requiredObject(value, "$");
  if (options.requireWorkType && !("workType" in object)) {
    throw new Error("$ is missing required fields: workType");
  }
  const allowedKeys = "workType" in object ? INTERPRETATION_KEYS : LEGACY_INTERPRETATION_KEYS;
  exactKeys(object, allowedKeys, "$");
  const requirements = requiredArray(object.requirements, "requirements");
  if (requirements.length === 0) throw new Error("requirements must contain at least one requirement");
  return {
    domain: requiredString(object.domain, "domain"),
    intent: requiredString(object.intent, "intent"),
    workType: optionalWorkType(object.workType),
    summary: requiredString(object.summary, "summary"),
    requirements: requirements.map((requirement, index) => validateRequirement(requirement, index, options)),
    expectedArtifactRefs: libraryRefArray(object.expectedArtifactRefs, "expectedArtifactRefs", "artifact."),
    requiredCapabilities: libraryRefArray(object.requiredCapabilities, "requiredCapabilities", "capability."),
    nonGoals: descriptiveStringArray(object.nonGoals, "nonGoals"),
    assumptions: descriptiveStringArray(object.assumptions, "assumptions"),
    blockingInputs: descriptiveStringArray(object.blockingInputs, "blockingInputs"),
    riskTags: descriptiveStringArray(object.riskTags, "riskTags"),
    requestedSideEffects: descriptiveStringArray(object.requestedSideEffects, "requestedSideEffects"),
  };
}

function goalContractVocabularyGaps(
  interpretation: GoalContractInterpretationV1,
  vocabulary: GoalContractLibraryVocabulary | undefined,
): GoalContractVocabularyGapV1[] {
  if (!vocabulary) return [];
  const gaps: GoalContractVocabularyGapV1[] = [];
  if (vocabulary.scopes.length > 0 && !vocabulary.scopes.includes(interpretation.domain)) {
    gaps.push({ kind: "domain", requestedRef: interpretation.domain, allowedRefs: [...vocabulary.scopes] });
  }
  const allowedCapabilities = new Set(vocabulary.capabilityRefs);
  const unknownCapabilities = interpretation.requiredCapabilities.filter((ref) => !allowedCapabilities.has(ref));
  gaps.push(...unknownCapabilities.map((requestedRef) => ({
    kind: "capability" as const,
    requestedRef,
    allowedRefs: [...vocabulary.capabilityRefs],
  })));
  const allowedArtifacts = new Set(vocabulary.artifactRefs);
  const unknownArtifactRefs = interpretation.expectedArtifactRefs.filter((ref) => !allowedArtifacts.has(ref));
  gaps.push(...unknownArtifactRefs.map((requestedRef) => ({
    kind: "artifact" as const,
    requestedRef,
    allowedRefs: [...vocabulary.artifactRefs],
  })));
  return gaps;
}

function validateRequirement(
  value: unknown,
  index: number,
  options: { allowRequirementIds?: boolean } = {},
): GoalRequirementInterpretationV1 {
  const path = `requirements.${index}`;
  const object = requiredObject(value, path);
  const hasId = options.allowRequirementIds === true && "id" in object;
  const allowedKeys = "expectedArtifacts" in object
    ? ("semanticTags" in object
      ? (hasId ? [...REQUIREMENT_KEYS_WITH_ID, "semanticTags"] : REQUIREMENT_KEYS_WITH_SEMANTIC_TAGS)
      : (hasId ? REQUIREMENT_KEYS_WITH_ID : REQUIREMENT_KEYS))
    : (hasId ? LEGACY_REQUIREMENT_KEYS_WITH_ID : LEGACY_REQUIREMENT_KEYS);
  exactKeys(object, allowedKeys, path);
  const acceptanceCriteria = stringArray(object.acceptanceCriteria, `${path}.acceptanceCriteria`);
  if (acceptanceCriteria.length === 0) {
    throw new Error(`${path}.acceptanceCriteria must contain at least one criterion`);
  }
  if (typeof object.blocking !== "boolean") throw new Error(`${path}.blocking must be a boolean`);
  if (object.source !== "explicit" && object.source !== "inferred") {
    throw new Error(`${path}.source must be explicit or inferred`);
  }
  return {
    ...(hasId ? { id: requiredString(object.id, `${path}.id`) } : {}),
    statement: requiredString(object.statement, `${path}.statement`),
    acceptanceCriteria,
    ...(object.semanticTags !== undefined ? { semanticTags: stringArray(object.semanticTags, `${path}.semanticTags`) } : {}),
    blocking: object.blocking,
    source: object.source,
    expectedArtifacts: expectedArtifactsArray(object.expectedArtifacts, `${path}.expectedArtifacts`),
  };
}

function validateHostInput(input: Pick<FinalizeGoalContractInputV1, "goalPrompt" | "cwd" | "projectRef">): void {
  requiredString(input.goalPrompt, "goalPrompt");
  requiredString(input.cwd, "cwd");
  if (input.projectRef !== undefined) requiredString(input.projectRef, "projectRef");
}

function requiredObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  return requiredArray(value, path).map((entry, index) => requiredString(entry, `${path}.${index}`));
}

function libraryRefArray(value: unknown, path: string, prefix: string): string[] {
  const refs = stringArray(value, path);
  const invalid = refs.find((ref) => !ref.startsWith(prefix) || ref.length === prefix.length);
  if (invalid) throw new Error(`${path} refs must start with ${prefix}; got ${invalid}`);
  return refs;
}

function descriptiveStringArray(value: unknown, path: string): string[] {
  return requiredArray(value, path).filter(nonEmptyString) as string[];
}

function optionalWorkType(value: unknown): RequirementSpecV2["workType"] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !WORK_TYPES.has(value as RequirementSpecV2["workType"])) {
    throw new Error("workType must be one of software_feature, bugfix, research, data_analysis, migration, ops_recovery, or general");
  }
  return value as RequirementSpecV2["workType"];
}

function expectedArtifactsArray(value: unknown, path: string): GoalExpectedArtifactV1[] {
  if (value === undefined) return [];
  return requiredArray(value, path).map((entry, index) => {
    const object = requiredObject(entry, `${path}.${index}`);
    const artifact: GoalExpectedArtifactV1 = {
      description: requiredString(object.description, `${path}.${index}.description`),
    };
    const artifactPath = optionalSafeRelativePath(object.path);
    if (artifactPath !== undefined) artifact.path = artifactPath;
    if (object.mediaType !== undefined) artifact.mediaType = requiredString(object.mediaType, `${path}.${index}.mediaType`);
    return artifact;
  });
}

function optionalSafeRelativePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const text = value;
  if (
    text.startsWith("/")
    || text.includes("\0")
    || text.split(/[\\/]+/).some((part) => part === ".." || part.length === 0)
  ) {
    return undefined;
  }
  return text;
}

function exactKeys(object: Record<string, unknown>, allowedKeys: readonly string[], path: string): void {
  const unexpected = Object.keys(object).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) throw new Error(`${path} contains unexpected fields: ${unexpected.join(", ")}`);
  const missing = allowedKeys.filter((key) => !(key in object));
  if (missing.length > 0) throw new Error(`${path} is missing required fields: ${missing.join(", ")}`);
}

function normalizeStatement(statement: string): string {
  return statement.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}
