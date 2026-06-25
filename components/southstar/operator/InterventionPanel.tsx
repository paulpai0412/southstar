"use client";

import { RunEventStreamPanel } from "./RunEventStreamPanel";

export function InterventionPanel(props: {
  baseUrl: string;
  runId?: string | null;
  selectedItem: any;
  workflowModel: any;
  onCommand: (endpoint: string, commandId: string, requiresConfirmation?: boolean) => Promise<void>;
}) {
  const commands = props.workflowModel?.commands ?? [];
  return (
    <aside style={{ borderLeft: "1px solid var(--border)", background: "var(--bg)", padding: 10, overflow: "auto" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 13 }}>Intervention Panel</h2>
      <pre style={{ margin: 0, maxHeight: 180, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: 8, fontSize: 11 }}>
        {JSON.stringify(props.selectedItem ?? props.workflowModel?.selectedDefinition ?? null, null, 2)}
      </pre>
      <section style={{ marginTop: 10 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>Commands</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {commands.map((command: any) => (
            <button
              key={command.id}
              type="button"
              disabled={!command.enabled}
              title={command.disabledReason}
              onClick={() => props.onCommand(command.endpoint, command.id, command.requiresConfirmation)}
              style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, padding: "5px 8px" }}
            >
              {command.label}
            </button>
          ))}
        </div>
      </section>
      <RunEventStreamPanel baseUrl={props.baseUrl} runId={props.runId} />
    </aside>
  );
}
