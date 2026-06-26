"use client";

import { useEffect, useMemo, useState } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { useSouthstarPageModel } from "../hooks/useSouthstarPageModel";
import { SouthstarWorkflowCanvas } from "../workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel, WorkflowTaskAttention, WorkflowTaskBadge } from "../workflow-canvas/types";
import { ActiveRunStrip } from "./ActiveRunStrip";
import { AttentionQueue, type OperatorAttentionItem } from "./AttentionQueue";
import { InterventionPanel, type OperatorCommand, type OperatorCommandResult } from "./InterventionPanel";
import { RunEventStreamPanel } from "./RunEventStreamPanel";

export function OperatorBoard(props: { api: SouthstarApiClient; activeCwd: string | null; serverBaseUrl: string; selectedRunId?: string | null }) {
  const sectionLabels = {
    attentionQueue: "Attention Queue",
    activeRuns: "Active Runs",
  };
  const overview = useSouthstarPageModel(() => props.api.getUiOperatorOverview(), [props.api]);
  const runs = useMemo(() => readRuns(overview.model), [overview.model]);
  const attentionItems = useMemo(() => readAttentionItems(overview.model), [overview.model]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => props.selectedRunId ?? null);
  const [targetTaskId, setTargetTaskId] = useState<string | null>(null);
  const [targetAttentionId, setTargetAttentionId] = useState<string | null>(null);
  const selectedAttention = useMemo(
    () => attentionItems.find((item) => item.id === targetAttentionId)
      ?? attentionItems.find((item) => item.kind === "run" && item.runId === selectedRunId)
      ?? null,
    [attentionItems, selectedRunId, targetAttentionId],
  );
  const commands = useMemo(() => readCommands(selectedAttention ?? overview.model), [overview.model, selectedAttention]);
  const commandResults = useMemo(() => readCommandResults(overview.model), [overview.model]);

  const workflow = useSouthstarPageModel(
    () => selectedRunId ? props.api.getUiWorkflow({ runId: selectedRunId }) : Promise.resolve(null),
    [props.api, selectedRunId],
  );
  const canvasModel = useMemo(
    () => operatorWorkflowCanvasForSelectedRun(workflow.model, selectedRunId),
    [workflow.model, selectedRunId],
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (!props.selectedRunId) return;
    const nextTargets = operatorTargetsAfterRunSelection({
      currentRunId: selectedRunId,
      nextRunId: props.selectedRunId,
      selectedTaskId,
      targetTaskId,
      targetAttentionId,
    });
    setSelectedRunId(props.selectedRunId);
    setSelectedTaskId(nextTargets.selectedTaskId);
    setTargetTaskId(nextTargets.targetTaskId);
    setTargetAttentionId(nextTargets.targetAttentionId);
  }, [props.selectedRunId]);

  useEffect(() => {
    setSelectedRunId((current) => selectInitialOperatorRunId(runs, current, props.selectedRunId ?? null));
  }, [runs, props.selectedRunId]);

  useEffect(() => {
    const firstTaskId = canvasModel.nodes[0]?.id ?? null;
    setSelectedTaskId((current) => {
      if (targetTaskId && canvasModel.nodes.some((node) => node.id === targetTaskId)) return targetTaskId;
      if (!current) return firstTaskId;
      if (!canvasModel.nodes.some((node) => node.id === current)) return firstTaskId;
      return current;
    });
  }, [canvasModel, targetTaskId]);

  async function invokeCommand(command: OperatorCommand, reason?: string): Promise<void> {
    if (!command.endpoint || command.method?.toUpperCase() !== "POST") return;
    const payload: Record<string, unknown> = {
      ...(command.body ?? {}),
      commandId: createOperatorCommandRequestId(command.id),
      actor: { type: "user", id: "operator-ui" },
    };
    if (selectedRunId) payload.runId = selectedRunId;
    const selectedInterventionTaskId = targetTaskId ?? selectedTaskId;
    if (selectedInterventionTaskId) payload.taskId = selectedInterventionTaskId;
    if (targetAttentionId) payload.attentionItemId = targetAttentionId;
    const normalizedReason = reason?.trim();
    if (normalizedReason) payload.reason = normalizedReason;
    await props.api.command(command.endpoint, payload);
    await overview.refresh();
  }

  function handleAttentionSelection(item: OperatorAttentionItem): void {
    setTargetAttentionId(item.id);
    const attentionRunId = item.runId ?? selectedRunId;
    if (attentionRunId) setSelectedRunId(attentionRunId);
    const attentionTaskId = item.taskId ?? null;
    if (attentionTaskId) setSelectedTaskId(attentionTaskId);
    setTargetTaskId(attentionTaskId);
  }

  function handleSelectRun(runId: string | null): void {
    const nextTargets = operatorTargetsAfterRunSelection({
      currentRunId: selectedRunId,
      nextRunId: runId,
      selectedTaskId,
      targetTaskId,
      targetAttentionId,
    });
    setSelectedRunId(runId);
    setSelectedTaskId(nextTargets.selectedTaskId);
    setTargetTaskId(nextTargets.targetTaskId);
    setTargetAttentionId(nextTargets.targetAttentionId);
  }

  function handleSelectTask(taskId: string | null): void {
    setSelectedTaskId(taskId);
    setTargetTaskId(taskId);
  }

  return (
    <section className="ss-operator-board">
      <div hidden aria-hidden>{sectionLabels.attentionQueue} · {sectionLabels.activeRuns}</div>
      <ActiveRunStrip
        runs={runs}
        selectedRunId={selectedRunId}
        activeCwd={props.activeCwd}
        onSelectRun={handleSelectRun}
      />
      <section className="ss-workflow-workbench">
        <AttentionQueue
          items={attentionItems}
          selectedAttentionId={targetAttentionId}
          onSelectAttention={handleAttentionSelection}
        />
        <SouthstarWorkflowCanvas
          canvas={canvasModel}
          selectedTaskId={selectedTaskId}
          onSelectTask={handleSelectTask}
        />
        <InterventionPanel
          runId={selectedRunId}
          targetTaskId={targetTaskId}
          targetAttentionId={targetAttentionId}
          interventionMode={selectedAttention?.interventionMode}
          source={selectedAttention?.source}
          detail={selectedAttention?.detail}
          commands={commands}
          commandResults={commandResults}
          onInvokeCommand={invokeCommand}
        />
      </section>
      <RunEventStreamPanel runId={selectedRunId} serverBaseUrl={props.serverBaseUrl} />
      {overview.error ? <p className="ss-empty">{overview.error}</p> : null}
      {workflow.error ? <p className="ss-empty">{workflow.error}</p> : null}
    </section>
  );
}

