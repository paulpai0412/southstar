import { evaluateApprovalPolicy } from "../approvals/policy.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { createExecutorBindingPg, getExecutorBindingPg, listExecutorBindingsForRunPg, updateExecutorBindingStatusPg } from "../executor/postgres-bindings.ts";
import { reconcileExecutorBindingsPg } from "../executor/postgres-reconciler.ts";
import { ingestTaskRunResultPg, type PostgresTaskRunCallbackResult } from "../executor/postgres-tork-callback.ts";
import { decideRecoveryDecisionApprovalPg } from "../exceptions/recovery-approval-service.ts";
import { createRecoveryDecisionApplier } from "../exceptions/recovery-decision-applier.ts";
import { RECOVERY_DECISION_SCHEMA_VERSION } from "../exceptions/types.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import type { WorkflowCompositionPlan } from "../design-library/types.ts";
import { buildEvolutionControlCenterReadModel } from "../read-models/evolution-control-center.ts";
import { envelopeReadModel } from "../read-models/envelope.ts";
import { buildAgentLibraryCandidatesReadModelPg, buildAgentLibraryReadModelPg } from "../read-models/agent-library.ts";
import { buildPostgresCoreReadModel, isPostgresCoreReadModelKind } from "../read-models/postgres-core.ts";
import { buildRunInspectionReadModelPg, buildRuntimeExceptionReadModelPg } from "../read-models/postgres-run-inspection.ts";
import type { ReadModelKind } from "../read-models/types.ts";
import { appendHistoryEventPg, getResourceByKeyPg, getWorkflowRunPg, listHistoryForRunPg, listResourcesPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import {
  createPostgresPlannerDraft,
  createPostgresRunFromDraft,
  getPostgresPlannerDraftOrchestration,
  patchPostgresPlannerDraftTaskProfileOverride,
  revisePostgresPlannerDraft,
  validatePostgresPlannerDraft,
  type PlannerDraftLibraryHints,
} from "../ui-api/postgres-run-api.ts";
import type { WorkflowComposerMode } from "../orchestration/composer-registry.ts";
import { LlmWorkflowComposer } from "../orchestration/llm-composer.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import { getPostgresTaskEnvelope } from "../ui-api/postgres-task-envelope.ts";
import { intakeWorkItemPg } from "../work-items/intake-service.ts";
import { materializeRunFromWorkItemPg } from "../work-items/run-materialization.ts";
import type { WorkItemIntakePriority, WorkItemSourceProvider } from "../work-items/types.ts";
import { handleEvolutionRoute } from "./evolution-routes.ts";
import { handleExecutionRoute } from "./execution-routes.ts";
import { handleRunLifecycleRoute } from "./run-lifecycle-routes.ts";
import { handleMemoryRoute } from "./memory-routes.ts";
import { handleChatRoute } from "./chat-routes.ts";
import { handleLibraryRoute } from "./library-routes.ts";
import { handleSessionRoute } from "./session-routes.ts";
import { handleTaskCommandRoute } from "./task-command-routes.ts";
import { startRunSchedulingPg } from "./run-execution-controller.ts";
import { handleUiRoute } from "./ui-routes.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import { createRuntimeEventStreamResponse } from "./runtime-event-stream.ts";
import { parseRuntimeLoopId } from "./runtime-loop-registry.ts";
import { parseRuntimeEventSequence, readRunEventsSince } from "./sse.ts";
import type { ApiEnvelope, ApiErrorEnvelope } from "./types.ts";

const TERMINAL_HAND_EXECUTION_STATUSES = ["completed", "failed", "cancelled", "lost", "superseded"] as const;
const PROTECTED_HAND_EXECUTION_HEARTBEAT_STATUSES = [...TERMINAL_HAND_EXECUTION_STATUSES, "cancel_requested"] as const;

export async function handleRuntimeRoute(context: RuntimeServerContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    const evolutionResponse = await handleEvolutionRoute(context, request, url);
    if (evolutionResponse) return evolutionResponse;
    const uiResponse = await handleUiRoute(context, request, url);
    if (uiResponse) return uiResponse;
    const runLifecycleResponse = await handleRunLifecycleRoute(context, request, url);
    if (runLifecycleResponse) return runLifecycleResponse;
    const sessionResponse = await handleSessionRoute(context, request, url);
    if (sessionResponse) return sessionResponse;
    const memoryResponse = await handleMemoryRoute(context, request, url);
    if (memoryResponse) return memoryResponse;
    const chatResponse = await handleChatRoute(context, request, url);
    if (chatResponse) return chatResponse;
    const libraryResponse = await handleLibraryRoute(context, request, url);
    if (libraryResponse) return libraryResponse;
    const executionResponse = await handleExecutionRoute(context, request, url);
    if (executionResponse) return executionResponse;
    const taskCommandResponse = await handleTaskCommandRoute(context, request, url);
    if (taskCommandResponse) return taskCommandResponse;

    if (request.method === "GET" && url.pathname === "/api/v2/agent-library") {
      return json("agent-library", await buildAgentLibraryReadModelPg(context.db, {
        domain: url.searchParams.get("domain") ?? undefined,
      }));
    }

    if (request.method === "GET" && url.pathname === "/api/v2/agent-library/candidates") {
      return json("agent-library-candidates", await buildAgentLibraryCandidatesReadModelPg(context.db, {
        draftId: requiredQueryParam(url, "draftId"),
        taskId: url.searchParams.get("taskId") ?? undefined,
      }));
    }

    if (request.method === "GET" && url.pathname === "/api/v2/runtime/health") {
      const database = await databaseHealth(context);
      return json("runtime-health", {
        database,
        managedRuntime: { configured: Boolean(context.managedRuntime) },
        torkObservation: { configured: Boolean(context.torkObservationClient) },
        loops: { configured: context.runtimeLoopRegistry?.list().length ?? 0 },
      }, database.ok ? 200 : 503);
    }

    if (request.method === "GET" && url.pathname === "/api/v2/runtime/loops") {
      return json("runtime-loops", { loops: context.runtimeLoopRegistry?.list() ?? [] });
    }

    const loopTickMatch = url.pathname.match(/^\/api\/v2\/runtime\/loops\/([^/]+)\/tick$/);
    if (request.method === "POST" && loopTickMatch) {
      if (!context.runtimeLoopRegistry) throw new Error("runtimeLoopRegistry is not configured");
      if (!context.manualRuntimeLoopControls) throw new Error("manual runtime loop controls are disabled");
      const loopId = parseRuntimeLoopId(decodeURIComponent(loopTickMatch[1]!));
      return json("runtime-loop-tick", await context.runtimeLoopRegistry.tick(loopId));
    }

    if (request.method === "POST" && url.pathname === "/api/v2/runtime/wake") {
      if (!context.runtimeLoopRegistry) throw new Error("runtimeLoopRegistry is not configured");
      if (!context.manualRuntimeLoopControls) throw new Error("manual runtime loop controls are disabled");
      const results = [];
      for (const loop of context.runtimeLoopRegistry.list()) {
        results.push(await context.runtimeLoopRegistry.tick(loop.id));
      }
      return json("runtime-wake", { results });
    }

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
      const body = await readJsonBody<{ goalPrompt?: string; orchestrationMode?: unknown; composerMode?: unknown }>(request);
      if (!body.goalPrompt) throw new Error("goalPrompt is required");
      const draft = await createPostgresPlannerDraft(context.db, {
        goalPrompt: body.goalPrompt,
        orchestrationMode: optionalOrchestrationMode(body.orchestrationMode),
        composerMode: optionalComposerMode(body.composerMode),
        composer: resolvePlannerWorkflowComposer(context),
      });
      const run = await createPostgresRunFromDraft(context.db, { draftId: draft.draftId });
      return json("run-goal", { draft, ...run });
    }

    if (request.method === "POST" && url.pathname === "/api/v2/planner/drafts/stream") {
      const body = await readJsonBody<{
        goalPrompt?: unknown;
        orchestrationMode?: unknown;
        composerMode?: unknown;
        domainPackId?: unknown;
        cwd?: unknown;
        compositionPlan?: unknown;
        libraryHints?: unknown;
      }>(request);
      return createPlannerDraftStreamResponse(context, body);
    }

    const draftReviseStreamMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/revise\/stream$/);
    if (request.method === "POST" && draftReviseStreamMatch) {
      const body = await readJsonBody<{ prompt?: unknown; orchestrationMode?: unknown; composerMode?: unknown }>(request);
      return createPlannerDraftRevisionStreamResponse(context, decodeURIComponent(draftReviseStreamMatch[1]!), body);
    }

    if (request.method === "POST" && url.pathname === "/api/v2/planner/drafts") {
      const body = await readJsonBody<{
        goalPrompt?: unknown;
        orchestrationMode?: unknown;
        composerMode?: unknown;
        domainPackId?: unknown;
        cwd?: unknown;
        compositionPlan?: unknown;
        libraryHints?: unknown;
      }>(request);
      const plannerRequest = parsePlannerDraftRequest(body);
      return json(
        "planner-draft",
        await createPostgresPlannerDraft(context.db, {
          ...plannerRequest,
          composer: resolvePlannerWorkflowComposer(context),
        }),
      );
    }

    const draftReviseMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/revise$/);
    if (request.method === "POST" && draftReviseMatch) {
      const body = await readJsonBody<{ prompt?: unknown; orchestrationMode?: unknown; composerMode?: unknown }>(request);
      return json(
        "planner-draft",
        await revisePostgresPlannerDraft(context.db, {
          draftId: decodeURIComponent(draftReviseMatch[1]!),
          prompt: requiredString(body.prompt, "prompt"),
          orchestrationMode: optionalOrchestrationMode(body.orchestrationMode),
          composerMode: optionalComposerMode(body.composerMode),
          composer: resolvePlannerWorkflowComposer(context),
        }),
      );
    }

    const draftOrchestrationMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/orchestration$/);
    if (request.method === "GET" && draftOrchestrationMatch) {
      const draftId = decodeURIComponent(draftOrchestrationMatch[1]!);
      return json("planner-draft-orchestration", await getPostgresPlannerDraftOrchestration(context.db, { draftId }));
    }

    const draftValidateMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/validate$/);
    if (request.method === "POST" && draftValidateMatch) {
      const draftId = decodeURIComponent(draftValidateMatch[1]!);
      return json("planner-draft", await validatePostgresPlannerDraft(context.db, { draftId }));
    }

    const draftRunMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/runs$/);
    if (request.method === "POST" && draftRunMatch) {
      const draftId = decodeURIComponent(draftRunMatch[1]!);
      return json("run", await createPostgresRunFromDraft(context.db, { draftId }));
    }

    const profileOverrideMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/tasks\/([^/]+)\/profile-override$/);
    if (request.method === "PATCH" && profileOverrideMatch) {
      return json("planner-draft-task-profile-override", await patchPostgresPlannerDraftTaskProfileOverride(context.db, {
        draftId: decodeURIComponent(profileOverrideMatch[1]!),
        taskId: decodeURIComponent(profileOverrideMatch[2]!),
        profileOverride: await readJsonBody<any>(request),
      }));
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

    const recoveryDecisionApplyMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/recovery-decisions\/([^/]+)\/apply$/);
    if (request.method === "POST" && recoveryDecisionApplyMatch) {
      const runId = decodeURIComponent(recoveryDecisionApplyMatch[1]!);
      const decisionId = decodeURIComponent(recoveryDecisionApplyMatch[2]!);
      const decision = await context.db.maybeOne<{ resource_key: string; payload_json: unknown }>(
        `select resource_key, payload_json
           from southstar.runtime_resources
          where run_id = $1
            and resource_type = 'recovery_decision'
            and payload_json->>'decisionId' = $2
            and payload_json->>'schemaVersion' = $3`,
        [runId, decisionId, RECOVERY_DECISION_SCHEMA_VERSION],
      );
      if (!decision) throw new Error(`runtime recovery decision not found: ${decisionId}`);
      if (!isRecord(decision.payload_json)) throw new Error(`runtime recovery decision payload invalid: ${decisionId}`);
      if (decision.payload_json.runId !== runId) {
        throw new Error(`runtime recovery decision payload runId mismatch: route run ${runId} payload run ${String(decision.payload_json.runId)}`);
      }
      const providerActions = context.managedRuntime?.providerActions ?? context.providerActions;
      const applier = createRecoveryDecisionApplier({
        db: context.db,
        ...(context.managedRuntime?.sessionStore ? { sessionStore: context.managedRuntime.sessionStore } : {}),
        ...(context.managedRuntime?.brainProvider ? { brainProvider: context.managedRuntime.brainProvider } : {}),
        ...(context.managedRuntime?.handProvider ? { handProvider: context.managedRuntime.handProvider } : {}),
        ...(providerActions ? { providerActions } : {}),
      });
      return json("recovery-decision-apply", await applier.applyDecision({
        decisionResourceKey: decision.resource_key,
      }));
    }

    const recoveryDecisionApprovalMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/recovery-decisions\/([^/]+)\/approval$/);
    if (request.method === "POST" && recoveryDecisionApprovalMatch) {
      const body = await readJsonBody<{ decision?: unknown; reason?: unknown }>(request);
      if (body.decision !== "approved" && body.decision !== "rejected") throw new Error("decision must be approved or rejected");
      return json("recovery-decision-approval", await decideRecoveryDecisionApprovalPg(context.db, {
        runId: decodeURIComponent(recoveryDecisionApprovalMatch[1]!),
        decisionId: decodeURIComponent(recoveryDecisionApprovalMatch[2]!),
        decision: body.decision,
        reason: requiredString(body.reason, "reason"),
      }));
    }

    const eventsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const after = parseRuntimeEventSequence(url.searchParams.get("after"));
      return json("events", await readRunEventsSince(context.db, { runId: decodeURIComponent(eventsMatch[1]!), afterSequence: after }));
    }

    const exceptionsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/exceptions$/);
    if (request.method === "GET" && exceptionsMatch) {
      return json("runtime-exceptions", await buildRuntimeExceptionReadModelPg(context.db, { runId: decodeURIComponent(exceptionsMatch[1]!) }));
    }

    const streamMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events\/stream$/);
    if (request.method === "GET" && streamMatch) {
      return createRuntimeEventStreamResponse(context, request, url, decodeURIComponent(streamMatch[1]!));
    }

    const readModelMatch = url.pathname.match(/^\/api\/v2\/read-models\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
    if (request.method === "GET" && readModelMatch) {
      const kind = decodeURIComponent(readModelMatch[1]!) as ReadModelKind;
      if (!isReadModelKind(kind)) throw new Error(`unknown read model kind: ${kind}`);
      const runId = decodeURIComponent(readModelMatch[2]!);
      const taskId = readModelMatch[3] ? decodeURIComponent(readModelMatch[3]) : undefined;
      if (kind === "evolution-control-center") return json("read-model", await buildEvolutionControlCenterReadModel(context.db));
      if (kind === "run-inspection") return json("read-model", await buildRunInspectionReadModelPg(context.db, runId));
      if (kind === "exceptions") {
        return json("read-model", envelopeReadModel({
          schemaVersion: "southstar.read_model.exceptions.v1",
          kind,
          data: await buildRuntimeExceptionReadModelPg(context.db, { runId }),
        }));
      }
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
      const callback = validatedCallbackResultPg(await readJsonBody(request));
      return json("callback", await ingestTaskRunResultPg(context.db, callback));
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
  if (isProtectedHandExecutionStatus(existing.status)) {
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
      PROTECTED_HAND_EXECUTION_HEARTBEAT_STATUSES,
    ],
  );
  const id = update.rows[0]?.id;
  if (!id) {
    const latest = await getResourceByKeyPg(db, "hand_execution", handExecutionId);
    if (latest && isProtectedHandExecutionStatus(latest.status)) {
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

function createPlannerDraftStreamResponse(
  context: RuntimeServerContext,
  body: {
    goalPrompt?: unknown;
    orchestrationMode?: unknown;
    composerMode?: unknown;
    domainPackId?: unknown;
    cwd?: unknown;
    libraryHints?: unknown;
  },
): Response {
  const plannerRequest = parsePlannerDraftRequest(body);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        send("planner.stage", { stage: "request.accepted", message: "Accepted workflow generation request." });
        const composer = resolvePlannerWorkflowComposer(context, {
          onStreamDegraded(message) {
            send("planner.stage", { stage: "planner.stream.degraded", message });
          },
        });
        const draft = await createPostgresPlannerDraft(context.db, {
          ...plannerRequest,
          composer,
          onProgress(event) {
            send("planner.stage", event);
          },
          onLlmDelta(text) {
            send("message.delta", { text });
          },
        });
        send("draft", { draft });
        send("planner.stage", { stage: "orchestration.loading", message: "Loading planner draft orchestration." });
        const orchestration = await getPostgresPlannerDraftOrchestration(context.db, { draftId: draft.draftId });
        send("orchestration", { orchestration });
        send("done", {});
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function createPlannerDraftRevisionStreamResponse(
  context: RuntimeServerContext,
  draftId: string,
  body: {
    prompt?: unknown;
    orchestrationMode?: unknown;
    composerMode?: unknown;
  },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        send("planner.stage", { stage: "revision.requested", message: "Accepted workflow revision request." });
        const composer = resolvePlannerWorkflowComposer(context, {
          onStreamDegraded(message) {
            send("planner.stage", { stage: "planner.stream.degraded", message });
          },
        });
        const draft = await revisePostgresPlannerDraft(context.db, {
          draftId,
          prompt: requiredString(body.prompt, "prompt"),
          orchestrationMode: optionalOrchestrationMode(body.orchestrationMode),
          composerMode: optionalComposerMode(body.composerMode),
          composer,
          onProgress(event) {
            send("planner.stage", event);
          },
          onLlmDelta(text) {
            send("message.delta", { text });
          },
        });
        send("draft", { draft });
        send("planner.stage", { stage: "orchestration.loading", message: "Loading revised planner draft orchestration." });
        const orchestration = await getPostgresPlannerDraftOrchestration(context.db, { draftId: draft.draftId });
        send("orchestration", { orchestration });
        send("done", {});
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
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

function parsePlannerDraftRequest(body: {
  goalPrompt?: unknown;
  orchestrationMode?: unknown;
  composerMode?: unknown;
  domainPackId?: unknown;
  cwd?: unknown;
  compositionPlan?: unknown;
  libraryHints?: unknown;
}): {
  goalPrompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: WorkflowComposerMode;
  domainPackId?: string;
  cwd?: string;
  compositionPlan?: WorkflowCompositionPlan;
  libraryHints?: PlannerDraftLibraryHints;
} {
  return {
    goalPrompt: requiredString(body.goalPrompt, "goalPrompt"),
    orchestrationMode: optionalOrchestrationMode(body.orchestrationMode),
    composerMode: optionalComposerMode(body.composerMode),
    domainPackId: optionalString(body.domainPackId),
    cwd: optionalString(body.cwd),
    compositionPlan: optionalWorkflowCompositionPlan(body.compositionPlan),
    libraryHints: optionalPlannerDraftLibraryHints(body.libraryHints),
  };
}

function optionalWorkflowCompositionPlan(value: unknown): WorkflowCompositionPlan | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("compositionPlan must be an object");
  if (value.schemaVersion !== "southstar.workflow_composition_plan.v1") {
    throw new Error("compositionPlan.schemaVersion must be southstar.workflow_composition_plan.v1");
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new Error("compositionPlan.title is required");
  }
  if (typeof value.selectedWorkflowTemplateRef !== "string" || value.selectedWorkflowTemplateRef.length === 0) {
    throw new Error("compositionPlan.selectedWorkflowTemplateRef is required");
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new Error("compositionPlan.tasks is required");
  }
  return value as WorkflowCompositionPlan;
}

function optionalPlannerDraftLibraryHints(value: unknown): PlannerDraftLibraryHints | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("libraryHints must be an object");
  return {
    roleRefs: parseOptionalStringArray(value.roleRefs, "libraryHints.roleRefs"),
    agentProfileRefs: parseOptionalStringArray(value.agentProfileRefs, "libraryHints.agentProfileRefs"),
    skillRefs: parseOptionalStringArray(value.skillRefs, "libraryHints.skillRefs"),
    mcpGrantRefs: parseOptionalStringArray(value.mcpGrantRefs, "libraryHints.mcpGrantRefs"),
    toolRefs: parseOptionalStringArray(value.toolRefs, "libraryHints.toolRefs"),
    modelHints: parseOptionalStringRecord(value.modelHints, "libraryHints.modelHints"),
    vaultLeasePolicyRefs: parseOptionalStringArray(value.vaultLeasePolicyRefs, "libraryHints.vaultLeasePolicyRefs"),
    toolPolicyHints: optionalPlannerDraftToolPolicyHints(value.toolPolicyHints),
  };
}

function optionalPlannerDraftToolPolicyHints(value: unknown): PlannerDraftLibraryHints["toolPolicyHints"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("libraryHints.toolPolicyHints must be an object");
  return {
    allowedTools: parseOptionalStringArray(value.allowedTools, "libraryHints.toolPolicyHints.allowedTools"),
    deniedTools: parseOptionalStringArray(value.deniedTools, "libraryHints.toolPolicyHints.deniedTools"),
    requiresApprovalFor: parseOptionalStringArray(value.requiresApprovalFor, "libraryHints.toolPolicyHints.requiresApprovalFor"),
  };
}

function parseOptionalStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an object with string values`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item as string]));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredQueryParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalOrchestrationMode(value: unknown): "deterministic" | "llm-constrained" | undefined {
  if (value === undefined) return undefined;
  if (value === "deterministic" || value === "llm-constrained") return value;
  throw new Error("orchestrationMode must be deterministic or llm-constrained");
}

function optionalComposerMode(value: unknown): WorkflowComposerMode | undefined {
  if (value === undefined) return undefined;
  if (value === "fixture" || value === "llm" || value === "llm-with-fixture-fallback") return value;
  throw new Error("composerMode must be fixture, llm, or llm-with-fixture-fallback");
}

function resolvePlannerWorkflowComposer(
  context: RuntimeServerContext,
  options: { onStreamDegraded?: (message: string) => void } = {},
): WorkflowComposer {
  if (context.workflowComposer) return context.workflowComposer;
  return new LlmWorkflowComposer({
    model: process.env.SOUTHSTAR_WORKFLOW_COMPOSER_MODEL ?? "southstar-runtime-workflow-composer",
    client: {
      async generateText(input) {
        return await context.plannerClient.generate(input.prompt);
      },
      async generateTextStream(input, handlers) {
        if (context.plannerClient.generateStream) {
          return await context.plannerClient.generateStream(input.prompt, { onDelta: handlers.onDelta });
        }
        options.onStreamDegraded?.("Planner client does not expose true token streaming; using final text only.");
        return await context.plannerClient.generate(input.prompt);
      },
    },
  });
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

function parseExecutorBindingStatus(value: unknown): "submitted" | "queued" | "starting" | "running" | "heartbeat-lost" | "queue-timeout" | "hard-timeout" | "callback-missing" | "cancel_requested" | "completed" | "failed" | "cancelled" | "lost" | "orphaned" {
  const allowed = [
    "submitted",
    "queued",
    "starting",
    "running",
    "heartbeat-lost",
    "queue-timeout",
    "hard-timeout",
    "callback-missing",
    "cancel_requested",
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

function isProtectedHandExecutionStatus(status: string): boolean {
  return (PROTECTED_HAND_EXECUTION_HEARTBEAT_STATUSES as readonly string[]).includes(status);
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

function json<T>(kind: string, result: T, status = 200): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { status, headers: { "content-type": "application/json", ...corsHeaders() } });
}

async function databaseHealth(context: RuntimeServerContext): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await context.db.query("select 1");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function errorResponse(error: string, status: number): Response {
  const envelope: ApiErrorEnvelope = { ok: false, error };
  return new Response(JSON.stringify(envelope), { status, headers: { "content-type": "application/json", ...corsHeaders() } });
}

function isReadModelKind(kind: string): kind is ReadModelKind {
  return [
    "run-inspection",
    "run-summary",
    "executions",
    "exceptions",
    "runtime-monitor",
    "workflow-canvas",
    "executor-ops",
    "task-detail",
    "sessions-memory",
    "vault-mcp",
    "evolution-control-center",
    "run-control",
    "workflow-dag",
  ].includes(kind);
}

function corsHeaders(): Record<string, string> {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", "access-control-allow-headers": "content-type,authorization,last-event-id" };
}
