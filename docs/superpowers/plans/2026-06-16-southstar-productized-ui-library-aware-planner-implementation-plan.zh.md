# Southstar Productized UI + Library-aware Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Southstar's productized App Shell with Chat / Workflow / Operations tabs and LLM-assisted Library-aware Planner so a non-calc software goal becomes a validated DAG assembled from the Software Engineering Starter Library, with real E2E and quantitative gates.

**Architecture:** Add a first-class library-aware planning path beside the existing constrained generator, backed by an expanded Software Engineering Starter Library, strict planner result validation, Context Economy resources, and UI read models. The Southstar App Shell ports the useful pi-web shell/chat structure into Southstar and exposes Chat, Workflow, and Operations tabs; Workflow consumes planner drafts, DAG rationale, context sources, Library alternatives, and Operator attention items, while Operations productizes the old Northstar control-center concepts for multi-run monitoring.

**Tech Stack:** TypeScript ESM, Node 22 native APIs via `tsx`, SQLite resource store, Next.js 16 app router, React 19, node:test, existing Southstar v2 server/UI API patterns.

---

## Goal tracking prompt for implementation sessions

When starting execution in a long-running agent session, create a tracked goal with this exact objective:

```text
Implement the Southstar productized App Shell and LLM-assisted Library-aware Planner from docs/superpowers/specs/2026-06-16-southstar-productized-ui-library-aware-planner-design.zh.md: expand the Software Engineering Starter Library, add library-aware planner schema/validation/skill orchestration, integrate prompt-to-DAG draft creation, add Context Economy resources, preserve fixed generic runner image delivery via TaskEnvelopeV2 skill snapshots/MCP grants/mounts, expose Chat/Workflow/Operations App Shell, Library, and Operator read models and UI, add non-calc real E2E scenarios, and enforce quantitative gates with npm test, npm run test:v2, npm run web:build, and the new real E2E gate.
```

Use the goal tool only when the harness provides it. Do not mark the goal complete until the completion audit maps every requirement to tests, files, and command output.

## Scope and sequencing

This plan intentionally ships one vertical product capability, not a cosmetic UI-only change. The implementation order is:

1. Expand the Starter Library so the planner has real software engineering components.
2. Add planner result schema and validator so LLM output cannot become truth without checks.
3. Add a library-aware planner with deterministic tests and a fake LLM client.
4. Integrate the planner into draft creation and persist decision traces.
5. Add Context Economy resources and downstream context reuse.
6. Preserve fixed generic runner image delivery: skills and MCP/tool grants travel through TaskEnvelopeV2, materialized run roots, context packets, and mounts; planner output must not invent ad hoc Docker images.
7. Add read models and UI surfaces for the Southstar App Shell: Chat, Workflow, Operations, Library alternatives, context sources, and Operator.
8. Add non-calc E2E fixtures, scenarios, and quantitative gates.

## File map

### New files

- `src/v2/design-library/software-engineering-starter.ts` — seeds workflow templates, agent definitions, agent profiles, skills, MCP/tool grants, artifact contracts, and evaluator profiles for the five software workflows.
- `src/v2/planner/library-aware-types.ts` — schema-level TypeScript types for planner input/output, selection traces, generated components, missing-capability decisions, and validation issues.
- `src/v2/planner/library-aware-validator.ts` — pure validation for planner result shape, DAG consistency, library refs, risk grants, artifacts, evaluators, and generated component policy.
- `src/v2/planner/library-search.ts` — deterministic scoring and retrieval over library objects and domain-pack resources.
- `src/v2/planner/library-aware-planner.ts` — orchestrates requirement extraction, library search, LLM-assisted selection/adaptation, validation, and repair attempts.
- `skills/southstar/workflow-planner-library-selection/SKILL.md` — planner skill instructions used by LLM planner sessions.
- `src/v2/context/economy.ts` — creates and reads Run Brief, Repo Fact Cache, Artifact Summary, and context-source summaries.
- `src/v2/quality/productized-ui-library-planner-gates.ts` — quantitative gate verifier for planner, DAG, context, library, execution image/skill/MCP delivery, UI, artifact, and E2E evidence.
- `src/v2/ui-api/page-models/workflow-tab.ts` — Workflow tab page model for new goal, planning, draft review, active run, task inspector, rationale, and context sources.
- `src/v2/ui-api/page-models/operations-tab.ts` — Operations tab model for multi-run monitoring, approvals, executor health, release lanes, and automation watch state.
- `src/v2/ui-api/page-models/library-alternatives.ts` — side-sheet model for matched templates, agent/profile alternatives, skills, MCP/tool grants, and rejected alternatives.
- `src/v2/ui-api/page-models/operator-attention.ts` — floating Operator sheet model for approvals, stuck tasks, high-risk release actions, and recovery suggestions.
- `components/southstar/app-shell/SouthstarProductShell.tsx` — pi-web inspired Southstar shell with Chat / Workflow / Operations tabs.
- `components/southstar/app-shell/SouthstarTopBar.tsx` — runtime/project/status bar.
- `components/southstar/app-shell/SouthstarTabRail.tsx` — tab selector for Chat, Workflow, Operations.
- `components/southstar/chat/SouthstarChatTab.tsx` — preserved chat surface adapted to Southstar style.
- `components/southstar/workflow/WorkflowTab.tsx` — productized Workflow tab container.
- `components/southstar/workflow/LibraryContextPanel.tsx` — selected/matched Library context panel.
- `components/southstar/workflow/GuidedPlannerChat.tsx` — skill-guided planner chat.
- `components/southstar/workflow/WorkflowDagPanel.tsx` — simplified DAG review canvas.
- `components/southstar/workflow/TaskInspector.tsx` — read-only task inspector with `Customize this run` entry.
- `components/southstar/workflow/LibraryAlternativesSheet.tsx` — read-only alternative selector.
- `components/southstar/operator/OperatorDock.tsx` — collapsed Operator attention pill.
- `components/southstar/operator/OperatorSheet.tsx` — expanded Operator attention layer.
- `components/southstar/operations/SouthstarOperationsTab.tsx` — Southstar Control Center based on Northstar control-panel concepts.
- `app/chat/page.tsx`, `app/workflow/page.tsx`, `app/operations/page.tsx` — deep-link routes into each tab.
- `tests/v2/software-engineering-starter-library.test.ts` — Starter Library coverage.
- `tests/v2/library-aware-planner-validator.test.ts` — planner result validator coverage.
- `tests/v2/library-aware-planner.test.ts` — planner orchestration coverage with fake LLM.
- `tests/v2/context-economy.test.ts` — Run Brief, Repo Fact Cache, Artifact Summary, and downstream context reuse coverage.
- `tests/v2/productized-ui-read-models.test.ts` — Workflow tab, Operations tab, Library alternatives, and Operator read model coverage.
- `tests/web/southstar-productized-app-shell-ui.test.tsx` — static/source-level App Shell, Chat, Workflow, Operations route and component coverage.
- `tests/e2e-real/scenarios/todo-web-feature.ts` — non-calc feature scenario.
- `tests/e2e-real/scenarios/markdown-table-bugfix.ts` — parser bugfix scenario.
- `tests/e2e-real/scenarios/docs-cli-usage.ts` — docs-only scenario.
- `tests/e2e-real/scenarios/refactor-safety-net.ts` — refactor scenario.
- `tests/v2/productized-ui-library-planner-gates.test.ts` — quantitative gate unit tests.
- `docs/superpowers/productized-ui-library-planner-coverage.md` — evidence matrix.

### Modified files

- `src/v2/design-library/software-dev-seed.ts` — call or delegate to the new Starter Library seed while preserving existing tests.
- `src/v2/design-library/types.ts` — add object kinds and payload shapes if the current model lacks agent definition/profile/skill/grant/evaluator metadata fields.
- `src/v2/ui-api/local-api.ts` — integrate Library-aware Planner into `createPlannerDraft`, persist traces, and create Context Economy resources.
- `src/v2/server/ui-routes.ts` — expose Workflow tab, Operations tab, Library alternatives, and Operator page models.
- `src/v2/ui-api/page-models/types.ts` — add new page model types.
- `src/v2/read-models/registry.ts` and `src/v2/read-models/types.ts` — expose the new read models through the generic read-model registry if needed by CLI.
- `components/southstar/shell/*` — keep existing routes reachable while the new product shell becomes root.
- `app/page.tsx` — route root to Southstar App Shell.
- `tests/v2/index.test.ts` — import new v2 tests.
- `tests/index.test.ts` — import web source-level tests if not already covered.
- `package.json` — add a real E2E productized planner script if the existing E2E runner needs a new entry.

---

## Task 1: Expand Software Engineering Starter Library seed

**Files:**
- Create: `src/v2/design-library/software-engineering-starter.ts`
- Modify: `src/v2/design-library/software-dev-seed.ts`
- Test: `tests/v2/software-engineering-starter-library.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing Starter Library test**

Create `tests/v2/software-engineering-starter-library.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareEngineeringStarterLibrary } from "../../src/v2/design-library/software-engineering-starter.ts";
import { listLibraryVersions } from "../../src/v2/design-library/store.ts";

type ObjectRow = { id: string; object_key: string; object_kind: string; state_json: string };

function libraryRows(db: ReturnType<typeof openSouthstarDb>, kind?: string): ObjectRow[] {
  const sql = kind
    ? "select id, object_key, object_kind, state_json from library_objects where object_kind = ? order by object_key"
    : "select id, object_key, object_kind, state_json from library_objects order by object_key";
  return (kind ? db.prepare(sql).all(kind) : db.prepare(sql).all()) as ObjectRow[];
}

test("software engineering starter library seeds five workflow templates and productized agents", () => {
  const db = openSouthstarDb(":memory:");
  const result = seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });

  assert.equal(result.workflowTemplateRefs.length, 5);
  assert.equal(result.agentDefinitionRefs.includes("software.release-operator"), true);
  assert.equal(result.agentDefinitionRefs.includes("software.release-reporter"), true);
  assert.equal(result.agentDefinitionRefs.includes("software.coding-reviewer"), true);
  assert.equal(result.agentDefinitionRefs.includes("software.spec-alignment"), true);
  assert.equal(result.agentDefinitionRefs.includes("software.browser-qa"), true);

  const templates = libraryRows(db, "workflow_template");
  assert.deepEqual(templates.map((row) => row.object_key), [
    "software.workflow.bug-diagnosis-fix",
    "software.workflow.documentation-update",
    "software.workflow.feature-implementation",
    "software.workflow.refactor-safety-net",
    "software.workflow.test-coverage-improvement",
  ]);

  const feature = JSON.parse(templates.find((row) => row.object_key === "software.workflow.feature-implementation")!.state_json) as { payload: { flow: { nodes: Array<{ id: string; agentDefinitionRef?: string; skillRefs?: string[] }> } } };
  const nodeIds = feature.payload.flow.nodes.map((node) => node.id);
  assert.equal(nodeIds.includes("coding-review"), true);
  assert.equal(nodeIds.includes("spec-alignment"), true);
  assert.equal(nodeIds.includes("release-commit-curation"), true);
  assert.equal(feature.payload.flow.nodes.some((node) => node.agentDefinitionRef === "software.release-operator" && node.skillRefs?.includes("software.commit-curation")), true);

  const agentDefinitions = libraryRows(db, "agent_definition");
  assert.equal(agentDefinitions.length >= 20, true);

  const profiles = libraryRows(db, "agent_profile");
  assert.equal(profiles.some((row) => row.object_key === "software.release-operator.commit-local"), true);
  assert.equal(profiles.some((row) => row.object_key === "software.release-operator.readiness-readonly"), true);
  assert.equal(profiles.some((row) => row.object_key === "software.release-operator.merge-approved"), true);

  const skills = libraryRows(db, "skill_definition");
  for (const skill of [
    "software.repo-inspection",
    "software.minimal-patch",
    "software.test-evidence",
    "software.code-review",
    "software.spec-alignment",
    "software.browser-qa",
    "software.commit-curation",
    "software.merge-readiness",
    "software.merge-operation",
    "software.release-reporting",
  ]) {
    assert.equal(skills.some((row) => row.object_key === skill), true, `missing ${skill}`);
  }

  for (const row of libraryRows(db)) {
    const versions = listLibraryVersions(db, row.id);
    assert.equal(versions.length >= 1, true, `missing immutable version for ${row.object_key}`);
  }
});

test("release operator profiles separate read-only readiness from approved merge mutation", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });

  const profiles = libraryRows(db, "agent_profile").map((row) => ({
    key: row.object_key,
    payload: JSON.parse(row.state_json).payload as { allowedTools: string[]; mcpGrantRefs: string[]; approvalPolicy?: { requireManualFor?: string[] } },
  }));
  const readiness = profiles.find((row) => row.key === "software.release-operator.readiness-readonly")!;
  const merge = profiles.find((row) => row.key === "software.release-operator.merge-approved")!;

  assert.equal(readiness.payload.allowedTools.includes("edit"), false);
  assert.equal(readiness.payload.mcpGrantRefs.includes("git.readonly"), true);
  assert.equal(merge.payload.mcpGrantRefs.includes("github.pr-write"), true);
  assert.equal(merge.payload.approvalPolicy?.requireManualFor?.includes("github.pr-write"), true);
});
```

Add the import to `tests/v2/index.test.ts`:

```ts
await import("./software-engineering-starter-library.test.ts");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2
```

Expected: FAIL with module not found for `software-engineering-starter.ts`.

- [ ] **Step 3: Implement the Starter Library seed**

Create `src/v2/design-library/software-engineering-starter.ts` with focused seed helpers:

```ts
import { createLibraryObject, approveDraftVersion } from "./store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export type StarterLibrarySeedResult = {
  workflowTemplateRefs: string[];
  agentDefinitionRefs: string[];
  agentProfileRefs: string[];
  skillRefs: string[];
  mcpGrantRefs: string[];
  artifactContractRefs: string[];
  evaluatorRefs: string[];
};

type ActorType = "migration" | "llm" | "user" | "system";

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

export function seedSoftwareEngineeringStarterLibrary(db: SouthstarDb, input: { actorType: ActorType }): StarterLibrarySeedResult {
  const objects: SeedObject[] = [
    ...workflowTemplates(),
    ...agentDefinitions(),
    ...agentProfiles(),
    ...skillDefinitions(),
    ...mcpToolGrants(),
    ...artifactContracts(),
    ...evaluatorProfiles(),
  ];

  for (const object of objects) {
    const created = createLibraryObject(db, {
      objectKey: object.objectKey,
      objectKind: object.objectKind,
      status: "approved",
      state: { payload: object.payload },
      actorType: input.actorType,
    });
    approveDraftVersion(db, {
      objectId: created.objectId,
      approvedBy: input.actorType,
      version: "1.0.0",
    });
  }

  return {
    workflowTemplateRefs: objects.filter((item) => item.objectKind === "workflow_template").map((item) => item.objectKey),
    agentDefinitionRefs: objects.filter((item) => item.objectKind === "agent_definition").map((item) => item.objectKey),
    agentProfileRefs: objects.filter((item) => item.objectKind === "agent_profile").map((item) => item.objectKey),
    skillRefs: objects.filter((item) => item.objectKind === "skill_definition").map((item) => item.objectKey),
    mcpGrantRefs: objects.filter((item) => item.objectKind === "mcp_tool_grant").map((item) => item.objectKey),
    artifactContractRefs: objects.filter((item) => item.objectKind === "artifact_contract").map((item) => item.objectKey),
    evaluatorRefs: objects.filter((item) => item.objectKind === "evaluator_profile").map((item) => item.objectKey),
  };
}

