"use client";

import { useEffect, useMemo, useState } from "react";
import { unwrapEnvelope } from "@/lib/library/api";
import { LibraryGraphChart, type LibraryGraphChartEdge, type LibraryGraphChartNode } from "./LibraryGraphChart";

type LibraryGraphData = {
  activeScope?: string;
  availableScopes?: string[];
  query?: {
    scope?: string;
    kind?: string;
    status?: string;
    edgeType?: string;
  };
  nodes?: LibraryGraphChartNode[];
  edges?: LibraryGraphChartEdge[];
};

const KIND_OPTIONS = [
  "agent_definition",
  "agent_profile",
  "domain_taxonomy",
  "skill_spec",
  "tool_definition",
  "mcp_tool_grant",
  "capability_spec",
  "workflow_template",
];

const STATUS_OPTIONS = ["draft", "approved", "deprecated", "blocked"];
const EDGE_TYPE_OPTIONS = uniqueOptions([
  "implements",
  "provides_capability",
  "requires_capability",
  "uses",
  "requires_skill",
  "allows_tool",
  "requires_tool",
  "uses_instruction",
  "requires_secret_group",
  "allows_mcp_grant",
  "produces_artifact",
  "consumes_artifact",
  "validates_artifact",
  "uses_policy",
  "part_of_template",
  "supersedes",
  "blocked_by",
  "belongs_to_domain",
  "has_capability",
  "provides",
  "uses",
  "requires",
  "conflicts_with",
  "precedes",
  "workflow_precedes",
  "unblocks",
  "validates",
  "reviews",
  "produces",
  "consumes",
  "similar_to",
  "substitutes",
  "complements",
  "incompatible_with",
  "requires_approval",
  "requires_secret",
]);

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
  const [selectedKind, setSelectedKind] = useState(initialGraph.query?.kind ?? "all");
  const [selectedStatus, setSelectedStatus] = useState(initialGraph.query?.status ?? "all");
  const [selectedEdgeType, setSelectedEdgeType] = useState(initialGraph.query?.edgeType ?? "all");
  const [open, setOpen] = useState(true);
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
    if (selectedEdgeType !== "all") params.set("edgeType", selectedEdgeType);
    fetch(`/api/library/graph?${params.toString()}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setGraph(unwrapEnvelope<LibraryGraphData>(payload));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedEdgeType, selectedKind, selectedScope, selectedStatus]);

  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isGraphNode) : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.filter(isGraphEdge) : [];
  const layoutKey = `scope=${selectedScope};kind=${selectedKind};status=${selectedStatus};edge=${selectedEdgeType}`;
  return (
    <div data-testid="library-graph-block" style={{ display: "grid", gap: 6, border: "1px solid var(--border)", borderRadius: 8, padding: 10, background: "var(--bg-subtle)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <button
          type="button"
          data-testid="library-graph-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            border: "none",
            background: "transparent",
            color: "var(--text)",
            cursor: "pointer",
            fontWeight: 700,
            padding: 0,
          }}
        >
          <span aria-hidden style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>›</span>
          <span>Graph snapshot</span>
        </button>
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
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span>Edge</span>
            <select
              data-testid="library-graph-edge-filter"
              value={selectedEdgeType}
              onChange={(event) => setSelectedEdgeType(event.currentTarget.value)}
            >
              <option value="all">all</option>
              {EDGE_TYPE_OPTIONS.map((edgeType) => (
                <option key={edgeType} value={edgeType}>{edgeType}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        {selectedScope} / {selectedKind} / {selectedStatus} / {selectedEdgeType} / {nodes.length} nodes / {edges.length} edges
      </div>
      {open ? <LibraryGraphChart nodes={nodes} edges={edges} onSelectNode={onSelectNode} persistLayoutKey={layoutKey} /> : null}
    </div>
  );
}

function toGraphData(value: Record<string, unknown>): LibraryGraphData {
  return {
    activeScope: typeof value.activeScope === "string" ? value.activeScope : undefined,
    availableScopes: Array.isArray(value.availableScopes) ? value.availableScopes.filter((scope): scope is string => typeof scope === "string") : undefined,
    query: isGraphQuery(value.query) ? value.query : undefined,
    nodes: Array.isArray(value.nodes) ? value.nodes.filter(isGraphNode) : undefined,
    edges: Array.isArray(value.edges) ? value.edges.filter(isGraphEdge) : undefined,
  };
}

function isGraphQuery(value: unknown): value is NonNullable<LibraryGraphData["query"]> {
  return Boolean(value && typeof value === "object");
}

function isGraphNode(value: unknown): value is LibraryGraphChartNode {
  return Boolean(value && typeof value === "object" && typeof (value as { objectKey?: unknown }).objectKey === "string");
}

function isGraphEdge(value: unknown): value is LibraryGraphChartEdge {
  if (!value || typeof value !== "object") return false;
  const edge = value as { fromObjectKey?: unknown; toObjectKey?: unknown };
  return typeof edge.fromObjectKey === "string" && typeof edge.toObjectKey === "string";
}

function uniqueOptions(values: string[]): string[] {
  return Array.from(new Set(values));
}
