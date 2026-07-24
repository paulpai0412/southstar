import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { evaluateRunCompletionGatePg } from "../../src/v2/evaluators/completion-gate.ts";
import {
  recordRuntimeExceptionPg,
  resolveRuntimeExceptionPg,
} from "../../src/v2/exceptions/postgres-runtime-exceptions.ts";
import { criterionValidationCheckKey } from "../../src/v2/design-library/types.ts";
import { goalContractHash, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { canonicalGoalDesignPackageFixture } from "./fixtures/goal-design.ts";

test("completion gate blocks completed runs with unresolved critical runtime exceptions", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedCompletedRunWithAcceptedArtifactRef(db, "run-gate-unresolved-runtime-exception");
    const exception = await recordRuntimeExceptionPg(db, {
      runId: "run-gate-unresolved-runtime-exception",
      taskId: "task-a",
      sessionId: "session-task-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-task-a",
      source: "tool-proxy",
      kind: "tool_proxy_violation",
      severity: "blocking",
      status: "blocked",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["tool-call:unauthorized"],
      providerEvidence: { toolName: "filesystem.write", decision: "denied" },
    });

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-unresolved-runtime-exception" });

    assert.equal(result.outcomeStatus, "blocked");
    assert.equal(result.findings.some((finding) => finding.includes(exception.resourceKey)), true);
  } finally {
    await db.close();
  }
});

test("completion gate passes completed runs after runtime exceptions are resolved", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedCompletedRunWithAcceptedArtifactRef(db, "run-gate-resolved-runtime-exception");
    const exception = await recordRuntimeExceptionPg(db, {
      runId: "run-gate-resolved-runtime-exception",
      taskId: "task-a",
      sessionId: "session-task-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-task-a",
      source: "callback",
      kind: "late_callback",
      severity: "warning",
      status: "observed",
      observedAt: "2026-06-21T10:15:00.000Z",
      evidenceRefs: ["callback:tork:late-terminal"],
      providerEvidence: { externalJobId: "job-late-callback" },
    });
    await resolveRuntimeExceptionPg(db, {
      runId: "run-gate-resolved-runtime-exception",
      resourceKey: exception.resourceKey,
      resolvedAt: "2026-06-21T10:20:00.000Z",
      reason: "late callback acknowledged",
    });

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-resolved-runtime-exception" });

    assert.deepEqual(result, {
      runId: "run-gate-resolved-runtime-exception",
      executionStatus: "completed",
      outcomeStatus: "satisfied",
      findings: [],
    });
  } finally {
    await db.close();
  }
});

test("completion gate blocks coverage derived from a planner draft without canonical V2 Goal Design lineage", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-gate-missing-v2-goal-design";
    await seedCompletedRunWithAcceptedArtifactRef(db, runId);
    await db.query(
      "update southstar.runtime_resources set payload_json = payload_json - 'goalDesignPackage' where resource_type = 'planner_draft' and resource_key = $1",
      [`draft-${runId}`],
    );

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "blocked");
    assert.deepEqual(result.findings, [
      `canonical_goal_design_package_required: planner draft draft-${runId} does not contain a valid southstar.goal_design_package.v3`,
    ]);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_design_package_required");
  } finally {
    await db.close();
  }
});

test("completion gate blocks when the run's immutable Goal Design package hash drifts", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-gate-stale-v2-goal-design-hash";
    await seedCompletedRunWithAcceptedArtifactRef(db, runId);
    await db.query(
      "update southstar.workflow_runs set runtime_context_json = jsonb_set(runtime_context_json, '{goalDesignPackageHash}', to_jsonb('stale-package-hash'::text)) where id = $1",
      [runId],
    );

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "blocked");
    assert.deepEqual(result.findings, [
      `canonical_goal_design_package_invalid: run ${runId} immutable Goal Design package hash does not match planner draft draft-${runId}`,
    ]);
  } finally {
    await db.close();
  }
});

