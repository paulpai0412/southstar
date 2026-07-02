import type {
  CandidatePacket,
  CandidateSummary,
  LibraryDefinitionKind,
  WorkflowCompositionPlan,
  WorkflowCompositionTask,
  WorkflowCompositionValidationIssue,
} from "../design-library/types.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "./composer.ts";

export type LlmTextClient = {
  generateText(input: { model: string; prompt: string; temperature?: number }): Promise<string>;
  generateTextStream?: (
    input: { model: string; prompt: string; temperature?: number },
    handlers: { onDelta?: (text: string) => void },
  ) => Promise<string>;
};

export type LlmWorkflowComposerOptions = {
  model: string;
  client: LlmTextClient;
  maxOutputChars?: number;
  temperature?: number;
};

const LIBRARY_DEFINITION_KIND_VALUES: readonly LibraryDefinitionKind[] = [
  "agent_spec",
  "agent_definition",
  "agent_profile",
  "skill_definition",
  "mcp_tool_grant",
  "artifact_contract",
  "evaluator_profile",
  "capability_spec",
  "contract_spec",
  "validator_spec",
  "policy_bundle",
  "workflow_template",
  "workflow_recipe",
  "tool_definition",
  "instruction_template",
  "vault_lease_policy",
  "skill_spec",
] as const;

const LIBRARY_DEFINITION_KIND_SET = new Set<string>(LIBRARY_DEFINITION_KIND_VALUES);

export const WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SouthstarWorkflowCompositionPlanV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "title",
    "selectedWorkflowTemplateRef",
    "rationale",
    "tasks",
    "rejectedCandidates",
    "generatedComponentProposals",
  ],
  properties: {
    schemaVersion: { const: "southstar.workflow_composition_plan.v1" },
    title: { type: "string", minLength: 1 },
    selectedWorkflowTemplateRef: { type: "string", minLength: 1 },
    rationale: { type: "string", minLength: 1 },
    tasks: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/task" },
    },
    rejectedCandidates: {
      type: "array",
      items: { $ref: "#/$defs/rejectedCandidate" },
    },
    generatedComponentProposals: {
      type: "array",
      items: { $ref: "#/$defs/generatedComponentProposal" },
    },
  },
  $defs: {
    task: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "name",
        "responsibility",
        "dependsOn",
        "templateSlotRef",
        "agentDefinitionRef",
        "agentProfileRef",
        "instructionRefs",
        "skillRefs",
        "toolGrantRefs",
        "mcpGrantRefs",
        "vaultLeasePolicyRefs",
        "inputArtifactRefs",
        "outputArtifactRefs",
        "evaluatorProfileRef",
        "recoveryStrategyRefs",
        "rationale",
      ],
      properties: {
        id: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        responsibility: { type: "string", minLength: 1 },
        dependsOn: { type: "array", items: { type: "string", minLength: 1 } },
        templateSlotRef: { type: "string", minLength: 1 },
        agentDefinitionRef: { type: "string", minLength: 1 },
        agentProfileRef: { type: "string", minLength: 1 },
        instructionRefs: { type: "array", items: { type: "string", minLength: 1 } },
        skillRefs: { type: "array", items: { type: "string", minLength: 1 } },
        toolGrantRefs: { type: "array", items: { type: "string", minLength: 1 } },
        mcpGrantRefs: { type: "array", items: { type: "string", minLength: 1 } },
        vaultLeasePolicyRefs: { type: "array", items: { type: "string", minLength: 1 } },
        inputArtifactRefs: { type: "array", items: { type: "string", minLength: 1 } },
        outputArtifactRefs: { type: "array", items: { type: "string", minLength: 1 } },
        evaluatorProfileRef: { type: "string", minLength: 1 },
        contextPolicyRef: { type: "string", minLength: 1 },
        workspacePolicyRef: { type: "string", minLength: 1 },
        recoveryStrategyRefs: { type: "array", items: { type: "string", minLength: 1 } },
        rationale: { type: "string", minLength: 1 },
      },
    },
    rejectedCandidate: {
      type: "object",
      additionalProperties: false,
      required: ["ref", "reason"],
      properties: {
        ref: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
      },
    },
    generatedComponentProposal: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "risk", "reason", "validationStatus"],
      properties: {
        id: { type: "string", minLength: 1 },
        kind: { type: "string", enum: LIBRARY_DEFINITION_KIND_VALUES },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        reason: { type: "string", minLength: 1 },
        validationStatus: { type: "string", enum: ["validated", "unvalidated"] },
      },
    },
  },
} as const;

