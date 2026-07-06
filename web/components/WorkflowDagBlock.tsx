"use client";

import { useMemo, useState } from "react";
import { SouthstarWorkflowCanvas } from "./workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel, WorkflowDependencyModel, WorkflowTaskNodeModel } from "./workflow-canvas/types";
import { useWorkflowLifecycle } from "@/hooks/useWorkflowLifecycle";
import { buildWorkflowTemplateSaveRequest } from "@/lib/workflow/template-save";
import type { WorkflowDag, WorkflowDagNode } from "@/lib/workflow/types";

type SaveTemplateStatus =
  | { phase: "idle" }
  | { phase: "saving"; message: string }
  | { phase: "saved"; message: string }
  | { phase: "error"; message: string };

export function WorkflowDagBlock({
  dag,
  cwd,
  onNodeSelect,
}: {
  dag: WorkflowDag;
  cwd?: string | null;
  onNodeSelect?: (node: WorkflowDagNode) => void;
}) {
  const [expanded, setExpanded] = useState<boolean>(dag.expandedByDefault);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saveTemplateStatus, setSaveTemplateStatus] = useState<SaveTemplateStatus>({ phase: "idle" });
  const { state, createDraft, validateDraft, runDraft, executeRun } = useWorkflowLifecycle(dag, cwd);
  const busy = state.phase === "drafting" || state.phase === "validating" || state.phase === "running" || state.phase === "executing";
  const activeDraftId = state.draft?.draftId ?? dag.draftId;
  const activeRunId = state.run?.runId ?? dag.runId;
  const draftReady = Boolean(activeDraftId);
  const canValidateActiveDag = draftReady || Boolean(dag.compositionPlan);
  const canRunActiveDraft = state.canRun || Boolean(dag.draftId && (dag.draftStatus === "validated" || dag.readiness === "ready"));
  const saveTemplateBusy = saveTemplateStatus.phase === "saving";
  const validateDisabled = busy || !canValidateActiveDag;
  const runDisabled = busy || !draftReady || !canRunActiveDraft || Boolean(activeRunId);
  const executeDisabled = busy || !activeRunId;
  const nodeById = useMemo(() => new Map(dag.nodes.map((node) => [node.id, node])), [dag.nodes]);
  const canvas = useMemo(() => workflowDagToCanvasModel(dag, selectedNodeId), [dag, selectedNodeId]);

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

  async function saveTemplate() {
    const draftId = state.draft?.draftId ?? dag.draftId;
    if (!draftId) return;
    setSaveTemplateStatus({ phase: "saving", message: "Saving..." });
    try {
      const request = buildWorkflowTemplateSaveRequest({ draftId, dag });
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      if (!response.ok) throw new Error(await response.text());
      setSaveTemplateStatus({ phase: "saved", message: "Template saved" });
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
        </div>
      )}
    </div>
  );
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
    badges: [
      { label: node.provider, tone: node.provider === "pi" ? "good" : "neutral" },
      { label: node.model, tone: "neutral" },
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
