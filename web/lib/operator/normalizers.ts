import type { OperatorAttentionItem, OperatorCommand, OperatorCommandResult, OperatorOverview, OperatorRun } from "./types";

export function normalizeOperatorOverview(input: unknown): OperatorOverview {
  const model = unwrapEnvelope(input);
  const runs = coerceArray<any>(model?.activeRuns || model?.runs || model?.data?.runs)
    .map(readRun)
    .filter((run): run is OperatorRun => run !== null);
  const attentionItems = coerceArray<any>(model?.attentionItems || model?.items || model?.data?.attentionItems)
    .map(readAttention)
    .filter((item): item is OperatorAttentionItem => item !== null);
  const commandResults = coerceArray<any>(model?.commandResults || model?.data?.commandResults)
    .map(readCommandResult)
    .filter((item): item is OperatorCommandResult => item !== null);
  return {
    runs,
    attentionItems,
    commandResults,
    runtimeHealth: {
      activeRunCount: numberValue(model?.runtimeHealth?.activeRunCount) || runs.length,
      attentionCount: numberValue(model?.runtimeHealth?.attentionCount) || attentionItems.length,
      blockedCount: numberValue(model?.runtimeHealth?.blockedCount) || attentionItems.filter((item) => item.severity === "blocked").length,
    },
    defaultSelection: recordValue(model?.defaultSelection) as OperatorOverview["defaultSelection"] || null,
  };
}

function readRun(run: any): OperatorRun | null {
  const runId = stringValue(run?.runId || run?.id);
  if (!runId) return null;
  return {
    runId,
    status: stringValue(run?.status) || "unknown",
    title: stringValue(run?.title || run?.goalPrompt) || runId,
    ...(stringValue(run?.domain) ? { domain: stringValue(run.domain) } : {}),
    ...(stringValue(run?.cwd) ? { cwd: stringValue(run.cwd) } : {}),
    ...(stringValue(run?.projectRoot) ? { projectRoot: stringValue(run.projectRoot) } : {}),
    ...(stringValue(run?.updatedAt) ? { updatedAt: stringValue(run.updatedAt) } : {}),
  };
}

function readAttention(item: any): OperatorAttentionItem | null {
  const id = stringValue(item?.id || item?.resourceKey || item?.title);
  if (!id) return null;
  const commands = coerceArray<any>(item?.commands).map(readCommand).filter((command): command is OperatorCommand => command !== null);
  return {
    id,
    kind: stringValue(item?.kind),
    severity: stringValue(item?.severity) || "info",
    interventionMode: stringValue(item?.interventionMode),
    title: stringValue(item?.title) || "Operator attention",
    reason: stringValue(item?.reason),
    runId: stringValue(item?.runId || item?.scope?.runId),
    taskId: stringValue(item?.taskId || item?.scope?.taskId),
    status: stringValue(item?.status),
    source: recordValue(item?.source) as OperatorAttentionItem["source"],
    detail: recordValue(item?.detail),
    commands,
    suggestedCommandId: stringValue(item?.suggestedCommandId || item?.commandId),
  };
}

function readCommand(command: any): OperatorCommand | null {
  const id = stringValue(command?.id);
  if (!id) return null;
  return {
    id,
    label: stringValue(command?.label) || id,
    endpoint: stringValue(command?.endpoint),
    method: stringValue(command?.method) || "POST",
    enabled: Boolean(command?.enabled),
    requiresConfirmation: Boolean(command?.requiresConfirmation),
    disabledReason: stringValue(command?.disabledReason),
    body: recordValue(command?.body),
  };
}

function readCommandResult(result: any): OperatorCommandResult | null {
  const commandId = stringValue(result?.commandId);
  const status = stringValue(result?.status);
  if (!commandId || !status) return null;
  return {
    commandId,
    status,
    accepted: typeof result?.accepted === "boolean" ? result.accepted : undefined,
    message: stringValue(result?.message),
    affectedRunId: stringValue(result?.affectedRunId),
    affectedTaskId: stringValue(result?.affectedTaskId),
    updatedAt: stringValue(result?.updatedAt),
  };
}

function unwrapEnvelope(input: any): any {
  return input?.result || input;
}

function coerceArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