export class LlmComposerOutputError extends Error {
  constructor(public readonly issues: WorkflowCompositionValidationIssue[]) {
    super(`LLM workflow composer output failed contract validation: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.name = "LlmComposerOutputError";
  }
}

export class LlmWorkflowComposer implements WorkflowComposer {
  constructor(private readonly options: LlmWorkflowComposerOptions) {}

  async compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    const prompt = renderComposerPrompt(input.goalPrompt, input.candidatePacket);
    const textInput = {
      model: this.options.model,
      prompt,
      temperature: this.options.temperature ?? 0,
    };
    const text = this.options.client.generateTextStream
      ? await this.options.client.generateTextStream(textInput, { onDelta: input.onLlmDelta })
      : await this.options.client.generateText(textInput);
    return parseWorkflowCompositionPlanFromText(text, this.options.maxOutputChars ?? 100_000);
  }
}

export function parseWorkflowCompositionPlanFromText(text: string, maxOutputChars: number): WorkflowCompositionPlan {
  if (text.length > maxOutputChars) {
    throw new LlmComposerOutputError([
      issue(
        "composer_output_too_large",
        "$",
        `LLM workflow composer output exceeded max output size: ${text.length} > ${maxOutputChars}`,
      ),
    ]);
  }

  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      throw new LlmComposerOutputError([
        issue("composer_output_non_json", "$", "LLM workflow composer returned non-JSON output"),
      ]);
    }
    throw new LlmComposerOutputError([
      issue(
        "composer_output_invalid_json",
        "$",
        `LLM workflow composer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ]);
  }

  const issues = validateStrictWorkflowCompositionPlan(parsed);
  if (issues.length > 0) {
    throw new LlmComposerOutputError(issues);
  }
  return parsed as WorkflowCompositionPlan;
}

export function renderComposerPrompt(goalPrompt: string, candidatePacket: CandidatePacket): string {
  const boundedPacket = boundCandidatePacket(candidatePacket);
  return [
    "You are Southstar's library-constrained workflow architect.",
    "Return exactly one JSON object matching schemaVersion southstar.workflow_composition_plan.v1.",
    "Do not return markdown, comments, prose, or multiple JSON objects.",
    "Do not use alias fields. Use exactly the property names defined in OutputJsonSchema.",
    "Select refs only from the candidate packet.",
    "Do not output runtime manifests, secrets, credentials, tool grant definitions, MCP grant definitions, or vault lease values.",
    "You may propose a generated agent profile only by combining refs from profilePrimitiveCandidates.",
    "When selecting a generated profile, include it in generatedComponentProposals with kind agent_profile and validationStatus validated.",
    "Generated component proposals are proposal-only unless they are validated agent_profile proposals selected as agentProfileRef.",
    "Use SkillGuidance as workflow-shaping guidance. Prefer the smallest sufficient DAG; add review or summary nodes only when the skill guidance and task risk justify them.",
    "",
    `Goal: ${goalPrompt}`,
    "",
    "SkillGuidance:",
    renderSkillGuidance(boundedPacket),
    "",
    "ProfilePrimitiveCandidates:",
    JSON.stringify(boundedPacket.profilePrimitiveCandidates ?? {
      agents: [],
      skills: [],
      tools: [],
      mcpGrants: [],
      instructions: [],
    }),
    "",
    "OutputJsonSchema:",
    JSON.stringify(WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA),
    "",
    "CandidatePacket:",
    JSON.stringify(boundedPacket),
  ].join("\n");
}

function renderSkillGuidance(packet: CandidatePacket): string {
  const lines: string[] = [];
  const seenRefs = new Set<string>();

  for (const [profileRef, candidates] of Object.entries(packet.skillCandidatesByProfile)) {
    for (const candidate of candidates) {
      if (seenRefs.has(candidate.ref)) continue;
      seenRefs.add(candidate.ref);
      const guidance = skillGuidanceLine(profileRef, candidate);
      if (guidance) lines.push(guidance);
      if (lines.length >= 40) return lines.join("\n");
    }
  }

  return lines.length > 0
    ? lines.join("\n")
    : "- No skill instructions were available; select the smallest valid workflow from approved candidate refs.";
}

function skillGuidanceLine(profileRef: string, candidate: CandidateSummary): string | null {
  const instructions = typeof candidate.state.instructions === "string"
    ? truncateForPrompt(candidate.state.instructions, 900)
    : "";
  const role = typeof candidate.state.role === "string" && candidate.state.role.length > 0
    ? ` role=${candidate.state.role}`
    : "";
  const artifactContracts = Array.isArray(candidate.state.artifactContracts)
    ? candidate.state.artifactContracts.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, 8)
    : [];
  const contracts = artifactContracts.length > 0 ? ` artifacts=${artifactContracts.join(",")}` : "";
  if (!instructions && !role && !contracts) return null;
  return `- ${candidate.ref} profile=${profileRef}${role}${contracts}: ${instructions}`;
}

