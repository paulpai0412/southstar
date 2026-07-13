import { NextRequest } from "next/server";
import { proxyWorkflowV2Json } from "../../../../../../../lib/workflow/v2-api";

function normalizedSegment(value: string): string {
  try { return encodeURIComponent(decodeURIComponent(value)); } catch { return encodeURIComponent(value); }
}

function pathFor(draftId: string, contractId: string): string {
  return `/api/v2/planner/drafts/${normalizedSegment(draftId)}/ui-contracts/${normalizedSegment(contractId)}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string; contractId: string }> },
) {
  const { draftId, contractId } = await params;
  return proxyWorkflowV2Json(request, pathFor(draftId, contractId));
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string; contractId: string }> },
) {
  const { draftId, contractId } = await params;
  return proxyWorkflowV2Json(request, pathFor(draftId, contractId));
}
