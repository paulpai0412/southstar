import { BaseEdge, type Edge, type EdgeProps, getBezierPath } from "@xyflow/react";
import { normalizeWorkflowStatus, statusColorFor } from "./colors";
import type { WorkflowDependencyEdgeData } from "./types";

type WorkflowDependencyFlowEdge = Edge<WorkflowDependencyEdgeData>;

export function WorkflowDependencyEdge(props: EdgeProps<WorkflowDependencyFlowEdge>) {
  const status = normalizeWorkflowStatus(props.data?.status);
  const colors = statusColorFor(status);
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: 0.22,
  });

  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={props.markerEnd}
      className={`ss-flow-edge ss-flow-edge-${status}`}
      style={{ stroke: colors.edge, strokeWidth: 1.8 }}
    />
  );
}
