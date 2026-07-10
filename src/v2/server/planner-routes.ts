import type { WorkflowCompositionPlan } from "../design-library/types.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import type { WorkflowComposerMode } from "../orchestration/composer-registry.ts";
import { LlmWorkflowComposer } from "../orchestration/llm-composer.ts";
import {
  interpretGoalContractWithLlm,
  type GoalContractInterpreter,
} from "../orchestration/goal-contract.ts";
import {
  createPostgresPlannerDraft,
  createPostgresRunFromDraft,
  getPostgresPlannerDraftOrchestration,
  patchPostgresPlannerDraftTaskProfileOverride,
  revisePostgresPlannerDraft,
  validatePostgresPlannerDraft,
  type PlannerDraftLibraryHints,
} from "../ui-api/postgres-run-api.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handlePlannerRoute(
  context: RuntimeServerContext,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (request.method === "POST" && url.pathname === "/api/v2/run-goal") {
    const body = await readJsonBody<{ goalPrompt?: string; orchestrationMode?: unknown; composerMode?: unknown }>(request);
    if (!body.goalPrompt) throw new Error("goalPrompt is required");
    const draft = await createPostgresPlannerDraft(context.db, {
      goalPrompt: body.goalPrompt,
      orchestrationMode: optionalOrchestrationMode(body.orchestrationMode),
      composerMode: optionalComposerMode(body.composerMode),
      goalInterpreter: resolveGoalInterpreter(context),
      composer: resolvePlannerWorkflowComposer(context),
    });
    if (draft.status === "needs_input") return json("run-goal", { draft });
    const run = await createPostgresRunFromDraft(context.db, { draftId: draft.draftId });
    return json("run-goal", { draft, ...run });
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
      cwd?: unknown;
      compositionPlan?: unknown;
      libraryHints?: unknown;
    }>(request);
    const plannerRequest = parsePlannerDraftRequest(body);
    return json(
      "planner-draft",
      await createPostgresPlannerDraft(context.db, {
        ...plannerRequest,
        goalInterpreter: resolveGoalInterpreter(context),
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

function createPlannerDraftStreamResponse(
  context: RuntimeServerContext,
  body: {
    goalPrompt?: unknown;
    orchestrationMode?: unknown;
    composerMode?: unknown;
    cwd?: unknown;
    compositionPlan?: unknown;
    libraryHints?: unknown;
  },
): Response {
  const plannerRequest = parsePlannerDraftRequest(body);
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
      });
      try {
        send("planner.stage", { stage: "request.accepted", message: "Accepted workflow generation request." });
        const composer = resolvePlannerWorkflowComposer(context, {
          onStreamDegraded(message) {
            send("planner.stage", { stage: "planner.stream.degraded", message });
          },
        });
        const draft = await createPostgresPlannerDraft(context.db, {
          ...plannerRequest,
          goalInterpreter: resolveGoalInterpreter(context),
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

function parsePlannerDraftRequest(body: {
  goalPrompt?: unknown;
  orchestrationMode?: unknown;
  composerMode?: unknown;
  cwd?: unknown;
  compositionPlan?: unknown;
  libraryHints?: unknown;
}): {
  goalPrompt: string;
  orchestrationMode?: "llm-constrained";
  composerMode?: WorkflowComposerMode;
  cwd?: string;
  compositionPlan?: WorkflowCompositionPlan;
  libraryHints?: PlannerDraftLibraryHints;
} {
  return {
    goalPrompt: requiredString(body.goalPrompt, "goalPrompt"),
    orchestrationMode: optionalOrchestrationMode(body.orchestrationMode),
    composerMode: optionalComposerMode(body.composerMode),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json<T>(kind: string, result: T, status = 200): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { status, headers: { "content-type": "application/json", ...corsHeaders() } });
}

function corsHeaders(): Record<string, string> {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", "access-control-allow-headers": "content-type,authorization,last-event-id" };
}
