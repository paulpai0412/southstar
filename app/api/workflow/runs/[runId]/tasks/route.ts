import { NextRequest } from "next/server";
import { proxyWorkflowV2Json } from "@/lib/workflow/v2-api";

function normalizedSegment(value: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return encodeURIComponent(value);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId: rawRunId } = await params;
  const runId = normalizedSegment(rawRunId);
  return proxyWorkflowV2Json(request, `/api/v2/runs/${runId}/tasks`);
}
