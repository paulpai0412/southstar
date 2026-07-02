import type { SouthstarDb } from "../db/postgres.ts";
import { seedSoftwareLibraryGraph } from "../design-library/software-library-seed.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import type { ArtifactContract, DomainPack } from "../domain-packs/types.ts";
import { buildTaskEnvelopeV2, type TaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import type { ContextPacket } from "../context/types.ts";
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import { normalizeLibraryRefs, type LibraryRefKind } from "../orchestration/library-ref-compat.ts";
import { materializeTaskLibraryRefs } from "../orchestration/runtime-library-materializer.ts";
import { assertWorkspaceMountAllowed } from "../workspace/workspace-mount-policy.ts";

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
  const envelope = row?.payload_json.envelope ?? null;
  const hostMountPath = envelope?.workspace?.handle?.hostMountPath;
  if (hostMountPath && isHostMountPath(hostMountPath)) assertWorkspaceMountAllowed(hostMountPath);
  return envelope;
}

async function buildPostgresTaskEnvelopeFromLatestContext(db: SouthstarDb, input: { runId: string; taskId: string }): Promise<TaskEnvelopeV2> {
  const workflow = await readWorkflow(db, input.runId);
  const workspace = await readWorkspaceHandle(db, input.runId);
  const task = required(workflow.tasks.find((candidate) => candidate.id === input.taskId), `unknown task: ${input.taskId}`);
  const taskRow = await db.maybeOne<{ root_session_id: string | null }>(
    "select root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
    [input.runId, input.taskId],
  );
  if (!taskRow) throw new Error(`unknown task: ${input.taskId}`);
  const contextPacket = await latestContextPacket(db, input);
  const domainPack = domainPackForWorkflow(workflow);
  const workflowRoles = required(workflow.roles, `missing workflow roles in manifest ${workflow.workflowId}`);
  const workflowProfiles = required(workflow.agentProfiles, `missing workflow agentProfiles in manifest ${workflow.workflowId}`);
  const role = required(workflowRoles.find((candidate) => candidate.id === task.roleRef), `missing role ${task.roleRef}`);
  const agentProfile = required(workflowProfiles.find((candidate) => candidate.id === task.agentProfileRef), `missing agent profile ${task.agentProfileRef}`);
  const harness = required(workflow.harnessDefinitions.find((candidate) => candidate.id === agentProfile.harnessRef), `missing harness ${agentProfile.harnessRef}`);
  const artifactContracts = artifactContractsForTask(domainPack, task);
  const evaluatorPipeline = required(domainPack.evaluatorPipelines.find((candidate) => candidate.id === task.evaluatorPipelineRef), `missing evaluator pipeline ${task.evaluatorPipelineRef}`);
  const rootSessionId = taskRow.root_session_id ?? `root-${input.runId}-${input.taskId}`;
  await seedSoftwareLibraryGraph(db);
  const materializedLibrary = await materializeTaskLibraryRefs(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: rootSessionId,
    instructionRefs: libraryRefs(task.instructionRefs, "instruction.", "instruction"),
    skillRefs: libraryRefs(task.skillRefs, "skill.", "skill"),
    toolGrantRefs: libraryRefs(task.toolGrantRefs, "tool.", "tool"),
    mcpGrantRefs: libraryRefs(task.mcpGrantRefs, "mcp.", "mcp"),
    vaultLeasePolicyRefs: libraryRefs(task.vaultLeasePolicyRefs, "vault.", "vault"),
  });
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
    skills: materializedLibrary.skills,
    mcpGrants: materializedLibrary.mcpGrants,
    vaultLeases: materializedLibrary.vaultLeases,
    toolProxyPolicy: materializedLibrary.toolProxyPolicy,
    materializedLibraryRefs: {
      instructionRefs: libraryRefs(task.instructionRefs, "instruction.", "instruction"),
      skillRefs: libraryRefs(task.skillRefs, "skill.", "skill"),
      toolGrantRefs: libraryRefs(task.toolGrantRefs, "tool.", "tool"),
      mcpGrantRefs: libraryRefs(task.mcpGrantRefs, "mcp.", "mcp"),
      vaultLeasePolicyRefs: libraryRefs(task.vaultLeasePolicyRefs, "vault.", "vault"),
    },
    artifactContracts,
    evaluatorPipeline,
    session: { sessionId: rootSessionId, maxRepairAttempts: task.rootSession.maxRepairAttempts },
    ...(workspace ? { workspace } : {}),
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

async function readWorkspaceHandle(db: SouthstarDb, runId: string): Promise<TaskEnvelopeV2["workspace"] | undefined> {
  const row = await db.maybeOne<{ runtime_context_json: unknown }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  const runtimeContext = asRecord(row?.runtime_context_json);
  const projectRoot = stringValue(runtimeContext.projectRoot) ?? stringValue(runtimeContext.cwd);
  if (!projectRoot || !isHostMountPath(projectRoot)) return undefined;
  assertWorkspaceMountAllowed(projectRoot);
  return {
    handle: {
      repoRoot: "/workspace/repo",
      worktreePath: "/workspace/repo",
      hostMountPath: projectRoot,
    },
  };
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

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function libraryRefs(values: string[] | undefined, prefix: string, kind: LibraryRefKind): string[] {
  return normalizeLibraryRefs({ values, prefix, kind });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isHostMountPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("/workspace/");
}
