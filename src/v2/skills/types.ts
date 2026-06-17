import type { SkillFieldGuidance, SkillRepairGuidance } from "../design-library/types.ts";

export type SkillSourceDefinition = {
  skillId: string;
  version: string;
  instructions: string;
  allowedTools: string[];
  requiredMounts: string[];
  mcpRequirements: string[];
  artifactContracts: string[];
  baseSkillRefs?: string[];
  fieldGuidance?: Record<string, SkillFieldGuidance>;
  repairGuidance?: SkillRepairGuidance;
};

export type ResolvedSkillSnapshot = SkillSourceDefinition & {
  contentHash: string;
  mountPath: string;
};

export type SkillCatalog = {
  resolve(skillId: string): SkillSourceDefinition;
};
