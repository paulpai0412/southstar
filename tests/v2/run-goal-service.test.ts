import test from "node:test";
import assert from "node:assert/strict";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { finalizeGoalContract, type GoalContractInterpreter, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import {
  GoalSubmissionConflictError,
  GoalSubmissionPendingError,
  submitGoalPg,
} from "../../src/v2/orchestration/run-goal-service.ts";
import { decideApprovalPg } from "../../src/v2/approvals/postgres-approval-service.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import {
  DeterministicFixtureComposer,
  deterministicFixtureComposition,
  seedDeterministicWorkflowGraph,
} from "./fixtures/deterministic-workflow-composer.ts";
import { fixedGoalInterpreter, softwareGoalContract } from "./fixtures/goal-contract.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { startRunSchedulingPg } from "../../src/v2/server/run-execution-controller.ts";

test("materialization failure rolls back the prepared draft and leaves a retryable submission", async () => {
  const db = await createTestPostgresDb();
  const input = request("Add parser tests", "goal-materialization-retry-1");
  try {
    await seedDeterministicWorkflowGraph(db);
    await upsertLibraryObject(db, {
      objectKey: "template.software-feature",
      objectKind: "workflow_template",
      status: "approved",
      headVersionId: "template.software-feature@test",
      state: { scope: "software", title: "Unsafe template", apiKey: "sk-live-must-not-snapshot" },
    });

    await assert.rejects(
      () => submitGoalPg({
        db,
        goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
        composer: new DeterministicFixtureComposer(),
      }, input),
      /credential-looking Library state/i,
    );
    assert.deepEqual(await durableCounts(db), { drafts: 0, runs: 0 });
    const failed = await submissionRow(db, input.idempotencyKey);
    assert.equal(failed.status, "failed");
    assert.equal(failed.payload_json.retryable, true);

    await upsertLibraryObject(db, {
      objectKey: "template.software-feature",
      objectKind: "workflow_template",
      status: "approved",
      headVersionId: "template.software-feature@test",
      state: { scope: "software", title: "Software Feature Test Template" },
    });
    const retried = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      composer: new DeterministicFixtureComposer(),
    }, input);
    assert.equal(retried.runStatus, "scheduling");
    assert.deepEqual(await durableCounts(db), { drafts: 1, runs: 1 });
  } finally {
    await db.close();
  }
});

test("planner failure persists a retryable claim instead of leaving permanent processing", async () => {
  const db = await createTestPostgresDb();
  const input = request("Add parser tests", "goal-planner-retry-1");
  try {
    await seedDeterministicWorkflowGraph(db);
    await assert.rejects(
      () => submitGoalPg({
        db,
        goalInterpreter: { interpret: async () => { throw new Error("interpreter unavailable"); } },
        composer: new DeterministicFixtureComposer(),
      }, input),
      /interpreter unavailable/,
    );
    const failed = await submissionRow(db, input.idempotencyKey);
    assert.equal(failed.status, "failed");
    assert.equal(failed.payload_json.retryable, true);
    assert.match(String(failed.payload_json.failure), /interpreter unavailable/);

    await assert.rejects(
      () => submitGoalPg({
        db,
        goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
        composer: { compose: async () => { throw new Error("composer unavailable"); } },
      }, input),
      /composer unavailable/,
    );
    const composerFailed = await submissionRow(db, input.idempotencyKey);
    assert.equal(composerFailed.status, "failed");
    assert.match(String(composerFailed.payload_json.failure), /composer unavailable/);

    const retried = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      composer: new DeterministicFixtureComposer(),
    }, input);
    assert.equal(retried.runStatus, "scheduling");
  } finally {
    await db.close();
  }
});

