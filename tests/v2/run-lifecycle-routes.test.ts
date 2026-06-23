import test from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb, type TestPostgresDb } from "./postgres-test-utils.ts";

test("run lifecycle routes pause, resume, cancel, and replay commands idempotently", async () => {
  const db = await createTestPostgresDb();
  let submitCalls = 0;
  try {
    await seedLifecycleRun(db, { runId: "run-lifecycle-api", status: "running" });
    await seedActiveExecutionResources(db, "run-lifecycle-api");
    const context = {
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: {
        executorType: "tork" as const,
        submit: async () => {
          submitCalls += 1;
          throw new Error("executor submit must not be called");
        },
      },
    };

    const actions = await readOk<{ actions: Array<{ action: string; allowed: boolean }> }>(
      await handleRuntimeRoute(context, request("GET", "/api/v2/runs/run-lifecycle-api/actions")),
    );
    assert.equal(actions.result.actions.some((action) => action.action === "pause" && action.allowed), true);

    const pause = await readOk<{ commandId: string; status: string }>(
      await handleRuntimeRoute(context, request("POST", "/api/v2/runs/run-lifecycle-api/pause", commandBody("cmd-run-pause"))),
    );
    assert.equal(pause.result.status, "applied");
    assert.equal(await runStatus(db, "run-lifecycle-api"), "paused");

    const replayPause = await readOk<{ commandId: string; status: string }>(
      await handleRuntimeRoute(context, request("POST", "/api/v2/runs/run-lifecycle-api/pause", commandBody("cmd-run-pause"))),
    );
    assert.deepEqual(replayPause.result, pause.result);
    assert.equal(await runStatus(db, "run-lifecycle-api"), "paused");
    const afterPauseReplayHistoryTypes = (await listHistoryForRunPg(db, "run-lifecycle-api")).map((event) => event.eventType);
    assert.equal(count(afterPauseReplayHistoryTypes, "run.command_requested"), 1);
    assert.equal(count(afterPauseReplayHistoryTypes, "run.paused"), 1);

    const resume = await readOk<{ commandId: string; status: string }>(
      await handleRuntimeRoute(context, request("POST", "/api/v2/runs/run-lifecycle-api/resume", commandBody("cmd-run-resume"))),
    );
    assert.equal(resume.result.status, "applied");
    assert.equal(await runStatus(db, "run-lifecycle-api"), "scheduling");

    const cancel = await readOk<{ commandId: string; status: string; eventRefs: Array<{ eventType: string }> }>(
      await handleRuntimeRoute(context, request("POST", "/api/v2/runs/run-lifecycle-api/cancel", {
        ...commandBody("cmd-run-cancel"),
        payload: { cancelActiveJobs: true },
      })),
    );
    assert.equal(cancel.result.status, "applied");
    assert.deepEqual(cancel.result.eventRefs.map((event) => event.eventType), [
      "run.command_requested",
      "run.cancel_requested",
      "run.cancelled",
    ]);
    assert.equal(await runStatus(db, "run-lifecycle-api"), "cancelled");

    const replayCancel = await readOk<{ commandId: string; status: string; eventRefs: Array<{ eventType: string }> }>(
      await handleRuntimeRoute(context, request("POST", "/api/v2/runs/run-lifecycle-api/cancel", {
        ...commandBody("cmd-run-cancel"),
        payload: { cancelActiveJobs: true },
      })),
    );
    assert.deepEqual(replayCancel.result, cancel.result);

    const commands = (await listResourcesPg(db, { resourceType: "runtime_command" }))
      .filter((resource) => resource.runId === "run-lifecycle-api")
      .map((resource) => resource.resourceKey)
      .sort();
    assert.deepEqual(commands, ["cmd-run-cancel", "cmd-run-pause", "cmd-run-resume"]);

    const historyTypes = (await listHistoryForRunPg(db, "run-lifecycle-api")).map((event) => event.eventType);
    assert.equal(count(historyTypes, "run.command_requested"), 3);
    assert.equal(count(historyTypes, "run.paused"), 1);
    assert.equal(count(historyTypes, "run.resumed"), 1);
    assert.equal(count(historyTypes, "run.cancel_requested"), 1);
    assert.equal(count(historyTypes, "run.cancelled"), 1);

    const activeResources = (await listResourcesPg(db, { resourceType: "hand_execution" }))
      .concat(await listResourcesPg(db, { resourceType: "executor_binding" }))
      .filter((resource) => resource.runId === "run-lifecycle-api");
    assert.deepEqual(activeResources.map((resource) => resource.status).sort(), ["cancel_requested", "cancel_requested"]);
    for (const resource of activeResources) {
      assert.equal(asRecord(resource.payload).status, "cancel_requested");
      assert.equal(asRecord(resource.summary).status, "cancel_requested");
      if (resource.resourceType === "executor_binding") {
        assert.equal(asRecord(resource.payload).southstarExecutorStatus, "cancel_requested");
      }
    }
    assert.equal(submitCalls, 0);
  } finally {
    await db.close();
  }
});

