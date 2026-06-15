import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { assertArtifactEvidenceGates } from "../../src/v2/quality/artifact-evidence-gates.ts";

test("artifact evidence quantitative gates pass only with complete evidence and no blocking validator failures", () => {
  const db = openSouthstarDb(":memory:");
  seedCompletedTask(db, "run-gate", "task-1");

  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: "artifact-run-gate-task-1",
    runId: "run-gate",
    taskId: "task-1",
    scope: "task",
    status: "accepted",
    title: "Accepted artifact",
    payload: {},
    summary: {
      contractRef: "implementation_report",
      evidencePacketRefs: ["evidence-run-gate-task-1"],
      validatorResultRefs: ["validator-run-gate-task-1"],
    },
  });

  upsertRuntimeResource(db, {
    resourceType: "evidence_packet",
    resourceKey: "evidence-run-gate-task-1",
    runId: "run-gate",
    taskId: "task-1",
    scope: "task",
    status: "complete",
    title: "Evidence",
    payload: { completeness: { requiredCount: 1, presentCount: 1, missingKinds: [] } },
  });

  upsertRuntimeResource(db, {
    resourceType: "validator_result",
    resourceKey: "validator-run-gate-task-1",
    runId: "run-gate",
    taskId: "task-1",
    scope: "task",
    status: "passed",
    title: "Validator",
    payload: { blocking: true, verdict: "passed" },
  });

  const result = assertArtifactEvidenceGates(db, { runId: "run-gate", minCompletedTasks: 1 });
  assert.equal(result.ok, true, result.failures.join("\n"));
});

function seedCompletedTask(db: ReturnType<typeof openSouthstarDb>, runId: string, taskId: string): void {
  createWorkflowRun(db, {
    id: runId,
    status: "passed",
    domain: "software",
    goalPrompt: "artifact gate test",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: JSON.stringify({}),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  createWorkflowTask(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: "completed",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: null,
  });
}
