import assert from "node:assert/strict";
import test from "node:test";

const intakeModule = "../../skills/northstar/scripts/lib/spec-plan-intake.mjs";

const specText = `# Search Completeness Spec

## Objective
Ship reliable search filtering with visible metrics.

## Acceptance Criteria
- Filters can be combined by status and owner.
- Empty search states explain the next action.

## Quantitative Metrics
- search_filter_latency_ms_p95 <= 250
- search_empty_state_helpfulness = 1

## Required Tests
- node --disable-warning=ExperimentalWarning tests/search/filter.test.ts
`;

const planText = `# Search Completeness Plan

## Task 1: Build Filter Model

Objective: Create the shared filter model.

Scope:
- Add parser and serializer for filter query state.

Acceptance Criteria:
- Filter state round-trips through URL params.
- Invalid filter values are ignored.

Quantitative Metrics:
- filter_model_roundtrip_coverage = 1

Required Tests:
- node --disable-warning=ExperimentalWarning tests/search/filter-model.test.ts

## Task 2: Render Search Results

Depends-On: Task 1

Objective: Render filtered result rows and empty states.

Scope:
- Connect the filter model to result rendering.

Acceptance Criteria:
- Matching rows update when filters change.
- Empty results show recovery copy.

Quantitative Metrics:
- search_result_render_latency_ms_p95 <= 250

Required Tests:
- node --disable-warning=ExperimentalWarning tests/search/results.test.ts
`;

test("northstar spec plan intake generates dry-run issue drafts from plan tasks", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  const result = generateIssueDraftsFromSpecPlan({
    specText,
    planText,
    specPath: "docs/specs/search.md",
    planPath: "docs/plans/search.md",
    repo: "owner/repo",
  });

  assert.equal(result.mode, "dry-run");
  assert.equal(result.canMutate, false);
  assert.equal(result.issueDrafts.length, 2);
  assert.equal(result.metrics.spec_plan_inputs_validated, 1);
  assert.equal(result.metrics.issues_generated_from_plan >= 2, true);
  assert.equal(result.metrics.issue_acceptance_criteria_present, 1);
  assert.equal(result.metrics.issue_quantitative_metrics_present, 1);
  assert.equal(result.metrics.dependency_graph_edges, 1);
  assert.equal(result.metrics.dependency_graph_cycles, 0);
  assert.equal(result.metrics.dry_run_requires_no_github_mutation, 1);
  assert.equal(result.metrics.secret_leaks_in_generated_issues, 0);

  assert.equal(result.issueDrafts[0].title, "Task 1: Build Filter Model");
  assert.equal(result.issueDrafts[0].source.specPath, "docs/specs/search.md");
  assert.equal(result.issueDrafts[0].source.planPath, "docs/plans/search.md");
  for (const section of [
    "## Objective",
    "## Source Documents",
    "## Scope",
    "## Acceptance Criteria",
    "## Quantitative Metrics",
    "## Required Tests",
    "## Dependencies",
    "## Northstar Execution Notes",
  ]) {
    assert.match(result.issueDrafts[0].body, new RegExp(section.replaceAll("#", "\\#")));
  }
  assert.match(result.issueDrafts[1].body, /Depends-On: #1/);
});

