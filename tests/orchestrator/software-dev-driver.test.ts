import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSoftwareDevPrompt,
  createSoftwareDevCommandPlan,
  QueuedHostSessionBridge,
  SoftwareDevDomainDriver,
  validateWorkerOutput,
} from "../../src/orchestrator/software-dev-driver.ts";
import type { DomainDriverContext } from "../../src/orchestrator/domain-driver.ts";

const IMPLEMENTATION_ARTIFACT = {
  schema_version: "1.0",
  artifact_kind: "implementation_result",
  status: "ready_for_verification",
  retryable: false,
  issue_number: 7,
  role: "implementation_agent",
  observed_at: "2026-06-03T00:00:00.000Z",
  summary: "implementation complete",
  pr: {
    url: "https://github.test/pull/17",
    number: 17,
    head_ref: "northstar/issue-7-template-issue",
    head_sha: "head-sha-17",
  },
  changed_files: ["src/example.ts"],
  commands_run: [{ command: "npm test", status: "passed" }],
  self_check_summary: "implementation verified",
  evidence: [{ type: "test", value: "npm test" }],
  workspace_evidence: {
    path_checked: ".northstar/runtime/worktrees/issue-7-template-issue",
    base_source: "origin/main",
    base_commit: "base-sha-17",
    expected_branch: "northstar/issue-7-template-issue",
    observed_branch: "northstar/issue-7-template-issue",
    expected_head_sha: "head-sha-17",
    observed_head_sha: "head-sha-17",
    matches_expected: true,
  },
};

function verificationArtifact(input: {
  role: string;
  browserRequired?: boolean;
  browserRan?: boolean;
  browserTestsPassed?: number;
}) {
  return {
    schema_version: "1.0",
    artifact_kind: "verification_result",
    status: "pass",
    retryable: false,
    issue_number: 7,
    role: input.role,
    observed_at: "2026-06-03T00:00:00.000Z",
    summary: "verification passed",
    review: { requirements_passed: true, code_review_passed: true },
    functional_review: { required: false, status: "pass" },
    browser_evidence: {
      required: input.browserRequired ?? false,
      ran: input.browserRan ?? true,
      tests_passed: input.browserTestsPassed ?? 1,
      screenshots: ["evidence/browser.png"],
    },
    workspace_evidence: {
      path_checked: ".northstar/runtime/worktrees/issue-7-template-issue",
      expected_branch: "northstar/issue-7-template-issue",
      observed_branch: "northstar/issue-7-template-issue",
      expected_head_sha: "head-sha-17",
      observed_head_sha: "head-sha-17",
      matches_expected: true,
    },
    release_recommendation: "ready_for_release",
  };
}

const RELEASE_ARTIFACT = {
  schema_version: "1.0",
  artifact_kind: "release_result",
  status: "completed",
  retryable: false,
  issue_number: 7,
  role: "release_agent",
  observed_at: "2026-06-03T00:00:00.000Z",
  summary: "release completed",
  release: {
    confirmed: true,
    merge_commit: "merge-sha-17",
    local_sync: {
      base_branch: "main",
      synced: true,
      local_head: "merge-sha-17",
      remote_head: "merge-sha-17",
      matches_remote: true,
    },
    repo_root_sync: {
      status: "skipped",
      reason: "repo_root_dirty",
    },
    worktree_cleanup: {
      path: ".northstar/runtime/worktrees/issue-7-template-issue",
      removed: true,
    },
  },
  issue_update: {
    comment_summary: "Released in PR #17",
    close_issue: true,
    labels_to_add: ["northstar:released"],
    labels_to_remove: ["northstar:ready"],
  },
  evidence: [
    { type: "merge_commit", value: "merge-sha-17" },
    { type: "local_remote_sync", value: "main at merge-sha-17" },
    { type: "worktree_cleanup", value: "removed .northstar/runtime/worktrees/issue-7-template-issue" },
  ],
};

