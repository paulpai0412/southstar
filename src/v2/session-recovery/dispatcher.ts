// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildTaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import { materializeTaskEnvelope } from "../agent-runner/materializer.ts";
import { buildContextPacket } from "../context/builder.ts";
import type { DomainPack } from "../domain-packs/types.ts";
import { createExecutorBinding } from "../executor/bindings.ts";
import type { ExecutorProvider } from "../executor/provider.ts";
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { resolveSkillSnapshots } from "../skills/resolver.ts";
import { createLibraryBackedSkillCatalog } from "../skills/library-backed-catalog.ts";
import type { ResolvedSkillSnapshot } from "../skills/types.ts";
import type { RecoveryExecutionPlan } from "./execution-planner.ts";

export type RecoveryDispatchInput = {
  runId: string;
  failedTaskId: string;
  plan: RecoveryExecutionPlan;
  executorProvider: ExecutorProvider;
  runRoot?: string;
  callbackUrl: string;
  heartbeatUrl?: string;
  contextRefreshUrl?: string;
  harnessEndpoint?: string;
};

export type RecoveryDispatchResult = {
  recoveryExecutionId: string;
  externalJobId: string;
  targetTaskIds: string[];
  attemptId: string;
};

export async function dispatchRecoveryExecution(
  db: SouthstarDb,
  input: RecoveryDispatchInput,
): Promise<RecoveryDispatchResult> {
  const workflow = readWorkflowManifest(db, input.runId);
  const attemptId = `attempt-${input.plan.attemptNumber}`;
  const targetTaskIds = [...input.plan.targetTaskIds];
  if (targetTaskIds.length === 0) throw new Error(`recovery plan for ${input.failedTaskId} has no target tasks`);

  const domainPack = domainPackFromWorkflow(workflow);
  const runRoot = input.runRoot ?? "/tmp/southstar-runs";
  const recoveryRunRoot = join(runRoot, `recovery-${attemptId}`);
  const recoveryEnvelopeBasePath = `/southstar-runs/recovery-${attemptId}`;
  const subsetWorkflow = workflowForRecoveryTargets(workflow, targetTaskIds, {
    runRoot,
    contextRefreshUrl: input.contextRefreshUrl,
    harnessEndpoint: input.harnessEndpoint,
  });

  for (const task of subsetWorkflow.tasks) {
    const envelope = buildRecoveryTaskEnvelope(db, {
      workflow,
      domainPack,
      task,
      runId: input.runId,
      attemptNumber: input.plan.attemptNumber,
      reason: input.plan.reason,
    });
    upsertRuntimeResource(db, {
      id: `task-envelope-${input.runId}-${task.id}-recovery-${input.plan.attemptNumber}`,
      resourceType: "task_envelope",
      resourceKey: `task-envelope-${input.runId}-${task.id}-recovery-${input.plan.attemptNumber}`,
      runId: input.runId,
      taskId: task.id,
      sessionId: envelope.session.sessionId,
      scope: task.domain,
      status: "created",
      title: "Recovery TaskEnvelopeV2",
      payload: envelope,
      summary: { schemaVersion: envelope.schemaVersion, contextPacketId: envelope.contextPacket.id },
    });
    await materializeTaskEnvelope(envelope, { runRoot: recoveryRunRoot });
    resetTaskForRecovery(db, input.runId, task.id, envelope.session.sessionId);
  }

  const executorSubmission = await input.executorProvider.submit({
    runId: input.runId,
    workflow: subsetWorkflow,
    callbackUrl: input.callbackUrl,
    heartbeatUrl: input.heartbeatUrl,
    envelopeBasePath: recoveryEnvelopeBasePath,
    attemptId,
  });

  for (const task of subsetWorkflow.tasks) {
    createExecutorBinding(db, {
      runId: input.runId,
      taskId: task.id,
      attemptId,
      torkJobId: executorSubmission.externalJobId,
      status: executorSubmission.status === "queued" ? "queued" : "submitted",
      queueTimeoutSeconds: 120,
      hardTimeoutSeconds: task.execution.timeoutSeconds,
    });
  }

  const recoveryExecutionId = `recovery-execution-${input.runId}-${input.failedTaskId}-${attemptId}`;
  upsertRuntimeResource(db, {
    id: recoveryExecutionId,
    resourceType: "recovery_execution",
    resourceKey: recoveryExecutionId,
    runId: input.runId,
    taskId: input.failedTaskId,
    scope: "recovery",
    status: "submitted",
    title: `Recovery execution ${attemptId}`,
    payload: {
      runId: input.runId,
      failedTaskId: input.failedTaskId,
      targetTaskIds,
      attemptId,
      strategy: input.plan.strategy,
      externalJobId: executorSubmission.externalJobId,
      projectionFingerprint: executorSubmission.projectionFingerprint,
      executionProjection: executorSubmission.executionProjection,
    },
    summary: {
      targetTaskIds,
      attemptId,
      strategy: input.plan.strategy,
      externalJobId: executorSubmission.externalJobId,
    },
  });
  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.failedTaskId,
    eventType: "recovery.execution_submitted",
    actorType: "orchestrator",
    payload: {
      recoveryExecutionId,
      targetTaskIds,
      attemptId,
      strategy: input.plan.strategy,
      externalJobId: executorSubmission.externalJobId,
    },
  });

  return {
    recoveryExecutionId,
    externalJobId: executorSubmission.externalJobId,
    targetTaskIds,
    attemptId,
  };
}

