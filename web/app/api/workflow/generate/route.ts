import { NextRequest } from "next/server";
import { buildWorkflowV2Url, workflowV2Capabilities } from "../../../../lib/workflow/v2-api";
import {
  buildWorkflowDagFromPlannerDraft,
  unwrapV2Envelope,
  type V2PlannerDraftOrchestrationView,
} from "../../../../lib/workflow/v2-library-adapter";
import type {
  GoalMissionReadModel,
  WorkflowCommandDescriptor,
} from "../../../../lib/workflow/types";

type RunGoalResult = {
  draftId: string;
  draftStatus: string;
  goalRequirementDraftId?: string;
  goalRequirementDraftHash?: string;
  goalDesignPhase?: string;
  goalRequirementDraft?: Record<string, unknown>;
  goalDesignPackageHash?: string;
  vocabularyGaps?: Array<{ kind: string; requestedRef: string; allowedRefs: string[] }>;
  libraryImportDraftId?: string;
  blockers?: string[];
  confirmable?: boolean;
  validationIssues?: Array<{ path: string; message: string; code?: string }>;
  runId?: string;
  runStatus?: string;
  executionSetId?: string;
  sliceRuns?: Array<{ sliceId: string; runId: string; runStatus: string; approvalId: string }>;
};

type WorkflowUiReadModel = {
  mission: GoalMissionReadModel | null;
  commands: WorkflowCommandDescriptor[];
};

