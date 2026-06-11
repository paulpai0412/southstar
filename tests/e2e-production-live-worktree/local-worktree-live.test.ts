import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatLiveLocalWorktreeSummary, runLiveLocalWorktreeE2E } from "./harness.ts";

test("production live local worktree E2E clear-skips without live flag", (t) => {
  if (process.env.NORTHSTAR_PRODUCTION_LIVE_WORKTREE !== "1") {
    t.skip("Set NORTHSTAR_PRODUCTION_LIVE_WORKTREE=1 to run production live local worktree E2E.");
    return;
  }

  assert.ok(process.env.GITHUB_TOKEN, "GITHUB_TOKEN is required");
  assert.ok(process.env.NORTHSTAR_LIVE_GITHUB_REPO, "NORTHSTAR_LIVE_GITHUB_REPO is required");
});

test("production live local worktree harness does not import fixture gateway shortcuts", async () => {
  const source = await readFile(new URL("./harness.ts", import.meta.url), "utf8");
  const forbidden = new RegExp(["ProductionLiveGitHubGateway", "createFixture", "Branch\\("].join("|"));

  assert.doesNotMatch(source, forbidden);
});

test("production live local worktree E2E uses production CLI default factory", async (t) => {
  if (process.env.NORTHSTAR_PRODUCTION_LIVE_WORKTREE !== "1") {
    t.skip("Set NORTHSTAR_PRODUCTION_LIVE_WORKTREE=1 to run production live local worktree E2E.");
    return;
  }

  const missing = ["GITHUB_TOKEN", "NORTHSTAR_LIVE_GITHUB_REPO"].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing production live local worktree E2E configuration: ${missing.join(", ")}`);
  }

  const result = await runLiveLocalWorktreeE2E({
    repo: process.env.NORTHSTAR_LIVE_GITHUB_REPO!,
    token: process.env.GITHUB_TOKEN!,
  });
  t.diagnostic(formatLiveLocalWorktreeSummary(result.metrics));
  t.diagnostic(`issue=${result.issueUrl}`);
  t.diagnostic(`pr=${result.prUrl}`);
  t.diagnostic(`merge_sha=${result.mergeSha}`);

  assert.equal(result.metrics.live_worktree_issues_created >= 1, true);
  assert.equal(result.metrics.live_worktrees_created >= 1, true);
  assert.equal(result.metrics.live_worktree_paths_under_consumer_root, 1);
  assert.equal(result.metrics.live_sdk_working_directory_is_worktree, 1);
  assert.equal(result.metrics.live_sdk_modified_worktree_files >= 1, true);
  assert.equal(result.metrics.live_git_add_commands >= 1, true);
  assert.equal(result.metrics.live_git_commit_commands >= 1, true);
  assert.equal(result.metrics.live_git_push_commands >= 1, true);
  assert.equal(result.metrics.live_branches_pushed >= 1, true);
  assert.equal(result.metrics.live_prs_created_or_reused >= 1, true);
  assert.equal(result.metrics.live_prs_merged >= 1, true);
  assert.equal(result.metrics.live_confirmed_merge_facts >= 1, true);
  assert.equal(result.metrics.live_runtime_completed >= 1, true);
  assert.equal(result.metrics.live_github_issues_closed >= 1, true);
  assert.equal(result.metrics.live_resume_reuses_existing_worktree, 1);
  assert.equal(result.metrics.live_resume_reuses_existing_branch, 1);
  assert.equal(result.metrics.live_resume_reuses_existing_pr, 1);
  assert.equal(result.metrics.live_duplicate_prs_created, 0);
  assert.equal(result.metrics.live_completed_reversals, 0);
  assert.equal(result.metrics.live_fixture_gateway_shortcuts_used, 0);
  assert.equal(result.metrics.live_shell_chain_commands, 0);
  assert.equal(result.metrics.live_secret_leaks, 0);
});
