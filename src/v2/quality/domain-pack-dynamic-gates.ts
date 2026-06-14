import type { SouthstarDb } from "../stores/sqlite.ts";

export type DomainPackDynamicGateInput = {
  runId: string;
  plannerMs: number;
  validationMs: number;
  torkSubmitMs: number;
  e2eMs: number;
};

export type DomainPackDynamicGateResult = {
  ok: boolean;
  failures: string[];
};

type CountRow = { count: number };
type RunRow = { status: string; metrics_json?: string };
type ResourceCountRow = { resource_type: string; count: number };

export function assertDomainPackDynamicQuantitativeGates(
  db: SouthstarDb,
  input: DomainPackDynamicGateInput,
): DomainPackDynamicGateResult {
  const failures: string[] = [];
  requireMax(failures, "plannerMs", input.plannerMs, 60_000);
  requireMax(failures, "validationMs", input.validationMs, 5_000);
  requireMax(failures, "torkSubmitMs", input.torkSubmitMs, 20_000);
  requireMax(failures, "e2eMs", input.e2eMs, 20 * 60_000);

  const run = db.prepare("select status, metrics_json from workflow_runs where id = ?").get(input.runId) as RunRow | undefined;
  if (!run) {
    failures.push(`workflow run not found: ${input.runId}`);
    return { ok: false, failures };
  }
  if (!["passed", "completed"].includes(run.status)) {
    failures.push(`workflow run must be passed/completed, got ${run.status}`);
  }

  const taskCount = countWorkflowTasks(db, input.runId);
  if (taskCount < 5) failures.push(`dynamic workflow task count must be >= 5, got ${taskCount}`);
  requireHistoryCount(failures, db, input.runId, "subagent.completed", taskCount);
  requireHistoryCount(failures, db, input.runId, "evaluator.completed", taskCount);
  requireHistoryCount(failures, db, input.runId, "progress.commentary", taskCount);
  requireRunMetrics(failures, run.metrics_json);
  requireTaskMetrics(failures, db, input.runId, taskCount);

  const counts = resourceCounts(db, input.runId);
  requireResource(failures, counts, "workflow_generation_plan", 1);
  requireResource(failures, counts, "orchestration_snapshot", 1);
  requireResource(failures, counts, "context_packet", taskCount);
  requireResource(failures, counts, "memory_injection_trace", taskCount);
  requireResource(failures, counts, "session_node", taskCount);
  requireResource(failures, counts, "session_checkpoint", taskCount);
  requireResource(failures, counts, "workspace_snapshot", 1);
  requireResource(failures, counts, "evaluator_pipeline_result", 1);
  requireResource(failures, counts, "stop_condition_result", 1);
  if (hasFailedEvaluatorPipeline(db, input.runId)) {
    requireResource(failures, counts, "recovery_decision", 1);
  }

  const stop = db.prepare(`
    select status
    from runtime_resources
    where run_id = ? and resource_type = 'stop_condition_result'
    order by created_at desc
    limit 1
  `).get(input.runId) as { status: string } | undefined;
  if (stop?.status !== "passed") failures.push(`latest stop_condition_result must be passed, got ${stop?.status ?? "missing"}`);

  return { ok: failures.length === 0, failures };
}

function requireMax(failures: string[], label: string, actual: number, max: number): void {
  if (!Number.isFinite(actual) || actual > max) failures.push(`${label} ${actual} > ${max}`);
}

function requireResource(
  failures: string[],
  counts: Record<string, number>,
  resourceType: string,
  minimum: number,
): void {
  const actual = counts[resourceType] ?? 0;
  if (actual < minimum) failures.push(`expected at least ${minimum} ${resourceType}, got ${actual}`);
}

function requireHistoryCount(
  failures: string[],
  db: SouthstarDb,
  runId: string,
  eventType: string,
  minimum: number,
): void {
  const row = db.prepare("select count(*) as count from workflow_history where run_id = ? and event_type = ?")
    .get(runId, eventType) as CountRow;
  if (row.count < minimum) failures.push(`expected at least ${minimum} ${eventType}, got ${row.count}`);
}

function requireRunMetrics(failures: string[], metricsJson: string | undefined): void {
  const metrics = parseRecord(metricsJson);
  const aggregate = recordValue(metrics.aggregate);
  if (numberValue(aggregate.tokens) <= 0) failures.push("run aggregate tokens must be > 0");
  if (numberValue(aggregate.durationMs) <= 0) failures.push("run aggregate durationMs must be > 0");
  if (!Number.isFinite(numberValue(aggregate.costMicrosUsd))) failures.push("run aggregate costMicrosUsd must be numeric");
  if (!Number.isFinite(numberValue(aggregate.toolCalls))) failures.push("run aggregate toolCalls must be numeric");
  if (!Number.isFinite(numberValue(aggregate.retryCount))) failures.push("run aggregate retryCount must be numeric");
  if (numberValue(metrics.resourceCount) <= 0) failures.push("run resourceCount must be > 0");
}

function requireTaskMetrics(failures: string[], db: SouthstarDb, runId: string, taskCount: number): void {
  const rows = db.prepare("select id, metrics_json from workflow_tasks where run_id = ?").all(runId) as Array<{ id: string; metrics_json: string }>;
  const withAggregate = rows.filter((row) => {
    const metrics = parseRecord(row.metrics_json);
    const aggregate = recordValue(metrics.aggregate);
    return numberValue(aggregate.tokens) > 0 && numberValue(aggregate.durationMs) > 0;
  });
  if (withAggregate.length < taskCount) {
    failures.push(`task metrics aggregate tokens/duration must exist for ${taskCount} tasks, got ${withAggregate.length}`);
  }
}

function countWorkflowTasks(db: SouthstarDb, runId: string): number {
  const row = db.prepare("select count(*) as count from workflow_tasks where run_id = ?").get(runId) as CountRow;
  return row.count;
}

function resourceCounts(db: SouthstarDb, runId: string): Record<string, number> {
  const rows = db.prepare(`
    select resource_type, count(*) as count
    from runtime_resources
    where run_id = ?
    group by resource_type
  `).all(runId) as ResourceCountRow[];
  return Object.fromEntries(rows.map((row) => [row.resource_type, row.count]));
}

function hasFailedEvaluatorPipeline(db: SouthstarDb, runId: string): boolean {
  const row = db.prepare(`
    select 1
    from runtime_resources
    where run_id = ? and resource_type = 'evaluator_pipeline_result' and status = 'failed'
    limit 1
  `).get(runId);
  return Boolean(row);
}

function parseRecord(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return recordValue(parsed);
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
