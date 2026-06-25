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
};

export function InterventionPanel(props: {
  runId: string | null;
  targetTaskId?: string | null;
  targetAttentionId?: string | null;
  commands: OperatorCommand[];
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
      </p>
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
                {command.label}
              </button>
              {command.requiresConfirmation ? <span>requiresConfirmation</span> : null}
              {!command.enabled && command.disabledReason ? <p className="ss-empty">{command.disabledReason}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="ss-empty">No operator commands available.</p>
      )}
    </section>
  );
}
