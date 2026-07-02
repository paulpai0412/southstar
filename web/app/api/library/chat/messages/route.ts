import { NextRequest } from "next/server";
import { proxyWorkflowV2Json } from "../../../../../lib/workflow/v2-api";

export async function POST(request: NextRequest) {
  return proxyWorkflowV2Json(request, "/api/v2/library/chat/messages");
}
