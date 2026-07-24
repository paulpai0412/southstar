import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { evaluateRunCompletionGatePg } from "../../src/v2/evaluators/completion-gate.ts";
import { criterionValidationCheckKey } from "../../src/v2/design-library/types.ts";
import { recordRuntimeExceptionPg } from "../../src/v2/exceptions/postgres-runtime-exceptions.ts";
import { goalContractHash, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { canonicalGoalDesignPackageFixture } from "./fixtures/goal-design.ts";
import { softwareGoalContract } from "./fixtures/goal-contract.ts";

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

test("completion gate persists a passed result for every declared stop condition", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-stop-condition-persisted");
    await db.query(
      `update southstar.workflow_runs
          set workflow_manifest_json = workflow_manifest_json || $2::jsonb
        where id = $1`,
      [runId, JSON.stringify({
        stopConditions: [{ id: "stop.generated", type: "artifact-accepted", evaluatorRefs: ["independent"] }],
      })],
    );

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "satisfied");
    const stopCondition = await db.one<{
      status: string;
      payload_json: { conditionId: string; conditionType: string; outcomeStatus: string; evaluatorRefs: string[] };
    }>(
      `select status, payload_json
         from southstar.runtime_resources
        where run_id = $1 and resource_type = 'stop_condition_result' and resource_key = $2`,
      [runId, `stop-condition:${runId}:stop.generated`],
    );
    assert.equal(stopCondition.status, "passed");
    assert.deepEqual(stopCondition.payload_json, {
      schemaVersion: "southstar.stop_condition_result.v1",
      conditionId: "stop.generated",
      conditionType: "artifact-accepted",
      evaluatorRefs: ["independent"],
      outcomeStatus: "satisfied",
      passed: true,
    });
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
    const { runId } = await seedCoveredGoalRun(db, "run-criterion-covered");

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
    const { runId } = await seedCoveredGoalRun(db, "run-criterion-missing", { omitCriterion: true });

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
    const { runId } = await seedCoveredGoalRun(db, "run-criterion-stale-evaluator");
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

test("a blocking Criterion remains completion authority when its parent Requirement is advisory", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-blocking-criterion-advisory-requirement", {
      evaluatorVerdict: "failed",
      requirementBlocking: false,
      criterionBlocking: true,
    });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "unsatisfied");
    assert.deepEqual((await goalOutcome(db, runId)).payload_json.failedRequirementIds, ["req-blocking"]);
  } finally {
    await db.close();
  }
});

test("an advisory Criterion failure does not block completion when its parent Requirement is blocking", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-advisory-criterion-blocking-requirement", {
      evaluatorVerdict: "failed",
      requirementBlocking: true,
      criterionBlocking: false,
    });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "satisfied");
    assert.deepEqual((await goalOutcome(db, runId)).payload_json.failedRequirementIds, []);
  } finally {
    await db.close();
  }
});

test("completion aggregates independently pinned evaluator results for atomic Criteria", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-two-atomic-evaluators", {
      secondCriterion: true,
    });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "satisfied");
    assert.deepEqual((await goalOutcome(db, runId)).payload_json.coveredRequirementIds, ["req-blocking"]);
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

