"use client";

import { useEffect, useMemo, useState } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { useSouthstarPageModel } from "../hooks/useSouthstarPageModel";
import { SouthstarWorkflowCanvas } from "../workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel } from "../workflow-canvas/types";
import { ActiveRunStrip } from "./ActiveRunStrip";
import { AttentionQueue, type OperatorAttentionItem } from "./AttentionQueue";
import { InterventionPanel, type OperatorCommand } from "./InterventionPanel";
import { RunEventStreamPanel } from "./RunEventStreamPanel";

export function OperatorBoard(props: { api: SouthstarApiClient; activeCwd: string | null }) {
  const sectionLabels = {
    attentionQueue: "Attention Queue",
    activeRuns: "Active Runs",
  };
  const overview = useSouthstarPageModel(() => props.api.getUiOperatorOverview(), [props.api]);
  const runs = useMemo(() => readRuns(overview.model), [overview.model]);
  const attentionItems = useMemo(() => readAttentionItems(overview.model), [overview.model]);
  const commands = useMemo(() => readCommands(overview.model), [overview.model]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [targetTaskId, setTargetTaskId] = useState<string | null>(null);
  const [targetAttentionId, setTargetAttentionId] = useState<string | null>(null);

  useEffect(() => {
    if (runs.length === 0) {
      setSelectedRunId(null);
      return;
    }
    setSelectedRunId((current) => {
      if (current && runs.some((run) => run.runId === current)) return current;
      return runs[0]!.runId;
    });
  }, [runs]);

  const workflow = useSouthstarPageModel(
    () => selectedRunId ? props.api.getUiWorkflow({ runId: selectedRunId }) : Promise.resolve(null),
    [props.api, selectedRunId],
  );
  const canvasModel = useMemo(() => readWorkflowCanvas(workflow.model), [workflow.model]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

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
    const payload: Record<string, string> = { commandId: `ui:${command.id}` };
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
    setSelectedRunId(runId);
    setTargetAttentionId(null);
    if (!runId) setTargetTaskId(null);
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
          commands={commands}
          onInvokeCommand={invokeCommand}
        />
      </section>
      <RunEventStreamPanel runId={selectedRunId} />
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
        severity: stringValue(item?.severity) ?? "info",
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
      return next;
    })
    .filter((command): command is OperatorCommand => command !== null);
}

function readWorkflowCanvas(model: any): WorkflowCanvasModel {
  const candidate = model?.data ?? model?.canvas ?? model;
  const nodes = coerceArray<any>(candidate?.nodes)
    .map((node) => {
      const id = stringValue(node?.id);
      if (!id) return null;
      const next: WorkflowCanvasModel["nodes"][number] = {
        id,
        label: stringValue(node?.label ?? node?.taskKey) ?? id,
        status: stringValue(node?.status) ?? "unknown",
        dependsOn: coerceArray<string>(node?.dependsOn).filter((dep) => typeof dep === "string"),
        badges: [],
      };
      const roleRef = stringValue(node?.roleRef);
      if (roleRef) next.roleRef = roleRef;
      const agentProfileRef = stringValue(node?.agentProfileRef);
      if (agentProfileRef) next.agentProfileRef = agentProfileRef;
      const artifactKind = stringValue(node?.artifactKind);
      if (artifactKind) next.artifactKind = artifactKind;
      const attention = stringValue(node?.attention);
      if (attention) next.attention = attention;
      return next;
    })
    .filter((node): node is WorkflowCanvasModel["nodes"][number] => node !== null);
  const nodeIdSet = new Set(nodes.map((node) => node.id));
  const edgeStatus = stringValue(candidate?.status) ?? null;
  const edges = nodes.flatMap((node) =>
    node.dependsOn
      .filter((dependencyId) => nodeIdSet.has(dependencyId))
      .map((dependencyId) => ({
        id: `${dependencyId}->${node.id}`,
        from: dependencyId,
        to: node.id,
        status: edgeStatus,
      })),
  );
  return {
    nodes,
    edges,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const next = stringValue(item);
    if (next) return next;
  }
  return undefined;
}
