import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, getResourceByKeyPg, listResourcesPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { ExecutorBindingPayload, SouthstarExecutorStatus } from "./observability-types.ts";

export type ExecutorBindingRecordPg = {
  id: string;
  runId: string;
  taskId: string;
  payload: ExecutorBindingPayload;
  status: SouthstarExecutorStatus;
};

export async function createExecutorBindingPg(db: SouthstarDb, input: {
  runId: string;
  taskId: string;
  attemptId: string;
  torkJobId: string;
  torkTaskId?: string;
  status: SouthstarExecutorStatus;
  now?: string;
  queueTimeoutSeconds: number;
  hardTimeoutSeconds: number;
}): Promise<ExecutorBindingRecordPg> {
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

  const { id: persistedId } = await upsertRuntimeResourcePg(db, {
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

  await appendHistoryEventPg(db, {
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

  return { id: persistedId, runId: input.runId, taskId: input.taskId, payload, status: input.status };
}

export async function listExecutorBindingsForRunPg(db: SouthstarDb, runId: string): Promise<ExecutorBindingRecordPg[]> {
  const resources = await listResourcesPg(db, { resourceType: "executor_binding" });
  return resources
    .filter((resource) => resource.runId === runId)
    .map(toRecord)
    .filter((binding): binding is ExecutorBindingRecordPg => Boolean(binding));
}

export async function getExecutorBindingPg(db: SouthstarDb, bindingId: string): Promise<ExecutorBindingRecordPg | null> {
  const resource = await getResourceByKeyPg(db, "executor_binding", bindingId);
  return resource ? toRecord(resource) : null;
}

export async function updateExecutorBindingStatusPg(db: SouthstarDb, input: {
  bindingId: string;
  status: SouthstarExecutorStatus;
  eventType: string;
  payloadPatch?: Partial<ExecutorBindingPayload>;
  eventPayload?: Record<string, unknown>;
}): Promise<ExecutorBindingRecordPg> {
  const current = await getExecutorBindingPg(db, input.bindingId);
  if (!current) throw new Error(`executor binding not found: ${input.bindingId}`);

  const payload: ExecutorBindingPayload = {
    ...current.payload,
    ...(input.payloadPatch ?? {}),
    southstarExecutorStatus: input.status,
  };

  const { id } = await upsertRuntimeResourcePg(db, {
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

  await appendHistoryEventPg(db, {
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

  return { id, runId: current.runId, taskId: current.taskId, status: input.status, payload };
}

function toRecord(resource: { id: string; runId: string | null; taskId: string | null; status: string; payload: unknown }): ExecutorBindingRecordPg | null {
  const payload = asRecord(resource.payload) as Partial<ExecutorBindingPayload>;
  if (!resource.runId || !resource.taskId || typeof payload.attemptId !== "string") return null;
  return {
    id: resource.id,
    runId: resource.runId,
    taskId: resource.taskId,
    payload: payload as ExecutorBindingPayload,
    status: resource.status as SouthstarExecutorStatus,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bindingId(runId: string, taskId: string, attemptId: string): string {
  return `executor-${runId}-${taskId}-${attemptId}`;
}
