import test from "node:test";
import assert from "node:assert/strict";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { evaluateRunCompletionGatePg } from "../../src/v2/evaluators/completion-gate.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("completion gate passes all completed tasks with accepted artifact_ref resources", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-pass");
    await seedTask(db, "run-gate-pass", "task-a", "completed", 0);
    await seedTask(db, "run-gate-pass", "task-b", "completed", 1);
    await acceptArtifactRef(db, "run-gate-pass", "task-a");
    await acceptArtifactRef(db, "run-gate-pass", "task-b");

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-pass" });

    assert.deepEqual(result, { runId: "run-gate-pass", status: "passed", findings: [] });
    const run = await runStatus(db, "run-gate-pass");
    assert.equal(run.status, "passed");
    assert.ok(run.completed_at);
    const evaluator = await evaluatorResult(db, "run-gate-pass");
    assert.equal(evaluator.status, "passed");
    assert.deepEqual(evaluator.payload_json, { status: "passed", findings: [] });
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

test("completion gate does not set completed_at while tasks are not ready for final evaluation", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-not-ready");
    await seedTask(db, "run-gate-not-ready", "task-a", "completed", 0);
    await seedTask(db, "run-gate-not-ready", "task-b", "running", 1);
    await acceptArtifactRef(db, "run-gate-not-ready", "task-a");

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-not-ready" });

    assert.deepEqual(result, { runId: "run-gate-not-ready", status: "not_ready", findings: ["tasks are not terminal"] });
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

    assert.equal(result.status, "failed");
    assert.deepEqual(result.findings, ["missing accepted artifact_ref for task task-a"]);
    const run = await runStatus(db, "run-gate-missing-artifact-ref");
    assert.equal(run.status, "failed");
    assert.ok(run.completed_at);
    const evaluator = await evaluatorResult(db, "run-gate-missing-artifact-ref");
    assert.equal(evaluator.status, "failed");
    assert.deepEqual(evaluator.payload_json, {
      status: "failed",
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

    assert.equal(result.status, "failed");
    assert.equal(result.findings.some((finding) => finding.includes("blocking tool proxy violation violation-run-gate-tool-proxy")), true);
    const run = await runStatus(db, "run-gate-tool-proxy");
    assert.equal(run.status, "failed");
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
      status: "failed",
      findings: ["task task-a terminal status is failed"],
    });
    const run = await runStatus(db, "run-gate-terminal-finding");
    assert.equal(run.status, "failed");
  } finally {
    await db.close();
  }
});

test("completion gate returns not_ready without mutation when a run has no tasks", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-gate-no-tasks");

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-no-tasks" });

    assert.deepEqual(result, { runId: "run-gate-no-tasks", status: "not_ready", findings: ["run has no tasks"] });
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
  payload_json: { status: string; findings: string[] };
  summary_json: { findingCount: number };
}> {
  return await db.one<{
    status: string;
    payload_json: { status: string; findings: string[] };
    summary_json: { findingCount: number };
  }>(
    "select status, payload_json, summary_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
    [`completion-gate:${runId}`],
  );
}
