import { evaluateApprovalPolicy } from "../approvals/policy.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { createExecutorBindingPg, getExecutorBindingPg, listExecutorBindingsForRunPg, updateExecutorBindingStatusPg } from "../executor/postgres-bindings.ts";
import { reconcileExecutorBindingsPg } from "../executor/postgres-reconciler.ts";
import { ingestTaskRunResultPg, type PostgresTaskRunCallbackResult } from "../executor/postgres-tork-callback.ts";
import { type RecoveryExecutionPlan } from "../session-recovery/execution-planner.ts";
import { dispatchRecoveryExecutionPg } from "../session-recovery/postgres-dispatcher.ts";
import { isRecoveryStrategy } from "../session-recovery/types.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { buildEvolutionControlCenterReadModel } from "../read-models/evolution-control-center.ts";
import { buildPostgresCoreReadModel, isPostgresCoreReadModelKind } from "../read-models/postgres-core.ts";
import { buildRunInspectionReadModelPg, buildRuntimeExceptionReadModelPg } from "../read-models/postgres-run-inspection.ts";
import type { ReadModelKind } from "../read-models/types.ts";
import { appendHistoryEventPg, getResourceByKeyPg, getWorkflowRunPg, listHistoryForRunPg, listResourcesPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../ui-api/postgres-run-api.ts";
import { getPostgresTaskEnvelope } from "../ui-api/postgres-task-envelope.ts";
import { intakeWorkItemPg } from "../work-items/intake-service.ts";
import { materializeRunFromWorkItemPg } from "../work-items/run-materialization.ts";
import type { WorkItemIntakePriority, WorkItemSourceProvider } from "../work-items/types.ts";
import { handleEvolutionRoute } from "./evolution-routes.ts";
import { startRunSchedulingPg } from "./run-execution-controller.ts";
import { handleUiRoute } from "./ui-routes.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import { readRunEventsSince, toSseFrame } from "./sse.ts";
import type { ApiEnvelope, ApiErrorEnvelope } from "./types.ts";

const TERMINAL_HAND_EXECUTION_STATUSES = ["completed", "failed", "cancelled", "lost", "superseded"] as const;

export async function handleRuntimeRoute(context: RuntimeServerContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    const evolutionResponse = await handleEvolutionRoute(context, request, url);
    if (evolutionResponse) return evolutionResponse;
    const uiResponse = await handleUiRoute(context, request, url);
    if (uiResponse) return uiResponse;

    if (request.method === "POST" && url.pathname === "/api/v2/work-items/intake") {
      const body = await readJsonBody<{
        sourceProvider?: unknown;
        sourceScope?: unknown;
        sourceRef?: unknown;
        sourceUrl?: unknown;
        title?: unknown;
        body?: unknown;
        domain?: unknown;
        priority?: unknown;
        labels?: unknown;
        requestedBy?: unknown;
        metadata?: unknown;
      }>(request);
      return json("work-item-intake", await intakeWorkItemPg(context.db, {
        sourceProvider: requiredWorkItemSourceProvider(body.sourceProvider),
        sourceScope: optionalString(body.sourceScope),
        sourceRef: optionalString(body.sourceRef),
        sourceUrl: optionalString(body.sourceUrl),
        title: requiredString(body.title, "title"),
        body: optionalString(body.body) ?? "",
        domain: requiredString(body.domain, "domain"),
        priority: parseOptionalPriority(body.priority),
        labels: parseOptionalStringArray(body.labels, "labels"),
        requestedBy: optionalString(body.requestedBy),
        metadata: isRecord(body.metadata) ? body.metadata : undefined,
      }));
    }

    if (request.method === "POST" && url.pathname === "/api/v2/work-items/materialize-run") {
      const body = await readJsonBody<{
        sourceProvider?: unknown;
        sourceScope?: unknown;
        sourceRef?: unknown;
        sourceUrl?: unknown;
        title?: unknown;
        body?: unknown;
        domain?: unknown;
        runId?: unknown;
        workflowManifest?: unknown;
        executionProjection?: unknown;
        metadata?: unknown;
      }>(request);
      if (!isRecord(body.workflowManifest)) throw new Error("workflowManifest is required");
      if (!isRecord(body.executionProjection)) throw new Error("executionProjection is required");
      if (body.metadata !== undefined && !isRecord(body.metadata)) throw new Error("metadata must be an object");
      return json("work-item-run-materialization", await materializeRunFromWorkItemPg(context.db, {
        sourceProvider: requiredWorkItemSourceProvider(body.sourceProvider),
        sourceScope: optionalString(body.sourceScope),
        sourceRef: optionalString(body.sourceRef),
        sourceUrl: optionalString(body.sourceUrl),
        title: requiredString(body.title, "title"),
        body: requiredString(body.body, "body"),
        domain: requiredString(body.domain, "domain"),
        runId: requiredString(body.runId, "runId"),
        workflowManifest: body.workflowManifest as SouthstarWorkflowManifest,
        executionProjection: body.executionProjection,
        metadata: body.metadata,
      }));
    }

    if (request.method === "POST" && url.pathname === "/api/v2/run-goal") {
      const body = await readJsonBody<{ goalPrompt?: string }>(request);
      if (!body.goalPrompt) throw new Error("goalPrompt is required");
      const draft = await createPostgresPlannerDraft(context.db, { goalPrompt: body.goalPrompt });
      const run = await createPostgresRunFromDraft(context.db, { draftId: draft.draftId });
      return json("run-goal", { draft, ...run });
    }

    if (request.method === "POST" && url.pathname === "/api/v2/planner/drafts") {
      const body = await readJsonBody<{ goalPrompt?: string }>(request);
      if (!body.goalPrompt) throw new Error("goalPrompt is required");
      return json("planner-draft", await createPostgresPlannerDraft(context.db, { goalPrompt: body.goalPrompt }));
    }

    if (request.method === "POST" && url.pathname === "/api/v2/runs") {
      const body = await readJsonBody<{ draftId?: string }>(request);
      if (!body.draftId) throw new Error("draftId is required");
      return json("run", await createPostgresRunFromDraft(context.db, { draftId: body.draftId }));
    }

    const executeMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/execute$/);
    if (request.method === "POST" && executeMatch) {
      const runId = decodeURIComponent(executeMatch[1]!);
      return json("run-execute", await startRunSchedulingPg(context.db, { runId }));
    }

    const recoveryDispatchMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/recovery\/dispatch$/);
    if (request.method === "POST" && recoveryDispatchMatch) {
      const body = await readJsonBody<{
        failedTaskId?: string;
        plan?: Partial<RecoveryExecutionPlan>;
        callbackUrl?: string;
        heartbeatUrl?: string;
        runRoot?: string;
        harnessEndpoint?: string;
        contextRefreshUrl?: string;
      }>(request);
      const runId = decodeURIComponent(recoveryDispatchMatch[1]!);
      const failedTaskId = body.failedTaskId ?? (typeof body.plan?.failedTaskId === "string" ? body.plan.failedTaskId : undefined);
      if (!failedTaskId) throw new Error("failedTaskId is required");
      const strategy = body.plan?.strategy;
      if (!isRecoveryStrategy(strategy)) throw new Error("plan.strategy is required");
      const attemptNumber = typeof body.plan?.attemptNumber === "number" && Number.isInteger(body.plan.attemptNumber)
        ? body.plan.attemptNumber
        : 2;
      if (attemptNumber < 2) throw new Error("plan.attemptNumber must be >= 2");
      const callbackUrl = body.callbackUrl ?? context.callbackUrl ?? (context.serverUrl ? `${context.serverUrl}/api/v2/tork/callback` : undefined);
      if (!callbackUrl) throw new Error("callbackUrl is required");
      const plan: RecoveryExecutionPlan = {
        strategy,
        failedTaskId,
        baseTaskId: typeof body.plan?.baseTaskId === "string" ? body.plan.baseTaskId : failedTaskId,
        targetTaskIds: Array.isArray(body.plan?.targetTaskIds) && body.plan.targetTaskIds.length > 0
          ? body.plan.targetTaskIds.filter((taskId): taskId is string => typeof taskId === "string")
          : [failedTaskId],
        attemptNumber,
        requiresOperatorApproval: typeof body.plan?.requiresOperatorApproval === "boolean"
          ? body.plan.requiresOperatorApproval
          : strategy === "rollback-workspace" || strategy === "ask-human",
        reason: typeof body.plan?.reason === "string" && body.plan.reason.trim().length > 0
          ? body.plan.reason
          : `Strategy ${strategy} reruns ${failedTaskId}`,
        diagnostics: Array.isArray(body.plan?.diagnostics)
          ? body.plan.diagnostics.filter((item): item is string => typeof item === "string")
          : [],
      };
      return json("recovery-dispatch", await dispatchRecoveryExecutionPg(context.db, {
        runId,
        failedTaskId,
        plan,
        executorProvider: context.executorProvider,
        callbackUrl,
        heartbeatUrl: body.heartbeatUrl ?? (context.serverUrl ? `${context.serverUrl}/api/v2/executor/heartbeat` : undefined),
        runRoot: body.runRoot ?? context.runRoot,
        harnessEndpoint: body.harnessEndpoint,
        contextRefreshUrl: body.contextRefreshUrl,
      }));
    }

    const eventsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const after = Number(url.searchParams.get("after") ?? "0");
      return json("events", await readRunEventsSince(context.db, { runId: decodeURIComponent(eventsMatch[1]!), afterSequence: Number.isFinite(after) ? after : 0 }));
    }

    const exceptionsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/exceptions$/);
    if (request.method === "GET" && exceptionsMatch) {
      return json("runtime-exceptions", await buildRuntimeExceptionReadModelPg(context.db, { runId: decodeURIComponent(exceptionsMatch[1]!) }));
    }

    const streamMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events\/stream$/);
    if (request.method === "GET" && streamMatch) {
      const after = Number(url.searchParams.get("after") ?? "0");
      const events = await readRunEventsSince(context.db, { runId: decodeURIComponent(streamMatch[1]!), afterSequence: Number.isFinite(after) ? after : 0 });
      return new Response(events.map(toSseFrame).join(""), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...corsHeaders() } });
    }

    const readModelMatch = url.pathname.match(/^\/api\/v2\/read-models\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
    if (request.method === "GET" && readModelMatch) {
      const kind = decodeURIComponent(readModelMatch[1]!) as ReadModelKind;
      if (!isReadModelKind(kind)) throw new Error(`unknown read model kind: ${kind}`);
      const runId = decodeURIComponent(readModelMatch[2]!);
      const taskId = readModelMatch[3] ? decodeURIComponent(readModelMatch[3]) : undefined;
      if (kind === "evolution-control-center") return json("read-model", await buildEvolutionControlCenterReadModel(context.db));
      if (kind === "run-inspection") return json("read-model", await buildRunInspectionReadModelPg(context.db, runId));
      if (isPostgresCoreReadModelKind(kind)) return json("read-model", await buildPostgresCoreReadModel(context.db, { kind, runId, taskId }));
      throw new Error(`unsupported read model kind: ${kind}`);
    }

    const runMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch) {
      const run = await getWorkflowRunPg(context.db, decodeURIComponent(runMatch[1]!));
      if (!run) throw new Error("run not found");
      return json("status", { run });
    }

    const tasksMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks$/);
    if (request.method === "GET" && tasksMatch) {
      const runId = decodeURIComponent(tasksMatch[1]!);
      const rows = await context.db.query("select * from southstar.workflow_tasks where run_id = $1 order by sort_order", [runId]);
      return json("tasks", rows.rows);
    }

    const taskMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)$/);
    if (request.method === "GET" && taskMatch) {
      const runId = decodeURIComponent(taskMatch[1]!);
      const taskId = decodeURIComponent(taskMatch[2]!);
      return json("task", await buildPostgresCoreReadModel(context.db, { kind: "task-detail", runId, taskId }));
    }

    const resourceMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(artifacts|sessions|memory|logs)$/);
    if (request.method === "GET" && resourceMatch) {
      const runId = decodeURIComponent(resourceMatch[1]!);
      const kind = resourceMatch[2]!;
      if (kind === "logs") return json("logs", await listHistoryForRunPg(context.db, runId));
      const resourceTypes = kind === "artifacts" ? ["artifact", ARTIFACT_REF_RESOURCE_TYPE] : kind === "sessions" ? ["session"] : ["memory_item", "memory_delta"];
      const resources = (await Promise.all(resourceTypes.map((resourceType) => listResourcesPg(context.db, { resourceType })))).flat().filter((resource) => resource.runId === runId);
      return json(kind, resources);
    }

    const approvalsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/approvals$/);
    if (request.method === "GET" && approvalsMatch) {
      const runId = decodeURIComponent(approvalsMatch[1]!);
      return json("approvals", (await listResourcesPg(context.db, { resourceType: "approval" })).filter((resource) => resource.runId === runId));
    }

    const approvalDecisionMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/approvals\/([^/]+)\/decision$/);
    if (request.method === "POST" && approvalDecisionMatch) {
      const body = await readJsonBody<{ decision?: "approved" | "rejected"; reason?: string }>(request);
      if (body.decision !== "approved" && body.decision !== "rejected") throw new Error("decision must be approved or rejected");
      if (!body.reason) throw new Error("reason is required");
      return json("approval-decision", await decideApprovalPg(context, {
        runId: decodeURIComponent(approvalDecisionMatch[1]!),
        approvalId: decodeURIComponent(approvalDecisionMatch[2]!),
        decision: body.decision,
        reason: body.reason,
      }));
    }

    const steerMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/steering$/);
    if (request.method === "POST" && steerMatch) {
      const body = await readJsonBody<{ message?: string }>(request);
      if (!body.message) throw new Error("message is required");
      const runId = decodeURIComponent(steerMatch[1]!);
      const event = await appendHistoryEventPg(context.db, { runId, eventType: "steering.message", actorType: "user", payload: { message: body.message } });
      return json("steering", event);
    }

    const voiceMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/voice-command$/);
    if (request.method === "POST" && voiceMatch) {
      const body = await readJsonBody<{ transcript?: string }>(request);
      if (!body.transcript) throw new Error("transcript is required");
      const runId = decodeURIComponent(voiceMatch[1]!);
      await appendHistoryEventPg(context.db, { runId, eventType: "voice.command_received", actorType: "user", payload: { transcript: body.transcript } });
      const riskTags = riskTagsForVoiceTranscript(body.transcript);
      const policy = evaluateApprovalPolicy({ mode: "policy", actionType: "voiceCommand", riskTags });
      const approval = policy.status === "pending" ? await createApprovalPg(context, { runId, actionType: "voiceCommand", riskTags, title: "Review voice command", payload: { transcript: body.transcript, policyReason: policy.reason } }) : undefined;
      const event = await appendHistoryEventPg(context.db, { runId, eventType: "steering.message", actorType: "user", payload: { message: body.transcript } });
      return json("voice-command", { transcript: body.transcript, approval, event });
    }

    const envelopeMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/envelope$/);
    if (request.method === "GET" && envelopeMatch) {
      return json("task-envelope", await getPostgresTaskEnvelope(context.db, { runId: decodeURIComponent(envelopeMatch[1]!), taskId: decodeURIComponent(envelopeMatch[2]!) }));
    }

    if (request.method === "POST" && url.pathname === "/api/v2/executor/heartbeat") {
      const body = await readJsonBody<Record<string, unknown>>(request);
      const runId = requiredString(body.runId, "runId");
      const taskId = requiredString(body.taskId, "taskId");
      const attemptId = requiredString(body.attemptId, "attemptId");
      const observedAt = typeof body.observedAt === "string" ? body.observedAt : new Date().toISOString();
      const heartbeatSeq = typeof body.heartbeatSeq === "number" && Number.isFinite(body.heartbeatSeq) ? body.heartbeatSeq : 1;
      const runnerPhase = requiredString(body.phase, "phase") as never;
      const bindingId = `executor-${runId}-${taskId}-${attemptId}`;
      const managedResult = await patchManagedHandExecutionHeartbeatPg(context.db, {
        runId,
        taskId,
        attemptId,
        sessionId: optionalString(body.sessionId) ?? optionalString(body.rootSessionId),
        observedAt,
        heartbeatSeq,
      });
      if (managedResult?.ignoredTerminal) return json("executor-heartbeat", managedResult);

      const binding = await getExecutorBindingPg(context.db, bindingId);
      if (!managedResult && !binding) throw new Error(`managed hand execution not found: hand-execution:${runId}:${taskId}:${attemptId}`);
      const result = binding
        ? await updateExecutorBindingStatusPg(context.db, {
          bindingId,
          status: "running",
          eventType: "executor.heartbeat",
          payloadPatch: {
            lastHeartbeatAt: observedAt,
            heartbeatSeq,
            runnerPhase,
          },
          eventPayload: { message: typeof body.message === "string" ? body.message : undefined },
        })
        : managedResult!;
      return json("executor-heartbeat", result);
    }

    if (request.method === "POST" && url.pathname === "/api/v2/executor/reconcile") {
      if (!context.torkObservationClient) throw new Error("torkObservationClient is required for executor reconcile");
      return json("executor-reconcile", await reconcileExecutorBindingsPg(context.db, { tork: context.torkObservationClient }));
    }

    if (request.method === "POST" && url.pathname === "/api/v2/executor/bindings") {
      const body = await readJsonBody<Record<string, unknown>>(request);
      return json("executor-binding", await createExecutorBindingPg(context.db, {
        runId: requiredString(body.runId, "runId"),
        taskId: requiredString(body.taskId, "taskId"),
        attemptId: requiredString(body.attemptId, "attemptId"),
        torkJobId: requiredString(body.torkJobId, "torkJobId"),
        torkTaskId: typeof body.torkTaskId === "string" ? body.torkTaskId : undefined,
        status: parseExecutorBindingStatus(body.status),
        now: typeof body.now === "string" ? body.now : undefined,
        queueTimeoutSeconds: numberFromBody(body.queueTimeoutSeconds, "queueTimeoutSeconds"),
        hardTimeoutSeconds: numberFromBody(body.hardTimeoutSeconds, "hardTimeoutSeconds"),
      }));
    }

    if (request.method === "GET" && url.pathname === "/api/v2/executor/bindings") {
      const runId = url.searchParams.get("runId");
      if (runId) return json("executor-bindings", await listExecutorBindingsForRunPg(context.db, runId));
      return json("executor-bindings", await listResourcesPg(context.db, { resourceType: "executor_binding" }));
    }

    const bindingMatch = url.pathname.match(/^\/api\/v2\/executor\/bindings\/([^/]+)$/);
    if (request.method === "GET" && bindingMatch) {
      const binding = await getExecutorBindingPg(context.db, decodeURIComponent(bindingMatch[1]!));
      if (!binding) throw new Error("executor binding not found");
      return json("executor-binding", binding);
    }

    if (request.method === "POST" && url.pathname === "/api/v2/tork/callback") {
      return json("callback", await ingestTaskRunResultPg(context.db, validatedCallbackResultPg(await readJsonBody(request))));
    }

    return errorResponse("not found", 404);
  } catch (error) {
    return errorResponse((error as Error).message, 400);
  }
}

