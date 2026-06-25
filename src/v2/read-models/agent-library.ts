import type { SouthstarDb } from "../db/postgres.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import { getResourceByKeyPg } from "../stores/postgres-runtime-store.ts";

export async function buildAgentLibraryReadModelPg(_db: SouthstarDb, input: { domain?: string }) {
  const domain = input.domain ?? "software";
  if (domain !== "software") throw new Error(`unsupported agent library domain: ${domain}`);
  const skills = uniqueStrings(softwareDomainPack.agentProfiles.flatMap((profile) => profile.skillRefs));
  const mcpServers = uniqueStrings(softwareDomainPack.agentProfiles.flatMap((profile) => profile.mcpGrantRefs));
  const tools = uniqueStrings(softwareDomainPack.agentProfiles.flatMap((profile) => profile.toolPolicy.allowedTools));
  return {
    domain,
    roles: softwareDomainPack.roles,
    agentProfiles: softwareDomainPack.agentProfiles,
    skills: skills.map((id) => ({ id })),
    mcpServers: mcpServers.map((id) => ({ id })),
    tools: tools.map((id) => ({ id })),
    artifactContracts: softwareDomainPack.artifactContracts,
    evaluatorPipelines: softwareDomainPack.evaluatorPipelines,
    policies: {
      context: softwareDomainPack.contextPolicies,
      memory: softwareDomainPack.memoryPolicies,
      vault: [],
    },
  };
}

export async function buildAgentLibraryCandidatesReadModelPg(db: SouthstarDb, input: { draftId: string; taskId?: string }) {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
  const workflow = asRecord(asRecord(draft.payload).workflow);
  const tasks = arrayRecords(workflow.tasks);
  const task = input.taskId ? tasks.find((candidate) => candidate.id === input.taskId) : tasks[0];
  if (!task) throw new Error(`task not found for draft ${input.draftId}`);
  const library = await buildAgentLibraryReadModelPg(db, { domain: "software" });
  return {
    draftId: input.draftId,
    taskId: String(task.id),
    selectedRefs: {
      roleRef: stringValue(task.roleRef),
      agentProfileRef: stringValue(task.agentProfileRef),
      skillRefs: stringArray(task.skillRefs),
      mcpGrantRefs: stringArray(task.mcpGrantRefs),
      toolRefs: stringArray(task.toolRefs),
    },
    alternatives: {
      roles: library.roles,
      agentProfiles: library.agentProfiles,
      skills: library.skills,
      mcpServers: library.mcpServers,
      tools: library.tools,
    },
    selectionReasons: [
      "Selected refs come from the current planner draft task.",
      "Alternatives come from the active software domain pack.",
    ],
    validationWarnings: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}
