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
const RECOVERY_PROVIDER_ACTION_NAME_SET = new Set(["poll", "cancel", "destroy", "provision", "snapshot", "rollback", "wake"]);
const RECOVERY_PROVIDER_ACTION_STATUS_SET = new Set(["requested", "succeeded", "failed", "skipped"]);

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
    if (input.taskId) {
      const task = await tx.maybeOne<{ id: string }>(
        "select id from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
        [input.runId, input.taskId],
      );
      if (!task) {
        throw new Error(`workflow task ${input.taskId} does not belong to run ${input.runId}`);
      }
    }
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
  assertTerminalRecoveryExecutionStatus(input.status);

  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const current = requireRecoveryExecutionRecord(
      await getResourceByKeyPg(tx, RECOVERY_EXECUTION_RESOURCE_TYPE, input.executionResourceKey),
    );
    if (current.payload.runId !== input.runId) {
      throw new Error(`recovery execution ${input.executionResourceKey} does not belong to run ${input.runId}`);
    }
    if (current.status !== "started") {
      if (!isIdempotentTerminalCompletion(current, input)) {
        throw new Error(`recovery execution ${input.executionResourceKey} already completed with a different result`);
      }
      return current;
    }
    assertValidRecoveryExecutionStateChanges(input.stateChanges);
    assertValidRecoveryExecutionProviderActions(input.providerActions);

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
    !isValidRecoveryExecutionStateChanges(payload.stateChanges) ||
    !isValidRecoveryExecutionProviderActions(payload.providerActions) ||
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

function assertTerminalRecoveryExecutionStatus(status: unknown): void {
  if (String(status) === "started") {
    throw new Error("terminal recovery execution status cannot be started");
  }
}

function isRecoveryPath(value: unknown): value is RecoveryPath {
  return typeof value === "string" && RECOVERY_PATH_SET.has(value as RecoveryPath);
}

function assertValidRecoveryExecutionStateChanges(value: unknown): asserts value is RecoveryExecutionStateChange[] {
  if (!isValidRecoveryExecutionStateChanges(value)) {
    throw new Error("invalid recovery execution state change");
  }
}

function isValidRecoveryExecutionStateChanges(value: unknown): value is RecoveryExecutionStateChange[] {
  return Array.isArray(value) && value.every(isValidRecoveryExecutionStateChange);
}

function isValidRecoveryExecutionStateChange(value: unknown): value is RecoveryExecutionStateChange {
  if (!isPlainObject(value)) return false;
  return (
    isNonEmptyString(value.resourceType) &&
    isNonEmptyString(value.resourceKey) &&
    isNonEmptyString(value.reason) &&
    (value.fromStatus === undefined || typeof value.fromStatus === "string") &&
    (value.toStatus === undefined || typeof value.toStatus === "string")
  );
}

function assertValidRecoveryExecutionProviderActions(value: unknown): asserts value is RecoveryExecutionProviderAction[] {
  if (!isValidRecoveryExecutionProviderActions(value)) {
    throw new Error("invalid recovery execution provider action");
  }
}

function isValidRecoveryExecutionProviderActions(value: unknown): value is RecoveryExecutionProviderAction[] {
  return Array.isArray(value) && value.every(isValidRecoveryExecutionProviderAction);
}

function isValidRecoveryExecutionProviderAction(value: unknown): value is RecoveryExecutionProviderAction {
  if (!isPlainObject(value)) return false;
  return (
    isNonEmptyString(value.providerId) &&
    typeof value.action === "string" &&
    RECOVERY_PROVIDER_ACTION_NAME_SET.has(value.action) &&
    typeof value.status === "string" &&
    RECOVERY_PROVIDER_ACTION_STATUS_SET.has(value.status) &&
    (value.evidenceRef === undefined || typeof value.evidenceRef === "string") &&
    (value.errorExcerpt === undefined || typeof value.errorExcerpt === "string")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIdempotentTerminalCompletion(
  current: RecoveryExecutionRecord,
  input: CompleteRecoveryExecutionInput,
): boolean {
  return (
    input.status === current.status &&
    input.completedAt === current.payload.completedAt &&
    sameJson(input.stateChanges, current.payload.stateChanges) &&
    sameJson(input.providerActions, current.payload.providerActions)
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

function toStableJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const stable = toStableJsonValue(item);
      return stable === undefined ? null : stable;
    });
  }
  if (typeof value === "object") {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return toStableJsonValue((value as { toJSON: () => unknown }).toJSON());
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const stable = toStableJsonValue(record[key]);
      if (stable !== undefined) output[key] = stable;
    }
    return output;
  }
  return undefined;
}
