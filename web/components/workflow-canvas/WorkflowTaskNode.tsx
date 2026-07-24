import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { normalizeWorkflowStatus, statusColorFor } from "./colors";
import type { WorkflowTaskNodeData } from "./types";

type WorkflowTaskFlowNode = Node<WorkflowTaskNodeData>;

export function WorkflowTaskNode(props: NodeProps<WorkflowTaskFlowNode>) {
  const status = normalizeWorkflowStatus(props.data.status);
  const colors = statusColorFor(status);
  const roleRef = props.data.roleRef?.trim() || null;
  const agentProfileRef = props.data.agentProfileRef?.trim() || null;
  const artifactKind = props.data.artifactKind?.trim() || null;
  const purpose = props.data.purpose?.trim();
  const requirementIds = props.data.requirementIds ?? [];
  const sliceId = props.data.sliceId?.trim();
  const expectedOutputs = props.data.expectedOutputs ?? [];
  const badges = props.data.badges;
  const attention = props.data.attention;
  const nodeType = props.data.nodeType?.trim();

  return (
    <article
      data-testid={`workflow-dag-node-${props.data.id}`}
      className={`ss-flow-node ss-flow-node-${status} ${props.data.collapsed ? "ss-flow-node-collapsed" : ""} ${props.data.selected ? "ss-flow-node-selected" : ""}`}
      style={{ borderColor: colors.border, background: colors.fill }}
    >
      <Handle type="target" position={Position.Top} className="ss-flow-handle" />
      <header className="ss-flow-node-header">
        <strong>{props.data.label}</strong>
        <div className="ss-flow-node-header-actions">
          <span className="ss-flow-node-status" style={{ color: colors.text }}>{status}</span>
          <button
            type="button"
            className="ss-flow-node-toggle"
            data-testid={`workflow-dag-node-toggle-${props.data.id}`}
            aria-label={props.data.collapsed ? `Expand ${props.data.label}` : `Collapse ${props.data.label}`}
            aria-expanded={!props.data.collapsed}
            onClick={(event) => {
              event.stopPropagation();
              props.data.onToggleCollapse?.(props.data.id);
            }}
          >
            {props.data.collapsed ? "+" : "−"}
          </button>
        </div>
      </header>
      {props.data.collapsed ? (
        <div className="ss-flow-node-collapsed-summary">
          {purpose ? <p className="ss-flow-node-collapsed-purpose" data-node-field="purpose">Does: {purpose}</p> : null}
          <div className="ss-flow-node-collapsed-meta">
            {nodeType ? <span data-node-field="nodeType">{nodeType}</span> : null}
            {requirementIds.length > 0 ? <span data-node-field="requirementIds">Requirements: {requirementIds.length}</span> : null}
            {sliceId ? <span data-node-field="sliceId">Slice: {sliceId}</span> : null}
            {expectedOutputs.length > 0 ? <span data-node-field="expectedOutputs">Outputs: {expectedOutputs.length}</span> : null}
          </div>
        </div>
      ) : null}
      {!props.data.collapsed ? <>
      {purpose ? <p className="ss-flow-node-purpose" data-node-field="purpose">Does: {purpose}</p> : null}
      {sliceId || requirementIds.length > 0 ? (
        <>
          <p className="ss-flow-node-lineage" data-node-field="requirementIds">
            Covers requirements: {requirementIds.length > 0 ? requirementIds.join(", ") : "—"}
          </p>
          {sliceId ? <p className="ss-flow-node-lineage" data-node-field="sliceId">Produces slice: {sliceId}</p> : null}
        </>
      ) : null}
      {nodeType ? <p className="ss-flow-node-lineage" data-node-field="nodeType">Work type: {nodeType}</p> : null}
      {expectedOutputs.length > 0 ? <p className="ss-flow-node-lineage" data-node-field="expectedOutputs">Produces: {expectedOutputs.join(", ")}</p> : null}
      <p className="ss-flow-node-ref" data-node-field="taskId">
        taskId: {props.data.id}
      </p>
      <p className="ss-flow-node-ref" data-node-field="roleRef">
        roleRef: {roleRef ?? "Unbound"}
      </p>
      <p className="ss-flow-node-ref" data-node-field="agentProfileRef">
        agentProfileRef: {agentProfileRef ?? "Unbound"}
      </p>
      <p className="ss-flow-node-ref" data-node-field="artifactKind">
        artifactKind: {artifactKind ?? "Unbound"}
      </p>
      </> : null}
      {badges.length > 0 ? (
        <div className="ss-flow-node-badges" data-node-field="badges">
          {badges.map((badge, index) => (
            <span key={`${badge.label}:${badge.tone ?? "neutral"}:${index}`} className={`ss-flow-badge ss-flow-badge-${badge.tone ?? "neutral"}`}>
              {badge.label}
            </span>
          ))}
        </div>
      ) : null}
      {attention ? (
        <p className={`ss-flow-node-attention ss-flow-node-attention-${attention.severity}`} data-node-field="attention">
          attention: {attention.severity} · {attention.reason}
        </p>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="ss-flow-handle" />
    </article>
  );
}
