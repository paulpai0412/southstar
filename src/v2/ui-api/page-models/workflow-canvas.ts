import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listHistoryForRun } from "../../stores/history-store.ts";
import { listResources } from "../../stores/resource-store.ts";
import { getRunRow, parseWorkflow, summarizePayload } from "./internal.ts";

export type WorkflowCanvasPageModel = {
  surface: "southstar.ui.workflow-canvas.v1";
  runId: string;
  status: string;
  nodes: Array<{ taskId: string; label: string; status: string; role: string; agent: string; model: string; contextPacketId?: string; memoryInjected: number }>;
  edges: Array<{ id: string; source: string; target: string; kind: "dependency" | "context-packet" | "repair-revision" | "evaluator-gate" }>;
  selectedNode?: { taskId: string; actions: Array<{ label: string; command: "retry-task" | "fork-session" | "rollback-workspace" | "request-revision" }> };
  revisionTimeline: Array<{ id: string; label?: string | null; status: string }>;
  rootSessionDecisions: Array<{ eventType: string; taskId?: string; summary: string }>;
};

export function buildWorkflowCanvasPageModel(db: SouthstarDb, input: { runId: string; selectedTaskId?: string | null }): WorkflowCanvasPageModel {
  const run = getRunRow(db, input.runId);
  const workflow = parseWorkflow(run);
  const taskRows = db.prepare("select id, status from workflow_tasks where run_id = ?").all(input.runId) as Array<{ id: string; status: string }>;
  const statusByTask = new Map(taskRows.map((row) => [row.id, row.status]));
  const contextPackets = listResources(db, { resourceType: "context_packet" }).filter((resource) => resource.runId === input.runId);
  const evaluatorResources = listResources(db, { resourceType: "evaluator_pipeline_result" }).filter((resource) => resource.runId === input.runId);
  const recoveryResources = listResources(db, { resourceType: "recovery_decision" }).filter((resource) => resource.runId === input.runId);
  const sessionOperations = listResources(db, { resourceType: "session_operation" }).filter((resource) => resource.runId === input.runId);
  const nodes = workflow.tasks.map((task) => {
    const packet = contextPackets.find((resource) => resource.taskId === task.id);
    const packetPayload = packet?.payload as { selectedMemories?: unknown[] } | undefined;
    return {
      taskId: task.id,
      label: task.name,
      status: statusByTask.get(task.id) ?? "pending",
      role: task.roleRef ?? "unknown-role",
      agent: task.agentProfileRef ?? "unknown-agent",
      model: task.model ?? "domain-default",
      contextPacketId: packet?.id,
      memoryInjected: packetPayload?.selectedMemories?.length ?? 0,
    };
  });
  const dependencyEdges = workflow.tasks.flatMap((task) => (task.dependsOn ?? []).map((source) => ({ id: `${source}-${task.id}`, source, target: task.id, kind: "dependency" as const })));
  const contextEdges = contextPackets.map((packet) => ({ id: `context-${packet.id}`, source: packet.taskId ?? "workflow", target: packet.taskId ?? "workflow", kind: "context-packet" as const }));
  const evaluatorEdges = evaluatorResources.filter((resource) => resource.taskId).map((resource) => ({ id: `eval-${resource.id}`, source: resource.taskId!, target: resource.taskId!, kind: "evaluator-gate" as const }));
  const recoveryEdges = recoveryResources.filter((resource) => resource.taskId).map((resource) => ({ id: `recovery-${resource.id}`, source: resource.taskId!, target: resource.taskId!, kind: "repair-revision" as const }));
  const operationEdges = sessionOperations.filter((resource) => resource.taskId).map((resource) => ({ id: `operation-${resource.id}`, source: resource.taskId!, target: resource.taskId!, kind: "repair-revision" as const }));
  const selectedTaskId = input.selectedTaskId ?? nodes[0]?.taskId;
  const events = listHistoryForRun(db, input.runId);
  return {
    surface: "southstar.ui.workflow-canvas.v1",
    runId: input.runId,
    status: run.status,
    nodes,
    edges: [...dependencyEdges, ...contextEdges, ...evaluatorEdges, ...recoveryEdges, ...operationEdges],
    selectedNode: selectedTaskId ? {
      taskId: selectedTaskId,
      actions: [
        { label: "Retry Task", command: "retry-task" },
        { label: "Fork Session", command: "fork-session" },
        { label: "Rollback Workspace", command: "rollback-workspace" },
        { label: "Request Revision", command: "request-revision" },
      ],
    } : undefined,
    revisionTimeline: listResources(db, { resourceType: "workflow_revision_request" }).filter((resource) => resource.runId === input.runId).map((resource) => ({ id: resource.id, label: resource.title, status: resource.status })),
    rootSessionDecisions: events.filter((event) => event.actorType === "root-session" || /decision|retry|fork|rollback|revision/.test(event.eventType)).map((event) => ({
      eventType: event.eventType,
      taskId: event.taskId ?? undefined,
      summary: summarizePayload(event.payload),
    })),
  };
}
