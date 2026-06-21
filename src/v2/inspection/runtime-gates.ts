import type { RuntimeGateVerdicts, RunInspectionCounts } from "./types.ts";

export function evaluateRuntimeInspectionGates(input: {
  runStatus: string;
  counts: RunInspectionCounts;
  stopConditionStatus?: string;
}): RuntimeGateVerdicts {
  const completed = input.counts.tasks.completed;
  const accepted = input.counts.resources.acceptedArtifacts;
  const acceptedArtifactRefs = input.counts.resources.acceptedArtifactRefs;
  const completeEvidence = input.counts.resources.completeEvidencePackets;
  const blockingFailures = input.counts.resources.blockingValidatorFailures;
  const blockingToolProxyViolations = input.counts.resources.blockingToolProxyViolations;
  const oversized = input.counts.resources.oversizedPayloadRows;
  return {
    completedTasks: {
      verdict: completed > 0 ? "passed" : "failed",
      actual: completed,
      expected: ">= 1 completed task",
    },
    acceptedArtifactsEqualCompletedTasks: {
      verdict: "passed",
      actual: { acceptedArtifacts: accepted, completedTasks: completed },
      expected: "legacy accepted artifact count is display-only; canonical artifact_ref gate enforces completion",
    },
    acceptedArtifactRefsEqualCompletedTasks: {
      verdict: acceptedArtifactRefs === completed ? "passed" : "failed",
      actual: { acceptedArtifactRefs, completedTasks: completed },
      expected: "accepted artifact_ref resources == completed tasks",
    },
    completeEvidenceEqualAcceptedArtifacts: {
      verdict: completeEvidence === acceptedArtifactRefs ? "passed" : "failed",
      actual: { completeEvidencePackets: completeEvidence, acceptedArtifactRefs },
      expected: "complete evidence packets == accepted artifact_ref resources",
    },
    blockingValidatorFailuresZero: {
      verdict: blockingFailures === 0 ? "passed" : "failed",
      actual: blockingFailures,
      expected: "blocking validator failures == 0",
    },
    blockingToolProxyViolationsZero: {
      verdict: blockingToolProxyViolations === 0 ? "passed" : "failed",
      actual: blockingToolProxyViolations,
      expected: "blocking tool proxy violations == 0",
    },
    stopConditionPassed: {
      verdict: input.stopConditionStatus === "passed" ? "passed" : "failed",
      actual: input.stopConditionStatus ?? "missing",
      expected: "latest stop condition status == passed",
    },
    payloadSizeWithinLimit: {
      verdict: oversized === 0 ? "passed" : "failed",
      actual: oversized,
      expected: "runtime resource payload_json rows over 50000 bytes == 0",
    },
  };
}

export function allRuntimeGatesPassed(gates: RuntimeGateVerdicts): boolean {
  return Object.values(gates).every((gate) => gate.verdict === "passed");
}
