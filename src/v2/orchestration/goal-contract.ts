import { createHash } from "node:crypto";
import { canonicalJson as stableStringify } from "../design-library/canonical-json.ts";
import type { RequirementSpecV2 } from "../design-library/types.ts";
import type { LlmTextClient } from "./llm-composer.ts";

export type GoalRequirementV1 = {
  id: string;
  statement: string;
  acceptanceCriteria: string[];
  blocking: boolean;
  source: "explicit" | "inferred";
};

export type GoalContractV1 = {
  schemaVersion: "southstar.goal_contract.v1";
  originalPrompt: string;
  promptHash: string;
  revision: number;
  workspace: { cwd: string; projectRef?: string };
  domain: string;
  intent: string;
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
    onDelta?: (text: string) => void;
  }): Promise<GoalContractV1>;
};

type GoalRequirementInterpretation = Omit<GoalRequirementV1, "id">;

type GoalContractInterpretation = {
  domain: string;
  intent: string;
  summary: string;
  requirements: GoalRequirementInterpretation[];
  expectedArtifactRefs: string[];
  requiredCapabilities: string[];
  nonGoals: string[];
  assumptions: string[];
  blockingInputs: string[];
  riskTags: string[];
  requestedSideEffects: string[];
};

type FinalizeGoalContractInput = {
  goalPrompt: string;
  cwd: string;
  projectRef?: string;
  interpretation: GoalContractInterpretation;
};

type ReviseGoalContractInput = FinalizeGoalContractInput & {
  previousContract: GoalContractV1;
};

type InterpretGoalContractWithLlmInput = {
  goalPrompt: string;
  cwd: string;
  projectRef?: string;
  previousContract?: GoalContractV1;
  revisionPrompt?: string;
  onDelta?: (text: string) => void;
  client: LlmTextClient;
  model: string;
};

const INTERPRETATION_KEYS = [
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

const REQUIREMENT_KEYS = ["statement", "acceptanceCriteria", "blocking", "source"] as const;

const INTERPRETER_INSTRUCTION = "Decompose compound outcomes into independently verifiable requirements. Requirements describe observable outcome slices; plan, implement, verify, repair, review, and release sequencing belong to workflow composition, not the Goal Contract.";

export async function interpretGoalContractWithLlm(
  input: InterpretGoalContractWithLlmInput,
): Promise<GoalContractV1> {
  const prompt = renderInterpreterPrompt(input);
  const textInput = { model: input.model, prompt, temperature: 0, cwd: input.cwd };
  const text = input.client.generateTextStream
    ? await input.client.generateTextStream(textInput, { onDelta: input.onDelta })
    : await input.client.generateText(textInput);
  const interpretation = parseInterpretation(text);
  const finalizationInput = {
    goalPrompt: input.goalPrompt,
    cwd: input.cwd,
    ...(input.projectRef ? { projectRef: input.projectRef } : {}),
    interpretation,
  };
  return input.previousContract
    ? reviseGoalContract({ ...finalizationInput, previousContract: input.previousContract })
    : finalizeGoalContract(finalizationInput);
}

export function finalizeGoalContract(input: FinalizeGoalContractInput): GoalContractV1 {
  validateHostInput(input);
  const interpretation = validateInterpretation(input.interpretation);
  return materializeContract(input, interpretation, 1);
}

export function reviseGoalContract(input: ReviseGoalContractInput): GoalContractV1 {
  validateHostInput(input);
  const interpretation = validateInterpretation(input.interpretation);
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
      && typeof requirement.blocking === "boolean"
      && (requirement.source === "explicit" || requirement.source === "inferred"),
    );
  })) return undefined;
  return contract as GoalContractV1;
}

