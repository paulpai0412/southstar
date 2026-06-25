export type UiReadModelScope = {
  runId?: string;
  taskId?: string;
  workItemId?: string;
  domain?: string;
};

export type UiCommandAffordance = {
  id: string;
  label: string;
  endpoint: string;
  method: "POST" | "PATCH" | "DELETE";
  bodySchemaRef?: string;
  enabled: boolean;
  disabledReason?: string;
  idempotencyKeyHint?: string;
  dangerLevel: "none" | "low" | "medium" | "high";
  requiresConfirmation: boolean;
};

export type UiAttentionItem = {
  id: string;
  severity: "info" | "warning" | "error" | "blocked";
  title: string;
  reason: string;
  sourceRefs: string[];
  suggestedCommandIds: string[];
};

export type UiSourceRef = {
  id: string;
  kind: "table-row" | "history-event" | "runtime-resource" | "manifest-ref" | "library-object";
  ref: string;
};

export type UiWarning = {
  code: string;
  message: string;
  sourceRefs: string[];
};

export type UiReadModelEnvelope<TData> = {
  schemaVersion: string;
  kind: string;
  scope: UiReadModelScope;
  data: TData;
  commands: UiCommandAffordance[];
  attentionItems: UiAttentionItem[];
  sourceRefs: UiSourceRef[];
  warnings: UiWarning[];
  generatedAt: string;
};

export function uiCommand(
  input: Omit<UiCommandAffordance, "dangerLevel" | "requiresConfirmation">
    & Partial<Pick<UiCommandAffordance, "dangerLevel" | "requiresConfirmation">>,
): UiCommandAffordance {
  if (!input.enabled && !input.disabledReason) {
    throw new Error(`disabledReason is required for disabled command ${input.id}`);
  }
  return {
    ...input,
    dangerLevel: input.dangerLevel ?? "none",
    requiresConfirmation: input.requiresConfirmation ?? false,
  };
}

export function createUiReadModelEnvelope<TData>(input: {
  schemaVersion: string;
  kind: string;
  scope: UiReadModelScope;
  data: TData;
  commands: UiCommandAffordance[];
  attentionItems: UiAttentionItem[];
  sourceRefs: UiSourceRef[];
  warnings: UiWarning[];
  now?: string;
}): UiReadModelEnvelope<TData> {
  return {
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    scope: input.scope,
    data: input.data,
    commands: input.commands,
    attentionItems: input.attentionItems,
    sourceRefs: input.sourceRefs,
    warnings: input.warnings,
    generatedAt: input.now ?? new Date().toISOString(),
  };
}
