"use client";

import type { OperatorTaskDebug } from "@/lib/operator/types";

export function OperatorTaskSummary({ debug }: { debug: OperatorTaskDebug }) {
  const task = debug.data.task;
  const latest = debug.data.history[0];
  const action = debug.data.actions[0];

  return (
    <section className="operator-task-summary">
      <header className="operator-panel-header"><h2>Task Summary</h2></header>
      <dl className="operator-summary-grid">
        <dt>Task</dt><dd>{task.taskKey}</dd>
        <dt>Status</dt><dd>{task.status}</dd>
        <dt>Latest event</dt><dd>{latest ? `${latest.eventType} by ${latest.actorType}` : "No history yet"}</dd>
        <dt>Recommended next action</dt><dd>{action?.label || "Review DAG, History, Live SSE, and Artifacts"}</dd>
      </dl>
    </section>
  );
}
