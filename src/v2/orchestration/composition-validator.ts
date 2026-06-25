import type { SouthstarDb } from "../db/postgres.ts";
import { findLibraryEdgesFrom } from "../design-library/library-graph-store.ts";
import type {
  CandidatePacket,
  LibraryEdgeType,
  WorkflowCompositionPlan,
  WorkflowCompositionValidationIssue,
  WorkflowCompositionValidationResult,
} from "../design-library/types.ts";

export type ValidateWorkflowCompositionOptions = {
  scope?: string;
};

export async function validateWorkflowCompositionPlan(
  db: SouthstarDb,
  packet: CandidatePacket,
  plan: WorkflowCompositionPlan,
  options: ValidateWorkflowCompositionOptions = {},
): Promise<WorkflowCompositionValidationResult> {
  const issues: WorkflowCompositionValidationIssue[] = [];
  if (plan.schemaVersion !== "southstar.workflow_composition_plan.v1") {
    issues.push(issue("invalid_schema_version", "schemaVersion", "schemaVersion must be southstar.workflow_composition_plan.v1"));
  }
  const candidateRefSet = candidateRefs(packet);
  if (!candidateRefSet.has(plan.selectedWorkflowTemplateRef)) {
    issues.push(issue("unknown_template", "selectedWorkflowTemplateRef", `template is not an approved candidate: ${plan.selectedWorkflowTemplateRef}`));
  }
  validateTaskDependencies(plan, issues);
  validateCoverageConstraints(packet, plan, issues);
  validateCandidateMembership(plan, candidateRefSet, issues);
  await validateEdgeConstraints(db, plan, issues, options.scope ?? "software");
  return { ok: issues.length === 0, issues };
}

type CompositionTaskGroupMatcher = {
  taskId?: string;
  agentDefinitionRef?: string;
  agentProfileRef?: string;
  skillRef?: string;
  instructionRef?: string;
  toolGrantRef?: string;
  outputArtifactRef?: string;
};

type CompositionRequiredTaskGroup = {
  id: string;
  minCount: number;
  matchAny: CompositionTaskGroupMatcher[];
};

type CompositionRequiredGroupDependency = {
  fromGroup: string;
  toGroup: string;
};

type CompositionConstraints = {
  requiredTaskGroups: CompositionRequiredTaskGroup[];
  requiredGroupDependencies: CompositionRequiredGroupDependency[];
};

function validateCoverageConstraints(
  packet: CandidatePacket,
  plan: WorkflowCompositionPlan,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const constraints = compositionConstraintsForTemplate(packet, plan.selectedWorkflowTemplateRef);
  if (!constraints) return;
  const taskIdsByGroup = new Map<string, Set<string>>();
  const taskIndexById = new Map<string, number>(plan.tasks.map((task, index) => [task.id, index]));
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));

  for (const rule of constraints.requiredTaskGroups) {
    const matchedTaskIds = new Set(
      plan.tasks.filter((task) => matchesTaskGroupRule(task, rule)).map((task) => task.id),
    );
    taskIdsByGroup.set(rule.id, matchedTaskIds);
    if (matchedTaskIds.size === 0) {
      issues.push(
        issue(
          "missing_required_task_group",
          `compositionConstraints.requiredTaskGroups.${rule.id}`,
          `composition is missing required task group: ${rule.id}`,
        ),
      );
      continue;
    }
    if (matchedTaskIds.size < rule.minCount) {
      issues.push(
        issue(
          "insufficient_task_group_count",
          `compositionConstraints.requiredTaskGroups.${rule.id}`,
          `task group ${rule.id} requires at least ${rule.minCount} task(s), found ${matchedTaskIds.size}`,
        ),
      );
    }
  }

  for (const dependency of constraints.requiredGroupDependencies) {
    const fromTaskIds = taskIdsByGroup.get(dependency.fromGroup);
    const toTaskIds = taskIdsByGroup.get(dependency.toGroup);
    if (!fromTaskIds || !toTaskIds || fromTaskIds.size === 0 || toTaskIds.size === 0) {
      continue;
    }
    for (const fromTaskId of fromTaskIds) {
      const fromTask = tasksById.get(fromTaskId);
      if (!fromTask) continue;
      const dependsOnRequiredGroup = fromTask.dependsOn.some((dependencyTaskId) => toTaskIds.has(dependencyTaskId));
      if (dependsOnRequiredGroup) continue;
      const taskIndex = taskIndexById.get(fromTaskId);
      issues.push(
        issue(
          "missing_required_group_dependency",
          taskIndex === undefined ? "tasks" : `tasks.${taskIndex}.dependsOn`,
          `task group ${dependency.fromGroup} must depend on task group ${dependency.toGroup}`,
        ),
      );
    }
  }
}

