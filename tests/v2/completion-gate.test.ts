import test from "node:test";
import assert from "node:assert/strict";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { evaluateRunCompletionGatePg } from "../../src/v2/evaluators/completion-gate.ts";
import { recordRuntimeExceptionPg } from "../../src/v2/exceptions/postgres-runtime-exceptions.ts";
import { goalContractHash, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("completion reports satisfied separately from degraded operational health", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-satisfied-degraded");
    await recordRuntimeExceptionPg(db, {
      runId,
      source: "callback",
      kind: "late_callback",
      severity: "warning",
      status: "observed",
      observedAt: "2026-07-11T00:00:00.000Z",
      evidenceRefs: ["callback:late"],
    });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.executionStatus, "completed");
    assert.equal(result.outcomeStatus, "satisfied");
    assert.equal((await runStatus(db, runId)).status, "completed");
    const outcome = await goalOutcome(db, runId);
    assert.equal(outcome.status, "satisfied");
    assert.deepEqual(outcome.payload_json.coveredRequirementIds, ["req-blocking"]);
  } finally {
    await db.close();
  }
});

test("completion cannot satisfy an uncovered blocking requirement", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-uncovered", { evaluatorVerdict: "failed" });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.executionStatus, "completed");
    assert.equal(result.outcomeStatus, "unsatisfied");
    assert.match(result.findings.join("\n"), /req-blocking/);
    assert.equal((await runStatus(db, runId)).status, "completed");
    assert.equal((await goalOutcome(db, runId)).status, "unsatisfied");
  } finally {
    await db.close();
  }
});

test("completion requires every frozen V2 criterion and evaluator profile version to pass", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRunV2(db, "run-criterion-covered");

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "satisfied");
    assert.deepEqual((await goalOutcome(db, runId)).payload_json.coveredRequirementIds, ["req-blocking"]);
  } finally {
    await db.close();
  }
});

test("completion rejects a V2 overall passed result with a missing frozen criterion", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRunV2(db, "run-criterion-missing", { omitCriterion: true });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "unsatisfied");
    assert.match(result.findings.join("\n"), /complete passed criterion evidence/);
  } finally {
    await db.close();
  }
});

test("completion rejects a passed V2 result from a different evaluator profile version", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRunV2(db, "run-criterion-stale-evaluator");
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{evaluatorProfileVersionRef}', to_jsonb('evaluator.independent@stale'::text))
        where run_id = $1 and resource_type = 'requirement_evaluator_result'`,
      [runId],
    );

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "unsatisfied");
    assert.match(result.findings.join("\n"), /frozen evaluator version/);
  } finally {
    await db.close();
  }
});

test("optional requirements do not block a satisfied goal outcome", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-optional-uncovered", { includeOptionalRequirement: true });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "satisfied");
    assert.deepEqual((await goalOutcome(db, runId)).payload_json.failedRequirementIds, []);
  } finally {
    await db.close();
  }
});

test("terminal completion evaluation is deterministic and auditable", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-outcome-idempotent");

    const first = await evaluateRunCompletionGatePg(db, { runId });
    const firstOutcome = await goalOutcome(db, runId);
    const second = await evaluateRunCompletionGatePg(db, { runId });
    const secondOutcome = await goalOutcome(db, runId);

    assert.deepEqual(second, first);
    assert.deepEqual(secondOutcome.payload_json, firstOutcome.payload_json);
    const history = await listHistoryForRunPg(db, runId);
    assert.equal(history.filter((event) => event.eventType === "run.completed").length, 1);
  } finally {
    await db.close();
  }
});

test("completion remains in progress while a blocking repair approval is unresolved", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-completion-awaiting-repair-approval");
    await db.query("update southstar.workflow_runs set status = 'awaiting_approval', completed_at = null where id = $1", [runId]);
    await upsertRuntimeResourcePg(db, {
      id: `dynamic-repair-approval:${runId}:proposal`,
      resourceType: "approval",
      resourceKey: `dynamic-repair-approval:${runId}:proposal`,
      runId,
      taskId: "task-verify",
      scope: "approval",
      status: "waiting_operator_approval",
      payload: {
        schemaVersion: "southstar.dynamic_repair_authority_approval.v1",
        actionType: "dynamic_repair_authority_expansion",
      },
    });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.deepEqual(result, {
      runId,
      executionStatus: "not_ready",
      outcomeStatus: "in_progress",
      findings: ["run is awaiting blocking approval"],
    });
    assert.equal((await runStatus(db, runId)).status, "awaiting_approval");
    assert.equal((await db.one<{ count: string }>(
      "select count(*) as count from southstar.runtime_resources where run_id = $1 and resource_type = 'goal_outcome'",
      [runId],
    )).count, "0");
  } finally {
    await db.close();
  }
});

test("completion rejects frozen coverage with phantom producer tasks", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-phantom-coverage");
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{entries,0,producerTaskIds}', '["phantom-producer"]'::jsonb)
        where resource_type = 'goal_requirement_coverage' and resource_key = $1`,
      [runId],
    );

    await assert.rejects(
      evaluateRunCompletionGatePg(db, { runId }),
      /manifest is missing producer task phantom-producer/,
    );
  } finally {
    await db.close();
  }
});

