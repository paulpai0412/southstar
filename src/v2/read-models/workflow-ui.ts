import { acceptedArtifactTaskIdsForRunPg } from "../artifacts/artifact-ref-store.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { softwareVaultLeasePolicies } from "../design-library/software-library-seed.ts";
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
  kind: "task";
  status: string;
  dependsOn: string[];
  roleRef?: string;
  agentProfileRef?: string;
  sortOrder: number;
  artifactKind?: string;
  badges: Array<{ label: string; tone: "neutral" | "good" | "warn" | "danger" }>;
  attention?: {
    severity: "info" | "warning" | "error" | "blocked";
    reason: string;
  };
};

type WorkflowCanvasEdge = {
  id: string;
  source: string;
  target: string;
  status: "pending" | "ready" | "active" | "blocked" | "satisfied";
};

type WorkflowTaskDefinitionSummary = {
  taskId: string;
  taskName: string;
  roleRef?: string;
  agentProfileRef?: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  toolGrantRefs: string[];
  profileOverride?: unknown;
  effectiveProfile?: {
    provider?: string;
    model?: string;
    thinkingLevel?: string;
    instruction?: string;
    skillRefs: string[];
    mcpGrantRefs: string[];
  };
  editable: boolean;
  roleDefinition?: unknown;
  agentProfile?: unknown;
  vaultPolicy?: unknown;
  vaultPolicies?: unknown;
  artifactContract?: unknown;
  artifactContracts?: unknown;
  evaluatorPipeline?: unknown;
  contextPolicy?: unknown;
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
    graphId: string;
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
  repairAttemptDetails: unknown[];
  plannerTrace: Record<string, unknown> | null;
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

type RuntimeOverlayRow = {
  resource_type: string;
  resource_key: string;
  task_id: string | null;
  status: string;
  title: string | null;
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
  const overlaysByTask = runtimeOverlaysByTask(await runtimeOverlayRows(db, runId));
  const workflowTasks = workflowTasksFromWorkflowManifest(run.workflow_manifest_json);
  const selectedTaskId = selectTaskId(tasks.map((task) => task.id), preferredTaskId);
  const domain = run.domain ?? "software";

  const nodes: WorkflowCanvasNode[] = tasks.map((task) => {
    const workflowTask = workflowTasks.find((candidate) => candidate.id === task.id);
    const snapshot = asRecord(task.snapshot_json);
    const roleRef = stringValue(workflowTask.roleRef) ?? stringValue(snapshot.roleRef);
    const agentProfileRef = stringValue(workflowTask.agentProfileRef) ?? stringValue(snapshot.agentProfileRef);
    const overlays = overlaysByTask.get(task.id) ?? [];
    const artifactKind = stringValue(workflowTask.artifactKind) ?? stringValue(snapshot.artifactKind);
    const attention = attentionFromOverlays(overlays);
    return {
      id: task.id,
      label: task.task_key,
      kind: "task",
      status: task.status,
      dependsOn: stringArray(task.depends_on_json),
      sortOrder: task.sort_order,
      ...(roleRef ? { roleRef } : {}),
      ...(agentProfileRef ? { agentProfileRef } : {}),
      ...(artifactKind ? { artifactKind } : {}),
      badges: overlayBadges(overlays),
      ...(attention ? { attention } : {}),
    };
  });

  const edges: WorkflowCanvasEdge[] = nodes.flatMap((node) => node.dependsOn.map((source) => ({
    id: `${source}->${node.id}`,
    source,
    target: node.id,
    status: runtimeEdgeStatus({
      source,
      target: node,
      nodes,
      acceptedArtifactTaskIds,
    }),
  })));

  const selectedDefinition = await runtimeSelectedDefinition(db, {
    runId,
    selectedTaskId,
    domain,
    nodes,
    workflowTasks,
  });
  const runtimeContext = asRecord(run.runtime_context_json);
  const runtimeDraftId = stringValue(runtimeContext.draftId);
  const librarySummary = agentLibrarySummary(domain);

  return {
    activeDraft: null,
    canvasModel: {
      graphId: runId,
      mode: "runtime",
      ...(selectedTaskId ? { selectedNodeId: selectedTaskId } : {}),
      nodes,
      edges,
    },
    selectedDefinition,
    agentLibrarySummary: librarySummary,
    validationIssues: [],
    repairAttempts: 0,
    repairAttemptDetails: [],
    plannerTrace: null,
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
  const issues = validationIssues(summary.validationIssues ?? payload.validationIssues);
  const repairDetails = repairAttemptDetails(payload.repairAttempts ?? summary.repairAttempts);

  const nodes: WorkflowCanvasNode[] = workflowTasks.map((task, index) => {
    const nodeIssues = validationIssuesForTask(issues, task.id, index);
    return {
      id: task.id,
      label: task.name ?? task.id,
      kind: "task",
      status: draftNodeStatus(draft.status, nodeIssues.length > 0),
      dependsOn: task.dependsOn,
      sortOrder: index,
      ...(task.roleRef ? { roleRef: task.roleRef } : {}),
      ...(task.agentProfileRef ? { agentProfileRef: task.agentProfileRef } : {}),
      ...(task.artifactKind ? { artifactKind: task.artifactKind } : {}),
      badges: draftNodeBadges({ task, validationIssueCount: nodeIssues.length, repairDetails }),
    };
  });

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
      graphId: draftId,
      mode: "draft",
      ...(selectedTaskId ? { selectedNodeId: selectedTaskId } : {}),
      nodes,
      edges,
    },
    selectedDefinition: selectedTask ? taskDefinitionSummary(selectedTask, domain) : null,
    agentLibrarySummary: agentLibrarySummary(domain),
    validationIssues: issues,
    repairAttempts: repairAttemptCount(payload.repairAttempts ?? summary.repairAttempts),
    repairAttemptDetails: repairDetails,
    plannerTrace: plannerTrace(payload.plannerTrace, summary.plannerTrace),
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
    domain: string;
    nodes: WorkflowCanvasNode[];
    workflowTasks: DraftTaskShape[];
  },
): Promise<WorkflowTaskDefinitionSummary | null> {
  if (!input.selectedTaskId) return null;
  const node = input.nodes.find((candidate) => candidate.id === input.selectedTaskId);
  if (!node) return null;
  const workflowTask = input.workflowTasks.find((candidate) => candidate.id === input.selectedTaskId);
  const envelope = await latestTaskEnvelope(db, input.runId, input.selectedTaskId);
  const envelopeRefs = asRecord(envelope.materializedLibraryRefs);
  const skillRefs = envelopeStringArray(envelopeRefs, "skillRefs", stringArray(workflowTask?.skillRefs));
  const mcpGrantRefs = envelopeStringArray(envelopeRefs, "mcpGrantRefs", stringArray(workflowTask?.mcpGrantRefs));
  const toolGrantRefs = envelopeStringArray(envelopeRefs, "toolGrantRefs", stringArray(workflowTask?.toolGrantRefs));
  const libraryDetails = libraryDefinitionDetails({
    domain: input.domain,
    roleRef: node.roleRef,
    agentProfileRef: node.agentProfileRef,
    artifactContractRef: workflowTask?.artifactContractRef,
    artifactKind: workflowTask?.artifactKind,
    evaluatorPipelineRef: workflowTask?.evaluatorPipelineRef,
    contextPolicyRef: workflowTask?.contextPolicyRef,
    vaultLeasePolicyRefs: workflowTask?.vaultLeasePolicyRefs ?? [],
  });

  return {
    taskId: node.id,
    taskName: node.label,
    ...(node.roleRef ? { roleRef: node.roleRef } : {}),
    ...(node.agentProfileRef ? { agentProfileRef: node.agentProfileRef } : {}),
    skillRefs,
    mcpGrantRefs,
    toolGrantRefs,
    editable: false,
    effectiveProfile: effectiveProfileFromSources({
      agentProfile: envelope.agentProfile ?? libraryDetails.agentProfile,
      skillRefs,
      mcpGrantRefs,
    }),
    ...libraryDetails,
    ...(envelope.roleDefinition !== undefined ? { roleDefinition: envelope.roleDefinition } : {}),
    ...(envelope.agentProfile !== undefined ? { agentProfile: envelope.agentProfile } : {}),
    ...(envelope.vaultPolicy !== undefined ? { vaultPolicy: envelope.vaultPolicy } : {}),
    ...(envelope.vaultPolicies !== undefined ? { vaultPolicies: envelope.vaultPolicies } : {}),
    ...(envelope.artifactContract !== undefined ? { artifactContract: envelope.artifactContract } : {}),
    ...(envelope.artifactContracts !== undefined ? { artifactContracts: envelope.artifactContracts } : {}),
    ...(envelope.evaluatorPipeline !== undefined ? { evaluatorPipeline: envelope.evaluatorPipeline } : {}),
    ...(envelope.contextPolicy !== undefined ? { contextPolicy: envelope.contextPolicy } : {}),
    ...(envelope.materializedLibraryRefs !== undefined ? { materializedLibraryRefs: envelope.materializedLibraryRefs } : {}),
  };
}

