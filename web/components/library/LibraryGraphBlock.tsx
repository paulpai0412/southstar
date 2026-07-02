"use client";

import { useEffect, useMemo, useState } from "react";
import { unwrapEnvelope } from "@/lib/library/api";
import { LibraryGraphChart, type LibraryGraphChartEdge, type LibraryGraphChartNode } from "./LibraryGraphChart";

type LibraryGraphData = {
  activeScope?: string;
  availableScopes?: string[];
  nodes?: LibraryGraphChartNode[];
  edges?: LibraryGraphChartEdge[];
};

const KIND_OPTIONS = [
  "agent_definition",
  "agent_profile",
  "skill_spec",
  "tool_definition",
  "mcp_tool_grant",
  "capability_spec",
  "workflow_template",
];

const STATUS_OPTIONS = ["draft", "approved", "deprecated", "blocked"];

export function LibraryGraphBlock({
  data,
  defaultScope,
  onSelectNode,
}: {
  data: Record<string, unknown>;
  defaultScope: string;
  onSelectNode?: (node: LibraryGraphChartNode) => void;
}) {
  const initialGraph = toGraphData(data);
  const initialScope = typeof initialGraph.activeScope === "string" && initialGraph.activeScope.length > 0
    ? initialGraph.activeScope
    : defaultScope || "all";
  const [selectedScope, setSelectedScope] = useState(initialScope);
  const [selectedKind, setSelectedKind] = useState("all");
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [graph, setGraph] = useState<LibraryGraphData>(initialGraph);
  const options = useMemo(() => {
    const discovered = Array.isArray(graph.availableScopes)
      ? graph.availableScopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
      : [];
    const domains = [selectedScope, defaultScope, ...discovered].filter((scope) => scope.length > 0 && scope !== "all" && scope !== "global");
    return ["all", "global", ...Array.from(new Set(domains)).sort()];
  }, [defaultScope, graph.availableScopes, selectedScope]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ scope: selectedScope });
    if (selectedKind !== "all") params.set("kind", selectedKind);
    if (selectedStatus !== "all") params.set("status", selectedStatus);
    fetch(`/api/library/graph?${params.toString()}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setGraph(unwrapEnvelope<LibraryGraphData>(payload));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedKind, selectedScope, selectedStatus]);

  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isGraphNode) : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.filter(isGraphEdge) : [];
  return (
    <div data-testid="library-graph-block" style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Graph snapshot</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span>Domain</span>
            <select
              data-testid="library-graph-domain-filter"
              value={selectedScope}
              onChange={(event) => setSelectedScope(event.currentTarget.value)}
            >
              {options.map((scope) => (
                <option key={scope} value={scope}>{scope}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span>Kind</span>
            <select
              data-testid="library-graph-kind-filter"
              value={selectedKind}
              onChange={(event) => setSelectedKind(event.currentTarget.value)}
            >
              <option value="all">all</option>
              {KIND_OPTIONS.map((kind) => (
                <option key={kind} value={kind}>{kind}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span>Status</span>
            <select
              data-testid="library-graph-status-filter"
              value={selectedStatus}
              onChange={(event) => setSelectedStatus(event.currentTarget.value)}
            >
              <option value="all">all</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        {selectedScope} / {selectedKind} / {selectedStatus} / {nodes.length} nodes / {edges.length} edges
      </div>
      <LibraryGraphChart nodes={nodes} edges={edges} onSelectNode={onSelectNode} />
    </div>
  );
}

function toGraphData(value: Record<string, unknown>): LibraryGraphData {
  return {
    activeScope: typeof value.activeScope === "string" ? value.activeScope : undefined,
    availableScopes: Array.isArray(value.availableScopes) ? value.availableScopes.filter((scope): scope is string => typeof scope === "string") : undefined,
    nodes: Array.isArray(value.nodes) ? value.nodes.filter(isGraphNode) : undefined,
    edges: Array.isArray(value.edges) ? value.edges.filter(isGraphEdge) : undefined,
  };
}

function isGraphNode(value: unknown): value is LibraryGraphChartNode {
  return Boolean(value && typeof value === "object" && typeof (value as { objectKey?: unknown }).objectKey === "string");
}

function isGraphEdge(value: unknown): value is LibraryGraphChartEdge {
  if (!value || typeof value !== "object") return false;
  const edge = value as { fromObjectKey?: unknown; toObjectKey?: unknown };
  return typeof edge.fromObjectKey === "string" && typeof edge.toObjectKey === "string";
}
