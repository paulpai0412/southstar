import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  appendHistoryEventOncePg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
  type RuntimeResourceRecord,
} from "../stores/postgres-runtime-store.ts";
import type {
  RecoveryExecutionProviderAction,
  RecoveryExecutionStateChange,
  RecoveryPath,
} from "../exceptions/types.ts";

export type SessionRecoveryOperationPath = Extract<RecoveryPath, "fork-session" | "reset-session" | "rollback-session">;

export type ApplySessionRecoveryOperationInput = {
  operationId: string;
  runId: string;
  taskId: string;
  path: SessionRecoveryOperationPath;
  approved: boolean;
  checkpointId?: string;
  workspaceSnapshotRef?: string;
  invalidatedSourceRefs?: string[];
  reason: string;
  now?: string;
};

export type SessionRecoveryOperationResult = {
  status: "succeeded" | "waiting_operator_approval";
  operationId: string;
  operationResourceKey: string;
  operationResourceType: "session_fork" | "session_reset" | "session_rollback";
  newRootSessionId?: string;
  previousRootSessionId?: string;
  rollbackMarkerRef?: string;
  stateChanges: RecoveryExecutionStateChange[];
  providerActions: RecoveryExecutionProviderAction[];
};

const ROLLBACK_MARKER_SCHEMA_VERSION = "southstar.session_recovery.rollback_marker.v1";

export async function applySessionRecoveryOperationPg(
  db: SouthstarDb,
  input: ApplySessionRecoveryOperationInput,
): Promise<SessionRecoveryOperationResult> {
  const now = input.now ?? new Date().toISOString();
  assertSupportedSessionPath(input.path);
  assertNonEmpty(input.operationId, "operationId");
  assertNonEmpty(input.runId, "runId");
  assertNonEmpty(input.taskId, "taskId");
  assertNonEmpty(input.reason, "reason");
  if (input.path === "rollback-session" && !input.workspaceSnapshotRef) {
    throw new Error("rollback-session requires workspaceSnapshotRef");
  }

  const operationResourceType = operationResourceTypeForPath(input.path);
  const operationResourceKey = `${operationResourceType}:${input.operationId}`;
  const operationHash = stableHash(input.operationId);
  const newRootSessionId = `root-${input.runId}-${input.taskId}-${input.path}-${operationHash.slice(0, 10)}`;
  const rollbackMarkerRef = input.path === "rollback-session" ? `rollback_marker:${input.operationId}` : undefined;

  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const task = await tx.maybeOne<{ status: string; completed_at: Date | string | null; root_session_id: string | null }>(
      `select status, completed_at, root_session_id
         from southstar.workflow_tasks
        where run_id = $1
          and id = $2
        for update`,
      [input.runId, input.taskId],
    );
    if (!task) throw new Error(`workflow task ${input.taskId} does not belong to run ${input.runId}`);
    const previousTaskStatus = task.status;

    const existing = await getResourceByKeyPg(tx, operationResourceType, operationResourceKey);
    if (existing?.status === "succeeded") {
      const payload = isPlainObject(existing.payload) ? existing.payload : {};
      return {
        status: "succeeded",
        operationId: input.operationId,
        operationResourceType,
        operationResourceKey,
        previousRootSessionId: stringValue(payload.previousRootSessionId) ?? task.root_session_id ?? undefined,
        newRootSessionId: stringValue(payload.newRootSessionId) ?? newRootSessionId,
        rollbackMarkerRef: stringValue(payload.rollbackMarkerRef) ?? rollbackMarkerRef,
        stateChanges: sessionOperationStateChanges({
          input,
          taskStatus: stringValue(payload.previousTaskStatus) ?? previousTaskStatus,
          operationResourceKey,
          operationResourceType,
          rollbackMarkerRef: stringValue(payload.rollbackMarkerRef) ?? rollbackMarkerRef,
        }),
        providerActions: [],
      };
    }

    if (input.path === "rollback-session" && !input.approved) {
      await upsertRuntimeResourcePg(tx, {
        resourceType: operationResourceType,
        resourceKey: operationResourceKey,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: task.root_session_id ?? undefined,
        scope: "session-recovery",
        status: "waiting_operator_approval",
        title: "Rollback session recovery operation",
        payload: operationPayload({
          ...input,
          now,
          operationResourceKey,
          previousTaskStatus,
          previousRootSessionId: task.root_session_id ?? undefined,
          newRootSessionId,
          rollbackMarkerRef,
        }),
        summary: operationSummary(input, now),
      });
      return {
        status: "waiting_operator_approval",
        operationId: input.operationId,
        operationResourceType,
        operationResourceKey,
        previousRootSessionId: task.root_session_id ?? undefined,
        stateChanges: [],
        providerActions: [],
      };
    }

    if (input.path === "rollback-session") {
      await upsertRollbackMarkerPg(tx, {
        input,
        markerRef: requireString(rollbackMarkerRef),
        markerId: `rollback-marker-${operationHash.slice(0, 16)}`,
        now,
      });
    }

    await upsertRuntimeResourcePg(tx, {
      resourceType: operationResourceType,
      resourceKey: operationResourceKey,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: newRootSessionId,
      scope: "session-recovery",
      status: "succeeded",
      title: `${input.path} recovery operation`,
      payload: operationPayload({
        ...input,
        now,
        operationResourceKey,
        previousTaskStatus,
        previousRootSessionId: task.root_session_id ?? undefined,
        newRootSessionId,
        rollbackMarkerRef,
      }),
      summary: operationSummary(input, now),
    });

    await tx.query(
      `update southstar.workflow_tasks
          set status = 'pending',
              root_session_id = $1,
              completed_at = null,
              updated_at = now()
        where run_id = $2
          and id = $3`,
      [newRootSessionId, input.runId, input.taskId],
    );

    await appendHistoryEventOncePg(tx, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: newRootSessionId,
      eventType: sessionEventType(input.path),
      actorType: "orchestrator",
      idempotencyKey: `${operationResourceKey}:applied`,
      payload: operationHistoryPayload({
        ...input,
        now,
        previousTaskStatus,
        previousRootSessionId: task.root_session_id ?? undefined,
        newRootSessionId,
        rollbackMarkerRef,
      }),
    });

    return {
      status: "succeeded",
      operationId: input.operationId,
      operationResourceType,
      operationResourceKey,
      previousRootSessionId: task.root_session_id ?? undefined,
      newRootSessionId,
      rollbackMarkerRef,
      stateChanges: sessionOperationStateChanges({
        input,
        taskStatus: previousTaskStatus,
        operationResourceKey,
        operationResourceType,
        rollbackMarkerRef,
      }),
      providerActions: [],
    };
  });
}

