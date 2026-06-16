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

  assert.equal(result.ok, true);
  assert.equal(result.decision, "pass");
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(result.normalizedArtifact, { summary: "changed CLI", commandsRun: ["npm test"], risks: [] });
});

test("unwraps nested artifact payload when required fields exist under one top-level key", () => {
  const result = evaluateArtifactGate({
    artifact: { verification_report: { summary: "ok", commandsRun: ["npm test"], testResults: ["pass"], checkerFindings: [], risks: [] } },
    requiredFields: ["summary", "commandsRun", "testResults", "checkerFindings", "risks"],
    attempt: 1,
    maxRepairAttempts: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision, "pass");
  assert.deepEqual(result.missingFields, []);
  assert.equal(typeof result.normalizedArtifact.summary, "string");
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