test("low-risk run-goal auto-schedules in one call after its durable transaction commits", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    let committedBeforeScheduling = false;
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(softwareGoalContract("Add unit tests for the parser")),
      composer: new DeterministicFixtureComposer(),
      async startScheduling(runDb, input) {
        const persisted = await runDb.one<{ run_status: string; approval_status: string }>(
          `select r.status as run_status, a.status as approval_status
             from southstar.workflow_runs r
             join southstar.runtime_resources a on a.run_id = r.id and a.resource_type = 'approval'
            where r.id = $1`,
          [input.runId],
        );
        committedBeforeScheduling = persisted.run_status === "created" && persisted.approval_status === "approved";
        await runDb.query("update southstar.workflow_runs set status = 'scheduling', updated_at = now() where id = $1", [input.runId]);
        return { runId: input.runId, status: "scheduling" as const, schedulerWakeRequested: true as const };
      },
    }, request("Add unit tests for the parser", "goal-low-risk-1"));

    assert.equal(result.draftStatus, "validated");
    assert.equal(result.runStatus, "scheduling", JSON.stringify(await approvalResource(db, result.approvalId!)));
    assert.ok(result.runId);
    assert.equal(committedBeforeScheduling, true);
    assert.equal((await approvalResource(db, result.approvalId!)).status, "approved");
    const approvalHistory = await db.query<{ event_type: string }>(
      "select event_type from southstar.workflow_history where run_id = $1 and event_type like 'approval.%' order by sequence",
      [result.runId],
    );
    assert.deepEqual(approvalHistory.rows.map((row) => row.event_type), ["approval.requested", "approval.decided"]);
  } finally {
    await db.close();
  }
});

test("high-risk run-goal persists approval and does not schedule", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    let schedulingCalls = 0;
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Deploy the service to production", ["deployment"])),
      composer: new DeterministicFixtureComposer(),
      async startScheduling() {
        schedulingCalls += 1;
        throw new Error("must not schedule");
      },
    }, request("Deploy the service to production", "goal-high-risk-1"));

    assert.equal(result.runStatus, "awaiting_approval", JSON.stringify(result));
    assert.equal((await runRow(db, result.runId!)).status, "awaiting_approval");
    assert.equal(schedulingCalls, 0);
    assert.equal(await schedulingStartedCount(db, result.runId!), 0);
  } finally {
    await db.close();
  }
});

test("selected authority triggers approval even when the Goal Contract omits a risk tag", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await upsertLibraryObject(db, {
      objectKey: "tool.production-deploy",
      objectKind: "tool_definition",
      status: "approved",
      headVersionId: "tool.production-deploy@test",
      state: {
        scope: "software",
        title: "Production deploy",
        toolName: "production-deploy",
        proxyToolName: "southstar.production-deploy",
        sideEffects: ["deployment", "production-change"],
      },
    });
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Release this service")),
      composer: deploymentComposer(),
    }, request("Release this service", "goal-derived-risk-1"));

    assert.equal(result.runStatus, "awaiting_approval", JSON.stringify(result));
    const approval = await approvalResource(db, result.approvalId!);
    assert.equal((approval.payload_json.riskTags as string[]).includes("deployment"), true);
    assert.equal((approval.payload_json.riskTags as string[]).includes("production-change"), true);
  } finally {
    await db.close();
  }
});

test("ambiguous run-goal persists needs_input without creating a run", async () => {
  const db = await createTestPostgresDb();
  try {
    const contract = { ...goalContract("Change it"), blockingInputs: ["Which parser should change?"] };
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(contract),
      composer: new DeterministicFixtureComposer(),
    }, request("Change it", "goal-ambiguous-1"));

    assert.equal(result.draftStatus, "needs_input");
    assert.deepEqual(result.blockers, contract.blockingInputs);
    assert.equal(result.runId, undefined);
    assert.equal(await runCount(db), 0);
  } finally {
    await db.close();
  }
});

test("replaying an idempotency key returns the same result and creates one run", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const context = {
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      composer: new DeterministicFixtureComposer(),
    };
    const input = request("Add parser tests", "goal-replay-1");
    const first = await submitGoalPg(context, input);
    const second = await submitGoalPg(context, input);

    assert.deepEqual(second, first);
    assert.equal(await runCount(db), 1);
  } finally {
    await db.close();
  }
});

