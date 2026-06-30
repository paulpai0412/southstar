"use client";

import { useEffect, useMemo, useState } from "react";
import type { OperatorAttentionItem, OperatorOverview } from "@/lib/operator/types";
import type { WorkflowCanvasModel, WorkflowEdgeStatus, WorkflowTaskBadge, WorkflowTaskAttention } from "../workflow-canvas/types";
import { OperatorStateBoard } from "./OperatorStateBoard";
import { OperatorWorkflowProgress } from "./OperatorWorkflowProgress";

export function OperatorWorkspace({
  overview,
  selectedRunId,
  selectedTaskId,
  onSelectRun,
  onSelectTask,
}: {
  overview: OperatorOverview;
  selectedRunId: string | null;
  selectedTaskId: string | null;
  onSelectRun: (runId: string) => void;
  onSelectTask: (input: { runId: string; taskId: string; attention?: OperatorAttentionItem }) => void;
}) {
  const [workflowModel, setWorkflowModel] = useState<unknown>(null);
  const selectedRun = overview.runs.find((run) => run.runId === selectedRunId) || overview.runs[0] || null;
  const effectiveRunId = selectedRunId || selectedRun?.runId || null;

  useEffect(() => {
    if (!effectiveRunId) {
      setWorkflowModel(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/workflow/ui?runId=${encodeURIComponent(effectiveRunId)}`, { cache: "no-store", signal: controller.signal })
      .then((res) => res.json())
      .then((data) => setWorkflowModel(readRecord(data)?.result || data))
      .catch(() => setWorkflowModel(null));
    return () => controller.abort();
  }, [effectiveRunId]);

  const canvas = useMemo(() => workflowCanvasFromUiModel(workflowModel, effectiveRunId), [workflowModel, effectiveRunId]);
  const attentionForRun = overview.attentionItems.filter((item) => !effectiveRunId || item.runId === effectiveRunId);

  return (
    <main data-testid="operator-workspace" className="operator-workspace">
      <OperatorStateBoard runs={overview.runs} selectedRunId={effectiveRunId} onSelectRun={onSelectRun} />
      <OperatorWorkflowProgress
        run={selectedRun}
        attentionItems={attentionForRun}
        canvas={canvas}
        selectedTaskId={selectedTaskId}
        onSelectTask={(taskId) => {
          if (effectiveRunId) onSelectTask({ runId: effectiveRunId, taskId, attention: attentionForRun.find((item) => item.taskId === taskId) });
        }}
      />
    </main>
  );
}

export function workflowCanvasFromUiModel(model: unknown, runId: string | null): WorkflowCanvasModel {
  const root = readRecord(model);
  const data = readRecord(root?.data);
  const candidate = readRecord(root?.canvasModel) || readRecord(data?.canvasModel) || readRecord(root?.canvas) || data || root || {};
  const rawNodes = Array.isArray(candidate.nodes) ? candidate.nodes : [];
  const rawEdges = Array.isArray(candidate.edges) ? candidate.edges : [];

  return {
    graphId: stringValue(candidate.graphId) || runId || "operator-runtime",
    mode: candidate.mode === "draft" ? "draft" : "runtime",
    selectedNodeId: stringValue(candidate.selectedNodeId) || null,
    nodes: rawNodes.map(readCanvasNode).filter((node): node is WorkflowCanvasModel["nodes"][number] => node !== null),
    edges: rawEdges.map(readCanvasEdge).filter((edge): edge is WorkflowCanvasModel["edges"][number] => edge !== null),
  };
}

function readCanvasNode(input: unknown): WorkflowCanvasModel["nodes"][number] | null {
  const node = readRecord(input);
  const id = stringValue(node?.id || node?.taskId || node?.taskKey);
  if (!id) return null;
  return {
    id,
    label: stringValue(node?.label || node?.title || node?.taskKey) || id,
    kind: "task",
    status: stringValue(node?.status) || "unknown",
    dependsOn: Array.isArray(node?.dependsOn) ? node.dependsOn.filter((item): item is string => typeof item === "string") : [],
    roleRef: stringValue(node?.roleRef) || null,
    agentProfileRef: stringValue(node?.agentProfileRef) || null,
    artifactKind: stringValue(node?.artifactKind) || null,
    badges: Array.isArray(node?.badges) ? node.badges.filter(isWorkflowTaskBadge) : [],
    attention: isWorkflowTaskAttention(node?.attention) ? node.attention : null,
  };
}

function readCanvasEdge(input: unknown, index: number): WorkflowCanvasModel["edges"][number] | null {
  const edge = readRecord(input);
  const source = stringValue(edge?.source || edge?.from);
  const target = stringValue(edge?.target || edge?.to);
  if (!source || !target) return null;
  return {
    id: stringValue(edge?.id) || `${source}->${target}-${index}`,
    source,
    target,
    status: isWorkflowEdgeStatus(edge?.status) ? edge.status : "pending",
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isWorkflowEdgeStatus(value: unknown): value is WorkflowEdgeStatus {
  return value === "pending" || value === "ready" || value === "active" || value === "blocked" || value === "satisfied";
}

function isWorkflowTaskBadge(value: unknown): value is WorkflowTaskBadge {
  const badge = readRecord(value);
  return Boolean(badge && typeof badge.label === "string");
}

function isWorkflowTaskAttention(value: unknown): value is WorkflowTaskAttention {
  const attention = readRecord(value);
  return Boolean(
    attention &&
    (attention.severity === "info" || attention.severity === "warning" || attention.severity === "error" || attention.severity === "blocked") &&
    typeof attention.reason === "string",
  );
}
