export type IntentDefinition = {
  id: string;
  description: string;
  examples: string[];
  workflowTemplateRef: string;
  requiredInputs: string[];
  defaultContextPolicyRef: string;
  defaultSessionPolicyRef: string;
};

export type Intent = IntentDefinition;

export type WorkflowStageTemplate = {
  id: string;
  roleRef: string;
  dependsOn: string[];
  promptTemplateRef: string;
  requiredArtifactRefs: string[];
  evaluatorPipelineRef: string;
  stopConditionRefs: string[];
  workspacePolicyRef?: string;
  allowDynamicExpansion: boolean;
};

export type WorkflowGeneratorPolicyDefinition = {
  id: string;
  intentRefs: string[];
  templateRefs: string[];
  allowedRoleRefs: string[];
  allowedAgentProfileRefs: string[];
  allowedEvaluatorPipelineRefs: string[];
  allowedArtifactContractRefs: string[];
  maxTasks: number;
  maxParallelTasks: number;
  maxAgentInvocations: number;
  maxEstimatedInputTokens: number;
  maxEstimatedCostMicrosUsd?: number;
  qualityPatterns: QualityPattern[];
};

export type WorkflowGeneratorPolicy = WorkflowGeneratorPolicyDefinition;

export type QualityPattern =
  | "maker-checker"
  | "multi-angle-research"
  | "competing-hypotheses"
  | "fanout-fanin"
  | "rollback-on-test-failure"
  | "fork-on-checker-reject";

export type RoleDefinition = {
  id: string;
  responsibility: string;
  defaultAgentProfileRef: string;
  allowedAgentProfileRefs: string[];
  artifactInputs: string[];
  artifactOutputs: string[];
  stopAuthority: "none" | "can-suggest" | "can-accept" | "can-reject";
};

export type AgentProvider = "pi" | "codex" | "claude-code" | "openai" | "anthropic" | "custom";

export type PlannerDraftTaskProfileOverride = {
  harnessRef?: string;
  provider?: AgentProvider;
  model?: string;
  thinkingLevel?: string;
  instruction?: string;
  skillRefs?: string[];
  mcpGrantRefs?: string[];
  toolGrantRefs?: string[];
  vaultLeasePolicyRefs?: string[];
  nodePromptSpec?: Record<string, unknown>;
};

export type AgentProfile = {
  id: string;
  name: string;
  agentRef?: string;
  workerKind?: "execution_worker" | "validation_worker" | "repair_worker" | "review_worker";
  provider: AgentProvider;
  model?: string;
  thinkingLevel?: string;
  instruction?: string;
  harnessRef: string;
  systemPromptRef?: string;
  agentsMdRefs: string[];
  promptTemplateRef: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  vaultLeasePolicyRefs?: string[];
  memoryScopes: string[];
  contextPolicyRef: string;
  sessionPolicyRef: string;
  toolPolicy: ToolPolicy;
  budgetPolicy: BudgetPolicy;
};

export type ToolPolicy = {
  allowedTools: string[];
  deniedTools: string[];
  requiresApprovalFor: string[];
};

export type BudgetPolicy = {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicrosUsd?: number;
  maxWallTimeSeconds?: number;
};

export type ArtifactContract = {
  id: string;
  artifactType: string;
  requiredFields: string[];
  evidenceFields: string[];
};

export type EvaluatorPipelineDefinition = {
  id: string;
  evaluators: EvaluatorStepDefinition[];
  onFailure: {
    defaultStrategy:
      | "retry-same-agent"
      | "fork-from-checkpoint"
      | "rollback-workspace"
      | "request-workflow-revision"
      | "ask-human";
  };
};

export type EvaluatorPipeline = EvaluatorPipelineDefinition;

export type EvaluatorStepDefinition = {
  id: string;
  kind: "schema" | "domain" | "test" | "evidence" | "checker-agent" | "policy";
  config: Record<string, unknown>;
  required: boolean;
};

export type ContextPolicyDefinition = {
  id: string;
  maxInputTokens: number;
  memoryPolicyRef: string;
  includeAgentsMd: boolean;
  includeWorkspaceSummary: boolean;
};

export type ContextPolicy = ContextPolicyDefinition;

export type SessionPolicyDefinition = {
  id: string;
  checkpointOn: Array<"task-start" | "artifact-accepted" | "before-recovery">;
  allowFork: boolean;
  allowReset: boolean;
  allowRollback: boolean;
};

export type SessionPolicy = SessionPolicyDefinition;

export type MemoryPolicyDefinition = {
  id: string;
  providerRef: "postgres" | "mem0" | string;
  scopes: string[];
  maxInjectedTokens: number;
  maxCandidates: number;
  requireWriteApproval: boolean;
  allowedKinds: MemoryKind[];
  ranking: {
    relevanceWeight: number;
    recencyWeight: number;
    successWeight: number;
    confidenceWeight: number;
  };
  compression: {
    strategy: "none" | "extractive" | "llm-summary";
    maxTokensPerMemory: number;
  };
};

export type MemoryPolicy = MemoryPolicyDefinition;

export type MemoryKind =
  | "preference"
  | "architecture_decision"
  | "domain_pattern"
  | "failure_lesson"
  | "artifact_summary"
  | "workflow_learning";

export type WorkspacePolicyDefinition = {
  id: string;
  provider: "git";
  snapshotAtTaskStart: boolean;
  snapshotAtAcceptedArtifact: boolean;
  forkOnCheckerReject: boolean;
  rollbackOnTestFailure: boolean;
};

export type WorkspacePolicy = WorkspacePolicyDefinition;

export type StopConditionDefinition = {
  id: string;
  type: "artifact-accepted" | "tests-passed" | "checker-passed" | "human-approved" | "custom";
  evaluatorRefs: string[];
};

export type StopCondition = StopConditionDefinition;
