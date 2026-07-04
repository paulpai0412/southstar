import type {
  PlannerDraftOrchestrationView,
  PlannerDraftResult,
  WorkflowExecuteResult,
  WorkflowDag,
  WorkflowLifecycleState,
  WorkflowRunResult,
} from "./types";

type WorkflowLifecycleAction =
  | { type: "dag_changed"; dag: WorkflowDag }
  | { type: "drafting" }
  | { type: "draft_progress"; message: string }
  | { type: "drafted"; draft: PlannerDraftResult }
  | { type: "draft_status_changed"; draftId: string; status: string }
  | { type: "validating" }
  | { type: "validated"; orchestration: PlannerDraftOrchestrationView }
  | { type: "running" }
  | { type: "run_created"; run: WorkflowRunResult }
  | { type: "executing" }
  | { type: "executed"; execute: WorkflowExecuteResult }
  | { type: "execute_failed"; error: string }
  | { type: "blocked"; error: string };

export function buildPlannerDraftRequest(dag: WorkflowDag, cwd?: string | null) {
  return {
    cwd: cwd ?? undefined,
    goalPrompt: dag.prompt,
    orchestrationMode: "llm-constrained" as const,
    composerMode: "llm" as const,
    domainPackId: dag.templateId.includes("software") ? "software" : undefined,
    ...(dag.compositionPlan ? { compositionPlan: dag.compositionPlan } : {}),
    libraryHints: {
      agentProfileRefs: Array.from(
        new Set(dag.nodes.map((node) => node.profileRef).filter((profileRef) => profileRef.length > 0)),
      ),
    },
  };
}

export function initialWorkflowLifecycleState(dag: WorkflowDag): WorkflowLifecycleState {
  if (!dag.draftId) {
    return { phase: "file_draft" };
  }
  const draft = buildPlannerDraftResultFromDag(dag);
  return {
    phase: phaseFromDraftStatus(draft.status),
    draft,
    canRun: draft.status === "validated",
  };
}

export function workflowLifecycleReducer(
  state: WorkflowLifecycleState,
  action: WorkflowLifecycleAction,
): WorkflowLifecycleState {
  if (action.type === "dag_changed") {
    return initialWorkflowLifecycleState(action.dag);
  }
  if (action.type === "drafting") {
    return { ...state, phase: "drafting", error: undefined };
  }
  if (action.type === "draft_progress") {
    return { ...state, phase: "drafting", progressMessage: action.message, error: undefined };
  }
  if (action.type === "drafted") {
    return stateFromDraft(action.draft);
  }
  if (action.type === "draft_status_changed") {
    if (state.draft?.draftId !== action.draftId) {
      return state;
    }
    const draft = { ...state.draft, status: action.status };
    return {
      ...state,
      phase: phaseFromDraftStatus(action.status),
      draft,
      orchestration: action.status === "validated" ? state.orchestration : undefined,
      canRun: action.status === "validated",
    };
  }
  if (action.type === "validating") {
    return { ...state, phase: "validating", error: undefined };
  }
  if (action.type === "validated") {
    const canRun = action.orchestration.status === "validated";
    return {
      ...state,
      phase: phaseFromDraftStatus(action.orchestration.status),
      draft: action.orchestration,
      orchestration: action.orchestration,
      canRun,
    };
  }
  if (action.type === "running") {
    return { ...state, phase: "running", error: undefined };
  }
  if (action.type === "run_created") {
    return { ...state, phase: "run_created", run: action.run, canRun: false };
  }
  if (action.type === "executing") {
    return { ...state, phase: "executing", error: undefined };
  }
  if (action.type === "executed") {
    return { ...state, phase: "executing", execute: action.execute, canRun: false };
  }
  if (action.type === "execute_failed") {
    return { ...state, phase: "run_created", error: action.error, canRun: false };
  }
  return { ...state, phase: "blocked", error: action.error, canRun: false };
}

function stateFromDraft(draft: PlannerDraftResult): WorkflowLifecycleState {
  return {
    phase: phaseFromDraftStatus(draft.status),
    draft,
    canRun: draft.status === "validated",
  };
}

function phaseFromDraftStatus(status: string): WorkflowLifecycleState["phase"] {
  if (status === "validated") return "validated";
  if (status === "needs_validation") return "needs_validation";
  if (status === "invalid") return "invalid";
  return "planner_draft";
}

function buildPlannerDraftResultFromDag(dag: WorkflowDag): PlannerDraftResult {
  const dependsOnByNode = new Map<string, string[]>();
  for (const edge of dag.edges) {
    const dependencies = dependsOnByNode.get(edge.to) ?? [];
    dependencies.push(edge.from);
    dependsOnByNode.set(edge.to, dependencies);
  }

  return {
    draftId: dag.draftId ?? dag.id,
    goalPrompt: dag.prompt,
    workflowId: dag.templateTitle || dag.id,
    status: dag.draftStatus ?? (dag.readiness === "ready" ? "validated" : "needs_validation"),
    validationIssues: [],
    taskSummaries: dag.nodes.map((node) => ({
      taskId: node.taskId ?? node.id,
      taskName: node.label,
      dependsOn: dependsOnByNode.get(node.id) ?? [],
      roleRef: node.role,
      agentProfileRef: node.profileRef,
    })),
  };
}
