"use client";

import type { WorkflowTemplateSummary } from "@/lib/workflow/types";

export function WorkflowLaunchPreview({
  template,
  cwd,
}: {
  template: WorkflowTemplateSummary | null | undefined;
  cwd?: string | null;
}) {
  const stages = [
    "Generate DAG",
    "Validate draft",
    "Run workflow",
    "Operator handoff",
  ];

  return (
    <section
      data-testid="workflow-launch-preview"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 7,
        background: "var(--bg-panel)",
        padding: 12,
        marginBottom: 12,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start", marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, color: "var(--text)", fontSize: 13, fontWeight: 700 }}>Workflow launch preview</h2>
          <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45 }}>
            Workflow handles DAG generation, revision, validation, and launch. {template ? template.description : "Select a workflow template, then describe the job to generate a DAG."}
          </p>
        </div>
        <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "nowrap" }}>
          {template?.status ?? "template:none"}
        </span>
      </header>
      <dl style={{ display: "grid", gridTemplateColumns: "104px minmax(0, 1fr)", gap: "6px 8px", margin: "0 0 10px" }}>
        <dt style={termStyle}>Template</dt>
        <dd style={valueStyle}>{template?.title ?? "No template selected"}</dd>
        <dt style={termStyle}>Project scope</dt>
        <dd style={valueStyle}>{cwd ?? "No repo selected"}</dd>
        <dt style={termStyle}>Agent roles</dt>
        <dd style={valueStyle}>{template ? `${template.agentRefs.length} agents / ${template.stageRefs.length} stages` : "Select from Workflow Library"}</dd>
      </dl>
      <ol className="workflow-launch-preview-flow" style={{ margin: 0, padding: 0, listStyle: "none", border: "1px solid var(--border)", background: "var(--border)" }}>
        {stages.map((stage, index) => (
          <li key={stage} style={{ background: "var(--bg)", padding: "8px 9px", minWidth: 0 }}>
            <span style={{ display: "block", color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>{index + 1}</span>
            <strong style={{ display: "block", color: "var(--text-muted)", fontSize: 12, overflowWrap: "anywhere" }}>{stage}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}

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
