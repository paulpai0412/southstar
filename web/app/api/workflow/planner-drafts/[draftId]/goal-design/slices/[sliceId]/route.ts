import { NextRequest } from "next/server";
import { proxyWorkflowV2Json } from "../../../../../../../../lib/workflow/v2-api";

function normalizedSegment(value: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return encodeURIComponent(value);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string; sliceId: string }> },
) {
  const { draftId: rawDraftId, sliceId: rawSliceId } = await params;
  const draftId = normalizedSegment(rawDraftId);
  const sliceId = normalizedSegment(rawSliceId);
  return proxyWorkflowV2Json(request, `/api/v2/planner/drafts/${draftId}/goal-design/slices/${sliceId}`);
}
