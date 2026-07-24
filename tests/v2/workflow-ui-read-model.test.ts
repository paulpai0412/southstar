import assert from "node:assert/strict";
import test from "node:test";
import { persistTerminalGoalOutcomePg } from "../../src/v2/evaluators/goal-outcome.ts";
import { recordRuntimeExceptionPg } from "../../src/v2/exceptions/postgres-runtime-exceptions.ts";
import { runtimeAttemptNumber } from "../../src/v2/executor/attempt-identity.ts";
import { inspectRunPg } from "../../src/v2/inspection/postgres-inspect-run.ts";
import { buildWorkflowLineageReadModel, buildWorkflowUiReadModelPg, hasDegradedProviderHealth } from "../../src/v2/read-models/workflow-ui.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { DeterministicFixtureComposer, seedDeterministicWorkflowGraph } from "./fixtures/deterministic-workflow-composer.ts";
import { fixedGoalInterpreter, softwareGoalContract } from "./fixtures/goal-contract.ts";
import { canonicalGoalDesignPackageFixture } from "./fixtures/goal-design.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { goalContractHash } from "../../src/v2/orchestration/goal-contract.ts";

test("runtime attempt identity extracts the canonical monotonic attempt number", () => {
  assert.equal(runtimeAttemptNumber("task-build-attempt-2"), 2);
  assert.equal(runtimeAttemptNumber("hand-execution:run:task:task-build-attempt-12"), 12);
  assert.equal(runtimeAttemptNumber("task-attempt-2:retry-attempt-3"), 3);
  assert.equal(runtimeAttemptNumber("legacy-attempt"), 0);
});

test("provider health uses update order only within the effective attempt", () => {
  assert.equal(hasDegradedProviderHealth([
    {
      resourceKey: "binding-attempt-2",
      taskId: "task-build",
      status: "hard-timeout",
      payload: { attemptId: "task-build-attempt-2" },
      updatedAt: "2026-07-11T00:00:00.000Z",
    },
    {
      resourceKey: "hand-attempt-2",
      taskId: "task-build",
      status: "completed",
      payload: { attemptId: "task-build-attempt-2" },
      updatedAt: "2026-07-11T00:01:00.000Z",
    },
  ]), false);
});

test("provider health preserves noncanonical identities alongside canonical attempts", () => {
  const observations = [
    {
      resourceKey: "binding-attempt-1",
      taskId: "task-build",
      status: "completed",
      payload: { attemptId: "task-build-attempt-1" },
      updatedAt: "2026-07-11T00:00:00.000Z",
    },
    {
      resourceKey: "legacy-retry-timeout",
      taskId: "task-build",
      status: "hard-timeout",
      payload: { attemptId: "legacy-retry" },
      updatedAt: "2026-07-11T00:01:00.000Z",
    },
  ];

  assert.equal(hasDegradedProviderHealth(observations), true);

  observations.push({
    resourceKey: "legacy-retry-completed",
    taskId: "task-build",
    status: "completed",
    payload: { attemptId: "legacy-retry" },
    updatedAt: "2026-07-11T00:02:00.000Z",
  });
  assert.equal(hasDegradedProviderHealth(observations), false);
});

test("workflow lineage keeps the latest evaluator attempt instead of letting history overwrite it", () => {
  const goalContract = softwareGoalContract("latest evaluator attempt wins");
  const requirement = goalContract.requirements[0]!;
  const criterion = requirement.acceptanceCriteria[0]!;
  const coverage = {
    schemaVersion: "southstar.goal_requirement_coverage.v1" as const,
    goalContractHash: goalContractHash(goalContract),
    entries: [{
      requirementId: requirement.id,
      producerTaskIds: ["task-producer"],
      artifactRefs: ["artifact.implementation_report"],
      evaluatorTaskIds: ["task-evaluator"],
      evaluatorProfileRefs: ["evaluator.test"],
      evaluatorProfileVersionRefs: ["evaluator.test@1"],
      validationBindingId: "binding-test",
      criterionBindings: [{
        criterionId: criterion.id,
        criterionVersion: criterion.version,
        blocking: true,
        artifactContractRef: "artifact.implementation_report",
        artifactContractVersionRef: "artifact.implementation_report@1",
        evaluatorProfileRef: "evaluator.test",
        evaluatorProfileVersionRef: "evaluator.test@1",
        verificationMode: "deterministic" as const,
        procedureRef: "procedure.test",
        expectedEvidenceKinds: ["test-result" as const],
      }],
      criterionIds: [criterion.id],
      acceptanceCriteria: [criterion.observableClaim],
      requiredEvidenceKinds: ["test-result" as const],
    }],
  };

  const lineage = buildWorkflowLineageReadModel({
    graphId: "run-latest-evaluator",
    mode: "runtime",
    slicePlan: undefined,
    workflowTasks: [],
    nodes: [],
    edges: [],
    goalContract,
    coverage,
    evaluatorResults: [
      {
        schemaVersion: "southstar.requirement_evaluator_result.v2",
        requirementId: requirement.id,
        evaluatorTaskId: "task-evaluator",
        attemptId: "task-evaluator-attempt-2",
        criteriaResults: [{ criterionId: criterion.id, verificationMode: "deterministic", verdict: "passed", evidenceRefs: ["evidence-latest"] }],
        evidenceRefs: ["evidence-latest"],
      },
      {
        schemaVersion: "southstar.requirement_evaluator_result.v2",
        requirementId: requirement.id,
        evaluatorTaskId: "task-evaluator",
        attemptId: "task-evaluator-attempt-1",
        criteriaResults: [{ criterionId: criterion.id, verificationMode: "deterministic", verdict: "blocked", evidenceRefs: ["evidence-old"] }],
        evidenceRefs: ["evidence-old"],
      },
    ],
    completionStatus: "satisfied",
  });

  assert.equal(lineage.chain.criteria[0]?.status, "passed");
  assert.equal(lineage.chain.checks[0]?.status, "passed");
  assert.deepEqual(lineage.chain.evidence.map((item) => item.ref), ["evidence-latest"]);
});