async function latestTaskEnvelope(db: SouthstarDb, runId: string, taskId: string): Promise<{
  roleDefinition?: unknown;
  agentProfile?: unknown;
  vaultPolicy?: unknown;
  vaultPolicies?: unknown;
  artifactContract?: unknown;
  artifactContracts?: unknown;
  evaluatorPipeline?: unknown;
  contextPolicy?: unknown;
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
  const roleDefinition = source.roleDefinition ?? source.role;
  const materializedLibraryRefs = source.materializedLibraryRefs ?? source.libraryRefs ?? source.refs;
  return {
    ...(roleDefinition !== undefined ? { roleDefinition } : {}),
    ...(source.agentProfile !== undefined ? { agentProfile: source.agentProfile } : {}),
    ...(source.vaultPolicy !== undefined ? { vaultPolicy: source.vaultPolicy } : {}),
    ...(source.vaultPolicies !== undefined ? { vaultPolicies: source.vaultPolicies } : {}),
    ...(source.artifactContract !== undefined ? { artifactContract: source.artifactContract } : {}),
    ...(source.artifactContracts !== undefined ? { artifactContracts: source.artifactContracts } : {}),
    ...(source.evaluatorPipeline !== undefined ? { evaluatorPipeline: source.evaluatorPipeline } : {}),
    ...(source.contextPolicy !== undefined ? { contextPolicy: source.contextPolicy } : {}),
    ...(materializedLibraryRefs !== undefined ? { materializedLibraryRefs } : {}),
  };
}

