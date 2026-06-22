import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import type { ArtifactContract, DomainPack } from "../domain-packs/types.ts";
import { buildTaskEnvelopeV2, type TaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import type { ContextPacket } from "../context/types.ts";
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import type { ResolvedSkillSnapshot } from "../skills/types.ts";

export async function getPostgresTaskEnvelope(db: SouthstarDb, input: { runId: string; taskId: string }): Promise<TaskEnvelopeV2> {
  const persisted = await latestPersistedTaskEnvelope(db, input);
  if (persisted) return persisted;
  return await buildPostgresTaskEnvelopeFromLatestContext(db, input);
}

async function latestPersistedTaskEnvelope(db: SouthstarDb, input: { runId: string; taskId: string }): Promise<TaskEnvelopeV2 | null> {
  const row = await db.maybeOne<{ payload_json: { envelope?: TaskEnvelopeV2 } }>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'task_envelope'
        and run_id = $1
        and task_id = $2
        and payload_json ? 'envelope'
      order by created_at desc
      limit 1`,
    [input.runId, input.taskId],
  );
  return row?.payload_json.envelope ?? null;
}

async function buildPostgresTaskEnvelopeFromLatestContext(db: SouthstarDb, input: { runId: string; taskId: string }): Promise<TaskEnvelopeV2> {
  const workflow = await readWorkflow(db, input.runId);
  const task = required(workflow.tasks.find((candidate) => candidate.id === input.taskId), `unknown task: ${input.taskId}`);
  const taskRow = await db.maybeOne<{ root_session_id: string | null }>(
    "select root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
    [input.runId, input.taskId],
  );
  if (!taskRow) throw new Error(`unknown task: ${input.taskId}`);
  const contextPacket = await latestContextPacket(db, input);
  const domainPack = domainPackForWorkflow(workflow);
  const role = required(domainPack.roles.find((candidate) => candidate.id === task.roleRef), `missing role ${task.roleRef}`);
  const agentProfile = required(domainPack.agentProfiles.find((candidate) => candidate.id === task.agentProfileRef), `missing agent profile ${task.agentProfileRef}`);
  const harness = required(workflow.harnessDefinitions.find((candidate) => candidate.id === agentProfile.harnessRef), `missing harness ${agentProfile.harnessRef}`);
  const artifactContracts = artifactContractsForTask(domainPack, task);
  const evaluatorPipeline = required(domainPack.evaluatorPipelines.find((candidate) => candidate.id === task.evaluatorPipelineRef), `missing evaluator pipeline ${task.evaluatorPipelineRef}`);
  const rootSessionId = taskRow.root_session_id ?? `root-${input.runId}-${input.taskId}`;
  return buildTaskEnvelopeV2({
    runId: input.runId,
    workflowId: workflow.workflowId,
    taskId: input.taskId,
    domain: workflow.domain ?? domainPack.id,
    intent: workflow.intent ?? "implement_feature",
    role,
    agentProfile,
    harness,
    contextPacket,
    skills: skillSnapshots(task.skillRefs ?? []),
    mcpGrants: (task.mcpGrantRefs ?? []).map((grantRef) => ({ serverId: grantRef, allowedTools: [] })),
    vaultLeases: [],
    artifactContracts,
    evaluatorPipeline,
    session: { sessionId: rootSessionId, maxRepairAttempts: task.rootSession.maxRepairAttempts },
  });
}

async function readWorkflow(db: SouthstarDb, runId: string): Promise<SouthstarWorkflowManifest> {
  const row = await db.maybeOne<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
    "select workflow_manifest_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  if (!row) throw new Error(`workflow run not found: ${runId}`);
  return row.workflow_manifest_json;
}

async function latestContextPacket(db: SouthstarDb, input: { runId: string; taskId: string }): Promise<ContextPacket> {
  const row = await db.maybeOne<{ payload_json: ContextPacket }>(
    `select payload_json
     from southstar.runtime_resources
     where resource_type = 'context_packet' and run_id = $1 and task_id = $2
     order by created_at desc
     limit 1`,
    [input.runId, input.taskId],
  );
  if (!row) throw new Error(`context packet not found: ${input.runId}/${input.taskId}`);
  return row.payload_json;
}

function domainPackForWorkflow(workflow: SouthstarWorkflowManifest): DomainPack {
  if (workflow.domain === softwareDomainPack.id || workflow.domainPackRef?.id === softwareDomainPack.id) return softwareDomainPack;
  return {
    ...softwareDomainPack,
    id: workflow.domain ?? softwareDomainPack.id,
    roles: workflow.roles ?? softwareDomainPack.roles,
    agentProfiles: workflow.agentProfiles ?? softwareDomainPack.agentProfiles,
    artifactContracts: workflow.artifactContracts ?? softwareDomainPack.artifactContracts,
    evaluatorPipelines: workflow.evaluatorPipelines ?? softwareDomainPack.evaluatorPipelines,
    contextPolicies: workflow.contextPolicies ?? softwareDomainPack.contextPolicies,
    sessionPolicies: workflow.sessionPolicies ?? softwareDomainPack.sessionPolicies,
    memoryPolicies: workflow.memoryPolicies ?? softwareDomainPack.memoryPolicies,
    workspacePolicies: workflow.workspacePolicies ?? softwareDomainPack.workspacePolicies,
    stopConditions: workflow.stopConditions ?? softwareDomainPack.stopConditions,
  };
}

function artifactContractsForTask(domainPack: DomainPack, task: WorkflowTaskDefinition): ArtifactContract[] {
  return (task.requiredArtifactRefs ?? [])
    .map((artifactRef) => required(domainPack.artifactContracts.find((contract) => contract.id === artifactRef), `missing artifact contract ${artifactRef}`));
}

function skillSnapshots(skillRefs: string[]): ResolvedSkillSnapshot[] {
  return skillRefs.map((skillId) => ({
    skillId,
    version: "runtime",
    instructions: `Use skill ${skillId}.`,
    allowedTools: [],
    requiredMounts: [],
    mcpRequirements: [],
    artifactContracts: [],
    contentHash: createHash("sha256").update(skillId).digest("hex"),
    mountPath: `/skills/${skillId}`,
  }));
}

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}
