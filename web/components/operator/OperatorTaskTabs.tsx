"use client";

import { type ReactNode } from "react";
import { useOperatorTaskDebug } from "@/hooks/useOperatorTaskDebug";
import { mergeOperatorTaskCommands } from "@/lib/operator/taskCommands";
import type { OperatorCommand, OperatorCommandResult } from "@/lib/operator/types";
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
}: {
  kind: "operatorHistory" | "operatorStream" | "operatorActions" | "operatorArtifacts";
  runId: string | null;
  taskId: string | null;
  commands: OperatorCommand[];
  commandResults: OperatorCommandResult[];
  onCommandComplete: () => void;
}) {
  const debug = useOperatorTaskDebug(runId, taskId);

  if (!runId || !taskId) {
    return <p className="operator-muted">Select a task to inspect History, Live SSE, Actions, and Artifacts.</p>;
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

  return withTaskSummary(<p className="operator-muted">Select a task debug tab.</p>);
}