function operationPayload(
  input: ApplySessionRecoveryOperationInput & {
    now: string;
    operationResourceKey: string;
    previousTaskStatus: string;
    previousRootSessionId?: string;
    newRootSessionId: string;
    rollbackMarkerRef?: string;
  },
): Record<string, unknown> {
  return {
    schemaVersion: "southstar.session_recovery.operation.v1",
    operationId: input.operationId,
    operationResourceKey: input.operationResourceKey,
    runId: input.runId,
    taskId: input.taskId,
    path: input.path,
    checkpointId: input.checkpointId,
    workspaceSnapshotRef: input.workspaceSnapshotRef,
    invalidatedSourceRefs: input.invalidatedSourceRefs ?? [],
    previousTaskStatus: input.previousTaskStatus,
    previousRootSessionId: input.previousRootSessionId,
    newRootSessionId: input.newRootSessionId,
    rollbackMarkerRef: input.rollbackMarkerRef,
    reason: input.reason,
    appliedAt: input.now,
  };
}

function operationHistoryPayload(
  input: ApplySessionRecoveryOperationInput & {
    now: string;
    previousRootSessionId?: string;
    newRootSessionId: string;
    rollbackMarkerRef?: string;
  },
): Record<string, unknown> {
  return {
    operationId: input.operationId,
    path: input.path,
    runId: input.runId,
    taskId: input.taskId,
    checkpointId: input.checkpointId,
    previousRootSessionId: input.previousRootSessionId,
    newRootSessionId: input.newRootSessionId,
    workspaceSnapshotRef: input.workspaceSnapshotRef,
    rollbackMarkerRef: input.rollbackMarkerRef,
    invalidatedSourceRefs: input.invalidatedSourceRefs ?? [],
    reason: input.reason,
    appliedAt: input.now,
  };
}

