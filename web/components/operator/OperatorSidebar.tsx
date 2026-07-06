"use client";

import { AlertTriangle, CheckCircle2, CircleDot, PauseCircle, PlayCircle, XCircle } from "lucide-react";
import { useState } from "react";
import { ProjectScopePicker } from "../ProjectScopePicker";
import { invokeOperatorCommand } from "@/lib/operator/invokeCommand";
import type { OperatorCommand, OperatorIncident, OperatorRun } from "@/lib/operator/types";

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
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const sortedRuns = [...runs].sort(compareRunUpdatedAt);
  const runningRuns = sortedRuns.filter((run) => !isCompletedRun(run));
  const completedRuns = sortedRuns.filter(isCompletedRun);

  async function invokeRunCommand(run: OperatorRun, command: OperatorCommand) {
    const reason = window.prompt(`Reason for ${command.label}`, command.id === "run.pause" ? "Pause workflow from Operator" : "");
    if (reason === null) return;
    const normalizedReason = reason.trim() || command.label;
    if (command.requiresConfirmation && !window.confirm(`Run ${command.label} with reason "${normalizedReason}"?`)) return;
    setPendingCommandId(`${run.runId}:${command.id}`);
    setActionError(null);
    try {
      await invokeOperatorCommand({ command, runId: run.runId, reason: normalizedReason });
      onRefresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingCommandId(null);
    }
  }

  return (
    <div data-testid="operator-sidebar" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <ProjectScopePicker selectedCwd={cwd} onCwdChange={onCwdChange} label="Project Scope" emptyLabel="All projects" />
      <section style={{ flex: "1 1 0", minHeight: 0, overflow: "auto", borderBottom: "1px solid var(--border)" }}>
        <OperatorSectionHeader title="Operator Focus" actionLabel="Refresh" onAction={onRefresh} />
        {error ? <p className="operator-muted operator-danger">Operator overview error: {error}</p> : null}
        {actionError ? <p className="operator-muted operator-danger">{actionError}</p> : null}
        <RunSection
          title="Running Workflow Runs"
          empty={cwd ? "No running workflows for this project." : "No running workflows."}
          runs={runningRuns}
          selectedRunId={selectedRunId}
          selectedTaskId={selectedTaskId}
          onSelectRun={onSelectRun}
          onRunCommand={(run, command) => void invokeRunCommand(run, command)}
          pendingCommandId={pendingCommandId}
          incidents={incidents}
          selectedIncidentId={selectedIncidentId}
          onSelectIncident={onSelectIncident}
        />
      </section>
      <section style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
        <RunSection
          title="Completed Workflow Runs"
          empty={cwd ? "No completed workflows for this project." : "No completed workflows."}
          runs={completedRuns}
          selectedRunId={selectedRunId}
          selectedTaskId={selectedTaskId}
          onSelectRun={onSelectRun}
          onRunCommand={(run, command) => void invokeRunCommand(run, command)}
          pendingCommandId={pendingCommandId}
          incidents={incidents}
          selectedIncidentId={selectedIncidentId}
          onSelectIncident={onSelectIncident}
        />
      </section>
    </div>
  );
}

function RunSection({
  title,
  empty,
  runs,
  selectedRunId,
  selectedTaskId,
  incidents,
  selectedIncidentId,
  onSelectRun,
  onRunCommand,
  pendingCommandId,
  onSelectIncident,
}: {
  title: string;
  empty: string;
  runs: OperatorRun[];
  selectedRunId: string | null;
  selectedTaskId: string | null;
  incidents: OperatorIncident[];
  selectedIncidentId: string | null;
  onSelectRun: (runId: string) => void;
  onRunCommand: (run: OperatorRun, command: OperatorCommand) => void;
  pendingCommandId: string | null;
  onSelectIncident: (incident: OperatorIncident) => void;
}) {
  return (
    <div style={{ padding: "0 6px 8px" }}>
      <div className="operator-section-label">{title}</div>
      {runs.length === 0 ? (
        <p className="operator-muted">{empty}</p>
      ) : runs.map((run) => {
        const runIncidents = incidents.filter((incident) => incident.runId === run.runId);
        const selectedIncident = runIncidents.find((incident) => incident.id === selectedIncidentId) || runIncidents[0] || null;
        const rowCommands = (run.commands ?? []).filter((command) => command.id === "run.pause" || command.id === "run.cancel");
        return (
          <div
            key={run.runId}
            role="button"
            tabIndex={0}
            className="operator-list-row operator-list-row-compact"
            aria-pressed={selectedRunId === run.runId}
            onClick={() => {
              onSelectRun(run.runId);
              if (selectedIncident) onSelectIncident(selectedIncident);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onSelectRun(run.runId);
              if (selectedIncident) onSelectIncident(selectedIncident);
            }}
          >
            <RunStatusIcon status={run.status} />
            <span>{run.title}</span>
            <div className="operator-run-meta-row">
              <em>{formatRunAge(run.updatedAt)}</em>
              {runIncidents.length > 0 ? (
                <span className="operator-run-attention-badge" aria-label={`${runIncidents.length} attention`}>
                  <AlertTriangle aria-hidden="true" size={13} strokeWidth={2.5} />
                  <span>{runIncidents.length}</span>
                </span>
              ) : null}
            </div>
            {rowCommands.length > 0 ? (
              <div className="operator-run-command-row" aria-label="Workflow run actions">
                {rowCommands.map((command) => (
                  <button
                    key={command.id}
                    type="button"
                    disabled={!command.enabled || pendingCommandId === `${run.runId}:${command.id}`}
                    title={command.disabledReason || command.label}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRunCommand(run, command);
                    }}
                  >
                    {pendingCommandId === `${run.runId}:${command.id}` ? "..." : command.label.replace(" Run", "")}
                  </button>
                ))}
              </div>
            ) : null}
            {selectedRunId === run.runId && selectedTaskId ? <em>task {selectedTaskId}</em> : null}
          </div>
        );
      })}
    </div>
  );
}

function RunStatusIcon({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const title = `Workflow status: ${status}`;
  const icon = normalized === "running" || normalized === "scheduling"
    ? <PlayCircle aria-hidden="true" size={15} color="#22c55e" />
    : normalized === "paused" || normalized === "blocked"
      ? <PauseCircle aria-hidden="true" size={15} color="#eab308" />
      : normalized === "cancelled" || normalized === "failed"
        ? <XCircle aria-hidden="true" size={15} color="#ef4444" />
        : normalized === "completed" || normalized === "passed"
          ? <CheckCircle2 aria-hidden="true" size={15} color="#22c55e" />
          : <CircleDot aria-hidden="true" size={15} color="var(--text-dim)" />;
  return <span title={title} aria-label={title}>{icon}</span>;
}

function formatRunAge(updatedAt: string | undefined): string {
  if (!updatedAt) return "age unknown";
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "age unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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

function isCompletedRun(run: OperatorRun): boolean {
  return run.status === "completed" || run.status === "passed" || run.status === "cancelled";
}

function compareRunUpdatedAt(a: OperatorRun, b: OperatorRun): number {
  const bTime = Date.parse(b.updatedAt || "");
  const aTime = Date.parse(a.updatedAt || "");
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}
