import type { SouthstarDb } from "../stores/sqlite.ts";

export type Phase15Timings = {
  runId: string;
  serverStartMs: number;
  plannerMs: number;
  validationMs: number;
  torkSubmitMs: number;
  firstClientEventMs: number;
  uiEventVisibilityMs: number;
  modeToggleMs: number;
  apiRunGoalCompletionMs: number;
  cliRunGoalCompletionMs: number;
  browserScenarioMs: number;
  durableFolderFindings: string[];
};

export type Phase15GateResult = {
  ok: boolean;
  failures: string[];
};

type WorkflowRunRow = {
  status: string;
  workflow_manifest_json: string;
  metrics_json: string;
};

type CountRow = {
  count: number;
};

type EventCountRow = {
  event_type: string;
  count: number;
};

type ResourceRow = {
  resource_type: string;
  status: string;
};

export function assertPhase15QuantitativeGates(db: SouthstarDb, timings: Phase15Timings): Phase15GateResult {
  const failures: string[] = [];

  requireMax(failures, "runtime server start", timings.serverStartMs, 5_000);
  requireMax(failures, "planner manifest generation", timings.plannerMs, 120_000);
  requireMax(failures, "manifest validation", timings.validationMs, 2_000);
  requireMax(failures, "Tork submit latency", timings.torkSubmitMs, 10_000);
  requireMax(failures, "first client event", timings.firstClientEventMs, 10_000);
  requireMax(failures, "UI event visibility", timings.uiEventVisibilityMs, 3_000);
  requireMax(failures, "Simple/Full mode toggle", timings.modeToggleMs, 500);
  requireMax(failures, "real API run-goal completion", timings.apiRunGoalCompletionMs, 15 * 60_000);
  requireMax(failures, "real CLI run-goal completion", timings.cliRunGoalCompletionMs, 15 * 60_000);
  requireMax(failures, "real browser operations scenario", timings.browserScenarioMs, 20 * 60_000);

  if (timings.durableFolderFindings.length > 0) {
    failures.push(`durable folder findings must be empty: ${timings.durableFolderFindings.join(", ")}`);
  }

  const run = db.prepare(`
    select status, workflow_manifest_json, metrics_json
    from workflow_runs
    where id = ?
  `).get(timings.runId) as WorkflowRunRow | undefined;

  if (!run) {
    failures.push(`workflow run not found: ${timings.runId}`);
    return { ok: false, failures };
  }

  if (!["passed", "completed"].includes(run.status)) {
    failures.push(`workflow run must be passed/completed, got ${run.status}`);
  }

  const taskCount = db.prepare("select count(*) as count from workflow_tasks where run_id = ?")
    .get(timings.runId) as CountRow;
  if (taskCount.count < 4) {
    failures.push(`workflow graph size must be >= 4 tasks, got ${taskCount.count}`);
  }

  const eventCounts = new Map(
    (db.prepare(`
      select event_type, count(*) as count
      from workflow_history
      where run_id = ?
      group by event_type
    `).all(timings.runId) as EventCountRow[]).map((row) => [row.event_type, row.count]),
  );
  for (const eventType of [
    "executor.submitted",
    "progress.commentary",
    "evaluator.completed",
    "session.entry",
    "voice.command_received",
    "approval.requested",
    "approval.decided",
  ]) {
    if ((eventCounts.get(eventType) ?? 0) < 1) {
      failures.push(`workflow_history requires ${eventType}`);
    }
  }
  requireCount(failures, eventCounts, "subagent.completed", 2, "subagent/root invocation");

  const resources = db.prepare("select resource_type, status from runtime_resources where run_id = ?")
    .all(timings.runId) as ResourceRow[];
  for (const [resourceType, status] of [
    ["artifact", "accepted"],
    ["executor_binding", "queued"],
    ["skill_snapshot", "resolved"],
    ["approval", "approved"],
  ] as const) {
    if (!resources.some((resource) => resource.resource_type === resourceType && resource.status === status)) {
      failures.push(`runtime_resources requires ${status} ${resourceType}`);
    }
  }

  const metrics = parseJsonObject(run.metrics_json);
  const aggregate = parseJsonObject(metrics.aggregate);
  if (!hasFiniteNumber(aggregate, "tokens")) failures.push("metrics aggregate tokens missing");
  if (!hasFiniteNumber(aggregate, "costUsd") && !hasFiniteNumber(aggregate, "costMicrosUsd")) {
    failures.push("metrics aggregate cost missing");
  }
  if (!hasFiniteNumber(aggregate, "toolCalls")) failures.push("metrics aggregate toolCalls missing");
  if (!hasFiniteNumber(aggregate, "retryCount")) failures.push("metrics aggregate retryCount missing");

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
  if (actual < minimum) {
    failures.push(`${label} requires ${eventType} >= ${minimum}, got ${actual}`);
  }
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
