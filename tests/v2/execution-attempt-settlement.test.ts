import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalHandExecutionId,
  isTerminalHandExecutionStatus,
  terminalHandExecutionStatus,
} from "../../src/v2/executor/attempt-settlement.ts";

test("attempt settlement keeps callback and observer terminal identity rules aligned", () => {
  assert.equal(canonicalHandExecutionId("run-1", "task-1", "attempt-2"), "hand-execution:run-1:task-1:attempt-2");
  assert.equal(terminalHandExecutionStatus("completed-like"), "lost");
  assert.equal(terminalHandExecutionStatus("cancelled-like"), "cancelled");
  assert.equal(terminalHandExecutionStatus("failed-like"), "failed");
  assert.equal(isTerminalHandExecutionStatus("completed"), true);
  assert.equal(isTerminalHandExecutionStatus("running"), false);
});
