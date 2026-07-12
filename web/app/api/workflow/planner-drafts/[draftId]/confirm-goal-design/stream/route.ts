import { NextRequest } from "next/server";
import { buildWorkflowV2Url } from "../../../../../../../lib/workflow/v2-api";
import { buildWorkflowDagFromPlannerDraft, unwrapV2Envelope, type V2PlannerDraftOrchestrationView } from "../../../../../../../lib/workflow/v2-library-adapter";

function normalizedSegment(value: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return encodeURIComponent(value);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const { draftId: rawDraftId } = await params;
  const draftId = normalizedSegment(rawDraftId);
  const body = await request.text();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const response = await fetch(buildWorkflowV2Url(`/api/v2/planner/drafts/${draftId}/confirm-goal-design`), {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            "content-type": request.headers.get("content-type") ?? "application/json",
          },
          body,
        });
        if (!response.ok) throw new Error(`goal design confirmation request failed: HTTP ${response.status}`);
        if (!response.body) throw new Error("goal design confirmation stream response is missing body");
        await proxyConfirmationStream(response.body, send);
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

type SendEvent = (event: string, data: unknown) => void;

async function proxyConfirmationStream(body: ReadableStream<Uint8Array>, send: SendEvent): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneSent = false;

  const dispatch = async (frame: string) => {
    const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice("event:".length).trim() || "message";
    const rawData = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    const data = rawData ? JSON.parse(rawData) as Record<string, unknown> : {};

    if (event === "done") {
      const result = data as { draftId?: unknown; draftStatus?: unknown; runId?: unknown; runStatus?: unknown };
      if (typeof result.draftId === "string" && result.draftStatus === "validated") {
        try {
          const orchestration = await fetchV2<V2PlannerDraftOrchestrationView>(`/api/v2/planner/drafts/${encodeURIComponent(result.draftId)}/orchestration`);
          const runId = typeof result.runId === "string" ? result.runId : undefined;
          const workflowUi = await fetchV2<Record<string, unknown>>(`/api/v2/ui/workflow?${runId ? `runId=${encodeURIComponent(runId)}` : `draftId=${encodeURIComponent(result.draftId)}`}`);
          const hydratedOrchestration = withWorkflowUiTaskSummaries(orchestration, workflowUi);
          const commands = Array.isArray(workflowUi.commands) ? workflowUi.commands : [];
          const approvalCommand = commands.find((command) => (
            Boolean(command)
            && typeof command === "object"
            && (command as Record<string, unknown>).id === "approval.approve"
          ));
          const dag = buildWorkflowDagFromPlannerDraft(hydratedOrchestration, {
            ...(runId ? { runId } : {}),
            ...(result.runStatus === "awaiting_approval" || result.runStatus === "scheduling" ? { runStatus: result.runStatus } : {}),
            ...(workflowUi.mission && typeof workflowUi.mission === "object" ? { mission: workflowUi.mission as never } : {}),
            ...(approvalCommand && typeof approvalCommand === "object" ? { approvalCommand: approvalCommand as never } : {}),
          });
          send("dag", { dag });
        } catch (error) {
          send("planner.stage", {
            stage: "workflow.ui.hydration.failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      doneSent = true;
      send("done", data);
      return;
    }

    if (event === "dag" && (!data.dag || typeof data.dag !== "object")) return;
    if (["message", "message.delta", "planner.stage", "heartbeat", "goal_design", "draft", "dag", "execution_set", "approval", "error"].includes(event)) {
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
    if (!doneSent) send("done", {});
  } finally {
    reader.releaseLock();
  }
}

function withWorkflowUiTaskSummaries(
  orchestration: V2PlannerDraftOrchestrationView,
  workflowUi: Record<string, unknown>,
): V2PlannerDraftOrchestrationView {
  if (orchestration.taskSummaries.length > 0) return orchestration;
  const canvasModel = workflowUi.canvasModel;
  if (!canvasModel || typeof canvasModel !== "object" || Array.isArray(canvasModel)) return orchestration;
  const nodes = (canvasModel as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return orchestration;
  const taskSummaries = nodes.flatMap((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return [];
    const value = node as Record<string, unknown>;
    if (typeof value.id !== "string") return [];
    return [{
      taskId: value.id,
      taskName: typeof value.label === "string" ? value.label : value.id,
      dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.filter((item): item is string => typeof item === "string") : [],
      ...(typeof value.roleRef === "string" ? { roleRef: value.roleRef } : {}),
      ...(typeof value.agentProfileRef === "string" ? { agentProfileRef: value.agentProfileRef } : {}),
    }];
  });
  return taskSummaries.length > 0 ? { ...orchestration, taskSummaries } : orchestration;
}

async function dispatchCompleteFrames(buffer: string, dispatch: (frame: string) => Promise<void>): Promise<string> {
  let remaining = buffer.replace(/\r\n/g, "\n");
  while (true) {
    const frameEnd = remaining.indexOf("\n\n");
    if (frameEnd === -1) return remaining;
    await dispatch(remaining.slice(0, frameEnd));
    remaining = remaining.slice(frameEnd + 2);
  }
}

async function fetchV2<T>(path: string): Promise<T> {
  const response = await fetch(buildWorkflowV2Url(path), { headers: { accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `workflow read model request failed: HTTP ${response.status}`);
  return unwrapV2Envelope<T>(JSON.parse(text));
}
