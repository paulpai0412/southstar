import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { DomainPack } from "../domain-packs/types.ts";
import type { PlanBundle, SouthstarWorkflowManifest, TaskStatus, WorkflowRevisionRequest } from "../manifests/types.ts";
import type { PiPlannerClient } from "../planner/types.ts";
import { applyWorkflowRevision } from "../manifests/workflow-revision.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import { createDomainPackRegistry } from "../domain-packs/registry.ts";
import { generateConstrainedWorkflowPlan } from "../workflow-generator/constrained-generator.ts";
import { materializeGenerationPlan } from "../workflow-generator/materialize.ts";
import type { OrchestrationSnapshot, WorkflowGenerationPlan } from "../workflow-generator/types.ts";
import {
  applyWorkflowExpansion,
  getResourceByKey,
  listResources,
  requestWorkflowRevision,
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
import { buildTaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import { materializeTaskEnvelope } from "../agent-runner/materializer.ts";
import { buildContextPacket, resolveArtifactContractRefs, resolveRoleProfile } from "../context/builder.ts";
import { createSqliteSessionGraphProvider } from "../session-graph/sqlite-provider.ts";
import { createGitWorkspaceSnapshotProvider } from "../workspace/git-provider.ts";
import type { WorkspaceSnapshotRef } from "../workspace/types.ts";
import { resolveSkillSnapshots } from "../skills/resolver.ts";
import type { ResolvedSkillSnapshot } from "../skills/types.ts";
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
  const generated = generateConstrainedPlannerBundle(input.goalPrompt);
  const bundle = generated.bundle;
  const draftId = `draft-${bundle.workflow.workflowId}`;
  if ("generationPlan" in generated) {
    persistGenerationResources(db, {
      generationPlan: generated.generationPlan,
      orchestrationSnapshot: generated.orchestrationSnapshot,
      workflow: bundle.workflow,
    });
  }
  upsertRuntimeResource(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: bundle.workflow.title,
    payload: bundle,
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId: bundle.workflow.workflowId,
      plannerMs: generated.plannerMs,
      validationMs: generated.validationMs,
    },
  });
  return { draftId, goalPrompt: input.goalPrompt, workflowId: bundle.workflow.workflowId };
}

function generateConstrainedPlannerBundle(goalPrompt: string): {
  bundle: PlanBundle;
  plannerMs: number;
  validationMs: number;
  generationPlan: WorkflowGenerationPlan;
  orchestrationSnapshot: OrchestrationSnapshot;
} {
  const startedAt = Date.now();
  const registry = createDomainPackRegistry([softwareDomainPack]);
  const route = registry.route({ goalPrompt });
  const generatedRunId = `draft-${route.domainPack.id}-${hash(goalPrompt).slice(0, 12)}`;
  const generationPlan = generateConstrainedWorkflowPlan({
    runId: generatedRunId,
    goalPrompt,
    domainPack: route.domainPack,
    intentId: route.intent.id,
  });
  const workflow = materializeGenerationPlan({
    plan: generationPlan,
    domainPack: route.domainPack,
    goalPrompt,
  });
  const orchestrationSnapshot: OrchestrationSnapshot = {
    id: workflow.workflowGeneration?.orchestrationSnapshotId ?? `orch-${generationPlan.id}`,
    runId: generatedRunId,
    generationPlanId: generationPlan.id,
    manifestFingerprint: hash(JSON.stringify(workflow)),
    phaseStates: generationPlan.orchestration.phases.map((phase) => ({
      phaseId: phase.id,
      status: "pending",
      taskResultRefs: [],
      intermediateResultRefs: [],
    })),
    metrics: {
      agentInvocations: generationPlan.tasks.length,
      inputTokens: generationPlan.estimatedBudget.inputTokens,
      outputTokens: generationPlan.estimatedBudget.outputTokens,
      costMicrosUsd: generationPlan.estimatedBudget.costMicrosUsd,
    },
  };
  return {
    bundle: {
      workflow,
      plannerTrace: {
        model: "southstar-constrained-generator",
        promptHash: hash(goalPrompt),
        generatedAt: new Date().toISOString(),
      },
    },
    plannerMs: Date.now() - startedAt,
    validationMs: 0,
    generationPlan,
    orchestrationSnapshot,
  };
}

