import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { assertDesignLibrarySessionRecoveryGates } from "../../src/v2/quality/design-library-gates.ts";

test("Design Library session recovery gates require checkpoint decision operation and telemetry", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-dl-recovery",
    status: "passed",
    domain: "software",
    goalPrompt: "todo-web",
    workflowManifestJson: JSON.stringify({ compiledFrom: { templateVersionId: "ver-1" }, tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  upsertRuntimeResource(db, { resourceType: "session_checkpoint", resourceKey: "chk", runId: "run-dl-recovery", taskId: "checker", sessionId: "sess", scope: "session", status: "created", payload: { kind: "before-recovery" } });
  upsertRuntimeResource(db, { resourceType: "recovery_decision", resourceKey: "rec", runId: "run-dl-recovery", taskId: "checker", scope: "session", status: "queued", payload: { selectedStrategy: "retry-same-agent", tokenTelemetry: { estimatedSavings: 100 } } });
  upsertRuntimeResource(db, { resourceType: "session_operation", resourceKey: "op", runId: "run-dl-recovery", taskId: "checker", sessionId: "sess2", scope: "session", status: "succeeded", payload: { type: "replay", fallbackUsed: false } });
  upsertRuntimeResource(db, { resourceType: "context_packet", resourceKey: "ctx", runId: "run-dl-recovery", taskId: "checker", sessionId: "sess2", scope: "software", status: "created", payload: { tokenEstimate: { total: 100 }, checkpointSummary: { text: "checkpoint" } } });
  upsertRuntimeResource(db, { resourceType: "task_envelope", resourceKey: "env", runId: "run-dl-recovery", taskId: "checker", sessionId: "sess2", scope: "software", status: "created", payload: { agentPrompt: "checkpoint" } });

  const gate = assertDesignLibrarySessionRecoveryGates(db, { runId: "run-dl-recovery" });
  assert.equal(gate.ok, true, gate.failures.join("\n"));
});

test("Design Library session recovery gates fail without token telemetry", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-dl-recovery-missing",
    status: "passed",
    domain: "software",
    goalPrompt: "todo-web",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  const gate = assertDesignLibrarySessionRecoveryGates(db, { runId: "run-dl-recovery-missing" });
  assert.equal(gate.ok, false);
  assert.equal(gate.failures.includes("missing recovery_decision with token telemetry"), true);
});
