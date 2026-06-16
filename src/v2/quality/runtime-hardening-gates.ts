import type { SouthstarDb } from "../stores/sqlite.ts";

export type RuntimeHardeningGateResult = {
  ok: boolean;
  failures: string[];
};

export type RuntimeAutoReconcileGateInput = {
  runId: string;
  orphanReconcileMs: number;
  activeTorkJobCountAfterScenario: number;
};

export function assertRuntimeAutoReconcileGates(
  db: SouthstarDb,
  input: RuntimeAutoReconcileGateInput,
): RuntimeHardeningGateResult {
  const failures: string[] = [];

  const heartbeatCount = count(
    db,
    "select count(*) as count from workflow_history where run_id = ? and event_type = 'executor.heartbeat'",
    input.runId,
  );
  if (heartbeatCount < 3) {
    failures.push(`expected >= 3 heartbeat events, got ${heartbeatCount}`);
  }

  const orphanedCount = count(
    db,
    "select count(*) as count from runtime_resources where run_id = ? and resource_type = 'executor_reconcile_result' and payload_json like '%\"classification\":\"orphaned\"%'",
    input.runId,
  );
  if (orphanedCount < 1) {
    failures.push("expected at least one orphaned reconcile classification");
  }

  const cancelAttemptCount = count(
    db,
    "select count(*) as count from runtime_resources where run_id = ? and resource_type = 'executor_job_command' and status in ('executed', 'failed') and payload_json like '%\"action\":\"cancel-executor\"%'",
    input.runId,
  );
  if (cancelAttemptCount < 1) {
    failures.push("expected at least one cancel-executor attempt");
  }

  const alertCommandCount = count(
    db,
    "select count(*) as count from runtime_resources where run_id = ? and resource_type = 'executor_job_command' and status = 'executed' and payload_json like '%\"action\":\"alert-operator\"%'",
    input.runId,
  );
  if (alertCommandCount < 1) {
    failures.push("expected at least one executed alert-operator command");
  }

  if (!Number.isFinite(input.orphanReconcileMs) || input.orphanReconcileMs > 30_000) {
    failures.push(`orphan reconcile latency must be <= 30000ms, got ${input.orphanReconcileMs}`);
  }

  const bypassCount = count(
    db,
    "select count(*) as count from workflow_history where run_id = ? and event_type = 'task.completed.from_executor_status'",
    input.runId,
  );
  if (bypassCount !== 0) {
    failures.push("executor status bypassed evaluator/stop-condition completion");
  }

  if (input.activeTorkJobCountAfterScenario !== 0) {
    failures.push(`expected 0 active Tork jobs after scenario, got ${input.activeTorkJobCountAfterScenario}`);
  }

  return { ok: failures.length === 0, failures };
}

export type RuntimeConcurrencyGateInput = {
  runIds: string[];
  expectedRunCount: number;
  expectedMinTaskCount: number;
  reconcileLatenciesMs: number[];
  activeTorkJobCountAfterScenario: number;
};

export function assertRuntimeConcurrencyGates(
  db: SouthstarDb,
  input: RuntimeConcurrencyGateInput,
): RuntimeHardeningGateResult {
  const failures: string[] = [];

  if (input.runIds.length !== input.expectedRunCount) {
    failures.push(`expected ${input.expectedRunCount} run ids, got ${input.runIds.length}`);
  }

  let totalTaskCount = 0;
  let totalHeartbeatCount = 0;
  let totalCommandCount = 0;
  let totalBypassCount = 0;

  for (const runId of input.runIds) {
    totalTaskCount += count(db, "select count(*) as count from workflow_tasks where run_id = ?", runId);
    totalHeartbeatCount += count(
      db,
      "select count(*) as count from workflow_history where run_id = ? and event_type = 'executor.heartbeat'",
      runId,
    );
    totalCommandCount += count(
      db,
      "select count(*) as count from runtime_resources where run_id = ? and resource_type = 'executor_job_command' and status = 'executed'",
      runId,
    );
    totalBypassCount += count(
      db,
      "select count(*) as count from workflow_history where run_id = ? and event_type = 'task.completed.from_executor_status'",
      runId,
    );
  }

  if (totalTaskCount < input.expectedMinTaskCount) {
    failures.push(`expected >= ${input.expectedMinTaskCount} tasks across runs, got ${totalTaskCount}`);
  }

  if (totalHeartbeatCount < input.expectedRunCount * 3) {
    failures.push(`expected >= ${input.expectedRunCount * 3} heartbeat events, got ${totalHeartbeatCount}`);
  }

  if (totalCommandCount < input.expectedRunCount) {
    failures.push(`expected >= ${input.expectedRunCount} executed executor commands, got ${totalCommandCount}`);
  }

  if (totalBypassCount !== 0) {
    failures.push(`executor status bypassed completion ${totalBypassCount} times`);
  }

  const reconcileP95Ms = percentile95(input.reconcileLatenciesMs);
  if (!Number.isFinite(reconcileP95Ms) || reconcileP95Ms > 30_000) {
    failures.push(`reconcile p95 must be <= 30000ms, got ${reconcileP95Ms}`);
  }

  const sqliteBusyCount = count(
    db,
    "select count(*) as count from workflow_history where payload_json like '%SQLITE_BUSY%' or payload_json like '%database is locked%'",
  );
  if (sqliteBusyCount > 0) {
    failures.push(`sqlite busy/locked evidence must be 0, got ${sqliteBusyCount}`);
  }

  if (input.activeTorkJobCountAfterScenario !== 0) {
    failures.push(`expected 0 active Tork jobs after scenario, got ${input.activeTorkJobCountAfterScenario}`);
  }

  return { ok: failures.length === 0, failures };
}

export type RuntimeSoakGateInput = {
  durationMs: number;
  requiredDurationMs: number;
  cycles: number;
  minCycles: number;
  reconcileLatenciesMs: number[];
  activeTorkJobCountAfterScenario: number;
};

export function assertRuntimeSoakGates(
  db: SouthstarDb,
  input: RuntimeSoakGateInput,
): RuntimeHardeningGateResult {
  const failures: string[] = [];

  if (!Number.isFinite(input.durationMs) || input.durationMs < input.requiredDurationMs) {
    failures.push(`soak duration must be >= ${input.requiredDurationMs}ms, got ${input.durationMs}`);
  }

  if (input.cycles < input.minCycles) {
    failures.push(`soak cycles must be >= ${input.minCycles}, got ${input.cycles}`);
  }

  const reconcileP95Ms = percentile95(input.reconcileLatenciesMs);
  if (!Number.isFinite(reconcileP95Ms) || reconcileP95Ms > 30_000) {
    failures.push(`soak reconcile p95 must be <= 30000ms, got ${reconcileP95Ms}`);
  }

  const sqliteBusyCount = count(
    db,
    "select count(*) as count from workflow_history where payload_json like '%SQLITE_BUSY%' or payload_json like '%database is locked%'",
  );
  if (sqliteBusyCount > 0) {
    failures.push(`sqlite busy/locked evidence must be 0 during soak, got ${sqliteBusyCount}`);
  }

  if (input.activeTorkJobCountAfterScenario !== 0) {
    failures.push(`expected 0 active Tork jobs after soak, got ${input.activeTorkJobCountAfterScenario}`);
  }

  return { ok: failures.length === 0, failures };
}

function percentile95(samples: number[]): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? Number.NaN;
}

function count(db: SouthstarDb, sql: string, ...args: string[]): number {
  const row = db.prepare(sql).get(...args) as { count: number };
  return row.count;
}
