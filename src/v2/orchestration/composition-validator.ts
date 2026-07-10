import type { SouthstarDb } from "../db/postgres.ts";
import { validateGeneratedNodeProfile } from "../design-library/profile-composer/generated-profile-validator.ts";
import { findLibraryEdgesFrom } from "../design-library/library-graph-store.ts";
import type {
  CandidatePacket,
  LibraryEdgeType,
  WorkflowCompositionPlan,
  WorkflowCompositionValidationIssue,
  WorkflowCompositionValidationResult,
} from "../design-library/types.ts";
import {
  GENERATED_AGENT_PROFILE_COMMAND_ENTRYPOINT,
  GENERATED_AGENT_PROFILE_HARNESSES,
  GENERATED_AGENT_PROFILE_IMAGES,
  GENERATED_AGENT_PROFILE_MODELS,
  GENERATED_AGENT_PROFILE_PROVIDERS,
  GENERATED_AGENT_PROFILE_THINKING_LEVELS,
  GENERATED_AGENT_PROFILE_WORKER_KINDS,
  isAllowedGeneratedAgentProfileValue,
  runtimeBindingForGeneratedProfileImage,
} from "./generated-agent-profile-policy.ts";
import {
  buildGoalRequirementCoverage,
  isCoverageExceptionTask,
} from "./goal-requirement-coverage.ts";
import type { GoalContractV1 } from "./goal-contract.ts";

export type ValidateWorkflowCompositionOptions = {
  scope?: string;
  goalContract?: GoalContractV1;
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
  const constraints = compositionConstraintsForTemplate(packet, plan.selectedWorkflowTemplateRef);
  validateTaskDependencies(plan, issues);
  if (options.goalContract) validateGoalRequirementCoverage(options.goalContract, plan, issues);
  validateCoverageConstraints(constraints, plan, issues);
  validateInputArtifactsAreSatisfied(plan, constraints, issues);
  validateTemplateSlotConstraints(plan.selectedWorkflowTemplateRef, constraints, plan, issues);
  validateCandidateMembership(plan, packet, candidateRefSet, issues);
  await validateGeneratedProfileClosure(db, plan, issues, options.scope ?? "software");
  await validateEdgeConstraints(db, plan, issues, options.scope ?? "software");
  return { ok: issues.length === 0, issues };
}