type OperatorRun = { runId: string; status: string; title: string };

function coerceArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function readRuns(model: any): OperatorRun[] {
  const rows = coerceArray<any>(model?.runs ?? model?.data?.runs ?? model?.operator?.runs);
  if (rows.length > 0) {
    return rows
      .map((run) => {
        const runId = stringValue(run?.runId ?? run?.id ?? run?.data?.runId);
        if (!runId) return null;
        return {
          runId,
          status: stringValue(run?.status ?? run?.data?.status) ?? "unknown",
          title: stringValue(run?.title ?? run?.goalPrompt ?? run?.data?.goalPrompt) ?? runId,
        };
      })
      .filter((run): run is OperatorRun => run !== null);
  }
  const runId = stringValue(model?.runId ?? model?.data?.runId ?? model?.scope?.runId);
  if (!runId) return [];
  return [{
    runId,
    status: stringValue(model?.status ?? model?.data?.status ?? model?.data?.rawStatus) ?? "unknown",
    title: stringValue(model?.goalPrompt ?? model?.data?.goalPrompt) ?? runId,
  }];
}

function readAttentionItems(model: any): OperatorAttentionItem[] {
  const rows = coerceArray<any>(model?.attentionItems ?? model?.items ?? model?.data?.attentionItems);
  return rows
    .map((item) => {
      const id = stringValue(item?.id ?? item?.resourceKey ?? item?.title);
      if (!id) return null;
      const next: OperatorAttentionItem = {
        id,
        kind: stringValue(item?.kind),
        status: stringValue(item?.status),
        severity: stringValue(item?.severity) ?? "info",
        interventionMode: stringValue(item?.interventionMode),
        title: stringValue(item?.title) ?? "Pending operator review",
      };
      const reason = stringValue(item?.reason);
      if (reason) next.reason = reason;
      const runId = stringValue(item?.runId ?? item?.run?.id ?? item?.scope?.runId ?? item?.data?.runId);
      if (runId) next.runId = runId;
      const taskId = stringValue(item?.taskId ?? item?.task?.id ?? item?.scope?.taskId ?? item?.data?.taskId);
      if (taskId) next.taskId = taskId;
      const suggestedCommandId =
        stringValue(item?.suggestedCommandId ?? item?.commandId) ?? firstString(item?.suggestedActions);
      if (suggestedCommandId) next.suggestedCommandId = suggestedCommandId;
      const source = recordValue(item?.source);
      if (source) {
        next.source = {
          resourceType: stringValue(source.resourceType),
          resourceKey: stringValue(source.resourceKey),
          ref: stringValue(source.ref),
        };
      }
      const detail = recordValue(item?.detail);
      if (detail) next.detail = detail;
      const commands = coerceArray<unknown>(item?.commands);
      if (commands.length > 0) next.commands = commands;
      return next;
    })
    .filter((item): item is OperatorAttentionItem => item !== null);
}