async function runtimeOverlayRows(db: SouthstarDb, runId: string): Promise<RuntimeOverlayRow[]> {
  return (await db.query<RuntimeOverlayRow>(
    `select resource_type, resource_key, task_id, status, title, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type in ('artifact_ref', 'executor_binding', 'hand_execution', 'runtime_exception', 'approval', 'recovery_decision')
      order by updated_at desc, resource_key`,
    [runId],
  )).rows;
}

function runtimeOverlaysByTask(rows: RuntimeOverlayRow[]): Map<string, RuntimeOverlayRow[]> {
  const byTask = new Map<string, RuntimeOverlayRow[]>();
  for (const row of rows) {
    if (!row.task_id) continue;
    const current = byTask.get(row.task_id) ?? [];
    current.push(row);
    byTask.set(row.task_id, current);
  }
  return byTask;
}

function overlayBadges(rows: RuntimeOverlayRow[]): WorkflowCanvasNode["badges"] {
  const badges: WorkflowCanvasNode["badges"] = [];
  for (const row of [...rows].sort((a, b) => overlayOrder(a.resource_type) - overlayOrder(b.resource_type))) {
    const label = overlayLabel(row);
    if (!label) continue;
    badges.push({ label, tone: overlayTone(row) });
  }
  return badges;
}

