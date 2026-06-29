import { proxyWorkflowV2Json } from "../../../../../../../../lib/workflow/v2-api";
import type { NextRequest } from "next/server";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ draftId: string; taskId: string }> },
) {
  const { draftId, taskId } = await context.params;
  return proxyWorkflowV2Json(
    request,
    `/api/v2/planner/drafts/${encodeURIComponent(draftId)}/tasks/${encodeURIComponent(taskId)}/profile-override`,
  );
}
