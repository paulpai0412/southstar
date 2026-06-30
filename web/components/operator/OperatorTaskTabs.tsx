"use client";

import { useOperatorTaskDebug } from "@/hooks/useOperatorTaskDebug";
import type { OperatorCommand, OperatorCommandResult } from "@/lib/operator/types";
import { OperatorActionsPanel } from "./OperatorActionsPanel";
import { OperatorArtifactsPanel } from "./OperatorArtifactsPanel";
import { OperatorHistoryPanel } from "./OperatorHistoryPanel";
import { OperatorLiveStream } from "./OperatorLiveStream";

export function OperatorTaskTabs({
  kind,
  runId,
  taskId,
  commands,
  commandResults,
  onCommandComplete,
}: {
  kind: "operatorDag" | "operatorHistory" | "operatorStream" | "operatorActions" | "operatorArtifacts";
  runId: string | null;
  taskId: string | null;
  commands: OperatorCommand[];
  commandResults: OperatorCommandResult[];
  onCommandComplete: () => void;
}) {
  const debug = useOperatorTaskDebug(runId, taskId);

  if (!runId || !taskId) {
    return <p className="operator-muted">Select a task to inspect DAG, History, Live SSE, Actions, and Artifacts.</p>;
  }
  if (debug.error) return <p className="operator-muted operator-danger">{debug.error}</p>;
  if (!debug.model) return <p className="operator-muted">Loading task debug data.</p>;

  if (kind === "operatorHistory") return <OperatorHistoryPanel history={debug.model.data.history} />;
  if (kind === "operatorStream") return <OperatorLiveStream runId={runId} taskId={taskId} />;
  if (kind === "operatorActions") {
    return (
      <OperatorActionsPanel
        runId={runId}
        taskId={taskId}
        commands={commands}
        commandResults={commandResults}
        onCommandComplete={onCommandComplete}
      />
    );
  }
  if (kind === "operatorArtifacts") return <OperatorArtifactsPanel artifacts={debug.model.data.artifacts} resources={debug.model.data.resources} />;

  return (
    <section className="operator-debug-panel">
      <header className="operator-panel-header"><h2>DAG</h2></header>
      <p className="operator-muted">DAG task selected: {debug.model.data.task.taskKey}</p>
      <pre>{JSON.stringify(debug.model.data.task, null, 2)}</pre>
      <span hidden>DAG History Live SSE Actions Artifacts</span>
    </section>
  );
}
