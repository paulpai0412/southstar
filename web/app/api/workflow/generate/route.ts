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
  runId?: string;
  runStatus?: string;
};

type WorkflowUiReadModel = {
  mission: GoalMissionReadModel | null;
  commands: WorkflowCommandDescriptor[];
};

type SendWorkflowGenerateEvent = (event: string, data: unknown) => void;

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    cwd?: string | null;
    prompt?: string;
    idempotencyKey?: string;
  };
  const prompt = body.prompt?.trim();
  const cwd = body.cwd?.trim();
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
    }),
  });
  if (!upstream.ok || !upstream.headers.get("content-type")?.includes("text/event-stream")) {
    return new Response(upstream.body, {
      status: upstream.status,
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
  const dispatch = async (frame: string) => {
    const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice("event:".length).trim() || "message";
    const rawData = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    const data = rawData ? JSON.parse(rawData) as Record<string, unknown> : {};
    if (event === "done") {
      await sendGoalReceipt(data as RunGoalResult, send);
      return;
    }
    if (["message", "message.delta", "planner.stage", "heartbeat", "draft", "dag", "error"].includes(event)) {
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

async function sendGoalReceipt(result: RunGoalResult, send: SendWorkflowGenerateEvent): Promise<void> {
  const missionQuery = result.runId
    ? `runId=${encodeURIComponent(result.runId)}`
    : `draftId=${encodeURIComponent(result.draftId)}`;
  const [orchestration, workflowUi] = await Promise.all([
    fetchJson<V2PlannerDraftOrchestrationView>(`/api/v2/planner/drafts/${encodeURIComponent(result.draftId)}/orchestration`),
    fetchJson<WorkflowUiReadModel>(`/api/v2/ui/workflow?${missionQuery}`),
  ]);
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
  send("draft", { draft: { draftId: result.draftId, status: result.draftStatus } });
  if (mission) {
    send("goal_contract", { mission });
    send("coverage", { mission });
  }
  if (result.runId) send("run", { runId: result.runId, runStatus: result.runStatus });
  if (mission?.approval || approvalCommand) send("approval", { mission, command: approvalCommand });
  send("dag", { dag });
  send("done", result);
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(buildWorkflowV2Url(path), { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`workflow read model request failed: HTTP ${response.status}`);
  return unwrapV2Envelope<T>(await response.json());
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
