export function TaskInspector(props: { model: any | null; selectedTaskId?: string | null; onRunDraft: () => void; running?: boolean; runDisabled?: boolean }) {
  const task = props.model?.draft?.taskInspector;
  const promptSummary = props.model?.draft?.plannerRationale;

  return (
    <aside className="ss-task-inspector">
      <header>
        <h2>Task Inspector</h2>
        <button type="button">Customize this run</button>
      </header>
      {task ? (
        <>
          <dl>
            <div><dt>Task</dt><dd>{task.taskId}</dd></div>
            <div><dt>Agent</dt><dd>{task.agentDefinitionRef}</dd></div>
            <div><dt>Profile</dt><dd>{task.agentProfileRef}</dd></div>
            <div><dt>Skills</dt><dd>{task.skillRefs.join(", ") || "none"}</dd></div>
            <div><dt>MCP grants</dt><dd>{task.mcpGrantRefs.join(", ") || "none"}</dd></div>
          </dl>
          <h3>Why selected</h3>
          <p>{task.rationale}</p>
        </>
      ) : <p className="ss-empty">Select a task from DAG Flow.</p>}
      <h3>Context Sources</h3>
      <ul>
        <li>Run Brief</li>
        <li>Repo Fact Cache</li>
        <li>Artifact Summaries</li>
        <li>Memory Injection Trace</li>
      </ul>
      <h3>Planner rationale</h3>
      <p>{promptSummary ?? "No rationale yet."}</p>
      <button type="button" onClick={props.onRunDraft} disabled={props.runDisabled || props.running}>{props.running ? "Starting run…" : "Run workflow"}</button>
    </aside>
  );
}
