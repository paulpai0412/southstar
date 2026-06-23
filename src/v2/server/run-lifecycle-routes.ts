import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  getResourceByKeyPg,
} from "../stores/postgres-runtime-store.ts";
import {
  recordRuntimeCommandPg,
  requireRuntimeCommandRequest,
  type RuntimeCommandRequest,
  type RuntimeCommandResourceRef,
  type RuntimeCommandResult,
  type RuntimeCommandStatus,
} from "../ui-api/commands/runtime-command.ts";

type RunLifecycleAction = "pause" | "resume" | "cancel";

type RunActionState = {
  action: RunLifecycleAction;
  allowed: boolean;
  reason?: string;
};

const TERMINAL_RUN_STATUSES = ["completed", "passed", "failed", "cancelled"] as const;
const ACTIVE_EXECUTION_STATUSES = ["submitted", "queued", "starting", "running", "heartbeat-lost", "queue-timeout", "hard-timeout", "callback-missing"] as const;

export async function handleRunLifecycleRoute(
  context: RuntimeServerContext,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  const actionsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/actions$/);
  if (request.method === "GET" && actionsMatch) {
    const runId = decodeURIComponent(actionsMatch[1]!);
    const run = await context.db.maybeOne<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
    if (!run) throw new Error(`run not found: ${runId}`);
    return json("run-actions", { runId, status: run.status, actions: actionsForStatus(run.status) });
  }

  const commandMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(pause|resume|cancel)$/);
  if (request.method === "POST" && commandMatch) {
    const runId = decodeURIComponent(commandMatch[1]!);
    const action = commandMatch[2]! as RunLifecycleAction;
    const command = requireRuntimeCommandRequest(await request.json());
    const existing = await getResourceByKeyPg(context.db, "runtime_command", command.commandId);
    if (existing) return json("runtime-command", storedRuntimeCommandResult(existing.payload));
    if (command.dryRun) return json("runtime-command", await dryRunLifecycleCommand(context.db, runId, action, command));
    return json("runtime-command", await applyLifecycleCommand(context.db, runId, action, command));
  }

  return undefined;
}

async function dryRunLifecycleCommand(
  db: SouthstarDb,
  runId: string,
  action: RunLifecycleAction,
  command: RuntimeCommandRequest,
): Promise<RuntimeCommandResult> {
  const run = await db.maybeOne<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
  if (!run) throw new Error(`run not found: ${runId}`);
  const allowed = actionAllowed(action, run.status);
  return runtimeCommandResult({
    command,
    runId,
    status: allowed.allowed ? "noop" : "blocked",
    resourceRefs: [],
    eventRefs: [],
    nextSuggestedActions: actionsForStatus(run.status).filter((item) => item.allowed).map((item) => item.action),
    message: allowed.allowed ? `dry run: ${action} would be applied` : allowed.reason,
  });
}

async function applyLifecycleCommand(
  db: SouthstarDb,
  runId: string,
  action: RunLifecycleAction,
  command: RuntimeCommandRequest,
): Promise<RuntimeCommandResult> {
  return await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [`runtime_command:${command.commandId}`]);
    const existing = await getResourceByKeyPg(tx, "runtime_command", command.commandId);
    if (existing) return storedRuntimeCommandResult(existing.payload);

    const run = await tx.maybeOne<{ id: string; status: string }>(
      "select id, status from southstar.workflow_runs where id = $1 for update",
      [runId],
    );
    if (!run) throw new Error(`run not found: ${runId}`);

    const allowed = actionAllowed(action, run.status);
    if (!allowed.allowed) {
      return await recordRuntimeCommandPg(tx, {
        commandId: command.commandId,
        runId,
        action: `run.${action}`,
        actor: command.actor,
        reason: command.reason,
        status: "blocked",
        resourceRefs: [{ resourceType: "workflow_run", resourceKey: runId }],
        eventType: `run.${action}_blocked`,
        eventPayload: { status: run.status, reason: allowed.reason },
        nextSuggestedActions: actionsForStatus(run.status).filter((item) => item.allowed).map((item) => item.action),
        message: allowed.reason,
      });
    }

    const nextStatus = nextStatusForAction(action);
    await tx.query(
      `update southstar.workflow_runs
          set status = $1,
              updated_at = now(),
              completed_at = case when $1 = 'cancelled' then coalesce(completed_at, now()) else completed_at end
        where id = $2`,
      [nextStatus, runId],
    );
    const resourceRefs = [{ resourceType: "workflow_run", resourceKey: runId }];
    if (action === "cancel" || (action === "pause" && command.payload?.cancelActiveJobs === true)) {
      resourceRefs.push(...await markActiveExecutionResourcesCancelRequested(tx, runId));
    }

    const eventSequence = action === "cancel"
      ? [
        { eventType: "run.cancel_requested", eventPayload: { fromStatus: run.status, toStatus: "cancel_requested" } },
        { eventType: "run.cancelled", eventPayload: { fromStatus: "cancel_requested", toStatus: nextStatus } },
      ]
      : undefined;

    return await recordRuntimeCommandPg(tx, {
      commandId: command.commandId,
      runId,
      action: `run.${action}`,
      actor: command.actor,
      reason: command.reason,
      status: "applied",
      resourceRefs,
      eventType: eventTypeForAction(action),
      eventPayload: { fromStatus: run.status, toStatus: nextStatus },
      eventSequence,
      nextSuggestedActions: actionsForStatus(nextStatus).filter((item) => item.allowed).map((item) => item.action),
    });
  });
}

