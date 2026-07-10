import type { SouthstarDb } from "../db/postgres.ts";
import type { AgentProvider, PlannerDraftTaskProfileOverride } from "../design-library/runtime-types.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

const allowedProviders = new Set<AgentProvider>(["pi", "codex", "claude-code", "openai", "openai-codex", "anthropic", "custom"]);

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

  const profileOverride = normalizeProfileOverride(input.profileOverride);
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

function normalizeProfileOverride(input: PlannerDraftTaskProfileOverride): PlannerDraftTaskProfileOverride {
  const output: PlannerDraftTaskProfileOverride = {};
  if (input.harnessRef !== undefined) output.harnessRef = nonEmptyString(input.harnessRef, "harnessRef");
  if (input.provider !== undefined) {
    if (!allowedProviders.has(input.provider)) throw new Error(`unsupported provider: ${input.provider}`);
    output.provider = input.provider;
  }
  if (input.model !== undefined) output.model = nonEmptyString(input.model, "model");
  if (input.thinkingLevel !== undefined) output.thinkingLevel = nonEmptyString(input.thinkingLevel, "thinkingLevel");
  if (input.instruction !== undefined) output.instruction = input.instruction.trim();
  if (input.skillRefs !== undefined) output.skillRefs = stringArray(input.skillRefs, "skillRefs");
  if (input.mcpGrantRefs !== undefined) output.mcpGrantRefs = stringArray(input.mcpGrantRefs, "mcpGrantRefs");
  if (input.toolGrantRefs !== undefined) output.toolGrantRefs = stringArray(input.toolGrantRefs, "toolGrantRefs");
  if (input.vaultLeasePolicyRefs !== undefined) output.vaultLeasePolicyRefs = stringArray(input.vaultLeasePolicyRefs, "vaultLeasePolicyRefs");
  if (input.nodePromptSpec !== undefined) output.nodePromptSpec = objectValue(input.nodePromptSpec, "nodePromptSpec");
  return output;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
