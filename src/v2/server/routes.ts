import { ingestTaskRunResult, type TaskRunCallbackResult } from "../executor/tork-callback.ts";
import {
  createPlannerDraft,
  createRunFromDraft,
  getRunStatus,
  getTaskEnvelope,
  steerRun,
} from "../ui-api/local-api.ts";
import { buildTaskDetailModel } from "../ui-api/read-models.ts";
import { listHistoryForRun } from "../stores/history-store.ts";
import { listResources } from "../stores/resource-store.ts";
import { decideApproval } from "../approvals/service.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import { readRunEventsSince, toSseFrame } from "./sse.ts";
import type { ApiEnvelope, ApiErrorEnvelope } from "./types.ts";

export async function handleRuntimeRoute(context: RuntimeServerContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.pathname === "/api/v2/run-goal") {
      const body = await readJsonBody<{ goalPrompt?: string }>(request);
      if (!body.goalPrompt) throw new Error("goalPrompt is required");
      const draft = await createPlannerDraft(context.db, {
        goalPrompt: body.goalPrompt,
        plannerClient: context.plannerClient,
      });
      const run = await createRunFromDraft(context.db, {
        draftId: draft.draftId,
        executorProvider: context.executorProvider,
        callbackUrl: `${requiredServerUrl(context)}/api/v2/tork/callback`,
        runRoot: context.runRoot,
      });
      return json("run-goal", { draft, ...run });
    }

    if (request.method === "POST" && url.pathname === "/api/v2/planner/drafts") {
      const body = await readJsonBody<{ goalPrompt?: string }>(request);
      if (!body.goalPrompt) throw new Error("goalPrompt is required");
      return json("planner-draft", await createPlannerDraft(context.db, {
        goalPrompt: body.goalPrompt,
        plannerClient: context.plannerClient,
      }));
    }

    if (request.method === "POST" && url.pathname === "/api/v2/runs") {
      const body = await readJsonBody<{ draftId?: string }>(request);
      if (!body.draftId) throw new Error("draftId is required");
      return json("run", await createRunFromDraft(context.db, {
        draftId: body.draftId,
        executorProvider: context.executorProvider,
        callbackUrl: `${requiredServerUrl(context)}/api/v2/tork/callback`,
        runRoot: context.runRoot,
      }));
    }

    const eventsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const after = Number(url.searchParams.get("after") ?? "0");
      return json("events", readRunEventsSince(context.db, {
        runId: decodeURIComponent(eventsMatch[1]!),
        afterSequence: Number.isFinite(after) ? after : 0,
      }));
    }

    const streamMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events\/stream$/);
    if (request.method === "GET" && streamMatch) {
      const after = Number(url.searchParams.get("after") ?? "0");
      const events = readRunEventsSince(context.db, {
        runId: decodeURIComponent(streamMatch[1]!),
        afterSequence: Number.isFinite(after) ? after : 0,
      });
      return new Response(events.map(toSseFrame).join(""), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }

    const runMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch) {
      return json("status", getRunStatus(context.db, decodeURIComponent(runMatch[1]!)));
    }

    const tasksMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks$/);
    if (request.method === "GET" && tasksMatch) {
      const runId = decodeURIComponent(tasksMatch[1]!);
      const rows = context.db.prepare("select * from workflow_tasks where run_id = ? order by sort_order").all(runId);
      return json("tasks", rows);
    }

    const taskMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)$/);
    if (request.method === "GET" && taskMatch) {
      const runId = decodeURIComponent(taskMatch[1]!);
      const taskId = decodeURIComponent(taskMatch[2]!);
      const task = buildTaskDetailModel(context.db, runId, taskId);
      if (!task) throw new Error(`task not found: ${runId}/${taskId}`);
      return json("task", task);
    }

    const resourceMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(artifacts|sessions|memory|logs)$/);
    if (request.method === "GET" && resourceMatch) {
      const runId = decodeURIComponent(resourceMatch[1]!);
      const kind = resourceMatch[2]!;
      if (kind === "logs") return json("logs", listHistoryForRun(context.db, runId));
      if (kind === "sessions") {
        return json("sessions", [
          ...listResources(context.db, { resourceType: "session" }),
          ...listResources(context.db, { resourceType: "session_checkpoint" }),
        ].filter((resource) => resource.runId === runId));
      }
      if (kind === "memory") {
        return json("memory", [
          ...listResources(context.db, { resourceType: "memory_item" }),
          ...listResources(context.db, { resourceType: "memory_delta" }),
        ].filter((resource) => resource.runId === runId));
      }
      const resourceType = kind === "artifacts" ? "artifact" : "memory_item";
      return json(kind, listResources(context.db, { resourceType }).filter((resource) => resource.runId === runId));
    }

    const approvalsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/approvals$/);
    if (request.method === "GET" && approvalsMatch) {
      const runId = decodeURIComponent(approvalsMatch[1]!);
      return json("approvals", listResources(context.db, { resourceType: "approval" }).filter((resource) => resource.runId === runId));
    }

    const approvalDecisionMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/approvals\/([^/]+)\/decision$/);
    if (request.method === "POST" && approvalDecisionMatch) {
      const body = await readJsonBody<{ decision?: "approved" | "rejected"; reason?: string }>(request);
      if (body.decision !== "approved" && body.decision !== "rejected") throw new Error("decision must be approved or rejected");
      if (!body.reason) throw new Error("reason is required");
      return json("approval-decision", decideApproval(context.db, {
        runId: decodeURIComponent(approvalDecisionMatch[1]!),
        approvalId: decodeURIComponent(approvalDecisionMatch[2]!),
        decision: body.decision,
        actorType: "user",
        reason: body.reason,
      }));
    }

    const steerMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/steering$/);
    if (request.method === "POST" && steerMatch) {
      const body = await readJsonBody<{ message?: string }>(request);
      if (!body.message) throw new Error("message is required");
      return json("steering", steerRun(context.db, {
        runId: decodeURIComponent(steerMatch[1]!),
        message: body.message,
      }));
    }

    const voiceMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/voice-command$/);
    if (request.method === "POST" && voiceMatch) {
      const body = await readJsonBody<{ transcript?: string }>(request);
      if (!body.transcript) throw new Error("transcript is required");
      return json("voice-command", {
        transcript: body.transcript,
        event: steerRun(context.db, {
          runId: decodeURIComponent(voiceMatch[1]!),
          message: body.transcript,
        }),
      });
    }

    const envelopeMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/envelope$/);
    if (request.method === "GET" && envelopeMatch) {
      return json("task-envelope", getTaskEnvelope(context.db, {
        runId: decodeURIComponent(envelopeMatch[1]!),
        taskId: decodeURIComponent(envelopeMatch[2]!),
      }));
    }

    if (request.method === "POST" && url.pathname === "/api/v2/tork/callback") {
      ingestTaskRunResult(context.db, validatedCallbackResult(context, await readJsonBody(request)));
      return json("callback", { accepted: true });
    }

    return errorResponse("not found", 404);
  } catch (error) {
    return errorResponse((error as Error).message, 400);
  }
}

