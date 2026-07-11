"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { bucketForRunStatus, operatorStateBuckets } from "@/lib/operator/progress";
import { workflowCanvasFromUiModel } from "@/lib/operator/taskDag";
import { invokeOperatorCommand } from "@/lib/operator/invokeCommand";
import type { OperatorAttentionItem, OperatorCommand, OperatorIncident, OperatorOverview, OperatorRun } from "@/lib/operator/types";
import { OperatorWorkflowProgress } from "./OperatorWorkflowProgress";

const DEFAULT_DAG_HEIGHT_PERCENT = 40;
const MIN_DAG_HEIGHT_PERCENT = 30;
const MAX_DAG_HEIGHT_PERCENT = 76;
const ACTIVE_RUN_STATUSES = new Set(["created", "validated", "ready", "scheduling", "queued", "running", "verifying", "release_pending", "blocked", "paused"]);

export function OperatorWorkspace({
  overview,
  selectedRunId,
  selectedTaskId,
  selectedIncidentId,
  incidents,
  error,
  onSelectRun,
  onSelectTask,
  onClearRun,
  onRefresh,
}: {
  overview: OperatorOverview;
  selectedRunId: string | null;
  selectedTaskId: string | null;
  selectedIncidentId: string | null;
  incidents: OperatorIncident[];
  error: string | null;
  onSelectRun: (runId: string) => void;
  onSelectTask: (input: { runId: string; taskId: string; attention?: OperatorAttentionItem }) => void;
  onClearRun: () => void;
  onRefresh: () => void;
}) {
  const [workflowModel, setWorkflowModel] = useState<unknown>(null);
  const [dagHeightPercent, setDagHeightPercent] = useState(DEFAULT_DAG_HEIGHT_PERCENT);
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const selectedRun = selectedRunId ? overview.runs.find((run) => run.runId === selectedRunId) || null : null;
  const effectiveRunId = selectedRun?.runId || null;
  const selectedRunUpdatedAt = selectedRun?.updatedAt || null;
  const selectedRunStatus = selectedRun?.status || null;

  const loadWorkflowModel = useCallback((runId: string, signal?: AbortSignal) => {
    return fetch(`/api/workflow/ui?runId=${encodeURIComponent(runId)}`, { cache: "no-store", signal })
      .then((res) => res.json())
      .then((data) => setWorkflowModel(readRecord(data)?.result || data));
  }, []);

  useEffect(() => {
    if (!effectiveRunId) {
      setWorkflowModel(null);
      return;
    }
    const controller = new AbortController();
    loadWorkflowModel(effectiveRunId, controller.signal)
      .catch(() => setWorkflowModel(null));
    return () => controller.abort();
  }, [effectiveRunId, loadWorkflowModel, selectedRunUpdatedAt]);

  useEffect(() => {
    if (!effectiveRunId || !selectedRunStatus || !ACTIVE_RUN_STATUSES.has(selectedRunStatus)) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadWorkflowModel(effectiveRunId).catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [effectiveRunId, loadWorkflowModel, selectedRunStatus]);

  const startDagResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    event.preventDefault();
    const rect = workspace.getBoundingClientRect();
    const startY = event.clientY;
    const startDagPixels = rect.height * (dagHeightPercent / 100);

    const onMove = (moveEvent: PointerEvent) => {
      const nextDagPixels = startDagPixels - (moveEvent.clientY - startY);
      const nextPercent = (nextDagPixels / rect.height) * 100;
      setDagHeightPercent(clamp(nextPercent, MIN_DAG_HEIGHT_PERCENT, MAX_DAG_HEIGHT_PERCENT));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [dagHeightPercent]);

  const canvas = useMemo(() => workflowCanvasFromUiModel(workflowModel, effectiveRunId), [workflowModel, effectiveRunId]);
  const attentionForRun = overview.attentionItems.filter((item) => item.runId === effectiveRunId);
  const selectedIncident = incidents.find((incident) => incident.id === selectedIncidentId) || null;

  const invokeRunCommand = useCallback(async (run: OperatorRun, command: OperatorCommand) => {
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
  }, [onRefresh]);

  return (
    <main ref={workspaceRef} data-testid="operator-workspace" className="operator-workspace">
      <OperatorStateDashboard
        overview={overview}
        selectedRunId={effectiveRunId}
        selectedIncident={selectedIncident}
        incidents={incidents}
        error={error}
        actionError={actionError}
        onSelectRun={onSelectRun}
        onClearRun={onClearRun}
        onRunCommand={(run, command) => void invokeRunCommand(run, command)}
        pendingCommandId={pendingCommandId}
      />
      {selectedRun ? (
        <>
          <div
            className="operator-dashboard-splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize task DAG"
            onPointerDown={startDagResize}
          />
          <OperatorWorkflowProgress
            run={selectedRun}
            attentionItems={attentionForRun}
            canvas={canvas}
            selectedTaskId={selectedTaskId}
            heightPercent={dagHeightPercent}
            onSelectTask={(taskId) => {
              if (effectiveRunId) onSelectTask({ runId: effectiveRunId, taskId, attention: attentionForRun.find((item) => item.taskId === taskId) });
            }}
          />
        </>
      ) : null}
    </main>
  );
}

function OperatorStateDashboard({
  overview,
  selectedRunId,
  selectedIncident,
  incidents,
  error,
  actionError,
  onSelectRun,
  onClearRun,
  onRunCommand,
  pendingCommandId,
}: {
  overview: OperatorOverview;
  selectedRunId: string | null;
  selectedIncident: OperatorIncident | null;
  incidents: OperatorIncident[];
  error: string | null;
  actionError: string | null;
  onSelectRun: (runId: string) => void;
  onClearRun: () => void;
  onRunCommand: (run: OperatorRun, command: OperatorCommand) => void;
  pendingCommandId: string | null;
}) {
  const sortedRuns = [...overview.runs].sort(compareRunUpdatedAt);
  const problemCount = overview.attentionItems.length + incidents.length;
  const exceptionRunCount = sortedRuns.filter((run) => bucketForRunStatus(run.status) === "exception").length;

  return (
    <section className="operator-state-dashboard" data-testid="operator-state-dashboard">
      <header className="operator-state-dashboard-header">
        <div>
          <h2>State Dashboard</h2>
          <p>Workflow lifecycle by project, newest first.</p>
          <div className="operator-state-dashboard-meta">
            <span>active {overview.runtimeHealth.activeRunCount}</span>
            <span>attention {overview.runtimeHealth.attentionCount}</span>
            <span>exception {exceptionRunCount}</span>
            <span>runs {overview.runs.length}</span>
          </div>
        </div>
        <div className="operator-state-dashboard-actions">
          {selectedRunId ? <button type="button" onClick={onClearRun}>State Dashboard</button> : null}
          {problemCount > 0 ? <strong>{problemCount} attention</strong> : <strong>healthy</strong>}
        </div>
      </header>
      {error ? <p className="operator-muted operator-danger">Operator overview error: {error}</p> : null}
      {actionError ? <p className="operator-muted operator-danger">{actionError}</p> : null}
      <div className="operator-workflow-state-grid" aria-label="Workflow state dashboard">
        {operatorStateBuckets.map((bucket) => {
          const bucketRuns = sortedRuns.filter((run) => bucketForRunStatus(run.status) === bucket);
          return (
            <section key={bucket} className="operator-workflow-state-column" data-state={bucket}>
              <div className="operator-workflow-state-title">
                <span>{bucket}</span>
                <strong>{bucketRuns.length}</strong>
              </div>
              <div className="operator-workflow-state-stack">
                {bucketRuns.length === 0 ? (
                  <p className="operator-state-empty">No workflow runs</p>
                ) : bucketRuns.map((run) => (
                  <WorkflowStateCard
                    key={run.runId}
                    run={run}
                    attentionItems={overview.attentionItems.filter((item) => item.runId === run.runId)}
                    incidents={incidents.filter((incident) => incident.runId === run.runId)}
                    selected={selectedRunId === run.runId}
                    onSelectRun={onSelectRun}
                    onRunCommand={onRunCommand}
                    pendingCommandId={pendingCommandId}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {selectedIncident ? (
        <p className="operator-state-dashboard-warning">
          {selectedIncident.severity}: {selectedIncident.title} · {selectedIncident.nextAction}
        </p>
      ) : overview.runs.length === 0 ? (
        <p className="operator-state-dashboard-empty">No workflow runs for this project.</p>
      ) : null}
    </section>
  );
}

function WorkflowStateCard({
  run,
  attentionItems,
  incidents,
  selected,
  onSelectRun,
  onRunCommand,
  pendingCommandId,
}: {
  run: OperatorRun;
  attentionItems: OperatorAttentionItem[];
  incidents: OperatorIncident[];
  selected: boolean;
  onSelectRun: (runId: string) => void;
  onRunCommand: (run: OperatorRun, command: OperatorCommand) => void;
  pendingCommandId: string | null;
}) {
  const attentionCount = attentionItems.length + incidents.length;
  const highestIncident = incidents[0] || null;
  const projectLabel = formatProjectLabel(run);
  const toggleCommand = runToggleCommand(run);
  const cancelCommand = run.commands?.find((command) => command.id === "run.cancel");
  const selectRun = () => onSelectRun(run.runId);

  return (
    <div
      role="button"
      tabIndex={0}
      className="operator-workflow-state-card"
      aria-pressed={selected}
      onClick={selectRun}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectRun();
      }}
    >
      <span className="operator-workflow-state-card-mission">
        <span data-testid="operator-run-execution">execution {run.executionStatus ?? "unknown"}</span>
        <span data-testid="operator-run-outcome">outcome {run.outcomeStatus ?? "in_progress"}</span>
        <span data-testid="operator-run-health">health {run.healthStatus ?? "healthy"}</span>
      </span>
      <strong>{run.title}</strong>
      <span className="operator-workflow-state-card-meta">
        {projectLabel}
        {run.domain ? ` · ${run.domain}` : ""}
      </span>
      <span className="operator-workflow-state-card-meta">{shortRunId(run.runId)} · {formatRunAge(run.updatedAt)}</span>
      {attentionCount > 0 ? (
        <span className="operator-workflow-state-card-attention">
          {attentionCount} attention{highestIncident ? ` · ${highestIncident.nextAction}` : ""}
        </span>
      ) : null}
      {(toggleCommand || cancelCommand) ? (
        <span className="operator-run-command-row" aria-label="Workflow run actions">
          {toggleCommand ? (
            <button
              type="button"
              disabled={!toggleCommand.enabled || pendingCommandId === `${run.runId}:${toggleCommand.id}`}
              title={toggleCommand.disabledReason || toggleCommand.label}
              onClick={(event) => {
                event.stopPropagation();
                onRunCommand(run, toggleCommand);
              }}
            >
              {pendingCommandId === `${run.runId}:${toggleCommand.id}` ? "..." : toggleCommand.label.replace(" Run", "")}
            </button>
          ) : null}
          {cancelCommand ? (
            <button
              type="button"
              disabled={!cancelCommand.enabled || pendingCommandId === `${run.runId}:${cancelCommand.id}`}
              title={cancelCommand.disabledReason || cancelCommand.label}
              onClick={(event) => {
                event.stopPropagation();
                onRunCommand(run, cancelCommand);
              }}
            >
              {pendingCommandId === `${run.runId}:${cancelCommand.id}` ? "..." : "Cancel"}
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function runToggleCommand(run: OperatorRun): OperatorCommand | undefined {
  const pause = run.commands?.find((command) => command.id === "run.pause");
  const resume = run.commands?.find((command) => command.id === "run.resume");
  if (resume?.enabled) return resume;
  if (pause?.enabled) return pause;
  return run.status === "paused" || run.status === "blocked" ? resume : pause;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function compareRunUpdatedAt(a: OperatorRun, b: OperatorRun): number {
  const bTime = Date.parse(b.updatedAt || "");
  const aTime = Date.parse(a.updatedAt || "");
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}

function formatRunAge(updatedAt: string | undefined): string {
  if (!updatedAt) return "unknown";
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function shortRunId(runId: string): string {
  return runId.length > 18 ? `${runId.slice(0, 10)}...${runId.slice(-5)}` : runId;
}

function formatProjectLabel(run: OperatorRun): string {
  const value = run.cwd || run.projectRoot || "project unknown";
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}