function compositionConstraintsForTemplate(
  packet: CandidatePacket,
  templateRef: string,
): CompositionConstraints | null {
  const templateCandidate = packet.workflowTemplateCandidates.find((candidate) => candidate.ref === templateRef);
  if (!templateCandidate || !isRecord(templateCandidate.state)) return null;
  const rawConstraints = templateCandidate.state.compositionConstraints;
  if (!isRecord(rawConstraints)) return null;
  const requiredTaskGroups = parseRequiredTaskGroups(rawConstraints.requiredTaskGroups);
  const requiredGroupDependencies = parseRequiredGroupDependencies(rawConstraints.requiredGroupDependencies);
  if (requiredTaskGroups.length === 0 && requiredGroupDependencies.length === 0) return null;
  return { requiredTaskGroups, requiredGroupDependencies };
}

function parseRequiredTaskGroups(value: unknown): CompositionRequiredTaskGroup[] {
  if (!Array.isArray(value)) return [];
  const rules: CompositionRequiredTaskGroup[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    const matchAny = parseTaskGroupMatchers(item.matchAny);
    if (matchAny.length === 0) continue;
    const minCount = typeof item.minCount === "number" && Number.isFinite(item.minCount) && item.minCount > 0
      ? Math.floor(item.minCount)
      : 1;
    rules.push({
      id: item.id,
      minCount,
      matchAny,
    });
  }
  return rules;
}

function parseRequiredGroupDependencies(value: unknown): CompositionRequiredGroupDependency[] {
  if (!Array.isArray(value)) return [];
  const dependencies: CompositionRequiredGroupDependency[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.fromGroup !== "string" || item.fromGroup.length === 0) continue;
    if (typeof item.toGroup !== "string" || item.toGroup.length === 0) continue;
    dependencies.push({ fromGroup: item.fromGroup, toGroup: item.toGroup });
  }
  return dependencies;
}

function parseTaskGroupMatchers(value: unknown): CompositionTaskGroupMatcher[] {
  if (!Array.isArray(value)) return [];
  const matchers: CompositionTaskGroupMatcher[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const matcher: CompositionTaskGroupMatcher = {};
    if (typeof item.taskId === "string" && item.taskId.length > 0) matcher.taskId = item.taskId;
    if (typeof item.agentDefinitionRef === "string" && item.agentDefinitionRef.length > 0) matcher.agentDefinitionRef = item.agentDefinitionRef;
    if (typeof item.agentProfileRef === "string" && item.agentProfileRef.length > 0) matcher.agentProfileRef = item.agentProfileRef;
    if (typeof item.skillRef === "string" && item.skillRef.length > 0) matcher.skillRef = item.skillRef;
    if (typeof item.instructionRef === "string" && item.instructionRef.length > 0) matcher.instructionRef = item.instructionRef;
    if (typeof item.toolGrantRef === "string" && item.toolGrantRef.length > 0) matcher.toolGrantRef = item.toolGrantRef;
    if (typeof item.outputArtifactRef === "string" && item.outputArtifactRef.length > 0) matcher.outputArtifactRef = item.outputArtifactRef;
    if (Object.keys(matcher).length === 0) continue;
    matchers.push(matcher);
  }
  return matchers;
}

function matchesTaskGroupRule(task: WorkflowCompositionPlan["tasks"][number], rule: CompositionRequiredTaskGroup): boolean {
  return rule.matchAny.some((matcher) => matchesTaskGroupMatcher(task, matcher));
}

