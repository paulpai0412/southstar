import assert from "node:assert/strict";
import { evaluateApprovalPolicy } from "../../../src/v2/approvals/policy.ts";
import { createApprovalRequest, decideApproval } from "../../../src/v2/approvals/service.ts";
import { listResources } from "../../../src/v2/stores/resource-store.ts";
import type { RealE2EEnv } from "../env.ts";
import { createScenarioContext } from "./harness.ts";

export async function runApprovalPolicyRealScenario(env: RealE2EEnv, runId: string): Promise<void> {
  const context = createScenarioContext(env);
  assert.equal(evaluateApprovalPolicy({ mode: "policy", actionType: "voiceCommand", riskTags: ["low-risk"] }).status, "approved");
  assert.equal(evaluateApprovalPolicy({ mode: "policy", actionType: "vaultAccess", riskTags: ["secret-access"] }).status, "pending");
  const pending = createApprovalRequest(context.db, {
    runId,
    actionType: "vaultAccess",
    riskTags: ["secret-access"],
    title: "Approve vault access",
    payload: { vault: "prod" },
  });
  decideApproval(context.db, {
    approvalId: pending.id,
    runId,
    decision: "approved",
    actorType: "user",
    reason: "manual approval in E2E",
  });
  assert.equal(listResources(context.db, { resourceType: "approval", status: "approved" }).some((resource) => resource.runId === runId), true);
  console.log("phase15 approval policy scenario passed");
}
