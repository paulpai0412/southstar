import { NextRequest, NextResponse } from "next/server";
import { buildWorkflowV2Url } from "../../../../../../../lib/workflow/v2-api";

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
  const body = await request.text();
  let upstream: Response;
  try {
    upstream = await fetch(buildWorkflowV2Url(
      `/api/v2/planner/drafts/${normalizedSegment(rawDraftId)}/confirm-requirements/stream`,
    ), {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": request.headers.get("content-type") ?? "application/json",
      },
      body,
      signal: request.signal,
    });
  } catch (error) {
    return NextResponse.json({
      status: "blocked",
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }
  if (!upstream.body) {
    return NextResponse.json({ status: "blocked", error: "Requirement confirmation stream is missing a response body" }, { status: 502 });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
