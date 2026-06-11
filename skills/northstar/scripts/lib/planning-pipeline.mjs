const sectionNames = Object.freeze([
  "Acceptance Criteria",
  "Quantitative Metrics",
  "Required Tests",
]);
const grillSkillLineage = Object.freeze(["northstar:planning-grill"]);
const specSkillLineage = Object.freeze(["northstar:planning-spec"]);
const implementationPlanSkillLineage = Object.freeze(["northstar:implementation-planning"]);
const grillContract = Object.freeze({
  asksOneQuestionAtATime: true,
  resolvesDecisionTreeBranches: true,
  exploresCodebaseWhenQuestionIsAnswerableByCode: true,
  requiresApprovalBeforeImplementation: true,
});
const prdContract = Object.freeze({
  interviewsUserAgain: false,
  synthesizesExistingContext: true,
  includesMajorModules: true,
  looksForDeepModules: true,
});
const implementationPlanContract = Object.freeze({
  usesCheckboxSteps: true,
  includesExactCommands: true,
  includesExpectedOutcomes: true,
  decomposesIntoBiteSizedTasks: true,
  mapsSpecToRuntimeWorkflow: true,
  definesIssueSlicingHints: true,
  includesNorthstarCliGates: true,
  includesEvidenceAndProjectProjection: true,
});

export function generatePlanningGrill(input = {}) {
  const briefText = nonEmptyString(input.briefText, "briefText");
  assertNoSecretShape(briefText);
  const title = titleFromMarkdown(briefText, "Northstar Project");
  const missing = sectionNames.filter((name) => !extractSection(briefText, name));
  const questions = [
    ...missing.map((name) => ({
      id: slug(`missing-${name}`),
      prompt: `What should the ${name.toLowerCase()} be?`,
      reason: `${name} is required before generating a reliable Northstar plan.`,
    })),
    {
      id: "execution-evidence",
      prompt: "What runtime or browser evidence must prove completion?",
      reason: "Northstar issue execution needs auditable acceptance evidence.",
    },
    {
      id: "dependency-order",
      prompt: "Which work must happen first, and which tasks can run in parallel?",
      reason: "The generated issue graph must avoid ambiguous scheduling.",
    },
  ];
  const uniqueQuestions = uniqueById(questions);
  const markdown = [
    "# Northstar Planning Grill",
    "",
    `Source: ${input.briefPath ?? "inline brief"}`,
    `Project: ${title}`,
    "",
    "## Questions",
    ...uniqueQuestions.map((question, index) => `${index + 1}. ${question.prompt}\n   Reason: ${question.reason}`),
    "",
    "## Northstar Grill Contract",
    "- Source contract: northstar:planning-grill.",
    "- Ask exactly one question at a time; do not bundle the whole queue into a single user prompt.",
    "- Walk the design decision tree branch-by-branch until each dependency is resolved.",
    "- If a question can be answered by reading code or docs, inspect those sources instead of asking the user.",
    "- Do not proceed to implementation, PRD, or issue creation until the user approves the resolved direction.",
    "",
    "## Next Question",
    `${uniqueQuestions[0]?.prompt ?? "No unresolved questions."}`,
    "",
    "## Detected Gaps",
    ...(missing.length > 0 ? missing.map((name) => `- ${name}`) : ["- None."]),
  ].join("\n");

  return {
    mode: "grill",
    title,
    skillLineage: [...grillSkillLineage],
    contract: { ...grillContract },
    nextQuestion: uniqueQuestions[0] ?? undefined,
    questions: uniqueQuestions,
    missingSections: missing,
    markdown,
    metrics: {
      planning_grill_questions_generated: uniqueQuestions.length,
      planning_grill_missing_sections: missing.length,
      secret_leaks_in_planning_output: 0,
    },
  };
}

