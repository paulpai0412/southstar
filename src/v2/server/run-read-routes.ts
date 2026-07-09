import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import { buildEvolutionControlCenterReadModel } from "../read-models/evolution-control-center.ts";
import { envelopeReadModel } from "../read-models/envelope.ts";
import { buildPostgresCoreReadModel, isPostgresCoreReadModelKind } from "../read-models/postgres-core.ts";
import { buildRunInspectionReadModelPg, buildRuntimeExceptionReadModelPg } from "../read-models/postgres-run-inspection.ts";
import type { ReadModelKind } from "../read-models/types.ts";
import { getWorkflowRunPg, listHistoryForRunPg, listResourcesPg } from "../stores/postgres-runtime-store.ts";
import { getPostgresTaskEnvelope } from "../ui-api/postgres-task-envelope.ts";
import { createRuntimeEventStreamResponse } from "./runtime-event-stream.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import { parseRuntimeEventSequence, readRunEventsSince } from "./sse.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleRunReadRoute(
  context: RuntimeServerContext,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  const eventsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events$/);
  if (request.method === "GET" && eventsMatch) {
    const after = parseRuntimeEventSequence(url.searchParams.get("after"));
    return json("events", await readRunEventsSince(context.db, { runId: decodeURIComponent(eventsMatch[1]!), afterSequence: after }));
  }

  const exceptionsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/exceptions$/);
  if (request.method === "GET" && exceptionsMatch) {
    return json("runtime-exceptions", await buildRuntimeExceptionReadModelPg(context.db, { runId: decodeURIComponent(exceptionsMatch[1]!) }));
  }

  const streamMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events\/stream$/);
  if (request.method === "GET" && streamMatch) {
    return createRuntimeEventStreamResponse(context, request, url, decodeURIComponent(streamMatch[1]!));
  }

  const readModelMatch = url.pathname.match(/^\/api\/v2\/read-models\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  if (request.method === "GET" && readModelMatch) {
    const kind = decodeURIComponent(readModelMatch[1]!) as ReadModelKind;
    if (!isReadModelKind(kind)) throw new Error(`unknown read model kind: ${kind}`);
    const runId = decodeURIComponent(readModelMatch[2]!);
    const taskId = readModelMatch[3] ? decodeURIComponent(readModelMatch[3]) : undefined;
    if (kind === "evolution-control-center") return json("read-model", await buildEvolutionControlCenterReadModel(context.db));
    if (kind === "run-inspection") return json("read-model", await buildRunInspectionReadModelPg(context.db, runId));
    if (kind === "exceptions") {
      return json("read-model", envelopeReadModel({
        schemaVersion: "southstar.read_model.exceptions.v1",
        kind,
        data: await buildRuntimeExceptionReadModelPg(context.db, { runId }),
      }));
    }
    if (isPostgresCoreReadModelKind(kind)) return json("read-model", await buildPostgresCoreReadModel(context.db, { kind, runId, taskId }));
    throw new Error(`unsupported read model kind: ${kind}`);
  }

  const runMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)$/);
  if (request.method === "GET" && runMatch) {
    const run = await getWorkflowRunPg(context.db, decodeURIComponent(runMatch[1]!));
    if (!run) throw new Error("run not found");
    return json("status", { run });
  }

  const tasksMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks$/);
  if (request.method === "GET" && tasksMatch) {
    const runId = decodeURIComponent(tasksMatch[1]!);
    const rows = await context.db.query("select * from southstar.workflow_tasks where run_id = $1 order by sort_order", [runId]);
    return json("tasks", rows.rows);
  }

  const taskMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)$/);
  if (request.method === "GET" && taskMatch) {
    const runId = decodeURIComponent(taskMatch[1]!);
    const taskId = decodeURIComponent(taskMatch[2]!);
    return json("task", await buildPostgresCoreReadModel(context.db, { kind: "task-detail", runId, taskId }));
  }

  const resourceMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(artifacts|sessions|memory|logs)$/);
  if (request.method === "GET" && resourceMatch) {
    const runId = decodeURIComponent(resourceMatch[1]!);
    const kind = resourceMatch[2]!;
    if (kind === "logs") return json("logs", await listHistoryForRunPg(context.db, runId));
    const resourceTypes = kind === "artifacts" ? ["artifact", ARTIFACT_REF_RESOURCE_TYPE] : kind === "sessions" ? ["session"] : ["memory_item", "memory_delta"];
    const resources = (await Promise.all(resourceTypes.map((resourceType) => listResourcesPg(context.db, { resourceType })))).flat().filter((resource) => resource.runId === runId);
    return json(kind, resources);
  }

  const approvalsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/approvals$/);
  if (request.method === "GET" && approvalsMatch) {
    const runId = decodeURIComponent(approvalsMatch[1]!);
    return json("approvals", (await listResourcesPg(context.db, { resourceType: "approval" })).filter((resource) => resource.runId === runId));
  }

  const envelopeMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/envelope$/);
  if (request.method === "GET" && envelopeMatch) {
    return json("task-envelope", await getPostgresTaskEnvelope(context.db, { runId: decodeURIComponent(envelopeMatch[1]!), taskId: decodeURIComponent(envelopeMatch[2]!) }));
  }

  return undefined;
}

function isReadModelKind(kind: string): kind is ReadModelKind {
  return [
    "run-inspection",
    "run-summary",
    "executions",
    "exceptions",
    "runtime-monitor",
    "workflow-canvas",
    "executor-ops",
    "task-detail",
    "sessions-memory",
    "vault-mcp",
    "evolution-control-center",
    "run-control",
    "workflow-dag",
  ].includes(kind);
}

function json<T>(kind: string, result: T, status = 200): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { status, headers: { "content-type": "application/json", ...corsHeaders() } });
}

function corsHeaders(): Record<string, string> {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", "access-control-allow-headers": "content-type,authorization,last-event-id" };
}
