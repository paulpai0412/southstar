"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";

export type LibraryGraphChartNode = {
  objectKey: string;
  objectKind?: string;
  status?: string;
  viewOnly?: boolean;
  title?: string;
  sourcePath?: string;
  sourceContent?: string;
  metadata?: Record<string, unknown>;
  selectionGraph?: LibraryGraphSelectionGraph;
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

export type LibraryGraphSelectionGraph = {
  activeScope?: string;
  nodes: LibraryGraphChartNode[];
  edges: LibraryGraphChartEdge[];
};

export function selectGraphNeighborhood(
  graph: LibraryGraphSelectionGraph,
  objectKey: string,
): LibraryGraphSelectionGraph {
  const visibleKeys = new Set([objectKey]);
  const relatedEdgeIndexes = new Set<number>();
  const adjacency = new Map<string, number[]>();
  graph.edges.forEach((edge, index) => {
    for (const key of new Set([edge.fromObjectKey, edge.toObjectKey])) {
      const indexes = adjacency.get(key) ?? [];
      indexes.push(index);
      adjacency.set(key, indexes);
    }
  });

  const pending = [objectKey];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const currentKey = pending[cursor];
    for (const edgeIndex of adjacency.get(currentKey) ?? []) {
      relatedEdgeIndexes.add(edgeIndex);
      const edge = graph.edges[edgeIndex];
      const connectedKey = edge.fromObjectKey === currentKey ? edge.toObjectKey : edge.fromObjectKey;
      if (!visibleKeys.has(connectedKey)) {
        visibleKeys.add(connectedKey);
        pending.push(connectedKey);
      }
    }
  }

  return {
    activeScope: graph.activeScope,
    nodes: graph.nodes.filter((node) => visibleKeys.has(node.objectKey)),
    edges: graph.edges.filter((_, index) => relatedEdgeIndexes.has(index)),
  };
}

export function selectDirectGraphNeighborhood(
  graph: LibraryGraphSelectionGraph,
  objectKey: string,
): LibraryGraphSelectionGraph {
  const visibleKeys = new Set([objectKey]);
  const edges = graph.edges.filter((edge) => {
    const isIncident = edge.fromObjectKey === objectKey || edge.toObjectKey === objectKey;
    if (isIncident) {
      visibleKeys.add(edge.fromObjectKey);
      visibleKeys.add(edge.toObjectKey);
    }
    return isIncident;
  });
  return {
    activeScope: graph.activeScope,
    nodes: graph.nodes.filter((node) => visibleKeys.has(node.objectKey)),
    edges,
  };
}

export function prepareGraphNodeSelection(
  graph: LibraryGraphSelectionGraph,
  node: LibraryGraphChartNode,
): LibraryGraphChartNode {
  const selectedGraph = selectDirectGraphNeighborhood(graph, node.objectKey);
  return {
    ...node,
    viewOnly: true,
    selectionGraph: {
      ...selectedGraph,
      nodes: selectedGraph.nodes.map((item) => ({ ...item, viewOnly: true })),
    },
    sourceContent: node.sourceContent ?? JSON.stringify({
      title: node.title ?? node.objectKey,
      ...(node.metadata ?? {}),
    }, null, 2),
  };
}