test("completion gate persists canonical corruption when the run Goal Contract hash drifts", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-gate-stale-goal-contract-hash";
    await seedCompletedRunWithAcceptedArtifactRef(db, runId);
    await db.query(
      "update southstar.workflow_runs set runtime_context_json = jsonb_set(runtime_context_json, '{goalContractHash}', to_jsonb('stale-contract-hash'::text)) where id = $1",
      [runId],
    );

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "blocked");
    assert.deepEqual(result.findings, [
      `canonical_goal_design_package_invalid: run ${runId} Goal Contract hash does not match planner draft draft-${runId}`,
    ]);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_design_package_invalid");
  } finally {
    await db.close();
  }
});

for (const severity of ["warning", "recoverable"] as const) {
  test(`unresolved ${severity} runtime health does not change a satisfied logical outcome`, async () => {
    const db = await createTestPostgresDb();
    const runId = `run-gate-${severity}-health`;
    try {
      await seedCompletedRunWithAcceptedArtifactRef(db, runId);
      await recordRuntimeExceptionPg(db, {
        runId,
        taskId: "task-a",
        source: severity === "warning" ? "callback" : "tork-observer",
        kind: severity === "warning" ? "late_callback" : "tork_running_hang",
        severity,
        status: "observed",
        observedAt: "2026-07-11T00:00:00.000Z",
        evidenceRefs: [`health:${severity}`],
      });

      const result = await evaluateRunCompletionGatePg(db, { runId });

      assert.equal(result.executionStatus, "completed");
      assert.equal(result.outcomeStatus, "satisfied");
      assert.deepEqual(result.findings, []);
    } finally {
      await db.close();
    }
  });
}

test("unapplied recovery decisions do not replace logical outcome evidence", async () => {
  const db = await createTestPostgresDb();
  const runId = "run-gate-unapplied-recovery-decision";
  try {
    await seedCompletedRunWithAcceptedArtifactRef(db, runId);
    await upsertRuntimeResourcePg(db, {
      resourceType: "recovery_decision",
      resourceKey: "recovery_decision:exception-a:retry-same-task-new-attempt",
      runId,
      taskId: "task-a",
      scope: "recovery",
      status: "recorded",
      title: "Recovery decision for task-a",
      payload: {
        schemaVersion: "southstar.runtime.recovery_decision.v1",
        decisionId: "decision-a",
        exceptionId: "exception-a",
        runId,
        taskId: "task-a",
        path: "retry-same-task-new-attempt",
        reason: "task attempt failed before artifact was repaired",
        operatorApprovalRequired: false,
        evidenceRefs: [],
        createdAt: "2026-06-21T11:00:00.000Z",
      },
    });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "satisfied");
    assert.deepEqual(result.findings, []);
  } finally {
    await db.close();
  }
});

test("completion gate ignores recorded managed recovery decisions", async () => {
  const db = await createTestPostgresDb();
  const runId = "run-gate-managed-recovery-decision";
  try {
    await seedCompletedRunWithAcceptedArtifactRef(db, runId);
    await upsertRuntimeResourcePg(db, {
      resourceType: "recovery_decision",
      resourceKey: "managed-recovery:exception-a:skip",
      runId,
      taskId: "task-a",
      scope: "recovery",
      status: "recorded",
      title: "Managed recovery decision for task-a",
      payload: {
        schemaVersion: "southstar.managed-recovery-decision.v1",
        decisionId: "managed-decision-a",
        runId,
        taskId: "task-a",
        action: "skip",
        reason: "managed session recovery recorded separately",
        createdAt: "2026-06-21T11:03:00.000Z",
      },
    });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.deepEqual(result, {
      runId,
      executionStatus: "completed",
      outcomeStatus: "satisfied",
      findings: [],
    });
  } finally {
    await db.close();
  }
});