test("run inspection does not keep superseded failed tasks as current blockers", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-inspection-superseded-task";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "completed",
      domain: "software",
      goalPrompt: "ignore superseded validation failure",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "task-producer",
      runId,
      taskKey: "producer",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
    });
    await createWorkflowTaskPg(db, {
      id: "task-verify-original",
      runId,
      taskKey: "verify-original",
      status: "failed",
      sortOrder: 1,
      dependsOn: [],
    });
    await createWorkflowTaskPg(db, {
      id: "task-verify-retry",
      runId,
      taskKey: "verify-retry",
      status: "completed",
      sortOrder: 2,
      dependsOn: [],
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "workflow_dynamic_repair_revision",
      resourceKey: `workflow-dynamic-repair:${runId}:attempt-1`,
      runId,
      scope: "run",
      status: "applied",
      payload: {
        rootFailedTaskId: "task-verify-original",
        originalFailedTaskId: "task-verify-original",
        newTaskIds: ["task-verify-retry"],
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: "artifact-ref-original-rejected",
      runId,
      taskId: "task-verify-original",
      scope: "artifact",
      status: "rejected",
      payload: {
        runId,
        taskId: "task-verify-original",
        artifactRefId: "artifact-ref-original-rejected",
        attemptId: "task-verify-original-attempt-1",
        status: "rejected",
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: "artifact-ref-retry-accepted",
      runId,
      taskId: "task-verify-retry",
      scope: "artifact",
      status: "accepted",
      payload: {
        runId,
        taskId: "task-verify-retry",
        artifactRefId: "artifact-ref-retry-accepted",
        attemptId: "task-verify-retry-attempt-1",
        status: "accepted",
        evaluatorResultRefs: ["evaluator-result-retry"],
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: "artifact-ref-producer-accepted",
      runId,
      taskId: "task-producer",
      scope: "artifact",
      status: "accepted",
      payload: {
        runId,
        taskId: "task-producer",
        artifactRefId: "artifact-ref-producer-accepted",
        attemptId: "task-producer-attempt-1",
        status: "accepted",
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "evidence_packet",
      resourceKey: "evidence-retry",
      runId,
      taskId: "task-verify-retry",
      scope: "evaluator",
      status: "complete",
      payload: { runId, taskId: "task-verify-retry", attemptId: "task-verify-retry-attempt-1" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "stop_condition_result",
      resourceKey: "stop-retry",
      runId,
      scope: "run",
      status: "passed",
      payload: { ok: true },
    });

    const inspection = await inspectRunPg(db, { runId });

    assert.equal(inspection.health, "healthy");
    assert.equal(inspection.primaryCause, null);
    assert.deepEqual(inspection.tasks.find((task) => task.taskId === "task-verify-original")?.causes, []);
  } finally {
    await db.close();
  }
});

test("workflow read model exposes the same answer-first mission for draft and runtime while keeping satisfied outcome degraded health", async () => {
  const db = await createTestPostgresDb();
  try {
    const goalContract = softwareGoalContract("Create an offline HTML article");
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: goalContract.originalPrompt,
      cwd: goalContract.workspace.cwd,
      goalInterpreter: fixedGoalInterpreter(goalContract),
      goalDesignPackage: canonicalGoalDesignPackageFixture(goalContract),
      composer: new DeterministicFixtureComposer(),
    });

    const draftModel = await buildWorkflowUiReadModelPg(db, { draftId: draft.draftId });
    assert.equal(draftModel.mission!.goalContract.summary, "Create an offline HTML article");
    assert.deepEqual(draftModel.mission!.status, {
      execution: "validated",
      outcome: "in_progress",
      health: "healthy",
    });
    assert.equal(draftModel.lineage.workflowDag?.mode, "draft");
    assert.deepEqual(draftModel.lineage.workflowDag?.taskIds, draftModel.canvasModel.nodes.map((node) => node.id));

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const runtimeContext = await db.one<{ runtime_context_json: Record<string, string> }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      [run.runId],
    );
    await upsertRuntimeResourcePg(db, {
      resourceType: "approval",
      resourceKey: "approval-mission",
      runId: run.runId,
      scope: "approval",
      status: "pending",
      payload: {
        approvalId: "approval-mission",
        actionType: "goalExecution",
        goalContractHash: runtimeContext.runtime_context_json.goalContractHash,
        manifestHash: runtimeContext.runtime_context_json.manifestHash,
        librarySnapshotHash: runtimeContext.runtime_context_json.librarySnapshotHash,
      },
    });
    const pendingApprovalModel = await buildWorkflowUiReadModelPg(db, { runId: run.runId });
    assert.deepEqual(
      pendingApprovalModel.commands.filter((command) => command.id.startsWith("approval.")),
      [
        {
          id: "approval.approve",
          label: "Approve",
          endpoint: `/api/v2/runs/${encodeURIComponent(run.runId)}/approvals/approval-mission/decision`,
          method: "POST",
          body: { decision: "approved" },
          enabled: true,
          requiresConfirmation: true,
        },
        {
          id: "approval.reject",
          label: "Reject",
          endpoint: `/api/v2/runs/${encodeURIComponent(run.runId)}/approvals/approval-mission/decision`,
          method: "POST",
          body: { decision: "rejected" },
          enabled: true,
          requiresConfirmation: true,
        },
      ],
    );
    await upsertRuntimeResourcePg(db, {
      resourceType: "approval",
      resourceKey: "approval-mission",
      runId: run.runId,
      scope: "approval",
      status: "approved",
      payload: {
        approvalId: "approval-mission",
        actionType: "goalExecution",
        goalContractHash: runtimeContext.runtime_context_json.goalContractHash,
        manifestHash: runtimeContext.runtime_context_json.manifestHash,
        librarySnapshotHash: runtimeContext.runtime_context_json.librarySnapshotHash,
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "requirement_evaluator_result",
      resourceKey: "mission-evaluator",
      runId: run.runId,
      scope: "evaluator",
      status: "passed",
      payload: { schemaVersion: "southstar.requirement_evaluator_result.v1", verdict: "passed" },
    });
    await persistTerminalGoalOutcomePg(db, {
      runId: run.runId,
      outcomeStatus: "satisfied",
      coveredRequirementIds: goalContract.requirements.map((requirement) => requirement.id),
      actorType: "test",
      idempotencyKey: "mission:satisfied",
    });
    await recordRuntimeExceptionPg(db, {
      runId: run.runId,
      source: "scheduler",
      kind: "provider_unreachable",
      severity: "warning",
      observedAt: "2026-07-11T00:00:00.000Z",
      evidenceRefs: ["scheduler:mission-warning"],
    });

    const runtimeModel = await buildWorkflowUiReadModelPg(db, { runId: run.runId });
    assert.deepEqual(runtimeModel.mission!.status, {
      execution: "completed",
      outcome: "satisfied",
      health: "degraded",
    });
    assert.deepEqual(runtimeModel.mission!.coverage, {
      covered: 1,
      total: 1,
      failedRequirementIds: [],
      entries: runtimeModel.mission!.coverage.entries,
    });
    assert.equal(runtimeModel.mission!.approval!.goalContractHash, runtimeModel.mission!.goalContractHash);
    assert.deepEqual(runtimeModel.mission!.blockers, [
      "canonical_requirement_evaluator_result_incompatible: requirement evaluator result mission-evaluator uses southstar.requirement_evaluator_result.v1; expected southstar.requirement_evaluator_result.v2",
    ]);
    assert.equal(runtimeModel.mission!.evaluatorResults.length, 1);
    await upsertRuntimeResourcePg(db, {
      resourceType: "requirement_evaluator_result",
      resourceKey: "mission-evaluator",
      runId: run.runId,
      scope: "evaluator",
      status: "stale",
      payload: { schemaVersion: "southstar.requirement_evaluator_result.v1", verdict: "passed" },
    });
    const staleFilteredModel = await buildWorkflowUiReadModelPg(db, { runId: run.runId });
    assert.deepEqual(staleFilteredModel.mission!.evaluatorResults, []);
    assert.deepEqual(staleFilteredModel.mission!.blockers, []);
    assert.equal(runtimeModel.lineage.workflowDag?.mode, "runtime");
    assert.equal(runtimeModel.lineage.workflowDag?.id, run.runId);
    assert.deepEqual(runtimeModel.lineage.workflowDag?.taskIds, runtimeModel.canvasModel.nodes.map((node) => node.id));
    assert.deepEqual(runtimeModel.mission!.goalContract, draftModel.mission!.goalContract);
    assert.equal(runtimeModel.mission!.goalContractHash, draftModel.mission!.goalContractHash);
    assert.deepEqual(runtimeModel.mission!.coverage.entries, draftModel.mission!.coverage.entries);
    assert.deepEqual(runtimeModel.mission!.provenance, {
      originalPrompt: goalContract.originalPrompt,
      revision: goalContract.revision,
      promptHash: goalContract.promptHash,
      manifestHash: runtimeContext.runtime_context_json.manifestHash,
      librarySnapshotHash: runtimeContext.runtime_context_json.librarySnapshotHash,
    });
  } finally {
    await db.close();
  }
});