test("a replay stays active while post-commit scheduling is pending", async () => {
  const db = await createTestPostgresDb();
  const entered = deferred();
  const release = deferred();
  const input = request("Add parser tests", "goal-scheduling-pending-1");
  let first: Promise<Awaited<ReturnType<typeof submitGoalPg>>> | undefined;
  try {
    await seedDeterministicWorkflowGraph(db);
    const context = {
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      composer: new DeterministicFixtureComposer(),
      async startScheduling(runDb: typeof db, schedulingInput: { runId: string }) {
        entered.resolve();
        await release.promise;
        return await startRunSchedulingPg(runDb, schedulingInput);
      },
    };
    first = submitGoalPg(context, input);
    await entered.promise;

    assert.equal((await runRowByGoal(db, "Add parser tests")).status, "created");
    await assert.rejects(
      () => submitGoalPg(context, input),
      (error: unknown) => error instanceof GoalSubmissionPendingError && error.status === 202,
    );
    const processing = await submissionRow(db, input.idempotencyKey);
    assert.equal(processing.status, "processing");
    assert.equal(processing.payload_json.result, undefined);

    release.resolve();
    const result = await first;
    assert.equal(result.runStatus, "scheduling");
    const completed = await submissionRow(db, input.idempotencyKey);
    assert.equal(completed.status, "completed");
    assert.equal((completed.payload_json.stages as string[]).at(-1), "done");
  } finally {
    release.resolve();
    await first?.catch(() => undefined);
    await db.close();
  }
});

test("scheduler failure commits its exception and final goal result atomically", async () => {
  const db = await createTestPostgresDb();
  const idempotencyKey = "goal-scheduler-atomic-1";
  try {
    await seedDeterministicWorkflowGraph(db);
    await installAtomicSchedulerFailureConstraint(db, idempotencyKey);

    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      composer: new DeterministicFixtureComposer(),
      async startScheduling() {
        throw new Error("scheduler unavailable");
      },
    }, request("Add parser tests", idempotencyKey));

    assert.equal(result.runStatus, "created");
    assert.ok(result.schedulerExceptionId);
    const completed = await submissionRow(db, idempotencyKey);
    assert.equal(completed.status, "completed");
    assert.equal((completed.payload_json.result as { schedulerExceptionId?: string }).schedulerExceptionId, result.schedulerExceptionId);
    assert.equal((completed.payload_json.stages as string[]).at(-1), "done");
  } finally {
    await db.close();
  }
});

test("a reused idempotency key with a different request returns 409", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const context = {
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      composer: new DeterministicFixtureComposer(),
    };
    await submitGoalPg(context, request("Add parser tests", "goal-conflict-1"));

    await assert.rejects(
      () => submitGoalPg(context, request("Delete production", "goal-conflict-1")),
      (error: unknown) => error instanceof GoalSubmissionConflictError && error.status === 409,
    );
  } finally {
    await db.close();
  }
});

test("an active identical idempotency claim returns 202 with its durable submission id", async () => {
  const db = await createTestPostgresDb();
  let release!: () => void;
  const entered = deferred();
  const blocked = deferred();
  try {
    await seedDeterministicWorkflowGraph(db);
    const interpreter: GoalContractInterpreter = {
      async interpret() {
        entered.resolve();
        await blocked.promise;
        return goalContract("Add parser tests");
      },
    };
    release = blocked.resolve;
    const input = request("Add parser tests", "goal-processing-1");
    const first = submitGoalPg({ db, goalInterpreter: interpreter, composer: new DeterministicFixtureComposer() }, input);
    await entered.promise;

    await assert.rejects(
      () => submitGoalPg({ db, goalInterpreter: interpreter, composer: new DeterministicFixtureComposer() }, input),
      (error: unknown) => error instanceof GoalSubmissionPendingError && error.status === 202 && error.submissionId.length > 0,
    );
    release();
    await first;
  } finally {
    release?.();
    await db.close();
  }
});

