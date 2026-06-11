import assert from "node:assert/strict";
import test from "node:test";

const planningModule = "../../skills/northstar/scripts/lib/planning-pipeline.mjs";
const intakeModule = "../../skills/northstar/scripts/lib/spec-plan-intake.mjs";

const briefText = `# Todo Planning Workflow

Build a browser-verified daily planning workflow for the todo app.

Acceptance Criteria:
- Users can add a task with a due date.
- Users can mark a daily planning task complete.

Required Tests:
- npm test
- npm run test:browser
`;

test("northstar planning pipeline grills incomplete briefs into actionable questions", async () => {
  const { generatePlanningGrill } = await import(planningModule);

  const result = generatePlanningGrill({
    briefText: "Build todo planning.",
    briefPath: "docs/briefs/todo.md",
  });

  assert.equal(result.mode, "grill");
  assert.deepEqual(result.skillLineage, ["northstar:planning-grill"]);
  assert.deepEqual(result.contract, {
    asksOneQuestionAtATime: true,
    resolvesDecisionTreeBranches: true,
    exploresCodebaseWhenQuestionIsAnswerableByCode: true,
    requiresApprovalBeforeImplementation: true,
  });
  assert.equal(result.questions.length >= 3, true);
  assert.equal(result.nextQuestion.id, result.questions[0].id);
  assert.ok(result.questions.every((question) => question.id && question.prompt && question.reason));
  assert.match(result.markdown, /# Northstar Planning Grill/);
  assert.match(result.markdown, /## Northstar Grill Contract/);
  assert.match(result.markdown, /northstar:planning-grill/);
  assert.doesNotMatch(result.markdown, /mattpocock:/);
  assert.doesNotMatch(result.markdown, /superpowers:/);
  assert.match(result.markdown, /docs\/briefs\/todo\.md/);
  assert.equal(result.metrics.planning_grill_questions_generated >= 3, true);
});

test("northstar planning pipeline turns brief and answers into a standard spec", async () => {
  const { generatePlanningSpec } = await import(planningModule);

  const result = generatePlanningSpec({
    briefText,
    answersText: [
      "Target user: individual todo app user.",
      "Non-goal: calendar integration.",
      "Browser evidence is required.",
    ].join("\n"),
    briefPath: "docs/briefs/todo.md",
  });

  assert.equal(result.mode, "spec");
  assert.deepEqual(result.skillLineage, ["northstar:planning-spec"]);
  assert.deepEqual(result.contract, {
    interviewsUserAgain: false,
    synthesizesExistingContext: true,
    includesMajorModules: true,
    looksForDeepModules: true,
  });
  assert.match(result.markdown, /# Todo Planning Workflow Spec/);
  for (const heading of [
    "## Northstar Spec Contract",
    "## Objective",
    "## Source Brief",
    "## Constraints",
    "## Product Requirements",
    "## User Stories",
    "## Acceptance Criteria",
    "## Quantitative Metrics",
    "## Required Tests",
    "## Open Questions",
  ]) {
    assert.match(result.markdown, new RegExp(heading.replaceAll("#", "\\#")));
  }
  assert.match(result.markdown, /Browser evidence is required/);
  assert.match(result.markdown, /northstar:planning-spec/);
  assert.doesNotMatch(result.markdown, /mattpocock:/);
  assert.doesNotMatch(result.markdown, /superpowers:/);
  assert.match(result.markdown, /Do not interview/);
  assert.match(result.markdown, /Implementation Decisions/);
  assert.match(result.markdown, /Testing Decisions/);
  assert.match(result.markdown, /Out of Scope/);
  assert.equal(result.metrics.planning_spec_generated, 1);
  assert.equal(result.metrics.planning_spec_contract_present, 1);
});

test("northstar planning pipeline turns a spec into an implementation plan compatible with issue intake", async () => {
  const { generatePlanningSpec, generateImplementationPlan } = await import(planningModule);
  const { generateIssueDraftsFromSpecPlan } = await import(intakeModule);
  const spec = generatePlanningSpec({
    briefText,
    answersText: "Browser evidence is required.",
    briefPath: "docs/briefs/todo.md",
  });

  const plan = generateImplementationPlan({
    specText: spec.markdown,
    specPath: "docs/specs/todo.md",
  });

  assert.equal(plan.mode, "implementation-plan");
  assert.deepEqual(plan.skillLineage, ["northstar:implementation-planning"]);
  assert.deepEqual(plan.contract, {
    usesCheckboxSteps: true,
    includesExactCommands: true,
    includesExpectedOutcomes: true,
    decomposesIntoBiteSizedTasks: true,
    mapsSpecToRuntimeWorkflow: true,
    definesIssueSlicingHints: true,
    includesNorthstarCliGates: true,
    includesEvidenceAndProjectProjection: true,
  });
  assert.match(plan.markdown, /# Todo Planning Workflow Implementation Plan/);
  assert.doesNotMatch(plan.markdown, /REQUIRED SUB-SKILL/);
  assert.doesNotMatch(plan.markdown, /superpowers:writing-plans/);
  assert.doesNotMatch(plan.markdown, /writing-plans/);
  assert.match(plan.markdown, /\*\*Goal:\*\*/);
  assert.match(plan.markdown, /\*\*Architecture:\*\*/);
  assert.match(plan.markdown, /\*\*Tech Stack:\*\*/);
  assert.match(plan.markdown, /## Northstar Planning Contract/);
  assert.match(plan.markdown, /## Runtime Workflow Map/);
  assert.match(plan.markdown, /## Issue Generation Guidance/);
  assert.match(plan.markdown, /northstar:implementation-planning/);
  assert.doesNotMatch(plan.markdown, /mattpocock:/);
  assert.match(plan.markdown, /### Task 1:/);
  assert.match(plan.markdown, /### Task 2:/);
  assert.match(plan.markdown, /- \[ \] \*\*Step 1:/);
  assert.match(plan.markdown, /Depends-On: Task 1/);
  assert.equal(plan.metrics.planning_implementation_tasks_generated >= 2, true);
  assert.equal(plan.metrics.planning_northstar_implementation_contract_present, 1);

  const issues = generateIssueDraftsFromSpecPlan({
    specText: spec.markdown,
    planText: plan.markdown,
    specPath: "docs/specs/todo.md",
    planPath: "docs/plans/todo.md",
    repo: "owner/repo",
  });
  assert.equal(issues.issueDrafts.length >= 2, true);
  assert.equal(issues.skillLineage.includes("northstar:issue-slicing"), true);
  assert.deepEqual(issues.contract, {
    usesTracerBulletVerticalSlices: true,
    avoidsHorizontalLayerSlicing: true,
    asksApprovalBeforeCreation: true,
    classifiesAfkOrHitl: true,
  });
  assert.equal(issues.metrics.issue_slicing_contract_present, 1);
  assert.match(issues.issueDrafts[0].body, /Planning Source Contract: northstar:issue-slicing/);
  assert.doesNotMatch(issues.issueDrafts[0].body, /mattpocock:/);
  assert.doesNotMatch(issues.issueDrafts[0].body, /superpowers:/);
  assert.match(issues.issueDrafts[0].body, /Tracer Bullet Vertical Slice/);
  assert.match(issues.issueDrafts[0].body, /Type: AFK/);
  assert.match(issues.issueDrafts[0].body, /What to build/);
  assert.equal(issues.metrics.dependency_graph_edges >= 1, true);
});
