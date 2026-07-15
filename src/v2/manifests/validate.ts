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
    const sourceKind = workflow.compiledFrom.sourceKind ?? "workflow_template";
    const hasTemplateFields = "templateDefinitionId" in workflow.compiledFrom || "templateVersionId" in workflow.compiledFrom;
    if (sourceKind === "library_primitives" && hasTemplateFields) {
      issues.push({ path: "workflow.compiledFrom.sourceKind", message: "library_primitives provenance must not include template fields" });
    }
    if (sourceKind === "workflow_template") {
      const templateCompiledFrom = workflow.compiledFrom as Extract<SouthstarWorkflowManifest["compiledFrom"], { sourceKind?: "workflow_template" }>;
      if (!templateCompiledFrom.templateDefinitionId) {
        issues.push({ path: "workflow.compiledFrom.templateDefinitionId", message: "is required when compiledFrom is present" });
      }
      if (!templateCompiledFrom.templateVersionId) {
        issues.push({ path: "workflow.compiledFrom.templateVersionId", message: "is required when compiledFrom is present" });
      }
      if (templateCompiledFrom.templateDefinitionId === "template.graph-dynamic-workflow" || templateCompiledFrom.templateVersionId === "template.graph-dynamic-workflow") {
        issues.push({ path: "workflow.compiledFrom.templateDefinitionId", message: "sentinel workflow template ids are not valid provenance" });
      }
    } else if (sourceKind !== "library_primitives") {
      issues.push({ path: "workflow.compiledFrom.sourceKind", message: "must be workflow_template or library_primitives" });
    }
    if (!workflow.compiledFrom.compilerVersion) {
      issues.push({ path: "workflow.compiledFrom.compilerVersion", message: "is required when compiledFrom is present" });
    }
    if (!/^[a-f0-9]{64}$/.test(workflow.compiledFrom.inputHash ?? "")) {
      issues.push({ path: "workflow.compiledFrom.inputHash", message: "must be a 64-char lowercase sha256 hex string" });
    }
    const libraryVersionRefs = workflow.compiledFrom.libraryVersionRefs;
    const validLibraryVersionRefs: string[] = [];
    if (!Array.isArray(libraryVersionRefs) || libraryVersionRefs.length === 0) {
      issues.push({ path: "workflow.compiledFrom.libraryVersionRefs", message: "must contain at least one immutable library version ref" });
    } else {
      for (const [index, ref] of libraryVersionRefs.entries()) {
        if (typeof ref !== "string" || ref.length === 0) {
          issues.push({ path: `workflow.compiledFrom.libraryVersionRefs.${index}`, message: "must be a non-empty immutable library version ref" });
          continue;
        }
        validLibraryVersionRefs.push(ref);
      }
      if (sourceKind === "workflow_template") {
        const templateCompiledFrom = workflow.compiledFrom as Extract<SouthstarWorkflowManifest["compiledFrom"], { sourceKind?: "workflow_template" }>;
        if (!validLibraryVersionRefs.includes(templateCompiledFrom.templateVersionId)) {
          issues.push({ path: "workflow.compiledFrom.templateVersionId", message: "must be included in compiledFrom.libraryVersionRefs" });
        }
      }
    }
    const objectVersionRefs = workflow.compiledFrom.libraryObjectVersionRefs;
    if (!Array.isArray(objectVersionRefs) || objectVersionRefs.length === 0) {
      issues.push({ path: "workflow.compiledFrom.libraryObjectVersionRefs", message: "must contain exact Library object-version pairs" });
    } else {
      const seenObjectKeys = new Set<string>();
      const validObjectVersionRefs: Array<{ objectKey: string; versionRef: string }> = [];
      for (const [index, pair] of objectVersionRefs.entries()) {
        if (!pair || typeof pair.objectKey !== "string" || pair.objectKey.length === 0 || typeof pair.versionRef !== "string" || pair.versionRef.length === 0) {
          issues.push({ path: `workflow.compiledFrom.libraryObjectVersionRefs.${index}`, message: "must be a non-empty object-version pair" });
          continue;
        }
        if (seenObjectKeys.has(pair.objectKey)) {
          issues.push({ path: `workflow.compiledFrom.libraryObjectVersionRefs.${index}.objectKey`, message: "must be unique" });
        }
        seenObjectKeys.add(pair.objectKey);
        validObjectVersionRefs.push(pair);
      }
      if (sourceKind === "workflow_template") {
        const templateCompiledFrom = workflow.compiledFrom as Extract<SouthstarWorkflowManifest["compiledFrom"], { sourceKind?: "workflow_template" }>;
        const templatePair = validObjectVersionRefs.find((pair) => pair.objectKey === templateCompiledFrom.templateDefinitionId);
        if (templatePair?.versionRef !== templateCompiledFrom.templateVersionId) {
          issues.push({ path: "workflow.compiledFrom.templateDefinitionId", message: "must map to templateVersionId in libraryObjectVersionRefs" });
        }
      }
      const pairVersions = [...new Set(validObjectVersionRefs.map((pair) => pair.versionRef))].sort();
      const compatibilityVersions = [...new Set(validLibraryVersionRefs)].sort();
      if (JSON.stringify(pairVersions) !== JSON.stringify(compatibilityVersions)) {
        issues.push({ path: "workflow.compiledFrom.libraryVersionRefs", message: "must match libraryObjectVersionRefs versions" });
      }
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
    validateWorkspaceMutation(task.workspaceMutation, `workflow.tasks.${task.id}.workspaceMutation`, issues);
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

function validateWorkspaceMutation(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  const mutation = value as { mode?: unknown; resourceKeys?: unknown };
  if (mutation.mode !== "read_only" && mutation.mode !== "shared_write" && mutation.mode !== "append_only") {
    issues.push({ path: `${path}.mode`, message: "must be read_only, shared_write, or append_only" });
  }
  if (mutation.resourceKeys !== undefined) {
    if (!Array.isArray(mutation.resourceKeys) || mutation.resourceKeys.some((key) => typeof key !== "string" || key.trim().length === 0)) {
      issues.push({ path: `${path}.resourceKeys`, message: "must be an array of non-empty strings" });
    }
  }
  const isolation = (value as { isolation?: unknown }).isolation;
  if (isolation !== undefined && isolation !== "shared" && isolation !== "git_worktree") {
    issues.push({ path: `${path}.isolation`, message: "must be shared or git_worktree" });
  }
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
