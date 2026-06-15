export function GraphCanvas(props: { nodes: Array<{ taskId: string; label: string; status: string }>; onSelect?: (taskId: string) => void }) {
  return (
    <div className="ss-graph-canvas">
      {props.nodes.map((node) => (
        <button key={node.taskId} className={`ss-graph-node ss-status-${node.status}`} onClick={() => props.onSelect?.(node.taskId)}>
          <strong>{node.label}</strong>
          <span>{node.status}</span>
        </button>
      ))}
    </div>
  );
}
