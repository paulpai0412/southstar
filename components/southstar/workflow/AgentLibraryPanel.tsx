"use client";

export function AgentLibraryPanel(props: {
  library: any;
  goalPrompt: string;
  planning: boolean;
  onGoalPromptChange: (value: string) => void;
  onGenerate: () => void;
}) {
  return (
    <aside style={{ borderRight: "1px solid var(--border)", background: "var(--bg-panel)", padding: 12, overflow: "auto" }}>
      <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
        Goal
        <textarea
          value={props.goalPrompt}
          onChange={(event) => props.onGoalPromptChange(event.target.value)}
          style={{ minHeight: 120, resize: "vertical", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", padding: 10 }}
        />
      </label>
      <button type="button" onClick={props.onGenerate} disabled={props.planning} style={{ marginTop: 10 }}>
        {props.planning ? "Generating..." : "Generate Workflow"}
      </button>
      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 12, textTransform: "uppercase", color: "var(--text-muted)" }}>Agent Library</h2>
        <LibraryList title="Roles" items={props.library?.roles} />
        <LibraryList title="Agent Profiles" items={props.library?.agentProfiles} />
        <LibraryList title="Skills" items={props.library?.skills} />
        <LibraryList title="MCP" items={props.library?.mcpServers} />
        <LibraryList title="Tools" items={props.library?.tools} />
        <LibraryList title="Artifact Contracts" items={props.library?.artifactContracts} />
        <LibraryList title="Evaluators" items={props.library?.evaluatorPipelines} />
      </section>
    </aside>
  );
}

function LibraryList(props: { title: string; items: any[] | undefined }) {
  const items = props.items ?? [];
  return (
    <details open style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text)" }}>{props.title} · {items.length}</summary>
      <ul style={{ margin: "6px 0 0", paddingLeft: 16, color: "var(--text-muted)", fontSize: 11 }}>
        {items.slice(0, 8).map((item, index) => <li key={String(item.id ?? item.name ?? index)}>{String(item.id ?? item.name ?? item.title ?? index)}</li>)}
      </ul>
    </details>
  );
}
