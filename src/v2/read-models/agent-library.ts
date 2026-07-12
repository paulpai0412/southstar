import type { SouthstarDb } from "../db/postgres.ts";
import { listLibraryEdges, listLibraryObjects } from "../design-library/library-graph-store.ts";
import type { LibraryEdgeRecord, LibraryObjectSummary } from "../design-library/types.ts";
import type { AgentProfile, RoleDefinition } from "../design-library/runtime-types.ts";

type AgentLibraryInput = {
  domain?: string;
};

type AgentLibraryCandidatesInput = {
  draftId: string;
  taskId?: string;
};

type DraftResourceRow = {
  payload_json: unknown;
};

type DraftTaskShape = {
  id: string;
  roleRef?: string;
  agentProfileRef?: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  toolGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
};

export type AgentLibraryReadModel = {
  domain: string;
  roles: RoleDefinition[];
  agentProfiles: AgentProfile[];
  skills: Array<{ id: string; profileRefs: string[] }>;
  mcpServers: Array<{ id: string; profileRefs: string[] }>;
  tools: Array<{ id: string; profileRefs: string[] }>;
  artifactContracts: unknown[];
  evaluatorPipelines: unknown[];
  contextPolicies: unknown[];
  sessionPolicies: unknown[];
  memoryPolicies: unknown[];
  workspacePolicies: unknown[];
  vaultLeasePolicies: unknown[];
};

export type AgentLibraryCandidatesReadModel = {
  draftId: string;
  taskId: string;
  domain: string;
  selectedRefs: {
    roleRef?: string;
    agentProfileRef?: string;
    skillRefs: string[];
    mcpGrantRefs: string[];
    toolGrantRefs: string[];
    vaultLeasePolicyRefs: string[];
  };
  alternatives: {
    roles: RoleDefinition[];
    agentProfiles: AgentProfile[];
    skills: Array<{ id: string; profileRefs: string[] }>;
    mcpServers: Array<{ id: string; profileRefs: string[] }>;
    tools: Array<{ id: string; profileRefs: string[] }>;
    vaultLeasePolicies: unknown[];
  };
  selectionReasons: string[];
};

export async function buildAgentLibraryReadModelPg(db: SouthstarDb, input: AgentLibraryInput): Promise<AgentLibraryReadModel> {
  const domain = normalizeDomain(input.domain);
  const library = await buildDomainLibrary(db, domain);
  return {
    domain,
    roles: library.roles,
    agentProfiles: library.agentProfiles,
    skills: library.skills,
    mcpServers: library.mcpServers,
    tools: library.tools,
    artifactContracts: library.artifactContracts,
    evaluatorPipelines: library.evaluatorPipelines,
    contextPolicies: library.contextPolicies,
    sessionPolicies: library.sessionPolicies,
    memoryPolicies: library.memoryPolicies,
    workspacePolicies: library.workspacePolicies,
    vaultLeasePolicies: library.vaultLeasePolicies,
  };
}

