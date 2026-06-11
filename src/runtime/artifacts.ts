import type { HistoryEntry } from "../types/control-plane.ts";
import type { WorkflowDefinition } from "../types/workflow.ts";
import { redactSecrets } from "./redaction.ts";

export type ArtifactKind =
  | "worker_result"
  | "evidence_packet"
  | "implementation_result"
  | "verification_result"
  | "release_result";
export type ArtifactStatus =
  | "success"
  | "pass"
  | "completed"
  | "ready_for_verification"
  | "blocked"
  | "failed_retryable"
  | "failed_terminal";

export type ArtifactValidationErrorCode =
  | "ARTIFACT_BINDING_MISMATCH"
  | "ARTIFACT_UNKNOWN_KIND"
  | "ARTIFACT_MISSING_FIELD"
  | "ARTIFACT_FIELD_TYPE"
  | "ARTIFACT_FIELD_TOO_LARGE"
  | "ARTIFACT_RAW_LOG_REJECTED"
  | "ARTIFACT_SECRET_VALUE"
  | "ARTIFACT_BROWSER_EVIDENCE_REQUIRED"
  | "ARTIFACT_RETRYABLE_MISMATCH"
  | "ARTIFACT_MERGE_NOT_CONFIRMED";

export class ArtifactValidationError extends Error {
  readonly code: ArtifactValidationErrorCode;
  readonly path: string;

  constructor(code: ArtifactValidationErrorCode, path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "ArtifactValidationError";
    this.code = code;
    this.path = path;
  }
}

export interface NormalizedArtifact {
  schema_version: string;
  artifact_kind: ArtifactKind;
  issue_number: number;
  role: string;
  status: ArtifactStatus;
  observed_at: string;
  summary: string;
  retryable: boolean;
  payload: Record<string, unknown>;
}

const rawLogFields = new Set(["raw_transcript", "raw_browser_trace", "terminal_log", "full_log"]);
const allowedKinds = new Set([
  "worker_result",
  "evidence_packet",
  "implementation_result",
  "verification_result",
  "release_result",
]);
const allowedStatuses = new Set([
  "success",
  "pass",
  "completed",
  "ready_for_verification",
  "blocked",
  "failed_retryable",
  "failed_terminal",
]);

