export type ApprovalMode = "manual" | "auto" | "policy";

export type ApprovalActionType =
  | "plannerDraft"
  | "workflowRevision"
  | "memoryDelta"
  | "artifactGate"
  | "steering"
  | "voiceCommand"
  | "vaultAccess"
  | "externalWrite"
  | "deployment";

export type ApprovalPolicyInput = {
  mode: ApprovalMode;
  actionType: ApprovalActionType;
  riskTags: string[];
};

export type ApprovalPolicyDecision = {
  status: "approved" | "pending" | "rejected";
  decisionMode: "auto" | "manual";
  reason: string;
};

const manualRiskTags = new Set([
  "secret-access",
  "external-write",
  "deployment",
  "delete",
  "cost-high",
  "production-change",
]);

export function evaluateApprovalPolicy(input: ApprovalPolicyInput): ApprovalPolicyDecision {
  if (input.mode === "manual") {
    return { status: "pending", decisionMode: "manual", reason: "manual mode requires operator approval" };
  }
  if (input.mode === "auto") {
    return { status: "approved", decisionMode: "auto", reason: "auto mode approval" };
  }

  const manualTag = input.riskTags.find((tag) => manualRiskTags.has(tag));
  if (manualTag) {
    return { status: "pending", decisionMode: "manual", reason: `manual approval required for ${manualTag}` };
  }
  return { status: "approved", decisionMode: "auto", reason: "policy low-risk auto approval" };
}
