import assert from "node:assert/strict";
import test from "node:test";
import { createUiReadModelEnvelope, uiCommand } from "../../src/v2/read-models/ui-envelope.ts";

test("ui read-model compatibility shim exports legacy builder symbols", async () => {
  const shim = await import("../../src/v2/ui-api/read-models.ts");

  assert.equal(typeof shim.buildWorkflowCanvasModel, "function");
  assert.equal(typeof shim.buildRuntimeMonitorModel, "function");
  assert.equal(typeof shim.buildTaskDetailModel, "function");
  assert.equal(typeof shim.buildSessionsMemoryModel, "function");
  assert.equal(typeof shim.sessionGraphResources, "function");
  assert.equal(typeof shim.buildVaultMcpModel, "function");
  assert.equal(typeof shim.buildExecutorOpsModel, "function");
});

test("ui read-model envelope includes required UI contract fields", () => {
  const envelope = createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.run_control.v1",
    kind: "run-control",
    scope: { runId: "run-ui-contract" },
    data: { runId: "run-ui-contract", status: "running" },
    commands: [
      uiCommand({
        id: "pause-run",
        label: "Pause",
        endpoint: "/api/v2/runs/run-ui-contract/pause",
        method: "POST",
        enabled: true,
      }),
    ],
    attentionItems: [],
    sourceRefs: [{ id: "run", kind: "table-row", ref: "southstar.workflow_runs:run-ui-contract" }],
    warnings: [],
    now: "2026-06-25T00:00:00.000Z",
  });

  assert.equal(envelope.schemaVersion, "southstar.read_model.run_control.v1");
  assert.equal(envelope.kind, "run-control");
  assert.equal(envelope.generatedAt, "2026-06-25T00:00:00.000Z");
  assert.equal(envelope.commands[0]?.dangerLevel, "none");
  assert.equal(envelope.commands[0]?.requiresConfirmation, false);
});

test("disabled ui command must include disabledReason", () => {
  assert.throws(
    () => uiCommand({
      id: "resume-run",
      label: "Resume",
      endpoint: "/api/v2/runs/run-ui-contract/resume",
      method: "POST",
      enabled: false,
    }),
    /disabledReason is required/,
  );
});