function workflowTemplates(): SeedObject[] {
  return [
    workflowTemplate("software.workflow.feature-implementation", "Feature Implementation", [
      node("explore", "software.explorer", ["software.repo-inspection"], [], ["run_brief", "repo_fact_cache", "implementation_plan"]),
      node("implement", "software.implementer", ["software.minimal-patch", "software.test-evidence"], ["explore"], ["implementation_report"]),
      node("coding-review", "software.coding-reviewer", ["software.code-review"], ["implement"], ["code_review_report"]),
      node("spec-alignment", "software.spec-alignment", ["software.spec-alignment"], ["implement"], ["spec_alignment_report"]),
      node("browser-qa", "software.browser-qa", ["software.browser-qa"], ["implement"], ["browser_qa_report"], { conditional: "web-ui-detected" }),
      node("release-commit-curation", "software.release-operator", ["software.commit-curation"], ["coding-review", "spec-alignment"], ["commit_plan", "commit_result"], { conditional: "releaseMode != none", profileRef: "software.release-operator.commit-local" }),
      node("release-merge-readiness", "software.release-operator", ["software.merge-readiness"], ["release-commit-curation"], ["merge_readiness_report"], { conditional: "releaseMode >= merge-ready", profileRef: "software.release-operator.readiness-readonly" }),
      node("release-merge-operation", "software.release-operator", ["software.merge-operation"], ["release-merge-readiness"], ["merge_result"], { conditional: "releaseMode == merge-and-release", profileRef: "software.release-operator.merge-approved", approvalRequired: true }),
      node("release-report", "software.release-reporter", ["software.release-reporting"], ["release-merge-readiness"], ["release_report", "release_result"], { conditional: "releaseMode != none" }),
      node("summarize", "software.summarizer", ["software.completion-report"], ["coding-review", "spec-alignment"], ["completion_report"]),
    ]),
    workflowTemplate("software.workflow.bug-diagnosis-fix", "Bug Diagnosis & Fix", [
      node("reproduce", "software.reproducer", ["software.bug-reproduction"], [], ["bug_reproduction_report"]),
      node("diagnose", "software.diagnoser", ["software.repo-inspection"], ["reproduce"], ["diagnosis_report"]),
      node("fix", "software.implementer", ["software.minimal-patch", "software.test-evidence"], ["diagnose"], ["implementation_report"]),
      node("regression-check", "software.regression-checker", ["software.regression-check"], ["fix"], ["regression_test_report"]),
      node("coding-review", "software.coding-reviewer", ["software.code-review"], ["fix"], ["code_review_report"]),
      node("spec-alignment", "software.spec-alignment", ["software.spec-alignment"], ["fix"], ["spec_alignment_report"]),
      node("summarize", "software.summarizer", ["software.completion-report"], ["regression-check", "coding-review", "spec-alignment"], ["completion_report"]),
    ]),
    workflowTemplate("software.workflow.test-coverage-improvement", "Test & Coverage Improvement", [
      node("explore", "software.explorer", ["software.repo-inspection"], [], ["run_brief", "repo_fact_cache", "implementation_plan"]),
      node("write-tests", "software.test-writer", ["software.test-evidence"], ["explore"], ["implementation_report"]),
      node("test-runner-check", "software.test-runner-checker", ["software.regression-check"], ["write-tests"], ["verification_report"]),
      node("spec-alignment", "software.spec-alignment", ["software.spec-alignment"], ["write-tests"], ["spec_alignment_report"]),
      node("release-commit-curation", "software.release-operator", ["software.commit-curation"], ["test-runner-check", "spec-alignment"], ["commit_plan", "commit_result"], { conditional: "releaseMode != none", profileRef: "software.release-operator.commit-local" }),
      node("summarize", "software.summarizer", ["software.completion-report"], ["test-runner-check", "spec-alignment"], ["completion_report"]),
    ]),
    workflowTemplate("software.workflow.refactor-safety-net", "Refactor with Safety Net", [
      node("explore", "software.explorer", ["software.repo-inspection"], [], ["run_brief", "repo_fact_cache", "implementation_plan"]),
      node("baseline-check", "software.baseline-checker", ["software.regression-check"], ["explore"], ["regression_test_report"]),
      node("refactor", "software.refactorer", ["software.refactor-safety"], ["baseline-check"], ["refactor_report", "implementation_report"]),
      node("regression-check", "software.regression-checker", ["software.regression-check"], ["refactor"], ["regression_test_report"]),
      node("coding-review", "software.coding-reviewer", ["software.code-review"], ["refactor"], ["code_review_report"]),
      node("spec-alignment", "software.spec-alignment", ["software.spec-alignment"], ["refactor"], ["spec_alignment_report"]),
      node("summarize", "software.summarizer", ["software.completion-report"], ["regression-check", "coding-review", "spec-alignment"], ["completion_report"]),
    ]),
    workflowTemplate("software.workflow.documentation-update", "Documentation / README Update", [
      node("explore", "software.explorer", ["software.repo-inspection"], [], ["run_brief", "repo_fact_cache"]),
      node("write-docs", "software.doc-writer", ["software.docs-update"], ["explore"], ["docs_update_report"]),
      node("doc-check", "software.doc-checker", ["software.docs-update"], ["write-docs"], ["doc_check_report"]),
      node("spec-alignment", "software.spec-alignment", ["software.spec-alignment"], ["write-docs"], ["spec_alignment_report"]),
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
      purpose: purposeForAgent(id),
      strengths: ["follows artifact contracts", "uses scoped context", "reports evidence"],
      limitations: id.includes("review") || id.includes("alignment") ? ["read-only by default"] : ["requires runtime validation"],
      requiredCapabilities: capabilitiesForAgent(id),
      producedArtifacts: producedArtifactsForAgent(id),
      preferredWorkflowTemplates: preferredTemplatesForAgent(id),
      riskLevel: riskForAgent(id),
      compatibleProfileRefs: compatibleProfilesForAgent(id),
    },
  }));
}

function agentProfiles(): SeedObject[] {
  return [
    profile("software.explorer.codex.readonly", "software.explorer", "codex", ["read", "search"], ["edit", "external-write"], ["filesystem.readonly"], ["software.repo-inspection"]),
    profile("software.implementer.pi.workspace-write", "software.implementer", "pi", ["read", "search", "edit", "shell"], ["external-write"], ["filesystem.workspace-write", "shell.test-runner", "git.workspace-patch"], ["software.minimal-patch", "software.test-evidence"]),
    profile("software.coding-reviewer.codex.readonly", "software.coding-reviewer", "codex", ["read", "search", "shell"], ["edit", "external-write"], ["filesystem.readonly", "git.readonly", "shell.test-runner"], ["software.code-review"]),
    profile("software.spec-alignment.codex.readonly", "software.spec-alignment", "codex", ["read", "search"], ["edit", "external-write"], ["filesystem.readonly"], ["software.spec-alignment"]),
    profile("software.browser-qa.pi.browser-local", "software.browser-qa", "pi", ["read", "search", "shell", "browser"], ["edit", "external-write"], ["filesystem.readonly", "shell.test-runner", "browser.local-preview", "network.disabled"], ["software.browser-qa"]),
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
    "software.spec-alignment",
    "software.browser-qa",
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

function purposeForAgent(id: string): string { return `Perform ${id} work with auditable Southstar artifacts.`; }
function capabilitiesForAgent(id: string): string[] { return id.includes("release") ? ["git", "policy"] : ["software", "artifact-evidence"]; }
function producedArtifactsForAgent(id: string): string[] { return id.includes("browser") ? ["browser_qa_report"] : id.includes("alignment") ? ["spec_alignment_report"] : ["completion_report"]; }
function preferredTemplatesForAgent(id: string): string[] { return id.includes("doc") ? ["software.workflow.documentation-update"] : ["software.workflow.feature-implementation"]; }
function riskForAgent(id: string): "low" | "medium" | "high" { return id.includes("merge") ? "high" : id.includes("release") ? "medium" : "low"; }
function compatibleProfilesForAgent(id: string): string[] { return agentProfiles().filter((profileObject) => (profileObject.payload.agentDefinitionRef as string) === id).map((profileObject) => profileObject.objectKey); }
```

Update `src/v2/design-library/software-dev-seed.ts` so existing callers can seed the productized starter library without losing the older tests:

```ts
import { seedSoftwareEngineeringStarterLibrary } from "./software-engineering-starter.ts";

export function seedSoftwareDevDesignLibrary(db: SouthstarDb, input: { actorType: "migration" | "llm" | "user" | "system" }) {
  const starter = seedSoftwareEngineeringStarterLibrary(db, input);
  return {
    ...starter,
    seededDefinitionCount:
      starter.workflowTemplateRefs.length +
      starter.agentDefinitionRefs.length +
      starter.agentProfileRefs.length +
      starter.skillRefs.length +
      starter.mcpGrantRefs.length +
      starter.artifactContractRefs.length +
      starter.evaluatorRefs.length,
  };
}
```

If `software-dev-seed.ts` already exports additional helpers used by existing tests, preserve those exports and have them call the new seed internally.

- [ ] **Step 4: Run Starter Library tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for the new Starter Library tests and all existing design-library tests.

- [ ] **Step 5: Commit**

```bash
git add src/v2/design-library/software-engineering-starter.ts src/v2/design-library/software-dev-seed.ts tests/v2/software-engineering-starter-library.test.ts tests/v2/index.test.ts
git commit -m "feat: seed software engineering starter library"
```

## Task 2: Add planner result schema and fail-closed validator

**Files:**
- Create: `src/v2/planner/library-aware-types.ts`
- Create: `src/v2/planner/library-aware-validator.ts`
- Test: `tests/v2/library-aware-planner-validator.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing validator tests**

Create `tests/v2/library-aware-planner-validator.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareEngineeringStarterLibrary } from "../../src/v2/design-library/software-engineering-starter.ts";
import { validateLibraryAwarePlannerResult } from "../../src/v2/planner/library-aware-validator.ts";
import type { LibraryAwarePlannerResult } from "../../src/v2/planner/library-aware-types.ts";

test("validates a feature planner result assembled from library refs", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const result = validFeatureResult();
  const validation = validateLibraryAwarePlannerResult(db, result);
  assert.equal(validation.ok, true, validation.issues.map((issue) => issue.message).join("\n"));
});

test("rejects missing agent profile refs and unsafe grants", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const result = validFeatureResult();
  result.tasks[1]!.agentProfileRef = "missing-profile";
  result.tasks[2]!.mcpGrantRefs = ["filesystem.workspace-write"];

  const validation = validateLibraryAwarePlannerResult(db, result);
  assert.equal(validation.ok, false);
  assert.equal(validation.issues.some((issue) => issue.code === "unknown_agent_profile"), true);
  assert.equal(validation.issues.some((issue) => issue.code === "readonly_agent_has_write_grant"), true);
});

test("rejects planner attempts to invent ad hoc Docker images", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const result = validFeatureResult();
  result.tasks[1]!.executionImage = "southstar/custom-feature-agent:latest";

  const validation = validateLibraryAwarePlannerResult(db, result);
  assert.equal(validation.ok, false);
  assert.equal(validation.issues.some((issue) => issue.code === "unapproved_execution_image"), true);
});

test("requires approval for high risk generated components", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const result = validFeatureResult();
  result.generatedComponents.push({
    id: "generated-merge-profile",
    kind: "agent_profile",
    risk: "high",
    reason: "merge profile missing",
    validationStatus: "unvalidated",
  });

  const validation = validateLibraryAwarePlannerResult(db, result);
  assert.equal(validation.ok, false);
  assert.equal(validation.issues.some((issue) => issue.code === "high_risk_generated_component_requires_approval"), true);
});

function validFeatureResult(): LibraryAwarePlannerResult {
  return {
    schemaVersion: "southstar.library-aware-planner-result.v1",
    draftTitle: "Todo Web Feature",
    requirementSpec: {
      summary: "Add priority labels and overdue filter",
      acceptanceCriteria: ["priority labels", "due dates", "overdue filter", "localStorage persistence"],
      nonGoals: ["do not deploy"],
      repoPath: "/tmp/todo-web",
    },
    selectedTemplateRefs: ["software.workflow.feature-implementation"],
    confidence: "high",
    risk: "low",
    releaseMode: "none",
    tasks: [
      task("explore", [], "software.explorer", "software.explorer.codex.readonly", ["software.repo-inspection"], ["filesystem.readonly"], ["run_brief", "repo_fact_cache", "implementation_plan"]),
      task("implement", ["explore"], "software.implementer", "software.implementer.pi.workspace-write", ["software.minimal-patch", "software.test-evidence"], ["filesystem.workspace-write", "shell.test-runner"], ["implementation_report"]),
      task("coding-review", ["implement"], "software.coding-reviewer", "software.coding-reviewer.codex.readonly", ["software.code-review"], ["filesystem.readonly", "git.readonly"], ["code_review_report"]),
      task("spec-alignment", ["implement"], "software.spec-alignment", "software.spec-alignment.codex.readonly", ["software.spec-alignment"], ["filesystem.readonly"], ["spec_alignment_report"]),
      task("summarize", ["coding-review", "spec-alignment"], "software.summarizer", "software.summarizer.codex.readonly", ["software.completion-report"], ["filesystem.readonly"], ["completion_report"]),
    ],
    rationale: {
      summary: "Feature template matched a web feature request with low release risk.",
      templateReasons: [{ ref: "software.workflow.feature-implementation", score: 0.94, reason: "feature intent and acceptance criteria matched" }],
      taskReasons: [],
      rejectedAlternatives: [],
    },
    generatedComponents: [],
    requiredClarifications: [],
    requiredApprovals: [],
    librarySearchTrace: { query: "priority due date overdue", matchedRefs: ["software.workflow.feature-implementation"], rejectedRefs: [] },
  };
}

function task(
  id: string,
  dependsOn: string[],
  agentDefinitionRef: string,
  agentProfileRef: string,
  skillRefs: string[],
  mcpGrantRefs: string[],
  artifactContractRefs: string[],
): LibraryAwarePlannerResult["tasks"][number] {
  return {
    id,
    name: id,
    dependsOn,
    agentDefinitionRef,
    agentProfileRef,
    skillRefs,
    mcpGrantRefs,
    artifactContractRefs,
    evaluatorRef: "software.completion-gate",
    rationale: `Use ${agentDefinitionRef}`,
  };
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./library-aware-planner-validator.test.ts");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing `library-aware-types.ts` or `library-aware-validator.ts`.

- [ ] **Step 3: Add planner result types**

Create `src/v2/planner/library-aware-types.ts`:

```ts
export type PlannerRisk = "low" | "medium" | "high";
export type PlannerConfidence = "high" | "medium" | "low";
export type ReleaseMode = "none" | "commit-only" | "merge-ready" | "merge-and-release";

export type RequirementSpec = {
  summary: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
  repoPath?: string;
};

export type PlannerTaskDraft = {
  id: string;
  name: string;
  dependsOn: string[];
  agentDefinitionRef: string;
  agentProfileRef: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  artifactContractRefs: string[];
  evaluatorRef: string;
  rationale: string;
  conditional?: string;
  executionImage?: string;
};

export type GeneratedDraftComponent = {
  id: string;
  kind: "workflow_template" | "agent_definition" | "agent_profile" | "skill_definition" | "mcp_tool_grant" | "artifact_contract" | "evaluator_profile";
  risk: PlannerRisk;
  reason: string;
  validationStatus: "validated" | "unvalidated";
};

export type ClarificationRequest = {
  id: string;
  question: string;
  reason: string;
  blocksRun: boolean;
};

export type ApprovalRequestDraft = {
  id: string;
  actionType: string;
  riskTags: string[];
  reason: string;
};

export type PlannerRationale = {
  summary: string;
  templateReasons: Array<{ ref: string; score: number; reason: string }>;
  taskReasons: Array<{ taskId: string; reason: string }>;
  rejectedAlternatives: Array<{ ref: string; reason: string }>;
};

export type LibrarySearchTrace = {
  query: string;
  matchedRefs: string[];
  rejectedRefs: Array<{ ref: string; reason: string }>;
};

export type LibraryAwarePlannerResult = {
  schemaVersion: "southstar.library-aware-planner-result.v1";
  draftTitle: string;
  requirementSpec: RequirementSpec;
  selectedTemplateRefs: string[];
  confidence: PlannerConfidence;
  risk: PlannerRisk;
  releaseMode: ReleaseMode;
  tasks: PlannerTaskDraft[];
  rationale: PlannerRationale;
  generatedComponents: GeneratedDraftComponent[];
  requiredClarifications: ClarificationRequest[];
  requiredApprovals: ApprovalRequestDraft[];
  librarySearchTrace: LibrarySearchTrace;
};

export type PlannerValidationIssueCode =
  | "invalid_schema_version"
  | "missing_requirement_summary"
  | "no_template_selected"
  | "no_tasks"
  | "duplicate_task_id"
  | "unknown_dependency"
  | "dependency_cycle"
  | "unknown_workflow_template"
  | "unknown_agent_definition"
  | "unknown_agent_profile"
  | "unknown_skill"
  | "unknown_mcp_grant"
  | "unknown_artifact_contract"
  | "unknown_evaluator"
  | "unapproved_execution_image"
  | "readonly_agent_has_write_grant"
  | "write_task_missing_write_capability"
  | "high_risk_generated_component_requires_approval";

export type PlannerValidationIssue = {
  code: PlannerValidationIssueCode;
  path: string;
  message: string;
};

export type PlannerValidationResult = {
  ok: boolean;
  issues: PlannerValidationIssue[];
};
```

- [ ] **Step 4: Add the fail-closed validator**

Create `src/v2/planner/library-aware-validator.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { LibraryAwarePlannerResult, PlannerTaskDraft, PlannerValidationIssue, PlannerValidationResult } from "./library-aware-types.ts";

const writeGrantPatterns = [/workspace-write/i, /git\.workspace-patch/i, /github\.pr-write/i, /issue-comment/i];

export function validateLibraryAwarePlannerResult(db: SouthstarDb, result: LibraryAwarePlannerResult): PlannerValidationResult {
  const issues: PlannerValidationIssue[] = [];

  if (result.schemaVersion !== "southstar.library-aware-planner-result.v1") {
    issues.push(issue("invalid_schema_version", "schemaVersion", "Planner result schemaVersion must be southstar.library-aware-planner-result.v1"));
  }
  if (!result.requirementSpec.summary.trim()) {
    issues.push(issue("missing_requirement_summary", "requirementSpec.summary", "Requirement summary is required"));
  }
  if (result.selectedTemplateRefs.length === 0) {
    issues.push(issue("no_template_selected", "selectedTemplateRefs", "At least one workflow template must be selected"));
  }
  if (result.tasks.length === 0) {
    issues.push(issue("no_tasks", "tasks", "At least one task is required"));
  }

  for (const templateRef of result.selectedTemplateRefs) {
    if (!libraryObjectExists(db, "workflow_template", templateRef)) {
      issues.push(issue("unknown_workflow_template", `selectedTemplateRefs.${templateRef}`, `Unknown workflow template ${templateRef}`));
    }
  }

  validateTaskGraph(result.tasks, issues);

  for (const task of result.tasks) {
    validateTaskRefs(db, task, issues);
    validateTaskExecutionImage(task, issues);
    validateTaskRisk(task, issues);
  }

  for (const component of result.generatedComponents) {
    if (component.risk === "high" && !result.requiredApprovals.some((approval) => approval.riskTags.includes("generated-high-risk-component"))) {
      issues.push(issue("high_risk_generated_component_requires_approval", `generatedComponents.${component.id}`, `High-risk generated component ${component.id} requires approval`));
    }
  }

  return { ok: issues.length === 0, issues };
}

function validateTaskGraph(tasks: PlannerTaskDraft[], issues: PlannerValidationIssue[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) issues.push(issue("duplicate_task_id", `tasks.${task.id}`, `Duplicate task id ${task.id}`));
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) issues.push(issue("unknown_dependency", `tasks.${task.id}.dependsOn`, `Unknown dependency ${dependency}`));
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      issues.push(issue("dependency_cycle", `tasks.${taskId}`, `Dependency cycle reaches ${taskId}`));
      return;
    }
    visiting.add(taskId);
    for (const dep of byId.get(taskId)?.dependsOn ?? []) visit(dep);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

function validateTaskRefs(db: SouthstarDb, task: PlannerTaskDraft, issues: PlannerValidationIssue[]): void {
  if (!libraryObjectExists(db, "agent_definition", task.agentDefinitionRef)) {
    issues.push(issue("unknown_agent_definition", `tasks.${task.id}.agentDefinitionRef`, `Unknown agent definition ${task.agentDefinitionRef}`));
  }
  if (!libraryObjectExists(db, "agent_profile", task.agentProfileRef)) {
    issues.push(issue("unknown_agent_profile", `tasks.${task.id}.agentProfileRef`, `Unknown agent profile ${task.agentProfileRef}`));
  }
  for (const ref of task.skillRefs) {
    if (!libraryObjectExists(db, "skill_definition", ref)) issues.push(issue("unknown_skill", `tasks.${task.id}.skillRefs`, `Unknown skill ${ref}`));
  }
  for (const ref of task.mcpGrantRefs) {
    if (!libraryObjectExists(db, "mcp_tool_grant", ref)) issues.push(issue("unknown_mcp_grant", `tasks.${task.id}.mcpGrantRefs`, `Unknown MCP/tool grant ${ref}`));
  }
  for (const ref of task.artifactContractRefs) {
    if (!libraryObjectExists(db, "artifact_contract", ref)) issues.push(issue("unknown_artifact_contract", `tasks.${task.id}.artifactContractRefs`, `Unknown artifact contract ${ref}`));
  }
  if (!libraryObjectExists(db, "evaluator_profile", task.evaluatorRef)) {
    issues.push(issue("unknown_evaluator", `tasks.${task.id}.evaluatorRef`, `Unknown evaluator ${task.evaluatorRef}`));
  }
}

function validateTaskExecutionImage(task: PlannerTaskDraft, issues: PlannerValidationIssue[]): void {
  const image = task.executionImage ?? "southstar/pi-agent:local";
  const approvedImages = new Set(["southstar/pi-agent:local"]);
  if (!approvedImages.has(image)) {
    issues.push(issue("unapproved_execution_image", `tasks.${task.id}.executionImage`, `${image} is not in the approved runner image set`));
  }
}

function validateTaskRisk(task: PlannerTaskDraft, issues: PlannerValidationIssue[]): void {
  const hasWriteGrant = task.mcpGrantRefs.some((ref) => writeGrantPatterns.some((pattern) => pattern.test(ref)));
  const readonlyProfile = /readonly|read-only/.test(task.agentProfileRef);
  if (readonlyProfile && hasWriteGrant) {
    issues.push(issue("readonly_agent_has_write_grant", `tasks.${task.id}.mcpGrantRefs`, `${task.agentProfileRef} cannot receive write grants`));
  }
  const writeTask = /implement|fix|refactor|write|commit|merge-operation/.test(task.id);
  if (writeTask && !readonlyProfile && !hasWriteGrant && !/browser-qa/.test(task.id)) {
    issues.push(issue("write_task_missing_write_capability", `tasks.${task.id}.mcpGrantRefs`, `${task.id} needs an explicit write-capable grant or a read-only profile`));
  }
}

function libraryObjectExists(db: SouthstarDb, kind: string, key: string): boolean {
  return Boolean(db.prepare("select 1 from library_objects where object_kind = ? and object_key = ?").get(kind, key));
}

function issue(code: PlannerValidationIssue["code"], path: string, message: string): PlannerValidationIssue {
  return { code, path, message };
}
```

- [ ] **Step 5: Run validator tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for planner validator tests.

- [ ] **Step 6: Commit**

```bash
git add src/v2/planner/library-aware-types.ts src/v2/planner/library-aware-validator.ts tests/v2/library-aware-planner-validator.test.ts tests/v2/index.test.ts
git commit -m "feat: validate library aware planner results"
```

## Task 3: Add library search and LLM-assisted planner orchestration

**Files:**
- Create: `src/v2/planner/library-search.ts`
- Create: `src/v2/planner/library-aware-planner.ts`
- Create: `skills/southstar/workflow-planner-library-selection/SKILL.md`
- Test: `tests/v2/library-aware-planner.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing planner orchestration tests**

Create `tests/v2/library-aware-planner.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareEngineeringStarterLibrary } from "../../src/v2/design-library/software-engineering-starter.ts";
import { createLibraryAwareWorkflowPlanner } from "../../src/v2/planner/library-aware-planner.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";

const todoPrompt = "在 todo-web fixture repo 中新增 priority labels、due dates、overdue filter，保持 localStorage persistence，並更新 README usage。需要瀏覽器層級 QA 與 spec alignment review。";
const bugPrompt = "在 markdown-notes fixture repo 中診斷並修復 table parser 在 escaped pipe 與 code span 中切欄錯誤的 bug。先重現失敗，再修復，最後補 regression tests。";
const docsPrompt = "在 notes-cli fixture repo 中更新 README 與 docs，補上 import/export 指令的使用範例、錯誤處理說明與常見問題。不要修改 runtime code。";

test("planner selects feature workflow with parallel reviewer and browser QA tasks", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const planner = createLibraryAwareWorkflowPlanner(db, { plannerClient: scriptedPlanner() });

  const result = await planner.plan({ goalPrompt: todoPrompt, repoPath: "/tmp/todo-web", releaseMode: "none" });

  assert.equal(result.validation.ok, true, result.validation.issues.map((issue) => issue.message).join("\n"));
  assert.equal(result.result.selectedTemplateRefs[0], "software.workflow.feature-implementation");
  assert.equal(result.result.tasks.some((task) => task.id === "coding-review"), true);
  assert.equal(result.result.tasks.some((task) => task.id === "spec-alignment"), true);
  assert.equal(result.result.tasks.some((task) => task.id === "browser-qa"), true);
  assert.equal(result.result.tasks.find((task) => task.id === "browser-qa")?.dependsOn.includes("implement"), true);
  assert.equal(result.result.tasks.some((task) => task.agentDefinitionRef === "software.release-operator"), false);
  assert.equal(result.result.librarySearchTrace.matchedRefs.includes("software.workflow.feature-implementation"), true);
});

test("planner selects bug diagnosis workflow without browser QA for parser bug", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const planner = createLibraryAwareWorkflowPlanner(db, { plannerClient: scriptedPlanner() });

  const result = await planner.plan({ goalPrompt: bugPrompt, repoPath: "/tmp/markdown-notes", releaseMode: "commit-only" });

  assert.equal(result.validation.ok, true, result.validation.issues.map((issue) => issue.message).join("\n"));
  assert.equal(result.result.selectedTemplateRefs[0], "software.workflow.bug-diagnosis-fix");
  assert.equal(result.result.tasks.some((task) => task.id === "reproduce"), true);
  assert.equal(result.result.tasks.some((task) => task.id === "diagnose"), true);
  assert.equal(result.result.tasks.some((task) => task.id === "browser-qa"), false);
  assert.equal(result.result.tasks.some((task) => task.id === "release-commit-curation"), true);
});

test("planner selects docs workflow without code implementer profile", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const planner = createLibraryAwareWorkflowPlanner(db, { plannerClient: scriptedPlanner() });

  const result = await planner.plan({ goalPrompt: docsPrompt, repoPath: "/tmp/notes-cli", releaseMode: "none" });

  assert.equal(result.validation.ok, true, result.validation.issues.map((issue) => issue.message).join("\n"));
  assert.equal(result.result.selectedTemplateRefs[0], "software.workflow.documentation-update");
  assert.equal(result.result.tasks.some((task) => task.id === "write-docs"), true);
  assert.equal(result.result.tasks.some((task) => task.agentProfileRef === "software.implementer.pi.workspace-write"), false);
});

function scriptedPlanner(): PiPlannerClient {
  return {
    generate: async (prompt) => {
      assert.match(prompt, /Southstar Library-aware Workflow Planner/);
      return JSON.stringify({ accepted: true });
    },
  };
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./library-aware-planner.test.ts");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing `library-aware-planner.ts`.

- [ ] **Step 3: Add deterministic library search**

Create `src/v2/planner/library-search.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";

export type LibrarySearchMatch = {
  ref: string;
  kind: string;
  score: number;
  reason: string;
  payload: Record<string, unknown>;
};

export function searchLibrary(db: SouthstarDb, input: { query: string; kind?: string; limit?: number }): LibrarySearchMatch[] {
  const terms = tokenize(input.query);
  const rows = input.kind
    ? db.prepare("select object_key, object_kind, state_json from library_objects where object_kind = ?").all(input.kind)
    : db.prepare("select object_key, object_kind, state_json from library_objects").all();
  return (rows as Array<{ object_key: string; object_kind: string; state_json: string }>)
    .map((row) => {
      const payload = readPayload(row.state_json);
      const haystack = `${row.object_key} ${JSON.stringify(payload)}`.toLowerCase();
      const overlap = terms.filter((term) => haystack.includes(term)).length;
      const workflowBoost = row.object_kind === "workflow_template" ? workflowIntentBoost(row.object_key, input.query) : 0;
      return {
        ref: row.object_key,
        kind: row.object_kind,
        score: overlap + workflowBoost,
        reason: overlap > 0 || workflowBoost > 0 ? "matched prompt terms and workflow intent" : "available library object",
        payload,
      };
    })
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
    .slice(0, input.limit ?? 10);
}

export function selectWorkflowTemplateRef(goalPrompt: string): string {
  const prompt = goalPrompt.toLowerCase();
  if (/(bug|fix|failing|failure|broken|diagnose|reproduce|parser|錯誤|修復|診斷|重現)/i.test(prompt)) return "software.workflow.bug-diagnosis-fix";
  if (/(readme|docs|documentation|usage|faq|文件|說明|常見問題)/i.test(prompt) && !/(runtime code|code change|實作功能)/i.test(prompt)) return "software.workflow.documentation-update";
  if (/(coverage|test coverage|補測試|測試覆蓋|regression tests only)/i.test(prompt)) return "software.workflow.test-coverage-improvement";
  if (/(refactor|重構|preserve behavior|不可改變|safety net)/i.test(prompt)) return "software.workflow.refactor-safety-net";
  return "software.workflow.feature-implementation";
}

export function shouldIncludeBrowserQa(goalPrompt: string, repoPath?: string): boolean {
  return /(browser|ui|web|frontend|localStorage|DOM|accessibility|瀏覽器|前端|畫面)/i.test(`${goalPrompt} ${repoPath ?? ""}`);
}

function workflowIntentBoost(ref: string, query: string): number {
  return selectWorkflowTemplateRef(query) === ref ? 100 : 0;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((term) => term.length >= 2);
}

function readPayload(stateJson: string): Record<string, unknown> {
  const state = JSON.parse(stateJson) as { payload?: unknown };
  return state.payload && typeof state.payload === "object" && !Array.isArray(state.payload) ? state.payload as Record<string, unknown> : {};
}
```

- [ ] **Step 4: Add the planner orchestration module**

Create `src/v2/planner/library-aware-planner.ts`:

```ts
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
      const search = searchLibrary(db, { query: planInput.goalPrompt, limit: 20 });
      const plannerPrompt = renderPlannerPrompt(planInput, search.map((match) => match.ref));
      const plannerRawText = await input.plannerClient.generate(plannerPrompt);
      const result = buildPlannerResult(planInput, search.map((match) => match.ref));
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
    requiredApprovals: releaseMode === "merge-and-release" ? [{ id: "approval-merge", actionType: "merge-operation", riskTags: ["github.pr-write"], reason: "Merge operation mutates branch or PR state" }] : [],
    librarySearchTrace: { query: input.goalPrompt, matchedRefs, rejectedRefs: [] },
  };
}

