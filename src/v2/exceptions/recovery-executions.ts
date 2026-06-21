import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  appendHistoryEventPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
  type RuntimeResourceRecord,
} from "../stores/postgres-runtime-store.ts";
import {
  RECOVERY_EXECUTION_RESOURCE_TYPE,
  RECOVERY_EXECUTION_SCHEMA_VERSION,
  type RecoveryExecutionPayload,
  type RecoveryExecutionProviderAction,
  type RecoveryExecutionRecord,
  type RecoveryExecutionStateChange,
  type RecoveryExecutionStatus,
  type RecoveryPath,
} from "./types.ts";

const RECOVERY_EXECUTION_STATUS_SET = new Set<RecoveryExecutionStatus>(["started", "succeeded", "failed", "superseded", "blocked"]);
const RECOVERY_PATH_SET = new Set<RecoveryPath>([
  "none-observe-only",
  "requeue-hand-execution",
  "reprovision-hand",
  "wake-new-brain",
  "retry-same-task-new-attempt",
  "repair-artifact",
  "rollback-workspace",
  "block-for-operator",
  "fail-task",
  "fail-run",
]);

type StartRecoveryExecutionInput = {
  decisionId: string;
  exceptionId: string;
  runId: string;
  taskId?: string;
  path: RecoveryPath;
  now: string;
};

type CompleteRecoveryExecutionInput = {
  runId: string;
  executionResourceKey: string;
  status: Exclude<RecoveryExecutionStatus, "started">;
  completedAt: string;
  stateChanges: RecoveryExecutionStateChange[];
  providerActions: RecoveryExecutionProviderAction[];
};

export async function startRecoveryExecutionPg(
  db: SouthstarDb,
  input: StartRecoveryExecutionInput,
): Promise<RecoveryExecutionRecord> {
  const resourceKey = recoveryExecutionResourceKey(input.decisionId);
  const executionId = recoveryExecutionId(resourceKey);

  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const existing = toRecoveryExecutionRecord(await getResourceByKeyPg(tx, RECOVERY_EXECUTION_RESOURCE_TYPE, resourceKey));
    if (existing) {
      if (
        existing.payload.runId !== input.runId ||
        existing.payload.exceptionId !== input.exceptionId ||
        existing.payload.path !== input.path ||
        existing.payload.taskId !== input.taskId
      ) {
        throw new Error(`recovery execution ${resourceKey} conflicts with requested start input`);
      }
      await appendStartedHistoryOncePg(tx, existing);
      return existing;
    }

    const payload: RecoveryExecutionPayload = {
      schemaVersion: RECOVERY_EXECUTION_SCHEMA_VERSION,
      executionId,
      decisionId: input.decisionId,
      exceptionId: input.exceptionId,
      runId: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      path: input.path,
      status: "started",
      stateChanges: [],
      providerActions: [],
      createdAt: input.now,
    };

    await upsertRuntimeResourcePg(tx, {
      id: executionId,
      resourceType: RECOVERY_EXECUTION_RESOURCE_TYPE,
      resourceKey,
      runId: input.runId,
      taskId: input.taskId,
      scope: "recovery",
      status: "started",
      title: `${input.path} recovery execution`,
      payload,
      summary: {
        decisionId: input.decisionId,
        exceptionId: input.exceptionId,
        path: input.path,
        startedAt: input.now,
      },
    });

    const record = requireRecoveryExecutionRecord(await getResourceByKeyPg(tx, RECOVERY_EXECUTION_RESOURCE_TYPE, resourceKey));
    await appendStartedHistoryOncePg(tx, record);
    return record;
  });
}

export async function completeRecoveryExecutionPg(
  db: SouthstarDb,
  input: CompleteRecoveryExecutionInput,
): Promise<RecoveryExecutionRecord> {
  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const current = requireRecoveryExecutionRecord(
      await getResourceByKeyPg(tx, RECOVERY_EXECUTION_RESOURCE_TYPE, input.executionResourceKey),
    );
    if (current.payload.runId !== input.runId) {
      throw new Error(`recovery execution ${input.executionResourceKey} does not belong to run ${input.runId}`);
    }
    if (current.status !== "started") return current;

    const payload: RecoveryExecutionPayload = {
      ...current.payload,
      status: input.status,
      stateChanges: input.stateChanges,
      providerActions: input.providerActions,
      completedAt: input.completedAt,
    };

    await upsertRuntimeResourcePg(tx, {
      id: current.executionId,
      resourceType: RECOVERY_EXECUTION_RESOURCE_TYPE,
      resourceKey: current.resourceKey,
      runId: current.payload.runId,
      taskId: current.payload.taskId,
      scope: "recovery",
      status: input.status,
      title: `${current.payload.path} recovery execution`,
      payload,
      summary: {
        decisionId: current.payload.decisionId,
        exceptionId: current.payload.exceptionId,
        path: current.payload.path,
        completedAt: input.completedAt,
        stateChangeCount: input.stateChanges.length,
        providerActionCount: input.providerActions.length,
      },
    });

    const record = requireRecoveryExecutionRecord(
      await getResourceByKeyPg(tx, RECOVERY_EXECUTION_RESOURCE_TYPE, input.executionResourceKey),
    );
    await appendTerminalHistoryOncePg(tx, record);
    return record;
  });
}

