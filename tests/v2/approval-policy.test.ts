import assert from "node:assert/strict";
import test from "node:test";
import { evaluateApprovalPolicy } from "../../src/v2/approvals/policy.ts";
import { createApprovalRequest, decideApproval } from "../../src/v2/approvals/service.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";

test("policy mode auto-approves low risk voice steering and requires manual for secret access", () => {
  assert.deepEqual(evaluateApprovalPolicy({
    mode: "policy",
    actionType: "voiceCommand",
    riskTags: ["read-only", "low-risk"],
  }), { status: "approved", decisionMode: "auto", reason: "policy low-risk auto approval" });

  assert.deepEqual(evaluateApprovalPolicy({
    mode: "policy",
    actionType: "vaultAccess",
    riskTags: ["secret-access"],
  }), { status: "pending", decisionMode: "manual", reason: "manual approval required for secret-access" });
});

test("approval request and decision are durable resources and history events", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());

  const request = createApprovalRequest(db, {
    runId: "run-approval",
    actionType: "workflowRevision",
    riskTags: ["low-risk"],
    title: "Approve workflow revision",
    payload: { revisionId: "rev-1" },
  });
  decideApproval(db, {
    approvalId: request.id,
    runId: "run-approval",
    decision: "approved",
    actorType: "user",
    reason: "reviewed in UI",
  });

  const approvals = listResources(db, { resourceType: "approval", status: "approved" });
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].payload, {
    actionType: "workflowRevision",
    riskTags: ["low-risk"],
    revisionId: "rev-1",
    decision: "approved",
    decisionReason: "reviewed in UI",
    decidedBy: "user",
  });
  assert.deepEqual(listHistoryForRun(db, "run-approval").map((event) => event.eventType), [
    "approval.requested",
    "approval.decided",
  ]);
});

test("approval payload cannot override audit action type or risk tags", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());

  const request = createApprovalRequest(db, {
    runId: "run-approval",
    actionType: "workflowRevision",
    riskTags: ["low-risk"],
    title: "Approve workflow revision",
    payload: { actionType: "vaultAccess", riskTags: ["secret-access"], revisionId: "rev-1" },
  });

  const approval = listResources(db, { resourceType: "approval", status: "pending" })
    .find((resource) => resource.id === request.id);
  assert.deepEqual(approval?.payload, {
    revisionId: "rev-1",
    actionType: "workflowRevision",
    riskTags: ["low-risk"],
  });
  assert.deepEqual(listHistoryForRun(db, "run-approval")[0]?.payload, {
    approvalId: request.id,
    actionType: "workflowRevision",
    riskTags: ["low-risk"],
  });
});

test("approval decision rejects mismatched run ownership", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());
  createWorkflowRun(db, minimalRun("run-other"));
  const request = createApprovalRequest(db, {
    runId: "run-approval",
    actionType: "workflowRevision",
    riskTags: ["low-risk"],
    title: "Approve workflow revision",
    payload: { revisionId: "rev-1" },
  });

  assert.throws(() => decideApproval(db, {
    approvalId: request.id,
    runId: "run-other",
    decision: "approved",
    actorType: "user",
    reason: "wrong run",
  }), /approval approval-.+ belongs to run run-approval, not run-other/);
});

test("deciding a missing approval rejects the decision", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());

  assert.throws(() => decideApproval(db, {
    approvalId: "approval-missing",
    runId: "run-approval",
    decision: "approved",
    actorType: "user",
    reason: "not present",
  }), /approval not found: approval-missing/);
});

function minimalRun(id = "run-approval") {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "implement approval policy",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({ activeTaskIds: [] }),
    runtimeContextJson: JSON.stringify({ scope: "software" }),
    metricsJson: JSON.stringify({}),
  };
}