async function readJsonBody<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function requiredServerUrl(context: RuntimeServerContext): string {
  if (!context.serverUrl) throw new Error("runtime server URL is not initialized");
  return context.serverUrl;
}

function validatedCallbackResult(context: RuntimeServerContext, body: unknown): TaskRunCallbackResult {
  if (!isRecord(body)) throw new Error("callback body must be an object");
  const runId = requiredString(body.runId, "runId");
  const taskId = requiredString(body.taskId, "taskId");
  const rootSessionId = requiredString(body.rootSessionId, "rootSessionId");
  const task = context.db.prepare("select 1 from workflow_tasks where run_id = ? and id = ?").get(runId, taskId);
  if (!task) throw new Error(`callback task not found: ${runId}/${taskId}`);
  return {
    runId,
    taskId,
    rootSessionId,
    ok: typeof body.ok === "boolean" ? body.ok : false,
    attempts: typeof body.attempts === "number" && Number.isFinite(body.attempts) ? body.attempts : 1,
    artifact: isRecord(body.artifact) ? body.artifact : {},
    metrics: isRecord(body.metrics) ? body.metrics : {},
    events: Array.isArray(body.events) ? body.events.map(validateCallbackEvent) : [],
    materializationRoot: context.runRoot ?? "/tmp/southstar-runs",
  };
}

function validateCallbackEvent(event: unknown): TaskRunCallbackResult["events"][number] {
  if (!isRecord(event)) throw new Error("callback event must be an object");
  return {
    eventType: requiredString(event.eventType, "eventType"),
    actorType: requiredString(event.actorType, "actorType") as TaskRunCallbackResult["events"][number]["actorType"],
    sessionId: typeof event.sessionId === "string" ? event.sessionId : undefined,
    payload: event.payload,
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), {
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(error: string, status: number): Response {
  const envelope: ApiErrorEnvelope = { ok: false, error };
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "content-type": "application/json" },
  });
}