test("workflow read model projects missing canonical coverage as a blocking mission instead of throwing", async () => {
  const db = await createTestPostgresDb();
  try {
    const goalContract = softwareGoalContract("Create an offline HTML article");
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: goalContract.originalPrompt,
      cwd: goalContract.workspace.cwd,
      goalInterpreter: fixedGoalInterpreter(goalContract),
      goalDesignPackage: canonicalGoalDesignPackageFixture(goalContract),
      composer: new DeterministicFixtureComposer(),
    });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    await db.query(
      "delete from southstar.runtime_resources where run_id = $1 and resource_type = 'goal_requirement_coverage'",
      [run.runId],
    );

    const model = await buildWorkflowUiReadModelPg(db, { runId: run.runId });

    assert.equal(model.mission?.status.health, "critical");
    assert.deepEqual(model.mission?.coverage.entries, []);
    assert.deepEqual(model.mission?.blockers, [
      `canonical_goal_requirement_coverage_missing: run ${run.runId} has no frozen goal requirement coverage`,
    ]);
  } finally {
    await db.close();
  }
});

test("workflow read model projects canonical Goal Contract hash corruption instead of coverage missing", async () => {
  const db = await createTestPostgresDb();
  try {
    const goalContract = softwareGoalContract("Expose canonical lineage corruption");
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: goalContract.originalPrompt,
      cwd: goalContract.workspace.cwd,
      goalInterpreter: fixedGoalInterpreter(goalContract),
      goalDesignPackage: canonicalGoalDesignPackageFixture(goalContract),
      composer: new DeterministicFixtureComposer(),
    });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    await db.query(
      "update southstar.workflow_runs set runtime_context_json = jsonb_set(runtime_context_json, '{goalContractHash}', to_jsonb('stale-contract-hash'::text)) where id = $1",
      [run.runId],
    );

    const model = await buildWorkflowUiReadModelPg(db, { runId: run.runId });

    assert.equal(model.mission?.status.health, "critical");
    assert.deepEqual(model.mission?.blockers, [
      `canonical_goal_design_package_invalid: run ${run.runId} Goal Contract hash does not match planner draft ${draft.draftId}`,
    ]);
  } finally {
    await db.close();
  }
});

