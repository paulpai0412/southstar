import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendVersionCreated, createLibraryObject, findLibraryObjectByKey, listLibraryVersions } from "./store.ts";
import type { LibraryActorType, LibraryDefinitionKind } from "./types.ts";

export type StarterLibrarySeedResult = {
  workflowTemplateRefs: string[];
  agentDefinitionRefs: string[];
  agentProfileRefs: string[];
  skillRefs: string[];
  mcpGrantRefs: string[];
  artifactContractRefs: string[];
  evaluatorRefs: string[];
};

type SeedObject = {
  objectKey: string;
  objectKind:
    | "workflow_template"
    | "agent_definition"
    | "agent_profile"
    | "skill_definition"
    | "mcp_tool_grant"
    | "artifact_contract"
    | "evaluator_profile";
  payload: Record<string, unknown>;
};

export function seedSoftwareEngineeringStarterLibrary(db: SouthstarDb, input: { actorType: LibraryActorType }): StarterLibrarySeedResult {
  const objects: SeedObject[] = [
    ...workflowTemplates(),
    ...agentDefinitions(),
    ...agentProfiles(),
    ...skillDefinitions(),
    ...mcpToolGrants(),
    ...artifactContracts(),
    ...evaluatorProfiles(),
  ];

  for (const object of objects) upsertSeedObject(db, object, input.actorType);

  return {
    workflowTemplateRefs: refs(objects, "workflow_template"),
    agentDefinitionRefs: refs(objects, "agent_definition"),
    agentProfileRefs: refs(objects, "agent_profile"),
    skillRefs: refs(objects, "skill_definition"),
    mcpGrantRefs: refs(objects, "mcp_tool_grant"),
    artifactContractRefs: refs(objects, "artifact_contract"),
    evaluatorRefs: refs(objects, "evaluator_profile"),
  };
}

function upsertSeedObject(db: SouthstarDb, object: SeedObject, actorType: LibraryActorType): void {
  const existing = findLibraryObjectByKey(db, object.objectKey);
  const objectId = existing?.objectId ?? createLibraryObject(db, {
    objectKey: object.objectKey,
    objectKind: object.objectKind as LibraryDefinitionKind,
    status: "approved",
    state: { payload: object.payload },
    actorType,
  }).objectId;

  const versionId = `${object.objectKey}@1.0.0`;
  if (listLibraryVersions(db, objectId).some((version) => version.versionId === versionId)) return;
  appendVersionCreated(db, {
    objectId,
    definitionKind: object.objectKind as LibraryDefinitionKind,
    versionId,
    payload: object.payload,
    createdBy: actorType === "llm" ? "migration" : actorType,
    status: "approved",
  });
}

function refs(objects: SeedObject[], kind: SeedObject["objectKind"]): string[] {
  return objects.filter((object) => object.objectKind === kind).map((object) => object.objectKey);
}