test("software-dev prompt uses workflow template and issue/worktree context", () => {
  const prompt = buildSoftwareDevPrompt({
    context: domainContext({
      prompt_template: "Implement {{issue_title}} at {{worktree_path}} on {{branch}} with {{expected_artifact_fields}}",
    }),
    worktreePath: "/tmp/northstar/worktrees/issue-7",
    branch: "northstar/7-template",
    expectedArtifactFields: ["branch", "commit_sha", "changed_files"],
  });

  assert.match(prompt, /Implement Template issue/);
  assert.match(prompt, /\/tmp\/northstar\/worktrees\/issue-7/);
  assert.match(prompt, /northstar\/7-template/);
  assert.match(prompt, /branch, commit_sha, changed_files/);
});

test("software-dev prompt has deterministic default when template is omitted", () => {
  const prompt = buildSoftwareDevPrompt({
    context: domainContext({}),
    worktreePath: "/tmp/northstar/worktrees/issue-7",
    branch: "northstar/7-default",
    expectedArtifactFields: ["branch", "commit_sha"],
  });

  assert.match(prompt, /Issue title: Template issue/);
  assert.match(prompt, /Stage: implementation/);
  assert.match(prompt, /Role: implementation_agent/);
});

test("queued host bridge planned ids include run issue stage and unique nonce", () => {
  const bridge = new QueuedHostSessionBridge({
    runId: "northstar-production",
    idGenerator: () => "nonce-1",
  });
  const role = {
    agent: "codex",
    load_skills: [],
  };

  const root = bridge.startRootSession({
    issue_id: "github:1",
    role_name: "implementation_agent",
    role,
  });
  const child = bridge.startBackgroundChild({
    issue_id: "github:1",
    lease_id: "lease-implementation-github:1",
    root_session_id: root.root_session_id,
    role_name: "implementation_agent",
    role,
  });

  assert.equal(root.root_session_id, "planned-root:northstar-production:github-1:implementation-agent:nonce-1");
  assert.equal(child.child_run_id, "planned-child:northstar-production:github-1:implementation-agent:nonce-1");
  assert.equal(child.session_id, root.root_session_id);
  assert.equal(bridge.readRootStatus(root.root_session_id).status, "live");
  assert.equal(bridge.readChildStatus(child.child_run_id).status, "queued");
});

test("software-dev prepareStage reuses durable runtime worktree and branch on resumed issues", async () => {
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-resume",
    github: new ThrowingDeliveryGitHub(),
    worker: new RecordingWorker(),
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
  });

  const prepared = await driver.prepareStage(domainContext({
    runtimeContext: {
      worktree_path: "agent-owned://codex/northstar-resume/issue-7-original",
      branch: "northstar/7-original",
    },
  }));

  assert.equal(prepared.worktreePath, "agent-owned://codex/northstar-resume/issue-7-original");
  assert.equal(prepared.branch, "northstar/7-original");
});

test("software-dev verifier recovery prompt includes prior rejection reason and PR metadata", async () => {
  const worker = new RecordingWorker();
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-verifier-retry",
    github: new ThrowingDeliveryGitHub(),
    worker,
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
  });

  await driver.recoverVerifierArtifact({
    ...domainContext({
      roleName: "verifier_agent",
      stageName: "verification",
      runtimeContext: {
        last_error: "ARTIFACT_MISSING_FIELD at artifact_kind",
        retry_count: 1,
      },
    }),
    pullRequest: {
      prNumber: 41,
      prUrl: "https://github.test/pull/41",
      branch: "northstar/issue-39-browser-evidence",
      commitSha: "head-sha-41",
    },
  });

  assert.match(worker.verificationPrompt, /Retry\/recovery context:/);
  assert.match(worker.verificationPrompt, /Existing PR: #41 https:\/\/github\.test\/pull\/41/);
  assert.match(worker.verificationPrompt, /Canonical verification_result JSON example:/);
  assert.match(worker.verificationPrompt, /Return a schema-valid verification_result artifact/);
  assert.match(worker.verificationPrompt, /failure_owner/);
  assert.match(worker.verificationPrompt, /feedback_for_release/);
  assert.match(worker.verificationPrompt, /PR mergeability, branch drift, GitHub merge status, or release readiness/i);
});

