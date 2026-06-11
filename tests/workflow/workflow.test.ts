import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflow, resolveWorkflowRoles } from "../../src/types/workflow.ts";
import { runWorkflowToIdle } from "../../src/runtime/engine.ts";
import { loadConfig } from "../../src/config/load-config.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const releaseWorkflowPath = join(repoRoot, "tests/fixtures/workflows/issue-to-pr-release.yaml");
const noReleaseWorkflowPath = join(repoRoot, "tests/fixtures/workflows/issue-to-done.yaml");
const configPath = join(repoRoot, "tests/fixtures/.northstar.yaml");

test("loads two workflow fixtures", () => {
  const release = loadWorkflow(releaseWorkflowPath);
  const noRelease = loadWorkflow(noReleaseWorkflowPath);

  assert.equal(release.id, "issue_to_pr_release");
  assert.equal(release.stages.implementation.role, "implementation_agent");
  assert.equal(release.roles.implementation_agent.artifact, "implementation_result");
  assert.equal(release.exception_policy?.default.action.type, "quarantine");
  assert.equal(noRelease.id, "issue_to_done");
  assert.equal(noRelease.stages.acceptance.on_pass, "completed");
});

test("engine executes workflows without hard-coded release-chain logic", () => {
  const release = loadWorkflow(releaseWorkflowPath);
  const noRelease = loadWorkflow(noReleaseWorkflowPath);

  assert.equal(runWorkflowToIdle(release).lifecycle_state, "verified");
  assert.equal(runWorkflowToIdle(noRelease).lifecycle_state, "completed");
});

test("role overrides cover agent, model, skills, run mode, timeout, and retry policy", () => {
  const workflow = loadWorkflow(releaseWorkflowPath);
  const config = loadConfig(configPath);
  const roles = resolveWorkflowRoles(workflow, config.workflowOverrides);

  assert.equal(roles.implementation_agent.agent, "codex-gpt-5.3");
  assert.equal(roles.implementation_agent.model, "gpt-5.3");
  assert.deepEqual(roles.implementation_agent.load_skills, ["tdd", "playwright"]);
  assert.equal(roles.implementation_agent.run_mode, "background_child");
  assert.equal(roles.implementation_agent.timeout_seconds, 3600);
  assert.deepEqual(roles.implementation_agent.retry_policy, {
    max_attempts: 2,
    backoff_seconds: [15, 60],
  });
});

test("workflow roles preserve typed prompt templates", () => {
  const workflow = loadWorkflow(releaseWorkflowPath);

  assert.match(workflow.roles.implementation_agent.prompt_template ?? "", /{{issue_title}}/);
});