function buildRecoveryTaskEnvelope(
  db: SouthstarDb,
  input: {
    workflow: SouthstarWorkflowManifest;
    domainPack: DomainPack;
    task: WorkflowTaskDefinition;
    runId: string;
    attemptNumber: number;
    reason: string;
  },
) {
  const roleRef = requiredString(input.task.roleRef, `task ${input.task.id} roleRef`);
  const agentProfileRef = requiredString(input.task.agentProfileRef, `task ${input.task.id} agentProfileRef`);
  const role = required(input.domainPack.roles.find((candidate) => candidate.id === roleRef), `role ${roleRef}`);
  const agentProfile = required(
    input.domainPack.agentProfiles.find((candidate) => candidate.id === agentProfileRef),
    `agent profile ${agentProfileRef}`,
  );
  const artifactContractRefs = resolveArtifactContractRefs(input.domainPack, input.task);
  const artifactContracts = artifactContractRefs.map((ref) =>
    required(input.domainPack.artifactContracts.find((candidate) => candidate.id === ref), `artifact contract ${ref}`)
  );
  const evaluatorPipeline = required(
    input.domainPack.evaluatorPipelines.find((candidate) => candidate.id === input.task.evaluatorPipelineRef),
    `evaluator pipeline ${input.task.evaluatorPipelineRef ?? ""}`,
  );
  const harness = required(
    input.workflow.harnessDefinitions.find((candidate) => candidate.id === agentProfile.harnessRef)
      ?? input.workflow.harnessDefinitions.find((candidate) => candidate.id === input.task.subagents[0]?.harnessId),
    `harness ${agentProfile.harnessRef}`,
  );
  const sessionId = `root-${input.runId}-${input.task.id}-recovery-${input.attemptNumber}`;
  const contextPacket = buildContextPacket(db, {
    contextPacketId: `ctx-${input.runId}-${input.task.id}-recovery-${input.attemptNumber}`,
    runId: input.runId,
    taskId: input.task.id,
    rootSessionId: sessionId,
    executionAttempt: input.attemptNumber,
    goalPrompt: taskGoalPrompt(input.workflow, input.task),
    domainPack: input.domainPack,
    roleRef,
    agentProfileRef,
    artifactContractRefs,
    priorArtifactRefs: input.task.dependsOn,
    checkpointSummary: `Recovery attempt ${input.attemptNumber}. ${input.reason}`,
    workspaceSummary: `Recovery task ${input.task.id} will run from workflow-derived execution slice.`,
  });

  return buildTaskEnvelopeV2({
    runId: input.runId,
    workflowId: input.workflow.workflowId,
    taskId: input.task.id,
    domain: input.task.domain,
    intent: input.workflow.intent ?? "recovery",
    role,
    agentProfile,
    harness,
    contextPacket,
    skills: resolveTaskSkills(db, input.runId, input.task),
    mcpGrants: [
      ...agentProfile.mcpGrantRefs.map((grantRef) => ({ serverId: grantRef, allowedTools: agentProfile.toolPolicy.allowedTools })),
      ...input.workflow.mcpGrants
        .filter((grant) => grant.taskId === input.task.id)
        .map((grant) => ({ serverId: grant.serverId, allowedTools: grant.allowedTools })),
    ],
    vaultLeases: [],
    artifactContracts,
    evaluatorPipeline,
    session: {
      sessionId,
      maxRepairAttempts: input.task.rootSession.maxRepairAttempts,
    },
    workspace: {
      handle: {
        repoRoot: input.task.execution.mounts[0]?.target ?? "/workspace/repo",
        worktreePath: input.task.execution.mounts[0]?.target ?? "/workspace/repo",
      },
    },
  });
}

function workflowForRecoveryTargets(
  workflow: SouthstarWorkflowManifest,
  targetTaskIds: string[],
  input: { runRoot: string; contextRefreshUrl?: string; harnessEndpoint?: string },
): SouthstarWorkflowManifest {
  const targetSet = new Set(targetTaskIds);
  return {
    ...workflow,
    tasks: workflow.tasks
      .filter((task) => targetSet.has(task.id))
      .map((task) => ({
        ...task,
        dependsOn: task.dependsOn.filter((dependency) => targetSet.has(dependency)),
        execution: {
          ...task.execution,
          env: {
            ...task.execution.env,
            ...(input.harnessEndpoint ? { SOUTHSTAR_HARNESS_ENDPOINT: input.harnessEndpoint } : {}),
            ...(input.contextRefreshUrl ? { SOUTHSTAR_CONTEXT_REFRESH_URL: input.contextRefreshUrl } : {}),
            SOUTHSTAR_MATERIALIZATION_ROOT: input.runRoot,
            ...piAgentEnv(),
          },
          mounts: [
            ...task.execution.mounts,
            ...piAgentMounts(),
            { source: input.runRoot, target: "/southstar-runs", readonly: true },
          ],
        },
      })),
  };
}

