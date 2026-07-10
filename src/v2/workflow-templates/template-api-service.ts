import type { SouthstarDb } from "../db/postgres.ts";
import { Buffer } from "node:buffer";
import type { WorkflowCompositionPlan } from "../design-library/types.ts";
import {
  findApprovedLibraryObjectsByKind,
  findLibraryObjectByKey,
  type LibraryObjectSummary,
} from "../design-library/library-graph-store.ts";
import type { WorkflowTaskDefinition } from "../manifests/types.ts";
import { runCompositionRepairLoop } from "../orchestration/composition-repair-loop.ts";
import { parseWorkflowCompositionPlanFromText } from "../orchestration/llm-composer.ts";
import { isCoverageExceptionTask } from "../orchestration/goal-requirement-coverage.ts";
import { getResourceByKeyPg } from "../stores/postgres-runtime-store.ts";
import {
  createPostgresPlannerDraft,
  type PlannerDraftProgressListener,
  type PlannerDraftValidationIssue,
} from "../ui-api/postgres-run-api.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import { resolveWorkflowCandidates } from "../orchestration/candidate-resolver.ts";
import {
  requirementSpecFromGoalContract,
  type GoalContractInterpreter,
  type GoalContractV1,
} from "../orchestration/goal-contract.ts";

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
  goalInterpreter: GoalContractInterpreter;
  composer?: WorkflowComposer;
  onProgress?: PlannerDraftProgressListener;
  onGoalContractDelta?: (text: string) => void;
  onLlmDelta?: (text: string) => void;
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
  const state = template.state;
  const goalInterpreter = memoizeGoalInterpreter(input.goalInterpreter);
  const goalContract = await goalInterpreter.interpret({
    goalPrompt: input.goalPrompt,
    cwd: input.cwd ?? process.cwd(),
    onDelta: input.onGoalContractDelta,
  });
  let compositionPlan: WorkflowCompositionPlan | undefined;
  if (goalContract.blockingInputs.length === 0) {
    await assertTemplateScopeCompatible(db, input.templateRef, goalContract.domain);
    const hasSavedCompositionPlan = state.compositionPlan !== undefined
      || (typeof state.compositionPlanJsonBase64 === "string" && state.compositionPlanJsonBase64.length > 0);
    const savedCompositionPlan = workflowCompositionPlanValue(state.compositionPlan)
      ?? workflowCompositionPlanBase64Value(state.compositionPlanJsonBase64);
    if (savedCompositionPlan) {
      try {
        compositionPlan = instantiateSavedCompositionPlan(savedCompositionPlan, input, goalContract);
      } catch (error) {
        if (!input.composer) {
          throw new Error(`saved workflow composition needs regeneration: ${errorMessage(error)}`);
        }
        compositionPlan = await composeSkeletonTemplate(db, input, template, goalContract);
      }
    } else if (hasSavedCompositionPlan && !input.composer) {
      throw new Error("saved workflow composition needs regeneration: stored composition does not match the current strict schema");
    } else {
      compositionPlan = await composeSkeletonTemplate(db, input, template, goalContract);
    }
  }

  input.onProgress?.(compositionPlan
    ? { stage: "template.loaded", message: "Workflow template composition loaded." }
    : { stage: "template.blocked", message: "Workflow template is waiting for required Goal Contract input." });
  const draft = await createPostgresPlannerDraft(db, {
    goalPrompt: input.goalPrompt,
    orchestrationMode: "llm-constrained",
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(compositionPlan ? { compositionPlan } : {}),
    goalInterpreter,
    composer: input.composer,
    onProgress: input.onProgress,
    onGoalContractDelta: input.onGoalContractDelta,
    onLlmDelta: input.onLlmDelta,
  });
  const persistedDraft = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
  const payload = asRecord(persistedDraft?.payload);
  const workflow = asRecord(payload.workflow);
  const tasks = Array.isArray(workflow.tasks) ? workflow.tasks : [];

  return {
    templateRef: input.templateRef,
    draftId: draft.draftId,
    workflowId: draft.workflowId,
    status: draft.status,
    validationIssues: draft.validationIssues,
    nodes: tasks.map((task) => instanceNodeFromTask(asWorkflowTask(task))),
  };
}

async function assertTemplateScopeCompatible(
  db: SouthstarDb,
  templateRef: string,
  domain: string,
): Promise<void> {
  const visibleTemplates = await findApprovedLibraryObjectsByKind(db, "workflow_template", domain);
  if (visibleTemplates.some((template) => template.objectKey === templateRef)) return;
  throw new Error(`workflow template ${templateRef} is not compatible with Goal Contract domain ${domain}`);
}