function workflowTemplates(): SeedObject[] {
  return [
    workflowTemplate("software.workflow.feature-implementation", "Feature Implementation", [
      node("explore", "software.explorer", ["software.repo-inspection"], [], ["run_brief", "repo_fact_cache", "implementation_plan"]),
      node("implement", "software.implementer", ["software.minimal-patch", "software.test-evidence"], ["explore"], ["implementation_report"], { profileRef: "software.implementer.pi.workspace-write" }),
      node("coding-review", "software.coding-reviewer", ["software.code-review"], ["implement"], ["code_review_report"]),
      node("spec-alignment", "software.spec-alignment", ["software.spec-alignment-skill"], ["implement"], ["spec_alignment_report"]),
      node("browser-qa", "software.browser-qa", ["software.browser-qa-skill"], ["implement"], ["browser_qa_report"], { conditional: "web-ui-detected" }),
      node("release-commit-curation", "software.release-operator", ["software.commit-curation"], ["coding-review", "spec-alignment"], ["commit_plan", "commit_result"], { conditional: "releaseMode != none", profileRef: "software.release-operator.commit-local" }),
      node("release-merge-readiness", "software.release-operator", ["software.merge-readiness"], ["release-commit-curation"], ["merge_readiness_report"], { conditional: "releaseMode >= merge-ready", profileRef: "software.release-operator.readiness-readonly" }),
      node("release-merge-operation", "software.release-operator", ["software.merge-operation"], ["release-merge-readiness"], ["merge_result"], { conditional: "releaseMode == merge-and-release", profileRef: "software.release-operator.merge-approved", approvalRequired: true }),
      node("release-report", "software.release-reporter", ["software.release-reporting"], ["release-merge-readiness"], ["release_report", "release_result"], { conditional: "releaseMode != none" }),
      node("summarize", "software.summarizer", ["software.completion-report"], ["coding-review", "spec-alignment"], ["completion_report"]),
    ]),
    workflowTemplate("software.workflow.bug-diagnosis-fix", "Bug Diagnosis & Fix", [
      node("reproduce", "software.reproducer", ["software.bug-reproduction"], [], ["bug_reproduction_report"]),
      node("diagnose", "software.diagnoser", ["software.repo-inspection"], ["reproduce"], ["diagnosis_report"]),
      node("fix", "software.implementer", ["software.minimal-patch", "software.test-evidence"], ["diagnose"], ["implementation_report"], { profileRef: "software.implementer.pi.workspace-write" }),
      node("regression-check", "software.regression-checker", ["software.regression-check"], ["fix"], ["regression_test_report"]),
      node("coding-review", "software.coding-reviewer", ["software.code-review"], ["fix"], ["code_review_report"]),
      node("spec-alignment", "software.spec-alignment", ["software.spec-alignment-skill"], ["fix"], ["spec_alignment_report"]),
      node("summarize", "software.summarizer", ["software.completion-report"], ["regression-check", "coding-review", "spec-alignment"], ["completion_report"]),
    ]),
    workflowTemplate("software.workflow.test-coverage-improvement", "Test & Coverage Improvement", [
      node("explore", "software.explorer", ["software.repo-inspection"], [], ["run_brief", "repo_fact_cache", "implementation_plan"]),
      node("write-tests", "software.test-writer", ["software.test-evidence"], ["explore"], ["implementation_report"], { profileRef: "software.implementer.pi.workspace-write" }),
      node("test-runner-check", "software.test-runner-checker", ["software.regression-check"], ["write-tests"], ["verification_report"]),
      node("spec-alignment", "software.spec-alignment", ["software.spec-alignment-skill"], ["write-tests"], ["spec_alignment_report"]),
      node("release-commit-curation", "software.release-operator", ["software.commit-curation"], ["test-runner-check", "spec-alignment"], ["commit_plan", "commit_result"], { conditional: "releaseMode != none", profileRef: "software.release-operator.commit-local" }),
      node("summarize", "software.summarizer", ["software.completion-report"], ["test-runner-check", "spec-alignment"], ["completion_report"]),
    ]),
    workflowTemplate("software.workflow.refactor-safety-net", "Refactor with Safety Net", [
      node("explore", "software.explorer", ["software.repo-inspection"], [], ["run_brief", "repo_fact_cache", "implementation_plan"]),
      node("baseline-check", "software.baseline-checker", ["software.regression-check"], ["explore"], ["regression_test_report"]),
      node("refactor", "software.refactorer", ["software.refactor-safety"], ["baseline-check"], ["refactor_report", "implementation_report"], { profileRef: "software.implementer.pi.workspace-write" }),
      node("regression-check", "software.regression-checker", ["software.regression-check"], ["refactor"], ["regression_test_report"]),
      node("coding-review", "software.coding-reviewer", ["software.code-review"], ["refactor"], ["code_review_report"]),
      node("spec-alignment", "software.spec-alignment", ["software.spec-alignment-skill"], ["refactor"], ["spec_alignment_report"]),
      node("summarize", "software.summarizer", ["software.completion-report"], ["regression-check", "coding-review", "spec-alignment"], ["completion_report"]),
    ]),
    workflowTemplate("software.workflow.documentation-update", "Documentation / README Update", [
      node("explore", "software.explorer", ["software.repo-inspection"], [], ["run_brief", "repo_fact_cache"]),
      node("write-docs", "software.doc-writer", ["software.docs-update"], ["explore"], ["docs_update_report"], { profileRef: "software.doc-writer.pi.docs-write" }),
      node("doc-check", "software.doc-checker", ["software.docs-update"], ["write-docs"], ["doc_check_report"]),
      node("spec-alignment", "software.spec-alignment", ["software.spec-alignment-skill"], ["write-docs"], ["spec_alignment_report"]),
      node("release-commit-curation", "software.release-operator", ["software.commit-curation"], ["doc-check", "spec-alignment"], ["commit_plan", "commit_result"], { conditional: "releaseMode != none", profileRef: "software.release-operator.commit-local" }),
      node("release-report", "software.release-reporter", ["software.release-reporting"], ["release-commit-curation"], ["release_report", "release_result"], { conditional: "releaseMode != none" }),
      node("summarize", "software.summarizer", ["software.completion-report"], ["doc-check", "spec-alignment"], ["completion_report"]),
    ]),
  ];
}

