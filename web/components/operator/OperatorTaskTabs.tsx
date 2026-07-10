"use client";

import { type ReactNode } from "react";
import { useOperatorTaskDebug } from "@/hooks/useOperatorTaskDebug";
import { mergeOperatorTaskCommands } from "@/lib/operator/taskCommands";
import type { OperatorCommand, OperatorCommandResult } from "@/lib/operator/types";
import { OperatorActionsPanel } from "./OperatorActionsPanel";
import { OperatorDebugPanel } from "./OperatorDebugPanel";
import { OperatorHistoryPanel } from "./OperatorHistoryPanel";
import { OperatorLiveStream } from "./OperatorLiveStream";
import { OperatorRecoveryPanel } from "./OperatorRecoveryPanel";
import { OperatorTaskSummary } from "./OperatorTaskSummary";

export function OperatorTaskTabs({
  kind,
  runId,
  taskId,
  commands,
  commandResults,
  onCommandComplete,
}: {
  kind: "operatorHistory" | "operatorStream" | "operatorActions" | "operatorRecovery" | "operatorDebug";
  runId: string | null;
  taskId: string | null;
  commands: OperatorCommand[];
  commandResults: OperatorCommandResult[];
  onCommandComplete: () => void;
}) {
  const debug = useOperatorTaskDebug(runId, taskId);

  if (!runId || !taskId) {
    return <p className="operator-muted">Select a task to inspect History, Live SSE, Actions, and Debug.</p>;
  }
  if (debug.error) return <p className="operator-muted operator-danger">{debug.error}</p>;
  if (!debug.model) return <p className="operator-muted">Loading task debug data.</p>;
  const debugModel = debug.model;

  const taskCommands = mergeOperatorTaskCommands(commands.filter((command) => command.id.startsWith("task.")), debugModel.data.actions);
  const recoveryCommands = commands.filter((command) => command.id.startsWith("recovery.") || command.id.startsWith("approval."));
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
  if (kind === "operatorRecovery") {
    return withTaskSummary(
      <OperatorRecoveryPanel
        debug={debugModel}
        commands={recoveryCommands}
        commandResults={commandResults}
        onCommandComplete={onCommandComplete}
      />,
    );
  }
  if (kind === "operatorDebug") {
    return withTaskSummary(<OperatorDebugPanel debug={debugModel} />);
  }

  return withTaskSummary(<p className="operator-muted">Select a task debug tab.</p>);
}
