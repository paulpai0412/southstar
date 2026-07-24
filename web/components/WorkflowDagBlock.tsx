"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SouthstarWorkflowCanvas } from "./workflow-canvas/SouthstarWorkflowCanvas";
import { GoalContractCard } from "./GoalContractCard";
import { buildMissionCoverageGraph } from "./GoalContractInspector";
import type { WorkflowCanvasModel, WorkflowDependencyModel, WorkflowTaskNodeModel } from "./workflow-canvas/types";
import { useWorkflowLifecycle } from "@/hooks/useWorkflowLifecycle";
import { buildWorkflowTemplateSaveRequest } from "@/lib/workflow/template-save";
import { invokeOperatorCommand } from "@/lib/operator/invokeCommand";
import type { GoalMissionReadModel, WorkflowCommandDescriptor, WorkflowDag, WorkflowDagNode } from "@/lib/workflow/types";
import { CoverageGraphPreview, type CoverageGraphData } from "./CoverageGraphPreview";
import type { LibraryGraphChartEdge, LibraryGraphChartNode } from "./library/LibraryGraphChart";

type SaveTemplateStatus =
  | { phase: "idle" }
  | { phase: "saving"; message: string }
  | { phase: "saved"; message: string }
  | { phase: "error"; message: string };

type ApprovalStatus =
  | { phase: "idle"; message: null }
  | { phase: "pending" | "succeeded" | "error"; message: string };

type ApprovalDraft = {
  command: WorkflowCommandDescriptor;
  reason: string;
};

type RefreshedWorkflowRuntime = {
  mission: GoalMissionReadModel | null;
  approvalCommand?: WorkflowCommandDescriptor;
  runStatus?: WorkflowDag["runStatus"];
};

