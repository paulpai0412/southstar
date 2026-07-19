"use client";

import { LibraryGraphChart, prepareGraphNodeSelection, type LibraryGraphChartEdge, type LibraryGraphChartNode } from "./library/LibraryGraphChart";

export type CoverageGraphData = {
  nodes: LibraryGraphChartNode[];
  edges: LibraryGraphChartEdge[];
};

export function CoverageGraphPreview({
  testId,
  persistLayoutKey,
  nodes,
  edges,
  description,
  onSelectNode,
}: CoverageGraphData & {
  testId: string;
  persistLayoutKey: string;
  description: string;
  onSelectNode?: (node: LibraryGraphChartNode) => void;
}) {
  const graph = { nodes, edges };
  return (
    <section data-testid={testId} style={previewStyle}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong>Coverage preview</strong>
        <span data-testid={`${testId}-summary`} style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {nodes.length} nodes · {edges.length} edges
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{description}</div>
      {nodes.length > 0 ? (
        <LibraryGraphChart
          nodes={nodes}
          edges={edges}
          persistLayoutKey={persistLayoutKey}
          onSelectNode={(node) => onSelectNode?.(prepareGraphNodeSelection(graph, node))}
        />
      ) : (
        <div data-testid={`${testId}-empty`} style={{ padding: 10, border: "1px dashed var(--border)", borderRadius: 7, color: "var(--text-dim)", fontSize: 11 }}>
          No coverage lineage is available at this step.
        </div>
      )}
    </section>
  );
}

const previewStyle = {
  display: "grid",
  gap: 7,
  marginTop: 10,
  paddingTop: 10,
  borderTop: "1px solid var(--border)",
} as const;
