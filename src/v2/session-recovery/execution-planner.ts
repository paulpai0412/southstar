import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import type { RecoveryStrategy } from "./types.ts";

export type RecoveryExecutionPlan = {
  strategy: RecoveryStrategy;
  failedTaskId: string;
  baseTaskId: string;
  targetTaskIds: string[];
  attemptNumber: number;
  requiresOperatorApproval: boolean;
  reason: string;
  diagnostics: string[];
};

export type PlanRecoveryExecutionInput = {
  workflow: SouthstarWorkflowManifest;
  failedTaskId: string;
  strategy: RecoveryStrategy;
  attemptNumber: number;
  completedTaskIds: string[];
};

export function planRecoveryExecution(input: PlanRecoveryExecutionInput): RecoveryExecutionPlan {
  const taskById = new Map(input.workflow.tasks.map((task) => [task.id, task]));
  const failedTask = taskById.get(input.failedTaskId);
  if (!failedTask) throw new Error(`failed task ${input.failedTaskId} not found in workflow ${input.workflow.workflowId}`);

  if (input.attemptNumber < 2 || !Number.isInteger(input.attemptNumber)) {
    throw new Error(`recovery attemptNumber must be an integer >= 2, got ${input.attemptNumber}`);
  }

  const completed = new Set(input.completedTaskIds);
  const diagnostics: string[] = [];
  let baseTaskId = input.failedTaskId;
  let targetTaskIds: string[];

  if (input.strategy === "retry-same-agent" || input.strategy === "reset-from-checkpoint" || input.strategy === "host-native-rewind") {
    targetTaskIds = [input.failedTaskId];
  } else if (input.strategy === "rollback-workspace") {
    baseTaskId = input.failedTaskId;
    targetTaskIds = orderedUnique([
      input.failedTaskId,
      ...downstreamClosure(input.workflow, input.failedTaskId),
    ], input.workflow);
  } else if (input.strategy === "fork-from-checkpoint") {
    const producers = nearestCompletedDependencies(input.workflow, input.failedTaskId, completed);
    if (producers.length > 0) {
      baseTaskId = producers[0]!;
      if (producers.length > 1) diagnostics.push(`multiple upstream producers selected: ${producers.join(",")}`);
    } else {
      diagnostics.push(`no completed upstream producer found for ${input.failedTaskId}; using failed task as base`);
    }
    targetTaskIds = orderedUnique([
      ...producers,
      input.failedTaskId,
      ...downstreamClosure(input.workflow, input.failedTaskId),
    ], input.workflow);
  } else {
    targetTaskIds = [];
    diagnostics.push(`strategy ${input.strategy} does not define an automatic execution slice`);
  }

  return {
    strategy: input.strategy,
    failedTaskId: input.failedTaskId,
    baseTaskId,
    targetTaskIds,
    attemptNumber: input.attemptNumber,
    requiresOperatorApproval: input.strategy === "rollback-workspace" || input.strategy === "ask-human",
    reason: reasonFor(input.strategy, input.failedTaskId, baseTaskId, targetTaskIds),
    diagnostics,
  };
}

function nearestCompletedDependencies(
  workflow: SouthstarWorkflowManifest,
  failedTaskId: string,
  completedTaskIds: Set<string>,
): string[] {
  const taskById = new Map(workflow.tasks.map((task) => [task.id, task]));
  const failedTask = taskById.get(failedTaskId);
  if (!failedTask) return [];

  const directCompleted = failedTask.dependsOn.filter((taskId) => completedTaskIds.has(taskId));
  if (directCompleted.length > 0) return orderedUnique(directCompleted, workflow);

  const visited = new Set<string>();
  const queue = [...failedTask.dependsOn];
  const found: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (completedTaskIds.has(current)) {
      found.push(current);
      continue;
    }
    const task = taskById.get(current);
    if (task) queue.push(...task.dependsOn);
  }
  return orderedUnique(found, workflow);
}

function downstreamClosure(workflow: SouthstarWorkflowManifest, taskId: string): string[] {
  const childrenByTask = new Map<string, string[]>();
  for (const task of workflow.tasks) {
    for (const dependency of task.dependsOn) {
      const children = childrenByTask.get(dependency) ?? [];
      children.push(task.id);
      childrenByTask.set(dependency, children);
    }
  }

  const visited = new Set<string>();
  const queue = [...(childrenByTask.get(taskId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(childrenByTask.get(current) ?? []));
  }
  return orderedUnique([...visited], workflow);
}

function orderedUnique(taskIds: string[], workflow: SouthstarWorkflowManifest): string[] {
  const wanted = new Set(taskIds);
  const output: string[] = [];
  for (const task of workflow.tasks) {
    if (wanted.has(task.id) && !output.includes(task.id)) output.push(task.id);
  }
  return output;
}

function reasonFor(strategy: RecoveryStrategy, failedTaskId: string, baseTaskId: string, targetTaskIds: string[]): string {
  if (targetTaskIds.length === 0) return `Strategy ${strategy} for ${failedTaskId} requires external intervention.`;
  if (baseTaskId === failedTaskId) return `Strategy ${strategy} reruns failed task ${failedTaskId}.`;
  return `Strategy ${strategy} reruns workflow slice from upstream producer ${baseTaskId} through ${targetTaskIds.at(-1)}.`;
}
