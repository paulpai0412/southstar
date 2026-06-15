import { evaluateApprovalPolicy, type ApprovalActionType } from "../../approvals/policy.ts";
import { decideApproval } from "../../approvals/service.ts";
import { appendHistoryEvent } from "../../stores/history-store.ts";
import { getResourceByKey, upsertRuntimeResource } from "../../stores/resource-store.ts";
import type { SouthstarDb } from "../../stores/sqlite.ts";
import type { SouthstarCommandRequest, SouthstarCommandResult } from "./types.ts";
import { rejectedCommand } from "./types.ts";

type GenericCommand<T extends Record<string, unknown>> = SouthstarCommandRequest<T>;

export function addMcpConnectionCommand(db: SouthstarDb, input: GenericCommand<{ name?: string; scope?: string }>): SouthstarCommandResult {
  const name = input.payload.name ?? "mcp";
  const resource = upsertRuntimeResource(db, { resourceType: "mcp_connection", resourceKey: input.commandId, scope: "governance", status: "configured", title: name, payload: input.payload });
  const grant = upsertRuntimeResource(db, { resourceType: "mcp_grant", resourceKey: `${input.commandId}:grant`, scope: "governance", status: "configured", title: `${name} grant`, payload: { connectionId: resource.id, allowedTools: ["read"] } });
  return governanceResult(db, input.commandId, "mcp.connection.added", [resource.id, grant.id], "MCP connection configured.");
}

export function addVaultSecretGroupCommand(db: SouthstarDb, input: GenericCommand<{ name?: string; scopedAccess?: string }>): SouthstarCommandResult {
  const resource = upsertRuntimeResource(db, { resourceType: "vault_secret_group", resourceKey: input.commandId, scope: "governance", status: "configured", title: input.payload.name ?? "secret group", payload: input.payload });
  return governanceResult(db, input.commandId, "vault.secret_group.added", [resource.id], "Vault secret group configured.");
}

export function simulateApprovalPolicyCommand(db: SouthstarDb, input: GenericCommand<{ actionType?: string; riskTags?: string[] }>): SouthstarCommandResult {
  const decision = evaluateApprovalPolicy({ mode: "policy", actionType: (input.payload.actionType ?? "steering") as ApprovalActionType, riskTags: input.payload.riskTags ?? [] });
  const resource = upsertRuntimeResource(db, { resourceType: "approval_policy_simulation", resourceKey: input.commandId, scope: "governance", status: decision.status, title: "Approval policy simulation", payload: { input: input.payload, decision } });
  return governanceResult(db, input.commandId, "approval_policy.simulated", [resource.id], "Policy simulation completed.");
}

export function decideApprovalCommand(db: SouthstarDb, input: GenericCommand<{ decision?: "approved" | "rejected"; reason?: string }> & { approvalId: string }): SouthstarCommandResult {
  const approval = getResourceByKey(db, "approval", input.approvalId);
  if (!approval?.runId) return rejectedCommand(input.commandId, "Select an existing approval request before deciding.");
  if (input.payload.decision !== "approved" && input.payload.decision !== "rejected") return rejectedCommand(input.commandId, "Approval decision must be approved or rejected.");
  const decision = decideApproval(db, { approvalId: input.approvalId, runId: approval.runId, decision: input.payload.decision, actorType: input.actor.type === "system" ? "system" : "user", reason: input.payload.reason ?? "" });
  const audit = upsertRuntimeResource(db, { resourceType: "audit_log", resourceKey: input.commandId, runId: approval.runId, scope: "governance", status: "recorded", title: "Approval decision audit", payload: { approvalId: input.approvalId, decision, reason: input.payload.reason ?? "" } });
  return { commandId: input.commandId, accepted: true, status: "applied", affectedRunId: approval.runId, resourceRefs: [audit.id], eventRefs: [], nextSuggestedActions: ["Approval queue and audit log updated."] };
}

function governanceResult(db: SouthstarDb, commandId: string, eventType: string, resourceRefs: string[], next: string): SouthstarCommandResult {
  ensureRun(db);
  const audit = upsertRuntimeResource(db, { resourceType: "audit_log", resourceKey: `audit-${commandId}`, runId: "governance", scope: "governance", status: "recorded", title: eventType, payload: { commandId, eventType, resourceRefs } });
  const event = appendHistoryEvent(db, { runId: "governance", eventType, actorType: "user", payload: { commandId, resourceRefs } });
  return { commandId, accepted: true, status: "applied", affectedRunId: "governance", resourceRefs: [...resourceRefs, audit.id], eventRefs: [String(event.sequence)], nextSuggestedActions: [next] };
}

function ensureRun(db: SouthstarDb): void {
  const exists = db.prepare("select 1 from workflow_runs where id = 'governance'").get();
  if (exists) return;
  const now = new Date().toISOString();
  db.prepare(`insert into workflow_runs (id,status,domain,goal_prompt,executor_job_id,workflow_manifest_json,execution_projection_json,snapshot_json,runtime_context_json,metrics_json,created_at,updated_at,completed_at) values ('governance', 'running', 'governance', '', null, '{"tasks":[]}', '{}', '{}', '{}', '{}', ?, ?, null)`).run(now, now);
}