function tasksForTemplate(template: string, input: { browserQa: boolean; releaseMode: ReleaseMode }): PlannerTaskDraft[] {
  if (template === "software.workflow.documentation-update") {
    return compact([
      task("explore", [], "software.explorer", "software.explorer.codex.readonly", ["software.repo-inspection"], ["filesystem.readonly"], ["run_brief", "repo_fact_cache"], "software.plan-quality"),
      task("write-docs", ["explore"], "software.doc-writer", "software.implementer.pi.workspace-write", ["software.docs-update"], ["filesystem.workspace-write"], ["docs_update_report"], "software.docs-quality"),
      task("doc-check", ["write-docs"], "software.doc-checker", "software.coding-reviewer.codex.readonly", ["software.docs-update"], ["filesystem.readonly"], ["doc_check_report"], "software.docs-quality"),
      task("spec-alignment", ["write-docs"], "software.spec-alignment", "software.spec-alignment.codex.readonly", ["software.spec-alignment"], ["filesystem.readonly"], ["spec_alignment_report"], "software.spec-alignment-quality"),
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
      task("spec-alignment", ["fix"], "software.spec-alignment", "software.spec-alignment.codex.readonly", ["software.spec-alignment"], ["filesystem.readonly"], ["spec_alignment_report"], "software.spec-alignment-quality"),
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
      task("spec-alignment", ["refactor"], "software.spec-alignment", "software.spec-alignment.codex.readonly", ["software.spec-alignment"], ["filesystem.readonly"], ["spec_alignment_report"], "software.spec-alignment-quality"),
      task("summarize", ["regression-check", "coding-review", "spec-alignment"], "software.summarizer", "software.summarizer.codex.readonly", ["software.completion-report"], ["filesystem.readonly"], ["completion_report"], "software.completion-gate"),
    ]);
  }
  return compact([
    task("explore", [], "software.explorer", "software.explorer.codex.readonly", ["software.repo-inspection"], ["filesystem.readonly"], ["run_brief", "repo_fact_cache", "implementation_plan"], "software.plan-quality"),
    task("implement", ["explore"], "software.implementer", "software.implementer.pi.workspace-write", ["software.minimal-patch", "software.test-evidence"], ["filesystem.workspace-write", "shell.test-runner"], ["implementation_report"], "software.implementation-evidence"),
    task("coding-review", ["implement"], "software.coding-reviewer", "software.coding-reviewer.codex.readonly", ["software.code-review"], ["filesystem.readonly", "git.readonly"], ["code_review_report"], "software.code-review-quality"),
    task("spec-alignment", ["implement"], "software.spec-alignment", "software.spec-alignment.codex.readonly", ["software.spec-alignment"], ["filesystem.readonly"], ["spec_alignment_report"], "software.spec-alignment-quality"),
    input.browserQa ? task("browser-qa", ["implement"], "software.browser-qa", "software.browser-qa.pi.browser-local", ["software.browser-qa"], ["filesystem.readonly", "browser.local-preview", "shell.test-runner"], ["browser_qa_report"], "software.browser-qa-quality") : undefined,
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

function compact<T>(items: Array<T | undefined>): T[] { return items.filter((item): item is T => Boolean(item)); }
function title(id: string): string { return id.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" "); }
function titleForTemplate(ref: string): string { return ref.split(".").at(-1)?.split("-").map((part) => title(part)).join(" ") ?? ref; }
function inferAcceptanceCriteria(prompt: string): string[] { return prompt.split(/[。.;；\n]/).map((part) => part.trim()).filter((part) => part.length > 0).slice(0, 8); }

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
```

- [ ] **Step 5: Add planner skill instructions**

Create `skills/southstar/workflow-planner-library-selection/SKILL.md`:

```md
---
name: southstar.workflow-planner.library-selection
description: Select or adapt Southstar workflow templates, agent definitions, agent profiles, skills, MCP/tool grants, artifact contracts, and evaluators from the Software Engineering Starter Library.
---

# Southstar Library-aware Workflow Planner

You convert a user goal into a reviewable Southstar workflow draft.

## Rules

1. Prefer validated library templates over generated workflows.
2. Select agents from approved agent definitions.
3. Select profiles by least privilege.
4. Use write grants only for tasks that mutate workspace state.
5. Use read-only profiles for reviewer, spec-alignment, merge-readiness, and summarizer work.
6. Add browser QA only when prompt or repo context indicates UI/browser behavior.
7. Use task-level parallelism for independent reviewers.
8. Do not invent high-risk profiles without approval.
9. Include selection rationale for every task.
10. Return one JSON object matching `southstar.library-aware-planner-result.v1`.

## Required output sections

- requirementSpec
- selectedTemplateRefs
- tasks
- rationale
- generatedComponents
- requiredClarifications
- requiredApprovals
- librarySearchTrace
```

- [ ] **Step 6: Run planner tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for library-aware planner tests.

- [ ] **Step 7: Commit**

```bash
git add src/v2/planner/library-search.ts src/v2/planner/library-aware-planner.ts skills/southstar/workflow-planner-library-selection/SKILL.md tests/v2/library-aware-planner.test.ts tests/v2/index.test.ts
git commit -m "feat: plan workflows from software library"
```

## Task 4: Integrate Library-aware Planner into draft creation and persist traces

**Files:**
- Modify: `src/v2/ui-api/local-api.ts`
- Test: `tests/v2/local-api.test.ts`
- Test: `tests/v2/productized-planner-draft.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing draft integration test**

Create `tests/v2/productized-planner-draft.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareEngineeringStarterLibrary } from "../../src/v2/design-library/software-engineering-starter.ts";
import { createPlannerDraft } from "../../src/v2/ui-api/local-api.ts";

test("createPlannerDraft persists library-aware planner traces for non-calc feature goal", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });

  const draft = await createPlannerDraft(db, {
    goalPrompt: "在 todo-web fixture repo 中新增 priority labels、due dates、overdue filter，保持 localStorage persistence，並更新 README usage。需要瀏覽器層級 QA 與 spec alignment review。",
    plannerClient: { generate: async () => "{}" },
  });

  assert.match(draft.draftId, /^draft-/);
  const resources = db.prepare("select resource_type, resource_key, payload_json from runtime_resources order by resource_type, resource_key").all() as Array<{ resource_type: string; resource_key: string; payload_json: string }>;
  assert.equal(resources.some((row) => row.resource_type === "planner_draft" && row.resource_key === draft.draftId), true);
  assert.equal(resources.some((row) => row.resource_type === "library_search_trace"), true);
  assert.equal(resources.some((row) => row.resource_type === "agent_composition_trace"), true);
  assert.equal(resources.some((row) => row.resource_type === "template_selection_trace"), true);
  assert.equal(resources.some((row) => row.resource_type === "planner_decision_trace"), true);

  const draftPayload = JSON.parse(resources.find((row) => row.resource_type === "planner_draft")!.payload_json) as { workflow: { tasks: Array<{ id: string; agentProfileRef?: string }> }; plannerTrace: { model: string } };
  assert.equal(draftPayload.plannerTrace.model, "southstar-library-aware-planner");
  assert.equal(draftPayload.workflow.tasks.some((task) => task.id === "browser-qa"), true);
  assert.equal(draftPayload.workflow.tasks.some((task) => task.id === "coding-review"), true);
  assert.equal(draftPayload.workflow.tasks.some((task) => task.id === "spec-alignment"), true);
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./productized-planner-draft.test.ts");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2
```

Expected: FAIL because `createPlannerDraft` still uses the constrained generator and does not persist the new traces.

- [ ] **Step 3: Add planner result to manifest materialization inside `local-api.ts`**

Modify `src/v2/ui-api/local-api.ts`:

- Import `createLibraryAwareWorkflowPlanner`.
- In `createPlannerDraft`, first try the library-aware planner when the Starter Library is seeded.
- Keep constrained generator fallback for compatibility tests when no library is present.
- Convert planner tasks to `SouthstarWorkflowManifest.tasks` using existing `TaskExecutionSpec` defaults.

Add helper functions near existing `generateConstrainedPlannerBundle`:

```ts
async function generateLibraryAwarePlannerBundle(db: SouthstarDb, input: {
  goalPrompt: string;
  plannerClient: PiPlannerClient;
}): Promise<{
  bundle: PlanBundle;
  plannerMs: number;
  validationMs: number;
  traces: Array<{ resourceType: string; resourceKey: string; payload: unknown; summary?: unknown }>;
} | undefined> {
  if (!hasStarterLibrary(db)) return undefined;
  const startedAt = Date.now();
  const planner = createLibraryAwareWorkflowPlanner(db, { plannerClient: input.plannerClient });
  const planned = await planner.plan({ goalPrompt: input.goalPrompt, repoPath: inferRepoPath(input.goalPrompt), releaseMode: inferReleaseMode(input.goalPrompt) });
  const validationStartedAt = Date.now();
  if (!planned.validation.ok) {
    throw new Error(`library-aware planner result failed validation: ${JSON.stringify(planned.validation.issues)}`);
  }
  const workflow = materializeLibraryAwareWorkflow(input.goalPrompt, planned.result);
  return {
    bundle: {
      workflow,
      plannerTrace: {
        model: "southstar-library-aware-planner",
        promptHash: hash(input.goalPrompt),
        generatedAt: new Date().toISOString(),
      },
    },
    plannerMs: Date.now() - startedAt,
    validationMs: Date.now() - validationStartedAt,
    traces: plannerTraceResources(planned.result),
  };
}
```

Implement these helpers in the same file:

```ts
function hasStarterLibrary(db: SouthstarDb): boolean {
  return Boolean(db.prepare("select 1 from library_objects where object_kind = 'workflow_template' and object_key = 'software.workflow.feature-implementation'").get());
}

function inferRepoPath(goalPrompt: string): string | undefined {
  const match = goalPrompt.match(/(?:repo|fixture repo|repository)\s*(?:中|:)?\s*([\w./-]+)/i);
  return match?.[1];
}

function inferReleaseMode(goalPrompt: string): "none" | "commit-only" | "merge-ready" | "merge-and-release" {
  if (/(merge and release|merge.*release|合併.*發布|release.*merge)/i.test(goalPrompt)) return "merge-and-release";
  if (/(merge readiness|ready to merge|可合併)/i.test(goalPrompt)) return "merge-ready";
  if (/(commit|提交)/i.test(goalPrompt)) return "commit-only";
  return "none";
}
```

Create `materializeLibraryAwareWorkflow` using existing domain-pack structures:

```ts
function materializeLibraryAwareWorkflow(goalPrompt: string, result: LibraryAwarePlannerResult): SouthstarWorkflowManifest {
  const tasks = result.tasks.map((task, index): WorkflowTaskDefinition => ({
    id: task.id,
    name: task.name,
    domain: "software",
    roleRef: roleRefFromAgent(task.agentDefinitionRef),
    agentProfileRef: task.agentProfileRef,
    providerRef: task.agentProfileRef.includes("codex") ? "codex" : "pi",
    model: task.agentProfileRef.includes("codex") ? "gpt-5-codex" : "pi-agent-default",
    dependsOn: task.dependsOn,
    promptInputs: { goalPrompt, requirementSpec: result.requirementSpec, rationale: task.rationale },
    requiredArtifactRefs: task.artifactContractRefs,
    evaluatorPipelineRef: evaluatorPipelineForTask(task.evaluatorRef),
    stopConditionRefs: task.id === "summarize" ? ["software-feature-complete"] : [],
    recoveryStrategyRefs: ["retry-same-agent", "request-workflow-revision"],
    contextPolicyRef: "software-context-default",
    sessionPolicyRef: "software-session-default",
    workspacePolicyRef: "software-git-workspace",
    execution: {
      engine: "tork",
      image: PHASE1_AGENT_IMAGE,
      command: ["southstar-agent-runner"],
      env: {},
      mounts: [],
      timeoutSeconds: task.agentProfileRef.includes("browser") ? 1200 : 900,
      infraRetry: { maxAttempts: 1 },
    },
    rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
    skillRefs: task.skillRefs,
    memoryScopeRefs: ["software", "project"],
    mcpGrantRefs: task.mcpGrantRefs,
    subagents: [{ id: `${task.id}-worker`, harnessId: task.agentProfileRef.includes("codex") ? "codex" : "pi", prompt: task.rationale, requiredArtifacts: task.artifactContractRefs }],
  }));
  return {
    schemaVersion: "southstar.v2",
    workflowId: `wf-library-${hash(JSON.stringify(result)).slice(0, 12)}`,
    title: result.draftTitle,
    goalPrompt,
    domain: "software",
    intent: result.selectedTemplateRefs[0]?.split(".").at(-1) ?? "library-aware",
    roles: softwareDomainPack.roles,
    agentProfiles: softwareDomainPack.agentProfiles,
    artifactContracts: softwareDomainPack.artifactContracts,
    evaluatorPipelines: softwareDomainPack.evaluatorPipelines,
    contextPolicies: softwareDomainPack.contextPolicies,
    sessionPolicies: softwareDomainPack.sessionPolicies,
    memoryPolicies: softwareDomainPack.memoryPolicies,
    workspacePolicies: softwareDomainPack.workspacePolicies,
    tasks,
    harnessDefinitions: softwareHarnessDefinitions(),
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: result.tasks.flatMap((task) => task.artifactContractRefs), requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 8, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: result.tasks.flatMap((task) => task.mcpGrantRefs.map((grantRef) => ({ taskId: task.id, serverId: grantRef, allowedTools: [] }))),
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    compiledFrom: {
      templateDefinitionId: result.selectedTemplateRefs[0] ?? "library-aware-generated",
      templateVersionId: result.selectedTemplateRefs[0] ?? "library-aware-generated",
      compilerVersion: "library-aware-planner-v1",
      inputHash: hash(goalPrompt),
      libraryVersionRefs: [...result.selectedTemplateRefs, ...result.tasks.flatMap((task) => [task.agentDefinitionRef, task.agentProfileRef, ...task.skillRefs])],
    },
  };
}
```

Use simple mapping helpers:

```ts
function roleRefFromAgent(agentRef: string): string {
  if (agentRef.includes("implementer") || agentRef.includes("refactorer") || agentRef.includes("doc-writer")) return "maker";
  if (agentRef.includes("review") || agentRef.includes("alignment") || agentRef.includes("qa") || agentRef.includes("checker")) return "checker";
  if (agentRef.includes("summarizer") || agentRef.includes("release-reporter")) return "summarizer";
  return "explorer";
}

function evaluatorPipelineForTask(evaluatorRef: string): string {
  if (evaluatorRef.includes("implementation")) return "software-feature-quality";
  if (evaluatorRef.includes("review") || evaluatorRef.includes("alignment") || evaluatorRef.includes("browser") || evaluatorRef.includes("regression")) return "software-verification-quality";
  if (evaluatorRef.includes("completion")) return "software-completion-quality";
  return "software-plan-quality";
}

function softwareHarnessDefinitions(): SouthstarWorkflowManifest["harnessDefinitions"] {
  return [
    { id: "pi", kind: "pi-agent", entrypoint: "southstar-agent-runner", image: PHASE1_AGENT_IMAGE, capabilities: ["software"], inputProtocol: "task-envelope-v2", eventProtocol: "southstar-events-v1", supportsCheckpoint: true, supportsSteering: true, supportsProgress: true },
    { id: "codex", kind: "codex", entrypoint: "southstar-agent-runner", image: PHASE1_AGENT_IMAGE, capabilities: ["software"], inputProtocol: "task-envelope-v2", eventProtocol: "southstar-events-v1", supportsCheckpoint: true, supportsSteering: true, supportsProgress: true },
  ];
}
```

Persist trace resources after planner draft upsert:

```ts
function plannerTraceResources(result: LibraryAwarePlannerResult): Array<{ resourceType: string; resourceKey: string; payload: unknown; summary?: unknown }> {
  const base = hash(JSON.stringify(result)).slice(0, 12);
  return [
    { resourceType: "library_search_trace", resourceKey: `library-search-${base}`, payload: result.librarySearchTrace, summary: { matchedCount: result.librarySearchTrace.matchedRefs.length } },
    { resourceType: "agent_composition_trace", resourceKey: `agent-composition-${base}`, payload: result.tasks.map((task) => ({ taskId: task.id, agentDefinitionRef: task.agentDefinitionRef, agentProfileRef: task.agentProfileRef, skillRefs: task.skillRefs, mcpGrantRefs: task.mcpGrantRefs })) },
    { resourceType: "template_selection_trace", resourceKey: `template-selection-${base}`, payload: result.rationale.templateReasons },
    { resourceType: "planner_decision_trace", resourceKey: `planner-decision-${base}`, payload: { confidence: result.confidence, risk: result.risk, releaseMode: result.releaseMode, rationale: result.rationale } },
  ];
}
```

- [ ] **Step 4: Run draft integration tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for productized planner draft test and existing local API tests.

- [ ] **Step 5: Commit**

```bash
git add src/v2/ui-api/local-api.ts tests/v2/productized-planner-draft.test.ts tests/v2/index.test.ts
git commit -m "feat: create drafts with library aware planner"
```

## Task 5: Add Context Economy resources and downstream reuse

**Files:**
- Create: `src/v2/context/economy.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Modify: `src/v2/context/builder.ts`
- Test: `tests/v2/context-economy.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing Context Economy tests**

Create `tests/v2/context-economy.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createRunBrief, createRepoFactCache, createArtifactSummary, buildContextSourceSummary } from "../../src/v2/context/economy.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";

test("creates one run brief and repo fact cache per run", () => {
  const db = openSouthstarDb(":memory:");
  createRunBrief(db, {
    runId: "run-context-economy",
    requirementSpec: { summary: "todo-web priority feature", acceptanceCriteria: ["priority", "overdue"], nonGoals: ["deploy"] },
    selectedTemplateRefs: ["software.workflow.feature-implementation"],
    selectedAgentRefs: ["software.implementer", "software.coding-reviewer"],
    risk: "low",
    releaseMode: "none",
  });
  createRepoFactCache(db, {
    runId: "run-context-economy",
    repoPath: "/tmp/todo-web",
    facts: { packageManager: "npm", testCommand: "npm test", framework: "vite", relevantFiles: ["src/App.tsx"], localPreviewCommand: "npm run dev" },
  });

  const rows = db.prepare("select resource_type, resource_key from runtime_resources where run_id = ? order by resource_type").all("run-context-economy") as Array<{ resource_type: string; resource_key: string }>;
  assert.equal(rows.filter((row) => row.resource_type === "run_brief").length, 1);
  assert.equal(rows.filter((row) => row.resource_type === "repo_fact_cache").length, 1);
});

test("context source summary includes upstream artifact summaries", () => {
  const db = openSouthstarDb(":memory:");
  createRunBrief(db, {
    runId: "run-context-summary",
    requirementSpec: { summary: "parser fix", acceptanceCriteria: ["escaped pipe"], nonGoals: [] },
    selectedTemplateRefs: ["software.workflow.bug-diagnosis-fix"],
    selectedAgentRefs: ["software.reproducer", "software.diagnoser"],
    risk: "low",
    releaseMode: "none",
  });
  createRepoFactCache(db, {
    runId: "run-context-summary",
    repoPath: "/tmp/markdown-notes",
    facts: { packageManager: "npm", testCommand: "npm test", framework: "node", relevantFiles: ["src/table-parser.ts"] },
  });
  createArtifactSummary(db, {
    runId: "run-context-summary",
    taskId: "fix",
    artifactRef: "artifact-fix",
    summary: "Fixed escaped pipe parsing and added regression tests.",
    evidenceRefs: ["evidence-fix"],
    validatorRefs: ["validator-fix"],
    riskNotes: ["parser edge cases"],
  });

  const summary = buildContextSourceSummary(db, { runId: "run-context-summary", taskId: "coding-review", dependencyTaskIds: ["fix"] });
  assert.equal(summary.sources.some((source) => source.kind === "run_brief"), true);
  assert.equal(summary.sources.some((source) => source.kind === "repo_fact_cache"), true);
  assert.equal(summary.sources.some((source) => source.kind === "artifact_summary" && source.sourceRef === "artifact-fix"), true);
  assert.match(summary.text, /Fixed escaped pipe parsing/);
});

test("review task context can reference upstream summaries before broad rediscovery", () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, { resourceType: "artifact", resourceKey: "artifact-implement", runId: "run-review", taskId: "implement", scope: "task", status: "accepted", payload: { summary: "Implemented priority labels" }, summary: { summary: "Implemented priority labels", evidencePacketRefs: ["evidence-1"], validatorResultRefs: ["validator-1"] } });
  createArtifactSummary(db, { runId: "run-review", taskId: "implement", artifactRef: "artifact-implement", summary: "Implemented priority labels", evidenceRefs: ["evidence-1"], validatorRefs: ["validator-1"], riskNotes: [] });

  const summary = buildContextSourceSummary(db, { runId: "run-review", taskId: "coding-review", dependencyTaskIds: ["implement"] });
  assert.equal(summary.artifactSummaryRefs, ["artifact-summary-run-review-implement-artifact-implement"].sort());
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./context-economy.test.ts");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing `context/economy.ts`.

- [ ] **Step 3: Implement Context Economy helpers**

Create `src/v2/context/economy.ts`:

```ts
import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { PlannerRisk, ReleaseMode, RequirementSpec } from "../planner/library-aware-types.ts";

export type RunBriefInput = {
  runId: string;
  requirementSpec: RequirementSpec;
  selectedTemplateRefs: string[];
  selectedAgentRefs: string[];
  risk: PlannerRisk;
  releaseMode: ReleaseMode;
};

export type RepoFactCacheInput = {
  runId: string;
  repoPath?: string;
  facts: {
    packageManager?: string;
    testCommand?: string;
    framework?: string;
    relevantFiles?: string[];
    docsPaths?: string[];
    localPreviewCommand?: string;
  };
};

export type ArtifactSummaryInput = {
  runId: string;
  taskId: string;
  artifactRef: string;
  summary: string;
  evidenceRefs: string[];
  validatorRefs: string[];
  riskNotes: string[];
};

export type ContextSourceSummary = {
  text: string;
  sources: Array<{ kind: "run_brief" | "repo_fact_cache" | "artifact_summary"; resourceKey: string; sourceRef?: string; summary: string }>;
  artifactSummaryRefs: string[];
};

export function createRunBrief(db: SouthstarDb, input: RunBriefInput) {
  const resourceKey = `run-brief-${input.runId}`;
  const summary = `${input.requirementSpec.summary}\nTemplates: ${input.selectedTemplateRefs.join(", ")}\nAgents: ${input.selectedAgentRefs.join(", ")}\nRisk: ${input.risk}\nRelease: ${input.releaseMode}`;
  upsertRuntimeResource(db, {
    id: resourceKey,
    resourceType: "run_brief",
    resourceKey,
    runId: input.runId,
    scope: "workflow",
    status: "created",
    title: "Run Brief",
    payload: { ...input, summary },
    summary: { text: summary, selectedTemplateCount: input.selectedTemplateRefs.length, selectedAgentCount: input.selectedAgentRefs.length },
  });
  return { resourceKey, summary };
}

export function createRepoFactCache(db: SouthstarDb, input: RepoFactCacheInput) {
  const resourceKey = `repo-fact-cache-${input.runId}`;
  const summary = [
    input.repoPath ? `Repo: ${input.repoPath}` : "Repo: unknown",
    input.facts.packageManager ? `Package manager: ${input.facts.packageManager}` : undefined,
    input.facts.testCommand ? `Test command: ${input.facts.testCommand}` : undefined,
    input.facts.framework ? `Framework: ${input.facts.framework}` : undefined,
    input.facts.localPreviewCommand ? `Local preview: ${input.facts.localPreviewCommand}` : undefined,
    input.facts.relevantFiles?.length ? `Relevant files: ${input.facts.relevantFiles.join(", ")}` : undefined,
  ].filter(Boolean).join("\n");
  upsertRuntimeResource(db, {
    id: resourceKey,
    resourceType: "repo_fact_cache",
    resourceKey,
    runId: input.runId,
    scope: "workspace",
    status: "created",
    title: "Repo Fact Cache",
    payload: { ...input, summary },
    summary: { text: summary, repoPath: input.repoPath },
  });
  return { resourceKey, summary };
}

export function createArtifactSummary(db: SouthstarDb, input: ArtifactSummaryInput) {
  const resourceKey = `artifact-summary-${input.runId}-${input.taskId}-${input.artifactRef}`;
  upsertRuntimeResource(db, {
    id: resourceKey,
    resourceType: "artifact_summary",
    resourceKey,
    runId: input.runId,
    taskId: input.taskId,
    scope: "artifact",
    status: "created",
    title: `Artifact Summary for ${input.taskId}`,
    payload: input,
    summary: { summary: input.summary, evidenceRefs: input.evidenceRefs, validatorRefs: input.validatorRefs, sourceArtifactRef: input.artifactRef },
  });
  return { resourceKey, summary: input.summary };
}

export function buildContextSourceSummary(db: SouthstarDb, input: { runId: string; taskId: string; dependencyTaskIds: string[] }): ContextSourceSummary {
  const dependencySet = new Set(input.dependencyTaskIds);
  const runBrief = listResources(db, { resourceType: "run_brief" }).find((resource) => resource.runId === input.runId);
  const repoFactCache = listResources(db, { resourceType: "repo_fact_cache" }).find((resource) => resource.runId === input.runId);
  const artifactSummaries = listResources(db, { resourceType: "artifact_summary" })
    .filter((resource) => resource.runId === input.runId && resource.taskId && dependencySet.has(resource.taskId));

  const sources: ContextSourceSummary["sources"] = [];
  if (runBrief) sources.push({ kind: "run_brief", resourceKey: runBrief.resourceKey, summary: textSummary(runBrief.summary, runBrief.payload) });
  if (repoFactCache) sources.push({ kind: "repo_fact_cache", resourceKey: repoFactCache.resourceKey, summary: textSummary(repoFactCache.summary, repoFactCache.payload) });
  for (const artifact of artifactSummaries) {
    const payload = artifact.payload as { artifactRef?: string; summary?: string };
    sources.push({ kind: "artifact_summary", resourceKey: artifact.resourceKey, sourceRef: payload.artifactRef, summary: payload.summary ?? textSummary(artifact.summary, artifact.payload) });
  }
  return {
    text: sources.map((source) => `${source.kind} ${source.resourceKey}: ${source.summary}`).join("\n"),
    sources,
    artifactSummaryRefs: artifactSummaries.map((resource) => resource.resourceKey).sort(),
  };
}

function textSummary(summary: unknown, payload: unknown): string {
  if (summary && typeof summary === "object" && !Array.isArray(summary) && typeof (summary as { text?: unknown }).text === "string") return (summary as { text: string }).text;
  if (summary && typeof summary === "object" && !Array.isArray(summary) && typeof (summary as { summary?: unknown }).summary === "string") return (summary as { summary: string }).summary;
  if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as { summary?: unknown }).summary === "string") return (payload as { summary: string }).summary;
  return JSON.stringify(payload ?? summary ?? {});
}
```

- [ ] **Step 4: Integrate Context Economy in `createRunFromDraft` and ContextPacket builder**

In `src/v2/ui-api/local-api.ts`, after creating the workflow run and before executor materialization, call:

```ts
createRunBrief(db, {
  runId,
  requirementSpec: requirementSpecFromWorkflow(workflow),
  selectedTemplateRefs: workflow.compiledFrom?.libraryVersionRefs.filter((ref) => ref.startsWith("software.workflow")) ?? [],
  selectedAgentRefs: workflow.tasks.map((task) => task.agentProfileRef ?? task.roleRef ?? task.id),
  risk: riskFromWorkflow(workflow),
  releaseMode: releaseModeFromWorkflow(workflow),
});
createRepoFactCache(db, {
  runId,
  repoPath: repoPathFromWorkflow(workflow),
  facts: inferRepoFacts(workflow),
});
```

Add helper functions in the same file:

```ts
function requirementSpecFromWorkflow(workflow: SouthstarWorkflowManifest): RequirementSpec {
  return { summary: workflow.goalPrompt, acceptanceCriteria: workflow.goalPrompt.split(/[。.;；\n]/).map((part) => part.trim()).filter(Boolean), nonGoals: [] };
}

