import { NextRequest } from "next/server";
import { proxyWorkflowV2Json } from "../../../../../../../lib/workflow/v2-api";

function normalizedSegment(value: string): string {
  try { return encodeURIComponent(decodeURIComponent(value)); } catch { return encodeURIComponent(value); }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string; requirementId: string }> },
) {
  const { draftId: rawDraftId, requirementId: rawRequirementId } = await params;
  return proxyWorkflowV2Json(request, `/api/v2/planner/drafts/${normalizedSegment(rawDraftId)}/goal-requirements/${normalizedSegment(rawRequirementId)}`);
}
