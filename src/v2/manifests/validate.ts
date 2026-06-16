import type { PlanBundle, SouthstarWorkflowManifest, ValidationIssue } from "./validation-types.ts";

export type { ValidationIssue, ValidationResult } from "./validation-types.ts";

export function validatePlanBundle(bundle: PlanBundle) {
  return validateWorkflowManifest(bundle.workflow);
}

export function validateWorkflowManifest(workflow: SouthstarWorkflowManifest) {
  const issues: ValidationIssue[] = [];
  if (workflow.schemaVersion !== "southstar.v2") {
    issues.push({ path: "workflow.schemaVersion", message: "must be southstar.v2" });
  }
  if (!Array.isArray(workflow.tasks)) {
    issues.push({ path: "workflow.tasks", message: "must be an array" });
  }
  if (!Array.isArray(workflow.harnessDefinitions)) {
    issues.push({ path: "workflow.harnessDefinitions", message: "must be an array" });
  }
  if (!Array.isArray(workflow.evaluators)) {
    issues.push({ path: "workflow.evaluators", message: "must be an array" });
  }
  if (workflow.compiledFrom) {
    if (!workflow.compiledFrom.templateDefinitionId) {
      issues.push({ path: "workflow.compiledFrom.templateDefinitionId", message: "is required when compiledFrom is present" });
    }
    if (!workflow.compiledFrom.templateVersionId) {
      issues.push({ path: "workflow.compiledFrom.templateVersionId", message: "is required when compiledFrom is present" });
    }
    if (!workflow.compiledFrom.compilerVersion) {
      issues.push({ path: "workflow.compiledFrom.compilerVersion", message: "is required when compiledFrom is present" });
    }
    if (!/^[a-f0-9]{64}$/.test(workflow.compiledFrom.inputHash ?? "")) {
      issues.push({ path: "workflow.compiledFrom.inputHash", message: "must be a 64-char lowercase sha256 hex string" });
    }
    if (!Array.isArray(workflow.compiledFrom.libraryVersionRefs) || workflow.compiledFrom.libraryVersionRefs.length === 0) {
      issues.push({ path: "workflow.compiledFrom.libraryVersionRefs", message: "must contain at least one immutable library version ref" });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const taskIds = new Set<string>();
  for (const task of workflow.tasks) {
    if (taskIds.has(task.id)) {
      issues.push({ path: `workflow.tasks.${task.id}.id`, message: "duplicate task id" });
    }
    taskIds.add(task.id);
  }

  const harnessIds = new Set(workflow.harnessDefinitions.map((harness) => harness.id));
  const evaluatorIds = new Set(workflow.evaluators.map((evaluator) => evaluator.id));
  for (const task of workflow.tasks) {
    if (task.execution.engine !== "tork") {
      issues.push({ path: `workflow.tasks.${task.id}.execution.engine`, message: "MVP execution engine must be tork" });
    }
    if (task.execution.command.length === 0 || task.execution.command[0] !== "southstar-agent-runner") {
      issues.push({ path: `workflow.tasks.${task.id}.execution.command`, message: "must run southstar-agent-runner" });
    }
    if (task.rootSession.maxRepairAttempts < 1) {
      issues.push({ path: `workflow.tasks.${task.id}.rootSession.maxRepairAttempts`, message: "must be >= 1" });
    }
    if (!evaluatorIds.has(task.rootSession.validator)) {
      issues.push({ path: `workflow.tasks.${task.id}.rootSession.validator`, message: "unknown evaluator id" });
    }
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        issues.push({ path: `workflow.tasks.${task.id}.dependsOn`, message: `unknown dependency ${dependency}` });
      }
    }
    for (const subagent of task.subagents) {
      if (!harnessIds.has(subagent.harnessId)) {
        issues.push({ path: `workflow.tasks.${task.id}.subagents.${subagent.id}.harnessId`, message: "unknown harness id" });
      }
    }
  }

  if (hasCycle(workflow)) {
    issues.push({ path: "workflow.tasks", message: "task dependency cycle detected" });
  }

  return { ok: issues.length === 0, issues };
}

function hasCycle(workflow: SouthstarWorkflowManifest) {
  const tasks = new Map(workflow.tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(taskId: string): boolean {
    if (visited.has(taskId)) return false;
    if (visiting.has(taskId)) return true;
    const task = tasks.get(taskId);
    if (!task) return false;
    visiting.add(taskId);
    for (const dependency of task.dependsOn) {
      if (visit(dependency)) return true;
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  }

  return workflow.tasks.some((task) => visit(task.id));
}