export async function buildAgentLibraryCandidatesReadModelPg(
  db: SouthstarDb,
  input: AgentLibraryCandidatesInput,
): Promise<AgentLibraryCandidatesReadModel> {
  const draft = await db.maybeOne<DraftResourceRow>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'planner_draft'
        and resource_key = $1`,
    [input.draftId],
  );
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);

  const payload = asRecord(draft.payload_json);
  const workflow = asRecord(payload.workflow);
  const tasks = workflowTasksFromUnknown(workflow.tasks);
  const selectedTaskId = selectTaskId(tasks.map((task) => task.id), input.taskId);
  if (!selectedTaskId) throw new Error(`planner draft has no tasks: ${input.draftId}`);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  if (!selectedTask) throw new Error(`planner draft task not found: ${selectedTaskId}`);

  const domain = normalizeDomain(stringValue(workflow.domain));
  const library = await buildDomainLibrary(db, domain);
  const selectedRole = selectedTask.roleRef ? library.roles.find((role) => role.id === selectedTask.roleRef) : undefined;
  const allowedAgentProfileRefs = selectedRole?.allowedAgentProfileRefs ?? library.agentProfiles.map((profile) => profile.id);
  const alternativeProfiles = library.agentProfiles.filter((profile) => allowedAgentProfileRefs.includes(profile.id));

  const selectionReasons = buildSelectionReasons(selectedTask, selectedRole, library.agentProfiles);

  return {
    draftId: input.draftId,
    taskId: selectedTask.id,
    domain,
    selectedRefs: {
      ...(selectedTask.roleRef ? { roleRef: selectedTask.roleRef } : {}),
      ...(selectedTask.agentProfileRef ? { agentProfileRef: selectedTask.agentProfileRef } : {}),
      skillRefs: selectedTask.skillRefs,
      mcpGrantRefs: selectedTask.mcpGrantRefs,
      toolGrantRefs: selectedTask.toolGrantRefs,
      vaultLeasePolicyRefs: selectedTask.vaultLeasePolicyRefs,
    },
    alternatives: {
      roles: library.roles,
      agentProfiles: alternativeProfiles,
      skills: library.skills,
      mcpServers: library.mcpServers,
      tools: library.tools,
      vaultLeasePolicies: library.vaultLeasePolicies,
    },
    selectionReasons,
  };
}

async function buildDomainLibrary(db: SouthstarDb, domain: string): Promise<{
  roles: RoleDefinition[];
  agentProfiles: AgentProfile[];
  skills: Array<{ id: string; profileRefs: string[] }>;
  mcpServers: Array<{ id: string; profileRefs: string[] }>;
  tools: Array<{ id: string; profileRefs: string[] }>;
  artifactContracts: unknown[];
  evaluatorPipelines: unknown[];
  contextPolicies: unknown[];
  sessionPolicies: unknown[];
  memoryPolicies: unknown[];
  workspacePolicies: unknown[];
  vaultLeasePolicies: unknown[];
}> {
  const objects = await listLibraryObjects(db, { scope: domain, status: "approved" });
  const edges = await listLibraryEdges(db, { scope: domain, status: "active" });
  const agentObjects = objects.filter((object) => object.objectKind === "agent_definition" || object.objectKind === "agent_spec");
  const agentProfiles = objects
    .filter((object) => object.objectKind === "agent_profile")
    .map(agentProfileFromObject)
    .filter((profile): profile is AgentProfile => Boolean(profile));
  return {
    roles: agentObjects.map(roleFromAgentObject).filter((role): role is RoleDefinition => Boolean(role)),
    agentProfiles,
    skills: objectRefRows(objects, edges, ["skill_spec", "skill_definition"], agentProfiles, (profile) => profile.skillRefs),
    mcpServers: objectRefRows(objects, edges, ["mcp_tool_grant"], agentProfiles, (profile) => profile.mcpGrantRefs),
    tools: objectRefRows(objects, edges, ["tool_definition"], agentProfiles, (profile) => profile.toolPolicy.allowedTools),
    artifactContracts: statesByKind(objects, "artifact_contract"),
    evaluatorPipelines: statesByKind(objects, "evaluator_profile"),
    contextPolicies: statesByPolicyKind(objects, "context"),
    sessionPolicies: statesByPolicyKind(objects, "session"),
    memoryPolicies: statesByPolicyKind(objects, "memory"),
    workspacePolicies: statesByPolicyKind(objects, "workspace"),
    vaultLeasePolicies: statesByKind(objects, "vault_lease_policy"),
  };
}

function objectRefRows(
  objects: LibraryObjectSummary[],
  edges: LibraryEdgeRecord[],
  kinds: LibraryObjectSummary["objectKind"][],
  profiles: AgentProfile[],
  selector: (profile: AgentProfile) => string[],
): Array<{ id: string; profileRefs: string[] }> {
  const objectKeys = new Set(objects.filter((object) => kinds.includes(object.objectKind)).map((object) => object.objectKey));
  const rows = uniqueRefRows(profiles, selector);
  for (const objectKey of objectKeys) {
    if (!rows.some((row) => row.id === objectKey)) rows.push({ id: objectKey, profileRefs: graphSourceRefs(edges, objectKey) });
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function uniqueRefRows(
  profiles: AgentProfile[],
  selector: (profile: AgentProfile) => string[],
): Array<{ id: string; profileRefs: string[] }> {
  const byId = new Map<string, Set<string>>();
  for (const profile of profiles) {
    for (const ref of selector(profile)) {
      if (!ref) continue;
      const profileSet = byId.get(ref) ?? new Set<string>();
      profileSet.add(profile.id);
      byId.set(ref, profileSet);
    }
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, profileRefs]) => ({ id, profileRefs: [...profileRefs].sort() }));
}

function graphSourceRefs(edges: LibraryEdgeRecord[], objectKey: string): string[] {
  return [...new Set(edges.filter((edge) => edge.toObjectKey === objectKey).map((edge) => edge.fromObjectKey))].sort();
}

function statesByKind(objects: LibraryObjectSummary[], kind: LibraryObjectSummary["objectKind"]): unknown[] {
  return objects.filter((object) => object.objectKind === kind).map((object) => ({ id: object.objectKey, ...object.state }));
}

function statesByPolicyKind(objects: LibraryObjectSummary[], policyKind: string): unknown[] {
  return objects
    .filter((object) => object.objectKind === "policy_bundle" && stringValue(object.state.policyKind) === policyKind)
    .map((object) => ({ id: object.objectKey, ...object.state }));
}

function roleFromAgentObject(object: LibraryObjectSummary): RoleDefinition | null {
  const runtimeRole = asRecord(object.state.runtimeRole);
  if (Object.keys(runtimeRole).length === 0) return null;
  return runtimeRole as RoleDefinition;
}

function agentProfileFromObject(object: LibraryObjectSummary): AgentProfile | null {
  const profile = asRecord(object.state.agentProfile);
  const runtimeProfile = asRecord(object.state.runtimeProfile);
  const candidate = Object.keys(profile).length > 0
    ? profile
    : Object.keys(runtimeProfile).length > 0
      ? runtimeProfile
      : object.state;
  if (!stringValue(candidate.id)) return null;
  return candidate as AgentProfile;
}

function buildSelectionReasons(
  selectedTask: DraftTaskShape,
  selectedRole: RoleDefinition | undefined,
  domainProfiles: AgentProfile[],
): string[] {
  const reasons: string[] = [];
  if (selectedTask.roleRef) {
    if (selectedRole) reasons.push(`task ${selectedTask.id} is assigned role ${selectedTask.roleRef}`);
    else reasons.push(`task ${selectedTask.id} keeps requested role ${selectedTask.roleRef} (not in software defaults)`);
  }
  if (selectedTask.agentProfileRef) {
    if (domainProfiles.some((profile) => profile.id === selectedTask.agentProfileRef)) {
      reasons.push(`task ${selectedTask.id} is pinned to profile ${selectedTask.agentProfileRef}`);
    } else {
      reasons.push(`task ${selectedTask.id} requested profile ${selectedTask.agentProfileRef}; showing closest domain alternatives`);
    }
  }
  if (selectedTask.skillRefs.length > 0) reasons.push(`task ${selectedTask.id} keeps selected skill refs`);
  if (reasons.length === 0) reasons.push(`task ${selectedTask.id} has no explicit refs; using domain defaults`);
  return reasons;
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
      ...(stringValue(task.roleRef) ? { roleRef: stringValue(task.roleRef) } : {}),
      ...(stringValue(task.agentProfileRef) ? { agentProfileRef: stringValue(task.agentProfileRef) } : {}),
      skillRefs: stringArray(task.skillRefs),
      mcpGrantRefs: stringArray(task.mcpGrantRefs),
      toolGrantRefs: stringArray(task.toolGrantRefs),
      vaultLeasePolicyRefs: stringArray(task.vaultLeasePolicyRefs),
    });
  }
  return tasks;
}

function selectTaskId(taskIds: string[], preferredTaskId?: string): string | undefined {
  if (preferredTaskId && taskIds.includes(preferredTaskId)) return preferredTaskId;
  return taskIds[0];
}

function normalizeDomain(value: string | undefined): string {
  return value && value.length > 0 ? value : "general";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
