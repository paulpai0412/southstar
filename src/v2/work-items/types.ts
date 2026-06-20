export type WorkItemSourceProvider =
  | "local"
  | "github"
  | "linear"
  | "jira"
  | "slack"
  | "api"
  | "custom"
  | "cli"
  | "ui"
  | "scheduler";

export type WorkItemRunRef = {
  runId: string;
  runAttempt: number;
  statusAtLink?: string;
  reason?: string;
  createdAt?: string;
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
  sourceUrl?: string;
  title: string;
  domain: string;
  status: WorkItemRecord["status"];
  metadata?: Record<string, unknown> & { sourceUrl?: string };
};

export type WorkItemIntakePriority = "low" | "normal" | "high" | "urgent";

export type WorkItemIntakeInput = {
  sourceProvider: WorkItemSourceProvider;
  sourceScope?: string;
  sourceRef?: string;
  sourceUrl?: string;
  title: string;
  body: string;
  domain: string;
  priority?: WorkItemIntakePriority;
  labels?: string[];
  requestedBy?: string;
  metadata?: Record<string, unknown>;
};

export type WorkItemIntakeResult = {
  workItemId: string;
  status: WorkItemRecord["status"];
  deduped: boolean;
};
