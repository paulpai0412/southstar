import { buildPostgresCoreReadModel } from "../read-models/postgres-core.ts";
import { getManagedAgentRunReadModelPg } from "../read-models/managed-agents.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleUiRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const managedAgentsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/managed-agents$/);
  if (request.method === "GET" && managedAgentsMatch) {
    return json("managed-agents", await getManagedAgentRunReadModelPg(context.db, decodeURIComponent(managedAgentsMatch[1]!)));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/workflow-canvas") {
    return json("ui-workflow-canvas", await buildPostgresCoreReadModel(context.db, {
      kind: "workflow-canvas",
      runId: requiredQuery(url, "runId"),
      taskId: url.searchParams.get("taskId") ?? undefined,
    }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/runtime-monitor") {
    return json("ui-runtime-monitor", await buildPostgresCoreReadModel(context.db, { kind: "runtime-monitor", runId: requiredQuery(url, "runId") }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/task-detail") {
    return json("ui-task-detail", await buildPostgresCoreReadModel(context.db, { kind: "task-detail", runId: requiredQuery(url, "runId"), taskId: requiredQuery(url, "taskId") }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/sessions-memory") {
    return json("ui-sessions-memory", await buildPostgresCoreReadModel(context.db, { kind: "sessions-memory", runId: requiredQuery(url, "runId") }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/executor") {
    return json("ui-executor", await buildPostgresCoreReadModel(context.db, { kind: "executor-ops", runId: requiredQuery(url, "runId") }));
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
