import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { finalizeGoalContract, goalContractHash, type GoalContractInterpreter, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import {
  finalizeGoalDesignPackage,
  type GoalDesigner,
  type GoalDesignMode,
  type ResolvedGoalDesignSkillV1,
  type WorkflowTemplatePolicyV1,
} from "../../src/v2/orchestration/goal-design.ts";
import { finalizeGoalRequirementDraft, type GoalRequirementDraftInputV1 } from "../../src/v2/orchestration/goal-requirement-draft.ts";
import {
  GoalSubmissionConflictError,
  GoalSubmissionPendingError,
  confirmGoalDesignPg,
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
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";

test("staged run-goal route persists requirement review and confirms with a hash", async () => {
  const db = await createTestPostgresDb();
  const cwd = process.cwd();
  const projectRef = "vocab-route";
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const context = {
      ...runtimeContext(db, "Create a vocabulary app"),
      goalRequirementInterpreter: {
        async interpret() {
          return finalizeGoalRequirementDraft({
            goalPrompt: "Create a vocabulary app",
            cwd,
            projectRef,
            summary: "Create a vocabulary app with a reviewable offline flow.",
            requirements: [{
              title: "Vocabulary review",
              statement: "A user can review a vocabulary item offline.",
              source: "explicit" as const,
              blocking: true,
              userVisibleBehaviors: ["The item and answer are shown."],
              businessRules: [],
              acceptanceCriteria: [{ statement: "A vocabulary item can be reviewed offline.", evidenceIntent: ["browser evidence"] }],
              expectedOutcomeArtifacts: [{ description: "Vocabulary review UI", mediaType: "text/html" }],
              verificationIntent: ["Open the app and complete one review."],
              assumptions: [],
              openQuestions: [],
              riskTags: [],
              interactionContractRefs: [],
            }],
            nonGoals: [],
            blockingInputs: [],
          });
        },
        async revise() {
          throw new Error("revision not used in route test");
        },
      },
    };
    const response = await handleRuntimeRoute(context, new Request("http://127.0.0.1/api/v2/run-goal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalPrompt: "Create a vocabulary app", cwd, projectRef, idempotencyKey: "requirements-route-1", goalDesignMode: "auto_until_blocked", templatePolicy: { mode: "auto" } }),
    }));
    assert.equal(response.status, 200);
    const envelope = await response.json() as { ok: true; result: { draftId: string; draftStatus: string; goalRequirementDraftHash: string } };
    assert.equal(envelope.result.draftStatus, "requirements_review");
    assert.match(envelope.result.goalRequirementDraftHash, /^[a-f0-9]{64}$/);
    const stagedResource = await db.one<{ payload_json: { plannerRequest?: { projectRef?: string; goalDesignMode?: string; templatePolicy?: { mode?: string } } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [envelope.result.draftId],
    );
    assert.equal(stagedResource.payload_json.plannerRequest?.goalDesignMode, "auto_until_blocked");
    assert.equal(stagedResource.payload_json.plannerRequest?.templatePolicy?.mode, "auto");
    assert.equal(stagedResource.payload_json.plannerRequest?.projectRef, projectRef);
    const replay = await handleRuntimeRoute(context, new Request("http://127.0.0.1/api/v2/run-goal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalPrompt: "Create a vocabulary app", cwd, projectRef, idempotencyKey: "requirements-route-1", goalDesignMode: "auto_until_blocked", templatePolicy: { mode: "auto" } }),
    }));
    assert.equal(replay.status, 200);
    const replayEnvelope = await replay.json() as { ok: true; result: { draftStatus: string; goalRequirementDraftHash: string } };
    assert.equal(replayEnvelope.result.draftStatus, "requirements_review");
    assert.equal(replayEnvelope.result.goalRequirementDraftHash, envelope.result.goalRequirementDraftHash);
    const confirmed = await handleRuntimeRoute(context, new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${encodeURIComponent(envelope.result.draftId)}/confirm-requirements`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedDraftHash: envelope.result.goalRequirementDraftHash, actor: "tester" }),
      },
    ));
    assert.equal(confirmed.status, 200);
    const confirmedEnvelope = await confirmed.json() as { ok: true; result: { status: string; phase: string; goalContractHash: string } };
    assert.equal(confirmedEnvelope.result.status, "validation_resolving");
    assert.equal(confirmedEnvelope.result.phase, "validation_resolving");
    assert.match(confirmedEnvelope.result.goalContractHash, /^[a-f0-9]{64}$/);

    const missing = await handleRuntimeRoute(context, new Request(
      "http://127.0.0.1/api/v2/planner/drafts/missing/goal-requirements/req",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedDraftHash: envelope.result.goalRequirementDraftHash, patch: { statement: "x" } }),
      },
    ));
    assert.equal(missing.status, 404);

    const mismatch = await handleRuntimeRoute(context, new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${encodeURIComponent(envelope.result.draftId)}/goal-requirements/route-id`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedDraftHash: envelope.result.goalRequirementDraftHash,
          patch: { kind: "update", requirementId: "body-id", patch: { statement: "x" } },
        }),
      },
    ));
    assert.equal(mismatch.status, 409);

    const malformed = await handleRuntimeRoute(context, new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${encodeURIComponent(envelope.result.draftId)}/goal-requirements/route-id`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedDraftHash: envelope.result.goalRequirementDraftHash, patch: { unknown: true } }),
      },
    ));
    assert.equal(malformed.status, 422);
  } finally {
    await db.close();
  }
});

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

test("run-goal defaults to ready_for_review without composer or run rows", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedGoalDesignSkill(db);
    let composerCalls = 0;
    const contract = goalContract("Deliver the requested outcome");
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(contract),
      goalDesigner: inlineGoalDesigner(),
      composer: {
        async compose() {
          composerCalls += 1;
          throw new Error("composer must not run");
        },
      },
    }, {
      ...request("Deliver the requested outcome", "goal-review-default-1"),
      cwd: process.cwd(),
    });

    assert.equal(result.draftStatus, "ready_for_review");
    assert.equal(composerCalls, 0);
    assert.equal(result.runId, undefined);
    assert.match(result.goalDesignPackageHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(await runCount(db), 0);
  } finally {
    await db.close();
  }
});

test("confirmation composes the exact package hash and schedules once", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    let composerCalls = 0;
    let schedulingCalls = 0;
    const context = {
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Deliver the requested outcome")),
      goalDesigner: inlineGoalDesigner(),
      composer: {
        async compose(input) {
          composerCalls += 1;
          return goalDesignAwareComposition(input.goalContract);
        },
      } satisfies WorkflowComposer,
      async startScheduling(runDb: typeof db, input: { runId: string }) {
        schedulingCalls += 1;
        return await startRunSchedulingPg(runDb, input);
      },
    };
    const prepared = await submitGoalPg(context, {
      ...request("Deliver the requested outcome", "goal-confirm-prepare-1"),
      cwd: "/tmp",
    });

    const first = await confirmGoalDesignPg(context, {
      draftId: prepared.draftId,
      expectedPackageHash: prepared.goalDesignPackageHash!,
    });
    const replay = await confirmGoalDesignPg(context, {
      draftId: prepared.draftId,
      expectedPackageHash: prepared.goalDesignPackageHash!,
    });

    assert.equal(first.runId, replay.runId);
    assert.equal(first.runStatus, "scheduling");
    assert.equal(composerCalls, 1);
    assert.equal(schedulingCalls, 1);
    assert.equal(await runCount(db), 1);
  } finally {
    await db.close();
  }
});

test("confirmation can materialize per-slice runs under one execution set", async () => {
  const db = await createTestPostgresDb();
  const workspace = await mkdtemp("/tmp/southstar-per-slice-runs-");
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const contract = perSliceGoalContract("Deliver account and billing slices", workspace);
    const composedSliceIds: string[] = [];
    const context = {
      db,
      goalInterpreter: fixedGoalInterpreter(contract),
      goalDesigner: perSliceGoalDesigner(),
      composer: {
        async compose(input) {
          const sliceId = input.goalDesignPackage?.slicePlan.slices[0]?.id ?? "missing";
          composedSliceIds.push(sliceId);
          return goalDesignAwareComposition(input.goalContract, sliceId);
        },
      } satisfies WorkflowComposer,
      startScheduling: startRunSchedulingPg,
    };
    const prepared = await submitGoalPg(context, {
      ...request("Deliver account and billing slices", "goal-per-slice-runs-1"),
      cwd: contract.workspace.cwd,
    });

    const result = await confirmGoalDesignPg(context, {
      draftId: prepared.draftId,
      expectedPackageHash: prepared.goalDesignPackageHash!,
    });

    assert.equal(result.draftStatus, "validated");
    assert.equal(result.runId, undefined);
    assert.ok(result.executionSetId);
    assert.equal(result.sliceRuns?.length, 2);
    assert.deepEqual([...composedSliceIds].sort(), ["slice-account", "slice-billing"]);
    assert.equal(await runCount(db), 2);

    const rows = await db.query<{ status: string; runtime_context_json: Record<string, unknown> }>(
      "select status, runtime_context_json from southstar.workflow_runs order by goal_prompt",
    );
    assert.deepEqual(
      rows.rows.map((row) => row.runtime_context_json.sliceId).sort(),
      ["slice-account", "slice-billing"],
    );
    assert.equal(rows.rows.every((row) => row.runtime_context_json.goalExecutionSetId === result.executionSetId), true);
    assert.equal(rows.rows.every((row) => row.runtime_context_json.cwd === contract.workspace.cwd), true);
    assert.equal(rows.rows.every((row) => row.runtime_context_json.parentGoalContractHash === prepared.goalContractHash), true);
    assert.equal(rows.rows.filter((row) => row.status === "scheduling").length, 1);
    assert.equal(rows.rows.filter((row) => row.status === "created").length, 1);

    const billingRun = rows.rows.find((row) => row.runtime_context_json.sliceId === "slice-billing");
    assert.deepEqual(billingRun?.runtime_context_json.dependsOnSliceIds, ["slice-account"]);
    assert.deepEqual(billingRun?.runtime_context_json.dependencyArtifactRefs, [contract.expectedArtifactRefs[0]]);

    const executionSet = await db.one<{ payload_json: { entries: Array<{ sliceId: string; runId: string }> } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'goal_execution_set' and resource_key = $1",
      [result.executionSetId],
    );
    assert.deepEqual(executionSet.payload_json.entries.map((entry) => entry.sliceId).sort(), ["slice-account", "slice-billing"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await db.close();
  }
});

test("stale confirmation fails before composer invocation", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    let composerCalls = 0;
    const context = {
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Deliver the requested outcome")),
      goalDesigner: inlineGoalDesigner(),
      composer: {
        async compose(input) {
          composerCalls += 1;
          return goalDesignAwareComposition(input.goalContract);
        },
      } satisfies WorkflowComposer,
    };
    const prepared = await submitGoalPg(context, {
      ...request("Deliver the requested outcome", "goal-confirm-stale-1"),
      cwd: "/tmp",
    });

    await assert.rejects(
      () => confirmGoalDesignPg(context, {
        draftId: prepared.draftId,
        expectedPackageHash: "0".repeat(64),
      }),
      /goal_design_package_stale/,
    );
    assert.equal(composerCalls, 0);
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

test("auto scheduling handoff rolls back and replay resumes its durable request", async () => {
  const db = await createTestPostgresDb();
  const idempotencyKey = "goal-scheduler-handoff-replay-1";
  const input = request("Add parser tests", idempotencyKey);
  try {
    await seedDeterministicWorkflowGraph(db);
    await installRejectGoalCompletionConstraint(db, idempotencyKey);
    const context = {
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      composer: new DeterministicFixtureComposer(),
      startScheduling: startRunSchedulingPg,
    };

    await assert.rejects(() => submitGoalPg(context, input), /forced goal handoff rollback/);
    assert.equal((await runRowByGoal(db, "Add parser tests")).status, "created");
    const requested = await submissionRow(db, idempotencyKey);
    assert.equal(requested.status, "processing");
    assert.equal(requested.payload_json.schedulingState, "requested");

    await removeRejectGoalCompletionConstraint(db);
    const replay = await submitGoalPg(context, input);
    assert.equal(replay.runStatus, "scheduling");
    assert.equal((await runRow(db, replay.runId!)).status, "scheduling");
    assert.equal((await submissionRow(db, idempotencyKey)).status, "completed");
    assert.equal(await schedulingStartedCount(db, replay.runId!), 1);
  } finally {
    await removeRejectGoalCompletionConstraint(db).catch(() => undefined);
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

test("manual approval replay resumes a requested handoff after interruption before scheduling", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Deploy production", ["deployment"])),
      composer: new DeterministicFixtureComposer(),
    }, request("Deploy production", "goal-manual-interrupted-1"));

    await assert.rejects(() => decideApprovalPg(db, {
      runId: result.runId!,
      approvalId: result.approvalId!,
      decision: "approved",
      reason: "operator approved",
      async startScheduling(runDb) {
        await runDb.query("select 1 / 0");
        throw new Error("unreachable");
      },
    }));
    const requested = await approvalResource(db, result.approvalId!);
    assert.equal(requested.status, "approved");
    assert.equal(requested.payload_json.schedulingState, "requested");
    assert.equal(requested.payload_json.schedulingResult, undefined);
    assert.equal((await runRow(db, result.runId!)).status, "created");

    const replay = await decideApprovalPg(db, {
      runId: result.runId!,
      approvalId: result.approvalId!,
      decision: "approved",
      reason: "operator approved",
    });
    assert.equal(replay.runStatus, "scheduling");
    assert.equal((await runRow(db, result.runId!)).status, "scheduling");
    const completed = await approvalResource(db, result.approvalId!);
    assert.equal(completed.payload_json.schedulingState, "completed");
    assert.equal((completed.payload_json.schedulingResult as { runStatus?: string }).runStatus, "scheduling");
  } finally {
    await db.close();
  }
});

test("manual scheduling and approval outcome roll back together and replay completes", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const result = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Deploy production", ["deployment"])),
      composer: new DeterministicFixtureComposer(),
    }, request("Deploy production", "goal-manual-outcome-rollback-1"));
    await installRejectApprovalOutcomeConstraint(db, result.approvalId!);

    await assert.rejects(() => decideApprovalPg(db, {
      runId: result.runId!,
      approvalId: result.approvalId!,
      decision: "approved",
      reason: "operator approved",
      startScheduling: startRunSchedulingPg,
    }), /forced approval handoff rollback/);
    assert.equal((await runRow(db, result.runId!)).status, "created");
    const requested = await approvalResource(db, result.approvalId!);
    assert.equal(requested.payload_json.schedulingState, "requested");
    assert.equal(requested.payload_json.schedulingResult, undefined);

    await removeRejectApprovalOutcomeConstraint(db);
    const replay = await decideApprovalPg(db, {
      runId: result.runId!,
      approvalId: result.approvalId!,
      decision: "approved",
      reason: "operator approved",
    });
    assert.equal(replay.runStatus, "scheduling");
    assert.equal((await runRow(db, result.runId!)).status, "scheduling");
    assert.equal((await approvalResource(db, result.approvalId!)).payload_json.schedulingState, "completed");
    assert.equal(await schedulingStartedCount(db, result.runId!), 1);
  } finally {
    await removeRejectApprovalOutcomeConstraint(db).catch(() => undefined);
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
    const concurrentReplayPromise = decideApprovalPg(db, {
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
    const [firstResult, concurrentReplay] = await Promise.all([first, concurrentReplayPromise]);

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
    await seedGoalDesignSkill(db);
    const response = await handleRuntimeRoute(runtimeContext(db, "Add parser tests"), new Request("http://127.0.0.1/api/v2/run-goal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request("Add parser tests", "goal-json-route-1"), cwd: process.cwd() }),
    }));
    assert.equal(response.status, 200);
    const envelope = await response.json() as { ok: true; kind: string; result: { runStatus?: string; draftStatus: string; goalDesignPackageHash?: string } };
    assert.equal(envelope.kind, "run-goal");
    assert.equal(envelope.result.draftStatus, "ready_for_review");
    assert.equal(envelope.result.runStatus, undefined);
    assert.match(envelope.result.goalDesignPackageHash ?? "", /^[a-f0-9]{64}$/);

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

test("run-goal returns structured 503 before claiming a submission when Library is not ready", async () => {
  const db = await createTestPostgresDb();
  try {
    for (const accept of ["application/json", "text/event-stream"]) {
      const response = await handleRuntimeRoute(runtimeContext(db, "Build a vocabulary app"), new Request("http://127.0.0.1/api/v2/run-goal", {
        method: "POST",
        headers: { accept, "content-type": "application/json" },
        body: JSON.stringify(request("Build a vocabulary app", `library-not-ready-${accept}`)),
      }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "library_not_ready",
        message: "Library reconciliation has not produced a ready snapshot",
        diagnostics: [],
      });
      assert.equal(await countGoalSubmissionClaims(db), 0);
    }
  } finally {
    await db.close();
  }
});

test("POST /api/v2/run-goal streams persisted stages and the JSON-equivalent done result", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const response = await handleRuntimeRoute(runtimeContext(db, "Add parser tests"), new Request("http://127.0.0.1/api/v2/run-goal", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...request("Add parser tests", "goal-sse-route-1"), cwd: process.cwd() }),
    }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const frames = parseFrames(await response.text());
    assert.deepEqual(frames.slice(0, -1).map((frame) => frame.event), [
      "planner.stage",
      "goal_design",
      "planner.stage",
      "planner.stage",
    ]);
    assert.match(String((frames[1]?.data as { goalDesignPackageHash?: string }).goalDesignPackageHash), /^[a-f0-9]{64}$/);
    assert.deepEqual(frames.slice(0, -1).filter((frame) => frame.event === "planner.stage").map((frame) => (frame.data as { stage: string }).stage), [
      "goal_contract.interpreted",
      "goal_design.persisted",
      "draft.ready_for_review",
    ]);
    assert.equal(frames.at(-1)?.event, "done");
    assert.equal((frames.at(-1)?.data as { draftStatus?: string; runStatus?: string }).draftStatus, "ready_for_review");
    assert.equal((frames.at(-1)?.data as { runStatus?: string }).runStatus, undefined);
  } finally {
    await db.close();
  }
});

test("POST /api/v2/planner/drafts enters through Goal Design and returns a legacy draft receipt", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const response = await handleRuntimeRoute(runtimeContext(db, "Add parser tests"), new Request("http://127.0.0.1/api/v2/planner/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goalPrompt: "Add parser tests",
        cwd: process.cwd(),
        idempotencyKey: "legacy-planner-draft-route-1",
      }),
    }));

    assert.equal(response.status, 200);
    const envelope = await response.json() as { ok: true; kind: string; result: { status: string; draftId: string; goalDesignPackageHash?: string } };
    assert.equal(envelope.kind, "planner-draft");
    assert.equal(envelope.result.status, "ready_for_review");
    assert.match(envelope.result.draftId, /^draft-goal-design-/);
    assert.match(envelope.result.goalDesignPackageHash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await db.close();
  }
});

test("POST /api/v2/planner/drafts/:draftId/revise edits a reviewable Goal Design draft", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const prepared = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      goalDesigner: inlineGoalDesigner(),
      composer: { compose: async (input) => goalDesignAwareComposition(input.goalContract) },
    }, {
      ...request("Add parser tests", "legacy-planner-revise-prepare-1"),
      cwd: process.cwd(),
    });
    assert.ok(prepared.goalDesignPackageHash);

    const response = await handleRuntimeRoute({
      ...runtimeContext(db, "Add parser tests"),
      goalDesigner: revisingGoalDesigner(),
    }, new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${prepared.draftId}/revise`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "tighten the slice plan",
          expectedPackageHash: prepared.goalDesignPackageHash,
        }),
      },
    ));

    assert.equal(response.status, 200);
    const envelope = await response.json() as { ok: true; kind: string; result: { kind: string; draftStatus: string; changedSliceIds: string[] } };
    assert.equal(envelope.kind, "goal-design-revision");
    assert.equal(envelope.result.kind, "revision");
    assert.equal(envelope.result.draftStatus, "ready_for_review");
    assert.deepEqual(envelope.result.changedSliceIds, ["slice-implementation"]);
  } finally {
    await db.close();
  }
});

