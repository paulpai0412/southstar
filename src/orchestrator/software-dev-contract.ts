import {
  validateArtifactPayload,
  type NormalizedArtifact,
} from "../runtime/artifacts.ts";

export type SoftwareDevTaskKind = "implementation" | "verification" | "release";
export type SoftwareDevArtifactKind = "implementation_result" | "verification_result" | "release_result";

export interface SoftwareDevAgentTask {
  schema_version: "1.0";
  task_kind: SoftwareDevTaskKind;
  northstar: {
    run_id: string;
    issue_id: string;
    stage: string;
    attempt: number;
  };
  repo: {
    provider: "github";
    name: string;
    url: string;
    base_branch: string;
  };
  workspace: {
    workspace_uri: string;
    branch: string;
    worktree_path_hint: string;
    project_root_path?: string;
    sync_worktree_path_hint?: string;
  };
  issue: {
    number: number;
    title: string;
    body: string;
    url: string;
  };
  policy: {
    git_is_agent_owned: true;
    implementation_worker_must_create_worktree: true;
    implementation_worker_must_create_branch: true;
    implementation_worker_owns_commit_push_pr: true;
    release_worker_owns_merge: true;
    release_worker_owns_local_base_branch_sync: true;
    release_worker_owns_worktree_cleanup: true;
    northstar_will_not_run_git: true;
    northstar_will_not_commit_or_push: true;
    northstar_will_not_create_or_merge_pr: true;
    northstar_will_validate_reported_artifacts: true;
  };
  expected_output: {
    artifact_kind: SoftwareDevArtifactKind;
    format: "json_object_only";
  };
}

export interface SoftwareDevAgentTaskInput {
  task_json: SoftwareDevAgentTask;
  prompt: string;
  expected_artifact_kind: SoftwareDevArtifactKind;
}

export function buildSoftwareDevAgentTask(input: {
  taskKind: SoftwareDevTaskKind;
  runId: string;
  issueId: string;
  stage: string;
  attempt: number;
  repo: SoftwareDevAgentTask["repo"];
  workspace: SoftwareDevAgentTask["workspace"];
  issue: SoftwareDevAgentTask["issue"];
  expectedArtifactKind: SoftwareDevArtifactKind;
}): SoftwareDevAgentTask {
  return {
    schema_version: "1.0",
    task_kind: input.taskKind,
    northstar: {
      run_id: input.runId,
      issue_id: input.issueId,
      stage: input.stage,
      attempt: input.attempt,
    },
    repo: input.repo,
    workspace: input.workspace,
    issue: input.issue,
    policy: {
      git_is_agent_owned: true,
      implementation_worker_must_create_worktree: true,
      implementation_worker_must_create_branch: true,
      implementation_worker_owns_commit_push_pr: true,
      release_worker_owns_merge: true,
      release_worker_owns_local_base_branch_sync: true,
      release_worker_owns_worktree_cleanup: true,
      northstar_will_not_run_git: true,
      northstar_will_not_commit_or_push: true,
      northstar_will_not_create_or_merge_pr: true,
      northstar_will_validate_reported_artifacts: true,
    },
    expected_output: {
      artifact_kind: input.expectedArtifactKind,
      format: "json_object_only",
    },
  };
}

export function buildSoftwareDevAgentPrompt(task: SoftwareDevAgentTask): string {
  return [
    "You are executing a Northstar software-development workflow stage.",
    ...gitOwnershipInstructions(task),
    "Return exactly one JSON object matching the expected schema. No Markdown fences and no prose outside JSON.",
    "Do not include raw transcripts, raw browser traces, terminal logs, full logs, or secrets.",
    "Task JSON:",
    JSON.stringify(task, null, 2),
  ].join("\n");
}

function gitOwnershipInstructions(task: SoftwareDevAgentTask): string[] {
  if (task.task_kind === "implementation") {
    return [
      "The implementation worker subagent owns git workspace setup. Create or reuse the issue worktree at task.workspace.worktree_path_hint and branch task.workspace.branch before editing files.",
      "Before creating a new issue worktree, fetch task.repo.base_branch from origin and base the issue branch on origin/task.repo.base_branch or the detached task.workspace.sync_worktree_path_hint HEAD. Do not create the issue branch from a stale project root main checkout.",
      "Record the base you used in workspace_evidence.base_source and workspace_evidence.base_commit before returning ready_for_verification.",
      "Do not checkout the local base branch in the issue worktree or sync workspace; keep base sync workspaces detached from origin/task.repo.base_branch so project root main being checked out does not block the agent flow.",
      "If the issue worktree already exists for a retry, inspect it and continue from it when it is on the expected branch. Only recreate the same hinted worktree when it is missing, corrupt, or on an unrecoverably wrong branch.",
      "Do not edit the repository root for implementation work. Work inside the issue worktree you create or reuse.",
      "The implementation worker subagent owns commit, push, and pull-request creation or reuse. Northstar will not run git.",
    ];
  }
  if (task.task_kind === "release") {
    return [
      "The release worker subagent owns release git operations, including verifying PR state, merging the pull request into task.repo.base_branch, syncing the local base branch to the remote base branch, removing the issue worktree, and reporting the merge commit.",
      "If the pull request is already merged during a retry, do not create another merge or new pull request. Reuse the merged PR state and continue with local base sync and issue worktree cleanup.",
      "After merge, sync task.workspace.sync_worktree_path_hint as a detached managed base workspace to origin/task.repo.base_branch and confirm release.local_sync.local_head equals release.local_sync.remote_head at the merge commit. This managed sync is required for completed.",
      "Also attempt a best-effort sync of task.workspace.project_root_path when it is clean, writable, and safe. Repo root sync failure must not block completed when the managed sync workspace is current.",
      "Report repo root sync separately as release.repo_root_sync with status synced, skipped, or failed_retryable. For skipped or failed_retryable, include a concise reason such as repo_root_dirty, git_metadata_readonly, branch_checked_out_elsewhere, or unsafe_to_update.",
      "After managed local/remote sync is confirmed, remove the issue worktree at task.workspace.worktree_path_hint.",
      "Before returning completed, self-check that release.local_sync head equals the remote merge commit, release.repo_root_sync is reported, and the reported issue worktree path no longer exists.",
      "Northstar will not run git, push, merge, sync local code, or remove worktrees on behalf of the release worker.",
    ];
  }
  return [
    "The verifier worker subagent must not mutate git state. Verify the pull request and reported workspace evidence only.",
    "Northstar will not run git during verification; report any git/workspace mismatch as verification feedback.",
  ];
}

export function parseSoftwareDevAgentResult(
  finalResponse: string,
  expected: {
    expectedArtifactKind: SoftwareDevArtifactKind;
    issueNumber: number;
    role: string;
  },
): NormalizedArtifact {
  const trimmed = finalResponse.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("agent result must be exactly one JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("agent result must be exactly one JSON object");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("agent result must be exactly one JSON object");
  }

  const record = parsed as Record<string, unknown>;
  if (record.artifact_kind !== expected.expectedArtifactKind) {
    throw new Error(`agent result artifact_kind must be ${expected.expectedArtifactKind}`);
  }
  if (record.issue_number !== expected.issueNumber) {
    throw new Error(`agent result issue_number must be ${expected.issueNumber}`);
  }
  if (record.role !== expected.role) {
    throw new Error(`agent result role must be ${expected.role}`);
  }

  return validateArtifactPayload(record);
}