test("completion reuses artifact type aliases and colon-prefixed evaluator refs", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-coverage-ref-aliases", { useAliases: true });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "satisfied");
  } finally {
    await db.close();
  }
});

test("completion gate passes all completed tasks with accepted artifact_ref resources", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-pass");
    await seedTask(db, "run-gate-pass", "task-a", "completed", 0);
    await seedTask(db, "run-gate-pass", "task-b", "completed", 1);
    await acceptArtifactRef(db, "run-gate-pass", "task-a");
    await acceptArtifactRef(db, "run-gate-pass", "task-b");

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-pass" });

    assert.deepEqual(result, { runId: "run-gate-pass", executionStatus: "completed", outcomeStatus: "satisfied", findings: [] });
    const run = await runStatus(db, "run-gate-pass");
    assert.equal(run.status, "completed");
    assert.ok(run.completed_at);
    const evaluator = await evaluatorResult(db, "run-gate-pass");
    assert.equal(evaluator.status, "satisfied");
    assert.deepEqual(evaluator.payload_json, { executionStatus: "completed", outcomeStatus: "satisfied", findings: [] });
    assert.deepEqual(evaluator.summary_json, { findingCount: 0 });
  } finally {
    await db.close();
  }
});

test("completion gate records evaluating_started before completed idempotently", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-history");
    await seedTask(db, "run-gate-history", "task-a", "completed", 0);
    await acceptArtifactRef(db, "run-gate-history", "task-a");

    await evaluateRunCompletionGatePg(db, { runId: "run-gate-history" });
    await evaluateRunCompletionGatePg(db, { runId: "run-gate-history" });

    const history = await listHistoryForRunPg(db, "run-gate-history");
    assert.deepEqual(history.map((event) => event.eventType), [
      "artifact.accepted",
      "run.evaluating_started",
      "run.completed",
    ]);
    assert.equal(history.find((event) => event.eventType === "run.evaluating_started")?.actorType, "evaluator");
    assert.equal(history.find((event) => event.eventType === "run.completed")?.actorType, "evaluator");
  } finally {
    await db.close();
  }
});

test("completion gate records a new immutable terminal event after recovery re-evaluates to passed", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-recovery-pass");
    await seedTask(db, "run-gate-recovery-pass", "task-a", "failed", 0);

    const failed = await evaluateRunCompletionGatePg(db, { runId: "run-gate-recovery-pass" });
    assert.deepEqual(failed, {
      runId: "run-gate-recovery-pass",
      executionStatus: "completed",
      outcomeStatus: "unsatisfied",
      findings: ["task task-a terminal status is failed"],
    });

    await db.query(
      "update southstar.workflow_tasks set status = 'completed', completed_at = null, updated_at = now() where run_id = $1 and id = $2",
      ["run-gate-recovery-pass", "task-a"],
    );
    await acceptArtifactRef(db, "run-gate-recovery-pass", "task-a");

    const passed = await evaluateRunCompletionGatePg(db, { runId: "run-gate-recovery-pass" });

    assert.deepEqual(passed, { runId: "run-gate-recovery-pass", executionStatus: "completed", outcomeStatus: "satisfied", findings: [] });
    const run = await runStatus(db, "run-gate-recovery-pass");
    assert.equal(run.status, "completed");
    const evaluator = await evaluatorResult(db, "run-gate-recovery-pass");
    assert.equal(evaluator.status, "satisfied");
    assert.deepEqual(evaluator.payload_json, { executionStatus: "completed", outcomeStatus: "satisfied", findings: [] });
    const completedEvents = (await listHistoryForRunPg(db, "run-gate-recovery-pass"))
      .filter((event) => event.eventType === "run.completed");
    assert.equal(completedEvents.length, 2);
    assert.deepEqual(completedEvents.map((event) => (event.payload as { outcomeStatus?: string }).outcomeStatus), ["unsatisfied", "satisfied"]);
    assert.notEqual(completedEvents[0]?.idempotencyKey, completedEvents[1]?.idempotencyKey);
  } finally {
    await db.close();
  }
});