function overlayOrder(resourceType: string): number {
  if (resourceType === "artifact_ref") return 0;
  if (resourceType === "executor_binding" || resourceType === "hand_execution") return 1;
  if (resourceType === "runtime_exception") return 2;
  if (resourceType === "approval") return 3;
  if (resourceType === "recovery_decision") return 4;
  return 9;
}

function overlayLabel(row: RuntimeOverlayRow): string | null {
  if (row.resource_type === "artifact_ref") return `artifact ${row.status}`;
  if (row.resource_type === "executor_binding" || row.resource_type === "hand_execution") return `executor ${row.status}`;
  if (row.resource_type === "runtime_exception") return `exception ${row.status}`;
  if (row.resource_type === "approval") return `approval ${row.status}`;
  if (row.resource_type === "recovery_decision") return `recovery ${row.status}`;
  return null;
}

function overlayTone(row: RuntimeOverlayRow): "neutral" | "good" | "warn" | "danger" {
  if (row.resource_type === "artifact_ref" && ["accepted", "passed", "completed"].includes(row.status)) return "good";
  if (row.resource_type === "runtime_exception") return "danger";
  if (row.resource_type === "approval" || row.resource_type === "recovery_decision") return "warn";
  if (row.status.includes("failed") || row.status.includes("timeout") || row.status.includes("lost")) return "danger";
  return "neutral";
}

function attentionFromOverlays(rows: RuntimeOverlayRow[]): WorkflowCanvasNode["attention"] | null {
  const ranked = rows
    .map((row) => ({ row, attention: attentionForOverlay(row) }))
    .filter((entry): entry is { row: RuntimeOverlayRow; attention: NonNullable<WorkflowCanvasNode["attention"]> } => entry.attention !== null)
    .sort((a, b) => attentionRank(a.attention.severity) - attentionRank(b.attention.severity));
  return ranked[0]?.attention ?? null;
}

function attentionForOverlay(row: RuntimeOverlayRow): WorkflowCanvasNode["attention"] | null {
  if (row.resource_type === "runtime_exception") return { severity: "blocked", reason: overlayReason(row) };
  if (row.status.includes("failed") || row.status.includes("timeout") || row.status.includes("lost")) {
    return { severity: "error", reason: overlayReason(row) };
  }
  if (row.resource_type === "approval" || row.resource_type === "recovery_decision") {
    return { severity: "warning", reason: overlayReason(row) };
  }
  return null;
}

function overlayReason(row: RuntimeOverlayRow): string {
  const payload = asRecord(row.payload_json);
  return row.title
    ?? stringValue(payload.reason)
    ?? stringValue(payload.message)
    ?? stringValue(payload.kind)
    ?? row.status;
}

function attentionRank(severity: NonNullable<WorkflowCanvasNode["attention"]>["severity"]): number {
  if (severity === "blocked") return 0;
  if (severity === "error") return 1;
  if (severity === "warning") return 2;
  return 3;
}

function runtimeEdgeStatus(input: {
  source: string;
  target: WorkflowCanvasNode;
  nodes: WorkflowCanvasNode[];
  acceptedArtifactTaskIds: Set<string>;
}): WorkflowCanvasEdge["status"] {
  const sourceNode = input.nodes.find((node) => node.id === input.source);
  if (isBlockingStatus(input.target.status) || isBlockingStatus(sourceNode?.status)) return "blocked";
  if (!input.acceptedArtifactTaskIds.has(input.source)) return "pending";
  if (isActiveStatus(input.target.status)) return "active";
  if (isReadyStatus(input.target.status)) return "ready";
  return "satisfied";
}

function isBlockingStatus(status: string | null | undefined): boolean {
  return ["blocked", "exception", "failed", "cancelled"].includes((status ?? "").toLowerCase());
}

function isActiveStatus(status: string | null | undefined): boolean {
  return ["running", "scheduling"].includes((status ?? "").toLowerCase());
}

