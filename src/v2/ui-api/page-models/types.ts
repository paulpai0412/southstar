export type UiPageSurface =
  | "southstar.ui.planner.v1"
  | "southstar.ui.workflow-canvas.v1"
  | "southstar.ui.runtime-monitor.v1"
  | "southstar.ui.task-detail.v1"
  | "southstar.ui.sessions-memory.v1"
  | "southstar.ui.worktree.v1"
  | "southstar.ui.executor.v1"
  | "southstar.ui.governance.v1";

export type UiStatus = "healthy" | "degraded" | "needs-binding" | "not-configured";

export type UiIntegrationHealth = {
  service: string;
  status: UiStatus;
  binding: "api-bound" | "not-bound";
  lastSeen?: string;
  notes: string;
  action?: string;
};

export type UiCommandDescriptor = {
  label: string;
  command: string;
  danger?: boolean;
};

export type PlannerPageModel = {
  surface: "southstar.ui.planner.v1";
  selectedRunId: string | null;
  promptHistory: Array<{ id: string; title?: string | null; status: string; createdAt?: string }>;
  activeDraft: null | {
    draftId: string;
    workflowId: string;
    goalPrompt: string;
    taskCount: number;
    domain: string;
    intent: string;
  };
  readiness: Array<{ label: string; value: string; status: "ready" | "detected" | "missing" }>;
  contextBudget: { totalTokens: number; limitTokens: number; bySource: Record<string, number> };
  artifactContract: Array<{ label: string; status: "ready" | "missing" | "pending" }>;
  stopCondition: Array<{ label: string; passed: boolean }>;
  policyControls: {
    repairAttempts: number;
    forkOnFailure: boolean;
    rollbackStrategy: string;
    workspaceIsolation: string;
    humanApproval: boolean;
  };
  taskAssignments: Array<{ task: string; role: string; agent: string; model: string; skills: string[]; mcp: string[]; memoryScope: string[] }>;
};
