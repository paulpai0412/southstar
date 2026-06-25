"use client";

import type { SouthstarApiClient } from "@/lib/southstar/api-client";

export function WorkflowWorkbench(props: {
  api: SouthstarApiClient;
  activeCwd: string | null;
  onOpenOperator: (runId?: string) => void;
}) {
  return (
    <section className="ss-workflow-workbench">
      <aside className="ss-panel">
        <h2>AgentLibraryPanel</h2>
        <p>Agent library scaffold for skills, MCP, tools, and profiles.</p>
      </aside>
      <section className="ss-panel">
        <h2>SouthstarWorkflowCanvas</h2>
        <p>Canvas placeholder. Active cwd: {props.activeCwd ?? "not selected"}.</p>
        <button type="button" onClick={() => props.onOpenOperator()}>
          Open Operator
        </button>
      </section>
      <aside className="ss-panel">
        <h2>DefinitionInspector</h2>
        <p>Definition panel scaffold for selected node config.</p>
      </aside>
    </section>
  );
}
