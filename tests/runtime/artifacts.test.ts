import test from "node:test";
import assert from "node:assert/strict";
import {
  validateArtifactPayload,
  ArtifactValidationError,
  artifactRejectionHistory,
} from "../../src/runtime/artifacts.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflow } from "../../src/types/workflow.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");

const common = {
  schema_version: "1.0",
  issue_number: 35,
  role: "issue_worker",
  status: "success",
  observed_at: "2026-05-29T04:00:00.000Z",
  summary: "done",
  retryable: false,
};

test("worker_result success requires branch metadata and compact changed files", () => {
  const artifact = validateArtifactPayload({
    ...common,
    artifact_kind: "worker_result",
    branch: "northstar/issue-35",
    base_branch: "main",
    commit_sha: "abc123",
    changed_files: ["src/runtime/artifacts.ts"],
    commands_run: [{ command: "npm test", status: "passed" }],
    test_summary: { passed: 18, failed: 0 },
    self_check_summary: "npm test passed",
  });

  assert.equal(artifact.artifact_kind, "worker_result");
  assert.equal(artifact.status, "success");
});

test("worker_result accepts structured command summaries and rejects secret-shaped values", () => {
  const artifact = validateArtifactPayload({
    ...common,
    artifact_kind: "worker_result",
    branch: "northstar/issue-35",
    base_branch: "main",
    commit_sha: "abc123",
    changed_files: ["src/App.tsx"],
    commands_run: [{ command: "npm test", status: "passed" }],
    test_summary: { passed: 18, failed: 0 },
    risks: [],
    next_action: "ready_for_verification",
    recovery_hint: null,
    self_check_summary: "npm test passed",
  });

  assert.equal((artifact.payload.commands_run as Array<{ status: string }>)[0].status, "passed");

  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "worker_result",
    branch: "b",
    base_branch: "main",
    commit_sha: "c",
    changed_files: ["src/App.tsx"],
    commands_run: [{ command: "npm test", status: "passed", output: "github_pat_abc12345678901234567890" }],
    test_summary: { passed: 1, failed: 0 },
    risks: [],
    next_action: "ready_for_verification",
    recovery_hint: null,
    self_check_summary: "ok",
  }), /ARTIFACT_SECRET_VALUE/);
});

test("worker_result success rejects missing structured command summaries", () => {
  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "worker_result",
    branch: "northstar/issue-35",
    base_branch: "main",
    commit_sha: "abc123",
    changed_files: ["src/App.tsx"],
    self_check_summary: "npm test passed",
  }), /ARTIFACT_MISSING_FIELD at commands_run/);

  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "worker_result",
    summary: "worker completed",
    branch: "northstar/issue-35",
    base_branch: "main",
    commit_sha: "abc123",
    changed_files: ["src/App.tsx"],
    self_check_summary: "orchestrator worker artifact",
  }), /ARTIFACT_MISSING_FIELD at commands_run/);
});

test("artifact validation rejects nested sk-style secret values", () => {
  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "worker_result",
    branch: "northstar/issue-35",
    base_branch: "main",
    commit_sha: "abc123",
    changed_files: ["src/App.tsx"],
    commands_run: [{ command: "npm test", status: "passed", output: "sk-abcdefghijklmnopqrstuvwxyz123456" }],
    test_summary: { passed: 1, failed: 0 },
    self_check_summary: "ok",
  }), /ARTIFACT_SECRET_VALUE/);
});

test("evidence_packet pass requires PR gate metadata", () => {
  const artifact = validateArtifactPayload({
    ...common,
    artifact_kind: "evidence_packet",
    role: "pr_verifier",
    status: "pass",
    pr_number: 42,
    base_branch: "main",
    gate_results: [{ name: "npm test", status: "pass" }],
    verifier: { session_id: "verifier-1" },
  });

  assert.equal(artifact.artifact_kind, "evidence_packet");

  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "evidence_packet",
    role: "pr_verifier",
    status: "pass",
    summary: "verification passed",
    pr_number: 42,
    base_branch: "main",
    gate_results: [{ name: "npm test", status: "pass" }],
  }), /ARTIFACT_MISSING_FIELD at verifier/);
});

