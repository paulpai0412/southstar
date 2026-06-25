export type WorkflowCanvasMode = "draft" | "runtime";
export type WorkflowCanvasAttentionSeverity = "info" | "warning" | "error" | "blocked";
export type WorkflowCanvasEdgeStatus = "pending" | "ready" | "active" | "blocked" | "satisfied";

export type WorkflowCanvasBadge = {
  tone: string;
  label: string;
};

export type WorkflowCanvasNode = {
  id: string;
  label: string;
  kind: "task";
  status: string;
  roleRef?: string;
  agentProfileRef?: string;
  artifactKind?: string;
  badges: WorkflowCanvasBadge[];
  attention?: {
    severity: WorkflowCanvasAttentionSeverity;
    reason: string;
  };
};

export type WorkflowCanvasEdge = {
  id: string;
  source: string;
  target: string;
  status: WorkflowCanvasEdgeStatus;
};

export type WorkflowCanvasModel = {
  graphId: string;
  mode: WorkflowCanvasMode;
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  selectedNodeId?: string;
};