test("started recovery execution does not replace logical outcome evidence", async () => {
  const db = await createTestPostgresDb();
  const runId = "run-gate-started-recovery-execution";
  try {
    await seedCompletedRunWithAcceptedArtifactRef(db, runId);
    await upsertRuntimeResourcePg(db, {
      resourceType: "recovery_execution",
      resourceKey: "recovery_execution:decision-a:attempt-1",
      runId,
      taskId: "task-a",
      scope: "recovery",
      status: "started",
      title: "Recovery execution for task-a",
      payload: {
        schemaVersion: "southstar.runtime.recovery_execution.v1",
        executionId: "execution-a",
        decisionId: "decision-a",
        exceptionId: "exception-a",
        runId,
        taskId: "task-a",
        path: "retry-same-task-new-attempt",
        status: "started",
        stateChanges: [],
        providerActions: [],
        createdAt: "2026-06-21T11:05:00.000Z",
      },
    });

    const result = await evaluateRunCompletionGatePg(db, { runId });

    assert.equal(result.outcomeStatus, "satisfied");
    assert.deepEqual(result.findings, []);
  } finally {
    await db.close();
  }
});

async function seedCompletedRunWithAcceptedArtifactRef(db: SouthstarDb, runId: string): Promise<void> {
  const goalContract: GoalContractV1 = {
    schemaVersion: "southstar.goal_contract.v2",
    originalPrompt: "evaluate runtime exceptions",
    promptHash: createHash("sha256").update("evaluate runtime exceptions").digest("hex"),
    revision: 1,
    workspace: { cwd: "/tmp/southstar" },
    domain: "software",
    intent: "evaluate",
    workType: "general",
    summary: "Evaluate runtime exceptions without changing logical completion",
    requirements: [{
      id: "req-a",
      statement: "The implementation artifact is independently verified",
      acceptanceCriteria: [{
        id: "criterion-a",
        version: 1,
        observableClaim: "The accepted implementation report passes independent verification",
        blocking: true,
        verificationIntent: ["Verify the accepted report using the independent evaluator."],
        requiredAssurance: ["deterministic"],
      }],
      blocking: true,
      source: "explicit",
      expectedArtifacts: [{ description: "Accepted implementation report" }],
    }],
    expectedArtifactRefs: ["artifact.output"],
    requiredCapabilities: [],
    nonGoals: [],
    assumptions: [],
    blockingInputs: [],
    riskTags: [],
    requestedSideEffects: [],
  };
  const contractHash = goalContractHash(goalContract);
  const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract, undefined, {
    artifactContractRef: "artifact.output",
    artifactContractVersionRef: "artifact.output@2",
    evaluatorProfileRef: "evaluator.independent",
    evaluatorProfileVersionRef: "evaluator.independent@2",
    procedureRef: "procedure.independent",
    expectedEvidenceKinds: ["artifact-ref"],
  });
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
    goalPrompt: "evaluate runtime exceptions",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: runId,
      artifactContracts: [{ id: "artifact.output", artifactType: "implementation_report" }],
      tasks: [
        { id: "task-a", requiredArtifactRefs: ["artifact.output"] },
        { id: "task-evaluator", evaluatorPipelineRef: "evaluator.independent" },
      ],
      evaluatorPipelines: [{
        id: "independent",
        libraryObjectRef: "evaluator.independent",
        libraryVersionRef: "evaluator.independent@2",
        validationBindingIds: ["binding-req-a"],
        evaluators: [{
          id: "check-criterion-a",
          kind: "checker-agent",
          required: true,
          config: {
            validationBindingId: "binding-req-a",
            criterionId: "criterion-a",
            acceptanceCriterion: "The accepted implementation report passes independent verification",
            expectedEvidenceKinds: ["artifact-ref"],
            procedureRef: "procedure.independent",
            verificationMode: "deterministic",
          },
        }],
        onFailure: { defaultStrategy: "request-workflow-revision" },
      }],
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
  await createWorkflowTaskPg(db, {
    id: "task-a",
    runId,
    taskKey: "task-a",
    status: "completed",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-task-a",
  });
  await createWorkflowTaskPg(db, {
    id: "task-evaluator",
    runId,
    taskKey: "task-evaluator",
    status: "completed",
    sortOrder: 1,
    dependsOn: ["task-a"],
    rootSessionId: "session-task-evaluator",
  });
  const artifact = await acceptOrRejectArtifactRefPg(db, {
    runId,
    taskId: "task-a",
    sessionId: "session-task-a",
    attemptId: "attempt-1",
    handExecutionId: "hand-task-a",
    producer: { actorType: "hand", providerId: "workspace" },
    artifactType: "implementation_report",
    status: "accepted",
    content: { taskId: "task-a", status: "done" },
    contractRefs: ["artifact.output"],
    summary: "Artifact for task-a",
    producedAt: "2026-06-21T00:00:00.000Z",
  });
  await db.query(
    `update southstar.runtime_resources
        set payload_json = jsonb_set(payload_json, '{contractVersionRefs}', '["artifact.output@2"]'::jsonb)
      where run_id = $1 and resource_type = 'artifact_ref' and resource_key = $2`,
    [runId, artifact.artifactRefId],
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
      goalContractHash: contractHash,
      entries: [{
        requirementId: "req-a",
        producerTaskIds: ["task-a"],
        artifactRefs: ["artifact.output"],
        artifactContractRefs: ["artifact.output"],
        evaluatorTaskIds: ["task-evaluator"],
        evaluatorProfileRefs: ["evaluator.independent"],
        evaluatorProfileVersionRefs: ["evaluator.independent@2"],
        validationBindingId: "binding-req-a",
        criterionBindings: [{
          criterionId: "criterion-a",
          criterionVersion: 1,
          blocking: true,
          artifactContractRef: "artifact.output",
          artifactContractVersionRef: "artifact.output@2",
          evaluatorProfileRef: "evaluator.independent",
          evaluatorProfileVersionRef: "evaluator.independent@2",
          verificationMode: "deterministic",
          procedureRef: "procedure.independent",
          expectedEvidenceKinds: ["artifact-ref"],
        }],
        criterionIds: ["criterion-a"],
        acceptanceCriteria: ["The accepted implementation report passes independent verification"],
        requiredEvidenceKinds: ["artifact-ref"],
      }],
    },
  });
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
      artifactRef: artifact.artifactRefId,
      lineage: {
        goalContractHash: contractHash,
        evaluatorTaskId: "task-evaluator",
        evaluatorAttemptId: "attempt-1",
        evaluatorArtifactRef: artifact.artifactRefId,
        checks: [{
          checkKey: criterionValidationCheckKey("criterion-a", "deterministic"),
          requirementId: "req-a",
          validationBindingId: "binding-req-a",
          criterionId: "criterion-a",
          criterionVersion: 1,
          verificationMode: "deterministic",
          artifactContractRef: "artifact.output",
          artifactContractVersionRef: "artifact.output@2",
          artifactInstanceRefs: [artifact.artifactRefId],
          procedureRef: "procedure.independent",
          evaluatorTaskId: "task-evaluator",
          evaluatorAttemptId: "attempt-1",
          evaluatorArtifactRef: artifact.artifactRefId,
          evaluatorProfileRef: "evaluator.independent",
          evaluatorProfileVersionRef: "evaluator.independent@2",
        }],
      },
    },
  });
  await upsertRuntimeResourcePg(db, {
    id: `requirement-result-${runId}`,
    resourceType: "requirement_evaluator_result",
    resourceKey: `requirement:${runId}:req-a:task-evaluator:${artifact.artifactRefId}`,
    runId,
    taskId: "task-evaluator",
    scope: "evaluator",
    status: "passed",
    payload: {
      schemaVersion: "southstar.requirement_evaluator_result.v2",
      requirementId: "req-a",
      validationBindingId: "binding-req-a",
      artifactRefs: [artifact.artifactRefId],
      evaluatorArtifactRef: artifact.artifactRefId,
      evaluatorId: `evaluator-${runId}`,
      evaluatorTaskId: "task-evaluator",
      attemptId: "attempt-1",
      evaluatorProfileRef: "evaluator.independent",
      evaluatorProfileVersionRef: "evaluator.independent@2",
      verdict: "passed",
      criteriaResults: [{
        criterionId: "criterion-a",
        verdict: "passed",
        evidenceRefs: [artifact.artifactRefId],
        findings: [],
      }],
      evidenceRefs: [`evidence-${runId}`],
      findings: [],
    },
  });
}
