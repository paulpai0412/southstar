import type { GoalMissionReadModel } from "../workflow/types";
import type { OperatorAttentionItem, OperatorCommand, OperatorCommandResult, OperatorOverview, OperatorRun } from "./types";

export function normalizeOperatorOverview(input: unknown): OperatorOverview {
  const model = unwrapEnvelope(input);
  const data = recordValue(model?.data);
  const runs = coerceArray(model?.activeRuns || model?.runs || data?.runs)
    .map(readRun)
    .filter((run): run is OperatorRun => run !== null);
  const attentionItems = coerceArray(model?.attentionItems || model?.items || data?.attentionItems)
    .map(readAttention)
    .filter((item): item is OperatorAttentionItem => item !== null);
  const commandResults = coerceArray(model?.commandResults || data?.commandResults)
    .map(readCommandResult)
    .filter((item): item is OperatorCommandResult => item !== null);
  const runtimeHealth = recordValue(model?.runtimeHealth);
  return {
    runs,
    attentionItems,
    commandResults,
    runtimeHealth: {
      activeRunCount: numberValue(runtimeHealth?.activeRunCount) ?? runs.length,
      attentionCount: numberValue(runtimeHealth?.attentionCount) ?? attentionItems.length,
      blockedCount: numberValue(runtimeHealth?.blockedCount) ?? attentionItems.filter((item) => item.severity === "blocked").length,
    },
    defaultSelection: recordValue(model?.defaultSelection) as OperatorOverview["defaultSelection"] || null,
  };
}

function readRun(input: unknown): OperatorRun | null {
  const run = recordValue(input);
  if (!run) return null;
  const runId = stringValue(run?.runId || run?.id);
  if (!runId) return null;
  const domain = stringValue(run.domain);
  const cwd = stringValue(run.cwd);
  const projectRoot = stringValue(run.projectRoot);
  const updatedAt = stringValue(run.updatedAt);
  const commands = coerceArray(run.commands).map(readCommand).filter((command): command is OperatorCommand => command !== null);
  const mission = recordValue(run.mission) as GoalMissionReadModel | undefined;
  const executionStatus = stringValue(run.executionStatus) || mission?.status.execution || stringValue(run.status) || "unknown";
  const outcomeStatus = goalOutcomeStatus(run.outcomeStatus) || mission?.status.outcome || "in_progress";
  const healthStatus = goalHealthStatus(run.healthStatus) || mission?.status.health || "healthy";
  return {
    runId,
    status: stringValue(run?.status) || "unknown",
    executionStatus,
    outcomeStatus,
    healthStatus,
    mission: mission ?? null,
    title: stringValue(run?.title || run?.goalPrompt) || runId,
    ...(domain ? { domain } : {}),
    ...(cwd ? { cwd } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(commands.length ? { commands } : {}),
  };
}

function goalOutcomeStatus(value: unknown): GoalMissionReadModel["status"]["outcome"] | undefined {
  return value === "in_progress" || value === "satisfied" || value === "unsatisfied" || value === "blocked" ? value : undefined;
}

function goalHealthStatus(value: unknown): GoalMissionReadModel["status"]["health"] | undefined {
  return value === "healthy" || value === "degraded" || value === "critical" ? value : undefined;
}

function readAttention(input: unknown): OperatorAttentionItem | null {
  const item = recordValue(input);
  if (!item) return null;
  const scope = recordValue(item?.scope);
  const id = stringValue(item?.id || item?.resourceKey || item?.title);
  if (!id) return null;
  const commands = coerceArray(item?.commands).map(readCommand).filter((command): command is OperatorCommand => command !== null);
  return {
    id,
    kind: stringValue(item?.kind),
    severity: stringValue(item?.severity) || "info",
    interventionMode: stringValue(item?.interventionMode),
    title: stringValue(item?.title) || "Operator attention",
    reason: stringValue(item?.reason),
    runId: stringValue(item?.runId || scope?.runId),
    taskId: stringValue(item?.taskId || scope?.taskId),
    status: stringValue(item?.status),
    source: recordValue(item?.source) as OperatorAttentionItem["source"],
    detail: recordValue(item?.detail),
    commands,
    suggestedCommandId: stringValue(item?.suggestedCommandId || item?.commandId),
    updatedAt: stringValue(item?.updatedAt),
  };
}

function readCommand(input: unknown): OperatorCommand | null {
  const command = recordValue(input);
  if (!command) return null;
  const id = stringValue(command?.id);
  if (!id) return null;
  return {
    id,
    label: stringValue(command?.label) || id,
    consequence: stringValue(command?.consequence),
    endpoint: stringValue(command?.endpoint),
    method: stringValue(command?.method) || "POST",
    enabled: Boolean(command?.enabled),
    requiresConfirmation: Boolean(command?.requiresConfirmation),
    disabledReason: stringValue(command?.disabledReason),
    body: recordValue(command?.body),
    inputOptions: readCommandInputOptions(command?.inputOptions),
  };
}

function readCommandInputOptions(input: unknown): OperatorCommand["inputOptions"] {
  const row = recordValue(input) ?? {};
  return {
    checkpointRefs: stringArray(row.checkpointRefs),
    workspaceSnapshotRefs: stringArray(row.workspaceSnapshotRefs),
  };
}

function readCommandResult(input: unknown): OperatorCommandResult | null {
  const result = recordValue(input);
  if (!result) return null;
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

function unwrapEnvelope(input: unknown): Record<string, unknown> {
  const record = recordValue(input);
  return recordValue(record?.result) ?? record ?? {};
}

function coerceArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return coerceArray(value).filter((item): item is string => typeof item === "string");
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