function workflowTemplate(objectKey: string, name: string, nodes: Array<Record<string, unknown>>): SeedObject {
  return {
    objectKey,
    objectKind: "workflow_template",
    payload: {
      schemaVersion: "southstar.library.workflow_template.v1",
      templateType: "adaptive",
      name,
      flow: { nodes, edges: edgesFromNodes(nodes) },
      reuse: {
        signature: name.toLowerCase(),
        tags: objectKey.split("."),
        requiredInputs: ["goalPrompt", "repoPath"],
        clarificationPolicy: { askOnlyWhenMissingRequiredInput: true, askWhenSimilarityBelow: 0.75, askWhenRiskAbove: "medium" },
      },
      lifecycle: { status: "validated", validatedByRunIds: [], failureEvidenceRefs: [] },
    },
  };
}

function node(
  id: string,
  agentDefinitionRef: string,
  skillRefs: string[],
  dependsOn: string[],
  artifactRefs: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, nodeType: "agent_task", name: titleCase(id), roleRef: roleFromAgent(agentDefinitionRef), agentDefinitionRef, skillRefs, dependsOn, artifactRefs, ...extra };
}

function edgesFromNodes(nodes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return nodes.flatMap((target) => (target.dependsOn as string[]).map((source) => ({
    id: `${source}-to-${target.id}`,
    from: source,
    to: target.id,
    edgeType: "artifact_flow",
  })));
}

function agentDefinitions(): SeedObject[] {
  const ids = [
    "software.explorer",
    "software.implementer",
    "software.checker",
    "software.reproducer",
    "software.diagnoser",
    "software.test-writer",
    "software.test-runner-checker",
    "software.refactorer",
    "software.baseline-checker",
    "software.regression-checker",
    "software.doc-writer",
    "software.doc-checker",
    "software.coding-reviewer",
    "software.spec-alignment",
    "software.browser-qa",
    "software.release-operator",
    "software.release-reporter",
    "software.summarizer",
    "software.requirement-planner",
    "software.context-economist",
  ];
  return ids.map((id) => ({
    objectKey: id,
    objectKind: "agent_definition",
    payload: {
      id,
      purpose: `Perform ${id} work with auditable Southstar artifacts.`,
      strengths: ["follows artifact contracts", "uses scoped context", "reports evidence"],
      limitations: id.includes("review") || id.includes("alignment") ? ["read-only by default"] : ["requires runtime validation"],
      requiredCapabilities: id.includes("release") ? ["git", "policy"] : ["software", "artifact-evidence"],
      producedArtifacts: producedArtifactsForAgent(id),
      preferredWorkflowTemplates: id.includes("doc") ? ["software.workflow.documentation-update"] : ["software.workflow.feature-implementation"],
      riskLevel: id.includes("merge") ? "high" : id.includes("release") ? "medium" : "low",
      compatibleProfileRefs: [],
    },
  }));
}

