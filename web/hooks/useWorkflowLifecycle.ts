"use client";

import { useEffect, useReducer, useRef } from "react";
import { createPlannerDraftStream } from "@/lib/workflow/generate-stream";
import { buildPlannerDraftRequest, initialWorkflowLifecycleState, workflowLifecycleReducer } from "@/lib/workflow/lifecycle";
import type {
  PlannerDraftOrchestrationView,
  PlannerDraftResult,
  WorkflowDag,
  WorkflowExecuteResult,
  WorkflowRunResult,
} from "@/lib/workflow/types";

type PlannerDraftUpdatedDetail = {
  draftId?: string;
  status?: string;
};

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok || data.error) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "result" in data &&
    (data as { result?: unknown }).result !== undefined
  ) {
    return (data as { result: T }).result;
  }
  return data;
}

export function useWorkflowLifecycle(dag: WorkflowDag, cwd?: string | null) {
  const [state, dispatch] = useReducer(workflowLifecycleReducer, dag, initialWorkflowLifecycleState);
  const dagLifecycleSignature = `${dag.id}\u0000${dag.draftId ?? ""}\u0000${dag.draftStatus ?? ""}\u0000${dag.runId ?? ""}`;
  const lastDagLifecycleSignatureRef = useRef(dagLifecycleSignature);

  useEffect(() => {
    if (lastDagLifecycleSignatureRef.current === dagLifecycleSignature) {
      return;
    }
    lastDagLifecycleSignatureRef.current = dagLifecycleSignature;
    dispatch({ type: "dag_changed", dag });
  }, [dag, dagLifecycleSignature]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handlePlannerDraftUpdated = (event: Event) => {
      const detail = (event as CustomEvent<PlannerDraftUpdatedDetail>).detail;
      const draftId = detail?.draftId;
      if (!draftId) return;
      dispatch({
        type: "draft_status_changed",
        draftId,
        status: detail.status ?? "needs_validation",
      });
    };
    window.addEventListener("southstar:planner-draft-updated", handlePlannerDraftUpdated);
    return () => {
      window.removeEventListener("southstar:planner-draft-updated", handlePlannerDraftUpdated);
    };
  }, []);

  const createDraftFromDag = async (): Promise<PlannerDraftResult> => {
    let createdDraft: PlannerDraftResult | undefined;
    await createPlannerDraftStream({
      request: buildPlannerDraftRequest(dag, cwd),
      onStage(stage) {
        const message = stage.message ?? stage.stage;
        if (message) {
          dispatch({ type: "draft_progress", message });
        }
      },
      onDraft(draft) {
        createdDraft = draft as PlannerDraftResult;
        dispatch({ type: "drafted", draft: createdDraft });
      },
    });
    if (!createdDraft) {
      throw new Error("planner draft stream completed without a draft");
    }
    return createdDraft;
  };

  const createDraft = async () => {
    dispatch({ type: "drafting" });
    try {
      await createDraftFromDag();
    } catch (error) {
      dispatch({ type: "blocked", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const validateDraft = async () => {
    let draftId = state.draft?.draftId ?? dag.draftId;
    if (!draftId) {
      dispatch({ type: "drafting" });
      try {
        const draft = await createDraftFromDag();
        draftId = draft.draftId;
      } catch (error) {
        dispatch({ type: "blocked", error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    dispatch({ type: "validating" });
    try {
      const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(draftId)}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      dispatch({ type: "validated", orchestration: await readJson<PlannerDraftOrchestrationView>(response) });
    } catch (error) {
      dispatch({ type: "blocked", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const runDraft = async () => {
    const draftId = state.draft?.draftId ?? dag.draftId;
    const canRunDraft = state.canRun || Boolean(dag.draftId && (dag.draftStatus === "validated" || dag.readiness === "ready"));
    if (!draftId || !canRunDraft) {
      return;
    }
    dispatch({ type: "running" });
    let createdRun: WorkflowRunResult | null = null;

    try {
      const orchestrationResponse = await fetch(
        `/api/workflow/planner-drafts/${encodeURIComponent(draftId)}/orchestration`,
      );
      const orchestration = await readJson<PlannerDraftOrchestrationView>(orchestrationResponse);
      dispatch({ type: "validated", orchestration });
      if (orchestration.status !== "validated") {
        dispatch({ type: "blocked", error: "Planner draft is not validated" });
        return;
      }

      const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(draftId)}/runs`, {
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
