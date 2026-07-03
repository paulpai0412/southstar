"use client";

export type LibraryGraphChartNode = {
  objectKey: string;
  objectKind?: string;
  status?: string;
  title?: string;
};

export type LibraryGraphChartEdge = {
  fromObjectKey: string;
  toObjectKey: string;
  edgeType?: string;
  ontology?: {
    category?: string;
    confidence?: number;
    rationale?: string;
    source?: string;
    draftId?: string;
    evidenceRefs?: string[];
  };
};

export function LibraryGraphChart({
  nodes,
  edges,
  onSelectNode,
}: {
  nodes: LibraryGraphChartNode[];
  edges: LibraryGraphChartEdge[];
  onSelectNode?: (node: LibraryGraphChartNode) => void;
}) {
  const width = 560;
  const rowHeight = 54;
  const height = Math.max(120, nodes.length * rowHeight + 24);
  const positions = new Map(nodes.map((node, index) => [
    node.objectKey,
    {
      x: index % 2 === 0 ? 132 : 398,
      y: 32 + index * rowHeight,
    },
  ]));

  return (
    <div data-testid="library-graph-chart" style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
      <svg width={width} height={height} role="img" aria-label="Library graph chart" style={{ display: "block", background: "var(--bg-subtle)" }}>
        {edges.map((edge, index) => {
          const from = positions.get(edge.fromObjectKey);
          const to = positions.get(edge.toObjectKey);
          if (!from || !to) return null;
          const midX = (from.x + to.x) / 2;
          const edgeStyle = edgeVisualStyle(edge);
          const label = edgeLabel(edge);
          return (
            <g key={`${edge.fromObjectKey}:${edge.toObjectKey}:${index}`}>
              <path
                d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
                fill="none"
                stroke={edgeStyle.stroke}
                strokeDasharray={edgeStyle.dash}
                strokeWidth="1.6"
              />
              {label ? (
                <text x={midX} y={(from.y + to.y) / 2 - 4} textAnchor="middle" fontSize="10" fill={edgeStyle.label}>
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
        {nodes.map((node) => {
          const position = positions.get(node.objectKey);
          if (!position) return null;
          return (
            <g
              key={node.objectKey}
              data-testid="library-graph-node"
              role={onSelectNode ? "button" : undefined}
              aria-label={onSelectNode ? (node.title ?? node.objectKey) : undefined}
              tabIndex={onSelectNode ? 0 : undefined}
              onClick={() => onSelectNode?.(node)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectNode?.(node);
                }
              }}
              style={{ cursor: onSelectNode ? "pointer" : "default" }}
            >
              <rect x={position.x - 92} y={position.y - 18} width="184" height="36" rx="6" fill="var(--bg)" stroke="var(--border)" />
              <text x={position.x} y={position.y - 3} textAnchor="middle" fontSize="11" fill="var(--text)" fontWeight="600">
                {node.title ?? node.objectKey}
              </text>
              <text x={position.x} y={position.y + 11} textAnchor="middle" fontSize="9" fill="var(--text-dim)">
                {node.objectKind ?? node.objectKey}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function edgeLabel(edge: LibraryGraphChartEdge): string {
  const type = edge.edgeType ?? "";
  const confidence = typeof edge.ontology?.confidence === "number" ? edge.ontology.confidence.toFixed(2) : "";
  return [type, confidence].filter(Boolean).join(" ");
}

function edgeVisualStyle(edge: LibraryGraphChartEdge): { stroke: string; label: string; dash?: string } {
  const kind = edge.ontology?.category ?? edge.edgeType ?? "";
  if (kind.includes("conflict")) {
    return { stroke: "var(--danger, #b42318)", label: "var(--danger, #b42318)", dash: "4 3" };
  }
  if (kind.includes("similar")) {
    return { stroke: "var(--accent, #4f46e5)", label: "var(--accent, #4f46e5)", dash: "2 3" };
  }
  if (kind.includes("workflow") || kind.includes("preced")) {
    return { stroke: "var(--warning, #b54708)", label: "var(--warning, #b54708)", dash: "6 3" };
  }
  return { stroke: "var(--border)", label: "var(--text-dim)" };
}