test("completion gate does not set completed_at while tasks are not ready for final evaluation", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-not-ready");
    await seedTask(db, "run-gate-not-ready", "task-a", "completed", 0);
    await seedTask(db, "run-gate-not-ready", "task-b", "running", 1);
    await acceptArtifactRef(db, "run-gate-not-ready", "task-a");

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-not-ready" });

    assert.deepEqual(result, { runId: "run-gate-not-ready", executionStatus: "not_ready", outcomeStatus: "in_progress", findings: ["tasks are not terminal"] });
    const run = await runStatus(db, "run-gate-not-ready");
    assert.equal(run.status, "running");
    assert.equal(run.completed_at, null);
    const history = await listHistoryForRunPg(db, "run-gate-not-ready");
    assert.equal(history.some((event) => event.eventType === "run.evaluating_started"), false);
    assert.equal(history.some((event) => event.eventType === "run.completed"), false);
  } finally {
    await db.close();
  }
});

test("completion gate fails completed tasks missing accepted artifact_ref resources", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-missing-artifact-ref");
    await seedTask(db, "run-gate-missing-artifact-ref", "task-a", "completed", 0);

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-missing-artifact-ref" });

    assert.equal(result.outcomeStatus, "unsatisfied");
    assert.deepEqual(result.findings, ["missing accepted artifact_ref for task task-a"]);
    const run = await runStatus(db, "run-gate-missing-artifact-ref");
    assert.equal(run.status, "completed");
    assert.ok(run.completed_at);
    const evaluator = await evaluatorResult(db, "run-gate-missing-artifact-ref");
    assert.equal(evaluator.status, "unsatisfied");
    assert.deepEqual(evaluator.payload_json, {
      executionStatus: "completed",
      outcomeStatus: "unsatisfied",
      findings: ["missing accepted artifact_ref for task task-a"],
    });
  } finally {
    await db.close();
  }
});

test("completion gate fails runs with blocking tool proxy violations", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-tool-proxy");
    await seedTask(db, "run-gate-tool-proxy", "task-a", "completed", 0);
    await acceptArtifactRef(db, "run-gate-tool-proxy", "task-a");
    await upsertRuntimeResourcePg(db, {
      id: "violation-run-gate-tool-proxy",
      resourceType: "tool_proxy_violation",
      resourceKey: "violation-run-gate-tool-proxy",
      runId: "run-gate-tool-proxy",
      taskId: "task-a",
      sessionId: "session-task-a",
      scope: "tool",
      status: "blocking",
      title: "Tool proxy violation",
      payload: { reason: "unauthorized tool call" },
    });

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-tool-proxy" });

    assert.equal(result.outcomeStatus, "blocked");
    assert.equal(result.findings.some((finding) => finding.includes("blocking tool proxy violation violation-run-gate-tool-proxy")), true);
    const run = await runStatus(db, "run-gate-tool-proxy");
    assert.equal(run.status, "completed");
  } finally {
    await db.close();
  }
});

test("completion gate treats non-completed terminal tasks as findings", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-terminal-finding");
    await seedTask(db, "run-gate-terminal-finding", "task-a", "failed", 0);

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-terminal-finding" });

    assert.deepEqual(result, {
      runId: "run-gate-terminal-finding",
      executionStatus: "completed",
      outcomeStatus: "unsatisfied",
      findings: ["task task-a terminal status is failed"],
    });
    const run = await runStatus(db, "run-gate-terminal-finding");
    assert.equal(run.status, "completed");
  } finally {
    await db.close();
  }
});