test("manual goal approval rechecks immutable hashes before committing", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Deploy production", ["deployment"])),
      composer: new DeterministicFixtureComposer(),
    }, request("Deploy production", "goal-hash-recheck-1"));
    await db.query(
      "update southstar.workflow_runs set workflow_manifest_json = jsonb_set(workflow_manifest_json, '{title}', to_jsonb('tampered'::text)) where id = $1",
      [result.runId],
    );

    await assert.rejects(
      () => decideApprovalPg(db, {
        runId: result.runId!,
        approvalId: result.approvalId!,
        decision: "approved",
        reason: "operator approved",
      }),
      /manifest hash mismatch/i,
    );
    assert.equal((await approvalResource(db, result.approvalId!)).status, "pending");
    assert.equal((await runRow(db, result.runId!)).status, "awaiting_approval");
  } finally {
    await db.close();
  }
});

test("manual goal approval commits created state before scheduling", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Deploy production", ["deployment"])),
      composer: new DeterministicFixtureComposer(),
    }, request("Deploy production", "goal-manual-schedule-1"));
    let committed = false;
    const decision = await decideApprovalPg(db, {
      runId: result.runId!,
      approvalId: result.approvalId!,
      decision: "approved",
      reason: "operator approved",
      async startScheduling(runDb, input) {
        const state = await runDb.one<{ run_status: string; approval_status: string }>(
          `select r.status as run_status, a.status as approval_status
             from southstar.workflow_runs r
             join southstar.runtime_resources a on a.run_id = r.id and a.resource_key = $2
            where r.id = $1`,
          [input.runId, result.approvalId],
        );
        committed = state.run_status === "created" && state.approval_status === "approved";
        await runDb.query("update southstar.workflow_runs set status = 'scheduling' where id = $1", [input.runId]);
        return { runId: input.runId, status: "scheduling" as const, schedulerWakeRequested: true as const };
      },
    });

    assert.equal(committed, true);
    assert.equal(decision.status, "approved");
    assert.equal((await runRow(db, result.runId!)).status, "scheduling");
  } finally {
    await db.close();
  }
});

test("replaying the same manual goal approval does not schedule or record an exception twice", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Deploy production", ["deployment"])),
      composer: new DeterministicFixtureComposer(),
    }, request("Deploy production", "goal-manual-replay-1"));
    let schedulingCalls = 0;
    const first = await decideApprovalPg(db, {
      runId: result.runId!,
      approvalId: result.approvalId!,
      decision: "approved",
      reason: "operator approved",
      async startScheduling(runDb, input) {
        schedulingCalls += 1;
        return await startRunSchedulingPg(runDb, input);
      },
    });
    const replay = await decideApprovalPg(db, {
      runId: result.runId!,
      approvalId: result.approvalId!,
      decision: "approved",
      reason: "operator approved",
      async startScheduling() {
        schedulingCalls += 1;
        throw new Error("replay must not schedule");
      },
    });

    assert.equal(schedulingCalls, 1);
    assert.equal(first.status, "approved");
    assert.equal(replay.status, "approved");
    assert.equal(await runtimeExceptionCount(db, result.runId!), 0);
  } finally {
    await db.close();
  }
});

test("concurrent identical manual approvals schedule exactly once", async () => {
  const db = await createTestPostgresDb();
  const entered = deferred();
  const release = deferred();
  let first: Promise<Awaited<ReturnType<typeof decideApprovalPg>>> | undefined;
  try {
    await seedDeterministicWorkflowGraph(db);
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Deploy production", ["deployment"])),
      composer: new DeterministicFixtureComposer(),
    }, request("Deploy production", "goal-manual-concurrent-1"));
    let schedulingCalls = 0;
    first = decideApprovalPg(db, {
      runId: result.runId!,
      approvalId: result.approvalId!,
      decision: "approved",
      reason: "operator approved",
      async startScheduling(runDb, input) {
        schedulingCalls += 1;
        entered.resolve();
        await release.promise;
        return await startRunSchedulingPg(runDb, input);
      },
    });
    await entered.promise;
    const concurrentReplay = await decideApprovalPg(db, {
      runId: result.runId!,
      approvalId: result.approvalId!,
      decision: "approved",
      reason: "operator approved",
      async startScheduling() {
        schedulingCalls += 1;
        throw new Error("concurrent replay must not schedule");
      },
    });
    release.resolve();
    const firstResult = await first;

    assert.equal(firstResult.status, "approved");
    assert.equal(concurrentReplay.status, "approved");
    assert.equal(schedulingCalls, 1);
    assert.equal(await runtimeExceptionCount(db, result.runId!), 0);
  } finally {
    release.resolve();
    await first?.catch(() => undefined);
    await db.close();
  }
});