export function recoveryExecutionResourceKey(decisionId: string): string {
  return `recovery_execution:${decisionId}:attempt-1`;
}

function recoveryExecutionId(resourceKey: string): string {
  return `recovery-execution-${createHash("sha256").update(resourceKey).digest("hex").slice(0, 24)}`;
}

async function appendStartedHistoryOncePg(db: SouthstarDb, record: RecoveryExecutionRecord): Promise<void> {
  await appendHistoryEventOncePg(db, {
    runId: record.payload.runId,
    taskId: record.payload.taskId,
    eventType: "recovery_execution.started",
    idempotencyKey: `${record.resourceKey}:started`,
    payload: {
      executionId: record.executionId,
      decisionId: record.payload.decisionId,
      exceptionId: record.payload.exceptionId,
      resourceKey: record.resourceKey,
      path: record.payload.path,
      startedAt: record.payload.createdAt,
    },
  });
}

async function appendTerminalHistoryOncePg(db: SouthstarDb, record: RecoveryExecutionRecord): Promise<void> {
  await appendHistoryEventOncePg(db, {
    runId: record.payload.runId,
    taskId: record.payload.taskId,
    eventType: `recovery_execution.${record.status}`,
    idempotencyKey: `${record.resourceKey}:${record.status}`,
    payload: {
      executionId: record.executionId,
      decisionId: record.payload.decisionId,
      exceptionId: record.payload.exceptionId,
      resourceKey: record.resourceKey,
      path: record.payload.path,
      status: record.status,
      completedAt: record.payload.completedAt,
      stateChanges: record.payload.stateChanges,
      providerActions: record.payload.providerActions,
    },
  });
}

async function appendHistoryEventOncePg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId?: string;
    eventType: string;
    idempotencyKey: string;
    payload: unknown;
  },
): Promise<void> {
  await db.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.runId, input.idempotencyKey],
  );
  if (existing) return;

  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: input.eventType,
    actorType: "orchestrator",
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  });
}

function requireRecoveryExecutionRecord(resource: RuntimeResourceRecord | null): RecoveryExecutionRecord {
  const record = toRecoveryExecutionRecord(resource);
  if (!record) throw new Error("recovery execution not found");
  return record;
}

function toRecoveryExecutionRecord(resource: RuntimeResourceRecord | null): RecoveryExecutionRecord | null {
  if (!resource) return null;
  const payload = resource.payload as Partial<RecoveryExecutionPayload>;
  const resourceStatus = resource.status;
  const payloadStatus = payload.status;
  if (
    resource.resourceType !== RECOVERY_EXECUTION_RESOURCE_TYPE ||
    typeof payload.executionId !== "string" ||
    typeof payload.decisionId !== "string" ||
    typeof payload.exceptionId !== "string" ||
    typeof payload.runId !== "string" ||
    (payload.taskId !== undefined && typeof payload.taskId !== "string") ||
    payload.schemaVersion !== RECOVERY_EXECUTION_SCHEMA_VERSION ||
    !isRecoveryPath(payload.path) ||
    !isRecoveryExecutionStatus(resourceStatus) ||
    !isRecoveryExecutionStatus(payloadStatus) ||
    payloadStatus !== resourceStatus ||
    !Array.isArray(payload.stateChanges) ||
    !Array.isArray(payload.providerActions) ||
    typeof payload.createdAt !== "string"
  ) {
    return null;
  }

  return {
    executionId: payload.executionId,
    resourceKey: resource.resourceKey,
    status: resourceStatus,
    payload: payload as RecoveryExecutionPayload,
  };
}

function isRecoveryExecutionStatus(value: unknown): value is RecoveryExecutionStatus {
  return typeof value === "string" && RECOVERY_EXECUTION_STATUS_SET.has(value as RecoveryExecutionStatus);
}

function isRecoveryPath(value: unknown): value is RecoveryPath {
  return typeof value === "string" && RECOVERY_PATH_SET.has(value as RecoveryPath);
}
