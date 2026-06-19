type GraphReadModel = {
  centerNodeId?: string;
  nodes?: Array<{ id: string; type: string; label?: string; status?: string }>;
  edges?: Array<{ id: string; from: string; to: string; type: string }>;
};

export function EvolutionGraphViewer(props: { graph?: GraphReadModel | null; onSelectNode?: (nodeId: string) => void }) {
  const nodes = props.graph?.nodes ?? [];
  const edges = props.graph?.edges ?? [];
  return (
    <section className="ss-evolution-graph" aria-label="Graph Viewer">
      <div className="ss-evolution-graph__canvas">
        {nodes.slice(0, 24).map((node, index) => (
          <article key={node.id} className="ss-evolution-node" style={{ ["--node-index" as string]: index }}>
            <button type="button" aria-label={`Select graph node ${node.id}`} onClick={() => props.onSelectNode?.(node.id)}>
              <span>{node.type}</span>
              <strong>{node.label ?? node.id}</strong>
              {node.status ? <em>{node.status}</em> : null}
            </button>
          </article>
        ))}
        {nodes.length === 0 ? <p>No local graph selected.</p> : null}
      </div>
      <div className="ss-evolution-edges">
        <strong>Local edges</strong>
        {edges.slice(0, 40).map((edge) => (
          <code key={edge.id}>{edge.from} --{edge.type}→ {edge.to}</code>
        ))}
      </div>
    </section>
  );
}
