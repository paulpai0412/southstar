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

async function schedulingStartedCount(db: Awaited<ReturnType<typeof createTestPostgresDb>>, runId: string): Promise<number> {
  const row = await db.one<{ count: string }>(
    "select count(*)::text as count from southstar.workflow_history where run_id = $1 and event_type = 'run.scheduling_started'",
    [runId],
  );
  return Number(row.count);
}

async function runCount(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<number> {
  return Number((await db.one<{ count: string }>("select count(*)::text as count from southstar.workflow_runs")).count);
}

function runtimeContext(db: Awaited<ReturnType<typeof createTestPostgresDb>>, goalPrompt: string) {
  return {
    db,
    goalInterpreter: fixedGoalInterpreter(goalContract(goalPrompt)),
    workflowComposer: new DeterministicFixtureComposer(),
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
  };
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