function readCommands(model: any): OperatorCommand[] {
  const rows = coerceArray<any>(model?.commands ?? model?.data?.commands ?? model?.runControl?.commands);
  return rows
    .map((command) => {
      const id = stringValue(command?.id);
      if (!id) return null;
      const next: OperatorCommand = {
        id,
        label: stringValue(command?.label) ?? id,
        method: stringValue(command?.method) ?? "POST",
        enabled: Boolean(command?.enabled),
        requiresConfirmation: Boolean(command?.requiresConfirmation),
      };
      const endpoint = stringValue(command?.endpoint);
      if (endpoint) next.endpoint = endpoint;
      const disabledReason = stringValue(command?.disabledReason);
      if (disabledReason) next.disabledReason = disabledReason;
      const body = recordValue(command?.body);
      if (body) next.body = body;
      return next;
    })
    .filter((command): command is OperatorCommand => command !== null);
}

function readCommandResults(model: any): OperatorCommandResult[] {
  const rows = coerceArray<any>(model?.commandResults ?? model?.data?.commandResults);
  return rows
    .map((result) => {
      const commandId = stringValue(result?.commandId);
      const status = stringValue(result?.status);
      if (!commandId || !status) return null;
      const next: OperatorCommandResult = {
        commandId,
        status,
      };
      if (typeof result?.accepted === "boolean") next.accepted = result.accepted;
      const message = stringValue(result?.message);
      if (message) next.message = message;
      const affectedRunId = stringValue(result?.affectedRunId);
      if (affectedRunId) next.affectedRunId = affectedRunId;
      const affectedTaskId = stringValue(result?.affectedTaskId);
      if (affectedTaskId) next.affectedTaskId = affectedTaskId;
      const updatedAt = stringValue(result?.updatedAt);
      if (updatedAt) next.updatedAt = updatedAt;
      return next;
    })
    .filter((result): result is OperatorCommandResult => result !== null);
}

export function operatorWorkflowCanvasFromReadModel(model: any): WorkflowCanvasModel {
  const candidate = model?.canvasModel ?? model?.data?.canvasModel ?? model?.canvas ?? model?.data ?? model;
  const nodes = coerceArray<any>(candidate?.nodes)
    .map((node) => {
      const id = stringValue(node?.id);
      if (!id) return null;
      const next: WorkflowCanvasModel["nodes"][number] = {
        id,
        label: stringValue(node?.label ?? node?.taskKey) ?? id,
        kind: "task",
        status: stringValue(node?.status) ?? "unknown",
        dependsOn: coerceArray<string>(node?.dependsOn).filter((dep) => typeof dep === "string"),
        badges: normalizeBadges(node?.badges),
      };
      const roleRef = stringValue(node?.roleRef);
      if (roleRef) next.roleRef = roleRef;
      const agentProfileRef = stringValue(node?.agentProfileRef);
      if (agentProfileRef) next.agentProfileRef = agentProfileRef;
      const artifactKind = stringValue(node?.artifactKind);
      if (artifactKind) next.artifactKind = artifactKind;
      const attention = normalizeAttention(node?.attention);
      if (attention) next.attention = attention;
      return next;
    })
    .filter((node): node is WorkflowCanvasModel["nodes"][number] => node !== null);
  const nodeIdSet = new Set(nodes.map((node) => node.id));
  const rawEdges = coerceArray<any>(candidate?.edges);
  const edges = rawEdges.length > 0
    ? rawEdges.map((edge, index) => ({
        id: stringValue(edge?.id) ?? `${edge?.source ?? edge?.from ?? "source"}->${edge?.target ?? edge?.to ?? "target"}-${index}`,
        source: stringValue(edge?.source ?? edge?.from) ?? "",
        target: stringValue(edge?.target ?? edge?.to) ?? "",
        status: normalizeEdgeStatus(edge?.status),
      }))
    : nodes.flatMap((node) =>
        node.dependsOn
          .filter((dependencyId) => nodeIdSet.has(dependencyId))
          .map((dependencyId) => ({
            id: `${dependencyId}->${node.id}`,
            source: dependencyId,
            target: node.id,
            status: "pending" as const,
          })),
      );
  return {
    graphId: stringValue(candidate?.graphId) ?? "operator-runtime",
    mode: candidate?.mode === "draft" ? "draft" : "runtime",
    selectedNodeId: stringValue(candidate?.selectedNodeId) ?? null,
    nodes,
    edges,
  };
}

