import type { WorkflowComposer } from "../orchestration/composer.ts";
import { LlmWorkflowComposer, loadWorkflowComposerSopPg } from "../orchestration/llm-composer.ts";
import { createLlmGoalDesigner, createLlmGoalSliceDesigner } from "../orchestration/goal-design.ts";
import {
  createLlmGoalRequirementDraftInterpreter,
  type GoalRequirementDraftInterpreter,
} from "../orchestration/goal-requirement-draft.ts";
import {
  interpretGoalContractWithLlm,
  type GoalContractInterpreter,
} from "../orchestration/goal-contract.ts";
import {
  GoalSubmissionPendingError,
  claimGoalSubmissionPg,
  confirmGoalDesignPg,
  isGoalDesignConfirmationActive,
  submitClaimedGoalPg,
  submitGoalPg,
  type GoalSubmissionClaim,
  type RunGoalResult,
  type RunGoalRequest,
} from "../orchestration/run-goal-service.ts";
import {
  LibraryNotReadyError,
  requireLibraryReadinessPg,
} from "../design-library/files/library-reconcile-service.ts";
import {
  isReviewableGoalDesignDraftPg,
  isGoalDesignVocabularyGapDraftPg,
  retryPostgresGoalDesignAfterVocabularyApprovalPg,
  loadCurrentGoalDesignPackagePg,
  reviseGoalDesignFromChatPg,
  reviseGoalSlicePg,
  reviseGoalTemplatePolicyPg,
  confirmGoalRequirementsPg,
  designAndPersistGoalSlicesPg,
  reviseGoalRequirementPg,
  reviseGoalRequirementFromChatPg,
  loadCurrentUiInteractionContractPg,
  reviseUiInteractionContractPg,
} from "../orchestration/goal-design-draft-service.ts";
import {
  assertRawRequirementRouteTarget,
  assertRequirementRouteTarget,
  optionalComposerMode,
  optionalGoalDesignMode,
  optionalOrchestrationMode,
  optionalWorkflowTemplatePolicy,
  parseGoalRequirementPatch,
  parseGoalSlicePatch,
  parseUiInteractionContractInput,
  parseUiInteractionContractPatch,
} from "./planner-route-inputs.ts";
import { resolveAndPersistGoalValidationPg } from "../orchestration/goal-validation-lifecycle.ts";
import {
  createPostgresRunFromDraft,
  getPostgresPlannerDraftOrchestration,
  patchPostgresPlannerDraftTaskProfileOverride,
  revisePostgresPlannerDraft,
  validatePostgresPlannerDraft,
} from "../ui-api/postgres-run-api.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";
import {
  buildRunGoalRequestFromPlannerDraftBody,
  plannerDraftReceiptFromGoalResult,
} from "../orchestration/planner-intake.ts";

