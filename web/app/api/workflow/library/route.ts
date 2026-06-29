import { NextRequest, NextResponse } from "next/server";
import { loadWorkflowLibrary } from "../../../../lib/workflow/library-store";
import { buildWorkflowV2Url, workflowV2Capabilities } from "../../../../lib/workflow/v2-api";
import { unwrapV2Envelope, workflowLibraryFromAgentLibrary, type V2AgentLibraryReadModel } from "../../../../lib/workflow/v2-library-adapter";

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd");
    if (workflowV2Capabilities().v2Backend) {
      const domain = request.nextUrl.searchParams.get("domain") ?? "software";
      const endpoint = `/api/v2/agent-library?domain=${encodeURIComponent(domain)}`;
      const response = await fetch(buildWorkflowV2Url(endpoint), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`agent-library request failed: HTTP ${response.status}`);
      }
      const payload = unwrapV2Envelope<V2AgentLibraryReadModel>(await response.json());
      return NextResponse.json({ library: workflowLibraryFromAgentLibrary(payload) });
    }

    const library = await loadWorkflowLibrary({ cwd });
    return NextResponse.json({ library });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
