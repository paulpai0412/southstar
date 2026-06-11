import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialWizardState,
  generateWizardCommandPlan,
  reduceWizardAction,
} from "../../src/operator-dashboard/wizard.ts";

test("initial wizard state exposes all northstar phases and starts at plan", () => {
  const state = buildInitialWizardState({
    projectId: "northstar-test",
    configPath: "/repo/.northstar.yaml",
    hasConfig: false,
    hostAdapter: "codex",
    issueCount: 0,
    activeIssueCount: 0,
    hasRetryableFailures: false,
    planIssuesCliAvailable: false,
  });

  assert.equal(state.currentPhase, "plan");
  assert.deepEqual(state.phases.map((phase) => phase.phase), ["plan", "setup", "execute", "monitor", "recovery", "report"]);
  assert.equal(state.phases.find((phase) => phase.phase === "setup")?.status, "ready");
  assert.equal(state.nextRecommendedAction, "Generate a plan command or move to setup for an existing GitHub issue workflow.");
});

test("wizard setup plan preserves codex opencode and pi host adapter choices", () => {
  const plan = generateWizardCommandPlan({
    phase: "setup",
    configPath: "/repo/.northstar.yaml",
    hostAdapter: "pi",
    options: { selectedHostAdapter: "opencode" },
  });

  assert.equal(plan.id, "setup:doctor");
  assert.equal(plan.phase, "setup");
  assert.equal(plan.risk, "medium");
  assert.equal(plan.requiresConfirmation, true);
  assert.deepEqual(plan.argv, ["node", "skills/northstar/scripts/doctor.mjs", "--config", "/repo/.northstar.yaml"]);
  assert.equal(plan.description, "Run Northstar setup doctor and review config, GitHub label, and Project viewer plans.");
  assert.deepEqual(plan.expectedEffects, [
    "Read local platform, git, GitHub, credential, CLI, and SDK availability.",
    "No config, GitHub label, or GitHub Project mutation occurs without a separate confirmation gate.",
    "Host adapter choices remain codex, opencode, and pi; selected default is opencode.",
  ]);
});

test("wizard command plan ids match implementation plan ids", () => {
  const setup = generateWizardCommandPlan({
    phase: "setup",
    configPath: "/repo/.northstar.yaml",
    hostAdapter: "codex",
  });
  const watch = generateWizardCommandPlan({
    phase: "execute",
    configPath: "/repo/.northstar.yaml",
    hostAdapter: "opencode",
    options: { mode: "watch" },
  });
  const singleIssue = generateWizardCommandPlan({
    phase: "execute",
    configPath: "/repo/.northstar.yaml",
    hostAdapter: "pi",
    issueId: "github:42",
    options: { mode: "single_issue" },
  });
  const createIssues = generateWizardCommandPlan({
    phase: "plan",
    configPath: "/repo/.northstar.yaml",
    hostAdapter: "codex",
    options: { mode: "create_issues" },
  });

  assert.equal(setup.id, "setup:doctor");
  assert.equal(watch.id, "execute:watch");
  assert.equal(singleIssue.id, "execute:start:42");
  assert.equal(createIssues.id, "plan:create-issues");
});

test("wizard create issues plan is blocked when production plan-issues cli is absent", () => {
  const state = buildInitialWizardState({
    projectId: "northstar-test",
    configPath: "/repo/.northstar.yaml",
    hasConfig: true,
    hostAdapter: "codex",
    issueCount: 0,
    activeIssueCount: 0,
    hasRetryableFailures: false,
    planIssuesCliAvailable: false,
  });

  const next = reduceWizardAction(state, {
    action: "generate_command_plan",
    phase: "plan",
    options: { mode: "create_issues", specPath: "docs/spec.md", planPath: "docs/plan.md" },
  });

  assert.equal(next.phases.find((phase) => phase.phase === "plan")?.status, "blocked");
  assert.equal(
    next.confirmationGates[0].reason,
    "GitHub issue creation requires confirmation, but production northstar plan-issues CLI is not available in this branch.",
  );
  assert.equal(next.confirmationGates[0].id, "plan:create-issues:blocked");
  assert.equal(next.commandPlans[0].id, "plan:create-issues");
  assert.deepEqual(next.commandPlans[0].argv, []);
  assert.equal(next.commandPlans[0].requiresConfirmation, true);
  assert.equal(next.commandPlans[0].risk, "high");
  const normalGate = next.confirmationGates.find((gate) => gate.id === "plan:create-issues:confirmation");
  assert.equal(normalGate, undefined);
});