test("run lifecycle pause with cancelActiveJobs marks active execution resources cancel_requested", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedLifecycleRun(db, { runId: "run-lifecycle-pause-cancel-active", status: "running" });
    await seedActiveExecutionResources(db, "run-lifecycle-pause-cancel-active");
    const context = {
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };

    const pause = await readOk<{ commandId: string; status: string; resourceRefs: Array<{ resourceType: string; resourceKey: string }> }>(
      await handleRuntimeRoute(context, request("POST", "/api/v2/runs/run-lifecycle-pause-cancel-active/pause", {
        ...commandBody("cmd-run-pause-cancel-active"),
        payload: { cancelActiveJobs: true },
      })),
    );

    assert.equal(pause.result.status, "applied");
    assert.equal(await runStatus(db, "run-lifecycle-pause-cancel-active"), "paused");
    assert.deepEqual(pause.result.resourceRefs.map((ref) => ref.resourceType).sort(), [
      "executor_binding",
      "hand_execution",
      "workflow_run",
    ]);
    const resources = (await listResourcesPg(db, { resourceType: "hand_execution" }))
      .concat(await listResourcesPg(db, { resourceType: "executor_binding" }))
      .filter((resource) => resource.runId === "run-lifecycle-pause-cancel-active")
      .sort((left, right) => left.resourceType.localeCompare(right.resourceType));
    assert.equal(resources.length, 2);
    for (const resource of resources) {
      assert.equal(resource.status, "cancel_requested");
      assert.equal(asRecord(resource.payload).status, "cancel_requested");
      assert.equal(asRecord(resource.summary).status, "cancel_requested");
      if (resource.resourceType === "executor_binding") {
        assert.equal(asRecord(resource.payload).southstarExecutorStatus, "cancel_requested");
      }
    }
  } finally {
    await db.close();
  }
});

test("run lifecycle cancel marks active execution resources cancel_requested without payload flag", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedLifecycleRun(db, { runId: "run-lifecycle-cancel-default-intent", status: "running" });
    await seedActiveExecutionResources(db, "run-lifecycle-cancel-default-intent");
    const context = {
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };

    const cancel = await readOk<{ commandId: string; status: string; resourceRefs: Array<{ resourceType: string; resourceKey: string }> }>(
      await handleRuntimeRoute(context, request("POST", "/api/v2/runs/run-lifecycle-cancel-default-intent/cancel", commandBody("cmd-run-cancel-default-intent"))),
    );

    assert.equal(cancel.result.status, "applied");
    assert.equal(await runStatus(db, "run-lifecycle-cancel-default-intent"), "cancelled");
    assert.deepEqual(cancel.result.resourceRefs.map((ref) => ref.resourceType).sort(), [
      "executor_binding",
      "hand_execution",
      "workflow_run",
    ]);
    const resources = (await listResourcesPg(db, { resourceType: "hand_execution" }))
      .concat(await listResourcesPg(db, { resourceType: "executor_binding" }))
      .filter((resource) => resource.runId === "run-lifecycle-cancel-default-intent");
    assert.deepEqual(resources.map((resource) => resource.status).sort(), ["cancel_requested", "cancel_requested"]);
  } finally {
    await db.close();
  }
});

test("run lifecycle dry run pause returns noop without mutating a running run", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedLifecycleRun(db, { runId: "run-lifecycle-dry-run", status: "running" });
    const result = await readOk<{ commandId: string; status: string }>(
      await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      }, request("POST", "/api/v2/runs/run-lifecycle-dry-run/pause", {
        ...commandBody("cmd-run-dry-pause"),
        dryRun: true,
      })),
    );

    assert.equal(result.result.status, "noop");
    assert.equal(await runStatus(db, "run-lifecycle-dry-run"), "running");
  } finally {
    await db.close();
  }
});

