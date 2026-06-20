// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import type { SouthstarDb } from "../stores/sqlite.ts";

export type ExecutorObservabilityGateInput = {
  runId: string;
  activeTorkJobCountAfterScenario: number;
};

export type ExecutorObservabilityGateResult = {
  ok: boolean;
  failures: string[];
};

export function assertExecutorObservabilityGates(
  db: SouthstarDb,
  input: ExecutorObservabilityGateInput,
): ExecutorObservabilityGateResult {
  const failures: string[] = [];

  const bindingRows = db.prepare(
    "select status, payload_json from runtime_resources where run_id = ? and resource_type = 'executor_binding'",
  ).all(input.runId) as Array<{ status: string; payload_json: string }>;
  if (bindingRows.length < 3) {
    failures.push(`expected >= 3 executor bindings, got ${bindingRows.length}`);
  }

  const heartbeatCount = count(db,
    "select count(*) as count from workflow_history where run_id = ? and event_type = 'executor.heartbeat'",
    input.runId,
  );
  if (heartbeatCount < 3) {
    failures.push(`expected >= 3 heartbeat events, got ${heartbeatCount}`);
  }

  const bindingPayloads = bindingRows.map((row) => JSON.parse(row.payload_json) as { southstarExecutorStatus?: string });
  if (bindingPayloads.filter((payload) => payload.southstarExecutorStatus === "heartbeat-lost").length < 1) {
    failures.push("expected at least one heartbeat-lost binding");
  }
  if (bindingPayloads.filter((payload) => payload.southstarExecutorStatus === "callback-missing").length < 1) {
    failures.push("expected at least one callback-missing binding");
  }

  const reconcileCount = count(db,
    "select count(*) as count from runtime_resources where run_id = ? and resource_type = 'executor_reconcile_result'",
    input.runId,
  );
  if (reconcileCount < 3) {
    failures.push(`expected >= 3 reconcile results, got ${reconcileCount}`);
  }

  const commandCount = count(db,
    "select count(*) as count from workflow_history where run_id = ? and event_type like 'executor.%'",
    input.runId,
  );
  if (commandCount < 1) {
    failures.push("expected at least one executor command/reconcile history event");
  }

  const bypassCount = count(db,
    "select count(*) as count from workflow_history where run_id = ? and event_type = 'task.completed.from_executor_status'",
    input.runId,
  );
  if (bypassCount !== 0) {
    failures.push("executor status bypassed evaluator/stop-condition completion");
  }

  if (input.activeTorkJobCountAfterScenario !== 0) {
    failures.push(`expected 0 active Tork jobs after scenario, got ${input.activeTorkJobCountAfterScenario}`);
  }

  const logRows = db.prepare(
    "select summary_json from runtime_resources where run_id = ? and resource_type = 'executor_log_ref'",
  ).all(input.runId) as Array<{ summary_json: string }>;
  for (const row of logRows) {
    if (row.summary_json.length > 4000) {
      failures.push("executor log ref summary exceeded 4000 chars");
    }
    if (/(ghp_|sk-[A-Za-z0-9]|token=|password=|secret=)/i.test(row.summary_json)) {
      failures.push("executor log ref summary contains token-shaped value");
    }
  }

  return { ok: failures.length === 0, failures };
}

function count(db: SouthstarDb, sql: string, runId: string): number {
  const row = db.prepare(sql).get(runId) as { count: number };
  return row.count;
}
