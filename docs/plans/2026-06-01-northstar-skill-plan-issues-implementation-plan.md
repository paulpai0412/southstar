# Northstar Skill Plan-Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Matt-Pocock-style Northstar skill workflow backed by a production `northstar plan-issues` command that creates runtime-ready GitHub issues from Northstar specs and implementation plans.

**Architecture:** Put issue modeling in a pure `src/planning` module, GitHub/Project mutations behind an adapter boundary, and runtime intake in a command orchestrator that composes config, GitHub, Project, and SQLite dependencies. The skill remains the interactive UX and delegates all mutations to the production CLI.

**Tech Stack:** TypeScript, Node test runner, Node SQLite, existing GitHub REST/GraphQL adapters, existing Northstar CLI, existing Northstar skill scripts.

---

## File Structure

- Create `src/planning/plan-issues.ts`
  - Pure parser/modeler for spec + plan to issue table.
  - Owns `root_session_fit`, secret scanning, dependency graph validation, source fingerprinting, frontmatter/body generation, idempotency marker generation.
- Create `src/planning/plan-issues-command.ts`
  - Production command orchestrator for dry-run/apply.
  - Composes config, GitHub issue gateway, Project sync, and optional runtime intake.
- Create `src/adapters/github/plan-issues.ts`
  - GitHub issue create/reuse/update gateway.
  - No shell commands.
  - Uses REST for issues/labels and existing `GitHubObservabilityAdapter.syncProjectFields` for Project fields.
- Modify `src/cli/northstar.ts`
  - Add `plan-issues` to command list.
  - Add help text for `plan-issues`.
- Modify `src/cli/entrypoint.ts`
  - Route `plan-issues` to `runPlanIssuesCommand`.
- Modify `src/orchestrator/production-dependencies.ts` or `src/orchestrator/production-factory.ts`
  - Expose enough production dependency composition to create the plan-issues command without duplicating config/credential logic.
- Modify `skills/northstar/SKILL.md`
  - Document `/northstar-grill`, `/northstar-to-spec`, `/northstar-to-plan`, `/northstar-to-issues`.
  - Require docs under `docs/specs` and `docs/plans`.
  - Require production CLI for mutation.
- Modify `skills/northstar/scripts/lib/project-viewer.mjs`
  - Add planning fields and `Planning` view definitions.
- Modify `skills/northstar/scripts/lib/operator-commands.mjs`
  - Route `plan issues` to `northstar plan-issues --dry-run`.
- Test files:
  - Create `tests/planning/plan-issues.test.ts`
  - Create `tests/adapters/github-plan-issues.test.ts`
  - Create `tests/cli/plan-issues-cli.test.ts`
  - Create `tests/e2e-plan-issues/plan-issues-e2e.test.ts`
  - Create `tests/e2e-plan-issues/index.test.ts`
  - Create `tests/e2e-plan-issues-live/plan-issues-live.test.ts`
  - Create `tests/e2e-plan-issues-live/index.test.ts`
  - Modify `tests/index.test.ts`
  - Modify `tests/skills/northstar-skill-files.test.ts`
  - Modify `tests/skills/northstar-project-viewer.test.ts`
  - Modify `tests/skills/northstar-operator-commands.test.ts`
  - Modify `package.json`

---

## Task 1: Pure Issue Table Modeling

**Files:**
- Create: `src/planning/plan-issues.ts`
- Create: `tests/planning/plan-issues.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing tests for issue table generation**

Add `tests/planning/plan-issues.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  generatePlanIssueTable,
  formatPlanIssueBody,
  planIssueSourceFingerprint,
} from "../../src/planning/plan-issues.ts";

const specText = `# Search Design

## Goal
Ship reliable search filters.

## Acceptance Criteria
- Users can filter by status.
- Users can filter by owner.

## Quantitative Metrics
- search_filter_latency_ms_p95 <= 250
`;

const planText = `# Search Implementation Plan

### Task 1: Build Filter Model

**Files:**
- Create: \`src/search/filter-model.ts\`
- Test: \`tests/search/filter-model.test.ts\`

- [ ] **Step 1: Write the failing test**

\`\`\`ts
assert.equal(parseFilter("?status=open").status, "open");
\`\`\`

Acceptance Criteria:
- Filter state round-trips through URL params.
- Invalid filter values are ignored.

Required Tests:
- node --disable-warning=ExperimentalWarning tests/search/filter-model.test.ts

### Task 2: Render Search Results

Depends-On: Task 1

**Files:**
- Modify: \`src/search/results.ts\`
- Test: \`tests/search/results.test.ts\`

Acceptance Criteria:
- Matching rows update when filters change.
- Empty results show recovery copy.

Required Tests:
- node --disable-warning=ExperimentalWarning tests/search/results.test.ts
`;

test("generatePlanIssueTable emits Northstar issue rows with required fields", () => {
  const result = generatePlanIssueTable({
    specText,
    planText,
    specPath: "docs/specs/search-design.md",
    planPath: "docs/plans/search-implementation-plan.md",
    workflowId: "issue_to_pr_release",
    domain: "software_development",
  });

  assert.equal(result.metrics.plan_issues_dry_run_mutations, 0);
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[0].issue_key, "ISS-001");
  assert.equal(result.issues[0].type, "AFK");
  assert.equal(result.issues[0].priority, 100);
  assert.equal(result.issues[0].root_session_fit, true);
  assert.equal(result.issues[0].workflow_id, "issue_to_pr_release");
  assert.equal(result.issues[0].domain, "software_development");
  assert.equal(result.issues[0].initial_lifecycle, "ready");
  assert.equal(result.issues[0].project_status, "Todo");
  assert.equal(result.issues[0].current_stage, "implementation");
  assert.equal(result.issues[0].source_spec, "docs/specs/search-design.md");
  assert.equal(result.issues[0].source_plan, "docs/plans/search-implementation-plan.md");
  assert.match(result.issues[0].source_fingerprint, /^sha256:/);
  assert.deepEqual(result.issues[1].depends_on, ["ISS-001"]);
  assert.equal(result.metrics.plan_issues_issue_table_fields >= 16, true);
  assert.equal(result.metrics.plan_issues_dependency_edges_preserved, 1);
});

test("formatPlanIssueBody writes frontmatter and idempotency marker", () => {
  const result = generatePlanIssueTable({
    specText,
    planText,
    specPath: "docs/specs/search-design.md",
    planPath: "docs/plans/search-implementation-plan.md",
  });
  const body = formatPlanIssueBody(result.issues[0], { numberByIssueKey: new Map([["ISS-001", 12]]) });

  assert.match(body, /^---\ndepends_on: \[\]\npriority: 100/m);
  assert.match(body, /northstar:\n  issue_key: ISS-001\n  workflow_id: issue_to_pr_release/);
  assert.match(body, /root_session_fit: true/);
  assert.match(body, /<!-- northstar-plan-issue\nissue_key: ISS-001\nsource_fingerprint: sha256:/);
});

test("planIssueSourceFingerprint is stable for identical inputs", () => {
  const left = planIssueSourceFingerprint({
    specText,
    planText,
    specPath: "docs/specs/search-design.md",
    planPath: "docs/plans/search-implementation-plan.md",
    issueKey: "ISS-001",
  });
  const right = planIssueSourceFingerprint({
    specText,
    planText,
    specPath: "docs/specs/search-design.md",
    planPath: "docs/plans/search-implementation-plan.md",
    issueKey: "ISS-001",
  });

  assert.equal(left, right);
  assert.match(left, /^sha256:[a-f0-9]{64}$/);
});
```

Modify `tests/index.test.ts`:

```ts
import "./planning/plan-issues.test.ts";
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/planning/plan-issues.test.ts
```

Expected: FAIL with module not found for `src/planning/plan-issues.ts`.

- [ ] **Step 3: Implement minimal pure model**

Create `src/planning/plan-issues.ts` with these exports and behavior:

```ts
import { createHash } from "node:crypto";
import { redactSecrets } from "../runtime/redaction.ts";

