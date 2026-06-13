import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AnyTaskEnvelope } from "./task-envelope.ts";

export type TaskMaterializerOptions = {
  runRoot?: string;
};

export type TaskMaterialization = {
  taskDir: string;
  envelopePath: string;
};

const DEFAULT_RUN_ROOT = "/tmp/southstar-runs";

export async function materializeTaskEnvelope(
  envelope: AnyTaskEnvelope,
  options: TaskMaterializerOptions = {},
): Promise<TaskMaterialization> {
  const runRoot = options.runRoot ?? DEFAULT_RUN_ROOT;
  const runDir = resolveChildDir(runRoot, envelope.runId, "run id");
  const taskDir = resolveChildDir(runDir, envelope.schemaVersion === "southstar.task-envelope.v2" ? envelope.taskId : envelope.task.id, "task id");
  const envelopePath = join(taskDir, "envelope.json");
  await mkdir(taskDir, { recursive: true });
  await writeFile(envelopePath, JSON.stringify(envelope, null, 2));
  if (envelope.schemaVersion === "southstar.task-envelope.v2") {
    await writeFile(join(taskDir, "context-packet.json"), JSON.stringify(envelope.contextPacket, null, 2));
  }
  const skillsRoot = join(taskDir, "skills");
  for (const skill of envelope.skills ?? []) {
    const skillDir = resolveSkillDir(skillsRoot, skill.skillId);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), skill.instructions);
    await writeFile(join(skillDir, "skill.json"), JSON.stringify(skill, null, 2));
  }
  return { taskDir, envelopePath };
}

export async function cleanupTaskMaterialization(materialization: TaskMaterialization): Promise<void> {
  await rm(materialization.taskDir, { recursive: true, force: true });
}

function resolveSkillDir(skillsRoot: string, skillId: string): string {
  return resolveChildDir(skillsRoot, skillId, "skill id");
}

function resolveChildDir(parentDir: string, childName: string, label: string): string {
  if (!childName || childName.includes("\0")) {
    throw new Error(`invalid ${label}: ${childName}`);
  }
  const root = resolve(parentDir);
  const target = resolve(root, childName);
  const relativeTarget = relative(root, target);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`invalid ${label}: ${childName}`);
  }
  return target;
}
