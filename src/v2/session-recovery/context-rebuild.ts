import type { DomainPack } from "../domain-packs/types.ts";
import { buildContextPacket } from "../context/builder.ts";
import { buildTaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import type { ContextPacket } from "../context/types.ts";
import type { TaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { ResolvedSkillSnapshot } from "../skills/types.ts";
import { getSessionCheckpoint } from "./checkpoints.ts";
import { recoverySavingsTelemetry } from "./telemetry.ts";
import type { RecoverySavingsTelemetry } from "./telemetry.ts";

export type RebuildTaskEnvelopeInput = {
  runId: string;
  taskId: string;
  workflowId: string;
  domainPack: DomainPack;
  roleRef: string;
  agentProfileRef: string;
  artifactContractRefs: string[];
  checkpointId: string;
  goalPrompt: string;
  executionAttempt: number;
};

export type RebuildTaskEnvelopeResult = {
  contextPacket: ContextPacket;
  envelope: TaskEnvelopeV2;
  telemetry: RecoverySavingsTelemetry;
};

export function rebuildTaskEnvelopeFromCheckpoint(db: SouthstarDb, input: RebuildTaskEnvelopeInput): RebuildTaskEnvelopeResult {
  const checkpoint = getSessionCheckpoint(db, input.checkpointId);
  if (!checkpoint) throw new Error(`session checkpoint not found: ${input.checkpointId}`);
  if (checkpoint.runId !== input.runId) throw new Error(`checkpoint ${input.checkpointId} does not belong to run ${input.runId}`);
  if (checkpoint.taskId !== input.taskId) throw new Error(`checkpoint ${input.checkpointId} does not belong to task ${input.taskId}`);

  const contextPacket = buildContextPacket(db, {
    contextPacketId: `ctx-${input.runId}-${input.taskId}-recovery-${input.executionAttempt}`,
    runId: input.runId,
    taskId: input.taskId,
    rootSessionId: checkpoint.sessionId,
    executionAttempt: input.executionAttempt,
    goalPrompt: input.goalPrompt,
    domainPack: input.domainPack,
    roleRef: input.roleRef,
    agentProfileRef: input.agentProfileRef,
    artifactContractRefs: input.artifactContractRefs,
    priorArtifactRefs: checkpoint.artifactRefs,
    checkpointSummary: checkpoint.summaries.checkpointSummary,
    failureSummary: compactFailureText(checkpoint),
    workspaceSummary: checkpoint.workspaceSnapshotRef ? `Workspace snapshot: ${checkpoint.workspaceSnapshotRef}` : undefined,
  });

  const runtimeTask = resolveRuntimeTask(input.domainPack, input.roleRef, input.agentProfileRef, input.artifactContractRefs);
  const envelope = buildTaskEnvelopeV2({
    runId: input.runId,
    workflowId: input.workflowId,
    taskId: input.taskId,
    domain: input.domainPack.id,
    intent: "recovery",
    role: runtimeTask.role,
    agentProfile: runtimeTask.agentProfile,
    harness: {
      id: runtimeTask.agentProfile.harnessRef,
      kind: runtimeTask.agentProfile.harnessRef === "pi" ? "pi-agent" : "custom",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: [input.domainPack.id],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    },
    contextPacket,
    skills: resolvedSkillsForRecovery(db, input.runId, input.taskId),
    mcpGrants: [],
    vaultLeases: [],
    artifactContracts: runtimeTask.artifactContracts,
    evaluatorPipeline: runtimeTask.evaluatorPipeline,
    session: { sessionId: checkpoint.sessionId, baseCheckpointId: checkpoint.checkpointId, maxRepairAttempts: 1 },
  });

  upsertRuntimeResource(db, {
    id: `task-envelope-${input.runId}-${input.taskId}-recovery-${input.executionAttempt}`,
    resourceType: "task_envelope",
    resourceKey: `task-envelope-${input.runId}-${input.taskId}-recovery-${input.executionAttempt}`,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: checkpoint.sessionId,
    scope: input.domainPack.id,
    status: "created",
    title: "Recovery TaskEnvelopeV2",
    payload: envelope,
    summary: { contextPacketId: contextPacket.id, baseCheckpointId: checkpoint.checkpointId },
  });

  return {
    contextPacket,
    envelope,
    telemetry: recoverySavingsTelemetry({
      originalContextTokenEstimate: checkpoint.tokenTelemetry.contextTokenEstimate,
      rebuiltContextTokenEstimate: contextPacket.tokenEstimate.total,
      omittedFailureSuffixEstimate: checkpoint.tokenTelemetry.failureSuffixTokenEstimate,
    }),
  };
}

function compactFailureText(checkpoint: NonNullable<ReturnType<typeof getSessionCheckpoint>>): string | undefined {
  return [
    checkpoint.summaries.failureSummary,
    checkpoint.summaries.attemptedApproach ? `Attempted approach: ${checkpoint.summaries.attemptedApproach}` : undefined,
    checkpoint.summaries.nextAttemptHint ? `Next attempt: ${checkpoint.summaries.nextAttemptHint}` : undefined,
  ].filter(Boolean).join("\n") || undefined;
}

function resolvedSkillsForRecovery(db: SouthstarDb, runId: string, taskId: string): ResolvedSkillSnapshot[] {
  return listResources(db, { resourceType: "skill_snapshot", status: "resolved" })
    .filter((resource) => resource.runId === runId && resource.taskId === taskId)
    .map((resource) => resource.payload as ResolvedSkillSnapshot)
    .sort((left, right) => left.skillId.localeCompare(right.skillId));
}

function resolveRuntimeTask(domainPack: DomainPack, roleRef: string, agentProfileRef: string, artifactContractRefs: string[]) {
  const role = domainPack.roles.find((candidate) => candidate.id === roleRef);
  const agentProfile = domainPack.agentProfiles.find((candidate) => candidate.id === agentProfileRef);
  if (!role) throw new Error(`missing role ${roleRef}`);
  if (!agentProfile) throw new Error(`missing agent profile ${agentProfileRef}`);
  const artifactContracts = artifactContractRefs.map((ref) => {
    const contract = domainPack.artifactContracts.find((candidate) => candidate.id === ref);
    if (!contract) throw new Error(`missing artifact contract ${ref}`);
    return contract;
  });
  const evaluatorPipeline = domainPack.evaluatorPipelines[0];
  if (!evaluatorPipeline) throw new Error("missing evaluator pipeline");
  return { role, agentProfile, artifactContracts, evaluatorPipeline };
}
