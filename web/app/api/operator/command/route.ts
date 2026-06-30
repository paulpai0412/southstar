import { buildWorkflowV2Url, workflowV2BlockedResponse } from "../../../../lib/workflow/v2-api";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { endpoint?: unknown; method?: unknown; payload?: unknown };
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const method = typeof body.method === "string" ? body.method.toUpperCase() : "POST";
    const upstreamUrl = buildWorkflowV2Url(endpoint);
    if (!endpoint.startsWith("/api/v2/") || !upstreamUrl.pathname.startsWith("/api/v2/")) {
      return NextResponse.json({ status: "rejected", error: "operator command endpoint must target /api/v2" }, { status: 400 });
    }
    if (method !== "POST") {
      return NextResponse.json({ status: "rejected", error: "operator commands support POST only" }, { status: 405 });
    }

    const response = await fetch(upstreamUrl, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body.payload ?? {}),
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return workflowV2BlockedResponse();
  }
}