test("evidence_packet requires browser evidence when browser acceptance is required", () => {
  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "evidence_packet",
    role: "pr_verifier",
    status: "pass",
    pr_number: 42,
    base_branch: "main",
    gate_results: [{ name: "npm test", status: "pass" }],
    verifier: { session_id: "verifier-1" },
    browser_required: true,
  }), /ARTIFACT_BROWSER_EVIDENCE_REQUIRED/);

  const artifact = validateArtifactPayload({
    ...common,
    artifact_kind: "evidence_packet",
    role: "pr_verifier",
    status: "pass",
    pr_number: 42,
    base_branch: "main",
    gate_results: [{ name: "npm test", status: "pass" }],
    verifier: { session_id: "verifier-1" },
    browser_required: true,
    browser_evidence: { ran: true, tests_passed: 12, screenshots: ["evidence/mobile.png"] },
  });

  assert.equal((artifact.payload.browser_evidence as { tests_passed: number }).tests_passed, 12);
});

test("release_result success requires merge confirmation fields", () => {
  const artifact = validateArtifactPayload({
    ...common,
    artifact_kind: "release_result",
    role: "release_worker",
    pr_number: 42,
    merge_status: "merged",
    merged_sha: "def456",
    local_sync_result: { status: "success" },
    cleanup_result: { status: "success" },
  });

  assert.equal(artifact.artifact_kind, "release_result");
});

test("implementation_result ready_for_verification requires PR and command evidence", () => {
  const artifact = validateArtifactPayload({
    schema_version: "1.0",
    artifact_kind: "implementation_result",
    status: "ready_for_verification",
    retryable: false,
    issue_number: 123,
    role: "implementation_agent",
    observed_at: "2026-06-03T12:00:00.000Z",
    summary: "Implemented todo filtering and opened PR #456.",
    pr: {
      url: "https://github.com/owner/repo/pull/456",
      number: 456,
      head_ref: "northstar/issue-123-todo-filter",
      head_sha: "abc123",
    },
    changed_files: ["app.js", "tests/todo-filter.test.js"],
    commands_run: [{ command: "npm test", status: "passed", summary: "12 tests passed." }],
    self_check_summary: "All issue requirements implemented and locally tested.",
    evidence: [{ type: "pull_request", url: "https://github.com/owner/repo/pull/456" }],
    workspace_evidence: {
      path_checked: ".northstar/runtime/worktrees/issue-123-todo-filter",
      base_source: "origin/main",
      base_commit: "base123",
      expected_branch: "northstar/issue-123-todo-filter",
      observed_branch: "northstar/issue-123-todo-filter",
      expected_head_sha: "abc123",
      observed_head_sha: "abc123",
      matches_expected: true,
    },
    next_action: "verify",
  });

  assert.equal(artifact.artifact_kind, "implementation_result");
  assert.equal(artifact.status, "ready_for_verification");
});

