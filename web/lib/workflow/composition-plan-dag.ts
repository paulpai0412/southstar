import type { WorkflowDag } from "./types.ts";

type WorkflowCompositionPlanTask = {
  id?: unknown;
  name?: unknown;
  dependsOn?: unknown;
  agentDefinitionRef?: unknown;
  agentProfileRef?: unknown;
};

type WorkflowCompositionPlanLike = {
  schemaVersion?: unknown;
  title?: unknown;
  selectedWorkflowTemplateRef?: unknown;
  tasks?: unknown;
};

export type WorkflowCompositionPlanDisplay = {
  dag: WorkflowDag;
  formattedText: string;
};

export function buildWorkflowDagFromCompositionPlanText(text: string): WorkflowDag | null {
  return buildWorkflowCompositionPlanDisplay(text)?.dag ?? null;
}

export function buildWorkflowCompositionPlanDisplay(text: string): WorkflowCompositionPlanDisplay | null {
  const parsed = parseJsonObject(text);
  if (!isWorkflowCompositionPlan(parsed)) return null;

  const tasks = parsed.tasks
    .filter(isWorkflowCompositionPlanTask)
    .map((task) => ({
      id: task.id,
      name: task.name,
      dependsOn: task.dependsOn,
      agentDefinitionRef: task.agentDefinitionRef,
      agentProfileRef: task.agentProfileRef,
    }));
  if (tasks.length === 0) return null;

  const levels = dependencyLevels(tasks);
  const dag: WorkflowDag = {
    id: `composition-${stableSlug(parsed.title)}`,
    mode: "draft",
    compositionPlan: parsed,
    ...(parsed.selectedWorkflowTemplateRef ? { templateId: parsed.selectedWorkflowTemplateRef } : {}),
    templateTitle: parsed.title,
    prompt: parsed.title,
    expandedByDefault: true,
    readiness: "ready",
    nodes: tasks.map((task, index) => {
      const profileRef = task.agentProfileRef || profileRefFromAgentDefinition(task.agentDefinitionRef);
      const role = roleFromRefs(task.agentDefinitionRef, profileRef);
      const provider = providerFromProfileRef(profileRef);
      return {
        id: task.id,
        taskId: task.id,
        mode: "draft",
        label: task.name || task.id,
        role,
        agentRef: task.agentDefinitionRef || `agent.${role}`,
        profileRef,
        profileResourcePath: `software/agents/${role}/profile.json`,
        provider,
        model: provider === "pi" ? "pi-agent-default" : "gpt-5-codex",
        level: levels.get(task.id) ?? index,
        state: "ready",
      };
    }),
    edges: tasks.flatMap((task) => task.dependsOn.map((dependency) => ({ from: dependency, to: task.id }))),
    createdAt: new Date().toISOString(),
  };
  return {
    dag,
    formattedText: `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``,
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        return null;
      }
    }
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function isWorkflowCompositionPlan(value: unknown): value is {
  title: string;
  selectedWorkflowTemplateRef?: string;
  tasks: WorkflowCompositionPlanTask[];
} {
  if (!value || typeof value !== "object") return false;
  const plan = value as WorkflowCompositionPlanLike;
  return plan.schemaVersion === "southstar.workflow_composition_plan.v1" &&
    typeof plan.title === "string" &&
    (plan.selectedWorkflowTemplateRef === undefined || typeof plan.selectedWorkflowTemplateRef === "string") &&
    Array.isArray(plan.tasks);
}

function isWorkflowCompositionPlanTask(value: unknown): value is {
  id: string;
  name: string;
  dependsOn: string[];
  agentDefinitionRef: string;
  agentProfileRef: string;
} {
  if (!value || typeof value !== "object") return false;
  const task = value as WorkflowCompositionPlanTask;
  return typeof task.id === "string" &&
    typeof task.name === "string" &&
    Array.isArray(task.dependsOn) &&
    task.dependsOn.every((dependency) => typeof dependency === "string") &&
    typeof task.agentDefinitionRef === "string" &&
    typeof task.agentProfileRef === "string";
}

function dependencyLevels(tasks: Array<{ id: string; dependsOn: string[] }>): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();

  const levelFor = (taskId: string): number => {
    const cached = levels.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) return 0;
    const task = byId.get(taskId);
    if (!task) return 0;
    visiting.add(taskId);
    const knownDependencies = task.dependsOn.filter((dependency) => byId.has(dependency));
    const level = knownDependencies.length === 0 ? 0 : Math.max(...knownDependencies.map(levelFor)) + 1;
    visiting.delete(taskId);
    levels.set(taskId, level);
    return level;
  };

  for (const task of tasks) levelFor(task.id);
  return levels;
}

function roleFromRefs(agentDefinitionRef: string, profileRef: string): string {
  const source = `${agentDefinitionRef} ${profileRef}`;
  if (source.includes("explorer")) return "explorer";
  if (source.includes("checker") || source.includes("reviewer")) return "checker";
  if (source.includes("summarizer")) return "summarizer";
  return "maker";
}

function providerFromProfileRef(profileRef: string): "pi" | "codex" {
  return profileRef.includes("-pi") ? "pi" : "codex";
}

function profileRefFromAgentDefinition(agentDefinitionRef: string): string {
  return `${agentDefinitionRef.replace(/^agent\./, "profile.")}-codex`;
}

function stableSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow";
}
