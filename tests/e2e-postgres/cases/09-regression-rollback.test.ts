import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
} from "../postgres-real-harness.ts";

// Regression lifecycle: promoted assets receive regression observations;
// low-risk regression auto-rolls back while high-risk regression raises an approval alert.
test("09 regression rollback: monitor rolls back low-risk asset and raises high-risk alert", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({ goalPrompt: "regression rollback real E2E: detect regressions and apply rollback policy" }),
    });
    const run = await api<{ runId: string }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });

    const promptV1 = await api<{ assetId: string }>(server.port, "/api/v2/evolution/assets/register", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "seed baseline prompt asset",
        assetKind: "prompt_template",
        assetRef: "prompt-software-maker",
        version: "v1",
        payload: { sections: ["baseline"] },
        status: "active",
      }),
    });
    const promptV2 = await api<{ assetId: string }>(server.port, "/api/v2/evolution/assets/register", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "seed candidate prompt asset",
        assetKind: "prompt_template",
        assetRef: "prompt-software-maker",
        version: "v2",
        parentVersion: "v1",
        payload: { sections: ["baseline", "artifact-check"] },
        status: "candidate",
      }),
    });
    await api<{ assetId: string }>(server.port, `/api/v2/evolution/assets/${encodeURIComponent(promptV2.assetId)}/promote`, {
      method: "POST",
      body: JSON.stringify({ actor: "operator", reason: "sandbox passed for prompt revision", targetStatus: "active" }),
    });

    const profileV1 = await api<{ assetId: string }>(server.port, "/api/v2/evolution/assets/register", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "seed baseline agent profile",
        assetKind: "agent_profile",
        assetRef: "software-maker-pi",
        version: "v1",
        payload: { model: "pi-agent-default" },
        status: "active",
      }),
    });
    const profileV2 = await api<{ assetId: string }>(server.port, "/api/v2/evolution/assets/register", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "seed candidate agent profile",
        assetKind: "agent_profile",
        assetRef: "software-maker-pi",
        version: "v2",
        parentVersion: "v1",
        payload: { model: "pi-agent-high-risk" },
        status: "candidate",
      }),
    });
    await api<{ assetId: string }>(server.port, `/api/v2/evolution/assets/${encodeURIComponent(profileV2.assetId)}/promote`, {
      method: "POST",
      body: JSON.stringify({ actor: "operator", reason: "approved high-risk profile rollout", targetStatus: "active" }),
    });

    await api<{ observationId: string }>(server.port, "/api/v2/evolution/regression-observations", {
      method: "POST",
      body: JSON.stringify({
        actor: "regression-monitor",
        reason: "record low-risk regression observation",
        assetId: promptV2.assetId,
        riskTier: "low",
        evaluatorFailureRateDelta: 0.22,
        repairCountDelta: 3,
        costRegressionPercent: 6,
        durationRegressionPercent: 7,
        observedRunRefs: [run.runId],
      }),
    });
    await api<{ observationId: string }>(server.port, "/api/v2/evolution/regression-observations", {
      method: "POST",
      body: JSON.stringify({
        actor: "regression-monitor",
        reason: "record high-risk regression observation",
        assetId: profileV2.assetId,
        riskTier: "high",
        evaluatorFailureRateDelta: 0.33,
        repairCountDelta: 4,
        costRegressionPercent: 18,
        durationRegressionPercent: 20,
        observedRunRefs: [run.runId],
      }),
    });

    const monitor = await api<{ rollbacks: Array<{ activeAssetId: string; rolledBackFromAssetId: string }>; alerts: Array<{ alertId: string; assetId: string }> }>(
      server.port,
      "/api/v2/evolution/regression-monitor/run",
      {
        method: "POST",
        body: JSON.stringify({ actor: "regression-monitor", reason: "scheduled real E2E regression sweep" }),
      },
    );
    assert.equal(monitor.rollbacks.length, 1);
    assert.equal(monitor.alerts.length, 1);

    const rollback = monitor.rollbacks[0];
    assert.equal(rollback?.rolledBackFromAssetId, promptV2.assetId);
    assert.equal(rollback?.activeAssetId, promptV1.assetId);

    const alert = monitor.alerts[0];
    assert.equal(alert?.assetId, profileV2.assetId);

    const assetRows = await env.db.query<{ resource_key: string; status: string }>(
      "select resource_key, status from southstar.runtime_resources where resource_type = 'asset_version' order by resource_key",
    );
    assert.equal(assetRows.rows.some((row) => row.resource_key === promptV1.assetId && row.status === "active"), true);
    assert.equal(assetRows.rows.some((row) => row.resource_key === promptV2.assetId && row.status === "rolled_back"), true);
    assert.equal(assetRows.rows.some((row) => row.resource_key === profileV2.assetId && row.status === "active"), true);

    const observationRows = await env.db.query<{ status: string; payload_json: { assetId?: string } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'asset_regression_observation' order by created_at",
    );
    assert.equal(observationRows.rows.length, 2);
    assert.equal(observationRows.rows.some((row) => row.payload_json.assetId === promptV2.assetId && row.status === "rolled_back"), true);
    assert.equal(observationRows.rows.some((row) => row.payload_json.assetId === profileV2.assetId && row.status === "alerted"), true);

    const rollbackNode = await env.db.maybeOne<{ id: string; status: string }>(
      "select id, status from southstar.learning_nodes where node_type = 'rollback' and payload_jsonb->>'assetId' = $1 order by created_at desc limit 1",
      [promptV2.assetId],
    );
    assert.equal(Boolean(rollbackNode), true);
    assert.equal(rollbackNode?.status, "completed");

    const rollbackEdges = await env.db.query<{ edge_type: string; from_node_id: string; to_node_id: string }>(
      "select edge_type, from_node_id, to_node_id from southstar.learning_edges where from_node_id = $1 or to_node_id = $1",
      [rollbackNode?.id ?? ""],
    );
    assert.equal(rollbackEdges.rows.some((row) => row.edge_type === "ROLLED_BACK_TO" && row.to_node_id === promptV1.assetId), true);
    assert.equal(rollbackEdges.rows.some((row) => row.edge_type === "HURT" && row.from_node_id === promptV2.assetId), true);

    const acknowledged = await api<{ alertId: string; status: string }>(
      server.port,
      `/api/v2/evolution/regression-alerts/${encodeURIComponent(alert?.alertId ?? "")}/acknowledge`,
      {
        method: "POST",
        body: JSON.stringify({ actor: "operator", reason: "acknowledged pending high-risk regression" }),
      },
    );
    assert.equal(acknowledged.alertId, alert?.alertId);
    assert.equal(acknowledged.status, "acknowledged");

    const alertRow = await env.db.one<{ status: string; payload_json: { decision?: string; decidedBy?: string } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'approval_alert' and resource_key = $1",
      [alert?.alertId],
    );
    assert.equal(alertRow.status, "acknowledged");
    assert.equal(alertRow.payload_json.decision, "acknowledged");
    assert.equal(alertRow.payload_json.decidedBy, "operator");

    const center = await api<{ data: { counts: Record<string, number> } }>(
      server.port,
      `/api/v2/read-models/evolution-control-center/${encodeURIComponent(run.runId)}`,
    );
    assert.equal((center.data.counts.regression ?? 0) >= 2, true);
    assert.equal((center.data.counts.assets ?? 0) >= 4, true);
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
