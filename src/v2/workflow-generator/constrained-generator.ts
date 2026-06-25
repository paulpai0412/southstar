import { createHash } from "node:crypto";
import type { DomainPack } from "../domain-packs/types.ts";
import type { EffortPolicy } from "../manifests/types.ts";
import type { GeneratedTaskPlan, WorkflowGenerationPlan } from "./types.ts";
import { validateWorkflowGenerationPlan } from "./validator.ts";

export type GenerateConstrainedWorkflowPlanInput = {
  runId: string;
  goalPrompt: string;
  domainPack: DomainPack;
  intentId: string;
};

export function generateConstrainedWorkflowPlan(input: GenerateConstrainedWorkflowPlanInput): WorkflowGenerationPlan {
  const intent = required(
    input.domainPack.intents.find((candidate) => candidate.id === input.intentId),
    `unknown intent ${input.intentId}`,
  );
  const template = required(
    input.domainPack.workflowTemplates.find((candidate) => candidate.id === intent.workflowTemplateRef),
    `unknown template ${intent.workflowTemplateRef}`,
  );
  const policy = required(
    input.domainPack.workflowGeneratorPolicies.find(
      (candidate) => candidate.intentRefs.includes(intent.id) && candidate.templateRefs.includes(template.id),
    ),
    `no generator policy for intent ${intent.id}`,
  );
  const broad = isBroadFeaturePrompt(input.goalPrompt);
  const tasks = broad ? broadFeatureTasks(input.goalPrompt) : narrowFeatureTasks(input.goalPrompt);
  const plan: WorkflowGenerationPlan = {
    id: `gen-${input.runId}-${hash(input.goalPrompt).slice(0, 10)}`,
    runId: input.runId,
    domainPackRef: {
      id: input.domainPack.id,
      version: input.domainPack.version,
      contentHash: hash(JSON.stringify(input.domainPack)),
    },
    intentRef: intent.id,
    templateRef: template.id,
    generatorPolicyRef: policy.id,
    rationale: broad
      ? "The prompt requests implementation, tests, documentation, and independent verification, so the generated DAG uses parallel checker work and a fan-in decision."
      : "The prompt is a narrow software change, so the generated DAG uses one maker, one checker, and one summary step.",
    tasks,
    orchestration: {
      phases: broad ? broadFeaturePhases() : narrowFeaturePhases(),
      resumePolicy: "regenerate-from-checkpoint",
    },
    effortPolicy: effortPolicyForPrompt({ broad, taskCount: tasks.length }),
    estimatedBudget: {
      inputTokens: tasks.length * 6_000,
      outputTokens: tasks.length * 1_500,
      costMicrosUsd: tasks.length * 40_000,
      maxParallelTasks: broad ? 2 : 1,
    },
  };
  const validation = validateWorkflowGenerationPlan(input.domainPack, plan);
  if (!validation.ok) {
    throw new Error(`generated workflow plan failed validation: ${JSON.stringify(validation.issues)}`);
  }
  return plan;
}

function effortPolicyForPrompt(input: { broad: boolean; taskCount: number }): EffortPolicy {
  if (input.broad) {
    return {
      complexity: "broad",
      maxBrains: 3,
      maxHandsPerBrain: 2,
      maxParallelTasks: 2,
      maxToolCallsPerTask: 20,
      maxInputTokensPerBrain: 20_000,
      maxCostMicrosUsd: input.taskCount * 60_000,
      stopWhenEvidenceSufficient: true,
    };
  }

  return {
    complexity: "simple",
    maxBrains: 1,
    maxHandsPerBrain: 1,
    maxParallelTasks: 1,
    maxToolCallsPerTask: 10,
    maxInputTokensPerBrain: 12_000,
    maxCostMicrosUsd: input.taskCount * 40_000,
    stopWhenEvidenceSufficient: true,
  };
}

