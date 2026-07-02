import { NextRequest } from "next/server";
import { buildWorkflowV2Url, workflowV2BlockedResponse, workflowV2Capabilities } from "../../../../../lib/workflow/v2-api";

export async function GET(request: NextRequest) {
  if (!workflowV2Capabilities().v2Backend) return workflowV2BlockedResponse();
  const upstream = buildWorkflowV2Url("/api/v2/library/chat/events");
  upstream.search = request.nextUrl.search;
  const response = await fetch(upstream, { headers: { accept: "text/event-stream" } });
  if (!response.ok) return new Response(await response.text(), { status: response.status, statusText: response.statusText });
  if (!response.body) return new Response("library chat stream missing body", { status: 502 });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}
