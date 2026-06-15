import type { PlannerDraftView, WorkflowCanvasView } from "./types";

type CanvasNode = WorkflowCanvasView["nodes"][number];
type PositionedNode = CanvasNode & { x: number; y: number; ordinal: number };

export function WorkflowCanvas(props: {
  draft?: PlannerDraftView | null;
  model?: WorkflowCanvasView;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}) {
  const nodes = props.model?.nodes ?? [];
  const draft = props.draft ?? null;
  const positioned = layoutNodes(nodes);
  const byId = new Map(positioned.map((node) => [node.id, node]));

  return (
    <section className="ss-panel ss-canvas" data-panel="workflow-canvas" id="workflow-canvas">
      <header>
        <h2>Workflow Canvas <span>(Draft v3)</span></h2>
        <div className="ss-canvas-tools">
          <button type="button">100%</button>
          <button type="button">Layout</button>
          <label><input type="checkbox" defaultChecked /> CP Trace</label>
        </div>
      </header>
      <div className="ss-dag">
        {nodes.length === 0 ? (
          <div className="ss-empty ss-dag-empty">
            {draft ? (
              <>
                <strong>Draft ready</strong>
                <span>{draft.workflowId}</span>
                <span>Press Run to submit this dynamic workflow to the executor.</span>
              </>
            ) : "Create a planner draft, then run it to load the workflow DAG."}
          </div>
        ) : (
          <svg className="ss-dag-svg" viewBox="0 0 620 600" role="img" aria-label="workflow DAG">
            <defs>
              <marker id="ss-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                <path d="M0,0 L0,6 L7,3 z" fill="#7f91aa" />
              </marker>
            </defs>
            {positioned.flatMap((node) => node.dependsOn.map((dependency) => {
              const from = byId.get(dependency);
              if (!from) return null;
              return (
                <path
                  key={`${dependency}-${node.id}`}
                  className="ss-dag-edge"
                  d={`M ${from.x + 105} ${from.y + 96} C ${from.x + 105} ${from.y + 130}, ${node.x + 105} ${node.y - 32}, ${node.x + 105} ${node.y}`}
                  markerEnd="url(#ss-arrow)"
                />
              );
            }))}
            {positioned.map((node) => (
              <g
                key={node.id}
                className={`ss-dag-node ss-dag-node-${node.status.toLowerCase()} ${props.selectedTaskId === node.id ? "ss-dag-node-selected" : ""}`}
                transform={`translate(${node.x} ${node.y})`}
                onClick={() => props.onSelectTask(node.id)}
                role="button"
                tabIndex={0}
              >
                <rect width="210" height="96" rx="8" />
                <text x="14" y="24" className="ss-dag-title">T{node.ordinal} {compactNodeLabel(node.label)}</text>
                <text x="14" y="47">Role: {roleFor(node.ordinal)}</text>
                <text x="14" y="66">Model: gpt-4.1</text>
                <text x="14" y="84">CP: {node.id.slice(0, 8)}</text>
                <text x="114" y="84" className="ss-dag-status">Status: {node.status}</text>
                <circle cx="190" cy="21" r="5" />
              </g>
            ))}
          </svg>
        )}
      </div>
    </section>
  );
}

function layoutNodes(nodes: CanvasNode[]): PositionedNode[] {
  const coordinates = [
    [205, 20],
    [205, 145],
    [70, 290],
    [340, 290],
    [70, 440],
    [340, 440],
    [205, 540],
    [205, 540],
  ];
  return nodes.map((node, index) => {
    const [x, y] = coordinates[index] ?? [70 + (index % 2) * 270, 100 + Math.floor(index / 2) * 128];
    return { ...node, x, y, ordinal: index + 1 };
  });
}

function roleFor(ordinal: number): string {
  return ["Analyst", "Software Engineer", "Coder", "Tester", "Writer", "Verifier", "Evaluator", "Deploy"][ordinal - 1] ?? "Agent";
}

function compactNodeLabel(label: string): string {
  return label.length > 17 ? `${label.slice(0, 14)}...` : label;
}
