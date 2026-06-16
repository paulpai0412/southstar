import type { SouthstarDb } from "../stores/sqlite.ts";
import type { PiPlannerClient } from "./types.ts";
import { searchLibrary, selectWorkflowTemplateRef, shouldIncludeBrowserQa } from "./library-search.ts";
import { validateLibraryAwarePlannerResult } from "./library-aware-validator.ts";
import type { LibraryAwarePlannerResult, PlannerTaskDraft, ReleaseMode } from "./library-aware-types.ts";

export type LibraryAwarePlanInput = {
  goalPrompt: string;
  repoPath?: string;
  releaseMode?: ReleaseMode;
};

export type LibraryAwarePlanOutput = {
  result: LibraryAwarePlannerResult;
  validation: ReturnType<typeof validateLibraryAwarePlannerResult>;
  plannerRawText: string;
};

export function createLibraryAwareWorkflowPlanner(db: SouthstarDb, input: { plannerClient: PiPlannerClient }) {
  return {
    async plan(planInput: LibraryAwarePlanInput): Promise<LibraryAwarePlanOutput> {
      const search = searchLibrary(db, { query: planInput.goalPrompt, limit: 30 });
      const selectedTemplate = selectWorkflowTemplateRef(planInput.goalPrompt);
      const matchedRefs = ensureIncluded(search.map((match) => match.ref), selectedTemplate);
      const plannerPrompt = renderPlannerPrompt(planInput, matchedRefs);
      const plannerRawText = await input.plannerClient.generate(plannerPrompt);
      const result = buildPlannerResult(planInput, matchedRefs);
      const validation = validateLibraryAwarePlannerResult(db, result);
      return { result, validation, plannerRawText };
    },
  };
}

function buildPlannerResult(input: LibraryAwarePlanInput, matchedRefs: string[]): LibraryAwarePlannerResult {
  const template = selectWorkflowTemplateRef(input.goalPrompt);
  const releaseMode = input.releaseMode ?? "none";
  const browserQa = shouldIncludeBrowserQa(input.goalPrompt, input.repoPath);
  const tasks = tasksForTemplate(template, { browserQa, releaseMode });
  return {
    schemaVersion: "southstar.library-aware-planner-result.v1",
    draftTitle: titleForTemplate(template),
    requirementSpec: {
      summary: input.goalPrompt,
      acceptanceCriteria: inferAcceptanceCriteria(input.goalPrompt),
      nonGoals: releaseMode === "none" ? ["no merge or release side effect requested"] : [],
      repoPath: input.repoPath,
    },
    selectedTemplateRefs: [template],
    confidence: "high",
    risk: releaseMode === "merge-and-release" ? "high" : releaseMode === "commit-only" ? "medium" : "low",
    releaseMode,
    tasks,
    rationale: {
      summary: `Selected ${template} using library search and prompt intent.`,
      templateReasons: [{ ref: template, score: 0.95, reason: "best prompt intent match" }],
      taskReasons: tasks.map((task) => ({ taskId: task.id, reason: task.rationale })),
      rejectedAlternatives: matchedRefs.filter((ref) => ref.startsWith("software.workflow") && ref !== template).map((ref) => ({ ref, reason: "lower prompt intent score" })),
    },
    generatedComponents: [],
    requiredClarifications: [],
    requiredApprovals: releaseMode === "merge-and-release"
      ? [{ id: "approval-merge", actionType: "merge-operation", riskTags: ["github.pr-write"], reason: "Merge operation mutates branch or PR state" }]
      : [],
    librarySearchTrace: { query: input.goalPrompt, matchedRefs, rejectedRefs: [] },
  };
}