function validateGoalRequirementCoverage(
  goalContract: GoalContractV1,
  plan: WorkflowCompositionPlan,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const knownRequirementIds = new Set(goalContract.requirements.map((requirement) => requirement.id));
  for (const [taskIndex, task] of plan.tasks.entries()) {
    const requirementIds = task.requirementIds ?? [];
    for (const requirementId of requirementIds) {
      if (knownRequirementIds.has(requirementId)) continue;
      issues.push(issue(
        "unknown_requirement_id",
        `tasks.${taskIndex}.requirementIds`,
        `task ${task.id} references unknown Goal Contract requirement: ${requirementId}`,
      ));
    }
    if (requirementIds.some((requirementId) => knownRequirementIds.has(requirementId))) continue;
    if (isCoverageExceptionTask(task)) continue;
    issues.push(issue(
      "task_without_requirement_coverage",
      `tasks.${taskIndex}.requirementIds`,
      `task ${task.id} does not contribute to a Goal Contract requirement`,
    ));
  }

  const coverage = buildGoalRequirementCoverage({ goalContract, composition: plan });
  const coverageByRequirementId = new Map(coverage.entries.map((entry) => [entry.requirementId, entry]));
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  for (const [requirementIndex, requirement] of goalContract.requirements.entries()) {
    if (!requirement.blocking) continue;
    const entry = coverageByRequirementId.get(requirement.id)!;
    const path = `goalContract.requirements.${requirementIndex}`;
    if (entry.producerTaskIds.length === 0) {
      issues.push(issue(
        "requirement_missing_producer",
        path,
        `blocking requirement has no producer task: ${requirement.id}`,
      ));
    }
    if (entry.artifactRefs.length === 0) {
      issues.push(issue(
        "requirement_missing_artifact",
        path,
        `blocking requirement has no producer artifact: ${requirement.id}`,
      ));
    }
    if (entry.evaluatorTaskIds.length === 0) {
      issues.push(issue(
        "requirement_missing_evaluator",
        path,
        `blocking requirement has no verify or review evaluator task: ${requirement.id}`,
      ));
    }
    const independentEvaluator = entry.producerTaskIds.length > 0 && entry.evaluatorTaskIds.some((evaluatorTaskId) => {
      if (entry.producerTaskIds.includes(evaluatorTaskId)) return false;
      const evaluatorTask = tasksById.get(evaluatorTaskId);
      if (!evaluatorTask) return false;
      return entry.producerTaskIds.every((producerTaskId) => evaluatorTask.dependsOn.includes(producerTaskId));
    });
    if (!independentEvaluator) {
      issues.push(issue(
        "requirement_evaluator_not_independent",
        path,
        `blocking requirement evaluator must be distinct from and directly depend on every producer: ${requirement.id}`,
      ));
    }
    if (entry.requiredEvidenceKinds.length === 0) {
      issues.push(issue(
        "requirement_missing_evidence",
        path,
        `blocking requirement evaluator has no required evidence: ${requirement.id}`,
      ));
    }
  }
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

type CompositionTemplateSlotConstraint = {
  slotRef: string;
  matchAny: CompositionTaskGroupMatcher[];
};

type CompositionConstraints = {
  requiredTaskGroups: CompositionRequiredTaskGroup[];
  requiredGroupDependencies: CompositionRequiredGroupDependency[];
  templateSlots: CompositionTemplateSlotConstraint[];
  initialArtifactRefs: string[];
};

function validateCoverageConstraints(
  constraints: CompositionConstraints | null,
  plan: WorkflowCompositionPlan,
  issues: WorkflowCompositionValidationIssue[],
): void {
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

function validateInputArtifactsAreSatisfied(
  plan: WorkflowCompositionPlan,
  constraints: CompositionConstraints | null,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const initialArtifacts = new Set(constraints?.initialArtifactRefs ?? []);
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));

  for (const [taskIndex, task] of plan.tasks.entries()) {
    const availableArtifacts = new Set(initialArtifacts);
    const upstreamTaskIds = collectUpstreamTaskIds(task, taskById);
    for (const upstreamTaskId of upstreamTaskIds) {
      const upstreamTask = taskById.get(upstreamTaskId);
      if (!upstreamTask) continue;
      for (const artifactRef of upstreamTask.outputArtifactRefs) {
        availableArtifacts.add(artifactRef);
      }
    }
    for (const artifactRef of task.inputArtifactRefs) {
      if (availableArtifacts.has(artifactRef)) continue;
      issues.push(
        issue(
          "input_artifact_not_satisfied",
          `tasks.${taskIndex}.inputArtifactRefs`,
          `task ${task.id} input artifact is not satisfied by initial artifacts or upstream outputs: ${artifactRef}`,
        ),
      );
    }
  }
}

function collectUpstreamTaskIds(
  task: WorkflowCompositionPlan["tasks"][number],
  taskById: Map<string, WorkflowCompositionPlan["tasks"][number]>,
): Set<string> {
  const upstreamTaskIds = new Set<string>();
  const stack = [...task.dependsOn];
  while (stack.length > 0) {
    const dependencyTaskId = stack.pop();
    if (!dependencyTaskId || upstreamTaskIds.has(dependencyTaskId)) continue;
    upstreamTaskIds.add(dependencyTaskId);
    const dependencyTask = taskById.get(dependencyTaskId);
    if (!dependencyTask) continue;
    stack.push(...dependencyTask.dependsOn);
  }
  return upstreamTaskIds;
}