function isReadyStatus(status: string | null | undefined): boolean {
  return ["ready", "queued", "pending"].includes((status ?? "").toLowerCase());
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

function taskDefinitionSummary(task: DraftTaskShape, domain: string): WorkflowTaskDefinitionSummary {
  const libraryDetails = libraryDefinitionDetails({
    domain,
    roleRef: task.roleRef,
    agentProfileRef: task.agentProfileRef,
    artifactContractRef: task.artifactContractRef,
    artifactKind: task.artifactKind,
    evaluatorPipelineRef: task.evaluatorPipelineRef,
    contextPolicyRef: task.contextPolicyRef,
    vaultLeasePolicyRefs: task.vaultLeasePolicyRefs,
  });
  const effectiveProfile = effectiveProfileForDraftTask(task, libraryDetails.agentProfile);
  return {
    taskId: task.id,
    taskName: task.name ?? task.id,
    ...(task.roleRef ? { roleRef: task.roleRef } : {}),
    ...(task.agentProfileRef ? { agentProfileRef: task.agentProfileRef } : {}),
    skillRefs: effectiveProfile.skillRefs,
    mcpGrantRefs: effectiveProfile.mcpGrantRefs,
    toolGrantRefs: task.toolGrantRefs,
    ...(task.profileOverride !== undefined ? { profileOverride: task.profileOverride } : {}),
    effectiveProfile,
    editable: true,
    ...libraryDetails,
    materializedLibraryRefs: {
      skillRefs: effectiveProfile.skillRefs,
      mcpGrantRefs: effectiveProfile.mcpGrantRefs,
      toolGrantRefs: task.toolGrantRefs,
      ...(task.vaultLeasePolicyRefs.length > 0 ? { vaultLeasePolicyRefs: task.vaultLeasePolicyRefs } : {}),
      ...(task.artifactContractRef ? { artifactContractRef: task.artifactContractRef } : {}),
      ...(task.evaluatorPipelineRef ? { evaluatorPipelineRef: task.evaluatorPipelineRef } : {}),
      ...(task.contextPolicyRef ? { contextPolicyRef: task.contextPolicyRef } : {}),
    },
  };
}

function libraryDefinitionDetails(input: {
  domain: string;
  roleRef?: string | null;
  agentProfileRef?: string | null;
  artifactContractRef?: string | null;
  artifactKind?: string | null;
  evaluatorPipelineRef?: string | null;
  contextPolicyRef?: string | null;
  vaultLeasePolicyRefs: string[];
}): Partial<WorkflowTaskDefinitionSummary> {
  if (input.domain !== "software") return {};
  const roleDefinition = input.roleRef ? softwareDomainPack.roles.find((role) => role.id === input.roleRef) : undefined;
  const agentProfile = input.agentProfileRef
    ? softwareDomainPack.agentProfiles.find((profile) => profile.id === input.agentProfileRef)
    : undefined;
  const artifactContractRef = input.artifactContractRef
    ?? (input.artifactKind && softwareDomainPack.artifactContracts.some((contract) => contract.id === input.artifactKind)
      ? input.artifactKind
      : undefined)
    ?? roleDefinition?.artifactOutputs[0];
  const artifactContract = artifactContractRef
    ? softwareDomainPack.artifactContracts.find((contract) => contract.id === artifactContractRef)
    : undefined;
  const evaluatorPipeline = input.evaluatorPipelineRef
    ? softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.id === input.evaluatorPipelineRef)
    : evaluatorPipelineForArtifact(artifactContractRef);
  const contextPolicyRef = input.contextPolicyRef ?? agentProfile?.contextPolicyRef;
  const contextPolicy = contextPolicyRef
    ? softwareDomainPack.contextPolicies.find((policy) => policy.id === contextPolicyRef)
    : undefined;
  const vaultPolicies = input.vaultLeasePolicyRefs
    .map((ref) => softwareVaultLeasePolicies.find((policy) => policy.id === ref))
    .filter((policy): policy is NonNullable<typeof policy> => Boolean(policy));

  return {
    ...(roleDefinition ? { roleDefinition } : {}),
    ...(agentProfile ? { agentProfile } : {}),
    ...(vaultPolicies[0] ? { vaultPolicy: vaultPolicies[0] } : {}),
    ...(vaultPolicies.length > 0 ? { vaultPolicies } : {}),
    ...(artifactContract ? { artifactContract } : {}),
    ...(evaluatorPipeline ? { evaluatorPipeline } : {}),
    ...(contextPolicy ? { contextPolicy } : {}),
  };
}

