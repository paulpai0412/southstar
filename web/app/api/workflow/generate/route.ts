import { NextRequest } from "next/server";
import { buildWorkflowDagProposal } from "@/lib/workflow/dag";
import { loadWorkflowLibrary } from "@/lib/workflow/library-store";
import { buildWorkflowV2Url, workflowV2Capabilities } from "@/lib/workflow/v2-api";
import { buildWorkflowDagFromPlannerDraft, unwrapV2Envelope, type V2PlannerDraftOrchestrationView } from "@/lib/workflow/v2-library-adapter";

type V2PlannerDraftResponse = {
  draftId: string;
};

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    cwd?: string | null;
    prompt?: string;
    templateId?: string | null;
  };
  const prompt = body.prompt?.trim();
  if (!prompt) return new Response("prompt is required", { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      if (workflowV2Capabilities().v2Backend) {
        try {
          const draftResponse = await fetch(buildWorkflowV2Url("/api/v2/planner/drafts"), {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              goalPrompt: prompt,
              ...(body.cwd ? { cwd: body.cwd } : {}),
            }),
          });
          if (!draftResponse.ok) {
            throw new Error(`planner draft request failed: HTTP ${draftResponse.status}`);
          }
          const draftPayload = unwrapV2Envelope<V2PlannerDraftResponse>(await draftResponse.json());
          if (!draftPayload?.draftId) {
            throw new Error("planner draft response is missing draftId");
          }

          const orchestrationResponse = await fetch(
            buildWorkflowV2Url(`/api/v2/planner/drafts/${encodeURIComponent(draftPayload.draftId)}/orchestration`),
            {
              headers: { accept: "application/json" },
            },
          );
          if (!orchestrationResponse.ok) {
            throw new Error(`planner draft orchestration request failed: HTTP ${orchestrationResponse.status}`);
          }
          const orchestrationPayload = unwrapV2Envelope<V2PlannerDraftOrchestrationView>(await orchestrationResponse.json());
          const dag = buildWorkflowDagFromPlannerDraft(orchestrationPayload);
          send("message", { text: "Generated workflow DAG proposal." });
          send("dag", { dag });
          send("done", {});
        } catch (error) {
          send("error", { error: error instanceof Error ? error.message : String(error) });
        }
        controller.close();
        return;
      }

      try {
        const library = await loadWorkflowLibrary({ cwd: body.cwd ?? null });
        const domain = library.domains[0];
        const template = domain?.workflowTemplates.find((item) => item.id === body.templateId) ?? domain?.workflowTemplates[0];
        if (!domain || !template) {
          send("error", { error: "No workflow template available" });
          controller.close();
          return;
        }

        const dag = buildWorkflowDagProposal({ prompt, template, agents: domain.agents });
        send("message", { text: "Generated workflow DAG proposal." });
        send("dag", { dag });
        send("done", {});
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : String(error) });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
