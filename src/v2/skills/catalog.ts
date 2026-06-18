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

const softwareEngineeringSkillIds = [
  "software.repo-inspection",
  "software.minimal-patch",
  "software.test-evidence",
  "software.bug-reproduction",
  "software.regression-check",
  "software.refactor-safety",
  "software.docs-update",
  "software.code-review",
  "software.spec-alignment-skill",
  "software.browser-qa-skill",
  "software.commit-curation",
  "software.merge-readiness",
  "software.merge-operation",
  "software.release-reporting",
  "software.completion-report",
];

const softwareEngineeringSkills: SkillSourceDefinition[] = softwareEngineeringSkillIds.map((skillId) => ({
  skillId,
  version: "2026-06-16",
  instructions: [
    `Use ${skillId} discipline for this Southstar task.`,
    "Follow the task's ContextPacket, artifact contracts, selected MCP/tool grants, and forbidden actions.",
    "Return structured artifact evidence with summary, evidence, and risks fields unless the task contract requires stricter fields.",
    "Do not assume this skill is baked into the Docker image; it is delivered through the task envelope.",
  ].join("\n"),
  allowedTools: ["read", "search", "shell", "edit"],
  requiredMounts: ["/workspace/repo"],
  mcpRequirements: [],
  artifactContracts: [],
}));

export const builtInSkillCatalog = createStaticSkillCatalog([
  ...softwareEngineeringSkills,
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
