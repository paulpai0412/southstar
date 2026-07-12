import { createHash } from "node:crypto";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import type { WorkflowComposerMode } from "../orchestration/composer-registry.ts";
import { LlmWorkflowComposer, loadWorkflowComposerSopPg } from "../orchestration/llm-composer.ts";
import {
  createLlmGoalDesigner,
  type GoalDesignMode,
  type WorkflowTemplatePolicyV1,
} from "../orchestration/goal-design.ts";
import {
  interpretGoalContractWithLlm,
  type GoalContractInterpreter,
} from "../orchestration/goal-contract.ts";
import {
  GoalSubmissionPendingError,
  claimGoalSubmissionPg,
  confirmGoalDesignPg,
  submitClaimedGoalPg,
  submitGoalPg,
  type GoalSubmissionClaim,
  type RunGoalResult,
  type RunGoalRequest,
} from "../orchestration/run-goal-service.ts";
import {
  isReviewableGoalDesignDraftPg,
  isGoalDesignVocabularyGapDraftPg,
  retryPostgresGoalDesignAfterVocabularyApprovalPg,
  loadCurrentGoalDesignPackagePg,
  reviseGoalDesignFromChatPg,
  reviseGoalSlicePg,
  reviseGoalTemplatePolicyPg,
  type GoalSlicePatchV1,
} from "../orchestration/goal-design-draft-service.ts";
import {
  createPostgresRunFromDraft,
  getPostgresPlannerDraftOrchestration,
  patchPostgresPlannerDraftTaskProfileOverride,
  revisePostgresPlannerDraft,
  validatePostgresPlannerDraft,
} from "../ui-api/postgres-run-api.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handlePlannerRoute(
  context: RuntimeServerContext,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (request.method === "POST" && url.pathname === "/api/v2/run-goal") {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const runGoalRequest: RunGoalRequest = {
      goalPrompt: requiredString(body.goalPrompt, "goalPrompt"),
      cwd: requiredString(body.cwd, "cwd"),
      idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey"),
      goalDesignMode: optionalGoalDesignMode(body.goalDesignMode),
      templatePolicy: optionalWorkflowTemplatePolicy(body.templatePolicy),
    };
    let claim: GoalSubmissionClaim;
    try {
      claim = await claimGoalSubmissionPg(context.db, runGoalRequest);
    } catch (error) {
      if (error instanceof GoalSubmissionPendingError) {
        return json("run-goal", { submissionId: error.submissionId, status: "processing" }, 202);
      }
      throw error;
    }
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      return createRunGoalStreamResponse(context, runGoalRequest, claim);
    }
    return json("run-goal", await submitClaimedGoalPg({
      db: context.db,
      goalInterpreter: resolveGoalInterpreter(context),
      goalDesigner: resolveGoalDesigner(context),
      composer: resolvePlannerWorkflowComposer(context),
      libraryImportLlmProvider: context.libraryImportLlmProvider,
      libraryImportSourceFetcher: context.libraryImportSourceFetcher,
    }, runGoalRequest, claim));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/planner/drafts/stream") {
    const body = await readJsonBody<{
      goalPrompt?: unknown;
      orchestrationMode?: unknown;
      composerMode?: unknown;
      cwd?: unknown;
      compositionPlan?: unknown;
      libraryHints?: unknown;
    }>(request);
    return createPlannerDraftStreamResponse(context, body);
  }

  const goalDesignConfirmMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/confirm-goal-design$/);
  if (request.method === "POST" && goalDesignConfirmMatch) {
    const draftId = decodeURIComponent(goalDesignConfirmMatch[1]!);
    const body = await readJsonBody<{ expectedPackageHash?: unknown }>(request);
    const expectedPackageHash = requiredString(body.expectedPackageHash, "expectedPackageHash");
    const occupied = await preflightGoalDesignConfirmation(context, { draftId, expectedPackageHash });
    if (occupied) return occupied;
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      return createGoalDesignConfirmationStreamResponse(context, { draftId, expectedPackageHash });
    }
    try {
      return json("goal-design-confirmation", await confirmGoalDesignPg({
        db: context.db,
        goalInterpreter: resolveGoalInterpreter(context),
        goalDesigner: resolveGoalDesigner(context),
        composer: resolvePlannerWorkflowComposer(context),
        libraryImportLlmProvider: context.libraryImportLlmProvider,
        libraryImportSourceFetcher: context.libraryImportSourceFetcher,
      }, { draftId, expectedPackageHash }));
    } catch (error) {
      return goalDesignConfirmationErrorResponse(error);
    }
  }

  const draftReviseStreamMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/revise\/stream$/);
  if (request.method === "POST" && draftReviseStreamMatch) {
    const body = await readJsonBody<{
      prompt?: unknown;
      orchestrationMode?: unknown;
      composerMode?: unknown;
      expectedPackageHash?: unknown;
      selectedSliceId?: unknown;
    }>(request);
    return createPlannerDraftRevisionStreamResponse(context, decodeURIComponent(draftReviseStreamMatch[1]!), body);
  }

  const goalDesignSlicePatchMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/goal-design\/slices\/([^/]+)$/);
  if (request.method === "PATCH" && goalDesignSlicePatchMatch) {
    const body = await readJsonBody<{ expectedPackageHash?: unknown; patch?: unknown }>(request);
    try {
      return json("goal-design-package", await reviseGoalSlicePg(context.db, {
        draftId: decodeURIComponent(goalDesignSlicePatchMatch[1]!),
        sliceId: decodeURIComponent(goalDesignSlicePatchMatch[2]!),
        expectedPackageHash: requiredString(body.expectedPackageHash, "expectedPackageHash"),
        patch: parseGoalSlicePatch(body.patch),
      }));
    } catch (error) {
      return goalDesignRevisionErrorResponse(error);
    }
  }

  const goalDesignTemplatePolicyPatchMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/goal-design\/template-policy$/);
  if (request.method === "PATCH" && goalDesignTemplatePolicyPatchMatch) {
    const body = await readJsonBody<{ expectedPackageHash?: unknown; templatePolicy?: unknown }>(request);
    const templatePolicy = optionalWorkflowTemplatePolicy(body.templatePolicy);
    if (!templatePolicy) return errorJson("templatePolicy is required", 422);
    try {
      return json("goal-design-package", await reviseGoalTemplatePolicyPg(context.db, {
        draftId: decodeURIComponent(goalDesignTemplatePolicyPatchMatch[1]!),
        expectedPackageHash: requiredString(body.expectedPackageHash, "expectedPackageHash"),
        templatePolicy,
      }));
    } catch (error) {
      return goalDesignRevisionErrorResponse(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/v2/planner/drafts") {
    const body = await readJsonBody<{
      goalPrompt?: unknown;
      orchestrationMode?: unknown;
      composerMode?: unknown;
      cwd?: unknown;
      compositionPlan?: unknown;
      libraryHints?: unknown;
      idempotencyKey?: unknown;
      goalDesignMode?: unknown;
      templatePolicy?: unknown;
    }>(request);
    return json(
      "planner-draft",
      plannerDraftReceiptFromGoalResult(await submitGoalPg({
        db: context.db,
        goalInterpreter: resolveGoalInterpreter(context),
        goalDesigner: resolveGoalDesigner(context),
        composer: resolvePlannerWorkflowComposer(context),
        libraryImportLlmProvider: context.libraryImportLlmProvider,
        libraryImportSourceFetcher: context.libraryImportSourceFetcher,
      }, runGoalRequestFromPlannerDraftBody(body)), requiredString(body.goalPrompt, "goalPrompt")),
    );
  }

  const draftReviseMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/revise$/);
  if (request.method === "POST" && draftReviseMatch) {
    const draftId = decodeURIComponent(draftReviseMatch[1]!);
    const body = await readJsonBody<{
      prompt?: unknown;
      orchestrationMode?: unknown;
      composerMode?: unknown;
      expectedPackageHash?: unknown;
      selectedSliceId?: unknown;
    }>(request);
    if (await isGoalDesignVocabularyGapDraftPg(context.db, draftId)) {
      return json("planner-draft", await retryPostgresGoalDesignAfterVocabularyApprovalPg(context.db, {
        draftId,
        goalInterpreter: resolveGoalInterpreter(context),
        goalDesigner: resolveGoalDesigner(context),
        libraryImportLlmProvider: context.libraryImportLlmProvider,
        libraryImportSourceFetcher: context.libraryImportSourceFetcher,
      }));
    }
    if (await isReviewableGoalDesignDraftPg(context.db, draftId)) {
      try {
        return json("goal-design-revision", await reviseGoalDesignFromChatPg({
          db: context.db,
          goalInterpreter: resolveGoalInterpreter(context),
          goalDesigner: resolveGoalDesigner(context),
        }, {
          draftId,
          expectedPackageHash: requiredString(body.expectedPackageHash, "expectedPackageHash"),
          message: requiredString(body.prompt, "prompt"),
          selectedSliceId: optionalString(body.selectedSliceId),
        }));
      } catch (error) {
        return goalDesignRevisionErrorResponse(error);
      }
    }
    return json(
      "planner-draft",
      await revisePostgresPlannerDraft(context.db, {
        draftId,
        prompt: requiredString(body.prompt, "prompt"),
        orchestrationMode: optionalOrchestrationMode(body.orchestrationMode),
        composerMode: optionalComposerMode(body.composerMode),
        goalInterpreter: resolveGoalInterpreter(context),
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

  return undefined;
}

function createRunGoalStreamResponse(
  context: RuntimeServerContext,
  request: RunGoalRequest,
  claim: GoalSubmissionClaim,
): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      };
      heartbeat = startPlannerSseHeartbeat(context, send, { phase: "run_goal", idempotencyKey: request.idempotencyKey });
      try {
        const result = await submitClaimedGoalPg({
          db: context.db,
          goalInterpreter: resolveGoalInterpreter(context),
          goalDesigner: resolveGoalDesigner(context),
          composer: resolvePlannerWorkflowComposer(context),
          libraryImportLlmProvider: context.libraryImportLlmProvider,
          libraryImportSourceFetcher: context.libraryImportSourceFetcher,
          onStage(stage, data) {
            if (stage === "goal_design.persisted") send("goal_design", data ?? {});
            if (stage !== "done") send("planner.stage", { stage, ...(data ?? {}) });
          },
        }, request, claim);
        send("done", result);
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        const wasClosed = closed;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (!wasClosed) {
          try {
            controller.close();
          } catch {
            // The browser or CLI client may have cancelled the stream already.
          }
        }
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
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

function createGoalDesignConfirmationStreamResponse(
  context: RuntimeServerContext,
  input: { draftId: string; expectedPackageHash: string },
): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      };
      heartbeat = startPlannerSseHeartbeat(context, send, {
        phase: "goal_design_confirmation",
        draftId: input.draftId,
      });
      try {
        send("goal_design", {
          draftId: input.draftId,
          expectedPackageHash: input.expectedPackageHash,
          status: "confirmed",
        });
        const result = await confirmGoalDesignPg({
          db: context.db,
          goalInterpreter: resolveGoalInterpreter(context),
          goalDesigner: resolveGoalDesigner(context),
          composer: resolvePlannerWorkflowComposer(context, {
            onStreamDegraded(message) {
              send("planner.stage", { stage: "planner.stream.degraded", message });
            },
          }),
          libraryImportLlmProvider: context.libraryImportLlmProvider,
          libraryImportSourceFetcher: context.libraryImportSourceFetcher,
          onStage(stage, data) {
            if (stage !== "done") send("planner.stage", { stage, ...(data ?? {}) });
          },
        }, input);
        sendGoalDesignConfirmationResultFrames(send, result);
        send("done", result);
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        const wasClosed = closed;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (!wasClosed) {
          try {
            controller.close();
          } catch {
            // The browser or CLI client may have cancelled the stream already.
          }
        }
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
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

async function preflightGoalDesignConfirmation(
  context: RuntimeServerContext,
  input: { draftId: string; expectedPackageHash: string },
): Promise<Response | undefined> {
  try {
    const pkg = await loadCurrentGoalDesignPackagePg(context.db, input.draftId);
    if (pkg.packageHash !== input.expectedPackageHash) {
      return errorJson("goal_design_package_stale", 409);
    }
    const existing = await context.db.maybeOne<{
      id: string;
      status: string;
      payload_json: Record<string, unknown>;
    }>(
      "select id, status, payload_json from southstar.runtime_resources where resource_type = 'goal_design_confirmation' and resource_key = $1",
      [input.draftId],
    );
    if (!existing || existing.status === "completed" || existing.status === "failed") return undefined;
    if (existing.status === "stale") return undefined;
    if (existing.payload_json.packageHash !== input.expectedPackageHash) {
      return errorJson("goal_design_confirmation_conflict", 409);
    }
    return json("goal-design-confirmation", { confirmationId: existing.id, status: "processing" }, 202);
  } catch (error) {
    return goalDesignConfirmationErrorResponse(error);
  }
}

function goalDesignConfirmationErrorResponse(error: unknown): Response {
  if (error instanceof GoalSubmissionPendingError) {
    return json("goal-design-confirmation", { confirmationId: error.submissionId, status: "processing" }, 202);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("goal_design_package_stale") || message.includes("goal_design_confirmation_conflict")) {
    return errorJson(message, 409);
  }
  throw error;
}

function sendGoalDesignConfirmationResultFrames(
  send: (event: string, data: unknown) => void,
  result: RunGoalResult,
): void {
  send("draft", {
    draftId: result.draftId,
    draftStatus: result.draftStatus,
    goalContractHash: result.goalContractHash,
    goalDesignPackageHash: result.goalDesignPackageHash,
    blockers: result.blockers,
  });
  if (result.runId) {
    send("run", { runId: result.runId, runStatus: result.runStatus });
    send("dag", { runId: result.runId, draftId: result.draftId, status: result.runStatus });
  }
  if (result.executionSetId) {
    send("execution_set", {
      executionSetId: result.executionSetId,
      sliceRuns: result.sliceRuns ?? [],
    });
  }
  if (result.approvalId) {
    send("approval", { approvalId: result.approvalId, runId: result.runId });
  }
}

function createPlannerDraftStreamResponse(
  context: RuntimeServerContext,
  body: {
    goalPrompt?: unknown;
    orchestrationMode?: unknown;
    composerMode?: unknown;
    cwd?: unknown;
    compositionPlan?: unknown;
    libraryHints?: unknown;
    idempotencyKey?: unknown;
    goalDesignMode?: unknown;
    templatePolicy?: unknown;
  },
): Response {
  const request = runGoalRequestFromPlannerDraftBody(body);
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      };
      heartbeat = startPlannerSseHeartbeat(context, send, {
        phase: "planner_draft_create",
        idempotencyKey: request.idempotencyKey,
      });
      try {
        send("planner.stage", { stage: "request.accepted", message: "Accepted workflow generation request." });
        const result = await submitGoalPg({
          db: context.db,
          goalInterpreter: resolveGoalInterpreter(context),
          goalDesigner: resolveGoalDesigner(context),
          composer: resolvePlannerWorkflowComposer(context, {
            onStreamDegraded(message) {
              send("planner.stage", { stage: "planner.stream.degraded", message });
            },
          }),
          libraryImportLlmProvider: context.libraryImportLlmProvider,
          libraryImportSourceFetcher: context.libraryImportSourceFetcher,
          onStage(stage, data) {
            if (stage === "goal_design.persisted") send("goal_design", data ?? {});
            if (stage !== "done") send("planner.stage", { stage, ...(data ?? {}) });
          },
        }, request);
        const draft = plannerDraftReceiptFromGoalResult(result, request.goalPrompt);
        send("draft", { draft });
        if (result.draftStatus === "validated") {
          send("planner.stage", { stage: "orchestration.loading", message: "Loading planner draft orchestration." });
          const orchestration = await getPostgresPlannerDraftOrchestration(context.db, { draftId: result.draftId });
          send("orchestration", { orchestration });
        }
        send("done", result);
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        const wasClosed = closed;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (!wasClosed) {
          try {
            controller.close();
          } catch {
            // The browser or CLI client may have cancelled the stream already.
          }
        }
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
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
    expectedPackageHash?: unknown;
    selectedSliceId?: unknown;
  },
): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      };
      heartbeat = startPlannerSseHeartbeat(context, send, {
        phase: "planner_draft_revision",
        draftId,
      });
      try {
        if (await isGoalDesignVocabularyGapDraftPg(context.db, draftId)) {
          send("planner.stage", { stage: "goal_design.vocabulary.retry", message: "Retrying Goal Design with approved Library vocabulary." });
          const draft = await retryPostgresGoalDesignAfterVocabularyApprovalPg(context.db, {
            draftId,
            goalInterpreter: resolveGoalInterpreter(context),
            goalDesigner: resolveGoalDesigner(context),
            libraryImportLlmProvider: context.libraryImportLlmProvider,
            libraryImportSourceFetcher: context.libraryImportSourceFetcher,
            onProgress(event) {
              send("planner.stage", event);
            },
          });
          if (draft.goalDesignPackage) {
            send("goal_design", {
              draftId: draft.draftId,
              status: draft.status,
              goalDesignPackageHash: draft.goalDesignPackageHash,
              package: draft.goalDesignPackage,
            });
          }
          send("draft", { draft });
          send("done", { draftId: draft.draftId, draftStatus: draft.status, goalDesignPackageHash: draft.goalDesignPackageHash });
          return;
        }
        if (await isReviewableGoalDesignDraftPg(context.db, draftId)) {
          send("planner.stage", { stage: "goal_design.revision.requested", message: "Accepted Goal Design revision request." });
          const result = await reviseGoalDesignFromChatPg({
            db: context.db,
            goalInterpreter: resolveGoalInterpreter(context),
            goalDesigner: resolveGoalDesigner(context),
          }, {
            draftId,
            expectedPackageHash: requiredString(body.expectedPackageHash, "expectedPackageHash"),
            message: requiredString(body.prompt, "prompt"),
            selectedSliceId: optionalString(body.selectedSliceId),
          });
          if (result.kind === "needs_input") {
            send("message.delta", { text: result.question });
            send("done", result);
            return;
          }
          send("message.delta", { text: result.summary });
          send("goal_design", {
            draftId,
            status: result.draftStatus,
            goalDesignPackageHash: result.package.packageHash,
            package: result.package,
            changedSliceIds: result.changedSliceIds,
          });
          send("draft", {
            draftId,
            status: result.draftStatus,
            goalDesignPackageHash: result.package.packageHash,
          });
          send("done", {
            draftId,
            draftStatus: result.draftStatus,
            goalDesignPackageHash: result.package.packageHash,
          });
          return;
        }
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
          goalInterpreter: resolveGoalInterpreter(context),
          composer,
          onProgress(event) {
            send("planner.stage", event);
          },
          onGoalContractDelta(text) {
            send("goal_contract.delta", { text });
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
        const wasClosed = closed;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (!wasClosed) {
          try {
            controller.close();
          } catch {
            // The browser or CLI client may have cancelled the stream already.
          }
        }
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
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

function startPlannerSseHeartbeat(
  context: RuntimeServerContext,
  send: (event: string, data: unknown) => void,
  data: Record<string, unknown>,
): ReturnType<typeof setInterval> {
  const intervalMs = Math.max(1, context.libraryChatHeartbeatMs ?? 15_000);
  return setInterval(() => {
    send("planner.progress.keepalive", {
      ...data,
      at: new Date().toISOString(),
    });
  }, intervalMs);
}

async function readJsonBody<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function runGoalRequestFromPlannerDraftBody(body: {
  goalPrompt?: unknown;
  cwd?: unknown;
  idempotencyKey?: unknown;
  goalDesignMode?: unknown;
  templatePolicy?: unknown;
}): RunGoalRequest {
  const goalPrompt = requiredString(body.goalPrompt, "goalPrompt");
  const cwd = optionalString(body.cwd) ?? process.cwd();
  return {
    goalPrompt,
    cwd,
    idempotencyKey: optionalString(body.idempotencyKey) ?? legacyPlannerDraftIdempotencyKey(goalPrompt, cwd),
    goalDesignMode: optionalGoalDesignMode(body.goalDesignMode),
    templatePolicy: optionalWorkflowTemplatePolicy(body.templatePolicy),
  };
}

function plannerDraftReceiptFromGoalResult(result: RunGoalResult, goalPrompt = "") {
  return {
    draftId: result.draftId,
    goalPrompt,
    workflowId: "",
    status: result.draftStatus,
    goalContractHash: result.goalContractHash,
    ...(result.goalDesignPackageHash ? { goalDesignPackageHash: result.goalDesignPackageHash } : {}),
    ...(result.vocabularyGaps ? { vocabularyGaps: result.vocabularyGaps } : {}),
    ...(result.libraryImportDraftId ? { libraryImportDraftId: result.libraryImportDraftId } : {}),
    blockers: result.blockers,
    validationIssues: [],
    taskSummaries: [],
  };
}

function legacyPlannerDraftIdempotencyKey(goalPrompt: string, cwd: string): string {
  return `planner-draft-${createHash("sha256").update(`${cwd}\n${goalPrompt}`).digest("hex").slice(0, 24)}`;
}

function optionalOrchestrationMode(value: unknown): "llm-constrained" | undefined {
  if (value === undefined) return undefined;
  if (value === "llm-constrained") return value;
  throw new Error("orchestrationMode must be llm-constrained");
}

function optionalComposerMode(value: unknown): WorkflowComposerMode | undefined {
  if (value === undefined) return undefined;
  if (value === "llm") return value;
  throw new Error("composerMode must be llm");
}

function optionalGoalDesignMode(value: unknown): GoalDesignMode | undefined {
  if (value === undefined) return undefined;
  if (value === "review_before_compose" || value === "auto_until_blocked") return value;
  throw new Error("goalDesignMode must be review_before_compose or auto_until_blocked");
}

function optionalWorkflowTemplatePolicy(value: unknown): WorkflowTemplatePolicyV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("templatePolicy must be an object");
  if (value.mode === "auto") return { mode: "auto" };
  if (value.mode === "prefer" || value.mode === "require") {
    return {
      mode: value.mode,
      templateRef: requiredString(value.templateRef, "templatePolicy.templateRef"),
      versionRef: requiredString(value.versionRef, "templatePolicy.versionRef"),
    };
  }
  throw new Error("templatePolicy.mode must be auto, prefer, or require");
}

function parseGoalSlicePatch(value: unknown): GoalSlicePatchV1 {
  if (!isRecord(value)) throw new Error("patch must be an object");
  const patch: GoalSlicePatchV1 = {};
  if (value.outcome !== undefined) patch.outcome = requiredString(value.outcome, "patch.outcome");
  if (value.requirementIds !== undefined) patch.requirementIds = parseRequiredStringArray(value.requirementIds, "patch.requirementIds");
  if (value.stateOrArtifactOwner !== undefined) patch.stateOrArtifactOwner = requiredString(value.stateOrArtifactOwner, "patch.stateOrArtifactOwner");
  if (value.mutationBoundary !== undefined) patch.mutationBoundary = requiredString(value.mutationBoundary, "patch.mutationBoundary");
  if (value.expectedArtifactRefs !== undefined) patch.expectedArtifactRefs = parseRequiredStringArray(value.expectedArtifactRefs, "patch.expectedArtifactRefs");
  if (value.evaluatorContractRefs !== undefined) patch.evaluatorContractRefs = parseRequiredStringArray(value.evaluatorContractRefs, "patch.evaluatorContractRefs");
  if (value.dependsOnSliceIds !== undefined) patch.dependsOnSliceIds = parseRequiredStringArray(value.dependsOnSliceIds, "patch.dependsOnSliceIds");
  if (value.dependencyArtifactRefs !== undefined) patch.dependencyArtifactRefs = parseRequiredStringArray(value.dependencyArtifactRefs, "patch.dependencyArtifactRefs");
  if (value.mergeReason !== undefined) patch.mergeReason = requiredString(value.mergeReason, "patch.mergeReason");
  return patch;
}

function parseRequiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function goalDesignRevisionErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("goal_design_package_stale")
    || message.includes("goal_design_already_materialized")
    || message.includes("not ready for review")
  ) {
    return errorJson(message, 409);
  }
  if (
    message.includes("invalid Goal Design package")
    || message.includes("goal_design_slice_not_found")
    || message.includes("patch must")
    || message.includes("patch.")
  ) {
    return errorJson(message, 422);
  }
  throw error;
}

function resolvePlannerWorkflowComposer(
  context: RuntimeServerContext,
  options: { onStreamDegraded?: (message: string) => void } = {},
): WorkflowComposer {
  if (context.workflowComposer) return context.workflowComposer;
  return new LlmWorkflowComposer({
    model: process.env.SOUTHSTAR_WORKFLOW_COMPOSER_MODEL ?? "southstar-runtime-workflow-composer",
    composerSop: () => loadWorkflowComposerSopPg(context.db),
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

export function resolveGoalInterpreter(context: RuntimeServerContext): GoalContractInterpreter {
  if (context.goalInterpreter) return context.goalInterpreter;
  return {
    interpret: (input) => interpretGoalContractWithLlm({
      ...input,
      model: process.env.SOUTHSTAR_GOAL_INTERPRETER_MODEL ?? "southstar-runtime-goal-interpreter",
      client: {
        generateText: ({ prompt }) => context.plannerClient.generate(prompt),
        generateTextStream: context.plannerClient.generateStream
          ? ({ prompt }, handlers) => context.plannerClient.generateStream!(prompt, { onDelta: handlers.onDelta })
          : undefined,
      },
    }),
  };
}

export function resolveGoalDesigner(context: RuntimeServerContext) {
  if (context.goalDesigner) return context.goalDesigner;
  return createLlmGoalDesigner(context.db, {
    model: process.env.SOUTHSTAR_GOAL_DESIGN_MODEL ?? "southstar-runtime-goal-designer",
    client: {
      generateText: ({ prompt }) => context.plannerClient.generate(prompt),
      generateTextStream: context.plannerClient.generateStream
        ? ({ prompt }, handlers) => context.plannerClient.generateStream!(prompt, { onDelta: handlers.onDelta })
        : undefined,
    },
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json<T>(kind: string, result: T, status = 200): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { status, headers: { "content-type": "application/json", ...corsHeaders() } });
}

function errorJson(error: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders(): Record<string, string> {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", "access-control-allow-headers": "content-type,authorization,last-event-id" };
}