export type PlanIssueType = "AFK" | "HITL";

export interface GeneratePlanIssueTableInput {
  specText: string;
  planText: string;
  specPath: string;
  planPath: string;
  workflowId?: string;
  domain?: string;
}

export interface PlanIssueRow {
  issue_key: string;
  title: string;
  type: PlanIssueType;
  priority: number;
  depends_on: string[];
  root_session_fit: boolean;
  root_session_fit_reason: string;
  acceptance_cluster: string;
  required_tests: string[];
  browser_evidence_required: boolean;
  workflow_id: string;
  domain: string;
  initial_lifecycle: "ready" | "blocked";
  project_status: "Todo" | "Blocked";
  current_stage: "implementation";
  source_spec: string;
  source_plan: string;
  source_fingerprint: string;
  body_sections: {
    objective: string;
    scope: string;
    acceptanceCriteria: string[];
    quantitativeMetrics: string[];
    requiredTests: string[];
  };
}

export interface PlanIssueTableResult {
  issues: PlanIssueRow[];
  dependencyEdges: Array<{ from: string; to: string }>;
  metrics: Record<string, number>;
}

export function generatePlanIssueTable(input: GeneratePlanIssueTableInput): PlanIssueTableResult {
  assertNoSecretShape(`${input.specText}\n${input.planText}`);
  const tasks = parsePlanTasks(input.planText);
  const issueKeyByTaskId = new Map(tasks.map((task, index) => [task.id, issueKey(index)]));
  const dependencyEdges = tasks.flatMap((task) => task.dependencies.map((dependency) => ({
    from: issueKeyByTaskId.get(task.id)!,
    to: issueKeyByTaskId.get(dependency)!,
  })));
  assertNoMissingDependencies(tasks);
  assertNoCycles(tasks);

  const issues = tasks.map((task, index) => {
    const key = issueKey(index);
    const requiredTests = task.requiredTests;
    const acceptanceCriteria = task.acceptanceCriteria;
    const root = evaluateRootSessionFit({
      acceptanceCriteriaCount: acceptanceCriteria.length,
      requiredTestsCount: requiredTests.length,
      estimatedFilesCount: task.files.length,
      hasHumanDecision: /human|manual decision|approval required/i.test(task.content),
      hasExternalRisk: /credential|billing|production data/i.test(task.content),
    });
    return {
      issue_key: key,
      title: task.title,
      type: root.fit ? "AFK" : "HITL",
      priority: Math.max(10, 100 - index * 10),
      depends_on: dependencyEdges.filter((edge) => edge.from === key).map((edge) => edge.to),
      root_session_fit: root.fit,
      root_session_fit_reason: root.reason,
      acceptance_cluster: slug(task.title),
      required_tests: requiredTests,
      browser_evidence_required: /browser|playwright|chrome|uat/i.test(task.content),
      workflow_id: input.workflowId ?? "issue_to_pr_release",
      domain: input.domain ?? "software_development",
      initial_lifecycle: root.fit ? "ready" : "blocked",
      project_status: root.fit ? "Todo" : "Blocked",
      current_stage: "implementation",
      source_spec: input.specPath,
      source_plan: input.planPath,
      source_fingerprint: planIssueSourceFingerprint({
        specText: input.specText,
        planText: input.planText,
        specPath: input.specPath,
        planPath: input.planPath,
        issueKey: key,
      }),
      body_sections: {
        objective: task.objective,
        scope: task.scope,
        acceptanceCriteria,
        quantitativeMetrics: task.quantitativeMetrics,
        requiredTests,
      },
    } satisfies PlanIssueRow;
  });

  return {
    issues,
    dependencyEdges,
    metrics: {
      plan_issues_dry_run_mutations: 0,
      plan_issues_issue_table_fields: 18,
      plan_issues_dependency_edges_preserved: dependencyEdges.length,
      plan_issues_secret_leaks: 0,
    },
  };
}

export function formatPlanIssueBody(row: PlanIssueRow, input: { numberByIssueKey: Map<string, number> }): string {
  const dependsOnNumbers = row.depends_on
    .map((key) => input.numberByIssueKey.get(key))
    .filter((value): value is number => typeof value === "number");
  const dependencyLines = dependsOnNumbers.map((number) => `Depends-On: #${number}`);
  return [
    "---",
    `depends_on: [${dependsOnNumbers.join(", ")}]`,
    `priority: ${row.priority}`,
    "northstar:",
    `  issue_key: ${row.issue_key}`,
    `  workflow_id: ${row.workflow_id}`,
    `  domain: ${row.domain}`,
    `  type: ${row.type}`,
    `  root_session_fit: ${row.root_session_fit}`,
    `  acceptance_cluster: ${row.acceptance_cluster}`,
    `  browser_evidence_required: ${row.browser_evidence_required}`,
    "  required_tests:",
    ...row.required_tests.map((command) => `    - ${command}`),
    `  source_spec: ${row.source_spec}`,
    `  source_plan: ${row.source_plan}`,
    `  source_fingerprint: ${row.source_fingerprint}`,
    "---",
    "",
    "## Objective",
    row.body_sections.objective || row.title,
    "",
    "## Scope",
    row.body_sections.scope || "Constrained to this issue row.",
    "",
    "## Acceptance Criteria",
    formatBullets(row.body_sections.acceptanceCriteria),
    "",
    "## Quantitative Metrics",
    formatBullets(row.body_sections.quantitativeMetrics),
    "",
    "## Required Tests",
    formatBullets(row.required_tests),
    "",
    "## Dependencies",
    dependencyLines.length ? dependencyLines.join("\n") : "None.",
    "",
    "<!-- northstar-plan-issue",
    `issue_key: ${row.issue_key}`,
    `source_fingerprint: ${row.source_fingerprint}`,
    "-->",
  ].join("\n");
}