function matchesTaskGroupMatcher(task: WorkflowCompositionPlan["tasks"][number], matcher: CompositionTaskGroupMatcher): boolean {
  if (matcher.taskId && task.id !== matcher.taskId) return false;
  if (matcher.agentDefinitionRef && task.agentDefinitionRef !== matcher.agentDefinitionRef) return false;
  if (matcher.agentProfileRef && task.agentProfileRef !== matcher.agentProfileRef) return false;
  if (matcher.skillRef && !task.skillRefs.includes(matcher.skillRef)) return false;
  if (matcher.instructionRef && !task.instructionRefs.includes(matcher.instructionRef)) return false;
  if (matcher.toolGrantRef && !task.toolGrantRefs.includes(matcher.toolGrantRef)) return false;
  if (matcher.outputArtifactRef && !task.outputArtifactRefs.includes(matcher.outputArtifactRef)) return false;
  return true;
}

function validateTaskDependencies(plan: WorkflowCompositionPlan, issues: WorkflowCompositionValidationIssue[]): void {
  const taskIds = new Set<string>();
  for (const [index, task] of plan.tasks.entries()) {
    if (taskIds.has(task.id)) {
      issues.push(issue("duplicate_task_id", `tasks.${index}.id`, `duplicate task id: ${task.id}`));
    }
    taskIds.add(task.id);
  }

  for (const [index, task] of plan.tasks.entries()) {
    for (const dependencyTaskId of task.dependsOn) {
      if (!taskIds.has(dependencyTaskId)) {
        issues.push(issue("unknown_dependency", `tasks.${index}.dependsOn`, `unknown dependency: ${dependencyTaskId}`));
      }
    }
  }

  if (hasCycle(plan.tasks.map((task) => ({ id: task.id, dependsOn: task.dependsOn })))) {
    issues.push(issue("dependency_cycle", "tasks", "task dependency graph contains a cycle"));
  }
}

function validateCandidateMembership(
  plan: WorkflowCompositionPlan,
  candidateRefSet: Set<string>,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const generatedRefs = new Set(plan.generatedComponentProposals.map((proposal) => proposal.id));
  for (const [taskIndex, task] of plan.tasks.entries()) {
    const selectedRefs = [
      task.agentDefinitionRef,
      task.agentProfileRef,
      task.evaluatorProfileRef,
      ...task.instructionRefs,
      ...task.skillRefs,
      ...task.toolGrantRefs,
      ...task.mcpGrantRefs,
      ...task.vaultLeasePolicyRefs,
      ...task.inputArtifactRefs,
      ...task.outputArtifactRefs,
    ];
    for (const ref of selectedRefs) {
      if (generatedRefs.has(ref)) {
        issues.push(issue("generated_component_selected", `tasks.${taskIndex}`, `generated proposal cannot be selected for runtime: ${ref}`));
      }
      if (!candidateRefSet.has(ref)) {
        issues.push(issue("ref_not_in_candidate_packet", `tasks.${taskIndex}`, `ref is not in candidate packet: ${ref}`));
      }
    }
  }
}

