import test from "node:test";
import assert from "node:assert/strict";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { evaluateRunCompletionGatePg } from "../../src/v2/evaluators/completion-gate.ts";
import {
  recordRuntimeExceptionPg,
  resolveRuntimeExceptionPg,
} from "../../src/v2/exceptions/postgres-runtime-exceptions.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

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
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "evaluate runtime exceptions",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: runId }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
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
  await acceptOrRejectArtifactRefPg(db, {
    runId,
    taskId: "task-a",
    sessionId: "session-task-a",
    attemptId: "attempt-1",
    handExecutionId: "hand-task-a",
    producer: { actorType: "hand", providerId: "workspace" },
    artifactType: "implementation_report",
    status: "accepted",
    content: { taskId: "task-a", status: "done" },
    contractRefs: ["contract:task-a"],
    summary: "Artifact for task-a",
    producedAt: "2026-06-21T00:00:00.000Z",
  });
}