test("POST /api/v2/planner/drafts/:draftId/confirm-goal-design returns the confirmed run result", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const prepared = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      goalDesigner: inlineGoalDesigner(),
      composer: { compose: async (input) => goalDesignAwareComposition(input.goalContract) },
    }, {
      ...request("Add parser tests", "goal-confirm-route-prepare-1"),
      cwd: "/tmp",
    });

    const response = await handleRuntimeRoute(runtimeContextWithInterpreter(
      db,
      fixedGoalInterpreter(goalContract("Add parser tests")),
      { compose: async (input) => goalDesignAwareComposition(input.goalContract) },
    ), new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${prepared.draftId}/confirm-goal-design`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPackageHash: prepared.goalDesignPackageHash }),
      },
    ));

    assert.equal(response.status, 200);
    const envelope = await response.json() as { ok: true; kind: string; result: { draftStatus: string; runStatus?: string; goalDesignPackageHash?: string } };
    assert.equal(envelope.kind, "goal-design-confirmation");
    assert.equal(envelope.result.draftStatus, "validated");
    assert.equal(envelope.result.runStatus, "scheduling");
    assert.equal(envelope.result.goalDesignPackageHash, prepared.goalDesignPackageHash);
  } finally {
    await db.close();
  }
});

test("confirmed single-DAG run result preserves source requirement lineage", async () => {
  const db = await createTestPostgresDb();
  const cwd = await mkdtemp("/tmp/southstar-single-dag-");
  const projectRef = "source-project";
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const sourceContract = goalContract("Add parser tests");
    const sourceDraft = finalizeGoalRequirementDraft({
      goalPrompt: sourceContract.originalPrompt,
      cwd,
      projectRef,
      summary: "A source requirement draft for the composed DAG.",
      requirements: [{
        title: "Parser tests",
        statement: "Parser tests cover the requested behavior.",
        source: "explicit",
        blocking: true,
        userVisibleBehaviors: ["Parser behavior is verified."],
        businessRules: [],
        acceptanceCriteria: [{ statement: "Parser tests pass.", evidenceIntent: ["test output"] }],
        expectedOutcomeArtifacts: [{ description: "Verification report", mediaType: "text/markdown" }],
        verificationIntent: ["Run the parser test suite."],
        assumptions: [],
        openQuestions: [],
        riskTags: [],
        interactionContractRefs: [],
      }],
      nonGoals: [],
      blockingInputs: [],
    } satisfies GoalRequirementDraftInputV1);
    const sourceDraftId = "draft-goal-requirements-source-run";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: sourceDraftId,
      scope: "planner",
      status: "validation_ready",
      payload: {
        goalRequirementDraftId: sourceDraftId,
        goalRequirementDraft: sourceDraft,
        goalRequirementDraftHash: sourceDraft.draftHash,
        goalDesignPhase: "validation_ready",
        goalContract: sourceContract,
        goalContractHash: goalContractHash(sourceContract),
      },
      summary: { goalRequirementDraftId: sourceDraftId, goalRequirementDraftHash: sourceDraft.draftHash },
    });

    const prepared = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(sourceContract),
      goalDesigner: inlineGoalDesigner(),
      composer: { compose: async (input) => goalDesignAwareComposition(input.goalContract) },
    }, {
      ...request("Add parser tests", "single-dag-source-lineage-1"),
      cwd,
      projectRef,
    });
    assert.equal(prepared.draftStatus, "ready_for_review");
    await db.query(
      `update southstar.runtime_resources
          set payload_json = payload_json || jsonb_build_object(
            'goalRequirementDraftId', $2::text,
            'goalRequirementDraftHash', $3::text,
            'plannerRequest', payload_json->'plannerRequest' || jsonb_build_object(
              'goalRequirementDraftId', $2::text,
              'goalRequirementDraftHash', $3::text
            )
          ),
          updated_at = now()
        where resource_type = 'planner_draft' and resource_key = $1`,
      [prepared.draftId, sourceDraftId, sourceDraft.draftHash],
    );

    const result = await confirmGoalDesignPg({
      db,
      goalInterpreter: fixedGoalInterpreter(sourceContract),
      goalDesigner: inlineGoalDesigner(),
      composer: { compose: async (input) => goalDesignAwareComposition(input.goalContract) },
    }, { draftId: prepared.draftId, expectedPackageHash: prepared.goalDesignPackageHash! });
    assert.equal(result.goalRequirementDraftId, sourceDraftId);
    assert.equal(result.goalRequirementDraftHash, sourceDraft.draftHash);
    assert.ok(result.runId);
    const run = await db.one<{ runtime_context_json: Record<string, unknown> }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      [result.runId],
    );
    assert.equal(run.runtime_context_json.goalRequirementDraftId, sourceDraftId);
    assert.equal(run.runtime_context_json.goalRequirementDraftHash, sourceDraft.draftHash);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await db.close();
  }
});

test("POST /api/v2/planner/drafts/:draftId/confirm-goal-design streams the same result envelope", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const prepared = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      goalDesigner: inlineGoalDesigner(),
      composer: { compose: async (input) => goalDesignAwareComposition(input.goalContract) },
    }, {
      ...request("Add parser tests", "goal-confirm-route-sse-prepare-1"),
      cwd: "/tmp",
    });

    const response = await handleRuntimeRoute(runtimeContextWithInterpreter(
      db,
      fixedGoalInterpreter(goalContract("Add parser tests")),
      { compose: async (input) => goalDesignAwareComposition(input.goalContract) },
    ), new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${prepared.draftId}/confirm-goal-design`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ expectedPackageHash: prepared.goalDesignPackageHash }),
      },
    ));

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const frames = parseFrames(await response.text());
    assert.equal(frames.some((frame) => frame.event === "draft"), true);
    assert.equal(frames.some((frame) => frame.event === "run"), true);
    assert.equal(frames.some((frame) => frame.event === "approval"), true);
    assert.equal(frames.some((frame) => frame.event === "dag"), true);
    assert.equal(frames.at(-1)?.event, "done");
    const done = frames.at(-1)?.data as { draftStatus?: string; runStatus?: string; goalDesignPackageHash?: string };
    assert.equal(done.draftStatus, "validated");
    assert.equal(done.runStatus, "scheduling");
    assert.equal(done.goalDesignPackageHash, prepared.goalDesignPackageHash);
  } finally {
    await db.close();
  }
});

