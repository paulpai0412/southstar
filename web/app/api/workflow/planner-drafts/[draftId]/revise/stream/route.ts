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
        const response = await fetch(buildWorkflowV2Url(`/api/v2/planner/drafts/${draftId}/revise/stream`), {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            "content-type": request.headers.get("content-type") ?? "application/json",
          },
          body,
        });
        if (!response.ok) {
          throw new Error(`planner draft revise stream request failed: HTTP ${response.status}`);
        }
        if (!response.body) {
          throw new Error("planner draft revise stream response is missing body");
        }
        await proxyPlannerDraftStream(response.body, send);
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

type SendWorkflowGenerateEvent = (event: string, data: unknown) => void;

async function proxyPlannerDraftStream(
  body: ReadableStream<Uint8Array>,
  send: SendWorkflowGenerateEvent,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneSent = false;
  const dispatch = (frame: string) => {
    const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice("event:".length).trim() || "message";
    const rawData = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    const data = rawData ? JSON.parse(rawData) as Record<string, unknown> : {};
    if (event === "orchestration") {
      const orchestrationPayload = unwrapV2Envelope<V2PlannerDraftOrchestrationView>(data.orchestration ?? data);
      const dag = buildWorkflowDagFromPlannerDraft(orchestrationPayload);
      send("dag", { dag });
      return;
    }
    if (event === "done") {
      doneSent = true;
      send("done", data);
      return;
    }
    if (["message", "message.delta", "planner.stage", "heartbeat", "draft", "goal_design", "goal_requirements", "error"].includes(event)) {
      send(event, data);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        buffer = dispatchCompletePlannerFrames(buffer, dispatch);
      }
      if (done) break;
    }
    buffer += decoder.decode();
    const rest = buffer.trim();
    if (rest) dispatch(rest);
    if (!doneSent) send("done", {});
  } finally {
    reader.releaseLock();
  }
}

function dispatchCompletePlannerFrames(buffer: string, dispatch: (frame: string) => void): string {
  let remaining = buffer.replace(/\r\n/g, "\n");
  while (true) {
    const frameEnd = remaining.indexOf("\n\n");
    if (frameEnd === -1) return remaining;
    const frame = remaining.slice(0, frameEnd);
    dispatch(frame);
    remaining = remaining.slice(frameEnd + 2);
  }
}
