import { buildWorkflowDagFromPlannerDraft, type V2PlannerDraftOrchestrationView } from "./v2-library-adapter";
import { buildWorkflowV2Url } from "./v2-api";
import type { GoalMissionReadModel, WorkflowCommandDescriptor, WorkflowDag } from "./types";

export type WorkflowUiTransportReadModel = {
  mission: GoalMissionReadModel | null;
  commands: WorkflowCommandDescriptor[];
};

export function unwrapV2Payload<T>(payload: unknown): T {
  if (typeof payload === "object" && payload !== null && "result" in payload) {
    const result = (payload as { result?: unknown }).result;
    if (result !== undefined) return result as T;
  }
  return payload as T;
}

export async function readWorkflowV2Json<T>(pathname: string): Promise<T> {
  const response = await fetch(buildWorkflowV2Url(pathname), { headers: { accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `workflow read model request failed: HTTP ${response.status}`);
  return unwrapV2Payload<T>(JSON.parse(text));
}

export async function readWorkflowUiReadModel(response: Response): Promise<WorkflowUiTransportReadModel> {
  const text = await response.text();
  if (!response.ok) throw new Error(text || `workflow read model request failed: HTTP ${response.status}`);
  return unwrapV2Payload<WorkflowUiTransportReadModel>(JSON.parse(text));
}

export function projectWorkflowUiReadModel(input: {
  orchestration: V2PlannerDraftOrchestrationView;
  workflowUi: WorkflowUiTransportReadModel;
  runId?: string;
  runStatus?: "awaiting_approval" | "scheduling";
}): {
  mission: GoalMissionReadModel | null;
  approvalCommand?: WorkflowCommandDescriptor;
  dag: WorkflowDag;
} {
  const approvalCommand = input.workflowUi.commands.find((command) => command.id === "approval.approve");
  return {
    mission: input.workflowUi.mission,
    ...(approvalCommand ? { approvalCommand } : {}),
    dag: buildWorkflowDagFromPlannerDraft(input.orchestration, {
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.runStatus ? { runStatus: input.runStatus } : {}),
      ...(input.workflowUi.mission ? { mission: input.workflowUi.mission } : {}),
      ...(approvalCommand ? { approvalCommand } : {}),
    }),
  };
}
