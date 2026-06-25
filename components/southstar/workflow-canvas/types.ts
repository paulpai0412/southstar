export const workflowStatusTokens = [
  "pending",
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

export type WorkflowTaskBadge = {
  label: string;
  tone?: "neutral" | "good" | "warn" | "danger";
};

export type WorkflowTaskNodeModel = {
  id: string;
  label: string;
  status: string;
  dependsOn: string[];
  roleRef?: string | null;
  agentProfileRef?: string | null;
  artifactKind?: string | null;
  badges: WorkflowTaskBadge[];
  attention?: string | null;
};

export type WorkflowDependencyModel = {
  id: string;
  from: string;
  to: string;
  status?: string | null;
};

export type WorkflowCanvasModel = {
  nodes: WorkflowTaskNodeModel[];
  edges: WorkflowDependencyModel[];
};

export type WorkflowTaskNodeData = WorkflowTaskNodeModel & {
  selected: boolean;
};

export type WorkflowDependencyEdgeData = {
  status: string;
};