export function operatorWorkflowCanvasForSelectedRun(model: any, selectedRunId: string | null): WorkflowCanvasModel {
  const canvas = operatorWorkflowCanvasFromReadModel(model);
  if (selectedRunId && canvas.graphId !== selectedRunId) {
    return {
      graphId: selectedRunId,
      mode: "runtime",
      selectedNodeId: null,
      nodes: [],
      edges: [],
    };
  }
  return canvas;
}

export function selectInitialOperatorRunId(
  runs: Array<{ runId: string }>,
  currentRunId: string | null,
  preferredRunId?: string | null,
): string | null {
  if (preferredRunId) return preferredRunId;
  if (currentRunId && (runs.length === 0 || runs.some((run) => run.runId === currentRunId))) return currentRunId;
  return runs[0]?.runId ?? null;
}

export function operatorTargetsAfterRunSelection(input: {
  currentRunId: string | null;
  nextRunId: string | null;
  selectedTaskId: string | null;
  targetTaskId: string | null;
  targetAttentionId: string | null;
}): { selectedTaskId: string | null; targetTaskId: string | null; targetAttentionId: string | null } {
  if (input.currentRunId !== input.nextRunId) return { selectedTaskId: null, targetTaskId: null, targetAttentionId: null };
  return {
    selectedTaskId: input.selectedTaskId,
    targetTaskId: input.targetTaskId,
    targetAttentionId: input.targetAttentionId,
  };
}

export function createOperatorCommandRequestId(commandId: string): string {
  return `ui:${commandId}:${Date.now()}:${crypto.randomUUID()}`;
}

function normalizeBadges(value: unknown): WorkflowTaskBadge[] {
  if (!Array.isArray(value)) return [];
  return value.map((badge) => {
    if (typeof badge === "string") return { label: badge, tone: "neutral" as const };
    return {
      label: stringValue((badge as { label?: unknown })?.label) ?? "badge",
      tone: normalizeBadgeTone((badge as { tone?: unknown })?.tone),
    };
  });
}

function normalizeBadgeTone(value: unknown): WorkflowTaskBadge["tone"] {
  if (value === "good" || value === "warn" || value === "danger" || value === "neutral") return value;
  return "neutral";
}

function normalizeAttention(value: unknown): WorkflowTaskAttention | null {
  if (typeof value === "string" && value.length > 0) return { severity: "warning", reason: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const severity = normalizeAttentionSeverity(record.severity);
  const reason = stringValue(record.reason);
  return severity && reason ? { severity, reason } : null;
}

function normalizeAttentionSeverity(value: unknown): WorkflowTaskAttention["severity"] | null {
  if (value === "info" || value === "warning" || value === "error" || value === "blocked") return value;
  return null;
}

function normalizeEdgeStatus(value: unknown): WorkflowCanvasModel["edges"][number]["status"] {
  if (value === "ready" || value === "active" || value === "blocked" || value === "satisfied") return value;
  return "pending";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const next = stringValue(item);
    if (next) return next;
  }
  return undefined;
}