export function LibraryGraphChart({
  nodes,
  edges,
  onSelectNode,
  persistLayoutKey,
}: {
  nodes: LibraryGraphChartNode[];
  edges: LibraryGraphChartEdge[];
  onSelectNode?: (node: LibraryGraphChartNode) => void;
  persistLayoutKey?: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [draggedPositions, setDraggedPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragEnabled, setDragEnabled] = useState(true);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const width = 760;
  const height = 380;
  const nodeKeySignature = useMemo(() => nodes.map((node) => node.objectKey).sort().join("|"), [nodes]);
  const basePositions = useMemo(() => layoutGraphNodes(nodes, width, height), [height, nodes, width]);
  const positions = useMemo(() => {
    const next = new Map(basePositions);
    for (const [objectKey, position] of Object.entries(draggedPositions)) {
      if (next.has(objectKey)) next.set(objectKey, position);
    }
    return next;
  }, [basePositions, draggedPositions]);
  useEffect(() => {
    setDraggedPositions(readPersistedGraphPositions(persistLayoutKey, new Set(nodes.map((node) => node.objectKey))));
  }, [nodeKeySignature, nodes, persistLayoutKey]);
  const clampZoom = (value: number) => Math.min(2.4, Math.max(0.55, Math.round(value * 100) / 100));
  const updateZoom = (delta: number) => setZoom((value) => clampZoom(value + delta));
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    updateZoom(event.deltaY > 0 ? -0.08 : 0.08);
  };
  const updateDraggedNodePosition = (objectKey: string, event: PointerEvent<HTMLElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const x = (event.clientX - bounds.left + viewport.scrollLeft) / zoom;
    const y = (event.clientY - bounds.top + viewport.scrollTop) / zoom;
    setDraggedPositions((current) => {
      const next = {
        ...current,
        [objectKey]: {
          x: Math.max(24, Math.min(width - 24, x)),
          y: Math.max(24, Math.min(height - 24, y)),
        },
      };
      writePersistedGraphPositions(persistLayoutKey, next);
      return next;
    });
  };
  const handleNodePointerDown = (node: LibraryGraphChartNode, event: PointerEvent<HTMLButtonElement>) => {
    if (!dragEnabled) return;
    setDraggingKey(node.objectKey);
    event.currentTarget.setPointerCapture(event.pointerId);
    updateDraggedNodePosition(node.objectKey, event);
  };
  const handleNodePointerMove = (node: LibraryGraphChartNode, event: PointerEvent<HTMLButtonElement>) => {
    if (draggingKey !== node.objectKey) return;
    updateDraggedNodePosition(node.objectKey, event);
  };
  const handleNodePointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingKey(null);
  };
  const resetLayout = () => {
    removePersistedGraphPositions(persistLayoutKey);
    setDraggedPositions({});
  };

  return (
    <div data-testid="library-graph-chart" style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "var(--bg)" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, padding: 6, borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <button
          type="button"
          data-testid="library-graph-drag-toggle"
          aria-pressed={dragEnabled}
          onClick={() => setDragEnabled((value) => !value)}
          aria-label={dragEnabled ? "Disable node dragging" : "Enable node dragging"}
        >
          {dragEnabled ? "Drag on" : "Drag off"}
        </button>
        <button type="button" data-testid="library-graph-reset-layout" onClick={resetLayout} aria-label="Reset graph layout">Reset</button>
        <button type="button" data-testid="library-graph-zoom-out" onClick={() => updateZoom(-0.12)} aria-label="Zoom out">−</button>
        <span style={{ minWidth: 46, textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>{Math.round(zoom * 100)}%</span>
        <button type="button" data-testid="library-graph-zoom-in" onClick={() => updateZoom(0.12)} aria-label="Zoom in">+</button>
      </div>
      <div
        data-testid="library-graph-viewport"
        data-zoom={zoom.toFixed(2)}
        ref={viewportRef}
        onWheel={handleWheel}
        style={{ position: "relative", height, overflow: "auto", background: "radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--accent, #4f46e5) 8%, transparent), transparent 58%)" }}
      >
        <div style={{ position: "relative", width: width * zoom, height: height * zoom }}>
          <svg width={width * zoom} height={height * zoom} role="img" aria-label="Library graph chart" style={{ display: "block", pointerEvents: "none" }}>
            <g transform={`scale(${zoom})`}>
              {edges.map((edge, index) => {
                const from = positions.get(edge.fromObjectKey);
                const to = positions.get(edge.toObjectKey);
                if (!from || !to) return null;
                const edgeStyle = edgeVisualStyle(edge);
                const label = edgeLabel(edge);
                const midX = (from.x + to.x) / 2;
                const midY = (from.y + to.y) / 2;
                return (
                  <g key={`${edge.fromObjectKey}:${edge.edgeType}:${edge.toObjectKey}:${index}`}>
                    <line
                      data-testid="library-graph-edge"
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke={edgeStyle.stroke}
                      strokeDasharray={edgeStyle.dash}
                      strokeOpacity="0.78"
                      strokeWidth="1.35"
                    />
                    {label ? (
                      <text x={midX} y={midY - 6} textAnchor="middle" fontSize="10" fill={edgeStyle.label}>
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
                  <g key={node.objectKey} aria-hidden="true">
                    <circle
                      data-testid="library-graph-dot"
                      cx={position.x}
                      cy={position.y}
                      r={nodeRadius(node)}
                      fill={nodeColor(node)}
                      stroke="var(--bg)"
                      strokeWidth="2"
                    />
                    <text x={position.x + 13} y={position.y - 2} fontSize="11" fill="var(--text)" fontWeight="650">
                      {shortLabel(node.title ?? node.objectKey)}
                    </text>
                    <text x={position.x + 13} y={position.y + 12} fontSize="9" fill="var(--text-dim)">
                      {node.objectKind ?? node.objectKey}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
          {nodes.map((node) => {
            const position = positions.get(node.objectKey);
            if (!position) return null;
            const radius = nodeRadius(node) + 8;
            return (
              <button
                key={node.objectKey}
                type="button"
                data-testid="library-graph-node"
                aria-label={node.title ?? node.objectKey}
                onClick={() => onSelectNode?.(node)}
                onPointerDown={(event) => handleNodePointerDown(node, event)}
                onPointerMove={(event) => handleNodePointerMove(node, event)}
                onPointerUp={handleNodePointerEnd}
                onPointerCancel={handleNodePointerEnd}
                style={{
                  position: "absolute",
                  left: position.x * zoom - radius,
                  top: position.y * zoom - radius,
                  width: radius * 2,
                  height: radius * 2,
                  padding: 0,
                  border: "none",
                  borderRadius: "50%",
                  background: "transparent",
                  color: "transparent",
                  cursor: dragEnabled ? (draggingKey === node.objectKey ? "grabbing" : "grab") : onSelectNode ? "pointer" : "default",
                  touchAction: "none",
                  zIndex: 2,
                }}
              >
                <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
                  {node.title ?? node.objectKey}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function readPersistedGraphPositions(
  persistLayoutKey: string | undefined,
  validKeys: Set<string>,
): Record<string, { x: number; y: number }> {
  if (!persistLayoutKey || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(graphLayoutStorageKey(persistLayoutKey));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const next: Record<string, { x: number; y: number }> = {};
    for (const [objectKey, position] of Object.entries(parsed as Record<string, unknown>)) {
      if (!validKeys.has(objectKey) || !isGraphPosition(position)) continue;
      next[objectKey] = position;
    }
    return next;
  } catch {
    return {};
  }
}

function writePersistedGraphPositions(
  persistLayoutKey: string | undefined,
  positions: Record<string, { x: number; y: number }>,
): void {
  if (!persistLayoutKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(graphLayoutStorageKey(persistLayoutKey), JSON.stringify(positions));
  } catch {
    // Layout persistence is a convenience; graph interaction should continue without storage.
  }
}

function removePersistedGraphPositions(persistLayoutKey: string | undefined): void {
  if (!persistLayoutKey || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(graphLayoutStorageKey(persistLayoutKey));
  } catch {
    // Ignore unavailable browser storage.
  }
}

function graphLayoutStorageKey(value: string): string {
  return `southstar:library-graph-layout:${value}`;
}

function isGraphPosition(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const position = value as { x?: unknown; y?: unknown };
  return typeof position.x === "number" && Number.isFinite(position.x)
    && typeof position.y === "number" && Number.isFinite(position.y);
}

function layoutGraphNodes(nodes: LibraryGraphChartNode[], width: number, height: number): Map<string, { x: number; y: number }> {
  const centerX = width / 2;
  const centerY = height / 2;
  if (nodes.length === 0) return new Map();
  if (nodes.length === 1) return new Map([[nodes[0]!.objectKey, { x: centerX, y: centerY }]]);
  const radiusX = Math.max(110, Math.min(290, width * 0.34));
  const radiusY = Math.max(90, Math.min(140, height * 0.32));
  return new Map(nodes.map((node, index) => {
    const angle = (-Math.PI / 2) + (index / nodes.length) * Math.PI * 2;
    const ringOffset = index % 3 === 0 ? 0 : index % 3 === 1 ? -18 : 18;
    return [
      node.objectKey,
      {
        x: centerX + Math.cos(angle) * (radiusX + ringOffset),
        y: centerY + Math.sin(angle) * (radiusY + ringOffset),
      },
    ];
  }));
}

function nodeRadius(node: LibraryGraphChartNode): number {
  if (node.objectKind === "agent_definition" || node.objectKind === "agent_profile") return 8;
  if (node.objectKind === "domain_taxonomy") return 9;
  if (node.objectKind === "skill_spec" || node.objectKind === "skill_definition") return 7;
  return 6;
}

function nodeColor(node: LibraryGraphChartNode): string {
  if (node.status === "blocked") return "var(--danger, #b42318)";
  const colors: Record<string, string> = {
    requirement: "#f59e0b",
    acceptance_criteria: "#14b8a6",
    candidate: "#8b5cf6",
    artifact: "#3b82f6",
    artifact_contract: "#3b82f6",
    expected_output: "#60a5fa",
    evidence: "#0ea5e9",
    evaluator: "#ec4899",
    evaluator_profile: "#ec4899",
    producer: "#22c55e",
    agent_definition: "var(--accent, #4f46e5)",
    agent_profile: "var(--accent, #4f46e5)",
    agent_spec: "var(--accent, #4f46e5)",
    skill_spec: "var(--success, #0f766e)",
    skill_definition: "var(--success, #0f766e)",
    capability_spec: "var(--success, #0f766e)",
    tool_definition: "var(--warning, #b54708)",
    mcp_tool_grant: "var(--warning, #b54708)",
    vault_lease_policy: "var(--warning, #b54708)",
    workflow_template: "#06b6d4",
    domain_taxonomy: "var(--info, #2563eb)",
    ontology: "#a855f7",
    slice: "#06b6d4",
    workflow_dag: "#0284c7",
    task: "#84cc16",
    goal_contract: "#eab308",
  };
  return colors[node.objectKind ?? ""] ?? "var(--text-muted)";
}

function shortLabel(value: string): string {
  return value.length > 34 ? `${value.slice(0, 31)}...` : value;
}

function edgeLabel(edge: LibraryGraphChartEdge): string {
  const type = edge.edgeType ?? "";
  const confidence = typeof edge.ontology?.confidence === "number" ? edge.ontology.confidence.toFixed(2) : "";
  return [type, confidence].filter(Boolean).join(" ");
}

function edgeVisualStyle(edge: LibraryGraphChartEdge): { stroke: string; label: string; dash?: string } {
  const kind = edge.ontology?.category ?? edge.edgeType ?? "";
  if (kind.includes("conflict") || kind.includes("incompatible")) {
    return { stroke: "var(--danger, #b42318)", label: "var(--danger, #b42318)", dash: "4 3" };
  }
  if (kind.includes("similar")) {
    return { stroke: "var(--accent, #4f46e5)", label: "var(--accent, #4f46e5)", dash: "2 3" };
  }
  if (kind.includes("workflow") || kind.includes("preced") || kind.includes("unblock")) {
    return { stroke: "var(--warning, #b54708)", label: "var(--warning, #b54708)", dash: "6 3" };
  }
  if (kind.includes("artifact")) {
    return { stroke: "var(--success, #0f766e)", label: "var(--success, #0f766e)", dash: "3 3" };
  }
  if (kind.includes("risk")) {
    return { stroke: "var(--danger, #b42318)", label: "var(--danger, #b42318)", dash: "1 4" };
  }
  return { stroke: "var(--border)", label: "var(--text-dim)" };
}
