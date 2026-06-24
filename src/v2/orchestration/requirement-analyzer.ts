import type { RequirementSpecV2 } from "../design-library/types.ts";

export function analyzeRequirementDeterministically(goalPrompt: string): RequirementSpecV2 {
  const summary = goalPrompt.trim();
  const workType = /fix|bug|failing|修正|錯誤/i.test(goalPrompt) ? "bugfix" : "software_feature";
  return {
    summary,
    workType,
    requiredCapabilities: [
      "capability.repo-read",
      "capability.repo-write",
      "capability.test-execution",
    ],
    expectedArtifacts: [
      "artifact.implementation_plan",
      "artifact.implementation_report",
      "artifact.verification_report",
      "artifact.completion_report",
    ],
    acceptanceCriteria: [summary],
    nonGoals: [],
    riskNotes: [],
    workspaceAssumptions: [],
    missingInputs: [],
  };
}
