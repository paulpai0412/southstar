"use client";

import { useReducer } from "react";
import { buildPlannerDraftRequest, workflowLifecycleReducer } from "@/lib/workflow/lifecycle";
import type {
  PlannerDraftOrchestrationView,
  PlannerDraftResult,
  WorkflowDag,
  WorkflowExecuteResult,
  WorkflowRunResult,
} from "@/lib/workflow/types";

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok || data.error) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

export function useWorkflowLifecycle(dag: WorkflowDag, cwd?: string | null) {
  const [state, dispatch] = useReducer(workflowLifecycleReducer, { phase: "file_draft" as const });

  const createDraft = async () => {
    dispatch({ type: "drafting" });
    try {
      const response = await fetch("/api/workflow/planner-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPlannerDraftRequest(dag, cwd)),
      });
      dispatch({ type: "drafted", draft: await readJson<PlannerDraftResult>(response) });
    } catch (error) {
      dispatch({ type: "blocked", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const validateDraft = async () => {
    if (!state.draft?.draftId) {
      return;
    }
    dispatch({ type: "validating" });
    try {
      const response = await fetch(
        `/api/workflow/planner-drafts/${encodeURIComponent(state.draft.draftId)}/orchestration`,
      );
      dispatch({ type: "validated", orchestration: await readJson<PlannerDraftOrchestrationView>(response) });
    } catch (error) {
      dispatch({ type: "blocked", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const runDraft = async () => {
    if (!state.draft?.draftId || !state.canRun) {
      return;
    }
    dispatch({ type: "running" });
    let createdRun: WorkflowRunResult | null = null;

    try {
      const orchestrationResponse = await fetch(
        `/api/workflow/planner-drafts/${encodeURIComponent(state.draft.draftId)}/orchestration`,
      );
      const orchestration = await readJson<PlannerDraftOrchestrationView>(orchestrationResponse);
      dispatch({ type: "validated", orchestration });
      if (orchestration.status !== "validated") {
        dispatch({ type: "blocked", error: "Planner draft is not validated" });
        return;
      }

      const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(state.draft.draftId)}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      createdRun = await readJson<WorkflowRunResult>(response);
      dispatch({ type: "run_created", run: createdRun });

      dispatch({ type: "executing" });
      const executeResponse = await fetch(`/api/workflow/runs/${encodeURIComponent(createdRun.runId)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      dispatch({ type: "executed", execute: await readJson<WorkflowExecuteResult>(executeResponse) });
    } catch (error) {
      dispatch({
        type: createdRun ? "execute_failed" : "blocked",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const retryExecute = async () => {
    if (!state.run?.runId) {
      return;
    }
    dispatch({ type: "executing" });
    try {
      const executeResponse = await fetch(`/api/workflow/runs/${encodeURIComponent(state.run.runId)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      dispatch({ type: "executed", execute: await readJson<WorkflowExecuteResult>(executeResponse) });
    } catch (error) {
      dispatch({ type: "execute_failed", error: error instanceof Error ? error.message : String(error) });
    }
  };

  return { state, createDraft, validateDraft, runDraft, retryExecute };
}
