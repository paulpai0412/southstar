import { NextRequest } from "next/server";
import { buildWorkflowV2Url, workflowV2Capabilities } from "../../../../../lib/workflow/v2-api";

export async function POST(request: NextRequest) {
  if (!workflowV2Capabilities().v2Backend) {
    return new Response("Southstar v2 workflow API is not configured", { status: 503 });
  }

  const body = await request.text();
  const response = await fetch(buildWorkflowV2Url("/api/v2/planner/drafts/stream"), {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": request.headers.get("content-type") ?? "application/json",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return new Response(text || `planner draft stream request failed: HTTP ${response.status}`, {
      status: response.status,
    });
  }
  if (!response.body) {
    return new Response("planner draft stream response is missing body", { status: 502 });
  }

  return new Response(response.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