function broadFeatureTasks(goalPrompt: string): GeneratedTaskPlan[] {
  return [
    explorerTask(goalPrompt),
    {
      id: "implement-primary-change",
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      dependsOn: ["understand-repo"],
      promptTemplateRef: "software-maker",
      promptInputs: { goalPrompt, focus: "implement the primary requested behavior" },
      requiredArtifactRefs: ["implementation_report"],
      evaluatorPipelineRef: "software-feature-quality",
      recoveryStrategyRefs: ["retry-same-agent", "rollback-workspace", "fork-from-checkpoint"],
    },
    {
      id: "verify-cli-behavior",
      roleRef: "checker",
      agentProfileRef: "software-checker-codex",
      dependsOn: ["implement-primary-change"],
      promptTemplateRef: "software-checker",
      promptInputs: { goalPrompt, focus: "CLI behavior, numbers, negatives, decimals, and error messages" },
      requiredArtifactRefs: ["verification_report"],
      evaluatorPipelineRef: "software-verification-quality",
      recoveryStrategyRefs: ["fork-from-checkpoint", "request-workflow-revision"],
    },
    {
      id: "verify-docs-and-tests",
      roleRef: "checker",
      agentProfileRef: "software-checker-codex",
      dependsOn: ["implement-primary-change"],
      promptTemplateRef: "software-checker",
      promptInputs: { goalPrompt, focus: "tests, README, and user-facing examples" },
      requiredArtifactRefs: ["verification_report"],
      evaluatorPipelineRef: "software-verification-quality",
      recoveryStrategyRefs: ["fork-from-checkpoint", "request-workflow-revision"],
    },
    {
      id: "fan-in-acceptance",
      roleRef: "checker",
      agentProfileRef: "software-checker-codex",
      dependsOn: ["verify-cli-behavior", "verify-docs-and-tests"],
      promptTemplateRef: "software-checker",
      promptInputs: { goalPrompt, focus: "merge checker findings and decide whether the feature is acceptable" },
      requiredArtifactRefs: ["verification_report"],
      evaluatorPipelineRef: "software-verification-quality",
      recoveryStrategyRefs: ["request-workflow-revision"],
    },
    summaryTask(goalPrompt, ["fan-in-acceptance"]),
  ];
}

function narrowFeatureTasks(goalPrompt: string): GeneratedTaskPlan[] {
  return [
    explorerTask(goalPrompt),
    {
      id: "implement-feature",
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      dependsOn: ["understand-repo"],
      promptTemplateRef: "software-maker",
      promptInputs: { goalPrompt },
      requiredArtifactRefs: ["implementation_report"],
      evaluatorPipelineRef: "software-feature-quality",
      recoveryStrategyRefs: ["retry-same-agent", "rollback-workspace", "fork-from-checkpoint"],
    },
    {
      id: "verify-feature",
      roleRef: "checker",
      agentProfileRef: "software-checker-codex",
      dependsOn: ["implement-feature"],
      promptTemplateRef: "software-checker",
      promptInputs: { goalPrompt, focus: "implementation evidence and tests" },
      requiredArtifactRefs: ["verification_report"],
      evaluatorPipelineRef: "software-verification-quality",
      recoveryStrategyRefs: ["fork-from-checkpoint", "request-workflow-revision"],
    },
    summaryTask(goalPrompt, ["verify-feature"]),
  ];
}

function explorerTask(goalPrompt: string): GeneratedTaskPlan {
  return {
    id: "understand-repo",
    roleRef: "explorer",
    agentProfileRef: "software-explorer-codex",
    dependsOn: [],
    promptTemplateRef: "software-explorer",
    promptInputs: { goalPrompt },
    requiredArtifactRefs: ["implementation_plan"],
    evaluatorPipelineRef: "software-plan-quality",
    recoveryStrategyRefs: ["retry-same-agent"],
  };
}

function summaryTask(goalPrompt: string, dependsOn: string[]): GeneratedTaskPlan {
  return {
    id: "summarize-completion",
    roleRef: "summarizer",
    agentProfileRef: "software-summarizer-codex",
    dependsOn,
    promptTemplateRef: "software-summarizer",
    promptInputs: { goalPrompt },
    requiredArtifactRefs: ["completion_report"],
    evaluatorPipelineRef: "software-completion-quality",
    recoveryStrategyRefs: ["request-workflow-revision"],
  };
}

function broadFeaturePhases() {
  return [
    { id: "understand", taskRefs: ["understand-repo"] },
    { id: "implement", taskRefs: ["implement-primary-change"] },
    {
      id: "parallel-verify",
      taskRefs: ["verify-cli-behavior", "verify-docs-and-tests"],
      fanIn: { strategy: "checker-arbitrated" as const, outputArtifactRef: "verification_report" },
    },
    { id: "acceptance-fan-in", taskRefs: ["fan-in-acceptance"] },
    { id: "summarize", taskRefs: ["summarize-completion"] },
  ];
}

function narrowFeaturePhases() {
  return [
    { id: "understand", taskRefs: ["understand-repo"] },
    { id: "implement", taskRefs: ["implement-feature"] },
    { id: "verify", taskRefs: ["verify-feature"] },
    { id: "summarize", taskRefs: ["summarize-completion"] },
  ];
}

function isBroadFeaturePrompt(goalPrompt: string): boolean {
  return /(readme|docs|文件|測試|test|checker|驗證|錯誤訊息|小數|負數|多數字|final completion report)/i.test(goalPrompt);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}
