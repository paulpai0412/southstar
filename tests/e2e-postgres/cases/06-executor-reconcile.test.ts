import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
} from "../postgres-real-harness.ts";

// Executor reconcile lifecycle: drifted/lost executor bindings are classified via real Tork observation
// and recorded as findings/actions without mutating run/task lifecycle state.
test("06 executor reconcile: lost binding produces reconcile finding and operator actions", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({ goalPrompt: "executor reconcile real E2E: classify lost executor binding and record actions" }),
    });
    const run = await api<{ runId: string; taskIds: string[] }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });
    const taskId = run.taskIds[0]!;
    const binding = await api<{ id: string }>(server.port, "/api/v2/executor/bindings", {
      method: "POST",
      body: JSON.stringify({
        runId: run.runId,
        taskId,
        attemptId: "attempt-1",
        torkJobId: `missing-job-${Date.now().toString(36)}`,
        status: "running",
        queueTimeoutSeconds: 120,
        hardTimeoutSeconds: 900,
      }),
    });

    const reconcile = await api<{ findings: Array<{ bindingId: string; runId: string; taskId: string; classification: string; actions: string[] }> }>(
      server.port,
      "/api/v2/executor/reconcile",
      { method: "POST", body: JSON.stringify({}) },
    );

    const finding = reconcile.findings.find((entry) => entry.bindingId === binding.id);
    assert.ok(finding, `expected finding for ${binding.id}`);
    assert.equal(finding?.classification, "lost");
    assert.equal(finding?.runId, run.runId);
    assert.equal(finding?.taskId, taskId);
    assert.deepEqual(new Set(finding?.actions ?? []), new Set(["retry-attempt", "alert-operator"]));

    const updatedBinding = await env.db.one<{ status: string; payload_json: { reconcileGeneration?: number } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'executor_binding' and resource_key = $1",
      [binding.id],
    );
    assert.equal(updatedBinding.status, "lost");
    assert.equal(updatedBinding.payload_json.reconcileGeneration, 1);

    const runRow = await env.db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [run.runId]);
    const taskRow = await env.db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [run.runId, taskId],
    );
    assert.equal(runRow.status, "created");
    assert.equal(taskRow.status, "pending");

    const reconcileResource = await env.db.maybeOne<{ status: string; payload_json: { classification?: string; actions?: string[] } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'executor_reconcile_result' and run_id = $1 and task_id = $2 order by created_at desc limit 1",
      [run.runId, taskId],
    );
    assert.equal(reconcileResource?.status, "lost");
    assert.equal(reconcileResource?.payload_json.classification, "lost");
    assert.deepEqual(new Set(reconcileResource?.payload_json.actions ?? []), new Set(["retry-attempt", "alert-operator"]));

    const actionRows = await env.db.query<{ resource_key: string; status: string; payload_json: { action?: string } }>(
      "select resource_key, status, payload_json from southstar.runtime_resources where resource_type = 'executor_job_command' and run_id = $1 and task_id = $2",
      [run.runId, taskId],
    );
    assert.equal(actionRows.rows.length, 2);
    assert.equal(actionRows.rows.every((row) => row.status === "executed"), true);
    assert.deepEqual(new Set(actionRows.rows.map((row) => row.payload_json.action)), new Set(["retry-attempt", "alert-operator"]));

    const history = await env.db.query<{ event_type: string }>(
      "select event_type from southstar.workflow_history where run_id = $1 and task_id = $2 order by sequence",
      [run.runId, taskId],
    );
    assert.equal(history.rows.some((row) => row.event_type === "executor.lost"), true);
    assert.equal(history.rows.some((row) => row.event_type === "executor.reconcile_completed"), true);
    assert.equal(history.rows.filter((row) => row.event_type === "executor.action_dispatched").length, 2);
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
