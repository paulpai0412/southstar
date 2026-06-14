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
      "Implement the user-facing command `calc sum <numbers...>` so the npm script invocation works exactly as `npm run -s cli -- sum 1 2 3` and prints `6`.",
      "Also verify `npm run -s cli -- sum -2 3.5 4` prints `5.5`, and `npm run -s cli -- sum 1 nope 3` exits non-zero with an invalid-input message naming `nope`.",
      "When using the npm script, process.argv.slice(2) starts with `sum`; Do not require a literal `calc` argument after `--`.",
      "README examples may describe the command as `calc sum <numbers...>`, but runnable npm examples must use `npm run -s cli -- sum <numbers...>`.",
      "README must document a positive sum example, a negative decimal example such as `npm run -s cli -- sum -2 3.5 4`, and an invalid-input example such as `npm run -s cli -- sum 1 nope 3`.",
      "Keep calculator behavior covered by focused tests.",
      "Prefer minimal changes in the CLI and calculation modules.",
      "Do not add runtime dependencies.",
      "Return artifact fields: summary, filesChanged, commandsRun, testResults, risks, artifactEvidence, followUpSuggestions.",
    ].join("\n"),
    allowedTools: ["shell", "edit"],
    requiredMounts: ["/workspace/repo"],
    mcpRequirements: [],
    artifactContracts: ["implementation-report"],
  },
]);
