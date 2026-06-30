import { NextRequest } from "next/server";
import { buildWorkflowV2Url, workflowV2BlockedResponse } from "../../../../../../../lib/workflow/v2-api";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  try {
    const upstreamUrl = buildWorkflowV2Url(`/api/v2/runs/${encodeURIComponent(runId)}/events/stream`);
    const upstreamSearch = new URLSearchParams(request.nextUrl.searchParams);
    const taskId = request.nextUrl.searchParams.get("taskId");
    if (taskId) upstreamSearch.set("taskId", taskId);
    upstreamUrl.search = upstreamSearch.toString();
    const response = await fetch(upstreamUrl, {
      headers: {
        accept: "text/event-stream",
        ...(request.headers.get("last-event-id") ? { "last-event-id": request.headers.get("last-event-id")! } : {}),
      },
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": response.headers.get("content-type") || "text/event-stream",
        "cache-control": "no-cache, no-transform",
      },
    });
  } catch {
    return workflowV2BlockedResponse();
  }
}
