import { acceptedArtifactTaskIdsForRunPg } from "../artifacts/artifact-ref-store.ts";
import { CANONICAL_DIAGNOSTIC_CODES, canonicalDiagnostic, canonicalDiagnosticCode } from "../canonical-diagnostics.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { runtimeAttemptNumber } from "../executor/attempt-identity.ts";
import { listUnresolvedRuntimeExceptionsForRunsPg } from "../exceptions/postgres-runtime-exceptions.ts";
import {
  frozenCoverageUnavailableDiagnosticPg,
  loadFrozenCoverageContextsPg,
  requirementEvaluatorResultIncompatibility,
} from "../evaluators/requirement-evaluator-results.ts";
import {
  goalContractHash,
  storedGoalContract,
  type GoalContractV1,
} from "../orchestration/goal-contract.ts";
import {
  storedGoalRequirementCoverage,
  type GoalRequirementCoverageV1,
} from "../orchestration/goal-requirement-coverage.ts";
import { getResourceByKeyPg } from "../stores/postgres-runtime-store.ts";
import { approvalCommands } from "./operator-attention.ts";
import { effectiveAgentProfile } from "../design-library/profile-composer/profile-contract.ts";
import {
  buildRuntimeWorkflowCanvasProjection,
  workflowTasksFromUnknown,
  workflowTasksFromWorkflowManifest,
  type DraftTaskShape,
  type RuntimeOverlayRow,
  type RuntimeTaskRow,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode,
} from "./runtime-workflow-projection.ts";

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

type WorkflowTaskDefinitionSummary = {
  taskId: string;
  taskName: string;
  roleRef?: string;
  agentProfileRef?: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  toolGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
  nodePromptSpec?: unknown;
  profileOverride?: unknown;
  effectiveProfile?: {
    harnessRef?: string;
    provider?: string;
    model?: string;
    thinkingLevel?: string;
    instruction?: string;
    skillRefs: string[];
    mcpGrantRefs: string[];
    toolGrantRefs: string[];
    vaultLeasePolicyRefs: string[];
    nodePromptSpec?: unknown;
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
  mission: GoalMissionReadModel | null;
  lineage: WorkflowLineageReadModel;
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
    requiresConfirmation?: boolean;
    disabledReason?: string;
    body?: Record<string, unknown>;
  }>;
};

export type GoalMissionReadModel = {
  goalContract: GoalContractV1;
  goalContractHash: string;
  coverage: {
    covered: number;
    total: number;
    failedRequirementIds: string[];
    entries: GoalRequirementCoverageV1["entries"];
  };
  status: {
    execution: string;
    outcome: "in_progress" | "satisfied" | "unsatisfied" | "blocked";
    health: "healthy" | "degraded" | "critical";
  };
  approval: null | {
    id: string;
    status: string;
    goalContractHash: string;
    manifestHash: string;
    librarySnapshotHash: string;
  };
  evaluatorResults: unknown[];
  blockers: string[];
  provenance: {
    originalPrompt: string;
    revision: number;
    promptHash: string;
    manifestHash?: string;
    librarySnapshotHash?: string;
  };
};

export type WorkflowLineageReadModel = {
  slicePlan: {
    revision: number;
    goalContractHash: string;
    slices: Array<{
      id: string;
      requirementIds: string[];
      outcome: string;
      expectedArtifactRefs: string[];
      evaluatorContractRefs: string[];
      dependsOnSliceIds: string[];
      dependencyArtifactRefs: string[];
    }>;
  } | null;
  workflowDag: {
    id: string;
    mode: "draft" | "runtime";
    taskIds: string[];
    edges: Array<{ from: string; to: string; status: WorkflowCanvasEdge["status"] }>;
  } | null;
  tasks: Array<{
    id: string;
    label: string;
    status: string;
    sliceId?: string;
    requirementIds: string[];
    dependsOn: string[];
    purpose?: string;
    nodeType?: string;
    expectedOutputs: string[];
    roleRef?: string;
    agentProfileRef?: string;
  }>;
};

