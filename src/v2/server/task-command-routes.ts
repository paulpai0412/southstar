import { createHash } from "node:crypto";
import {
  RECOVERY_DECISION_SCHEMA_VERSION,
  RUNTIME_EXCEPTION_RESOURCE_TYPE,
  RUNTIME_EXCEPTION_SCHEMA_VERSION,
  type RecoveryPath,
} from "../exceptions/types.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import {
  recordRuntimeCommandPg,
  requireRuntimeCommandRequest,
  type RuntimeCommandResult,
} from "../ui-api/commands/runtime-command.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

type TaskRecoveryAction = "retry" | "fork-session" | "reset-session" | "rollback-session" | "request-revision";
type OperatorPayload = {
  checkpointId?: string;
  workspaceSnapshotRef?: string;
  invalidatedSourceRefs?: string[];
  revisionReason?: string;
};

type WorkflowTaskRow = {
  status: string;
  root_session_id: string | null;
};

export async function handleTaskCommandRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const actionsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/actions$/);
  if (request.method === "GET" && actionsMatch) {
    const runId = decodeURIComponent(actionsMatch[1]!);
    const taskId = decodeURIComponent(actionsMatch[2]!);
    const task = await readTask(context, runId, taskId);
    return json("task-actions", { runId, taskId, status: task.status, actions: taskActions(task.status) });
  }

  const commandMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/(retry|fork-session|reset-session|rollback-session|request-revision)$/);
  if (request.method === "POST" && commandMatch) {
    const runId = decodeURIComponent(commandMatch[1]!);
    const taskId = decodeURIComponent(commandMatch[2]!);
    const action = commandMatch[3]! as TaskRecoveryAction;
    const body = requireRuntimeCommandRequest(await request.json());
    return json("task-command", await context.db.tx(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [`runtime_command:${body.commandId}`]);
      const existing = await getResourceByKeyPg(tx, "runtime_command", body.commandId);
      if (existing) return storedRuntimeCommandResult(existing.payload);

      const task = await readTask({ ...context, db: tx }, runId, taskId);
      if (!isTaskRecoverable(task.status)) throw new Error(`task status ${task.status} does not allow ${action}`);
      const operatorPayload = operatorPayloadFromCommand(body.payload ?? {});
      if (action === "request-revision") {
        const request = await recordWorkflowRevisionRequest({ ...context, db: tx }, {
          commandId: body.commandId,
          runId,
          taskId,
          sessionId: task.root_session_id ?? undefined,
          reason: body.reason ?? action,
          actor: body.actor,
          operatorPayload,
        });
        return await recordRuntimeCommandPg(tx, {
          commandId: body.commandId,
          runId,
          taskId,
          sessionId: task.root_session_id ?? undefined,
          action: "task.request-revision",
          actor: body.actor,
          reason: body.reason,
          status: "queued",
          resourceRefs: [{ resourceType: "workflow_revision_request", resourceKey: request.resourceKey }],
          eventType: "task.revision_requested",
          eventPayload: {
            requestId: request.requestId,
            requestResourceKey: request.resourceKey,
          },
          nextSuggestedActions: ["review-workflow-revision-request"],
        });
      }
      const path = recoveryPathForTaskAction(action);
      const decision = await recordOperatorRecoveryDecision({ ...context, db: tx }, {
        commandId: body.commandId,
        runId,
        taskId,
        sessionId: task.root_session_id ?? undefined,
        path,
        reason: body.reason ?? action,
        actor: body.actor,
        operatorApprovalRequired: action === "rollback-session",
        operatorPayload,
      });
      return await recordRuntimeCommandPg(tx, {
        commandId: body.commandId,
        runId,
        taskId,
        sessionId: task.root_session_id ?? undefined,
        action: `task.${action}`,
        actor: body.actor,
        reason: body.reason,
        status: "queued",
        resourceRefs: [{ resourceType: "recovery_decision", resourceKey: decision.resourceKey }],
        eventType: "task.command_queued",
        eventSequence: [
          {
            eventType: "recovery.decision_recorded",
            eventPayload: {
              action,
              recoveryPath: path,
              decisionId: decision.decisionId,
              decisionResourceKey: decision.resourceKey,
            },
          },
          {
            eventType: "task.command_queued",
            eventPayload: {
              action,
              recoveryPath: path,
              decisionId: decision.decisionId,
              decisionResourceKey: decision.resourceKey,
            },
          },
        ],
        nextSuggestedActions: action === "rollback-session" ? ["approve-recovery-decision"] : ["apply-recovery-decision"],
      });
    }));
  }

  return undefined;
}

async function readTask(context: RuntimeServerContext, runId: string, taskId: string): Promise<WorkflowTaskRow> {
  const task = await context.db.maybeOne<WorkflowTaskRow>(
    "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
    [runId, taskId],
  );
  if (!task) throw new Error(`task not found: ${runId}/${taskId}`);
  return task;
}

