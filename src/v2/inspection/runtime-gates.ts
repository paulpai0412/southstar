import type { RuntimeGateVerdicts, RunInspectionCounts } from "./types.ts";

export function evaluateRuntimeInspectionGates(input: {
  runStatus: string;
  counts: RunInspectionCounts;
  stopConditionStatus?: string;
}): RuntimeGateVerdicts {
  const completed = input.counts.tasks.completed;
  const accepted = input.counts.resources.acceptedArtifacts;
  const completeEvidence = input.counts.resources.completeEvidencePackets;
  const blockingFailures = input.counts.resources.blockingValidatorFailures;
  const oversized = input.counts.resources.oversizedPayloadRows;
  return {
    completedTasks: {
      verdict: completed > 0 ? "passed" : "failed",
      actual: completed,
      expected: ">= 1 completed task",
    },
    acceptedArtifactsEqualCompletedTasks: {
      verdict: accepted === completed ? "passed" : "failed",
      actual: { acceptedArtifacts: accepted, completedTasks: completed },
      expected: "accepted artifacts == completed tasks",
    },
    completeEvidenceEqualAcceptedArtifacts: {
      verdict: completeEvidence === accepted ? "passed" : "failed",
      actual: { completeEvidencePackets: completeEvidence, acceptedArtifacts: accepted },
      expected: "complete evidence packets == accepted artifacts",
    },
    blockingValidatorFailuresZero: {
      verdict: blockingFailures === 0 ? "passed" : "failed",
      actual: blockingFailures,
      expected: "blocking validator failures == 0",
    },
    stopConditionPassed: {
      verdict: input.stopConditionStatus === "passed" ? "passed" : "failed",
      actual: input.stopConditionStatus ?? "missing",
      expected: "latest stop condition status == passed",
    },
    payloadSizeWithinLimit: {
      verdict: oversized === 0 ? "passed" : "failed",
      actual: oversized,
      expected: "artifact/evidence/validator payload_json rows over 50000 bytes == 0",
    },
  };
}

export function allRuntimeGatesPassed(gates: RuntimeGateVerdicts): boolean {
  return Object.values(gates).every((gate) => gate.verdict === "passed");
}