async function markActiveExecutionResourcesCancelRequested(
  db: SouthstarDb,
  runId: string,
): Promise<RuntimeCommandResourceRef[]> {
  const result = await db.query<{ resource_type: string; resource_key: string }>(
    `update southstar.runtime_resources
        set status = 'cancel_requested',
            payload_json = case
              when resource_type = 'executor_binding' then
                jsonb_set(
                  jsonb_set(payload_json, '{status}', to_jsonb('cancel_requested'::text), true),
                  '{southstarExecutorStatus}', to_jsonb('cancel_requested'::text), true
                )
              else jsonb_set(payload_json, '{status}', to_jsonb('cancel_requested'::text), true)
            end,
            summary_json = jsonb_set(summary_json, '{status}', to_jsonb('cancel_requested'::text), true),
            updated_at = now()
      where run_id = $1
        and resource_type = any($2::text[])
        and status = any($3::text[])
      returning resource_type, resource_key`,
    [runId, ["hand_execution", "executor_binding"], ACTIVE_EXECUTION_STATUSES],
  );
  return result.rows.map((row) => ({ resourceType: row.resource_type, resourceKey: row.resource_key }));
}

function actionsForStatus(status: string): RunActionState[] {
  return [
    actionState("pause", status),
    actionState("resume", status),
    actionState("cancel", status),
  ];
}

function actionState(action: RunLifecycleAction, status: string): RunActionState {
  const allowed = actionAllowed(action, status);
  return {
    action,
    allowed: allowed.allowed,
    ...(allowed.reason ? { reason: allowed.reason } : {}),
  };
}

function actionAllowed(action: RunLifecycleAction, status: string): { allowed: boolean; reason?: string } {
  if (action === "pause") {
    if (status === "scheduling" || status === "running") return { allowed: true };
    return { allowed: false, reason: `run cannot pause from status ${status}` };
  }
  if (action === "resume") {
    if (status === "paused" || status === "blocked") return { allowed: true };
    return { allowed: false, reason: `run cannot resume from status ${status}` };
  }
  if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(status)) {
    return { allowed: false, reason: `run cannot cancel from terminal status ${status}` };
  }
  return { allowed: true };
}

function nextStatusForAction(action: RunLifecycleAction): string {
  if (action === "pause") return "paused";
  if (action === "resume") return "scheduling";
  return "cancelled";
}

function eventTypeForAction(action: RunLifecycleAction): string {
  if (action === "pause") return "run.paused";
  if (action === "resume") return "run.resumed";
  return "run.cancelled";
}

function runtimeCommandResult(input: {
  command: RuntimeCommandRequest;
  runId: string;
  status: RuntimeCommandStatus;
  resourceRefs: RuntimeCommandResourceRef[];
  eventRefs: RuntimeCommandResult["eventRefs"];
  nextSuggestedActions: string[];
  message?: string;
}): RuntimeCommandResult {
  return {
    commandId: input.command.commandId,
    accepted: input.status !== "blocked" && input.status !== "rejected",
    status: input.status,
    affectedRunId: input.runId,
    resourceRefs: input.resourceRefs,
    eventRefs: input.eventRefs,
    nextSuggestedActions: input.nextSuggestedActions,
    ...(input.message ? { message: input.message } : {}),
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
    && typeof value.status === "string"
    && Array.isArray(value.resourceRefs)
    && Array.isArray(value.eventRefs)
    && Array.isArray(value.nextSuggestedActions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", ...corsHeaders() } });
}

function corsHeaders(): Record<string, string> {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
}
