import { reconcileExecutorBindingsPg } from "../executor/postgres-reconciler.ts";
import { getExecutionProjectionByExternalJobIdPg, getExecutionProjectionPg, listExecutionProjectionsPg, type ExecutionProjection } from "../read-models/executions.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  recordRuntimeCommandPg,
  requireRuntimeCommandRequest,
  type RuntimeCommandRequest,
  type RuntimeCommandResult,
} from "../ui-api/commands/runtime-command.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

const ACTIVE_EXECUTION_STATUSES = new Set([
  "submitted",
  "queued",
  "starting",
  "running",
  "heartbeat-lost",
  "queue-timeout",
  "hard-timeout",
  "callback-missing",
  "orphaned",
]);
const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "failed", "cancelled", "lost", "superseded", "cancel_requested"]);

export async function handleExecutionRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const listMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(?:hand-executions|executor-jobs)$/);
  if (request.method === "GET" && listMatch) {
    const runId = decodeURIComponent(listMatch[1]!);
    return json("executions", { runId, executions: await listExecutionProjectionsPg(context.db, runId) });
  }

  const detailMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(hand-executions|executor-jobs)\/([^/]+)$/);
  if (request.method === "GET" && detailMatch) {
    const runId = decodeURIComponent(detailMatch[1]!);
    const routeKind = detailMatch[2]!;
    const executionId = decodeURIComponent(detailMatch[3]!);
    const execution = routeKind === "executor-jobs"
      ? await getExecutionProjectionByExternalJobIdPg(context.db, { runId, jobId: executionId })
      : await getExecutionProjectionPg(context.db, { runId, executionId });
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    return json("execution", { runId, execution });
  }

  const actionsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/executor-jobs\/([^/]+)\/actions$/);
  if (request.method === "GET" && actionsMatch) {
    const runId = decodeURIComponent(actionsMatch[1]!);
    const jobId = decodeURIComponent(actionsMatch[2]!);
    const execution = await getExecutionProjectionByExternalJobIdPg(context.db, { runId, jobId });
    if (!execution) throw new Error(`execution not found: ${jobId}`);
    return json("executor-job-actions", {
      runId,
      jobId,
      executionId: execution.executionId,
      status: execution.status,
      rawStatus: execution.rawStatus,
      actions: executorJobActions(context, runId, jobId, execution),
    });
  }

  const cancelMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/executor-jobs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const runId = decodeURIComponent(cancelMatch[1]!);
    const jobId = decodeURIComponent(cancelMatch[2]!);
    const command = requireRuntimeCommandRequest(await request.json());
    return json("runtime-command", await cancelExecutorJobPg(context.db, { runId, jobId, command }));
  }

  const reconcileMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/executor-jobs\/([^/]+)\/reconcile$/);
  if (request.method === "POST" && reconcileMatch) {
    const runId = decodeURIComponent(reconcileMatch[1]!);
    const jobId = decodeURIComponent(reconcileMatch[2]!);
    const execution = await getExecutionProjectionByExternalJobIdPg(context.db, { runId, jobId });
    if (!execution) throw new Error(`execution not found: ${jobId}`);
    if (!context.torkObservationClient) throw new Error("torkObservationClient is required for executor reconcile");
    return json("executor-job-reconcile", {
      runId,
      executionId: execution.executionId,
      result: await reconcileExecutorBindingsPg(context.db, {
        tork: context.torkObservationClient,
        runId,
        bindingId: execution.executionId,
      }),
    });
  }

  return undefined;
}

