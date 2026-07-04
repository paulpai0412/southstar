import { NextRequest } from "next/server";
import { buildWorkflowV2Url, workflowV2Capabilities } from "../../../../lib/workflow/v2-api";
import { buildWorkflowDagFromPlannerDraft, unwrapV2Envelope, type V2PlannerDraftOrchestrationView } from "../../../../lib/workflow/v2-library-adapter";


export async function POST(request: NextRequest) {
  const body = await request.json() as {
    cwd?: string | null;
    prompt?: string;
    templateId?: string | null;
  };
  const prompt = body.prompt?.trim();
  if (!prompt) return new Response("prompt is required", { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      if (!workflowV2Capabilities().v2Backend) {
        send("error", { error: "Southstar v2 workflow API is not configured" });
        controller.close();
        return;
      }

      try {
        const plannerStreamResponse = await fetch(buildWorkflowV2Url("/api/v2/planner/drafts/stream"), {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            goalPrompt: prompt,
            ...(body.cwd ? { cwd: body.cwd } : {}),
            orchestrationMode: "llm-constrained",
            composerMode: "llm",
          }),
        });
        if (!plannerStreamResponse.ok) {
          throw new Error(`planner draft stream request failed: HTTP ${plannerStreamResponse.status}`);
        }
        if (!plannerStreamResponse.body) {
          throw new Error("planner draft stream response is missing body");
        }
        await proxyPlannerDraftStream(plannerStreamResponse.body, send);
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : String(error) });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
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
    if (["message", "message.delta", "planner.stage", "draft", "error"].includes(event)) {
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
