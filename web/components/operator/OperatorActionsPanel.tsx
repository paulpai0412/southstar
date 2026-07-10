"use client";

import { useState } from "react";
import { invokeOperatorCommand } from "@/lib/operator/invokeCommand";
import type { OperatorCommand, OperatorCommandResult } from "@/lib/operator/types";

export function OperatorActionsPanel({
  runId,
  taskId,
  commands,
  commandResults,
  onCommandComplete,
}: {
  runId: string | null;
  taskId: string | null;
  commands: OperatorCommand[];
  commandResults: OperatorCommandResult[];
  onCommandComplete: () => void;
}) {
  const [reasonByCommand, setReasonByCommand] = useState<Record<string, string>>({});
  const [checkpointByCommand, setCheckpointByCommand] = useState<Record<string, string>>({});
  const [snapshotByCommand, setSnapshotByCommand] = useState<Record<string, string>>({});
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function invoke(command: OperatorCommand) {
    if (!command.endpoint || !command.enabled) return;
    const reason = reasonByCommand[command.id] || "";
    const normalizedReason = reason.trim();
    if (requiresReason(command) && !normalizedReason) {
      setActionError(`Reason required before running ${command.label}`);
      return;
    }
    if (command.requiresConfirmation && !window.confirm(`Run ${command.label} with reason "${normalizedReason}"?`)) return;
    setPendingCommandId(command.id);
    setActionError(null);
    try {
      await invokeOperatorCommand({
        command,
        runId,
        taskId,
        reason: normalizedReason,
        payload: commandPayload(command, {
          checkpointId: checkpointByCommand[command.id],
          workspaceSnapshotRef: snapshotByCommand[command.id] || command.inputOptions?.workspaceSnapshotRefs?.[0],
          revisionReason: normalizedReason,
        }),
      });
      onCommandComplete();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingCommandId(null);
    }
  }

  return (
    <section data-testid="operator-actions-panel" className="operator-debug-panel">
      <header className="operator-panel-header"><h2>Recovery actions</h2></header>
      {actionError ? (
        <div className="operator-command-result operator-danger">
          <strong>Command result</strong>
          <span>{actionError}</span>
        </div>
      ) : null}
      {commands.length === 0 ? (
        <p className="operator-muted">No actions available for this target.</p>
      ) : commands.map((command) => (
        <article key={command.id} className="operator-action-card">
          <div className="operator-action-main">
            <div>
              <strong>{command.label}</strong>
              <span>{command.endpoint || "No endpoint available"}</span>
            </div>
            <button
              type="button"
              disabled={!command.enabled || pendingCommandId === command.id}
              onClick={() => void invoke(command)}
            >
              {pendingCommandId === command.id ? `Pending ${command.label}` : command.label}
            </button>
          </div>
          {command.inputOptions?.checkpointRefs?.length ? (
            <label className="operator-action-field">
              <span>Checkpoint</span>
              <select
                value={checkpointByCommand[command.id] || ""}
                onChange={(event) => setCheckpointByCommand((current) => ({ ...current, [command.id]: event.currentTarget.value }))}
              >
                <option value="">Fresh session</option>
                {command.inputOptions.checkpointRefs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
              </select>
            </label>
          ) : null}
          {command.inputOptions?.workspaceSnapshotRefs?.length ? (
            <label className="operator-action-field">
              <span>Workspace snapshot</span>
              <select
                value={snapshotByCommand[command.id] || command.inputOptions.workspaceSnapshotRefs[0] || ""}
                onChange={(event) => setSnapshotByCommand((current) => ({ ...current, [command.id]: event.currentTarget.value }))}
              >
                {command.inputOptions.workspaceSnapshotRefs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
              </select>
            </label>
          ) : null}
          <dl className="operator-action-meta">
            <dt>Consequence</dt>
            <dd>{command.consequence || describeCommandConsequence(command)}</dd>
            <dt>Audit reason</dt>
            <dd>
              <textarea
                className="operator-action-reason"
                value={reasonByCommand[command.id] || ""}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setReasonByCommand((current) => ({ ...current, [command.id]: value }));
                }}
                placeholder={requiresReason(command) ? "Reason required before running" : "Optional reason"}
                aria-label={`Reason for ${command.label}`}
                rows={2}
              />
            </dd>
          </dl>
          {!command.enabled && command.disabledReason ? <p className="operator-muted">{command.disabledReason}</p> : null}
        </article>
      ))}
      <section className="operator-command-results" aria-label="Command results">
        <header className="operator-panel-header"><h2>Command result</h2></header>
        {commandResults.length === 0 ? <p className="operator-muted">No command result recorded yet.</p> : null}
        {commandResults.slice(0, 6).map((result) => (
          <p key={`${result.commandId}:${result.updatedAt || result.status}`} className="operator-command-result">
            <strong>{result.status}</strong>
            <span>{result.commandId} {result.message || ""}</span>
          </p>
        ))}
      </section>
    </section>
  );
}

function commandPayload(command: OperatorCommand, input: { checkpointId?: string; workspaceSnapshotRef?: string; revisionReason?: string }): Record<string, unknown> {
  return {
    ...(command.id === "task.fork-session" || command.id === "task.reset-session" || command.id === "task.rollback-session"
      ? input.checkpointId ? { checkpointId: input.checkpointId } : {}
      : {}),
    ...(command.id === "task.rollback-session" && input.workspaceSnapshotRef ? { workspaceSnapshotRef: input.workspaceSnapshotRef } : {}),
    ...(command.id === "task.request-revision" && input.revisionReason ? { revisionReason: input.revisionReason } : {}),
  };
}

function requiresReason(command: OperatorCommand): boolean {
  return command.requiresConfirmation || Boolean(command.endpoint);
}

function describeCommandConsequence(command: OperatorCommand): string {
  const value = `${command.id} ${command.label}`.toLowerCase();
  if (value.includes("retry")) return "Retries the selected task and records the operator reason in command history.";
  if (value.includes("resume")) return "Moves the run or task back into active execution after recording the operator reason.";
  if (value.includes("cancel")) return "Stops the selected run or task and prevents normal downstream progress.";
  if (value.includes("quarantine")) return "Keeps the target in human-intervention state until a follow-up recovery action is taken.";
  return "Records an operator intervention and may change the selected run or task state.";
}
