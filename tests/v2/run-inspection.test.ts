import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { appendHistoryEvent } from "../../src/v2/stores/history-store.ts";
import { inspectRun } from "../../src/v2/inspection/inspect-run.ts";

const runId = "run-inspect-1";

test("inspectRun returns healthy for a passed run with complete runtime evidence", () => {
  const db = seededInspectionDb({ runStatus: "passed", taskStatus: "completed" });
  seedAcceptedArtifactEvidenceValidator(db, "task-1");
  seedStopCondition(db, "passed");

  const inspection = inspectRun(db, { runId });

  assert.equal(inspection.runId, runId);
  assert.equal(inspection.status, "passed");
  assert.equal(inspection.health, "healthy");
  assert.equal(inspection.primaryCause, null);
  assert.equal(inspection.gates.completedTasks.verdict, "passed");
  assert.equal(inspection.gates.acceptedArtifactsEqualCompletedTasks.verdict, "passed");
  assert.equal(inspection.gates.completeEvidenceEqualAcceptedArtifacts.verdict, "passed");
  assert.equal(inspection.gates.blockingValidatorFailuresZero.verdict, "passed");
  assert.equal(inspection.gates.stopConditionPassed.verdict, "passed");
  assert.equal(inspection.tasks[0]?.artifact.accepted, 1);
  assert.equal(inspection.tasks[0]?.evidence.complete, 1);
  assert.equal(inspection.tasks[0]?.validators.passed, 1);
});

test("inspectRun reports missing runs as unknown with run_missing primary cause", () => {
  const db = openSouthstarDb(":memory:");

  const inspection = inspectRun(db, { runId: "missing-run" });

  assert.equal(inspection.runId, "missing-run");
  assert.equal(inspection.status, "missing");
  assert.equal(inspection.health, "unknown");
  assert.equal(inspection.primaryCause?.code, "run_missing");
  assert.equal(inspection.primaryCause?.severity, "blocking");
  assert.deepEqual(inspection.tasks, []);
});

test("incomplete evidence outranks blocking validator failure as primary cause", () => {
  const db = seededInspectionDb({ runStatus: "failed", taskStatus: "completed" });
  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: "artifact-run-inspect-1-task-1",
    runId,
    taskId: "task-1",
    scope: "task",
    status: "accepted",
    title: "Implementation artifact",
    payload: { summary: "missing test evidence" },
  });
  upsertRuntimeResource(db, {
    resourceType: "evidence_packet",
    resourceKey: "evidence-run-inspect-1-task-1",
    runId,
    taskId: "task-1",
    scope: "task",
    status: "incomplete",
    title: "Evidence packet",
    payload: { completeness: { missingKinds: ["test-result"] } },
  });
  upsertRuntimeResource(db, {
    resourceType: "validator_result",
    resourceKey: "validator-run-inspect-1-task-1-evidence",
    runId,
    taskId: "task-1",
    scope: "task",
    status: "failed",
    title: "Evidence validator",
    payload: { verdict: "failed", blocking: true, message: "Missing required test-result evidence" },
  });
  seedStopCondition(db, "failed");

  const inspection = inspectRun(db, { runId });

  assert.equal(inspection.primaryCause?.code, "incomplete_evidence");
  assert.equal(inspection.primaryCause?.taskId, "task-1");
  assert.equal(
    inspection.contributingCauses.some((cause) => cause.code === "blocking_validator_failed"),
    true,
  );
  assert.equal(inspection.tasks[0]?.evidence.missingKinds.includes("test-result"), true);
});

test("inspectRun accepts hand_execution-only managed running tasks", () => {
  const db = seededInspectionDb({ runStatus: "running", taskStatus: "running" });
  upsertRuntimeResource(db, {
    resourceType: "hand_execution",
    resourceKey: `hand-execution-${runId}-task-1-attempt-1`,
    runId,
    taskId: "task-1",
    scope: "hand",
    status: "running",
    title: "Managed hand execution",
    payload: {
      providerId: "tork",
      externalJobId: "job-1",
      status: "running",
      lastHeartbeatAt: "2026-06-20T08:01:00.000Z",
    },
  });

  const inspection = inspectRun(db, { runId });

  assert.equal(inspection.tasks[0]?.causes.some((cause) => cause.code === "executor_issue"), false);
  assert.equal(inspection.tasks[0]?.executor.status, "running");
  assert.equal(inspection.tasks[0]?.executor.executorType, "tork");
  assert.equal(inspection.tasks[0]?.executor.externalJobId, "job-1");
  assert.equal(inspection.tasks[0]?.executor.lastHeartbeatAt, "2026-06-20T08:01:00.000Z");
  assert.equal(inspection.tasks[0]?.executor.issue, "none");
});

