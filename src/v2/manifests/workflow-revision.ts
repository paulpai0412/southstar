import { createHash } from "node:crypto";
import type {
  SouthstarWorkflowManifest,
  TaskStatus,
  WorkflowRevisionRequest,
  WorkflowRevisionResult,
} from "./types.ts";
import { validateWorkflowManifest } from "./validate.ts";

export function applyWorkflowRevision(
  base: SouthstarWorkflowManifest,
  request: WorkflowRevisionRequest,
  taskStates: Record<string, TaskStatus>,
): WorkflowRevisionResult {
  const removed = new Set(request.removeTaskIds);
  for (const taskId of removed) {
    const state = taskStates[taskId];
    if (state === "completed" || state === "running") {
      throw new Error(`cannot remove ${state} task ${taskId}`);
    }
  }

  const dependencyChanges = new Map(request.dependencyChanges.map((change) => [change.taskId, change.dependsOn]));
  for (const taskId of dependencyChanges.keys()) {
    const state = taskStates[taskId];
    if (state === "completed" || state === "running") {
      throw new Error(`cannot change dependencies for ${state} task ${taskId}`);
    }
  }

  const retainedTasks = base.tasks
    .filter((task) => !removed.has(task.id))
    .map((task) => dependencyChanges.has(task.id) ? { ...task, dependsOn: dependencyChanges.get(task.id) ?? [] } : task);
  const workflow: SouthstarWorkflowManifest = {
    ...base,
    tasks: [...retainedTasks, ...request.addTasks],
  };

  const validation = validateWorkflowManifest(workflow);
  if (!validation.ok) {
    throw new Error(`invalid workflow revision: ${validation.issues.map((issue) => issue.message).join("; ")}`);
  }

  return {
    workflow,
    revisionId: request.revisionId,
    manifestFingerprint: fingerprint(workflow),
    newTaskIds: request.addTasks.map((task) => task.id),
  };
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
