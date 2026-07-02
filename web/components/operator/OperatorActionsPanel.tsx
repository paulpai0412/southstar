"use client";

import { useState } from "react";
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
      const method = command.method || "POST";
      if (method !== "POST") throw new Error(`${command.label} uses unsupported method ${method}`);
      const payload = {
        ...(command.body || {}),
        runId,
        taskId,
        commandId: `ui:${command.id}:${Date.now()}:${crypto.randomUUID()}`,
        actor: { type: "user", id: "operator-ui" },
        ...(normalizedReason ? { reason: normalizedReason } : {}),
      };
      const response = await fetch("/api/operator/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: command.endpoint,
          method,
          payload,
        }),
      });
      if (!response.ok) throw new Error(`${command.label} failed with ${response.status}`);
      const result = await response.json() as { result?: { accepted?: unknown; message?: unknown }; accepted?: unknown; message?: unknown };
      const accepted = typeof result.result?.accepted === "boolean" ? result.result.accepted : result.accepted;
      if (accepted !== true) {
        const message = typeof result.result?.message === "string" ? result.result.message : typeof result.message === "string" ? result.message : "command was not accepted";
        throw new Error(message);
      }
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
