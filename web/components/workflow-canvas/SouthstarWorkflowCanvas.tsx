"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { statusColorFor } from "./colors";
import { WorkflowDependencyEdge } from "./WorkflowDependencyEdge";
import { WorkflowTaskNode } from "./WorkflowTaskNode";
import { buildWorkflowFlowLayout } from "./layout";
import type {
  WorkflowCanvasModel,
  WorkflowDependencyEdgeData,
  WorkflowTaskNodeData,
} from "./types";

const nodeTypes = { workflowTask: WorkflowTaskNode };
const edgeTypes = { workflowDependency: WorkflowDependencyEdge };

export function SouthstarWorkflowCanvas(props: {
  canvas: WorkflowCanvasModel;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}) {
  const [nodes, setNodes] = useState<Array<Node<WorkflowTaskNodeData>>>([]);
  const [edges, setEdges] = useState<Array<Edge<WorkflowDependencyEdgeData>>>([]);
  const [layoutError, setLayoutError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function runLayout() {
      try {
        const next = await buildWorkflowFlowLayout({
          canvas: props.canvas,
          selectedTaskId: props.selectedTaskId,
        });
        if (cancelled) return;
        setLayoutError(null);
        setNodes(next.nodes);
        setEdges(next.edges);
      } catch (caught) {
        if (cancelled) return;
        setLayoutError((caught as Error).message);
      }
    }
    void runLayout();
    return () => {
      cancelled = true;
    };
  }, [props.canvas, props.selectedTaskId]);

  const minimapColor = useMemo(
    () => (node: Node<WorkflowTaskNodeData>) => statusColorFor(node.data.status).edge,
    [],
  );

  if (props.canvas.nodes.length === 0) {
    return <p className="ss-empty">No DAG yet. Submit a workflow goal to generate a draft.</p>;
  }

  return (
    <section className="ss-workflow-canvas" data-graph-id={props.canvas.graphId} data-canvas-mode={props.canvas.mode}>
      <div className="ss-workflow-canvas-surface">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.35}
          maxZoom={1.7}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          onNodeClick={(_, node) => props.onSelectTask(node.id)}
        >
          <MiniMap nodeColor={minimapColor} maskColor="rgba(15, 98, 254, 0.08)" />
          <Controls position="top-right" />
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        </ReactFlow>
      </div>
      {layoutError ? <p className="ss-error">Layout error: {layoutError}</p> : null}
    </section>
  );
}
