import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { PlanBundle, SouthstarWorkflowManifest, TaskStatus, WorkflowRevisionRequest } from "../manifests/types.ts";
import type { PiPlannerClient } from "../planner/types.ts";
import { generatePlanBundle } from "../planner/pi-planner.ts";
import { applyWorkflowRevision } from "../manifests/workflow-revision.ts";
import {
  applyWorkflowExpansion,
  listResources,
  requestWorkflowRevision,
  retrieveApprovedMemory,
  upsertRuntimeResource,
  validateWorkflowRevision,
} from "../stores/resource-store.ts";
import { createWorkflowRun, updateExecutionProjection } from "../stores/run-store.ts";
import { createWorkflowTask } from "../stores/task-store.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import type { TorkClient, TorkSubmitResult } from "../executor/tork-client.ts";
import type { ExecutorProvider, ExecutorSubmitResult } from "../executor/provider.ts";
import { TorkExecutorProvider } from "../executor/tork-provider.ts";
import { appendRuntimeEvent } from "../signals/events.ts";
import { buildTaskEnvelope } from "../agent-runner/task-envelope.ts";
import { materializeTaskEnvelope } from "../agent-runner/materializer.ts";
import {
  buildExecutorOpsModel,
  buildRuntimeMonitorModel,
  buildTaskDetailModel,
  buildVaultMcpModel,
  buildSessionsMemoryModel,
  buildWorkflowCanvasModel,
} from "./read-models.ts";

const PHASE1_AGENT_IMAGE = "southstar/pi-agent:local";

export type PlannerDraftResult = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
};

export async function createPlannerDraft(db: SouthstarDb, input: {
  goalPrompt: string;
  plannerClient: PiPlannerClient;
}): Promise<PlannerDraftResult> {
  const bundle = await generatePlanBundle(input.plannerClient, {
    goalPrompt: input.goalPrompt,
    schemaVersion: "southstar.v2",
    availableHarnesses: ["pi", "codex", "claude-code", "custom"],
  });
  const draftId = `draft-${bundle.workflow.workflowId}`;
  upsertRuntimeResource(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: bundle.workflow.title,
    payload: bundle,
    summary: { goalPrompt: input.goalPrompt, workflowId: bundle.workflow.workflowId },
  });
  return { draftId, goalPrompt: input.goalPrompt, workflowId: bundle.workflow.workflowId };
}

export async function revisePlannerDraft(db: SouthstarDb, input: {
  draftId: string;
  prompt: string;
  plannerClient: PiPlannerClient;
}): Promise<PlannerDraftResult> {
  const previous = readDraftBundle(db, input.draftId);
  const revisedGoal = [
    previous.workflow.goalPrompt,
    "",
    "User revision prompt:",
    input.prompt,
  ].join("\n");
  const bundle = await generatePlanBundle(input.plannerClient, {
    goalPrompt: revisedGoal,
    schemaVersion: "southstar.v2",
    availableHarnesses: ["pi", "codex", "claude-code", "custom"],
  });
  const revisionHash = createHash("sha256")
    .update(`${input.draftId}:${input.prompt}:${bundle.workflow.workflowId}`)
    .digest("hex")
    .slice(0, 12);
  const draftId = `draft-${bundle.workflow.workflowId}-rev-${revisionHash}`;
  upsertRuntimeResource(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: bundle.workflow.title,
    payload: bundle,
    summary: {
      previousDraftId: input.draftId,
      revisionPrompt: input.prompt,
      workflowId: bundle.workflow.workflowId,
    },
  });
  return { draftId, goalPrompt: revisedGoal, workflowId: bundle.workflow.workflowId };
}