export function requirementSpecFromGoalContract(contract: GoalContractV1): RequirementSpecV2 {
  return {
    summary: contract.summary,
    workType: workTypeFromContract(contract),
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
  input: Pick<FinalizeGoalContractInput, "goalPrompt" | "cwd" | "projectRef">,
  interpretation: GoalContractInterpretation | (Omit<GoalContractInterpretation, "requirements"> & { requirements: GoalRequirementV1[] }),
  revision: number,
): GoalContractV1 {
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
    summary: interpretation.summary,
    requirements: interpretation.requirements.map((requirement) => ({
      ...requirement,
      id: "id" in requirement ? requirement.id : requirementId(requirement.statement),
      acceptanceCriteria: [...requirement.acceptanceCriteria],
    })),
    expectedArtifactRefs: [...interpretation.expectedArtifactRefs],
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

function renderInterpreterPrompt(input: InterpretGoalContractWithLlmInput): string {
  return [
    "Interpret the user's goal as a strict Southstar Goal Contract JSON object.",
    INTERPRETER_INSTRUCTION,
    "Return JSON only. Include exactly these fields: domain, intent, summary, requirements, expectedArtifactRefs, requiredCapabilities, nonGoals, assumptions, blockingInputs, riskTags, requestedSideEffects.",
    "Each requirement must contain exactly statement, acceptanceCriteria, blocking, and source. Every requirement needs at least one observable acceptance criterion. source must be explicit or inferred.",
    "Do not return host-owned fields such as schemaVersion, originalPrompt, promptHash, revision, workspace, or requirement ids.",
    `GoalPrompt: ${input.goalPrompt}`,
    `WorkspaceCwd: ${input.cwd}`,
    ...(input.projectRef ? [`ProjectRef: ${input.projectRef}`] : []),
    ...(input.previousContract ? [`PreviousGoalContract: ${stableStringify(input.previousContract)}`] : []),
    ...(input.revisionPrompt ? [`RevisionPrompt: ${input.revisionPrompt}`] : []),
  ].join("\n");
}

function parseInterpretation(text: string): GoalContractInterpretation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error("Goal Contract interpreter returned invalid JSON");
  }
  return validateInterpretation(parsed);
}

function validateInterpretation(value: unknown): GoalContractInterpretation {
  const object = requiredObject(value, "$");
  exactKeys(object, INTERPRETATION_KEYS, "$");
  const requirements = requiredArray(object.requirements, "requirements");
  if (requirements.length === 0) throw new Error("requirements must contain at least one requirement");
  return {
    domain: requiredString(object.domain, "domain"),
    intent: requiredString(object.intent, "intent"),
    summary: requiredString(object.summary, "summary"),
    requirements: requirements.map((requirement, index) => validateRequirement(requirement, index)),
    expectedArtifactRefs: stringArray(object.expectedArtifactRefs, "expectedArtifactRefs"),
    requiredCapabilities: stringArray(object.requiredCapabilities, "requiredCapabilities"),
    nonGoals: stringArray(object.nonGoals, "nonGoals"),
    assumptions: stringArray(object.assumptions, "assumptions"),
    blockingInputs: stringArray(object.blockingInputs, "blockingInputs"),
    riskTags: stringArray(object.riskTags, "riskTags"),
    requestedSideEffects: stringArray(object.requestedSideEffects, "requestedSideEffects"),
  };
}

function validateRequirement(value: unknown, index: number): GoalRequirementInterpretation {
  const path = `requirements.${index}`;
  const object = requiredObject(value, path);
  exactKeys(object, REQUIREMENT_KEYS, path);
  const acceptanceCriteria = stringArray(object.acceptanceCriteria, `${path}.acceptanceCriteria`);
  if (acceptanceCriteria.length === 0) {
    throw new Error(`${path}.acceptanceCriteria must contain at least one criterion`);
  }
  if (typeof object.blocking !== "boolean") throw new Error(`${path}.blocking must be a boolean`);
  if (object.source !== "explicit" && object.source !== "inferred") {
    throw new Error(`${path}.source must be explicit or inferred`);
  }
  return {
    statement: requiredString(object.statement, `${path}.statement`),
    acceptanceCriteria,
    blocking: object.blocking,
    source: object.source,
  };
}

function validateHostInput(input: Pick<FinalizeGoalContractInput, "goalPrompt" | "cwd" | "projectRef">): void {
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

function workTypeFromContract(contract: GoalContractV1): RequirementSpecV2["workType"] {
  const classifier = `${contract.domain} ${contract.intent}`.toLowerCase();
  if (/bug|fix|repair/.test(classifier)) return "bugfix";
  if (/research|investigat/.test(classifier)) return "research";
  if (/data[_ /-]?analysis|analytics/.test(classifier)) return "data_analysis";
  if (/migrat/.test(classifier)) return "migration";
  if (/ops|operation|recover/.test(classifier)) return "ops_recovery";
  if (/software|implement|feature/.test(classifier)) return "software_feature";
  return "general";
}
