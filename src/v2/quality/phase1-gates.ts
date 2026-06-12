import type { SouthstarDb } from "../stores/sqlite.ts";

export type Phase1GateTimings = {
  runId: string;
  plannerMs: number;
  validationMs: number;
  torkSubmitMs: number;
  e2eMs: number;
  uiVisibilityMs: number;
};

export type Phase1GateResult = {
  ok: boolean;
  failures: string[];
};

type WorkflowRunRow = {
  id: string;
  status: string;
  workflow_manifest_json: string;
  metrics_json: string;
};

type WorkflowTaskRow = {
  id: string;
  status: string;
};

type HistoryRow = {
  event_type: string;
  payload_json: string;
};

type ResourceRow = {
  resource_type: string;
  status: string;
};

export function assertPhase1QuantitativeGates(db: SouthstarDb, timings: Phase1GateTimings): Phase1GateResult {
  const failures: string[] = [];
  const run = db.prepare(`
    select id, status, workflow_manifest_json, metrics_json
    from workflow_runs
    where id = ?
  `).get(timings.runId) as WorkflowRunRow | undefined;

  if (!run) {
    return { ok: false, failures: [`workflow run not found: ${timings.runId}`] };
  }

  requireMax(failures, "planner manifest generation", timings.plannerMs, 120_000);
  requireMax(failures, "manifest validation", timings.validationMs, 2_000);
  requireMax(failures, "Tork submit latency", timings.torkSubmitMs, 10_000);
  requireMax(failures, "real E2E completion", timings.e2eMs, 15 * 60 * 1000);
  requireMax(failures, "UI runtime visibility", timings.uiVisibilityMs, 3_000);

  if (!["passed", "completed"].includes(run.status)) {
    failures.push(`workflow run status must be passed/completed, got ${run.status}`);
  }

  const tasks = db.prepare("select id, status from workflow_tasks where run_id = ? order by sort_order")
    .all(timings.runId) as WorkflowTaskRow[];
  const manifestTaskCount = countManifestTasks(run.workflow_manifest_json);
  if (Math.max(tasks.length, manifestTaskCount) < 4) {
    failures.push(`workflow graph size must be >= 4, got tasks=${tasks.length}, manifest=${manifestTaskCount}`);
  }

  const history = db.prepare("select event_type, payload_json from workflow_history where run_id = ?")
    .all(timings.runId) as HistoryRow[];
  const eventCounts = countBy(history.map((row) => row.event_type));

  requireCount(failures, eventCounts, "subagent.completed", 2, "harness/subagent invocation");
  requireCount(failures, eventCounts, "progress.commentary", 3, "progress commentary");
  requireEvent(failures, eventCounts, "steering.received", "steering event");
  requireEvent(failures, eventCounts, "session.entry", "session durability");
  requireEvent(failures, eventCounts, "evaluator.completed", "artifact evaluator coverage");
  requireEvent(failures, eventCounts, "workflow.expanded", "dynamic DAG expansion");
  requireEvent(failures, eventCounts, "task.created", "dynamic task creation");
  requireEvent(failures, eventCounts, "memory.item_approved", "memory reuse approval");

  const repairRequests = eventCounts.get("repair.requested") ?? 0;
  if (repairRequests < 1 || repairRequests > 2) {
    failures.push(`repair loop must repair invalid artifact within 2 attempts, got ${repairRequests}`);
  }

  const resources = db.prepare("select resource_type, status from runtime_resources where run_id = ?")
    .all(timings.runId) as ResourceRow[];
  requireResource(failures, resources, "workflow_revision", "applied");
  requireResource(failures, resources, "artifact", "accepted");
  requireResource(failures, resources, "memory_item", "approved");

  const metrics = parseJsonObject(run.metrics_json);
  const aggregate = parseJsonObject(metrics.aggregate);
  if (!hasFiniteNumber(aggregate, "tokens")) failures.push("workflow_runs.metrics_json must contain aggregate tokens");
  if (!hasFiniteNumber(aggregate, "costMicrosUsd") && !hasFiniteNumber(aggregate, "costUsd")) {
    failures.push("workflow_runs.metrics_json must contain aggregate cost");
  }
  if (!hasFiniteNumber(aggregate, "toolCalls")) failures.push("workflow_runs.metrics_json must contain aggregate tool calls");
  if (!hasFiniteNumber(aggregate, "retryCount")) failures.push("workflow_runs.metrics_json must contain aggregate retry count");

  return { ok: failures.length === 0, failures };
}

function requireMax(failures: string[], label: string, actual: number, max: number): void {
  if (!Number.isFinite(actual) || actual > max) {
    failures.push(`${label} must be <= ${max}ms, got ${actual}ms`);
  }
}

function requireCount(
  failures: string[],
  counts: Map<string, number>,
  eventType: string,
  minimum: number,
  label: string,
): void {
  const actual = counts.get(eventType) ?? 0;
  if (actual < minimum) failures.push(`${label} requires ${eventType} >= ${minimum}, got ${actual}`);
}

function requireEvent(failures: string[], counts: Map<string, number>, eventType: string, label: string): void {
  if ((counts.get(eventType) ?? 0) < 1) failures.push(`${label} requires workflow_history.${eventType}`);
}

function requireResource(failures: string[], resources: ResourceRow[], resourceType: string, status: string): void {
  if (!resources.some((resource) => resource.resource_type === resourceType && resource.status === status)) {
    failures.push(`runtime_resources must contain ${status} ${resourceType}`);
  }
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function countManifestTasks(workflowManifestJson: string): number {
  const manifest = parseJsonObject(workflowManifestJson);
  return Array.isArray(manifest.tasks) ? manifest.tasks.length : 0;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasFiniteNumber(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "number" && Number.isFinite(record[key]);
}
