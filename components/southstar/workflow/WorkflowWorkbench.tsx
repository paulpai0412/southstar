"use client";

import { useEffect, useMemo, useState } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { SouthstarWorkflowCanvas } from "../workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel, WorkflowTaskBadge, WorkflowTaskNodeModel } from "../workflow-canvas/types";
import { AgentLibraryPanel } from "./AgentLibraryPanel";
import { DefinitionInspector } from "./DefinitionInspector";
import { LibraryAlternativesSheet } from "./LibraryAlternativesSheet";

const defaultGoal = "在 todo-web repo 新增 priority labels 與 overdue filter，並做 browser QA 與 spec alignment";

type PlannerInputState = {
  goalPrompt: string;
  domainPack: string;
  cwdHint: string;
  orchestrationMode: "deterministic" | "llm-constrained";
  composerMode: "llm" | "fixture" | "llm-with-fixture-fallback";
  libraryHints: string;
};

type ValidationIssue = {
  path: string;
  message: string;
  code?: string;
};

export function WorkflowWorkbench(props: {
  api: SouthstarApiClient;
  activeCwd: string | null;
  initialDraftId?: string;
  initialRunId?: string;
  onOpenOperator: (runId?: string) => void;
}) {
  const [plannerInput, setPlannerInput] = useState<PlannerInputState>(() => ({
    goalPrompt: defaultGoal,
    domainPack: "software",
    cwdHint: props.activeCwd ?? "",
    orchestrationMode: "llm-constrained",
    composerMode: "llm",
    libraryHints: "",
  }));
  const [draftId, setDraftId] = useState<string | undefined>();
  const [runId, setRunId] = useState<string | undefined>();
  const [workflowModel, setWorkflowModel] = useState<any | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const [alternativesModel, setAlternativesModel] = useState<any | null>(null);

  useEffect(() => {
    setDraftId(props.initialDraftId);
    setRunId(props.initialRunId);
    if (props.initialDraftId || props.initialRunId) {
      void refreshModel(props.initialDraftId, props.initialRunId);
    }
  }, [props.initialDraftId, props.initialRunId]);

  useEffect(() => {
    if (!props.activeCwd) return;
    setPlannerInput((current) => (current.cwdHint.length > 0 ? current : { ...current, cwdHint: props.activeCwd ?? "" }));
  }, [props.activeCwd]);

  async function refreshModel(nextDraftId = draftId, nextRunId = runId) {
    try {
      const next = await props.api.getUiWorkflowTab({ draftId: nextDraftId, runId: nextRunId });
      setWorkflowModel(next);
      setSelectedTaskId((current) => current
        ?? next?.canvasModel?.selectedNodeId
        ?? next?.selectedDefinition?.taskId
        ?? next?.draft?.taskInspector?.taskId
        ?? null);
      const domain = stringValue(next?.agentLibrarySummary?.domain);
      if (domain) {
        setPlannerInput((current) => ({ ...current, domainPack: domain }));
      }
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function planWorkflow() {
    setPlanning(true);
    setError(null);
    try {
      const draft = await createDraftWithPlannerInput(props.api, plannerInput);
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
      props.onOpenOperator(run.runId);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function reviseWorkflow(prompt: string) {
    if (!draftId || prompt.trim().length === 0) return;
    setRevising(true);
    setError(null);
    try {
      const draft = await props.api.reviseDraft(draftId, buildRevisionPrompt(prompt, plannerInput));
      setDraftId(draft.draftId);
      setRunId(undefined);
      await refreshModel(draft.draftId, undefined);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRevising(false);
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

  const canvasModel = useMemo(() => toCanvasModel(workflowModel), [workflowModel]);
  const selectedTask = useMemo(
    () => canvasModel.nodes.find((node) => node.id === selectedTaskId) ?? null,
    [canvasModel.nodes, selectedTaskId],
  );
  const inspectorModel = workflowModel?.selectedDefinition ?? workflowModel?.draft?.taskInspector ?? null;
  const validationIssues = useMemo<ValidationIssue[]>(
    () => normalizeValidationIssues(workflowModel?.validationIssues ?? workflowModel?.draft?.validationIssues),
    [workflowModel],
  );
  const repairAttempts = numberValue(workflowModel?.repairAttempts ?? workflowModel?.draft?.repairAttempts) ?? 0;
  const plannerTrace = useMemo<Record<string, unknown> | null>(
    () => asRecord(workflowModel?.plannerTrace) ?? asRecord(workflowModel?.draft?.plannerTrace),
    [workflowModel],
  );

  return (
    <>
      <section className="ss-workflow-workbench">
        <AgentLibraryPanel
          model={workflowModel}
          activeCwd={props.activeCwd}
          selectedTaskId={selectedTaskId}
          onOpenAlternatives={openAlternatives}
          alternativesDisabled={!draftId}
        />
        <section className="ss-workflow-center">
          <section className="ss-guided-chat">
            <header>
              <h1>Guided workflow chat</h1>
              <p>Southstar planner confirms workflow, agents, profiles, and tools before runtime submission.</p>
            </header>
            <label htmlFor="workflow-goal">Workflow goal</label>
            <textarea
              id="workflow-goal"
              value={plannerInput.goalPrompt}
              onChange={(event) => setPlannerInput((current) => ({ ...current, goalPrompt: event.currentTarget.value }))}
            />
            <label htmlFor="workflow-domain-pack">Domain pack</label>
            <input
              id="workflow-domain-pack"
              value={plannerInput.domainPack}
              onChange={(event) => setPlannerInput((current) => ({ ...current, domainPack: event.currentTarget.value }))}
            />
            <label htmlFor="workflow-cwd-hint">Workspace cwd hint</label>
            <input
              id="workflow-cwd-hint"
              value={plannerInput.cwdHint}
              onChange={(event) => setPlannerInput((current) => ({ ...current, cwdHint: event.currentTarget.value }))}
            />
            <label htmlFor="workflow-orchestration-mode">Orchestration mode</label>
            <select
              id="workflow-orchestration-mode"
              value={plannerInput.orchestrationMode}
              onChange={(event) => setPlannerInput((current) => ({
                ...current,
                orchestrationMode: event.currentTarget.value as PlannerInputState["orchestrationMode"],
              }))}
            >
              <option value="llm-constrained">llm-constrained</option>
              <option value="deterministic">deterministic</option>
            </select>
            <label htmlFor="workflow-composer-mode">Composer mode</label>
            <select
              id="workflow-composer-mode"
              value={plannerInput.composerMode}
              onChange={(event) => setPlannerInput((current) => ({
                ...current,
                composerMode: event.currentTarget.value as PlannerInputState["composerMode"],
              }))}
            >
              <option value="llm">llm</option>
              <option value="llm-with-fixture-fallback">llm-with-fixture-fallback</option>
              <option value="fixture">fixture</option>
            </select>
            <label htmlFor="workflow-library-hints">Library hints</label>
            <textarea
              id="workflow-library-hints"
              value={plannerInput.libraryHints}
              onChange={(event) => setPlannerInput((current) => ({ ...current, libraryHints: event.currentTarget.value }))}
            />
            <button type="button" onClick={planWorkflow} disabled={planning || plannerInput.goalPrompt.trim().length === 0}>
              {planning ? "Planning…" : "Plan workflow"}
            </button>
          </section>
          <section className="ss-workflow-dag">
            <header>
              <h2>Workflow DAG</h2>
              <p>ELK layered layout with React Flow controls.</p>
            </header>
            <SouthstarWorkflowCanvas
              canvas={canvasModel}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
            />
          </section>
        </section>
        <DefinitionInspector
          task={selectedTask}
          inspector={inspectorModel}
          plannerRationale={stringValue(workflowModel?.plannerRationale) ?? stringValue(workflowModel?.draft?.plannerRationale) ?? null}
          validationIssues={validationIssues}
          repairAttempts={repairAttempts}
          plannerTraceRefs={plannerTrace}
          onRunDraft={runWorkflow}
          onReviseDraft={reviseWorkflow}
          runDisabled={!draftId}
          running={running}
          reviseDisabled={!draftId}
          revising={revising}
        />
      </section>
      {alternativesOpen ? <LibraryAlternativesSheet model={alternativesModel} onClose={() => setAlternativesOpen(false)} /> : null}
      {error ? <p className="ss-error">{error}</p> : null}
    </>
  );
}

function toCanvasModel(model: any | null): WorkflowCanvasModel {
  const canvasModel = asRecord(model?.canvasModel);
  const dag = model?.draft?.dag ?? {};
  const rawNodes = Array.isArray(canvasModel?.nodes)
    ? canvasModel.nodes
    : Array.isArray(dag.nodes)
      ? dag.nodes
      : [];
  const rawEdges = Array.isArray(canvasModel?.edges)
    ? canvasModel.edges
    : Array.isArray(dag.edges)
      ? dag.edges
      : [];

  const nodes: WorkflowTaskNodeModel[] = rawNodes.map((node: any) => {
    const badges: WorkflowTaskBadge[] = Array.isArray(node.badges)
      ? node.badges.map((badge: any) => (typeof badge === "string"
        ? { label: badge, tone: "neutral" as const }
        : {
            label: String(badge?.label ?? "badge"),
            tone: normalizeBadgeTone(badge?.tone),
          }))
      : [];

    return {
      id: String(node.id ?? ""),
      label: String(node.label ?? node.taskName ?? node.id ?? "task"),
      status: String(node.status ?? "pending"),
      dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn.map(String) : [],
      roleRef: node.roleRef ?? node.role ?? node.agentDefinitionRef ?? null,
      agentProfileRef: node.agentProfileRef ?? node.profileRef ?? null,
      artifactKind: node.artifactKind ?? node.artifact?.kind ?? null,
      badges,
      attention: node.attention ?? (node.needsAttention ? "operator review" : null),
    };
  });

  const edges = rawEdges.map((edge: any, index: number) => ({
    id: String(edge.id ?? `${edge.from ?? edge.source}-${edge.to ?? edge.target}-${index}`),
    from: String(edge.from ?? edge.source ?? ""),
    to: String(edge.to ?? edge.target ?? ""),
    status: String(edge.status ?? "pending"),
  }));

  return { nodes, edges };
}

function normalizeBadgeTone(tone: unknown): WorkflowTaskBadge["tone"] {
  if (tone === "good" || tone === "warn" || tone === "danger" || tone === "neutral") return tone;
  return "neutral";
}

async function createDraftWithPlannerInput(api: SouthstarApiClient, input: PlannerInputState): Promise<{ draftId: string }> {
  const payload = {
    goalPrompt: input.goalPrompt,
    orchestrationMode: input.orchestrationMode,
    composerMode: input.composerMode,
    plannerHints: {
      domainPack: input.domainPack,
      cwdHint: input.cwdHint,
      libraryHints: listFromMultiline(input.libraryHints),
    },
  };
  try {
    return await api.command("/api/v2/planner/drafts", payload);
  } catch {
    return await api.createDraft(buildPlannerPrompt(input));
  }
}

function buildPlannerPrompt(input: PlannerInputState): string {
  const lines = [
    input.goalPrompt.trim(),
    `domainPack=${input.domainPack || "software"}`,
    `cwdHint=${input.cwdHint || "not-provided"}`,
    `orchestrationMode=${input.orchestrationMode}`,
    `composerMode=${input.composerMode}`,
  ];
  const hints = listFromMultiline(input.libraryHints);
  if (hints.length > 0) lines.push(`libraryHints=${hints.join(", ")}`);
  return lines.join("\n");
}

function buildRevisionPrompt(prompt: string, input: PlannerInputState): string {
  return `${prompt.trim()}\n\nplanner_context:\n${buildPlannerPrompt(input)}`;
}

function listFromMultiline(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeValidationIssues(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: ValidationIssue[] = [];
  for (const candidate of value) {
    const issue = asRecord(candidate);
    const path = stringValue(issue?.path);
    const message = stringValue(issue?.message);
    if (!path || !message) continue;
    issues.push({
      path,
      message,
      ...(stringValue(issue?.code) ? { code: stringValue(issue?.code) } : {}),
    });
  }
  return issues;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return null;
}
