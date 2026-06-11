import { tmpdir } from "node:os";
import path from "node:path";
import type { HostCapabilityReport } from "../adapters/host/capabilities.ts";
import type { RuntimeContext } from "../types/control-plane.ts";
import type { RoleDefinition, WorkflowDefinition } from "../types/workflow.ts";

export interface StagePreparation {
  worktreePath: string;
  branch: string;
}

export interface PullRequestResult {
  prNumber: number;
  prUrl: string;
  branch: string;
  commitSha: string;
  workerArtifact?: Record<string, unknown>;
  verifierArtifact?: Record<string, unknown>;
}

export interface ReleaseSyncWorktreeResult {
  status: "synced" | "failed" | "skipped";
  path?: string;
  headCommit?: string;
  expectedCommit?: string;
  code?: string;
  lastError?: string;
  retryable?: boolean;
}

export interface ReleaseResult {
  confirmed: boolean;
  mergeSha: string;
  syncWorktree?: ReleaseSyncWorktreeResult;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  commitSha?: string;
  releaseArtifact?: Record<string, unknown>;
  issueUpdate?: Record<string, unknown>;
}

export interface ExternalCompletionResult {
  completed: boolean;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  commitSha?: string;
  mergeSha?: string;
}

export interface DomainIssueContext {
  id: string;
  number: number;
  title: string;
  body: string;
  sourceUrl: string;
}

export interface DomainWorkflowContext {
  id: string;
  domain?: string;
}

export interface DomainStageContext {
  name: string;
}

export interface DomainRoleContext {
  name: string;
  definition: RoleDefinition;
}

export interface DomainStreamSessionRecord {
  stream_adapter: HostCapabilityReport["host"];
  stream_session_id: string;
  stream_child_run_id?: string;
  stream_root_session_id?: string;
}

export interface DomainDriverContext {
  issue: DomainIssueContext;
  workflow: DomainWorkflowContext;
  stage: DomainStageContext;
  role: DomainRoleContext;
  runtimeContext: RuntimeContext;
  recordStreamSession?: (session: DomainStreamSessionRecord) => void | Promise<void>;
}

export interface FinalizeWorkerArtifactInput extends DomainDriverContext {
  branch: string;
  changedFiles: string[];
}

export interface ReleaseVerifiedItemInput extends DomainDriverContext {
  releaseMetadata?: Record<string, unknown>;
}

export interface RecoverVerifierArtifactInput extends DomainDriverContext {
  pullRequest: PullRequestResult;
}

export interface VerifyPullRequestInput extends DomainDriverContext {
  pullRequest: PullRequestResult;
}

export interface RecoverDispatchBlockInput extends DomainDriverContext {
  blocker: string;
  blockedErrorCode?: string;
}

export interface RefreshCompletedBaseInput extends DomainDriverContext {
  mergeSha: string;
}

export interface DomainDriver {
  prepareStage(input: DomainDriverContext): Promise<StagePreparation>;
  finalizeWorkerArtifact(input: FinalizeWorkerArtifactInput): Promise<PullRequestResult>;
  verifyPullRequest?(input: VerifyPullRequestInput): Promise<Record<string, unknown> | undefined>;
  releaseVerifiedItem(input: ReleaseVerifiedItemInput): Promise<ReleaseResult>;
  recoverVerifierArtifact?(input: RecoverVerifierArtifactInput): Promise<PullRequestResult>;
  recoverDispatchBlock?(input: RecoverDispatchBlockInput): Promise<{ recovered: boolean; note?: string } | undefined>;
  reconcileExternalCompletion?(input: DomainDriverContext): Promise<ExternalCompletionResult | undefined>;
  refreshCompletedBase?(input: RefreshCompletedBaseInput): Promise<ReleaseSyncWorktreeResult | undefined>;
}

export class FakeDomainDriver implements DomainDriver {
  readonly metrics = { domain_driver_dispatches: 0 };

  async prepareStage(input: DomainDriverContext): Promise<StagePreparation> {
    this.metrics.domain_driver_dispatches += 1;
    const issueSlug = input.issue.id.replace(/[^a-z0-9-]/gi, "-");
    return {
      worktreePath: path.join(tmpdir(), "northstar", issueSlug),
      branch: `northstar/${input.issue.number}-${input.stage.name}`,
    };
  }

  async finalizeWorkerArtifact(input: FinalizeWorkerArtifactInput): Promise<PullRequestResult> {
    this.metrics.domain_driver_dispatches += 1;
    return {
      prNumber: 1,
      prUrl: `https://github.test/${input.issue.id}/pull/1`,
      branch: input.branch,
      commitSha: "fake-commit-sha",
    };
  }

  async releaseVerifiedItem(input: ReleaseVerifiedItemInput): Promise<ReleaseResult> {
    this.metrics.domain_driver_dispatches += 1;
    const prNumber = Number(input.releaseMetadata?.prNumber ?? 1);
    return {
      confirmed: true,
      mergeSha: `merge-${prNumber}`,
    };
  }
}
