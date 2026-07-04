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

export type SkillBundleFileSnapshot = {
  relativePath: string;
  contentBase64: string;
  contentHash: string;
};

export type ResolvedSkillSnapshot = SkillSourceDefinition & {
  contentHash: string;
  mountPath: string;
  sourcePath?: string;
  assetBundlePath?: string;
  bundleFiles?: SkillBundleFileSnapshot[];
};

export type SkillCatalog = {
  resolve(skillId: string): SkillSourceDefinition;
};
