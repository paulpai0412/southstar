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
    const reason = (reasonByCommand[command.id] || "").trim();
    if (command.requiresConfirmation && !reason) return;
    if (command.requiresConfirmation && !window.confirm(`Run ${command.label} with reason "${reason}"?`)) return;
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
        ...(reason ? { reason } : {}),
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
      {actionError ? <p className="operator-muted operator-danger">{actionError}</p> : null}
      {commands.length === 0 ? (
        <p className="operator-muted">No actions available for this target.</p>
      ) : commands.map((command) => (
        <div key={command.id} className="operator-action-row">
          {command.requiresConfirmation ? (
            <input
              value={reasonByCommand[command.id] || ""}
              onChange={(event) => setReasonByCommand((current) => ({ ...current, [command.id]: event.currentTarget.value }))}
              placeholder="Reason"
            />
          ) : <span />}
          <button
            type="button"
            disabled={!command.enabled || pendingCommandId === command.id || (command.requiresConfirmation && !(reasonByCommand[command.id] || "").trim())}
            onClick={() => void invoke(command)}
          >
            {pendingCommandId === command.id ? `Pending ${command.label}` : command.label}
          </button>
          {!command.enabled && command.disabledReason ? <p className="operator-muted">{command.disabledReason}</p> : null}
        </div>
      ))}
      {commandResults.slice(0, 6).map((result) => (
        <p key={`${result.commandId}:${result.updatedAt || result.status}`} className="operator-muted">
          {result.status} · {result.commandId} {result.message || ""}
        </p>
      ))}
    </section>
  );
}