test("workflow mission health uses only the latest provider attempt observation", async () => {
  const db = await createTestPostgresDb();
  try {
    const goalContract = softwareGoalContract("Recover with a successful second attempt");
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: goalContract.originalPrompt,
      cwd: goalContract.workspace.cwd,
      goalInterpreter: fixedGoalInterpreter(goalContract),
      goalDesignPackage: canonicalGoalDesignPackageFixture(goalContract),
      composer: new DeterministicFixtureComposer(),
    });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const task = await db.one<{ id: string }>(
      "select id from southstar.workflow_tasks where run_id = $1 order by sort_order, id limit 1",
      [run.runId],
    );
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "mission-attempt-1",
      runId: run.runId,
      taskId: task.id,
      scope: "executor",
      status: "orphaned",
      payload: { attemptId: "attempt-1" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "mission-attempt-2",
      runId: run.runId,
      taskId: task.id,
      scope: "executor",
      status: "completed",
      payload: { attemptId: "attempt-2" },
    });
    await db.query(
      `update southstar.runtime_resources
          set updated_at = case resource_key
            when 'mission-attempt-1' then '2026-07-11T00:02:00.000Z'::timestamptz
            else '2026-07-11T00:01:00.000Z'::timestamptz
          end
        where resource_type = 'executor_binding' and resource_key in ('mission-attempt-1', 'mission-attempt-2')`,
    );

    assert.equal((await buildWorkflowUiReadModelPg(db, { runId: run.runId })).mission!.status.health, "healthy");

    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "mission-attempt-2",
      runId: run.runId,
      taskId: task.id,
      scope: "executor",
      status: "hard-timeout",
      payload: { attemptId: "attempt-2" },
    });
    assert.equal((await buildWorkflowUiReadModelPg(db, { runId: run.runId })).mission!.status.health, "degraded");
  } finally {
    await db.close();
  }
});

