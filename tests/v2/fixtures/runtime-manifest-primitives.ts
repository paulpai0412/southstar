import type {
  AgentProfile,
  ArtifactContract,
  ContextPolicyDefinition,
  EvaluatorPipelineDefinition,
  MemoryPolicyDefinition,
  RoleDefinition,
  SessionPolicyDefinition,
  WorkspacePolicyDefinition,
} from "../../../src/v2/design-library/runtime-types.ts";

export function makerRole(): RoleDefinition {
  return {
    id: "maker",
    responsibility: "Implement the feature with tests and documentation.",
    defaultAgentProfileRef: "software-maker-pi",
    allowedAgentProfileRefs: ["software-maker-pi"],
    artifactInputs: [],
    artifactOutputs: ["implementation_report"],
    stopAuthority: "can-suggest",
  };
}

export function makerAgentProfile(): AgentProfile {
  return {
    id: "software-maker-pi",
    name: "Software Maker",
    provider: "pi",
    model: "pi-agent-default",
    harnessRef: "pi",
    agentsMdRefs: [],
    promptTemplateRef: "software-maker",
    skillRefs: ["skill.software-implementation"],
    mcpGrantRefs: ["mcp.filesystem-workspace"],
    vaultLeasePolicyRefs: [],
    memoryScopes: ["software", "project"],
    contextPolicyRef: "software-context-default",
    sessionPolicyRef: "software-session-default",
    toolPolicy: {
      allowedTools: ["workspace-read", "workspace-write", "shell-command"],
      deniedTools: [],
      requiresApprovalFor: [],
    },
    budgetPolicy: {
      maxInputTokens: 12_000,
      maxOutputTokens: 4_000,
      maxWallTimeSeconds: 600,
    },
  };
}

export function implementationReportContract(): ArtifactContract {
  return {
    id: "implementation_report",
    artifactType: "implementation-report",
    requiredFields: ["summary"],
    evidenceFields: ["summary"],
  };
}

export function softwareFeatureQualityPipeline(): EvaluatorPipelineDefinition {
  return {
    id: "software-feature-quality",
    evaluators: [],
    onFailure: { defaultStrategy: "ask-human" },
  };
}

export function contextPolicy(): ContextPolicyDefinition {
  return {
    id: "software-context-default",
    maxInputTokens: 12_000,
    memoryPolicyRef: "software-memory-default",
    includeAgentsMd: true,
    includeWorkspaceSummary: true,
  };
}

export function sessionPolicy(): SessionPolicyDefinition {
  return {
    id: "software-session-default",
    checkpointOn: ["task-start", "artifact-accepted", "before-recovery"],
    allowFork: true,
    allowReset: true,
    allowRollback: true,
  };
}

export function memoryPolicy(): MemoryPolicyDefinition {
  return {
    id: "software-memory-default",
    providerRef: "postgres",
    scopes: ["software", "project"],
    maxInjectedTokens: 1_500,
    maxCandidates: 5,
    requireWriteApproval: true,
    allowedKinds: ["preference", "architecture_decision", "domain_pattern", "failure_lesson", "artifact_summary", "workflow_learning"],
    ranking: {
      relevanceWeight: 0.5,
      recencyWeight: 0.2,
      successWeight: 0.2,
      confidenceWeight: 0.1,
    },
    compression: { strategy: "none", maxTokensPerMemory: 800 },
  };
}

export function workspacePolicy(): WorkspacePolicyDefinition {
  return {
    id: "software-workspace-default",
    provider: "git",
    snapshotAtTaskStart: true,
    snapshotAtAcceptedArtifact: true,
    forkOnCheckerReject: true,
    rollbackOnTestFailure: true,
  };
}