function domainPackFromWorkflow(workflow: SouthstarWorkflowManifest): DomainPack {
  return {
    id: workflow.domain ?? "general",
    version: workflow.domainPackRef?.version ?? "workflow-embedded",
    displayName: workflow.title,
    intents: [],
    roles: requireArray(workflow.roles, "workflow.roles"),
    agentProfiles: requireArray(workflow.agentProfiles, "workflow.agentProfiles"),
    workflowTemplates: [],
    workflowGeneratorPolicies: [],
    artifactContracts: requireArray(workflow.artifactContracts, "workflow.artifactContracts"),
    evaluatorPipelines: requireArray(workflow.evaluatorPipelines, "workflow.evaluatorPipelines"),
    contextPolicies: requireArray(workflow.contextPolicies, "workflow.contextPolicies"),
    sessionPolicies: requireArray(workflow.sessionPolicies, "workflow.sessionPolicies"),
    memoryPolicies: requireArray(workflow.memoryPolicies, "workflow.memoryPolicies"),
    workspacePolicies: workflow.workspacePolicies ?? [],
    stopConditions: [],
  };
}

function resolveArtifactContractRefs(domainPack: DomainPack, task: WorkflowTaskDefinition): string[] {
  const refs = new Set<string>();
  for (const ref of task.requiredArtifactRefs ?? []) {
    const contract = findArtifactContract(domainPack, ref);
    if (contract) refs.add(contract.id);
  }
  for (const ref of task.subagents.flatMap((subagent) => subagent.requiredArtifacts)) {
    const contract = findArtifactContract(domainPack, ref);
    if (contract) refs.add(contract.id);
  }
  if (refs.size === 0) throw new Error(`task ${task.id} has no resolvable artifact contracts`);
  return [...refs];
}

function findArtifactContract(domainPack: DomainPack, ref: string) {
  const normalized = normalizeRef(ref);
  return domainPack.artifactContracts.find((candidate) =>
    normalizeRef(candidate.id) === normalized || normalizeRef(candidate.artifactType) === normalized
  );
}

function resolveTaskSkills(db: SouthstarDb, runId: string, task: WorkflowTaskDefinition): ResolvedSkillSnapshot[] {
  if ((task.skillRefs ?? []).length === 0) return [];
  const snapshots = resolveSkillSnapshots(db, {
    runId,
    taskId: task.id,
    skillRefs: task.skillRefs ?? [],
    catalog: createLibraryBackedSkillCatalog(db),
  });
  return snapshots;
}

function resetTaskForRecovery(db: SouthstarDb, runId: string, taskId: string, rootSessionId: string): void {
  db.prepare(`
    update workflow_tasks
    set status = 'pending', root_session_id = ?, updated_at = ?, completed_at = null
    where run_id = ? and id = ?
  `).run(rootSessionId, new Date().toISOString(), runId, taskId);
}

function readWorkflowManifest(db: SouthstarDb, runId: string): SouthstarWorkflowManifest {
  const row = db.prepare("select workflow_manifest_json from workflow_runs where id = ?")
    .get(runId) as { workflow_manifest_json: string } | undefined;
  if (!row) throw new Error(`workflow run not found: ${runId}`);
  const workflow = JSON.parse(row.workflow_manifest_json) as SouthstarWorkflowManifest;
  if (!Array.isArray(workflow.tasks)) throw new Error(`workflow run ${runId} has no tasks`);
  return workflow;
}

function taskGoalPrompt(workflow: SouthstarWorkflowManifest, task: WorkflowTaskDefinition): string {
  const value = task.promptInputs?.goalPrompt;
  return typeof value === "string" && value.length > 0 ? value : workflow.goalPrompt;
}

function piAgentEnv(): Record<string, string> {
  const source = process.env.SOUTHSTAR_PI_AGENT_DIR ?? "/home/timmypai/.pi/agent";
  if (!existsSync(source)) return {};
  return { PI_CODING_AGENT_DIR: "/southstar/pi-agent", PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-agent-sessions" };
}

function piAgentMounts(): Array<{ source: string; target: string; readonly: boolean }> {
  const source = process.env.SOUTHSTAR_PI_AGENT_DIR ?? "/home/timmypai/.pi/agent";
  if (!existsSync(source)) return [];
  return [{ source, target: "/southstar/pi-agent", readonly: true }];
}

function requireArray<T>(value: T[] | undefined, label: string): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} is required for recovery dispatch`);
  return value;
}

function required<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function requiredString(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function normalizeRef(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
