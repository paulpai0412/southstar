import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";

export type OperatorAttentionItem = {
  id: string;
  kind: "approval" | "failed-task" | "executor-attention" | "release-risk";
  title: string;
  runId?: string;
  taskId?: string;
  severity: "info" | "warning" | "critical";
  suggestedActions: string[];
};

export type OperatorAttentionPageModel = {
  surface: "southstar.ui.operator-attention.v1";
  attentionCount: number;
  items: OperatorAttentionItem[];
};

export function buildOperatorAttentionPageModel(db: SouthstarDb, _input: {}): OperatorAttentionPageModel {
  const approvals = listResources(db, { resourceType: "approval" }).filter((resource) => resource.status === "pending");
  const executorAttention = listResources(db, { resourceType: "executor_binding" }).filter((resource) => ["heartbeat-lost", "queue-timeout", "hard-timeout", "callback-missing", "orphaned"].includes(resource.status));
  const items: OperatorAttentionItem[] = [
    ...approvals.map((resource) => ({ id: resource.id, kind: "approval" as const, title: resource.title ?? "Approval required", runId: resource.runId, taskId: resource.taskId, severity: "warning" as const, suggestedActions: ["Review approval", "Approve", "Reject"] })),
    ...executorAttention.map((resource) => ({ id: resource.id, kind: "executor-attention" as const, title: resource.title ?? `Executor ${resource.status}`, runId: resource.runId, taskId: resource.taskId, severity: "critical" as const, suggestedActions: ["Reconcile", "Retry task", "Cancel job"] })),
  ];
  return { surface: "southstar.ui.operator-attention.v1", attentionCount: items.length, items };
}
