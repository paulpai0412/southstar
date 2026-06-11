import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSoftwareDevAgentPrompt,
  buildSoftwareDevAgentTask,
  parseSoftwareDevAgentResult,
} from "../../src/orchestrator/software-dev-contract.ts";

test("builds implementation task envelope with agent-owned git boundary", () => {
  const task = buildSoftwareDevAgentTask({
    taskKind: "implementation",
    runId: "northstar-production",
    issueId: "github:123",
    stage: "implementation",
    attempt: 1,
    repo: {
      provider: "github",
      name: "owner/repo",
      url: "https://github.com/owner/repo",
      base_branch: "main",
    },
    workspace: {
      workspace_uri: "agent-owned://codex/northstar-production/issue-123-add-todo-filter",
      branch: "northstar/123",
      worktree_path_hint: ".northstar/runtime/worktrees/issue-123-add-todo-filter",
    },
    issue: {
      number: 123,
      title: "Add todo filter",
      body: "Acceptance criteria",
      url: "https://github.com/owner/repo/issues/123",
    },
    expectedArtifactKind: "implementation_result",
  });

  assert.equal(task.policy.git_is_agent_owned, true);
  assert.equal(task.policy.implementation_worker_must_create_worktree, true);
  assert.equal(task.policy.implementation_worker_must_create_branch, true);
  assert.equal(task.policy.implementation_worker_owns_commit_push_pr, true);
  assert.equal(task.policy.release_worker_owns_merge, true);
  assert.equal(task.policy.release_worker_owns_local_base_branch_sync, true);
  assert.equal(task.policy.release_worker_owns_worktree_cleanup, true);
  assert.equal(task.policy.northstar_will_not_run_git, true);
  assert.equal(task.workspace.branch, "northstar/123");
  assert.equal(task.expected_output.artifact_kind, "implementation_result");
});

test("release prompt requires release worker to sync local code and remove issue worktree", () => {
  const task = buildSoftwareDevAgentTask({
    taskKind: "release",
    runId: "northstar-production",
    issueId: "github:123",
    stage: "release",
    attempt: 1,
    repo: {
      provider: "github",
      name: "owner/repo",
      url: "https://github.com/owner/repo",
      base_branch: "main",
    },
    workspace: {
      workspace_uri: "agent-owned://codex/northstar-production/issue-123-add-todo-filter",
      branch: "northstar/123",
      worktree_path_hint: ".northstar/runtime/worktrees/issue-123-add-todo-filter",
    },
    issue: {
      number: 123,
      title: "Add todo filter",
      body: "Acceptance criteria",
      url: "https://github.com/owner/repo/issues/123",
    },
    expectedArtifactKind: "release_result",
  });

  const prompt = buildSoftwareDevAgentPrompt(task);

  assert.match(prompt, /release worker subagent owns release git operations/i);
  assert.match(prompt, /merging the pull request into task\.repo\.base_branch/i);
  assert.match(prompt, /syncing the local base branch to the remote base branch/i);
  assert.match(prompt, /removing the issue worktree/i);
  assert.match(prompt, /"release_worker_owns_local_base_branch_sync": true/);
  assert.match(prompt, /"release_worker_owns_worktree_cleanup": true/);
});

test("parses exact JSON agent result and rejects markdown", () => {
  const artifact = parseSoftwareDevAgentResult(
    JSON.stringify({
      schema_version: "1.0",
      artifact_kind: "verification_result",
      status: "failed_retryable",
      retryable: true,
      issue_number: 123,
      role: "verifier_agent",
      observed_at: "2026-06-03T12:30:00.000Z",
      summary: "Functional review failed.",
      review: {
        requirements_passed: false,
        code_review_passed: false,
        findings: [{ severity: "high", area: "functional", summary: "Completed filter still shows active todos." }],
      },
      failure_owner: "implementation",
      feedback_for_implementation: ["Fix completed filter."],
      next_action: "return_to_implementation",
    }),
    {
      expectedArtifactKind: "verification_result",
      issueNumber: 123,
      role: "verifier_agent",
    },
  );

  assert.equal(artifact.status, "failed_retryable");

  assert.throws(
    () => parseSoftwareDevAgentResult("```json\n{}\n```", {
      expectedArtifactKind: "verification_result",
      issueNumber: 123,
      role: "verifier_agent",
    }),
    /agent result must be exactly one JSON object/,
  );
});