export function WorkflowDagBlock({
  dag,
  cwd,
  onNodeSelect,
  onGoalContractSelect,
  onReviseGoal,
  onMissionRefresh,
  onLibraryGraphNodeSelect,
}: {
  dag: WorkflowDag;
  cwd?: string | null;
  onNodeSelect?: (node: WorkflowDagNode) => void;
  onGoalContractSelect?: (dag: WorkflowDag) => void;
  onReviseGoal?: (dag: WorkflowDag, choice?: string) => void;
  onMissionRefresh?: (dag: WorkflowDag) => Promise<GoalMissionReadModel | null>;
  onLibraryGraphNodeSelect?: (node: LibraryGraphChartNode) => void;
}) {
  const [expanded, setExpanded] = useState<boolean>(dag.expandedByDefault ?? true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saveTemplateStatus, setSaveTemplateStatus] = useState<SaveTemplateStatus>({ phase: "idle" });
  const [reviewMode, setReviewMode] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState<ApprovalStatus>({ phase: "idle", message: null });
  const [approvalDraft, setApprovalDraft] = useState<ApprovalDraft | null>(null);
  const [refreshedMission, setRefreshedMission] = useState<GoalMissionReadModel | null>(null);
  const [refreshedApprovalCommand, setRefreshedApprovalCommand] = useState<WorkflowCommandDescriptor | null>(null);
  const [refreshedRunStatus, setRefreshedRunStatus] = useState<WorkflowDag["runStatus"]>();
  const approvalInFlightRef = useRef(false);
  const { state, createDraft, validateDraft, runDraft, executeRun } = useWorkflowLifecycle(dag, cwd);
  const busy = state.phase === "drafting" || state.phase === "validating" || state.phase === "running" || state.phase === "executing";
  const activeDraftId = state.draft?.draftId ?? dag.draftId;
  const activeRunId = state.run?.runId ?? dag.runId;
  const draftReady = Boolean(activeDraftId);
  const canValidateActiveDag = draftReady;
  const canRunActiveDraft = state.canRun || Boolean(dag.draftId && (dag.draftStatus === "validated" || dag.readiness === "ready"));
  const saveTemplateBusy = saveTemplateStatus.phase === "saving";
  const validateDisabled = busy || !canValidateActiveDag;
  const runDisabled = busy || !draftReady || !canRunActiveDraft || Boolean(activeRunId);
  const nodeById = useMemo(() => new Map(dag.nodes.map((node) => [node.id, node])), [dag.nodes]);
  const canvas = useMemo(() => workflowDagToCanvasModel(dag, selectedNodeId), [dag, selectedNodeId]);
  const coverageGraph = useMemo(() => buildDagCoverageGraph(dag), [dag]);
  const activeRunStatus: WorkflowDag["runStatus"] = state.run?.runStatus === "awaiting_approval"
    ? "awaiting_approval"
    : state.run?.runStatus === "scheduling"
      ? "scheduling"
      : refreshedRunStatus ?? dag.runStatus;
  const activeDag = useMemo(() => ({
    ...dag,
    ...(activeRunId ? { runId: activeRunId } : {}),
    ...(activeRunStatus ? { runStatus: activeRunStatus } : {}),
  }), [activeRunId, activeRunStatus, dag]);
  const mission = refreshedMission && (!dag.mission || refreshedMission.goalContractHash === dag.mission.goalContractHash)
    ? refreshedMission
    : dag.mission;
  const approvalComplete = approvalStatus.phase === "succeeded" || Boolean(mission?.approval && mission.approval.status !== "pending");
  const approvalPending = approvalStatus.phase === "pending"
    || activeRunStatus === "awaiting_approval"
    || mission?.status.execution === "awaiting_approval"
    || mission?.approval?.status === "pending";
  const executeDisabled = busy || !activeRunId || approvalPending;
  const approvalCommand = approvalComplete ? undefined : refreshedApprovalCommand ?? dag.approvalCommand;

  useEffect(() => {
    if (!activeRunId) return;
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const next = await refreshGoalRuntime({
          ...dag,
          ...(activeRunId ? { runId: activeRunId } : {}),
          ...(activeRunStatus ? { runStatus: activeRunStatus } : {}),
        });
        if (!active) return;
        if (next.mission) setRefreshedMission(next.mission);
        setRefreshedApprovalCommand(next.approvalCommand ?? null);
        setRefreshedRunStatus(next.runStatus);
        if (next.mission && next.mission.status.outcome !== "in_progress" && timer !== undefined) {
          window.clearInterval(timer);
        }
      } catch {
        // A persisted DAG remains usable when the runtime is temporarily unavailable.
      }
    };
    void refresh();
    timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [activeRunId, activeRunStatus]);

  const handleDraft = () => {
    void createDraft();
  };

  const handleValidate = () => {
    void validateDraft();
  };

  const handleRun = () => {
    if (!window.confirm("Create workflow run rows from this validated planner draft?")) {
      return;
    }
    void runDraft();
  };

  const handleExecute = () => {
    if (!window.confirm("Execute this workflow run now?")) {
      return;
    }
    void executeRun();
  };

  const openApprovalForm = (command: WorkflowCommandDescriptor) => {
    if (!activeRunId || approvalInFlightRef.current || approvalComplete) return;
    setApprovalDraft({ command, reason: "Approve Goal Contract execution" });
    setApprovalStatus({ phase: "idle", message: null });
  };

  const submitApproval = async () => {
    if (!activeRunId || !approvalDraft || approvalInFlightRef.current || approvalComplete) return;
    const reason = approvalDraft.reason.trim();
    if (!reason) {
      setApprovalStatus({ phase: "error", message: "Approval reason is required." });
      return;
    }
    approvalInFlightRef.current = true;
    setApprovalStatus({ phase: "pending", message: "Approving…" });
    try {
      await invokeOperatorCommand({ command: approvalDraft.command, runId: activeRunId, reason });
      try {
        const refreshed = onMissionRefresh
          ? await onMissionRefresh(activeDag)
          : await refreshGoalRuntime(activeDag);
        if (refreshed && "mission" in refreshed) {
          if (refreshed.mission) setRefreshedMission(refreshed.mission);
          setRefreshedApprovalCommand(refreshed.approvalCommand ?? null);
          setRefreshedRunStatus(refreshed.runStatus);
        } else if (refreshed) {
          setRefreshedMission(refreshed);
        }
        setApprovalStatus({ phase: "succeeded", message: "Approved" });
      } catch (refreshError) {
        const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
        setApprovalStatus({ phase: "succeeded", message: `Approved · ${message}` });
      }
      setApprovalDraft(null);
    } catch (error) {
      setApprovalStatus({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      approvalInFlightRef.current = false;
    }
  };

  async function saveTemplate() {
    const draftId = state.draft?.draftId ?? dag.draftId;
    if (!draftId) return;
    const defaultTitle = dag.templateTitle?.trim() || "Saved Workflow Template";
    const title = window.prompt("Workflow template name", defaultTitle)?.trim();
    if (!title) return;
    setSaveTemplateStatus({ phase: "saving", message: "Saving..." });
    try {
      const request = buildWorkflowTemplateSaveRequest({ draftId, dag, title });
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      if (!response.ok) throw new Error(await response.text());
      setSaveTemplateStatus({ phase: "saved", message: `Template saved: ${title}` });
    } catch (error) {
      setSaveTemplateStatus({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  const handleSelectTask = (taskId: string) => {
    setSelectedNodeId(taskId);
    const node = nodeById.get(taskId);
    if (node) {
      const nodeWithLifecycleScope: WorkflowDagNode = {
        ...node,
        taskId: node.taskId ?? node.id,
        draftId: state.draft?.draftId ?? node.draftId ?? dag.draftId,
        runId: state.run?.runId ?? node.runId ?? dag.runId,
        mode: activeRunId ? "runtime" : activeDraftId ? "draft" : node.mode ?? dag.mode,
      };
      onNodeSelect?.(nodeWithLifecycleScope);
    }
  };

  return (
    <div
      data-testid="workflow-dag-block"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 7,
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
      <button
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 10px",
          border: "none",
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent)", fontWeight: 650 }}>
          DAG
        </span>
        <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {dag.templateTitle}
        </span>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 11 }}>
          {dag.nodes.length} nodes
        </span>
      </button>
      {expanded && (
        <div style={{ padding: 10, background: "var(--bg)" }}>
          <details data-testid="workflow-dag-guide" style={dagGuideStyle}>
            <summary style={dagGuideSummaryStyle}>How to review and run this DAG</summary>
            <div style={dagGuideBodyStyle}>
              <div><strong>Each node:</strong> read its purpose, covered requirements, produced slice, and expected outputs before relying on its technical task ID.</div>
              <div><strong>Review mode:</strong> Draft creates a persisted planner draft; Validate checks bindings; Create Run materializes the run; Execute starts work. Operator approval may still be required.</div>
              <div>Click a node to inspect its Agent Profile. Runtime status and evaluator evidence are refreshed from the existing read model while the run proceeds.</div>
            </div>
          </details>
          {mission ? (
            <GoalContractCard
              mission={mission}
              runStatus={activeRunStatus}
              approvalCommand={approvalCommand}
              onOpenDetails={() => onGoalContractSelect?.(dag)}
              onReviseGoal={(choice) => onReviseGoal?.(dag, choice)}
              onApprove={openApprovalForm}
              approvalPending={approvalStatus.phase === "pending"}
            />
          ) : null}
          {approvalDraft && !approvalComplete ? (
            <form
              className="goal-contract-approval-form"
              data-testid="goal-contract-approval-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitApproval();
              }}
            >
              <label htmlFor="goal-contract-approval-reason">Reason for {approvalDraft.command.label}</label>
              <textarea
                id="goal-contract-approval-reason"
                aria-label={`Reason for ${approvalDraft.command.label}`}
                value={approvalDraft.reason}
                onChange={(event) => {
                  const reason = event.currentTarget.value;
                  setApprovalDraft((current) => current ? { ...current, reason } : current);
                }}
                rows={2}
                disabled={approvalStatus.phase === "pending"}
              />
              <div>
                <button
                  type="submit"
                  data-testid="goal-contract-confirm-approval"
                  disabled={approvalStatus.phase === "pending" || !approvalDraft.reason.trim()}
                >
                  Confirm {approvalDraft.command.label}
                </button>
                <button
                  type="button"
                  disabled={approvalStatus.phase === "pending"}
                  onClick={() => {
                    setApprovalDraft(null);
                    setApprovalStatus({ phase: "idle", message: null });
                  }}
                >
                  Cancel approval
                </button>
              </div>
            </form>
          ) : null}
          {approvalStatus.message ? <p className="goal-contract-command-status" aria-live="polite">{approvalStatus.message}</p> : null}
          <button
            type="button"
            className="workflow-review-mode-toggle"
            aria-expanded={reviewMode}
            onClick={() => setReviewMode((value) => !value)}
          >
            Review mode
          </button>
          {reviewMode ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 10,
              flexWrap: "wrap",
            }}
          >
            {!draftReady && (
              <button
                type="button"
                data-testid="workflow-action-draft"
                onClick={handleDraft}
                disabled={busy}
                style={actionButtonStyle(busy)}
              >
                {state.phase === "drafting" ? "Drafting..." : "Draft"}
              </button>
            )}
            {draftReady && (
              <span
                data-testid="workflow-draft-saved"
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg-panel)",
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "5px 9px",
                  lineHeight: 1.2,
                }}
              >
                {renderDraftBadgeLabel(state)}
              </span>
            )}
            <button
              type="button"
              data-testid="workflow-action-validate"
              onClick={handleValidate}
              disabled={validateDisabled}
              style={actionButtonStyle(validateDisabled)}
            >
              Validate
            </button>
            <button
              type="button"
              data-testid="workflow-action-run"
              onClick={handleRun}
              disabled={runDisabled}
              style={actionButtonStyle(runDisabled)}
            >
              {state.phase === "running" ? "Creating..." : "Create Run"}
            </button>
            <button
              type="button"
              data-testid="workflow-action-execute"
              onClick={handleExecute}
              disabled={executeDisabled}
              style={actionButtonStyle(executeDisabled)}
            >
              {state.phase === "executing" ? "Executing..." : "Execute"}
            </button>
            <button
              type="button"
              data-testid="workflow-action-save-template"
              onClick={() => void saveTemplate()}
              disabled={!draftReady || saveTemplateBusy}
              style={actionButtonStyle(!draftReady || saveTemplateBusy)}
            >
              {saveTemplateBusy ? "Saving..." : "Save Template"}
            </button>
            {saveTemplateStatus.phase !== "idle" && (
              <span
                data-testid="workflow-save-template-status"
                style={{
                  fontSize: 11,
                  color: saveTemplateStatus.phase === "error" ? "var(--danger)" : "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {saveTemplateStatus.message}
              </span>
            )}
            <div
              data-testid="workflow-lifecycle-notice"
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                marginLeft: "auto",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {renderLifecycleNotice(state)}
            </div>
          </div>
          ) : null}
          <div
            data-testid="workflow-dag-scroll"
            style={{
              overflowX: "auto",
              overflowY: "auto",
              maxHeight: "min(62vh, 620px)",
              minHeight: 360,
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ minWidth: 760, height: 520 }}>
              <SouthstarWorkflowCanvas
                canvas={canvas}
                selectedTaskId={selectedNodeId}
                onSelectTask={handleSelectTask}
              />
            </div>
          </div>
          <CoverageGraphPreview
            testId="workflow-dag-coverage-preview"
            persistLayoutKey={`workflow-dag-coverage:${dag.id}`}
            nodes={coverageGraph.nodes}
            edges={coverageGraph.edges}
            description="DAG coverage uses persisted mission lineage when available; expected outputs remain separate from produced artifacts."
            onSelectNode={onLibraryGraphNodeSelect}
          />
        </div>
      )}
    </div>
  );
}

