import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, recoverySavingsTelemetry } from "../../src/v2/session-recovery/telemetry.ts";

test("estimateTokens uses stable quarter-character approximation", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("recoverySavingsTelemetry clamps negative savings to zero", () => {
  assert.deepEqual(recoverySavingsTelemetry({
    originalContextTokenEstimate: 100,
    rebuiltContextTokenEstimate: 70,
    omittedFailureSuffixEstimate: 50,
  }), {
    originalContextTokenEstimate: 100,
    rebuiltContextTokenEstimate: 70,
    omittedFailureSuffixEstimate: 50,
    estimatedSavings: 30,
  });

  assert.equal(recoverySavingsTelemetry({
    originalContextTokenEstimate: 50,
    rebuiltContextTokenEstimate: 60,
    omittedFailureSuffixEstimate: 10,
  }).estimatedSavings, 0);
});
