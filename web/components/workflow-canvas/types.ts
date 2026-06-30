export const workflowStatusTokens = [
  "pending",
  "ready",
  "active",
  "satisfied",
  "queued",
  "scheduling",
  "running",
  "completed",
  "passed",
  "paused",
  "blocked",
  "exception",
  "failed",
  "cancelled",
] as const;

export type WorkflowStatusToken = (typeof workflowStatusTokens)[number];
export type WorkflowCanvasMode = "draft" | "runtime";
export type WorkflowEdgeStatus = "pending" | "ready" | "active" | "blocked" | "satisfied";

export type WorkflowTaskBadge = {
  label: string;
  tone?: "neutral" | "good" | "warn" | "danger";
};

export type WorkflowTaskAttention = {
  severity: "info" | "warning" | "error" | "blocked";
  reason: string;
};

export type WorkflowTaskNodeModel = {
  id: string;
  label: string;
  kind: "task";
  status: string;
  dependsOn: string[];
  roleRef?: string | null;
  agentProfileRef?: string | null;
  artifactKind?: string | null;
  badges: WorkflowTaskBadge[];
  attention?: WorkflowTaskAttention | null;
};

export type WorkflowDependencyModel = {
  id: string;
  source: string;
  target: string;
  status: WorkflowEdgeStatus;
};

export type WorkflowCanvasModel = {
  graphId: string;
  mode: WorkflowCanvasMode;
  selectedNodeId?: string | null;
  nodes: WorkflowTaskNodeModel[];
  edges: WorkflowDependencyModel[];
};

export type WorkflowTaskNodeData = WorkflowTaskNodeModel & {
  selected: boolean;
};

export type WorkflowDependencyEdgeData = {
  status: string;
};