test("workflow ui read model exposes runtime DAG and selected definition", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-workflow-ui";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "build workflow canvas",
      workflowManifestJson: JSON.stringify({
        workflowId: "wf-ui",
        tasks: [
          { id: "task-plan", name: "Plan", dependsOn: [], roleRef: "planner", agentProfileRef: "planner-codex" },
          { id: "task-build", name: "Build", dependsOn: ["task-plan"], roleRef: "builder", agentProfileRef: "builder-codex" },
          { id: "task-review", name: "Review", dependsOn: ["task-plan"], roleRef: "reviewer", agentProfileRef: "reviewer-codex" },
          { id: "task-release", name: "Release", dependsOn: ["task-build"], roleRef: "releaser", agentProfileRef: "releaser-codex" },
          { id: "task-done", name: "Done", dependsOn: ["task-plan"], roleRef: "closer", agentProfileRef: "closer-codex" },
        ],
      }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-plan", runId, taskKey: "Plan", status: "completed", sortOrder: 0, dependsOn: [] });
    await createWorkflowTaskPg(db, { id: "task-build", runId, taskKey: "Build", status: "running", sortOrder: 1, dependsOn: ["task-plan"] });
    await createWorkflowTaskPg(db, { id: "task-review", runId, taskKey: "Review", status: "ready", sortOrder: 2, dependsOn: ["task-plan"] });
    await createWorkflowTaskPg(db, { id: "task-release", runId, taskKey: "Release", status: "blocked", sortOrder: 3, dependsOn: ["task-build"] });
    await createWorkflowTaskPg(db, { id: "task-done", runId, taskKey: "Done", status: "completed", sortOrder: 4, dependsOn: ["task-plan"] });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: "artifact-ref-task-plan",
      runId,
      taskId: "task-plan",
      scope: "artifact",
      status: "accepted",
      payload: { artifactRefId: "artifact-ref-task-plan" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "executor-binding-task-build",
      runId,
      taskId: "task-build",
      scope: "executor",
      status: "running",
      title: "Tork job running",
      payload: { executorType: "tork", jobId: "job-build" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-task-build",
      runId,
      taskId: "task-build",
      scope: "runtime",
      status: "observed",
      title: "Callback missing",
      payload: { kind: "callback_missing", severity: "blocking" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "approval",
      resourceKey: "approval-task-build",
      runId,
      taskId: "task-build",
      scope: "approval",
      status: "pending",
      title: "Approve recovery",
      payload: { actionType: "recovery" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "recovery_decision",
      resourceKey: "recovery-task-build",
      runId,
      taskId: "task-build",
      scope: "recovery",
      status: "proposed",
      title: "Requeue task",
      payload: { strategy: "requeue_task" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: "task-envelope-build",
      runId,
      taskId: "task-build",
      scope: "task",
      status: "created",
      payload: {
        envelope: {
          role: { id: "builder" },
          agentProfile: { id: "builder-codex" },
          artifactContract: { kind: "implementation_result" },
          skills: [{ id: "southstar" }],
          materializedLibraryRefs: {
            skillRefs: ["southstar"],
            mcpGrantRefs: ["github-read"],
            toolGrantRefs: ["shell"],
          },
        },
      },
    });

    const model = await buildWorkflowUiReadModelPg(db, { runId, taskId: "task-build" });
    assert.equal(model.canvasModel.graphId, runId);
    assert.equal(model.canvasModel.mode, "runtime");
    assert.deepEqual(model.canvasModel.edges.map((edge) => [edge.source, edge.target, edge.status]), [
      ["task-plan", "task-build", "active"],
      ["task-plan", "task-review", "ready"],
      ["task-build", "task-release", "blocked"],
      ["task-plan", "task-done", "satisfied"],
    ]);
    const buildNode = model.canvasModel.nodes.find((node: { id: string }) => node.id === "task-build");
    assert.equal(buildNode?.kind, "task");
    assert.equal(buildNode?.agentProfileRef, "builder-codex");
    assert.deepEqual(buildNode?.badges.map((badge) => badge.label), [
      "executor running",
      "exception observed",
      "approval pending",
      "recovery proposed",
    ]);
    assert.deepEqual(buildNode?.attention, { severity: "blocked", reason: "Callback missing" });
    assert.equal(model.selectedDefinition?.taskId, "task-build");
    assert.equal((model.selectedDefinition?.artifactContract as { kind?: string } | undefined)?.kind, "implementation_result");
    assert.deepEqual((model.selectedDefinition?.materializedLibraryRefs as { skillRefs?: string[] } | undefined)?.skillRefs, ["southstar"]);
    assert.equal(model.activeDraft, null);
    assert.equal(model.agentLibrarySummary.domain, "software");
    assert.equal(model.agentLibrarySummary.roleCount, 0);
    assert.equal(model.validationIssues.length, 0);
    assert.equal(model.repairAttempts, 0);
    assert.ok(model.commands.some((command: { id: string; enabled: boolean }) => command.id === "open-agent-library" && command.enabled));
  } finally {
    await db.close();
  }
});

test("workflow ui renders dynamic repair as caused by failed verifier without changing runtime dependencies", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-workflow-ui-dynamic-repair";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "repair failed verification",
      workflowManifestJson: JSON.stringify({
        workflowId: "wf-dynamic-repair-ui",
        tasks: [
          { id: "task-plan", name: "Plan", dependsOn: [] },
          { id: "task-implement", name: "Implement", dependsOn: ["task-plan"] },
          { id: "task-verify", name: "Verify", dependsOn: ["task-implement"] },
          { id: "task-review", name: "Review", dependsOn: ["reverify-task-verify-attempt-1"] },
          { id: "repair-task-verify-attempt-1", name: "Repair", dependsOn: ["task-implement"] },
          { id: "reverify-task-verify-attempt-1", name: "Reverify", dependsOn: ["repair-task-verify-attempt-1"] },
        ],
      }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-plan", runId, taskKey: "Plan", status: "completed", sortOrder: 0, dependsOn: [] });
    await createWorkflowTaskPg(db, { id: "task-implement", runId, taskKey: "Implement", status: "completed", sortOrder: 1, dependsOn: ["task-plan"] });
    await createWorkflowTaskPg(db, { id: "task-verify", runId, taskKey: "Verify", status: "failed", sortOrder: 2, dependsOn: ["task-implement"] });
    await createWorkflowTaskPg(db, { id: "task-review", runId, taskKey: "Review", status: "completed", sortOrder: 3, dependsOn: ["reverify-task-verify-attempt-1"] });
    await createWorkflowTaskPg(db, {
      id: "repair-task-verify-attempt-1",
      runId,
      taskKey: "Repair",
      status: "completed",
      sortOrder: 4,
      dependsOn: ["task-implement"],
      snapshot: { dynamicRepair: { failedTaskId: "task-verify", rootFailedTaskId: "task-verify", round: 1 } },
    });
    await createWorkflowTaskPg(db, {
      id: "reverify-task-verify-attempt-1",
      runId,
      taskKey: "Reverify",
      status: "completed",
      sortOrder: 5,
      dependsOn: ["repair-task-verify-attempt-1"],
      snapshot: { dynamicRepair: { failedTaskId: "task-verify", rootFailedTaskId: "task-verify", round: 1 } },
    });

    const model = await buildWorkflowUiReadModelPg(db, { runId });
    const repairNode = model.canvasModel.nodes.find((node: { id: string }) => node.id === "repair-task-verify-attempt-1");
    assert.deepEqual(repairNode?.dependsOn, ["task-implement"]);
    assert.ok(model.canvasModel.edges.some((edge) => edge.source === "task-verify" && edge.target === "repair-task-verify-attempt-1"));
    assert.ok(!model.canvasModel.edges.some((edge) => edge.source === "task-implement" && edge.target === "repair-task-verify-attempt-1"));
  } finally {
    await db.close();
  }
});

test("workflow ui runtime selected definition prefers materialized task envelope details over software library fallback", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-workflow-ui-envelope-definition";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "inspect runtime envelope",
      workflowManifestJson: JSON.stringify({
        workflowId: "wf-envelope-definition",
        tasks: [{
          id: "task-build",
          name: "Build",
          dependsOn: [],
          roleRef: "builder",
          agentProfileRef: "builder-codex",
          skillRefs: ["manifest-skill"],
          mcpGrantRefs: ["manifest-mcp"],
          toolGrantRefs: ["manifest-tool"],
        }],
      }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-build", runId, taskKey: "Build", status: "running", sortOrder: 0, dependsOn: [] });
    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: "task-envelope-build",
      runId,
      taskId: "task-build",
      scope: "task",
      status: "created",
      payload: {
        envelope: {
          role: { id: "builder", source: "runtime-envelope-role" },
          agentProfile: { id: "builder-codex", source: "runtime-envelope-profile" },
          evaluatorPipeline: { id: "runtime-evaluator", source: "runtime-envelope-evaluator" },
          contextPolicy: { id: "runtime-context", source: "runtime-envelope-context" },
          vaultPolicy: { id: "runtime-vault-primary", source: "runtime-envelope-vault" },
          vaultPolicies: [{ id: "runtime-vault-primary" }, { id: "runtime-vault-secondary" }],
          artifactContract: { id: "runtime-artifact", source: "runtime-envelope-artifact" },
          materializedLibraryRefs: {
            skillRefs: ["runtime-skill"],
            mcpGrantRefs: ["runtime-mcp"],
            toolGrantRefs: ["runtime-tool"],
            vaultLeasePolicyRefs: ["runtime-vault-primary"],
            evaluatorPipelineRef: "runtime-evaluator",
            contextPolicyRef: "runtime-context",
            artifactContractRef: "runtime-artifact",
          },
        },
      },
    });

    const model = await buildWorkflowUiReadModelPg(db, { runId, taskId: "task-build" });
    assert.equal((model.selectedDefinition as any).roleDefinition.source, "runtime-envelope-role");
    assert.equal((model.selectedDefinition as any).agentProfile.source, "runtime-envelope-profile");
    assert.equal((model.selectedDefinition as any).evaluatorPipeline.source, "runtime-envelope-evaluator");
    assert.equal((model.selectedDefinition as any).contextPolicy.source, "runtime-envelope-context");
    assert.equal((model.selectedDefinition as any).vaultPolicy.source, "runtime-envelope-vault");
    assert.deepEqual((model.selectedDefinition as any).vaultPolicies.map((policy: { id: string }) => policy.id), [
      "runtime-vault-primary",
      "runtime-vault-secondary",
    ]);
    assert.equal((model.selectedDefinition as any).artifactContract.source, "runtime-envelope-artifact");
    assert.deepEqual(model.selectedDefinition?.skillRefs, ["runtime-skill"]);
    assert.deepEqual(model.selectedDefinition?.mcpGrantRefs, ["runtime-mcp"]);
    assert.deepEqual(model.selectedDefinition?.toolGrantRefs, ["runtime-tool"]);
    assert.deepEqual((model.selectedDefinition?.materializedLibraryRefs as { skillRefs?: string[] } | undefined)?.skillRefs, ["runtime-skill"]);
  } finally {
    await db.close();
  }
});

