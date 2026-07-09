export type WorkflowNodeProfileForm = {
  harnessRef: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  instruction: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  toolGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
  nodePromptSpec: string;
};

export function normalizeNodeProfileForm(input: { selectedDefinition?: unknown | null }): WorkflowNodeProfileForm {
  const selected = recordValue(input.selectedDefinition) ?? {};
  const effective = recordValue(selected.effectiveProfile) ?? {};
  const selectedPromptInputs = recordValue(selected.promptInputs);
  const nodePromptSpec = effective.nodePromptSpec ?? selected.nodePromptSpec ?? selectedPromptInputs?.nodePromptSpec;
  return {
    harnessRef: stringValue(effective.harnessRef ?? recordValue(selected.agentProfile)?.harnessRef),
    provider: stringValue(effective.provider ?? recordValue(selected.agentProfile)?.provider),
    model: stringValue(effective.model ?? recordValue(selected.agentProfile)?.model),
    thinkingLevel: stringValue(effective.thinkingLevel),
    instruction: stringValue(effective.instruction),
    skillRefs: stringArray(effective.skillRefs ?? selected.skillRefs),
    mcpGrantRefs: stringArray(effective.mcpGrantRefs ?? selected.mcpGrantRefs),
    toolGrantRefs: stringArray(effective.toolGrantRefs ?? selected.toolGrantRefs),
    vaultLeasePolicyRefs: stringArray(effective.vaultLeasePolicyRefs ?? selected.vaultLeasePolicyRefs),
    nodePromptSpec: formatJson(nodePromptSpec),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function buildNodeProfilePatchPayload(form: WorkflowNodeProfileForm) {
  const harnessRef = clean(form.harnessRef);
  const provider = clean(form.provider);
  const model = clean(form.model);
  const thinkingLevel = clean(form.thinkingLevel);
  return {
    ...(harnessRef ? { harnessRef } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    instruction: clean(form.instruction),
    skillRefs: dedupe(form.skillRefs),
    mcpGrantRefs: dedupe(form.mcpGrantRefs),
    toolGrantRefs: dedupe(form.toolGrantRefs),
    vaultLeasePolicyRefs: dedupe(form.vaultLeasePolicyRefs),
    ...(clean(form.nodePromptSpec) ? { nodePromptSpec: JSON.parse(form.nodePromptSpec) as Record<string, unknown> } : {}),
  };
}

export function formEquals(left: WorkflowNodeProfileForm, right: WorkflowNodeProfileForm): boolean {
  try {
    return JSON.stringify(buildNodeProfilePatchPayload(left)) === JSON.stringify(buildNodeProfilePatchPayload(right));
  } catch {
    return JSON.stringify(left) === JSON.stringify(right);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clean(value: string): string {
  return value.trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}
