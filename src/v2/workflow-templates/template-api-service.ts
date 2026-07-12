import type { SouthstarDb } from "../db/postgres.ts";
import { Buffer } from "node:buffer";
import type { WorkflowCompositionPlan } from "../design-library/types.ts";
import {
  findApprovedLibraryObjectsByKind,
  findLibraryObjectByKey,
  type LibraryObjectSummary,
} from "../design-library/library-graph-store.ts";
import type { WorkflowTaskDefinition } from "../manifests/types.ts";
import { parseWorkflowCompositionPlanFromText } from "../orchestration/llm-composer.ts";
import { getResourceByKeyPg } from "../stores/postgres-runtime-store.ts";
import {
  type PlannerDraftValidationIssue,
} from "../ui-api/postgres-run-api.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import type { WorkflowTemplatePolicyV1 } from "../orchestration/goal-design.ts";
import type { RunGoalRequest, RunGoalResult } from "../orchestration/run-goal-service.ts";

export type WorkflowTemplateSearchInput = {
  prompt: string;
  domain?: string;
  limit?: number;
};

export type WorkflowTemplateSearchResult = {
  templates: WorkflowTemplateSummary[];
};

export type WorkflowTemplateSummary = {
  templateRef: string;
  title: string;
  description?: string;
  status: string;
  score: number;
  nodeCount: number;
  nodeTypes: string[];
  versionRef?: string;
};

export type WorkflowTemplateDetailInput = {
  templateRef: string;
};

export type WorkflowTemplateDetail = WorkflowTemplateSummary & {
  nodes: WorkflowTemplateNodeSummary[];
  edges: WorkflowTemplateEdgeSummary[];
  canInstantiate: boolean;
  validationIssues: PlannerDraftValidationIssue[];
};

export type WorkflowTemplateNodeSummary = {
  id: string;
  title?: string;
  nodeType?: string;
};

export type WorkflowTemplateEdgeSummary = {
  from: string;
  to: string;
};

export type InstantiateWorkflowTemplateInput = {
  templateRef: string;
  goalPrompt: string;
  cwd?: string;
  repo?: {
    path?: string;
    url?: string;
    branch?: string;
  };
  constraints?: {
    mode?: "strict" | "adaptive";
    maxNodes?: number;
    requireApproval?: boolean;
  };
  idempotencyKey?: string;
  submitGoal: (request: RunGoalRequest) => Promise<RunGoalResult>;
};

export type InstantiateWorkflowTemplateResult = {
  templateRef: string;
  draftId: string;
  workflowId: string;
  status: string;
  validationIssues: PlannerDraftValidationIssue[];
  nodes: WorkflowTemplateInstanceNode[];
};

export type WorkflowTemplateInstanceNode = {
  taskId: string;
  nodeType?: string;
  nodePromptSpec?: unknown;
  agentProfileRef?: string;
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
};

export async function searchWorkflowTemplatesPg(
  db: SouthstarDb,
  input: WorkflowTemplateSearchInput,
): Promise<WorkflowTemplateSearchResult> {
  const templates = await findApprovedLibraryObjectsByKind(db, "workflow_template", input.domain);
  const queryTokens = tokenize(input.prompt);
  const ranked = templates
    .map((template) => summaryFromLibraryObject(template, scoreTemplate(template, queryTokens)))
    .sort((a, b) => b.score - a.score || a.templateRef.localeCompare(b.templateRef))
    .slice(0, Math.max(1, input.limit ?? 10));
  return { templates: ranked };
}

export async function getWorkflowTemplateDetailPg(
  db: SouthstarDb,
  input: WorkflowTemplateDetailInput,
): Promise<WorkflowTemplateDetail> {
  const template = await requireApprovedWorkflowTemplate(db, input.templateRef);
  return detailFromLibraryObject(template);
}

