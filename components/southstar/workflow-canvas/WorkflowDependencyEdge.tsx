import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { edgeClassForStatus } from "./colors";
import type { WorkflowCanvasEdge } from "./types";

export function WorkflowDependencyEdge(props: EdgeProps) {
  const data = props.data as WorkflowCanvasEdge | undefined;
  const [edgePath, labelX, labelY] = getSmoothStepPath(props);
  const status = data?.status ?? "pending";
  return (
    <>
      <BaseEdge path={edgePath} markerEnd={props.markerEnd} className={edgeClassForStatus(status)} />
      <EdgeLabelRenderer>
        <span
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            fontSize: 10,
            color: "var(--text-muted)",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 3,
            padding: "1px 4px",
            pointerEvents: "none",
          }}
        >
          {status}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}
