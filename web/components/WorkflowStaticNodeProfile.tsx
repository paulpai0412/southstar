"use client";

import type { WorkflowDagNode } from "@/lib/workflow/types";

export function WorkflowStaticNodeProfile({ node }: { node: WorkflowDagNode }) {
  return (
    <div data-testid="workflow-static-node-profile" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 650, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {node.label || node.taskId || node.id}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            file draft / {node.taskId ?? node.id}
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 14 }}>
        <section style={cardStyle}>
          <header style={headerStyle}>
            <h2 style={titleStyle}>Profile summary</h2>
            <span style={pillStyle}>file draft</span>
          </header>
          <dl style={gridStyle}>
            <dt style={termStyle}>Task</dt><dd style={valueStyle}>{node.label || node.taskId || node.id}</dd>
            <dt style={termStyle}>Role</dt><dd style={valueStyle}>{node.role || "role:auto"}</dd>
            <dt style={termStyle}>Agent</dt><dd style={valueStyle}>{node.agentRef || "agent:auto"}</dd>
            <dt style={termStyle}>Profile</dt><dd style={valueStyle}>{node.profileRef || "profile:auto"}</dd>
            <dt style={termStyle}>Host</dt><dd style={valueStyle}>{[node.provider, node.model].filter(Boolean).join(" / ") || "provider:auto / model:auto"}</dd>
            <dt style={termStyle}>State</dt><dd style={valueStyle}>{node.state}</dd>
          </dl>
        </section>
        <section style={cardStyle}>
          <h2 style={titleStyle}>Editing</h2>
          <p style={bodyStyle}>
            Draft this DAG to edit the task profile. After the planner draft exists, clicking this node opens the editable profile editor with validation-aware save behavior.
          </p>
        </section>
        {node.profileResourcePath && (
          <section style={cardStyle}>
            <h2 style={titleStyle}>Legacy resource path</h2>
            <p style={{ ...bodyStyle, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
              {node.profileResourcePath}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

const cardStyle = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-panel)",
  padding: 10,
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  marginBottom: 8,
} as const;

const titleStyle = {
  margin: 0,
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 650,
} as const;

const pillStyle = {
  border: "1px solid var(--border)",
  borderRadius: 5,
  padding: "2px 6px",
  color: "var(--text-dim)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
} as const;

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "104px minmax(0, 1fr)",
  gap: "6px 8px",
  margin: 0,
} as const;

const termStyle = {
  color: "var(--text-dim)",
  fontSize: 11,
} as const;

const valueStyle = {
  margin: 0,
  color: "var(--text-muted)",
  fontSize: 12,
  overflowWrap: "anywhere",
} as const;

const bodyStyle = {
  margin: "8px 0 0",
  color: "var(--text-muted)",
  fontSize: 12,
  lineHeight: 1.5,
} as const;
