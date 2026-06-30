import type { WorkflowCanvasModel, WorkflowDependencyModel, WorkflowTaskNodeModel } from "@/components/workflow-canvas/types";
import type { OperatorTaskDebug } from "./types";

export function taskDagCanvasFromDebug(debug: OperatorTaskDebug, workflowUiModel: unknown): WorkflowCanvasModel {
  const taskId = debug.data.task.taskId;
  const canvas = workflowCanvasFromUiModel(workflowUiModel, debug.data.runId, taskId);
  if (canvas.nodes.length > 0) return canvas;

  const dependencyNodes = debug.data.task.dependsOn.map((id): WorkflowTaskNodeModel => ({
    id,
    label: id,
    kind: "task",
    status: "unknown",
    dependsOn: [],
    badges: [{ label: "dependency" }],
    attention: null,
  }));
  const selectedNode: WorkflowTaskNodeModel = {
    id: taskId,
    label: debug.data.task.taskKey || taskId,
    kind: "task",
    status: debug.data.task.status,
    dependsOn: debug.data.task.dependsOn,
    badges: [{ label: `order ${debug.data.task.sortOrder}` }],
    attention: null,
  };
  const edges = debug.data.task.dependsOn.map((source): WorkflowDependencyModel => ({
    id: `${source}->${taskId}`,
    source,
    target: taskId,
    status: "pending",
  }));

  return {
    graphId: debug.data.runId,
    mode: "runtime",
    selectedNodeId: taskId,
    nodes: [...dependencyNodes, selectedNode],
    edges,
  };
}

export function workflowCanvasFromUiModel(model: unknown, runId: string | null, selectedTaskId: string | null = null): WorkflowCanvasModel {
  const root = readRecord(model);
  const data = readRecord(root?.data);
  const candidate = readRecord(root?.canvasModel) || readRecord(data?.canvasModel) || readRecord(root?.canvas) || data || root || {};
  const rawNodes = Array.isArray(candidate.nodes) ? candidate.nodes : [];
  const rawEdges = Array.isArray(candidate.edges) ? candidate.edges : [];

  return {
    graphId: stringValue(candidate.graphId) || runId || "operator-runtime",
    mode: candidate.mode === "draft" ? "draft" : "runtime",
    selectedNodeId: selectedTaskId || stringValue(candidate.selectedNodeId) || null,
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

function isWorkflowEdgeStatus(value: unknown): value is WorkflowCanvasModel["edges"][number]["status"] {
  return value === "pending" || value === "ready" || value === "active" || value === "blocked" || value === "satisfied";
}

function isWorkflowTaskBadge(value: unknown): value is WorkflowCanvasModel["nodes"][number]["badges"][number] {
  const badge = readRecord(value);
  return Boolean(badge && typeof badge.label === "string");
}

function isWorkflowTaskAttention(value: unknown): value is NonNullable<WorkflowCanvasModel["nodes"][number]["attention"]> {
  const attention = readRecord(value);
  return Boolean(
    attention &&
    (attention.severity === "info" || attention.severity === "warning" || attention.severity === "error" || attention.severity === "blocked") &&
    typeof attention.reason === "string",
  );
}

