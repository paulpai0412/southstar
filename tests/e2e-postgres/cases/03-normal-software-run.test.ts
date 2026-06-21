import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
} from "../postgres-real-harness.ts";

// Task 6 contract: /execute starts managed runtime scheduling. Task 7/8 will add per-task hand execution completion coverage.
test("03 normal software run: /execute schedules a bounded software workflow for managed runtime", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({ goalPrompt: "normal real E2E: inspect the repository and produce implementation evidence for a bounded CLI/doc task" }),
    });
    const run = await api<{ runId: string; taskIds: string[] }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });

    const scheduled = await api<{ runId: string; status: "scheduling"; schedulerWakeRequested: true }>(
      server.port,
      `/api/v2/runs/${encodeURIComponent(run.runId)}/execute`,
      {
        method: "POST",
        body: "{}",
      },
    );

    assert.deepEqual(scheduled, {
      runId: run.runId,
      status: "scheduling",
      schedulerWakeRequested: true,
    });

    const runRow = await env.db.one<{ status: string; executor_job_id: string | null }>(
      "select status, executor_job_id from southstar.workflow_runs where id = $1",
      [run.runId],
    );
    assert.equal(runRow.status, "scheduling");
    assert.equal(runRow.executor_job_id, null);

    const history = await env.db.query<{ event_type: string; task_id: string | null }>(
      "select event_type, task_id from southstar.workflow_history where run_id = $1 order by sequence",
      [run.runId],
    );
    assert.equal(history.rows.some((event) => event.event_type === "run.scheduling_started"), true);
    assert.equal(history.rows.some((event) => event.event_type === "run.execution_submitted"), false);
    assert.equal(history.rows.some((event) => event.event_type === "executor.callback_received"), false);

    const bindings = await env.db.query<{ status: string }>(
      "select status, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'executor_binding'",
      [run.runId],
    );
    assert.equal(bindings.rows.length, 0);
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