test("ui route exposes draft workflow canvas via /api/v2/ui/workflow", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-ui";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        goalDesignPackage: {
          slicePlan: {
            schemaVersion: "southstar.goal_slice_plan.v1",
            goalContractHash: "contract-hash-draft-ui",
            revision: 2,
            slices: [{
              id: "slice-main",
              requirementIds: ["req-offline"],
              outcome: "Build the offline article",
              stateOrArtifactOwner: "artifact://article.html",
              mutationBoundary: "workspace",
              expectedArtifactRefs: ["artifact://article.html"],
              evaluatorContractRefs: ["evaluator.html"],
              dependsOnSliceIds: [],
              dependencyArtifactRefs: [],
            }],
          },
        },
        workflow: {
          workflowId: "wf-draft-ui",
          tasks: [
            { id: "task-plan", name: "Plan", dependsOn: [] },
            {
              id: "task-build",
              name: "Build",
              dependsOn: ["task-plan"],
              roleRef: "builder",
              agentProfileRef: "builder-codex",
              promptInputs: {
                sliceId: "slice-main",
                requirementIds: ["req-offline"],
                nodePromptSpec: {
                  goal: "Build the offline article",
                  nodeType: "implement",
                  expectedOutputs: ["artifact://article.html"],
                },
              },
            },
          ],
        },
      },
      summary: {
        goalPrompt: "draft workflow ui",
        validationIssues: [{ path: "workflow.tasks", message: "none" }],
      },
    });

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/ui/workflow?draftId=${encodeURIComponent(draftId)}&taskId=task-build`);
      assert.equal(response.status, 200);
      const envelope = await response.json() as { ok: true; kind: string; result: Awaited<ReturnType<typeof buildWorkflowUiReadModelPg>> };
      assert.equal(envelope.ok, true);
      assert.equal(envelope.kind, "ui-workflow");
      assert.equal(envelope.result.canvasModel.graphId, draftId);
      assert.equal(envelope.result.canvasModel.mode, "draft");
      assert.equal(envelope.result.canvasModel.selectedNodeId, "task-build");
      assert.equal(envelope.result.canvasModel.nodes[0]?.kind, "task");
      assert.deepEqual(envelope.result.canvasModel.edges, [{ id: "task-plan->task-build", source: "task-plan", target: "task-build", status: "pending" }]);
      assert.equal(envelope.result.lineage.slicePlan?.revision, 2);
      assert.equal(envelope.result.lineage.slicePlan?.slices[0]?.id, "slice-main");
      assert.deepEqual(envelope.result.lineage.workflowDag, {
        id: draftId,
        mode: "draft",
        taskIds: ["task-plan", "task-build"],
        edges: [{ from: "task-plan", to: "task-build", status: "pending" }],
      });
      assert.deepEqual(envelope.result.lineage.tasks.find((task) => task.id === "task-build"), {
        id: "task-build",
        label: "Build",
        status: "ready",
        sliceId: "slice-main",
        requirementIds: ["req-offline"],
        dependsOn: ["task-plan"],
        purpose: "Build the offline article",
        nodeType: "implement",
        expectedOutputs: ["artifact://article.html"],
        roleRef: "builder",
        agentProfileRef: "builder-codex",
      });
      assert.equal(envelope.result.selectedDefinition?.taskId, "task-build");
      assert.equal(envelope.result.activeDraft?.draftId, draftId);
      assert.equal(envelope.result.activeDraft?.goalPrompt, "draft workflow ui");
      assert.equal(envelope.result.validationIssues.length, 1);
      assert.equal(envelope.result.validationIssues[0]?.path, "workflow.tasks");
      assert.equal(envelope.result.repairAttempts, 0);
      assert.ok(envelope.result.commands.some((command: { id: string; enabled: boolean }) => command.id === "run-draft" && command.enabled));
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

test("workflow ui draft validation issues target explicit task indexes without badging unaffected nodes", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-indexed-validation";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-indexed-validation",
          tasks: [
            { id: "task-plan", name: "Plan", dependsOn: [], roleRef: "missing-role" },
            { id: "task-build", name: "Build", dependsOn: ["task-plan"], roleRef: "builder" },
          ],
        },
      },
      summary: {
        goalPrompt: "indexed validation targeting",
        validationIssues: [{ path: "workflow.tasks[0].roleRef", message: "roleRef is unknown" }],
      },
    });

    const model = await buildWorkflowUiReadModelPg(db, { draftId });
    const planNode = model.canvasModel.nodes.find((node) => node.id === "task-plan");
    const buildNode = model.canvasModel.nodes.find((node) => node.id === "task-build");
    assert.equal(planNode?.status, "blocked");
    assert.deepEqual(planNode?.badges.filter((badge) => badge.label.startsWith("validation issues")).map((badge) => badge.label), [
      "validation issues 1",
    ]);
    assert.equal(buildNode?.status, "ready");
    assert.deepEqual(buildNode?.badges.filter((badge) => badge.label.startsWith("validation")).map((badge) => badge.label), [
      "validation passed",
    ]);
  } finally {
    await db.close();
  }
});

test("workflow ui draft read model exposes selected definition depth planner trace repair details and draft badges", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-definition-depth";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-definition-depth",
          domain: "software",
          goalPrompt: "implement calc sum",
          tasks: [{
            id: "implement",
            name: "Implement",
            dependsOn: ["understand"],
            roleRef: "maker",
            agentProfileRef: "software-maker-pi",
            artifactContractRef: "implementation_report",
            evaluatorPipelineRef: "software-feature-quality",
            vaultLeasePolicyRefs: ["vault.github-write-token"],
            skillRefs: ["software.calc-cli"],
            mcpGrantRefs: ["filesystem-workspace"],
            toolGrantRefs: ["read", "search", "edit", "shell"],
          }],
        },
        plannerTrace: {
          manifestRef: "planner.manifest_generated:123",
          validationRef: "manifest.validated:123",
        },
        repairAttempts: [{
          attempt: 1,
          reason: "missing evaluator pipeline",
          status: "repaired",
          traceRef: "planner.repair:1",
        }],
      },
      summary: {
        goalPrompt: "implement calc sum",
        validationIssues: [],
        plannerTrace: {
          summaryRef: "summary.trace:1",
        },
      },
    });

    const model = await buildWorkflowUiReadModelPg(db, { draftId, taskId: "implement" });
    const implementNode = model.canvasModel.nodes.find((node) => node.id === "implement");
    assert.equal(implementNode?.status, "ready");
    assert.deepEqual(implementNode?.badges.map((badge) => badge.label), [
      "role maker",
      "profile software-maker-pi",
      "skills 1",
      "mcp 1",
      "tools 4",
      "validation passed",
      "repair repaired",
    ]);
    assert.equal(model.selectedDefinition?.taskId, "implement");
    assert.equal((model.selectedDefinition as any).roleDefinition, undefined);
    assert.equal((model.selectedDefinition as any).agentProfile, undefined);
    assert.equal((model.selectedDefinition as any).vaultPolicy.id, "vault.github-write-token");
    assert.equal((model.selectedDefinition as any).artifactContract, undefined);
    assert.equal((model.selectedDefinition as any).evaluatorPipeline, undefined);
    assert.equal((model.selectedDefinition as any).contextPolicy, undefined);
    assert.equal((model.plannerTrace as any).manifestRef, "planner.manifest_generated:123");
    assert.equal((model.plannerTrace as any).summaryRef, "summary.trace:1");
    assert.deepEqual(model.repairAttemptDetails, [{
      attempt: 1,
      reason: "missing evaluator pipeline",
      status: "repaired",
      traceRef: "planner.repair:1",
    }]);
  } finally {
    await db.close();
  }
});

test("workflow ui draft selected definition exposes editable profile override and effective profile", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-profile-override";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-profile-override",
          domain: "software",
          tasks: [{
            id: "task-build",
            name: "Build",
            dependsOn: [],
            roleRef: "maker",
            agentProfileRef: "software-maker-pi",
            skillRefs: ["software.calc-cli"],
            mcpGrantRefs: [],
            profileOverride: {
              provider: "codex",
              model: "gpt-5-codex",
              thinkingLevel: "high",
              instruction: "Use small patches.",
              skillRefs: ["software.calc-cli", "software.test-evidence"],
              mcpGrantRefs: ["filesystem-workspace"],
            },
          }],
        },
      },
      summary: { goalPrompt: "profile override read model", workflowId: "wf-profile-override" },
    });

    const model = await buildWorkflowUiReadModelPg(db, { draftId, taskId: "task-build" });

    assert.equal(model.selectedDefinition?.editable, true);
    assert.equal((model.selectedDefinition as any).profileOverride.model, "gpt-5-codex");
    assert.equal((model.selectedDefinition as any).effectiveProfile.model, "gpt-5-codex");
    assert.equal((model.selectedDefinition as any).effectiveProfile.provider, "codex");
    assert.equal((model.selectedDefinition as any).effectiveProfile.thinkingLevel, "high");
    assert.equal((model.selectedDefinition as any).effectiveProfile.instruction, "Use small patches.");
    assert.deepEqual((model.selectedDefinition as any).effectiveProfile.skillRefs, ["software.calc-cli", "software.test-evidence"]);
    assert.deepEqual((model.selectedDefinition as any).effectiveProfile.mcpGrantRefs, ["filesystem-workspace"]);
    assert.deepEqual(model.selectedDefinition?.skillRefs, ["software.calc-cli", "software.test-evidence"]);
  } finally {
    await db.close();
  }
});
