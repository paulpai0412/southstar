import { reconcileExecutorBindingsPg } from "../executor/postgres-reconciler.ts";
import { getExecutionProjectionByExternalJobIdPg, getExecutionProjectionPg, listExecutionProjectionsPg } from "../read-models/executions.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleExecutionRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const listMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(?:hand-executions|executor-jobs)$/);
  if (request.method === "GET" && listMatch) {
    const runId = decodeURIComponent(listMatch[1]!);
    return json("executions", { runId, executions: await listExecutionProjectionsPg(context.db, runId) });
  }

  const detailMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(hand-executions|executor-jobs)\/([^/]+)$/);
  if (request.method === "GET" && detailMatch) {
    const runId = decodeURIComponent(detailMatch[1]!);
    const routeKind = detailMatch[2]!;
    const executionId = decodeURIComponent(detailMatch[3]!);
    const execution = routeKind === "executor-jobs"
      ? await getExecutionProjectionByExternalJobIdPg(context.db, { runId, jobId: executionId })
      : await getExecutionProjectionPg(context.db, { runId, executionId });
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    return json("execution", { runId, execution });
  }

  const reconcileMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/executor-jobs\/([^/]+)\/reconcile$/);
  if (request.method === "POST" && reconcileMatch) {
    const runId = decodeURIComponent(reconcileMatch[1]!);
    const jobId = decodeURIComponent(reconcileMatch[2]!);
    const execution = await getExecutionProjectionByExternalJobIdPg(context.db, { runId, jobId });
    if (!execution) throw new Error(`execution not found: ${jobId}`);
    if (!context.torkObservationClient) throw new Error("torkObservationClient is required for executor reconcile");
    return json("executor-job-reconcile", {
      runId,
      executionId: execution.executionId,
      result: await reconcileExecutorBindingsPg(context.db, {
        tork: context.torkObservationClient,
        runId,
        bindingId: execution.executionId,
      }),
    });
  }

  return undefined;
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