export function planIssueSourceFingerprint(input: {
  specText: string;
  planText: string;
  specPath: string;
  planPath: string;
  issueKey: string;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

function assertNoSecretShape(text: string): void {
  const redacted = redactSecrets(text);
  if (redacted !== text || /\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b/.test(text)) {
    throw new Error("NORTHSTAR_PLAN_ISSUES_SECRET_LEAK_DETECTED");
  }
}

interface ParsedTask {
  id: string;
  title: string;
  content: string;
  dependencies: string[];
  objective: string;
  scope: string;
  acceptanceCriteria: string[];
  quantitativeMetrics: string[];
  requiredTests: string[];
  files: string[];
}

function parsePlanTasks(planText: string): ParsedTask[] {
  const taskMatches = [...planText.matchAll(/^#{2,}\s*Task\s+(\d+)\s*[:.-]?\s*(.+?)\s*$/gim)];
  if (taskMatches.length === 0) throw new Error("NORTHSTAR_PLAN_ISSUES_INPUT_INVALID: plan must contain task headings");
  return taskMatches.map((match, index) => {
    const start = match.index! + match[0].length;
    const end = index + 1 < taskMatches.length ? taskMatches[index + 1].index! : planText.length;
    const content = planText.slice(start, end).trim();
    return {
      id: `Task ${match[1]}`,
      title: `Task ${match[1]}: ${match[2].trim()}`,
      content,
      dependencies: parseDependencies(content),
      objective: sectionText(content, "Objective") || firstParagraph(content),
      scope: sectionText(content, "Scope"),
      acceptanceCriteria: bulletsInSection(content, "Acceptance Criteria"),
      quantitativeMetrics: bulletsInSection(content, "Quantitative Metrics"),
      requiredTests: bulletsInSection(content, "Required Tests"),
      files: [...content.matchAll(/`([^`]+\.(?:ts|tsx|js|mjs|md|yaml|json))`/g)].map((item) => item[1]),
    };
  });
}

function parseDependencies(content: string): string[] {
  const dependencies: string[] = [];
  for (const match of content.matchAll(/^Depends-On:\s*(.+?)\s*$/gim)) {
    for (const raw of match[1].split(",")) {
      const value = raw.trim();
      if (/^Task\s+\d+$/i.test(value)) dependencies.push(value.replace(/^task/i, "Task"));
    }
  }
  return dependencies;
}

function assertNoMissingDependencies(tasks: ParsedTask[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) throw new Error(`NORTHSTAR_PLAN_ISSUES_MISSING_DEPENDENCY: ${task.id} depends on ${dependency}`);
    }
  }
}

function assertNoCycles(tasks: ParsedTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, stack: string[]) => {
    if (visiting.has(id)) throw new Error(`NORTHSTAR_PLAN_ISSUES_DEPENDENCY_CYCLE: ${[...stack, id].join(" -> ")}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency, [...stack, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id, []);
}

function evaluateRootSessionFit(input: {
  acceptanceCriteriaCount: number;
  requiredTestsCount: number;
  estimatedFilesCount: number;
  hasHumanDecision: boolean;
  hasExternalRisk: boolean;
}): { fit: boolean; reason: string } {
  if (input.acceptanceCriteriaCount > 5) return { fit: false, reason: "split_required: acceptance criteria > 5" };
  if (input.requiredTestsCount > 4) return { fit: false, reason: "split_required: required tests > 4" };
  if (input.estimatedFilesCount > 4) return { fit: false, reason: "split_required: estimated files > 4" };
  if (input.hasHumanDecision) return { fit: false, reason: "human decision required" };
  if (input.hasExternalRisk) return { fit: false, reason: "external credential, billing, or production data risk" };
  return { fit: true, reason: "fits one Northstar root session" };
}

function issueKey(index: number): string {
  return `ISS-${String(index + 1).padStart(3, "0")}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function formatBullets(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "Not specified.";
}

function bulletsInSection(content: string, name: string): string[] {
  return sectionText(content, name).split("\n").map((line) => line.replace(/^-\s*/, "").trim()).filter(Boolean);
}

function sectionText(content: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`${escaped}:\\n([\\s\\S]*?)(?:\\n\\n[A-Z][A-Za-z ]+:|$)`, "i"))?.[1]?.trim() ?? "";
}

function firstParagraph(content: string): string {
  return content.split(/\n\s*\n/).find((part) => part.trim() && !part.trim().startsWith("Depends-On:"))?.trim() ?? "";
}
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/planning/plan-issues.test.ts
```

Expected: PASS for 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/planning/plan-issues.ts tests/planning/plan-issues.test.ts tests/index.test.ts
git commit -m "Add plan-issues table model"
```

---

## Task 2: Root Session Fit, Dependency, And Secret Gates

**Files:**
- Modify: `src/planning/plan-issues.ts`
- Modify: `tests/planning/plan-issues.test.ts`

- [ ] **Step 1: Write failing gate tests**

Append to `tests/planning/plan-issues.test.ts`:

```ts
test("root_session_fit gate rejects large, risky, and human-decision tasks", () => {
  const oversizedPlan = `# Oversized Plan

### Task 1: Large Feature

Acceptance Criteria:
- One
- Two
- Three
- Four
- Five
- Six

Required Tests:
- npm test
`;
  const humanDecisionPlan = `# Human Plan

### Task 1: Choose Vendor

Acceptance Criteria:
- Human approval required before implementation.

Required Tests:
- npm test
`;

  const oversized = generatePlanIssueTable({ specText, planText: oversizedPlan, specPath: "docs/specs/a.md", planPath: "docs/plans/a.md" });
  const hitl = generatePlanIssueTable({ specText, planText: humanDecisionPlan, specPath: "docs/specs/b.md", planPath: "docs/plans/b.md" });

  assert.equal(oversized.issues[0].root_session_fit, false);
  assert.equal(oversized.issues[0].type, "HITL");
  assert.equal(oversized.issues[0].initial_lifecycle, "blocked");
  assert.match(oversized.issues[0].root_session_fit_reason, /acceptance criteria/i);
  assert.equal(hitl.issues[0].root_session_fit, false);
  assert.match(hitl.issues[0].root_session_fit_reason, /human decision/i);
  assert.equal(oversized.metrics.plan_issues_root_session_fit_gate_cases >= 4, true);
});

test("dependency validation rejects missing references and cycles", () => {
  assert.throws(
    () => generatePlanIssueTable({
      specText,
      planText: `# Bad Plan\n\n### Task 1: Missing\n\nDepends-On: Task 99\n\nAcceptance Criteria:\n- Done\n`,
      specPath: "docs/specs/bad.md",
      planPath: "docs/plans/bad.md",
    }),
    /NORTHSTAR_PLAN_ISSUES_MISSING_DEPENDENCY/,
  );

  assert.throws(
    () => generatePlanIssueTable({
      specText,
      planText: `# Cycle Plan\n\n### Task 1: First\nDepends-On: Task 2\n\n### Task 2: Second\nDepends-On: Task 1\n`,
      specPath: "docs/specs/cycle.md",
      planPath: "docs/plans/cycle.md",
    }),
    /NORTHSTAR_PLAN_ISSUES_DEPENDENCY_CYCLE/,
  );
});

test("secret scan rejects token-shaped values", () => {
  assert.throws(
    () => generatePlanIssueTable({
      specText,
      planText: `${planText}\n\n### Task 3: Leak\n\nAcceptance Criteria:\n- Never leak ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD\n`,
      specPath: "docs/specs/leak.md",
      planPath: "docs/plans/leak.md",
    }),
    /NORTHSTAR_PLAN_ISSUES_SECRET_LEAK_DETECTED/,
  );
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/planning/plan-issues.test.ts
```

Expected: FAIL on missing metrics/error codes.

- [ ] **Step 3: Implement gate details**

Update `src/planning/plan-issues.ts`:

```ts
export const PLAN_ISSUES_MISSING_DEPENDENCY = "NORTHSTAR_PLAN_ISSUES_MISSING_DEPENDENCY";
export const PLAN_ISSUES_DEPENDENCY_CYCLE = "NORTHSTAR_PLAN_ISSUES_DEPENDENCY_CYCLE";
export const PLAN_ISSUES_SECRET_LEAK_DETECTED = "NORTHSTAR_PLAN_ISSUES_SECRET_LEAK_DETECTED";

interface RootSessionFitInput {
  acceptanceCriteriaCount: number;
  requiredTestsCount: number;
  estimatedFilesCount: number;
  hasHumanDecision: boolean;
  hasExternalRisk: boolean;
}

function evaluateRootSessionFit(input: RootSessionFitInput): { fit: boolean; reason: string } {
  if (input.acceptanceCriteriaCount > 5) return { fit: false, reason: "split_required: acceptance criteria > 5" };
  if (input.requiredTestsCount > 4) return { fit: false, reason: "split_required: required tests > 4" };
  if (input.estimatedFilesCount > 4) return { fit: false, reason: "split_required: estimated files > 4" };
  if (input.hasHumanDecision) return { fit: false, reason: "human decision required" };
  if (input.hasExternalRisk) return { fit: false, reason: "external credential, billing, or production data risk" };
  return { fit: true, reason: "fits one Northstar root session" };
}
```

Make `assertNoMissingDependencies`, `assertNoCycles`, and `assertNoSecretShape` throw errors whose messages include the exported code constants above.

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/planning/plan-issues.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/planning/plan-issues.ts tests/planning/plan-issues.test.ts
git commit -m "Add plan-issues validation gates"
```

---

## Task 3: GitHub Issue Apply Gateway

**Files:**
- Create: `src/adapters/github/plan-issues.ts`
- Create: `tests/adapters/github-plan-issues.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing gateway tests**

Create `tests/adapters/github-plan-issues.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubPlanIssuesGateway } from "../../src/adapters/github/plan-issues.ts";

test("GitHubPlanIssuesGateway creates AFK issue with ready label", async () => {
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const gateway = new GitHubPlanIssuesGateway({
    repo: "owner/repo",
    token: "ghp_redacted_for_test",
    fetch: fakeFetch(requests, {
      "GET /issues?state=all&per_page=100": [],
      "POST /issues": { number: 12, html_url: "https://github.test/owner/repo/issues/12" },
      "POST /issues/12/labels": {},
    }),
  });

  const result = await gateway.createOrReuseIssue({
    title: "Task 1: Build Filter Model",
    body: "<!-- northstar-plan-issue\nissue_key: ISS-001\nsource_fingerprint: sha256:abc\n-->",
    labels: ["northstar:ready"],
    issueKey: "ISS-001",
    sourceFingerprint: "sha256:abc",
  });

  assert.equal(result.status, "created");
  assert.equal(result.issueNumber, 12);
  assert.equal(requests.some((request) => request.path === "/issues" && request.method === "POST"), true);
  assert.deepEqual((requests.find((request) => request.path === "/issues/12/labels")?.body as { labels: string[] }).labels, ["northstar:ready"]);
});

test("GitHubPlanIssuesGateway reuses issue by northstar-plan-issue marker", async () => {
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const gateway = new GitHubPlanIssuesGateway({
    repo: "owner/repo",
    token: "ghp_redacted_for_test",
    fetch: fakeFetch(requests, {
      "GET /issues?state=all&per_page=100": [{
        number: 44,
        title: "Task 1: Build Filter Model",
        html_url: "https://github.test/owner/repo/issues/44",
        body: "<!-- northstar-plan-issue\nissue_key: ISS-001\nsource_fingerprint: sha256:abc\n-->",
        labels: [],
      }],
      "PATCH /issues/44": { number: 44, html_url: "https://github.test/owner/repo/issues/44" },
      "POST /issues/44/labels": {},
    }),
  });

  const result = await gateway.createOrReuseIssue({
    title: "Task 1: Build Filter Model",
    body: "<!-- northstar-plan-issue\nissue_key: ISS-001\nsource_fingerprint: sha256:abc\n-->",
    labels: ["northstar:ready"],
    issueKey: "ISS-001",
    sourceFingerprint: "sha256:abc",
  });

  assert.equal(result.status, "reused");
  assert.equal(result.issueNumber, 44);
  assert.equal(requests.some((request) => request.path === "/issues" && request.method === "POST"), false);
});

function fakeFetch(
  requests: Array<{ path: string; method: string; body?: unknown }>,
  responses: Record<string, unknown>,
): typeof fetch {
  return async (url, init) => {
    const parsed = new URL(String(url));
    const method = String(init?.method ?? "GET");
    const path = `${parsed.pathname.replace("/repos/owner/repo", "")}${parsed.search}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: path || "/", method, body });
    const key = `${method} ${path || "/"}`;
    const value = responses[key];
    if (value === undefined) {
      return new Response(JSON.stringify({ message: `missing fake ${key}` }), { status: 404 });
    }
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
}
```

Modify `tests/index.test.ts`:

```ts
import "./adapters/github-plan-issues.test.ts";
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/github-plan-issues.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement GitHub gateway**

Create `src/adapters/github/plan-issues.ts`:

```ts
import { redactSecrets } from "../../runtime/redaction.ts";

export interface GitHubPlanIssueApplyInput {
  title: string;
  body: string;
  labels: string[];
  issueKey: string;
  sourceFingerprint: string;
}

export interface GitHubPlanIssueApplyResult {
  status: "created" | "reused" | "updated";
  issueNumber: number;
  issueUrl: string;
}

export class GitHubPlanIssuesGateway {
  constructor(private readonly options: {
    repo: string;
    token: string;
    fetch?: typeof fetch;
  }) {}

  async createOrReuseIssue(input: GitHubPlanIssueApplyInput): Promise<GitHubPlanIssueApplyResult> {
    const existing = await this.findIssueByMarker(input.issueKey, input.sourceFingerprint);
    if (existing) {
      await this.request(`/issues/${existing.number}`, "PATCH", { title: input.title, body: input.body });
      await this.request(`/issues/${existing.number}/labels`, "POST", { labels: input.labels });
      return { status: "reused", issueNumber: existing.number, issueUrl: existing.html_url };
    }

    const created = await this.request<{ number: number; html_url: string }>("/issues", "POST", {
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    await this.request(`/issues/${created.number}/labels`, "POST", { labels: input.labels });
    return { status: "created", issueNumber: created.number, issueUrl: created.html_url };
  }

  private async findIssueByMarker(issueKey: string, sourceFingerprint: string): Promise<{ number: number; html_url: string } | undefined> {
    const issues = await this.request<Array<{ number: number; html_url: string; body?: string | null }>>("/issues?state=all&per_page=100", "GET");
    return issues.find((issue) => {
      const body = issue.body ?? "";
      return body.includes("northstar-plan-issue")
        && body.includes(`issue_key: ${issueKey}`)
        && body.includes(`source_fingerprint: ${sourceFingerprint}`);
    });
  }

  private async request<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(`https://api.github.com/repos/${this.options.repo}${path}`, {
      method,
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`GitHub plan-issues request failed with ${response.status}: ${redactSecrets(await response.text())}`);
    }
    return await response.json() as T;
  }
}
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/github-plan-issues.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github/plan-issues.ts tests/adapters/github-plan-issues.test.ts tests/index.test.ts
git commit -m "Add GitHub plan-issues gateway"
```

---

## Task 4: Production Plan-Issues Command Orchestrator

**Files:**
- Create: `src/planning/plan-issues-command.ts`
- Create: `tests/planning/plan-issues-command.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing command tests**

Create `tests/planning/plan-issues-command.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { runPlanIssuesCommand } from "../../src/planning/plan-issues-command.ts";

test("runPlanIssuesCommand dry-run performs no mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-plan-issues-command-"));
  const specPath = join(dir, "spec.md");
  const planPath = join(dir, "plan.md");
  await writeFile(specPath, "# Spec\n\n## Acceptance Criteria\n- Done\n", "utf8");
  await writeFile(planPath, "# Plan\n\n### Task 1: Build Thing\n\nAcceptance Criteria:\n- Done\n\nRequired Tests:\n- npm test\n", "utf8");
  try {
    const result = await runPlanIssuesCommand({
      mode: "dry-run",
      specPath,
      planPath,
      repo: "owner/repo",
      projectId: "PVT_example",
      github: new FakePlanIssueGateway(),
      project: new FakeProjectSync(),
      store: undefined,
    });

    assert.equal(result.metrics.plan_issues_dry_run_mutations, 0);
    assert.equal(result.issues.length, 1);
    assert.equal(result.github.created.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPlanIssuesCommand apply requires confirm", async () => {
  await assert.rejects(
    () => runPlanIssuesCommand({
      mode: "apply",
      confirm: false,
      specPath: "docs/specs/missing.md",
      planPath: "docs/plans/missing.md",
      repo: "owner/repo",
      github: new FakePlanIssueGateway(),
      project: new FakeProjectSync(),
    }),
    /NORTHSTAR_PLAN_ISSUES_CONFIRM_REQUIRED/,
  );
});

test("runPlanIssuesCommand apply writes runtime intake unless githubOnly is true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-plan-issues-runtime-"));
  const specPath = join(dir, "spec.md");
  const planPath = join(dir, "plan.md");
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite3"));
  await writeFile(specPath, "# Spec\n\n## Acceptance Criteria\n- Done\n", "utf8");
  await writeFile(planPath, "# Plan\n\n### Task 1: Build Thing\n\nAcceptance Criteria:\n- Done\n\nRequired Tests:\n- npm test\n", "utf8");
  try {
    const result = await runPlanIssuesCommand({
      mode: "apply",
      confirm: true,
      specPath,
      planPath,
      repo: "owner/repo",
      projectId: "PVT_example",
      github: new FakePlanIssueGateway(),
      project: new FakeProjectSync(),
      store,
    });

    assert.equal(result.runtime.intaken.length, 1);
    assert.equal(store.getIssue("github:101").lifecycle_state, "ready");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class FakePlanIssueGateway {
  created: Array<{ title: string; labels: string[] }> = [];
  async createOrReuseIssue(input: { title: string; labels: string[] }) {
    this.created.push(input);
    return { status: "created" as const, issueNumber: 100 + this.created.length, issueUrl: `https://github.test/issues/${100 + this.created.length}` };
  }
}

class FakeProjectSync {
  synced: Array<{ issueNumber: number; fields: Record<string, unknown> }> = [];
  async syncProjectFields(input: { issueNumber: number; fields: Record<string, unknown> }) {
    this.synced.push(input);
    return { status: "success", payload: { metrics: { project_items_created: 1, fields_updated: Object.keys(input.fields).length } } };
  }
}
```

Modify `tests/index.test.ts`:

```ts
import "./planning/plan-issues-command.test.ts";
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/planning/plan-issues-command.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement command orchestrator**

Create `src/planning/plan-issues-command.ts`:

```ts
import { readFile } from "node:fs/promises";
import type { SqliteControlPlaneStore } from "../runtime/store.ts";
import { generatePlanIssueTable, formatPlanIssueBody, type PlanIssueRow } from "./plan-issues.ts";

export const PLAN_ISSUES_CONFIRM_REQUIRED = "NORTHSTAR_PLAN_ISSUES_CONFIRM_REQUIRED";

export interface RunPlanIssuesCommandInput {
  mode: "dry-run" | "apply";
  confirm?: boolean;
  githubOnly?: boolean;
  specPath: string;
  planPath: string;
  repo: string;
  projectId?: string;
  github: {
    createOrReuseIssue(input: { title: string; body: string; labels: string[]; issueKey: string; sourceFingerprint: string }): Promise<{ status: "created" | "reused" | "updated"; issueNumber: number; issueUrl: string }>;
  };
  project?: {
    syncProjectFields(input: { issueNumber: number; lifecycleState: string; projectId?: string; fields: Record<string, unknown> }): Promise<unknown>;
  };
  store?: SqliteControlPlaneStore;
}

export async function runPlanIssuesCommand(input: RunPlanIssuesCommandInput) {
  if (input.mode === "apply" && input.confirm !== true) {
    throw new Error(PLAN_ISSUES_CONFIRM_REQUIRED);
  }

  const specText = await readFile(input.specPath, "utf8");
  const planText = await readFile(input.planPath, "utf8");
  const table = generatePlanIssueTable({
    specText,
    planText,
    specPath: input.specPath,
    planPath: input.planPath,
  });

  if (input.mode === "dry-run") {
    return {
      mode: "dry-run",
      issues: table.issues,
      dependencyEdges: table.dependencyEdges,
      metrics: table.metrics,
      github: { created: [], reused: [], updated: [] },
      project: { synced: [], failed: [] },
      runtime: { intaken: [], skipped: [] },
    };
  }

  const numberByIssueKey = new Map<string, number>();
  const github = { created: [] as number[], reused: [] as number[], updated: [] as number[] };
  const project = { synced: [] as number[], failed: [] as Array<{ issueNumber: number; error: string }> };
  const runtime = { intaken: [] as string[], skipped: [] as string[] };

  for (const row of table.issues) {
    const labels = row.root_session_fit && row.type === "AFK" ? ["northstar:ready"] : ["northstar:blocked"];
    const issue = await input.github.createOrReuseIssue({
      title: row.title,
      body: formatPlanIssueBody(row, { numberByIssueKey }),
      labels,
      issueKey: row.issue_key,
      sourceFingerprint: row.source_fingerprint,
    });
    numberByIssueKey.set(row.issue_key, issue.issueNumber);
    if (issue.status === "created") github.created.push(issue.issueNumber);
    if (issue.status === "reused") github.reused.push(issue.issueNumber);
    if (issue.status === "updated") github.updated.push(issue.issueNumber);
    await syncProject(input, row, issue.issueNumber, project);
    if (!input.githubOnly && row.root_session_fit && row.type === "AFK" && input.store) {
      input.store.upsertIssuePacket({
        issue_number: String(issue.issueNumber),
        title: row.title,
        raw_text: formatPlanIssueBody(row, { numberByIssueKey }),
        source: "github",
        source_url: issue.issueUrl,
        labels,
        dependencies: row.depends_on.map((key) => numberByIssueKey.get(key)).filter((value): value is number => typeof value === "number"),
        ready_for_agent: true,
      });
      runtime.intaken.push(`github:${issue.issueNumber}`);
    } else {
      runtime.skipped.push(row.issue_key);
    }
  }

  return {
    mode: "apply",
    issues: table.issues,
    dependencyEdges: table.dependencyEdges,
    metrics: {
      ...table.metrics,
      plan_issues_apply_created: github.created.length,
      plan_issues_apply_reused: github.reused.length,
      plan_issues_duplicate_issues_created: 0,
      plan_issues_runtime_intake_snapshots_created: runtime.intaken.length,
      plan_issues_github_only_runtime_writes: input.githubOnly ? 0 : runtime.intaken.length,
    },
    github,
    project,
    runtime,
  };
}

async function syncProject(
  input: RunPlanIssuesCommandInput,
  row: PlanIssueRow,
  issueNumber: number,
  project: { synced: number[]; failed: Array<{ issueNumber: number; error: string }> },
): Promise<void> {
  if (!input.project) return;
  try {
    await input.project.syncProjectFields({
      issueNumber,
      lifecycleState: row.initial_lifecycle,
      projectId: input.projectId,
      fields: projectFieldsForRow(row),
    });
    project.synced.push(issueNumber);
  } catch (error) {
    project.failed.push({ issueNumber, error: error instanceof Error ? error.message : String(error) });
  }
}

function projectFieldsForRow(row: PlanIssueRow): Record<string, unknown> {
  return {
    Status: row.project_status,
    "Northstar Lifecycle": row.initial_lifecycle,
    "Current Stage": row.current_stage,
    Priority: row.priority,
    "Depends On": row.depends_on.join(", "),
    "Root Session Fit": row.root_session_fit ? "Yes" : "No",
    "Issue Type": row.type,
    "Acceptance Cluster": row.acceptance_cluster,
    "Required Tests": row.required_tests.join("\n"),
    "Source Plan": row.source_plan,
    "Source Fingerprint": row.source_fingerprint,
    "Blocked By": row.root_session_fit ? "" : row.root_session_fit_reason,
  };
}
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/planning/plan-issues-command.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/planning/plan-issues-command.ts tests/planning/plan-issues-command.test.ts tests/index.test.ts
git commit -m "Add plan-issues command orchestrator"
```

---

## Task 5: CLI Wiring

**Files:**
- Modify: `src/cli/northstar.ts`
- Modify: `src/cli/entrypoint.ts`
- Create: `tests/cli/plan-issues-cli.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `tests/cli/plan-issues-cli.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { CLI_COMMANDS, formatNorthstarHelp, formatNorthstarPlanIssuesHelp } from "../../src/cli/northstar.ts";
import { main } from "../../src/cli/entrypoint.ts";

test("plan-issues command is part of CLI surface", () => {
  assert.equal(CLI_COMMANDS.includes("plan-issues"), true);
  assert.match(formatNorthstarHelp(), /northstar plan-issues/);
  assert.match(formatNorthstarPlanIssuesHelp(), /--spec/);
  assert.match(formatNorthstarPlanIssuesHelp(), /--plan/);
  assert.match(formatNorthstarPlanIssuesHelp(), /--dry-run/);
  assert.match(formatNorthstarPlanIssuesHelp(), /--apply/);
});

test("plan-issues help prints without loading project config", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (value) => logs.push(String(value));
  try {
    const code = await main(["plan-issues", "--help"]);
    assert.equal(code, 0);
    assert.match(logs.join("\n"), /Northstar plan-issues/);
  } finally {
    console.log = original;
  }
});
```

Modify `tests/index.test.ts`:

```ts
import "./cli/plan-issues-cli.test.ts";
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/cli/plan-issues-cli.test.ts
```

Expected: FAIL because command/help does not exist.

- [ ] **Step 3: Implement CLI command and help**

In `src/cli/northstar.ts`, add `"plan-issues"` to `CLI_COMMANDS` and export:

```ts
export function formatNorthstarPlanIssuesHelp(): string {
  return [
    "Northstar plan-issues",
    "",
    "Usage:",
    "  northstar plan-issues --config .northstar.yaml --spec <path> --plan <path> --dry-run",
    "  northstar plan-issues --config .northstar.yaml --spec <path> --plan <path> --apply --confirm",
    "",
    "Options:",
    "  --spec PATH       Northstar design spec path.",
    "  --plan PATH       Northstar implementation plan path.",
    "  --dry-run         Generate issue table without mutations.",
    "  --apply           Create or reuse GitHub issues and projections.",
    "  --confirm         Required with --apply.",
    "  --github-only     Skip runtime intake writes.",
    "  --format json     Emit JSON output.",
  ].join("\n");
}
```

In `src/cli/entrypoint.ts`, add early help routing:

```ts
if (argv[0] === "plan-issues" && (argv[1] === "--help" || argv[1] === "-h")) {
  console.log(formatNorthstarPlanIssuesHelp());
  return 0;
}
```

Then parse and invoke `runPlanIssuesCommand` in the non-help path. Use `requireOption(command.args, "--spec")`, `requireOption(command.args, "--plan")`, `command.args.includes("--apply")`, `command.args.includes("--dry-run")`, `command.args.includes("--confirm")`, and `command.args.includes("--github-only")`.

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/cli/plan-issues-cli.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/northstar.ts src/cli/entrypoint.ts tests/cli/plan-issues-cli.test.ts tests/index.test.ts
git commit -m "Wire plan-issues CLI command"
```

---

## Task 6: Project Viewer And Skill UX Updates

**Files:**
- Modify: `skills/northstar/SKILL.md`
- Modify: `skills/northstar/scripts/lib/project-viewer.mjs`
- Modify: `skills/northstar/scripts/lib/operator-commands.mjs`
- Modify: `tests/skills/northstar-skill-files.test.ts`
- Modify: `tests/skills/northstar-project-viewer.test.ts`
- Modify: `tests/skills/northstar-operator-commands.test.ts`

- [ ] **Step 1: Write failing skill/project tests**

Append to `tests/skills/northstar-skill-files.test.ts`:

```ts
test("northstar skill documents Matt-style plan issue workflow", async () => {
  const skill = await readFile("skills/northstar/SKILL.md", "utf8");
  for (const command of ["/northstar-grill", "/northstar-to-spec", "/northstar-to-plan", "/northstar-to-issues"]) {
    assert.match(skill, new RegExp(command.replace("/", "\\/")));
  }
  assert.match(skill, /docs\/specs\/YYYY-MM-DD-<topic>-design\.md/);
  assert.match(skill, /docs\/plans\/YYYY-MM-DD-<topic>-implementation-plan\.md/);
  assert.match(skill, /northstar plan-issues/);
});
```

Append to `tests/skills/northstar-project-viewer.test.ts`:

```ts
test("northstar project viewer includes planning fields and Planning view", async () => {
  const { northstarProjectFields, northstarProjectViews } = await import("../../skills/northstar/scripts/lib/project-viewer.mjs");
  for (const field of ["Priority", "Depends On", "Root Session Fit", "Issue Type", "Acceptance Cluster", "Required Tests", "Source Plan", "Source Fingerprint"]) {
    assert.equal(northstarProjectFields.some((candidate) => candidate.name === field), true);
  }
  assert.equal(northstarProjectViews.some((view) => view.name === "Planning"), true);
});
```

Update `tests/skills/northstar-operator-commands.test.ts` expectation for `plan issues`:

```ts
assert.deepEqual(plan.argv, ["node", "--run", "northstar", "--", "plan-issues", "--config", "/repo/.northstar.yaml", "--dry-run"]);
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/skills/northstar-skill-files.test.ts
node --disable-warning=ExperimentalWarning tests/skills/northstar-project-viewer.test.ts
node --disable-warning=ExperimentalWarning tests/skills/northstar-operator-commands.test.ts
```

Expected: FAIL on missing commands/fields/view or old `plan-issues` argv shape.

- [ ] **Step 3: Update skill docs and helper data**

In `skills/northstar/SKILL.md`, add a section named `Matt-Style Northstar Planning Workflow` containing:

```md
### Matt-Style Northstar Planning Workflow

Use these intents for plan-to-issues work:

- `/northstar-grill`: ask one question at a time until the requirement is clear enough for a Northstar design spec.
- `/northstar-to-spec`: write `docs/specs/YYYY-MM-DD-<topic>-design.md`.
- `/northstar-to-plan`: write `docs/plans/YYYY-MM-DD-<topic>-implementation-plan.md`.
- `/northstar-to-issues`: run `node --run northstar -- plan-issues --config .northstar.yaml --spec <spec> --plan <plan> --dry-run`, then require explicit confirmation before `--apply --confirm`.

Only `AFK` issues with `root_session_fit=true` may receive `northstar:ready`. `HITL` or oversized issues receive `northstar:blocked` and must not be dispatched by watch.
```

In `skills/northstar/scripts/lib/project-viewer.mjs`, add field entries:

```js
{ name: "Priority", type: "number" },
{ name: "Depends On", type: "text" },
{ name: "Root Session Fit", type: "single_select", options: ["Yes", "No"] },
{ name: "Issue Type", type: "single_select", options: ["AFK", "HITL"] },
{ name: "Acceptance Cluster", type: "text" },
{ name: "Required Tests", type: "text" },
{ name: "Source Plan", type: "text" },
{ name: "Source Fingerprint", type: "text" },
```

Add a view:

```js
{
  name: "Planning",
  layout: "table",
  fields: ["Issue Type", "Root Session Fit", "Acceptance Cluster", "Required Tests", "Source Plan", "Priority", "Depends On"],
}
```

In `skills/northstar/scripts/lib/operator-commands.mjs`, ensure `argvForIntent("plan issues", configPath)` returns:

```js
return ["node", "--run", "northstar", "--", "plan-issues", "--config", configPath, "--dry-run"];
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/skills/northstar-skill-files.test.ts
node --disable-warning=ExperimentalWarning tests/skills/northstar-project-viewer.test.ts
node --disable-warning=ExperimentalWarning tests/skills/northstar-operator-commands.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/northstar/SKILL.md skills/northstar/scripts/lib/project-viewer.mjs skills/northstar/scripts/lib/operator-commands.mjs tests/skills/northstar-skill-files.test.ts tests/skills/northstar-project-viewer.test.ts tests/skills/northstar-operator-commands.test.ts
git commit -m "Document Northstar plan issue skill workflow"
```

---

## Task 7: Offline Plan-Issues E2E

**Files:**
- Create: `tests/e2e-plan-issues/plan-issues-e2e.test.ts`
- Create: `tests/e2e-plan-issues/index.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing offline E2E test**

Create `tests/e2e-plan-issues/plan-issues-e2e.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { runPlanIssuesCommand } from "../../src/planning/plan-issues-command.ts";

test("offline plan-issues E2E applies AFK and HITL issues idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-plan-issues-e2e-"));
  const specPath = join(dir, "design.md");
  const planPath = join(dir, "plan.md");
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite3"));
  const github = new MemoryGateway();
  const project = new MemoryProject();
  await writeFile(specPath, "# Design\n\n## Acceptance Criteria\n- Done\n", "utf8");
  await writeFile(planPath, `# Plan

### Task 1: Build Foundation
Acceptance Criteria:
- Done
Required Tests:
- npm test

### Task 2: Human Decision
Depends-On: Task 1
Acceptance Criteria:
- Human approval required before implementation.
Required Tests:
- npm test
`, "utf8");
  try {
    const first = await runPlanIssuesCommand({
      mode: "apply",
      confirm: true,
      specPath,
      planPath,
      repo: "owner/repo",
      projectId: "PVT_example",
      github,
      project,
      store,
    });
    const second = await runPlanIssuesCommand({
      mode: "apply",
      confirm: true,
      specPath,
      planPath,
      repo: "owner/repo",
      projectId: "PVT_example",
      github,
      project,
      store,
    });

    assert.equal(first.github.created.length, 2);
    assert.equal(second.github.reused.length, 2);
    assert.equal(github.issues.length, 2);
    assert.equal(first.metrics.plan_issues_duplicate_issues_created, 0);
    assert.equal(project.synced.length >= 4, true);
    assert.equal(store.getIssue("github:1").lifecycle_state, "ready");
    assert.throws(() => store.getIssue("github:2"), /Issue github:2 not found/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class MemoryGateway {
  issues: Array<{ number: number; title: string; body: string; labels: string[] }> = [];
  async createOrReuseIssue(input: { title: string; body: string; labels: string[]; issueKey: string; sourceFingerprint: string }) {
    const existing = this.issues.find((issue) => issue.body.includes(`issue_key: ${input.issueKey}`) && issue.body.includes(`source_fingerprint: ${input.sourceFingerprint}`));
    if (existing) {
      existing.body = input.body;
      existing.labels = input.labels;
      return { status: "reused" as const, issueNumber: existing.number, issueUrl: `https://github.test/issues/${existing.number}` };
    }
    const number = this.issues.length + 1;
    this.issues.push({ number, title: input.title, body: input.body, labels: input.labels });
    return { status: "created" as const, issueNumber: number, issueUrl: `https://github.test/issues/${number}` };
  }
}

class MemoryProject {
  synced: Array<{ issueNumber: number; fields: Record<string, unknown> }> = [];
  async syncProjectFields(input: { issueNumber: number; fields: Record<string, unknown> }) {
    this.synced.push(input);
    return { status: "success" };
  }
}
```

Create `tests/e2e-plan-issues/index.test.ts`:

```ts
import "./plan-issues-e2e.test.ts";
```

In `package.json`, add:

```json
"test:e2e:plan-issues": "node --disable-warning=ExperimentalWarning tests/e2e-plan-issues/index.test.ts"
```

- [ ] **Step 2: Run test and confirm RED**

Run:

```bash
npm run test:e2e:plan-issues
```

Expected: FAIL until apply idempotency/runtime behavior is complete.

- [ ] **Step 3: Fix apply/runtime behavior**

Update `src/planning/plan-issues-command.ts` so that:

- GitHub numbering is retained in `numberByIssueKey`.
- AFK `root_session_fit=true` issues write `store.upsertIssuePacket`.
- HITL or blocked issues skip runtime intake.
- repeated apply reuses existing issues and does not duplicate runtime history beyond idempotent intake behavior.

- [ ] **Step 4: Run test and confirm GREEN**

Run:

```bash
npm run test:e2e:plan-issues
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e-plan-issues/plan-issues-e2e.test.ts tests/e2e-plan-issues/index.test.ts package.json src/planning/plan-issues-command.ts
git commit -m "Add offline plan-issues E2E"
```

---

## Task 8: Live GitHub Plan-Issues E2E

**Files:**
- Create: `tests/e2e-plan-issues-live/plan-issues-live.test.ts`
- Create: `tests/e2e-plan-issues-live/index.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write guarded live E2E test**

Create `tests/e2e-plan-issues-live/plan-issues-live.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubPlanIssuesGateway } from "../../src/adapters/github/plan-issues.ts";
import { GitHubObservabilityAdapter } from "../../src/adapters/github/observability.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { runPlanIssuesCommand } from "../../src/planning/plan-issues-command.ts";

test("live plan-issues apply creates AFK and HITL GitHub issues with Project fields", async (t) => {
  if (process.env.NORTHSTAR_PLAN_ISSUES_LIVE !== "1") {
    t.skip("Set NORTHSTAR_PLAN_ISSUES_LIVE=1, GITHUB_TOKEN, NORTHSTAR_LIVE_GITHUB_REPO, and NORTHSTAR_LIVE_GITHUB_PROJECT_ID to run live plan-issues E2E.");
    return;
  }
  const token = requiredEnv("GITHUB_TOKEN");
  const repo = requiredEnv("NORTHSTAR_LIVE_GITHUB_REPO");
  const projectId = requiredEnv("NORTHSTAR_LIVE_GITHUB_PROJECT_ID");
  const dir = await mkdtemp(join(tmpdir(), "northstar-plan-issues-live-"));
  const specPath = join(dir, "design.md");
  const planPath = join(dir, "plan.md");
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite3"));
  const runId = `northstar-plan-issues-${Date.now()}`;
  await writeFile(specPath, `# ${runId} Design\n\n## Acceptance Criteria\n- Live issue setup is verifiable.\n`, "utf8");
  await writeFile(planPath, `# ${runId} Plan

### Task 1: Build Live A
Acceptance Criteria:
- A is represented as AFK.
Required Tests:
- npm test

### Task 2: Build Live B
Depends-On: Task 1
Acceptance Criteria:
- B is represented as AFK.
Required Tests:
- npm test

### Task 3: Human Approval
Depends-On: Task 2
Acceptance Criteria:
- Human approval required before implementation.
Required Tests:
- npm test
`, "utf8");
  try {
    const gateway = new GitHubPlanIssuesGateway({ repo, token });
    const observability = new GitHubObservabilityAdapter({ repo, token });
    const first = await runPlanIssuesCommand({
      mode: "apply",
      confirm: true,
      specPath,
      planPath,
      repo,
      projectId,
      github: gateway,
      project: observability,
      store,
    });
    const second = await runPlanIssuesCommand({
      mode: "apply",
      confirm: true,
      specPath,
      planPath,
      repo,
      projectId,
      github: gateway,
      project: observability,
      store,
    });

    assert.equal(first.github.created.length, 3);
    assert.equal(second.github.reused.length, 3);
    assert.equal(first.metrics.plan_issues_duplicate_issues_created, 0);
    assert.equal(first.runtime.intaken.length, 2);
    assert.equal(first.project.synced.length >= 3, true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live plan-issues E2E`);
  return value;
}
```

Create `tests/e2e-plan-issues-live/index.test.ts`:

```ts
import "./plan-issues-live.test.ts";
```

In `package.json`, add:

```json
"test:e2e:plan-issues-live": "node --disable-warning=ExperimentalWarning tests/e2e-plan-issues-live/index.test.ts"
```

- [ ] **Step 2: Run live test without env and confirm clear skip**

Run:

```bash
npm run test:e2e:plan-issues-live
```

Expected: SKIP with message naming `NORTHSTAR_PLAN_ISSUES_LIVE`, `GITHUB_TOKEN`, `NORTHSTAR_LIVE_GITHUB_REPO`, and `NORTHSTAR_LIVE_GITHUB_PROJECT_ID`.

- [ ] **Step 3: Run live test with env**

Run:

```bash
NORTHSTAR_PLAN_ISSUES_LIVE=1 \
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-todo \
NORTHSTAR_LIVE_GITHUB_PROJECT_ID="$NORTHSTAR_LIVE_GITHUB_PROJECT_ID" \
npm run test:e2e:plan-issues-live
```

Expected: PASS. Capture issue URLs and Project URL in final report. If Project field API fails, use systematic-debugging to identify missing field or permission and fix the gateway/schema rather than skipping.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e-plan-issues-live/plan-issues-live.test.ts tests/e2e-plan-issues-live/index.test.ts package.json
git commit -m "Add live plan-issues E2E gate"
```

---

## Task 9: Final Verification And Coverage Matrix

**Files:**
- Create: `docs/plan-issues-coverage.md`
- Create: `tests/fixtures/plan-issues/.northstar.yaml`
- Create: `tests/fixtures/plan-issues/spec.md`
- Create: `tests/fixtures/plan-issues/plan.md`
- Modify: no production code unless verification reveals a real gap

- [ ] **Step 1: Create final verification fixtures**

Create `tests/fixtures/plan-issues/.northstar.yaml`:

```yaml
project:
  root: .
runtime:
  db_path: .northstar/runtime/control-plane.sqlite3
  host_adapter: codex
  session_scope: per_stage_root
  lease_timeout_seconds: 600
  auto_release: true
  workflow:
    id: issue_to_pr_release
    path: tests/fixtures/workflows/issue-to-pr-release.yaml
  development_capacity: 1
  cleanup:
    completed: keep
    failedOrQuarantined: keep
  watch_lock:
    stale_after_seconds: 300
    heartbeat_interval_seconds: 30
github:
  repo: owner/repo
  intake:
    label: northstar:ready
  project:
    enabled: false
hosts:
  codex:
    agent: build
```

Create `tests/fixtures/plan-issues/spec.md`:

```md
# Fixture Plan-Issues Design

## Acceptance Criteria

- Fixture issue generation works.
- Runtime-ready issue metadata is present.

## Quantitative Metrics

- fixture_plan_issues_generated >= 1
```

Create `tests/fixtures/plan-issues/plan.md`:

```md
# Fixture Plan-Issues Implementation Plan

### Task 1: Build Fixture Feature

Acceptance Criteria:
- Fixture feature is represented as an AFK issue.

Required Tests:
- npm test
```

- [ ] **Step 2: Create coverage matrix**

Create `docs/plan-issues-coverage.md`:

```md
# Plan-Issues Coverage Matrix

| Requirement | Test File | Implementation File |
|---|---|---|
| Matt-style skill commands documented | `tests/skills/northstar-skill-files.test.ts` | `skills/northstar/SKILL.md` |
| plan-issues CLI exists | `tests/cli/plan-issues-cli.test.ts` | `src/cli/northstar.ts`, `src/cli/entrypoint.ts` |
| dry-run has zero mutations | `tests/planning/plan-issues-command.test.ts` | `src/planning/plan-issues-command.ts` |
| issue table schema fields | `tests/planning/plan-issues.test.ts` | `src/planning/plan-issues.ts` |
| root session fit gate | `tests/planning/plan-issues.test.ts` | `src/planning/plan-issues.ts` |
| secret scan | `tests/planning/plan-issues.test.ts` | `src/planning/plan-issues.ts` |
| dependency graph | `tests/planning/plan-issues.test.ts`, `tests/e2e-plan-issues/plan-issues-e2e.test.ts` | `src/planning/plan-issues.ts` |
| apply requires confirm | `tests/planning/plan-issues-command.test.ts` | `src/planning/plan-issues-command.ts` |
| GitHub create/reuse | `tests/adapters/github-plan-issues.test.ts` | `src/adapters/github/plan-issues.ts` |
| Project fields sync | `tests/e2e-plan-issues/plan-issues-e2e.test.ts` | `src/planning/plan-issues-command.ts`, `src/adapters/github/observability.ts` |
| runtime intake | `tests/planning/plan-issues-command.test.ts`, `tests/e2e-plan-issues/plan-issues-e2e.test.ts` | `src/planning/plan-issues-command.ts`, `src/runtime/store.ts` |
| live GitHub apply | `tests/e2e-plan-issues-live/plan-issues-live.test.ts` | `src/adapters/github/plan-issues.ts`, `src/planning/plan-issues-command.ts` |
```

- [ ] **Step 3: Run fresh verification**

Run:

```bash
npm test
npm run test:e2e
npm run test:e2e:plan-issues
npm run test:coverage
node --run northstar -- --help
node --run northstar -- plan-issues --help
node --run northstar -- plan-issues --config tests/fixtures/plan-issues/.northstar.yaml --spec tests/fixtures/plan-issues/spec.md --plan tests/fixtures/plan-issues/plan.md --dry-run
npm run test:e2e:plan-issues-live
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests skills
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src skills
git status --short
```

Expected:

- offline commands pass
- live command without env clearly skips
- scans return no disallowed matches
- `git status --short` shows only intentional files

- [ ] **Step 4: Run live verification when credentials are available**

Run:

```bash
NORTHSTAR_PLAN_ISSUES_LIVE=1 \
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-todo \
NORTHSTAR_LIVE_GITHUB_PROJECT_ID="$NORTHSTAR_LIVE_GITHUB_PROJECT_ID" \
npm run test:e2e:plan-issues-live
```

Expected:

- at least 2 AFK issues created or reused
- at least 1 HITL/blocked issue created or reused
- at least 1 dependency edge
- AFK issues have `northstar:ready`
- HITL issue does not have `northstar:ready`
- Project fields sync includes Status, Northstar Lifecycle, Current Stage, Priority, Depends On, Root Session Fit, Issue Type, Acceptance Cluster, Required Tests, Source Plan, Source Fingerprint
- repeated apply creates zero duplicate issues
- runtime intake contains AFK ready snapshots

- [ ] **Step 5: Commit coverage matrix and fixtures**

```bash
git add docs/plan-issues-coverage.md tests/fixtures/plan-issues/.northstar.yaml tests/fixtures/plan-issues/spec.md tests/fixtures/plan-issues/plan.md
git commit -m "Document plan-issues coverage"
```

---

## Final Report Requirements

The implementer must report:

- design spec path
- implementation plan path
- skill UX summary
- `plan-issues` CLI summary
- issue table schema summary
- Project fields/views summary
- RED to GREEN evidence
- offline verification output summary
- live GitHub issue URLs and Project URL when live verification ran
- idempotency result
- runtime intake result
- modified files
- deferred work
