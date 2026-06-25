import { Handle, Position, type NodeProps } from "@xyflow/react";
import { toneForStatus } from "./colors";
import type { WorkflowCanvasNode } from "./types";

export function WorkflowTaskNode(props: NodeProps) {
  const data = props.data as WorkflowCanvasNode;
  const tone = toneForStatus(data.attention?.severity === "blocked" ? "blocked" : data.status);
  return (
    <article
      style={{
        width: 240,
        minHeight: 112,
        border: `1px solid ${tone.border}`,
        background: tone.background,
        color: "var(--text)",
        borderRadius: 6,
        padding: 10,
        boxShadow: props.selected ? "0 0 0 2px var(--accent)" : "none",
        fontSize: 12,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: tone.text, flexShrink: 0 }} />
        <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.label}</strong>
      </div>
      <div style={{ marginTop: 6, display: "grid", gap: 3, color: "var(--text-muted)" }}>
        {data.roleRef ? <span>role: {data.roleRef}</span> : null}
        {data.agentProfileRef ? <span>profile: {data.agentProfileRef}</span> : null}
        {data.artifactKind ? <span>artifact: {data.artifactKind}</span> : null}
      </div>
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
        <span style={{ border: `1px solid ${tone.border}`, borderRadius: 3, padding: "1px 5px", color: tone.text }}>{data.status}</span>
        {data.badges.map((badge) => (
          <span key={`${badge.tone}:${badge.label}`} style={{ border: "1px solid var(--border)", borderRadius: 3, padding: "1px 5px", color: "var(--text-muted)" }}>
            {badge.label}
          </span>
        ))}
      </div>
      {data.attention ? <p style={{ margin: "8px 0 0", color: tone.text }}>{data.attention.reason}</p> : null}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
