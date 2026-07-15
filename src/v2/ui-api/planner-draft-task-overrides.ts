import type { SouthstarDb } from "../db/postgres.ts";
import type { PlannerDraftTaskProfileOverride } from "../design-library/runtime-types.ts";
import { normalizeAgentProfileOverride } from "../design-library/profile-composer/profile-contract.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export type PatchPlannerDraftTaskProfileOverrideInput = {
  draftId: string;
  taskId: string;
  profileOverride: PlannerDraftTaskProfileOverride;
};

export type PatchPlannerDraftTaskProfileOverrideResult = {
  draftId: string;
  taskId: string;
  status: string;
  profileOverride: PlannerDraftTaskProfileOverride;
};

export async function patchPlannerDraftTaskProfileOverridePg(
  db: SouthstarDb,
  input: PatchPlannerDraftTaskProfileOverrideInput,
): Promise<PatchPlannerDraftTaskProfileOverrideResult> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);

  const payload = asRecord(draft.payload);
  const workflow = asRecord(payload.workflow);
  const tasks = Array.isArray(workflow.tasks) ? workflow.tasks.map((task) => asRecord(task)) : [];
  const taskIndex = tasks.findIndex((task) => task.id === input.taskId);
  if (taskIndex < 0) throw new Error(`planner draft task not found: ${input.taskId}`);

  const profileOverride = normalizeAgentProfileOverride(input.profileOverride);
  const currentTask = tasks[taskIndex] ?? {};
  const nextTask = {
    ...currentTask,
    profileOverride,
    ...(profileOverride.skillRefs !== undefined ? { skillRefs: profileOverride.skillRefs } : {}),
    ...(profileOverride.mcpGrantRefs !== undefined ? { mcpGrantRefs: profileOverride.mcpGrantRefs } : {}),
    ...(profileOverride.toolGrantRefs !== undefined ? { toolGrantRefs: profileOverride.toolGrantRefs } : {}),
    ...(profileOverride.vaultLeasePolicyRefs !== undefined ? { vaultLeasePolicyRefs: profileOverride.vaultLeasePolicyRefs } : {}),
    ...(profileOverride.nodePromptSpec !== undefined
      ? { promptInputs: { ...asRecord(currentTask.promptInputs), nodePromptSpec: profileOverride.nodePromptSpec } }
      : {}),
  };
  const nextTasks = [...tasks];
  nextTasks[taskIndex] = nextTask;

  await upsertRuntimeResourcePg(db, {
    id: draft.id,
    resourceType: "planner_draft",
    resourceKey: input.draftId,
    ...(draft.runId ? { runId: draft.runId } : {}),
    ...(draft.taskId ? { taskId: draft.taskId } : {}),
    ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
    scope: draft.scope,
    status: draft.status,
    ...(draft.title ? { title: draft.title } : {}),
    payload: {
      ...payload,
      workflow: {
        ...workflow,
        tasks: nextTasks,
      },
    },
    summary: draft.summary,
    metrics: draft.metrics,
    ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}),
  });

  return {
    draftId: input.draftId,
    taskId: input.taskId,
    status: draft.status,
    profileOverride,
  };
}


function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