test("software-dev implementation retry prompt includes prior artifact rejection", async () => {
  const worker = new RecordingWorker();
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-implementation-retry",
    github: new ThrowingDeliveryGitHub(),
    worker,
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
  });

  await driver.prepareStage(domainContext({}));
  await driver.finalizeWorkerArtifact({
    ...domainContext({
      runtimeContext: {
        last_error: "agent result issue_number must be 7",
        exception: { attempt_count: 2 },
      },
    }),
    branch: "northstar/7",
    changedFiles: ["src/example.ts"],
  });

  assert.match(worker.implementationPrompt, /Retry\/recovery context:/);
  assert.match(worker.implementationPrompt, /Previous failure: agent result issue_number must be 7/);
  assert.match(worker.implementationPrompt, /Retry count: 2/);
  assert.match(worker.implementationPrompt, /self-check that artifact_kind, issue_number, and role exactly match/);
  assert.match(worker.implementationPrompt, /Canonical implementation_result JSON example:/);
});

test("software-dev implementation retry prompt includes verifier feedback carry-forward", async () => {
  const worker = new RecordingWorker();
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-verifier-feedback-retry",
    github: new ThrowingDeliveryGitHub(),
    worker,
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
  });

  await driver.prepareStage(domainContext({}));
  await driver.finalizeWorkerArtifact({
    ...domainContext({
      runtimeContext: {
        exception_carry_forward: {
          feedback_for_implementation: ["Fix completed filter.", "Add reload persistence evidence."],
        },
      },
    }),
    branch: "northstar/7",
    changedFiles: ["src/example.ts"],
  });

  assert.match(worker.implementationPrompt, /Verifier feedback: Fix completed filter.; Add reload persistence evidence\./);
});

test("software-dev release retry prompt includes release cleanup carry-forward", async () => {
  const worker = new RecordingWorker();
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-release-cleanup-retry",
    github: new ThrowingDeliveryGitHub(),
    worker,
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
  });

  await driver.prepareStage(domainContext({
    stageName: "release",
    roleName: "release_agent",
    runtimeContext: {
      exception_carry_forward: {
        error: "PR #6 already merged; local sync incomplete.",
        release_context: {
          merge_commit: "merge-sha-6",
          local_head: "old-main",
          remote_head: "merge-sha-6",
          worktree_cleanup_path: ".northstar/runtime/worktrees/issue-6",
        },
      },
    },
  }));
  await driver.releaseVerifiedItem(domainContext({
    stageName: "release",
    roleName: "release_agent",
    runtimeContext: {
      exception_carry_forward: {
        error: "PR #6 already merged; local sync incomplete.",
        release_context: {
          merge_commit: "merge-sha-6",
          local_head: "old-main",
          remote_head: "merge-sha-6",
          worktree_cleanup_path: ".northstar/runtime/worktrees/issue-6",
        },
      },
    },
  }));

  assert.match(worker.releasePrompt, /Previous failure: PR #6 already merged; local sync incomplete\./);
  assert.match(worker.releasePrompt, /Release merge commit: merge-sha-6/);
  assert.match(worker.releasePrompt, /Release local head: old-main/);
  assert.match(worker.releasePrompt, /Release remote head: merge-sha-6/);
  assert.match(worker.releasePrompt, /Release worktree cleanup path: \.northstar\/runtime\/worktrees\/issue-6/);
});

