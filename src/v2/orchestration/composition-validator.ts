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
  validateCandidateMembership(plan, candidateRefSet, issues);
  await validateEdgeConstraints(db, plan, issues, options.scope ?? "software");
  return { ok: issues.length === 0, issues };
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
