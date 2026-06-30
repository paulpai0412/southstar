"use client";

import { useEffect, useMemo, useState } from "react";
import { buildOperatorPriorityLanes } from "@/lib/operator/incidents";
import { workflowCanvasFromUiModel } from "@/lib/operator/taskDag";
import type { OperatorAttentionItem, OperatorIncident, OperatorOverview } from "@/lib/operator/types";
import { OperatorHealthStrip } from "./OperatorHealthStrip";
import { OperatorIncidentPanel } from "./OperatorIncidentPanel";
import { OperatorStateBoard } from "./OperatorStateBoard";
import { OperatorWorkflowProgress } from "./OperatorWorkflowProgress";

export function OperatorWorkspace({
  overview,
  selectedRunId,
  selectedTaskId,
  selectedIncidentId,
  incidents,
  error,
  onSelectRun,
  onSelectTask,
}: {
  overview: OperatorOverview;
  selectedRunId: string | null;
  selectedTaskId: string | null;
  selectedIncidentId: string | null;
  incidents: OperatorIncident[];
  error: string | null;
  onSelectRun: (runId: string) => void;
  onSelectTask: (input: { runId: string; taskId: string; attention?: OperatorAttentionItem }) => void;
}) {
  const [workflowModel, setWorkflowModel] = useState<unknown>(null);
  const selectedRun = overview.runs.find((run) => run.runId === selectedRunId) || overview.runs[0] || null;
  const effectiveRunId = selectedRunId || selectedRun?.runId || null;

  useEffect(() => {
    if (!effectiveRunId) {
      setWorkflowModel(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/workflow/ui?runId=${encodeURIComponent(effectiveRunId)}`, { cache: "no-store", signal: controller.signal })
      .then((res) => res.json())
      .then((data) => setWorkflowModel(readRecord(data)?.result || data))
      .catch(() => setWorkflowModel(null));
    return () => controller.abort();
  }, [effectiveRunId]);

  const canvas = useMemo(() => workflowCanvasFromUiModel(workflowModel, effectiveRunId), [workflowModel, effectiveRunId]);
  const attentionForRun = overview.attentionItems.filter((item) => !effectiveRunId || item.runId === effectiveRunId);
  const selectedIncident = incidents.find((incident) => incident.id === selectedIncidentId) || incidents[0] || null;
  const priorityLanes = useMemo(() => buildOperatorPriorityLanes(overview.runs, incidents), [overview.runs, incidents]);

  return (
    <main data-testid="operator-workspace" className="operator-workspace">
      <OperatorHealthStrip overview={overview} incidents={incidents} error={error} />
      {overview.runs.length === 0 && incidents.length === 0 ? (
        <section className="operator-panel">
          <p className="operator-muted">Operator helps you monitor running workflows, inspect exceptions, and recover tasks.</p>
        </section>
      ) : null}
      <section className="operator-panel operator-priority-lanes">
        <header className="operator-panel-header"><h2>Priority</h2></header>
        <div className="operator-priority-grid">
          <div><strong>Needs Action</strong><span>{priorityLanes.needsAction.length}</span></div>
          <div><strong>At Risk</strong><span>{priorityLanes.atRisk.length}</span></div>
          <div><strong>Running</strong><span>{priorityLanes.running.length}</span></div>
          <div><strong>Recently Resolved</strong><span>{priorityLanes.recentlyResolved.length}</span></div>
        </div>
      </section>
      <OperatorIncidentPanel incident={selectedIncident} />
      <OperatorStateBoard
        runs={overview.runs}
        attentionItems={overview.attentionItems}
        selectedRunId={effectiveRunId}
        onSelectRun={onSelectRun}
      />
      <OperatorWorkflowProgress
        run={selectedRun}
        attentionItems={attentionForRun}
        canvas={canvas}
        selectedTaskId={selectedTaskId}
        onSelectTask={(taskId) => {
          if (effectiveRunId) onSelectTask({ runId: effectiveRunId, taskId, attention: attentionForRun.find((item) => item.taskId === taskId) });
        }}
      />
    </main>
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
