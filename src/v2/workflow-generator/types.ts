import type { EffortPolicy } from "../manifests/types.ts";

export type WorkflowGenerationPlan = {
  id: string;
  runId: string;
  domainPackRef: { id: string; version: string; contentHash: string };
  intentRef: string;
  templateRef: string;
  generatorPolicyRef: string;
  rationale: string;
  tasks: GeneratedTaskPlan[];
  orchestration: OrchestrationPlan;
  effortPolicy: EffortPolicy;
  estimatedBudget: {
    inputTokens: number;
    outputTokens: number;
    costMicrosUsd?: number;
    maxParallelTasks: number;
  };
};

export type GeneratedTaskPlan = {
  id: string;
  roleRef: string;
  agentProfileRef: string;
  dependsOn: string[];
  promptTemplateRef: string;
  promptInputs: Record<string, unknown>;
  requiredArtifactRefs: string[];
  evaluatorPipelineRef: string;
  recoveryStrategyRefs: string[];
};

export type OrchestrationPlan = {
  phases: Array<{
    id: string;
    taskRefs: string[];
    fanIn?: {
      strategy: "all-pass" | "majority" | "best-candidate" | "checker-arbitrated";
      outputArtifactRef: string;
    };
  }>;
  resumePolicy: "same-plan" | "regenerate-from-checkpoint";
};

export type OrchestrationSnapshot = {
  id: string;
  runId: string;
  generationPlanId: string;
  manifestFingerprint: string;
  phaseStates: Array<{
    phaseId: string;
    status: "pending" | "running" | "completed" | "failed" | "superseded";
    taskResultRefs: string[];
    intermediateResultRefs: string[];
  }>;
  metrics: {
    agentInvocations: number;
    inputTokens?: number;
    outputTokens?: number;
    costMicrosUsd?: number;
  };
};

export type WorkflowGenerationValidationResult = {
  ok: boolean;
  issues: Array<{ path: string; message: string }>;
};
