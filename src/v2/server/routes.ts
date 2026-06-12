import { ingestTaskRunResult, type TaskRunCallbackResult } from "../executor/tork-callback.ts";
import {
  createPlannerDraft,
  createRunFromDraft,
  getRunStatus,
  getTaskEnvelope,
  steerRun,
} from "../ui-api/local-api.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope, ApiErrorEnvelope } from "./types.ts";

export async function handleRuntimeRoute(context: RuntimeServerContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
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

    const runMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch) {
      return json("status", getRunStatus(context.db, decodeURIComponent(runMatch[1]!)));
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
