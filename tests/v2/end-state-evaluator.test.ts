import test from "node:test";
import assert from "node:assert/strict";
import { evaluateManagedAgentEndState } from "../../src/v2/evaluators/end-state.ts";

test("end-state evaluator rejects unsupported final report and orphan hands", () => {
  const result = evaluateManagedAgentEndState({
    acceptedArtifactRefs: ["artifact-implementation", "artifact-verification"],
    finalReportArtifactRefs: ["artifact-implementation"],
    activeHandBindings: ["hand-1"],
    unresolvedEvaluatorFindings: [],
    toolEfficiency: { toolCalls: 12, maxToolCalls: 20 },
    securityFindings: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.findings.join("\n"), /final report missing accepted artifact refs/);
  assert.match(result.findings.join("\n"), /active orphan hand bindings/);
});

test("end-state evaluator accepts complete managed-agent state", () => {
  const result = evaluateManagedAgentEndState({
    acceptedArtifactRefs: ["artifact-implementation", "artifact-verification"],
    finalReportArtifactRefs: ["artifact-implementation", "artifact-verification"],
    activeHandBindings: [],
    unresolvedEvaluatorFindings: [],
    toolEfficiency: { toolCalls: 8, maxToolCalls: 20 },
    securityFindings: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});