function agentProfiles(): SeedObject[] {
  return [
    profile("software.explorer.codex.readonly", "software.explorer", "codex", ["read", "search"], ["edit", "external-write"], ["filesystem.readonly"], ["software.repo-inspection"]),
    profile("software.implementer.pi.workspace-write", "software.implementer", "pi", ["read", "search", "edit", "shell"], ["external-write"], ["filesystem.workspace-write", "shell.test-runner", "git.workspace-patch"], ["software.minimal-patch", "software.test-evidence"]),
    profile("software.doc-writer.pi.docs-write", "software.doc-writer", "pi", ["read", "search", "edit"], ["external-write"], ["filesystem.workspace-write"], ["software.docs-update"]),
    profile("software.coding-reviewer.codex.readonly", "software.coding-reviewer", "codex", ["read", "search", "shell"], ["edit", "external-write"], ["filesystem.readonly", "git.readonly", "shell.test-runner"], ["software.code-review"]),
    profile("software.spec-alignment.codex.readonly", "software.spec-alignment", "codex", ["read", "search"], ["edit", "external-write"], ["filesystem.readonly"], ["software.spec-alignment-skill"]),
    profile("software.browser-qa.pi.browser-local", "software.browser-qa", "pi", ["read", "search", "shell", "browser"], ["edit", "external-write"], ["filesystem.readonly", "shell.test-runner", "browser.local-preview", "network.disabled"], ["software.browser-qa-skill"]),
    profile("software.release-operator.commit-local", "software.release-operator", "pi", ["read", "search", "shell", "edit"], ["external-write"], ["filesystem.workspace-write", "git.workspace-patch", "shell.test-runner"], ["software.commit-curation"]),
    profile("software.release-operator.readiness-readonly", "software.release-operator", "codex", ["read", "search", "shell"], ["edit", "external-write"], ["filesystem.readonly", "git.readonly", "shell.test-runner"], ["software.merge-readiness"]),
    profile("software.release-operator.merge-approved", "software.release-operator", "pi", ["read", "search", "shell", "edit"], ["secret-read-without-approval"], ["filesystem.workspace-write", "git.workspace-patch", "github.pr-write"], ["software.merge-operation"], { requireManualFor: ["github.pr-write", "external-write", "merge-operation"] }),
    profile("software.release-reporter.codex.readonly", "software.release-reporter", "codex", ["read", "search"], ["edit"], ["filesystem.readonly", "git.readonly", "github.readonly"], ["software.release-reporting"]),
    profile("software.summarizer.codex.readonly", "software.summarizer", "codex", ["read", "search"], ["edit", "external-write"], ["filesystem.readonly"], ["software.completion-report"]),
  ];
}

function profile(
  objectKey: string,
  agentDefinitionRef: string,
  provider: "pi" | "codex",
  allowedTools: string[],
  deniedTools: string[],
  mcpGrantRefs: string[],
  skillRefs: string[],
  approvalPolicy: Record<string, unknown> = {},
): SeedObject {
  return {
    objectKey,
    objectKind: "agent_profile",
    payload: {
      id: objectKey,
      agentDefinitionRef,
      provider,
      model: provider === "pi" ? "pi-agent-default" : "gpt-5-codex",
      harnessRef: provider,
      allowedTools,
      deniedTools,
      skillRefs,
      mcpGrantRefs,
      contextPolicyRef: "software-context-default",
      sessionPolicyRef: "software-session-default",
      budgetPolicy: { maxInputTokens: 24000, maxOutputTokens: 4000, maxWallTimeSeconds: provider === "pi" ? 900 : 600 },
      approvalPolicy,
    },
  };
}

