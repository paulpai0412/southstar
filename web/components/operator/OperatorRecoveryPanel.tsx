"use client";

import { useState } from "react";
import { invokeOperatorCommand } from "@/lib/operator/invokeCommand";
import type { OperatorCommand, OperatorCommandResult, OperatorResourceItem, OperatorTaskDebug } from "@/lib/operator/types";

export function OperatorRecoveryPanel({
  debug,
  commands: attentionCommands,
  commandResults,
  onCommandComplete,
}: {
  debug: OperatorTaskDebug;
  commands: OperatorCommand[];
  commandResults: OperatorCommandResult[];
  onCommandComplete: () => void;
}) {
  const recovery = debug.data.debug?.recovery;
  const items = recovery?.items ?? [];
  const commands = mergeCommands(attentionCommands, debug.data.recoveryActions ?? [], recovery?.commands ?? []);
  const [reasonByCommand, setReasonByCommand] = useState<Record<string, string>>({});
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function invoke(command: OperatorCommand) {
    if (!command.endpoint || !command.enabled) return;
    const reason = (reasonByCommand[command.id] || "").trim();
    if (!reason) {
      setError(`Reason required before running ${command.label}`);
      return;
    }
    if (command.requiresConfirmation && !window.confirm(`Run ${command.label} with reason "${reason}"?`)) return;
    setPendingCommandId(command.id);
    setError(null);
    try {
      await invokeOperatorCommand({ command, runId: debug.data.runId, taskId: debug.data.task.taskId, reason });
      onCommandComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingCommandId(null);
    }
  }

  return (
    <section className="operator-debug-panel">
      <header className="operator-panel-header"><h2>Recovery</h2></header>
      {error ? <p className="operator-muted operator-danger">{error}</p> : null}
      {items.length === 0 ? <p className="operator-muted">No recovery decision, approval, or execution for this task.</p> : null}
      {items.map((item) => <RecoveryItem key={`${item.resourceType}:${item.resourceKey}`} item={item} />)}
      {commands.length > 0 ? (
        <section className="operator-command-results" aria-label="Recovery commands">
          <header className="operator-panel-header"><h2>Commands</h2></header>
          {commands.map((command) => (
            <article key={command.id} className="operator-action-card">
              <div className="operator-action-main">
                <div>
                  <strong>{command.label}</strong>
                  <span>{command.endpoint || command.disabledReason || "No endpoint available"}</span>
                </div>
                <button type="button" disabled={!command.enabled || pendingCommandId === command.id} onClick={() => void invoke(command)}>
                  {pendingCommandId === command.id ? `Pending ${command.label}` : command.label}
                </button>
              </div>
              <textarea
                className="operator-action-reason"
                value={reasonByCommand[command.id] || ""}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setReasonByCommand((current) => ({ ...current, [command.id]: value }));
                }}
                placeholder="Reason required before running"
                aria-label={`Reason for ${command.label}`}
                rows={2}
              />
              {!command.enabled && command.disabledReason ? <p className="operator-muted">{command.disabledReason}</p> : null}
            </article>
          ))}
        </section>
      ) : null}
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

function RecoveryItem({ item }: { item: OperatorResourceItem }) {
  return (
    <article className="operator-debug-card">
      <div className="operator-debug-card-title">
        <strong>{item.resourceType}</strong>
        <span>{item.status}</span>
      </div>
      <p className="operator-muted">{item.title || item.resourceKey}</p>
      <pre>{JSON.stringify({ resourceKey: item.resourceKey, summary: item.summary, payload: item.payload }, null, 2)}</pre>
    </article>
  );
}

function mergeCommands(...groups: OperatorCommand[][]): OperatorCommand[] {
  const merged = new Map<string, OperatorCommand>();
  for (const group of groups) for (const command of group) merged.set(command.id, command);
  return [...merged.values()];
}