export function buildWorkflowLineageReadModel(input: {
  graphId: string;
  mode: "draft" | "runtime";
  slicePlan: unknown;
  workflowTasks: DraftTaskShape[];
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
}): WorkflowLineageReadModel {
  const taskById = new Map(input.workflowTasks.map((task) => [task.id, task]));
  const tasks = input.nodes.map((node) => {
    const workflowTask = taskById.get(node.id);
    return {
      id: node.id,
      label: node.label,
      status: node.status,
      ...(workflowTask?.sliceId ?? node.sliceId ? { sliceId: workflowTask?.sliceId ?? node.sliceId } : {}),
      requirementIds: workflowTask?.requirementIds ?? node.requirementIds ?? [],
      dependsOn: node.dependsOn,
      ...(workflowTask?.purpose ?? node.purpose ? { purpose: workflowTask?.purpose ?? node.purpose } : {}),
      ...(workflowTask?.nodeType ?? node.nodeType ? { nodeType: workflowTask?.nodeType ?? node.nodeType } : {}),
      expectedOutputs: workflowTask?.expectedOutputs ?? node.expectedOutputs ?? [],
      ...(node.roleRef ?? workflowTask?.roleRef ? { roleRef: node.roleRef ?? workflowTask?.roleRef } : {}),
      ...(node.agentProfileRef ?? workflowTask?.agentProfileRef ? { agentProfileRef: node.agentProfileRef ?? workflowTask?.agentProfileRef } : {}),
    };
  });
  return {
    slicePlan: slicePlanFromUnknown(input.slicePlan),
    workflowDag: input.nodes.length > 0 || input.edges.length > 0
      ? {
          id: input.graphId,
          mode: input.mode,
          taskIds: input.nodes.map((node) => node.id),
          edges: input.edges.map((edge) => ({ from: edge.source, to: edge.target, status: edge.status })),
        }
      : null,
    tasks,
  };
}

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

export async function buildGoalMissionReadModelPg(
  db: SouthstarDb,
  input: { draftId?: string; runId?: string },
): Promise<GoalMissionReadModel | null> {
  if (input.runId) return (await buildGoalMissionReadModelsPg(db, [input.runId])).get(input.runId) ?? null;
  if (input.draftId) return await buildDraftGoalMissionReadModel(db, input.draftId);
  throw new Error("runId or draftId is required");
}

