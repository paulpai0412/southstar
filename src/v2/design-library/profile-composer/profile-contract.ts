import type { AgentProvider, AgentProfile, PlannerDraftTaskProfileOverride } from "../runtime-types.ts";

const allowedProviders = new Set<AgentProvider>([
  "pi",
  "codex",
  "claude-code",
  "openai",
  "openai-codex",
  "github-copilot",
  "anthropic",
  "custom",
]);

export type EffectiveAgentProfileProjection = {
  harnessRef?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  instruction?: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  toolGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
  nodePromptSpec?: unknown;
};

export function normalizeAgentProfileOverride(input: unknown): PlannerDraftTaskProfileOverride {
  const value = asRecord(input);
  const output: PlannerDraftTaskProfileOverride = {};
  if (value.harnessRef !== undefined) output.harnessRef = nonEmptyString(value.harnessRef, "harnessRef");
  if (value.provider !== undefined) {
    if (!allowedProviders.has(value.provider as AgentProvider)) throw new Error(`unsupported provider: ${String(value.provider)}`);
    output.provider = value.provider as AgentProvider;
  }
  if (value.model !== undefined) output.model = nonEmptyString(value.model, "model");
  if (value.thinkingLevel !== undefined) output.thinkingLevel = nonEmptyString(value.thinkingLevel, "thinkingLevel");
  if (value.instruction !== undefined) output.instruction = stringInput(value.instruction, "instruction");
  if (value.skillRefs !== undefined) output.skillRefs = stringArray(value.skillRefs, "skillRefs");
  if (value.mcpGrantRefs !== undefined) output.mcpGrantRefs = stringArray(value.mcpGrantRefs, "mcpGrantRefs");
  if (value.toolGrantRefs !== undefined) output.toolGrantRefs = stringArray(value.toolGrantRefs, "toolGrantRefs");
  if (value.vaultLeasePolicyRefs !== undefined) output.vaultLeasePolicyRefs = stringArray(value.vaultLeasePolicyRefs, "vaultLeasePolicyRefs");
  if (value.nodePromptSpec !== undefined) output.nodePromptSpec = objectValue(value.nodePromptSpec, "nodePromptSpec");
  return output;
}

export function effectiveAgentProfile(input: {
  agentProfile?: unknown;
  task?: {
    skillRefs?: string[];
    mcpGrantRefs?: string[];
    toolGrantRefs?: string[];
    vaultLeasePolicyRefs?: string[];
    promptInputs?: Record<string, unknown>;
  };
  profileOverride?: unknown;
}): EffectiveAgentProfileProjection {
  const profile = asRecord(input.agentProfile);
  const task = input.task ?? {};
  const override = asRecord(input.profileOverride);
  const profileToolPolicy = asRecord(profile.toolPolicy);
  const nodePromptSpec = override.nodePromptSpec
    ?? asRecord(task.promptInputs).nodePromptSpec;
  return {
    ...(stringValue(override.harnessRef) ?? stringValue(profile.harnessRef) ? { harnessRef: stringValue(override.harnessRef) ?? stringValue(profile.harnessRef) } : {}),
    ...(stringValue(override.provider) ?? stringValue(profile.provider) ? { provider: stringValue(override.provider) ?? stringValue(profile.provider) } : {}),
    ...(stringValue(override.model) ?? stringValue(profile.model) ? { model: stringValue(override.model) ?? stringValue(profile.model) } : {}),
    ...(stringValue(override.thinkingLevel) ?? stringValue(profile.thinkingLevel) ? { thinkingLevel: stringValue(override.thinkingLevel) ?? stringValue(profile.thinkingLevel) } : {}),
    ...(stringValue(override.instruction) ?? stringValue(profile.instruction) ? { instruction: stringValue(override.instruction) ?? stringValue(profile.instruction) } : {}),
    skillRefs: optionalStringArray(override.skillRefs) ?? task.skillRefs ?? stringArrayValue(profile.skillRefs),
    mcpGrantRefs: optionalStringArray(override.mcpGrantRefs) ?? task.mcpGrantRefs ?? stringArrayValue(profile.mcpGrantRefs),
    toolGrantRefs: optionalStringArray(override.toolGrantRefs) ?? task.toolGrantRefs ?? stringArrayValue(profileToolPolicy.allowedTools),
    vaultLeasePolicyRefs: optionalStringArray(override.vaultLeasePolicyRefs) ?? task.vaultLeasePolicyRefs ?? stringArrayValue(profile.vaultLeasePolicyRefs),
    ...(nodePromptSpec !== undefined ? { nodePromptSpec } : {}),
  };
}

export function materializeAgentProfile(
  profile: AgentProfile,
  override: PlannerDraftTaskProfileOverride,
  taskId: string,
  taskName: string,
): AgentProfile {
  return {
    ...cloneAgentProfile(profile),
    id: `${profile.id}__${taskId}__override`,
    name: `${profile.name} (${taskName || taskId})`,
    ...(override.harnessRef !== undefined ? { harnessRef: override.harnessRef } : {}),
    ...(override.provider !== undefined ? { provider: override.provider } : {}),
    ...(override.model !== undefined ? { model: override.model } : {}),
    ...(override.thinkingLevel !== undefined ? { thinkingLevel: override.thinkingLevel } : {}),
    ...(override.instruction !== undefined ? { instruction: override.instruction } : {}),
    ...(override.skillRefs !== undefined ? { skillRefs: [...override.skillRefs] } : {}),
    ...(override.mcpGrantRefs !== undefined ? { mcpGrantRefs: [...override.mcpGrantRefs] } : {}),
    ...(override.vaultLeasePolicyRefs !== undefined ? { vaultLeasePolicyRefs: [...override.vaultLeasePolicyRefs] } : {}),
    ...(override.toolGrantRefs !== undefined
      ? { toolPolicy: { ...profile.toolPolicy, allowedTools: [...override.toolGrantRefs] } }
      : {}),
  };
}

export function cloneAgentProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    agentsMdRefs: [...profile.agentsMdRefs],
    skillRefs: [...profile.skillRefs],
    mcpGrantRefs: [...profile.mcpGrantRefs],
    ...(profile.vaultLeasePolicyRefs !== undefined ? { vaultLeasePolicyRefs: [...profile.vaultLeasePolicyRefs] } : {}),
    memoryScopes: [...profile.memoryScopes],
    toolPolicy: {
      allowedTools: [...profile.toolPolicy.allowedTools],
      deniedTools: [...profile.toolPolicy.deniedTools],
      requiresApprovalFor: [...profile.toolPolicy.requiresApprovalFor],
    },
    budgetPolicy: { ...profile.budgetPolicy },
  };
}

function stringInput(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? stringArrayValue(value) : undefined;
}

function nonEmptyString(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
