import type { SouthstarDb } from "../stores/sqlite.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { listResources } from "../stores/resource-store.ts";
import {
  buildExecutorOpsModel,
  buildRuntimeMonitorModel,
  buildSessionsMemoryModel,
  buildTaskDetailModel,
  buildVaultMcpModel,
  buildWorkflowCanvasModel,
} from "./read-models.ts";

const operationPanelIds = [
  "planner-chat",
  "workflow-canvas",
  "runtime-monitor",
  "task-detail",
  "agent-definitions",
  "sessions-memory",
  "vault-mcp",
  "executor-ops",
] as const;

export type OperationsDashboardPanelId = typeof operationPanelIds[number];

export function buildOperationsDashboardModel(
  db: SouthstarDb,
  input: { runId?: string; taskId?: string } = {},
) {
  const runId = input.runId ?? latestRunId(db);
  const taskId = runId ? (input.taskId ?? firstTaskId(db, runId)) : undefined;
  const workflow = runId ? readRunWorkflow(db, runId) : undefined;

  return {
    surface: "pi-web.operations-dashboard.v1",
    selectedRunId: runId ?? null,
    selectedTaskId: taskId ?? null,
    panels: operationPanelIds.map((id) => ({ id, title: titleForPanel(id) })),
    plannerChat: buildPlannerChatModel(db),
    workflowCanvas: runId ? buildWorkflowCanvasModel(db, runId) : emptyWorkflowCanvas(),
    runtimeMonitor: runId ? buildRuntimeMonitorModel(db, runId) : emptyRuntimeMonitor(),
    taskDetail: runId && taskId ? buildTaskDetailModel(db, runId, taskId) : null,
    agentDefinitions: workflow ? buildAgentDefinitionsModel(workflow) : { harnesses: [], taskAgents: [] },
    sessionsMemory: runId ? buildSessionsMemoryModel(db, runId) : { runId: null, sessions: [], memoryItems: [] },
    vaultMcp: runId ? buildVaultMcpModel(db, runId) : { runId: null, vaultLeases: [], mcpGrants: [] },
    executorOps: runId ? buildExecutorOpsModel(db, runId) : { runId: null, bindings: [] },
  };
}

function buildPlannerChatModel(db: SouthstarDb) {
  return {
    drafts: listResources(db, { resourceType: "planner_draft" }).map((draft) => ({
      id: draft.id,
      status: draft.status,
      title: draft.title,
      workflowId: (draft.summary as { workflowId?: string }).workflowId,
      goalPrompt: (draft.summary as { goalPrompt?: string }).goalPrompt,
      revisionPrompt: (draft.summary as { revisionPrompt?: string }).revisionPrompt,
    })),
  };
}

function buildAgentDefinitionsModel(workflow: SouthstarWorkflowManifest) {
  return {
    harnesses: workflow.harnessDefinitions.map((harness) => ({
      id: harness.id,
      kind: harness.kind,
      image: harness.image,
      capabilities: harness.capabilities,
      supportsSteering: harness.supportsSteering,
      supportsProgress: harness.supportsProgress,
    })),
    taskAgents: workflow.tasks.flatMap((task) => task.subagents.map((subagent) => ({
      taskId: task.id,
      subagentId: subagent.id,
      harnessId: subagent.harnessId,
      requiredArtifacts: subagent.requiredArtifacts,
    }))),
  };
}

function latestRunId(db: SouthstarDb): string | undefined {
  const row = db.prepare("select id from workflow_runs order by updated_at desc limit 1").get() as { id: string } | undefined;
  return row?.id;
}

function firstTaskId(db: SouthstarDb, runId: string): string | undefined {
  const row = db.prepare("select id from workflow_tasks where run_id = ? order by sort_order limit 1").get(runId) as { id: string } | undefined;
  return row?.id;
}

function readRunWorkflow(db: SouthstarDb, runId: string): SouthstarWorkflowManifest {
  const row = db.prepare("select workflow_manifest_json from workflow_runs where id = ?")
    .get(runId) as { workflow_manifest_json: string } | undefined;
  if (!row) throw new Error(`workflow run not found: ${runId}`);
  return JSON.parse(row.workflow_manifest_json) as SouthstarWorkflowManifest;
}

function emptyWorkflowCanvas() {
  return { runId: null, status: "empty", nodes: [] };
}

function emptyRuntimeMonitor() {
  return {
    runId: null,
    status: "empty",
    latestProgress: undefined,
    latestSteering: undefined,
    executorJobIds: [],
    runningTaskIds: [],
  };
}

function titleForPanel(id: OperationsDashboardPanelId): string {
  switch (id) {
    case "planner-chat":
      return "Planner Chat";
    case "workflow-canvas":
      return "Workflow Canvas";
    case "runtime-monitor":
      return "Runtime Monitor";
    case "task-detail":
      return "Task Detail";
    case "agent-definitions":
      return "Agent Definitions";
    case "sessions-memory":
      return "Sessions/Memory";
    case "vault-mcp":
      return "Vault/MCP";
    case "executor-ops":
      return "Executor Ops";
  }
}