test("completion blocks and persists invalid frozen coverage with phantom producer tasks", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-phantom-coverage");
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{entries,0,producerTaskIds}', '["phantom-producer"]'::jsonb)
        where resource_type = 'goal_requirement_coverage' and resource_key = $1`,
      [runId],
    );

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "blocked");
    assert.deepEqual(result.findings, [
      `canonical_goal_requirement_coverage_invalid: run ${runId} frozen Goal Requirement Coverage is incompatible with canonical Goal Design lineage`,
    ]);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_requirement_coverage_invalid");
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

test("completion blocks V1 evaluator lineage without frozen criteria", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedLegacyCoveredGoalRun(db, "run-v1-evaluator-lineage");

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "blocked");
    assert.equal(
      result.findings[0],
      `canonical_goal_requirement_coverage_invalid: run ${runId} frozen Goal Requirement Coverage is incompatible with canonical Goal Design lineage`,
    );
    assert.match(
      result.findings[1] ?? "",
      /^canonical_requirement_evaluator_result_incompatible: requirement evaluator result .* uses southstar\.requirement_evaluator_result\.v1; expected southstar\.requirement_evaluator_result\.v2$/,
    );
    assert.equal((await goalOutcome(db, runId)).status, "blocked");
  } finally {
    await db.close();
  }
});

test("completion blocks a V1 evaluator result even when valid V2 criterion evidence also exists", async () => {
  const db = await createTestPostgresDb();
  try {
    const { runId } = await seedCoveredGoalRun(db, "run-mixed-evaluator-lineage");
    await upsertRuntimeResourcePg(db, {
      id: `legacy-requirement-result-${runId}`,
      resourceType: "requirement_evaluator_result",
      resourceKey: `legacy-requirement-result-${runId}`,
      runId,
      taskId: "task-evaluator",
      scope: "evaluator",
      status: "passed",
      payload: {
        schemaVersion: "southstar.requirement_evaluator_result.v1",
        requirementIds: ["req-blocking"],
        artifactRefs: [],
        evaluatorTaskId: "task-evaluator",
        evaluatorProfileRef: "evaluator.independent",
        verdict: "passed",
        evidenceRefs: [],
        findings: [],
      },
    });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "blocked");
    assert.deepEqual(result.findings, [
      "canonical_requirement_evaluator_result_incompatible: requirement evaluator result legacy-requirement-result-run-mixed-evaluator-lineage uses southstar.requirement_evaluator_result.v1; expected southstar.requirement_evaluator_result.v2",
    ]);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      `select payload_json
         from southstar.runtime_resources
        where run_id = $1 and resource_type = 'runtime_exception'`,
      [runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_requirement_evaluator_result_incompatible");
  } finally {
    await db.close();
  }
});

test("completion gate blocks terminal runs missing frozen requirement coverage", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-pass");
    const goalContract = softwareGoalContract("evaluate completion without frozen coverage");
    const contractHash = goalContractHash(goalContract);
    const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract);
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: "draft-run-gate-pass",
      scope: "planner",
      status: "validated",
      payload: {
        goalContract,
        goalContractHash: contractHash,
        goalDesignPackage,
      },
    });
    await db.query(
      "update southstar.workflow_runs set runtime_context_json = $2::jsonb where id = $1",
      ["run-gate-pass", JSON.stringify({
        goalContractHash: contractHash,
        goalDesignPackageHash: goalDesignPackage.packageHash,
        draftId: "draft-run-gate-pass",
      })],
    );
    await seedTask(db, "run-gate-pass", "task-a", "completed", 0);
    await seedTask(db, "run-gate-pass", "task-b", "completed", 1);
    await acceptArtifactRef(db, "run-gate-pass", "task-a");
    await acceptArtifactRef(db, "run-gate-pass", "task-b");

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-pass" });

    assert.deepEqual(result, {
      runId: "run-gate-pass",
      executionStatus: "completed",
      outcomeStatus: "blocked",
      findings: ["canonical_goal_requirement_coverage_missing: run run-gate-pass has no frozen goal requirement coverage"],
    });
    const run = await runStatus(db, "run-gate-pass");
    assert.equal(run.status, "completed");
    assert.ok(run.completed_at);
    const evaluator = await evaluatorResult(db, "run-gate-pass");
    assert.equal(evaluator.status, "blocked");
    assert.deepEqual(evaluator.payload_json, {
      executionStatus: "completed",
      outcomeStatus: "blocked",
      findings: ["canonical_goal_requirement_coverage_missing: run run-gate-pass has no frozen goal requirement coverage"],
    });
    assert.deepEqual(evaluator.summary_json, { findingCount: 1 });
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
      "runtime_exception.observed",
      "run.evaluating_started",
      "run.completed",
    ]);
    assert.equal(history.find((event) => event.eventType === "run.evaluating_started")?.actorType, "evaluator");
    assert.equal(history.find((event) => event.eventType === "run.completed")?.actorType, "evaluator");
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

test("completion gate fails V2 lineage missing its accepted producer artifact", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-gate-missing-artifact-ref";
    await seedCoveredGoalRun(db, runId);
    await db.query(
      "delete from southstar.runtime_resources where run_id = $1 and resource_type = 'artifact_ref'",
      [runId],
    );

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "unsatisfied");
    assert.deepEqual(result.findings, [
      "blocking requirement req-blocking lacks complete passed criterion evidence from the frozen evaluator version",
    ]);
    const run = await runStatus(db, runId);
    assert.equal(run.status, "completed");
    assert.ok(run.completed_at);
    const evaluator = await evaluatorResult(db, runId);
    assert.equal(evaluator.status, "unsatisfied");
    assert.deepEqual(evaluator.payload_json, {
      executionStatus: "completed",
      outcomeStatus: "unsatisfied",
      findings: [
        "blocking requirement req-blocking lacks complete passed criterion evidence from the frozen evaluator version",
      ],
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

async function seedLegacyCoveredGoalRun(
  db: SouthstarDb,
  runId: string,
  options: {
    evaluatorVerdict?: "passed" | "failed";
    includeOptionalRequirement?: boolean;
    useAliases?: boolean;
    requirementBlocking?: boolean;
    criterionBlocking?: boolean;
    secondCriterion?: boolean;
  } = {},
): Promise<{ runId: string }> {
  const requirements: GoalContractV1["requirements"] = [{
    id: "req-blocking",
    statement: "The blocking outcome works",
    acceptanceCriteria: [
      criterion(
        "criterion-blocking",
        "The produced artifact is independently verified",
        options.criterionBlocking ?? true,
      ),
      ...(options.secondCriterion
        ? [criterion("criterion-secondary", "The produced artifact passes a second independent check", true)]
        : []),
    ],
    blocking: options.requirementBlocking ?? true,
    source: "explicit",
    expectedArtifacts: [],
  }];
  if (options.includeOptionalRequirement) {
    requirements.push({
      id: "req-optional",
      statement: "Optional polish exists",
      acceptanceCriteria: [criterion("criterion-optional", "Optional polish may be deferred", false)],
      blocking: false,
      source: "inferred",
      expectedArtifacts: [],
    });
  }
  const goalContract: GoalContractV1 = {
    schemaVersion: "southstar.goal_contract.v2",
    originalPrompt: "Ship a covered outcome",
    promptHash: createHash("sha256").update("Ship a covered outcome").digest("hex"),
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
  const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract);
  const draftId = `draft-${runId}`;
  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: "Planner draft",
    payload: {
      goalContract,
      goalContractHash: contractHash,
      goalDesignPackage,
    },
  });
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: goalContract.originalPrompt,
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: runId,
      artifactContracts: [{
        id: "artifact.output",
        artifactType: "implementation_report",
        libraryObjectRef: "artifact.output",
        libraryVersionRef: "artifact.output@1",
      }],
      tasks: [
        { id: "task-producer", requiredArtifactRefs: ["artifact.output"] },
        { id: "task-evaluator", evaluatorPipelineRef: "evaluator.independent" },
        ...(options.secondCriterion
          ? [{ id: "task-evaluator-secondary", evaluatorPipelineRef: "evaluator.secondary" }]
          : []),
      ],
    }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({
      draftId,
      goalContractHash: contractHash,
      goalDesignPackageHash: goalDesignPackage.packageHash,
    }),
    metricsJson: JSON.stringify({}),
  });
  await seedTask(db, runId, "task-producer", "completed", 0);
  await seedTask(db, runId, "task-evaluator", "completed", 1);
  if (options.secondCriterion) await seedTask(db, runId, "task-evaluator-secondary", "completed", 2);
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
    contractVersionRefs: ["artifact.output@1"],
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

function criterion(id: string, observableClaim: string, blocking: boolean): GoalContractV1["requirements"][number]["acceptanceCriteria"][number] {
  return {
    id,
    version: 1,
    observableClaim,
    blocking,
    verificationIntent: ["Verify the observable claim against the accepted artifact."],
    requiredAssurance: ["deterministic"],
  };
}

function criterionEvidenceLineage(input: {
  requirementId: string;
  validationBindingId: string;
  criterion: {
    criterionId: string;
    criterionVersion: number;
    artifactContractRef: string;
    artifactContractVersionRef: string;
    evaluatorProfileRef: string;
    evaluatorProfileVersionRef: string;
    verificationMode: "deterministic" | "browser_interaction" | "semantic_review" | "human_approval";
    procedureRef: string;
  };
  artifactRef: string;
  evaluatorTaskId: string;
  evaluatorAttemptId: string;
  evaluatorArtifactRef: string;
}): Record<string, unknown> {
  return {
    checkKey: criterionValidationCheckKey(input.criterion.criterionId, input.criterion.verificationMode),
    requirementId: input.requirementId,
    validationBindingId: input.validationBindingId,
    criterionId: input.criterion.criterionId,
    criterionVersion: input.criterion.criterionVersion,
    verificationMode: input.criterion.verificationMode,
    artifactContractRef: input.criterion.artifactContractRef,
    artifactContractVersionRef: input.criterion.artifactContractVersionRef,
    artifactInstanceRefs: [input.artifactRef],
    procedureRef: input.criterion.procedureRef,
    evaluatorTaskId: input.evaluatorTaskId,
    evaluatorAttemptId: input.evaluatorAttemptId,
    evaluatorArtifactRef: input.evaluatorArtifactRef,
    evaluatorProfileRef: input.criterion.evaluatorProfileRef,
    evaluatorProfileVersionRef: input.criterion.evaluatorProfileVersionRef,
  };
}

async function seedCoveredGoalRun(
  db: SouthstarDb,
  runId: string,
  options: {
    evaluatorVerdict?: "passed" | "failed";
    includeOptionalRequirement?: boolean;
    useAliases?: boolean;
    omitCriterion?: boolean;
    requirementBlocking?: boolean;
    criterionBlocking?: boolean;
    secondCriterion?: boolean;
  } = {},
): Promise<{ runId: string }> {
  await seedLegacyCoveredGoalRun(db, runId, options);
  const artifact = await db.one<{ resource_key: string }>(
    `select resource_key
       from southstar.runtime_resources
      where run_id = $1 and resource_type = 'artifact_ref' and status = 'accepted'
      order by resource_key
      limit 1`,
    [runId],
  );
  const goalContractHashValue = (await db.one<{ runtime_context_json: { goalContractHash: string } }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [runId],
  )).runtime_context_json.goalContractHash;
  await db.query(
    `update southstar.runtime_resources
        set payload_json = jsonb_set(payload_json, '{contractVersionRefs}', '["artifact.output@1"]'::jsonb)
      where run_id = $1 and resource_type = 'artifact_ref' and resource_key = $2`,
    [runId, artifact.resource_key],
  );
  const criterionBindings = [{
    criterionId: "criterion-blocking",
    criterionVersion: 1,
    blocking: options.criterionBlocking ?? true,
    artifactContractRef: "artifact.output",
    artifactContractVersionRef: "artifact.output@1",
    evaluatorProfileRef: options.useAliases ? "evaluator:independent" : "evaluator.independent",
    evaluatorProfileVersionRef: "evaluator.independent@2",
    verificationMode: "deterministic" as const,
    procedureRef: "procedure:criterion-blocking",
    expectedEvidenceKinds: ["artifact-ref" as const],
  }, ...(options.secondCriterion ? [{
    criterionId: "criterion-secondary",
    criterionVersion: 1,
    blocking: true,
    artifactContractRef: "artifact.output",
    artifactContractVersionRef: "artifact.output@1",
    evaluatorProfileRef: "evaluator.secondary",
    evaluatorProfileVersionRef: "evaluator.secondary@5",
    verificationMode: "deterministic" as const,
    procedureRef: "procedure:criterion-secondary",
    expectedEvidenceKinds: ["artifact-ref" as const],
  }] : [])];
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
      goalContractHash: goalContractHashValue,
      entries: [{
        requirementId: "req-blocking",
        producerTaskIds: ["task-producer"],
        artifactRefs: [options.useAliases ? "artifact:output" : "artifact.output"],
        artifactContractRefs: ["artifact.output"],
        evaluatorTaskIds: ["task-evaluator", ...(options.secondCriterion ? ["task-evaluator-secondary"] : [])],
        evaluatorProfileRefs: [...new Set(criterionBindings.map((binding) => binding.evaluatorProfileRef))].sort(),
        evaluatorProfileVersionRefs: [...new Set(criterionBindings.map((binding) => binding.evaluatorProfileVersionRef))].sort(),
        validationBindingId: "binding-req-blocking",
        criterionBindings,
        criterionIds: criterionBindings.map((binding) => binding.criterionId),
        acceptanceCriteria: [
          "The produced artifact is independently verified",
          ...(options.secondCriterion ? ["The produced artifact passes a second independent check"] : []),
        ],
        requiredEvidenceKinds: ["artifact-ref"],
      }, ...(options.includeOptionalRequirement ? [{
        requirementId: "req-optional",
        producerTaskIds: [],
        artifactRefs: [],
        evaluatorTaskIds: [],
        evaluatorProfileRefs: [],
        evaluatorProfileVersionRefs: [],
        criterionBindings: [],
        criterionIds: [],
        acceptanceCriteria: [],
        requiredEvidenceKinds: [],
      }] : [])],
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
          required: options.criterionBlocking ?? true,
          config: {
            validationBindingId: "binding-req-blocking",
            criterionId: "criterion-blocking",
            acceptanceCriterion: "The produced artifact is independently verified",
            procedureRef: "procedure:criterion-blocking",
            verificationMode: "deterministic",
            expectedEvidenceKinds: ["artifact-ref"],
          },
        }],
        onFailure: { defaultStrategy: "request-workflow-revision" },
      }, ...(options.secondCriterion ? [{
        id: "secondary",
        libraryObjectRef: "evaluator.secondary",
        libraryVersionRef: "evaluator.secondary@5",
        validationBindingIds: ["binding-req-blocking"],
        evaluators: [{
          id: "check-criterion-secondary",
          kind: "checker-agent",
          required: true,
          config: {
            validationBindingId: "binding-req-blocking",
            criterionId: "criterion-secondary",
            acceptanceCriterion: "The produced artifact passes a second independent check",
            procedureRef: "procedure:criterion-secondary",
            verificationMode: "deterministic",
            expectedEvidenceKinds: ["artifact-ref"],
          },
        }],
        onFailure: { defaultStrategy: "request-workflow-revision" },
      }] : [])],
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
    payload: {
      schemaVersion: "southstar.runtime.evidence_packet.v1",
      runId,
      taskId: "task-evaluator",
      artifactRef: artifact.resource_key,
      lineage: {
        goalContractHash: goalContractHashValue,
        evaluatorTaskId: "task-evaluator",
        evaluatorAttemptId: "attempt-1",
        evaluatorArtifactRef: artifact.resource_key,
        checks: [criterionEvidenceLineage({
          requirementId: "req-blocking",
          validationBindingId: "binding-req-blocking",
          criterion: criterionBindings[0]!,
          artifactRef: artifact.resource_key,
          evaluatorTaskId: "task-evaluator",
          evaluatorAttemptId: "attempt-1",
          evaluatorArtifactRef: artifact.resource_key,
        })],
      },
    },
  });
  await upsertRuntimeResourcePg(db, {
    id: `requirement-result-${runId}`,
    resourceType: "requirement_evaluator_result",
    resourceKey: `requirement:${runId}:req-blocking:task-evaluator:${artifact.resource_key}`,
    runId,
    taskId: "task-evaluator",
    scope: "evaluator",
    status: options.evaluatorVerdict ?? "passed",
    payload: {
      schemaVersion: "southstar.requirement_evaluator_result.v2",
      requirementId: "req-blocking",
      validationBindingId: "binding-req-blocking",
      artifactRefs: [artifact.resource_key],
      evaluatorArtifactRef: artifact.resource_key,
      evaluatorId: `evaluator-${runId}`,
      evaluatorTaskId: "task-evaluator",
      attemptId: "attempt-1",
      evaluatorProfileRef: options.useAliases ? "evaluator:independent" : "evaluator.independent",
      evaluatorProfileVersionRef: "evaluator.independent@2",
      verdict: options.evaluatorVerdict ?? "passed",
      criteriaResults: options.omitCriterion ? [] : [{
        criterionId: "criterion-blocking",
        verdict: options.evaluatorVerdict ?? "passed",
        evidenceRefs: [artifact.resource_key],
        findings: options.evaluatorVerdict === "failed" ? ["verification failed"] : [],
      }],
      evidenceRefs: [`evidence-${runId}`],
      findings: options.evaluatorVerdict === "failed" ? ["verification failed"] : [],
    },
  });
  if (options.secondCriterion) {
    await upsertRuntimeResourcePg(db, {
      id: `evidence-secondary-${runId}`,
      resourceType: "evidence_packet",
      resourceKey: `evidence-secondary-${runId}`,
      runId,
      taskId: "task-evaluator-secondary",
      scope: "evaluator",
      status: "complete",
      payload: {
        schemaVersion: "southstar.runtime.evidence_packet.v1",
        runId,
        taskId: "task-evaluator-secondary",
        artifactRef: artifact.resource_key,
        lineage: {
          goalContractHash: goalContractHashValue,
          evaluatorTaskId: "task-evaluator-secondary",
          evaluatorAttemptId: "attempt-1",
          evaluatorArtifactRef: artifact.resource_key,
          checks: [criterionEvidenceLineage({
            requirementId: "req-blocking",
            validationBindingId: "binding-req-blocking",
            criterion: criterionBindings[1]!,
            artifactRef: artifact.resource_key,
            evaluatorTaskId: "task-evaluator-secondary",
            evaluatorAttemptId: "attempt-1",
            evaluatorArtifactRef: artifact.resource_key,
          })],
        },
      },
    });
    await upsertRuntimeResourcePg(db, {
      id: `requirement-result-secondary-${runId}`,
      resourceType: "requirement_evaluator_result",
      resourceKey: `requirement:${runId}:req-blocking:task-evaluator-secondary:${artifact.resource_key}`,
      runId,
      taskId: "task-evaluator-secondary",
      scope: "evaluator",
      status: "passed",
      payload: {
        schemaVersion: "southstar.requirement_evaluator_result.v2",
        requirementId: "req-blocking",
        validationBindingId: "binding-req-blocking",
        artifactRefs: [artifact.resource_key],
        evaluatorArtifactRef: artifact.resource_key,
        evaluatorId: `evaluator-secondary-${runId}`,
        evaluatorTaskId: "task-evaluator-secondary",
        attemptId: "attempt-1",
        evaluatorProfileRef: "evaluator.secondary",
        evaluatorProfileVersionRef: "evaluator.secondary@5",
        verdict: "passed",
        criteriaResults: [{
          criterionId: "criterion-secondary",
          verdict: "passed",
          evidenceRefs: [artifact.resource_key],
          findings: [],
        }],
        evidenceRefs: [`evidence-secondary-${runId}`],
        findings: [],
      },
    });
  }
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