export async function createRunFromDraft(db: SouthstarDb, input: {
  draftId: string;
  executorProvider?: ExecutorProvider;
  torkClient?: Pick<TorkClient, "submit">;
  runRoot?: string;
  callbackUrl?: string;
  harnessEndpoint?: string;
}): Promise<{ runId: string; tork: TorkSubmitResult }> {
  const bundle = readDraftBundle(db, input.draftId);
  const workflow = normalizeWorkflowRuntimeExecution(bundle.workflow);
  const runId = allocateRunId(db, bundle.workflow.workflowId);
  const projectedWorkflow = await materializedWorkflowForExecution(db, workflow, {
    runId,
    runRoot: input.runRoot,
    harnessEndpoint: input.harnessEndpoint,
  });
  const executorProvider = resolveExecutorProvider(input);
  createWorkflowRun(db, {
    id: runId,
    status: "running",
    domain: inferDomain(workflow),
    goalPrompt: workflow.goalPrompt,
    workflowManifestJson: JSON.stringify(workflow),
    executionProjectionJson: JSON.stringify(null),
    snapshotJson: JSON.stringify({ activeTaskIds: workflow.tasks.map((task) => task.id) }),
    runtimeContextJson: JSON.stringify({ draftId: input.draftId }),
    metricsJson: JSON.stringify({}),
  });
  workflow.tasks.forEach((task, index) => {
    createWorkflowTask(db, {
      id: task.id,
      runId,
      taskKey: task.id,
      status: "pending",
      sortOrder: index,
      dependsOn: task.dependsOn,
      rootSessionId: `root-${runId}-${task.id}`,
      snapshot: { name: task.name, domain: task.domain },
    });
  });
  appendHistoryEvent(db, {
    runId,
    eventType: "run.created",
    actorType: "orchestrator",
    payload: { draftId: input.draftId, workflowId: bundle.workflow.workflowId },
  });
  const executorSubmission = await executorProvider.submit({
    runId,
    workflow: projectedWorkflow,
    callbackUrl: input.callbackUrl ?? "/api/v2/tork/callback",
    envelopeBasePath: "/southstar-runs",
  });
  updateExecutionProjection(db, runId, JSON.stringify(executorSubmission.executionProjection ?? null));
  const tork = torkSubmitResultFromExecutorSubmission(executorSubmission);
  upsertRuntimeResource(db, {
    id: `executor-${runId}`,
    resourceType: "executor_binding",
    resourceKey: `executor-${runId}`,
    runId,
    scope: "executor",
    status: executorSubmission.status,
    title: `${executorSubmission.executorType} job`,
    payload: {
      executorType: executorSubmission.executorType,
      externalJobId: executorSubmission.externalJobId,
      ...(executorSubmission.providerPayload ?? {}),
      ...(executorSubmission.projectionFingerprint ? { projectionFingerprint: executorSubmission.projectionFingerprint } : {}),
    },
  });
  appendHistoryEvent(db, {
    runId,
    eventType: "executor.submitted",
    actorType: "orchestrator",
    payload: {
      executorType: executorSubmission.executorType,
      externalJobId: executorSubmission.externalJobId,
      ...(executorSubmission.providerPayload ?? {}),
      status: executorSubmission.status,
    },
  });
  return { runId, tork };
}

export async function expandWorkflowRun(db: SouthstarDb, input: {
  runId: string;
  request: WorkflowRevisionRequest;
  executorProvider?: ExecutorProvider;
  torkClient?: Pick<TorkClient, "submit">;
  runRoot?: string;
  callbackUrl?: string;
  harnessEndpoint?: string;
}) {
  const workflow = readRunWorkflow(db, input.runId);
  requestWorkflowRevision(db, {
    runId: input.runId,
    revisionId: input.request.revisionId,
    reason: input.request.reason,
    patch: normalizeRevisionRuntimeExecution(input.request),
    idempotencyKey: input.request.idempotencyKey,
  });
  const revision = applyWorkflowRevision(workflow, normalizeRevisionRuntimeExecution(input.request), readTaskStates(db, input.runId));
  validateWorkflowRevision(db, {
    runId: input.runId,
    revisionId: input.request.revisionId,
    validationResult: { ok: true, newTaskIds: revision.newTaskIds },
    manifestFingerprint: revision.manifestFingerprint,
  });
  const createdTasks = revision.newTaskIds.map((taskId) => {
    const task = revision.workflow.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`revision missing created task: ${taskId}`);
    return { id: task.id, taskKey: task.id, dependsOn: task.dependsOn };
  });
  applyWorkflowExpansion(db, {
    runId: input.runId,
    revisionId: input.request.revisionId,
    workflowManifestJson: JSON.stringify(revision.workflow),
    createdTasks,
  });
  const projectedWorkflow = await materializedWorkflowForExecution(
    db,
    workflowForAddedTasks(revision.workflow, revision.newTaskIds),
    {
      runId: input.runId,
      runRoot: input.runRoot,
      harnessEndpoint: input.harnessEndpoint,
    },
  );
  const executorProvider = resolveExecutorProvider(input);
  const executorSubmission = await executorProvider.submit({
    runId: input.runId,
    workflow: projectedWorkflow,
    callbackUrl: input.callbackUrl ?? "/api/v2/tork/callback",
    envelopeBasePath: "/southstar-runs",
  });
  const tork = torkSubmitResultFromExecutorSubmission(executorSubmission);
  upsertRuntimeResource(db, {
    id: `executor-${input.runId}-${input.request.revisionId}`,
    resourceType: "executor_binding",
    resourceKey: `executor-${input.runId}-${input.request.revisionId}`,
    runId: input.runId,
    scope: "executor",
    status: tork.status,
    title: `${executorSubmission.executorType} dynamic expansion job`,
    payload: {
      executorType: executorSubmission.executorType,
      externalJobId: executorSubmission.externalJobId,
      ...(executorSubmission.providerPayload ?? {}),
      revisionId: input.request.revisionId,
      taskIds: revision.newTaskIds,
      ...(executorSubmission.projectionFingerprint ? { projectionFingerprint: executorSubmission.projectionFingerprint } : {}),
    },
  });
  appendHistoryEvent(db, {
    runId: input.runId,
    eventType: "executor.submitted",
    actorType: "orchestrator",
    payload: {
      executorType: executorSubmission.executorType,
      externalJobId: executorSubmission.externalJobId,
      ...(executorSubmission.providerPayload ?? {}),
      status: executorSubmission.status,
      revisionId: input.request.revisionId,
      taskIds: revision.newTaskIds,
    },
  });
  return { ...revision, tork };
}

