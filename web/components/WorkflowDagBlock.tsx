"use client";

import { useMemo, useState } from "react";
import { SouthstarWorkflowCanvas } from "./workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel, WorkflowDependencyModel, WorkflowTaskNodeModel } from "./workflow-canvas/types";
import { useWorkflowLifecycle } from "@/hooks/useWorkflowLifecycle";
import type { WorkflowDag, WorkflowDagNode } from "@/lib/workflow/types";

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
  const { state, createDraft, validateDraft, runDraft, retryExecute } = useWorkflowLifecycle(dag, cwd);
  const busy = state.phase === "drafting" || state.phase === "validating" || state.phase === "running" || state.phase === "executing";
  const draftReady = Boolean(state.draft?.draftId);
  const nodeById = useMemo(() => new Map(dag.nodes.map((node) => [node.id, node])), [dag.nodes]);
  const canvas = useMemo(() => workflowDagToCanvasModel(dag, selectedNodeId), [dag, selectedNodeId]);

  const handleDraft = () => {
    if (!window.confirm("Create a Southstar planner draft in Postgres for this DAG?")) {
      return;
    }
    void createDraft();
  };

  const handleValidate = () => {
    void validateDraft();
  };

  const handleRun = () => {
    if (!window.confirm("Validate this planner draft, create workflow run rows, and start execution?")) {
      return;
    }
    void runDraft();
  };

  const handleSelectTask = (taskId: string) => {
    setSelectedNodeId(taskId);
    const node = nodeById.get(taskId);
    if (node) onNodeSelect?.(node);
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
            {!dag.draftId && (
              <button
                type="button"
                data-testid="workflow-action-draft"
                onClick={handleDraft}
                disabled={busy}
                style={actionButtonStyle(busy)}
              >
                Draft
              </button>
            )}
            {dag.draftId && (
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
                Draft saved
              </span>
            )}
            <button
              type="button"
              data-testid="workflow-action-validate"
              onClick={handleValidate}
              disabled={busy || !draftReady}
              style={actionButtonStyle(busy || !draftReady)}
            >
              Validate
            </button>
            <button
              type="button"
              data-testid="workflow-action-run"
              onClick={handleRun}
              disabled={busy || !draftReady || !state.canRun}
              style={actionButtonStyle(busy || !draftReady || !state.canRun)}
            >
              Run
            </button>
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
            {state.phase === "run_created" && state.error && state.run?.runId && (
              <button
                type="button"
                data-testid="workflow-execute-retry"
                onClick={() => {
                  void retryExecute();
                }}
                disabled={busy}
                style={actionButtonStyle(busy)}
              >
                Retry Execute
              </button>
            )}
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

function renderLifecycleNotice(state: ReturnType<typeof useWorkflowLifecycle>["state"]) {
  if (state.phase === "drafting") {
    return "Drafting planner resource...";
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
    return `Draft ${state.draft.draftId} validated`;
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