export async function handlePlannerRoute(
  context: RuntimeServerContext,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (request.method === "POST" && url.pathname === "/api/v2/run-goal") {
    try {
      await requireLibraryReadinessPg(context.db);
    } catch (error: unknown) {
      if (!(error instanceof LibraryNotReadyError)) throw error;
      return new Response(JSON.stringify({
        ok: false,
        error: error.code,
        message: error.message,
        diagnostics: error.diagnostics,
      }), {
        status: error.status,
        headers: { "content-type": "application/json", ...corsHeaders() },
      });
    }
    const body = await readJsonBody<Record<string, unknown>>(request);
    const runGoalRequest: RunGoalRequest = {
      goalPrompt: requiredString(body.goalPrompt, "goalPrompt"),
      cwd: requiredString(body.cwd, "cwd"),
      ...(optionalString(body.projectRef) !== undefined ? { projectRef: optionalString(body.projectRef) } : {}),
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
      goalRequirementInterpreter: resolveGoalRequirementInterpreter(context),
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
      projectRef?: unknown;
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

  const goalRequirementPatchMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/goal-requirements\/([^/]+)$/);
  if (request.method === "PATCH" && goalRequirementPatchMatch) {
    const body = await readJsonBody<{ expectedDraftHash?: unknown; patch?: unknown; actor?: unknown }>(request);
    try {
      const requirementId = decodeURIComponent(goalRequirementPatchMatch[2]!);
      assertRawRequirementRouteTarget(requirementId, body.patch);
      const patch = parseGoalRequirementPatch(body.patch);
      assertRequirementRouteTarget(requirementId, patch);
      return json("goal-requirement-draft", await reviseGoalRequirementPg(context.db, {
        draftId: decodeURIComponent(goalRequirementPatchMatch[1]!),
        requirementId,
        expectedDraftHash: requiredString(body.expectedDraftHash, "expectedDraftHash"),
        patch,
        actor: optionalString(body.actor),
      }));
    } catch (error) {
      return goalRequirementRevisionErrorResponse(error);
    }
  }

  const uiContractMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/ui-contracts\/([^/]+)$/);
  if (request.method === "GET" && uiContractMatch) {
    try {
      return json("ui-interaction-contract", await loadCurrentUiInteractionContractPg(context.db, {
        draftId: decodeURIComponent(uiContractMatch[1]!),
        contractId: decodeURIComponent(uiContractMatch[2]!),
      }));
    } catch (error) {
      return goalRequirementRevisionErrorResponse(error);
    }
  }
  if (request.method === "PATCH" && uiContractMatch) {
    const body = await readJsonBody<{
      expectedContractHash?: unknown;
      contract?: unknown;
      patch?: unknown;
      actor?: unknown;
    }>(request);
    try {
      const contract = body.contract === undefined ? undefined : parseUiInteractionContractInput(body.contract);
      const patch = body.patch === undefined ? undefined : parseUiInteractionContractPatch(body.patch);
      if ((contract ? 1 : 0) + (patch ? 1 : 0) !== 1) throw new Error("exactly one of contract or patch is required");
      return json("goal-requirement-draft", await reviseUiInteractionContractPg(context.db, {
        draftId: decodeURIComponent(uiContractMatch[1]!),
        contractId: decodeURIComponent(uiContractMatch[2]!),
        ...(body.expectedContractHash !== undefined ? { expectedContractHash: requiredString(body.expectedContractHash, "expectedContractHash") } : {}),
        ...(contract ? { contract } : {}),
        ...(patch ? { patch } : {}),
        actor: optionalString(body.actor),
      }));
    } catch (error) {
      return goalRequirementRevisionErrorResponse(error);
    }
  }

  const goalRequirementConfirmMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/confirm-requirements$/);
  if (request.method === "POST" && goalRequirementConfirmMatch) {
    if (!context.libraryImportLlmProvider) return goalValidationProviderConfigurationResponse();
    const body = await readJsonBody<{ expectedDraftHash?: unknown; actor?: unknown }>(request);
    try {
      const confirmed = await confirmGoalRequirementsPg(context.db, {
        draftId: decodeURIComponent(goalRequirementConfirmMatch[1]!),
        expectedDraftHash: requiredString(body.expectedDraftHash, "expectedDraftHash"),
        actor: optionalString(body.actor),
        goalInterpreter: resolveGoalInterpreter(context),
      });
      if (!confirmed.goalContractHash) {
        return json("goal-requirement-confirmation", confirmed);
      }
      const validation = await resolveAndPersistGoalValidationPg(context.db, {
        draftId: confirmed.draftId,
        expectedGoalContractHash: confirmed.goalContractHash,
        libraryImportLlmProvider: context.libraryImportLlmProvider,
        libraryImportSourceFetcher: context.libraryImportSourceFetcher,
        actor: optionalString(body.actor),
      });
      if (validation.status !== "validation_ready") {
        return json("goal-requirement-confirmation", validation);
      }
      return json("goal-requirement-confirmation", await designAndPersistGoalSlicesPg(context.db, {
        draftId: validation.draftId,
        expectedResolutionHash: validation.goalValidationResolution.resolutionHash,
        sliceDesigner: resolveGoalSliceDesigner(context),
      }));
    } catch (error) {
      return goalRequirementRevisionErrorResponse(error);
    }
  }

  const goalRequirementConfirmStreamMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/confirm-requirements\/stream$/);
  if (request.method === "POST" && goalRequirementConfirmStreamMatch) {
    if (!context.libraryImportLlmProvider) return goalValidationProviderConfigurationResponse();
    const body = await readJsonBody<{ expectedDraftHash?: unknown; actor?: unknown }>(request);
    return createGoalRequirementConfirmationStreamResponse(context, {
      draftId: decodeURIComponent(goalRequirementConfirmStreamMatch[1]!),
      expectedDraftHash: requiredString(body.expectedDraftHash, "expectedDraftHash"),
      actor: optionalString(body.actor),
    });
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
      projectRef?: unknown;
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
        goalRequirementInterpreter: resolveGoalRequirementInterpreter(context),
        goalDesigner: resolveGoalDesigner(context),
        composer: resolvePlannerWorkflowComposer(context),
        libraryImportLlmProvider: context.libraryImportLlmProvider,
        libraryImportSourceFetcher: context.libraryImportSourceFetcher,
      }, buildRunGoalRequestFromPlannerDraftBody(body)), requiredString(body.goalPrompt, "goalPrompt")),
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
          goalRequirementInterpreter: resolveGoalRequirementInterpreter(context),
          goalDesigner: resolveGoalDesigner(context),
          composer: resolvePlannerWorkflowComposer(context),
          libraryImportLlmProvider: context.libraryImportLlmProvider,
          libraryImportSourceFetcher: context.libraryImportSourceFetcher,
          onStage(stage, data) {
            if (stage === "goal_design.persisted") send("goal_design", data ?? {});
            if (stage === "requirements.persisted") send("goal_requirements", data ?? {});
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

function createGoalRequirementConfirmationStreamResponse(
  context: RuntimeServerContext,
  input: { draftId: string; expectedDraftHash: string; actor?: string },
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
      const startedAt = Date.now();
      heartbeat = setInterval(() => {
        send("heartbeat", {
          phase: "goal_validation",
          draftId: input.draftId,
          elapsedMs: Date.now() - startedAt,
          at: new Date().toISOString(),
        });
      }, Math.max(1, context.libraryChatHeartbeatMs ?? 15_000));
      try {
        send("goal.validation.started", { draftId: input.draftId, expectedDraftHash: input.expectedDraftHash });
        const confirmed = await confirmGoalRequirementsPg(context.db, {
          draftId: input.draftId,
          expectedDraftHash: input.expectedDraftHash,
          actor: input.actor,
          goalInterpreter: resolveGoalInterpreter(context),
        });
        send("goal.validation.requirements_confirmed", {
          draftId: confirmed.draftId,
          goalContractHash: confirmed.goalContractHash,
          goalRequirementDraftHash: confirmed.goalRequirementDraftHash,
        });
        if (!confirmed.goalContractHash) {
          send("goal_requirements", confirmed);
          send("done", confirmed);
          return;
        }
        const validation = await resolveAndPersistGoalValidationPg(context.db, {
          draftId: confirmed.draftId,
          expectedGoalContractHash: confirmed.goalContractHash,
          libraryImportLlmProvider: context.libraryImportLlmProvider,
          libraryImportSourceFetcher: context.libraryImportSourceFetcher,
          actor: input.actor,
          progress(progress) {
            send(progress.event, progress.data);
          },
        });
        if (validation.status !== "validation_ready") {
          send("goal.validation.library_review", {
            draftId: validation.draftId,
            libraryImportDraftId: validation.libraryImportDraftId,
            gapCount: validation.validationGaps.length,
          });
          send("goal_requirements", validation);
          send("done", validation);
          return;
        }
        send("goal.validation.slice_design.started", {
          draftId: validation.draftId,
          resolutionHash: validation.goalValidationResolution.resolutionHash,
        });
        const designed = await designAndPersistGoalSlicesPg(context.db, {
          draftId: validation.draftId,
          expectedResolutionHash: validation.goalValidationResolution.resolutionHash,
          sliceDesigner: resolveGoalSliceDesigner(context),
        });
        send("goal_design", designed);
        send("done", designed);
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
            // Client cancelled the stream.
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
    if (existing.status === "composing" && !isGoalDesignConfirmationActive(existing.id)) return undefined;
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
    ...(result.goalContractHash ? { goalContractHash: result.goalContractHash } : {}),
    goalDesignPackageHash: result.goalDesignPackageHash,
    goalDesignPhase: result.goalDesignPhase,
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
    projectRef?: unknown;
    compositionPlan?: unknown;
    libraryHints?: unknown;
    idempotencyKey?: unknown;
    goalDesignMode?: unknown;
    templatePolicy?: unknown;
  },
): Response {
  const request = buildRunGoalRequestFromPlannerDraftBody(body);
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
          goalRequirementInterpreter: resolveGoalRequirementInterpreter(context),
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
            if (stage === "requirements.persisted") send("goal_requirements", data ?? {});
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
    expectedDraftHash?: unknown;
    selectedSliceId?: unknown;
    selectedRequirementId?: unknown;
    selectedRequirementIds?: unknown;
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
        const currentRequirementView = await getPostgresPlannerDraftOrchestration(context.db, { draftId });
        if (currentRequirementView.goalDesignPhase === "requirements_review") {
          const requirementInterpreter = resolveGoalRequirementInterpreter(context);
          if (!requirementInterpreter) throw new Error("goal requirement interpreter is not configured");
          send("planner.stage", { stage: "requirements.revision.requested", message: "Accepted Requirement revision request." });
          const result = await reviseGoalRequirementFromChatPg(context.db, {
            draftId,
            expectedDraftHash: requiredString(body.expectedDraftHash, "expectedDraftHash"),
            message: requiredString(body.prompt, "prompt"),
            selectedRequirementId: optionalString(body.selectedRequirementId),
            selectedRequirementIds: optionalStringArray(body.selectedRequirementIds),
            requirementInterpreter,
            onDelta(text) { send("message.delta", { text }); },
          });
          if (result.kind === "needs_input") {
            send("message.delta", { text: result.question });
            send("done", result);
            return;
          }
          send("goal_requirements", {
            draftId: result.draftId,
            status: result.status,
            phase: result.phase,
            goalRequirementDraftHash: result.goalRequirementDraftHash,
            confirmable: result.confirmable,
            validationIssues: result.validationIssues,
            package: result,
          });
          send("draft", {
            draftId: result.draftId,
            status: result.status,
            goalDesignPhase: result.phase,
            goalRequirementDraftHash: result.goalRequirementDraftHash,
            goalRequirementDraft: result.goalRequirementDraft,
          });
          send("done", result);
          return;
        }
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

function goalDesignRevisionErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("goal_design_package_stale")
    || message.includes("goal_design_already_materialized")
    || message.includes("goal_design_frozen")
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

function goalRequirementRevisionErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("goal_requirement_draft_stale")
    || message.includes("goal_requirement_revision_conflict")
    || message.includes("goal_requirement_route_target_conflict")
    || message.includes("goal_requirements_already_materialized")
    || message.includes("goal_requirements_frozen")
    || message.includes("ui_interaction_contract_stale")
    || message.includes("ui_interaction_contract_frozen")
    || message.includes("cannot be confirmed in phase")
  ) {
    return errorJson(message, 409);
  }
  if (
    message.includes("invalid Goal Requirement draft")
    || message.includes("goal_requirement_draft_invalid")
    || message.includes("patch")
    || message.includes("requirementId is required")
    || message.includes("Goal Requirement interpreter returned")
    || message.includes("goal_requirement_contract_metadata_missing")
    || message.includes("goal_requirement_contract_metadata_invalid")
    || message.includes("invalid UI interaction contract")
    || message.includes("UI interaction contract operation")
    || message.includes("exactly one of contract or patch")
    || message.includes("creating a UI interaction contract")
    || message.includes("revising a UI interaction contract")
    || message.includes("goal_requirement_not_confirmable")
  ) {
    return errorJson(message, 422);
  }
  if (message.includes("Goal Requirement draft not found") || message.includes("planner draft not found") || message.includes("UI interaction contract not found")) {
    return errorJson(message, 404);
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

/**
 * Resolve the staged Requirement interpreter. Test/runtime callers that inject
 * the legacy Goal Designer remain on that explicit legacy path; production
 * server contexts (which do not inject a designer) use the LLM interpreter.
 */
export function resolveGoalRequirementInterpreter(context: RuntimeServerContext): GoalRequirementDraftInterpreter | undefined {
  if (context.goalRequirementInterpreter) return context.goalRequirementInterpreter;
  if (context.goalDesigner) return undefined;
  return createLlmGoalRequirementDraftInterpreter({
    model: process.env.SOUTHSTAR_GOAL_REQUIREMENT_MODEL ?? "southstar-runtime-goal-requirement-interpreter",
    client: {
      generateText: ({ prompt }) => context.plannerClient.generate(prompt),
      generateTextStream: context.plannerClient.generateStream
        ? ({ prompt }, handlers) => context.plannerClient.generateStream!(prompt, { onDelta: handlers.onDelta })
        : undefined,
    },
  });
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

export function resolveGoalSliceDesigner(context: RuntimeServerContext) {
  if (context.goalSliceDesigner) return context.goalSliceDesigner;
  return createLlmGoalSliceDesigner({
    model: process.env.SOUTHSTAR_GOAL_SLICE_MODEL ?? "southstar-runtime-goal-slice-designer",
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

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("selectedRequirementIds must be an array of non-empty strings");
  }
  return value as string[];
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

function goalValidationProviderConfigurationResponse(): Response {
  return new Response(JSON.stringify({
    ok: false,
    code: "goal_validation_provider_not_configured",
    status: "configuration_required",
    error: "Goal validation requires a configured Library LLM provider before Requirements can be confirmed.",
    readiness: {
      ready: false,
      missing: ["libraryImportLlmProvider"],
      action: "Configure the runtime Library LLM provider, then confirm the Requirement draft again.",
    },
  }), {
    status: 503,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders(): Record<string, string> {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", "access-control-allow-headers": "content-type,authorization,last-event-id" };
}