test("inspectRun reports canonical artifact_ref gate failure as primary cause", () => {
  const db = seededInspectionDb({ runStatus: "passed", taskStatus: "completed" });
  upsertRuntimeResource(db, {
    resourceType: "evidence_packet",
    resourceKey: `evidence-${runId}-task-1`,
    runId,
    taskId: "task-1",
    scope: "task",
    status: "complete",
    title: "Complete evidence",
    payload: { completeness: { missingKinds: [] } },
  });
  upsertRuntimeResource(db, {
    resourceType: "validator_result",
    resourceKey: `validator-${runId}-task-1-schema`,
    runId,
    taskId: "task-1",
    scope: "task",
    status: "passed",
    title: "Schema validator",
    payload: { verdict: "passed", blocking: true },
  });
  seedStopCondition(db, "passed");

  const inspection = inspectRun(db, { runId });

  assert.equal(inspection.health, "failed");
  assert.equal(inspection.primaryCause?.code, "artifact_ref_gate_failed");
  assert.equal(inspection.primaryCause?.severity, "blocking");
  assert.match(inspection.primaryCause?.message ?? "", /accepted artifact_ref resources/);
});

test("inspectRun reports completed task gate failure as primary cause", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: runId,
    status: "passed",
    domain: "software",
    goalPrompt: "inspect run",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  seedStopCondition(db, "passed");

  const inspection = inspectRun(db, { runId });

  assert.equal(inspection.health, "failed");
  assert.equal(inspection.primaryCause?.code, "completed_tasks_gate_failed");
  assert.match(inspection.primaryCause?.message ?? "", />= 1 completed task/);
});

test("inspectRun counts oversized canonical artifact_ref payloads", () => {
  const db = seededInspectionDb({ runStatus: "passed", taskStatus: "completed" });
  upsertRuntimeResource(db, {
    resourceType: "artifact_ref",
    resourceKey: `artifact-ref-${runId}-task-1-large`,
    runId,
    taskId: "task-1",
    scope: "artifact",
    status: "accepted",
    title: "Large artifact ref",
    payload: { artifactRefId: `artifact_ref:${runId}:task-1:attempt-1:sha`, details: "x".repeat(50_001) },
  });
  upsertRuntimeResource(db, {
    resourceType: "evidence_packet",
    resourceKey: `evidence-${runId}-task-1`,
    runId,
    taskId: "task-1",
    scope: "task",
    status: "complete",
    title: "Complete evidence",
    payload: { completeness: { missingKinds: [] } },
  });
  seedStopCondition(db, "passed");

  const inspection = inspectRun(db, { runId });

  assert.equal(inspection.counts.resources.oversizedPayloadRows, 1);
  assert.equal(inspection.gates.payloadSizeWithinLimit.verdict, "failed");
  assert.equal(inspection.primaryCause?.code, "payload_too_large");
  assert.match(inspection.primaryCause?.message ?? "", /runtime resource payload_json rows/);
});

test("Design Library lineage is tolerant when library tables are absent", () => {
  const db = seededInspectionDb({
    runStatus: "running",
    taskStatus: "running",
    workflowManifest: { compiledFrom: { objectKey: "template-a", versionId: "ver-a" } },
  });
  db.exec("drop table if exists library_history;");
  db.exec("drop table if exists library_objects;");
  db.exec("drop table if exists library_similarity_index;");

  const inspection = inspectRun(db, { runId });

  assert.deepEqual(inspection.designLibrary, {
    available: false,
    reason: "library_tables_missing",
  });
});