export async function instantiateWorkflowTemplatePg(
  db: SouthstarDb,
  input: InstantiateWorkflowTemplateInput,
): Promise<InstantiateWorkflowTemplateResult> {
  const template = await requireApprovedWorkflowTemplate(db, input.templateRef);
  if (!template.headVersionId) throw new Error(`workflow template is missing head version: ${input.templateRef}`);
  const templatePolicy: WorkflowTemplatePolicyV1 = input.constraints?.mode === "strict"
    ? { mode: "require", templateRef: template.objectKey, versionRef: template.headVersionId }
    : { mode: "prefer", templateRef: template.objectKey, versionRef: template.headVersionId };
  const submitted = await input.submitGoal({
    goalPrompt: input.goalPrompt,
    cwd: input.cwd ?? process.cwd(),
    idempotencyKey: input.idempotencyKey ?? workflowTemplateInstantiationKey(input, template.headVersionId),
    templatePolicy,
  });
  const persistedDraft = await getResourceByKeyPg(db, "planner_draft", submitted.draftId);
  const payload = asRecord(persistedDraft?.payload);
  const workflow = asRecord(payload.workflow);
  const tasks = Array.isArray(workflow.tasks) ? workflow.tasks : [];

  return {
    templateRef: input.templateRef,
    draftId: submitted.draftId,
    workflowId: stringValue(workflow.workflowId) ?? "",
    status: submitted.draftStatus,
    validationIssues: plannerDraftValidationIssues(payload.validationIssues),
    nodes: tasks.map((task) => instanceNodeFromTask(asWorkflowTask(task))),
  };
}

function requireApprovedWorkflowTemplate(db: SouthstarDb, templateRef: string): Promise<LibraryObjectSummary> {
  return findLibraryObjectByKey(db, templateRef).then((template) => {
    if (!template) throw new Error(`workflow template not found: ${templateRef}`);
    if (template.objectKind !== "workflow_template") throw new Error(`library object is not a workflow template: ${templateRef}`);
    if (template.status !== "approved") throw new Error(`workflow template is not approved: ${templateRef}`);
    return template;
  });
}

function summaryFromLibraryObject(template: LibraryObjectSummary, score: number): WorkflowTemplateSummary {
  const detail = templateShape(template.state);
  return {
    templateRef: template.objectKey,
    title: detail.title ?? template.objectKey,
    ...(detail.description ? { description: detail.description } : {}),
    status: template.status,
    score,
    nodeCount: detail.nodes.length,
    nodeTypes: unique(detail.nodes.map((node) => node.nodeType).filter(isNonEmptyString)),
    ...(template.headVersionId ? { versionRef: template.headVersionId } : {}),
  };
}

function detailFromLibraryObject(template: LibraryObjectSummary): WorkflowTemplateDetail {
  const detail = templateShape(template.state);
  const validationIssues = templateValidationIssues(detail, template.state);
  return {
    ...summaryFromLibraryObject(template, 1),
    nodes: detail.nodes,
    edges: detail.edges,
    canInstantiate: validationIssues.length === 0,
    validationIssues,
  };
}

function templateValidationIssues(
  detail: ReturnType<typeof templateShape>,
  state: Record<string, unknown>,
): PlannerDraftValidationIssue[] {
  if (detail.nodes.length > 0) return [];
  if (workflowCompositionPlanValue(state.compositionPlan)) return [];
  if (workflowCompositionPlanBase64Value(state.compositionPlanJsonBase64)) return [];
  return [{
    path: "state.nodes",
    code: "workflow_template_empty",
    message: "workflow template must define nodes or compositionPlan before it can be instantiated",
  }];
}

