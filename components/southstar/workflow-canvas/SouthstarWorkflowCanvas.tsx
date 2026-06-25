"use client";

import { useEffect, useMemo, useState } from "react";
import { Background, Controls, MarkerType, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowCanvasModel } from "./types";
import { layoutWorkflowGraph, toReactFlowEdges } from "./layout";
import { WorkflowTaskNode } from "./WorkflowTaskNode";
import { WorkflowDependencyEdge } from "./WorkflowDependencyEdge";

const nodeTypes = { workflowTask: WorkflowTaskNode };
const edgeTypes = { workflowDependency: WorkflowDependencyEdge };

export function SouthstarWorkflowCanvas(props: {
  model: WorkflowCanvasModel | null;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const edges: Edge[] = useMemo(() => toReactFlowEdges(props.model?.edges ?? []).map((edge) => ({
    ...edge,
    markerEnd: { type: MarkerType.ArrowClosed },
  })), [props.model]);

  useEffect(() => {
    let cancelled = false;
    void layoutWorkflowGraph({ nodes: props.model?.nodes ?? [], edges: props.model?.edges ?? [] }).then((layouted) => {
      if (!cancelled) setNodes(layouted);
    });
    return () => {
      cancelled = true;
    };
  }, [props.model]);

  if (!props.model || props.model.nodes.length === 0) {
    return <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--text-dim)", fontSize: 12 }}>No workflow graph yet.</div>;
  }

  return (
    <ReactFlow
      nodes={nodes.map((node) => ({ ...node, selected: node.id === props.selectedNodeId }))}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      minZoom={0.2}
      maxZoom={1.8}
      onNodeClick={(_event, node) => props.onSelectNode?.(node.id)}
    >
      <Background />
      <MiniMap pannable zoomable />
      <Controls />
    </ReactFlow>
  );
}
