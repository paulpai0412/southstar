import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../../src/v2/ui-api/postgres-run-api.ts";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
} from "../postgres-real-harness.ts";

// Evolution learning lifecycle: runtime-linked learning signals synthesize Knowledge Cards,
// generate delta proposals, and expose bidirectional wiki links/read-model evidence.
test("07 evolution learning: signal -> card -> delta -> wiki lineage is persisted in Postgres", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await createPostgresPlannerDraft(env.db, {
      goalPrompt: "evolution learning real E2E: synthesize lessons from repeated artifact repair signals",
    });
    const run = await createPostgresRunFromDraft(env.db, { draftId: draft.draftId });
    const taskId = run.taskIds[0]!;

    const signalResult = await api<{ nodeIds: string[] }>(server.port, "/api/v2/evolution/signals", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "capture repeated artifact repair observations",
        signals: [
          {
            signalKind: "artifact_repair",
            runId: run.runId,
            taskId,
            scope: "software",
            intent: "implement_feature",
            roleRef: "software-maker",
            agentProfileRef: "software-maker-v1",
            artifactType: "implementation_result",
            failureKind: "missing_fields",
            missingFields: ["commandsRun", "testResults"],
            promptTemplateRef: "prompt-software-maker",
          },
          {
            signalKind: "artifact_repair",
            runId: run.runId,
            taskId,
            scope: "software",
            intent: "implement_feature",
            roleRef: "software-maker",
            agentProfileRef: "software-maker-v1",
            artifactType: "implementation_result",
            failureKind: "missing_fields",
            missingFields: ["commandsRun", "testResults"],
            promptTemplateRef: "prompt-software-maker",
          },
        ],
      }),
    });
    assert.equal(signalResult.nodeIds.length, 2);

    const cardResult = await api<{ cardIds: string[] }>(server.port, "/api/v2/evolution/cards/synthesize", {
      method: "POST",
      body: JSON.stringify({ actor: "operator", reason: "synthesize repeated repair lesson", runId: run.runId }),
    });
    assert.equal(cardResult.cardIds.length >= 1, true);
    const cardId = cardResult.cardIds[0]!;

    await api<{ assetId: string }>(server.port, "/api/v2/evolution/assets/register", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "seed prompt asset for delta target validation",
        assetKind: "prompt_template",
        assetRef: "prompt-software-maker",
        version: "active",
        payload: { sections: ["system", "task", "artifact-check"] },
      }),
    });

    const deltaResult = await api<{ deltaIds: string[] }>(server.port, "/api/v2/evolution/deltas/synthesize", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "propose prompt delta from synthesized lesson",
        sourceCardRefs: [cardId],
        targetRef: "prompt-software-maker",
        targetVersion: "active",
      }),
    });
    assert.equal(deltaResult.deltaIds.length, 1);
    const deltaId = deltaResult.deltaIds[0]!;

    const wikiLink = await api<{ edgeId: string }>(server.port, "/api/v2/evolution/wiki/links", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "connect synthesized delta with originating lesson card",
        fromNodeId: deltaId,
        toNodeId: cardId,
        relation: "related_topic",
        confidence: 0.82,
        evidenceNodeRefs: [signalResult.nodeIds[0]],
      }),
    });
    await api(server.port, `/api/v2/evolution/wiki/links/${encodeURIComponent(wikiLink.edgeId)}/approve`, {
      method: "POST",
      body: JSON.stringify({ actor: "operator", reason: "confirm lineage link" }),
    });

    const cardWiki = await api<{
      nodeId: string;
      forwardLinks: Array<{ toNodeId: string; relation: string }>;
      backlinks: Array<{ fromNodeId: string; relation: string }>;
    }>(server.port, `/api/v2/evolution/wiki/${encodeURIComponent(cardId)}`);
    assert.equal(cardWiki.nodeId, cardId);
    assert.equal(cardWiki.forwardLinks.some((link) => signalResult.nodeIds.includes(link.toNodeId) && link.relation === "supports"), true);
    assert.equal(cardWiki.backlinks.some((link) => link.fromNodeId === deltaId && link.relation === "related_topic"), true);

    const center = await api<{ data: { counts: Record<string, number> } }>(
      server.port,
      `/api/v2/read-models/evolution-control-center/${encodeURIComponent(run.runId)}`,
    );
    assert.equal((center.data.counts.signals ?? 0) >= 2, true);
    assert.equal((center.data.counts.cards ?? 0) >= 1, true);
    assert.equal((center.data.counts.deltas ?? 0) >= 1, true);

    const history = await env.db.query<{ event_type: string; task_id: string | null }>(
      "select event_type, task_id from southstar.workflow_history where run_id = $1 order by sequence",
      [run.runId],
    );
    assert.equal(history.rows.filter((row) => row.event_type === "evolution.learning_signal_recorded" && row.task_id === taskId).length, 2);

    const deltaResource = await env.db.maybeOne<{ status: string; payload_json: { sourceCardRefs?: string[]; targetRef?: string } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'delta_proposal' and resource_key = $1",
      [deltaId],
    );
    assert.equal(deltaResource?.status, "proposed");
    assert.deepEqual(deltaResource?.payload_json.sourceCardRefs, [cardId]);
    assert.equal(deltaResource?.payload_json.targetRef, "prompt-software-maker");
  } finally {
    await server.close();
    await env.close();
  }
});

async function api<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}