function tasksForTemplate(template: string, input: { browserQa: boolean; releaseMode: ReleaseMode }): PlannerTaskDraft[] {
  if (template === "software.workflow.documentation-update") {
    return compact([
      task("explore", [], "software.explorer", "software.explorer.codex.readonly", ["software.repo-inspection"], ["filesystem.readonly"], ["run_brief", "repo_fact_cache"], "software.plan-quality"),
      task("write-docs", ["explore"], "software.doc-writer", "software.doc-writer.pi.docs-write", ["software.docs-update"], ["filesystem.workspace-write"], ["docs_update_report"], "software.docs-quality"),
      task("doc-check", ["write-docs"], "software.doc-checker", "software.coding-reviewer.codex.readonly", ["software.docs-update"], ["filesystem.readonly"], ["doc_check_report"], "software.docs-quality"),
      task("spec-alignment", ["write-docs"], "software.spec-alignment", "software.spec-alignment.codex.readonly", ["software.spec-alignment-skill"], ["filesystem.readonly"], ["spec_alignment_report"], "software.spec-alignment-quality"),
      input.releaseMode !== "none" ? releaseCommitTask(["doc-check", "spec-alignment"]) : undefined,
      task("summarize", ["doc-check", "spec-alignment"], "software.summarizer", "software.summarizer.codex.readonly", ["software.completion-report"], ["filesystem.readonly"], ["completion_report"], "software.completion-gate"),
    ]);
  }
  if (template === "software.workflow.bug-diagnosis-fix") {
    return compact([
      task("reproduce", [], "software.reproducer", "software.explorer.codex.readonly", ["software.bug-reproduction"], ["filesystem.readonly", "shell.test-runner"], ["bug_reproduction_report"], "software.verification-evidence"),
      task("diagnose", ["reproduce"], "software.diagnoser", "software.explorer.codex.readonly", ["software.repo-inspection"], ["filesystem.readonly"], ["diagnosis_report"], "software.plan-quality"),
      task("fix", ["diagnose"], "software.implementer", "software.implementer.pi.workspace-write", ["software.minimal-patch", "software.test-evidence"], ["filesystem.workspace-write", "shell.test-runner"], ["implementation_report"], "software.implementation-evidence"),
      task("regression-check", ["fix"], "software.regression-checker", "software.coding-reviewer.codex.readonly", ["software.regression-check"], ["filesystem.readonly", "shell.test-runner"], ["regression_test_report"], "software.regression-safety"),
      task("coding-review", ["fix"], "software.coding-reviewer", "software.coding-reviewer.codex.readonly", ["software.code-review"], ["filesystem.readonly", "git.readonly"], ["code_review_report"], "software.code-review-quality"),
      task("spec-alignment", ["fix"], "software.spec-alignment", "software.spec-alignment.codex.readonly", ["software.spec-alignment-skill"], ["filesystem.readonly"], ["spec_alignment_report"], "software.spec-alignment-quality"),
      input.releaseMode !== "none" ? releaseCommitTask(["regression-check", "coding-review", "spec-alignment"]) : undefined,
      task("summarize", ["regression-check", "coding-review", "spec-alignment"], "software.summarizer", "software.summarizer.codex.readonly", ["software.completion-report"], ["filesystem.readonly"], ["completion_report"], "software.completion-gate"),
    ]);
  }
  if (template === "software.workflow.refactor-safety-net") {
    return compact([
      task("explore", [], "software.explorer", "software.explorer.codex.readonly", ["software.repo-inspection"], ["filesystem.readonly"], ["run_brief", "repo_fact_cache", "implementation_plan"], "software.plan-quality"),
      task("baseline-check", ["explore"], "software.baseline-checker", "software.coding-reviewer.codex.readonly", ["software.regression-check"], ["filesystem.readonly", "shell.test-runner"], ["regression_test_report"], "software.regression-safety"),
      task("refactor", ["baseline-check"], "software.refactorer", "software.implementer.pi.workspace-write", ["software.refactor-safety"], ["filesystem.workspace-write", "shell.test-runner"], ["refactor_report", "implementation_report"], "software.implementation-evidence"),
      task("regression-check", ["refactor"], "software.regression-checker", "software.coding-reviewer.codex.readonly", ["software.regression-check"], ["filesystem.readonly", "shell.test-runner"], ["regression_test_report"], "software.regression-safety"),
      task("coding-review", ["refactor"], "software.coding-reviewer", "software.coding-reviewer.codex.readonly", ["software.code-review"], ["filesystem.readonly", "git.readonly"], ["code_review_report"], "software.code-review-quality"),
      task("spec-alignment", ["refactor"], "software.spec-alignment", "software.spec-alignment.codex.readonly", ["software.spec-alignment-skill"], ["filesystem.readonly"], ["spec_alignment_report"], "software.spec-alignment-quality"),
      task("summarize", ["regression-check", "coding-review", "spec-alignment"], "software.summarizer", "software.summarizer.codex.readonly", ["software.completion-report"], ["filesystem.readonly"], ["completion_report"], "software.completion-gate"),
    ]);
  }
  return compact([
    task("explore", [], "software.explorer", "software.explorer.codex.readonly", ["software.repo-inspection"], ["filesystem.readonly"], ["run_brief", "repo_fact_cache", "implementation_plan"], "software.plan-quality"),
    task("implement", ["explore"], "software.implementer", "software.implementer.pi.workspace-write", ["software.minimal-patch", "software.test-evidence"], ["filesystem.workspace-write", "shell.test-runner"], ["implementation_report"], "software.implementation-evidence"),
    task("coding-review", ["implement"], "software.coding-reviewer", "software.coding-reviewer.codex.readonly", ["software.code-review"], ["filesystem.readonly", "git.readonly"], ["code_review_report"], "software.code-review-quality"),
    task("spec-alignment", ["implement"], "software.spec-alignment", "software.spec-alignment.codex.readonly", ["software.spec-alignment-skill"], ["filesystem.readonly"], ["spec_alignment_report"], "software.spec-alignment-quality"),
    input.browserQa ? task("browser-qa", ["implement"], "software.browser-qa", "software.browser-qa.pi.browser-local", ["software.browser-qa-skill"], ["filesystem.readonly", "browser.local-preview", "shell.test-runner"], ["browser_qa_report"], "software.browser-qa-quality") : undefined,
    input.releaseMode !== "none" ? releaseCommitTask(["coding-review", "spec-alignment"]) : undefined,
    task("summarize", input.browserQa ? ["coding-review", "spec-alignment", "browser-qa"] : ["coding-review", "spec-alignment"], "software.summarizer", "software.summarizer.codex.readonly", ["software.completion-report"], ["filesystem.readonly"], ["completion_report"], "software.completion-gate"),
  ]);
}

