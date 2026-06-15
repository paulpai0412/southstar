"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Boxes,
  CircleDot,
  Database,
  FileText,
  GitBranch,
  MessageSquare,
  Network,
  Package,
  Pause,
  ServerCog,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";
import { OperationsPanels } from "./OperationsPanels";
import { PlannerChat } from "./PlannerChat";
import { RuntimeMonitor } from "./RuntimeMonitor";
import { TaskDetail } from "./TaskDetail";
import type {
  PlannerDraftView,
  RunCreationView,
  RunStatusView,
  SouthstarCommandResultView,
  TaskDetailView,
  TaskEnvelopeEvidenceView,
  UiTaskDetailPageView,
} from "./types";
import type { SouthstarViewMode } from "./view-mode";
import { WorkflowCanvas } from "./WorkflowCanvas";

const defaultGoalPrompt = "新增 calc sum <numbers...>，保留最小改動，不新增 runtime dependency。";
const fullModePanels = new Set(["agent-definitions", "sessions-memory", "vault-mcp", "executor-ops", "approval-policy"]);
const navItems: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: "planner-chat", label: "Planner Chat", icon: MessageSquare },
  { id: "workflow-canvas", label: "Workflow Canvas", icon: Network },
  { id: "runtime-monitor", label: "Runtime Monitor", icon: Activity },
  { id: "task-detail", label: "Task Detail", icon: FileText },
  { id: "sessions-memory", label: "Sessions/Memory", icon: Database },
  { id: "worktree-console", label: "Worktree", icon: GitBranch },
  { id: "executor-ops", label: "Executor Ops", icon: ServerCog },
  { id: "domain-packs", label: "Domain Packs", icon: Package },
];

