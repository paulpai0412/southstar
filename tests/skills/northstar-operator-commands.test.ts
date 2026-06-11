import assert from "node:assert/strict";
import test from "node:test";

const operatorCommandsModule = "../../skills/northstar/scripts/lib/operator-commands.mjs";

test("northstar operator commands advertise the supported operator intents", async () => {
  const { supportedOperatorIntents } = await import(operatorCommandsModule);

  assert.equal(supportedOperatorIntents.length >= 11, true);
  for (const intent of ["setup", "plan issues", "run", "status", "recover", "intake", "start", "reconcile", "release", "inspect", "watch"]) {
    assert.ok(supportedOperatorIntents.includes(intent), `missing supported intent ${intent}`);
  }
});

test("northstar operator commands map issue intents to explicit argv plans", async () => {
  const { commandPlanForIntent, supportedOperatorIntents } = await import(operatorCommandsModule);
  const configPath = "/repo/.northstar.yaml";

  for (const intent of ["intake", "start", "reconcile", "release", "inspect"]) {
    assert.deepEqual(commandPlanForIntent({ intent, configPath, issue: 42 }), {
      argv: ["node", "--run", "northstar", "--", intent, "--config", configPath, "--issue", "42"],
      metadata: { skill_operator_issue_commands_mapped: supportedOperatorIntents.length },
    });
  }
});

test("northstar operator commands map setup, run, status, and recover intents to exact argv arrays", async () => {
  const { commandPlanForIntent, supportedOperatorIntents } = await import(operatorCommandsModule);
  const configPath = "/repo/.northstar.yaml";

  assert.deepEqual(commandPlanForIntent({ intent: "setup", configPath }), {
    argv: ["node", "--run", "northstar", "--", "doctor", "--config", configPath],
    metadata: { skill_operator_issue_commands_mapped: supportedOperatorIntents.length },
  });
  assert.deepEqual(commandPlanForIntent({ intent: "run", configPath }), {
    argv: ["node", "--run", "northstar", "--", "watch", "--config", configPath],
    metadata: { skill_operator_issue_commands_mapped: supportedOperatorIntents.length },
  });
  assert.deepEqual(commandPlanForIntent({ intent: "status", configPath }), {
    argv: ["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"],
    metadata: { skill_operator_issue_commands_mapped: supportedOperatorIntents.length },
  });
  assert.deepEqual(commandPlanForIntent({ intent: "recover", configPath }), {
    argv: ["node", "--run", "northstar", "--", "repair-runtime", "--config", configPath],
    metadata: { skill_operator_issue_commands_mapped: supportedOperatorIntents.length },
  });
});

test("northstar operator commands map plan issues without shell strings", async () => {
  const { commandPlanForIntent } = await import(operatorCommandsModule);
  const plan = commandPlanForIntent({
    intent: "plan issues",
    configPath: "/repo/.northstar.yaml",
    specPath: "docs/specs/example.md",
    planPath: "docs/plans/example.md",
  });

  assert.deepEqual(plan.argv, [
    "node",
    "--run",
    "northstar",
    "--",
    "plan-issues",
    "--config",
    "/repo/.northstar.yaml",
    "--spec",
    "docs/specs/example.md",
    "--plan",
    "docs/plans/example.md",
    "--dry-run",
  ]);
  assert.ok(plan.argv.every((part) => !part.includes(" ")), "argv parts must not be shell command strings");
});

test("northstar operator commands support watch options without issue selectors", async () => {
  const { commandPlanForIntent, supportedOperatorIntents } = await import(operatorCommandsModule);
  const configPath = "/repo/.northstar.yaml";

  assert.deepEqual(commandPlanForIntent({ intent: "watch", configPath }), {
    argv: ["node", "--run", "northstar", "--", "watch", "--config", configPath],
    metadata: { skill_operator_issue_commands_mapped: supportedOperatorIntents.length },
  });
  assert.deepEqual(commandPlanForIntent({ intent: "watch", configPath, maxCycles: 3, logJson: true }), {
    argv: ["node", "--run", "northstar", "--", "watch", "--config", configPath, "--max-cycles", "3", "--log-json"],
    metadata: { skill_operator_issue_commands_mapped: supportedOperatorIntents.length },
  });
  assert.deepEqual(commandPlanForIntent({ intent: "watch", configPath, logJson: false }), {
    argv: ["node", "--run", "northstar", "--", "watch", "--config", configPath],
    metadata: { skill_operator_issue_commands_mapped: supportedOperatorIntents.length },
  });
});

