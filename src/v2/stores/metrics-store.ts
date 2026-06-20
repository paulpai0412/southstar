// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import type { SouthstarDb } from "./sqlite.ts";

export type ManagementMetrics = {
  tokens: number;
  costMicrosUsd: number;
  costUsd: number;
  toolCalls: number;
  retryCount: number;
  durationMs: number;
};

export type RunManagementMetrics = {
  aggregate: ManagementMetrics;
  byTask: Record<string, { aggregate: ManagementMetrics; resourceCount: number }>;
  resourceCount: number;
};

const emptyMetrics: ManagementMetrics = {
  tokens: 0,
  costMicrosUsd: 0,
  costUsd: 0,
  toolCalls: 0,
  retryCount: 0,
  durationMs: 0,
};

export function recomputeManagementMetrics(db: SouthstarDb, runId: string): RunManagementMetrics {
  const rows = db.prepare(`
    select id, task_id, metrics_json from runtime_resources
    where run_id = ?
  `).all(runId) as Array<{ id: string; task_id: string | null; metrics_json: string }>;

  const aggregate = emptyAggregate();
  const byTask: Record<string, { aggregate: ManagementMetrics; resourceCount: number }> = {};
  for (const row of rows) {
    const metrics = normalizeMetrics(JSON.parse(row.metrics_json));
    addMetrics(aggregate, metrics);
    if (row.task_id) {
      byTask[row.task_id] ??= { aggregate: emptyAggregate(), resourceCount: 0 };
      byTask[row.task_id].resourceCount += 1;
      addMetrics(byTask[row.task_id].aggregate, metrics);
    }
  }
  finalizeCost(aggregate);
  for (const taskMetrics of Object.values(byTask)) finalizeCost(taskMetrics.aggregate);

  const result: RunManagementMetrics = { aggregate, byTask, resourceCount: rows.length };
  const now = new Date().toISOString();
  for (const [taskId, metrics] of Object.entries(byTask)) {
    db.prepare("update workflow_tasks set metrics_json = ?, updated_at = ? where run_id = ? and id = ?")
      .run(JSON.stringify(metrics), now, runId, taskId);
  }
  db.prepare("update workflow_runs set metrics_json = ?, updated_at = ? where id = ?")
    .run(JSON.stringify(result), now, runId);
  return result;
}

function emptyAggregate(): ManagementMetrics {
  return { ...emptyMetrics };
}

function normalizeMetrics(value: unknown): ManagementMetrics {
  const record = isRecord(value) ? value : {};
  const costMicrosUsd = numberValue(record.costMicrosUsd);
  return {
    tokens: numberValue(record.tokens),
    costMicrosUsd,
    costUsd: costMicrosUsd / 1_000_000,
    toolCalls: numberValue(record.toolCalls),
    retryCount: numberValue(record.retryCount),
    durationMs: numberValue(record.durationMs),
  };
}

function addMetrics(target: ManagementMetrics, next: ManagementMetrics): void {
  target.tokens += next.tokens;
  target.costMicrosUsd += next.costMicrosUsd;
  target.toolCalls += next.toolCalls;
  target.retryCount += next.retryCount;
  target.durationMs += next.durationMs;
}

function finalizeCost(metrics: ManagementMetrics): void {
  metrics.costUsd = metrics.costMicrosUsd / 1_000_000;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
