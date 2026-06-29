import { proxyWorkflowV2Json } from "../../../../lib/workflow/v2-api";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  return proxyWorkflowV2Json(request, "/api/v2/ui/workflow");
}