test("northstar operator commands reject missing or invalid issue selectors", async () => {
  const { commandPlanForIntent } = await import(operatorCommandsModule);
  const configPath = "/repo/.northstar.yaml";

  for (const issue of [undefined, null, "", "12.5", 12.5, 0, -1]) {
    assert.throws(
      () => commandPlanForIntent({ intent: "start", configPath, issue }),
      /NORTHSTAR_SKILL_ISSUE_REQUIRED/,
    );
  }
});

test("northstar operator commands reject missing or invalid config paths", async () => {
  const { commandPlanForIntent } = await import(operatorCommandsModule);

  for (const configPath of [undefined, null, "", "   ", { path: "/repo/.northstar.yaml" }]) {
    assert.throws(
      () => commandPlanForIntent({ intent: "start", configPath, issue: 42 }),
      /NORTHSTAR_SKILL_CONFIG_REQUIRED/,
    );
  }
});

test("northstar operator commands reject invalid watch options", async () => {
  const { commandPlanForIntent } = await import(operatorCommandsModule);
  const configPath = "/repo/.northstar.yaml";

  for (const maxCycles of [null, "", "4.5", 4.5, 0, -1]) {
    assert.throws(
      () => commandPlanForIntent({ intent: "watch", configPath, maxCycles }),
      /NORTHSTAR_SKILL_INVALID_WATCH_OPTION/,
    );
  }

  for (const logJson of [null, "", "true", 1, 0, {}]) {
    assert.throws(
      () => commandPlanForIntent({ intent: "watch", configPath, logJson }),
      /NORTHSTAR_SKILL_INVALID_WATCH_OPTION/,
    );
  }
});

test("northstar operator commands reject unknown intents", async () => {
  const { commandPlanForIntent } = await import(operatorCommandsModule);

  assert.throws(
    () => commandPlanForIntent({ intent: "deploy", configPath: "/repo/.northstar.yaml", issue: 42 }),
    /NORTHSTAR_SKILL_UNKNOWN_INTENT/,
  );
});

test("northstar operator commands reject non-string intents without coercion", async () => {
  const { commandPlanForIntent } = await import(operatorCommandsModule);

  for (const intent of [
    { toString: () => "watch" },
    { toString: () => "start" },
  ]) {
    assert.throws(
      () => commandPlanForIntent({ intent, configPath: "/repo/.northstar.yaml", issue: 42 }),
      /NORTHSTAR_SKILL_UNKNOWN_INTENT/,
    );
  }
});

test("northstar operator commands map phase commands and aliases", async () => {
  const { commandPlanForIntent } = await import(operatorCommandsModule);
  const configPath = "/repo/.northstar.yaml";

  const cases = [
    ["/northstar-setup", ["node", "--run", "northstar", "--", "doctor", "--config", configPath]],
    ["/northstar-init", ["node", "--run", "northstar", "--", "doctor", "--config", configPath]],
    ["/northstar-execute", ["node", "--run", "northstar", "--", "watch", "--config", configPath]],
    ["/northstar-watch", ["node", "--run", "northstar", "--", "watch", "--config", configPath]],
    ["/northstar-observe", ["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"]],
    ["/northstar-status", ["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"]],
    ["/northstar-recover", ["node", "--run", "northstar", "--", "repair-runtime", "--config", configPath]],
    ["/northstar-recovery", ["node", "--run", "northstar", "--", "repair-runtime", "--config", configPath]],
    ["/northstar-report", ["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"]],
  ];

  for (const [intent, argv] of cases) {
    const plan = commandPlanForIntent({ intent, configPath });
    assert.deepEqual(plan.argv, argv);
    assert.equal(plan.metadata.phase_command_mapped, 1);
  }
});