function validateTemplateSlotConstraints(
  templateRef: string,
  constraints: CompositionConstraints | null,
  plan: WorkflowCompositionPlan,
  issues: WorkflowCompositionValidationIssue[],
): void {
  if (!constraints || constraints.templateSlots.length === 0) return;
  const slotByRef = new Map(constraints.templateSlots.map((slot) => [slot.slotRef, slot]));

  for (const [taskIndex, task] of plan.tasks.entries()) {
    const slot = slotByRef.get(task.templateSlotRef);
    if (!slot) {
      issues.push(
        issue(
          "template_slot_not_allowed",
          `tasks.${taskIndex}.templateSlotRef`,
          `template ${templateRef} does not allow slot: ${task.templateSlotRef}`,
        ),
      );
      continue;
    }
    if (slot.matchAny.length === 0) continue;
    if (slot.matchAny.some((matcher) => matchesTaskGroupMatcher(task, matcher))) continue;
    issues.push(
      issue(
        "template_slot_not_allowed",
        `tasks.${taskIndex}.templateSlotRef`,
        `task ${task.id} does not satisfy template slot constraints for slot: ${task.templateSlotRef}`,
      ),
    );
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
  const templateSlots = parseTemplateSlotConstraints(rawConstraints.templateSlots);
  const initialArtifactRefs = parseStringArray(rawConstraints.initialArtifactRefs);
  if (
    requiredTaskGroups.length === 0
    && requiredGroupDependencies.length === 0
    && templateSlots.length === 0
    && initialArtifactRefs.length === 0
  ) {
    return null;
  }
  return { requiredTaskGroups, requiredGroupDependencies, templateSlots, initialArtifactRefs };
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

function parseTemplateSlotConstraints(value: unknown): CompositionTemplateSlotConstraint[] {
  if (!Array.isArray(value)) return [];
  const slots: CompositionTemplateSlotConstraint[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const slotRef = typeof item.slotRef === "string" && item.slotRef.length > 0
      ? item.slotRef
      : typeof item.id === "string" && item.id.length > 0
        ? item.id
        : null;
    if (!slotRef) continue;
    slots.push({
      slotRef,
      matchAny: parseTaskGroupMatchers(item.matchAny),
    });
  }
  return slots;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
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
  packet: CandidatePacket,
  candidateRefSet: Set<string>,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const generatedRefs = new Set(plan.generatedComponentProposals.map((proposal) => proposal.id));
  const validatedGeneratedAgentProfileRefs = validatedGeneratedAgentProfiles(plan);
  for (const [taskIndex, task] of plan.tasks.entries()) {
    const generatedProfileSelected = generatedRefs.has(task.agentProfileRef);
    if (generatedProfileSelected && !validatedGeneratedAgentProfileRefs.has(task.agentProfileRef)) {
      issues.push(
        issue(
          "generated_component_selected",
          `tasks.${taskIndex}.agentProfileRef`,
          `generated proposal cannot be selected for runtime: ${task.agentProfileRef}`,
        ),
      );
    }
    if (generatedProfileSelected && validatedGeneratedAgentProfileRefs.has(task.agentProfileRef)) {
      validateSelectedGeneratedProfileSpec(plan, task.agentProfileRef, taskIndex, issues);
    }

    const selectedRefs = generatedProfileSelected
      ? [
          task.evaluatorProfileRef,
          ...task.vaultLeasePolicyRefs,
          ...task.inputArtifactRefs,
          ...task.outputArtifactRefs,
        ]
      : [
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
      if (!candidateRefSet.has(ref)) {
        issues.push(issue("ref_not_in_candidate_packet", `tasks.${taskIndex}`, `ref is not in candidate packet: ${ref}`));
      }
    }
    if (validatedGeneratedAgentProfileRefs.has(task.agentProfileRef)) {
      validateGeneratedProfilePrimitiveMembership(packet, task, taskIndex, issues);
    }
    validateGraphMetadataConflictEdges(packet, task, taskIndex, issues);
  }
}

function validateSelectedGeneratedProfileSpec(
  plan: WorkflowCompositionPlan,
  profileRef: string,
  taskIndex: number,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const proposalIndex = plan.generatedComponentProposals.findIndex((candidate) => candidate.id === profileRef);
  const proposal = proposalIndex >= 0 ? plan.generatedComponentProposals[proposalIndex] : undefined;
  const path = `generatedComponentProposals.${proposalIndex}.agentProfile`;
  const profile = proposal?.agentProfile;
  if (!profile) {
    issues.push(issue("generated_profile_missing_agent_profile", path, `selected generated profile must include agentProfile: ${profileRef}`));
    return;
  }

  const requiredStringFields = [
    "workerKind",
    "provider",
    "model",
    "thinkingLevel",
    "harnessRef",
    "instruction",
    "promptTemplateRef",
    "contextPolicyRef",
    "sessionPolicyRef",
  ] as const;
  for (const field of requiredStringFields) {
    if (typeof profile[field] !== "string" || profile[field].trim().length === 0) {
      issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.${field}`, `selected generated profile is missing ${field}: ${profileRef}`));
    }
  }
  requireAllowedGeneratedProfileValue(GENERATED_AGENT_PROFILE_WORKER_KINDS, profile.workerKind, `${path}.workerKind`, profileRef, issues);
  requireAllowedGeneratedProfileValue(GENERATED_AGENT_PROFILE_PROVIDERS, profile.provider, `${path}.provider`, profileRef, issues);
  requireAllowedGeneratedProfileValue(GENERATED_AGENT_PROFILE_MODELS, profile.model, `${path}.model`, profileRef, issues);
  requireAllowedGeneratedProfileValue(GENERATED_AGENT_PROFILE_THINKING_LEVELS, profile.thinkingLevel, `${path}.thinkingLevel`, profileRef, issues);
  requireAllowedGeneratedProfileValue(GENERATED_AGENT_PROFILE_HARNESSES, profile.harnessRef, `${path}.harnessRef`, profileRef, issues);

  for (const field of ["memoryScopes", "agentsMdRefs", "vaultLeasePolicyRefs"] as const) {
    if (!Array.isArray(profile[field])) {
      issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.${field}`, `selected generated profile must include ${field}: ${profileRef}`));
    }
  }

  const toolPolicy = profile.toolPolicy;
  for (const field of ["allowedTools", "deniedTools", "requiresApprovalFor"] as const) {
    if (!Array.isArray(toolPolicy?.[field])) {
      issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.toolPolicy.${field}`, `selected generated profile toolPolicy must include ${field}: ${profileRef}`));
    }
  }

  const budgetPolicy = profile.budgetPolicy;
  for (const field of ["maxInputTokens", "maxOutputTokens", "maxWallTimeSeconds"] as const) {
    if (typeof budgetPolicy?.[field] !== "number" || !Number.isFinite(budgetPolicy[field])) {
      issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.budgetPolicy.${field}`, `selected generated profile budgetPolicy must include ${field}: ${profileRef}`));
    }
  }

  const task = plan.tasks[taskIndex];
  if (task && !task.toolGrantRefs.every((ref) => profile.toolPolicy?.allowedTools?.includes(ref))) {
    issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.toolPolicy.allowedTools`, `selected generated profile toolPolicy must allow the task toolGrantRefs: ${profileRef}`));
  }
  if (task && !task.vaultLeasePolicyRefs.every((ref) => profile.vaultLeasePolicyRefs?.includes(ref))) {
    issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.vaultLeasePolicyRefs`, `selected generated profile must include the task vaultLeasePolicyRefs: ${profileRef}`));
  }

  const execution = profile.execution;
  if (!execution) {
    issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.execution`, `selected generated profile must include execution: ${profileRef}`));
    return;
  }
  if (execution.engine !== "tork") {
    issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.execution.engine`, `selected generated profile execution.engine must be tork: ${profileRef}`));
  }
  requireAllowedGeneratedProfileValue(["tork"], execution.engine, `${path}.execution.engine`, profileRef, issues);
  if (typeof execution.image !== "string" || execution.image.trim().length === 0) {
    issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.execution.image`, `selected generated profile execution must include image: ${profileRef}`));
  }
  requireAllowedGeneratedProfileValue(GENERATED_AGENT_PROFILE_IMAGES, execution.image, `${path}.execution.image`, profileRef, issues);
  const binding = runtimeBindingForGeneratedProfileImage(execution.image);
  if (binding) {
    if (profile.provider !== binding.provider) {
      issues.push(issue(
        "generated_profile_invalid_value",
        `${path}.provider`,
        `selected generated profile provider must be ${binding.provider} for ${execution.image}: ${profileRef}`,
      ));
    }
    if (profile.model !== binding.model) {
      issues.push(issue(
        "generated_profile_invalid_value",
        `${path}.model`,
        `selected generated profile model must be ${binding.model} for ${execution.image}: ${profileRef}`,
      ));
    }
    if (profile.harnessRef !== binding.harnessRef) {
      issues.push(issue(
        "generated_profile_invalid_value",
        `${path}.harnessRef`,
        `selected generated profile harnessRef must be ${binding.harnessRef} for ${execution.image}: ${profileRef}`,
      ));
    }
  }
  if (!Array.isArray(execution.command) || execution.command.length === 0) {
    issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.execution.command`, `selected generated profile execution must include command: ${profileRef}`));
  }
  if (Array.isArray(execution.command) && execution.command[0] !== GENERATED_AGENT_PROFILE_COMMAND_ENTRYPOINT) {
    issues.push(issue(
      "generated_profile_invalid_value",
      `${path}.execution.command`,
      `selected generated profile execution.command must start with ${GENERATED_AGENT_PROFILE_COMMAND_ENTRYPOINT}: ${profileRef}`,
    ));
  }
  if (!execution.env || typeof execution.env !== "object" || Array.isArray(execution.env)) {
    issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.execution.env`, `selected generated profile execution must include env object: ${profileRef}`));
  }
  if (!Array.isArray(execution.mounts)) {
    issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.execution.mounts`, `selected generated profile execution must include mounts array: ${profileRef}`));
  }
  if (Array.isArray(execution.mounts)) {
    for (const [mountIndex, mount] of execution.mounts.entries()) {
      if (!mount || typeof mount !== "object" || Array.isArray(mount)) {
        issues.push(issue("generated_profile_invalid_value", `${path}.execution.mounts.${mountIndex}`, `selected generated profile execution mount must be an object: ${profileRef}`));
        continue;
      }
      const source = (mount as { source?: unknown }).source;
      const target = (mount as { target?: unknown }).target;
      if (typeof source !== "string" || !isHostMountSource(source)) {
        issues.push(issue(
          "generated_profile_invalid_value",
          `${path}.execution.mounts.${mountIndex}.source`,
          `selected generated profile execution mount source must be an absolute host path; workspace mounts are injected by runtime: ${profileRef}`,
        ));
      }
      if (typeof target !== "string" || !target.startsWith("/")) {
        issues.push(issue(
          "generated_profile_invalid_value",
          `${path}.execution.mounts.${mountIndex}.target`,
          `selected generated profile execution mount target must be an absolute container path: ${profileRef}`,
        ));
      }
    }
  }
  if (typeof execution.timeoutSeconds !== "number" || !Number.isFinite(execution.timeoutSeconds)) {
    issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.execution.timeoutSeconds`, `selected generated profile execution must include timeoutSeconds: ${profileRef}`));
  }
  if (typeof execution.infraRetry?.maxAttempts !== "number" || !Number.isFinite(execution.infraRetry.maxAttempts)) {
    issues.push(issue("generated_profile_incomplete_agent_profile", `${path}.execution.infraRetry.maxAttempts`, `selected generated profile execution must include infraRetry.maxAttempts: ${profileRef}`));
  }
}

function isHostMountSource(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("/workspace/");
}

function requireAllowedGeneratedProfileValue(
  allowedValues: readonly string[],
  value: unknown,
  path: string,
  profileRef: string,
  issues: WorkflowCompositionValidationIssue[],
): void {
  if (isAllowedGeneratedAgentProfileValue(allowedValues, value)) return;
  issues.push(issue(
    "generated_profile_invalid_value",
    path,
    `selected generated profile value must be one of ${allowedValues.join(", ")}: ${profileRef}`,
  ));
}

function validateGeneratedProfilePrimitiveMembership(
  packet: CandidatePacket,
  task: WorkflowCompositionPlan["tasks"][number],
  taskIndex: number,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const primitiveCandidates = packet.profilePrimitiveCandidates ?? {
    agents: [],
    skills: [],
    tools: [],
    mcpGrants: [],
    instructions: [],
  };
  const metadataRefs = graphMetadataRefSet(packet);
  const agents = metadataRefs ?? new Set(primitiveCandidates.agents);
  const skills = metadataRefs ?? new Set(primitiveCandidates.skills);
  const tools = metadataRefs ?? new Set(primitiveCandidates.tools);
  const mcpGrants = metadataRefs ?? new Set(primitiveCandidates.mcpGrants);
  const instructions = metadataRefs ?? new Set(primitiveCandidates.instructions);

  requirePrimitiveRef(agents, task.agentDefinitionRef, `tasks.${taskIndex}.agentDefinitionRef`, issues);
  for (const [index, ref] of task.skillRefs.entries()) {
    requirePrimitiveRef(skills, ref, `tasks.${taskIndex}.skillRefs.${index}`, issues);
  }
  for (const [index, ref] of task.toolGrantRefs.entries()) {
    requirePrimitiveRef(tools, ref, `tasks.${taskIndex}.toolGrantRefs.${index}`, issues);
  }
  for (const [index, ref] of task.mcpGrantRefs.entries()) {
    requirePrimitiveRef(mcpGrants, ref, `tasks.${taskIndex}.mcpGrantRefs.${index}`, issues);
  }
  for (const [index, ref] of task.instructionRefs.entries()) {
    requirePrimitiveRef(instructions, ref, `tasks.${taskIndex}.instructionRefs.${index}`, issues);
  }
}

function validatedGeneratedAgentProfiles(plan: WorkflowCompositionPlan): Set<string> {
  return new Set(
    plan.generatedComponentProposals
      .filter((proposal) => proposal.kind === "agent_profile" && proposal.validationStatus === "validated")
      .map((proposal) => proposal.id),
  );
}

function requirePrimitiveRef(
  allowedRefs: Set<string>,
  ref: string,
  path: string,
  issues: WorkflowCompositionValidationIssue[],
): void {
  if (allowedRefs.has(ref)) return;
  issues.push(issue("ref_not_in_candidate_packet", path, `ref is not in profile primitive candidates: ${ref}`));
}

function validateGraphMetadataConflictEdges(
  packet: CandidatePacket,
  task: WorkflowCompositionPlan["tasks"][number],
  taskIndex: number,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const graph = packet.graphMetadataCandidates;
  if (!graph) return;
  const selected = new Set([
    task.agentDefinitionRef,
    task.agentProfileRef,
    ...task.instructionRefs,
    ...task.skillRefs,
    ...task.toolGrantRefs,
    ...task.mcpGrantRefs,
    ...task.vaultLeasePolicyRefs,
    ...task.inputArtifactRefs,
    ...task.outputArtifactRefs,
    task.evaluatorProfileRef,
  ]);
  for (const edge of graph.edges) {
    if (edge.type !== "conflicts_with" && edge.type !== "incompatible_with") continue;
    if (selected.has(edge.from) && selected.has(edge.to)) {
      issues.push(issue("conflicting_refs", `tasks.${taskIndex}`, `${edge.from} ${edge.type} ${edge.to}`));
    }
  }
}

async function validateGeneratedProfileClosure(
  db: SouthstarDb,
  plan: WorkflowCompositionPlan,
  issues: WorkflowCompositionValidationIssue[],
  scope: string,
): Promise<void> {
  const generatedProfileRefs = validatedGeneratedAgentProfiles(plan);
  for (const [taskIndex, task] of plan.tasks.entries()) {
    if (!generatedProfileRefs.has(task.agentProfileRef)) continue;
    const validation = await validateGeneratedNodeProfile(db, {
      scope,
      nodeId: task.id,
      agentRef: task.agentDefinitionRef,
      skillRefs: task.skillRefs,
      toolGrantRefs: task.toolGrantRefs,
      mcpGrantRefs: task.mcpGrantRefs,
      instructionRefs: task.instructionRefs,
    });
    for (const validationIssue of validation.issues) {
      issues.push(issue(
        validationIssue.code as WorkflowCompositionValidationIssue["code"],
        `tasks.${taskIndex}.${validationIssue.path}`,
        validationIssue.message,
      ));
    }
  }
}

async function validateEdgeConstraints(
  db: SouthstarDb,
  plan: WorkflowCompositionPlan,
  issues: WorkflowCompositionValidationIssue[],
  scope: string,
): Promise<void> {
  const generatedProfileRefs = validatedGeneratedAgentProfiles(plan);
  for (const [taskIndex, task] of plan.tasks.entries()) {
    if (!generatedProfileRefs.has(task.agentProfileRef)) {
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
        await requireAnyOutgoingEdge(
          db,
          task.agentProfileRef,
          ["uses"],
          skillRef,
          scope,
          issues,
          "profile_does_not_allow_skill",
          `tasks.${taskIndex}.skillRefs`,
        );
      }
      for (const toolRef of task.toolGrantRefs) {
        await requireAnyOutgoingEdge(
          db,
          task.agentProfileRef,
          ["allows_tool", "uses"],
          toolRef,
          scope,
          issues,
          "profile_does_not_allow_tool",
          `tasks.${taskIndex}.toolGrantRefs`,
        );
      }
      for (const mcpRef of task.mcpGrantRefs) {
        await requireAnyOutgoingEdge(
          db,
          task.agentProfileRef,
          ["allows_mcp_grant", "uses"],
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
        await requireAnyOutgoingEdge(
          db,
          task.agentProfileRef,
          ["uses_instruction", "uses"],
          instructionRef,
          scope,
          issues,
          "profile_does_not_allow_instruction",
          `tasks.${taskIndex}.instructionRefs`,
        );
      }
    }
    for (const artifactRef of task.outputArtifactRefs) {
      if (!generatedProfileRefs.has(task.agentProfileRef)) {
        await requireAnyOutgoingEdge(
          db,
          task.agentDefinitionRef,
          ["produces_artifact", "produces"],
          artifactRef,
          scope,
          issues,
          "agent_does_not_produce_artifact",
          `tasks.${taskIndex}.outputArtifactRefs`,
        );
      }
      await requireAnyOutgoingEdge(
        db,
        task.evaluatorProfileRef,
        ["validates_artifact", "validates"],
        artifactRef,
        scope,
        issues,
        "evaluator_does_not_validate_artifact",
        `tasks.${taskIndex}.evaluatorProfileRef`,
      );
    }
  }
}

async function requireAnyOutgoingEdge(
  db: SouthstarDb,
  fromRef: string,
  edgeTypes: readonly LibraryEdgeType[],
  toRef: string,
  scope: string,
  issues: WorkflowCompositionValidationIssue[],
  code: WorkflowCompositionValidationIssue["code"],
  path: string,
): Promise<void> {
  for (const edgeType of edgeTypes) {
    const edges = await findLibraryEdgesFrom(db, fromRef, edgeType, { scope });
    if (edges.some((edge) => edge.toObjectKey === toRef)) return;
  }
  issues.push(issue(code, path, `${fromRef} does not have ${edgeTypes.join(" or ")} edge to ${toRef}`));
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
  const metadataRefs = graphMetadataRefSet(packet);
  if (metadataRefs) return metadataRefs;
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

function graphMetadataRefSet(packet: CandidatePacket): Set<string> | null {
  if (!packet.graphMetadataCandidates) return null;
  return new Set(packet.graphMetadataCandidates.nodes.map((node) => node.ref));
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
