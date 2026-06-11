import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");

test("northstar skill source files and package scripts exist", async () => {
  const skill = await readFile(join(repoRoot, "skills/northstar/SKILL.md"), "utf8");
  const readme = await readFile(join(repoRoot, "skills/northstar/README.md"), "utf8");
  const configTemplate = await readFile(join(repoRoot, "skills/northstar/templates/northstar.yaml"), "utf8");
  const workflowTemplate = await readFile(join(repoRoot, "skills/northstar/templates/workflow.issue-to-pr-release.yaml"), "utf8");
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

  assert.match(skill, /Northstar Global Skill/);
  assert.match(skill, /setup this repo/i);
  assert.match(skill, /recover stuck issues/i);
  assert.match(readme, /npm run skill:sync/);
  assert.match(configTemplate, /__PROJECT_ROOT__/);
  assert.match(configTemplate, /auto_release: true/);
  assert.match(configTemplate, /project:\n    enabled: false/);
  assert.match(configTemplate, /path: \.northstar\/workflows\/issue-to-pr-release\.yaml/);
  assert.match(configTemplate, /version: "2\.0"/);
  assert.match(workflowTemplate, /issue_to_pr_release/);
  assert.match(workflowTemplate, /implementation_agent/);
  assert.match(workflowTemplate, /verification_result/);
  assert.match(workflowTemplate, /max_recovery_attempts_from: runtime.max_recovery_attempts/);
  assert.equal(pkg.scripts["skill:sync"], "node skills/northstar/scripts/sync-global.mjs");
  assert.equal(pkg.scripts["skill:doctor"], "node skills/northstar/scripts/doctor.mjs");
  assert.equal(pkg.scripts["skill:render-config"], "node skills/northstar/scripts/render-config.mjs");
});

test("northstar skill documents phase commands and aliases", async () => {
  const skill = await readFile(join(repoRoot, "skills/northstar/SKILL.md"), "utf8");

  for (const command of [
    "/northstar-plan",
    "/northstar-setup",
    "/northstar-execute",
    "/northstar-observe",
    "/northstar-recover",
    "/northstar-report",
    "/northstar-init",
    "/northstar-watch",
    "/northstar-status",
    "/northstar-recovery",
    "/northstar-grill",
    "/northstar-to-spec",
    "/northstar-to-plan",
    "/northstar-to-issues",
  ]) {
    assert.match(skill, new RegExp(command.replace("/", "\\/")));
  }

  assert.match(skill, /phase workflow first/i);
  assert.match(skill, /Guided auto/i);
  assert.match(skill, /aggressive recovery with guards/i);
  for (const command of ["plan-grill", "plan-spec", "plan-implementation", "plan-issues"]) {
    assert.match(skill, new RegExp(command));
  }

  for (const contract of [
    "northstar:planning-grill",
    "northstar:planning-spec",
    "northstar:implementation-planning",
    "northstar:issue-slicing",
  ]) {
    assert.match(skill, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(skill, /mattpocock:/);
  assert.doesNotMatch(skill, /superpowers:/);
});

test("northstar skill defines an interactive ask-question workflow from init to completion", async () => {
  const skill = await readFile(join(repoRoot, "skills/northstar/SKILL.md"), "utf8");

  assert.match(skill, /Interactive Ask-Question Workflow/);
  assert.match(skill, /Ask one short multiple-choice question at a time/);
  assert.match(skill, /wait for the user's answer before continuing/);
  assert.match(skill, /Do not perform file, GitHub, Project, issue, PR, or release mutations until the step explicitly reaches a confirmation gate/);

  for (const requiredStep of [
    "Step 1: Project Entry",
    "Step 2: Project Type",
    "Step 3: GitHub Repository",
    "Step 4: Project Viewer",
    "Step 5: Issue Source",
    "Step 6: Scheduling",
    "Step 7: Execution Mode",
    "Step 8: Monitoring",
    "Step 9: Recovery Policy",
    "Step 10: Completion Report",
  ]) {
    assert.match(skill, new RegExp(requiredStep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const requiredOption of [
    "A. Initialize a new consumer repo",
    "B. Check an existing repo",
    "C. Take over existing GitHub issues",
    "A. Create or update GitHub Project viewer",
    "B. Use an existing Project",
    "C. Disable Project viewer for now",
    "A. Single issue first",
    "B. Sequential dependency flow",
    "C. Parallel flow",
    "D. Mixed dependency graph",
    "A. Manual one-issue run",
    "B. Watch daemon auto-runs northstar:ready",
    "C. Dry-run only",
  ]) {
    assert.match(skill, new RegExp(requiredOption.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(skill, /Configuration Gate/);
  assert.match(skill, /GitHub Mutation Gate/);
  assert.match(skill, /Execution Gate/);
  assert.match(skill, /Recovery Gate/);
});

test("northstar skill requires Chrome automation when Project view APIs are unavailable", async () => {
  const skill = await readFile(join(repoRoot, "skills/northstar/SKILL.md"), "utf8");

  assert.match(skill, /Project view API is unavailable/);
  assert.match(skill, /use Chrome automation to operate the GitHub UI/);
  assert.match(skill, /Do not tell the user to create the views manually/);
  assert.match(skill, /Browser Verification Gate/);
  assert.match(skill, /Project viewer setup uses `Northstar Lifecycle`, `Status`, `PR URL`, `Merge SHA`, `Current Stage`, `Last Error`, `Retry Count`, and `Blocked By`/);
  assert.doesNotMatch(skill, /Northstar PR/);
  assert.doesNotMatch(skill, /Northstar Merge SHA/);

  for (const expectedView of [
    "Northstar Board: board layout grouped by Status",
    "Active Runs: table layout filtered to Status In Progress, In Review, Ready to Release, or Releasing",
    "Blocked Recovery: table layout filtered to Status Blocked or Failed",
    "Release Evidence: table layout showing Merge SHA and PR URL",
    "Completed: table layout filtered to Status Done",
  ]) {
    assert.match(skill, new RegExp(expectedView.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("northstar skill documents raw sqlite inspection without imagined history columns", async () => {
  const skill = await readFile(join(repoRoot, "skills/northstar/SKILL.md"), "utf8");

  assert.match(skill, /Raw SQLite Inspection/);
  assert.match(skill, /Prefer `inspect --summary`/);
  assert.match(skill, /`issue_history` columns are `id`, `issue_id`, `sequence`, `event_type`, `payload_json`, and `created_at`/);
  assert.match(skill, /`issues` uses `id` as the issue key/);
  assert.match(skill, /json_extract\(payload_json,'\$\.reason_code'\)/);
  assert.doesNotMatch(skill, /from_state/);
  assert.doesNotMatch(skill, /to_state/);
});
