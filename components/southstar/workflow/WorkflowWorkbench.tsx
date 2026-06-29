"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { CreatePlannerDraftRequest, SouthstarApiClient } from "@/lib/southstar/api-client";
import { SouthstarWorkflowCanvas } from "../workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel, WorkflowTaskAttention, WorkflowTaskBadge, WorkflowTaskNodeModel } from "../workflow-canvas/types";
import { AgentLibraryPanel } from "./AgentLibraryPanel";
import { DefinitionInspector } from "./DefinitionInspector";
import { LibraryAlternativesSheet } from "./LibraryAlternativesSheet";

const defaultGoal = "在 todo-web repo 新增 priority labels 與 overdue filter，並做 browser QA 與 spec alignment";

type PlannerInputState = {
  goalPrompt: string;
  domainPackId: string;
  cwd: string;
  orchestrationMode: "deterministic" | "llm-constrained";
  composerMode: "llm" | "fixture" | "llm-with-fixture-fallback";
  roleRefs: string;
  agentProfileRefs: string;
  skillRefs: string;
  mcpGrantRefs: string;
  toolRefs: string;
  modelHints: string;
  vaultLeasePolicyRefs: string;
  toolPolicyHints: string;
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
  initialWorkflowModel?: any;
  onOpenOperator: (runId?: string) => void;
}) {
  const [plannerInput, setPlannerInput] = useState<PlannerInputState>(() => ({
    goalPrompt: defaultGoal,
    domainPackId: "software",
    cwd: props.activeCwd ?? "",
    orchestrationMode: "llm-constrained",
    composerMode: "llm",
    roleRefs: "",
    agentProfileRefs: "",
    skillRefs: "",
    mcpGrantRefs: "",
    toolRefs: "",
    modelHints: "",
    vaultLeasePolicyRefs: "",
    toolPolicyHints: "",
  }));
  const [draftId, setDraftId] = useState<string | undefined>(() => props.initialDraftId);
  const [runId, setRunId] = useState<string | undefined>(() => props.initialRunId);
  const [workflowModel, setWorkflowModel] = useState<any | null>(() => props.initialWorkflowModel ?? null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => selectedTaskIdFromModel(props.initialWorkflowModel));
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const [alternativesModel, setAlternativesModel] = useState<any | null>(null);

  useEffect(() => {
    setDraftId(props.initialDraftId);
    setRunId(props.initialRunId);
    if (props.initialWorkflowModel) {
      setWorkflowModel(props.initialWorkflowModel);
      setSelectedTaskId((current) => current ?? selectedTaskIdFromModel(props.initialWorkflowModel));
      return;
    }
    if (props.initialDraftId || props.initialRunId) {
      void refreshModel(props.initialDraftId, props.initialRunId);
    }
  }, [props.initialDraftId, props.initialRunId, props.initialWorkflowModel]);

  useEffect(() => {
    if (!props.activeCwd) return;
    setPlannerInput((current) => (current.cwd.length > 0 ? current : { ...current, cwd: props.activeCwd ?? "" }));
  }, [props.activeCwd]);

  async function refreshModel(nextDraftId = draftId, nextRunId = runId) {
    try {
      const next = await loadWorkflowWorkbenchModel(props.api, { draftId: nextDraftId, runId: nextRunId });
      setWorkflowModel(next);
      setSelectedTaskId((current) => current ?? selectedTaskIdFromModel(next));
      const domain = stringValue(next?.agentLibrary?.domain) ?? stringValue(next?.agentLibrarySummary?.domain);
      if (domain) {
        setPlannerInput((current) => ({ ...current, domainPackId: domain }));
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
        <section className="ss-workflow-planner-panel">
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
            <label htmlFor="workflow-domain-pack-id">Domain pack ID</label>
            <input
              id="workflow-domain-pack-id"
              value={plannerInput.domainPackId}
              onChange={(event) => setPlannerInput((current) => ({ ...current, domainPackId: event.currentTarget.value }))}
            />
            <label htmlFor="workflow-cwd">Workspace cwd</label>
            <input
              id="workflow-cwd"
              value={plannerInput.cwd}
              onChange={(event) => setPlannerInput((current) => ({ ...current, cwd: event.currentTarget.value }))}
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
            <details className="ss-planner-advanced-hints">
              <summary>Advanced structured hints</summary>
              <label htmlFor="workflow-role-refs">Role refs</label>
              <textarea
                id="workflow-role-refs"
                value={plannerInput.roleRefs}
                onChange={(event) => setPlannerInput((current) => ({ ...current, roleRefs: event.currentTarget.value }))}
              />
              <label htmlFor="workflow-agent-profile-refs">Agent profile refs</label>
              <textarea
                id="workflow-agent-profile-refs"
                value={plannerInput.agentProfileRefs}
                onChange={(event) => setPlannerInput((current) => ({ ...current, agentProfileRefs: event.currentTarget.value }))}
              />
              <label htmlFor="workflow-skill-refs">Skill refs</label>
              <textarea
                id="workflow-skill-refs"
                value={plannerInput.skillRefs}
                onChange={(event) => setPlannerInput((current) => ({ ...current, skillRefs: event.currentTarget.value }))}
              />
              <label htmlFor="workflow-mcp-grant-refs">MCP grant refs</label>
              <textarea
                id="workflow-mcp-grant-refs"
                value={plannerInput.mcpGrantRefs}
                onChange={(event) => setPlannerInput((current) => ({ ...current, mcpGrantRefs: event.currentTarget.value }))}
              />
              <label htmlFor="workflow-tool-refs">Tool refs</label>
              <textarea
                id="workflow-tool-refs"
                value={plannerInput.toolRefs}
                onChange={(event) => setPlannerInput((current) => ({ ...current, toolRefs: event.currentTarget.value }))}
              />
              <label htmlFor="workflow-model-hints">Model hints</label>
              <textarea
                id="workflow-model-hints"
                value={plannerInput.modelHints}
                onChange={(event) => setPlannerInput((current) => ({ ...current, modelHints: event.currentTarget.value }))}
              />
              <label htmlFor="workflow-vault-lease-policy-refs">Vault lease policy refs</label>
              <textarea
                id="workflow-vault-lease-policy-refs"
                value={plannerInput.vaultLeasePolicyRefs}
                onChange={(event) => setPlannerInput((current) => ({ ...current, vaultLeasePolicyRefs: event.currentTarget.value }))}
              />
              <label htmlFor="workflow-tool-policy-hints">Tool policy hints</label>
              <textarea
                id="workflow-tool-policy-hints"
                value={plannerInput.toolPolicyHints}
                onChange={(event) => setPlannerInput((current) => ({ ...current, toolPolicyHints: event.currentTarget.value }))}
              />
            </details>
            <button type="button" onClick={planWorkflow} disabled={planning || plannerInput.goalPrompt.trim().length === 0}>
              {planning ? "Planning…" : "Plan workflow"}
            </button>
          </section>
          <AgentLibraryPanel
            model={workflowModel}
            activeCwd={props.activeCwd}
            selectedTaskId={selectedTaskId}
            onOpenAlternatives={openAlternatives}
            alternativesDisabled={!draftId}
          />
        </section>
        <section className="ss-workflow-center">
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
          repairAttemptDetails={Array.isArray(workflowModel?.repairAttemptDetails) ? workflowModel.repairAttemptDetails : []}
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

export async function loadWorkflowWorkbenchModel(
  api: SouthstarApiClient,
  params: { draftId?: string; runId?: string },
): Promise<any> {
  const workflowModel = await api.getUiWorkflowTab({ draftId: params.draftId, runId: params.runId });
  if (asRecord(workflowModel?.agentLibrary)) return workflowModel;
  const domain = stringValue(workflowModel?.agentLibrarySummary?.domain);
  if (!domain) return workflowModel;
  try {
    const agentLibrary = await api.getAgentLibrary({ domain });
    return { ...workflowModel, agentLibrary };
  } catch (caught) {
    return { ...workflowModel, agentLibraryError: (caught as Error).message };
  }
}

function selectedTaskIdFromModel(model: any | null | undefined): string | null {
  return stringValue(model?.canvasModel?.selectedNodeId)
    ?? stringValue(model?.selectedDefinition?.taskId)
    ?? stringValue(model?.draft?.taskInspector?.taskId)
    ?? null;
}

export function toCanvasModel(model: any | null): WorkflowCanvasModel {
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
      kind: "task",
      status: String(node.status ?? "pending"),
      dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn.map(String) : [],
      roleRef: node.roleRef ?? node.role ?? node.agentDefinitionRef ?? null,
      agentProfileRef: node.agentProfileRef ?? node.profileRef ?? null,
      artifactKind: node.artifactKind ?? node.artifact?.kind ?? null,
      badges,
      attention: normalizeAttention(node.attention, node.needsAttention),
    };
  });

  const edges = rawEdges.map((edge: any, index: number) => ({
    id: String(edge.id ?? `${edge.from ?? edge.source}-${edge.to ?? edge.target}-${index}`),
    source: String(edge.source ?? edge.from ?? ""),
    target: String(edge.target ?? edge.to ?? ""),
    status: normalizeEdgeStatus(edge.status),
  }));

  return {
    graphId: stringValue(canvasModel?.graphId) ?? stringValue(model?.activeDraft?.draftId) ?? stringValue(model?.draft?.draftId) ?? "workflow",
    mode: canvasModel?.mode === "runtime" ? "runtime" : "draft",
    selectedNodeId: stringValue(canvasModel?.selectedNodeId) ?? null,
    nodes,
    edges,
  };
}

function normalizeBadgeTone(tone: unknown): WorkflowTaskBadge["tone"] {
  if (tone === "good" || tone === "warn" || tone === "danger" || tone === "neutral") return tone;
  return "neutral";
}

function normalizeAttention(value: unknown, needsAttention: unknown): WorkflowTaskAttention | null {
  const record = asRecord(value) ?? {};
  const severity = normalizeAttentionSeverity(record.severity);
  const reason = stringValue(record.reason);
  if (severity && reason) return { severity, reason };
  if (typeof value === "string" && value.length > 0) return { severity: "warning", reason: value };
  return needsAttention ? { severity: "warning", reason: "operator review" } : null;
}

function normalizeAttentionSeverity(value: unknown): WorkflowTaskAttention["severity"] | null {
  if (value === "info" || value === "warning" || value === "error" || value === "blocked") return value;
  return null;
}

function normalizeEdgeStatus(value: unknown): WorkflowCanvasModel["edges"][number]["status"] {
  if (value === "ready" || value === "active" || value === "blocked" || value === "satisfied") return value;
  return "pending";
}

async function createDraftWithPlannerInput(api: SouthstarApiClient, input: PlannerInputState): Promise<{ draftId: string }> {
  return await api.createDraft(buildPlannerDraftRequest(input));
}

function buildPlannerDraftRequest(input: PlannerInputState): CreatePlannerDraftRequest {
  return {
    goalPrompt: input.goalPrompt.trim(),
    orchestrationMode: input.orchestrationMode,
    composerMode: input.composerMode,
    domainPackId: input.domainPackId.trim() || "software",
    ...(input.cwd.trim().length > 0 ? { cwd: input.cwd.trim() } : {}),
    libraryHints: {
      roleRefs: listFromMultiline(input.roleRefs),
      agentProfileRefs: listFromMultiline(input.agentProfileRefs),
      skillRefs: listFromMultiline(input.skillRefs),
      mcpGrantRefs: listFromMultiline(input.mcpGrantRefs),
      toolRefs: listFromMultiline(input.toolRefs),
      modelHints: recordFromKeyValueLines(input.modelHints),
      vaultLeasePolicyRefs: listFromMultiline(input.vaultLeasePolicyRefs),
      toolPolicyHints: toolPolicyHintsFromLines(input.toolPolicyHints),
    },
  };
}

function buildRevisionPrompt(prompt: string, input: PlannerInputState): string {
  return `${prompt.trim()}\n\nplanner_context:\n${JSON.stringify(buildPlannerDraftRequest(input), null, 2)}`;
}

function listFromMultiline(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function recordFromKeyValueLines(value: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of listFromMultiline(value)) {
    const match = entry.match(/^([^:=]+)[:=](.+)$/);
    if (!match) continue;
    record[match[1]!.trim()] = match[2]!.trim();
  }
  return record;
}

function toolPolicyHintsFromLines(value: string): NonNullable<CreatePlannerDraftRequest["libraryHints"]>["toolPolicyHints"] {
  const record = recordFromKeyValueLines(value);
  return {
    allowedTools: commaList(record.allowedTools),
    deniedTools: commaList(record.deniedTools),
    requiresApprovalFor: commaList(record.requiresApprovalFor),
  };
}

function commaList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
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