test("scheduler wakeup failure records an exception against the existing run", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      composer: new DeterministicFixtureComposer(),
      async startScheduling() {
        throw new Error("scheduler unavailable");
      },
    }, request("Add parser tests", "goal-scheduler-failure-1"));

    assert.ok(result.schedulerExceptionId);
    assert.equal(await runCount(db), 1);
    const exception = await db.one<{ id: string; run_id: string }>(
      "select id, run_id from southstar.runtime_resources where resource_type = 'runtime_exception' and id = $1",
      [result.schedulerExceptionId],
    );
    assert.equal(exception.id, result.schedulerExceptionId);
    assert.equal(exception.run_id, result.runId);
    const submission = await db.one<{ payload_json: { stages: string[] } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'goal_submission' and resource_key = $1",
      ["goal-scheduler-failure-1"],
    );
    assert.equal(submission.payload_json.stages.includes("run.scheduling_started"), false);
    assert.equal(submission.payload_json.stages.at(-1), "done");
  } finally {
    await db.close();
  }
});

test("POST /api/v2/run-goal requires the one-prompt ingress contract and returns the durable result", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const response = await handleRuntimeRoute(runtimeContext(db, "Add parser tests"), new Request("http://127.0.0.1/api/v2/run-goal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request("Add parser tests", "goal-json-route-1")),
    }));
    assert.equal(response.status, 200);
    const envelope = await response.json() as { ok: true; kind: string; result: { runStatus: string; draftStatus: string } };
    assert.equal(envelope.kind, "run-goal");
    assert.equal(envelope.result.draftStatus, "validated");
    assert.equal(envelope.result.runStatus, "scheduling");

    const invalid = await handleRuntimeRoute(runtimeContext(db, "Add parser tests"), new Request("http://127.0.0.1/api/v2/run-goal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalPrompt: "Add parser tests" }),
    }));
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /cwd is required/);
  } finally {
    await db.close();
  }
});

test("POST /api/v2/run-goal streams persisted stages and the JSON-equivalent done result", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const response = await handleRuntimeRoute(runtimeContext(db, "Add parser tests"), new Request("http://127.0.0.1/api/v2/run-goal", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(request("Add parser tests", "goal-sse-route-1")),
    }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const frames = parseFrames(await response.text());
    assert.deepEqual(frames.slice(0, -1).map((frame) => frame.event), Array(6).fill("planner.stage"));
    assert.deepEqual(frames.slice(0, -1).map((frame) => (frame.data as { stage: string }).stage), [
      "goal_contract.interpreted",
      "draft.persisted",
      "coverage.validated",
      "library_snapshot.persisted",
      "approval.persisted",
      "run.scheduling_started",
    ]);
    assert.equal(frames.at(-1)?.event, "done");
    assert.equal((frames.at(-1)?.data as { runStatus?: string }).runStatus, "scheduling");
  } finally {
    await db.close();
  }
});

