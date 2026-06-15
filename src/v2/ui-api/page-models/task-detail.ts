import type { SouthstarDb } from "../../stores/sqlite.ts";
import { getTaskEnvelope } from "../local-api.ts";
import { buildTaskDetailModel } from "../read-models.ts";
import { listHistoryForRun } from "../../stores/history-store.ts";
import { listResources } from "../../stores/resource-store.ts";

export function buildTaskDetailPageModel(db: SouthstarDb, input: { runId: string; taskId: string }) {
  const task = buildTaskDetailModel(db, input.runId, input.taskId);
  if (!task) throw new Error(`task not found: ${input.runId}/${input.taskId}`);
  const envelope = getTaskEnvelope(db, input);
  const artifacts = listResources(db, { resourceType: "artifact" }).filter((resource) => resource.runId === input.runId && resource.taskId === input.taskId);
  const evaluatorResults = [
    ...listResources(db, { resourceType: "evaluator_result" }),
    ...listResources(db, { resourceType: "evaluator_pipeline_result" }),
  ].filter((resource) => resource.runId === input.runId && resource.taskId === input.taskId);
  const worktreeSnapshots = listResources(db, { resourceType: "worktree_snapshot" }).filter((resource) => resource.runId === input.runId && resource.taskId === input.taskId);
  const worktreeRollbackPreviews = listResources(db, { resourceType: "worktree_rollback_preview" }).filter((resource) => resource.runId === input.runId && resource.taskId === input.taskId);
  const worktreeRollbacks = listResources(db, { resourceType: "worktree_rollback" }).filter((resource) => resource.runId === input.runId && resource.taskId === input.taskId);
  const trace = listResources(db, { resourceType: "memory_injection_trace" }).find((resource) => resource.runId === input.runId && resource.taskId === input.taskId);
  const tracePayload = trace?.payload as { included?: unknown[]; excluded?: unknown[]; decisionReason?: string } | undefined;
  return {
    surface: "southstar.ui.task-detail.v1" as const,
    task: { taskId: task.id, taskKey: task.taskKey, status: task.status, dependsOn: task.dependsOn },
    envelope,
    contextPacket: envelope.contextPacket,
    memoryTrace: {
      selected: envelope.contextPacket.selectedMemories ?? [],
      excluded: envelope.contextPacket.excludedCandidates ?? [],
      includedTrace: tracePayload?.included ?? [],
      excludedTrace: tracePayload?.excluded ?? [],
      decisionReason: tracePayload?.decisionReason ?? "Memory trace recorded by ContextPacket.",
    },
    artifacts,
    evaluator: {
      pipelineId: envelope.evaluatorPipeline?.id ?? "domain-default",
      results: evaluatorResults,
    },
    worktree: {
      snapshots: worktreeSnapshots,
      rollbackPreviews: worktreeRollbackPreviews,
      rollbacks: worktreeRollbacks,
    },
    logs: listHistoryForRun(db, input.runId).filter((event) => event.taskId === input.taskId),
    actions: [
      { label: "Retry Task", command: "retry-task" },
      { label: "Fork Session", command: "fork-session" },
      { label: "Rollback Workspace", command: "rollback-workspace" },
      { label: "Request Revision", command: "request-revision" },
    ],
  };
}