test("software-dev driver delegates git operations to implementation and release worker subagents", async () => {
  const github = new ThrowingDeliveryGitHub();
  const worker = new RecordingWorker();
  const host = new QueuedHostSessionBridge({
    runId: "northstar-test",
    idGenerator: () => "verifier-nonce",
  });
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-test",
    github,
    worker,
    host,
    metrics: emptyMetrics(),
    workspaceHints: {
      projectRoot: "/repo",
      syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    },
  });

  const prepared = await driver.prepareStage(domainContext({}));
  assert.equal(prepared.branch, "northstar/7");
  assert.match(prepared.worktreePath, /^agent-owned:\/\/codex\/northstar-test\/issue-7-template-issue$/);

  const pr = await driver.finalizeWorkerArtifact({ ...domainContext({}), branch: prepared.branch, changedFiles: ["src/example.ts"] });
  assert.match(worker.implementationPrompt, /implementation worker subagent owns git workspace setup/i);
  assert.match(worker.implementationPrompt, /"branch": "northstar\/7"/);
  assert.match(worker.implementationPrompt, /"worktree_path_hint": ".northstar\/runtime\/worktrees\/issue-7-template-issue"/);
  assert.match(worker.implementationPrompt, /"implementation_worker_must_create_worktree": true/);
  assert.match(worker.implementationPrompt, /"northstar_will_not_run_git": true/);
  assert.match(worker.implementationPrompt, /fetch task\.repo\.base_branch from origin/);
  assert.match(worker.implementationPrompt, /Do not create the issue branch from a stale project root main checkout/);
  assert.match(worker.implementationPrompt, /workspace_evidence\.base_source/);
  assert.match(worker.implementationPrompt, /workspace_evidence\.base_commit/);
  assert.match(worker.implementationPrompt, /If the issue worktree already exists for a retry, inspect it and continue from it/);
  assert.match(worker.implementationPrompt, /self-check that artifact_kind, issue_number, and role exactly match/);
  assert.match(worker.implementationPrompt, /Canonical implementation_result JSON example:/);
  assert.equal(pr.workerArtifact?.artifact_kind, "implementation_result");
  assert.equal(pr.verifierArtifact, undefined);
  assert.equal(worker.verificationPrompt, "");
  const verifierRoot = host.startRootSession({
    issue_id: "github:7",
    role_name: "verifier_agent",
    role: { agent: "review", load_skills: [] },
  });
  const verifierChild = host.startBackgroundChild({
    issue_id: "github:7",
    lease_id: "lease-verification-github:7",
    root_session_id: verifierRoot.root_session_id,
    role_name: "verifier_agent",
    role: { agent: "review", load_skills: [] },
  });
  assert.equal(verifierRoot.root_session_id, "planned-root:northstar-test:github-7:verifier-agent:verifier-nonce");
  assert.equal(verifierChild.child_run_id, "planned-child:northstar-test:github-7:verifier-agent:verifier-nonce");

  const verifierArtifact = await driver.verifyPullRequest?.({
    ...domainContext({ roleName: "verifier_agent", stageName: "verification" }),
    pullRequest: pr,
  });
  assert.equal(verifierArtifact?.artifact_kind, "verification_result");
  assert.match(worker.verificationPrompt, /Canonical verification_result JSON example:/);
  assert.equal(worker.verificationRoleName, "verifier_agent");
  assert.equal(pr.prNumber, 17);
  assert.equal(pr.prUrl, "https://github.test/pull/17");
  assert.equal(pr.branch, "northstar/issue-7-template-issue");
  assert.equal(pr.commitSha, "head-sha-17");

  const release = await driver.releaseVerifiedItem({
    ...domainContext({ roleName: "release_agent", stageName: "release" }),
    releaseMetadata: { prNumber: pr.prNumber },
  });
  assert.match(worker.releasePrompt, /release worker subagent owns release git operations/i);
  assert.match(worker.releasePrompt, /merge the PR/);
  assert.match(worker.releasePrompt, /detached managed base workspace/i);
  assert.match(worker.releasePrompt, /best-effort sync/i);
  assert.match(worker.releasePrompt, /release\.repo_root_sync/);
  assert.match(worker.releasePrompt, /If the pull request is already merged during a retry/);
  assert.match(worker.releasePrompt, /sync_worktree_path_hint/);
  assert.match(worker.releasePrompt, /\/repo\/\.northstar\/runtime\/sync-worktrees\/main/);
  assert.match(worker.releasePrompt, /remove the issue worktree/i);
  assert.match(worker.releasePrompt, /"release_worker_owns_local_base_branch_sync": true/);
  assert.match(worker.releasePrompt, /"release_worker_owns_worktree_cleanup": true/);
  assert.match(worker.releasePrompt, /release\.local_sync\.synced must be true/);
  assert.match(worker.releasePrompt, /release\.repo_root_sync\.status must be synced, skipped, or failed_retryable/);
  assert.match(worker.releasePrompt, /release\.worktree_cleanup\.removed must be true/);
  assert.match(worker.releasePrompt, /self-check that artifact_kind, issue_number, and role exactly match/);
  assert.match(worker.releasePrompt, /Canonical release_result JSON example:/);
  assert.equal(release.confirmed, true);
  assert.equal(release.mergeSha, "merge-sha-17");
  assert.equal(release.releaseArtifact?.artifact_kind, "release_result");
  assert.deepEqual(release.issueUpdate?.labels_to_add, ["northstar:released"]);

  assert.equal(github.calls.length, 0);
});