test("POST /api/v2/planner/drafts/:draftId/confirm-goal-design maps stale hash to 409", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const prepared = await submitGoalPg({
      db,
      goalInterpreter: fixedGoalInterpreter(goalContract("Add parser tests")),
      goalDesigner: inlineGoalDesigner(),
      composer: { compose: async (input) => goalDesignAwareComposition(input.goalContract) },
    }, {
      ...request("Add parser tests", "goal-confirm-route-stale-prepare-1"),
      cwd: "/tmp",
    });

    const response = await handleRuntimeRoute(runtimeContextWithInterpreter(
      db,
      fixedGoalInterpreter(goalContract("Add parser tests")),
      { compose: async (input) => goalDesignAwareComposition(input.goalContract) },
    ), new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${prepared.draftId}/confirm-goal-design`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPackageHash: "0".repeat(64) }),
      },
    ));

    assert.equal(response.status, 409);
    assert.match(await response.text(), /goal_design_package_stale/);
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
    await seedGoalDesignSkill(db);
    const context = runtimeContextWithInterpreter(db, {
      async interpret() {
        entered.resolve();
        await release.promise;
        return goalContract("Add parser tests");
      },
    });
    const activeRequest = { ...request("Add parser tests", "goal-json-status-1"), cwd: process.cwd() };
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
    await seedGoalDesignSkill(db);
    const context = runtimeContextWithInterpreter(db, {
      async interpret() {
        entered.resolve();
        await release.promise;
        return goalContract("Add parser tests");
      },
    });
    const activeRequest = { ...request("Add parser tests", "goal-sse-status-1"), cwd: process.cwd() };
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
      workType: "software_feature",
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

function perSliceGoalContract(goalPrompt: string, cwd: string): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt,
    cwd,
    interpretation: {
      domain: "software",
      intent: "implement_feature",
      workType: "software_feature",
      summary: goalPrompt,
      requirements: [
        {
          statement: "Implement account access control",
          acceptanceCriteria: ["account access control passes verification"],
          blocking: true,
          source: "explicit",
          expectedArtifacts: [{ description: "Account implementation report", path: "account.md", mediaType: "text/markdown" }],
        },
        {
          statement: "Implement billing state transitions",
          acceptanceCriteria: ["billing state transitions pass verification"],
          blocking: true,
          source: "explicit",
          expectedArtifacts: [{ description: "Billing implementation report", path: "billing.md", mediaType: "text/markdown" }],
        },
      ],
      expectedArtifactRefs: ["artifact.account_report", "artifact.billing_report"],
      requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
      nonGoals: [],
      assumptions: [],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: ["workspace-write"],
    },
  });
}

async function seedGoalDesignSkill(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey: "skill.southstar-goal-design",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.southstar-goal-design@test",
    state: {
      purpose: "goal_design",
      body: "Design the smallest cohesive outcome slices and return the host schema.",
    },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "library_readiness",
    resourceKey: "library-readiness:current",
    scope: "runtime",
    status: "ready",
    title: "Current Library readiness",
    payload: {
      schemaVersion: "southstar.library_readiness.v1",
      ready: true,
      status: "ready",
      snapshotHash: "test-ready",
      sourceRoot: "/workspace/software/library",
      reconciledAt: new Date().toISOString(),
      trigger: "startup",
      includedCount: 1,
      excludedCount: 0,
      diagnostics: [],
    },
    summary: "ready",
    metrics: { included: 1, excluded: 0 },
  });
}

function inlineGoalDesigner(): GoalDesigner {
  return {
    async design(input) {
      return goalDesignPackage({
        goalContract: input.goalContract,
        mode: input.mode,
        templatePolicy: input.templatePolicy,
        skill: input.skill,
        workspaceDiscoveryHash: input.workspaceDiscovery.discoveryHash,
      });
    },
    async revise() {
      throw new Error("revise not used");
    },
  };
}

function revisingGoalDesigner(): GoalDesigner {
  const base = inlineGoalDesigner();
  return {
    ...base,
    async revise(input) {
      const slice = input.currentPackage.slicePlan.slices[0]!;
      const nextRevision = input.currentPackage.revision + 1;
      const next = finalizeGoalDesignPackage({
        schemaVersion: "southstar.goal_design_package.v1",
        revision: nextRevision,
        parentRevision: input.currentPackage.revision,
        goalContract: input.currentPackage.goalContract,
        evaluatorContracts: input.currentPackage.evaluatorContracts,
        slicePlan: {
          schemaVersion: "southstar.goal_slice_plan.v1",
          goalContractHash: "host-filled",
          revision: nextRevision,
          slices: [{ ...slice, outcome: `${slice.outcome} (revised)` }],
        },
        compositionStrategy: input.currentPackage.compositionStrategy,
        templatePolicy: input.currentPackage.templatePolicy,
        goalDesignSkillRef: input.currentPackage.goalDesignSkillRef,
        goalDesignSkillVersionRef: input.currentPackage.goalDesignSkillVersionRef,
        workspaceDiscoveryHash: input.currentPackage.workspaceDiscoveryHash,
        mode: input.currentPackage.mode,
      });
      return { kind: "revision", package: next, summary: "Revised slice plan.", changedSliceIds: [slice.id] };
    },
  };
}

function perSliceGoalDesigner(): GoalDesigner {
  return {
    async design(input) {
      return perSliceGoalDesignPackage({
        goalContract: input.goalContract,
        mode: input.mode,
        templatePolicy: input.templatePolicy,
        skill: input.skill,
        workspaceDiscoveryHash: input.workspaceDiscovery.discoveryHash,
      });
    },
    async revise() {
      throw new Error("revise not used");
    },
  };
}

function goalDesignPackage(input: {
  goalContract: GoalContractV1;
  mode: GoalDesignMode;
  templatePolicy: WorkflowTemplatePolicyV1;
  skill: ResolvedGoalDesignSkillV1;
  workspaceDiscoveryHash: string;
}) {
  const requirement = input.goalContract.requirements[0]!;
  const artifactRef = input.goalContract.expectedArtifactRefs[0]!;
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: 1,
    goalContract: input.goalContract,
    evaluatorContracts: [{
      schemaVersion: "southstar.requirement_evaluator_contract.v1",
      id: "eval-implementation",
      requirementId: requirement.id,
      acceptanceCriteria: [...requirement.acceptanceCriteria],
      requiredEvidenceKinds: ["test_result"],
      independence: "independent",
      failureClassifications: ["implementation_gap"],
    }],
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: 1,
      slices: [{
        id: "slice-implementation",
        requirementIds: [requirement.id],
        outcome: requirement.statement,
        stateOrArtifactOwner: artifactRef,
        mutationBoundary: "one cohesive implementation boundary",
        expectedArtifactRefs: [artifactRef],
        evaluatorContractRefs: ["eval-implementation"],
        dependsOnSliceIds: [],
        dependencyArtifactRefs: [],
      }],
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: ["slice-implementation"],
      rationale: "one atomic requirement boundary",
    },
    templatePolicy: input.templatePolicy,
    goalDesignSkillRef: input.skill.objectKey,
    goalDesignSkillVersionRef: input.skill.versionRef,
    workspaceDiscoveryHash: input.workspaceDiscoveryHash,
    mode: input.mode,
  });
}

function perSliceGoalDesignPackage(input: {
  goalContract: GoalContractV1;
  mode: GoalDesignMode;
  templatePolicy: WorkflowTemplatePolicyV1;
  skill: ResolvedGoalDesignSkillV1;
  workspaceDiscoveryHash: string;
}) {
  const [accountRequirement, billingRequirement] = input.goalContract.requirements;
  const [accountArtifactRef, billingArtifactRef] = input.goalContract.expectedArtifactRefs;
  assert.ok(accountRequirement);
  assert.ok(billingRequirement);
  assert.ok(accountArtifactRef);
  assert.ok(billingArtifactRef);
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: 1,
    goalContract: input.goalContract,
    evaluatorContracts: [
      {
        schemaVersion: "southstar.requirement_evaluator_contract.v1",
        id: "eval-account",
        requirementId: accountRequirement.id,
        acceptanceCriteria: [...accountRequirement.acceptanceCriteria],
        requiredEvidenceKinds: ["test_result"],
        independence: "independent",
        failureClassifications: ["implementation_gap"],
      },
      {
        schemaVersion: "southstar.requirement_evaluator_contract.v1",
        id: "eval-billing",
        requirementId: billingRequirement.id,
        acceptanceCriteria: [...billingRequirement.acceptanceCriteria],
        requiredEvidenceKinds: ["test_result"],
        independence: "independent",
        failureClassifications: ["implementation_gap"],
      },
    ],
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: 1,
      slices: [
        {
          id: "slice-account",
          requirementIds: [accountRequirement.id],
          outcome: accountRequirement.statement,
          stateOrArtifactOwner: "account",
          mutationBoundary: "account access control files",
          expectedArtifactRefs: [accountArtifactRef],
          evaluatorContractRefs: ["eval-account"],
          dependsOnSliceIds: [],
          dependencyArtifactRefs: [],
        },
        {
          id: "slice-billing",
          requirementIds: [billingRequirement.id],
          outcome: billingRequirement.statement,
          stateOrArtifactOwner: "billing",
          mutationBoundary: "billing state transition files",
          expectedArtifactRefs: [billingArtifactRef],
          evaluatorContractRefs: ["eval-billing"],
          dependsOnSliceIds: ["slice-account"],
          dependencyArtifactRefs: [accountArtifactRef],
        },
      ],
    },
    compositionStrategy: {
      mode: "per-slice-runs",
      sliceIds: ["slice-account", "slice-billing"],
      rationale: "Persist each independently owned slice as its own run while sharing cwd.",
    },
    templatePolicy: input.templatePolicy,
    goalDesignSkillRef: input.skill.objectKey,
    goalDesignSkillVersionRef: input.skill.versionRef,
    workspaceDiscoveryHash: input.workspaceDiscoveryHash,
    mode: input.mode,
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

function goalDesignAwareComposition(goalContract: GoalContractV1, sliceId = "slice-implementation") {
  const composition = deterministicFixtureComposition(goalContract);
  for (const task of composition.tasks) {
    (task as typeof task & { sliceId: string }).sliceId = sliceId;
  }
  return composition;
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

async function countGoalSubmissionClaims(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<number> {
  return Number((await db.one<{ count: string }>(
    "select count(*)::text as count from southstar.runtime_resources where resource_type = 'goal_submission'",
  )).count);
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

async function installRejectGoalCompletionConstraint(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  idempotencyKey: string,
): Promise<void> {
  await db.query(
    `create or replace function southstar.reject_goal_handoff_completion()
       returns trigger
       language plpgsql
       as $function$
       begin
         if new.resource_type = 'goal_submission'
            and new.resource_key = ${sqlLiteral(idempotencyKey)}
            and new.status = 'completed' then
           raise exception 'forced goal handoff rollback';
         end if;
         return new;
       end
       $function$`,
  );
  await db.query(
    `create constraint trigger reject_goal_handoff_completion
       after update on southstar.runtime_resources
       deferrable initially deferred
       for each row execute function southstar.reject_goal_handoff_completion()`,
  );
}

async function removeRejectGoalCompletionConstraint(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
): Promise<void> {
  await db.query("drop trigger if exists reject_goal_handoff_completion on southstar.runtime_resources");
  await db.query("drop function if exists southstar.reject_goal_handoff_completion()");
}

async function installRejectApprovalOutcomeConstraint(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  approvalId: string,
): Promise<void> {
  await db.query(
    `create or replace function southstar.reject_approval_handoff_completion()
       returns trigger
       language plpgsql
       as $function$
       begin
         if new.resource_type = 'approval'
            and new.resource_key = ${sqlLiteral(approvalId)}
            and new.payload_json->>'schedulingState' = 'completed' then
           raise exception 'forced approval handoff rollback';
         end if;
         return new;
       end
       $function$`,
  );
  await db.query(
    `create constraint trigger reject_approval_handoff_completion
       after update on southstar.runtime_resources
       deferrable initially deferred
       for each row execute function southstar.reject_approval_handoff_completion()`,
  );
}

async function removeRejectApprovalOutcomeConstraint(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
): Promise<void> {
  await db.query("drop trigger if exists reject_approval_handoff_completion on southstar.runtime_resources");
  await db.query("drop function if exists southstar.reject_approval_handoff_completion()");
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
  workflowComposer: WorkflowComposer = new DeterministicFixtureComposer(),
) {
  return {
    db,
    goalInterpreter,
    goalDesigner: inlineGoalDesigner(),
    workflowComposer,
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
