import assert from "node:assert/strict";
import test from "node:test";
import { evaluateArtifactGate } from "../../src/v2/agent-runner/root-session.ts";

test("artifact repair instruction references skill field sections", () => {
  const gate = evaluateArtifactGate({
    artifact: { summary: "partial" },
    requiredFields: ["summary", "commandsRun", "testResults", "checkerFindings", "risks"],
    attempt: 1,
    maxRepairAttempts: 2,
    repairContext: {
      contractId: "verification_report",
      fieldGuidance: {
        commandsRun: {
          sectionId: "#field-commandsRun",
          description: "Record of commands executed",
          dataType: "array",
          generationSteps: ["Record commands"],
          example: ["npm test"],
          validation: ["Must be array"],
        },
        testResults: {
          sectionId: "#field-testResults",
          description: "Structured test execution data",
          dataType: "array",
          generationSteps: ["Capture output"],
          example: [{ command: "npm test", passed: true, output: "ok", exitCode: 0 }],
          validation: ["Must be array"],
        },
        checkerFindings: {
          sectionId: "#field-checkerFindings",
          description: "Verification outcome for acceptance criteria",
          dataType: "array",
          generationSteps: ["Check criteria"],
          example: ["criteria met"],
          validation: ["Must be array"],
        },
        risks: {
          sectionId: "#field-risks",
          description: "Identified risks or concerns",
          dataType: "array",
          generationSteps: ["Review risks"],
          example: [],
          validation: ["Must be array"],
        },
      },
      repairGuidance: {
        template: "Missing fields: {missingFieldsList}\n{fieldInstructions}",
        fieldReferenceFormat: "- {field} -> {sectionId}: {description}",
      },
    },
  });

  assert.equal(gate.decision, "repair");
  assert.match(gate.repairInstruction ?? "", /commandsRun -> #field-commandsRun/);
  assert.match(gate.repairInstruction ?? "", /testResults -> #field-testResults/);
  assert.match(gate.repairInstruction ?? "", /checkerFindings -> #field-checkerFindings/);
  assert.match(gate.repairInstruction ?? "", /risks -> #field-risks/);
});