test("software-dev driver rejects implementation artifact with wrong kind", async () => {
  const worker = new RecordingWorker({
    implementationArtifact: {
      ...IMPLEMENTATION_ARTIFACT,
      artifact_kind: "worker_result",
    },
  });
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-test",
    github: new ThrowingDeliveryGitHub(),
    worker,
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
  });

  await driver.prepareStage(domainContext({}));
  await assert.rejects(
    () => driver.finalizeWorkerArtifact({ ...domainContext({}), branch: "", changedFiles: [] }),
    /agent result artifact_kind must be implementation_result/,
  );
});

test("software-dev driver rejects non-json implementation artifact output", async () => {
  const worker = new RecordingWorker({ implementationFinalResponse: "implementation complete" });
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-test",
    github: new ThrowingDeliveryGitHub(),
    worker,
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
  });

  await driver.prepareStage(domainContext({}));
  await assert.rejects(
    () => driver.finalizeWorkerArtifact({ ...domainContext({}), branch: "", changedFiles: [] }),
    /agent result must be exactly one JSON object/,
  );
});

test("software-dev driver requires browser evidence when runtime context demands browser acceptance", async () => {
  const worker = new RecordingWorker({
    verificationArtifact: verificationArtifact({
      role: "verifier_agent",
      browserRequired: true,
      browserRan: false,
      browserTestsPassed: 0,
    }),
  });
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-browser",
    github: new ThrowingDeliveryGitHub(),
    worker,
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
  });

  await driver.prepareStage(domainContext({}));
  const pr = await driver.finalizeWorkerArtifact({
    ...domainContext({}),
    branch: "",
    changedFiles: ["src/example.ts"],
  });
  await assert.rejects(
    () => driver.verifyPullRequest?.({
      ...domainContext({ roleName: "verifier_agent", stageName: "verification" }),
      pullRequest: pr,
    }),
    /ARTIFACT_BROWSER_EVIDENCE_REQUIRED/,
  );
});

test("software-dev release refresh is always skipped and external completion is disabled", async () => {
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-release",
    github: new ThrowingDeliveryGitHub(),
    worker: new RecordingWorker(),
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
  });

  assert.deepEqual(await driver.refreshCompletedBase({ mergeSha: "merge-sha-17" }), {
    status: "skipped",
    expectedCommit: "merge-sha-17",
  });
  assert.equal(await driver.reconcileExternalCompletion(domainContext({})), undefined);
  assert.equal(await driver.recoverDispatchBlock({ blocker: "sync_worktree", blockedErrorCode: "SYNC_WORKTREE_DIRTY" }), undefined);
});