function riskFromWorkflow(workflow: SouthstarWorkflowManifest): "low" | "medium" | "high" {
  if (workflow.tasks.some((task) => task.mcpGrantRefs?.includes("github.pr-write"))) return "high";
  if (workflow.tasks.some((task) => task.mcpGrantRefs?.some((grant) => grant.includes("workspace-write") || grant.includes("git.workspace-patch")))) return "medium";
  return "low";
}

function releaseModeFromWorkflow(workflow: SouthstarWorkflowManifest): "none" | "commit-only" | "merge-ready" | "merge-and-release" {
  if (workflow.tasks.some((task) => task.id.includes("merge-operation"))) return "merge-and-release";
  if (workflow.tasks.some((task) => task.id.includes("merge-readiness"))) return "merge-ready";
  if (workflow.tasks.some((task) => task.id.includes("commit-curation"))) return "commit-only";
  return "none";
}

function repoPathFromWorkflow(workflow: SouthstarWorkflowManifest): string | undefined {
  for (const task of workflow.tasks) {
    const repoPath = task.promptInputs?.repoPath;
    if (typeof repoPath === "string") return repoPath;
  }
  return undefined;
}

function inferRepoFacts(workflow: SouthstarWorkflowManifest): RepoFactCacheInput["facts"] {
  const prompt = workflow.goalPrompt.toLowerCase();
  return {
    packageManager: prompt.includes("pnpm") ? "pnpm" : "npm",
    testCommand: prompt.includes("pytest") ? "pytest" : "npm test",
    framework: prompt.includes("web") || prompt.includes("browser") || prompt.includes("todo-web") ? "web" : "node",
    relevantFiles: [],
    docsPaths: ["README.md", "docs/"],
    localPreviewCommand: prompt.includes("web") || prompt.includes("browser") || prompt.includes("todo-web") ? "npm run dev" : undefined,
  };
}
```

In `src/v2/context/builder.ts`, add optional context source summary input and include it as a memory-like context block with source type `workspace` or add `context-source` to `ContextBlock.sourceType` if you update the type consistently. Prefer not changing the union in this task; use `workspace`:

```ts
contextSourceSummary?: string;
```

Include it in token estimation and packet construction as:

```ts
const contextSourceSummary = input.contextSourceSummary ? block("workspace", "Context Sources", input.contextSourceSummary) : undefined;
```

In `buildContextPacketForTask` in `local-api.ts`, call `buildContextSourceSummary` for task dependencies and pass `contextSourceSummary: summary.text`.

- [ ] **Step 5: Run Context Economy tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for context economy and existing context builder tests.

- [ ] **Step 6: Commit**

```bash
git add src/v2/context/economy.ts src/v2/context/builder.ts src/v2/ui-api/local-api.ts tests/v2/context-economy.test.ts tests/v2/index.test.ts
git commit -m "feat: add context economy resources"
```

## Task 6: Add Workflow tab, Operations tab, Library alternatives, and Operator read models

**Files:**
- Create: `src/v2/ui-api/page-models/workflow-tab.ts`
- Create: `src/v2/ui-api/page-models/operations-tab.ts`
- Create: `src/v2/ui-api/page-models/library-alternatives.ts`
- Create: `src/v2/ui-api/page-models/operator-attention.ts`
- Modify: `src/v2/ui-api/page-models/types.ts`
- Modify: `src/v2/server/ui-routes.ts`
- Test: `tests/v2/productized-ui-read-models.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing read model tests**

