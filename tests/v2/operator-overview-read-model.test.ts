import assert from "node:assert/strict";
import test from "node:test";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { persistTerminalGoalOutcomePg } from "../../src/v2/evaluators/goal-outcome.ts";
import { finalizeGoalContract } from "../../src/v2/orchestration/goal-contract.ts";
import { buildOperatorOverviewReadModelPg } from "../../src/v2/read-models/operator-overview.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { DeterministicFixtureComposer, seedDeterministicWorkflowGraph } from "./fixtures/deterministic-workflow-composer.ts";
import { fixedGoalInterpreter } from "./fixtures/goal-contract.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("operator overview exposes mission axes and attention for goal approvals uncovered requirements failed requirements and dynamic repair approval", async () => {
  const db = await createTestPostgresDb();
  try {
    const goalContract = finalizeGoalContract({
      goalPrompt: "Ship an offline article and optional print stylesheet",
      cwd: "/workspace/article",
      interpretation: {
        domain: "software",
        intent: "implement_feature",
        summary: "Ship an offline article",
        requirements: [
          { statement: "The offline article renders", acceptanceCriteria: ["The article opens without network access"], blocking: true, source: "explicit" },
          { statement: "A print stylesheet is available", acceptanceCriteria: ["Printing uses a readable layout"], blocking: false, source: "explicit" },
        ],
        expectedArtifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
        requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
        nonGoals: [],
        assumptions: [],
        blockingInputs: [],
        riskTags: [],
        requestedSideEffects: ["workspace-write"],
      },
    });
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: goalContract.originalPrompt,
      cwd: goalContract.workspace.cwd,
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer: new DeterministicFixtureComposer(),
    });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const [blockingRequirement, optionalRequirement] = goalContract.requirements;
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{entries}',
            (select coalesce(jsonb_agg(entry), '[]'::jsonb)
               from jsonb_array_elements(payload_json->'entries') entry
              where entry->>'requirementId' <> $2))
        where resource_type = 'goal_requirement_coverage' and resource_key = $1`,
      [run.runId, optionalRequirement!.id],
    );
    await persistTerminalGoalOutcomePg(db, {
      runId: run.runId,
      outcomeStatus: "unsatisfied",
      failedRequirementIds: [blockingRequirement!.id],
      findings: ["blocking requirement failed"],
      actorType: "test",
      idempotencyKey: "operator-mission:unsatisfied",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "approval",
      resourceKey: "goal-approval",
      runId: run.runId,
      scope: "approval",
      status: "pending",
      payload: { approvalId: "goal-approval", actionType: "goalExecution" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "approval",
      resourceKey: "repair-approval",
      runId: run.runId,
      scope: "approval",
      status: "pending",
      payload: {
        approvalId: "repair-approval",
        actionType: "dynamic_repair_authority_expansion",
        schemaVersion: "southstar.dynamic_repair_authority_approval.v1",
      },
    });

    const model = await buildOperatorOverviewReadModelPg(db);
    const runRow = model.activeRuns.find((candidate) => candidate.runId === run.runId)!;
    assert.deepEqual({
      executionStatus: runRow.executionStatus,
      outcomeStatus: runRow.outcomeStatus,
      healthStatus: runRow.healthStatus,
    }, {
      executionStatus: "completed",
      outcomeStatus: "unsatisfied",
      healthStatus: "healthy",
    });
    assert.equal(runRow.mission!.goalContractHash, draft.goalContractHash);
    assert.equal(model.attentionItems.some((item) => item.id === `goal-requirement-uncovered:${run.runId}:${optionalRequirement!.id}`), true);
    assert.equal(model.attentionItems.some((item) => item.id === `goal-requirement-failed:${run.runId}:${blockingRequirement!.id}`), true);
    for (const approvalId of ["goal-approval", "repair-approval"]) {
      const attention = model.attentionItems.find((item) => item.id === `approval:${approvalId}`);
      assert.equal(attention?.commands.find((command) => command.id === "approval.approve")?.enabled, true);
      assert.equal(attention?.commands.find((command) => command.id === "approval.reject")?.enabled, true);
    }
  } finally {
    await db.close();
  }
});

test("operator overview mission query count stays bounded as run count grows", async () => {
  const db = await createTestPostgresDb();
  try {
    const goalContract = finalizeGoalContract({
      goalPrompt: "Build bounded mission projections",
      cwd: "/workspace/query-count",
      interpretation: {
        domain: "software",
        intent: "implement_feature",
        summary: "Build bounded mission projections",
        requirements: [{ statement: "Mission projections remain bounded", acceptanceCriteria: ["Twenty runs do not add per-run queries"], blocking: true, source: "explicit" }],
        expectedArtifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
        requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
        nonGoals: [], assumptions: [], blockingInputs: [], riskTags: [], requestedSideEffects: [],
      },
    });
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: goalContract.originalPrompt,
      cwd: goalContract.workspace.cwd,
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer: new DeterministicFixtureComposer(),
    });
    const runIds: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      runIds.push((await createPostgresRunFromDraft(db, { draftId: draft.draftId })).runId);
    }
    await db.query(
      "update southstar.workflow_runs set runtime_context_json = jsonb_set(runtime_context_json, '{projectRoot}', to_jsonb('/workspace/query-count-two'::text)) where id = any($1::text[])",
      [runIds.slice(0, 2)],
    );

    const two = countingDb(db);
    await buildOperatorOverviewReadModelPg(two.db, { projectRoot: "/workspace/query-count-two" });
    const twenty = countingDb(db);
    await buildOperatorOverviewReadModelPg(twenty.db);

    assert.equal(twenty.count(), two.count(), `query count grew from ${two.count()} for 2 runs to ${twenty.count()} for 20 runs`);
  } finally {
    await db.close();
  }
});

test("operator overview returns active runs and attention items", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-overview";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "operator overview",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-build", runId, taskKey: "Build", status: "running", sortOrder: 0, dependsOn: [] });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-operator",
      runId,
      taskId: "task-build",
      scope: "runtime",
      status: "observed",
      title: "Heartbeat lost",
      payload: { kind: "tork_running_hang", severity: "blocking", handExecutionId: "job-build" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "approval",
      resourceKey: "approval-operator",
      runId,
      taskId: "task-build",
      scope: "approval",
      status: "pending",
      title: "Approve recovery",
      payload: { actionType: "recovery" },
    });

    const model = await buildOperatorOverviewReadModelPg(db);
    assert.deepEqual(model.activeRuns.map((run) => run.runId), [runId]);
    assert.equal(model.attentionItems.some((item) => item.kind === "runtime_exception" && item.severity === "blocked"), true);
    assert.equal(model.attentionItems.some((item) => item.kind === "approval" && item.severity === "warning"), true);
    assert.equal(model.defaultSelection?.runId, runId);
  } finally {
    await db.close();
  }
});

test("operator overview keeps failed runs visible when unresolved attention exists", async () => {
  const db = await createTestPostgresDb();
  try {
    const visibleRunId = "run-operator-failed-visible";
    await createWorkflowRunPg(db, {
      id: visibleRunId,
      status: "failed",
      domain: "software",
      goalPrompt: "failed run with unresolved exception",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: JSON.stringify({ cwd: "/home/timmypai/apps/southstar", projectRoot: "/home/timmypai/apps/southstar" }),
      metricsJson: "{}",
    });
    await createWorkflowRunPg(db, {
      id: "run-operator-failed-quiet",
      status: "failed",
      domain: "software",
      goalPrompt: "failed run without unresolved attention",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-failed-visible",
      runId: visibleRunId,
      taskId: "task-implement",
      scope: "runtime",
      status: "observed",
      title: "Queue timeout",
      payload: { kind: "tork_queue_timeout", severity: "recoverable" },
    });

    const model = await buildOperatorOverviewReadModelPg(db);

    assert.equal(model.activeRuns.some((run) => run.runId === visibleRunId && run.status === "failed"), true);
    assert.equal(model.activeRuns.some((run) => run.runId === "run-operator-failed-quiet"), false);
    assert.equal(model.attentionItems.some((item) => item.runId === visibleRunId && item.kind === "runtime_exception"), true);
    assert.equal(model.defaultSelection?.runId, visibleRunId);
  } finally {
    await db.close();
  }
});

test("operator overview does not enable retry for runtime exceptions on completed tasks", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-completed-exception";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "failed",
      domain: "software",
      goalPrompt: "failed run with stale callback",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-done", runId, taskKey: "Done", status: "completed", sortOrder: 0, dependsOn: [] });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-completed-task",
      runId,
      taskId: "task-done",
      scope: "runtime",
      status: "observed",
      title: "Stale callback",
      payload: { kind: "stale_callback", severity: "warning" },
    });

    const model = await buildOperatorOverviewReadModelPg(db);
    const exception = model.attentionItems.find((item) => item.id === "runtime_exception:runtime-exception-completed-task");
    const retry = exception?.commands.find((command) => command.id === "task.retry");

    assert.equal(exception?.severity, "warning");
    assert.equal(retry?.enabled, false);
    assert.equal(retry?.disabledReason, "task status completed does not allow retry");
  } finally {
    await db.close();
  }
});

test("operator overview keeps recently passed runs visible after refresh without counting them active", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-passed-visible";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "passed",
      domain: "software",
      goalPrompt: "recently passed run",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: JSON.stringify({ cwd: "/home/timmypai/apps/southstar", projectRoot: "/home/timmypai/apps/southstar" }),
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-done", runId, taskKey: "Done", status: "completed", sortOrder: 0, dependsOn: [] });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-passed-stale-callback",
      runId,
      taskId: "task-done",
      scope: "runtime",
      status: "observed",
      title: "Late callback",
      payload: { kind: "stale_callback", severity: "warning" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "hand_execution",
      resourceKey: "hand-execution-passed-lost",
      runId,
      taskId: "task-done",
      scope: "hand",
      status: "lost",
      title: "Superseded hand execution",
      payload: { externalJobId: "job-old-attempt", lostReason: "reprovision-hand" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "recovery_decision",
      resourceKey: "recovery-passed-applied",
      runId,
      taskId: "task-done",
      scope: "recovery",
      status: "applied",
      title: "Applied recovery",
      payload: { decisionId: "recovery-passed-applied", path: "reprovision-hand" },
    });

    const model = await buildOperatorOverviewReadModelPg(db);

    assert.equal(model.activeRuns.some((run) => run.runId === runId && run.status === "passed"), true);
    assert.equal(model.runtimeHealth.activeRunCount, 0);
    assert.equal(model.runtimeHealth.attentionCount, 0);
    assert.equal(model.attentionItems.some((item) => item.runId === runId), false);
    assert.equal(model.defaultSelection?.runId, runId);
  } finally {
    await db.close();
  }
});

test("operator overview keeps cancelled runs visible after operator cancel without counting them active", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-cancelled-visible";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "cancelled",
      domain: "software",
      goalPrompt: "cancelled run",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const model = await buildOperatorOverviewReadModelPg(db);

    assert.equal(model.activeRuns.some((run) => run.runId === runId && run.status === "cancelled"), true);
    assert.equal(model.runtimeHealth.activeRunCount, 0);
    assert.equal(model.runtimeHealth.attentionCount, 0);
    assert.equal(model.attentionItems.some((item) => item.runId === runId), false);
    assert.equal(model.defaultSelection?.runId, runId);
  } finally {
    await db.close();
  }
});

test("operator overview disables managed recovery decisions because runtime applies them internally", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-managed-recovery";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "failed",
      domain: "software",
      goalPrompt: "failed run with managed recovery",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "recovery_decision",
      resourceKey: "managed-recovery:run-operator-managed-recovery:task-a",
      runId,
      taskId: "task-a",
      scope: "recovery",
      status: "recorded",
      title: "Managed recovery",
      payload: { schemaVersion: "southstar.managed-recovery-decision.v1", path: "reprovision-hand", reason: "managed recovery" },
    });

    const model = await buildOperatorOverviewReadModelPg(db);
    const recovery = model.attentionItems.find((item) => item.id === "recovery_decision:managed-recovery:run-operator-managed-recovery:task-a");
    const apply = recovery?.commands.find((command) => command.id === "recovery.apply");

    assert.equal(apply?.enabled, false);
    assert.equal(apply?.disabledReason, "managed recovery decisions are applied by the runtime loop");
  } finally {
    await db.close();
  }
});

test("operator overview does not count normal running executions as attention", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-normal-running";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "normal running execution",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-running", runId, taskKey: "Run", status: "running", sortOrder: 0, dependsOn: [] });
    await upsertRuntimeResourcePg(db, {
      resourceType: "hand_execution",
      resourceKey: "hand-execution-running",
      runId,
      taskId: "task-running",
      scope: "hand",
      status: "running",
      title: "Hand execution running",
      payload: { externalJobId: "job-running", attemptId: "attempt-running" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "executor-binding-queued",
      runId,
      taskId: "task-running",
      scope: "executor",
      status: "queued",
      title: "Executor binding queued",
      payload: { torkJobId: "job-queued", attemptId: "attempt-queued" },
    });

    const model = await buildOperatorOverviewReadModelPg(db);

    assert.equal(model.activeRuns.some((run) => run.runId === runId && run.status === "running"), true);
    assert.equal(model.runtimeHealth.activeRunCount, 1);
    assert.equal(model.runtimeHealth.attentionCount, 0);
    assert.equal(model.attentionItems.some((item) => item.runId === runId), false);
    assert.equal(model.defaultSelection?.runId, runId);
  } finally {
    await db.close();
  }
});

test("operator overview classifies all operator attention sources from runtime state", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-taxonomy";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "operator taxonomy",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowRunPg(db, {
      id: "run-operator-paused",
      status: "paused",
      domain: "software",
      goalPrompt: "paused run needs operator watch",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-running", runId, taskKey: "Run", status: "running", sortOrder: 0, dependsOn: [] });
    await createWorkflowTaskPg(db, { id: "task-blocked", runId, taskKey: "Blocked", status: "blocked", sortOrder: 1, dependsOn: ["task-running"] });
    await createWorkflowTaskPg(db, { id: "task-failed", runId, taskKey: "Failed", status: "failed", sortOrder: 2, dependsOn: ["task-running"] });

    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "exception-taxonomy",
      runId,
      taskId: "task-blocked",
      scope: "runtime",
      status: "observed",
      title: "Runtime exception observed",
      payload: { exceptionId: "exception-taxonomy", kind: "task_runtime_exception", severity: "blocking", message: "task failed" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "approval",
      resourceKey: "approval-taxonomy",
      runId,
      taskId: "task-running",
      scope: "approval",
      status: "pending",
      title: "Approval required",
      payload: { approvalId: "approval-taxonomy", actionType: "run.pause" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "recovery_decision",
      resourceKey: "recovery-taxonomy",
      runId,
      taskId: "task-blocked",
      scope: "recovery",
      status: "waiting_operator_approval",
      title: "Recovery decision waiting",
      payload: { decisionId: "recovery-taxonomy", path: "retry-same-task-new-attempt", reason: "retry after failure" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "recovery_decision",
      resourceKey: "recovery-approved-taxonomy",
      runId,
      taskId: "task-blocked",
      scope: "recovery",
      status: "approved",
      title: "Recovery decision approved",
      payload: { decisionId: "recovery-approved-taxonomy", path: "retry-same-task-new-attempt", reason: "approved retry" },
    });
    for (const [resourceKey, status, taskId, jobId] of [
      ["executor-heartbeat", "heartbeat-lost", "task-running", "job-heartbeat"],
      ["executor-queue", "queue-timeout", "task-running", "job-queue"],
      ["executor-callback", "callback-missing", "task-running", "job-callback"],
    ] as const) {
      await upsertRuntimeResourcePg(db, {
        resourceType: "executor_binding",
        resourceKey,
        runId,
        taskId,
        scope: "executor",
        status,
        title: `Executor ${status}`,
        payload: {
          bindingId: resourceKey,
          runId,
          taskId,
          attemptId: `${resourceKey}-attempt`,
          executorType: "tork",
          torkJobId: jobId,
          southstarExecutorStatus: status,
          submittedAt: "2026-06-25T00:00:00.000Z",
          queueTimeoutAt: "2026-06-25T00:01:00.000Z",
          heartbeatTimeoutAt: "2026-06-25T00:02:00.000Z",
          hardTimeoutAt: "2026-06-25T00:10:00.000Z",
          reconcileGeneration: 1,
          idempotencyKey: `${resourceKey}-idem`,
        },
      });
    }
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_command",
      resourceKey: "ui:cancel-rejected",
      runId,
      taskId: "task-running",
      scope: "operator",
      status: "blocked",
      title: "Cancel rejected",
      payload: {
        result: {
          commandId: "ui:cancel-rejected",
          accepted: false,
          status: "blocked",
          affectedRunId: runId,
          affectedTaskId: "task-running",
          resourceRefs: [],
          eventRefs: [],
          nextSuggestedActions: ["watch-events"],
          message: "execution cannot cancel from terminal status completed",
        },
      },
    });

    const model = await buildOperatorOverviewReadModelPg(db);
    const signatures = model.attentionItems.map((item) => `${item.kind}:${item.status}:${item.interventionMode}`);
    for (const expected of [
      "runtime_exception:observed:exception",
      "approval:pending:approval",
      "recovery_decision:waiting_operator_approval:recovery",
      "recovery_decision:approved:recovery",
      "executor_binding:heartbeat-lost:executor",
      "executor_binding:queue-timeout:executor",
      "executor_binding:callback-missing:executor",
      "task:blocked:task",
      "task:failed:task",
      "run:paused:run",
    ]) {
      assert.equal(signatures.includes(expected), true, `missing attention signature ${expected}; saw ${signatures.join(", ")}`);
    }

    const executor = model.attentionItems.find((item) => item.id === "executor_binding:executor-heartbeat");
    assert.equal(executor?.source.resourceType, "executor_binding");
    assert.equal(executor?.source.resourceKey, "executor-heartbeat");
    assert.equal(executor?.detail.torkJobId, "job-heartbeat");
    assert.equal(executor?.commands.some((command) =>
      command.id === "executor.reconcile"
      && command.endpoint === `/api/v2/runs/${runId}/executor-jobs/job-heartbeat/reconcile`
      && command.requiresConfirmation === false
    ), true);
    assert.equal(executor?.commands.some((command) =>
      command.id === "executor.cancel"
      && command.endpoint === `/api/v2/runs/${runId}/executor-jobs/job-heartbeat/cancel`
      && command.requiresConfirmation === true
    ), true);

    const blockedTask = model.attentionItems.find((item) => item.id === "task:task-blocked");
    assert.equal(blockedTask?.detail.taskKey, "Blocked");
    assert.equal(blockedTask?.commands.some((command) =>
      command.id === "task.retry"
      && command.endpoint === `/api/v2/runs/${runId}/tasks/task-blocked/retry`
      && command.requiresConfirmation === true
    ), true);

    const approvedRecovery = model.attentionItems.find((item) => item.id === "recovery_decision:recovery-approved-taxonomy");
    assert.equal(approvedRecovery?.commands.some((command) =>
      command.id === "recovery.apply"
      && command.endpoint === `/api/v2/runs/${runId}/recovery-decisions/recovery-approved-taxonomy/apply`
      && command.enabled === true
      && command.requiresConfirmation === true
    ), true);

    assert.equal(model.commandResults.some((result) =>
      result.commandId === "ui:cancel-rejected"
      && result.status === "blocked"
      && result.message === "execution cannot cancel from terminal status completed"
    ), true);
  } finally {
    await db.close();
  }
});

test("ui route exposes /api/v2/ui/operator-overview", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-overview-route";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "operator overview route",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-operator-route",
      runId,
      scope: "runtime",
      status: "observed",
      payload: { kind: "scheduler_claim_stale", severity: "blocking" },
    });

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/ui/operator-overview`);
      assert.equal(response.status, 200);
      const envelope = await response.json() as { ok: true; kind: string; result: Awaited<ReturnType<typeof buildOperatorOverviewReadModelPg>> };
      assert.equal(envelope.kind, "ui-operator-overview");
      assert.equal(envelope.result.activeRuns[0]?.runId, runId);
      assert.equal(envelope.result.attentionItems.some((item) => item.kind === "runtime_exception"), true);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

