import { ingestTaskRunResult, type TaskRunCallbackResult } from "../executor/tork-callback.ts";
import { dispatchRecoveryExecution } from "../session-recovery/dispatcher.ts";
import { recordExecutorHeartbeat } from "../executor/heartbeat.ts";
import { getExecutorBinding, listExecutorBindingsForRun } from "../executor/bindings.ts";
import { reconcileExecutorBindings } from "../executor/reconciler.ts";
import {
  createPlannerDraft,
  createRunFromDraft,
  getRunStatus,
  getTaskEnvelope,
  steerRun,
} from "../ui-api/local-api.ts";
import { buildTaskDetailModel, sessionGraphResources } from "../ui-api/read-models.ts";
import { listHistoryForRun } from "../stores/history-store.ts";
import { listResources } from "../stores/resource-store.ts";
import { evaluateApprovalPolicy } from "../approvals/policy.ts";
import { createApprovalRequest, decideApproval } from "../approvals/service.ts";
import { appendRuntimeEvent } from "../signals/events.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import { handleUiRoute } from "./ui-routes.ts";
import { readRunEventsSince, toSseFrame } from "./sse.ts";
import type { ApiEnvelope, ApiErrorEnvelope } from "./types.ts";
import { buildReadModel } from "../read-models/registry.ts";
import type { ReadModelKind } from "../read-models/types.ts";

export async function handleRuntimeRoute(context: RuntimeServerContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const uiResponse = await handleUiRoute(context, request, url);
    if (uiResponse) return uiResponse;

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
        callbackUrl: callbackUrl(context),
        heartbeatUrl: heartbeatUrl(context),
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
        callbackUrl: callbackUrl(context),
        heartbeatUrl: heartbeatUrl(context),
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

    const readModelMatch = url.pathname.match(/^\/api\/v2\/read-models\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
    if (request.method === "GET" && readModelMatch) {
      const kind = decodeURIComponent(readModelMatch[1]!) as ReadModelKind;
      if (!isReadModelKind(kind)) throw new Error(`unknown read model kind: ${kind}`);
      const runId = decodeURIComponent(readModelMatch[2]!);
      const taskId = readModelMatch[3] ? decodeURIComponent(readModelMatch[3]) : undefined;
      return json("read-model", buildReadModel(context.db, { kind, runId, taskId }));
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
        return json("sessions", sessionGraphResources(context.db).filter((resource) => resource.runId === runId));
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
      const runId = decodeURIComponent(voiceMatch[1]!);
      appendRuntimeEvent(context.db, {
        runId,
        eventType: "voice.command_received",
        actorType: "user",
        payload: { transcript: body.transcript },
      });
      const riskTags = riskTagsForVoiceTranscript(body.transcript);
      const policy = evaluateApprovalPolicy({ mode: "policy", actionType: "voiceCommand", riskTags });
      const approval = policy.status === "pending"
        ? createApprovalRequest(context.db, {
          runId,
          actionType: "voiceCommand",
          riskTags,
          title: "Review voice command",
          payload: { transcript: body.transcript, policyReason: policy.reason },
        })
        : undefined;
      return json("voice-command", {
        transcript: body.transcript,
        approval,
        event: steerRun(context.db, {
          runId,
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

    if (request.method === "POST" && url.pathname === "/api/v2/executor/heartbeat") {
      const body = await readJsonBody<Record<string, unknown>>(request);
      return json("executor-heartbeat", recordExecutorHeartbeat(context.db, {
        runId: requiredString(body.runId, "runId"),
        taskId: requiredString(body.taskId, "taskId"),
        attemptId: requiredString(body.attemptId, "attemptId"),
        executorType: "tork",
        torkJobId: requiredString(body.torkJobId, "torkJobId"),
        torkTaskId: typeof body.torkTaskId === "string" ? body.torkTaskId : undefined,
        rootSessionId: requiredString(body.rootSessionId, "rootSessionId"),
        heartbeatSeq: typeof body.heartbeatSeq === "number" && Number.isFinite(body.heartbeatSeq) ? body.heartbeatSeq : 1,
        phase: requiredString(body.phase, "phase") as "booting" | "root-session-started" | "subagent-running" | "artifact-uploading" | "callback-sent" | "shutdown",
        message: typeof body.message === "string" ? body.message : undefined,
        observedAt: typeof body.observedAt === "string" ? body.observedAt : new Date().toISOString(),
      }));
    }

    if (request.method === "POST" && url.pathname === "/api/v2/executor/reconcile") {
      if (!context.torkObservationClient) {
        throw new Error("torkObservationClient is required for executor reconcile");
      }
      return json("executor-reconcile", await reconcileExecutorBindings(context.db, {
        tork: context.torkObservationClient,
      }));
    }

    if (request.method === "GET" && url.pathname === "/api/v2/executor/bindings") {
      const runId = url.searchParams.get("runId");
      if (runId) {
        return json("executor-bindings", listExecutorBindingsForRun(context.db, runId));
      }
      return json("executor-bindings", listResources(context.db, { resourceType: "executor_binding" }));
    }

    const bindingMatch = url.pathname.match(/^\/api\/v2\/executor\/bindings\/([^/]+)$/);
    if (request.method === "GET" && bindingMatch) {
      const binding = getExecutorBinding(context.db, decodeURIComponent(bindingMatch[1]!));
      if (!binding) throw new Error("executor binding not found");
      return json("executor-binding", binding);
    }

    if (request.method === "POST" && url.pathname === "/api/v2/tork/callback") {
      const ingestion = ingestTaskRunResult(context.db, validatedCallbackResult(context, await readJsonBody(request)));
      const recoveryDispatch = ingestion.recoveryDispatch
        ? await dispatchRecoveryExecution(context.db, {
          ...ingestion.recoveryDispatch,
          executorProvider: context.executorProvider,
          runRoot: context.runRoot,
          callbackUrl: callbackUrl(context),
          heartbeatUrl: heartbeatUrl(context),
        })
        : undefined;
      return json("callback", { accepted: true, recoveryDispatch });
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

function callbackUrl(context: RuntimeServerContext): string {
  return context.callbackUrl ?? `${requiredServerUrl(context)}/api/v2/tork/callback`;
}

function heartbeatUrl(context: RuntimeServerContext): string {
  return `${requiredServerUrl(context)}/api/v2/executor/heartbeat`;
}

function riskTagsForVoiceTranscript(transcript: string): string[] {
  const normalized = transcript.toLowerCase();
  const tags = new Set<string>();
  if (/secret|vault|token|password|credential|金鑰|密鑰|憑證/.test(normalized)) tags.add("secret-access");
  if (/external|webhook|send it|upload|外部|傳送/.test(normalized)) tags.add("external-write");
  return tags.size === 0 ? ["low-risk"] : [...tags];
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
    attemptId: typeof body.attemptId === "string" ? body.attemptId : undefined,
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
    headers: {
      "content-type": "application/json",
      ...corsHeaders(),
    },
  });
}

function errorResponse(error: string, status: number): Response {
  const envelope: ApiErrorEnvelope = { ok: false, error };
  return new Response(JSON.stringify(envelope), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(),
    },
  });
}

function isReadModelKind(kind: string): kind is ReadModelKind {
  return [
    "run-inspection",
    "runtime-monitor",
    "workflow-canvas",
    "executor-ops",
    "task-detail",
    "sessions-memory",
    "vault-mcp",
  ].includes(kind);
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}