test("software-dev driver passes role context and role timeout to workers", async () => {
  const seen: Array<{ roleName?: string; roleAgent?: string; timeoutMs?: number; worktree?: string }> = [];
  const worker = new RecordingWorker({ onImplementationInput: (input) => {
    seen.push({
      roleName: input.role_name,
      roleAgent: typeof input.role === "object" && input.role !== null ? (input.role as { agent?: string }).agent : undefined,
      timeoutMs: input.timeout_ms,
      worktree: input.worktree_path,
    });
  } });
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-role-context",
    github: new ThrowingDeliveryGitHub(),
    worker,
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
  });

  const context = domainContext({
    roleName: "implementation_agent",
    role: {
      run_mode: "background_child",
      agent: "build",
      timeout_seconds: 11,
    },
  });
  const prepared = await driver.prepareStage(context);
  await driver.finalizeWorkerArtifact({ ...context, branch: prepared.branch, changedFiles: ["src/example.ts"] });

  assert.deepEqual(seen, [{
    roleName: "implementation_agent",
    roleAgent: "build",
    timeoutMs: 11_000,
    worktree: "agent-owned://codex/northstar-role-context/issue-7-template-issue",
  }]);
});

test("software-dev command plan uses argv arrays and avoids root checkout", () => {
  const plan = createSoftwareDevCommandPlan({
    projectRoot: "/repo",
    worktreePath: "/repo/.northstar/runtime/worktrees/issue-7",
    branch: "northstar/7",
    baseBranch: "main",
    commitMessage: "northstar issue 7",
  });

  assert.equal(plan.commands.every((command) => Array.isArray(command.argv)), true);
  assert.equal(plan.commands.some((command) => command.argv.join(" ") === "git checkout main"), false);
  assert.equal(plan.commands.some((command) => command.argv.join(" ") === "git switch main"), false);
  assert.equal(plan.commands.some((command) => command.argv.some((part) => /&&|\|\||;/.test(part))), false);
});

test("software-dev driver rejects malformed worker output and records metric", () => {
  const metrics = emptyMetrics();
  assert.throws(
    () => validateWorkerOutput("codex", "implementation", "", metrics),
    /codex implementation worker returned an empty response/,
  );
  assert.equal(metrics.software_dev_malformed_artifacts_rejected, 1);
});

test("software-dev worker output secret detector ignores task slug text", () => {
  const metrics = emptyMetrics();
  const safeResponse = JSON.stringify({
    summary: "worktree slug issue-sketch-12345 remains safe",
    artifact_kind: "implementation_result",
  });
  assert.doesNotThrow(() => validateWorkerOutput("codex", "implementation", safeResponse, metrics));
  assert.equal(metrics.software_dev_driver_secret_leaks, 0);
});

function domainContext(roleOverride: Record<string, unknown>): DomainDriverContext {
  const { issueBody, runtimeContext, roleName, role, stageName, ...roleDefinitionOverride } = roleOverride;
  return {
    issue: {
      id: "github:7",
      number: 7,
      title: "Template issue",
      body: typeof issueBody === "string" ? issueBody : "Body details",
      sourceUrl: "https://github.test/issues/7",
    },
    workflow: {
      id: "issue_to_pr_release",
      domain: "software_development",
    },
    stage: {
      name: typeof stageName === "string" ? stageName : "implementation",
    },
    role: {
      name: typeof roleName === "string" ? roleName : "implementation_agent",
      definition: {
        run_mode: "background_child",
        agent: "build",
        load_skills: ["tdd"],
        timeout_seconds: 600,
        ...(typeof role === "object" && role ? role : {}),
        ...roleDefinitionOverride,
      },
    },
    runtimeContext: (runtimeContext as DomainDriverContext["runtimeContext"] | undefined) ?? {},
  };
}

function emptyMetrics(overrides: Record<string, unknown> = {}) {
  return {
    software_dev_branch_reuse_cases: 0,
    software_dev_retryable_effect_failures: 0,
    software_dev_malformed_artifacts_rejected: 0,
    software_dev_completed_reversals: 0,
    software_dev_driver_live_completed: 0,
    software_dev_driver_secret_leaks: 0,
    software_dev_driver_shell_fallbacks: 0,
    merge_conflicts_detected: 0,
    merge_conflict_recovery_attempts: 0,
    merge_conflict_recovered_prs_merged: 0,
    merge_conflict_terminal_failures: 0,
    resume_duplicate_prs_created: 0,
    ...overrides,
  };
}