test("northstar spec plan intake maps issue-number dependency markers to graph edges and issue bodies", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  const issueReferencePlanText = planText.replace("Depends-On: Task 1", "Depends-On: #1");

  const result = generateIssueDraftsFromSpecPlan({
    specText,
    planText: issueReferencePlanText,
    specPath: "docs/specs/search.md",
    planPath: "docs/plans/search.md",
    repo: "owner/repo",
  });

  assert.deepEqual(result.dependencyGraph.edges, [
    { from: "Task 2", to: "Task 1" },
  ]);
  assert.equal(result.metrics.dependency_graph_edges, 1);
  assert.match(result.issueDrafts[1].body, /## Dependencies\nDepends-On: #1/);
  assert.doesNotMatch(result.issueDrafts[1].body, /## Dependencies\nNone\./);
});

test("northstar spec plan intake uses normal Markdown spec headings for fallback sections and metrics", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  const result = generateIssueDraftsFromSpecPlan({
    specText,
    planText: `# Spec Fallback Plan

## Task 1: Build Search Contracts

Objective: Wire the work to the spec fallback sections.

Scope:
- Create shared contracts for search filtering.
`,
    specPath: "docs/specs/search.md",
    planPath: "docs/plans/search-fallback.md",
    repo: "owner/repo",
  });

  const body = result.issueDrafts[0].body;
  assert.match(body, /## Acceptance Criteria\n- Filters can be combined by status and owner\.\n- Empty search states explain the next action\./);
  assert.match(body, /## Quantitative Metrics\n- search_filter_latency_ms_p95 <= 250\n- search_empty_state_helpfulness = 1/);
  assert.equal(result.metrics.issue_acceptance_criteria_present, 1);
  assert.equal(result.metrics.issue_quantitative_metrics_present, 1);
});

test("northstar spec plan intake marks missing substantive section content in metrics", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  const result = generateIssueDraftsFromSpecPlan({
    specText: `# Empty Spec

## Objective
Track the missing sections accurately.
`,
    planText: `# Empty Section Plan

## Task 1: Missing Acceptance Details

Objective: Show that generated headers alone do not count.
`,
    specPath: "docs/specs/empty.md",
    planPath: "docs/plans/empty.md",
    repo: "owner/repo",
  });

  assert.match(result.issueDrafts[0].body, /## Acceptance Criteria\nNot specified\./);
  assert.match(result.issueDrafts[0].body, /## Quantitative Metrics\nNot specified\./);
  assert.equal(result.metrics.issue_acceptance_criteria_present, 0);
  assert.equal(result.metrics.issue_quantitative_metrics_present, 0);
});

test("northstar spec plan intake emits dependency markers using generated issue order for non-contiguous task numbers", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  const result = generateIssueDraftsFromSpecPlan({
    specText,
    planText: `# Non-Contiguous Plan

## Task 10: First Generated Issue

Acceptance Criteria:
- First issue is generated from task ten.

Quantitative Metrics:
- task_ten_ready = 1

Required Tests:
- node tests/task-ten.test.ts

## Task 20: Second Generated Issue

Depends-On: Task 10

Acceptance Criteria:
- Second issue depends on the first generated issue.

Quantitative Metrics:
- task_twenty_ready = 1

Required Tests:
- node tests/task-twenty.test.ts
`,
    specPath: "docs/specs/search.md",
    planPath: "docs/plans/non-contiguous.md",
    repo: "owner/repo",
  });

  assert.deepEqual(result.dependencyGraph.edges, [
    { from: "Task 20", to: "Task 10" },
  ]);
  assert.match(result.issueDrafts[1].body, /## Dependencies\nDepends-On: #1/);
  assert.doesNotMatch(result.issueDrafts[1].body, /Depends-On: #10/);
});

test("northstar spec plan intake uses exact source labels and required execution notes", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  const result = generateIssueDraftsFromSpecPlan({
    specText,
    planText,
    specPath: "docs/specs/search.md",
    planPath: "docs/plans/search.md",
    repo: "owner/repo",
  });

  assert.match(result.issueDrafts[0].body, /## Source Documents\n- Spec: docs\/specs\/search\.md\n- Implementation Plan: docs\/plans\/search\.md/);
  assert.doesNotMatch(result.issueDrafts[0].body, /- Plan: docs\/plans\/search\.md/);
  const executionNotes = result.issueDrafts[0].body
    .match(/## Northstar Execution Notes\n([\s\S]*?)(?:\n## |$)/)?.[1]
    .trim()
    .split("\n");
  assert.deepEqual(executionNotes, [
    "- domain: software_development",
    "- expected driver: software-dev",
    "- requires live GitHub: no",
    "- requires browser evidence: no",
    "- issue creation approval: required before apply mode",
  ]);
});

test("northstar spec plan intake requires explicit confirmation before apply mode can mutate", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  assert.throws(
    () => generateIssueDraftsFromSpecPlan({
      specText,
      planText,
      specPath: "docs/specs/search.md",
      planPath: "docs/plans/search.md",
      repo: "owner/repo",
      mode: "apply",
    }),
    (error) => error?.code === "NORTHSTAR_SPEC_PLAN_APPLY_REQUIRES_CONFIRMATION"
      && /NORTHSTAR_SPEC_PLAN_APPLY_REQUIRES_CONFIRMATION/.test(error.message),
  );

  const result = generateIssueDraftsFromSpecPlan({
    specText,
    planText,
    specPath: "docs/specs/search.md",
    planPath: "docs/plans/search.md",
    repo: "owner/repo",
    projectId: "PVT_kwDOExample",
    mode: "apply",
    confirmed: true,
  });

  assert.equal(result.mode, "apply");
  assert.equal(result.canMutate, true);
  assert.equal(result.applyPlan.repo, "owner/repo");
  assert.equal(result.applyPlan.projectId, "PVT_kwDOExample");
  assert.equal(result.metrics.apply_requires_confirmation, 1);
  assert.equal(result.metrics.preflight_missing_project_fields_detected, 0);
});

test("northstar spec plan intake detects dependency cycles before apply", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  const cyclicPlanText = `# Cyclic Plan

## Task 1: First
Depends-On: Task 2

Acceptance Criteria:
- First task is tracked.

Quantitative Metrics:
- first_metric = 1

Required Tests:
- node tests/first.test.ts

## Task 2: Second
Depends-On: Task 1

Acceptance Criteria:
- Second task is tracked.

Quantitative Metrics:
- second_metric = 1

Required Tests:
- node tests/second.test.ts
`;

  assert.throws(
    () => generateIssueDraftsFromSpecPlan({
      specText,
      planText: cyclicPlanText,
      specPath: "docs/specs/search.md",
      planPath: "docs/plans/cyclic.md",
      repo: "owner/repo",
      mode: "apply",
      confirmed: true,
    }),
    (error) => error?.code === "NORTHSTAR_SPEC_PLAN_DEPENDENCY_CYCLE"
      && /NORTHSTAR_SPEC_PLAN_DEPENDENCY_CYCLE/.test(error.message),
  );
});

test("northstar spec plan intake detects dependency cycles through issue-number references", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  const cyclicIssueReferencePlanText = `# Cyclic Plan

## Task 1: First
Depends-On: #2

Acceptance Criteria:
- First task is tracked.

Quantitative Metrics:
- first_metric = 1

Required Tests:
- node tests/first.test.ts

## Task 2: Second
Depends-On: #1

Acceptance Criteria:
- Second task is tracked.

Quantitative Metrics:
- second_metric = 1

Required Tests:
- node tests/second.test.ts
`;

  assert.throws(
    () => generateIssueDraftsFromSpecPlan({
      specText,
      planText: cyclicIssueReferencePlanText,
      specPath: "docs/specs/search.md",
      planPath: "docs/plans/cyclic.md",
      repo: "owner/repo",
      mode: "apply",
      confirmed: true,
    }),
    (error) => error?.code === "NORTHSTAR_SPEC_PLAN_DEPENDENCY_CYCLE"
      && /NORTHSTAR_SPEC_PLAN_DEPENDENCY_CYCLE/.test(error.message),
  );
});

test("northstar spec plan intake rejects secret-shaped values before generating issue drafts", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  assert.throws(
    () => generateIssueDraftsFromSpecPlan({
      specText,
      planText: `${planText}\n\n## Task 3: Never Leak ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD\n`,
      specPath: "docs/specs/search.md",
      planPath: "docs/plans/search.md",
      repo: "owner/repo",
    }),
    (error) => error?.code === "NORTHSTAR_SPEC_PLAN_SECRET_LEAK_DETECTED"
      && /NORTHSTAR_SPEC_PLAN_SECRET_LEAK_DETECTED/.test(error.message),
  );
});

test("northstar spec plan intake rejects secret-shaped source paths before returning drafts", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);

  assert.throws(
    () => generateIssueDraftsFromSpecPlan({
      specText,
      planText,
      specPath: "docs/specs/ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD.md",
      planPath: "docs/plans/search.md",
      repo: "owner/repo",
    }),
    (error) => error?.code === "NORTHSTAR_SPEC_PLAN_SECRET_LEAK_DETECTED"
      && /NORTHSTAR_SPEC_PLAN_SECRET_LEAK_DETECTED/.test(error.message),
  );
});