async function refreshGoalRuntime(dag: WorkflowDag): Promise<RefreshedWorkflowRuntime> {
  const query = dag.runId
    ? `runId=${encodeURIComponent(dag.runId)}`
    : dag.draftId
      ? `draftId=${encodeURIComponent(dag.draftId)}`
      : null;
  if (!query) return { mission: null };
  const response = await fetch(`/api/workflow/ui?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text() || `Mission refresh failed with ${response.status}`);
  const payload = await response.json() as {
    result?: { mission?: GoalMissionReadModel | null; commands?: unknown };
    mission?: GoalMissionReadModel | null;
    commands?: unknown;
  };
  const result = payload.result ?? payload;
  const mission = result.mission ?? null;
  const approvalCommand = Array.isArray(result.commands)
    ? result.commands.find((command): command is WorkflowCommandDescriptor => (
        typeof command === "object"
        && command !== null
        && "id" in command
        && (command as { id?: unknown }).id === "approval.approve"
      ))
    : undefined;
  return {
    mission,
    ...(approvalCommand ? { approvalCommand } : {}),
    ...(mission?.status.execution === "awaiting_approval" ? { runStatus: "awaiting_approval" as const } : {}),
  };
}

function workflowDagToCanvasModel(dag: WorkflowDag, selectedNodeId: string | null): WorkflowCanvasModel {
  const dependsOnByNode = new Map<string, string[]>();
  for (const edge of dag.edges) {
    const dependencies = dependsOnByNode.get(edge.to) ?? [];
    dependencies.push(edge.from);
    dependsOnByNode.set(edge.to, dependencies);
  }

  const nodes: WorkflowTaskNodeModel[] = dag.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: "task",
    status: nodeStatus(node),
    dependsOn: dependsOnByNode.get(node.id) ?? [],
    roleRef: node.role,
    agentProfileRef: node.profileRef,
    artifactKind: "implementation_report",
    requirementIds: node.requirementIds ?? [],
    sliceId: node.sliceId ?? null,
    purpose: node.purpose ?? null,
    nodeType: node.nodeType ?? null,
    expectedOutputs: node.expectedOutputs ?? [],
    badges: [
      ...(node.provider ? [{ label: node.provider, tone: node.provider === "pi" ? "good" as const : "neutral" as const }] : []),
      ...(node.model ? [{ label: node.model, tone: "neutral" as const }] : []),
    ],
    attention: node.state === "blocked"
      ? { severity: "blocked", reason: "Planner draft is blocked." }
      : node.state === "warning"
        ? { severity: "warning", reason: "Planner draft has validation warnings." }
        : null,
  }));

  const edges: WorkflowDependencyModel[] = dag.edges.map((edge, index) => ({
    id: `${edge.from}->${edge.to}-${index}`,
    source: edge.from,
    target: edge.to,
    status: dag.readiness === "ready" ? "ready" : dag.readiness === "warning" ? "blocked" : "blocked",
  }));

  return {
    graphId: dag.id,
    mode: dag.mode === "runtime" ? "runtime" : "draft",
    selectedNodeId,
    nodes,
    edges,
  };
}

function buildDagCoverageGraph(dag: WorkflowDag): CoverageGraphData {
  const nodes = new Map<string, LibraryGraphChartNode>();
  const edges: LibraryGraphChartEdge[] = [];
  const edgeKeys = new Set<string>();
  const taskKeys = new Set(dag.nodes.map((node) => `task:${node.id}`));
  const missionRequirements = new Map((dag.mission?.goalContract.requirements ?? []).map((requirement) => [requirement.id, requirement]));
  const addNode = (node: LibraryGraphChartNode) => {
    if (!nodes.has(node.objectKey)) nodes.set(node.objectKey, node);
  };
  const addEdge = (fromObjectKey: string, toObjectKey: string, edgeType: string) => {
    const key = `${fromObjectKey}:${edgeType}:${toObjectKey}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ fromObjectKey, toObjectKey, edgeType });
  };

  for (const node of dag.nodes) {
    const taskKey = `task:${node.id}`;
    addNode({
      objectKey: taskKey,
      objectKind: "task",
      status: node.state,
      title: node.label,
      metadata: { purpose: node.purpose, nodeType: node.nodeType, expectedOutputs: node.expectedOutputs ?? [] },
    });
    for (const requirementId of node.requirementIds ?? []) {
      const requirementKey = `requirement:${requirementId}`;
      const requirement = missionRequirements.get(requirementId);
      addNode({
        objectKey: requirementKey,
        objectKind: "requirement",
        status: node.state,
        title: requirement?.statement ?? `Requirement ${requirementId}`,
        ...(requirement ? { metadata: { acceptanceCriteria: requirement.acceptanceCriteria, blocking: requirement.blocking } } : {}),
      });
      if (node.sliceId) {
        const sliceKey = `slice:${node.sliceId}`;
        addNode({ objectKey: sliceKey, objectKind: "slice", status: node.state, title: `Slice ${node.sliceId}` });
        addEdge(requirementKey, sliceKey, "covered by slice");
        addEdge(sliceKey, taskKey, "implemented by task");
      } else {
        addEdge(requirementKey, taskKey, "implemented by task");
      }
    }
    for (const output of node.expectedOutputs ?? []) {
      if (!output) continue;
      const outputKey = `expected-output:${node.id}:${output}`;
      addNode({ objectKey: outputKey, objectKind: "expected_output", status: node.state, title: `Expected output ${output}` });
      addEdge(taskKey, outputKey, "produces expected output");
    }
  }

  for (const edge of dag.edges) {
    const from = `task:${edge.from}`;
    const to = `task:${edge.to}`;
    if (taskKeys.has(from) && taskKeys.has(to)) addEdge(from, to, "depends on");
  }

  if (dag.mission) {
    const missionGraph = buildMissionCoverageGraph(dag.mission);
    for (const node of missionGraph.nodes) addNode(node);
    for (const edge of missionGraph.edges) addEdge(edge.fromObjectKey, edge.toObjectKey, edge.edgeType ?? "related");
    for (const entry of dag.mission.coverage.entries) {
      for (const producerTaskId of entry.producerTaskIds) {
        if (taskKeys.has(`task:${producerTaskId}`)) addEdge(`task:${producerTaskId}`, `producer:${producerTaskId}`, "is producer");
      }
      for (const evaluatorTaskId of entry.evaluatorTaskIds) {
        if (taskKeys.has(`task:${evaluatorTaskId}`)) addEdge(`task:${evaluatorTaskId}`, `evaluator:${evaluatorTaskId}`, "runs evaluator");
      }
    }
  }

  return { nodes: [...nodes.values()], edges };
}