test("implementation_result ready_for_verification requires matching workspace evidence", () => {
  assert.throws(() => validateArtifactPayload({
    schema_version: "1.0",
    artifact_kind: "implementation_result",
    status: "ready_for_verification",
    retryable: false,
    issue_number: 123,
    role: "implementation_agent",
    observed_at: "2026-06-03T12:00:00.000Z",
    summary: "Implemented todo filtering and opened PR #456.",
    pr: {
      url: "https://github.com/owner/repo/pull/456",
      number: 456,
      head_ref: "northstar/issue-123-todo-filter",
      head_sha: "abc123",
    },
    changed_files: ["app.js"],
    commands_run: [{ command: "npm test", status: "passed" }],
    self_check_summary: "All issue requirements implemented and locally tested.",
    evidence: [{ type: "pull_request", url: "https://github.com/owner/repo/pull/456" }],
  }), /ARTIFACT_MISSING_FIELD at workspace_evidence/);

  assert.throws(() => validateArtifactPayload({
    schema_version: "1.0",
    artifact_kind: "implementation_result",
    status: "ready_for_verification",
    retryable: false,
    issue_number: 123,
    role: "implementation_agent",
    observed_at: "2026-06-03T12:00:00.000Z",
    summary: "Implemented todo filtering and opened PR #456.",
    pr: {
      url: "https://github.com/owner/repo/pull/456",
      number: 456,
      head_ref: "northstar/issue-123-todo-filter",
      head_sha: "abc123",
    },
    changed_files: ["app.js"],
    commands_run: [{ command: "npm test", status: "passed" }],
    self_check_summary: "All issue requirements implemented and locally tested.",
    evidence: [{ type: "pull_request", url: "https://github.com/owner/repo/pull/456" }],
    workspace_evidence: {
      path_checked: ".northstar/runtime/worktrees/issue-123-todo-filter",
      base_source: "origin/main",
      base_commit: "base123",
      expected_branch: "northstar/issue-123-todo-filter",
      observed_branch: "main",
      expected_head_sha: "abc123",
      observed_head_sha: "base123",
      matches_expected: false,
    },
  }), /ARTIFACT_FIELD_TYPE at workspace_evidence.matches_expected/);
});

test("release_result completed requires confirmed release and issue update", () => {
  const artifact = validateArtifactPayload({
    schema_version: "1.0",
    artifact_kind: "release_result",
    status: "completed",
    retryable: false,
    issue_number: 123,
    role: "release_agent",
    observed_at: "2026-06-03T13:00:00.000Z",
    summary: "PR #456 was merged successfully.",
    pr: { url: "https://github.com/owner/repo/pull/456", number: 456 },
    release: {
      confirmed: true,
      type: "github_pr_merge",
      merge_commit: "def456",
      released_at: "2026-06-03T13:00:00.000Z",
      local_sync: {
        base_branch: "main",
        synced: true,
        local_head: "def456",
        remote_head: "def456",
        matches_remote: true,
      },
      repo_root_sync: {
        status: "skipped",
        reason: "repo_root_dirty",
      },
      worktree_cleanup: {
        path: ".northstar/runtime/worktrees/issue-123-add-todo-filter",
        removed: true,
      },
    },
    evidence: [
      { type: "merge_commit", value: "def456" },
      { type: "local_remote_sync", value: "main at def456" },
      { type: "worktree_cleanup", value: "removed .northstar/runtime/worktrees/issue-123-add-todo-filter" },
    ],
    issue_update: {
      comment_summary: "Released via PR #456.",
      close_issue: true,
      labels_to_add: ["northstar:released"],
      labels_to_remove: ["northstar:ready"],
    },
  });

  assert.equal(artifact.artifact_kind, "release_result");
  assert.equal(artifact.status, "completed");
});