test("JSON run-goal returns HTTP 202 for an active replay and 409 for a conflicting request", async () => {
  const db = await createTestPostgresDb();
  const entered = deferred();
  const release = deferred();
  let first: Promise<Response> | undefined;
  try {
    await seedDeterministicWorkflowGraph(db);
    const context = runtimeContextWithInterpreter(db, {
      async interpret() {
        entered.resolve();
        await release.promise;
        return goalContract("Add parser tests");
      },
    });
    const activeRequest = request("Add parser tests", "goal-json-status-1");
    first = handleRuntimeRoute(context, runGoalRequest(activeRequest));
    await entered.promise;

    const active = await handleRuntimeRoute(context, runGoalRequest(activeRequest));
    assert.equal(active.status, 202);
    assert.match(await active.text(), /goal-submission-/);
    const conflict = await handleRuntimeRoute(context, runGoalRequest({
      ...activeRequest,
      goalPrompt: "Delete production",
    }));
    assert.equal(conflict.status, 409);

    release.resolve();
    assert.equal((await first).status, 200);
  } finally {
    release.resolve();
    await first?.catch(() => undefined);
    await db.close();
  }
});

test("SSE run-goal returns HTTP 202 or 409 before constructing a stream for an occupied key", async () => {
  const db = await createTestPostgresDb();
  const entered = deferred();
  const release = deferred();
  let firstResponse: Response | undefined;
  let firstBody: Promise<string> | undefined;
  const extraResponses: Response[] = [];
  try {
    await seedDeterministicWorkflowGraph(db);
    const context = runtimeContextWithInterpreter(db, {
      async interpret() {
        entered.resolve();
        await release.promise;
        return goalContract("Add parser tests");
      },
    });
    const activeRequest = request("Add parser tests", "goal-sse-status-1");
    firstResponse = await handleRuntimeRoute(context, runGoalRequest(activeRequest, true));
    assert.equal(firstResponse.status, 200);
    firstBody = firstResponse.text();
    await entered.promise;

    const active = await handleRuntimeRoute(context, runGoalRequest(activeRequest, true));
    extraResponses.push(active);
    assert.equal(active.status, 202);
    assert.match(active.headers.get("content-type") ?? "", /application\/json/);
    const conflict = await handleRuntimeRoute(context, runGoalRequest({
      ...activeRequest,
      goalPrompt: "Delete production",
    }, true));
    extraResponses.push(conflict);
    assert.equal(conflict.status, 409);
    assert.match(conflict.headers.get("content-type") ?? "", /application\/json/);

    release.resolve();
    const frames = parseFrames(await firstBody);
    assert.equal(frames.at(-1)?.event, "done");
  } finally {
    release.resolve();
    await firstBody?.catch(() => undefined);
    await Promise.all(extraResponses.map((response) => response.body?.cancel().catch(() => undefined)));
    await db.close();
  }
});

function request(goalPrompt: string, idempotencyKey: string) {
  return { goalPrompt, cwd: "/workspace/software", idempotencyKey };
}

function goalContract(goalPrompt: string, riskTags: string[] = []): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt,
    cwd: "/workspace/software",
    interpretation: {
      domain: "software",
      intent: "implement_feature",
      summary: goalPrompt,
      requirements: [{ statement: goalPrompt, acceptanceCriteria: [goalPrompt], blocking: true, source: "explicit" }],
      expectedArtifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
      requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
      nonGoals: [],
      assumptions: [],
      blockingInputs: [],
      riskTags,
      requestedSideEffects: ["workspace-write"],
    },
  });
}

function deploymentComposer(): WorkflowComposer {
  return {
    async compose(input) {
      const composition = deterministicFixtureComposition(input.goalContract);
      composition.tasks[0]!.toolGrantRefs = ["tool.production-deploy"];
      const profile = composition.generatedComponentProposals.find((proposal) => proposal.id === composition.tasks[0]!.agentProfileRef)?.agentProfile;
      assert.ok(profile?.toolPolicy);
      profile.toolPolicy.allowedTools = ["tool.production-deploy"];
      return composition;
    },
  };
}

async function approvalResource(db: Awaited<ReturnType<typeof createTestPostgresDb>>, approvalId: string) {
  return await db.one<{ status: string; payload_json: Record<string, unknown> }>(
    "select status, payload_json from southstar.runtime_resources where resource_type = 'approval' and resource_key = $1",
    [approvalId],
  );
}

