export type WorkflowResourceKind = "markdown" | "json";

export interface WorkflowLibrary {
  domains: WorkflowDomain[];
}

export interface WorkflowDomain {
  id: string;
  label: string;
  workflowTemplates: WorkflowTemplateSummary[];
  agents: WorkflowAgentSummary[];
  resources: WorkflowResourceSummary[];
}

export interface WorkflowTemplateSummary {
  id: string;
  domainId: string;
  title: string;
  description: string;
  nodes: WorkflowTemplateNodeSummary[];
  agentRefs: string[];
  stageRefs: string[];
  status: "draft" | "approved";
}

export interface WorkflowTemplateNodeSummary {
  id: string;
  title: string;
  profileRef?: string;
}

export interface WorkflowAgentSummary {
  id: string;
  domainId: string;
  label: string;
  role: string;
  defaultProfileRef: string;
  profileResourcePath: string;
  instructionResourcePath: string;
  skillResourcePaths: string[];
  mcpResourcePaths: string[];
  policyResourcePaths: string[];
}

export interface WorkflowResourceSummary {
  path: string;
  domainId: string;
  label: string;
  kind: WorkflowResourceKind;
  agentRef?: string;
}

export interface WorkflowResource {
  path: string;
  label: string;
  kind: WorkflowResourceKind;
  content: string;
  source: "file" | "generated";
  writable: boolean;
}

export interface WorkflowLibraryStoreOptions {
  cwd: string | null;
}

export interface WorkflowResourceReadOptions {
  cwd: string | null;
  resourcePath: string;
}

export interface WorkflowResourceWriteOptions extends WorkflowResourceReadOptions {
  content: string;
}

export interface WorkflowDag {
  id: string;
  draftId?: string;
  draftStatus?: string;
  runId?: string;
  mode?: "draft" | "runtime";
  compositionPlan?: unknown;
  templateId: string;
  templateTitle: string;
  prompt: string;
  expandedByDefault: true;
  readiness: "ready" | "blocked" | "warning";
  nodes: WorkflowDagNode[];
  edges: WorkflowDagEdge[];
  createdAt: string;
}

export interface WorkflowDagNode {
  id: string;
  taskId?: string;
  draftId?: string;
  runId?: string;
  mode?: "draft" | "runtime";
  label: string;
  role: string;
  agentRef: string;
  profileRef: string;
  profileResourcePath: string;
  provider: string;
  model: string;
  level: number;
  state: "ready" | "blocked" | "warning";
}

export interface WorkflowDagEdge {
  from: string;
  to: string;
}

export type PlannerDraftValidationIssue = {
  path: string;
  message: string;
  code?: string;
};

export type PlannerDraftTaskSummary = {
  taskId: string;
  taskName: string;
  dependsOn: string[];
  roleRef?: string;
  agentProfileRef?: string;
};

export type PlannerDraftResult = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
  status: string;
  validationIssues: PlannerDraftValidationIssue[];
  taskSummaries: PlannerDraftTaskSummary[];
};

export type PlannerDraftOrchestrationView = PlannerDraftResult & {
  orchestrationSnapshot?: unknown;
  plannerTrace?: unknown;
  repairAttempts?: unknown;
};

export type WorkflowRunResult = {
  runId: string;
  taskIds: string[];
};

export type WorkflowExecuteResult = {
  status: string;
  runId?: string;
};

export type WorkflowLifecycleState = {
  phase:
    | "file_draft"
    | "drafting"
    | "planner_draft"
    | "needs_validation"
    | "validating"
    | "validated"
    | "invalid"
    | "running"
    | "run_created"
    | "executing"
    | "blocked";
  draft?: PlannerDraftResult;
  orchestration?: PlannerDraftOrchestrationView;
  run?: WorkflowRunResult;
  execute?: WorkflowExecuteResult;
  error?: string;
  progressMessage?: string;
  canRun?: boolean;
};