Create `tests/v2/productized-ui-read-models.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareEngineeringStarterLibrary } from "../../src/v2/design-library/software-engineering-starter.ts";
import { createPlannerDraft, createRunFromDraft } from "../../src/v2/ui-api/local-api.ts";
import { buildWorkflowTabPageModel } from "../../src/v2/ui-api/page-models/workflow-tab.ts";
import { buildLibraryAlternativesPageModel } from "../../src/v2/ui-api/page-models/library-alternatives.ts";
import { buildOperatorAttentionPageModel } from "../../src/v2/ui-api/page-models/operator-attention.ts";
import { buildOperationsTabPageModel } from "../../src/v2/ui-api/page-models/operations-tab.ts";
import { createApprovalRequest } from "../../src/v2/approvals/service.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";

test("workflow tab page model exposes draft DAG, task inspector, rationale, and context sources", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const draft = await createPlannerDraft(db, { goalPrompt: "todo-web priority labels overdue filter browser QA", plannerClient: { generate: async () => "{}" } });
  const model = buildWorkflowTabPageModel(db, { draftId: draft.draftId });

  assert.equal(model.surface, "southstar.ui.workflow-tab.v1");
  assert.equal(model.state, "draft-review");
  assert.equal(model.draft?.dag.nodes.some((node) => node.id === "coding-review"), true);
  assert.equal(model.draft?.dag.nodes.some((node) => node.id === "spec-alignment"), true);
  assert.equal(model.draft?.summary.confidence.length > 0, true);
  assert.equal(model.draft?.taskInspector?.agentProfileRef.length > 0, true);
  assert.equal(model.draft?.taskInspector?.rationale.length > 0, true);
});

test("library alternatives model shows matched templates, profiles, skills, grants, and rejections", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const draft = await createPlannerDraft(db, { goalPrompt: "markdown parser escaped pipe bug fix", plannerClient: { generate: async () => "{}" } });
  const model = buildLibraryAlternativesPageModel(db, { draftId: draft.draftId, taskId: "fix" });

  assert.equal(model.surface, "southstar.ui.library-alternatives.v1");
  assert.equal(model.matchedTemplates.length >= 1, true);
  assert.equal(model.agentProfiles.length >= 1, true);
  assert.equal(model.skills.length >= 1, true);
  assert.equal(Array.isArray(model.rejectedAlternatives), true);
});

test("operations tab model exposes Southstar Control Center without Northstar wording", () => {
  const db = openSouthstarDb(":memory:");
  const model = buildOperationsTabPageModel(db, {});
  assert.equal(model.surface, "southstar.ui.operations-tab.v1");
  assert.equal(Array.isArray(model.runs), true);
  assert.equal(Array.isArray(model.approvals), true);
  assert.equal(Array.isArray(model.executorHealth), true);
});

test("operator attention model surfaces approvals and stuck executor attention", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const draft = await createPlannerDraft(db, { goalPrompt: "todo-web feature commit", plannerClient: { generate: async () => "{}" } });
  const run = await createRunFromDraft(db, { draftId: draft.draftId, executorProvider: executorProvider() });
  createApprovalRequest(db, { runId: run.runId, actionType: "merge-operation", riskTags: ["github.pr-write"], title: "Approve merge", payload: { reason: "test" } });

  const model = buildOperatorAttentionPageModel(db, {});
  assert.equal(model.surface, "southstar.ui.operator-attention.v1");
  assert.equal(model.attentionCount >= 1, true);
  assert.equal(model.items.some((item) => item.kind === "approval"), true);
});

function executorProvider(): ExecutorProvider {
  return { executorType: "tork", async submit() { return { executorType: "tork", externalJobId: "job-productized-read-model", status: "queued" }; } };
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./productized-ui-read-models.test.ts");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing page model files.

- [ ] **Step 3: Implement Workflow tab page model**

Create `src/v2/ui-api/page-models/workflow-tab.ts`:

```ts
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";
import { buildWorkflowCanvasModel } from "../read-models.ts";

export type WorkflowTabPageModel = {
  surface: "southstar.ui.workflow-tab.v1";
  state: "new-goal" | "planning" | "draft-review" | "active-run";
  activeRunId?: string;
  draft?: {
    draftId: string;
    title: string;
    summary: { templateRefs: string[]; confidence: string; risk: string; releaseMode: string };
    dag: { nodes: Array<{ id: string; label: string; status: string }>; edges: Array<{ from: string; to: string }> };
    taskInspector?: { taskId: string; agentDefinitionRef: string; agentProfileRef: string; skillRefs: string[]; mcpGrantRefs: string[]; artifactContractRefs: string[]; rationale: string; readOnly: true };
    plannerRationale: string;
  };
};

export function buildWorkflowTabPageModel(db: SouthstarDb, input: { draftId?: string; runId?: string }): WorkflowTabPageModel {
  if (input.runId) {
    const canvas = buildWorkflowCanvasModel(db, input.runId);
    return { surface: "southstar.ui.workflow-tab.v1", state: "active-run", activeRunId: input.runId, draft: undefined };
  }
  if (!input.draftId) return { surface: "southstar.ui.workflow-tab.v1", state: "new-goal" };
  const draft = listResources(db, { resourceType: "planner_draft" }).find((resource) => resource.resourceKey === input.draftId);
  if (!draft) return { surface: "southstar.ui.workflow-tab.v1", state: "new-goal" };
  const payload = draft.payload as { workflow?: { title?: string; tasks?: Array<{ id: string; name?: string; dependsOn?: string[]; agentProfileRef?: string; skillRefs?: string[]; mcpGrantRefs?: string[]; requiredArtifactRefs?: string[]; promptInputs?: { rationale?: string } }> } };
  const workflow = payload.workflow;
  const tasks = workflow?.tasks ?? [];
  const decision = listResources(db, { resourceType: "planner_decision_trace" }).at(-1);
  const decisionPayload = decision?.payload as { confidence?: string; risk?: string; releaseMode?: string; rationale?: { summary?: string } } | undefined;
  const templateTrace = listResources(db, { resourceType: "template_selection_trace" }).at(-1);
  const templateRefs = Array.isArray(templateTrace?.payload) ? (templateTrace!.payload as Array<{ ref?: string }>).map((item) => item.ref).filter((value): value is string => Boolean(value)) : [];
  const firstTask = tasks[0];
  return {
    surface: "southstar.ui.workflow-tab.v1",
    state: "draft-review",
    draft: {
      draftId: input.draftId,
      title: workflow?.title ?? draft.title ?? "Workflow Draft",
      summary: { templateRefs, confidence: decisionPayload?.confidence ?? "unknown", risk: decisionPayload?.risk ?? "unknown", releaseMode: decisionPayload?.releaseMode ?? "none" },
      dag: {
        nodes: tasks.map((task) => ({ id: task.id, label: task.name ?? task.id, status: "draft" })),
        edges: tasks.flatMap((task) => (task.dependsOn ?? []).map((from) => ({ from, to: task.id }))),
      },
      taskInspector: firstTask ? {
        taskId: firstTask.id,
        agentDefinitionRef: String(firstTask.promptInputs?.rationale?.match(/software\.[\w.-]+/)?.[0] ?? firstTask.agentProfileRef ?? firstTask.id),
        agentProfileRef: firstTask.agentProfileRef ?? "unknown",
        skillRefs: firstTask.skillRefs ?? [],
        mcpGrantRefs: firstTask.mcpGrantRefs ?? [],
        artifactContractRefs: firstTask.requiredArtifactRefs ?? [],
        rationale: String(firstTask.promptInputs?.rationale ?? `Selected ${firstTask.agentProfileRef ?? firstTask.id}`),
        readOnly: true,
      } : undefined,
      plannerRationale: decisionPayload?.rationale?.summary ?? "Planner rationale not recorded.",
    },
  };
}
```

- [ ] **Step 4: Implement Library alternatives and Operator models**

Create `src/v2/ui-api/page-models/library-alternatives.ts`:

```ts
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";
import { searchLibrary } from "../../planner/library-search.ts";

export type LibraryAlternativesPageModel = {
  surface: "southstar.ui.library-alternatives.v1";
  draftId: string;
  taskId?: string;
  matchedTemplates: Array<{ ref: string; score: number; reason: string }>;
  agentProfiles: Array<{ ref: string; score: number; reason: string }>;
  skills: Array<{ ref: string; score: number; reason: string }>;
  mcpGrants: Array<{ ref: string; score: number; reason: string }>;
  rejectedAlternatives: Array<{ ref: string; reason: string }>;
};

