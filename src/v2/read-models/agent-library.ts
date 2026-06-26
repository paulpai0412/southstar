import type { SouthstarDb } from "../db/postgres.ts";
import { softwareVaultLeasePolicies } from "../design-library/software-library-seed.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import type { AgentProfile, RoleDefinition } from "../domain-packs/types.ts";

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
};

export type AgentLibraryReadModel = {
  domain: string;
  roles: RoleDefinition[];
  agentProfiles: AgentProfile[];
  skills: Array<{ id: string; profileRefs: string[] }>;
  mcpServers: Array<{ id: string; profileRefs: string[] }>;
  tools: Array<{ id: string; profileRefs: string[] }>;
  artifactContracts: typeof softwareDomainPack.artifactContracts;
  evaluatorPipelines: typeof softwareDomainPack.evaluatorPipelines;
  contextPolicies: typeof softwareDomainPack.contextPolicies;
  sessionPolicies: typeof softwareDomainPack.sessionPolicies;
  memoryPolicies: typeof softwareDomainPack.memoryPolicies;
  workspacePolicies: typeof softwareDomainPack.workspacePolicies;
  vaultLeasePolicies: typeof softwareVaultLeasePolicies;
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
  };
  alternatives: {
    roles: RoleDefinition[];
    agentProfiles: AgentProfile[];
    skills: Array<{ id: string; profileRefs: string[] }>;
    mcpServers: Array<{ id: string; profileRefs: string[] }>;
    tools: Array<{ id: string; profileRefs: string[] }>;
  };
  selectionReasons: string[];
};

export async function buildAgentLibraryReadModelPg(_db: SouthstarDb, input: AgentLibraryInput): Promise<AgentLibraryReadModel> {
  const domain = normalizeDomain(input.domain);
  const library = buildDomainLibrary(domain);
  return {
    domain,
    roles: library.roles,
    agentProfiles: library.agentProfiles,
    skills: library.skills,
    mcpServers: library.mcpServers,
    tools: library.tools,
    artifactContracts: softwareDomainPack.artifactContracts,
    evaluatorPipelines: softwareDomainPack.evaluatorPipelines,
    contextPolicies: softwareDomainPack.contextPolicies,
    sessionPolicies: softwareDomainPack.sessionPolicies,
    memoryPolicies: softwareDomainPack.memoryPolicies,
    workspacePolicies: softwareDomainPack.workspacePolicies,
    vaultLeasePolicies: softwareVaultLeasePolicies,
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
  const library = buildDomainLibrary(domain);
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
    },
    alternatives: {
      roles: library.roles,
      agentProfiles: alternativeProfiles,
      skills: library.skills,
      mcpServers: library.mcpServers,
      tools: library.tools,
    },
    selectionReasons,
  };
}

function buildDomainLibrary(domain: string): {
  roles: RoleDefinition[];
  agentProfiles: AgentProfile[];
  skills: Array<{ id: string; profileRefs: string[] }>;
  mcpServers: Array<{ id: string; profileRefs: string[] }>;
  tools: Array<{ id: string; profileRefs: string[] }>;
} {
  if (domain !== "software") {
    throw new Error(`unsupported domain pack for agent library: ${domain}`);
  }
  return {
    roles: softwareDomainPack.roles,
    agentProfiles: softwareDomainPack.agentProfiles,
    skills: uniqueRefRows(softwareDomainPack.agentProfiles, (profile) => profile.skillRefs),
    mcpServers: uniqueRefRows(softwareDomainPack.agentProfiles, (profile) => profile.mcpGrantRefs),
    tools: uniqueRefRows(softwareDomainPack.agentProfiles, (profile) => profile.toolPolicy.allowedTools),
  };
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
    });
  }
  return tasks;
}

function selectTaskId(taskIds: string[], preferredTaskId?: string): string | undefined {
  if (preferredTaskId && taskIds.includes(preferredTaskId)) return preferredTaskId;
  return taskIds[0];
}

function normalizeDomain(value: string | undefined): string {
  return value && value.length > 0 ? value : "software";
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