async function cancelExecutorJobPg(
  db: SouthstarDb,
  input: { runId: string; jobId: string; command: RuntimeCommandRequest },
): Promise<RuntimeCommandResult> {
  const execution = await getExecutionProjectionByExternalJobIdPg(db, { runId: input.runId, jobId: input.jobId });
  if (!execution) throw new Error(`execution not found: ${input.jobId}`);

  const allowed = isExecutionCancelAllowed(execution.rawStatus);
  if (input.command.dryRun) {
    return {
      commandId: input.command.commandId,
      accepted: allowed.allowed,
      status: allowed.allowed ? "noop" : "blocked",
      affectedRunId: input.runId,
      ...(execution.taskId ? { affectedTaskId: execution.taskId } : {}),
      ...(execution.sessionId ? { affectedSessionId: execution.sessionId } : {}),
      resourceRefs: [],
      eventRefs: [],
      nextSuggestedActions: allowed.allowed ? ["cancel-executor-job"] : [],
      message: allowed.allowed ? "dry run: executor job cancel would be requested" : allowed.reason,
    };
  }

  if (!allowed.allowed) {
    return await recordRuntimeCommandPg(db, {
      commandId: input.command.commandId,
      runId: input.runId,
      taskId: execution.taskId,
      sessionId: execution.sessionId,
      action: "executor_job.cancel",
      actor: input.command.actor,
      reason: input.command.reason,
      status: "noop",
      resourceRefs: [{ resourceType: execution.kind, resourceKey: execution.executionId }],
      eventType: "executor_job.cancel_noop",
      eventPayload: {
        jobId: input.jobId,
        executionId: execution.executionId,
        rawStatus: execution.rawStatus,
        reason: allowed.reason,
      },
      nextSuggestedActions: ["watch-events"],
      message: allowed.reason ?? `execution cannot cancel from status ${execution.rawStatus}`,
    });
  }

  return await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [`executor-job-cancel:${input.command.commandId}`]);
    const freshExecution = await getExecutionProjectionByExternalJobIdPg(tx, { runId: input.runId, jobId: input.jobId });
    if (!freshExecution) throw new Error(`execution not found: ${input.jobId}`);
    const freshAllowed = isExecutionCancelAllowed(freshExecution.rawStatus);
    if (!freshAllowed.allowed) {
      return await recordRuntimeCommandPg(tx, {
        commandId: input.command.commandId,
        runId: input.runId,
        taskId: freshExecution.taskId,
        sessionId: freshExecution.sessionId,
        action: "executor_job.cancel",
        actor: input.command.actor,
        reason: input.command.reason,
        status: "noop",
        resourceRefs: [{ resourceType: freshExecution.kind, resourceKey: freshExecution.executionId }],
        eventType: "executor_job.cancel_noop",
        eventPayload: {
          jobId: input.jobId,
          executionId: freshExecution.executionId,
          rawStatus: freshExecution.rawStatus,
          reason: freshAllowed.reason,
        },
        nextSuggestedActions: ["watch-events"],
        message: freshAllowed.reason ?? `execution cannot cancel from status ${freshExecution.rawStatus}`,
      });
    }

    await markExecutionCancelRequestedPg(tx, freshExecution);
    return await recordRuntimeCommandPg(tx, {
      commandId: input.command.commandId,
      runId: input.runId,
      taskId: freshExecution.taskId,
      sessionId: freshExecution.sessionId,
      action: "executor_job.cancel",
      actor: input.command.actor,
      reason: input.command.reason,
      status: "applied",
      resourceRefs: [{ resourceType: freshExecution.kind, resourceKey: freshExecution.executionId }],
      eventType: "executor_job.cancel_requested",
      eventPayload: {
        jobId: input.jobId,
        executionId: freshExecution.executionId,
        externalJobId: freshExecution.externalJobId,
        fromStatus: freshExecution.rawStatus,
        toStatus: "cancel_requested",
      },
      nextSuggestedActions: ["reconcile-executor-job", "watch-events"],
    });
  });
}

async function markExecutionCancelRequestedPg(db: SouthstarDb, execution: ExecutionProjection): Promise<void> {
  const result = await db.query<{ resource_key: string }>(
    `update southstar.runtime_resources
        set status = 'cancel_requested',
            payload_json = case
              when resource_type = 'executor_binding' then
                jsonb_set(
                  jsonb_set(coalesce(payload_json, '{}'::jsonb), '{status}', to_jsonb('cancel_requested'::text), true),
                  '{southstarExecutorStatus}', to_jsonb('cancel_requested'::text), true
                )
              else jsonb_set(coalesce(payload_json, '{}'::jsonb), '{status}', to_jsonb('cancel_requested'::text), true)
            end,
            summary_json = jsonb_set(coalesce(summary_json, '{}'::jsonb), '{status}', to_jsonb('cancel_requested'::text), true),
            updated_at = now()
      where run_id = $1
        and resource_type = $2
        and resource_key = $3
        and status = any($4::text[])
      returning resource_key`,
    [execution.runId, execution.kind, execution.executionId, [...ACTIVE_EXECUTION_STATUSES]],
  );
  if (!result.rows[0]) throw new Error(`execution is no longer cancellable: ${execution.executionId}`);
}

function executorJobActions(
  context: RuntimeServerContext,
  runId: string,
  jobId: string,
  execution: ExecutionProjection,
): Array<{ action: "cancel" | "reconcile"; allowed: boolean; reason?: string; endpoint: string }> {
  const cancelAllowed = isExecutionCancelAllowed(execution.rawStatus);
  const canReconcile = Boolean(context.torkObservationClient && execution.externalJobId);
  return [
    {
      action: "cancel",
      allowed: cancelAllowed.allowed,
      ...(cancelAllowed.reason ? { reason: cancelAllowed.reason } : {}),
      endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(jobId)}/cancel`,
    },
    {
      action: "reconcile",
      allowed: canReconcile,
      ...(canReconcile ? {} : { reason: context.torkObservationClient ? "execution has no external job id" : "torkObservationClient is not configured" }),
      endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(jobId)}/reconcile`,
    },
  ];
}

function isExecutionCancelAllowed(rawStatus: string): { allowed: boolean; reason?: string } {
  if (ACTIVE_EXECUTION_STATUSES.has(rawStatus)) return { allowed: true };
  if (TERMINAL_EXECUTION_STATUSES.has(rawStatus)) return { allowed: false, reason: `execution cannot cancel from terminal status ${rawStatus}` };
  return { allowed: false, reason: `execution cannot cancel from status ${rawStatus}` };
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
