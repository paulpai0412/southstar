import test from "node:test";
import assert from "node:assert/strict";
import {
  assertErrorRecoveryMetrics,
  emptyErrorRecoveryMetrics,
  formatErrorRecoverySummary,
  recordRecoveryFact,
} from "../../src/orchestrator/metrics.ts";

test("orchestrator recovery metrics quantify quarantine, retry, terminal, and completed reversal guards", () => {
  const metrics = emptyErrorRecoveryMetrics();

  recordRecoveryFact(metrics, "quarantined");
  recordRecoveryFact(metrics, "resume_attempted");
  recordRecoveryFact(metrics, "retryable_effect");
  recordRecoveryFact(metrics, "terminal_failure");
  recordRecoveryFact(metrics, "completed_preserved");

  assert.equal(metrics.orchestrator_quarantined_detected, 1);
  assert.equal(metrics.orchestrator_resume_attempts, 1);
  assert.equal(metrics.orchestrator_retryable_effects_recorded, 1);
  assert.equal(metrics.orchestrator_terminal_failures_recorded, 1);
  assert.equal(metrics.orchestrator_completed_reversals, 0);
  assert.doesNotThrow(() => assertErrorRecoveryMetrics(metrics));
  assert.match(formatErrorRecoverySummary(metrics), /orchestrator_completed_reversals=0/);
});
