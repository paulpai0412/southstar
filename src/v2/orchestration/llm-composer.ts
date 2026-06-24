import type { CandidatePacket, WorkflowCompositionPlan } from "../design-library/types.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "./composer.ts";

export type LlmTextClient = {
  generateText(input: { model: string; prompt: string; temperature?: number }): Promise<string>;
};

export type LlmWorkflowComposerOptions = {
  model: string;
  client: LlmTextClient;
  maxOutputChars?: number;
  temperature?: number;
};

export class LlmWorkflowComposer implements WorkflowComposer {
  constructor(private readonly options: LlmWorkflowComposerOptions) {}

  async compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    const prompt = renderComposerPrompt(input.goalPrompt, input.candidatePacket);
    const text = await this.options.client.generateText({
      model: this.options.model,
      prompt,
      temperature: this.options.temperature ?? 0,
    });
    return parseWorkflowCompositionPlanFromText(text, this.options.maxOutputChars ?? 100_000);
  }
}

export function parseWorkflowCompositionPlanFromText(text: string, maxOutputChars: number): WorkflowCompositionPlan {
  if (text.length > maxOutputChars) {
    throw new Error(`LLM workflow composer output exceeded max output size: ${text.length} > ${maxOutputChars}`);
  }

  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      throw new Error("LLM workflow composer returned non-JSON output");
    }
    throw new Error(
      `LLM workflow composer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error("LLM workflow composer must return a JSON object");
  }
  if (parsed.schemaVersion !== "southstar.workflow_composition_plan.v1") {
    throw new Error("LLM workflow composer returned invalid schemaVersion");
  }
  if (!Array.isArray(parsed.tasks)) {
    throw new Error("LLM workflow composer returned plan without tasks array");
  }
  if (typeof parsed.title !== "string") {
    throw new Error("LLM workflow composer returned missing or invalid title");
  }
  if (typeof parsed.selectedWorkflowTemplateRef !== "string") {
    throw new Error("LLM workflow composer returned missing or invalid selectedWorkflowTemplateRef");
  }
  if (typeof parsed.rationale !== "string") {
    throw new Error("LLM workflow composer returned missing or invalid rationale");
  }
  if (!Array.isArray(parsed.rejectedCandidates)) {
    throw new Error("LLM workflow composer returned missing or invalid rejectedCandidates");
  }
  if (!Array.isArray(parsed.generatedComponentProposals)) {
    throw new Error("LLM workflow composer returned missing or invalid generatedComponentProposals");
  }
  for (const [taskIndex, taskValue] of parsed.tasks.entries()) {
    if (!isRecord(taskValue)) {
      throw new Error(`LLM workflow composer returned invalid tasks[${taskIndex}]: task must be an object`);
    }
    for (const field of TASK_STRING_FIELDS) {
      if (typeof taskValue[field] !== "string") {
        throw new Error(`LLM workflow composer returned invalid tasks[${taskIndex}].${field}: expected string`);
      }
    }
    for (const field of TASK_STRING_ARRAY_FIELDS) {
      if (!isStringArray(taskValue[field])) {
        throw new Error(`LLM workflow composer returned invalid tasks[${taskIndex}].${field}: expected string[]`);
      }
    }
  }
  return parsed as WorkflowCompositionPlan;
}

export function renderComposerPrompt(goalPrompt: string, candidatePacket: CandidatePacket): string {
  return [
    "You are Southstar's library-constrained workflow architect.",
    "Return exactly one JSON object matching schemaVersion southstar.workflow_composition_plan.v1.",
    "Do not return markdown, comments, prose, or multiple JSON objects.",
    "Select refs only from the candidate packet.",
    "Do not output runtime manifests, secrets, credentials, tool grant definitions, MCP grant definitions, or vault lease values.",
    "Generated component proposals are proposal-only and cannot be selected in tasks.",
    "",
    `Goal: ${goalPrompt}`,
    "",
    "CandidatePacket:",
    JSON.stringify(boundCandidatePacket(candidatePacket)),
  ].join("\n");
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
  };
}

function boundCandidateMap<T>(candidateMap: Record<string, T[]>): Record<string, T[]> {
  return Object.fromEntries(
    Object.entries(candidateMap)
      .slice(0, 50)
      .map(([key, candidates]) => [key, candidates.slice(0, 20)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const TASK_STRING_FIELDS = [
  "id",
  "name",
  "responsibility",
  "templateSlotRef",
  "agentDefinitionRef",
  "agentProfileRef",
  "evaluatorProfileRef",
  "rationale",
] as const;

const TASK_STRING_ARRAY_FIELDS = [
  "dependsOn",
  "instructionRefs",
  "skillRefs",
  "toolGrantRefs",
  "mcpGrantRefs",
  "vaultLeasePolicyRefs",
  "inputArtifactRefs",
  "outputArtifactRefs",
  "recoveryStrategyRefs",
] as const;
