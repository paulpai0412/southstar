import type {
  WorkflowCompositionTask,
  WorkflowNodePromptSpec,
} from "../design-library/types.ts";

export function classifyWorkflowCompositionTask(
  task: WorkflowCompositionTask,
): WorkflowNodePromptSpec["nodeType"] {
  if (task.nodePromptSpec) return task.nodePromptSpec.nodeType;

  const structuralType = inferStructuralNodeType(`${task.id} ${task.templateSlotRef}`.toLowerCase());
  if (structuralType !== "general") return structuralType;
  return inferStructuralNodeType(`${task.agentDefinitionRef} ${task.agentProfileRef}`.toLowerCase());
}

function inferStructuralNodeType(structuralRefs: string): WorkflowNodePromptSpec["nodeType"] {
  if (/\b(repair|fix)\b/.test(structuralRefs)) return "repair";
  if (/\b(reverify|verify|test|check|validation)\b/.test(structuralRefs)) return "verify";
  if (/\b(review|quality|risk)\b/.test(structuralRefs)) return "review";
  if (/\b(summary|summarize|completion|handoff)\b/.test(structuralRefs)) return "summary";
  if (/\b(plan|spec|understand|inspect|explore)\b/.test(structuralRefs)) return "plan";
  if (/\b(implement|build|code|create)\b/.test(structuralRefs)) return "implement";
  return "general";
}

export function isExplicitCoverageExceptionTask(task: WorkflowCompositionTask): boolean {
  if (task.nodePromptSpec?.nodeType === "summary") return true;
  if (task.nodePromptSpec?.nodeType !== "general") return false;
  return task.templateSlotRef === "coordination" || task.templateSlotRef.endsWith(".coordination");
}
