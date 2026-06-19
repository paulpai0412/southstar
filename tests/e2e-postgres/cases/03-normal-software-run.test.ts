import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { dispatchPostgresRunExecutionPg } from "../../../src/v2/executor/postgres-run-dispatcher.ts";
import { TorkClient } from "../../../src/v2/executor/tork-client.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../../src/v2/ui-api/postgres-run-api.ts";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  dockerReachableUrl,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
  waitForPostgresRunStatus,
  waitForPostgresTaskCallbacks,
  waitForTorkJob,
} from "../postgres-real-harness.ts";

// Normal software lifecycle: planner draft -> run -> materialized envelopes -> Tork/Pi execution -> callback -> accepted artifacts -> passed run.
test("03 normal software run: real Postgres/Tork/Pi completes a bounded software workflow", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  let runIdForCleanup: string | undefined;
  try {
    const draft = await createPostgresPlannerDraft(env.db, {
      goalPrompt: "normal real E2E: inspect the repository and produce implementation evidence for a bounded CLI/doc task",
    });
    const run = await createPostgresRunFromDraft(env.db, { draftId: draft.draftId });
    runIdForCleanup = run.runId;
    const callbackBase = dockerReachableUrl(server, infra);
    const torkClient = new TorkClient({ baseUrl: infra.torkBaseUrl, requestTimeoutMs: 20_000, retryCount: 2 });

    const dispatched = await dispatchPostgresRunExecutionPg(env.db, {
      runId: run.runId,
      executorProvider: new TorkExecutorProvider({ torkClient }),
      callbackUrl: `${callbackBase}/api/v2/tork/callback`,
      heartbeatUrl: `${callbackBase}/api/v2/executor/heartbeat`,
      runRoot: "/tmp/southstar-runs",
      envelopeBasePath: "/southstar-runs",
    });

    assert.equal(dispatched.taskIds.length, run.taskIds.length);
    assert.match(dispatched.externalJobId, /.+/);

    await waitForTorkJob(infra.torkBaseUrl, dispatched.externalJobId);
    await waitForPostgresTaskCallbacks(env.db, run.runId, run.taskIds);
    const finalStatus = await waitForPostgresRunStatus(env.db, run.runId, ["passed", "failed"]);
    assert.equal(finalStatus, "passed");

    const taskRows = await env.db.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order",
      [run.runId],
    );
    assert.deepEqual(taskRows.rows.map((row) => row.status), run.taskIds.map(() => "completed"));

    const artifactRows = await env.db.query<{ task_id: string | null; status: string; payload_json: Record<string, unknown> }>(
      "select task_id, status, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'artifact' order by task_id",
      [run.runId],
    );
    assert.equal(artifactRows.rows.length >= run.taskIds.length, true);
    assert.equal(artifactRows.rows.every((row) => row.status === "accepted"), true);
    assert.equal(artifactRows.rows.some((row) => Array.isArray(row.payload_json.commandsRun) || Array.isArray(row.payload_json.testResults)), true);

    const history = await env.db.query<{ event_type: string; task_id: string | null }>(
      "select event_type, task_id from southstar.workflow_history where run_id = $1 order by sequence",
      [run.runId],
    );
    assert.equal(history.rows.some((event) => event.event_type === "run.execution_submitted"), true);
    assert.equal(history.rows.some((event) => event.event_type === "executor.callback_received"), true);
    assert.equal(history.rows.some((event) => event.event_type === "run.completed"), true);

    const bindings = await env.db.query<{ status: string; payload_json: { torkJobId?: string } }>(
      "select status, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'executor_binding'",
      [run.runId],
    );
    assert.equal(bindings.rows.length, run.taskIds.length);
    assert.equal(bindings.rows.every((row) => row.status === "completed" && row.payload_json.torkJobId === dispatched.externalJobId), true);
  } finally {
    if (runIdForCleanup) await rm(join("/tmp/southstar-runs", runIdForCleanup), { recursive: true, force: true });
    await server.close();
    await env.close();
  }
});