function truncateForPrompt(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function validateStrictWorkflowCompositionPlan(value: unknown): WorkflowCompositionValidationIssue[] {
  const issues: WorkflowCompositionValidationIssue[] = [];
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", "$", "plan must be a JSON object"));
    return issues;
  }

  validateObjectShape(
    value,
    [
      "schemaVersion",
      "title",
      "selectedWorkflowTemplateRef",
      "rationale",
      "tasks",
      "rejectedCandidates",
      "generatedComponentProposals",
    ],
    [
      "schemaVersion",
      "title",
      "selectedWorkflowTemplateRef",
      "rationale",
      "tasks",
      "rejectedCandidates",
      "generatedComponentProposals",
    ],
    "$",
    issues,
  );

  if (value.schemaVersion !== "southstar.workflow_composition_plan.v1") {
    issues.push(
      issue(
        "composer_output_schema_violation",
        "schemaVersion",
        "schemaVersion must be southstar.workflow_composition_plan.v1",
      ),
    );
  }
  requireString(value.title, "title", issues);
  requireString(value.selectedWorkflowTemplateRef, "selectedWorkflowTemplateRef", issues);
  requireString(value.rationale, "rationale", issues);

  if (!Array.isArray(value.tasks)) {
    issues.push(issue("composer_output_schema_violation", "tasks", "tasks must be an array"));
  } else {
    if (value.tasks.length === 0) {
      issues.push(issue("composer_output_schema_violation", "tasks", "tasks must contain at least 1 item"));
    }
    for (const [index, task] of value.tasks.entries()) {
      validateTask(task, index, issues);
    }
  }

  if (!Array.isArray(value.rejectedCandidates)) {
    issues.push(issue("composer_output_schema_violation", "rejectedCandidates", "rejectedCandidates must be an array"));
  } else {
    for (const [index, candidate] of value.rejectedCandidates.entries()) {
      validateRejectedCandidate(candidate, index, issues);
    }
  }

  if (!Array.isArray(value.generatedComponentProposals)) {
    issues.push(
      issue(
        "composer_output_schema_violation",
        "generatedComponentProposals",
        "generatedComponentProposals must be an array",
      ),
    );
  } else {
    for (const [index, proposal] of value.generatedComponentProposals.entries()) {
      validateGeneratedComponentProposal(proposal, index, issues);
    }
  }

  return issues;
}

function validateTask(value: unknown, index: number, issues: WorkflowCompositionValidationIssue[]): void {
  const path = `tasks.${index}`;
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "task must be an object"));
    return;
  }
  validateObjectShape(
    value,
    [
      ...TASK_STRING_FIELDS,
      ...TASK_STRING_ARRAY_FIELDS,
      "contextPolicyRef",
      "workspacePolicyRef",
    ],
    [...TASK_STRING_FIELDS, ...TASK_STRING_ARRAY_FIELDS],
    path,
    issues,
  );
  for (const field of TASK_STRING_FIELDS) {
    requireString(value[field], `${path}.${field}`, issues);
  }
  for (const field of TASK_STRING_ARRAY_FIELDS) {
    requireStringArray(value[field], `${path}.${field}`, issues);
  }
  if (value.contextPolicyRef !== undefined) {
    requireString(value.contextPolicyRef, `${path}.contextPolicyRef`, issues);
  }
  if (value.workspacePolicyRef !== undefined) {
    requireString(value.workspacePolicyRef, `${path}.workspacePolicyRef`, issues);
  }
}

function validateRejectedCandidate(value: unknown, index: number, issues: WorkflowCompositionValidationIssue[]): void {
  const path = `rejectedCandidates.${index}`;
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "rejected candidate must be an object"));
    return;
  }
  validateObjectShape(value, ["ref", "reason"], ["ref", "reason"], path, issues);
  requireString(value.ref, `${path}.ref`, issues);
  requireString(value.reason, `${path}.reason`, issues);
}