class RecordingWorker {
  implementationPrompt = "";
  verificationPrompt = "";
  releasePrompt = "";
  verificationRoleName = "";
  private readonly implementationArtifact: Record<string, unknown>;
  private readonly verification: Record<string, unknown> | ((role: string) => Record<string, unknown>);
  private readonly releaseArtifact: Record<string, unknown>;
  private readonly implementationFinalResponse?: string;
  private readonly onImplementationInput?: (input: { role_name?: string; role?: unknown; timeout_ms?: number; worktree_path?: string }) => void;

  constructor(options: {
    implementationArtifact?: Record<string, unknown>;
    verificationArtifact?: Record<string, unknown>;
    releaseArtifact?: Record<string, unknown>;
    implementationFinalResponse?: string;
    onImplementationInput?: (input: { role_name?: string; role?: unknown; timeout_ms?: number; worktree_path?: string }) => void;
  } = {}) {
    this.implementationArtifact = options.implementationArtifact ?? IMPLEMENTATION_ARTIFACT;
    this.verification = options.verificationArtifact ?? ((role) => verificationArtifact({ role }));
    this.releaseArtifact = options.releaseArtifact ?? RELEASE_ARTIFACT;
    this.implementationFinalResponse = options.implementationFinalResponse;
    this.onImplementationInput = options.onImplementationInput;
  }

  async runImplementation(input: { prompt: string; role_name?: string; role?: unknown; timeout_ms?: number; worktree_path?: string }) {
    this.implementationPrompt = input.prompt;
    this.onImplementationInput?.(input);
    return {
      root_session_id: "root-implementation-1",
      child_run_id: "child-implementation-1",
      session_id: "session-implementation-1",
      final_response: this.implementationFinalResponse ?? JSON.stringify(this.implementationArtifact),
      shell_fallbacks: 0 as const,
    };
  }

  async runVerification(input: { prompt: string; role_name?: string }) {
    this.verificationPrompt = input.prompt;
    this.verificationRoleName = input.role_name ?? "";
    const artifact = typeof this.verification === "function"
      ? this.verification(input.role_name ?? "implementation_agent")
      : this.verification;
    return {
      root_session_id: "root-verification-1",
      child_run_id: "child-verification-1",
      session_id: "session-verification-1",
      final_response: JSON.stringify(artifact),
      shell_fallbacks: 0 as const,
    };
  }

  async runRelease(input: { prompt: string }) {
    this.releasePrompt = input.prompt;
    return {
      root_session_id: "root-release-1",
      child_run_id: "child-release-1",
      session_id: "session-release-1",
      final_response: JSON.stringify(this.releaseArtifact),
      shell_fallbacks: 0 as const,
    };
  }
}

class ThrowingDeliveryGitHub {
  readonly calls: string[] = [];

  async createFixtureBranch() { this.calls.push("createFixtureBranch"); throw new Error("createFixtureBranch must not be called"); }
  async readBranchCommit() { this.calls.push("readBranchCommit"); throw new Error("readBranchCommit must not be called"); }
  async createPullRequest() { this.calls.push("createPullRequest"); throw new Error("createPullRequest must not be called"); }
  async createOrReusePullRequest() { this.calls.push("createOrReusePullRequest"); throw new Error("createOrReusePullRequest must not be called"); }
  async mergePullRequest() { this.calls.push("mergePullRequest"); throw new Error("mergePullRequest must not be called"); }
  async closeIssue() { this.calls.push("closeIssue"); throw new Error("closeIssue must not be called"); }
  async findMergedPullRequestForIssue() { this.calls.push("findMergedPullRequestForIssue"); throw new Error("findMergedPullRequestForIssue must not be called"); }
}