test("wizard create issues plan is confirmation-gated when production plan-issues cli is available", () => {
  const state = buildInitialWizardState({
    projectId: "northstar-test",
    configPath: "/repo/.northstar.yaml",
    hasConfig: true,
    hostAdapter: "codex",
    issueCount: 0,
    activeIssueCount: 0,
    hasRetryableFailures: false,
    planIssuesCliAvailable: true,
  });

  const next = reduceWizardAction(state, {
    action: "generate_command_plan",
    phase: "plan",
    options: { mode: "create_issues", specPath: "docs/spec.md", planPath: "docs/plan.md" },
  });

  assert.equal(next.phases.find((phase) => phase.phase === "plan")?.status, "waiting_for_confirmation");
  assert.equal(next.commandPlans[0].id, "plan:create-issues");
  assert.deepEqual(next.commandPlans[0].argv, [
    "node",
    "--run",
    "northstar",
    "--",
    "plan-issues",
    "--config",
    "/repo/.northstar.yaml",
    "--spec",
    "docs/spec.md",
    "--plan",
    "docs/plan.md",
    "--apply",
    "--confirmed",
  ]);
  assert.equal(next.confirmationGates[0].id, "plan:create-issues:confirmation");
});

test("wizard execute plan requires confirmation before dispatching workers", () => {
  const plan = generateWizardCommandPlan({
    phase: "execute",
    configPath: "/repo/.northstar.yaml",
    issueId: "github:42",
    hostAdapter: "pi",
    options: { mode: "single_issue" },
  });

  assert.equal(plan.id, "execute:start:42");
  assert.deepEqual(plan.argv, ["node", "--run", "northstar", "--", "start", "--config", "/repo/.northstar.yaml", "--issue", "42"]);
  assert.equal(plan.risk, "medium");
  assert.equal(plan.requiresConfirmation, true);
  assert.match(plan.expectedEffects.join("\n"), /Dispatch one Northstar worker through the configured host adapter pi/);
});

test("wizard watch plan describes ready issue dispatch through selected adapter", () => {
  const plan = generateWizardCommandPlan({
    phase: "execute",
    configPath: "/repo/.northstar.yaml",
    hostAdapter: "opencode",
    options: { mode: "watch" },
  });

  assert.equal(plan.id, "execute:watch");
  assert.equal(plan.description, "Start Northstar watch mode for ready issues.");
  assert.deepEqual(plan.expectedEffects, ["Dispatch ready issues through the configured host adapter opencode."]);
});

test("wizard replaces duplicate setup command plans and gates by id", () => {
  const state = buildInitialWizardState({
    projectId: "northstar-test",
    configPath: "/repo/.northstar.yaml",
    hasConfig: false,
    hostAdapter: "codex",
    issueCount: 0,
    activeIssueCount: 0,
    hasRetryableFailures: false,
    planIssuesCliAvailable: true,
  });

  const once = reduceWizardAction(state, {
    action: "generate_command_plan",
    phase: "setup",
  });
  const twice = reduceWizardAction(once, {
    action: "generate_command_plan",
    phase: "setup",
  });

  assert.equal(twice.commandPlans.filter((plan) => plan.id === "setup:doctor").length, 1);
  assert.equal(twice.confirmationGates.filter((gate) => gate.id === "setup:doctor:confirmation").length, 1);
});

test("wizard reducer blocks execute single issue command generation when issue id is missing", () => {
  const state = buildInitialWizardState({
    projectId: "northstar-test",
    configPath: "/repo/.northstar.yaml",
    hasConfig: true,
    hostAdapter: "codex",
    issueCount: 1,
    activeIssueCount: 0,
    hasRetryableFailures: false,
    planIssuesCliAvailable: true,
  });

  const next = reduceWizardAction(state, {
    action: "generate_command_plan",
    phase: "execute",
    options: { mode: "single_issue" },
  });

  const execute = next.phases.find((phase) => phase.phase === "execute");
  assert.equal(execute?.status, "blocked");
  assert.match(execute?.blockers.join("\n") ?? "", /GitHub issue id is required/);
  assert.deepEqual(next.commandPlans, []);
});
