import type { SouthstarDb } from "../db/postgres.ts";
import { recordLearningSignals } from "../evolution/signals.ts";
import { synthesizeKnowledgeCards, approveKnowledgeCard, rejectKnowledgeCard } from "../evolution/cards.ts";
import { synthesizeDeltaProposals } from "../evolution/deltas.ts";
import { createAssetVersion, promoteAssetVersion, rollbackAssetVersion } from "../evolution/assets.ts";
import { createSandboxExperiment, evaluateSandboxExperiment, recordSandboxEvaluatorOutputPg, recordSandboxTrial, startSandboxExecutionPg } from "../evolution/sandbox.ts";
import { getEvidenceSubgraph } from "../evolution/learning-graph.ts";
import { getWikiPage, listBacklinks, listForwardLinks, proposeWikiLink, approveWikiLink, rejectWikiLink, findOrphanKnowledgeCards, findStaleWikiLinks, normalizeWikiAliases, openWikiConflict, resolveWikiConflict, rewireStaleWikiLinks } from "../evolution/wiki.ts";
import { decideRegressionAlert } from "../evolution/regression-monitor.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";

type EvolutionCommandBody = {
  actor?: string;
  reason?: string;
  commandId?: string;
};

export async function handleEvolutionRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/v2/evolution")) return undefined;
  const db = context.db as unknown as SouthstarDb;

  if (request.method === "GET" && url.pathname === "/api/v2/evolution/overview") {
    const counts = await db.query<{ bucket: string; count: string }>(
      `select bucket, count(*)::text as count
       from (
         select 'signals' as bucket from southstar.learning_nodes where node_type = 'learning_signal'
         union all select 'cards' from southstar.learning_nodes where node_type = 'knowledge_card'
         union all select 'deltas' from southstar.runtime_resources where resource_type = 'delta_proposal'
         union all select 'experiments' from southstar.runtime_resources where resource_type = 'sandbox_experiment'
         union all select 'assets' from southstar.runtime_resources where resource_type = 'asset_version'
       ) buckets
       group by bucket`,
    );
    const byBucket = Object.fromEntries(counts.rows.map((row) => [row.bucket, Number(row.count)]));
    return json("evolution-overview", {
      health: { status: "ready", schema: "southstar" },
      counts: byBucket,
      signals: byBucket.signals ?? 0,
      cards: byBucket.cards ?? 0,
      deltas: byBucket.deltas ?? 0,
      experiments: byBucket.experiments ?? 0,
      assets: byBucket.assets ?? 0,
      regression: [],
      graph: null,
      selectedWikiNodeId: undefined,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/v2/evolution/signals") {
    const rows = await db.query("select id, status, payload_jsonb from southstar.learning_nodes where node_type = 'learning_signal' order by created_at, id");
    return json("evolution-signals", rows.rows.map(mapNode));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/evolution/signals") {
    const body = await readJsonBody<EvolutionCommandBody & { signals?: Array<Record<string, unknown>> }>(request);
    requireCommand(body);
    if (!Array.isArray(body.signals)) throw new Error("signals is required");
    return json("evolution-signals-recorded", await recordLearningSignals(db, {
      actor: body.actor,
      reason: body.reason,
      signals: body.signals.map((signal) => ({ ...signal, signalKind: requiredString(signal.signalKind, "signalKind") })),
    }));
  }

  if (request.method === "GET" && url.pathname === "/api/v2/evolution/cards") {
    const rows = await db.query("select id, status, payload_jsonb from southstar.learning_nodes where node_type = 'knowledge_card' order by created_at, id");
    return json("evolution-cards", rows.rows.map(mapNode));
  }

  const cardMatch = url.pathname.match(/^\/api\/v2\/evolution\/cards\/([^/]+)$/);
  if (request.method === "GET" && cardMatch) {
    const row = await db.maybeOne("select id, status, payload_jsonb from southstar.learning_nodes where id = $1 and node_type = 'knowledge_card'", [decodeURIComponent(cardMatch[1]!)]);
    if (!row) throw new Error("knowledge card not found");
    return json("evolution-card", mapNode(row));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/evolution/cards/synthesize") {
    const body = await readJsonBody<EvolutionCommandBody & { runId?: string }>(request);
    requireCommand(body);
    return json("evolution-cards-synthesized", await synthesizeKnowledgeCards(db, { actor: body.actor, reason: body.reason, runId: body.runId }));
  }

  const cardApproveMatch = url.pathname.match(/^\/api\/v2\/evolution\/cards\/([^/]+)\/(approve|reject)$/);
  if (request.method === "POST" && cardApproveMatch) {
    const body = await readJsonBody<EvolutionCommandBody>(request);
    requireCommand(body);
    const cardId = decodeURIComponent(cardApproveMatch[1]!);
    if (cardApproveMatch[2] === "approve") {
      await approveKnowledgeCard(db, { cardId, actor: body.actor, reason: body.reason, commandId: body.commandId ?? crypto.randomUUID() });
      return json("evolution-card-approved", { cardId });
    }
    await rejectKnowledgeCard(db, { cardId, actor: body.actor, reason: body.reason, commandId: body.commandId ?? crypto.randomUUID() });
    return json("evolution-card-rejected", { cardId });
  }

  if (request.method === "GET" && url.pathname === "/api/v2/evolution/deltas") {
    const rows = await db.query("select resource_key as id, status, payload_json from southstar.runtime_resources where resource_type = 'delta_proposal' order by created_at, resource_key");
    return json("evolution-deltas", rows.rows.map(mapResource));
  }

  const deltaMatch = url.pathname.match(/^\/api\/v2\/evolution\/deltas\/([^/]+)$/);
  if (request.method === "GET" && deltaMatch) {
    const row = await db.maybeOne("select resource_key as id, status, payload_json from southstar.runtime_resources where resource_type = 'delta_proposal' and resource_key = $1", [decodeURIComponent(deltaMatch[1]!)]);
    if (!row) throw new Error("delta proposal not found");
    return json("evolution-delta", mapResource(row));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/evolution/deltas/synthesize") {
    const body = await readJsonBody<EvolutionCommandBody & { sourceCardRefs?: string[]; targetRef?: string; targetVersion?: string }>(request);
    requireCommand(body);
    if (!Array.isArray(body.sourceCardRefs)) throw new Error("sourceCardRefs is required");
    return json("evolution-deltas-synthesized", await synthesizeDeltaProposals(db, {
      actor: body.actor,
      reason: body.reason,
      sourceCardRefs: body.sourceCardRefs,
      targetRef: body.targetRef,
      targetVersion: body.targetVersion,
    }));
  }

  const deltaModerateMatch = url.pathname.match(/^\/api\/v2\/evolution\/deltas\/([^/]+)\/(approve|reject)$/);
  if (request.method === "POST" && deltaModerateMatch) {
    const body = await readJsonBody<EvolutionCommandBody>(request);
    requireCommand(body);
    const deltaId = decodeURIComponent(deltaModerateMatch[1]!);
    const status = deltaModerateMatch[2] === "approve" ? "validated" : "rejected";
    await updateRuntimeResourceStatus(db, "delta_proposal", deltaId, status, {
      moderatedBy: body.actor,
      moderationReason: body.reason,
      commandId: body.commandId ?? crypto.randomUUID(),
    });
    await db.query("update southstar.learning_nodes set status = $2, updated_at = now() where id = $1 and node_type = 'delta_proposal'", [deltaId, status]);
    return json("evolution-delta-moderated", { deltaId, status });
  }

  const sandboxMatch = url.pathname.match(/^\/api\/v2\/evolution\/deltas\/([^/]+)\/run-sandbox$/);
  if (request.method === "POST" && sandboxMatch) {
    const body = await readJsonBody<EvolutionCommandBody & {
      baselineAssetRefs?: string[];
      candidateAssetRefs?: string[];
      regressionSuiteRefs?: string[];
      replayRunRefs?: string[];
      maxCostRegressionPercent?: number;
      maxDurationRegressionPercent?: number;
      baselineTrial?: Record<string, unknown>;
      candidateTrial?: Record<string, unknown>;
    }>(request);
    requireCommand(body);
    const deltaProposalId = decodeURIComponent(sandboxMatch[1]!);
    const experiment = await createSandboxExperiment(db, {
      deltaProposalId,
      baselineAssetRefs: body.baselineAssetRefs ?? [],
      candidateAssetRefs: body.candidateAssetRefs ?? [],
      regressionSuiteRefs: body.regressionSuiteRefs ?? ["software-core-regression"],
      replayRunRefs: body.replayRunRefs ?? [],
      maxCostRegressionPercent: body.maxCostRegressionPercent ?? 10,
      maxDurationRegressionPercent: body.maxDurationRegressionPercent ?? 15,
    });
    const caseRef = (body.replayRunRefs ?? ["regression-case"])[0] ?? "regression-case";
    if (body.baselineTrial) {
      await recordSandboxTrial(db, sandboxTrialFromBody(experiment.experimentId, "baseline", caseRef, body.baselineTrial));
    }
    if (body.candidateTrial) {
      await recordSandboxTrial(db, sandboxTrialFromBody(experiment.experimentId, "candidate", caseRef, body.candidateTrial));
    }
    const decision = body.baselineTrial && body.candidateTrial
      ? await evaluateSandboxExperiment(db, experiment.experimentId)
      : { experimentId: experiment.experimentId, decision: "queued" as const, reasons: [] };
    return json("evolution-sandbox", { ...experiment, ...decision });
  }

  const experimentStartMatch = url.pathname.match(/^\/api\/v2\/evolution\/experiments\/([^/]+)\/start$/);
  if (request.method === "POST" && experimentStartMatch) {
    const body = await readJsonBody<EvolutionCommandBody>(request);
    requireCommand(body);
    return json("evolution-sandbox-started", await startSandboxExecutionPg(db, {
      experimentId: decodeURIComponent(experimentStartMatch[1]!),
      executorProvider: context.executorProvider,
      callbackUrl: context.callbackUrl ?? `${context.serverUrl ?? ""}/api/v2/tork/callback`,
      heartbeatUrl: context.serverUrl ? `${context.serverUrl}/api/v2/executor/heartbeat` : undefined,
    }));
  }

  const experimentEvaluatorMatch = url.pathname.match(/^\/api\/v2\/evolution\/experiments\/([^/]+)\/evaluator-output$/);
  if (request.method === "POST" && experimentEvaluatorMatch) {
    const body = await readJsonBody<EvolutionCommandBody & { variant?: "baseline" | "candidate"; caseRef?: string; evaluatorResult?: Record<string, unknown> }>(request);
    requireCommand(body);
    const evaluatorResult = isRecord(body.evaluatorResult) ? body.evaluatorResult : {};
    return json("evolution-sandbox-evaluator-output", await recordSandboxEvaluatorOutputPg(db, {
      experimentId: decodeURIComponent(experimentEvaluatorMatch[1]!),
      variant: body.variant === "candidate" ? "candidate" : "baseline",
      caseRef: requiredString(body.caseRef, "caseRef"),
      evaluatorResult: {
        ok: evaluatorResult.ok === true,
        targetedReplayFixed: evaluatorResult.targetedReplayFixed === true,
        metrics: isRecord(evaluatorResult.metrics) ? evaluatorResult.metrics : {},
      },
    }));
  }

  if (request.method === "GET" && url.pathname === "/api/v2/evolution/experiments") {
    const rows = await db.query("select resource_key as id, status, payload_json from southstar.runtime_resources where resource_type = 'sandbox_experiment' order by created_at, resource_key");
    return json("evolution-experiments", rows.rows.map(mapResource));
  }

  if (request.method === "GET" && url.pathname === "/api/v2/evolution/assets") {
    const rows = await db.query("select resource_key as id, status, payload_json from southstar.runtime_resources where resource_type = 'asset_version' order by created_at, resource_key");
    return json("evolution-assets", rows.rows.map(mapResource));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/evolution/assets/register") {
    const body = await readJsonBody<EvolutionCommandBody & {
      assetKind?: never;
      assetRef?: string;
      version?: string;
      parentVersion?: string;
      payload?: unknown;
      status?: never;
      promotedByDeltaId?: string;
    }>(request);
    requireCommand(body);
    const asset = await createAssetVersion(db, {
      assetKind: requiredString(body.assetKind, "assetKind") as never,
      assetRef: requiredString(body.assetRef, "assetRef"),
      version: requiredString(body.version, "version"),
      parentVersion: body.parentVersion,
      payload: body.payload ?? {},
      status: body.status,
      promotedByDeltaId: body.promotedByDeltaId,
    });
    return json("evolution-asset-registered", { assetId: asset.id });
  }

  const assetMatch = url.pathname.match(/^\/api\/v2\/evolution\/assets\/([^/]+)$/);
  if (request.method === "GET" && assetMatch) {
    const row = await db.maybeOne("select resource_key as id, status, payload_json from southstar.runtime_resources where resource_type = 'asset_version' and resource_key = $1", [decodeURIComponent(assetMatch[1]!)]);
    if (!row) throw new Error("asset version not found");
    return json("evolution-asset", mapResource(row));
  }

  const assetPromoteMatch = url.pathname.match(/^\/api\/v2\/evolution\/assets\/([^/]+)\/promote$/);
  if (request.method === "POST" && assetPromoteMatch) {
    const body = await readJsonBody<EvolutionCommandBody & { promotedByDeltaId?: string; targetStatus?: "active" | "canary"; canaryPercent?: number }>(request);
    requireCommand(body);
    const assetId = decodeURIComponent(assetPromoteMatch[1]!);
    await promoteAssetVersion(db, {
      assetId,
      promotedByDeltaId: body.promotedByDeltaId,
      actor: body.actor,
      reason: body.reason,
      targetStatus: body.targetStatus,
      canaryPercent: body.canaryPercent,
    });
    return json("evolution-asset-promoted", { assetId });
  }

  const assetRollbackMatch = url.pathname.match(/^\/api\/v2\/evolution\/assets\/([^/]+)\/rollback$/);
  if (request.method === "POST" && assetRollbackMatch) {
    const body = await readJsonBody<EvolutionCommandBody>(request);
    requireCommand(body);
    return json("evolution-asset-rollback", await rollbackAssetVersion(db, {
      assetId: decodeURIComponent(assetRollbackMatch[1]!),
      actor: body.actor,
      reason: body.reason,
    }));
  }

  if (request.method === "GET" && url.pathname === "/api/v2/evolution/graph") {
    const nodeId = url.searchParams.get("nodeId");
    if (!nodeId) throw new Error("nodeId is required");
    return json("evolution-graph", await getEvidenceSubgraph(db, nodeId, 4));
  }

  const wikiNormalizeMatch = url.pathname.match(/^\/api\/v2\/evolution\/wiki\/([^/]+)\/normalize-aliases$/);
  if (request.method === "POST" && wikiNormalizeMatch) {
    const body = await readJsonBody<EvolutionCommandBody>(request);
    requireCommand(body);
    return json("evolution-wiki-aliases-normalized", await normalizeWikiAliases(db, {
      nodeId: decodeURIComponent(wikiNormalizeMatch[1]!),
      actor: body.actor,
      reason: body.reason,
    }));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/evolution/wiki/maintenance/rewire-stale") {
    const body = await readJsonBody<EvolutionCommandBody>(request);
    requireCommand(body);
    return json("evolution-wiki-stale-rewired", await rewireStaleWikiLinks(db, { actor: body.actor, reason: body.reason }));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/evolution/wiki/conflicts") {
    const body = await readJsonBody<EvolutionCommandBody & { fromNodeId?: string; toNodeId?: string; evidenceNodeRefs?: string[] }>(request);
    requireCommand(body);
    return json("evolution-wiki-conflict-opened", await openWikiConflict(db, {
      fromNodeId: requiredString(body.fromNodeId, "fromNodeId"),
      toNodeId: requiredString(body.toNodeId, "toNodeId"),
      actor: body.actor,
      reason: body.reason,
      evidenceNodeRefs: Array.isArray(body.evidenceNodeRefs) ? body.evidenceNodeRefs : [],
    }));
  }

  const wikiConflictResolveMatch = url.pathname.match(/^\/api\/v2\/evolution\/wiki\/conflicts\/([^/]+)\/resolve$/);
  if (request.method === "POST" && wikiConflictResolveMatch) {
    const body = await readJsonBody<EvolutionCommandBody & { resolution?: "rejected" | "superseded" | "accepted" }>(request);
    requireCommand(body);
    const conflictId = decodeURIComponent(wikiConflictResolveMatch[1]!);
    await resolveWikiConflict(db, {
      conflictId,
      resolution: body.resolution === "accepted" || body.resolution === "rejected" || body.resolution === "superseded" ? body.resolution : "accepted",
      actor: body.actor,
      reason: body.reason,
    });
    return json("evolution-wiki-conflict-resolved", { conflictId, status: "resolved" });
  }

  const wikiMatch = url.pathname.match(/^\/api\/v2\/evolution\/wiki\/([^/]+)$/);
  if (request.method === "GET" && wikiMatch) {
    return json("evolution-wiki-page", await getWikiPage(db, decodeURIComponent(wikiMatch[1]!)));
  }

  const wikiBacklinksMatch = url.pathname.match(/^\/api\/v2\/evolution\/wiki\/([^/]+)\/backlinks$/);
  if (request.method === "GET" && wikiBacklinksMatch) {
    return json("evolution-wiki-backlinks", await listBacklinks(db, decodeURIComponent(wikiBacklinksMatch[1]!)));
  }

  const wikiLinksMatch = url.pathname.match(/^\/api\/v2\/evolution\/wiki\/([^/]+)\/links$/);
  if (request.method === "GET" && wikiLinksMatch) {
    return json("evolution-wiki-links", await listForwardLinks(db, decodeURIComponent(wikiLinksMatch[1]!)));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/evolution/wiki/links") {
    const body = await readJsonBody<EvolutionCommandBody & {
      fromNodeId?: string;
      toNodeId?: string;
      relation?: never;
      confidence?: number;
      evidenceNodeRefs?: string[];
    }>(request);
    requireCommand(body);
    return json("evolution-wiki-link", await proposeWikiLink(db, {
      fromNodeId: requiredString(body.fromNodeId, "fromNodeId"),
      toNodeId: requiredString(body.toNodeId, "toNodeId"),
      relation: requiredString(body.relation, "relation") as never,
      actor: body.actor,
      reason: body.reason,
      confidence: typeof body.confidence === "number" ? body.confidence : 0.5,
      evidenceNodeRefs: Array.isArray(body.evidenceNodeRefs) ? body.evidenceNodeRefs : [],
    }));
  }

  const wikiModerateMatch = url.pathname.match(/^\/api\/v2\/evolution\/wiki\/links\/([^/]+)\/(approve|reject)$/);
  if (request.method === "POST" && wikiModerateMatch) {
    const body = await readJsonBody<EvolutionCommandBody>(request);
    requireCommand(body);
    const edgeId = decodeURIComponent(wikiModerateMatch[1]!);
    if (wikiModerateMatch[2] === "approve") await approveWikiLink(db, { edgeId, actor: body.actor, reason: body.reason });
    else await rejectWikiLink(db, { edgeId, actor: body.actor, reason: body.reason });
    return json("evolution-wiki-link-moderated", { edgeId, status: wikiModerateMatch[2] === "approve" ? "active" : "rejected" });
  }

  if (request.method === "GET" && url.pathname === "/api/v2/evolution/wiki/orphans") {
    return json("evolution-wiki-orphans", await findOrphanKnowledgeCards(db));
  }

  if (request.method === "GET" && url.pathname === "/api/v2/evolution/wiki/stale-links") {
    return json("evolution-wiki-stale-links", await findStaleWikiLinks(db));
  }

  const regressionAlertMatch = url.pathname.match(/^\/api\/v2\/evolution\/regression-alerts\/([^/]+)\/(acknowledge|dismiss)$/);
  if (request.method === "POST" && regressionAlertMatch) {
    const body = await readJsonBody<EvolutionCommandBody>(request);
    requireCommand(body);
    return json("evolution-regression-alert-decided", await decideRegressionAlert(db, {
      alertId: decodeURIComponent(regressionAlertMatch[1]!),
      decision: regressionAlertMatch[2] === "acknowledge" ? "acknowledged" : "dismissed",
      actor: body.actor,
      reason: body.reason,
    }));
  }

  return errorResponse("not found", 404);
}

async function readJsonBody<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function requireCommand(body: EvolutionCommandBody): asserts body is EvolutionCommandBody & { actor: string; reason: string } {
  requiredString(body.actor, "actor");
  requiredString(body.reason, "reason");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

async function updateRuntimeResourceStatus(
  db: SouthstarDb,
  resourceType: string,
  resourceKey: string,
  status: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const row = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = $1 and resource_key = $2",
    [resourceType, resourceKey],
  );
  if (!row) throw new Error(`${resourceType} not found: ${resourceKey}`);
  await db.query(
    `update southstar.runtime_resources
     set status = $3, payload_json = $4::jsonb, updated_at = now()
     where resource_type = $1 and resource_key = $2`,
    [resourceType, resourceKey, status, JSON.stringify({ ...row.payload_json, ...patch, status })],
  );
}

function sandboxTrialFromBody(experimentId: string, variant: "baseline" | "candidate", caseRef: string, body: Record<string, unknown>) {
  const metrics = isRecord(body.metrics) ? body.metrics : {};
  return {
    experimentId,
    variant,
    caseRef,
    status: (body.status === "passed" || body.status === "failed" || body.status === "cancelled" ? body.status : "failed") as "passed" | "failed" | "cancelled",
    targetedReplayFixed: body.targetedReplayFixed === true,
    metrics: {
      durationMs: numberValue(metrics.durationMs, 0),
      tokens: numberValue(metrics.tokens, 0),
      costMicrosUsd: numberValue(metrics.costMicrosUsd, 0),
      repairCount: numberValue(metrics.repairCount, 0),
      toolCalls: numberValue(metrics.toolCalls, 0),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mapNode(row: Record<string, unknown>) {
  return { id: row.id, status: row.status, payload: row.payload_jsonb };
}

function mapResource(row: Record<string, unknown>) {
  return { id: row.id, status: row.status, payload: row.payload_json };
}

function json<T>(kind: string, result: T): Response {
  return new Response(JSON.stringify({ ok: true, kind, result }), {
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

function errorResponse(error: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}
