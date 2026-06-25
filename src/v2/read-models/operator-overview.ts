import type { SouthstarDb } from "../db/postgres.ts";

const ACTIVE_RUN_STATUSES = ["created", "validated", "ready", "scheduling", "running", "paused", "blocked"] as const;

export async function buildOperatorOverviewReadModelPg(db: SouthstarDb) {
  const activeRuns = (await db.query<{
    id: string;
    status: string;
    domain: string | null;
    goal_prompt: string;
    updated_at: Date;
  }>(
    `select id, status, domain, goal_prompt, updated_at
       from southstar.workflow_runs
      where status = any($1::text[])
      order by updated_at desc, id
      limit 50`,
    [[...ACTIVE_RUN_STATUSES]],
  )).rows.map((run) => ({
    runId: run.id,
    status: run.status,
    domain: run.domain ?? undefined,
    title: run.goal_prompt,
    updatedAt: run.updated_at.toISOString(),
  }));

  const attentionRows = (await db.query<{
    resource_type: string;
    resource_key: string;
    run_id: string | null;
    task_id: string | null;
    status: string;
    title: string | null;
    payload_json: unknown;
    updated_at: Date;
  }>(
    `select resource_type, resource_key, run_id, task_id, status, title, payload_json, updated_at
       from southstar.runtime_resources
      where resource_type in ('runtime_exception', 'approval', 'recovery_decision', 'executor_binding', 'hand_execution')
        and status <> all($1::text[])
      order by updated_at desc, resource_key
      limit 100`,
    [["resolved", "approved", "rejected", "completed", "passed", "cancelled", "superseded"]],
  )).rows;

  const attentionItems = attentionRows.map((row) => {
    const kind = row.resource_type;
    const severity = severityFor(row.resource_type, row.status);
    return {
      id: `${row.resource_type}:${row.resource_key}`,
      kind,
      severity,
      runId: row.run_id ?? undefined,
      taskId: row.task_id ?? undefined,
      title: row.title ?? titleFor(row.resource_type, row.status),
      status: row.status,
      reason: reasonFor(row.payload_json, row.status),
      updatedAt: row.updated_at.toISOString(),
      suggestedActions: suggestedActionsFor(row.resource_type, row.status),
    };
  }).sort(compareAttention);

  return {
    activeRuns,
    attentionItems,
    runtimeHealth: {
      activeRunCount: activeRuns.length,
      attentionCount: attentionItems.length,
      blockedCount: attentionItems.filter((item) => item.severity === "blocked").length,
    },
    defaultSelection: attentionItems[0]?.runId
      ? { runId: attentionItems[0].runId, attentionItemId: attentionItems[0].id }
      : activeRuns[0]
        ? { runId: activeRuns[0].runId }
        : null,
  };
}

function severityFor(resourceType: string, status: string): "blocked" | "error" | "warning" | "info" {
  if (resourceType === "runtime_exception") return "blocked";
  if (status.includes("failed") || status.includes("timeout") || status.includes("lost")) return "error";
  if (resourceType === "approval" || resourceType === "recovery_decision") return "warning";
  return "info";
}

function compareAttention(a: { severity: string; updatedAt: string }, b: { severity: string; updatedAt: string }): number {
  const rank: Record<string, number> = { blocked: 0, error: 1, warning: 2, info: 3 };
  return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || b.updatedAt.localeCompare(a.updatedAt);
}

function titleFor(resourceType: string, status: string): string {
  if (resourceType === "runtime_exception") return "Runtime exception";
  if (resourceType === "approval") return "Approval required";
  if (resourceType === "recovery_decision") return "Recovery decision";
  return `${resourceType} ${status}`;
}

function reasonFor(payload: unknown, status: string): string {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  return String(record.kind ?? record.reason ?? record.message ?? status);
}

function suggestedActionsFor(resourceType: string, status: string): string[] {
  if (resourceType === "runtime_exception") return ["open-exception", "review-recovery"];
  if (resourceType === "approval") return ["approve", "reject"];
  if (resourceType === "recovery_decision") return ["approve-recovery", "apply-recovery"];
  if (status.includes("timeout") || status.includes("lost")) return ["reconcile-executor-job", "cancel-executor-job"];
  return ["watch-events"];
}