function evaluatorPipelineForArtifact(artifactContractRef: string | undefined): unknown {
  if (!artifactContractRef) return undefined;
  return softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.evaluators.some((evaluator) => (
    stringValue(evaluator.config.artifactRef) === artifactContractRef
  )));
}

function draftNodeStatus(draftStatus: string, hasValidationIssues: boolean): WorkflowCanvasNode["status"] {
  if (hasValidationIssues) return "blocked";
  const normalized = draftStatus.toLowerCase();
  if (normalized === "validated") return "ready";
  if (normalized === "running") return "running";
  if (normalized === "completed" || normalized === "passed") return "satisfied";
  if (normalized === "failed" || normalized === "invalid" || normalized === "rejected") return "failed";
  return "pending";
}

function draftNodeBadges(input: {
  task: DraftTaskShape;
  validationIssueCount: number;
  repairDetails: unknown[];
}): WorkflowCanvasNode["badges"] {
  const badges: WorkflowCanvasNode["badges"] = [];
  if (input.task.roleRef) badges.push({ label: `role ${input.task.roleRef}`, tone: "neutral" });
  if (input.task.agentProfileRef) badges.push({ label: `profile ${input.task.agentProfileRef}`, tone: "neutral" });
  if (input.task.skillRefs.length > 0) badges.push({ label: `skills ${input.task.skillRefs.length}`, tone: "neutral" });
  if (input.task.mcpGrantRefs.length > 0) badges.push({ label: `mcp ${input.task.mcpGrantRefs.length}`, tone: "neutral" });
  if (input.task.toolGrantRefs.length > 0) badges.push({ label: `tools ${input.task.toolGrantRefs.length}`, tone: "neutral" });
  badges.push(input.validationIssueCount > 0
    ? { label: `validation issues ${input.validationIssueCount}`, tone: "warn" }
    : { label: "validation passed", tone: "good" });
  const lastRepair = input.repairDetails
    .map((entry) => asRecord(entry))
    .findLast((entry) => Object.keys(entry).length > 0);
  const repairStatus = stringValue(lastRepair?.status);
  if (repairStatus) badges.push({ label: `repair ${repairStatus}`, tone: repairStatus === "repaired" ? "good" : "warn" });
  return badges;
}

type DraftTaskShape = {
  id: string;
  name?: string;
  roleRef?: string;
  agentProfileRef?: string;
  artifactKind?: string;
  artifactContractRef?: string;
  evaluatorPipelineRef?: string;
  contextPolicyRef?: string;
  vaultLeasePolicyRefs: string[];
  dependsOn: string[];
  skillRefs: string[];
  mcpGrantRefs: string[];
  toolGrantRefs: string[];
  profileOverride?: Record<string, unknown>;
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
      ...(stringValue(task.artifactKind) ? { artifactKind: stringValue(task.artifactKind) } : {}),
      ...(stringValue(task.artifactContractRef) ? { artifactContractRef: stringValue(task.artifactContractRef) } : {}),
      ...(stringValue(task.evaluatorPipelineRef) ? { evaluatorPipelineRef: stringValue(task.evaluatorPipelineRef) } : {}),
      ...(stringValue(task.contextPolicyRef) ? { contextPolicyRef: stringValue(task.contextPolicyRef) } : {}),
      vaultLeasePolicyRefs: stringArray(task.vaultLeasePolicyRefs),
      dependsOn: stringArray(task.dependsOn),
      skillRefs: stringArray(task.skillRefs),
      mcpGrantRefs: stringArray(task.mcpGrantRefs),
      toolGrantRefs: stringArray(task.toolGrantRefs),
      ...(isRecord(task.profileOverride) ? { profileOverride: asRecord(task.profileOverride) } : {}),
    });
  }
  return tasks;
}