test("northstar operator commands map planning aliases to planning modes", async () => {
  const { commandPlanForIntent } = await import(operatorCommandsModule);
  const configPath = "/repo/.northstar.yaml";

  for (const [intent, mode, argv] of [
    ["/northstar-plan", "interactive", ["node", "--run", "northstar", "--", "plan-grill", "--config", configPath, "--brief", "docs/briefs/example.md", "--dry-run"]],
    ["/northstar-grill", "grill", ["node", "--run", "northstar", "--", "plan-grill", "--config", configPath, "--brief", "docs/briefs/example.md", "--dry-run"]],
    ["/northstar-to-spec", "spec", ["node", "--run", "northstar", "--", "plan-spec", "--config", configPath, "--brief", "docs/briefs/example.md", "--answers", "docs/briefs/example-answers.md", "--out", "docs/specs/example.md"]],
    ["/northstar-to-plan", "implementation-plan", ["node", "--run", "northstar", "--", "plan-implementation", "--config", configPath, "--spec", "docs/specs/example.md", "--out", "docs/plans/example.md"]],
  ]) {
    const plan = commandPlanForIntent({
      intent,
      configPath,
      briefPath: "docs/briefs/example.md",
      answersPath: "docs/briefs/example-answers.md",
      specPath: "docs/specs/example.md",
      planPath: "docs/plans/example.md",
    });
    assert.deepEqual(plan.argv, argv);
    assert.equal(plan.metadata.phase, "plan");
    assert.equal(plan.metadata.planning_mode, mode);
    assert.equal(Array.isArray(plan.metadata.skill_lineage), true);
  }

  const issuePlan = commandPlanForIntent({
    intent: "/northstar-to-issues",
    configPath,
    specPath: "docs/specs/example.md",
    planPath: "docs/plans/example.md",
  });
  assert.deepEqual(issuePlan.argv, [
    "node",
    "--run",
    "northstar",
    "--",
    "plan-issues",
    "--config",
    configPath,
    "--spec",
    "docs/specs/example.md",
    "--plan",
    "docs/plans/example.md",
    "--dry-run",
  ]);
  assert.equal(issuePlan.metadata.planning_mode, "issue-table");
  assert.deepEqual(issuePlan.metadata.skill_lineage, ["northstar:issue-slicing"]);

  const implementationPlan = commandPlanForIntent({
    intent: "/northstar-to-plan",
    configPath,
    specPath: "docs/specs/example.md",
    planPath: "docs/plans/example.md",
  });
  assert.deepEqual(implementationPlan.metadata.skill_lineage, ["northstar:implementation-planning"]);

  const grillPlan = commandPlanForIntent({
    intent: "/northstar-grill",
    configPath,
    briefPath: "docs/briefs/example.md",
  });
  assert.deepEqual(grillPlan.metadata.skill_lineage, ["northstar:planning-grill"]);

  const specPlan = commandPlanForIntent({
    intent: "/northstar-to-spec",
    configPath,
    briefPath: "docs/briefs/example.md",
    answersPath: "docs/briefs/example-answers.md",
    specPath: "docs/specs/example.md",
  });
  assert.deepEqual(specPlan.metadata.skill_lineage, ["northstar:planning-spec"]);
});

test("northstar operator command validation is isolated from exported intent mutations", async () => {
  const { commandPlanForIntent, supportedOperatorIntents } = await import(operatorCommandsModule);
  const fakeIntent = "deploy";

  assert.equal(Object.isFrozen(supportedOperatorIntents), true);
  assert.throws(() => supportedOperatorIntents.push(fakeIntent), TypeError);
  assert.throws(
    () => commandPlanForIntent({ intent: fakeIntent, configPath: "/repo/.northstar.yaml", issue: 42 }),
    /NORTHSTAR_SKILL_UNKNOWN_INTENT/,
  );
});
