"use client";

import { useMemo, useState } from "react";
import { useWorkflowLifecycle } from "@/hooks/useWorkflowLifecycle";
import { layoutWorkflowDag } from "@/lib/workflow/dag-layout";
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
  const { state, createDraft, validateDraft, runDraft, retryExecute } = useWorkflowLifecycle(dag, cwd);
  const layout = useMemo(() => layoutWorkflowDag(dag), [dag]);
  const markerId = useMemo(() => `workflow-dag-arrow-head-${dag.id}`, [dag.id]);
  const busy = state.phase === "drafting" || state.phase === "validating" || state.phase === "running" || state.phase === "executing";

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
        <div style={{ padding: 10, background: "var(--bg)", overflowX: "auto" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 10,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              data-testid="workflow-action-draft"
              onClick={handleDraft}
              disabled={busy}
              style={actionButtonStyle(busy)}
            >
              Draft
            </button>
            <button
              type="button"
              data-testid="workflow-action-validate"
              onClick={handleValidate}
              disabled={busy || !state.draft?.draftId}
              style={actionButtonStyle(busy || !state.draft?.draftId)}
            >
              Validate
            </button>
            <button
              type="button"
              data-testid="workflow-action-run"
              onClick={handleRun}
              disabled={busy || !state.draft?.draftId || !state.canRun}
              style={actionButtonStyle(busy || !state.draft?.draftId || !state.canRun)}
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
            style={{
              position: "relative",
              minWidth: Math.max(520, layout.width),
              minHeight: layout.height,
            }}
          >
            <svg
              width={layout.width}
              height={layout.height}
              style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" }}
              aria-hidden
            >
              <defs>
                <marker id={markerId} viewBox="0 0 8 8" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--accent)" />
                </marker>
              </defs>
              {layout.arrows.map((arrow) => (
                <path
                  key={`${arrow.from}-${arrow.to}`}
                  data-testid="workflow-dag-arrow"
                  d={arrow.path}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.5}
                  opacity={0.8}
                  markerEnd={`url(#${markerId})`}
                />
              ))}
            </svg>
            {layout.columns.flatMap((column) =>
              column.nodes.map((layoutNode) => (
                <WorkflowDagNodeCard
                  key={layoutNode.node.id}
                  node={layoutNode.node}
                  x={layoutNode.x}
                  y={layoutNode.y}
                  width={layoutNode.width}
                  height={layoutNode.height}
                  onNodeSelect={onNodeSelect}
                />
              )),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowDagNodeCard({
  node,
  x,
  y,
  width,
  height,
  onNodeSelect,
}: {
  node: WorkflowDagNode;
  x: number;
  y: number;
  width: number;
  height: number;
  onNodeSelect?: (node: WorkflowDagNode) => void;
}) {
  return (
    <button
      data-testid={`workflow-dag-node-${node.id}`}
      onClick={() => onNodeSelect?.(node)}
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        minHeight: height,
        border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
        borderRadius: 7,
        background: "color-mix(in srgb, var(--accent) 4%, var(--bg))",
        color: "var(--text)",
        padding: 9,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {node.label}
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {node.agentRef}
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 8 }}>
        {node.provider} / {node.model}
      </div>
    </button>
  );
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
  if (state.phase === "validating") {
    return "Validating planner draft...";
  }
  if (state.phase === "validated" && state.draft?.draftId) {
    return `Draft ${state.draft.draftId} validated`;
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