export function validateArtifactPayload(value: unknown, workflow?: WorkflowDefinition): NormalizedArtifact {
  const record = objectValue(value, "artifact");
  for (const key of Object.keys(record)) {
    if (rawLogFields.has(key)) {
      throw new ArtifactValidationError("ARTIFACT_RAW_LOG_REJECTED", key, `${key} is not allowed in artifact payloads`);
    }
  }
  rejectSecretValues(record, "artifact");

  const artifact_kind = stringValue(record.artifact_kind, "artifact_kind") as ArtifactKind;
  const customSchema = workflow?.artifact_schemas?.[artifact_kind];
  if (!allowedKinds.has(artifact_kind) && !customSchema) {
    throw new ArtifactValidationError("ARTIFACT_UNKNOWN_KIND", "artifact_kind", `unknown artifact kind ${artifact_kind}`);
  }

  const status = stringValue(record.status, "status") as ArtifactStatus;
  if (!allowedStatuses.has(status)) {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", "status", `unknown artifact status ${status}`);
  }

  const normalized: NormalizedArtifact = {
    schema_version: stringValue(record.schema_version, "schema_version"),
    artifact_kind,
    issue_number: numberValue(record.issue_number, "issue_number"),
    role: stringValue(record.role, "role"),
    status,
    observed_at: isoDateValue(record.observed_at, "observed_at"),
    summary: compactStringValue(record.summary, "summary", 5000),
    retryable: booleanValue(record.retryable, "retryable"),
    payload: record,
  };

  if (normalized.status === "completed" && artifact_kind !== "release_result") {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", "status", `${artifact_kind} does not support status completed`);
  }

  if (normalized.status === "ready_for_verification" && artifact_kind !== "implementation_result") {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", "status", `${artifact_kind} does not support status ready_for_verification`);
  }

  if ((normalized.status === "blocked" || normalized.status === "failed_retryable") && !normalized.retryable) {
    throw new ArtifactValidationError("ARTIFACT_RETRYABLE_MISMATCH", "retryable", `${normalized.status} artifacts must be retryable`);
  }

  if (artifact_kind === "worker_result" && normalized.status === "success") {
    requireString(record.branch, "branch");
    requireString(record.base_branch, "base_branch");
    requireString(record.commit_sha, "commit_sha");
    requireStringArray(record.changed_files, "changed_files");
    requireArray(record.commands_run, "commands_run");
    objectValue(record.test_summary, "test_summary");
    requireString(record.self_check_summary, "self_check_summary");
  }

  if (artifact_kind === "evidence_packet" && normalized.status === "pass") {
    numberValue(record.pr_number, "pr_number");
    requireString(record.base_branch, "base_branch");
    requireArray(record.gate_results, "gate_results");
    objectValue(record.verifier, "verifier");
    if (record.browser_required !== undefined && typeof record.browser_required !== "boolean") {
      throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", "browser_required", "browser_required must be a boolean");
    }
    if (record.browser_required === true) {
      if (record.browser_evidence === undefined) {
        throw new ArtifactValidationError("ARTIFACT_BROWSER_EVIDENCE_REQUIRED", "browser_evidence", "browser evidence is required");
      }
      const browserEvidence = objectValue(record.browser_evidence, "browser_evidence");
      if (booleanValue(browserEvidence.ran, "browser_evidence.ran") !== true) {
        throw new ArtifactValidationError("ARTIFACT_BROWSER_EVIDENCE_REQUIRED", "browser_evidence.ran", "browser evidence must have run");
      }
      const testsPassed = numberValue(browserEvidence.tests_passed, "browser_evidence.tests_passed");
      if (testsPassed <= 0) {
        throw new ArtifactValidationError("ARTIFACT_BROWSER_EVIDENCE_REQUIRED", "browser_evidence.tests_passed", "browser evidence must include passing tests");
      }
    }
  }

  if (artifact_kind === "implementation_result" && normalized.status === "ready_for_verification") {
    const pr = objectValue(record.pr, "pr");
    requireString(pr.url, "pr.url");
    numberValue(pr.number, "pr.number");
    requireStringArray(record.changed_files, "changed_files");
    requireArray(record.commands_run, "commands_run");
    requireString(record.self_check_summary, "self_check_summary");
    requireArray(record.evidence, "evidence");
    requireMatchingWorkspaceEvidence(record.workspace_evidence, "workspace_evidence");
    const workspaceEvidence = objectValue(record.workspace_evidence, "workspace_evidence");
    requireString(workspaceEvidence.base_source, "workspace_evidence.base_source");
    requireString(workspaceEvidence.base_commit, "workspace_evidence.base_commit");
  }

  if (artifact_kind === "verification_result" && normalized.status === "pass") {
    const review = objectValue(record.review, "review");
    if (typeof review.requirements_passed !== "boolean") {
      throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", "review.requirements_passed", "review.requirements_passed must be a boolean");
    }
    if (typeof review.code_review_passed !== "boolean") {
      throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", "review.code_review_passed", "review.code_review_passed must be a boolean");
    }

    const functionalReview = objectValue(record.functional_review, "functional_review");
    if (functionalReview.required === true && functionalReview.status !== "pass") {
      throw new ArtifactValidationError(
        "ARTIFACT_FIELD_TYPE",
        "functional_review.status",
        "required functional review must have status=pass",
      );
    }

    const browserEvidence = objectValue(record.browser_evidence, "browser_evidence");
    if (browserEvidence.required === true && booleanValue(browserEvidence.ran, "browser_evidence.ran") !== true) {
      throw new ArtifactValidationError(
        "ARTIFACT_BROWSER_EVIDENCE_REQUIRED",
        "browser_evidence.ran",
        "required browser evidence must run",
      );
    }
    requireBrowserScreenshotsWhenRan(browserEvidence, "browser_evidence");
    requireMatchingWorkspaceEvidence(record.workspace_evidence, "workspace_evidence");

    if (record.release_recommendation !== "ready_for_release") {
      throw new ArtifactValidationError(
        "ARTIFACT_FIELD_TYPE",
        "release_recommendation",
        "pass verification_result requires release_recommendation=ready_for_release",
      );
    }
  }

  if (artifact_kind === "verification_result" && normalized.status === "failed_retryable") {
    objectValue(record.review, "review");
    const failureOwner = stringValue(record.failure_owner, "failure_owner");
    if (failureOwner === "implementation") {
      requireNonEmptyStringArray(record.feedback_for_implementation, "feedback_for_implementation");
    } else if (failureOwner === "release") {
      requireNonEmptyStringArray(record.feedback_for_release, "feedback_for_release");
    } else {
      throw new ArtifactValidationError(
        "ARTIFACT_FIELD_TYPE",
        "failure_owner",
        "failure_owner must be implementation or release",
      );
    }
    if (record.browser_evidence !== undefined) {
      const browserEvidence = objectValue(record.browser_evidence, "browser_evidence");
      requireBrowserScreenshotsWhenRan(browserEvidence, "browser_evidence");
    }
  }

  if (artifact_kind === "release_result" && normalized.status === "success") {
    numberValue(record.pr_number, "pr_number");
    const mergeStatus = stringValue(record.merge_status, "merge_status");
    if (mergeStatus !== "merged") {
      throw new ArtifactValidationError("ARTIFACT_MERGE_NOT_CONFIRMED", "merge_status", "release success requires merge_status=merged");
    }
    requireString(record.merged_sha, "merged_sha");
  }

  if (artifact_kind === "release_result" && normalized.status === "completed") {
    const release = objectValue(record.release, "release");
    if (booleanValue(release.confirmed, "release.confirmed") !== true) {
      throw new ArtifactValidationError(
        "ARTIFACT_MERGE_NOT_CONFIRMED",
        "release.confirmed",
        "release completed requires release.confirmed=true",
      );
    }
    requireString(release.merge_commit, "release.merge_commit");
    const localSync = objectValue(release.local_sync, "release.local_sync");
    requireString(localSync.base_branch, "release.local_sync.base_branch");
    if (booleanValue(localSync.synced, "release.local_sync.synced") !== true) {
      throw new ArtifactValidationError(
        "ARTIFACT_MERGE_NOT_CONFIRMED",
        "release.local_sync.synced",
        "release completed requires release.local_sync.synced=true",
      );
    }
    requireString(localSync.local_head, "release.local_sync.local_head");
    requireString(localSync.remote_head, "release.local_sync.remote_head");
    if (booleanValue(localSync.matches_remote, "release.local_sync.matches_remote") !== true) {
      throw new ArtifactValidationError(
        "ARTIFACT_MERGE_NOT_CONFIRMED",
        "release.local_sync.matches_remote",
        "release completed requires release.local_sync.matches_remote=true",
      );
    }
    const repoRootSync = objectValue(release.repo_root_sync, "release.repo_root_sync");
    const repoRootSyncStatus = stringValue(repoRootSync.status, "release.repo_root_sync.status");
    if (!["synced", "skipped", "failed_retryable"].includes(repoRootSyncStatus)) {
      throw new ArtifactValidationError(
        "ARTIFACT_FIELD_TYPE",
        "release.repo_root_sync.status",
        "release.repo_root_sync.status must be synced, skipped, or failed_retryable",
      );
    }
    if (repoRootSyncStatus === "synced") {
      requireString(repoRootSync.local_head, "release.repo_root_sync.local_head");
      requireString(repoRootSync.remote_head, "release.repo_root_sync.remote_head");
      if (booleanValue(repoRootSync.matches_remote, "release.repo_root_sync.matches_remote") !== true) {
        throw new ArtifactValidationError(
          "ARTIFACT_MERGE_NOT_CONFIRMED",
          "release.repo_root_sync.matches_remote",
          "release completed requires release.repo_root_sync.matches_remote=true when status=synced",
        );
      }
    } else {
      requireString(repoRootSync.reason, "release.repo_root_sync.reason");
    }
    const worktreeCleanup = objectValue(release.worktree_cleanup, "release.worktree_cleanup");
    requireString(worktreeCleanup.path, "release.worktree_cleanup.path");
    if (booleanValue(worktreeCleanup.removed, "release.worktree_cleanup.removed") !== true) {
      throw new ArtifactValidationError(
        "ARTIFACT_MERGE_NOT_CONFIRMED",
        "release.worktree_cleanup.removed",
        "release completed requires release.worktree_cleanup.removed=true",
      );
    }
    const issueUpdate = objectValue(record.issue_update, "issue_update");
    requireString(issueUpdate.comment_summary, "issue_update.comment_summary");
    requireArray(record.evidence, "evidence");
  }

  if (customSchema) {
    for (const field of customSchema.required_fields) {
      if (record[field] === undefined) {
        throw new ArtifactValidationError("ARTIFACT_MISSING_FIELD", field, `${field} is required by workflow artifact schema`);
      }
    }
  }

  return normalized;
}