async function patchManagedHandExecutionHeartbeatPg(
  db: SouthstarDb,
  input: { runId: string; taskId: string; attemptId: string; sessionId?: string; observedAt: string; heartbeatSeq: number },
): Promise<{ id: string; runId: string; taskId: string; status: string; payload: Record<string, unknown>; ignoredTerminal?: boolean } | null> {
  const handExecutionId = `hand-execution:${input.runId}:${input.taskId}:${input.attemptId}`;
  const existing = await getResourceByKeyPg(db, "hand_execution", handExecutionId);
  if (!existing) return null;
  if (isTerminalHandExecutionStatus(existing.status)) {
    return {
      id: existing.id,
      runId: input.runId,
      taskId: input.taskId,
      status: existing.status,
      payload: asRecord(existing.payload),
      ignoredTerminal: true,
    };
  }
  const existingPayload = asRecord(existing.payload);
  const sessionId = input.sessionId ?? stringValue(existingPayload.sessionId);
  const nextPayload = {
    ...existingPayload,
    schemaVersion: "southstar.runtime.hand_execution.v1",
    handExecutionId,
    providerId: "tork",
    runId: input.runId,
    taskId: input.taskId,
    ...(sessionId ? { sessionId } : {}),
    attemptId: input.attemptId,
    status: "running",
    startedAt: stringValue(existingPayload.startedAt) ?? input.observedAt,
    lastHeartbeatAt: input.observedAt,
    heartbeatSeq: input.heartbeatSeq,
  };
  const summary = {
    ...asRecord(existing.summary),
    providerId: "tork",
    attemptId: input.attemptId,
    status: "running",
  };
  const update = await db.query<{ id: string }>(
    `update southstar.runtime_resources
     set run_id = $2,
         task_id = $3,
         session_id = $4,
         scope = 'hand',
         status = 'running',
         title = coalesce(title, $5),
         payload_json = $6::jsonb,
         summary_json = $7::jsonb,
         metrics_json = $8::jsonb,
         updated_at = now()
     where id = $1
       and status <> all($9::text[])
     returning id`,
    [
      existing.id,
      input.runId,
      input.taskId,
      sessionId ?? null,
      `Hand execution ${input.taskId}`,
      JSON.stringify(nextPayload),
      JSON.stringify(summary),
      JSON.stringify(existing.metrics ?? {}),
      TERMINAL_HAND_EXECUTION_STATUSES,
    ],
  );
  const id = update.rows[0]?.id;
  if (!id) {
    const latest = await getResourceByKeyPg(db, "hand_execution", handExecutionId);
    if (latest && isTerminalHandExecutionStatus(latest.status)) {
      return {
        id: latest.id,
        runId: input.runId,
        taskId: input.taskId,
        status: latest.status,
        payload: asRecord(latest.payload),
        ignoredTerminal: true,
      };
    }
    throw new Error(`managed hand execution heartbeat update lost race: ${handExecutionId}`);
  }
  await db.query(
    "update southstar.workflow_tasks set status = 'running', updated_at = now() where run_id = $1 and id = $2 and status in ('queued', 'claimed')",
    [input.runId, input.taskId],
  );
  await db.query(
    "update southstar.workflow_runs set status = 'running', updated_at = now() where id = $1 and status = 'scheduling'",
    [input.runId],
  );
  return { id, runId: input.runId, taskId: input.taskId, status: "running", payload: nextPayload };
}

