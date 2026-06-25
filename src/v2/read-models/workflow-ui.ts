import { acceptedArtifactTaskIdsForRunPg } from "../artifacts/artifact-ref-store.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";

type WorkflowUiInput = {
  draftId?: string;
  runId?: string;
  taskId?: string;
};

type ValidationIssue = {
  path: string;
  message: string;
  code?: string;
};

type WorkflowCanvasNode = {
  id: string;
  label: string;
  status: string;
  dependsOn: string[];
  roleRef?: string;
  agentProfileRef?: string;
  sortOrder: number;
};

type WorkflowCanvasEdge = {
  id: string;
  source: string;
  target: string;
  status: "pending" | "satisfied";
};

type WorkflowTaskDefinitionSummary = {
  taskId: string;
  taskName: string;
  roleRef?: string;
  agentProfileRef?: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  toolGrantRefs: string[];
  artifactContract?: unknown;
  artifactContracts?: unknown;
  materializedLibraryRefs?: unknown;
};

export type WorkflowUiReadModel = {
  activeDraft: null | {
    draftId: string;
    workflowId: string;
    goalPrompt: string;
    status: string;
  };
  canvasModel: {
    mode: "draft" | "runtime";
    selectedNodeId?: string;
    nodes: WorkflowCanvasNode[];
    edges: WorkflowCanvasEdge[];
  };
  selectedDefinition: WorkflowTaskDefinitionSummary | null;
  agentLibrarySummary: {
    domain: string;
    roleCount: number;
    agentProfileCount: number;
    skillCount: number;
    mcpServerCount: number;
    toolCount: number;
    artifactContractCount: number;
    evaluatorPipelineCount: number;
  };
  validationIssues: ValidationIssue[];
  repairAttempts: number;
  commands: Array<{
    id: string;
    label: string;
    endpoint: string;
    method: "GET" | "POST";
    enabled: boolean;
    disabledReason?: string;
  }>;
};

type RuntimeTaskRow = {
  id: string;
  task_key: string;
  status: string;
  sort_order: number;
  depends_on_json: unknown;
  snapshot_json: unknown;
};

type RuntimeRunRow = {
  id: string;
  status: string;
  domain: string | null;
  runtime_context_json: unknown;
  workflow_manifest_json: unknown;
};

type DraftResourceRow = {
  resource_key: string;
  status: string;
  payload_json: unknown;
  summary_json: unknown;
};

type TaskEnvelopeRow = {
  payload_json: unknown;
};

export async function buildWorkflowUiReadModelPg(db: SouthstarDb, input: WorkflowUiInput): Promise<WorkflowUiReadModel> {
  if (input.runId) return await buildRuntimeWorkflowUiReadModel(db, input.runId, input.taskId);
  if (input.draftId) return await buildDraftWorkflowUiReadModel(db, input.draftId, input.taskId);
  throw new Error("runId or draftId is required");
}

