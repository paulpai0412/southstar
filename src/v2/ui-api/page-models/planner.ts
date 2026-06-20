// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { getResourceByKey, listResources } from "../../stores/resource-store.ts";
import type { PlannerPageModel } from "./types.ts";
import type { PlanBundle, SouthstarWorkflowManifest } from "../../manifests/types.ts";

export type PlannerPageModelInput = { draftId?: string | null };

export function buildPlannerPageModel(db: SouthstarDb, input: PlannerPageModelInput = {}): PlannerPageModel {
  const draftResource = input.draftId ? getResourceByKey(db, "planner_draft", input.draftId) : latestPlannerDraft(db);
  const bundle = draftResource ? parseBundle(draftResource.payload) : null;
  const workflow = bundle?.workflow ?? null;
  const taskAssignments = workflow?.tasks.map((task) => ({
    task: task.name,
    role: task.roleRef ?? "unassigned",
    agent: task.agentProfileRef ?? task.subagents[0]?.id ?? "unassigned",
    model: task.model ?? "domain-default",
    skills: task.skillRefs ?? [],
    mcp: task.mcpGrantRefs ?? [],
    memoryScope: task.memoryScopeRefs ?? [],
  })) ?? [];

  return {
    surface: "southstar.ui.planner.v1",
    selectedRunId: latestRunId(db),
    promptHistory: listResources(db, { resourceType: "planner_draft" }).map((resource) => ({
      id: resource.resourceKey,
      title: resource.title,
      status: resource.status,
      createdAt: resource.createdAt,
    })),
    activeDraft: workflow && draftResource ? {
      draftId: draftResource.resourceKey,
      workflowId: workflow.workflowId,
      goalPrompt: workflow.goalPrompt,
      taskCount: workflow.tasks.length,
      domain: workflow.domain ?? "unknown",
      intent: workflow.intent ?? "unknown",
    } : null,
    readiness: workflow ? [
      { label: "Domain / Intent", value: `${workflow.domain ?? "unknown"} / ${workflow.intent ?? "unknown"}`, status: "detected" },
      { label: "Workflow Draft", value: `${workflow.tasks.length} tasks`, status: "ready" },
      { label: "Assignments", value: `${taskAssignments.length} / ${workflow.tasks.length} assigned`, status: "ready" },
      { label: "Artifact Contract", value: `${workflow.artifactContracts?.length ?? workflow.evaluators?.[0]?.artifactTypes.length ?? 0} items`, status: "ready" },
      { label: "Stop Condition", value: `${workflow.stopConditions?.length ?? 0} policy gate(s)`, status: "ready" },
    ] : [],
    contextBudget: {
      totalTokens: estimateTokens(workflow),
      limitTokens: 128000,
      bySource: {
        "Prompt + System": workflow ? 12000 : 0,
        "Memory Injection": 0,
        "Skills + MCP Schemas": workflow ? 6000 : 0,
        "Workspace Snapshot": workflow ? 4000 : 0,
      },
    },
    artifactContract: (workflow?.artifactContracts ?? []).map((contract) => ({ label: contract.artifactType, status: "ready" })),
    stopCondition: (workflow?.stopConditions?.length ? workflow.stopConditions : [{ id: "software-feature-complete", evaluatorRefs: [] }]).map((condition) => ({
      label: condition.id,
      passed: false,
    })),
    policyControls: {
      repairAttempts: 2,
      forkOnFailure: true,
      rollbackStrategy: "Git Worktree (per task)",
      workspaceIsolation: "Per Task (worktree)",
      humanApproval: true,
    },
    taskAssignments,
  };
}

function latestPlannerDraft(db: SouthstarDb) {
  const row = db.prepare("select resource_key from runtime_resources where resource_type = 'planner_draft' order by created_at desc limit 1").get() as { resource_key: string } | undefined;
  return row ? getResourceByKey(db, "planner_draft", row.resource_key) : undefined;
}

function latestRunId(db: SouthstarDb): string | null {
  const row = db.prepare("select id from workflow_runs order by updated_at desc limit 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

function parseBundle(payload: unknown): PlanBundle {
  if (typeof payload === "string") return JSON.parse(payload) as PlanBundle;
  return payload as PlanBundle;
}

function estimateTokens(workflow: SouthstarWorkflowManifest | null): number {
  if (!workflow) return 0;
  return 12000 + workflow.tasks.length * 1200;
}
