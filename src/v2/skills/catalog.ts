import type { SkillCatalog, SkillSourceDefinition } from "./types.ts";

export function createStaticSkillCatalog(skills: SkillSourceDefinition[]): SkillCatalog {
  const byId = new Map(skills.map((skill) => [skill.skillId, skill]));
  return {
    resolve(skillId: string): SkillSourceDefinition {
      const skill = byId.get(skillId);
      if (!skill) {
        throw new Error(`unknown skill: ${skillId}`);
      }
      return skill;
    },
  };
}

export const builtInSkillCatalog = createStaticSkillCatalog([
  {
    skillId: "software.calc-cli",
    version: "2026-06-12",
    instructions: [
      "Use the repository's calc CLI conventions.",
      "Keep calculator behavior covered by focused tests.",
      "Prefer minimal changes in the CLI and calculation modules.",
      "Do not add runtime dependencies.",
      "Return artifact fields: summary, commandsRun, testResults, risks, followUpSuggestions.",
    ].join("\n"),
    allowedTools: ["shell", "edit"],
    requiredMounts: ["/workspace/repo"],
    mcpRequirements: [],
    artifactContracts: ["implementation-report"],
  },
]);
