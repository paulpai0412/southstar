export function WorkflowDagPanel(props: { model: any | null; selectedTaskId?: string | null; onSelectTask: (taskId: string) => void }) {
  const draft = props.model?.draft;
  const nodes = draft?.dag?.nodes ?? [];
  const edges = draft?.dag?.edges ?? [];

  return (
    <section className="ss-workflow-dag">
      <header><h2>DAG Flow</h2><p>Review task order before execution.</p></header>
      {nodes.length === 0 ? <p className="ss-empty">No DAG yet. Submit a workflow goal to generate a draft.</p> : (
        <div>
          <ul>
            {nodes.map((node: any) => (
              <li key={node.id}>
                <button type="button" aria-pressed={props.selectedTaskId === node.id} onClick={() => props.onSelectTask(node.id)}>
                  <strong>{node.label}</strong>
                  <span>{node.status}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="ss-dag-edge-summary">Edges: {edges.map((edge: any) => `${edge.from} → ${edge.to}`).join(" · ") || "none"}</p>
        </div>
      )}
    </section>
  );
}