test("Design Library lineage is available when compiledFrom and validated_from_run exist", () => {
  const db = seededInspectionDb({
    runStatus: "passed",
    taskStatus: "completed",
    workflowManifest: { compiledFrom: { objectKey: "software-dev.template.issue", versionId: "ver-template-1", source: "design-library" } },
  });
  seedAcceptedArtifactEvidenceValidator(db, "task-1");
  seedStopCondition(db, "passed");
  createLibraryTables(db);
  db.prepare(`
    insert into library_objects (id, object_key, object_kind, status, head_version_id, state_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "obj-1",
    "software-dev.template.issue",
    "workflow_template",
    "approved",
    "ver-template-1",
    JSON.stringify({}),
    new Date().toISOString(),
    new Date().toISOString(),
  );
  db.prepare(`
    insert into library_history (id, object_id, sequence, event_type, actor_type, payload_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "hist-version",
    "obj-1",
    1,
    "version.created",
    "user",
    JSON.stringify({ versionId: "ver-template-1", definitionKind: "workflow_template", contentHash: "hash-1" }),
    new Date().toISOString(),
  );
  db.prepare(`
    insert into library_history (id, object_id, sequence, event_type, actor_type, payload_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "hist-validated",
    "obj-1",
    2,
    "template.validated_from_run",
    "runtime",
    JSON.stringify({ runId, fromVersionId: "ver-template-1", templateVersionId: "ver-template-validated" }),
    new Date().toISOString(),
  );

  const inspection = inspectRun(db, { runId });

  assert.equal(inspection.designLibrary.available, true);
  if (inspection.designLibrary.available) {
    assert.equal(inspection.designLibrary.compiledFrom.versionId, "ver-template-1");
    assert.equal(inspection.designLibrary.validatedFromRun?.validatedTemplateVersionId, "ver-template-validated");
  }
});

function seededInspectionDb(input: { runStatus: string; taskStatus: string; workflowManifest?: unknown }): SouthstarDb {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: runId,
    status: input.runStatus,
    domain: "software",
    goalPrompt: "inspect run",
    workflowManifestJson: JSON.stringify(input.workflowManifest ?? { schemaVersion: "southstar.v2" }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-1",
    runId,
    taskKey: "task-implement",
    status: input.taskStatus,
    sortOrder: 0,
    dependsOn: [],
  });
  return db;
}

function seedAcceptedArtifactEvidenceValidator(db: SouthstarDb, taskId: string): void {
  upsertRuntimeResource(db, {
    resourceType: "executor_binding",
    resourceKey: `executor-${runId}-${taskId}-attempt-1`,
    runId,
    taskId,
    scope: "executor",
    status: "submitted",
    title: "Executor binding",
    payload: { executorType: "tork", torkJobId: "job-1", southstarExecutorStatus: "submitted", runnerPhase: "shutdown" },
  });
  upsertRuntimeResource(db, {
    resourceType: "artifact_ref",
    resourceKey: `artifact-ref-${runId}-${taskId}`,
    runId,
    taskId,
    scope: "artifact",
    status: "accepted",
    title: "Accepted artifact ref",
    payload: { artifactRefId: `artifact_ref:${runId}:${taskId}:attempt-1:sha` },
  });
  upsertRuntimeResource(db, {
    resourceType: "evidence_packet",
    resourceKey: `evidence-${runId}-${taskId}`,
    runId,
    taskId,
    scope: "task",
    status: "complete",
    title: "Complete evidence",
    payload: { completeness: { missingKinds: [] } },
  });
  upsertRuntimeResource(db, {
    resourceType: "validator_result",
    resourceKey: `validator-${runId}-${taskId}-schema`,
    runId,
    taskId,
    scope: "task",
    status: "passed",
    title: "Schema validator",
    payload: { verdict: "passed", blocking: true },
  });
}

function seedStopCondition(db: SouthstarDb, status: "passed" | "failed"): void {
  upsertRuntimeResource(db, {
    resourceType: "stop_condition_result",
    resourceKey: `stop-${runId}`,
    runId,
    scope: "run",
    status,
    title: "Stop condition",
    payload: { status },
  });
  appendHistoryEvent(db, {
    runId,
    eventType: "stop_condition.evaluated",
    actorType: "evaluator",
    payload: { status },
  });
}

function createLibraryTables(db: SouthstarDb): void {
  db.exec(`
    create table if not exists library_objects (
      id text primary key,
      object_key text not null unique,
      object_kind text not null,
      status text not null,
      head_version_id text,
      state_json text not null,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists library_history (
      id text primary key,
      object_id text not null,
      sequence integer not null,
      event_type text not null,
      actor_type text not null,
      payload_json text not null,
      created_at text not null
    );
    create table if not exists library_similarity_index (
      object_id text not null,
      vector_json text not null,
      updated_at text not null
    );
  `);
}
