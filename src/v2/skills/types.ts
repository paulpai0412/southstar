export type SkillSourceDefinition = {
  skillId: string;
  version: string;
  instructions: string;
  allowedTools: string[];
  requiredMounts: string[];
  mcpRequirements: string[];
  artifactContracts: string[];
};

export type ResolvedSkillSnapshot = SkillSourceDefinition & {
  contentHash: string;
  mountPath: string;
};

export type SkillCatalog = {
  resolve(skillId: string): SkillSourceDefinition;
};
