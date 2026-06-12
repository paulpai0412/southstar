import { randomUUID } from "node:crypto";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { getResourceByKey, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { ApprovalActionType } from "./policy.ts";

export type CreateApprovalRequestInput = {
  runId: string;
  taskId?: string;
  actionType: ApprovalActionType;
  riskTags: string[];
  title: string;
  payload: Record<string, unknown>;
};

export type DecideApprovalInput = {
  approvalId: string;
  runId: string;
  decision: "approved" | "rejected";
  actorType: "user" | "system" | "orchestrator";
  reason: string;
};

export function createApprovalRequest(db: SouthstarDb, input: CreateApprovalRequestInput) {
  const id = `approval-${randomUUID()}`;
  db.exec("begin immediate");
  try {
    upsertRuntimeResource(db, {
      id,
      resourceType: "approval",
      resourceKey: id,
      runId: input.runId,
      taskId: input.taskId,
      scope: "approval",
      status: "pending",
      title: input.title,
      payload: {
        ...input.payload,
        actionType: input.actionType,
        riskTags: input.riskTags,
      },
    });
    appendHistoryEvent(db, {
      runId: input.runId,
      taskId: input.taskId,
      eventType: "approval.requested",
      actorType: "orchestrator",
      payload: { approvalId: id, actionType: input.actionType, riskTags: input.riskTags },
    });
    db.exec("commit");
    return { id, status: "pending" as const };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function decideApproval(db: SouthstarDb, input: DecideApprovalInput) {
  const existing = getResourceByKey(db, "approval", input.approvalId);
  if (!existing) throw new Error(`approval not found: ${input.approvalId}`);
  if (existing.runId !== input.runId) {
    throw new Error(`approval ${input.approvalId} belongs to run ${existing.runId}, not ${input.runId}`);
  }

  db.exec("begin immediate");
  try {
    upsertRuntimeResource(db, {
      id: existing.id,
      resourceType: "approval",
      resourceKey: input.approvalId,
      runId: existing.runId ?? input.runId,
      taskId: existing.taskId,
      scope: "approval",
      status: input.decision,
      title: existing.title,
      payload: {
        ...(existing.payload as Record<string, unknown>),
        decision: input.decision,
        decisionReason: input.reason,
        decidedBy: input.actorType,
      },
    });
    appendHistoryEvent(db, {
      runId: existing.runId ?? input.runId,
      taskId: existing.taskId,
      eventType: "approval.decided",
      actorType: input.actorType,
      payload: { approvalId: input.approvalId, decision: input.decision, reason: input.reason },
    });
    db.exec("commit");
    return { id: input.approvalId, status: input.decision };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
