import type { SouthstarDb } from "../stores/sqlite.ts";
import { assertDomainPackDynamicQuantitativeGates } from "./domain-pack-dynamic-gates.ts";

export type UiControlPlaneGateInput = {
  runId: string;
  plannerMs: number;
  validationMs: number;
  torkSubmitMs: number;
  browserRunCompletionMs: number;
  firstWorkflowVisibleMs: number;
  taskDetailVisibleMs: number;
  stopConditionVisibleMs: number;
};

export type UiControlPlaneGateResult = {
  ok: boolean;
  failures: string[];
};

export function assertUiControlPlaneQuantitativeGates(
  db: SouthstarDb,
  input: UiControlPlaneGateInput,
): UiControlPlaneGateResult {
  const failures = assertDomainPackDynamicQuantitativeGates(db, {
    runId: input.runId,
    plannerMs: input.plannerMs,
    validationMs: input.validationMs,
    torkSubmitMs: input.torkSubmitMs,
    e2eMs: input.browserRunCompletionMs,
  }).failures;

  requireMax(failures, "firstWorkflowVisibleMs", input.firstWorkflowVisibleMs, 120_000);
  requireMax(failures, "taskDetailVisibleMs", input.taskDetailVisibleMs, 120_000);
  requireMax(failures, "stopConditionVisibleMs", input.stopConditionVisibleMs, 20 * 60_000);

  const run = db.prepare("select status from workflow_runs where id = ?").get(input.runId) as { status: string } | undefined;
  if (!run || !["passed", "completed"].includes(run.status)) {
    failures.push(`UI-triggered run must be passed/completed, got ${run?.status ?? "missing"}`);
  }

  const executor = db.prepare(`
    select payload_json
    from runtime_resources
    where run_id = ? and resource_type = 'executor_binding'
    limit 1
  `).get(input.runId) as { payload_json: string } | undefined;
  if (!executor) {
    failures.push("missing executor_binding for UI-triggered run");
  } else {
    const payload = JSON.parse(executor.payload_json) as { executorType?: string; externalJobId?: string };
    if (payload.executorType !== "tork") failures.push(`executor binding must be tork, got ${payload.executorType ?? "missing"}`);
    if (!payload.externalJobId) failures.push("executor binding must include externalJobId");
  }

  const stop = db.prepare(`
    select status
    from runtime_resources
    where run_id = ? and resource_type = 'stop_condition_result'
    order by created_at desc
    limit 1
  `).get(input.runId) as { status: string } | undefined;
  if (stop?.status !== "passed") failures.push(`UI stop condition must be passed, got ${stop?.status ?? "missing"}`);

  return { ok: failures.length === 0, failures };
}

function requireMax(failures: string[], label: string, actual: number, max: number): void {
  if (!Number.isFinite(actual) || actual > max) failures.push(`${label} ${actual} > ${max}`);
}
