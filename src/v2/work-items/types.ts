export type WorkItemSourceProvider = "local" | "github" | "linear" | "jira" | "slack" | "api" | "custom";

export type WorkItemRunRef = {
  runId: string;
  runAttempt: number;
};

export type WorkItemRecord = {
  id: string;
  sourceProvider: WorkItemSourceProvider;
  sourceRef?: string;
  sourceUrl?: string;
  title: string;
  domain: string;
  status: "active" | "waiting" | "completed" | "failed" | "cancelled";
  runRefs: WorkItemRunRef[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkItemInput = {
  id: string;
  sourceProvider: WorkItemSourceProvider;
  sourceRef?: string;
  title: string;
  domain: string;
  status: WorkItemRecord["status"];
  metadata?: Record<string, unknown> & { sourceUrl?: string };
};
