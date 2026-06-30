"use client";

import { useState } from "react";
import { SouthstarWorkflowCanvas } from "../workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel } from "../workflow-canvas/types";
import type { OperatorAttentionItem, OperatorRun } from "@/lib/operator/types";

export function OperatorWorkflowProgress({
  run,
  attentionItems,
  canvas,
  selectedTaskId,
  onSelectTask,
}: {
  run: OperatorRun | null;
  attentionItems: OperatorAttentionItem[];
  canvas: WorkflowCanvasModel;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}) {
  const [view, setView] = useState<"progress" | "dag">("progress");

  return (
    <section data-testid="operator-workflow-progress" className="operator-panel operator-progress-panel">
      <header className="operator-panel-header">
        <h2>{run?.title || "Selected Workflow"}</h2>
        <div className="operator-segmented">
          <button type="button" aria-pressed={view === "progress"} onClick={() => setView("progress")}>Progress</button>
          <button type="button" aria-pressed={view === "dag"} onClick={() => setView("dag")}>DAG</button>
        </div>
      </header>
      {view === "dag" ? (
        <SouthstarWorkflowCanvas canvas={canvas} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
      ) : (
        <ol className="operator-progress-list">
          {canvas.nodes.length === 0 ? (
            <li><p className="operator-muted">No workflow progress available.</p></li>
          ) : canvas.nodes.map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => onSelectTask(node.id)} aria-pressed={selectedTaskId === node.id}>
                <strong>{node.status}</strong>
                <span>{node.label}</span>
                {attentionItems.some((item) => item.taskId === node.id) ? <em>attention</em> : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