export function buildLibraryAlternativesPageModel(db: SouthstarDb, input: { draftId: string; taskId?: string }): LibraryAlternativesPageModel {
  const draft = listResources(db, { resourceType: "planner_draft" }).find((resource) => resource.resourceKey === input.draftId);
  const query = `${draft?.title ?? "software"} ${input.taskId ?? ""}`;
  const toView = (match: { ref: string; score: number; reason: string }) => ({ ref: match.ref, score: match.score, reason: match.reason });
  const rejected = listResources(db, { resourceType: "planner_decision_trace" }).flatMap((resource) => {
    const payload = resource.payload as { rationale?: { rejectedAlternatives?: Array<{ ref: string; reason: string }> } };
    return payload.rationale?.rejectedAlternatives ?? [];
  });
  return {
    surface: "southstar.ui.library-alternatives.v1",
    draftId: input.draftId,
    taskId: input.taskId,
    matchedTemplates: searchLibrary(db, { query, kind: "workflow_template", limit: 5 }).map(toView),
    agentProfiles: searchLibrary(db, { query, kind: "agent_profile", limit: 8 }).map(toView),
    skills: searchLibrary(db, { query, kind: "skill_definition", limit: 8 }).map(toView),
    mcpGrants: searchLibrary(db, { query, kind: "mcp_tool_grant", limit: 8 }).map(toView),
    rejectedAlternatives: rejected,
  };
}
```

Create `src/v2/ui-api/page-models/operator-attention.ts`:

```ts
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";

export type OperatorAttentionItem = {
  id: string;
  kind: "approval" | "failed-task" | "executor-attention" | "release-risk";
  title: string;
  runId?: string;
  taskId?: string;
  severity: "info" | "warning" | "critical";
  suggestedActions: string[];
};

export type OperatorAttentionPageModel = {
  surface: "southstar.ui.operator-attention.v1";
  attentionCount: number;
  items: OperatorAttentionItem[];
};

export function buildOperatorAttentionPageModel(db: SouthstarDb, _input: {}): OperatorAttentionPageModel {
  const approvals = listResources(db, { resourceType: "approval" }).filter((resource) => resource.status === "pending");
  const executorAttention = listResources(db, { resourceType: "executor_binding" }).filter((resource) => ["heartbeat-lost", "queue-timeout", "hard-timeout", "callback-missing", "orphaned"].includes(resource.status));
  const items: OperatorAttentionItem[] = [
    ...approvals.map((resource) => ({ id: resource.id, kind: "approval" as const, title: resource.title ?? "Approval required", runId: resource.runId, taskId: resource.taskId, severity: "warning" as const, suggestedActions: ["Review approval", "Approve", "Reject"] })),
    ...executorAttention.map((resource) => ({ id: resource.id, kind: "executor-attention" as const, title: resource.title ?? `Executor ${resource.status}`, runId: resource.runId, taskId: resource.taskId, severity: "critical" as const, suggestedActions: ["Reconcile", "Retry task", "Cancel job"] })),
  ];
  return { surface: "southstar.ui.operator-attention.v1", attentionCount: items.length, items };
}
```

Create `src/v2/ui-api/page-models/operations-tab.ts`:

```ts
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";

export type OperationsTabPageModel = {
  surface: "southstar.ui.operations-tab.v1";
  runs: Array<{ runId: string; status: string; title: string }>;
  approvals: Array<{ id: string; runId?: string; title: string; status: string }>;
  executorHealth: Array<{ service: string; status: "healthy" | "attention" | "unknown" }>;
  releaseLanes: Array<{ runId?: string; status: string; summary: string }>;
};

export function buildOperationsTabPageModel(db: SouthstarDb, _input: {}): OperationsTabPageModel {
  const runRows = db.prepare("select id, status, goal_prompt from workflow_runs order by updated_at desc limit 20").all() as Array<{ id: string; status: string; goal_prompt: string }>;
  const approvals = listResources(db, { resourceType: "approval" });
  const executorBindings = listResources(db, { resourceType: "executor_binding" });
  return {
    surface: "southstar.ui.operations-tab.v1",
    runs: runRows.map((run) => ({ runId: run.id, status: run.status, title: run.goal_prompt })),
    approvals: approvals.map((approval) => ({ id: approval.id, runId: approval.runId, title: approval.title ?? approval.resourceKey, status: approval.status })),
    executorHealth: [{ service: "Tork Executor", status: executorBindings.some((binding) => ["heartbeat-lost", "queue-timeout", "hard-timeout", "callback-missing", "orphaned"].includes(binding.status)) ? "attention" : "healthy" }],
    releaseLanes: listResources(db, { resourceType: "merge_result" }).map((resource) => ({ runId: resource.runId, status: resource.status, summary: resource.title ?? resource.resourceKey })),
  };
}
```

- [ ] **Step 5: Expose routes**

Modify `src/v2/server/ui-routes.ts` to include:

```ts
if (request.method === "GET" && url.pathname === "/api/v2/ui/workflow-tab") {
  return json("ui-workflow-tab", buildWorkflowTabPageModel(context.db, {
    draftId: url.searchParams.get("draftId") ?? undefined,
    runId: url.searchParams.get("runId") ?? undefined,
  }));
}
if (request.method === "GET" && url.pathname === "/api/v2/ui/library-alternatives") {
  const draftId = url.searchParams.get("draftId");
  if (!draftId) throw new Error("draftId is required");
  return json("ui-library-alternatives", buildLibraryAlternativesPageModel(context.db, {
    draftId,
    taskId: url.searchParams.get("taskId") ?? undefined,
  }));
}
if (request.method === "GET" && url.pathname === "/api/v2/ui/operator-attention") {
  return json("ui-operator-attention", buildOperatorAttentionPageModel(context.db, {}));
}
if (request.method === "GET" && url.pathname === "/api/v2/ui/operations-tab") {
  return json("ui-operations-tab", buildOperationsTabPageModel(context.db, {}));
}
```

Add imports for the four builders.

- [ ] **Step 6: Run read model tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for productized UI read model tests.

- [ ] **Step 7: Commit**

```bash
git add src/v2/ui-api/page-models/workflow-tab.ts src/v2/ui-api/page-models/operations-tab.ts src/v2/ui-api/page-models/library-alternatives.ts src/v2/ui-api/page-models/operator-attention.ts src/v2/ui-api/page-models/types.ts src/v2/server/ui-routes.ts tests/v2/productized-ui-read-models.test.ts tests/v2/index.test.ts
git commit -m "feat: expose productized app shell read models"
```

## Task 7: Port pi-web inspired Southstar App Shell with Chat / Workflow / Operations tabs

**Files:**
- Create: `components/southstar/app-shell/SouthstarProductShell.tsx`
- Create: `components/southstar/app-shell/SouthstarTopBar.tsx`
- Create: `components/southstar/app-shell/SouthstarTabRail.tsx`
- Create: `components/southstar/chat/SouthstarChatTab.tsx`
- Create: `components/southstar/workflow/WorkflowTab.tsx`
- Create: `components/southstar/workflow/LibraryContextPanel.tsx`
- Create: `components/southstar/workflow/GuidedPlannerChat.tsx`
- Create: `components/southstar/workflow/WorkflowDagPanel.tsx`
- Create: `components/southstar/workflow/TaskInspector.tsx`
- Create: `components/southstar/workflow/LibraryAlternativesSheet.tsx`
- Create: `components/southstar/operator/OperatorDock.tsx`
- Create: `components/southstar/operator/OperatorSheet.tsx`
- Create: `components/southstar/operations/SouthstarOperationsTab.tsx`
- Create: `app/chat/page.tsx`
- Modify: `app/workflow/page.tsx`
- Create: `app/operations/page.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Test: `tests/web/southstar-productized-app-shell-ui.test.tsx`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing App Shell UI source tests**

Create `tests/web/southstar-productized-app-shell-ui.test.tsx`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
function source(path: string): string { return readFileSync(join(root, path), "utf8"); }

test("root renders Southstar product shell with Chat Workflow Operations tabs", () => {
  assert.match(source("app/page.tsx"), /SouthstarProductShell/);
  const shell = source("components/southstar/app-shell/SouthstarProductShell.tsx");
  assert.match(shell, /SouthstarChatTab/);
  assert.match(shell, /WorkflowTab/);
  assert.match(shell, /SouthstarOperationsTab/);
  assert.match(shell, /activeTab/);
  assert.match(shell, /Chat/);
  assert.match(shell, /Workflow/);
  assert.match(shell, /Operations/);
});

test("workflow tab contains library context, guided chat, DAG flow, and floating operator", () => {
  assert.match(source("components/southstar/workflow/WorkflowTab.tsx"), /LibraryContextPanel/);
  assert.match(source("components/southstar/workflow/WorkflowTab.tsx"), /GuidedPlannerChat/);
  assert.match(source("components/southstar/workflow/WorkflowTab.tsx"), /WorkflowDagPanel/);
  assert.match(source("components/southstar/workflow/TaskInspector.tsx"), /Customize this run/);
  assert.match(source("components/southstar/workflow/TaskInspector.tsx"), /Context Sources/);
  assert.match(source("components/southstar/workflow/LibraryAlternativesSheet.tsx"), /Matched templates/);
  assert.match(source("components/southstar/operator/OperatorSheet.tsx"), /Needs attention/);
});

test("chat tab remains available and operations tab replaces northstar wording", () => {
  assert.match(source("components/southstar/chat/SouthstarChatTab.tsx"), /General conversation/);
  assert.match(source("components/southstar/chat/SouthstarChatTab.tsx"), /skill-guided/);
  const ops = source("components/southstar/operations/SouthstarOperationsTab.tsx");
  assert.match(ops, /Southstar Control Center/);
  assert.match(ops, /workflow runs/);
  assert.doesNotMatch(ops, /Northstar issue|issue lifecycle/);
});