export async function buildGoalMissionReadModelsPg(
  db: SouthstarDb,
  runIds: string[],
): Promise<Map<string, GoalMissionReadModel | null>> {
  return await buildRuntimeGoalMissionReadModels(db, [...new Set(runIds)]);
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
  const overlayRows = await runtimeOverlayRows(db, runId);
  const workflowTasks = workflowTasksFromWorkflowManifest(run.workflow_manifest_json);
  const selectedTaskId = selectTaskId(tasks.map((task) => task.id), preferredTaskId);
  const domain = run.domain ?? "general";
  const { nodes, edges } = buildRuntimeWorkflowCanvasProjection({
    tasks,
    workflowTasks,
    overlayRows,
    acceptedArtifactTaskIds,
  });

  const selectedDefinition = await runtimeSelectedDefinition(db, {
    runId,
    selectedTaskId,
    domain,
    nodes,
    workflowTasks,
    workflowManifest: run.workflow_manifest_json,
  });
  const runtimeContext = asRecord(run.runtime_context_json);
  const runtimeDraftId = stringValue(runtimeContext.draftId);
  const runtimeDraft = runtimeDraftId ? await getResourceByKeyPg(db, "planner_draft", runtimeDraftId) : null;
  const runtimeDraftPayload = asRecord(runtimeDraft?.payload);
  const lineage = buildWorkflowLineageReadModel({
    graphId: runId,
    mode: "runtime",
    slicePlan: asRecord(runtimeDraftPayload.goalDesignPackage).slicePlan ?? runtimeDraftPayload.slicePlan,
    workflowTasks,
    nodes,
    edges,
  });
  const librarySummary = agentLibrarySummary(domain, run.workflow_manifest_json);
  const mission = await buildGoalMissionReadModelPg(db, { runId });

  return {
    mission,
    lineage,
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
      ...(mission?.approval?.status === "pending" ? approvalCommands(runId, mission.approval.id) : []),
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
  const domain = stringValue(workflow.domain) ?? "general";
  const issues = validationIssues(summary.validationIssues ?? payload.validationIssues);
  const repairDetails = repairAttemptDetails(payload.repairAttempts ?? summary.repairAttempts);
  const mission = await buildGoalMissionReadModelPg(db, { draftId });

  const nodes: WorkflowCanvasNode[] = workflowTasks.map((task, index) => {
    const nodeIssues = validationIssuesForTask(issues, task.id, index);
    return {
      id: task.id,
      label: task.name ?? task.id,
      kind: "task",
      status: draftNodeStatus(draft.status, nodeIssues.length > 0),
      dependsOn: task.dependsOn,
      sortOrder: index,
      ...(task.sliceId ? { sliceId: task.sliceId } : {}),
      ...(task.requirementIds && task.requirementIds.length > 0 ? { requirementIds: task.requirementIds } : {}),
      ...(task.purpose ? { purpose: task.purpose } : {}),
      ...(task.nodeType ? { nodeType: task.nodeType } : {}),
      ...(task.expectedOutputs && task.expectedOutputs.length > 0 ? { expectedOutputs: task.expectedOutputs } : {}),
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
  const lineage = buildWorkflowLineageReadModel({
    graphId: draftId,
    mode: "draft",
    slicePlan: asRecord(payload.goalDesignPackage).slicePlan ?? payload.slicePlan,
    workflowTasks,
    nodes,
    edges,
  });

  return {
    mission,
    lineage,
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
    selectedDefinition: selectedTask ? taskDefinitionSummary(selectedTask, domain, workflow) : null,
    agentLibrarySummary: agentLibrarySummary(domain, workflow),
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

async function buildDraftGoalMissionReadModel(db: SouthstarDb, draftId: string): Promise<GoalMissionReadModel | null> {
  const draft = await getResourceByKeyPg(db, "planner_draft", draftId);
  if (!draft) throw new Error(`planner draft not found: ${draftId}`);
  const payload = asRecord(draft.payload);
  const goalContract = storedGoalContract(payload.goalContract);
  if (!goalContract) return null;
  const coverage = storedGoalRequirementCoverage(payload.goalRequirementCoverage);
  if (!coverage) throw new Error(`planner draft Goal Requirement Coverage is invalid: ${draftId}`);
  const contractHash = goalContractHash(goalContract);
  if (stringValue(payload.goalContractHash) !== contractHash || coverage.goalContractHash !== contractHash) {
    throw new Error(`planner draft Goal Contract lineage mismatch: ${draftId}`);
  }
  const compiler = asRecord(asRecord(payload.orchestrationSnapshot).compiler);
  return goalMissionProjection({
    goalContract,
    coverage,
    execution: draft.status,
    outcome: "in_progress",
    health: "healthy",
    approval: null,
    evaluatorResults: [],
    manifestHash: stringValue(compiler.manifestHash),
  });
}

type MissionResourceRow = {
  resource_type: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  status: string;
  payload_json: unknown;
  created_at: Date;
  updated_at: Date;
};

async function buildRuntimeGoalMissionReadModels(
  db: SouthstarDb,
  runIds: string[],
): Promise<Map<string, GoalMissionReadModel | null>> {
  if (runIds.length === 0) return new Map();
  const runs = await db.query<{ id: string; status: string; runtime_context_json: unknown }>(
    "select id, status, runtime_context_json from southstar.workflow_runs where id = any($1::text[])",
    [runIds],
  );
  const contexts = await loadFrozenCoverageContextsPg(db, runIds);
  const resourceRows = await db.query<MissionResourceRow>(
    `select resource_type, resource_key, run_id, task_id, status, payload_json, created_at, updated_at
       from southstar.runtime_resources
      where run_id = any($1::text[])
        and resource_type in ('goal_outcome', 'requirement_evaluator_result', 'evaluator_result', 'approval', 'executor_binding', 'hand_execution')
      order by updated_at desc, created_at desc, resource_key desc`,
    [runIds],
  );
  const exceptions = await listUnresolvedRuntimeExceptionsForRunsPg(db, runIds);
  const resourcesByRun = new Map<string, MissionResourceRow[]>();
  for (const row of resourceRows.rows) {
    if (!row.run_id) continue;
    const rows = resourcesByRun.get(row.run_id) ?? [];
    rows.push(row);
    resourcesByRun.set(row.run_id, rows);
  }
  const exceptionsByRun = new Map<string, typeof exceptions>();
  for (const exception of exceptions) {
    const rows = exceptionsByRun.get(exception.runId) ?? [];
    rows.push(exception);
    exceptionsByRun.set(exception.runId, rows);
  }
  const result = new Map<string, GoalMissionReadModel | null>();
  for (const run of runs.rows) {
    const rows = resourcesByRun.get(run.id) ?? [];
    const evaluatorRows = rows.filter(
      (row) => row.resource_type === "requirement_evaluator_result" || row.resource_type === "evaluator_result",
    );
    const evaluatorResultBlockers = evaluatorRows.flatMap((row) => {
      if (row.resource_type !== "requirement_evaluator_result") return [];
      const diagnostic = requirementEvaluatorResultIncompatibility({ resourceKey: row.resource_key, payload: row.payload_json });
      return diagnostic ? [diagnostic.message] : [];
    });
    const outcomeResource = rows.find((row) => row.resource_type === "goal_outcome");
    const outcomePayload = asRecord(outcomeResource?.payload_json);
    const outcome = outcomeResource
      ? goalOutcomeStatus(outcomeResource.status) ?? goalOutcomeStatus(outcomePayload.outcomeStatus)
      : "in_progress";
    if (!outcome) throw new Error(`invalid goal outcome for run ${run.id}`);
    const runExceptions = exceptionsByRun.get(run.id) ?? [];
    const runtimeIncompatibilityBlockers = runExceptions.flatMap((exception) => {
      const providerEvidence = asRecord(exception.payload.providerEvidence);
      return canonicalDiagnosticCode(providerEvidence.code) && stringValue(providerEvidence.message)
        ? [stringValue(providerEvidence.message)!]
        : [];
    });
    const health = runExceptions.some((exception) => ["blocking", "terminal", "critical"].includes(exception.payload.severity))
      ? "critical" as const
      : runExceptions.length > 0 || hasDegradedProviderHealth(providerObservations(rows))
        ? "degraded" as const
        : "healthy" as const;
    const runtimeContext = asRecord(run.runtime_context_json);
    const context = contexts.get(run.id);
    if (!context) {
      const draftId = stringValue(runtimeContext.draftId);
      const draft = draftId ? await getResourceByKeyPg(db, "planner_draft", draftId) : null;
      const goalContract = storedGoalContract(asRecord(draft?.payload).goalContract);
      if (!goalContract) {
        result.set(run.id, null);
        continue;
      }
      const unavailableDiagnostic = await frozenCoverageUnavailableDiagnosticPg(db, run.id)
        ?? canonicalDiagnostic(
          CANONICAL_DIAGNOSTIC_CODES.goalRequirementCoverageMissing,
          `run ${run.id} has no frozen goal requirement coverage`,
        );
      result.set(run.id, goalMissionProjection({
        goalContract,
        execution: run.status,
        outcome,
        health: "critical",
        approval: missionApproval(rows.find((row) => row.resource_type === "approval" && asRecord(row.payload_json).actionType === "goalExecution") ?? null),
        evaluatorResults: evaluatorRows.map((row) => row.payload_json),
        blockers: [unavailableDiagnostic.message, ...evaluatorResultBlockers, ...runtimeIncompatibilityBlockers],
        failedRequirementIds: stringArray(outcomePayload.failedRequirementIds),
        manifestHash: stringValue(runtimeContext.manifestHash),
        librarySnapshotHash: stringValue(runtimeContext.librarySnapshotHash),
      }));
      continue;
    }
    result.set(run.id, goalMissionProjection({
      goalContract: context.goalContract,
      coverage: context.coverage,
      execution: run.status,
      outcome,
      health,
      approval: missionApproval(rows.find((row) => row.resource_type === "approval" && asRecord(row.payload_json).actionType === "goalExecution") ?? null),
      evaluatorResults: evaluatorRows.map((row) => row.payload_json),
      blockers: [...evaluatorResultBlockers, ...runtimeIncompatibilityBlockers],
      failedRequirementIds: stringArray(outcomePayload.failedRequirementIds),
      manifestHash: stringValue(runtimeContext.manifestHash),
      librarySnapshotHash: stringValue(runtimeContext.librarySnapshotHash),
    }));
  }
  return result;
}

export type ProviderHealthObservation = {
  resourceKey: string;
  taskId?: string;
  status: string;
  payload: unknown;
  updatedAt: string;
};

export function hasDegradedProviderHealth(observations: ProviderHealthObservation[]): boolean {
  const byTask = new Map<string, ProviderHealthObservation[]>();
  for (const observation of observations) {
    if (!observation.taskId) {
      if (isDegradedProviderStatus(observation.status)) return true;
      continue;
    }
    const rows = byTask.get(observation.taskId) ?? [];
    rows.push(observation);
    byTask.set(observation.taskId, rows);
  }
  for (const rows of byTask.values()) {
    const canonicalAttempts = rows.filter((row) => providerAttemptNumber(row) > 0);
    const latestAttempt = Math.max(0, ...canonicalAttempts.map(providerAttemptNumber));
    if (latestAttempt > 0) {
      const effective = canonicalAttempts.filter((row) => providerAttemptNumber(row) === latestAttempt);
      if (hasDegradedLatestProviderObservation(effective)) return true;
    }
    const legacyAttempts = new Map<string, ProviderHealthObservation[]>();
    for (const row of rows.filter((candidate) => providerAttemptNumber(candidate) === 0)) {
      const identity = providerAttemptIdentity(row);
      const attemptRows = legacyAttempts.get(identity) ?? [];
      attemptRows.push(row);
      legacyAttempts.set(identity, attemptRows);
    }
    if ([...legacyAttempts.values()].some(hasDegradedLatestProviderObservation)) return true;
  }
  return false;
}

function providerAttemptNumber(observation: ProviderHealthObservation): number {
  return runtimeAttemptNumber(providerAttemptIdentity(observation));
}

function providerAttemptIdentity(observation: ProviderHealthObservation): string {
  return stringValue(asRecord(observation.payload).attemptId) ?? observation.resourceKey;
}

function hasDegradedLatestProviderObservation(observations: ProviderHealthObservation[]): boolean {
  const latestUpdatedAt = Math.max(...observations.map((observation) => Date.parse(observation.updatedAt)));
  return observations.some((observation) =>
    Date.parse(observation.updatedAt) === latestUpdatedAt && isDegradedProviderStatus(observation.status)
  );
}

function providerObservations(rows: MissionResourceRow[]): ProviderHealthObservation[] {
  return rows
    .filter((row) => row.resource_type === "executor_binding" || row.resource_type === "hand_execution")
    .map((row) => ({
      resourceKey: row.resource_key,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      status: row.status,
      payload: row.payload_json,
      updatedAt: row.updated_at.toISOString(),
    }));
}

function isDegradedProviderStatus(status: string): boolean {
  return ["heartbeat-lost", "queue-timeout", "hard-timeout", "callback-missing", "orphaned", "failed", "lost"].includes(status);
}

function goalMissionProjection(input: {
  goalContract: GoalContractV1;
  coverage?: GoalRequirementCoverageV1;
  execution: string;
  outcome: GoalMissionReadModel["status"]["outcome"];
  health: GoalMissionReadModel["status"]["health"];
  approval: GoalMissionReadModel["approval"];
  evaluatorResults: unknown[];
  blockers?: string[];
  failedRequirementIds?: string[];
  manifestHash?: string;
  librarySnapshotHash?: string;
}): GoalMissionReadModel {
  const coverageEntries = input.coverage?.entries ?? [];
  const coveredRequirementIds = new Set(coverageEntries.map((entry) => entry.requirementId));
  return {
    goalContract: input.goalContract,
    goalContractHash: goalContractHash(input.goalContract),
    coverage: {
      covered: input.goalContract.requirements.filter((requirement) => coveredRequirementIds.has(requirement.id)).length,
      total: input.goalContract.requirements.length,
      failedRequirementIds: [...new Set(input.failedRequirementIds ?? [])].sort(),
      entries: coverageEntries,
    },
    status: { execution: input.execution, outcome: input.outcome, health: input.health },
    approval: input.approval,
    evaluatorResults: input.evaluatorResults,
    blockers: [...new Set([...input.goalContract.blockingInputs, ...(input.blockers ?? [])])].sort(),
    provenance: {
      originalPrompt: input.goalContract.originalPrompt,
      revision: input.goalContract.revision,
      promptHash: input.goalContract.promptHash,
      ...(input.manifestHash ? { manifestHash: input.manifestHash } : {}),
      ...(input.librarySnapshotHash ? { librarySnapshotHash: input.librarySnapshotHash } : {}),
    },
  };
}

function missionApproval(row: { resource_key: string; status: string; payload_json: unknown } | null): GoalMissionReadModel["approval"] {
  if (!row) return null;
  const payload = asRecord(row.payload_json);
  const approvalGoalContractHash = stringValue(payload.goalContractHash);
  const manifestHash = stringValue(payload.manifestHash);
  const librarySnapshotHash = stringValue(payload.librarySnapshotHash);
  if (!approvalGoalContractHash || !manifestHash || !librarySnapshotHash) return null;
  return {
    id: stringValue(payload.approvalId) ?? row.resource_key,
    status: row.status,
    goalContractHash: approvalGoalContractHash,
    manifestHash,
    librarySnapshotHash,
  };
}

function goalOutcomeStatus(value: unknown): GoalMissionReadModel["status"]["outcome"] | undefined {
  return value === "in_progress" || value === "satisfied" || value === "unsatisfied" || value === "blocked" ? value : undefined;
}

async function runtimeSelectedDefinition(
  db: SouthstarDb,
  input: {
    runId: string;
    selectedTaskId?: string;
    domain: string;
    nodes: WorkflowCanvasNode[];
    workflowTasks: DraftTaskShape[];
    workflowManifest: unknown;
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
  const vaultLeasePolicyRefs = envelopeStringArray(envelopeRefs, "vaultLeasePolicyRefs", stringArray(workflowTask?.vaultLeasePolicyRefs));
  const nodePromptSpec = asRecord(workflowTask?.promptInputs).nodePromptSpec;
  const libraryDetails = libraryDefinitionDetails({
    domain: input.domain,
    roleRef: node.roleRef,
    agentProfileRef: node.agentProfileRef,
    artifactContractRef: workflowTask?.artifactContractRef,
    artifactKind: workflowTask?.artifactKind,
    evaluatorPipelineRef: workflowTask?.evaluatorPipelineRef,
    contextPolicyRef: workflowTask?.contextPolicyRef,
    vaultLeasePolicyRefs,
    workflowManifest: input.workflowManifest,
  });

  return {
    taskId: node.id,
    taskName: node.label,
    ...(node.roleRef ? { roleRef: node.roleRef } : {}),
    ...(node.agentProfileRef ? { agentProfileRef: node.agentProfileRef } : {}),
    skillRefs,
    mcpGrantRefs,
    toolGrantRefs,
    vaultLeasePolicyRefs,
    ...(nodePromptSpec !== undefined ? { nodePromptSpec } : {}),
    editable: false,
    effectiveProfile: effectiveAgentProfile({
      agentProfile: envelope.agentProfile ?? libraryDetails.agentProfile,
      task: {
        skillRefs,
        mcpGrantRefs,
        toolGrantRefs,
        vaultLeasePolicyRefs,
        ...(nodePromptSpec !== undefined ? { promptInputs: { nodePromptSpec } } : {}),
      },
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

function agentLibrarySummary(domain: string, workflowManifest: unknown): WorkflowUiReadModel["agentLibrarySummary"] {
  const skillIds = new Set<string>();
  const mcpIds = new Set<string>();
  const toolIds = new Set<string>();
  const profiles = workflowArray<Record<string, unknown>>(workflowManifest, "agentProfiles");
  for (const profile of profiles) {
    for (const ref of stringArray(profile.skillRefs)) skillIds.add(ref);
    for (const ref of stringArray(profile.mcpGrantRefs)) mcpIds.add(ref);
    for (const tool of stringArray(asRecord(profile.toolPolicy).allowedTools)) toolIds.add(tool);
  }
  return {
    domain,
    roleCount: workflowArray(workflowManifest, "roles").length,
    agentProfileCount: profiles.length,
    skillCount: skillIds.size,
    mcpServerCount: mcpIds.size,
    toolCount: toolIds.size,
    artifactContractCount: workflowArray(workflowManifest, "artifactContracts").length,
    evaluatorPipelineCount: workflowArray(workflowManifest, "evaluatorPipelines").length,
  };
}

function taskDefinitionSummary(task: DraftTaskShape, domain: string, workflowManifest: unknown): WorkflowTaskDefinitionSummary {
  const libraryDetails = libraryDefinitionDetails({
    domain,
    roleRef: task.roleRef,
    agentProfileRef: task.agentProfileRef,
    artifactContractRef: task.artifactContractRef,
    artifactKind: task.artifactKind,
    evaluatorPipelineRef: task.evaluatorPipelineRef,
    contextPolicyRef: task.contextPolicyRef,
    vaultLeasePolicyRefs: task.vaultLeasePolicyRefs,
    workflowManifest,
  });
  const effectiveProfile = effectiveProfileForDraftTask(task, libraryDetails.agentProfile);
  return {
    taskId: task.id,
    taskName: task.name ?? task.id,
    ...(task.roleRef ? { roleRef: task.roleRef } : {}),
    ...(task.agentProfileRef ? { agentProfileRef: task.agentProfileRef } : {}),
    skillRefs: effectiveProfile.skillRefs,
    mcpGrantRefs: effectiveProfile.mcpGrantRefs,
    toolGrantRefs: effectiveProfile.toolGrantRefs,
    vaultLeasePolicyRefs: effectiveProfile.vaultLeasePolicyRefs,
    ...(effectiveProfile.nodePromptSpec !== undefined ? { nodePromptSpec: effectiveProfile.nodePromptSpec } : {}),
    ...(task.profileOverride !== undefined ? { profileOverride: task.profileOverride } : {}),
    effectiveProfile,
    editable: true,
    ...libraryDetails,
    materializedLibraryRefs: {
      skillRefs: effectiveProfile.skillRefs,
      mcpGrantRefs: effectiveProfile.mcpGrantRefs,
      toolGrantRefs: effectiveProfile.toolGrantRefs,
      ...(effectiveProfile.vaultLeasePolicyRefs.length > 0 ? { vaultLeasePolicyRefs: effectiveProfile.vaultLeasePolicyRefs } : {}),
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
  workflowManifest: unknown;
}): Partial<WorkflowTaskDefinitionSummary> {
  const roles = workflowArray<Record<string, unknown>>(input.workflowManifest, "roles");
  const profiles = workflowArray<Record<string, unknown>>(input.workflowManifest, "agentProfiles");
  const artifactContracts = workflowArray<Record<string, unknown>>(input.workflowManifest, "artifactContracts");
  const evaluatorPipelines = workflowArray<Record<string, unknown>>(input.workflowManifest, "evaluatorPipelines");
  const contextPolicies = workflowArray<Record<string, unknown>>(input.workflowManifest, "contextPolicies");
  const roleDefinition = input.roleRef ? roles.find((role) => stringValue(role.id) === input.roleRef) : undefined;
  const agentProfile = input.agentProfileRef
    ? profiles.find((profile) => stringValue(profile.id) === input.agentProfileRef)
    : undefined;
  const artifactContractRef = input.artifactContractRef
    ?? (input.artifactKind && artifactContracts.some((contract) => stringValue(contract.id) === input.artifactKind)
      ? input.artifactKind
      : undefined)
    ?? stringArray(roleDefinition?.artifactOutputs)[0];
  const artifactContract = artifactContractRef
    ? artifactContracts.find((contract) => stringValue(contract.id) === artifactContractRef)
    : undefined;
  const evaluatorPipeline = input.evaluatorPipelineRef
    ? evaluatorPipelines.find((pipeline) => stringValue(pipeline.id) === input.evaluatorPipelineRef)
    : evaluatorPipelineForArtifact(evaluatorPipelines, artifactContractRef);
  const contextPolicyRef = input.contextPolicyRef ?? stringValue(agentProfile?.contextPolicyRef);
  const contextPolicy = contextPolicyRef
    ? contextPolicies.find((policy) => stringValue(policy.id) === contextPolicyRef)
    : undefined;
  const vaultPolicies = input.vaultLeasePolicyRefs.map((id) => ({ id }));

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

function evaluatorPipelineForArtifact(evaluatorPipelines: Array<Record<string, unknown>>, artifactContractRef: string | undefined): unknown {
  if (!artifactContractRef) return undefined;
  return evaluatorPipelines.find((pipeline) => stringArray(pipeline.artifactContracts).includes(artifactContractRef)
    || stringArray(pipeline.validatesArtifactRefs).includes(artifactContractRef)
    || objectArray(pipeline.evaluators).some((evaluator) => (
      stringValue(asRecord(evaluator.config).artifactRef) === artifactContractRef
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

function effectiveProfileForDraftTask(
  task: DraftTaskShape,
  agentProfile: unknown,
): NonNullable<WorkflowTaskDefinitionSummary["effectiveProfile"]> {
  return effectiveAgentProfile({
    agentProfile,
    task,
    profileOverride: task.profileOverride,
  });
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

function slicePlanFromUnknown(value: unknown): WorkflowLineageReadModel["slicePlan"] {
  const plan = asRecord(value);
  const revision = plan.revision;
  const goalContractHash = stringValue(plan.goalContractHash);
  if (!Number.isInteger(revision) || !goalContractHash || !Array.isArray(plan.slices)) return null;
  const slices = plan.slices.map((value) => {
    const slice = asRecord(value);
    const id = stringValue(slice.id);
    const outcome = stringValue(slice.outcome);
    if (!id || !outcome) return null;
    return {
      id,
      requirementIds: stringArray(slice.requirementIds),
      outcome,
      expectedArtifactRefs: stringArray(slice.expectedArtifactRefs),
      evaluatorContractRefs: stringArray(slice.evaluatorContractRefs),
      dependsOnSliceIds: stringArray(slice.dependsOnSliceIds),
      dependencyArtifactRefs: stringArray(slice.dependencyArtifactRefs),
    };
  }).filter((slice): slice is NonNullable<typeof slice> => slice !== null);
  if (slices.length !== plan.slices.length || slices.length === 0) return null;
  return { revision, goalContractHash, slices };
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

function objectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((item) => Object.keys(item).length > 0);
}

function workflowArray<T>(workflowManifest: unknown, key: string): T[] {
  const value = asRecord(workflowManifest)[key];
  return Array.isArray(value) ? value as T[] : [];
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? stringArray(value) : undefined;
}