async function createApprovalPg(context: RuntimeServerContext, input: { runId: string; actionType: string; riskTags: string[]; title: string; payload: Record<string, unknown> }) {
  const approvalId = `approval-${crypto.randomUUID()}`;
  await upsertRuntimeResourcePg(context.db, {
    id: approvalId,
    resourceType: "approval",
    resourceKey: approvalId,
    runId: input.runId,
    scope: "approval",
    status: "pending",
    title: input.title,
    payload: { ...input.payload, actionType: input.actionType, riskTags: input.riskTags },
  });
  await appendHistoryEventPg(context.db, { runId: input.runId, eventType: "approval.requested", actorType: "orchestrator", payload: { approvalId, actionType: input.actionType, riskTags: input.riskTags } });
  return { id: approvalId, status: "pending" as const };
}

async function decideApprovalPg(context: RuntimeServerContext, input: { runId: string; approvalId: string; decision: "approved" | "rejected"; reason: string }) {
  const row = await context.db.maybeOne<{ payload_json: Record<string, unknown>; title: string | null; task_id: string | null }>(
    "select payload_json, title, task_id from southstar.runtime_resources where resource_type = 'approval' and resource_key = $1 and run_id = $2",
    [input.approvalId, input.runId],
  );
  if (!row) throw new Error(`approval not found: ${input.approvalId}`);
  await upsertRuntimeResourcePg(context.db, {
    id: input.approvalId,
    resourceType: "approval",
    resourceKey: input.approvalId,
    runId: input.runId,
    taskId: row.task_id ?? undefined,
    scope: "approval",
    status: input.decision,
    title: row.title ?? "Approval",
    payload: { ...row.payload_json, decision: input.decision, decisionReason: input.reason, decidedBy: "user" },
  });
  await appendHistoryEventPg(context.db, { runId: input.runId, taskId: row.task_id ?? undefined, eventType: "approval.decided", actorType: "user", payload: { approvalId: input.approvalId, decision: input.decision, reason: input.reason } });
  return { id: input.approvalId, status: input.decision };
}