function resolveExecutorProvider(input: {
  executorProvider?: ExecutorProvider;
  torkClient?: Pick<TorkClient, "submit">;
}): ExecutorProvider {
  if (input.executorProvider) return input.executorProvider;
  if (input.torkClient) return new TorkExecutorProvider({ torkClient: input.torkClient });
  throw new Error("createRunFromDraft requires executorProvider or torkClient");
}

function torkSubmitResultFromExecutorSubmission(submission: ExecutorSubmitResult): TorkSubmitResult {
  return { jobId: submission.externalJobId, status: submission.status };
}

function normalizeRevisionRuntimeExecution(request: WorkflowRevisionRequest): WorkflowRevisionRequest {
  return {
    ...request,
    addTasks: request.addTasks.map((task) => ({
      ...task,
      execution: {
        ...task.execution,
        image: PHASE1_AGENT_IMAGE,
      },
    })),
  };
}

function normalizeWorkflowRuntimeExecution(workflow: SouthstarWorkflowManifest): SouthstarWorkflowManifest {
  return {
    ...workflow,
    tasks: workflow.tasks.map((task) => ({
      ...task,
      execution: {
        ...task.execution,
        image: PHASE1_AGENT_IMAGE,
      },
    })),
  };
}

export function getRunStatus(db: SouthstarDb, runId: string) {
  return {
    canvas: buildWorkflowCanvasModel(db, runId),
    runtime: buildRuntimeMonitorModel(db, runId),
    sessionsMemory: buildSessionsMemoryModel(db, runId),
    vaultMcp: buildVaultMcpModel(db, runId),
    executor: buildExecutorOpsModel(db, runId),
  };
}

export function steerRun(db: SouthstarDb, input: { runId: string; message: string }) {
  return appendRuntimeEvent(db, {
    runId: input.runId,
    eventType: "steering.received",
    actorType: "user",
    payload: { message: input.message },
  });
}

export function getTaskEnvelope(db: SouthstarDb, input: { runId: string; taskId: string }) {
  const workflow = readRunWorkflow(db, input.runId);
  const task = buildTaskDetailModel(db, input.runId, input.taskId);
  if (!task) throw new Error(`unknown task: ${input.taskId}`);
  const vaultLeases = listResources(db, { resourceType: "vault_lease" })
    .filter((resource) => resource.runId === input.runId && resource.taskId === input.taskId)
    .map((resource) => ({
      leaseRef: resource.resourceKey,
      mountAs: ((resource.payload as { mountAs?: "env" | "file" }).mountAs ?? "file"),
    }));
  const mcpGrants = listResources(db, { resourceType: "mcp_grant" })
    .filter((resource) => resource.runId === input.runId && resource.taskId === input.taskId)
    .map((resource) => ({
      serverId: (resource.payload as { serverId?: string }).serverId ?? resource.resourceKey,
      allowedTools: (resource.payload as { allowedTools?: string[] }).allowedTools ?? [],
    }));
  return buildTaskEnvelope(workflow, {
    runId: input.runId,
    taskId: input.taskId,
    rootSessionId: task.rootSessionId ?? `root-${input.runId}-${input.taskId}`,
    memorySnapshot: retrieveApprovedMemory(db, inferDomain(workflow), workflow.memoryPolicy.retrievalLimit),
    vaultLeases,
    mcpGrants,
  });
}