export function generatePlanningSpec(input = {}) {
  const briefText = nonEmptyString(input.briefText, "briefText");
  const answersText = typeof input.answersText === "string" ? input.answersText.trim() : "";
  assertNoSecretShape(`${briefText}\n${answersText}`);
  const title = titleFromMarkdown(briefText, "Northstar Project");
  const acceptance = extractSection(briefText, "Acceptance Criteria") || "- Acceptance criteria must be confirmed before implementation.";
  const metrics = extractSection(briefText, "Quantitative Metrics") || "- planning_acceptance_defined = 1";
  const tests = extractSection(briefText, "Required Tests") || "- npm test";
  const objective = firstParagraphAfterTitle(briefText) || `Deliver ${title}.`;
  const constraints = answersText || "None.";
  const userStories = inferUserStories({ title, objective, acceptance });
  const nonGoals = inferNonGoals(answersText);

  const markdown = [
    `# ${title} Spec`,
    "",
    "## Northstar Spec Contract",
    "- Source contract: northstar:planning-spec.",
    "- Synthesize known conversation, brief, and codebase context into a PRD/spec.",
    "- Do not interview the user again during this stage; unresolved questions stay in Open Questions.",
    "- Include major modules and deep-module opportunities so implementation can target stable interfaces.",
    "- This document is the approved source for `plan-implementation` and `plan-issues`.",
    "",
    "## Objective",
    objective,
    "",
    "## Source Brief",
    input.briefPath ?? "inline brief",
    "",
    "## Constraints",
    constraints,
    "",
    "## Product Requirements",
    acceptance,
    "",
    "## User Stories",
    userStories,
    "",
    "## Implementation Decisions",
    "- Preserve existing Northstar architecture boundaries and prefer existing seams.",
    "- Avoid specific file paths in the PRD unless a prototype snippet encodes a durable decision.",
    "- Major modules to build or modify: planning pipeline, CLI command surface, operator command mapping, generated issue intake.",
    "- Deep module opportunity: keep planning contract generation behind a small deterministic helper API.",
    "",
    "## Testing Decisions",
    tests,
    "",
    "## Non-Goals",
    nonGoals,
    "",
    "## Acceptance Criteria",
    acceptance,
    "",
    "## Quantitative Metrics",
    metrics,
    "",
    "## Required Tests",
    tests,
    "",
    "## Out of Scope",
    nonGoals,
    "",
    "## Open Questions",
    "None.",
  ].join("\n");

  assertNoSecretShape(markdown);
  return {
    mode: "spec",
    title,
    skillLineage: [...specSkillLineage],
    contract: { ...prdContract },
    markdown,
    metrics: {
      planning_spec_generated: 1,
      planning_spec_contract_present: 1,
      planning_spec_acceptance_present: hasSpecified(acceptance) ? 1 : 0,
      planning_spec_required_tests_present: hasSpecified(tests) ? 1 : 0,
      secret_leaks_in_planning_output: 0,
    },
  };
}

export function generateImplementationPlan(input = {}) {
  const specText = nonEmptyString(input.specText, "specText");
  assertNoSecretShape(specText);
  const title = titleFromMarkdown(specText, "Northstar Project").replace(/\s+Spec$/i, "");
  const acceptance = extractSection(specText, "Acceptance Criteria") || "- Spec acceptance criteria are satisfied.";
  const metrics = extractSection(specText, "Quantitative Metrics") || "- implementation_plan_ready = 1";
  const tests = extractSection(specText, "Required Tests") || "- npm test";
  const safeTitle = title.replace(/\s+Implementation Plan$/i, "");

  const markdown = [
    `# ${safeTitle} Implementation Plan`,
    "",
    "> **Northstar planning contract:** This plan is a runtime-ready execution contract for Northstar operators and workers. It turns an approved spec into issue-sized implementation tasks, verification evidence, Project projection expectations, and release gates without requiring an external planning skill.",
    "",
    `**Goal:** Deliver ${safeTitle} from the approved PRD/spec as independently verifiable Northstar work.`,
    "",
    "**Architecture:** Keep planning as a deterministic contract pipeline. Preserve Northstar runtime boundaries by generating issue-ready vertical slices without embedding agent-specific skill execution into the runtime.",
    "",
    "**Tech Stack:** Northstar CLI, GitHub issues, Markdown PRD/spec documents, implementation plans, and runtime/browser verification evidence.",
    "",
    "---",
    "",
    `Source Spec: ${input.specPath ?? "inline spec"}`,
    "",
    "## Northstar Planning Contract",
    "- Source contract: northstar:implementation-planning.",
    "- Each task must be small enough to become one GitHub issue or a clearly ordered issue dependency.",
    "- Each task must include exact commands, expected outcomes, verification evidence, and a commit boundary.",
    "- Each task must state the runtime or Project evidence affected when the work changes orchestration, release, recovery, or browser verification.",
    "- Downstream `plan-issues` converts these tasks into Northstar issue-slicing vertical slices.",
    "",
    "## Runtime Workflow Map",
    "- Default domain: software_development.",
    "- Default workflow: issue_to_pr_release unless the consumer config specifies another workflow.",
    "- Expected stage flow: intake -> implementation -> verification -> release -> completed.",
    "- Evidence required at completion: test output, browser/runtime evidence when required by the spec, PR URL, head commit, merge SHA, and final Project projection.",
    "",
    "## Issue Generation Guidance",
    "- Preserve task headings and Depends-On markers; they are consumed by issue generation.",
    "- Prefer vertical slices that produce inspectable behavior over horizontal module-only tickets.",
    "- Mark tasks needing user input as HITL; otherwise keep tasks AFK-capable with explicit verification commands.",
    "",
    `### Task 1: Define ${safeTitle} Contracts`,
    "",
    "Objective: Establish the data, UI, and runtime contract needed by the feature.",
    "",
    "Scope:",
    "- Define inputs, outputs, state transitions, and acceptance evidence.",
    "",
    "Acceptance Criteria:",
    acceptance,
    "",
    "Quantitative Metrics:",
    metrics,
    "",
    "Required Tests:",
    tests,
    "",
    "- [ ] **Step 1: Write the failing contract test**",
    "",
    "Run: `node --disable-warning=ExperimentalWarning tests/skills/northstar-spec-plan-intake.test.ts`",
    "Expected: FAIL until the contract behavior exists.",
    "",
    "- [ ] **Step 2: Implement the minimal contract behavior**",
    "",
    "Use existing Northstar helpers and keep secrets out of generated artifacts.",
    "",
    "- [ ] **Step 3: Run targeted verification**",
    "",
    "Run: `node --disable-warning=ExperimentalWarning tests/skills/northstar-spec-plan-intake.test.ts`",
    "Expected: PASS.",
    "",
    "- [ ] **Step 4: Commit**",
    "",
    "Commit the contract change with its focused tests.",
    "",
    `### Task 2: Implement ${safeTitle} Workflow`,
    "",
    "Depends-On: Task 1",
    "",
    "Objective: Implement the behavior described by the spec and contracts.",
    "",
    "Scope:",
    "- Add the production behavior behind the existing Northstar architecture boundaries.",
    "",
    "Acceptance Criteria:",
    acceptance,
    "",
    "Quantitative Metrics:",
    metrics,
    "",
    "Required Tests:",
    tests,
    "",
    "- [ ] **Step 1: Write the failing workflow test**",
    "",
    "Run: `npm test`",
    "Expected: FAIL until the workflow behavior exists.",
    "",
    "- [ ] **Step 2: Implement the workflow behavior**",
    "",
    "Keep the implementation behind existing Northstar driver and CLI boundaries.",
    "",
    "- [ ] **Step 3: Run full verification**",
    "",
    "Run: `npm test`",
    "Expected: PASS.",
    "",
    "- [ ] **Step 4: Commit**",
    "",
    "Commit the workflow behavior with its focused tests.",
    "",
    `### Task 3: Verify ${safeTitle} Evidence`,
    "",
    "Depends-On: Task 2",
    "",
    "Objective: Prove completion with the required automated and browser evidence.",
    "",
    "Scope:",
    "- Run required tests and record evidence expected by the workflow.",
    "",
    "Acceptance Criteria:",
    "- Required tests pass.",
    "- Browser or runtime evidence is captured when required.",
    "",
    "Quantitative Metrics:",
    "- verification_evidence_recorded = 1",
    "",
    "Required Tests:",
    tests,
    "",
    "- [ ] **Step 1: Run all required tests**",
    "",
    "Run the commands listed under Required Tests.",
    "",
    "- [ ] **Step 2: Capture browser or runtime evidence**",
    "",
    "Record evidence required by the approved PRD/spec and Northstar workflow.",
    "",
    "- [ ] **Step 3: Commit evidence wiring**",
    "",
    "Commit only durable evidence wiring or documentation needed by the release path.",
  ].join("\n");

  assertNoSecretShape(markdown);
  return {
    mode: "implementation-plan",
    title: safeTitle,
    skillLineage: [...implementationPlanSkillLineage],
    contract: { ...implementationPlanContract },
    markdown,
    metrics: {
      planning_implementation_tasks_generated: 3,
      planning_implementation_dependencies_generated: 2,
      planning_northstar_implementation_contract_present: 1,
      secret_leaks_in_planning_output: 0,
    },
  };
}

