import { createHash } from "node:crypto";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { builtInSkillCatalog } from "./catalog.ts";
import type { ResolvedSkillSnapshot, SkillCatalog, SkillSourceDefinition } from "./types.ts";

export type ResolveSkillSnapshotsInput = {
  runId: string;
  taskId: string;
  skillRefs: string[];
  catalog?: SkillCatalog;
};

export function resolveSkillSnapshots(db: SouthstarDb, input: ResolveSkillSnapshotsInput): ResolvedSkillSnapshot[] {
  const catalog = input.catalog ?? builtInSkillCatalog;
  return input.skillRefs.map((skillRef) => {
    const skill = catalog.resolve(skillRef);
    const snapshot = toSnapshot(skill);
    upsertRuntimeResource(db, {
      resourceType: "skill_snapshot",
      resourceKey: `${input.runId}:${input.taskId}:${skillRef}`,
      runId: input.runId,
      taskId: input.taskId,
      scope: "task",
      status: "resolved",
      title: skill.skillId,
      payload: snapshot,
      summary: {
        version: snapshot.version,
        contentHash: snapshot.contentHash,
      },
    });
    return snapshot;
  });
}

function toSnapshot(skill: SkillSourceDefinition): ResolvedSkillSnapshot {
  const contentHash = createHash("sha256")
    .update(JSON.stringify(skill))
    .digest("hex");
  return {
    ...skill,
    contentHash,
    mountPath: `/southstar/skills/${skill.skillId}`,
  };
}
