import type {
  PlannerDraftOrchestrationView,
  PlannerDraftResult,
  WorkflowExecuteResult,
  WorkflowDag,
  WorkflowLifecycleState,
  WorkflowRunResult,
} from "./types";

type WorkflowLifecycleAction =
  | { type: "drafting" }
  | { type: "drafted"; draft: PlannerDraftResult }
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
    composerMode: "llm-with-fixture-fallback" as const,
    domainPackId: dag.templateId.includes("software") ? "software" : undefined,
    libraryHints: {
      agentProfileRefs: Array.from(
        new Set(dag.nodes.map((node) => node.profileRef).filter((profileRef) => profileRef.length > 0)),
      ),
    },
  };
}

export function workflowLifecycleReducer(
  state: WorkflowLifecycleState,
  action: WorkflowLifecycleAction,
): WorkflowLifecycleState {
  if (action.type === "drafting") {
    return { ...state, phase: "drafting", error: undefined };
  }
  if (action.type === "drafted") {
    const canRun = action.draft.status === "validated";
    return { phase: canRun ? "validated" : "planner_draft", draft: action.draft, canRun };
  }
  if (action.type === "validating") {
    return { ...state, phase: "validating", error: undefined };
  }
  if (action.type === "validated") {
    const canRun = action.orchestration.status === "validated";
    return { ...state, phase: canRun ? "validated" : "planner_draft", orchestration: action.orchestration, canRun };
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