test("completion gate ignores a failed verifier superseded by accepted dynamic repair", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-gate-dynamic-repair-superseded";
    await seedRun(db, runId);
    await seedTask(db, runId, "task-plan", "completed", 0);
    await seedTask(db, runId, "task-implement", "completed", 1);
    await seedTask(db, runId, "task-verify", "failed", 2);
    await seedTask(db, runId, "repair-task-verify-attempt-1", "completed", 3);
    await seedTask(db, runId, "reverify-task-verify-attempt-1", "completed", 4);
    await seedTask(db, runId, "task-review", "completed", 5);
    await acceptArtifactRef(db, runId, "task-plan");
    await acceptArtifactRef(db, runId, "task-implement");
    await acceptArtifactRef(db, runId, "repair-task-verify-attempt-1");
    await acceptArtifactRef(db, runId, "reverify-task-verify-attempt-1");
    await acceptArtifactRef(db, runId, "task-review");
    await upsertRuntimeResourcePg(db, {
      resourceType: "workflow_dynamic_repair_revision",
      resourceKey: "workflow-dynamic-repair:run-gate-dynamic-repair-superseded:task-verify:attempt-1",
      runId,
      scope: "workflow",
      status: "applied",
      title: "Dynamic repair workflow revision",
      payload: {
        rootFailedTaskId: "task-verify",
        originalFailedTaskId: "task-verify",
        failedTaskId: "task-verify",
        newTaskIds: ["repair-task-verify-attempt-1", "reverify-task-verify-attempt-1"],
      },
    });
    await recordRuntimeExceptionPg(db, {
      runId,
      taskId: "task-verify",
      sessionId: "session-task-verify",
      attemptId: "attempt-1",
      handExecutionId: "hand-task-verify",
      source: "tork-observer",
      kind: "tork_running_hang",
      severity: "recoverable",
      status: "observed",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["hand-task-verify"],
      providerEvidence: { externalJobId: "job-task-verify" },
    });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.deepEqual(result, { runId, executionStatus: "completed", outcomeStatus: "satisfied", findings: [] });
  } finally {
    await db.close();
  }
});

test("completion gate returns not_ready without mutation when a run has no tasks", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-no-tasks");

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-no-tasks" });

    assert.deepEqual(result, { runId: "run-gate-no-tasks", executionStatus: "not_ready", outcomeStatus: "in_progress", findings: ["run has no tasks"] });
    const run = await runStatus(db, "run-gate-no-tasks");
    assert.equal(run.status, "running");
    assert.equal(run.completed_at, null);
    const evaluatorCount = await db.one<{ count: string }>(
      "select count(*) as count from southstar.runtime_resources where run_id = $1 and resource_type = 'evaluator_result'",
      ["run-gate-no-tasks"],
    );
    assert.equal(Number(evaluatorCount.count), 0);
  } finally {
    await db.close();
  }
});

async function seedRun(db: SouthstarDb, runId: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "evaluate completion",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: runId }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
}

async function seedTask(db: SouthstarDb, runId: string, taskId: string, status: string, sortOrder: number): Promise<void> {
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status,
    sortOrder,
    dependsOn: [],
    rootSessionId: `session-${taskId}`,
  });
}

async function acceptArtifactRef(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  await acceptOrRejectArtifactRefPg(db, {
    runId,
    taskId,
    sessionId: `session-${taskId}`,
    attemptId: "attempt-1",
    handExecutionId: `hand-${taskId}`,
    producer: { actorType: "hand", providerId: "workspace" },
    artifactType: "implementation_report",
    status: "accepted",
    content: { taskId, status: "done" },
    contractRefs: [`contract:${taskId}`],
    summary: `Artifact for ${taskId}`,
    producedAt: "2026-06-21T00:00:00.000Z",
  });
}

async function runStatus(db: SouthstarDb, runId: string): Promise<{ status: string; completed_at: Date | null }> {
  return await db.one<{ status: string; completed_at: Date | null }>(
    "select status, completed_at from southstar.workflow_runs where id = $1",
    [runId],
  );
}

async function evaluatorResult(db: SouthstarDb, runId: string): Promise<{
  status: string;
  payload_json: { executionStatus: string; outcomeStatus: string; findings: string[] };
  summary_json: { findingCount: number };
}> {
  return await db.one<{
    status: string;
    payload_json: { executionStatus: string; outcomeStatus: string; findings: string[] };
    summary_json: { findingCount: number };
  }>(
    "select status, payload_json, summary_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
    [`completion-gate:${runId}`],
  );
}

