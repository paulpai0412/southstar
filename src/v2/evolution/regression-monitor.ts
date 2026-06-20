import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { createLearningEdge, createLearningNode } from "./learning-graph.ts";
import { rollbackAssetVersion } from "./assets.ts";

export type AssetRegressionObservationInput = {
  assetId: string;
  riskTier: "low" | "medium" | "high";
  evaluatorFailureRateDelta: number;
  repairCountDelta: number;
  costRegressionPercent: number;
  durationRegressionPercent: number;
  observedRunRefs: string[];
};

export type RegressionMonitorResult = {
  rollbacks: Array<{ activeAssetId: string; rolledBackFromAssetId: string }>;
  alerts: Array<{ alertId: string; assetId: string }>;
};

export async function recordAssetRegressionObservation(db: SouthstarDb, input: AssetRegressionObservationInput): Promise<{ observationId: string }> {
  const asset = await db.maybeOne("select 1 from southstar.runtime_resources where resource_type = 'asset_version' and resource_key = $1", [input.assetId]);
  if (!asset) throw new Error(`asset version not found: ${input.assetId}`);
  const observationId = `regression-${randomUUID()}`;
  const payload = { id: observationId, status: "recorded", ...input };
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values ($1, 'asset_regression_observation', $1, 'evolution', 'recorded', $2, $3::jsonb, $4::jsonb, '{}'::jsonb, now(), now())`,
    [observationId, `Regression observation for ${input.assetId}`, JSON.stringify(payload), JSON.stringify({ assetId: input.assetId, riskTier: input.riskTier })],
  );
  await createLearningNode(db, {
    id: observationId,
    nodeType: "learning_signal",
    scope: "evolution",
    status: "recorded",
    resourceRef: observationId,
    payload,
    summaryText: `Regression observation for ${input.assetId}`,
  });
  await createLearningEdge(db, {
    fromNodeId: input.assetId,
    edgeType: "HURT",
    toNodeId: observationId,
    evidence: { reason: "post-promotion regression observation", observedRunRefs: input.observedRunRefs },
  });
  return { observationId };
}

export async function decideRegressionAlert(db: SouthstarDb, input: { alertId: string; decision: "acknowledged" | "dismissed"; actor: string; reason: string }): Promise<{ alertId: string; status: "acknowledged" | "dismissed" }> {
  const row = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'approval_alert' and resource_key = $1",
    [input.alertId],
  );
  if (!row) throw new Error(`regression alert not found: ${input.alertId}`);
  const payload = { ...row.payload_json, decision: input.decision, decidedBy: input.actor, decisionReason: input.reason };
  await db.query(
    `update southstar.runtime_resources
     set status = $2, payload_json = $3::jsonb, updated_at = now()
     where resource_type = 'approval_alert' and resource_key = $1`,
    [input.alertId, input.decision, JSON.stringify(payload)],
  );
  return { alertId: input.alertId, status: input.decision };
}

export async function runRegressionMonitor(db: SouthstarDb, input: { actor: string; reason: string }): Promise<RegressionMonitorResult> {
  const rows = await db.query<{ resource_key: string; payload_json: AssetRegressionObservationInput & { id: string } }>(
    "select resource_key, payload_json from southstar.runtime_resources where resource_type = 'asset_regression_observation' and status = 'recorded' order by created_at, resource_key",
  );
  const result: RegressionMonitorResult = { rollbacks: [], alerts: [] };
  for (const row of rows.rows) {
    const observation = row.payload_json;
    if (!isRegressed(observation)) {
      await markObservation(db, row.resource_key, "ignored", { monitorReason: "within thresholds" });
      continue;
    }
    if (observation.riskTier === "low") {
      const rollback = await rollbackAssetVersion(db, {
        assetId: observation.assetId,
        actor: input.actor,
        reason: `${input.reason}: regression observation ${row.resource_key}`,
      });
      result.rollbacks.push(rollback);
      await markObservation(db, row.resource_key, "rolled_back", { rollback });
      continue;
    }
    const alert = await createApprovalAlert(db, observation, input);
    result.alerts.push(alert);
    await markObservation(db, row.resource_key, "alerted", { alertId: alert.alertId });
  }
  return result;
}

function isRegressed(input: AssetRegressionObservationInput): boolean {
  return input.evaluatorFailureRateDelta > 0.1
    || input.repairCountDelta > 1
    || input.costRegressionPercent > 10
    || input.durationRegressionPercent > 15;
}

async function createApprovalAlert(
  db: SouthstarDb,
  observation: AssetRegressionObservationInput & { id: string },
  input: { actor: string; reason: string },
): Promise<{ alertId: string; assetId: string }> {
  const alertId = `approval-alert-${randomUUID()}`;
  const payload = {
    alertId,
    assetId: observation.assetId,
    actionType: "regression_review",
    riskTier: observation.riskTier,
    observationId: observation.id,
    actor: input.actor,
    reason: input.reason,
  };
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values ($1, 'approval_alert', $1, 'evolution', 'pending', $2, $3::jsonb, $4::jsonb, '{}'::jsonb, now(), now())`,
    [alertId, `Regression review for ${observation.assetId}`, JSON.stringify(payload), JSON.stringify({ assetId: observation.assetId, riskTier: observation.riskTier })],
  );
  return { alertId, assetId: observation.assetId };
}

async function markObservation(db: SouthstarDb, observationId: string, status: string, patch: Record<string, unknown>): Promise<void> {
  const row = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'asset_regression_observation' and resource_key = $1",
    [observationId],
  );
  if (!row) return;
  await db.query(
    `update southstar.runtime_resources
     set status = $2, payload_json = $3::jsonb, updated_at = now()
     where resource_type = 'asset_regression_observation' and resource_key = $1`,
    [observationId, status, JSON.stringify({ ...row.payload_json, ...patch, status })],
  );
  await db.query(
    "update southstar.learning_nodes set status = $2, updated_at = now() where id = $1",
    [observationId, status],
  );
}
