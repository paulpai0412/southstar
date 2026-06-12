import test from "node:test";
import assert from "node:assert/strict";
import { evaluateArtifactGate } from "../../src/v2/agent-runner/root-session.ts";

test("passes artifact when all required fields are present", () => {
  const result = evaluateArtifactGate({
    artifact: { summary: "changed CLI", commandsRun: ["npm test"], risks: [] },
    requiredFields: ["summary", "commandsRun", "risks"],
    attempt: 1,
    maxRepairAttempts: 2,
  });

  assert.deepEqual(result, { ok: true, missingFields: [], decision: "pass" });
});

test("requests repair when required artifact fields are missing", () => {
  const result = evaluateArtifactGate({
    artifact: { summary: "changed CLI" },
    requiredFields: ["summary", "commandsRun", "risks"],
    attempt: 1,
    maxRepairAttempts: 2,
  });

  assert.equal(result.ok, false);
  assert.equal(result.decision, "repair");
  assert.deepEqual(result.missingFields, ["commandsRun", "risks"]);
  assert.match(result.repairInstruction ?? "", /commandsRun, risks/);
});

test("fails gate when repair attempts are exhausted", () => {
  const result = evaluateArtifactGate({
    artifact: {},
    requiredFields: ["summary"],
    attempt: 2,
    maxRepairAttempts: 2,
  });

  assert.equal(result.ok, false);
  assert.equal(result.decision, "fail");
});
