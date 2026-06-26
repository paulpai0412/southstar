import type { SouthstarDb } from "../db/postgres.ts";
import { buildAgentLibraryReadModelPg } from "./agent-library.ts";

type ChatCapabilitiesInput = {
  domain?: string;
};

export type ChatCapabilitiesReadModel = {
  domain: string;
  modelList: Array<{
    id: string;
    modelId: string;
    provider: string;
    name: string;
    profileRefs: string[];
  }>;
  skillCommands: Array<{
    command: string;
    skill: string;
    description: string;
    profileRefs: string[];
  }>;
  toolPresets: Array<{
    id: string;
    label: string;
    allowedTools: string[];
    deniedTools: string[];
    requiresApprovalFor: string[];
    profileRefs: string[];
  }>;
  thinkingLevels: Array<"auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh">;
};

export async function buildChatCapabilitiesReadModelPg(
  db: SouthstarDb,
  input: ChatCapabilitiesInput,
): Promise<ChatCapabilitiesReadModel> {
  const library = await buildAgentLibraryReadModelPg(db, input);
  const modelList = [...modelsFromProfiles(library.agentProfiles).values()]
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId));
  const skillCommands = library.skills.map((skill) => ({
    command: skill.id,
    skill: skill.id,
    description: `Use ${skill.id} with ${skill.profileRefs.join(", ")}`,
    profileRefs: skill.profileRefs,
  }));
  const allToolPreset = buildDefaultToolPreset(library.agentProfiles);
  const profileToolPresets = library.agentProfiles
    .map((profile) => ({
      id: profile.id,
      label: profile.name,
      allowedTools: uniqueSorted(profile.toolPolicy.allowedTools),
      deniedTools: uniqueSorted(profile.toolPolicy.deniedTools),
      requiresApprovalFor: uniqueSorted(profile.toolPolicy.requiresApprovalFor),
      profileRefs: [profile.id],
    }))
    .filter((preset) => preset.allowedTools.length > 0);

  return {
    domain: library.domain,
    modelList,
    skillCommands,
    toolPresets: [allToolPreset, ...profileToolPresets],
    thinkingLevels: ["auto", "off", "minimal", "low", "medium", "high", "xhigh"],
  };
}

function modelsFromProfiles(
  profiles: Awaited<ReturnType<typeof buildAgentLibraryReadModelPg>>["agentProfiles"],
): Map<string, ChatCapabilitiesReadModel["modelList"][number]> {
  const byModel = new Map<string, ChatCapabilitiesReadModel["modelList"][number]>();
  for (const profile of profiles) {
    if (!profile.model) continue;
    const key = `${profile.provider}:${profile.model}`;
    const existing = byModel.get(key);
    if (existing) {
      existing.profileRefs.push(profile.id);
      existing.profileRefs.sort();
      continue;
    }
    byModel.set(key, {
      id: profile.model,
      modelId: profile.model,
      provider: profile.provider,
      name: `${profile.provider} ${profile.model}`,
      profileRefs: [profile.id],
    });
  }
  return byModel;
}

function buildDefaultToolPreset(
  profiles: Awaited<ReturnType<typeof buildAgentLibraryReadModelPg>>["agentProfiles"],
): ChatCapabilitiesReadModel["toolPresets"][number] {
  return {
    id: "default",
    label: "Default",
    allowedTools: uniqueSorted(profiles.flatMap((profile) => profile.toolPolicy.allowedTools)),
    deniedTools: uniqueSorted(profiles.flatMap((profile) => profile.toolPolicy.deniedTools)),
    requiresApprovalFor: uniqueSorted(profiles.flatMap((profile) => profile.toolPolicy.requiresApprovalFor)),
    profileRefs: profiles.map((profile) => profile.id).sort(),
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}
