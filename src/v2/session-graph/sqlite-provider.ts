import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { getResourceByKey, upsertRuntimeResource } from "../stores/resource-store.ts";
import { recordSessionOperation } from "../session-recovery/operations.ts";
import type { RecoveryDecision, SessionCheckpoint, SessionGraphProvider, SessionNode } from "./types.ts";

export function createSqliteSessionGraphProvider(db: SouthstarDb): SessionGraphProvider {
  return {
    createSession(input) {
      const isChildSession = Boolean(input.parentSessionId || input.baseCheckpointId);
      return persistSessionNode(db, {
        id: isChildSession ? `session-${input.runId}-${input.taskId}-${randomUUID()}` : `root-${input.runId}-${input.taskId}`,
        runId: input.runId,
        taskId: input.taskId,
        roleRef: input.roleRef,
        agentProfileRef: input.agentProfileRef,
        parentSessionId: input.parentSessionId,
        baseCheckpointId: input.baseCheckpointId,
      });
    },
    checkpoint(input) {
      requireWorkflowRun(db, input.runId);
      const checkpoint: SessionCheckpoint = {
        id: `checkpoint-${randomUUID()}`,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        contextPacketId: input.contextPacketId,
        artifactRefs: input.artifactRefs,
        transcriptSummary: input.transcriptSummary,
        metrics: input.metrics ?? {},
      };
      upsertRuntimeResource(db, {
        id: checkpoint.id,
        resourceType: "session_checkpoint",
        resourceKey: checkpoint.id,
        runId: checkpoint.runId,
        taskId: checkpoint.taskId,
        sessionId: checkpoint.sessionId,
        scope: "session",
        status: "created",
        title: "Session checkpoint",
        payload: checkpoint,
        summary: { transcriptSummary: checkpoint.transcriptSummary, artifactRefs: checkpoint.artifactRefs },
        metrics: {},
      });
      appendHistoryEvent(db, {
        runId: checkpoint.runId,
        taskId: checkpoint.taskId,
        sessionId: checkpoint.sessionId,
        eventType: "checkpoint.created",
        actorType: "root-session",
        payload: {
          checkpointResourceId: checkpoint.id,
          contextPacketId: checkpoint.contextPacketId,
          artifactRefs: checkpoint.artifactRefs,
        },
      });
      return checkpoint;
    },
    fork(input) {
      const checkpoint = requireCheckpointForRun(db, input.baseCheckpointId, input.runId);
      const parentSession = readSessionNode(db, checkpoint.sessionId);
      const fork = persistSessionNode(db, {
        id: `session-${randomUUID()}`,
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId,
        roleRef: parentSession?.roleRef ?? "unknown",
        agentProfileRef: parentSession?.agentProfileRef ?? "unknown",
        parentSessionId: checkpoint.sessionId,
        baseCheckpointId: input.baseCheckpointId,
      });
      const decision = persistRecoveryDecision(db, {
        id: `recovery-${randomUUID()}`,
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId,
        sessionId: fork.id,
        strategy: "fork-from-checkpoint",
        reason: input.reason,
        baseCheckpointId: input.baseCheckpointId,
      });
      recordSessionOperation(db, {
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId ?? "unknown-task",
        type: "fork",
        baseCheckpointId: input.baseCheckpointId,
        oldSessionId: checkpoint.sessionId,
        newSessionId: fork.id,
        host: "southstar-native",
        status: "succeeded",
        fallbackUsed: false,
      });
      return { ...fork, recoveryDecisionId: decision.id };
    },
    reset(input) {
      const checkpoint = requireCheckpointForRun(db, input.baseCheckpointId, input.runId);
      const parentSession = readSessionNode(db, checkpoint.sessionId);
      const resetSession = persistSessionNode(db, {
        id: `session-${randomUUID()}`,
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId,
        roleRef: parentSession?.roleRef ?? "unknown",
        agentProfileRef: parentSession?.agentProfileRef ?? "unknown",
        baseCheckpointId: input.baseCheckpointId,
      });
      const decision = persistRecoveryDecision(db, {
        id: `recovery-${randomUUID()}`,
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId,
        sessionId: resetSession.id,
        strategy: "reset-from-checkpoint",
        reason: input.reason,
        baseCheckpointId: input.baseCheckpointId,
      });
      recordSessionOperation(db, {
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId ?? "unknown-task",
        type: "reset",
        baseCheckpointId: input.baseCheckpointId,
        oldSessionId: checkpoint.sessionId,
        newSessionId: resetSession.id,
        host: "southstar-native",
        status: "succeeded",
        fallbackUsed: false,
      });
      return decision;
    },
    rollback(input) {
      const checkpoint = requireCheckpointForRun(db, input.checkpointId, input.runId);
      const decision = persistRecoveryDecision(db, {
        id: `recovery-${randomUUID()}`,
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId,
        sessionId: checkpoint.sessionId,
        strategy: "rollback-workspace",
        reason: input.reason,
        restoredCheckpointId: input.checkpointId,
      });
      recordSessionOperation(db, {
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId ?? "unknown-task",
        type: "replay",
        baseCheckpointId: input.checkpointId,
        oldSessionId: checkpoint.sessionId,
        newSessionId: checkpoint.sessionId,
        host: "southstar-native",
        status: "succeeded",
        fallbackUsed: false,
      });
      return decision;
    },
  };
}

