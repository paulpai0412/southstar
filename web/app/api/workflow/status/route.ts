import { NextResponse } from "next/server";
import { workflowV2Capabilities } from "@/lib/workflow/v2-api";

export async function GET() {
  return NextResponse.json({ capabilities: workflowV2Capabilities() });
}
