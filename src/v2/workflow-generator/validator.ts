import type { DomainPack } from "../domain-packs/types.ts";
import type { WorkflowGenerationPlan, WorkflowGenerationValidationResult } from "./types.ts";

export function validateWorkflowGenerationPlan(
  domainPack: DomainPack,
  plan: WorkflowGenerationPlan,
): WorkflowGenerationValidationResult {
  const issues: Array<{ path: string; message: string }> = [];
  const policy = domainPack.workflowGeneratorPolicies.find((candidate) => candidate.id === plan.generatorPolicyRef);
  if (!policy) {
    return { ok: false, issues: [{ path: "generatorPolicyRef", message: "unknown generator policy" }] };
  }
  if (!policy.intentRefs.includes(plan.intentRef)) {
    issues.push({ path: "intentRef", message: "intent not allowed by generator policy" });
  }
  if (!policy.templateRefs.includes(plan.templateRef)) {
    issues.push({ path: "templateRef", message: "template not allowed by generator policy" });
  }
  if (plan.tasks.length > policy.maxTasks) {
    issues.push({ path: "tasks", message: `task count exceeds maxTasks ${policy.maxTasks}` });
  }
  if (plan.tasks.length > policy.maxAgentInvocations) {
    issues.push({ path: "tasks", message: `agent invocation estimate exceeds ${policy.maxAgentInvocations}` });
  }
  if (plan.estimatedBudget.maxParallelTasks > policy.maxParallelTasks) {
    issues.push({ path: "estimatedBudget.maxParallelTasks", message: `parallel task estimate exceeds ${policy.maxParallelTasks}` });
  }
  if (plan.estimatedBudget.inputTokens > policy.maxEstimatedInputTokens) {
    issues.push({ path: "estimatedBudget.inputTokens", message: `input token estimate exceeds ${policy.maxEstimatedInputTokens}` });
  }
  if (
    policy.maxEstimatedCostMicrosUsd !== undefined &&
    (plan.estimatedBudget.costMicrosUsd ?? 0) > policy.maxEstimatedCostMicrosUsd
  ) {
    issues.push({ path: "estimatedBudget.costMicrosUsd", message: `cost estimate exceeds ${policy.maxEstimatedCostMicrosUsd}` });
  }

  const taskIdCounts = new Map<string, number>();
  for (const task of plan.tasks) {
    taskIdCounts.set(task.id, (taskIdCounts.get(task.id) ?? 0) + 1);
  }
  const taskIds = new Set(taskIdCounts.keys());

  plan.tasks.forEach((task, index) => {
    if ((taskIdCounts.get(task.id) ?? 0) > 1) {
      issues.push({ path: `tasks.${index}.id`, message: "duplicate task id" });
    }
    if (!policy.allowedRoleRefs.includes(task.roleRef)) {
      issues.push({ path: `tasks.${index}.roleRef`, message: "role not allowed by generator policy" });
    }
    if (!policy.allowedAgentProfileRefs.includes(task.agentProfileRef)) {
      issues.push({ path: `tasks.${index}.agentProfileRef`, message: "agent profile not allowed by generator policy" });
    }
    if (!policy.allowedEvaluatorPipelineRefs.includes(task.evaluatorPipelineRef)) {
      issues.push({ path: `tasks.${index}.evaluatorPipelineRef`, message: "evaluator pipeline not allowed by generator policy" });
    }
    for (const artifactRef of task.requiredArtifactRefs) {
      if (!policy.allowedArtifactContractRefs.includes(artifactRef)) {
        issues.push({
          path: `tasks.${index}.requiredArtifactRefs`,
          message: `artifact contract not allowed: ${artifactRef}`,
        });
      }
    }
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        issues.push({ path: `tasks.${index}.dependsOn`, message: `unknown dependency ${dependency}` });
      }
    }
  });

  plan.orchestration.phases.forEach((phase, index) => {
    if (phase.taskRefs.length > policy.maxParallelTasks) {
      issues.push({
        path: `orchestration.phases.${index}.taskRefs`,
        message: `parallel task count exceeds ${policy.maxParallelTasks}`,
      });
    }
    for (const taskRef of phase.taskRefs) {
      if (!taskIds.has(taskRef)) {
        issues.push({ path: `orchestration.phases.${index}.taskRefs`, message: `unknown task ref ${taskRef}` });
      }
    }
  });

  return { ok: issues.length === 0, issues };
}