function validateGeneratedComponentProposal(
  value: unknown,
  index: number,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const path = `generatedComponentProposals.${index}`;
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "generated component proposal must be an object"));
    return;
  }
  validateObjectShape(
    value,
    ["id", "kind", "risk", "reason", "validationStatus"],
    ["id", "kind", "risk", "reason", "validationStatus"],
    path,
    issues,
  );
  requireString(value.id, `${path}.id`, issues);
  requireString(value.reason, `${path}.reason`, issues);
  if (typeof value.kind !== "string" || !LIBRARY_DEFINITION_KIND_SET.has(value.kind)) {
    issues.push(
      issue(
        "composer_output_schema_violation",
        `${path}.kind`,
        `kind must be one of: ${LIBRARY_DEFINITION_KIND_VALUES.join(", ")}`,
      ),
    );
  }
  if (value.risk !== "low" && value.risk !== "medium" && value.risk !== "high") {
    issues.push(issue("composer_output_schema_violation", `${path}.risk`, "risk must be one of: low, medium, high"));
  }
  if (value.validationStatus !== "validated" && value.validationStatus !== "unvalidated") {
    issues.push(
      issue(
        "composer_output_schema_violation",
        `${path}.validationStatus`,
        "validationStatus must be one of: validated, unvalidated",
      ),
    );
  }
}

function validateObjectShape(
  value: Record<string, unknown>,
  allowedKeys: string[],
  requiredKeys: string[],
  path: string,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push(issue("composer_output_schema_violation", `${path}.${key}`, `unexpected property: ${key}`));
    }
  }
  for (const key of requiredKeys) {
    if (!(key in value)) {
      issues.push(issue("composer_output_schema_violation", `${path}.${key}`, `missing required property: ${key}`));
    }
  }
}

function requireString(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(issue("composer_output_schema_violation", path, "must be a non-empty string"));
  }
}

function requireStringArray(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "must be a string[]"));
    return;
  }
  if (value.some((item) => typeof item !== "string" || item.length === 0)) {
    issues.push(issue("composer_output_schema_violation", path, "must be a string[] with non-empty values"));
  }
}

function boundCandidatePacket(packet: CandidatePacket): CandidatePacket {
  return {
    ...packet,
    workflowTemplateCandidates: packet.workflowTemplateCandidates.slice(0, 20),
    agentCandidatesByCapability: boundCandidateMap(packet.agentCandidatesByCapability),
    profileCandidatesByAgent: boundCandidateMap(packet.profileCandidatesByAgent),
    skillCandidatesByProfile: boundCandidateMap(packet.skillCandidatesByProfile),
    toolCandidatesByProfile: boundCandidateMap(packet.toolCandidatesByProfile),
    mcpGrantCandidatesByProfile: boundCandidateMap(packet.mcpGrantCandidatesByProfile),
    vaultLeaseCandidatesByProfile: boundCandidateMap(packet.vaultLeaseCandidatesByProfile),
    instructionCandidatesByProfile: boundCandidateMap(packet.instructionCandidatesByProfile),
    artifactContractCandidates: packet.artifactContractCandidates.slice(0, 50),
    evaluatorCandidatesByArtifact: boundCandidateMap(packet.evaluatorCandidatesByArtifact),
    policyConstraints: packet.policyConstraints.slice(0, 50),
    profilePrimitiveCandidates: packet.profilePrimitiveCandidates
      ? {
        agents: packet.profilePrimitiveCandidates.agents.slice(0, 100),
        skills: packet.profilePrimitiveCandidates.skills.slice(0, 100),
        tools: packet.profilePrimitiveCandidates.tools.slice(0, 100),
        mcpGrants: packet.profilePrimitiveCandidates.mcpGrants.slice(0, 100),
        instructions: packet.profilePrimitiveCandidates.instructions.slice(0, 100),
      }
      : undefined,
  };
}

function boundCandidateMap<T>(candidateMap: Record<string, T[]>): Record<string, T[]> {
  return Object.fromEntries(
    Object.entries(candidateMap)
      .slice(0, 50)
      .map(([key, candidates]) => [key, candidates.slice(0, 20)]),
  );
}

function issue(
  code: WorkflowCompositionValidationIssue["code"],
  path: string,
  message: string,
): WorkflowCompositionValidationIssue {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

const TASK_STRING_FIELDS: Array<keyof WorkflowCompositionTask> = [
  "id",
  "name",
  "responsibility",
  "templateSlotRef",
  "agentDefinitionRef",
  "agentProfileRef",
  "evaluatorProfileRef",
  "rationale",
];

const TASK_STRING_ARRAY_FIELDS: Array<keyof WorkflowCompositionTask> = [
  "dependsOn",
  "instructionRefs",
  "skillRefs",
  "toolGrantRefs",
  "mcpGrantRefs",
  "vaultLeasePolicyRefs",
  "inputArtifactRefs",
  "outputArtifactRefs",
  "recoveryStrategyRefs",
];
