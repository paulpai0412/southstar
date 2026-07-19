"use client";

import type { WorkflowNodeProfileForm } from "@/lib/workflow/node-profile";

export function WorkflowNodeProfileSummary({
  taskId,
  mode,
  selectedDefinition,
  form,
  editable,
  dirty,
}: {
  taskId: string;
  mode: "draft" | "runtime";
  selectedDefinition: unknown;
  form: WorkflowNodeProfileForm;
  editable: boolean;
  dirty: boolean;
}) {
  const selected = recordValue(selectedDefinition);
  const agentProfile = recordValue(selected?.agentProfile);
  const taskName = stringValue(selected?.taskName) || taskId;
  const roleRef = stringValue(selected?.roleRef) || "Unbound";
  const profileRef = stringValue(selected?.agentProfileRef ?? agentProfile?.id) || "Unbound";
  const hostAdapter = form.harnessRef || stringValue(agentProfile?.harnessRef) || "Unbound";
  const provider = form.provider || stringValue(agentProfile?.provider) || "Unbound";
  const model = form.model || stringValue(agentProfile?.model) || "Unbound";
  const capabilityCount = form.skillRefs.length + form.mcpGrantRefs.length + form.toolGrantRefs.length + form.vaultLeasePolicyRefs.length;
  const promptState = form.nodePromptSpec.trim() ? "editable nodePromptSpec" : "no nodePromptSpec";
  const stateLabel = editable
    ? dirty ? "Draft edited. Save will mark the DAG as needing validation." : "Draft editable. No unsaved changes."
    : mode === "runtime" ? "Runtime profile is locked to the launched run." : "Profile is read-only for this selection.";

  return (
    <section data-testid="workflow-node-profile-summary" style={cardStyle}>
      <header style={headerStyle}>
        <h2 style={titleStyle}>Profile summary</h2>
        <span style={pillStyle}>{mode}</span>
      </header>
      <dl style={gridStyle}>
        <dt style={termStyle}>Task</dt><dd style={valueStyle}>{taskName}</dd>
        <dt style={termStyle}>Role</dt><dd style={valueStyle}>{roleRef}</dd>
        <dt style={termStyle}>Profile</dt><dd style={valueStyle}>{profileRef}</dd>
        <dt style={termStyle}>Host adapter</dt><dd style={valueStyle}>{hostAdapter}</dd>
        <dt style={termStyle}>Provider</dt><dd style={valueStyle}>{provider}</dd>
        <dt style={termStyle}>Model</dt><dd style={valueStyle}>{model}</dd>
        <dt style={termStyle}>Capability refs</dt><dd style={valueStyle}>{capabilityCount} refs</dd>
        <dt style={termStyle}>Prompt</dt><dd style={valueStyle}>{promptState}</dd>
        <dt style={termStyle}>State</dt><dd style={valueStyle}>{stateLabel}</dd>
      </dl>
    </section>
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
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
