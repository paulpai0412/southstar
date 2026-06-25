"use client";

export function DefinitionInspector(props: {
  selectedDefinition: any;
  onRunWorkflow: () => void;
  runDisabled: boolean;
  running: boolean;
}) {
  const definition = props.selectedDefinition;
  return (
    <aside style={{ borderLeft: "1px solid var(--border)", background: "var(--bg)", padding: 12, overflow: "auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 13 }}>Definition Inspector</h2>
        <button type="button" onClick={props.onRunWorkflow} disabled={props.runDisabled || props.running}>
          {props.running ? "Starting..." : "Run"}
        </button>
      </header>
      {!definition ? <p style={{ color: "var(--text-dim)", fontSize: 12 }}>Select a workflow task.</p> : (
        <div style={{ display: "grid", gap: 10, marginTop: 12, fontSize: 12 }}>
          <InspectorBlock title="Task" value={definition.task ?? { taskId: definition.taskId }} />
          <InspectorBlock title="Role" value={definition.roleDefinition} />
          <InspectorBlock title="Agent Profile" value={definition.agentProfile} />
          <InspectorBlock title="Skills" value={definition.skills} />
          <InspectorBlock title="Materialized Library Refs" value={definition.materializedLibraryRefs} />
          <InspectorBlock title="Artifact Contract" value={definition.artifactContract} />
          <InspectorBlock title="Evaluator Pipeline" value={definition.evaluatorPipeline} />
          <InspectorBlock title="Context Policy" value={definition.contextPolicy} />
        </div>
      )}
    </aside>
  );
}

function InspectorBlock(props: { title: string; value: unknown }) {
  return (
    <section>
      <h3 style={{ margin: "0 0 4px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>{props.title}</h3>
      <pre style={{ margin: 0, overflow: "auto", maxHeight: 180, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: 8, fontSize: 11 }}>
        {JSON.stringify(props.value ?? null, null, 2)}
      </pre>
    </section>
  );
}
