export type WorkflowNodeProfileForm = {
  provider: string;
  model: string;
  thinkingLevel: string;
  instruction: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
};

export function normalizeNodeProfileForm(input: { selectedDefinition?: unknown | null }): WorkflowNodeProfileForm {
  const selected = recordValue(input.selectedDefinition) ?? {};
  const effective = recordValue(selected.effectiveProfile) ?? {};
  return {
    provider: stringValue(effective.provider ?? recordValue(selected.agentProfile)?.provider),
    model: stringValue(effective.model ?? recordValue(selected.agentProfile)?.model),
    thinkingLevel: stringValue(effective.thinkingLevel),
    instruction: stringValue(effective.instruction),
    skillRefs: stringArray(effective.skillRefs ?? selected.skillRefs),
    mcpGrantRefs: stringArray(effective.mcpGrantRefs ?? selected.mcpGrantRefs),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function buildNodeProfilePatchPayload(form: WorkflowNodeProfileForm) {
  const provider = clean(form.provider);
  const model = clean(form.model);
  const thinkingLevel = clean(form.thinkingLevel);
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    instruction: clean(form.instruction),
    skillRefs: dedupe(form.skillRefs),
    mcpGrantRefs: dedupe(form.mcpGrantRefs),
  };
}

export function formEquals(left: WorkflowNodeProfileForm, right: WorkflowNodeProfileForm): boolean {
  return JSON.stringify(buildNodeProfilePatchPayload(left)) === JSON.stringify(buildNodeProfilePatchPayload(right));
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
