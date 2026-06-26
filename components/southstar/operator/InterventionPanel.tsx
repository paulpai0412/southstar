"use client";

import { useState } from "react";

export type OperatorCommand = {
  id: string;
  label: string;
  endpoint?: string;
  method?: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
  body?: Record<string, unknown>;
};

export type OperatorCommandResult = {
  commandId: string;
  status: string;
  accepted?: boolean;
  message?: string;
  affectedRunId?: string;
  affectedTaskId?: string;
  updatedAt?: string;
};

export function InterventionPanel(props: {
  runId: string | null;
  targetTaskId?: string | null;
  targetAttentionId?: string | null;
  interventionMode?: string | null;
  source?: { resourceType?: string; resourceKey?: string; ref?: string } | null;
  detail?: Record<string, unknown> | null;
  commands: OperatorCommand[];
  commandResults?: OperatorCommandResult[];
  onInvokeCommand: (command: OperatorCommand, reason?: string) => Promise<void>;
}) {
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const [reasonByCommand, setReasonByCommand] = useState<Record<string, string>>({});
  const commands = props.commands;

  async function invoke(command: OperatorCommand): Promise<void> {
    if (!command.enabled) return;
    const reason = (reasonByCommand[command.id] ?? "").trim();
    if (command.requiresConfirmation) {
      if (!reason) return;
      if (!window.confirm(`Run ${command.label} with reason "${reason}"?`)) return;
    }
    setPendingCommandId(command.id);
    try {
      await props.onInvokeCommand(command, reason);
      if (reason) {
        setReasonByCommand((current) => ({ ...current, [command.id]: "" }));
      }
    } finally {
      setPendingCommandId(null);
    }
  }

  return (
    <section className="ss-panel">
      <h2>Intervention Panel</h2>
      <p className="ss-empty">
        Target run: {props.runId ?? "none"}
        {props.targetTaskId ? ` · task ${props.targetTaskId}` : ""}
        {props.targetAttentionId ? ` · attention ${props.targetAttentionId}` : ""}
        {props.interventionMode ? ` · mode ${props.interventionMode}` : ""}
      </p>
      {props.source ? (
        <p className="ss-empty">
          Source: {props.source.resourceType ?? "unknown"} {props.source.resourceKey ?? props.source.ref ?? ""}
        </p>
      ) : null}
      {props.detail && Object.keys(props.detail).length > 0 ? (
        <dl className="ss-timeline">
          {Object.entries(props.detail).slice(0, 8).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{formatDetailValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {commands.length > 0 ? (
        <ul className="ss-timeline">
          {commands.map((command) => (
            <li key={command.id}>
              {command.requiresConfirmation ? (
                <input
                  type="text"
                  placeholder="Reason"
                  value={reasonByCommand[command.id] ?? ""}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    setReasonByCommand((current) => ({ ...current, [command.id]: next }));
                  }}
                />
              ) : null}
              <button
                type="button"
                disabled={
                  !command.enabled
                  || pendingCommandId === command.id
                  || (command.requiresConfirmation && !(reasonByCommand[command.id] ?? "").trim())
                }
                onClick={() => void invoke(command)}
              >
                {pendingCommandId === command.id ? `Pending ${command.label}` : command.label}
              </button>
              {command.requiresConfirmation ? <span>requiresConfirmation</span> : null}
              {!command.enabled && command.disabledReason ? <p className="ss-empty">{command.disabledReason}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="ss-empty">No operator commands available.</p>
      )}
      {props.commandResults && props.commandResults.length > 0 ? (
        <ul className="ss-timeline">
          {props.commandResults.slice(0, 5).map((result) => (
            <li key={result.commandId}>
              <strong>{result.status}</strong>
              <span> {result.commandId}</span>
              {result.message ? <p className="ss-empty">{result.message}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