async function recordOperatorRecoveryDecision(
  context: RuntimeServerContext,
  input: {
    commandId: string;
    runId: string;
    taskId: string;
    sessionId?: string;
    path: RecoveryPath;
    reason: string;
    actor: { type: string; id?: string };
    operatorApprovalRequired: boolean;
    operatorPayload: OperatorPayload;
  },
): Promise<{ decisionId: string; resourceKey: string }> {
  const decisionId = `operator-decision-${hash(`${input.commandId}:${input.path}`).slice(0, 24)}`;
  const resourceKey = `operator-recovery:${input.commandId}`;
  const exceptionId = `operator:${input.commandId}`;
  const now = new Date().toISOString();
  await upsertRuntimeResourcePg(context.db, {
    id: exceptionId,
    resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
    resourceKey: `runtime_exception:${input.runId}:operator:${input.commandId}`,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "task",
    status: "classified",
    title: "operator task recovery command",
    payload: {
      schemaVersion: RUNTIME_EXCEPTION_SCHEMA_VERSION,
      exceptionId,
      runId: input.runId,
      taskId: input.taskId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      source: "operator",
      kind: "validation_failed",
      severity: "recoverable",
      status: "classified",
      observedAt: now,
      classifiedAt: now,
      evidenceRefs: [`runtime_command:${input.commandId}`],
      providerEvidence: {
        commandId: input.commandId,
        path: input.path,
        actor: input.actor,
      },
    },
    summary: {
      source: "operator",
      kind: "validation_failed",
      severity: "recoverable",
      path: input.path,
    },
  });
  await upsertRuntimeResourcePg(context.db, {
    resourceType: "recovery_decision",
    resourceKey,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "recovery",
    status: input.operatorApprovalRequired ? "waiting_operator_approval" : "recorded",
    title: `Operator recovery decision: ${input.path}`,
    payload: {
      schemaVersion: RECOVERY_DECISION_SCHEMA_VERSION,
      decisionId,
      exceptionId,
      runId: input.runId,
      taskId: input.taskId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      path: input.path,
      reason: input.reason,
      operatorApprovalRequired: input.operatorApprovalRequired,
      evidenceRefs: [`runtime_command:${input.commandId}`],
      createdAt: now,
      source: "operator-task-command",
      actor: input.actor,
      commandId: input.commandId,
      ...input.operatorPayload,
    },
    summary: {
      path: input.path,
      reason: input.reason,
      operatorApprovalRequired: input.operatorApprovalRequired,
    },
  });
  return { decisionId, resourceKey };
}

async function recordWorkflowRevisionRequest(
  context: RuntimeServerContext,
  input: {
    commandId: string;
    runId: string;
    taskId: string;
    sessionId?: string;
    reason: string;
    actor: { type: string; id?: string };
    operatorPayload: OperatorPayload;
  },
): Promise<{ requestId: string; resourceKey: string }> {
  const requestId = `workflow-revision-request-${hash(input.commandId).slice(0, 24)}`;
  const resourceKey = `workflow-revision-request:${input.commandId}`;
  const now = new Date().toISOString();
  await upsertRuntimeResourcePg(context.db, {
    id: requestId,
    resourceType: "workflow_revision_request",
    resourceKey,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "workflow",
    status: "requested",
    title: "Workflow revision requested",
    payload: {
      requestId,
      commandId: input.commandId,
      runId: input.runId,
      taskId: input.taskId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      reason: input.operatorPayload.revisionReason ?? input.reason,
      actor: input.actor,
      createdAt: now,
    },
    summary: { reason: input.operatorPayload.revisionReason ?? input.reason },
  });
  return { requestId, resourceKey };
}

function recoveryPathForTaskAction(action: TaskRecoveryAction): RecoveryPath {
  if (action === "retry") return "retry-same-task-new-attempt";
  if (action === "fork-session") return "fork-session";
  if (action === "reset-session") return "reset-session";
  if (action === "rollback-session") return "rollback-session";
  throw new Error(`unsupported recovery task action: ${action}`);
}

function taskActions(status: string): Array<{ action: TaskRecoveryAction; allowed: boolean; reason?: string }> {
  const recoverable = isTaskRecoverable(status);
  return (["retry", "fork-session", "reset-session", "rollback-session", "request-revision"] as const).map((action) => ({
    action,
    allowed: recoverable,
    ...(recoverable ? {} : { reason: `task status ${status} does not allow ${action}` }),
  }));
}

function isTaskRecoverable(status: string): boolean {
  return status === "failed" || status === "blocked" || status === "running" || status === "queued";
}

function operatorPayloadFromCommand(payload: Record<string, unknown>): OperatorPayload {
  return {
    ...(typeof payload.checkpointId === "string" ? { checkpointId: payload.checkpointId } : {}),
    ...(typeof payload.workspaceSnapshotRef === "string" ? { workspaceSnapshotRef: payload.workspaceSnapshotRef } : {}),
    ...(Array.isArray(payload.invalidatedSourceRefs) && payload.invalidatedSourceRefs.every((item) => typeof item === "string")
      ? { invalidatedSourceRefs: payload.invalidatedSourceRefs }
      : {}),
    ...(typeof payload.revisionReason === "string" ? { revisionReason: payload.revisionReason } : {}),
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
