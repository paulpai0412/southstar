"use client";

import { useEffect, useState } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { LibraryContextPanel } from "./LibraryContextPanel";
import { GuidedPlannerChat } from "./GuidedPlannerChat";
import { WorkflowDagPanel } from "./WorkflowDagPanel";
import { TaskInspector } from "./TaskInspector";
import { LibraryAlternativesSheet } from "./LibraryAlternativesSheet";

const defaultGoal = "在 todo-web repo 新增 priority labels 與 overdue filter，並做 browser QA 與 spec alignment";

export function WorkflowTab(props: { api: SouthstarApiClient; onOpenOperator: () => void }) {
  const [goalPrompt, setGoalPrompt] = useState(defaultGoal);
  const [draftId, setDraftId] = useState<string | undefined>();
  const [runId, setRunId] = useState<string | undefined>();
  const [workflowModel, setWorkflowModel] = useState<any | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const [alternativesModel, setAlternativesModel] = useState<any | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialDraftId = params.get("draftId") ?? undefined;
    const initialRunId = params.get("runId") ?? undefined;
    setDraftId(initialDraftId);
    setRunId(initialRunId);
    void refreshModel(initialDraftId, initialRunId);
  }, []);

  async function refreshModel(nextDraftId = draftId, nextRunId = runId) {
    try {
      const next = await props.api.getUiWorkflowTab({ draftId: nextDraftId, runId: nextRunId });
      setWorkflowModel(next);
      setSelectedTaskId((current) => current ?? next?.draft?.taskInspector?.taskId ?? null);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function planWorkflow() {
    setPlanning(true);
    setError(null);
    try {
      const draft = await props.api.createDraft(goalPrompt);
      setDraftId(draft.draftId);
      setRunId(undefined);
      await refreshModel(draft.draftId, undefined);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setPlanning(false);
    }
  }

  async function runWorkflow() {
    if (!draftId) return;
    setRunning(true);
    setError(null);
    try {
      const run = await props.api.runDraft(draftId);
      setRunId(run.runId);
      await refreshModel(undefined, run.runId);
      props.onOpenOperator();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function openAlternatives() {
    if (!draftId) return;
    setAlternativesOpen(true);
    try {
      const model = await props.api.getUiLibraryAlternatives({ draftId, taskId: selectedTaskId ?? undefined });
      setAlternativesModel(model);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <section className="ss-workflow-tab">
      <div className="ss-workflow-grid">
        <LibraryContextPanel model={workflowModel} onOpenAlternatives={openAlternatives} />
        <div className="ss-workflow-center">
          <GuidedPlannerChat value={goalPrompt} planning={planning} onChange={setGoalPrompt} onPlan={planWorkflow} />
          <WorkflowDagPanel model={workflowModel} selectedTaskId={selectedTaskId} onSelectTask={setSelectedTaskId} />
        </div>
        <TaskInspector model={workflowModel} selectedTaskId={selectedTaskId} onRunDraft={runWorkflow} running={running} runDisabled={!draftId} />
      </div>
      {alternativesOpen ? <LibraryAlternativesSheet model={alternativesModel} onClose={() => setAlternativesOpen(false)} /> : null}
      {error ? <p className="ss-error">{error}</p> : null}
    </section>
  );
}