function effectiveProfileForDraftTask(
  task: DraftTaskShape,
  agentProfile: unknown,
): NonNullable<WorkflowTaskDefinitionSummary["effectiveProfile"]> {
  const profile = asRecord(agentProfile);
  const override = asRecord(task.profileOverride);
  return effectiveProfileFromSources({
    agentProfile,
    provider: stringValue(override.provider) ?? stringValue(profile.provider),
    model: stringValue(override.model) ?? stringValue(profile.model),
    thinkingLevel: stringValue(override.thinkingLevel),
    instruction: stringValue(override.instruction),
    skillRefs: optionalStringArray(override.skillRefs) ?? task.skillRefs,
    mcpGrantRefs: optionalStringArray(override.mcpGrantRefs) ?? task.mcpGrantRefs,
  });
}

function effectiveProfileFromSources(input: {
  agentProfile?: unknown;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  instruction?: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
}): NonNullable<WorkflowTaskDefinitionSummary["effectiveProfile"]> {
  const profile = asRecord(input.agentProfile);
  return {
    ...(input.provider ?? stringValue(profile.provider) ? { provider: input.provider ?? stringValue(profile.provider) } : {}),
    ...(input.model ?? stringValue(profile.model) ? { model: input.model ?? stringValue(profile.model) } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.instruction ? { instruction: input.instruction } : {}),
    skillRefs: input.skillRefs,
    mcpGrantRefs: input.mcpGrantRefs,
  };
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

function repairAttemptDetails(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.filter((entry) => isRecord(entry));
  const record = asRecord(value);
  const attempts = record.attempts;
  return Array.isArray(attempts) ? attempts.filter((entry) => isRecord(entry)) : [];
}

function plannerTrace(payloadTrace: unknown, summaryTrace: unknown): Record<string, unknown> | null {
  const merged = {
    ...asRecord(payloadTrace),
    ...asRecord(summaryTrace),
  };
  return Object.keys(merged).length > 0 ? merged : null;
}

function validationIssuesForTask(issues: ValidationIssue[], taskId: string, taskIndex: number): ValidationIssue[] {
  return issues.filter((issue) => {
    const explicitTaskIndex = taskIndexFromIssuePath(issue.path);
    if (explicitTaskIndex !== null) return explicitTaskIndex === taskIndex;
    if (issue.path.includes(taskId)) return true;
    return !hasTaskSpecificPath(issue.path);
  });
}

function selectTaskId(ids: string[], preferredTaskId?: string): string | undefined {
  if (preferredTaskId && ids.includes(preferredTaskId)) return preferredTaskId;
  return ids[0];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function envelopeStringArray(refs: Record<string, unknown>, key: string, fallback: string[]): string[] {
  return Object.prototype.hasOwnProperty.call(refs, key) ? stringArray(refs[key]) : fallback;
}

function taskIndexFromIssuePath(path: string): number | null {
  const bracketMatch = path.match(/(?:^|[.[/])tasks\[(\d+)\]/);
  if (bracketMatch?.[1] !== undefined) return Number(bracketMatch[1]);
  const segmentMatch = path.match(/(?:^|[./])tasks[./](\d+)(?:[./\]]|$)/);
  if (segmentMatch?.[1] !== undefined) return Number(segmentMatch[1]);
  return null;
}

function hasTaskSpecificPath(path: string): boolean {
  return taskIndexFromIssuePath(path) !== null || /(?:^|[.[/])tasks(?:[.[/].*)?/.test(path) && /\btask[-_A-Za-z0-9]+\b/.test(path);
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

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? stringArray(value) : undefined;
}