async function readJsonBody<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function riskTagsForVoiceTranscript(transcript: string): string[] {
  const normalized = transcript.toLowerCase();
  const tags = new Set<string>();
  if (/secret|vault|token|password|credential|金鑰|密鑰|憑證/.test(normalized)) tags.add("secret-access");
  if (/external|webhook|send it|upload|外部|傳送/.test(normalized)) tags.add("external-write");
  return tags.size === 0 ? ["low-risk"] : [...tags];
}

function validatedCallbackResultPg(body: unknown): PostgresTaskRunCallbackResult {
  if (!isRecord(body)) throw new Error("callback body must be an object");
  return {
    runId: requiredString(body.runId, "runId"),
    taskId: requiredString(body.taskId, "taskId"),
    rootSessionId: requiredString(body.rootSessionId, "rootSessionId"),
    ok: typeof body.ok === "boolean" ? body.ok : false,
    attempts: typeof body.attempts === "number" && Number.isFinite(body.attempts) ? body.attempts : 1,
    attemptId: typeof body.attemptId === "string" ? body.attemptId : undefined,
    artifact: isRecord(body.artifact) ? body.artifact : {},
    metrics: isRecord(body.metrics) ? body.metrics : {},
    events: Array.isArray(body.events) ? body.events.map(validateCallbackEvent) : [],
    receivedAt: typeof body.receivedAt === "string" ? body.receivedAt : undefined,
    materializationRoot: "/tmp/southstar-runs",
  };
}

