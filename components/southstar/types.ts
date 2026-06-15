export type PlannerDraftView = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
};

export type RunCreationView = {
  runId: string;
  tork?: {
    jobId?: string;
    status?: string;
  };
};

export type WorkflowCanvasView = {
  runId: string;
  status: string;
  nodes: Array<{
    id: string;
    label: string;
    status: string;
    dependsOn: string[];
  }>;
};

export type RuntimeMonitorView = {
  runId: string;
  status: string;
  latestProgress?: string;
  latestSteering?: string;
  executorJobIds: string[];
  runningTaskIds: string[];
};

export type TaskDetailView = {
  id: string;
  runId: string;
  taskKey: string;
  status: string;
  dependsOn: string[];
  rootSessionId?: string;
  subagentSessionIds: string[];
  executorTaskId?: string;
  snapshot: unknown;
  metrics: unknown;
};

export type TaskEnvelopeEvidenceView = {
  schemaVersion: "southstar.task-envelope.v2" | string;
  runId: string;
  workflowId: string;
  taskId: string;
  domain: string;
  intent: string;
  role?: {
    id?: string;
    name?: string;
  };
  agentProfile?: {
    id?: string;
    provider?: string;
    model?: string;
    skillRefs?: string[];
    memoryScopes?: string[];
    mcpGrantRefs?: string[];
  };
  harness?: {
    id?: string;
    kind?: string;
  };
  contextPacket?: {
    id: string;
    rootSessionId?: string;
    executionAttempt?: number;
    roleRef?: string;
    agentProfileRef?: string;
    selectedMemories?: Array<{
      id: string;
      title: string;
      sourceRef?: string;
      tokenEstimate?: number;
    }>;
    excludedCandidates?: Array<{
      sourceRef: string;
      reason: string;
      tokenEstimate?: number;
    }>;
    skillInstructions?: Array<{ id: string; title: string; sourceRef?: string }>;
    mcpGrantSummary?: Array<{ id: string; title: string; sourceRef?: string }>;
    tokenEstimate?: {
      total?: number;
      bySourceType?: Record<string, number>;
    };
  };
  skills?: Array<{
    skillId?: string;
    sourceRef?: string;
  }>;
  mcpGrants?: Array<{
    serverId?: string;
    allowedTools?: string[];
  }>;
  artifactContracts?: Array<{
    id?: string;
    artifactType?: string;
    requiredFields?: string[];
  }>;
  evaluatorPipeline?: {
    id?: string;
    evaluatorRefs?: string[];
    stopConditionRef?: string;
  };
  session?: {
    sessionId?: string;
    baseCheckpointId?: string;
    maxRepairAttempts?: number;
  };
  workspace?: {
    handle?: {
      repoRoot?: string;
      worktreePath?: string;
    };
    baseSnapshotRef?: {
      provider?: string;
      repoRoot?: string;
      commitSha?: string;
      ref?: string;
    };
  };
};

export type SouthstarCommandResultView = {
  commandId: string;
  accepted: boolean;
  status: "applied" | "queued" | "rejected";
  affectedRunId?: string;
  affectedTaskId?: string;
  resourceRefs: string[];
  eventRefs: string[];
  nextSuggestedActions: string[];
};

export type UiRuntimeResourceView = {
  id?: string;
  resourceKey?: string;
  resourceType?: string;
  status?: string;
  title?: string;
  payload?: unknown;
  createdAt?: string;
};

export type UiTaskDetailPageView = {
  surface: "southstar.ui.task-detail.v1";
  task: {
    taskId: string;
    taskKey: string;
    status: string;
    dependsOn: string[];
  };
  envelope: TaskEnvelopeEvidenceView;
  contextPacket: TaskEnvelopeEvidenceView["contextPacket"];
  memoryTrace: {
    selected: NonNullable<TaskEnvelopeEvidenceView["contextPacket"]>["selectedMemories"];
    excluded: NonNullable<TaskEnvelopeEvidenceView["contextPacket"]>["excludedCandidates"];
    includedTrace: unknown[];
    excludedTrace: unknown[];
    decisionReason: string;
  };
  artifacts: UiRuntimeResourceView[];
  evaluator: {
    pipelineId: string;
    results: UiRuntimeResourceView[];
  };
  worktree?: {
    snapshots: UiRuntimeResourceView[];
    rollbackPreviews: UiRuntimeResourceView[];
    rollbacks: UiRuntimeResourceView[];
  };
  logs: Array<{
    sequence?: number;
    eventType?: string;
    actorType?: string;
    payload?: unknown;
    createdAt?: string;
  }>;
  actions: Array<{ label: string; command: string }>;
};

export type RunStatusView = {
  canvas: WorkflowCanvasView;
  runtime: RuntimeMonitorView;
  sessionsMemory: {
    runId: string;
    sessions: unknown[];
    memoryItems: unknown[];
  };
  vaultMcp: {
    runId: string;
    vaultLeases: unknown[];
    mcpGrants: unknown[];
  };
  executor: {
    runId: string;
    bindings: Array<{
      id: string;
      status: string;
      taskId?: string;
      torkJobId?: string;
    }>;
  };
};
