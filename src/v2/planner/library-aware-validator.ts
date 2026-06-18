import type { SouthstarDb } from "../stores/sqlite.ts";
import type {
  LibraryAwarePlannerResult,
  PlannerTaskDraft,
  PlannerValidationIssue,
  PlannerValidationResult,
} from "./library-aware-types.ts";

const writeGrantPatterns = [/workspace-write/i, /git\.workspace-patch/i, /github\.pr-write/i, /issue-comment/i];
const approvedRunnerImages = new Set(["southstar/pi-agent:local"]);

export function validateLibraryAwarePlannerResult(db: SouthstarDb, result: LibraryAwarePlannerResult): PlannerValidationResult {
  const issues: PlannerValidationIssue[] = [];

  if (result.schemaVersion !== "southstar.library-aware-planner-result.v1") {
    issues.push(issue("invalid_schema_version", "schemaVersion", "Planner result schemaVersion must be southstar.library-aware-planner-result.v1"));
  }
  if (!result.requirementSpec.summary.trim()) {
    issues.push(issue("missing_requirement_summary", "requirementSpec.summary", "Requirement summary is required"));
  }
  if (result.selectedTemplateRefs.length === 0) {
    issues.push(issue("no_template_selected", "selectedTemplateRefs", "At least one workflow template must be selected"));
  }
  if (result.tasks.length === 0) {
    issues.push(issue("no_tasks", "tasks", "At least one task is required"));
  }

  for (const templateRef of result.selectedTemplateRefs) {
    if (!libraryObjectExists(db, "workflow_template", templateRef)) {
      issues.push(issue("unknown_workflow_template", `selectedTemplateRefs.${templateRef}`, `Unknown workflow template ${templateRef}`));
    }
  }

  validateTaskGraph(result.tasks, issues);
  for (const task of result.tasks) {
    validateTaskRefs(db, task, issues);
    validateTaskExecutionImage(task, issues);
    validateTaskRisk(task, issues);
  }

  for (const component of result.generatedComponents) {
    const approved = result.requiredApprovals.some((approval) =>
      approval.riskTags.includes("generated-high-risk-component") || approval.riskTags.includes(component.id)
    );
    if (component.risk === "high" && !approved) {
      issues.push(issue("high_risk_generated_component_requires_approval", `generatedComponents.${component.id}`, `High-risk generated component ${component.id} requires approval`));
    }
  }

  return { ok: issues.length === 0, issues };
}

function validateTaskGraph(tasks: PlannerTaskDraft[], issues: PlannerValidationIssue[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) issues.push(issue("duplicate_task_id", `tasks.${task.id}`, `Duplicate task id ${task.id}`));
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) issues.push(issue("unknown_dependency", `tasks.${task.id}.dependsOn`, `Unknown dependency ${dependency}`));
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      issues.push(issue("dependency_cycle", `tasks.${taskId}`, `Dependency cycle reaches ${taskId}`));
      return;
    }
    visiting.add(taskId);
    for (const dep of byId.get(taskId)?.dependsOn ?? []) visit(dep);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

function validateTaskRefs(db: SouthstarDb, task: PlannerTaskDraft, issues: PlannerValidationIssue[]): void {
  if (!libraryObjectExists(db, "agent_definition", task.agentDefinitionRef)) {
    issues.push(issue("unknown_agent_definition", `tasks.${task.id}.agentDefinitionRef`, `Unknown agent definition ${task.agentDefinitionRef}`));
  }
  if (!libraryObjectExists(db, "agent_profile", task.agentProfileRef)) {
    issues.push(issue("unknown_agent_profile", `tasks.${task.id}.agentProfileRef`, `Unknown agent profile ${task.agentProfileRef}`));
  }
  for (const ref of task.skillRefs) {
    if (!libraryObjectExists(db, "skill_definition", ref)) issues.push(issue("unknown_skill", `tasks.${task.id}.skillRefs`, `Unknown skill ${ref}`));
  }
  for (const ref of task.mcpGrantRefs) {
    if (!libraryObjectExists(db, "mcp_tool_grant", ref)) issues.push(issue("unknown_mcp_grant", `tasks.${task.id}.mcpGrantRefs`, `Unknown MCP/tool grant ${ref}`));
  }
  for (const ref of task.artifactContractRefs) {
    if (!libraryObjectExists(db, "artifact_contract", ref)) issues.push(issue("unknown_artifact_contract", `tasks.${task.id}.artifactContractRefs`, `Unknown artifact contract ${ref}`));
  }
  if (!libraryObjectExists(db, "evaluator_profile", task.evaluatorRef)) {
    issues.push(issue("unknown_evaluator", `tasks.${task.id}.evaluatorRef`, `Unknown evaluator ${task.evaluatorRef}`));
  }
}

function validateTaskExecutionImage(task: PlannerTaskDraft, issues: PlannerValidationIssue[]): void {
  const image = task.executionImage ?? "southstar/pi-agent:local";
  if (!approvedRunnerImages.has(image)) {
    issues.push(issue("unapproved_execution_image", `tasks.${task.id}.executionImage`, `${image} is not in the approved runner image set`));
  }
}

function validateTaskRisk(task: PlannerTaskDraft, issues: PlannerValidationIssue[]): void {
  const hasWriteGrant = task.mcpGrantRefs.some((ref) => writeGrantPatterns.some((pattern) => pattern.test(ref)));
  const readonlyProfile = /readonly|read-only/.test(task.agentProfileRef);
  if (readonlyProfile && hasWriteGrant) {
    issues.push(issue("readonly_agent_has_write_grant", `tasks.${task.id}.mcpGrantRefs`, `${task.agentProfileRef} cannot receive write grants`));
  }
  const writeTask = /implement|fix|refactor|write|commit|merge-operation/.test(task.id);
  if (writeTask && !readonlyProfile && !hasWriteGrant && !/browser-qa/.test(task.id)) {
    issues.push(issue("write_task_missing_write_capability", `tasks.${task.id}.mcpGrantRefs`, `${task.id} needs an explicit write-capable grant or a read-only profile`));
  }
}

function libraryObjectExists(db: SouthstarDb, kind: string, key: string): boolean {
  return Boolean(db.prepare("select 1 from library_objects where object_kind = ? and object_key = ?").get(kind, key));
}

function issue(code: PlannerValidationIssue["code"], path: string, message: string): PlannerValidationIssue {
  return { code, path, message };
}