function templateShape(state: Record<string, unknown>): {
  title?: string;
  description?: string;
  nodes: WorkflowTemplateNodeSummary[];
  edges: WorkflowTemplateEdgeSummary[];
} {
  const flow = asRecord(state.flow);
  const sourceNodes = Array.isArray(state.nodes) ? state.nodes : Array.isArray(flow.nodes) ? flow.nodes : [];
  const sourceEdges = Array.isArray(state.edges) ? state.edges : Array.isArray(flow.edges) ? flow.edges : [];
  return {
    ...(isNonEmptyString(state.title) ? { title: state.title } : {}),
    ...(isNonEmptyString(state.description) ? { description: state.description } : {}),
    nodes: sourceNodes.map((node) => {
      const record = asRecord(node);
      return {
        id: stringValue(record.id) ?? "",
        ...(stringValue(record.title) ?? stringValue(record.name) ? { title: stringValue(record.title) ?? stringValue(record.name) } : {}),
        ...(stringValue(record.nodeType) ? { nodeType: stringValue(record.nodeType) } : {}),
      };
    }).filter((node) => node.id.length > 0),
    edges: sourceEdges.map((edge) => {
      const record = asRecord(edge);
      return {
        from: stringValue(record.from) ?? "",
        to: stringValue(record.to) ?? "",
      };
    }).filter((edge) => edge.from.length > 0 && edge.to.length > 0),
  };
}

function instanceNodeFromTask(task: WorkflowTaskDefinition): WorkflowTemplateInstanceNode {
  const promptInputs = asRecord(task.promptInputs);
  return {
    taskId: task.id,
    ...(stringValue(asRecord(promptInputs.nodePromptSpec).nodeType) ? { nodeType: stringValue(asRecord(promptInputs.nodePromptSpec).nodeType) } : {}),
    ...(promptInputs.nodePromptSpec !== undefined ? { nodePromptSpec: promptInputs.nodePromptSpec } : {}),
    ...(task.agentProfileRef ? { agentProfileRef: task.agentProfileRef } : {}),
    skillRefs: [...(task.skillRefs ?? [])],
    toolGrantRefs: [...(task.toolGrantRefs ?? [])],
    mcpGrantRefs: [...(task.mcpGrantRefs ?? [])],
  };
}

function workflowTemplateInstantiationKey(
  input: InstantiateWorkflowTemplateInput,
  versionRef: string,
): string {
  return `workflow-template:${contentHashForPayload({
    templateRef: input.templateRef,
    versionRef,
    goalPrompt: input.goalPrompt,
    cwd: input.cwd ?? process.cwd(),
    mode: input.constraints?.mode ?? "adaptive",
  }).slice(0, 24)}`;
}

function plannerDraftValidationIssues(value: unknown): PlannerDraftValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.map((issue) => {
    const record = asRecord(issue);
    return {
      path: stringValue(record.path) ?? "",
      message: stringValue(record.message) ?? "",
      ...(stringValue(record.code) ? { code: stringValue(record.code) } : {}),
    };
  });
}

function scoreTemplate(template: LibraryObjectSummary, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const detail = templateShape(template.state);
  const haystackTokens = tokenize([
    template.objectKey,
    detail.title ?? "",
    detail.description ?? "",
    detail.nodes.map((node) => `${node.title ?? ""} ${node.nodeType ?? ""}`).join(" "),
  ].join(" "));
  let score = 0;
  for (const token of queryTokens) {
    if (haystackTokens.has(token)) score += 1;
  }
  return score / queryTokens.size;
}

function workflowCompositionPlanValue(value: unknown): WorkflowCompositionPlan | undefined {
  try {
    const text = JSON.stringify(value);
    if (!text) return undefined;
    return parseWorkflowCompositionPlanFromText(text, 1_000_000);
  } catch {
    return undefined;
  }
}

function workflowCompositionPlanBase64Value(value: unknown): WorkflowCompositionPlan | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return workflowCompositionPlanValue(JSON.parse(Buffer.from(value, "base64").toString("utf8")));
  } catch {
    return undefined;
  }
}

function asWorkflowTask(value: unknown): WorkflowTaskDefinition {
  return asRecord(value) as unknown as WorkflowTaskDefinition;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9._-]+/g).filter((token) => token.length > 1));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
