import { appendHistoryEvent } from "../stores/history-store.ts";
import { listResources, type RuntimeResourceRecord, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type {
  ExecutorBindingPayload,
  SouthstarExecutorStatus,
} from "./observability-types.ts";

export type ExecutorBindingRecord = {
  id: string;
  runId: string;
  taskId: string;
  payload: ExecutorBindingPayload;
  status: SouthstarExecutorStatus;
};

export function createExecutorBinding(db: SouthstarDb, input: {
  runId: string;
  taskId: string;
  attemptId: string;
  torkJobId: string;
  torkTaskId?: string;
  status: SouthstarExecutorStatus;
  now?: string;
  queueTimeoutSeconds: number;
  hardTimeoutSeconds: number;
}): ExecutorBindingRecord {
  const nowIso = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const id = bindingId(input.runId, input.taskId, input.attemptId);
  const payload: ExecutorBindingPayload = {
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    executorType: "tork",
    torkJobId: input.torkJobId,
    ...(input.torkTaskId ? { torkTaskId: input.torkTaskId } : {}),
    southstarExecutorStatus: input.status,
    submittedAt: nowIso,
    queueTimeoutAt: new Date(nowMs + input.queueTimeoutSeconds * 1000).toISOString(),
    hardTimeoutAt: new Date(nowMs + input.hardTimeoutSeconds * 1000).toISOString(),
    reconcileGeneration: 0,
    idempotencyKey: `executor-binding:${input.runId}:${input.taskId}:${input.attemptId}`,
  };

  const { id: persistedId } = upsertRuntimeResource(db, {
    id,
    resourceType: "executor_binding",
    resourceKey: id,
    runId: input.runId,
    taskId: input.taskId,
    scope: "executor",
    status: input.status,
    title: `Tork binding ${input.taskId}`,
    payload,
    summary: {
      torkJobId: input.torkJobId,
      attemptId: input.attemptId,
      status: input.status,
    },
  });

  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: "executor.submitted",
    actorType: "orchestrator",
    idempotencyKey: payload.idempotencyKey,
    payload: {
      bindingId: persistedId,
      torkJobId: input.torkJobId,
      status: input.status,
      attemptId: input.attemptId,
    },
  });

  return {
    id: persistedId,
    runId: input.runId,
    taskId: input.taskId,
    payload,
    status: input.status,
  };
}

export function listExecutorBindingsForRun(db: SouthstarDb, runId: string): ExecutorBindingRecord[] {
  return listResources(db, { resourceType: "executor_binding" })
    .filter((resource) => resource.runId === runId)
    .map(toRecord)
    .filter((binding): binding is ExecutorBindingRecord => Boolean(binding));
}

export function getExecutorBinding(db: SouthstarDb, bindingId: string): ExecutorBindingRecord | null {
  const resource = listResources(db, { resourceType: "executor_binding" })
    .find((candidate) => candidate.id === bindingId || candidate.resourceKey === bindingId);
  if (!resource) return null;
  return toRecord(resource);
}

export function updateExecutorBindingStatus(db: SouthstarDb, input: {
  bindingId: string;
  status: SouthstarExecutorStatus;
  eventType: string;
  payloadPatch?: Partial<ExecutorBindingPayload>;
  eventPayload?: Record<string, unknown>;
}): ExecutorBindingRecord {
  const current = getExecutorBinding(db, input.bindingId);
  if (!current) throw new Error(`executor binding not found: ${input.bindingId}`);

  const payload: ExecutorBindingPayload = {
    ...current.payload,
    ...(input.payloadPatch ?? {}),
    southstarExecutorStatus: input.status,
  };

  const { id } = upsertRuntimeResource(db, {
    id: current.id,
    resourceType: "executor_binding",
    resourceKey: current.id,
    runId: current.runId,
    taskId: current.taskId,
    scope: "executor",
    status: input.status,
    title: `Tork binding ${current.taskId}`,
    payload,
    summary: {
      torkJobId: payload.torkJobId,
      status: input.status,
      runnerPhase: payload.runnerPhase ?? "no-heartbeat-yet",
    },
  });

  appendHistoryEvent(db, {
    runId: current.runId,
    taskId: current.taskId,
    eventType: input.eventType,
    actorType: "orchestrator",
    payload: {
      bindingId: id,
      status: input.status,
      ...(input.eventPayload ?? {}),
    },
  });

  return {
    id,
    runId: current.runId,
    taskId: current.taskId,
    status: input.status,
    payload,
  };
}

function toRecord(resource: RuntimeResourceRecord): ExecutorBindingRecord | null {
  const payload = resource.payload as Partial<ExecutorBindingPayload>;
  if (!resource.runId || !resource.taskId || typeof payload.attemptId !== "string") {
    return null;
  }
  return {
    id: resource.id,
    runId: resource.runId,
    taskId: resource.taskId,
    payload: payload as ExecutorBindingPayload,
    status: resource.status as SouthstarExecutorStatus,
  };
}

function bindingId(runId: string, taskId: string, attemptId: string): string {
  return `executor-${runId}-${taskId}-${attemptId}`;
}
