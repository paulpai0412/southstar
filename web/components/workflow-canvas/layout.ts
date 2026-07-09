import ELK from "elkjs/lib/elk.bundled.js";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { normalizeWorkflowStatus, statusColorFor } from "./colors";
import type {
  WorkflowCanvasModel,
  WorkflowDependencyEdgeData,
  WorkflowTaskNodeData,
} from "./types";

const elk = new ELK();
const NODE_WIDTH = 272;
const NODE_HEIGHT = 142;

export async function buildWorkflowFlowLayout(input: {
  canvas: WorkflowCanvasModel;
  selectedTaskId: string | null;
  direction?: "DOWN" | "RIGHT";
}): Promise<{ nodes: Array<Node<WorkflowTaskNodeData>>; edges: Array<Edge<WorkflowDependencyEdgeData>> }> {
  const nodeIds = new Set(input.canvas.nodes.map((node) => node.id));
  const dependencyByTarget = new Map<string, string[]>();
  for (const node of input.canvas.nodes) {
    if (node.dependsOn.length > 0) dependencyByTarget.set(node.id, [...node.dependsOn]);
  }

  const rawDependencies = input.canvas.edges.length > 0
    ? input.canvas.edges
    : input.canvas.nodes.flatMap((node) => {
        const dependsOn = dependencyByTarget.get(node.id) ?? [];
        return dependsOn.map((dependency, index) => ({
          id: `${dependency}-${node.id}-${index}`,
          source: dependency,
          target: node.id,
          status: "pending" as const,
        }));
      });
  const dependencies = rawDependencies.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  const graph = await elk.layout({
    id: "southstar-workflow-canvas",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": input.direction ?? "DOWN",
      "elk.spacing.nodeNode": "44",
      "elk.layered.spacing.nodeNodeBetweenLayers": "86",
      "elk.layered.considerModelOrder.strategy": "PREFER_NODES",
    },
    children: input.canvas.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: dependencies.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  });

  const positioned = new Map<string, { x: number; y: number }>();
  for (const node of graph.children ?? []) {
    positioned.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  }

  const nodes: Array<Node<WorkflowTaskNodeData>> = input.canvas.nodes.map((node, index) => {
    const position = positioned.get(node.id) ?? { x: index * (NODE_WIDTH + 30), y: index * 16 };
    return {
      id: node.id,
      type: "workflowTask",
      position,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        ...node,
        status: normalizeWorkflowStatus(node.status),
        selected: input.selectedTaskId === node.id,
      },
      draggable: true,
      selectable: true,
    };
  });

  const edges: Array<Edge<WorkflowDependencyEdgeData>> = dependencies.map((edge) => {
    const normalizedStatus = normalizeWorkflowStatus(edge.status ?? "pending");
    const colors = statusColorFor(normalizedStatus);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "workflowDependency",
      data: { status: normalizedStatus },
      animated: normalizedStatus === "active",
      className: `ss-flow-edge ss-flow-edge-${normalizedStatus}`,
      style: { stroke: colors.edge, strokeWidth: 1.8 },
      markerEnd: { type: MarkerType.ArrowClosed, color: colors.edge },
    };
  });

  return { nodes, edges };
}
