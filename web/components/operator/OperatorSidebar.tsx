"use client";

import { ProjectScopePicker } from "../ProjectScopePicker";
import type { OperatorIncident, OperatorRun } from "@/lib/operator/types";
import { OperatorAttentionQueue } from "./OperatorAttentionQueue";

export function OperatorSidebar({
  cwd,
  runs,
  incidents,
  selectedRunId,
  selectedTaskId,
  selectedIncidentId,
  error,
  onCwdChange,
  onSelectRun,
  onSelectIncident,
  onRefresh,
}: {
  cwd: string | null;
  runs: OperatorRun[];
  incidents: OperatorIncident[];
  selectedRunId: string | null;
  selectedTaskId: string | null;
  selectedIncidentId: string | null;
  error: string | null;
  onCwdChange: (cwd: string | null) => void;
  onSelectRun: (runId: string) => void;
  onSelectIncident: (incident: OperatorIncident) => void;
  onRefresh: () => void;
}) {
  return (
    <div data-testid="operator-sidebar" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <ProjectScopePicker selectedCwd={cwd} onCwdChange={onCwdChange} label="Project Scope" />
      <section style={{ flex: "0 0 42%", minHeight: 150, overflow: "auto", borderBottom: "1px solid var(--border)" }}>
        <OperatorSectionHeader title="Operator Focus" actionLabel="Refresh" onAction={onRefresh} />
        {error ? <p className="operator-muted operator-danger">Operator overview error: {error}</p> : null}
        <div style={{ padding: "0 6px 8px" }}>
          <div className="operator-section-label">Attention</div>
          <OperatorAttentionQueue
            incidents={incidents}
            selectedIncidentId={selectedIncidentId}
            onSelectIncident={onSelectIncident}
          />
        </div>
      </section>
      <section style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
        <div className="operator-section-label">Running Workflows</div>
        <div style={{ padding: "0 6px 8px" }}>
          {runs.length === 0 ? (
            <p className="operator-muted">{cwd ? "No workflows for this project." : "No active workflows."}</p>
          ) : runs.map((run) => (
            <button
              key={run.runId}
              type="button"
              className="operator-list-row"
              aria-pressed={selectedRunId === run.runId}
              onClick={() => onSelectRun(run.runId)}
            >
              <strong>{run.status}</strong>
              <span>{run.title}</span>
              {selectedRunId === run.runId && selectedTaskId ? <em>task {selectedTaskId}</em> : null}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function OperatorSectionHeader({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 10px" }}>
      <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 650, textTransform: "uppercase" }}>{title}</span>
      <button type="button" onClick={onAction}>{actionLabel}</button>
    </header>
  );
}
