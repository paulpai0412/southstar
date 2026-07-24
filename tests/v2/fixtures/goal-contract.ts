import type {
  GoalContractInterpreter,
  GoalContractV1,
  GoalCriterionInterpretationV1,
} from "../../../src/v2/orchestration/goal-contract.ts";
import { finalizeGoalContract } from "../../../src/v2/orchestration/goal-contract.ts";

export function deterministicCriterion(observableClaim: string): GoalCriterionInterpretationV1 {
  return {
    observableClaim,
    blocking: true,
    verificationIntent: ["Verify the observable claim against the accepted artifact."],
    requiredAssurance: ["deterministic"],
  };
}

export function fixedGoalInterpreter(contract: GoalContractV1): GoalContractInterpreter {
  return { interpret: async () => structuredClone(contract) };
}

export function softwareGoalContract(goalPrompt = "implement calc sum"): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt,
    cwd: "/workspace/software",
    interpretation: {
      domain: "software",
      intent: "implement_feature",
      workType: "software_feature",
      summary: goalPrompt,
      requirements: [{
        statement: goalPrompt,
        acceptanceCriteria: [deterministicCriterion(goalPrompt)],
        blocking: true,
        source: "explicit",
        expectedArtifacts: [],
      }],
      expectedArtifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
      requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
      nonGoals: [],
      assumptions: [],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: ["workspace-write"],
    },
  });
}

export function articleGoalContract(): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt: "Build and publish a browser-verifiable article",
    cwd: "/workspace/article",
    interpretation: {
      domain: "article",
      intent: "publish",
      workType: "general",
      summary: "Build and publish a browser-verifiable article",
      requirements: [{
        statement: "The article is complete, readable, and available at a URL",
        acceptanceCriteria: [{
          ...deterministicCriterion("The rendered article passes browser quality review"),
          requiredAssurance: ["browser_interaction"],
        }],
        blocking: true,
        source: "explicit",
        expectedArtifacts: [],
      }],
      expectedArtifactRefs: ["artifact.article_html", "artifact.verification_report"],
      requiredCapabilities: ["capability.workspace-write", "capability.browser"],
      nonGoals: [],
      assumptions: [],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: ["workspace-write"],
    },
  });
}

export function subscriptionGoalContract(
  goalPrompt = "Deliver a local membership subscription flow using the fake payment adapter",
  cwd = "/workspace/subscription",
): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt,
    cwd,
    interpretation: {
      domain: "software",
      intent: "implement_feature",
      workType: "software_feature",
      summary: "Deliver a production-ready local membership subscription flow",
      requirements: [
        { statement: "Authorized members can access subscription-only features", acceptanceCriteria: [deterministicCriterion("Unauthorized users are denied and authorized members are allowed")], blocking: true, source: "explicit", expectedArtifacts: [] },
        { statement: "Members can purchase a subscription and payment state is persisted", acceptanceCriteria: [deterministicCriterion("A successful fake payment activates exactly one subscription")], blocking: true, source: "explicit", expectedArtifacts: [] },
        { statement: "Members can cancel and receive the configured refund behavior", acceptanceCriteria: [deterministicCriterion("Cancellation and fake refund state are observable and idempotent")], blocking: true, source: "explicit", expectedArtifacts: [] },
        { statement: "Operators can inspect subscription and audit events", acceptanceCriteria: [deterministicCriterion("Administrative reporting shows the recorded lifecycle events")], blocking: true, source: "explicit", expectedArtifacts: [] },
      ],
      expectedArtifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
      requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
      nonGoals: ["Do not deploy or charge real payment accounts"],
      assumptions: ["The test workspace provides a fake payment adapter"],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: ["workspace-write"],
    },
  });
}
