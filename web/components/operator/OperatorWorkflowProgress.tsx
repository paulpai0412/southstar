"use client";

import { SouthstarWorkflowCanvas } from "../workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel } from "../workflow-canvas/types";
import type { OperatorAttentionItem, OperatorRun } from "@/lib/operator/types";

export function OperatorWorkflowProgress({
  run,
  attentionItems,
  canvas,
  selectedTaskId,
  heightPercent,
  onSelectTask,
}: {
  run: OperatorRun | null;
  attentionItems: OperatorAttentionItem[];
  canvas: WorkflowCanvasModel;
  selectedTaskId: string | null;
  heightPercent: number;
  onSelectTask: (taskId: string) => void;
}) {
  const effectiveSelectedTaskId = selectedTaskId || canvas.selectedNodeId || null;
  const selectedNode = canvas.nodes.find((node) => node.id === effectiveSelectedTaskId) || null;

  return (
    <section
      data-testid="operator-workflow-progress"
      className="operator-panel operator-progress-panel"
      style={{ flexBasis: `${heightPercent}%` }}
    >
      <header className="operator-panel-header">
        <h2>{run?.title || "Selected Workflow"}</h2>
        <div className="operator-dag-status">
          <span>{run?.status || "no run"}</span>
          {selectedNode ? <span>{selectedNode.status} · {selectedNode.label}</span> : null}
        </div>
      </header>
      {attentionItems.length > 0 ? (
        <div className="operator-dag-attention">
          {attentionItems.slice(0, 3).map((item) => (
            <span key={item.id}>{item.severity}: {item.title}</span>
          ))}
        </div>
      ) : null}
      <SouthstarWorkflowCanvas
        canvas={canvas}
        selectedTaskId={effectiveSelectedTaskId}
        onSelectTask={onSelectTask}
        direction="RIGHT"
      />
    </section>
  );
}