async function seedCoveredGoalRun(
  db: SouthstarDb,
  runId: string,
  options: { evaluatorVerdict?: "passed" | "failed"; includeOptionalRequirement?: boolean; useAliases?: boolean } = {},
): Promise<{ runId: string }> {
  const requirements: GoalContractV1["requirements"] = [{
    id: "req-blocking",
    statement: "The blocking outcome works",
    acceptanceCriteria: ["The produced artifact is independently verified"],
    blocking: true,
    source: "explicit",
    expectedArtifacts: [],
  }];
  if (options.includeOptionalRequirement) {
    requirements.push({
      id: "req-optional",
      statement: "Optional polish exists",
      acceptanceCriteria: ["Optional polish may be deferred"],
      blocking: false,
      source: "inferred",
      expectedArtifacts: [],
    });
  }
  const goalContract: GoalContractV1 = {
    schemaVersion: "southstar.goal_contract.v1",
    originalPrompt: "Ship a covered outcome",
    promptHash: "prompt-hash",
    revision: 1,
    workspace: { cwd: "/tmp/southstar" },
    domain: "software",
    intent: "ship",
    workType: "general",
    summary: "Ship a covered outcome",
    requirements,
    expectedArtifactRefs: ["artifact.output"],
    requiredCapabilities: [],
    nonGoals: [],
    assumptions: [],
    blockingInputs: [],
    riskTags: [],
    requestedSideEffects: [],
  };
  const contractHash = goalContractHash(goalContract);
  const draftId = `draft-${runId}`;
  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: "Planner draft",
    payload: { goalContract, goalContractHash: contractHash },
  });
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: goalContract.originalPrompt,
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: runId,
      artifactContracts: [{ id: "artifact.output", artifactType: "implementation_report" }],
      tasks: [
        { id: "task-producer", requiredArtifactRefs: ["artifact.output"] },
        { id: "task-evaluator", evaluatorPipelineRef: "evaluator.independent" },
      ],
    }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({ draftId, goalContractHash: contractHash }),
    metricsJson: JSON.stringify({}),
  });
  await seedTask(db, runId, "task-producer", "completed", 0);
  await seedTask(db, runId, "task-evaluator", "completed", 1);
  const artifact = await acceptOrRejectArtifactRefPg(db, {
    runId,
    taskId: "task-producer",
    sessionId: "session-task-producer",
    attemptId: "attempt-1",
    handExecutionId: "hand-task-producer",
    producer: { actorType: "hand", providerId: "workspace" },
    artifactType: "implementation_report",
    status: "accepted",
    content: { ok: true },
    contractRefs: [options.useAliases ? "implementation_report" : "artifact.output"],
    summary: "Produced output",
    producedAt: "2026-07-11T00:00:00.000Z",
  });
  await upsertRuntimeResourcePg(db, {
    id: `coverage-${runId}`,
    resourceType: "goal_requirement_coverage",
    resourceKey: runId,
    runId,
    scope: "run",
    status: "frozen",
    title: "Frozen coverage",
    payload: {
      schemaVersion: "southstar.goal_requirement_coverage.v1",
      goalContractHash: contractHash,
      entries: [
        {
          requirementId: "req-blocking",
          producerTaskIds: ["task-producer"],
          artifactRefs: [options.useAliases ? "artifact:output" : "artifact.output"],
          evaluatorTaskIds: ["task-evaluator"],
          evaluatorProfileRefs: [options.useAliases ? "evaluator:independent" : "evaluator.independent"],
          requiredEvidenceKinds: ["artifact-ref"],
        },
        ...(options.includeOptionalRequirement ? [{
          requirementId: "req-optional",
          producerTaskIds: [],
          artifactRefs: [],
          evaluatorTaskIds: [],
          evaluatorProfileRefs: [],
          requiredEvidenceKinds: [],
        }] : []),
      ],
    },
  });
  const verdict = options.evaluatorVerdict ?? "passed";
  await upsertRuntimeResourcePg(db, {
    id: `requirement-result-${runId}`,
    resourceType: "requirement_evaluator_result",
    resourceKey: `requirement:${runId}:req-blocking:task-evaluator:${artifact.artifactRefId}`,
    runId,
    taskId: "task-evaluator",
    scope: "evaluator",
    status: verdict,
    title: "Requirement evaluator",
    payload: {
      schemaVersion: "southstar.requirement_evaluator_result.v1",
      requirementIds: ["req-blocking"],
      artifactRefs: [artifact.artifactRefId],
      evaluatorId: `evaluator-${runId}`,
      evaluatorTaskId: "task-evaluator",
      evaluatorProfileRef: "evaluator.independent",
      verdict,
      evidenceRefs: [`evidence-${runId}`],
      findings: verdict === "passed" ? [] : ["verification failed"],
    },
  });
  return { runId };
}

