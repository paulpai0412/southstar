"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";
import { OperationsPanels } from "./OperationsPanels";
import { PlannerChat } from "./PlannerChat";
import { RuntimeMonitor } from "./RuntimeMonitor";
import { TaskDetail } from "./TaskDetail";
import type { PlannerDraftView, RunCreationView, RunStatusView, TaskDetailView, TaskEnvelopeEvidenceView } from "./types";
import type { SouthstarViewMode } from "./view-mode";
import { WorkflowCanvas } from "./WorkflowCanvas";

const defaultGoalPrompt = "新增 calc sum <numbers...>，保留最小改動，不新增 runtime dependency。";

export function SouthstarOperationsApp() {
  const [mode, setMode] = useState<SouthstarViewMode>("simple");
  const [goalPrompt, setGoalPrompt] = useState(defaultGoalPrompt);
  const [draft, setDraft] = useState<PlannerDraftView | null>(null);
  const [run, setRun] = useState<RunCreationView | null>(null);
  const [status, setStatus] = useState<RunStatusView | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskDetailView | null>(null);
  const [selectedEnvelope, setSelectedEnvelope] = useState<TaskEnvelopeEvidenceView | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: southstarServerUrl() }), []);
  const currentRunId = run?.runId ?? status?.canvas.runId ?? null;

  const refreshRun = useCallback(async (runId: string) => {
    const nextStatus = await api.getRun(runId);
    setStatus(nextStatus);
    const firstTaskId = nextStatus.canvas.nodes[0]?.id ?? null;
    setSelectedTaskId((current) => current ?? firstTaskId);
    return nextStatus;
  }, [api]);

  const refreshTask = useCallback(async (runId: string, taskId: string) => {
    const [task, envelope] = await Promise.all([
      api.getTask(runId, taskId),
      api.getTaskEnvelope(runId, taskId),
    ]);
    setSelectedTask(task);
    setSelectedEnvelope(envelope);
  }, [api]);

  useEffect(() => {
    if (!currentRunId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const nextStatus = await api.getRun(currentRunId);
        if (cancelled) return;
        setStatus(nextStatus);
        const firstTaskId = nextStatus.canvas.nodes[0]?.id ?? null;
        setSelectedTaskId((current) => current ?? firstTaskId);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    };
    void tick();
    const interval = window.setInterval(tick, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [api, currentRunId]);

  useEffect(() => {
    if (!currentRunId || !selectedTaskId) return;
    let cancelled = false;
    refreshTask(currentRunId, selectedTaskId)
      .catch((cause) => {
        if (!cancelled) setError((cause as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [currentRunId, refreshTask, selectedTaskId]);

  async function withBusy<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusyAction(label);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      setError((cause as Error).message);
      return undefined;
    } finally {
      setBusyAction(null);
    }
  }

  const onCreateDraft = () => withBusy("planner", async () => {
    const nextDraft = await api.createDraft(goalPrompt);
    setDraft(nextDraft);
    setRun(null);
    setStatus(null);
    setSelectedTask(null);
    setSelectedEnvelope(null);
    setSelectedTaskId(null);
  });

  const onRunDraft = () => withBusy("run", async () => {
    const ensuredDraft = draft ?? await api.createDraft(goalPrompt);
    setDraft(ensuredDraft);
    const nextRun = await api.runDraft(ensuredDraft.draftId);
    setRun(nextRun);
    const nextStatus = await refreshRun(nextRun.runId);
    const firstTaskId = nextStatus.canvas.nodes[0]?.id;
    if (firstTaskId) await refreshTask(nextRun.runId, firstTaskId);
  });

  const onSelectTask = (taskId: string) => {
    if (taskId === selectedTaskId) {
      if (currentRunId && !selectedTask) {
        void refreshTask(currentRunId, taskId).catch((cause) => setError((cause as Error).message));
      }
      return;
    }
    setSelectedTask(null);
    setSelectedEnvelope(null);
    setSelectedTaskId(taskId);
  };

  return (
    <main className={`ss-app-shell ss-mode-${mode}`}>
      <aside className="ss-rail">
        <div className="ss-brand">Southstar v2</div>
        <nav>
          <a href="#planner-chat">Planner Chat</a>
          <a href="#workflow-canvas">Workflow Canvas</a>
          <a href="#runtime-monitor">Runtime Monitor</a>
          <a href="#task-detail">Task Detail</a>
          <a href="#executor-ops">Executor Ops</a>
        </nav>
      </aside>
      <section className="ss-workspace">
        <header className="ss-topbar">
          <strong>Pi Planner Orchestration</strong>
          <div className="ss-toggle" aria-label="view mode">
            <button type="button" onClick={() => setMode("simple")} aria-pressed={mode === "simple"}>
              Simple
            </button>
            <button type="button" onClick={() => setMode("full")} aria-pressed={mode === "full"}>
              Full
            </button>
          </div>
        </header>
        <div className="ss-grid">
          <PlannerChat
            busyAction={busyAction}
            draft={draft}
            error={error}
            goalPrompt={goalPrompt}
            run={run}
            onCreateDraft={onCreateDraft}
            onGoalPromptChange={setGoalPrompt}
            onRunDraft={onRunDraft}
          />
          <WorkflowCanvas
            model={status?.canvas}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
          <RuntimeMonitor model={status?.runtime} />
          <TaskDetail task={selectedTask} envelope={selectedEnvelope} />
        </div>
        {mode === "full" ? <OperationsPanels status={status} /> : null}
      </section>
    </main>
  );
}

function southstarServerUrl(): string {
  return process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL
    ?? process.env.SOUTHSTAR_SERVER_URL
    ?? "http://127.0.0.1:3001";
}