async function buildRuntimeWorkflowUiReadModel(db: SouthstarDb, runId: string, preferredTaskId?: string): Promise<WorkflowUiReadModel> {
  const run = await db.maybeOne<RuntimeRunRow>(
    "select id, status, domain, runtime_context_json, workflow_manifest_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  if (!run) throw new Error(`run not found: ${runId}`);

  const tasks = (await db.query<RuntimeTaskRow>(
    `select id, task_key, status, sort_order, depends_on_json, snapshot_json
       from southstar.workflow_tasks
      where run_id = $1
      order by sort_order, id`,
    [runId],
  )).rows;
  const acceptedArtifactTaskIds = await acceptedArtifactTaskIdsForRunPg(db, runId);
  const workflowTasks = workflowTasksFromWorkflowManifest(run.workflow_manifest_json);
  const selectedTaskId = selectTaskId(tasks.map((task) => task.id), preferredTaskId);

  const nodes: WorkflowCanvasNode[] = tasks.map((task) => {
    const workflowTask = workflowTasks.find((candidate) => candidate.id === task.id);
    const snapshot = asRecord(task.snapshot_json);
    const roleRef = stringValue(workflowTask.roleRef) ?? stringValue(snapshot.roleRef);
    const agentProfileRef = stringValue(workflowTask.agentProfileRef) ?? stringValue(snapshot.agentProfileRef);
    return {
      id: task.id,
      label: task.task_key,
      status: task.status,
      dependsOn: stringArray(task.depends_on_json),
      sortOrder: task.sort_order,
      ...(roleRef ? { roleRef } : {}),
      ...(agentProfileRef ? { agentProfileRef } : {}),
    };
  });

  const edges: WorkflowCanvasEdge[] = nodes.flatMap((node) => node.dependsOn.map((source) => ({
    id: `${source}->${node.id}`,
    source,
    target: node.id,
    status: acceptedArtifactTaskIds.has(source) ? "satisfied" : "pending",
  })));

  const selectedDefinition = await runtimeSelectedDefinition(db, {
    runId,
    selectedTaskId,
    nodes,
    workflowTasks,
  });
  const runtimeContext = asRecord(run.runtime_context_json);
  const runtimeDraftId = stringValue(runtimeContext.draftId);
  const domain = run.domain ?? "software";
  const librarySummary = agentLibrarySummary(domain);

  return {
    activeDraft: null,
    canvasModel: {
      mode: "runtime",
      ...(selectedTaskId ? { selectedNodeId: selectedTaskId } : {}),
      nodes,
      edges,
    },
    selectedDefinition,
    agentLibrarySummary: librarySummary,
    validationIssues: [],
    repairAttempts: 0,
    commands: [
      {
        id: "open-agent-library",
        label: "Open Agent Library",
        endpoint: `/api/v2/agent-library?domain=${encodeURIComponent(domain)}`,
        method: "GET",
        enabled: true,
      },
      {
        id: "view-candidates",
        label: "View Task Candidates",
        endpoint: selectedTaskId && runtimeDraftId
          ? `/api/v2/agent-library/candidates?draftId=${encodeURIComponent(runtimeDraftId)}&taskId=${encodeURIComponent(selectedTaskId)}`
          : runtimeDraftId
          ? `/api/v2/agent-library/candidates?draftId=${encodeURIComponent(runtimeDraftId)}`
          : `/api/v2/agent-library/candidates`,
        method: "GET",
        enabled: Boolean(selectedTaskId && runtimeDraftId),
        ...(selectedTaskId && runtimeDraftId ? {} : { disabledReason: "draft context not available" }),
      },
    ],
  };
}

async function buildDraftWorkflowUiReadModel(db: SouthstarDb, draftId: string, preferredTaskId?: string): Promise<WorkflowUiReadModel> {
  const draft = await db.maybeOne<DraftResourceRow>(
    `select resource_key, status, payload_json, summary_json
       from southstar.runtime_resources
      where resource_type = 'planner_draft'
        and resource_key = $1`,
    [draftId],
  );
  if (!draft) throw new Error(`planner draft not found: ${draftId}`);

  const payload = asRecord(draft.payload_json);
  const summary = asRecord(draft.summary_json);
  const workflow = asRecord(payload.workflow);
  const workflowTasks = workflowTasksFromUnknown(workflow.tasks);
  const selectedTaskId = selectTaskId(workflowTasks.map((task) => task.id), preferredTaskId);
  const selectedTask = selectedTaskId ? workflowTasks.find((task) => task.id === selectedTaskId) ?? null : null;
  const domain = stringValue(workflow.domain) ?? "software";

  const nodes: WorkflowCanvasNode[] = workflowTasks.map((task, index) => ({
    id: task.id,
    label: task.name ?? task.id,
    status: "draft",
    dependsOn: task.dependsOn,
    sortOrder: index,
    ...(task.roleRef ? { roleRef: task.roleRef } : {}),
    ...(task.agentProfileRef ? { agentProfileRef: task.agentProfileRef } : {}),
  }));

  const edges: WorkflowCanvasEdge[] = nodes.flatMap((node) => node.dependsOn.map((source) => ({
    id: `${source}->${node.id}`,
    source,
    target: node.id,
    status: "pending",
  })));

  return {
    activeDraft: {
      draftId,
      workflowId: stringValue(summary.workflowId) ?? stringValue(workflow.workflowId) ?? draftId,
      goalPrompt: stringValue(summary.goalPrompt) ?? stringValue(workflow.goalPrompt) ?? "",
      status: draft.status,
    },
    canvasModel: {
      mode: "draft",
      ...(selectedTaskId ? { selectedNodeId: selectedTaskId } : {}),
      nodes,
      edges,
    },
    selectedDefinition: selectedTask ? {
      taskId: selectedTask.id,
      taskName: selectedTask.name ?? selectedTask.id,
      ...(selectedTask.roleRef ? { roleRef: selectedTask.roleRef } : {}),
      ...(selectedTask.agentProfileRef ? { agentProfileRef: selectedTask.agentProfileRef } : {}),
      skillRefs: selectedTask.skillRefs,
      mcpGrantRefs: selectedTask.mcpGrantRefs,
      toolGrantRefs: selectedTask.toolGrantRefs,
      materializedLibraryRefs: {
        skillRefs: selectedTask.skillRefs,
        mcpGrantRefs: selectedTask.mcpGrantRefs,
        toolGrantRefs: selectedTask.toolGrantRefs,
      },
    } : null,
    agentLibrarySummary: agentLibrarySummary(domain),
    validationIssues: validationIssues(summary.validationIssues ?? payload.validationIssues),
    repairAttempts: repairAttemptCount(payload.repairAttempts),
    commands: [
      {
        id: "open-agent-library",
        label: "Open Agent Library",
        endpoint: `/api/v2/agent-library?domain=${encodeURIComponent(domain)}`,
        method: "GET",
        enabled: true,
      },
      {
        id: "run-draft",
        label: "Run Draft",
        endpoint: "/api/v2/runs",
        method: "POST",
        enabled: draft.status === "validated",
        ...(draft.status === "validated" ? {} : { disabledReason: `draft status is ${draft.status}` }),
      },
      {
        id: "view-candidates",
        label: "View Task Candidates",
        endpoint: selectedTaskId
          ? `/api/v2/agent-library/candidates?draftId=${encodeURIComponent(draftId)}&taskId=${encodeURIComponent(selectedTaskId)}`
          : `/api/v2/agent-library/candidates?draftId=${encodeURIComponent(draftId)}`,
        method: "GET",
        enabled: Boolean(selectedTaskId),
        ...(selectedTaskId ? {} : { disabledReason: "select a task" }),
      },
    ],
  };
}

async function runtimeSelectedDefinition(
  db: SouthstarDb,
  input: {
    runId: string;
    selectedTaskId?: string;
    nodes: WorkflowCanvasNode[];
    workflowTasks: DraftTaskShape[];
  },
): Promise<WorkflowTaskDefinitionSummary | null> {
  if (!input.selectedTaskId) return null;
  const node = input.nodes.find((candidate) => candidate.id === input.selectedTaskId);
  if (!node) return null;
  const workflowTask = input.workflowTasks.find((candidate) => candidate.id === input.selectedTaskId);
  const envelope = await latestTaskEnvelope(db, input.runId, input.selectedTaskId);

  return {
    taskId: node.id,
    taskName: node.label,
    ...(node.roleRef ? { roleRef: node.roleRef } : {}),
    ...(node.agentProfileRef ? { agentProfileRef: node.agentProfileRef } : {}),
    skillRefs: stringArray(workflowTask?.skillRefs),
    mcpGrantRefs: stringArray(workflowTask?.mcpGrantRefs),
    toolGrantRefs: stringArray(workflowTask?.toolGrantRefs),
    ...(envelope.artifactContract !== undefined ? { artifactContract: envelope.artifactContract } : {}),
    ...(envelope.artifactContracts !== undefined ? { artifactContracts: envelope.artifactContracts } : {}),
    ...(envelope.materializedLibraryRefs !== undefined ? { materializedLibraryRefs: envelope.materializedLibraryRefs } : {}),
  };
}

async function latestTaskEnvelope(db: SouthstarDb, runId: string, taskId: string): Promise<{
  artifactContract?: unknown;
  artifactContracts?: unknown;
  materializedLibraryRefs?: unknown;
}> {
  const row = await db.maybeOne<TaskEnvelopeRow>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'task_envelope'
        and run_id = $1
        and task_id = $2
      order by created_at desc
      limit 1`,
    [runId, taskId],
  );
  const payload = asRecord(row?.payload_json);
  const envelope = asRecord(payload.envelope);
  const source = Object.keys(envelope).length > 0 ? envelope : payload;
  return {
    ...(source.artifactContract !== undefined ? { artifactContract: source.artifactContract } : {}),
    ...(source.artifactContracts !== undefined ? { artifactContracts: source.artifactContracts } : {}),
    ...(source.materializedLibraryRefs !== undefined ? { materializedLibraryRefs: source.materializedLibraryRefs } : {}),
  };
}

function agentLibrarySummary(domain: string): WorkflowUiReadModel["agentLibrarySummary"] {
  const skillIds = new Set<string>();
  const mcpIds = new Set<string>();
  const toolIds = new Set<string>();
  for (const profile of softwareDomainPack.agentProfiles) {
    for (const ref of profile.skillRefs) skillIds.add(ref);
    for (const ref of profile.mcpGrantRefs) mcpIds.add(ref);
    for (const tool of profile.toolPolicy.allowedTools) toolIds.add(tool);
  }
  return {
    domain,
    roleCount: softwareDomainPack.roles.length,
    agentProfileCount: softwareDomainPack.agentProfiles.length,
    skillCount: skillIds.size,
    mcpServerCount: mcpIds.size,
    toolCount: toolIds.size,
    artifactContractCount: softwareDomainPack.artifactContracts.length,
    evaluatorPipelineCount: softwareDomainPack.evaluatorPipelines.length,
  };
}

type DraftTaskShape = {
  id: string;
  name?: string;
  roleRef?: string;
  agentProfileRef?: string;
  dependsOn: string[];
  skillRefs: string[];
  mcpGrantRefs: string[];
  toolGrantRefs: string[];
};

function workflowTasksFromWorkflowManifest(value: unknown): DraftTaskShape[] {
  const workflow = asRecord(value);
  return workflowTasksFromUnknown(workflow.tasks);
}

function workflowTasksFromUnknown(value: unknown): DraftTaskShape[] {
  if (!Array.isArray(value)) return [];
  const tasks: DraftTaskShape[] = [];
  for (const candidate of value) {
    const task = asRecord(candidate);
    const id = stringValue(task.id);
    if (!id) continue;
    tasks.push({
      id,
      ...(stringValue(task.name) ? { name: stringValue(task.name) } : {}),
      ...(stringValue(task.roleRef) ? { roleRef: stringValue(task.roleRef) } : {}),
      ...(stringValue(task.agentProfileRef) ? { agentProfileRef: stringValue(task.agentProfileRef) } : {}),
      dependsOn: stringArray(task.dependsOn),
      skillRefs: stringArray(task.skillRefs),
      mcpGrantRefs: stringArray(task.mcpGrantRefs),
      toolGrantRefs: stringArray(task.toolGrantRefs),
    });
  }
  return tasks;
}

function validationIssues(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: ValidationIssue[] = [];
  for (const candidate of value) {
    const issue = asRecord(candidate);
    const path = stringValue(issue.path);
    const message = stringValue(issue.message);
    if (!path || !message) continue;
    issues.push({
      path,
      message,
      ...(stringValue(issue.code) ? { code: stringValue(issue.code) } : {}),
    });
  }
  return issues;
}

function repairAttemptCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  if (isRecord(value) && typeof value.count === "number" && Number.isFinite(value.count)) return value.count;
  return 0;
}

function selectTaskId(ids: string[], preferredTaskId?: string): string | undefined {
  if (preferredTaskId && ids.includes(preferredTaskId)) return preferredTaskId;
  return ids[0];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
