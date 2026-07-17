import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { normalizeWorkflowStatus, statusColorFor } from "./colors";
import type { WorkflowTaskNodeData } from "./types";

type WorkflowTaskFlowNode = Node<WorkflowTaskNodeData>;

export function WorkflowTaskNode(props: NodeProps<WorkflowTaskFlowNode>) {
  const status = normalizeWorkflowStatus(props.data.status);
  const colors = statusColorFor(status);
  const roleRef = props.data.roleRef ?? "unassigned";
  const agentProfileRef = props.data.agentProfileRef ?? "default";
  const artifactKind = props.data.artifactKind ?? "implementation_report";
  const purpose = props.data.purpose?.trim();
  const requirementIds = props.data.requirementIds ?? [];
  const sliceId = props.data.sliceId?.trim();
  const expectedOutputs = props.data.expectedOutputs ?? [];
  const badges = props.data.badges;
  const attention = props.data.attention;

  return (
    <article
      data-testid={`workflow-dag-node-${props.data.id}`}
      className={`ss-flow-node ss-flow-node-${status} ${props.data.selected ? "ss-flow-node-selected" : ""}`}
      style={{ borderColor: colors.border, background: colors.fill }}
    >
      <Handle type="target" position={Position.Top} className="ss-flow-handle" />
      <header className="ss-flow-node-header">
        <strong>{props.data.label}</strong>
        <span className="ss-flow-node-status" style={{ color: colors.text }}>
          {status}
        </span>
      </header>
      {purpose ? <p className="ss-flow-node-purpose" data-node-field="purpose">Does: {purpose}</p> : null}
      {sliceId || requirementIds.length > 0 ? (
        <>
          <p className="ss-flow-node-lineage" data-node-field="requirementIds">
            Covers requirements: {requirementIds.length > 0 ? requirementIds.join(", ") : "—"}
          </p>
          {sliceId ? <p className="ss-flow-node-lineage" data-node-field="sliceId">Produces slice: {sliceId}</p> : null}
        </>
      ) : null}
      {props.data.nodeType ? <p className="ss-flow-node-lineage" data-node-field="nodeType">Work type: {props.data.nodeType}</p> : null}
      {expectedOutputs.length > 0 ? <p className="ss-flow-node-lineage" data-node-field="expectedOutputs">Produces: {expectedOutputs.join(", ")}</p> : null}
      <p className="ss-flow-node-ref" data-node-field="taskId">
        taskId: {props.data.id}
      </p>
      <p className="ss-flow-node-ref" data-node-field="roleRef">
        roleRef: {roleRef}
      </p>
      <p className="ss-flow-node-ref" data-node-field="agentProfileRef">
        agentProfileRef: {agentProfileRef}
      </p>
      <p className="ss-flow-node-ref" data-node-field="artifactKind">
        artifactKind: {artifactKind}
      </p>
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
