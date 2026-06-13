export type SessionNode = {
  id: string;
  runId: string;
  taskId?: string;
  roleRef: string;
  agentProfileRef: string;
  parentSessionId?: string;
  baseCheckpointId?: string;
};

export type SessionCheckpoint = {
  id: string;
  sessionId: string;
  runId: string;
  taskId?: string;
  contextPacketId: string;
  artifactRefs: string[];
  transcriptSummary: string;
  metrics: Record<string, unknown>;
};

export type RecoveryDecision = {
  id: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  strategy: "fork-from-checkpoint" | "reset-from-checkpoint" | "rollback-workspace";
  baseCheckpointId?: string;
  restoredCheckpointId?: string;
  reason: string;
};

export type SessionGraphProvider = {
  createSession(input: {
    runId: string;
    taskId?: string;
    roleRef: string;
    agentProfileRef: string;
    parentSessionId?: string;
    baseCheckpointId?: string;
  }): SessionNode;
  checkpoint(input: {
    sessionId: string;
    runId: string;
    taskId?: string;
    contextPacketId: string;
    artifactRefs: string[];
    transcriptSummary: string;
    metrics?: Record<string, unknown>;
  }): SessionCheckpoint;
  fork(input: { runId: string; taskId?: string; baseCheckpointId: string; reason: string }): SessionNode & {
    recoveryDecisionId: string;
  };
  reset(input: { runId: string; taskId?: string; baseCheckpointId: string; reason: string }): RecoveryDecision;
  rollback(input: { runId: string; taskId?: string; checkpointId: string; reason: string }): RecoveryDecision;
};