function validateCallbackEvent(event: unknown): PostgresTaskRunCallbackResult["events"][number] {
  if (!isRecord(event)) throw new Error("callback event must be an object");
  return {
    eventType: requiredString(event.eventType, "eventType"),
    actorType: requiredString(event.actorType, "actorType") as PostgresTaskRunCallbackResult["events"][number]["actorType"],
    sessionId: typeof event.sessionId === "string" ? event.sessionId : undefined,
    payload: event.payload,
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function parseOptionalPriority(value: unknown): WorkItemIntakePriority | undefined {
  if (value === undefined) return undefined;
  if (value === "low" || value === "normal" || value === "high" || value === "urgent") return value;
  throw new Error("priority must be one of low, normal, high, urgent");
}

function requiredWorkItemSourceProvider(value: unknown): WorkItemSourceProvider {
  const allowed = ["local", "github", "linear", "jira", "slack", "api", "custom", "cli", "ui", "scheduler"] as const;
  if (typeof value !== "string" || !allowed.includes(value as typeof allowed[number])) {
    throw new Error("sourceProvider is required");
  }
  return value as WorkItemSourceProvider;
}

function numberFromBody(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a positive number`);
  return value;
}

function parseExecutorBindingStatus(value: unknown): "submitted" | "queued" | "starting" | "running" | "heartbeat-lost" | "queue-timeout" | "hard-timeout" | "callback-missing" | "completed" | "failed" | "cancelled" | "lost" | "orphaned" {
  const allowed = [
    "submitted",
    "queued",
    "starting",
    "running",
    "heartbeat-lost",
    "queue-timeout",
    "hard-timeout",
    "callback-missing",
    "completed",
    "failed",
    "cancelled",
    "lost",
    "orphaned",
  ] as const;
  if (typeof value !== "string" || !allowed.includes(value as typeof allowed[number])) {
    throw new Error("status must be a supported executor binding status");
  }
  return value as typeof allowed[number];
}

function isTerminalHandExecutionStatus(status: string): boolean {
  return (TERMINAL_HAND_EXECUTION_STATUSES as readonly string[]).includes(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", ...corsHeaders() } });
}

function errorResponse(error: string, status: number): Response {
  const envelope: ApiErrorEnvelope = { ok: false, error };
  return new Response(JSON.stringify(envelope), { status, headers: { "content-type": "application/json", ...corsHeaders() } });
}

function isReadModelKind(kind: string): kind is ReadModelKind {
  return ["run-inspection", "runtime-monitor", "workflow-canvas", "executor-ops", "task-detail", "sessions-memory", "vault-mcp", "evolution-control-center"].includes(kind);
}

function corsHeaders(): Record<string, string> {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
}