async function composeSkeletonTemplate(
  db: SouthstarDb,
  input: InstantiateWorkflowTemplateInput,
  template: LibraryObjectSummary,
  goalContract: GoalContractV1,
): Promise<WorkflowCompositionPlan> {
  if (!input.composer) {
    throw new Error(`workflow template requires a composer when compositionPlan is missing: ${input.templateRef}`);
  }
  const detail = detailFromLibraryObject(template);
  if (!detail.canInstantiate) {
    throw new Error(`workflow template is not instantiable: ${input.templateRef}`);
  }
  const scope = goalContract.domain;
  const requirementSpec = requirementSpecFromGoalContract(goalContract);
  input.onProgress?.({ stage: "candidate.resolving", message: "Resolving workflow library candidates." });
  const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope });
  input.onProgress?.({ stage: "candidate.resolved", message: "Workflow library candidates resolved." });
  const repair = await runCompositionRepairLoop({
    db,
    goalPrompt: renderTemplateInstantiationGoal(input, detail),
    goalContract,
    candidatePacket,
    composer: input.composer,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    scope,
    maxRepairAttempts: 2,
    onProgress: input.onProgress,
    onLlmDelta: input.onLlmDelta,
  });
  if (!repair.validation.ok || !repair.composition) {
    throw new Error(`workflow template composition failed validation: ${JSON.stringify(repair.validation.issues)}`);
  }
  return repair.composition;
}

function memoizeGoalInterpreter(interpreter: GoalContractInterpreter): GoalContractInterpreter {
  let contract: Promise<GoalContractV1> | undefined;
  return {
    interpret(input) {
      contract ??= interpreter.interpret(input);
      return contract;
    },
  };
}

function renderTemplateInstantiationGoal(
  input: InstantiateWorkflowTemplateInput,
  detail: WorkflowTemplateDetail,
): string {
  return [
    input.goalPrompt,
    "",
    "Template instantiation mode:",
    input.constraints?.mode === "adaptive" ? "adaptive" : "strict",
    "",
    "Template skeleton:",
    JSON.stringify({
      templateRef: input.templateRef,
      title: detail.title,
      nodes: detail.nodes,
      edges: detail.edges,
    }),
    "",
    "Preserve template node ids and dependencies when mode is strict.",
    "For each template node, generate the nodePromptSpec and generated agent profile for this specific goal.",
    "Select agent, skill, tool, MCP, instruction, artifact, evaluator, and policy refs only from the provided graph metadata candidates.",
  ].join("\n");
}

function instantiateSavedCompositionPlan(
  plan: WorkflowCompositionPlan,
  input: InstantiateWorkflowTemplateInput,
  goalContract: GoalContractV1,
): WorkflowCompositionPlan {
  const goalRequirement = `Instantiation goal: ${input.goalPrompt}`;
  return {
    ...plan,
    title: `${plan.title} - instantiated`,
    rationale: `${plan.rationale}\n\nInstantiated for: ${input.goalPrompt}`,
    tasks: plan.tasks.map((task) => {
      const requirementIds = mapSavedTaskRequirementIds(task, goalContract);
      return {
        ...task,
        requirementIds,
        nodePromptSpec: {
          ...task.nodePromptSpec,
          goal: `${task.nodePromptSpec!.goal}\n\nInstantiation goal: ${input.goalPrompt}`,
          requirements: uniqueStrings([goalRequirement, ...task.nodePromptSpec!.requirements]),
          acceptanceCriteria: uniqueStrings([
            `Satisfy the instantiation goal: ${input.goalPrompt}`,
            ...task.nodePromptSpec!.acceptanceCriteria,
          ]),
        },
      };
    }),
    generatedComponentProposals: plan.generatedComponentProposals.map((proposal) => proposal.agentProfile
      ? {
        ...proposal,
        agentProfile: {
          ...proposal.agentProfile,
          instruction: `${proposal.agentProfile.instruction}\n\nInstantiation goal: ${input.goalPrompt}`,
        },
      }
      : proposal),
  };
}

function mapSavedTaskRequirementIds(
  task: WorkflowCompositionPlan["tasks"][number],
  goalContract: GoalContractV1,
): string[] {
  if (!task.nodePromptSpec) {
    throw new Error(`task ${task.id} has no nodePromptSpec`);
  }
  const requirementIdsByText = new Map<string, Set<string>>();
  for (const requirement of goalContract.requirements) {
    for (const text of [requirement.statement, ...requirement.acceptanceCriteria]) {
      const normalized = normalizeRequirementText(text);
      const requirementIds = requirementIdsByText.get(normalized) ?? new Set<string>();
      requirementIds.add(requirement.id);
      requirementIdsByText.set(normalized, requirementIds);
    }
  }

  const mappedRequirementIds = new Set<string>();
  for (const text of [
    ...task.nodePromptSpec.requirements,
    ...task.nodePromptSpec.acceptanceCriteria,
  ]) {
    const matches = [...(requirementIdsByText.get(normalizeRequirementText(text)) ?? [])];
    if (matches.length > 1) {
      throw new Error(`task ${task.id} has ambiguous Goal Contract requirement text: ${text}`);
    }
    if (matches[0]) mappedRequirementIds.add(matches[0]);
  }
  if (mappedRequirementIds.size === 0 && !isCoverageExceptionTask(task)) {
    throw new Error(`task ${task.id} cannot be mapped to a Goal Contract requirement by exact node prompt text`);
  }
  return [...mappedRequirementIds];
}

function normalizeRequirementText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