test("release_result completed requires local sync and worktree cleanup evidence", () => {
  const completedRelease = {
    schema_version: "1.0",
    artifact_kind: "release_result",
    status: "completed",
    retryable: false,
    issue_number: 123,
    role: "release_agent",
    observed_at: "2026-06-03T13:00:00.000Z",
    summary: "PR #456 was merged successfully.",
    release: {
      confirmed: true,
      merge_commit: "def456",
      local_sync: {
        base_branch: "main",
        synced: true,
        local_head: "def456",
        remote_head: "def456",
        matches_remote: true,
      },
      repo_root_sync: {
        status: "skipped",
        reason: "repo_root_dirty",
      },
      worktree_cleanup: {
        path: ".northstar/runtime/worktrees/issue-123-add-todo-filter",
        removed: true,
      },
    },
    evidence: [
      { type: "merge_commit", value: "def456" },
      { type: "local_remote_sync", value: "main at def456" },
      { type: "worktree_cleanup", value: "removed .northstar/runtime/worktrees/issue-123-add-todo-filter" },
    ],
    issue_update: {
      comment_summary: "Released via PR #456.",
    },
  };

  assert.throws(
    () => validateArtifactPayload({
      ...completedRelease,
      release: {
        confirmed: true,
        merge_commit: "def456",
        worktree_cleanup: completedRelease.release.worktree_cleanup,
        repo_root_sync: completedRelease.release.repo_root_sync,
      },
    }),
    /ARTIFACT_MISSING_FIELD at release.local_sync/,
  );

  assert.throws(
    () => validateArtifactPayload({
      ...completedRelease,
      release: {
        ...completedRelease.release,
        local_sync: {
          ...completedRelease.release.local_sync,
          matches_remote: false,
        },
      },
    }),
    /ARTIFACT_MERGE_NOT_CONFIRMED at release.local_sync.matches_remote/,
  );

  assert.throws(
    () => validateArtifactPayload({
      ...completedRelease,
      release: {
        confirmed: true,
        merge_commit: "def456",
        local_sync: completedRelease.release.local_sync,
        repo_root_sync: completedRelease.release.repo_root_sync,
      },
    }),
    /ARTIFACT_MISSING_FIELD at release.worktree_cleanup/,
  );

  assert.throws(
    () => validateArtifactPayload({
      ...completedRelease,
      release: {
        ...completedRelease.release,
        worktree_cleanup: {
          ...completedRelease.release.worktree_cleanup,
          removed: false,
        },
      },
    }),
    /ARTIFACT_MERGE_NOT_CONFIRMED at release.worktree_cleanup.removed/,
  );
});

