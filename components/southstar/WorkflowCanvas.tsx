import type { WorkflowCanvasView } from "./types";

export function WorkflowCanvas(props: {
  model?: WorkflowCanvasView;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}) {
  const nodes = props.model?.nodes ?? [];
  return (
    <section className="ss-panel ss-canvas" data-panel="workflow-canvas" id="workflow-canvas">
      <header>
        <h2>Workflow Canvas</h2>
        <span>Dynamic Workflow</span>
      </header>
      <div className="ss-dag">
        {nodes.length === 0 ? (
          <div className="ss-empty">Create a planner draft, then run it to load the workflow DAG.</div>
        ) : nodes.map((node) => (
          <button
            className={`ss-node ss-node-${node.status.toLowerCase()}`}
            key={node.id}
            type="button"
            aria-pressed={props.selectedTaskId === node.id}
            onClick={() => props.onSelectTask(node.id)}
          >
            <strong>{node.label}</strong>
            <span>{node.status}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