async function runRow(db: Awaited<ReturnType<typeof createTestPostgresDb>>, runId: string) {
  return await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
}

async function runRowByGoal(db: Awaited<ReturnType<typeof createTestPostgresDb>>, goalPrompt: string) {
  return await db.one<{ status: string }>("select status from southstar.workflow_runs where goal_prompt = $1", [goalPrompt]);
}

async function schedulingStartedCount(db: Awaited<ReturnType<typeof createTestPostgresDb>>, runId: string): Promise<number> {
  const row = await db.one<{ count: string }>(
    "select count(*)::text as count from southstar.workflow_history where run_id = $1 and event_type = 'run.scheduling_started'",
    [runId],
  );
  return Number(row.count);
}

async function runtimeExceptionCount(db: Awaited<ReturnType<typeof createTestPostgresDb>>, runId: string): Promise<number> {
  return Number((await db.one<{ count: string }>(
    "select count(*)::text as count from southstar.runtime_resources where run_id = $1 and resource_type = 'runtime_exception'",
    [runId],
  )).count);
}

async function runCount(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<number> {
  return Number((await db.one<{ count: string }>("select count(*)::text as count from southstar.workflow_runs")).count);
}

async function durableCounts(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  const row = await db.one<{ drafts: string; runs: string }>(
    `select
       (select count(*)::text from southstar.runtime_resources where resource_type = 'planner_draft') as drafts,
       (select count(*)::text from southstar.workflow_runs) as runs`,
  );
  return { drafts: Number(row.drafts), runs: Number(row.runs) };
}

async function submissionRow(db: Awaited<ReturnType<typeof createTestPostgresDb>>, idempotencyKey: string) {
  return await db.one<{ status: string; payload_json: Record<string, unknown> }>(
    "select status, payload_json from southstar.runtime_resources where resource_type = 'goal_submission' and resource_key = $1",
    [idempotencyKey],
  );
}

async function installAtomicSchedulerFailureConstraint(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  idempotencyKey: string,
): Promise<void> {
  await db.query(
    `create or replace function southstar.assert_goal_scheduler_failure_atomic()
       returns trigger
       language plpgsql
       as $function$
       declare submission jsonb;
       begin
         if new.resource_type <> 'runtime_exception' or new.payload_json->>'source' <> 'scheduler' then
           return new;
         end if;
         select payload_json into submission
           from southstar.runtime_resources
          where resource_type = 'goal_submission' and resource_key = ${sqlLiteral(idempotencyKey)};
         if submission #>> '{result,schedulerExceptionId}' is distinct from new.id
            or submission->'stages'->>(jsonb_array_length(submission->'stages') - 1) is distinct from 'done' then
           raise exception 'scheduler exception and goal result were not committed atomically';
         end if;
         return new;
       end
       $function$`,
  );
  await db.query(
    `create constraint trigger assert_goal_scheduler_failure_atomic
       after insert on southstar.runtime_resources
       deferrable initially deferred
       for each row execute function southstar.assert_goal_scheduler_failure_atomic()`,
  );
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runtimeContext(db: Awaited<ReturnType<typeof createTestPostgresDb>>, goalPrompt: string) {
  return runtimeContextWithInterpreter(db, fixedGoalInterpreter(goalContract(goalPrompt)));
}

function runtimeContextWithInterpreter(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  goalInterpreter: GoalContractInterpreter,
) {
  return {
    db,
    goalInterpreter,
    workflowComposer: new DeterministicFixtureComposer(),
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
  };
}

function runGoalRequest(input: ReturnType<typeof request>, sse = false): Request {
  return new Request("http://127.0.0.1/api/v2/run-goal", {
    method: "POST",
    headers: { "content-type": "application/json", ...(sse ? { accept: "text/event-stream" } : {}) },
    body: JSON.stringify(input),
  });
}

function parseFrames(text: string): Array<{ event: string; data: unknown }> {
  return text.trim().split("\n\n").map((frame) => {
    const lines = frame.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
    const data = JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "null");
    return { event, data };
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
