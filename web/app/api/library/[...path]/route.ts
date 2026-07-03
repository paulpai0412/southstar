import { NextRequest } from "next/server";
import { buildWorkflowV2Url, proxyWorkflowV2Json, workflowV2BlockedResponse, workflowV2Capabilities } from "../../../../lib/workflow/v2-api";

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(request, params);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(request, params);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(request, params);
}

async function proxy(request: NextRequest, paramsPromise: Promise<{ path: string[] }>) {
  if (!workflowV2Capabilities().v2Backend) return workflowV2BlockedResponse();
  const params = await paramsPromise;
  const pathname = `/api/v2/library/${params.path.map(encodeURIComponent).join("/")}`;
  if (request.headers.get("accept")?.includes("text/event-stream")) {
    const upstream = buildWorkflowV2Url(pathname);
    upstream.search = request.nextUrl.search;
    const headers: HeadersInit = { accept: "text/event-stream" };
    const contentType = request.headers.get("content-type");
    if (contentType) headers["content-type"] = contentType;
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    });
    if (!response.ok) return new Response(await response.text(), { status: response.status, statusText: response.statusText });
    if (!response.body) return new Response("library stream missing body", { status: 502 });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
      },
    });
  }
  return proxyWorkflowV2Json(request, pathname);
}
