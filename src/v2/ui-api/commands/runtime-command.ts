import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../../db/postgres.ts";
import {
  appendHistoryEventOncePg,
  getResourceByKeyPg,
} from "../../stores/postgres-runtime-store.ts";

export type RuntimeCommandActor = { type: "user" | "system" | "root-session"; id?: string };

export type RuntimeCommandRequest = {
  commandId: string;
  actor: RuntimeCommandActor;
  reason?: string;
  dryRun?: boolean;
  payload?: Record<string, unknown>;
};

export type RuntimeCommandStatus = "applied" | "queued" | "blocked" | "rejected" | "noop";

export type RuntimeCommandResourceRef = { resourceType: string; resourceKey: string };

export type RuntimeCommandEventRef = { runId: string; sequence: number; eventType: string };

export type RuntimeCommandResult = {
  commandId: string;
  accepted: boolean;
  status: RuntimeCommandStatus;
  affectedRunId?: string;
  affectedTaskId?: string;
  affectedSessionId?: string;
  resourceRefs: RuntimeCommandResourceRef[];
  eventRefs: RuntimeCommandEventRef[];
  nextSuggestedActions: string[];
  message?: string;
};

export type RecordRuntimeCommandInput = {
  commandId: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  action: string;
  actor: RuntimeCommandActor;
  reason?: string;
  status: RuntimeCommandStatus;
  resourceRefs?: RuntimeCommandResourceRef[];
  eventType: string;
  eventPayload?: unknown;
  eventSequence?: Array<{ eventType: string; eventPayload?: unknown }>;
  nextSuggestedActions?: string[];
  message?: string;
};

export function requireRuntimeCommandRequest(value: unknown): RuntimeCommandRequest {
  if (!isRecord(value)) throw new TypeError("runtime command request must be an object");
  const { commandId, actor, reason, dryRun, payload } = value;
  if (typeof commandId !== "string" || commandId.length === 0) {
    throw new TypeError("runtime command request commandId must be a non-empty string");
  }
  if (!isRuntimeCommandActor(actor)) {
    throw new TypeError("runtime command request actor must include a supported type");
  }
  if (reason !== undefined && typeof reason !== "string") {
    throw new TypeError("runtime command request reason must be a string");
  }
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    throw new TypeError("runtime command request dryRun must be a boolean");
  }
  if (payload !== undefined && !isRecord(payload)) {
    throw new TypeError("runtime command request payload must be an object");
  }
  return {
    commandId,
    actor,
    ...(reason !== undefined ? { reason } : {}),
    ...(dryRun !== undefined ? { dryRun } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
}

export async function recordRuntimeCommandPg(
  db: SouthstarDb,
  input: RecordRuntimeCommandInput,
): Promise<RuntimeCommandResult> {
  return await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [`runtime_command:${input.commandId}`]);

    const existing = await getResourceByKeyPg(tx, "runtime_command", input.commandId);
    if (existing) return storedRuntimeCommandResult(existing.payload);

    const resourceRefs = input.resourceRefs ?? [];
    const requestedEvent = await appendHistoryEventOncePg(tx, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      eventType: "run.command_requested",
      actorType: input.actor.type,
      idempotencyKey: `runtime-command:${input.commandId}:requested`,
      payload: {
        commandId: input.commandId,
        action: input.action,
        actor: input.actor,
        reason: input.reason,
        status: input.status,
        resourceRefs,
      },
    });
    const actionEvents = input.eventSequence ?? [{ eventType: input.eventType, eventPayload: input.eventPayload }];
    const actionEventRefs: RuntimeCommandEventRef[] = [];
    for (const event of actionEvents) {
      const actionEvent = await appendHistoryEventOncePg(tx, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        eventType: event.eventType,
        actorType: input.actor.type,
        idempotencyKey: `runtime-command:${input.commandId}:${event.eventType}`,
        payload: event.eventPayload ?? {},
      });
      actionEventRefs.push({ runId: input.runId, sequence: actionEvent.sequence, eventType: event.eventType });
    }
    const result = runtimeCommandResult(input, resourceRefs, [
      { runId: input.runId, sequence: requestedEvent.sequence, eventType: "run.command_requested" },
      ...actionEventRefs,
    ]);

    await insertRuntimeCommandResourceOncePg(tx, input, result);

    const stored = await getResourceByKeyPg(tx, "runtime_command", input.commandId);
    if (!stored) throw new Error(`runtime_command resource was not stored for ${input.commandId}`);
    return storedRuntimeCommandResult(stored.payload);
  });
}

async function insertRuntimeCommandResourceOncePg(
  db: SouthstarDb,
  input: RecordRuntimeCommandInput,
  result: RuntimeCommandResult,
): Promise<void> {
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, run_id, task_id, session_id, scope, status,
      title, payload_json, summary_json, metrics_json, created_at, updated_at, expires_at
    ) values ($1, 'runtime_command', $2, $3, $4, $5, 'runtime', $6, $7, $8::jsonb, $9::jsonb, '{}'::jsonb, now(), now(), null)
    on conflict(resource_type, resource_key) do nothing`,
    [
      randomUUID(),
      input.commandId,
      input.runId,
      input.taskId ?? null,
      input.sessionId ?? null,
      input.status,
      `Runtime command: ${input.action}`,
      JSON.stringify({
        commandId: input.commandId,
        action: input.action,
        actor: input.actor,
        reason: input.reason,
        result,
      }),
      JSON.stringify({ action: input.action, status: input.status }),
    ],
  );
}

function runtimeCommandResult(
  input: RecordRuntimeCommandInput,
  resourceRefs: RuntimeCommandResourceRef[],
  eventRefs: RuntimeCommandEventRef[],
): RuntimeCommandResult {
  return {
    commandId: input.commandId,
    accepted: input.status !== "blocked" && input.status !== "rejected",
    status: input.status,
    affectedRunId: input.runId,
    ...(input.taskId !== undefined ? { affectedTaskId: input.taskId } : {}),
    ...(input.sessionId !== undefined ? { affectedSessionId: input.sessionId } : {}),
    resourceRefs,
    eventRefs,
    nextSuggestedActions: input.nextSuggestedActions ?? [],
    ...(input.message !== undefined ? { message: input.message } : {}),
  };
}

function storedRuntimeCommandResult(payload: unknown): RuntimeCommandResult {
  if (!isRecord(payload) || !isRuntimeCommandResult(payload.result)) {
    throw new Error("runtime_command resource is missing a valid result payload");
  }
  return payload.result;
}

function isRuntimeCommandResult(value: unknown): value is RuntimeCommandResult {
  return isRecord(value)
    && typeof value.commandId === "string"
    && typeof value.accepted === "boolean"
    && isRuntimeCommandStatus(value.status)
    && Array.isArray(value.resourceRefs)
    && Array.isArray(value.eventRefs)
    && Array.isArray(value.nextSuggestedActions);
}

function isRuntimeCommandActor(value: unknown): value is RuntimeCommandActor {
  return isRecord(value)
    && (value.type === "user" || value.type === "system" || value.type === "root-session")
    && (value.id === undefined || typeof value.id === "string");
}

function isRuntimeCommandStatus(value: unknown): value is RuntimeCommandStatus {
  return value === "applied" || value === "queued" || value === "blocked" || value === "rejected" || value === "noop";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
