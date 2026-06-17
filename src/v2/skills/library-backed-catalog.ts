import type { SouthstarDb } from "../stores/sqlite.ts";
import { findLibraryObjectByKey, getLibraryVersion } from "../design-library/store.ts";
import type { SkillSpecPayload } from "../design-library/types.ts";
import { builtInSkillCatalog } from "./catalog.ts";
import type { SkillCatalog, SkillSourceDefinition } from "./types.ts";

export function createLibraryBackedSkillCatalog(db: SouthstarDb, fallbackCatalog: SkillCatalog = builtInSkillCatalog): SkillCatalog {
  return {
    resolve(skillId: string): SkillSourceDefinition {
      const object = findLibraryObjectByKey(db, skillId);
      if (!object) {
        return fallbackCatalog.resolve(skillId);
      }
      if (object.objectKind !== "skill_spec") {
        throw new Error(`library object ${skillId} is not skill_spec`);
      }
      if (!object.headVersionId) {
        throw new Error(`skill ${skillId} has no head version`);
      }
      const version = getLibraryVersion(db, object.headVersionId);
      if (!version) {
        throw new Error(`skill ${skillId} head version not found: ${object.headVersionId}`);
      }
      if (version.definitionKind !== "skill_spec") {
        throw new Error(`skill ${skillId} version kind mismatch: ${version.definitionKind}`);
      }
      const payload = version.payload as SkillSpecPayload;
      return {
        skillId,
        version: version.versionId,
        instructions: payload.instructions.content,
        allowedTools: payload.allowedTools,
        requiredMounts: payload.requiredMounts,
        mcpRequirements: payload.mcpRequirements,
        artifactContracts: payload.contractRefs ?? [],
        baseSkillRefs: payload.baseSkillRef ? [payload.baseSkillRef] : [],
        fieldGuidance: payload.fieldGuidance,
        repairGuidance: payload.repairGuidance,
      };
    },
  };
}
