import test from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { startRunSchedulingPg } from "../../src/v2/server/run-execution-controller.ts";
import { createWorkflowRunPg, listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("startRunSchedulingPg moves a created run to scheduling without executor side effects", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, { id: "run-thin-execute-created", status: "created" });

    const result = await startRunSchedulingPg(db, { runId: "run-thin-execute-created" });

    assert.deepEqual(result, {
      runId: "run-thin-execute-created",
      status: "scheduling",
      schedulerWakeRequested: true,
    });
    const run = await db.one<{
      status: string;
      executor_job_id: string | null;
      execution_projection_json: Record<string, unknown>;
    }>(
      "select status, executor_job_id, execution_projection_json from southstar.workflow_runs where id = $1",
      ["run-thin-execute-created"],
    );
    assert.equal(run.status, "scheduling");
    assert.equal(run.executor_job_id, null);
    assert.deepEqual(run.execution_projection_json, {});
    assert.equal((await listResourcesPg(db, { resourceType: "executor_binding" })).filter((resource) => resource.runId === "run-thin-execute-created").length, 0);
    assert.equal((await listResourcesPg(db, { resourceType: "brain_binding" })).filter((resource) => resource.runId === "run-thin-execute-created").length, 0);
    assert.equal((await listResourcesPg(db, { resourceType: "hand_binding" })).filter((resource) => resource.runId === "run-thin-execute-created").length, 0);
    const events = await listHistoryForRunPg(db, "run-thin-execute-created");
    assert.deepEqual(events.filter((event) => event.eventType === "run.scheduling_started").map((event) => event.actorType), ["orchestrator"]);
  } finally {
    await db.close();
  }
});

test("startRunSchedulingPg is idempotent for an already scheduling run", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, { id: "run-thin-execute-idempotent", status: "scheduling" });

    const first = await startRunSchedulingPg(db, { runId: "run-thin-execute-idempotent" });
    const second = await startRunSchedulingPg(db, { runId: "run-thin-execute-idempotent" });

    assert.deepEqual(first, second);
    assert.deepEqual(second, {
      runId: "run-thin-execute-idempotent",
      status: "scheduling",
      schedulerWakeRequested: true,
    });
    const events = await listHistoryForRunPg(db, "run-thin-execute-idempotent");
    assert.equal(events.filter((event) => event.eventType === "run.scheduling_started").length, 1);
  } finally {
    await db.close();
  }
});

test("startRunSchedulingPg rejects missing runs and invalid source statuses", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, { id: "run-thin-execute-running", status: "running" });
    await seedRun(db, { id: "run-thin-execute-passed", status: "passed" });

    await assert.rejects(
      () => startRunSchedulingPg(db, { runId: "run-thin-execute-missing" }),
      /run not found: run-thin-execute-missing/,
    );
    await assert.rejects(
      () => startRunSchedulingPg(db, { runId: "run-thin-execute-running" }),
      /run cannot start scheduling from status running/,
    );
    await assert.rejects(
      () => startRunSchedulingPg(db, { runId: "run-thin-execute-passed" }),
      /run cannot start scheduling from status passed/,
    );
  } finally {
    await db.close();
  }
});

test("POST /api/v2/runs/:runId/execute starts scheduling without callbackUrl or executor submission", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, { id: "run-thin-execute-route", status: "created" });
    const response = await handleRuntimeRoute({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: {
        executorType: "tork",
        submit: async () => { throw new Error("executor submit must not be called"); },
      },
    }, new Request("http://127.0.0.1/api/v2/runs/run-thin-execute-route/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));

    assert.equal(response.status, 200);
    const body = await response.json() as {
      ok: true;
      kind: string;
      result: { runId: string; status: string; schedulerWakeRequested: boolean };
    };
    assert.equal(body.kind, "run-execute");
    assert.deepEqual(body.result, {
      runId: "run-thin-execute-route",
      status: "scheduling",
      schedulerWakeRequested: true,
    });
    const run = await db.one<{ status: string; executor_job_id: string | null }>(
      "select status, executor_job_id from southstar.workflow_runs where id = $1",
      ["run-thin-execute-route"],
    );
    assert.equal(run.status, "scheduling");
    assert.equal(run.executor_job_id, null);
  } finally {
    await db.close();
  }
});

async function seedRun(db: Awaited<ReturnType<typeof createTestPostgresDb>>, input: { id: string; status: string }): Promise<void> {
  await createWorkflowRunPg(db, {
    id: input.id,
    status: input.status,
    domain: "software",
    goalPrompt: "ship managed runtime contracts",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
}