function persistSessionNode(db: SouthstarDb, node: SessionNode): SessionNode {
  requireWorkflowRun(db, node.runId);
  upsertRuntimeResource(db, {
    id: node.id,
    resourceType: "session_node",
    resourceKey: node.id,
    runId: node.runId,
    taskId: node.taskId,
    sessionId: node.id,
    scope: "session",
    status: "active",
    title: "Session node",
    payload: node,
    summary: {
      roleRef: node.roleRef,
      agentProfileRef: node.agentProfileRef,
      parentSessionId: node.parentSessionId,
      baseCheckpointId: node.baseCheckpointId,
    },
  });
  upsertRuntimeResource(db, {
    id: `session-resource-${node.id}`,
    resourceType: "session",
    resourceKey: node.id,
    runId: node.runId,
    taskId: node.taskId,
    sessionId: node.id,
    scope: "session",
    status: "active",
    title: "Session",
    payload: node,
  });
  appendHistoryEvent(db, {
    runId: node.runId,
    taskId: node.taskId,
    sessionId: node.id,
    eventType: "session.created",
    actorType: "orchestrator",
    payload: { sessionId: node.id, parentSessionId: node.parentSessionId, baseCheckpointId: node.baseCheckpointId },
  });
  return node;
}

function persistRecoveryDecision(db: SouthstarDb, decision: RecoveryDecision): RecoveryDecision {
  requireWorkflowRun(db, decision.runId);
  upsertRuntimeResource(db, {
    id: decision.id,
    resourceType: "recovery_decision",
    resourceKey: decision.id,
    runId: decision.runId,
    taskId: decision.taskId,
    sessionId: decision.sessionId,
    scope: "session",
    status: "recorded",
    title: "Recovery decision",
    payload: decision,
    summary: { strategy: decision.strategy, reason: decision.reason },
  });
  appendHistoryEvent(db, {
    runId: decision.runId,
    taskId: decision.taskId,
    sessionId: decision.sessionId,
    eventType: "recovery.decision",
    actorType: "root-session",
    payload: decision,
  });
  return decision;
}

function requireWorkflowRun(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select 1 from workflow_runs where id = ?").get(runId);
  if (!row) throw new Error(`unknown workflow run: ${runId}`);
}

function requireCheckpoint(db: SouthstarDb, checkpointId: string): SessionCheckpoint {
  const resource = getResourceByKey(db, "session_checkpoint", checkpointId);
  if (!resource) throw new Error(`session checkpoint not found: ${checkpointId}`);
  return resource.payload as SessionCheckpoint;
}

function requireCheckpointForRun(db: SouthstarDb, checkpointId: string, runId: string): SessionCheckpoint {
  const checkpoint = requireCheckpoint(db, checkpointId);
  if (checkpoint.runId !== runId) {
    throw new Error(`checkpoint ${checkpointId} does not belong to workflow run ${runId}`);
  }
  return checkpoint;
}

function readSessionNode(db: SouthstarDb, sessionId: string): SessionNode | undefined {
  return getResourceByKey(db, "session_node", sessionId)?.payload as SessionNode | undefined;
}