function allocateRunId(db: SouthstarDb, workflowId: string): string {
  const base = `run-${workflowId}`;
  if (!runExists(db, base)) return base;
  for (let attempt = 1; attempt < 100; attempt++) {
    const candidate = `${base}-${Date.now().toString(36)}-${attempt}`;
    if (!runExists(db, candidate)) return candidate;
  }
  throw new Error(`unable to allocate run id for workflow ${workflowId}`);
}

function runExists(db: SouthstarDb, runId: string): boolean {
  const row = db.prepare("select 1 from workflow_runs where id = ?").get(runId);
  return Boolean(row);
}

function readDraftBundle(db: SouthstarDb, draftId: string): PlanBundle {
  const row = db.prepare("select payload_json from runtime_resources where resource_type = ? and resource_key = ?")
    .get("planner_draft", draftId) as { payload_json: string } | undefined;
  if (!row) throw new Error(`planner draft not found: ${draftId}`);
  return JSON.parse(row.payload_json) as PlanBundle;
}

function readRunWorkflow(db: SouthstarDb, runId: string): SouthstarWorkflowManifest {
  const row = db.prepare("select workflow_manifest_json from workflow_runs where id = ?")
    .get(runId) as { workflow_manifest_json: string } | undefined;
  if (!row) throw new Error(`workflow run not found: ${runId}`);
  return JSON.parse(row.workflow_manifest_json) as SouthstarWorkflowManifest;
}

function inferDomain(workflow: SouthstarWorkflowManifest): string {
  return workflow.tasks[0]?.domain ?? "general";
}

async function materializedWorkflowForExecution(
  db: SouthstarDb,
  workflow: SouthstarWorkflowManifest,
  input: { runId: string; runRoot?: string; harnessEndpoint?: string },
): Promise<SouthstarWorkflowManifest> {
  const tasks = [];
  for (const task of workflow.tasks) {
    const rootSessionId = `root-${input.runId}-${task.id}`;
    const envelope = buildTaskEnvelope(workflow, {
      runId: input.runId,
      taskId: task.id,
      rootSessionId,
      memorySnapshot: retrieveApprovedMemory(db, task.domain, workflow.memoryPolicy.retrievalLimit),
      vaultLeases: [],
      mcpGrants: workflow.mcpGrants
        .filter((grant) => grant.taskId === task.id)
        .map((grant) => ({ serverId: grant.serverId, allowedTools: grant.allowedTools })),
    });
    const materialization = await materializeTaskEnvelope(envelope, { runRoot: input.runRoot });
    const runRoot = input.runRoot ?? "/tmp/southstar-runs";
    const piAgentConfigMount = getPiAgentConfigMount();
    tasks.push({
      ...task,
      execution: {
        ...task.execution,
        env: {
          ...task.execution.env,
          ...(input.harnessEndpoint ? { SOUTHSTAR_HARNESS_ENDPOINT: input.harnessEndpoint } : {}),
          ...(!isImplementerTask(task.id) ? { SOUTHSTAR_HARNESS_KIND: "builtin" } : {}),
          SOUTHSTAR_MATERIALIZATION_ROOT: input.runRoot ?? "/tmp/southstar-runs",
          ...(piAgentConfigMount ? {
            PI_CODING_AGENT_DIR: piAgentConfigMount.target,
            PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-agent-sessions",
          } : {}),
        },
        mounts: [
          ...task.execution.mounts,
          ...(piAgentConfigMount ? [piAgentConfigMount] : []),
          {
            source: runRoot,
            target: "/southstar-runs",
            readonly: true,
          },
        ],
      },
    });
  }
  return { ...workflow, tasks };
}

function isImplementerTask(taskId: string): boolean {
  return /implement/i.test(taskId);
}

function getPiAgentConfigMount(): { source: string; target: string; readonly: boolean } | undefined {
  const source = process.env.SOUTHSTAR_PI_AGENT_DIR ?? "/home/timmypai/.pi/agent";
  if (!existsSync(source)) return undefined;
  return { source, target: "/southstar/pi-agent", readonly: true };
}

function readTaskStates(db: SouthstarDb, runId: string) {
  const rows = db.prepare("select id, status from workflow_tasks where run_id = ?").all(runId) as Array<{ id: string; status: TaskStatus }>;
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

function workflowForAddedTasks(
  workflow: SouthstarWorkflowManifest,
  taskIds: string[],
): SouthstarWorkflowManifest {
  const taskIdSet = new Set(taskIds);
  return {
    ...workflow,
    tasks: workflow.tasks
      .filter((task) => taskIdSet.has(task.id))
      .map((task) => ({
        ...task,
        dependsOn: task.dependsOn.filter((dependency) => taskIdSet.has(dependency)),
      })),
  };
}