test("operator overview route forwards projectRoot and isolates runs attention and command results", async () => {
  const db = await createTestPostgresDb();
  try {
    for (const project of ["A", "B"] as const) {
      const runId = `run-route-project-${project}`;
      await createWorkflowRunPg(db, {
        id: runId,
        status: "running",
        domain: "software",
        goalPrompt: `project ${project}`,
        workflowManifestJson: "{}",
        executionProjectionJson: "{}",
        snapshotJson: "{}",
        runtimeContextJson: JSON.stringify({ cwd: `/workspace/${project}`, projectRoot: `/workspace/${project}` }),
        metricsJson: "{}",
      });
      await upsertRuntimeResourcePg(db, {
        resourceType: "runtime_exception",
        resourceKey: `route-project-${project}-exception`,
        runId,
        scope: "runtime",
        status: "observed",
        payload: { kind: "scheduler_claim_stale", severity: "blocking" },
      });
      await upsertRuntimeResourcePg(db, {
        resourceType: "runtime_command",
        resourceKey: `route-project-${project}-command`,
        runId,
        scope: "operator",
        status: "accepted",
        payload: { result: { commandId: `project-${project}`, accepted: true, status: "accepted", affectedRunId: runId, resourceRefs: [], eventRefs: [], nextSuggestedActions: [] } },
      });
    }
    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/ui/operator-overview?projectRoot=${encodeURIComponent("/workspace/A")}`);
      const envelope = await response.json() as { result: Awaited<ReturnType<typeof buildOperatorOverviewReadModelPg>> };
      assert.deepEqual(envelope.result.scope, { kind: "project", projectRoot: "/workspace/A" });
      assert.deepEqual(envelope.result.activeRuns.map((run) => run.runId), ["run-route-project-A"]);
      assert.deepEqual([...new Set(envelope.result.attentionItems.map((item) => item.runId))], ["run-route-project-A"]);
      assert.deepEqual(envelope.result.commandResults.map((result) => result.affectedRunId), ["run-route-project-A"]);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

function countingDb(db: SouthstarDb): { db: SouthstarDb; count(): number } {
  let count = 0;
  return {
    db: new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if ((property === "query" || property === "one" || property === "maybeOne") && typeof value === "function") {
          return (...args: unknown[]) => {
            count += 1;
            return Reflect.apply(value, target, args);
          };
        }
        return value;
      },
    }),
    count: () => count,
  };
}
