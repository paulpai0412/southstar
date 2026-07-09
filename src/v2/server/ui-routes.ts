import { getManagedAgentRunReadModelPg } from "../read-models/managed-agents.ts";
import { buildWorkflowUiReadModelPg } from "../read-models/workflow-ui.ts";
import { buildOperatorOverviewReadModelPg } from "../read-models/operator-overview.ts";
import { buildOperatorTaskDebugReadModelPg } from "../read-models/operator-task-debug.ts";
import { buildChatCapabilitiesReadModelPg } from "../read-models/chat-capabilities.ts";
import { buildChatSessionReadModelPg } from "../read-models/chat-session.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleUiRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const managedAgentsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/managed-agents$/);
  if (request.method === "GET" && managedAgentsMatch) {
    return json("managed-agents", await getManagedAgentRunReadModelPg(context.db, decodeURIComponent(managedAgentsMatch[1]!)));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/workflow") {
    const runId = url.searchParams.get("runId") ?? undefined;
    const draftId = url.searchParams.get("draftId") ?? undefined;
    if (!runId && !draftId) throw new Error("runId or draftId is required");
    return json("ui-workflow", await buildWorkflowUiReadModelPg(context.db, {
      runId,
      draftId,
      taskId: url.searchParams.get("taskId") ?? undefined,
    }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/chat-capabilities") {
    return json("ui-chat-capabilities", await buildChatCapabilitiesReadModelPg(context.db, {
      domain: url.searchParams.get("domain") ?? undefined,
    }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/chat-session") {
    return json("ui-chat-session", await buildChatSessionReadModelPg(context.db, {
      runId: url.searchParams.get("runId") ?? undefined,
      sessionId: url.searchParams.get("sessionId") ?? undefined,
    }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/operator-overview") {
    return json("ui-operator-overview", await buildOperatorOverviewReadModelPg(context.db));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/operator-task-debug") {
    return json("ui-operator-task-debug", await buildOperatorTaskDebugReadModelPg(context.db, {
      runId: requiredQuery(url, "runId"),
      taskId: requiredQuery(url, "taskId"),
    }));
  }
  return undefined;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