test("artifact validators reject invalid payloads with stable codes", () => {
  const invalidCases = [
    [{ ...common, artifact_kind: "worker_result" }, "ARTIFACT_MISSING_FIELD"],
    [{ ...common, artifact_kind: "evidence_packet", status: "pass" }, "ARTIFACT_MISSING_FIELD"],
    [{ ...common, artifact_kind: "release_result", merge_status: "merged" }, "ARTIFACT_MISSING_FIELD"],
    [{ ...common, artifact_kind: "unknown" }, "ARTIFACT_UNKNOWN_KIND"],
    [{ ...common, artifact_kind: "worker_result", status: "success", branch: "b", base_branch: "main", commit_sha: "c", changed_files: "src/a.ts", self_check_summary: "ok" }, "ARTIFACT_FIELD_TYPE"],
    [{ ...common, artifact_kind: "worker_result", status: "success", branch: "b", base_branch: "main", commit_sha: "c", changed_files: ["src/a.ts"], self_check_summary: "ok", raw_transcript: "secret" }, "ARTIFACT_RAW_LOG_REJECTED"],
    [{ ...common, artifact_kind: "worker_result", status: "blocked", retryable: false }, "ARTIFACT_RETRYABLE_MISMATCH"],
    [{ ...common, artifact_kind: "release_result", status: "success", pr_number: 42, merge_status: "open", merged_sha: "sha" }, "ARTIFACT_MERGE_NOT_CONFIRMED"],
    [{ ...common, artifact_kind: "worker_result", summary: "x".repeat(5001) }, "ARTIFACT_FIELD_TOO_LARGE"],
    [{ ...common, artifact_kind: "worker_result", issue_number: "35" }, "ARTIFACT_FIELD_TYPE"],
    [{ ...common, artifact_kind: "worker_result", observed_at: "not-a-date" }, "ARTIFACT_FIELD_TYPE"],
    [{ ...common, artifact_kind: "worker_result", retryable: "no" }, "ARTIFACT_FIELD_TYPE"],
  ] as const;

  assert.equal(invalidCases.length, 12);
  for (const [payload, code] of invalidCases) {
    assert.throws(
      () => validateArtifactPayload(payload),
      (error) => {
        assert.ok(error instanceof ArtifactValidationError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});

test("artifact validators enforce verification recommendation, release confirmation, and string arrays", () => {
  assert.throws(
    () => validateArtifactPayload({
      ...common,
      artifact_kind: "verification_result",
      status: "pass",
      role: "verifier_agent",
      review: { requirements_passed: true, code_review_passed: true },
      functional_review: { required: false, status: "pass" },
      browser_evidence: { required: false, ran: true, tests_passed: 1 },
      workspace_evidence: {
        path_checked: ".northstar/runtime/worktrees/issue-123",
        expected_branch: "northstar/123",
        observed_branch: "northstar/123",
        expected_head_sha: "abc123",
        observed_head_sha: "abc123",
        matches_expected: true,
      },
      release_recommendation: "blocked",
    }),
    /ARTIFACT_FIELD_TYPE at release_recommendation/,
  );

  assert.throws(
    () => validateArtifactPayload({
      schema_version: "1.0",
      artifact_kind: "release_result",
      status: "completed",
      retryable: false,
      issue_number: 123,
      role: "release_agent",
      observed_at: "2026-06-03T13:00:00.000Z",
      summary: "Release attempted.",
      release: {
        confirmed: false,
        merge_commit: "def456",
        local_sync: {
          base_branch: "main",
          synced: true,
          local_head: "def456",
          remote_head: "def456",
          matches_remote: true,
        },
        repo_root_sync: {
          status: "skipped",
          reason: "repo_root_dirty",
        },
        worktree_cleanup: {
          path: ".northstar/runtime/worktrees/issue-123-add-todo-filter",
          removed: true,
        },
      },
      evidence: [{ type: "merge_commit", value: "def456" }],
      issue_update: { comment_summary: "Release blocked" },
    }),
    /ARTIFACT_MERGE_NOT_CONFIRMED at release.confirmed/,
  );

  assert.throws(
    () => validateArtifactPayload({
      ...common,
      artifact_kind: "worker_result",
      status: "success",
      branch: "northstar/issue-7",
      base_branch: "main",
      commit_sha: "abc123",
      changed_files: ["src/app.ts", 42],
      commands_run: [{ command: "npm test", status: "passed" }],
      test_summary: { passed: 1 },
      self_check_summary: "ok",
    }),
    /ARTIFACT_FIELD_TYPE at changed_files/,
  );
});

test("verification_result pass requires matching workspace evidence and screenshot-backed browser evidence", () => {
  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "verification_result",
    status: "pass",
    role: "verifier_agent",
    review: { requirements_passed: true, code_review_passed: true },
    functional_review: { required: true, status: "pass" },
    browser_evidence: { required: true, ran: true, tests_passed: 1, screenshots: [] },
    workspace_evidence: {
      path_checked: ".northstar/runtime/worktrees/issue-123",
      expected_branch: "northstar/123",
      observed_branch: "northstar/123",
      expected_head_sha: "abc123",
      observed_head_sha: "abc123",
      matches_expected: true,
    },
    release_recommendation: "ready_for_release",
  }), /ARTIFACT_BROWSER_EVIDENCE_REQUIRED at browser_evidence.screenshots/);

  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "verification_result",
    status: "pass",
    role: "verifier_agent",
    review: { requirements_passed: true, code_review_passed: true },
    functional_review: { required: false, status: "pass" },
    browser_evidence: { required: false, ran: true, tests_passed: 1 },
    workspace_evidence: {
      path_checked: ".northstar/runtime/worktrees/issue-123",
      expected_branch: "northstar/123",
      observed_branch: "main",
      expected_head_sha: "abc123",
      observed_head_sha: "base123",
      matches_expected: false,
    },
    release_recommendation: "ready_for_release",
  }), /ARTIFACT_FIELD_TYPE at workspace_evidence.matches_expected/);
});

