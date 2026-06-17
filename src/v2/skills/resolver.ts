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
  const skills = expandSkills(input.skillRefs, catalog);

  return skills.map((skill) => {
    const snapshot = toSnapshot(skill);
    upsertRuntimeResource(db, {
      resourceType: "skill_snapshot",
      resourceKey: `${input.runId}:${input.taskId}:${skill.skillId}`,
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

function expandSkills(skillRefs: string[], catalog: SkillCatalog): SkillSourceDefinition[] {
  const expanded: SkillSourceDefinition[] = [];
  const emitted = new Set<string>();
  const visiting: string[] = [];

  const visit = (skillRef: string) => {
    if (emitted.has(skillRef)) return;
    if (visiting.includes(skillRef)) {
      throw new Error(`skill base dependency cycle: ${[...visiting, skillRef].join(" -> ")}`);
    }

    visiting.push(skillRef);
    const skill = catalog.resolve(skillRef);
    for (const baseRef of skill.baseSkillRefs ?? []) {
      visit(baseRef);
    }
    visiting.pop();

    if (!emitted.has(skill.skillId)) {
      expanded.push(skill);
      emitted.add(skill.skillId);
    }
  };

  for (const skillRef of skillRefs) {
    visit(skillRef);
  }

  return expanded;
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