function nonEmptyString(value, field) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw newPlanningError("NORTHSTAR_PLANNING_INPUT_INVALID", `${field} is required`);
}

function titleFromMarkdown(text, fallback) {
  return text.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || fallback;
}

function firstParagraphAfterTitle(text) {
  return text
    .replace(/^#\s+.+?\s*$/m, "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.endsWith(":") && !part.startsWith("-")) ?? "";
}

function extractSection(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markdown = text.match(new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s+|\\s*$)`, "im"))?.[1]?.trim();
  if (markdown) return markdown;

  const label = text.match(new RegExp(`^${escaped}:\\s*\\n([\\s\\S]*?)(?=^[A-Z][A-Za-z ]+:\\s*$|^##\\s+|\\s*$)`, "im"))?.[1]?.trim();
  return label ?? "";
}

function inferNonGoals(answersText) {
  const nonGoalLines = answersText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^non-?goal/i.test(line));
  return nonGoalLines.length > 0 ? nonGoalLines.map((line) => `- ${line.replace(/^non-?goal:\s*/i, "")}`).join("\n") : "None.";
}

function inferUserStories({ title, objective, acceptance }) {
  const criteria = acceptance
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  const stories = criteria.length > 0 ? criteria : [objective];
  return stories
    .map((story, index) => `${index + 1}. As a Northstar operator, I want ${story.replace(/\.$/, "")}, so that ${title} can be verified from user-visible behavior.`)
    .join("\n");
}

function hasSpecified(value) {
  return Boolean(value && value.trim() && value.trim() !== "Not specified.");
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function assertNoSecretShape(text) {
  if (/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/.test(text)) {
    throw newPlanningError("NORTHSTAR_PLANNING_SECRET_LEAK_DETECTED");
  }
}

function newPlanningError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