function persistGenerationResources(db: SouthstarDb, input: {
  generationPlan: WorkflowGenerationPlan;
  orchestrationSnapshot: OrchestrationSnapshot;
  workflow: SouthstarWorkflowManifest;
}): void {
  upsertRuntimeResource(db, {
    id: input.generationPlan.id,
    resourceType: "workflow_generation_plan",
    resourceKey: input.generationPlan.id,
    scope: "workflow",
    status: "validated",
    title: "Workflow generation plan",
    payload: input.generationPlan,
    summary: {
      domain: input.workflow.domain,
      intent: input.workflow.intent,
      taskCount: input.generationPlan.tasks.length,
    },
  });
  upsertRuntimeResource(db, {
    id: input.orchestrationSnapshot.id,
    resourceType: "orchestration_snapshot",
    resourceKey: input.orchestrationSnapshot.id,
    scope: "workflow",
    status: "created",
    title: "Initial orchestration snapshot",
    payload: input.orchestrationSnapshot,
    summary: {
      generationPlanId: input.generationPlan.id,
      phaseCount: input.orchestrationSnapshot.phaseStates.length,
    },
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  const generated = generateConstrainedPlannerBundle(revisedGoal);
  const bundle = generated.bundle;
  const revisionHash = createHash("sha256")
    .update(`${input.draftId}:${input.prompt}:${bundle.workflow.workflowId}`)
    .digest("hex")
    .slice(0, 12);
  const draftId = `draft-${bundle.workflow.workflowId}-rev-${revisionHash}`;
  persistGenerationResources(db, {
    generationPlan: generated.generationPlan,
    orchestrationSnapshot: generated.orchestrationSnapshot,
    workflow: bundle.workflow,
  });
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
      plannerMs: generated.plannerMs,
      validationMs: generated.validationMs,
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
  const draftResource = getResourceByKey(db, "planner_draft", input.draftId);
  const draftSummary = parseJsonObject(draftResource?.summary);
  const workflow = normalizeWorkflowRuntimeExecution(bundle.workflow);
  const runId = allocateRunId(db, bundle.workflow.workflowId);
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
    eventType: "planner.manifest_generated",
    actorType: "planner",
    payload: { draftId: input.draftId, durationMs: numberValue(draftSummary.plannerMs) ?? 0 },
  });
  appendHistoryEvent(db, {
    runId,
    eventType: "manifest.validated",
    actorType: "planner",
    payload: { draftId: input.draftId, durationMs: numberValue(draftSummary.validationMs) ?? 0 },
  });
  appendHistoryEvent(db, {
    runId,
    eventType: "run.created",
    actorType: "orchestrator",
    payload: { draftId: input.draftId, workflowId: bundle.workflow.workflowId },
  });
  const projectedWorkflow = await materializedWorkflowForExecution(db, workflow, {
    runId,
    runRoot: input.runRoot,
    harnessEndpoint: input.harnessEndpoint,
  });
  const executorSubmitStartedAt = Date.now();
  const executorSubmission = await executorProvider.submit({
    runId,
    workflow: projectedWorkflow,
    callbackUrl: input.callbackUrl ?? "/api/v2/tork/callback",
    envelopeBasePath: "/southstar-runs",
  });
  const executorSubmitMs = Date.now() - executorSubmitStartedAt;
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
      durationMs: executorSubmitMs,
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
  const taskDefinition = workflow.tasks.find((candidate) => candidate.id === input.taskId);
  if (!taskDefinition) throw new Error(`unknown task: ${input.taskId}`);
  const domainPack = domainPackForWorkflow(workflow);
  const rootSessionId = task.rootSessionId ?? `root-${input.runId}-${input.taskId}`;
  const runtimeTask = resolveRuntimeTaskProfile(workflow, domainPack, taskDefinition);
  const contextPacket = latestContextPacket(db, input) ?? buildContextPacketForTask(db, workflow, domainPack, taskDefinition, {
    runId: input.runId,
    rootSessionId,
    executionAttempt: 1,
    runtimeTask,
  });
  return buildRuntimeTaskEnvelopeV2(db, workflow, domainPack, taskDefinition, {
    runId: input.runId,
    rootSessionId,
    contextPacket,
    runtimeTask,
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
  const domainPack = domainPackForWorkflow(workflow);
  const sessionGraph = createSqliteSessionGraphProvider(db);
  const workspaceProvider = createGitWorkspaceSnapshotProvider();
  for (const task of workflow.tasks) {
    const runtimeTask = resolveRuntimeTaskProfile(workflow, domainPack, task);
    const sessionNode = sessionGraph.createSession({
      runId: input.runId,
      taskId: task.id,
      roleRef: runtimeTask.roleRef,
      agentProfileRef: runtimeTask.agentProfileRef,
    });
    const rootSessionId = sessionNode.id;
    const workspaceSnapshot = snapshotTaskWorkspace(workspaceProvider, task);
    const contextPacket = buildContextPacketForTask(db, workflow, domainPack, task, {
      runId: input.runId,
      rootSessionId,
      executionAttempt: 1,
      runtimeTask,
    });
    const startCheckpoint = sessionGraph.checkpoint({
      sessionId: rootSessionId,
      runId: input.runId,
      taskId: task.id,
      contextPacketId: contextPacket.id,
      artifactRefs: [],
      transcriptSummary: "Task submitted to executor.",
      metrics: {},
    });
    const envelope = buildRuntimeTaskEnvelopeV2(db, workflow, domainPack, task, {
      runId: input.runId,
      rootSessionId,
      baseCheckpointId: startCheckpoint.id,
      contextPacket,
      runtimeTask,
      workspaceSnapshot,
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
          ...runtimeHarnessEnv(runtimeTask.agentProfile),
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

function domainPackForWorkflow(workflow: SouthstarWorkflowManifest): DomainPack {
  return {
    ...softwareDomainPack,
    id: workflow.domain ?? softwareDomainPack.id,
    version: workflow.domainPackRef?.version ?? softwareDomainPack.version,
    roles: workflow.roles ?? softwareDomainPack.roles,
    agentProfiles: workflow.agentProfiles ?? softwareDomainPack.agentProfiles,
    artifactContracts: workflow.artifactContracts ?? softwareDomainPack.artifactContracts,
    evaluatorPipelines: workflow.evaluatorPipelines ?? softwareDomainPack.evaluatorPipelines,
    contextPolicies: workflow.contextPolicies ?? softwareDomainPack.contextPolicies,
    sessionPolicies: workflow.sessionPolicies ?? softwareDomainPack.sessionPolicies,
    memoryPolicies: workflow.memoryPolicies ?? softwareDomainPack.memoryPolicies,
    workspacePolicies: workflow.workspacePolicies ?? softwareDomainPack.workspacePolicies,
  };
}

function taskGoalPrompt(workflow: SouthstarWorkflowManifest, task: SouthstarWorkflowManifest["tasks"][number]): string {
  const promptGoal = task.promptInputs?.goalPrompt;
  if (typeof promptGoal === "string" && promptGoal.length > 0) return promptGoal;
  return workflow.goalPrompt;
}

type RuntimeTaskProfile = {
  roleRef: string;
  agentProfileRef: string;
  role: DomainPack["roles"][number];
  agentProfile: DomainPack["agentProfiles"][number];
  harness: SouthstarWorkflowManifest["harnessDefinitions"][number];
  artifactContractRefs: string[];
  artifactContracts: DomainPack["artifactContracts"];
  evaluatorPipeline: DomainPack["evaluatorPipelines"][number];
};

function resolveRuntimeTaskProfile(
  workflow: SouthstarWorkflowManifest,
  domainPack: DomainPack,
  task: SouthstarWorkflowManifest["tasks"][number],
): RuntimeTaskProfile {
  const roleProfile = resolveRoleProfile({
    taskId: task.id,
    roleRef: task.roleRef,
    agentProfileRef: task.agentProfileRef,
    roles: domainPack.roles,
  });
  const role = requiredDomainItem(domainPack.roles.find((candidate) => candidate.id === roleProfile.roleRef), `role ${roleProfile.roleRef}`);
  const agentProfile = requiredDomainItem(
    domainPack.agentProfiles.find((candidate) => candidate.id === roleProfile.agentProfileRef),
    `agent profile ${roleProfile.agentProfileRef}`,
  );
  const artifactContractRefs = resolveArtifactContractRefs({
    requiredArtifactRefs: task.requiredArtifactRefs,
    subagentArtifactTypes: task.subagents.flatMap((subagent) => subagent.requiredArtifacts),
    artifactContracts: domainPack.artifactContracts,
  });
  const artifactContracts = artifactContractRefs.map((artifactRef) =>
    requiredDomainItem(domainPack.artifactContracts.find((candidate) => candidate.id === artifactRef), `artifact contract ${artifactRef}`)
  );
  const evaluatorPipeline = requiredDomainItem(
    domainPack.evaluatorPipelines.find((candidate) => candidate.id === task.evaluatorPipelineRef)
      ?? domainPack.evaluatorPipelines[0],
    "evaluator pipeline",
  );
  const harness = requiredDomainItem(
    workflow.harnessDefinitions.find((candidate) => candidate.id === agentProfile.harnessRef)
      ?? workflow.harnessDefinitions.find((candidate) => candidate.id === task.subagents[0]?.harnessId)
      ?? workflow.harnessDefinitions[0],
    `harness ${agentProfile.harnessRef}`,
  );
  return {
    roleRef: roleProfile.roleRef,
    agentProfileRef: roleProfile.agentProfileRef,
    role,
    agentProfile,
    harness,
    artifactContractRefs,
    artifactContracts,
    evaluatorPipeline,
  };
}

function buildContextPacketForTask(
  db: SouthstarDb,
  workflow: SouthstarWorkflowManifest,
  domainPack: DomainPack,
  task: SouthstarWorkflowManifest["tasks"][number],
  input: { runId: string; rootSessionId: string; executionAttempt: number; runtimeTask: RuntimeTaskProfile },
) {
  return buildContextPacket(db, {
    runId: input.runId,
    taskId: task.id,
    rootSessionId: input.rootSessionId,
    executionAttempt: input.executionAttempt,
    goalPrompt: taskGoalPrompt(workflow, task),
    domainPack,
    roleRef: input.runtimeTask.roleRef,
    agentProfileRef: input.runtimeTask.agentProfileRef,
    artifactContractRefs: input.runtimeTask.artifactContractRefs,
    priorArtifactRefs: task.dependsOn,
    checkpointSummary: "No checkpoint materialized before initial task submission.",
    workspaceSummary: `Task ${task.id} will run in ${task.domain} workspace scope.`,
  });
}

function buildRuntimeTaskEnvelopeV2(
  db: SouthstarDb,
  workflow: SouthstarWorkflowManifest,
  _domainPack: DomainPack,
  task: SouthstarWorkflowManifest["tasks"][number],
  input: {
    runId: string;
    rootSessionId: string;
    baseCheckpointId?: string;
    contextPacket: ReturnType<typeof buildContextPacket>;
    runtimeTask: RuntimeTaskProfile;
    workspaceSnapshot?: WorkspaceSnapshotRef;
  },
) {
  return buildTaskEnvelopeV2({
    runId: input.runId,
    workflowId: workflow.workflowId,
    taskId: task.id,
    domain: task.domain,
    intent: workflow.intent ?? "unknown",
    role: input.runtimeTask.role,
    agentProfile: input.runtimeTask.agentProfile,
    harness: input.runtimeTask.harness,
    contextPacket: input.contextPacket,
    skills: resolveTaskSkills(db, input.runId, task),
    mcpGrants: [
      ...workflow.mcpGrants
        .filter((grant) => grant.taskId === task.id)
        .map((grant) => ({ serverId: grant.serverId, allowedTools: grant.allowedTools })),
      ...listResources(db, { resourceType: "mcp_grant" })
        .filter((resource) => resource.runId === input.runId && resource.taskId === task.id)
        .map((resource) => ({
          serverId: (resource.payload as { serverId?: string }).serverId ?? resource.resourceKey,
          allowedTools: (resource.payload as { allowedTools?: string[] }).allowedTools ?? [],
        })),
    ],
    vaultLeases: listResources(db, { resourceType: "vault_lease" })
      .filter((resource) => resource.runId === input.runId && resource.taskId === task.id)
      .map((resource) => ({
        leaseRef: resource.resourceKey,
        mountAs: ((resource.payload as { mountAs?: "env" | "file" }).mountAs ?? "file"),
      })),
    artifactContracts: input.runtimeTask.artifactContracts,
    evaluatorPipeline: input.runtimeTask.evaluatorPipeline,
    session: {
      sessionId: input.rootSessionId,
      baseCheckpointId: input.baseCheckpointId,
      maxRepairAttempts: task.rootSession.maxRepairAttempts,
    },
    workspace: {
      handle: {
        repoRoot: input.workspaceSnapshot?.repoRoot ?? task.execution.mounts[0]?.source ?? ".",
        worktreePath: input.workspaceSnapshot?.repoRoot ?? task.execution.mounts[0]?.source ?? ".",
      },
      baseSnapshotRef: input.workspaceSnapshot,
    },
  });
}

function snapshotTaskWorkspace(
  workspaceProvider: ReturnType<typeof createGitWorkspaceSnapshotProvider>,
  task: SouthstarWorkflowManifest["tasks"][number],
): WorkspaceSnapshotRef | undefined {
  if (!task.workspacePolicyRef) return undefined;
  const mount = task.execution.mounts.find((candidate) => !candidate.readonly && existsSync(join(candidate.source, ".git")));
  if (!mount) return undefined;
  return workspaceProvider.snapshot({ repoRoot: mount.source, reason: `task-start:${task.id}` });
}

function requiredDomainItem<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function latestContextPacket(
  db: SouthstarDb,
  input: { runId: string; taskId: string },
): ReturnType<typeof buildContextPacket> | undefined {
  const row = db.prepare(`
    select payload_json from runtime_resources
    where resource_type = 'context_packet' and run_id = ? and task_id = ?
    order by updated_at desc
    limit 1
  `).get(input.runId, input.taskId) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json) as ReturnType<typeof buildContextPacket> : undefined;
}

function resolveTaskSkills(db: SouthstarDb, runId: string, task: SouthstarWorkflowManifest["tasks"][number]): ResolvedSkillSnapshot[] {
  const skillRefs = task.skillRefs ?? [];
  return skillRefs.map((skillRef) => {
    const resourceKey = `${runId}:${task.id}:${skillRef}`;
    const existing = getResourceByKey(db, "skill_snapshot", resourceKey);
    if (existing?.status === "resolved") {
      return existing.payload as ResolvedSkillSnapshot;
    }
    const [snapshot] = resolveSkillSnapshots(db, {
      runId,
      taskId: task.id,
      skillRefs: [skillRef],
    });
    return snapshot;
  });
}

function runtimeHarnessEnv(agentProfile: DomainPack["agentProfiles"][number]): Record<string, string> {
  if (agentProfile.provider === "pi" || agentProfile.harnessRef === "pi") return {};
  return { SOUTHSTAR_HARNESS_KIND: "builtin" };
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

function parseJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