function operationSummary(input: ApplySessionRecoveryOperationInput, now: string): Record<string, unknown> {
  return {
    path: input.path,
    checkpointId: input.checkpointId,
    workspaceSnapshotRef: input.workspaceSnapshotRef,
    reason: input.reason,
    appliedAt: now,
  };
}

async function upsertRollbackMarkerPg(
  db: SouthstarDb,
  input: {
    input: ApplySessionRecoveryOperationInput;
    markerRef: string;
    markerId: string;
    now: string;
  },
): Promise<RuntimeResourceRecord> {
  await upsertRuntimeResourcePg(db, {
    id: input.markerId,
    resourceType: "rollback_marker",
    resourceKey: input.markerRef,
    runId: input.input.runId,
    taskId: input.input.taskId,
    scope: "session-recovery",
    status: "recorded",
    title: "Session rollback marker",
    payload: {
      schemaVersion: ROLLBACK_MARKER_SCHEMA_VERSION,
      markerId: input.markerId,
      operationId: input.input.operationId,
      runId: input.input.runId,
      taskId: input.input.taskId,
      checkpointId: input.input.checkpointId,
      workspaceSnapshotRef: input.input.workspaceSnapshotRef,
      invalidatedSourceRefs: input.input.invalidatedSourceRefs ?? [],
      reason: input.input.reason,
      createdAt: input.now,
    },
    summary: {
      operationId: input.input.operationId,
      checkpointId: input.input.checkpointId,
      workspaceSnapshotRef: input.input.workspaceSnapshotRef,
      invalidatedSourceRefCount: input.input.invalidatedSourceRefs?.length ?? 0,
    },
  });
  return requireResource(await getResourceByKeyPg(db, "rollback_marker", input.markerRef));
}

function sessionOperationStateChanges(input: {
  input: ApplySessionRecoveryOperationInput;
  taskStatus: string;
  operationResourceKey: string;
  operationResourceType: SessionRecoveryOperationResult["operationResourceType"];
  rollbackMarkerRef?: string;
}): RecoveryExecutionStateChange[] {
  return [
    ...(input.rollbackMarkerRef
      ? [{
        resourceType: "rollback_marker",
        resourceKey: input.rollbackMarkerRef,
        toStatus: "recorded",
        reason: input.input.path,
      }]
      : []),
    {
      resourceType: input.operationResourceType,
      resourceKey: input.operationResourceKey,
      toStatus: "succeeded",
      reason: input.input.path,
    },
    {
      resourceType: "workflow_task",
      resourceKey: `${input.input.runId}:${input.input.taskId}`,
      fromStatus: input.taskStatus,
      toStatus: "pending",
      reason: input.input.path,
    },
  ];
}

function operationResourceTypeForPath(path: SessionRecoveryOperationPath): SessionRecoveryOperationResult["operationResourceType"] {
  if (path === "fork-session") return "session_fork";
  if (path === "reset-session") return "session_reset";
  return "session_rollback";
}

function sessionEventType(path: SessionRecoveryOperationPath): "session.fork" | "session.reset" | "session.rollback" {
  if (path === "fork-session") return "session.fork";
  if (path === "reset-session") return "session.reset";
  return "session.rollback";
}

function assertSupportedSessionPath(path: RecoveryPath): asserts path is SessionRecoveryOperationPath {
  if (path !== "fork-session" && path !== "reset-session" && path !== "rollback-session") {
    throw new Error(`unsupported session recovery path ${path}`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
}

function requireString(value: string | undefined): string {
  if (!value) throw new Error("required string is missing");
  return value;
}

function requireResource(value: RuntimeResourceRecord | null): RuntimeResourceRecord {
  if (!value) throw new Error("runtime resource not found");
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