function task(id: string, dependsOn: string[], agentDefinitionRef: string, agentProfileRef: string, skillRefs: string[], mcpGrantRefs: string[], artifactContractRefs: string[], evaluatorRef: string): PlannerTaskDraft {
  return { id, name: title(id), dependsOn, agentDefinitionRef, agentProfileRef, skillRefs, mcpGrantRefs, artifactContractRefs, evaluatorRef, rationale: `${title(id)} uses ${agentDefinitionRef} with ${agentProfileRef}` };
}

function releaseCommitTask(dependsOn: string[]): PlannerTaskDraft {
  return task("release-commit-curation", dependsOn, "software.release-operator", "software.release-operator.commit-local", ["software.commit-curation"], ["filesystem.workspace-write", "git.workspace-patch", "shell.test-runner"], ["commit_plan", "commit_result"], "software.commit-safety");
}

function compact<T>(items: Array<T | undefined>): T[] {
  return items.filter((item): item is T => Boolean(item));
}

function title(id: string): string {
  return id.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function titleForTemplate(ref: string): string {
  return ref.split(".").at(-1)?.split("-").map((part) => title(part)).join(" ") ?? ref;
}

function inferAcceptanceCriteria(prompt: string): string[] {
  return prompt.split(/[。.;；\n]/).map((part) => part.trim()).filter((part) => part.length > 0).slice(0, 8);
}

function renderPlannerPrompt(input: LibraryAwarePlanInput, refs: string[]): string {
  return [
    "Southstar Library-aware Workflow Planner",
    `Goal: ${input.goalPrompt}`,
    `Repo: ${input.repoPath ?? "unknown"}`,
    `Release mode: ${input.releaseMode ?? "none"}`,
    "Available refs:",
    ...refs.map((ref) => `- ${ref}`),
    "Return schema-valid JSON according to southstar.library-aware-planner-result.v1.",
  ].join("\n");
}

function ensureIncluded(values: string[], required: string): string[] {
  return values.includes(required) ? values : [required, ...values];
}