async function validateEdgeConstraints(
  db: SouthstarDb,
  plan: WorkflowCompositionPlan,
  issues: WorkflowCompositionValidationIssue[],
  scope: string,
): Promise<void> {
  for (const [taskIndex, task] of plan.tasks.entries()) {
    await requireOutgoingEdge(
      db,
      task.agentProfileRef,
      "implements",
      task.agentDefinitionRef,
      scope,
      issues,
      "profile_does_not_implement_agent",
      `tasks.${taskIndex}.agentProfileRef`,
    );
    for (const skillRef of task.skillRefs) {
      await requireOutgoingEdge(
        db,
        task.agentProfileRef,
        "supports_skill",
        skillRef,
        scope,
        issues,
        "profile_does_not_allow_skill",
        `tasks.${taskIndex}.skillRefs`,
      );
    }
    for (const toolRef of task.toolGrantRefs) {
      await requireOutgoingEdge(
        db,
        task.agentProfileRef,
        "allows_tool",
        toolRef,
        scope,
        issues,
        "profile_does_not_allow_tool",
        `tasks.${taskIndex}.toolGrantRefs`,
      );
    }
    for (const mcpRef of task.mcpGrantRefs) {
      await requireOutgoingEdge(
        db,
        task.agentProfileRef,
        "allows_mcp_grant",
        mcpRef,
        scope,
        issues,
        "profile_does_not_allow_mcp",
        `tasks.${taskIndex}.mcpGrantRefs`,
      );
    }
    for (const vaultRef of task.vaultLeasePolicyRefs) {
      await requireOutgoingEdge(
        db,
        task.agentProfileRef,
        "requires_secret_group",
        vaultRef,
        scope,
        issues,
        "profile_does_not_allow_vault_lease",
        `tasks.${taskIndex}.vaultLeasePolicyRefs`,
      );
    }
    for (const instructionRef of task.instructionRefs) {
      await requireOutgoingEdge(
        db,
        task.agentProfileRef,
        "uses_instruction",
        instructionRef,
        scope,
        issues,
        "profile_does_not_allow_instruction",
        `tasks.${taskIndex}.instructionRefs`,
      );
    }
    for (const artifactRef of task.outputArtifactRefs) {
      await requireOutgoingEdge(
        db,
        task.agentDefinitionRef,
        "produces_artifact",
        artifactRef,
        scope,
        issues,
        "agent_does_not_produce_artifact",
        `tasks.${taskIndex}.outputArtifactRefs`,
      );
      await requireOutgoingEdge(
        db,
        task.evaluatorProfileRef,
        "validates_artifact",
        artifactRef,
        scope,
        issues,
        "evaluator_does_not_validate_artifact",
        `tasks.${taskIndex}.evaluatorProfileRef`,
      );
    }
  }
}

async function requireOutgoingEdge(
  db: SouthstarDb,
  fromRef: string,
  edgeType: LibraryEdgeType,
  toRef: string,
  scope: string,
  issues: WorkflowCompositionValidationIssue[],
  code: WorkflowCompositionValidationIssue["code"],
  path: string,
): Promise<void> {
  const edges = await findLibraryEdgesFrom(db, fromRef, edgeType, { scope });
  if (edges.some((edge) => edge.toObjectKey === toRef)) return;
  issues.push(issue(code, path, `${fromRef} does not have ${edgeType} edge to ${toRef}`));
}

function candidateRefs(packet: CandidatePacket): Set<string> {
  const refs = new Set<string>();
  for (const candidate of packet.workflowTemplateCandidates) refs.add(candidate.ref);
  for (const candidates of Object.values(packet.agentCandidatesByCapability)) for (const candidate of candidates) refs.add(candidate.ref);
  for (const candidates of Object.values(packet.profileCandidatesByAgent)) for (const candidate of candidates) refs.add(candidate.ref);
  for (const candidates of Object.values(packet.skillCandidatesByProfile)) for (const candidate of candidates) refs.add(candidate.ref);
  for (const candidates of Object.values(packet.toolCandidatesByProfile)) for (const candidate of candidates) refs.add(candidate.ref);
  for (const candidates of Object.values(packet.mcpGrantCandidatesByProfile)) for (const candidate of candidates) refs.add(candidate.ref);
  for (const candidates of Object.values(packet.vaultLeaseCandidatesByProfile)) for (const candidate of candidates) refs.add(candidate.ref);
  for (const candidates of Object.values(packet.instructionCandidatesByProfile)) for (const candidate of candidates) refs.add(candidate.ref);
  for (const candidate of packet.artifactContractCandidates) refs.add(candidate.ref);
  for (const candidates of Object.values(packet.evaluatorCandidatesByArtifact)) for (const candidate of candidates) refs.add(candidate.ref);
  for (const candidate of packet.policyConstraints) refs.add(candidate.ref);
  return refs;
}

function hasCycle(tasks: Array<{ id: string; dependsOn: string[] }>): boolean {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string): boolean => {
    if (visited.has(taskId)) return false;
    if (visiting.has(taskId)) return true;
    visiting.add(taskId);
    for (const dependencyTaskId of taskById.get(taskId)?.dependsOn ?? []) {
      if (!taskById.has(dependencyTaskId)) continue;
      if (visit(dependencyTaskId)) return true;
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  };

  return tasks.some((task) => visit(task.id));
}

function issue(
  code: WorkflowCompositionValidationIssue["code"],
  path: string,
  message: string,
): WorkflowCompositionValidationIssue {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