export function artifactRejectionHistory(issueId: string, rejection: Record<string, unknown>): HistoryEntry {
  return {
    event_type: "artifact_rejected",
    payload: {
      issue_id: issueId,
      artifact_kind: rejection.artifact_kind,
      role: rejection.role,
      reason: rejection.reason,
      path: rejection.path,
    },
  };
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactValidationError(
      value === undefined ? "ARTIFACT_MISSING_FIELD" : "ARTIFACT_FIELD_TYPE",
      path,
      `${path} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ArtifactValidationError(
      value === undefined ? "ARTIFACT_MISSING_FIELD" : "ARTIFACT_FIELD_TYPE",
      path,
      `${path} must be a non-empty string`,
    );
  }
  return value;
}

function requireString(value: unknown, path: string): void {
  stringValue(value, path);
}

function rejectSecretValues(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (redactSecrets(value) !== value || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)) {
      throw new ArtifactValidationError("ARTIFACT_SECRET_VALUE", path, `${path} contains a secret-shaped value`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretValues(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      rejectSecretValues(nested, `${path}.${key}`);
    }
  }
}

function compactStringValue(value: unknown, path: string, maxLength: number): string {
  const text = stringValue(value, path);
  if (text.length > maxLength) {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TOO_LARGE", path, `${path} must be at most ${maxLength} characters`);
  }
  return text;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ArtifactValidationError(
      value === undefined ? "ARTIFACT_MISSING_FIELD" : "ARTIFACT_FIELD_TYPE",
      path,
      `${path} must be a number`,
    );
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ArtifactValidationError(
      value === undefined ? "ARTIFACT_MISSING_FIELD" : "ARTIFACT_FIELD_TYPE",
      path,
      `${path} must be a boolean`,
    );
  }
  return value;
}

function isoDateValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", path, `${path} must be an ISO timestamp`);
  }
  return text;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ArtifactValidationError(
      value === undefined ? "ARTIFACT_MISSING_FIELD" : "ARTIFACT_FIELD_TYPE",
      path,
      `${path} must be an array`,
    );
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  const array = requireArray(value, path);
  if (!array.every((item) => typeof item === "string")) {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", path, `${path} must be an array of strings`);
  }
  return array as string[];
}

function requireNonEmptyStringArray(value: unknown, path: string): string[] {
  const array = requireStringArray(value, path);
  if (array.length === 0 || array.some((item) => item.trim().length === 0)) {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", path, `${path} must include at least one non-empty string`);
  }
  return array;
}

function requireBrowserScreenshotsWhenRan(browserEvidence: Record<string, unknown>, path: string): void {
  if (browserEvidence.required === true && booleanValue(browserEvidence.ran, `${path}.ran`) === true) {
    try {
      requireNonEmptyStringArray(browserEvidence.screenshots, `${path}.screenshots`);
    } catch (error) {
      if (error instanceof ArtifactValidationError) {
        throw new ArtifactValidationError(
          "ARTIFACT_BROWSER_EVIDENCE_REQUIRED",
          `${path}.screenshots`,
          "browser evidence must include at least one screenshot or evidence image path",
        );
      }
      throw error;
    }
  }
}

function requireMatchingWorkspaceEvidence(value: unknown, path: string): void {
  const workspace = objectValue(value, path);
  requireString(workspace.path_checked, `${path}.path_checked`);
  requireString(workspace.expected_branch, `${path}.expected_branch`);
  requireString(workspace.observed_branch, `${path}.observed_branch`);
  requireString(workspace.expected_head_sha, `${path}.expected_head_sha`);
  requireString(workspace.observed_head_sha, `${path}.observed_head_sha`);
  if (booleanValue(workspace.matches_expected, `${path}.matches_expected`) !== true) {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", `${path}.matches_expected`, `${path}.matches_expected must be true`);
  }
}
