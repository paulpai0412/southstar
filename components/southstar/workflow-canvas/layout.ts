import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import type { WorkflowCanvasEdge, WorkflowCanvasNode } from "./types";

const elk = new ELK();
const DEFAULT_NODE_WIDTH = 240;
const DEFAULT_NODE_HEIGHT = 112;

export async function layoutWorkflowGraph(input: {
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
}): Promise<Node[]> {
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.edgeRouting": "ORTHOGONAL",
    },
    children: input.nodes.map((node) => ({
      id: node.id,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
    })),
    edges: input.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };
  const layouted = await elk.layout(graph);
  const byId = new Map(layouted.children?.map((node) => [node.id, node]) ?? []);
  return input.nodes.map((node) => {
    const positioned = byId.get(node.id);
    return {
      id: node.id,
      type: "workflowTask",
      position: { x: positioned?.x ?? 0, y: positioned?.y ?? 0 },
      data: node,
    };
  });
}

export function toReactFlowEdges(edges: WorkflowCanvasEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "workflowDependency",
    data: edge,
    animated: edge.status === "active",
  }));
}
