import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";
import { buildWorkflowCanvasModel } from "../read-models.ts";

export type WorkflowTabPageModel = {
  surface: "southstar.ui.workflow-tab.v1";
  state: "new-goal" | "planning" | "draft-review" | "active-run";
  activeRunId?: string;
  draft?: {
    draftId: string;
    title: string;
    summary: { templateRefs: string[]; confidence: string; risk: string; releaseMode: string };
    dag: { nodes: Array<{ id: string; label: string; status: string }>; edges: Array<{ from: string; to: string }> };
    taskInspector?: { taskId: string; agentDefinitionRef: string; agentProfileRef: string; skillRefs: string[]; mcpGrantRefs: string[]; artifactContractRefs: string[]; rationale: string; readOnly: true };
    plannerRationale: string;
  };
};

export function buildWorkflowTabPageModel(db: SouthstarDb, input: { draftId?: string | null; runId?: string | null }): WorkflowTabPageModel {
  if (input.runId) {
    buildWorkflowCanvasModel(db, input.runId);
    return { surface: "southstar.ui.workflow-tab.v1", state: "active-run", activeRunId: input.runId, draft: undefined };
  }
  if (!input.draftId) return { surface: "southstar.ui.workflow-tab.v1", state: "new-goal" };
  const draft = listResources(db, { resourceType: "planner_draft" }).find((resource) => resource.resourceKey === input.draftId);
  if (!draft) return { surface: "southstar.ui.workflow-tab.v1", state: "new-goal" };
  const payload = draft.payload as { workflow?: { title?: string; tasks?: Array<{ id: string; name?: string; dependsOn?: string[]; agentProfileRef?: string; skillRefs?: string[]; mcpGrantRefs?: string[]; requiredArtifactRefs?: string[]; promptInputs?: { rationale?: string } }> } };
  const workflow = payload.workflow;
  const tasks = workflow?.tasks ?? [];
  const decision = listResources(db, { resourceType: "planner_decision_trace" }).at(-1);
  const decisionPayload = decision?.payload as { confidence?: string; risk?: string; releaseMode?: string; rationale?: { summary?: string } } | undefined;
  const templateTrace = listResources(db, { resourceType: "template_selection_trace" }).at(-1);
  const templateRefs = Array.isArray(templateTrace?.payload) ? (templateTrace!.payload as Array<{ ref?: string }>).map((item) => item.ref).filter((value): value is string => Boolean(value)) : [];
  const firstTask = tasks[0];
  return {
    surface: "southstar.ui.workflow-tab.v1",
    state: "draft-review",
    draft: {
      draftId: input.draftId,
      title: workflow?.title ?? draft.title ?? "Workflow Draft",
      summary: { templateRefs, confidence: decisionPayload?.confidence ?? "unknown", risk: decisionPayload?.risk ?? "unknown", releaseMode: decisionPayload?.releaseMode ?? "none" },
      dag: {
        nodes: tasks.map((task) => ({ id: task.id, label: task.name ?? task.id, status: "draft" })),
        edges: tasks.flatMap((task) => (task.dependsOn ?? []).map((from) => ({ from, to: task.id }))),
      },
      taskInspector: firstTask ? {
        taskId: firstTask.id,
        agentDefinitionRef: String(firstTask.promptInputs?.rationale?.match(/software\.[\w.-]+/)?.[0] ?? firstTask.agentProfileRef ?? firstTask.id),
        agentProfileRef: firstTask.agentProfileRef ?? "unknown",
        skillRefs: firstTask.skillRefs ?? [],
        mcpGrantRefs: firstTask.mcpGrantRefs ?? [],
        artifactContractRefs: firstTask.requiredArtifactRefs ?? [],
        rationale: String(firstTask.promptInputs?.rationale ?? `Selected ${firstTask.agentProfileRef ?? firstTask.id}`),
        readOnly: true,
      } : undefined,
      plannerRationale: decisionPayload?.rationale?.summary ?? "Planner rationale not recorded.",
    },
  };
}
