"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useOperatorTaskDebug } from "@/hooks/useOperatorTaskDebug";
import { mergeOperatorTaskCommands } from "@/lib/operator/taskCommands";
import { taskDagCanvasFromDebug } from "@/lib/operator/taskDag";
import type { OperatorCommand, OperatorCommandResult } from "@/lib/operator/types";
import { SouthstarWorkflowCanvas } from "../workflow-canvas/SouthstarWorkflowCanvas";
import { OperatorActionsPanel } from "./OperatorActionsPanel";
import { OperatorArtifactsPanel } from "./OperatorArtifactsPanel";
import { OperatorHistoryPanel } from "./OperatorHistoryPanel";
import { OperatorLiveStream } from "./OperatorLiveStream";
import { OperatorTaskSummary } from "./OperatorTaskSummary";

export function OperatorTaskTabs({
  kind,
  runId,
  taskId,
  commands,
  commandResults,
  onCommandComplete,
  onSelectTask,
}: {
  kind: "operatorDag" | "operatorHistory" | "operatorStream" | "operatorActions" | "operatorArtifacts";
  runId: string | null;
  taskId: string | null;
  commands: OperatorCommand[];
  commandResults: OperatorCommandResult[];
  onCommandComplete: () => void;
  onSelectTask: (taskId: string) => void;
}) {
  const debug = useOperatorTaskDebug(runId, taskId);
  const [workflowModel, setWorkflowModel] = useState<unknown>(null);

  useEffect(() => {
    if (!runId || kind !== "operatorDag") {
      setWorkflowModel(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/workflow/ui?runId=${encodeURIComponent(runId)}`, { cache: "no-store", signal: controller.signal })
      .then((res) => res.json())
      .then((data) => setWorkflowModel(readRecord(data)?.result || data))
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setWorkflowModel(null);
      });
    return () => controller.abort();
  }, [kind, runId]);

  if (!runId || !taskId) {
    return <p className="operator-muted">Select a task to inspect DAG, History, Live SSE, Actions, and Artifacts.</p>;
  }
  if (debug.error) return <p className="operator-muted operator-danger">{debug.error}</p>;
  if (!debug.model) return <p className="operator-muted">Loading task debug data.</p>;
  const debugModel = debug.model;

  const taskCommands = mergeOperatorTaskCommands(commands, debugModel.data.actions);
  const withTaskSummary = (content: ReactNode) => (
    <>
      <span hidden>Task Summary</span>
      <OperatorTaskSummary debug={debugModel} />
      {content}
    </>
  );

  if (kind === "operatorHistory") return withTaskSummary(<OperatorHistoryPanel history={debugModel.data.history} />);
  if (kind === "operatorStream") return withTaskSummary(<OperatorLiveStream runId={runId} taskId={taskId} />);
  if (kind === "operatorActions") {
    return withTaskSummary(
      <OperatorActionsPanel
        runId={runId}
        taskId={taskId}
        commands={taskCommands}
        commandResults={commandResults}
        onCommandComplete={onCommandComplete}
      />,
    );
  }
  if (kind === "operatorArtifacts") {
    return withTaskSummary(<OperatorArtifactsPanel artifacts={debugModel.data.artifacts} resources={debugModel.data.resources} />);
  }

  const dagCanvas = taskDagCanvasFromDebug(debugModel, workflowModel);

  return withTaskSummary(
    <section className="operator-debug-panel operator-dag-panel">
      <header className="operator-panel-header"><h2>DAG</h2></header>
      <SouthstarWorkflowCanvas canvas={dagCanvas} selectedTaskId={taskId} onSelectTask={onSelectTask} />
      <span hidden>DAG History Live SSE Actions Artifacts</span>
    </section>,
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