function nodeStatus(node: WorkflowDagNode): string {
  if (node.state === "blocked") return "blocked";
  if (node.state === "warning") return "paused";
  return "ready";
}

function actionButtonStyle(disabled: boolean) {
  return {
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: disabled ? "var(--bg-panel)" : "color-mix(in srgb, var(--accent) 8%, var(--bg))",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 11,
    fontWeight: 600,
    padding: "5px 9px",
    lineHeight: 1.2,
  } as const;
}

const dagGuideStyle = {
  marginBottom: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  fontSize: 11,
  lineHeight: 1.45,
} as const;

const dagGuideSummaryStyle = { cursor: "pointer", padding: "7px 9px", color: "var(--text)" } as const;
const dagGuideBodyStyle = { display: "grid", gap: 5, padding: "0 9px 9px" } as const;

function renderDraftBadgeLabel(state: ReturnType<typeof useWorkflowLifecycle>["state"]) {
  if (state.phase === "validated" || state.canRun) return "Draft validated";
  if (state.phase === "needs_validation") return "Draft needs validation";
  if (state.phase === "invalid") return "Draft invalid";
  return "Draft saved";
}

function renderLifecycleNotice(state: ReturnType<typeof useWorkflowLifecycle>["state"]) {
  if (state.phase === "drafting") {
    return state.progressMessage ?? "Drafting planner resource...";
  }
  if (state.phase === "planner_draft" && state.draft?.draftId) {
    return `Draft ${state.draft.draftId} created`;
  }
  if (state.phase === "needs_validation" && state.draft?.draftId) {
    return `Draft ${state.draft.draftId} needs validation`;
  }
  if (state.phase === "validating") {
    return "Validating planner draft...";
  }
  if (state.phase === "validated" && state.draft?.draftId) {
    return `Ready to run: ${state.draft.draftId}`;
  }
  if (state.phase === "invalid" && state.draft?.draftId) {
    return `Draft ${state.draft.draftId} invalid`;
  }
  if (state.phase === "running") {
    return "Creating run from draft...";
  }
  if (state.phase === "run_created" && state.run?.runId && state.error) {
    return `Run ${state.run.runId} created, execute failed: ${state.error}`;
  }
  if (state.phase === "run_created" && state.run?.runId) {
    return `Run ${state.run.runId} created`;
  }
  if (state.phase === "executing" && state.run?.runId) {
    return `Run ${state.run.runId} executing`;
  }
  if (state.phase === "blocked" && state.error) {
    return `Blocked: ${state.error}`;
  }
  return "File draft only";
}