function skillDefinitions(): SeedObject[] {
  return [
    "software.repo-inspection",
    "software.minimal-patch",
    "software.test-evidence",
    "software.bug-reproduction",
    "software.regression-check",
    "software.refactor-safety",
    "software.docs-update",
    "software.code-review",
    "software.spec-alignment-skill",
    "software.browser-qa-skill",
    "software.commit-curation",
    "software.merge-readiness",
    "software.merge-operation",
    "software.release-reporting",
    "software.completion-report",
  ].map((id) => ({
    objectKey: id,
    objectKind: "skill_definition",
    payload: { id, instructions: `Use ${id} discipline. Produce structured evidence and respect Southstar artifact contracts.`, allowedTools: [] },
  }));
}

function mcpToolGrants(): SeedObject[] {
  return [
    grant("filesystem.readonly", ["read", "search"]),
    grant("filesystem.workspace-write", ["read", "search", "edit"]),
    grant("git.readonly", ["git status", "git diff", "git log"]),
    grant("git.workspace-patch", ["git status", "git diff", "git add", "git commit"]),
    grant("shell.test-runner", ["npm test", "node --test", "pytest", "pnpm test"]),
    grant("browser.local-preview", ["open local preview", "inspect DOM", "capture accessibility evidence"]),
    grant("network.disabled", []),
    grant("github.readonly", ["read issue", "read PR", "read checks"]),
    grant("github.pr-write", ["merge PR", "update PR"], { approvalRequired: true }),
    grant("github.issue-comment", ["comment issue", "close issue"], { approvalRequired: true }),
  ];
}

function grant(objectKey: string, allowedTools: string[], extra: Record<string, unknown> = {}): SeedObject {
  return { objectKey, objectKind: "mcp_tool_grant", payload: { id: objectKey, allowedTools, ...extra } };
}

function artifactContracts(): SeedObject[] {
  return [
    "requirement_spec", "run_brief", "repo_fact_cache", "implementation_plan", "implementation_report", "verification_report",
    "code_review_report", "spec_alignment_report", "browser_qa_report", "bug_reproduction_report", "diagnosis_report",
    "regression_test_report", "refactor_report", "docs_update_report", "doc_check_report", "commit_plan", "commit_result",
    "merge_readiness_report", "merge_result", "release_report", "release_result", "completion_report",
  ].map((id) => ({ objectKey: id, objectKind: "artifact_contract", payload: { id, requiredFields: ["summary", "evidence", "risks"], evidenceFields: ["commandsRun", "artifactRefs", "validatorRefs"] } }));
}

function evaluatorProfiles(): SeedObject[] {
  return [
    "software.requirement-spec-quality", "software.plan-quality", "software.implementation-evidence", "software.verification-evidence",
    "software.code-review-quality", "software.spec-alignment-quality", "software.browser-qa-quality", "software.regression-safety",
    "software.docs-quality", "software.commit-safety", "software.merge-readiness-quality", "software.release-result-quality", "software.completion-gate",
  ].map((id) => ({ objectKey: id, objectKind: "evaluator_profile", payload: { id, kind: "policy", requiredEvidence: ["summary", "evidence"], failClosed: true } }));
}

function titleCase(id: string): string {
  return id.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function roleFromAgent(agent: string): string {
  return agent.split(".").at(-1) ?? agent;
}

function producedArtifactsForAgent(id: string): string[] {
  if (id.includes("browser")) return ["browser_qa_report"];
  if (id.includes("alignment")) return ["spec_alignment_report"];
  if (id.includes("reviewer")) return ["code_review_report"];
  if (id.includes("release-operator")) return ["commit_result", "merge_readiness_report", "merge_result"];
  if (id.includes("release-reporter")) return ["release_report", "release_result"];
  return ["completion_report"];
}
