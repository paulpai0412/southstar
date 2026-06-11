import assert from "node:assert/strict";
import test from "node:test";

const setupModule = "../../skills/northstar/scripts/lib/setup-flow.mjs";

test("setup flow creates config draft and requires project confirmation", async () => {
  const { setupPlan } = await import(setupModule);
  const result = await setupPlan({
    gitRoot: "/consumer/app",
    githubRepo: "owner/app",
    defaultBranch: "main",
    projectMode: "create_new",
    confirmedProjectMutation: false,
  });

  assert.equal(result.metrics.skill_setup_creates_config, 1);
  assert.equal(result.metrics.skill_project_create_requires_confirmation, 1);
  assert.equal(result.canWriteConfig, false);
  assert.equal(result.canMutateProject, false);
  assert.match(result.configDraft, /schema_version: "1\.1"/);
  assert.match(result.configDraft, /path: \.northstar\/workflows\/issue-to-pr-release\.yaml/);
  assert.equal(result.workflowPath, "/consumer/app/.northstar/workflows/issue-to-pr-release.yaml");
  assert.match(result.workflowDraft, /id: issue_to_pr_release/);
  assert.match(result.workflowDraft, /version: "2\.0"/);
  assert.equal(result.metrics.skill_setup_includes_workflow_copy, 1);
  assert.match(result.configDraft, /db_path: \.northstar\/runtime\/control-plane\.sqlite3/);
  assert.match(result.configDraft, /development_capacity: 1/);
  assert.match(result.configDraft, /lease_timeout_seconds: 600/);
  assert.match(result.configDraft, /child_timeout_seconds: 7200/);
  assert.match(result.configDraft, /github:\n  repo: owner\/app/);
  assert.match(result.configDraft, /project:\n    enabled: false/);
});

test("setup flow returns labels, project plan, doctor commands, and confirmation-gated mutations", async () => {
  const { setupPlan } = await import(setupModule);
  const unconfirmed = await setupPlan({
    gitRoot: "/consumer/app",
    githubRepo: "owner/app",
    defaultBranch: "trunk",
    projectMode: "existing",
    confirmedConfigWrite: false,
    confirmedProjectMutation: false,
  });
  const confirmed = await setupPlan({
    gitRoot: "/consumer/app",
    githubRepo: "owner/app",
    defaultBranch: "trunk",
    projectMode: "existing",
    confirmedConfigWrite: true,
    confirmedProjectMutation: true,
  });

  assert.deepEqual(unconfirmed.labelPlan.labels, ["northstar:ready", "northstar:blocked", "northstar:quarantined"]);
  assert.equal(unconfirmed.projectPlan.mode, "existing");
  assert.equal(unconfirmed.projectPlan.canMutate, false);
  assert.equal(unconfirmed.canWriteConfig, false);
  assert.equal(confirmed.canWriteConfig, true);
  assert.equal(confirmed.canMutateProject, true);
  assert.ok(unconfirmed.doctorCommands.every((command) => Array.isArray(command.argv)), "doctor commands must be argv arrays");
  assert.ok(unconfirmed.doctorCommands.some((command) => command.argv.includes("skill:doctor")), "doctor commands should call the real skill doctor script");
  assert.match(unconfirmed.configDraft, /base_branch: trunk/);
  assert.equal(unconfirmed.workflowPath, "/consumer/app/.northstar/workflows/issue-to-pr-release.yaml");
  assert.match(unconfirmed.workflowDraft, /implementation_agent/);
});

test("status flow reads runtime, github, and project summary fields", async () => {
  const { statusSummary } = await import(setupModule);
  const summary = statusSummary({
    runtime: { activeIssues: 2, quarantinedIssues: 1, staleLocks: 1 },
    github: { openReadyIssues: 3, prsOpen: 2, projectStatusMismatches: 0 },
    project: { blockedItems: 4, releaseEvidenceItems: 5 },
  });

  assert.equal(summary.metrics.skill_status_reads_runtime_and_github, 1);
  assert.equal(summary.metrics.skill_status_reads_project, 1);
  assert.match(summary.markdown, /Active issues: 2/);
  assert.match(summary.markdown, /Open ready issues: 3/);
  assert.match(summary.markdown, /Project status mismatches: 0/);
  assert.match(summary.markdown, /Blocked items: 4/);
});

test("recover flow detects stale lock and requires confirmation for mutation", async () => {
  const { recoverPlan } = await import(setupModule);
  const plan = recoverPlan({
    staleLock: { path: "/consumer/app/.northstar/runtime/watch.lock", pid: 123, heartbeatAgeSeconds: 900 },
    confirmed: false,
  });

  assert.equal(plan.metrics.skill_recover_detects_stale_lock, 1);
  assert.equal(plan.canMutate, false);
  assert.match(plan.commands[0].description, /stale watch lock/);
});

test("recover flow covers conflict, quarantine, stale branch, and projection failure options", async () => {
  const { recoverPlan } = await import(setupModule);
  const unconfirmed = recoverPlan({
    configPath: ".northstar.yaml",
    mergeConflict: { issue: 42, branch: "northstar/issue-42" },
    failedOrQuarantined: { issue: 43, state: "quarantined" },
    staleBranchPr: { issue: 44, branch: "northstar/issue-44", prUrl: "https://github.com/owner/app/pull/44" },
    projectionFailure: { issue: 45, message: "missing field" },
    confirmed: false,
  });
  const confirmed = recoverPlan({
    configPath: ".northstar.yaml",
    mergeConflict: { issue: 42, branch: "northstar/issue-42" },
    failedOrQuarantined: { issue: 43, state: "failed" },
    staleBranchPr: { issue: 44, branch: "northstar/issue-44", prUrl: "https://github.com/owner/app/pull/44" },
    projectionFailure: { issue: 45, message: "missing field" },
    confirmed: true,
  });

  assert.equal(unconfirmed.canMutate, false);
  assert.equal(confirmed.canMutate, true);
  assert.deepEqual(
    unconfirmed.commands.map((command) => command.kind),
    ["merge_conflict", "failed_or_quarantined", "stale_branch_pr", "projection_failure"],
  );
  assert.equal(unconfirmed.commands.every((command) => command.canMutate === false), true);
  assert.equal(confirmed.commands.every((command) => command.canMutate === true), true);
  assert.deepEqual(unconfirmed.commands.map((command) => command.argv.join(" ")), [
    "node --run northstar -- release --config .northstar.yaml --issue 42",
    "node --run northstar -- repair-runtime --config .northstar.yaml --issue 43",
    "node --run northstar -- reconcile --config .northstar.yaml --issue 44",
    "node --run northstar -- retry-sync --config .northstar.yaml --issue 45",
  ]);
  assert.equal(unconfirmed.metrics.skill_recover_options_defined, 4);
});