export function SouthstarOperationsApp() {
  const [mode, setMode] = useState<SouthstarViewMode>("simple");
  const [goalPrompt, setGoalPrompt] = useState(defaultGoalPrompt);
  const [draft, setDraft] = useState<PlannerDraftView | null>(null);
  const [run, setRun] = useState<RunCreationView | null>(null);
  const [status, setStatus] = useState<RunStatusView | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskDetailView | null>(null);
  const [selectedEnvelope, setSelectedEnvelope] = useState<TaskEnvelopeEvidenceView | null>(null);
  const [selectedTaskPage, setSelectedTaskPage] = useState<UiTaskDetailPageView | null>(null);
  const [worktreePreviewIds, setWorktreePreviewIds] = useState<Record<string, string>>({});
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
    const [task, envelope, page] = await Promise.all([
      api.getTask(runId, taskId),
      api.getTaskEnvelope(runId, taskId),
      api.getUiTaskDetail(runId, taskId) as Promise<UiTaskDetailPageView>,
    ]);
    setSelectedTask(task);
    setSelectedEnvelope(envelope);
    setSelectedTaskPage(page);
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      try {
        const planner = await api.getUiPlanner() as {
          activeDraft?: { draftId: string; workflowId: string; goalPrompt: string };
          selectedRunId?: string | null;
        };
        if (cancelled) return;
        if (planner.activeDraft) {
          setDraft({
            draftId: planner.activeDraft.draftId,
            workflowId: planner.activeDraft.workflowId,
            goalPrompt: planner.activeDraft.goalPrompt,
          });
          setGoalPrompt(planner.activeDraft.goalPrompt);
        }
        if (planner.selectedRunId) {
          setRun({ runId: planner.selectedRunId });
          const nextStatus = await refreshRun(planner.selectedRunId);
          if (cancelled) return;
          const firstTaskId = nextStatus.canvas.nodes[0]?.id;
          if (firstTaskId) await refreshTask(planner.selectedRunId, firstTaskId);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [api, refreshRun, refreshTask]);

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
    setSelectedTaskPage(null);
    setSelectedTaskId(null);
    setWorktreePreviewIds({});
    focusPanel("workflow-canvas");
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
    setSelectedTaskPage(null);
    setSelectedTaskId(taskId);
  };

  const onTaskCommand = (command: string) => withBusy(command, async () => {
    if (!currentRunId || !selectedTaskId) throw new Error("Select a running task before issuing a task command.");
    const pathByCommand: Record<string, string> = {
      "retry-task": `/api/v2/runs/${encodeURIComponent(currentRunId)}/tasks/${encodeURIComponent(selectedTaskId)}/retry`,
      "fork-session": `/api/v2/runs/${encodeURIComponent(currentRunId)}/tasks/${encodeURIComponent(selectedTaskId)}/fork-session`,
      "rollback-workspace": `/api/v2/runs/${encodeURIComponent(currentRunId)}/tasks/${encodeURIComponent(selectedTaskId)}/rollback-workspace`,
      "request-revision": `/api/v2/runs/${encodeURIComponent(currentRunId)}/tasks/${encodeURIComponent(selectedTaskId)}/request-revision`,
    };
    const path = pathByCommand[command];
    if (!path) throw new Error(`Unknown task command: ${command}`);
    await api.command(path, commandRequest(command));
    await refreshRun(currentRunId);
    await refreshTask(currentRunId, selectedTaskId);
  });

  const onSessionCommand = (command: "fork" | "reset" | "rollback") => withBusy(`session-${command}`, async () => {
    if (!currentRunId || !selectedTaskId) throw new Error("Select a running task before changing session lineage.");
    const sessionId = selectedEnvelope?.session?.sessionId ?? selectedTask?.rootSessionId;
    const checkpointId = selectedEnvelope?.session?.baseCheckpointId;
    if (!sessionId || !checkpointId) throw new Error("Task envelope does not include a session checkpoint for lineage operations.");
    const result = await api.command(`/api/v2/sessions/${encodeURIComponent(sessionId)}/${command}`, {
      ...commandRequest(`session-${command}`),
      payload: { checkpointId, reason: `Requested from Task Detail: session ${command}` },
    }) as SouthstarCommandResultView;
    ensureAccepted(result);
    await refreshTask(currentRunId, selectedTaskId);
  });

  const onPauseRun = () => withBusy("pause-run", async () => {
    if (!currentRunId) throw new Error("Select a running run before pausing.");
    await api.command(`/api/v2/runs/${encodeURIComponent(currentRunId)}/pause`, commandRequest("pause-run"));
    await refreshRun(currentRunId);
  });

  const onPreviewWorktreeRollback = () => withBusy("worktree-preview", async () => {
    if (!currentRunId || !selectedTaskId) throw new Error("Select a running task before previewing rollback.");
    const workspace = selectedEnvelope?.workspace;
    const repoRoot = workspace?.handle?.repoRoot ?? workspace?.handle?.worktreePath ?? workspace?.baseSnapshotRef?.repoRoot;
    if (!repoRoot) throw new Error("Task envelope does not include a repo root for rollback preview.");
    const snapshot = await api.command(`/api/v2/runs/${encodeURIComponent(currentRunId)}/worktree/snapshots`, {
      ...commandRequest("worktree-snapshot"),
      payload: { repoRoot, taskId: selectedTaskId },
    }) as SouthstarCommandResultView;
    ensureAccepted(snapshot);
    const snapshotRef = snapshot.resourceRefs[0];
    if (!snapshotRef) throw new Error("Worktree snapshot command did not return a snapshot resource.");
    const preview = await api.command(`/api/v2/runs/${encodeURIComponent(currentRunId)}/worktree/rollback-preview`, {
      ...commandRequest("worktree-rollback-preview"),
      payload: { repoRoot, taskId: selectedTaskId, snapshotRef },
    }) as SouthstarCommandResultView;
    ensureAccepted(preview);
    const previewId = preview.resourceRefs[0];
    if (!previewId) throw new Error("Worktree rollback preview did not return a preview resource.");
    setWorktreePreviewIds((current) => ({ ...current, [selectedTaskId]: previewId }));
    await refreshTask(currentRunId, selectedTaskId);
  });

  const onApplyWorktreeRollback = () => withBusy("worktree-rollback", async () => {
    if (!currentRunId || !selectedTaskId) throw new Error("Select a running task before applying rollback.");
    const workspace = selectedEnvelope?.workspace;
    const repoRoot = workspace?.handle?.repoRoot ?? workspace?.handle?.worktreePath ?? workspace?.baseSnapshotRef?.repoRoot;
    const previewId = worktreePreviewIds[selectedTaskId];
    if (!repoRoot) throw new Error("Task envelope does not include a repo root for rollback.");
    if (!previewId) throw new Error("Preview rollback before applying workspace rollback.");
    const result = await api.command(`/api/v2/runs/${encodeURIComponent(currentRunId)}/worktree/rollback`, {
      ...commandRequest("worktree-rollback"),
      payload: { repoRoot, taskId: selectedTaskId, previewId },
    }) as SouthstarCommandResultView;
    ensureAccepted(result);
    await refreshTask(currentRunId, selectedTaskId);
  });

  const onMemoryCommand = (command: "approve" | "reject") => withBusy(`memory-${command}`, async () => {
    const memoryId = selectedEnvelope?.contextPacket?.selectedMemories?.[0]?.id;
    if (!memoryId) throw new Error("No injected memory is available for this task.");
    await api.command(`/api/v2/memory/${encodeURIComponent(memoryId)}/${command}`, commandRequest(`memory-${command}`));
    if (currentRunId && selectedTaskId) await refreshTask(currentRunId, selectedTaskId);
  });

  const navigateToPanel = (panelId: string) => {
    if (fullModePanels.has(panelId)) setMode("full");
    window.requestAnimationFrame(() => focusPanel(panelId));
  };

  return (
    <main className={`ss-app-shell ss-control-plane ss-mode-${mode}`}>
      <aside className="ss-rail">
        <div className="ss-brand"><Boxes size={21} aria-hidden /> Southstar v2</div>
        <nav>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" onClick={() => navigateToPanel(id)}><Icon size={18} aria-hidden /> {label}</button>
          ))}
        </nav>
        <div className="ss-rail-account"><span>OP</span><strong>ops@example.com</strong></div>
        <div className="ss-rail-warning">Session/Worktree ops need API binding</div>
      </aside>
      <section className="ss-workspace">
        <header className="ss-topbar">
          <strong>Pi Planner Orchestration</strong>
          <div className="ss-topbar-actions">
            <div className="ss-toggle" aria-label="view mode">
              <button type="button" onClick={() => setMode("simple")} aria-pressed={mode === "simple"}>
                Simple
              </button>
              <button type="button" onClick={() => setMode("full")} aria-pressed={mode === "full"}>
                Full
              </button>
            </div>
            <span className="ss-run-pill"><CircleDot size={12} aria-hidden /> {currentRunId ? "Run Active" : "Run Idle"}</span>
            <button type="button" className="ss-topbar-button" onClick={() => void onPauseRun()} disabled={!currentRunId}><Pause size={14} aria-hidden /> Pause</button>
          </div>
        </header>
        <div className="ss-grid ss-control-plane-grid">
          <div className="ss-left-stack">
            <PlannerChat
              busyAction={busyAction}
              draft={draft}
              error={error}
              goalPrompt={goalPrompt}
              run={run}
              onCreateDraft={onCreateDraft}
              onGoalPromptChange={setGoalPrompt}
              onRunDraft={onRunDraft}
              onReviewDraft={() => focusPanel("workflow-canvas")}
              onRevise={() => focusPanel("planner-chat")}
            />
            <RuntimeMonitor model={status?.runtime} />
          </div>
          <div className="ss-center-stack">
            <WorkflowCanvas
              draft={draft}
              model={status?.canvas}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
            <section className="ss-panel ss-runtime-log">
              <header><h2>{selectedTaskId ?? "T2"} Runtime Events</h2><span>8</span></header>
              <table><tbody>{runtimeRows(status?.runtime.latestProgress).map((row) => <tr key={row[0]}><td>{row[0]}</td><td>{row[1]}</td><td>{row[2]}</td></tr>)}</tbody></table>
            </section>
          </div>
          <div className="ss-right-inspector">
            <TaskDetail
              task={selectedTask}
              envelope={selectedEnvelope}
              model={selectedTaskPage}
              onRetryTask={() => void onTaskCommand("retry-task")}
              onForkSession={() => void onSessionCommand("fork")}
              onResetSession={() => void onSessionCommand("reset")}
              onRollbackSession={() => void onSessionCommand("rollback")}
              onRollbackWorkspace={() => void onTaskCommand("rollback-workspace")}
              onPreviewWorktreeRollback={() => void onPreviewWorktreeRollback()}
              onApplyWorktreeRollback={() => void onApplyWorktreeRollback()}
              onRequestWorkflowRevision={() => void onTaskCommand("request-revision")}
              onApproveMemory={() => void onMemoryCommand("approve")}
              onRejectMemory={() => void onMemoryCommand("reject")}
            />
          </div>
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

function focusPanel(panelId: string): void {
  document.getElementById(panelId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function commandRequest(command: string) {
  return {
    commandId: `ui-${command}-${Date.now()}`,
    actor: { type: "user" as const, id: "southstar-ui" },
    reason: `Requested from Southstar UI: ${command}`,
    payload: { source: "southstar-control-plane" },
  };
}

function ensureAccepted(result: SouthstarCommandResultView): void {
  if (result.accepted) return;
  const message = result.nextSuggestedActions[0] ?? `${result.commandId} was rejected`;
  throw new Error(message);
}

function runtimeRows(latestProgress?: string) {
  return [
    ["10:14:11", "ContextPacket built", latestProgress ?? "with memory injections"],
    ["10:14:12", "Executor", "Starting task container"],
    ["10:14:14", "Agent", "Plan generated"],
    ["10:14:18", "Output", "Artifact checkpoint recorded"],
  ];
}
