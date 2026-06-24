import type {
  AgentProfile,
  ArtifactContract,
  ContextPolicyDefinition,
  EvaluatorPipelineDefinition,
  MemoryPolicyDefinition,
  RoleDefinition,
  SessionPolicyDefinition,
  WorkspacePolicyDefinition,
  StopConditionDefinition,
} from "../domain-packs/types.ts";

export type HarnessKind = "pi-agent" | "codex" | "claude-code" | "custom";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type HarnessDefinition = {
  id: string;
  kind: HarnessKind;
  entrypoint: string;
  image: string;
  capabilities: string[];
  inputProtocol: "task-envelope-v1" | "task-envelope-v2";
  eventProtocol: "southstar-events-v1";
  supportsCheckpoint: boolean;
  supportsSteering: boolean;
  supportsProgress: boolean;
};

export type TaskExecutionSpec = {
  engine: "tork";
  image: string;
  command: string[];
  env: Record<string, string>;
  mounts: Array<{ source: string; target: string; readonly: boolean }>;
  timeoutSeconds: number;
  infraRetry: { maxAttempts: number };
};

export type WorkflowTaskDefinition = {
  id: string;
  name: string;
  domain: "software" | "research" | "data-analysis" | "general";
  roleRef?: string;
  agentProfileRef?: string;
  providerRef?: string;
  model?: string;
  dependsOn: string[];
  promptInputs?: Record<string, unknown>;
  requiredArtifactRefs?: string[];
  evaluatorPipelineRef?: string;
  stopConditionRefs?: string[];
  recoveryStrategyRefs?: string[];
  contextPolicyRef?: string;
  sessionPolicyRef?: string;
  workspacePolicyRef?: string;
  execution: TaskExecutionSpec;
  rootSession: {
    validator: "schema-evaluator-v1";
    maxRepairAttempts: number;
  };
  skillRefs?: string[];
  instructionRefs?: string[];
  toolGrantRefs?: string[];
  vaultLeasePolicyRefs?: string[];
  memoryScopeRefs?: string[];
  mcpGrantRefs?: string[];
  subagents: Array<{
    id: string;
    harnessId: string;
    prompt: string;
    requiredArtifacts: string[];
  }>;
};

export type EvaluatorDefinition = {
  id: string;
  kind: "schema" | "rubric" | "policy";
  artifactTypes: string[];
  requiredFields: string[];
};

export type McpServerDefinition = {
  id: string;
  command: string;
  args: string[];
  envKeys: string[];
};

export type McpGrantDefinition = {
  taskId: string;
  serverId: string;
  allowedTools: string[];
};

export type VaultLeaseDefinition = {
  taskId: string;
  secretRef: string;
  mountAs: "env" | "file";
  ttlSeconds: number;
};

export type ApprovalPolicy = {
  mode: "manual" | "auto" | "policy";
  requiredApprovals: string[];
  autoApprove?: {
    plannerDraft?: boolean;
    workflowRevision?: boolean;
    memoryDelta?: boolean;
    lowRiskArtifactGate?: boolean;
    steering?: boolean;
    voiceCommand?: boolean;
  };
  requireManualFor?: string[];
};

export type CompiledFromTemplate = {
  templateDefinitionId: string;
  templateVersionId: string;
  recipeVersionId?: string;
  compilerVersion: string;
  inputHash: string;
  libraryVersionRefs: string[];
};

export type EffortPolicy = {
  complexity: "simple" | "standard" | "broad" | "deep";
  maxBrains: number;
  maxHandsPerBrain: number;
  maxParallelTasks: number;
  maxToolCallsPerTask: number;
  maxInputTokensPerBrain: number;
  maxCostMicrosUsd: number;
  stopWhenEvidenceSufficient: boolean;
};

export type SouthstarWorkflowManifest = {
  schemaVersion: "southstar.v2";
  workflowId: string;
  title: string;
  goalPrompt: string;
  domain?: string;
  intent?: string;
  domainPackRef?: { id: string; version: string; contentHash: string };
  workflowGeneration?: {
    planId: string;
    generatorPolicyRef: string;
    orchestrationSnapshotId: string;
  };
  roles?: RoleDefinition[];
  agentProfiles?: AgentProfile[];
  artifactContracts?: ArtifactContract[];
  evaluatorPipelines?: EvaluatorPipelineDefinition[];
  contextPolicies?: ContextPolicyDefinition[];
  sessionPolicies?: SessionPolicyDefinition[];
  memoryPolicies?: MemoryPolicyDefinition[];
  workspacePolicies?: WorkspacePolicyDefinition[];
  stopConditions?: StopConditionDefinition[];
  tasks: WorkflowTaskDefinition[];
  harnessDefinitions: HarnessDefinition[];
  evaluators: EvaluatorDefinition[];
  memoryPolicy: {
    retrievalLimit: number;
    writeRequiresApproval: boolean;
  };
  vaultPolicy: {
    leaseTtlSeconds: number;
    mountMode: "ephemeral-file" | "env";
  };
  mcpServers: McpServerDefinition[];
  mcpGrants: McpGrantDefinition[];
  progressPolicy: {
    firstEventWithinSeconds: number;
    minEventsPerLongTask: number;
  };
  steeringPolicy: {
    enabled: boolean;
    acceptedSignals: Array<"pause" | "resume" | "revise-prompt" | "repair">;
  };
  learningPolicy: {
    recordMemoryDeltas: boolean;
    recordWorkflowLearnings: boolean;
  };
  approvalPolicy?: ApprovalPolicy;
  compiledFrom?: CompiledFromTemplate;
  effortPolicy?: EffortPolicy;
};

export type PlanBundle = {
  workflow: SouthstarWorkflowManifest;
  executionProjection?: {
    executor: "tork";
    job: unknown;
    fingerprint: string;
  };
  plannerTrace: {
    model: string;
    promptHash: string;
    generatedAt: string;
  };
};

export type WorkflowRevisionRequest = {
  revisionId: string;
  baseRevisionId: string;
  runId: string;
  actorType: "planner" | "root-session" | "review-agent" | "orchestrator";
  reason: string;
  addTasks: WorkflowTaskDefinition[];
  removeTaskIds: string[];
  dependencyChanges: Array<{ taskId: string; dependsOn: string[] }>;
  idempotencyKey: string;
};

export type WorkflowRevisionResult = {
  workflow: SouthstarWorkflowManifest;
  revisionId: string;
  manifestFingerprint: string;
  newTaskIds: string[];
};
