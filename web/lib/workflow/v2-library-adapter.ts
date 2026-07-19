import type { GoalMissionReadModel, WorkflowCommandDescriptor, WorkflowDag } from "./types";

export type V2PlannerDraftTaskSummary = {
  taskId: string;
  taskName: string;
  dependsOn: string[];
  roleRef?: string;
  agentProfileRef?: string;
  agentRef?: string;
  harnessRef?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  requirementIds?: string[];
  sliceId?: string;
  purpose?: string;
  nodeType?: string;
  expectedOutputs?: string[];
};

export type V2PlannerDraftOrchestrationView = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
  status: string;
  validationIssues: Array<{ path: string; message: string; code?: string }>;
  taskSummaries: V2PlannerDraftTaskSummary[];
};

type V2Envelope<T> = {
  ok?: boolean;
  kind?: string;
  result?: T;
};

function profileResourcePathFromProfileRef(profileRef: string): string {
  const segment = profileRef
    .replace(/^profile\./, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-") || "agent";
  return `profiles/${segment}.yaml`;
}

function readinessFromDraftStatus(
  status: string,
  validationIssueCount: number,
): "ready" | "blocked" | "warning" {
  if (status !== "validated") return "blocked";
  if (validationIssueCount > 0) return "warning";
  return "ready";
}

export function unwrapV2Envelope<T>(payload: unknown): T {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "result" in payload &&
    (payload as V2Envelope<T>).result !== undefined
  ) {
    return (payload as V2Envelope<T>).result as T;
  }
  return payload as T;
}

function dependencyLevels(tasks: V2PlannerDraftTaskSummary[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();

  const levelFor = (taskId: string): number => {
    const cached = levels.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) return 0;
    const task = byId.get(taskId);
    if (!task) return 0;
    visiting.add(taskId);
    const knownDependencies = task.dependsOn.filter((dependency) => byId.has(dependency));
    const level = knownDependencies.length === 0
      ? 0
      : Math.max(...knownDependencies.map((dependency) => levelFor(dependency))) + 1;
    visiting.delete(taskId);
    levels.set(taskId, level);
    return level;
  };

  for (const task of tasks) levelFor(task.taskId);
  return levels;
}

export function buildWorkflowDagFromPlannerDraft(input: V2PlannerDraftOrchestrationView, runtime?: {
  runId?: string;
  runStatus?: "awaiting_approval" | "scheduling";
  mission?: GoalMissionReadModel;
  approvalCommand?: WorkflowCommandDescriptor;
}): WorkflowDag {
  const readiness = readinessFromDraftStatus(input.status, input.validationIssues.length);
  const levels = dependencyLevels(input.taskSummaries);
  const nodes = input.taskSummaries.map((task, index) => {
    return {
      id: task.taskId,
      taskId: task.taskId,
      draftId: input.draftId,
      ...(runtime?.runId ? { runId: runtime.runId } : {}),
      mode: runtime?.runId ? "runtime" as const : "draft" as const,
      label: task.taskName || task.taskId,
      ...(task.roleRef ? { role: task.roleRef } : {}),
      ...(task.agentRef ? { agentRef: task.agentRef } : {}),
      ...(task.agentProfileRef ? {
        profileRef: task.agentProfileRef,
        profileResourcePath: profileResourcePathFromProfileRef(task.agentProfileRef),
      } : {}),
      ...(task.harnessRef ? { harnessRef: task.harnessRef } : {}),
      ...(task.provider ? { provider: task.provider } : {}),
      ...(task.model ? { model: task.model } : {}),
      ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
      ...(task.requirementIds?.length ? { requirementIds: task.requirementIds } : {}),
      ...(task.sliceId ? { sliceId: task.sliceId } : {}),
      ...(task.purpose ? { purpose: task.purpose } : {}),
      ...(task.nodeType ? { nodeType: task.nodeType } : {}),
      ...(task.expectedOutputs?.length ? { expectedOutputs: task.expectedOutputs } : {}),
      level: levels.get(task.taskId) ?? index,
      state: readiness,
    };
  });

  const edges = input.taskSummaries.flatMap((task) => (
    task.dependsOn.map((dependency) => ({ from: dependency, to: task.taskId }))
  ));

  return {
    id: input.draftId,
    draftId: input.draftId,
    draftStatus: input.status,
    ...(runtime?.runId ? { runId: runtime.runId } : {}),
    ...(runtime?.runStatus ? { runStatus: runtime.runStatus } : {}),
    ...(runtime?.mission ? { mission: runtime.mission } : {}),
    ...(runtime?.approvalCommand ? { approvalCommand: runtime.approvalCommand } : {}),
    mode: runtime?.runId ? "runtime" : "draft",
    templateTitle: input.workflowId || "Planner Draft",
    prompt: input.goalPrompt,
    expandedByDefault: true,
    readiness,
    nodes,
    edges,
    createdAt: new Date().toISOString(),
  };
}