test("verification_result failed_retryable requires owner-specific actionable feedback", () => {
  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "verification_result",
    status: "failed_retryable",
    retryable: true,
    role: "verifier_agent",
    review: {
      requirements_passed: false,
      code_review_passed: false,
      findings: [{ severity: "high", area: "build", summary: "npm run build failed" }],
    },
  }), /ARTIFACT_MISSING_FIELD at failure_owner/);

  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "verification_result",
    status: "failed_retryable",
    retryable: true,
    role: "verifier_agent",
    review: {
      requirements_passed: false,
      code_review_passed: false,
      findings: [{ severity: "high", area: "build", summary: "npm run build failed" }],
    },
    failure_owner: "implementation",
  }), /ARTIFACT_MISSING_FIELD at feedback_for_implementation/);

  const implementationArtifact = validateArtifactPayload({
    ...common,
    artifact_kind: "verification_result",
    status: "failed_retryable",
    retryable: true,
    role: "verifier_agent",
    review: {
      requirements_passed: false,
      code_review_passed: false,
      findings: [{ severity: "high", area: "build", summary: "npm run build failed" }],
    },
    failure_owner: "implementation",
    feedback_for_implementation: ["Fix npm run build failure before requesting verification again."],
    browser_evidence: { required: true, ran: false, tests_passed: 0 },
    release_recommendation: "not_ready_for_release",
  });

  assert.equal(implementationArtifact.status, "failed_retryable");

  const releaseArtifact = validateArtifactPayload({
    ...common,
    artifact_kind: "verification_result",
    status: "failed_retryable",
    retryable: true,
    role: "verifier_agent",
    summary: "PR branch is behind main and GitHub reports mergeable=false.",
    review: {
      requirements_passed: true,
      code_review_passed: true,
    },
    functional_review: { required: true, status: "pass" },
    failure_owner: "release",
    feedback_for_release: ["Update the PR branch onto current main so GitHub reports it mergeable."],
    browser_evidence: { required: true, ran: true, tests_passed: 1, screenshots: ["evidence/browser.png"] },
    workspace_evidence: {
      path_checked: ".northstar/runtime/worktrees/issue-123",
      expected_branch: "northstar/123",
      observed_branch: "northstar/123",
      expected_head_sha: "abc123",
      observed_head_sha: "abc123",
      matches_expected: true,
    },
    release_recommendation: "not_ready_for_release",
  });

  assert.equal(releaseArtifact.status, "failed_retryable");
});

test("artifact rejection history is compact and auditable", () => {
  const history = artifactRejectionHistory("issue-35", {
    artifact_kind: "worker_result",
    role: "issue_worker",
    reason: "ARTIFACT_MISSING_FIELD",
    path: "branch",
  });

  assert.equal(history.event_type, "artifact_rejected");
  assert.equal(history.payload.reason, "ARTIFACT_MISSING_FIELD");
  assert.equal(history.payload.artifact_kind, "worker_result");
});

test("workflow-defined artifacts validate required custom fields", () => {
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/content-creation-publish.yaml"));

  const artifact = validateArtifactPayload({
    schema_version: "1.0",
    artifact_kind: "draft_article",
    issue_number: 1001,
    role: "writer",
    status: "success",
    observed_at: "2026-05-29T03:00:00.000Z",
    summary: "Draft complete",
    retryable: false,
    title: "Offline E2E",
    body_text: "A concise draft body",
  }, workflow);

  assert.equal(artifact.artifact_kind, "draft_article");
  assert.equal(artifact.payload.title, "Offline E2E");
});

test("workflow-defined artifacts reject missing required custom fields", () => {
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/office-report-delivery.yaml"));

  assert.throws(() => validateArtifactPayload({
    schema_version: "1.0",
    artifact_kind: "email_delivery_result",
    issue_number: 1002,
    role: "mailer",
    status: "success",
    observed_at: "2026-05-29T03:00:00.000Z",
    summary: "Email sent",
    retryable: false,
    recipient_count: 3,
  }, workflow), /ARTIFACT_MISSING_FIELD at confirmed_delivery/);
});
