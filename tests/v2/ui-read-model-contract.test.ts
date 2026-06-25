import assert from "node:assert/strict";
import test from "node:test";

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
