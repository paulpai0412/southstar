import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskEnvelope } from "./task-envelope.ts";

export type TaskMaterializerOptions = {
  runRoot?: string;
};

export type TaskMaterialization = {
  taskDir: string;
  envelopePath: string;
};

const DEFAULT_RUN_ROOT = "/tmp/southstar-runs";

export async function materializeTaskEnvelope(
  envelope: TaskEnvelope,
  options: TaskMaterializerOptions = {},
): Promise<TaskMaterialization> {
  const runRoot = options.runRoot ?? DEFAULT_RUN_ROOT;
  const taskDir = join(runRoot, envelope.runId, envelope.task.id);
  const envelopePath = join(taskDir, "envelope.json");
  await mkdir(taskDir, { recursive: true });
  await writeFile(envelopePath, JSON.stringify(envelope, null, 2));
  return { taskDir, envelopePath };
}

export async function cleanupTaskMaterialization(materialization: TaskMaterialization): Promise<void> {
  await rm(materialization.taskDir, { recursive: true, force: true });
}