type SendWorkflowGenerateEvent = (event: string, data: unknown) => void;

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    cwd?: string | null;
    projectRef?: string | null;
    prompt?: string;
    idempotencyKey?: string;
    goalDesignMode?: unknown;
    templatePolicy?: unknown;
  };
  const prompt = body.prompt?.trim();
  const cwd = body.cwd?.trim();
  const projectRef = body.projectRef?.trim();
  const idempotencyKey = body.idempotencyKey?.trim();
  if (!prompt) return new Response("prompt is required", { status: 400 });
  if (!cwd) return new Response("cwd is required", { status: 400 });
  if (!idempotencyKey) return new Response("idempotencyKey is required", { status: 400 });
  if (!workflowV2Capabilities().v2Backend) {
    return new Response("Southstar v2 workflow API is not configured", { status: 503 });
  }

  const upstream = await fetch(buildWorkflowV2Url("/api/v2/run-goal"), {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      goalPrompt: prompt,
      cwd,
      idempotencyKey,
      ...(projectRef ? { projectRef } : {}),
      ...(isGoalDesignMode(body.goalDesignMode) ? { goalDesignMode: body.goalDesignMode } : {}),
      ...(isTemplatePolicy(body.templatePolicy) ? { templatePolicy: body.templatePolicy } : {}),
    }),
  });
  const isEventStream = upstream.headers.get("content-type")?.includes("text/event-stream") ?? false;
  if (!upstream.ok || !isEventStream) {
    const status = upstream.ok && upstream.status !== 202 && upstream.status !== 409
      ? 502
      : upstream.status;
    return new Response(upstream.body, {
      status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }
  const upstreamBody = upstream.body;
  if (!upstreamBody) return new Response("run-goal stream response is missing body", { status: 502 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: SendWorkflowGenerateEvent = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        await proxyRunGoalStream(upstreamBody, send);
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

async function proxyRunGoalStream(
  body: ReadableStream<Uint8Array>,
  send: SendWorkflowGenerateEvent,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawGoalRequirements = false;
  const dispatch = async (frame: string) => {
    const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice("event:".length).trim() || "message";
    const rawData = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    const data = rawData ? JSON.parse(rawData) as Record<string, unknown> : {};
    if (event === "done") {
      await sendGoalReceipt(data as RunGoalResult, send, { includeGoalRequirements: !sawGoalRequirements });
      return;
    }
    if (["message", "message.delta", "planner.stage", "heartbeat", "goal_design", "goal_requirements", "draft", "dag", "execution_set", "error"].includes(event)) {
      if (event === "goal_requirements") sawGoalRequirements = true;
      send(event, data);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        buffer = await dispatchCompleteFrames(buffer, dispatch);
      }
      if (done) break;
    }
    buffer += decoder.decode();
    if (buffer.trim()) await dispatch(buffer.trim());
  } finally {
    reader.releaseLock();
  }
}

async function sendGoalReceipt(
  result: RunGoalResult,
  send: SendWorkflowGenerateEvent,
  options: { includeGoalRequirements?: boolean } = {},
): Promise<void> {
  send("draft", { draft: {
    draftId: result.draftId,
    status: result.draftStatus,
    goalDesignPackageHash: result.goalDesignPackageHash,
    vocabularyGaps: result.vocabularyGaps,
    libraryImportDraftId: result.libraryImportDraftId,
    confirmable: result.confirmable,
    validationIssues: result.validationIssues,
  } });
  if (options.includeGoalRequirements && result.draftStatus === "requirements_review" && result.goalRequirementDraft && result.goalRequirementDraftHash) {
    const requirementReceipt = {
      draftId: result.goalRequirementDraftId ?? result.draftId,
      status: result.draftStatus,
      phase: result.goalDesignPhase ?? result.draftStatus,
      goalRequirementDraftId: result.goalRequirementDraftId ?? result.draftId,
      goalRequirementDraftHash: result.goalRequirementDraftHash,
      goalRequirementDraft: result.goalRequirementDraft,
      confirmable: result.confirmable === true,
      validationIssues: result.validationIssues ?? [],
      blockers: result.blockers,
    };
    send("goal_requirements", { ...requirementReceipt, package: requirementReceipt });
    send("done", result);
    return;
  }
  if (result.executionSetId) {
    send("execution_set", { executionSetId: result.executionSetId, sliceRuns: result.sliceRuns ?? [] });
    send("done", result);
    return;
  }
  if (result.runId) send("run", { runId: result.runId, runStatus: result.runStatus });
  if (!result.runId && (
    result.draftStatus === "requirements_review"
    || result.draftStatus === "ready_for_review"
    || result.draftStatus === "needs_input"
    || result.draftStatus === "needs_library_input"
  )) {
    send("done", result);
    return;
  }
  const missionQuery = result.runId
    ? `runId=${encodeURIComponent(result.runId)}`
    : `draftId=${encodeURIComponent(result.draftId)}`;
  let orchestration: V2PlannerDraftOrchestrationView;
  let workflowUi: WorkflowUiReadModel;
  try {
    [orchestration, workflowUi] = await Promise.all([
      fetchJson<V2PlannerDraftOrchestrationView>(`/api/v2/planner/drafts/${encodeURIComponent(result.draftId)}/orchestration`),
      fetchJson<WorkflowUiReadModel>(`/api/v2/ui/workflow?${missionQuery}`),
    ]);
  } catch (error) {
    send("recoverable", {
      result,
      error: error instanceof Error ? error.message : String(error),
    });
    send("done", result);
    return;
  }
  const mission = workflowUi.mission ?? undefined;
  const approvalCommand = workflowUi.commands.find((command) => command.id === "approval.approve");
  const runStatus = result.runStatus === "awaiting_approval" || result.runStatus === "scheduling"
    ? result.runStatus
    : undefined;
  const dag = buildWorkflowDagFromPlannerDraft(orchestration, {
    ...(result.runId ? { runId: result.runId } : {}),
    ...(runStatus ? { runStatus } : {}),
    ...(mission ? { mission } : {}),
    ...(approvalCommand ? { approvalCommand } : {}),
  });
  if (mission) {
    send("goal_contract", { mission });
    send("coverage", { mission });
  }
  if (mission?.approval || approvalCommand) send("approval", { mission, command: approvalCommand });
  send("dag", { dag });
  send("done", result);
}

function isGoalDesignMode(value: unknown): value is "review_before_compose" | "auto_until_blocked" {
  return value === "review_before_compose" || value === "auto_until_blocked";
}

function isTemplatePolicy(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  if (policy.mode === "auto") return true;
  return (policy.mode === "prefer" || policy.mode === "require")
    && typeof policy.templateRef === "string"
    && typeof policy.versionRef === "string";
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(buildWorkflowV2Url(path), { headers: { accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `workflow read model request failed: HTTP ${response.status}`);
  return unwrapV2Envelope<T>(JSON.parse(text));
}

async function dispatchCompleteFrames(
  buffer: string,
  dispatch: (frame: string) => Promise<void>,
): Promise<string> {
  let remaining = buffer.replace(/\r\n/g, "\n");
  while (true) {
    const frameEnd = remaining.indexOf("\n\n");
    if (frameEnd === -1) return remaining;
    await dispatch(remaining.slice(0, frameEnd));
    remaining = remaining.slice(frameEnd + 2);
  }
}