test("calm product shell tokens exist and avoid copied pi-web dark shell as default", () => {
  const css = source("app/globals.css");
  assert.match(css, /--ss-product-bg: #f6f8fb/);
  assert.match(css, /--ss-product-primary: #102033/);
  assert.match(css, /--ss-product-border: #d8e1ec/);
  assert.doesNotMatch(css, /purple|violet|gradient\(.*purple/i);
});
```

Add to `tests/index.test.ts`:

```ts
await import("./web/southstar-productized-app-shell-ui.test.tsx");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL with missing Southstar product shell files.

- [ ] **Step 3: Add API client methods for Workflow, Operations, Library, and Operator**

Modify `lib/southstar/api-client.ts` using its existing request helper style. Add these methods to the returned client object:

```ts
async getUiWorkflowTab(params?: { draftId?: string; runId?: string }) {
  const query = new URLSearchParams();
  if (params?.draftId) query.set("draftId", params.draftId);
  if (params?.runId) query.set("runId", params.runId);
  return this.get(`/api/v2/ui/workflow-tab${query.size ? `?${query}` : ""}`);
},
async getUiOperationsTab(params?: { runId?: string }) {
  const query = new URLSearchParams();
  if (params?.runId) query.set("runId", params.runId);
  return this.get(`/api/v2/ui/operations-tab${query.size ? `?${query}` : ""}`);
},
async getUiLibraryAlternatives(params: { draftId: string; taskId?: string }) {
  const query = new URLSearchParams({ draftId: params.draftId });
  if (params.taskId) query.set("taskId", params.taskId);
  return this.get(`/api/v2/ui/library-alternatives?${query}`);
},
async getUiOperatorAttention() {
  return this.get("/api/v2/ui/operator-attention");
}
```

- [ ] **Step 4: Create Southstar Product Shell**

Create `components/southstar/app-shell/SouthstarProductShell.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";
import { SouthstarTopBar } from "./SouthstarTopBar";
import { SouthstarTabRail, type SouthstarProductTab } from "./SouthstarTabRail";
import { SouthstarChatTab } from "../chat/SouthstarChatTab";
import { WorkflowTab } from "../workflow/WorkflowTab";
import { SouthstarOperationsTab } from "../operations/SouthstarOperationsTab";
import { OperatorDock } from "../operator/OperatorDock";
import { OperatorSheet } from "../operator/OperatorSheet";

export function SouthstarProductShell(props: { initialTab?: SouthstarProductTab }) {
  const [activeTab, setActiveTab] = useState<SouthstarProductTab>(props.initialTab ?? "workflow");
  const [operatorOpen, setOperatorOpen] = useState(false);
  const [operator, setOperator] = useState<any | null>(null);
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" }), []);

  useEffect(() => { void api.getUiOperatorAttention().then(setOperator).catch(() => setOperator(null)); }, [api, activeTab]);

  return (
    <main className="ss-product-shell">
      <SouthstarTopBar activeTab={activeTab} />
      <div className="ss-product-body">
        <SouthstarTabRail activeTab={activeTab} onChange={setActiveTab} />
        <section className="ss-product-tab-surface">
          {activeTab === "chat" ? <SouthstarChatTab /> : null}
          {activeTab === "workflow" ? <WorkflowTab api={api} /> : null}
          {activeTab === "operations" ? <SouthstarOperationsTab api={api} /> : null}
        </section>
      </div>
      <OperatorDock count={operator?.attentionCount ?? 0} onOpen={() => setOperatorOpen(true)} />
      {operatorOpen ? <OperatorSheet model={operator} onClose={() => setOperatorOpen(false)} /> : null}
    </main>
  );
}
```

Create `components/southstar/app-shell/SouthstarTopBar.tsx`:

```tsx
import type { SouthstarProductTab } from "./SouthstarTabRail";

export function SouthstarTopBar(props: { activeTab: SouthstarProductTab }) {
  return (
    <header className="ss-product-topbar">
      <div className="ss-product-brand"><span aria-hidden /> <strong>Southstar</strong><small>Workflow OS</small></div>
      <div className="ss-product-status"><span className="ss-status-dot" /> runtime healthy · {props.activeTab}</div>
    </header>
  );
}
```

Create `components/southstar/app-shell/SouthstarTabRail.tsx`:

```tsx
export type SouthstarProductTab = "chat" | "workflow" | "operations";

const tabs: Array<{ id: SouthstarProductTab; label: string; description: string }> = [
  { id: "chat", label: "Chat", description: "General conversation" },
  { id: "workflow", label: "Workflow", description: "Plan and run" },
  { id: "operations", label: "Operations", description: "Control Center" },
];

export function SouthstarTabRail(props: { activeTab: SouthstarProductTab; onChange: (tab: SouthstarProductTab) => void }) {
  return (
    <aside className="ss-product-rail" aria-label="Southstar sections">
      {tabs.map((tab) => <button key={tab.id} type="button" aria-pressed={props.activeTab === tab.id} onClick={() => props.onChange(tab.id)}><strong>{tab.label}</strong><span>{tab.description}</span></button>)}
    </aside>
  );
}
```

- [ ] **Step 5: Create Chat tab and Workflow tab components**

Create `components/southstar/chat/SouthstarChatTab.tsx`:

```tsx
export function SouthstarChatTab() {
  return (
    <section className="ss-chat-tab">
      <div className="ss-chat-empty">
        <h1>General conversation</h1>
        <p>Use chat for freeform work, brainstorming, and skill-guided Southstar planning. Start with <code>/workflow</code> when you want Southstar to design a workflow.</p>
        <div className="ss-chat-input-shell"><textarea aria-label="Chat message" aria-describedby="chat-helper" /><p id="chat-helper">Ask a question or use a Southstar skill command.</p></div>
      </div>
    </section>
  );
}
```

Create `components/southstar/workflow/WorkflowTab.tsx`:

```tsx
"use client";

import { useState } from "react";
import { LibraryContextPanel } from "./LibraryContextPanel";
import { GuidedPlannerChat } from "./GuidedPlannerChat";
import { WorkflowDagPanel } from "./WorkflowDagPanel";
import { TaskInspector } from "./TaskInspector";
import { LibraryAlternativesSheet } from "./LibraryAlternativesSheet";

export function WorkflowTab(props: { api: any }) {
  const [goalPrompt, setGoalPrompt] = useState("");
  const [model, setModel] = useState<any | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [planning, setPlanning] = useState(false);

  async function planGoal() {
    setPlanning(true);
    try {
      const draft = await props.api.createDraft(goalPrompt);
      setDraftId(draft.draftId);
      const next = await props.api.getUiWorkflowTab({ draftId: draft.draftId });
      setModel(next);
      setSelectedTaskId(next.draft?.dag?.nodes?.[0]?.id ?? null);
    } finally {
      setPlanning(false);
    }
  }

  return (
    <div className="ss-workflow-tab">
      <LibraryContextPanel model={model} onOpenAlternatives={() => setLibraryOpen(true)} />
      <main className="ss-workflow-main">
        <GuidedPlannerChat value={goalPrompt} onChange={setGoalPrompt} onPlan={() => void planGoal()} planning={planning} />
        <WorkflowDagPanel draft={model?.draft} selectedTaskId={selectedTaskId} onSelectTask={setSelectedTaskId} />
      </main>
      <TaskInspector draft={model?.draft} selectedTaskId={selectedTaskId} onOpenAlternatives={() => setLibraryOpen(true)} />
      {libraryOpen && draftId ? <LibraryAlternativesSheet api={props.api} draftId={draftId} taskId={selectedTaskId ?? undefined} onClose={() => setLibraryOpen(false)} /> : null}
    </div>
  );
}
```

Create `components/southstar/workflow/LibraryContextPanel.tsx`:

```tsx
export function LibraryContextPanel(props: { model: any | null; onOpenAlternatives: () => void }) {
  const summary = props.model?.draft?.summary;
  return (
    <aside className="ss-library-context">
      <h2>Library Context</h2>
      <section><h3>Matched Workflow</h3><p>{summary?.templateRefs?.join(", ") ?? "Waiting for prompt"}</p></section>
      <section><h3>Agent Team</h3><p>{props.model?.draft?.dag?.nodes?.map((node: any) => node.id).join(" · ") ?? "Southstar will select agents"}</p></section>
      <section><h3>Skills / MCP</h3><p>Shown after planning from selected agent profiles.</p></section>
      <button type="button" onClick={props.onOpenAlternatives}>View alternatives</button>
    </aside>
  );
}
```

Create `components/southstar/workflow/GuidedPlannerChat.tsx`:

```tsx
const guideSteps = ["Understand goal", "Select workflow", "Compose agent team", "Confirm profiles / tools", "Review DAG", "Run"];

export function GuidedPlannerChat(props: { value: string; planning: boolean; onChange: (value: string) => void; onPlan: () => void }) {
  return (
    <section className="ss-guided-chat">
      <header><h1>Guided workflow chat</h1><p>Southstar skill-guided planner helps confirm workflow, agents, profiles, and tools.</p></header>
      <ol>{guideSteps.map((step) => <li key={step}>{step}</li>)}</ol>
      <label htmlFor="workflow-goal">Workflow goal</label>
      <textarea id="workflow-goal" value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)} />
      <button type="button" onClick={props.onPlan} disabled={props.planning || props.value.trim().length === 0}>{props.planning ? "Planning…" : "Plan workflow"}</button>
    </section>
  );
}
```

Create `components/southstar/workflow/WorkflowDagPanel.tsx` and `TaskInspector.tsx`:

```tsx
export function WorkflowDagPanel(props: { draft: any | null; selectedTaskId: string | null; onSelectTask: (taskId: string) => void }) {
  const nodes = props.draft?.dag?.nodes ?? [{ id: "prompt", label: "Prompt" }, { id: "planner", label: "Planner" }, { id: "dag", label: "DAG" }];
  return (
    <section className="ss-workflow-dag">
      <header><h2>DAG Flow</h2><p>{props.draft ? "Review before running" : "Generated after planning"}</p></header>
      <svg viewBox="0 0 720 180" role="img" aria-label="DAG Flow">
        {nodes.map((node: any, index: number) => <g key={node.id} onClick={() => props.onSelectTask(node.id)} className={props.selectedTaskId === node.id ? "is-selected" : ""}><rect x={24 + index * 120} y="62" width="96" height="54" rx="12" /><text x={72 + index * 120} y="94">{node.label ?? node.id}</text></g>)}
      </svg>
    </section>
  );
}
```

```tsx
export function TaskInspector(props: { draft: any | null; selectedTaskId: string | null; onOpenAlternatives: () => void }) {
  const inspector = props.draft?.taskInspector;
  return (
    <aside className="ss-task-inspector">
      <h2>Task Inspector</h2>
      <p>Read-only until you choose Customize this run.</p>
      <dl><dt>Agent</dt><dd>{inspector?.agentDefinitionRef ?? "Select a DAG node"}</dd><dt>Profile</dt><dd>{inspector?.agentProfileRef ?? "—"}</dd><dt>Skills</dt><dd>{inspector?.skillRefs?.join(", ") ?? "—"}</dd><dt>MCP Grants</dt><dd>{inspector?.mcpGrantRefs?.join(", ") ?? "—"}</dd></dl>
      <section><h3>Context Sources</h3><ul><li>Run Brief</li><li>Repo Facts</li><li>Upstream Artifacts</li><li>Selected Memories</li><li>Skills</li><li>MCP Grants</li></ul></section>
      <button type="button">Customize this run</button><button type="button" onClick={props.onOpenAlternatives}>View alternatives</button>
    </aside>
  );
}
```

- [ ] **Step 6: Create Operator and Operations components**

Create `components/southstar/operator/OperatorDock.tsx`:

```tsx
export function OperatorDock(props: { count: number; onOpen: () => void }) {
  return <button type="button" className="ss-operator-dock" onClick={props.onOpen}>Operator · {props.count}</button>;
}
```

Create `components/southstar/operator/OperatorSheet.tsx`:

```tsx
export function OperatorSheet(props: { model: any; onClose: () => void }) {
  return <aside className="ss-operator-sheet"><header><h2>Needs attention</h2><button type="button" onClick={props.onClose}>Close</button></header>{props.model?.items?.map((item: any) => <article key={item.id}><strong>{item.title}</strong><p>{item.suggestedActions?.join(" · ")}</p></article>)}</aside>;
}
```

Create `components/southstar/workflow/LibraryAlternativesSheet.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

export function LibraryAlternativesSheet(props: { api: any; draftId: string; taskId?: string; onClose: () => void }) {
  const [model, setModel] = useState<any | null>(null);
  useEffect(() => { void props.api.getUiLibraryAlternatives({ draftId: props.draftId, taskId: props.taskId }).then(setModel); }, [props.api, props.draftId, props.taskId]);
  return <aside className="ss-library-sheet"><header><h2>Matched templates</h2><button type="button" onClick={props.onClose}>Close</button></header><h3>Agent profiles</h3>{model?.agentProfiles?.map((item: any) => <p key={item.ref}>{item.ref}</p>)}<h3>Skills</h3>{model?.skills?.map((item: any) => <p key={item.ref}>{item.ref}</p>)}</aside>;
}
```

Create `components/southstar/operations/SouthstarOperationsTab.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

export function SouthstarOperationsTab(props: { api: any }) {
  const [model, setModel] = useState<any | null>(null);
  useEffect(() => { void props.api.getUiOperationsTab().then(setModel).catch(() => setModel(null)); }, [props.api]);
  return (
    <section className="ss-operations-tab">
      <header><h1>Southstar Control Center</h1><p>Monitor workflow runs, approvals, executor health, release lanes, and automation loops.</p></header>
      <div className="ss-ops-grid"><article><h2>workflow runs</h2><p>{model?.runs?.length ?? 0}</p></article><article><h2>approvals</h2><p>{model?.approvals?.length ?? 0}</p></article><article><h2>executor health</h2><p>{model?.executorHealth?.[0]?.status ?? "unknown"}</p></article></div>
    </section>
  );
}
```

- [ ] **Step 7: Add routes**

Create `app/chat/page.tsx`:

```tsx
import { SouthstarProductShell } from "@/components/southstar/app-shell/SouthstarProductShell";
export default function Page() { return <SouthstarProductShell initialTab="chat" />; }
```

Modify `app/workflow/page.tsx`:

```tsx
import { SouthstarProductShell } from "@/components/southstar/app-shell/SouthstarProductShell";
export default function Page() { return <SouthstarProductShell initialTab="workflow" />; }
```

Create `app/operations/page.tsx`:

```tsx
import { SouthstarProductShell } from "@/components/southstar/app-shell/SouthstarProductShell";
export default function Page() { return <SouthstarProductShell initialTab="operations" />; }
```

Modify `app/page.tsx`:

```tsx
import { SouthstarProductShell } from "@/components/southstar/app-shell/SouthstarProductShell";
export default function Home() { return <SouthstarProductShell initialTab="workflow" />; }
```

- [ ] **Step 8: Add Calm Product Shell CSS**

Modify `app/globals.css` with:

```css
:root {
  --ss-product-bg: #f6f8fb;
  --ss-product-surface: #ffffff;
  --ss-product-primary: #102033;
  --ss-product-muted: #64748b;
  --ss-product-border: #d8e1ec;
  --ss-product-safe: #0f766e;
  --ss-product-safe-bg: #eaf6f3;
  --ss-product-warning: #d97706;
  --ss-product-warning-bg: #fff7ed;
}
.ss-product-shell { min-height: 100dvh; background: var(--ss-product-bg); color: var(--ss-product-primary); }
.ss-product-topbar { height: 60px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; border-bottom: 1px solid var(--ss-product-border); background: rgba(255,255,255,.78); backdrop-filter: blur(12px); }
.ss-product-brand, .ss-product-status { display: flex; align-items: center; gap: 10px; }
.ss-product-brand span { width: 24px; height: 24px; border-radius: 8px; background: var(--ss-product-primary); display: inline-block; }
.ss-product-brand small, .ss-product-status, .ss-product-rail span { color: var(--ss-product-muted); }
.ss-status-dot { width: 8px; height: 8px; border-radius: 99px; background: var(--ss-product-safe); }
.ss-product-body { display: grid; grid-template-columns: 180px minmax(0, 1fr); min-height: calc(100dvh - 60px); }
.ss-product-rail { padding: 16px; border-right: 1px solid var(--ss-product-border); display: grid; align-content: start; gap: 8px; }
.ss-product-rail button { text-align: left; border: 1px solid transparent; background: transparent; border-radius: 12px; padding: 12px; color: var(--ss-product-primary); display: grid; gap: 4px; }
.ss-product-rail button[aria-pressed="true"] { background: white; border-color: var(--ss-product-border); box-shadow: 0 10px 24px rgba(20,45,80,.05); }
.ss-product-tab-surface { min-width: 0; overflow: hidden; }
.ss-workflow-tab { display: grid; grid-template-columns: 260px minmax(0, 1fr) 320px; gap: 16px; padding: 18px; height: calc(100dvh - 60px); }
.ss-library-context, .ss-guided-chat, .ss-workflow-dag, .ss-task-inspector, .ss-operations-tab, .ss-chat-empty { background: var(--ss-product-surface); border: 1px solid var(--ss-product-border); border-radius: 16px; box-shadow: 0 14px 32px rgba(20,45,80,.05); }
.ss-library-context, .ss-guided-chat, .ss-workflow-dag, .ss-task-inspector, .ss-operations-tab, .ss-chat-empty { padding: 16px; }
.ss-workflow-main { min-width: 0; display: grid; grid-template-rows: minmax(0, 1fr) 240px; gap: 16px; }
.ss-guided-chat textarea, .ss-chat-input-shell textarea { width: 100%; min-height: 92px; border: 1px solid var(--ss-product-border); border-radius: 12px; background: #f8fafc; color: var(--ss-product-primary); padding: 12px; }
.ss-guided-chat button, .ss-library-context button, .ss-task-inspector button:first-of-type { min-height: 38px; border: 0; border-radius: 10px; padding: 0 14px; color: white; background: var(--ss-product-primary); font-weight: 700; }
.ss-workflow-dag svg { width: 100%; height: 180px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; }
.ss-workflow-dag rect { fill: white; stroke: #cbd5e1; cursor: pointer; }
.ss-workflow-dag .is-selected rect { fill: var(--ss-product-safe-bg); stroke: #b9ddd3; }
.ss-workflow-dag text { font-size: 10px; text-anchor: middle; fill: var(--ss-product-primary); pointer-events: none; }
.ss-operator-dock { position: fixed; right: 24px; bottom: 24px; background: var(--ss-product-primary); color: white; border: 0; border-radius: 999px; padding: 12px 16px; box-shadow: 0 12px 28px rgba(16,32,51,.24); }
.ss-operator-sheet, .ss-library-sheet { position: fixed; right: 0; top: 0; width: min(420px, 92vw); height: 100dvh; background: white; border-left: 1px solid var(--ss-product-border); box-shadow: -16px 0 40px rgba(20,45,80,.10); padding: 18px; z-index: 40; overflow: auto; }
.ss-ops-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.ss-ops-grid article { border: 1px solid var(--ss-product-border); border-radius: 14px; padding: 14px; background: #f8fafc; }
@media (max-width: 1100px) { .ss-workflow-tab { grid-template-columns: 1fr; height: auto; } .ss-product-body { grid-template-columns: 1fr; } .ss-product-rail { grid-auto-flow: column; overflow: auto; border-right: 0; border-bottom: 1px solid var(--ss-product-border); } }
@media (prefers-reduced-motion: no-preference) { .ss-operator-sheet, .ss-library-sheet { animation: ss-sheet-in .18s ease-out; } @keyframes ss-sheet-in { from { transform: translateX(24px); opacity: .4; } to { transform: translateX(0); opacity: 1; } } }
```

- [ ] **Step 9: Run UI tests and build**

Run:

```bash
npm test
npm run web:build
```

Expected:

```text
npm test: PASS
npm run web:build: Compiled successfully
```

- [ ] **Step 10: Commit**

```bash
git add app/page.tsx app/chat/page.tsx app/workflow/page.tsx app/operations/page.tsx app/globals.css components/southstar/app-shell components/southstar/chat components/southstar/workflow components/southstar/operator components/southstar/operations tests/web/southstar-productized-app-shell-ui.test.tsx tests/index.test.ts lib/southstar/api-client.ts
git commit -m "feat: port pi web shell into southstar product tabs"
```

## Task 8: Add quantitative gates for productized planner and UI

**Files:**
- Create: `src/v2/quality/productized-ui-library-planner-gates.ts`
- Test: `tests/v2/productized-ui-library-planner-gates.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing gate tests**

Create `tests/v2/productized-ui-library-planner-gates.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { assertProductizedUiLibraryPlannerGates } from "../../src/v2/quality/productized-ui-library-planner-gates.ts";

test("productized planner gates pass with durable non-calc evidence", () => {
  const db = openSouthstarDb(":memory:");
  const taskIds = ["explore", "implement", "coding-review", "spec-alignment", "browser-qa", "summarize"];
  createWorkflowRun(db, {
    id: "run-productized",
    status: "passed",
    domain: "software",
    goalPrompt: "todo-web priority labels",
    workflowManifestJson: JSON.stringify({
      tasks: taskIds.map((id) => ({
        id,
        execution: { image: "southstar/pi-agent:local", mounts: [{ target: "/southstar-runs", readonly: true }] },
        skillRefs: [`software.${id}`],
        mcpGrantRefs: [id === "implement" ? "filesystem.workspace-write" : "filesystem.readonly"],
      })),
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: JSON.stringify({ aggregate: { tokens: 100, costUsd: 0, toolCalls: 10, retryCount: 1 } }),
  });
  for (const [index, id] of taskIds.entries()) {
    createWorkflowTask(db, { id, runId: "run-productized", taskKey: id, status: "completed", sortOrder: index, dependsOn: id === "implement" ? ["explore"] : ["coding-review", "spec-alignment", "browser-qa"].includes(id) ? ["implement"] : id === "summarize" ? ["coding-review", "spec-alignment", "browser-qa"] : [], rootSessionId: `root-${id}`, snapshot: {} });
    upsertRuntimeResource(db, { resourceType: "context_packet", resourceKey: `ctx-${id}`, runId: "run-productized", taskId: id, scope: "test", status: "created", payload: { tokenEstimate: { total: 1000 } } });
    upsertRuntimeResource(db, { resourceType: "memory_injection_trace", resourceKey: `mem-${id}`, runId: "run-productized", taskId: id, scope: "test", status: "created", payload: { included: [], excluded: [], decisionReason: "test" } });
    upsertRuntimeResource(db, { resourceType: "artifact", resourceKey: `artifact-${id}`, runId: "run-productized", taskId: id, scope: "test", status: "accepted", payload: { summary: id, evidence: true, risks: [] } });
    upsertRuntimeResource(db, { resourceType: "artifact_summary", resourceKey: `artifact-summary-${id}`, runId: "run-productized", taskId: id, scope: "test", status: "created", payload: { summary: id, evidenceRefs: [`evidence-${id}`], validatorRefs: [`validator-${id}`] } });
  }
  for (const resourceType of ["planner_draft", "library_search_trace", "agent_composition_trace", "template_selection_trace", "planner_decision_trace", "run_brief", "repo_fact_cache"]) {
    upsertRuntimeResource(db, { resourceType, resourceKey: `${resourceType}-1`, runId: "run-productized", scope: "test", status: "created", payload: resourceType === "agent_composition_trace" ? ["software.implementer", "software.coding-reviewer", "software.spec-alignment"] : { ok: true } });
  }
  upsertRuntimeResource(db, { resourceType: "evaluator_result", resourceKey: "eval-1", runId: "run-productized", scope: "test", status: "passed", payload: { ok: true } });
  upsertRuntimeResource(db, { resourceType: "stop_condition_result", resourceKey: "stop-1", runId: "run-productized", scope: "test", status: "passed", payload: { ok: true } });

  const result = assertProductizedUiLibraryPlannerGates(db, {
    runId: "run-productized",
    scenarioId: "todo-web-feature",
    timings: { plannerDraftMs: 1000, validationMs: 100, firstPlanningEventMs: 500, draftReviewVisibleMs: 500, operatorSheetOpenMs: 100, appShellRouteLoadMs: 500, e2eScenarioMs: 60_000 },
    visitedUiSurfaces: ["chat-tab", "workflow-new-goal", "workflow-planning", "workflow-draft-review", "operations-tab", "task-inspector", "library-alternatives", "context-sources", "operator-sheet"],
  });
  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("productized planner gates fail closed for calc scenario or missing context economy", () => {
  const db = openSouthstarDb(":memory:");
  const result = assertProductizedUiLibraryPlannerGates(db, {
    runId: "missing",
    scenarioId: "calc-feature",
    timings: { plannerDraftMs: 181_000, validationMs: 4_000, firstPlanningEventMs: 11_000, draftReviewVisibleMs: 6_000, operatorSheetOpenMs: 400, appShellRouteLoadMs: 4_000, e2eScenarioMs: 26 * 60_000 },
    visitedUiSurfaces: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /non-calc|run not found|planner draft|Southstar UI/);
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./productized-ui-library-planner-gates.test.ts");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing gate module.

- [ ] **Step 3: Implement quantitative gates**

Create `src/v2/quality/productized-ui-library-planner-gates.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { listResources } from "../stores/resource-store.ts";

export type ProductizedPlannerGateInput = {
  runId: string;
  scenarioId: string;
  timings: {
    plannerDraftMs: number;
    validationMs: number;
    firstPlanningEventMs: number;
    draftReviewVisibleMs: number;
    operatorSheetOpenMs: number;
    appShellRouteLoadMs: number;
    e2eScenarioMs: number;
  };
  visitedUiSurfaces: string[];
};

export type ProductizedPlannerGateResult = { ok: boolean; failures: string[] };

const requiredUiSurfaces = ["chat-tab", "workflow-new-goal", "workflow-planning", "workflow-draft-review", "operations-tab", "task-inspector", "library-alternatives", "context-sources"];

export function assertProductizedUiLibraryPlannerGates(db: SouthstarDb, input: ProductizedPlannerGateInput): ProductizedPlannerGateResult {
  const failures: string[] = [];
  if (/calc/i.test(input.scenarioId)) failures.push("E2E scenario must be non-calc");
  max(failures, "planner draft", input.timings.plannerDraftMs, 180_000);
  max(failures, "manifest validation", input.timings.validationMs, 3_000);
  max(failures, "first planning event", input.timings.firstPlanningEventMs, 10_000);
  max(failures, "Draft Review visible", input.timings.draftReviewVisibleMs, 5_000);
  max(failures, "Operator sheet open", input.timings.operatorSheetOpenMs, 300);
  max(failures, "Southstar App Shell route load", input.timings.appShellRouteLoadMs, 3_000);
  max(failures, "E2E scenario", input.timings.e2eScenarioMs, 25 * 60_000);

  const run = db.prepare("select status, goal_prompt from workflow_runs where id = ?").get(input.runId) as { status: string; goal_prompt: string } | undefined;
  if (!run) failures.push(`run not found: ${input.runId}`);
  if (run && !["passed", "completed"].includes(run.status)) failures.push(`run must be passed/completed, got ${run.status}`);
  if (run && /calc/i.test(run.goal_prompt)) failures.push("run goal must be non-calc");

  for (const resourceType of ["planner_draft", "library_search_trace", "agent_composition_trace", "template_selection_trace", "planner_decision_trace", "run_brief", "repo_fact_cache"]) {
    if (!listResources(db, { resourceType }).some((resource) => resource.runId === input.runId || resource.resourceType === "planner_draft")) {
      failures.push(`${resourceType} evidence is required`);
    }
  }

  const tasks = db.prepare("select id from workflow_tasks where run_id = ?").all(input.runId) as Array<{ id: string }>;
  if (tasks.length < 4) failures.push(`DAG must have at least 4 tasks, got ${tasks.length}`);
  for (const task of tasks) {
    if (!listResources(db, { resourceType: "context_packet" }).some((resource) => resource.runId === input.runId && resource.taskId === task.id)) failures.push(`task ${task.id} missing ContextPacket`);
    if (!listResources(db, { resourceType: "memory_injection_trace" }).some((resource) => resource.runId === input.runId && resource.taskId === task.id)) failures.push(`task ${task.id} missing memory injection trace`);
    if (!listResources(db, { resourceType: "artifact" }).some((resource) => resource.runId === input.runId && resource.taskId === task.id && resource.status === "accepted")) failures.push(`task ${task.id} missing accepted artifact`);
  }

  if (tasks.some((task) => task.id === "implement" || task.id === "fix" || task.id === "refactor")) {
    for (const reviewer of ["coding-review", "spec-alignment"]) {
      if (!tasks.some((task) => task.id === reviewer)) failures.push(`parallel review lane missing ${reviewer}`);
    }
  }

  const workflowRow = db.prepare("select workflow_manifest_json from workflow_runs where id = ?").get(input.runId) as { workflow_manifest_json: string } | undefined;
  if (workflowRow) {
    const workflow = JSON.parse(workflowRow.workflow_manifest_json) as { tasks?: Array<{ id: string; execution?: { image?: string; mounts?: Array<{ target: string; readonly: boolean }> }; skillRefs?: string[]; mcpGrantRefs?: string[] }> };
    for (const task of workflow.tasks ?? []) {
      if ((task.execution?.image ?? "southstar/pi-agent:local") !== "southstar/pi-agent:local") failures.push(`task ${task.id} uses unapproved image ${task.execution?.image}`);
      if (!(task.execution?.mounts ?? []).some((mount) => mount.target === "/southstar-runs" && mount.readonly === true)) failures.push(`task ${task.id} missing readonly /southstar-runs mount`);
      if ((task.skillRefs ?? []).length === 0) failures.push(`task ${task.id} missing selected skill refs`);
      if ((task.mcpGrantRefs ?? []).length === 0) failures.push(`task ${task.id} missing selected MCP/tool grants`);
    }
  }

  if (!listResources(db, { resourceType: "evaluator_result" }).some((resource) => resource.runId === input.runId && (resource.status === "passed" || (resource.payload as { ok?: boolean }).ok === true))) failures.push("passed evaluator_result is required");
  if (!listResources(db, { resourceType: "stop_condition_result" }).some((resource) => resource.runId === input.runId && resource.status === "passed")) failures.push("passed stop_condition_result is required");

  const visited = new Set(input.visitedUiSurfaces);
  for (const surface of requiredUiSurfaces) {
    if (!visited.has(surface)) failures.push(`Southstar UI did not visit ${surface}`);
  }

  return { ok: failures.length === 0, failures };
}

function max(failures: string[], label: string, actual: number, maximum: number): void {
  if (!Number.isFinite(actual) || actual > maximum) failures.push(`${label} must be <= ${maximum}ms, got ${actual}ms`);
}
```

- [ ] **Step 4: Run gate tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for quantitative gate tests.

- [ ] **Step 5: Commit**

```bash
git add src/v2/quality/productized-ui-library-planner-gates.ts tests/v2/productized-ui-library-planner-gates.test.ts tests/v2/index.test.ts
git commit -m "feat: gate productized planner evidence"
```

## Task 9: Add non-calc real E2E scenarios and fixture expectations

**Files:**
- Create: `tests/e2e-real/scenarios/todo-web-feature.ts`
- Create: `tests/e2e-real/scenarios/markdown-table-bugfix.ts`
- Create: `tests/e2e-real/scenarios/docs-cli-usage.ts`
- Create: `tests/e2e-real/scenarios/refactor-safety-net.ts`
- Modify: `tests/e2e-real/index.test.ts`
- Modify: `package.json` if a separate script is preferred

- [ ] **Step 1: Add E2E scenario contracts before implementation**

Create `tests/e2e-real/scenarios/todo-web-feature.ts`:

```ts
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../../src/v2/stores/sqlite.ts";
import { assertProductizedUiLibraryPlannerGates } from "../../../src/v2/quality/productized-ui-library-planner-gates.ts";

export const todoWebFeatureScenario = {
  id: "todo-web-feature",
  goalPrompt: "在 todo-web fixture repo 中新增 priority labels、due dates、overdue filter，保持 localStorage persistence，並更新 README usage。需要瀏覽器層級 QA 與 spec alignment review。",
  assertPlannerDraft(db: SouthstarDb, draftId: string) {
    const row = db.prepare("select payload_json from runtime_resources where resource_type = 'planner_draft' and resource_key = ?").get(draftId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { workflow: { tasks: Array<{ id: string }> } };
    const taskIds = payload.workflow.tasks.map((task) => task.id);
    assert.equal(taskIds.includes("coding-review"), true);
    assert.equal(taskIds.includes("spec-alignment"), true);
    assert.equal(taskIds.includes("browser-qa"), true);
    assert.equal(taskIds.includes("release-merge-operation"), false);
  },
  assertFinalGates(db: SouthstarDb, runId: string, timings: Parameters<typeof assertProductizedUiLibraryPlannerGates>[1]["timings"]) {
    const result = assertProductizedUiLibraryPlannerGates(db, {
      runId,
      scenarioId: "todo-web-feature",
      timings,
      visitedUiSurfaces: ["chat-tab", "workflow-new-goal", "workflow-planning", "workflow-draft-review", "operations-tab", "task-inspector", "library-alternatives", "context-sources", "operator-sheet"],
    });
    assert.equal(result.ok, true, result.failures.join("\n"));
  },
};
```

Create `tests/e2e-real/scenarios/markdown-table-bugfix.ts`:

```ts
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../../src/v2/stores/sqlite.ts";

export const markdownTableBugfixScenario = {
  id: "markdown-table-bugfix",
  goalPrompt: "在 markdown-notes fixture repo 中診斷並修復 table parser 在 escaped pipe 與 code span 中切欄錯誤的 bug。先重現失敗，再修復，最後補 regression tests。",
  assertPlannerDraft(db: SouthstarDb, draftId: string) {
    const row = db.prepare("select payload_json from runtime_resources where resource_type = 'planner_draft' and resource_key = ?").get(draftId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { workflow: { tasks: Array<{ id: string }> } };
    const taskIds = payload.workflow.tasks.map((task) => task.id);
    assert.equal(taskIds.includes("reproduce"), true);
    assert.equal(taskIds.includes("diagnose"), true);
    assert.equal(taskIds.includes("fix"), true);
    assert.equal(taskIds.includes("regression-check"), true);
    assert.equal(taskIds.includes("browser-qa"), false);
  },
};
```

Create `tests/e2e-real/scenarios/docs-cli-usage.ts`:

```ts
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../../src/v2/stores/sqlite.ts";

export const docsCliUsageScenario = {
  id: "docs-cli-usage",
  goalPrompt: "在 notes-cli fixture repo 中更新 README 與 docs，補上 import/export 指令的使用範例、錯誤處理說明與常見問題。不要修改 runtime code。",
  assertPlannerDraft(db: SouthstarDb, draftId: string) {
    const row = db.prepare("select payload_json from runtime_resources where resource_type = 'planner_draft' and resource_key = ?").get(draftId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { workflow: { tasks: Array<{ id: string; agentProfileRef?: string }> } };
    const taskIds = payload.workflow.tasks.map((task) => task.id);
    assert.equal(taskIds.includes("write-docs"), true);
    assert.equal(taskIds.includes("doc-check"), true);
    assert.equal(payload.workflow.tasks.some((task) => task.agentProfileRef === "software.implementer.pi.workspace-write" && task.id !== "write-docs"), false);
  },
};
```

Create `tests/e2e-real/scenarios/refactor-safety-net.ts`:

```ts
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../../src/v2/stores/sqlite.ts";

export const refactorSafetyNetScenario = {
  id: "refactor-safety-net",
  goalPrompt: "在 task-runner fixture repo 中重構 command execution module，降低重複邏輯但不可改變公開 CLI 行為。先建立 baseline tests，再重構，最後跑 regression suite。",
  assertPlannerDraft(db: SouthstarDb, draftId: string) {
    const row = db.prepare("select payload_json from runtime_resources where resource_type = 'planner_draft' and resource_key = ?").get(draftId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { workflow: { tasks: Array<{ id: string }> } };
    const taskIds = payload.workflow.tasks.map((task) => task.id);
    assert.equal(taskIds.includes("baseline-check"), true);
    assert.equal(taskIds.includes("refactor"), true);
    assert.equal(taskIds.includes("regression-check"), true);
    assert.equal(taskIds.includes("coding-review"), true);
    assert.equal(taskIds.includes("spec-alignment"), true);
  },
};
```

- [ ] **Step 2: Wire E2E index to scenario contracts**

Modify `tests/e2e-real/index.test.ts` to import the scenario contracts and run the planner-draft stage for each scenario before full live execution. Use the existing real E2E environment guard. Add a subtest that can run in local mode with fake executor if live credentials are absent, and keep full live mode behind the existing env guard.

Expected code shape:

```ts
await import("./scenarios/todo-web-feature.ts");
await import("./scenarios/markdown-table-bugfix.ts");
await import("./scenarios/docs-cli-usage.ts");
await import("./scenarios/refactor-safety-net.ts");
```

- [ ] **Step 3: Run E2E scenario imports**

Run:

```bash
npm run test:e2e:real
```

Expected in an environment without live requirements: fail closed with existing missing-env message after scenario modules load. Expected in live environment: scenarios execute and gates pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e-real/scenarios/todo-web-feature.ts tests/e2e-real/scenarios/markdown-table-bugfix.ts tests/e2e-real/scenarios/docs-cli-usage.ts tests/e2e-real/scenarios/refactor-safety-net.ts tests/e2e-real/index.test.ts package.json
git commit -m "test: add non calc productized e2e scenarios"
```

## Task 10: Add coverage matrix and final verification

**Files:**
- Create: `docs/superpowers/productized-ui-library-planner-coverage.md`

- [ ] **Step 1: Create coverage matrix**

Create `docs/superpowers/productized-ui-library-planner-coverage.md`:

```md
# Southstar Productized UI + Library-aware Planner Coverage

Source spec: `docs/superpowers/specs/2026-06-16-southstar-productized-ui-library-aware-planner-design.zh.md`

| Requirement | Evidence | Implementation |
| --- | --- | --- |
| Southstar App Shell with Chat / Workflow / Operations | `tests/web/southstar-productized-app-shell-ui.test.tsx`, `npm run web:build` | `app/page.tsx`, `app/chat/page.tsx`, `app/workflow/page.tsx`, `app/operations/page.tsx`, `components/southstar/app-shell/*`, `components/southstar/chat/*`, `components/southstar/workflow/*`, `components/southstar/operations/*` |
| Library-aware Planner core | `tests/v2/library-aware-planner.test.ts`, `tests/v2/productized-planner-draft.test.ts` | `src/v2/planner/library-aware-planner.ts`, `src/v2/ui-api/local-api.ts` |
| Planner result validation | `tests/v2/library-aware-planner-validator.test.ts` | `src/v2/planner/library-aware-validator.ts`, `src/v2/planner/library-aware-types.ts` |
| Software Engineering Starter Library v1 | `tests/v2/software-engineering-starter-library.test.ts` | `src/v2/design-library/software-engineering-starter.ts` |
| Coding reviewer / spec alignment / browser QA | planner and starter library tests | starter library seed, planner task generation |
| Release operator consolidation | starter library tests | `software.release-operator` profiles and skills |
| Task-level parallelism | planner tests and quantitative gates | planner DAG tasks and dependsOn edges |
| Context Economy | `tests/v2/context-economy.test.ts`, quantitative gates | `src/v2/context/economy.ts`, `src/v2/context/builder.ts`, `src/v2/ui-api/local-api.ts` |
| Fixed runner image + task-delivered skills/MCP | planner validator and quantitative gates | `src/v2/planner/library-aware-validator.ts`, `src/v2/ui-api/local-api.ts`, `src/v2/quality/productized-ui-library-planner-gates.ts` |
| Floating Operator | read model and web tests | `src/v2/ui-api/page-models/operator-attention.ts`, `OperatorDock`, `OperatorSheet` |
| Library alternatives side sheet | read model and web tests | `src/v2/ui-api/page-models/library-alternatives.ts`, `LibraryAlternativesSheet` |
| Non-calc E2E scenarios | `npm run test:e2e:real` in live environment | `tests/e2e-real/scenarios/*` |
| Quantitative gates | `tests/v2/productized-ui-library-planner-gates.test.ts` | `src/v2/quality/productized-ui-library-planner-gates.ts` |
```

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run test:v2
npm run web:build
```

Expected:

```text
npm test: all subtests pass
npm run test:v2: all subtests pass
npm run web:build: Compiled successfully
```

If live E2E credentials and fixture services are available, run:

```bash
npm run test:e2e:real
```

Expected:

```text
non-calc productized E2E scenarios complete or fail closed with explicit environment reason
```

- [ ] **Step 3: Commit coverage docs**

```bash
git add docs/superpowers/productized-ui-library-planner-coverage.md
git commit -m "docs: map productized planner coverage"
```

## Completion audit checklist

Before claiming complete, verify each item with file paths and command output:

- [ ] Starter Library has five workflow templates.
- [ ] Starter Library includes coding-reviewer, spec-alignment, browser-qa, release-operator, release-reporter.
- [ ] Release operator is one agent definition with separate commit/readiness/merge profiles and skills.
- [ ] Planner skill exists and is used by the planning path.
- [ ] `createPlannerDraft` produces library-aware drafts when Starter Library exists.
- [ ] Draft resources include library search, template selection, agent composition, and planner decision traces.
- [ ] Southstar App Shell shows Chat, Workflow, and Operations tabs.
- [ ] Workflow tab shows guided planner chat, Library Context, DAG review, inspector, context sources, Library alternatives, and Operator.
- [ ] Context Economy resources are persisted and consumed.
- [ ] E2E scenario prompts are non-calc.
- [ ] Fixed runner image is preserved; planner validation rejects ad hoc images.
- [ ] Skill snapshots, MCP/tool grants, context packets, and `/southstar-runs` mount provide task specialization.
- [ ] Quantitative gates fail closed when evidence is missing.
- [ ] `npm test`, `npm run test:v2`, and `npm run web:build` pass.
- [ ] Live E2E is either passed with evidence or explicitly not run because required live environment is absent.