test("run lifecycle blocked dry run returns blocked without mutating a paused run", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedLifecycleRun(db, { runId: "run-lifecycle-dry-blocked", status: "paused" });
    const result = await readOk<{ commandId: string; status: string; accepted: boolean }>(
      await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      }, request("POST", "/api/v2/runs/run-lifecycle-dry-blocked/pause", {
        ...commandBody("cmd-run-dry-blocked-pause"),
        dryRun: true,
      })),
    );

    assert.equal(result.result.status, "blocked");
    assert.equal(result.result.accepted, false);
    assert.equal(await runStatus(db, "run-lifecycle-dry-blocked"), "paused");
    assert.equal((await listHistoryForRunPg(db, "run-lifecycle-dry-blocked")).length, 0);
    assert.equal((await listResourcesPg(db, { resourceType: "runtime_command" })).filter((resource) => resource.runId === "run-lifecycle-dry-blocked").length, 0);
  } finally {
    await db.close();
  }
});

test("run lifecycle cancel keeps a cancelled run terminal when a late callback arrives", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedLifecycleRun(db, { runId: "run-lifecycle-late-callback", status: "running" });
    await seedActiveExecutionResources(db, "run-lifecycle-late-callback");
    const context = {
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };

    await readOk(await handleRuntimeRoute(context, request("POST", "/api/v2/runs/run-lifecycle-late-callback/cancel", {
      ...commandBody("cmd-run-late-callback-cancel"),
      payload: { cancelActiveJobs: true },
    })));
    assert.equal(await runStatus(db, "run-lifecycle-late-callback"), "cancelled");

    const callback = await readOk<{ accepted: boolean; ignoredRunStatus?: string }>(
      await handleRuntimeRoute(context, request("POST", "/api/v2/tork/callback", {
        runId: "run-lifecycle-late-callback",
        taskId: "task-a",
        rootSessionId: "root-a",
        attemptId: "attempt-1",
        ok: true,
        attempts: 1,
        artifact: { kind: "implementation_report", summary: "late callback should not reopen run" },
        metrics: {},
        events: [],
      })),
    );

    assert.equal(callback.result.accepted, false);
    assert.equal(callback.result.ignoredRunStatus, "cancelled");
    assert.equal(await runStatus(db, "run-lifecycle-late-callback"), "cancelled");
  } finally {
    await db.close();
  }
});

async function seedLifecycleRun(db: TestPostgresDb, input: { runId: string; status: string }): Promise<void> {
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: input.status,
    domain: "software",
    goalPrompt: "run lifecycle API",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [] }),
    executionProjectionJson: JSON.stringify({}),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: "task-a",
    runId: input.runId,
    taskKey: "task-a",
    status: "queued",
    sortOrder: 1,
    dependsOn: [],
  });
}

async function seedActiveExecutionResources(db: TestPostgresDb, runId: string): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    resourceType: "hand_execution",
    resourceKey: `hand-execution:${runId}:task-a:attempt-1`,
    runId,
    taskId: "task-a",
    scope: "hand",
    status: "running",
    title: "Hand execution",
    payload: { handExecutionId: `hand-execution:${runId}:task-a:attempt-1`, status: "running" },
    summary: { status: "running" },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "executor_binding",
    resourceKey: `executor-${runId}-task-a-attempt-1`,
    runId,
    taskId: "task-a",
    scope: "executor",
    status: "running",
    title: "Executor binding",
    payload: {
      runId,
      taskId: "task-a",
      attemptId: "attempt-1",
      executorType: "tork",
      torkJobId: "job-1",
      southstarExecutorStatus: "running",
      submittedAt: "2026-06-23T00:00:00.000Z",
      queueTimeoutAt: "2026-06-23T00:05:00.000Z",
      hardTimeoutAt: "2026-06-23T00:30:00.000Z",
      reconcileGeneration: 0,
      idempotencyKey: `executor-binding:${runId}:task-a:attempt-1`,
    },
    summary: { status: "running" },
  });
}

function commandBody(commandId: string) {
  return {
    commandId,
    actor: { type: "user" as const, id: "operator-a" },
    reason: "operator requested lifecycle transition",
    payload: {},
  };
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function readOk<T>(response: Response): Promise<{ ok: true; kind: string; result: T }> {
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: true; kind: string; result: T };
  assert.equal(body.ok, true);
  return body;
}

async function runStatus(db: TestPostgresDb, runId: string): Promise<string> {
  return (await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId])).status;
}

function count(values: string[], expected: string): number {
  return values.filter((value) => value === expected).length;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