async function seedCoveredGoalRunV2(
  db: SouthstarDb,
  runId: string,
  options: { omitCriterion?: boolean } = {},
): Promise<{ runId: string }> {
  await seedCoveredGoalRun(db, runId);
  const artifact = await db.one<{ resource_key: string }>(
    `select resource_key
       from southstar.runtime_resources
      where run_id = $1 and resource_type = 'artifact_ref' and status = 'accepted'
      order by resource_key
      limit 1`,
    [runId],
  );
  await upsertRuntimeResourcePg(db, {
    id: `coverage-${runId}`,
    resourceType: "goal_requirement_coverage",
    resourceKey: runId,
    runId,
    scope: "run",
    status: "frozen",
    title: "Frozen criterion coverage",
    payload: {
      schemaVersion: "southstar.goal_requirement_coverage.v1",
      goalContractHash: (await db.one<{ runtime_context_json: { goalContractHash: string } }>(
        "select runtime_context_json from southstar.workflow_runs where id = $1",
        [runId],
      )).runtime_context_json.goalContractHash,
      entries: [{
        requirementId: "req-blocking",
        producerTaskIds: ["task-producer"],
        artifactRefs: ["artifact.output"],
        evaluatorTaskIds: ["task-evaluator"],
        evaluatorProfileRefs: ["evaluator.independent"],
        evaluatorProfileVersionRefs: ["evaluator.independent@2"],
        validationBindingId: "binding-req-blocking",
        criterionIds: ["criterion-blocking"],
        acceptanceCriteria: ["The produced artifact is independently verified"],
        requiredEvidenceKinds: ["artifact-ref"],
      }],
    },
  });
  await db.query(
    `update southstar.workflow_runs
        set workflow_manifest_json = workflow_manifest_json || $2::jsonb
      where id = $1`,
    [runId, JSON.stringify({
      evaluatorPipelines: [{
        id: "independent",
        libraryObjectRef: "evaluator.independent",
        libraryVersionRef: "evaluator.independent@2",
        validationBindingIds: ["binding-req-blocking"],
        evaluators: [{
          id: "check-criterion-blocking",
          kind: "checker-agent",
          required: true,
          config: {
            criterionId: "criterion-blocking",
            acceptanceCriterion: "The produced artifact is independently verified",
            expectedEvidenceKinds: ["artifact-ref"],
          },
        }],
        onFailure: { defaultStrategy: "request-workflow-revision" },
      }],
    })],
  );
  await upsertRuntimeResourcePg(db, {
    id: `evidence-${runId}`,
    resourceType: "evidence_packet",
    resourceKey: `evidence-${runId}`,
    runId,
    taskId: "task-evaluator",
    scope: "evaluator",
    status: "complete",
    payload: { schemaVersion: "southstar.evidence_packet.v1" },
  });
  await upsertRuntimeResourcePg(db, {
    id: `requirement-result-${runId}`,
    resourceType: "requirement_evaluator_result",
    resourceKey: `requirement:${runId}:req-blocking:task-evaluator:${artifact.resource_key}`,
    runId,
    taskId: "task-evaluator",
    scope: "evaluator",
    status: "passed",
    payload: {
      schemaVersion: "southstar.requirement_evaluator_result.v2",
      requirementId: "req-blocking",
      validationBindingId: "binding-req-blocking",
      artifactRefs: [artifact.resource_key],
      evaluatorId: `evaluator-${runId}`,
      evaluatorTaskId: "task-evaluator",
      evaluatorProfileRef: "evaluator.independent",
      evaluatorProfileVersionRef: "evaluator.independent@2",
      verdict: "passed",
      criteriaResults: options.omitCriterion ? [] : [{
        criterionId: "criterion-blocking",
        verdict: "passed",
        evidenceRefs: [artifact.resource_key],
        findings: [],
      }],
      evidenceRefs: [`evidence-${runId}`],
      findings: [],
    },
  });
  return { runId };
}

async function goalOutcome(db: SouthstarDb, runId: string): Promise<{
  status: string;
  payload_json: {
    outcomeStatus: string;
    coveredRequirementIds: string[];
    failedRequirementIds: string[];
    findings: string[];
  };
}> {
  return await db.one(
    "select status, payload_json from southstar.runtime_resources where resource_type = 'goal_outcome' and resource_key = $1",
    [`goal-outcome:${runId}`],
  );
}
