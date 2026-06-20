// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { getResourceByKey, upsertRuntimeResource } from "../stores/resource-store.ts";
import { estimateTokens } from "./telemetry.ts";
import type { SessionCheckpointV1 } from "./types.ts";
import { validateSessionCheckpoint } from "./types.ts";

export type CreateSessionCheckpointInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  kind: SessionCheckpointV1["kind"];
  createdBy: SessionCheckpointV1["createdBy"];
  contextPacketId?: string;
  taskEnvelopeId?: string;
  artifactRefs?: string[];
  evidencePacketRefs?: string[];
  validatorResultRefs?: string[];
  workspaceSnapshotRef?: string;
  hostSessionAnchor?: SessionCheckpointV1["hostSessionAnchor"];
  checkpointSummary: string;
  decisions?: string[];
  filesTouched?: string[];
  filesInspected?: string[];
  failureSummary?: string;
  attemptedApproach?: string;
  nextAttemptHint?: string;
  contextTokenEstimate?: number;
  failureSuffixTokenEstimate?: number;
  policy?: Partial<SessionCheckpointV1["policy"]>;
};

export function createSessionCheckpoint(db: SouthstarDb, input: CreateSessionCheckpointInput): SessionCheckpointV1 {
  requireRun(db, input.runId);
  const checkpointId = `checkpoint-${input.runId}-${input.taskId}-${input.kind}-${randomUUID()}`;
  const checkpoint = validateSessionCheckpoint({
    schemaVersion: "southstar.session-checkpoint.v1",
    checkpointId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    kind: input.kind,
    createdBy: input.createdBy,
    contextPacketId: input.contextPacketId,
    taskEnvelopeId: input.taskEnvelopeId,
    artifactRefs: input.artifactRefs ?? [],
    evidencePacketRefs: input.evidencePacketRefs ?? [],
    validatorResultRefs: input.validatorResultRefs ?? [],
    workspaceSnapshotRef: input.workspaceSnapshotRef,
    hostSessionAnchor: input.hostSessionAnchor,
    summaries: {
      checkpointSummary: input.checkpointSummary,
      decisions: input.decisions ?? [],
      filesTouched: input.filesTouched ?? [],
      filesInspected: input.filesInspected ?? [],
      failureSummary: input.failureSummary,
      attemptedApproach: input.attemptedApproach,
      nextAttemptHint: input.nextAttemptHint,
    },
    tokenTelemetry: {
      contextTokenEstimate: input.contextTokenEstimate ?? estimateTokens(input.checkpointSummary),
      checkpointSummaryTokenEstimate: estimateTokens(input.checkpointSummary),
      failureSuffixTokenEstimate: input.failureSuffixTokenEstimate,
    },
    policy: {
      safeForAutoRetry: input.policy?.safeForAutoRetry ?? false,
      safeForFork: input.policy?.safeForFork ?? false,
      safeForReset: input.policy?.safeForReset ?? false,
      safeForWorkspaceRollback: input.policy?.safeForWorkspaceRollback ?? false,
    },
  });

  upsertRuntimeResource(db, {
    id: checkpointId,
    resourceType: "session_checkpoint",
    resourceKey: checkpointId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "session",
    status: "created",
    title: `${input.kind} checkpoint`,
    payload: checkpoint,
    summary: {
      kind: input.kind,
      checkpointSummary: input.checkpointSummary,
      artifactRefs: checkpoint.artifactRefs,
      tokenTelemetry: checkpoint.tokenTelemetry,
    },
  });

  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "checkpoint.created",
    actorType: input.createdBy,
    payload: { checkpointId, kind: input.kind, contextPacketId: input.contextPacketId },
  });

  return checkpoint;
}

export function getSessionCheckpoint(db: SouthstarDb, checkpointId: string): SessionCheckpointV1 | null {
  const resource = getResourceByKey(db, "session_checkpoint", checkpointId);
  if (!resource) return null;
  return validateSessionCheckpoint(resource.payload as SessionCheckpointV1);
}

function requireRun(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select 1 from workflow_runs where id = ?").get(runId);
  if (!row) throw new Error(`unknown workflow run: ${runId}`);
}
