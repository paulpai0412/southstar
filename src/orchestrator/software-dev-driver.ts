import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { commandSpec, type CommandSpec } from "../adapters/platform/process.ts";
import {
  buildSoftwareDevAgentPrompt,
  buildSoftwareDevAgentTask,
  parseSoftwareDevAgentResult,
  type SoftwareDevAgentTaskInput,
} from "./software-dev-contract.ts";
import type { HostCapabilityReport } from "../adapters/host/capabilities.ts";
import { ArtifactValidationError, validateArtifactPayload } from "../runtime/artifacts.ts";
import { redactSecrets } from "../runtime/redaction.ts";
import type { HostAdapter, HostChildRunResult, StartBackgroundChildRequest, StartRootSessionRequest } from "../types/host.ts";
import type { RoleDefinition } from "../types/workflow.ts";
import type {
  DomainDriver,
  DomainDriverContext,
  FinalizeWorkerArtifactInput,
  PullRequestResult,
  RecoverDispatchBlockInput,
  RecoverVerifierArtifactInput,
  RefreshCompletedBaseInput,
  ReleaseResult,
  ReleaseSyncWorktreeResult,
  ReleaseVerifiedItemInput,
  StagePreparation,
  ExternalCompletionResult,
  VerifyPullRequestInput,
} from "./domain-driver.ts";

export interface SoftwareDevMetrics {
  software_dev_branch_reuse_cases: number;
  software_dev_retryable_effect_failures: number;
  software_dev_malformed_artifacts_rejected: number;
  software_dev_completed_reversals: number;
  software_dev_driver_live_completed: number;
  software_dev_driver_secret_leaks: number;
  software_dev_driver_shell_fallbacks: number;
  merge_conflicts_detected: number;
  merge_conflict_recovery_attempts: number;
  merge_conflict_recovered_prs_merged: number;
  merge_conflict_terminal_failures: number;
  resume_duplicate_prs_created: number;
  maxRecoveryAttempts?: number;
}

export interface SoftwareDevWorkspaceHints {
  projectRoot?: string;
  syncWorktreeDir?: string;
}

export interface SoftwareDevWorker {
  runImplementation(input: SoftwareDevWorkerInput): Promise<SoftwareDevWorkerResult>;
  runVerification(input: SoftwareDevVerificationInput): Promise<SoftwareDevWorkerResult>;
  runRelease(input: SoftwareDevReleaseInput): Promise<SoftwareDevWorkerResult>;
  dispose?(): Promise<void>;
}

export interface SoftwareDevWorkerRoleContext {
  role_name?: string;
  role?: RoleDefinition;
  timeout_ms?: number;
  on_stream_session_started?: (session: SoftwareDevStreamSession) => void | Promise<void>;
}

export interface SoftwareDevStreamSession {
  stream_adapter: HostCapabilityReport["host"];
  stream_session_id: string;
  stream_child_run_id?: string;
  stream_root_session_id?: string;
}

export interface SoftwareDevWorkerInput extends SoftwareDevWorkerRoleContext {
  issue_number: number;
  issue_url: string;
  repo: string;
  branch: string;
  worktree_path?: string;
  fixture_path: string;
  fixture_content: string;
  prompt: string;
  task_json?: SoftwareDevAgentTaskInput["task_json"];
  expected_artifact_kind?: SoftwareDevAgentTaskInput["expected_artifact_kind"];
}

export interface SoftwareDevVerificationInput extends SoftwareDevWorkerRoleContext {
  pr_number: number;
  pr_url: string;
  expected_fixture_path: string;
  worktree_path?: string;
  prompt: string;
  task_json?: SoftwareDevAgentTaskInput["task_json"];
  expected_artifact_kind?: SoftwareDevAgentTaskInput["expected_artifact_kind"];
}

export interface SoftwareDevReleaseInput extends SoftwareDevWorkerRoleContext {
  prompt: string;
  worktree_path?: string;
  task_json?: SoftwareDevAgentTaskInput["task_json"];
  expected_artifact_kind?: SoftwareDevAgentTaskInput["expected_artifact_kind"];
}

export interface SoftwareDevWorkerResult {
  root_session_id: string;
  child_run_id: string;
  session_id?: string;
  final_response: string;
  shell_fallbacks: 0;
  capability_report?: HostCapabilityReport;
}

export type VerifierArtifactErrorWithPullRequest = Error & { pullRequest?: PullRequestResult };

export interface SoftwareDevGitHubGateway {
  createFixtureBranch(input: {
    branch: string;
    base: string;
    path: string;
    content: string;
    message: string;
  }): Promise<{ branch: string; commit_sha: string }>;
  readBranchCommit(input: { branch: string }): Promise<{ branch: string; commit_sha: string }>;
  createPullRequest(input: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ number: number; html_url: string }>;
  createOrReusePullRequest?(input: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ number: number; html_url: string; reused?: boolean }>;
  mergePullRequest(input: { number: number; commit_title: string }): Promise<{ merged: boolean; sha: string }>;
  closeIssue(issueNumber: number): Promise<void>;
  findMergedPullRequestForIssue?(input: {
    issueNumber: number;
    branch: string;
    base: string;
  }): Promise<{
    number: number;
    html_url: string;
    merge_commit_sha?: string;
    head_sha?: string;
  } | undefined>;
}

export interface SoftwareDevWorktree {
  prepareIssueWorktree(input: { issueNumber: number; slug: string }): Promise<{ path: string; branch: string; baseCommit?: string }>;
  commitAndPush(input: { worktreePath: string; branch: string; message: string }): Promise<void | { commit_sha?: string; commitSha?: string }>;
  syncBaseBranch?(): Promise<{ path: string; commitSha: string }>;
}

export class SoftwareDevRetryableError extends Error {
  readonly code = "SOFTWARE_DEV_RETRYABLE_EFFECT_FAILURE";
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SoftwareDevRetryableError";
    this.cause = cause;
  }
}

export class SoftwareDevOperatorActionError extends Error {
  readonly code = "SOFTWARE_DEV_OPERATOR_ACTION_REQUIRED";
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SoftwareDevOperatorActionError";
    this.cause = cause;
  }
}

export class QueuedHostSessionBridge implements HostAdapter {
  private readonly runId: string;
  private readonly idGenerator: () => string;
  private readonly queue: Array<{
    rootSessionId: string;
    childRunId: string;
    sessionId: string;
    capabilityReport?: HostCapabilityReport;
  }> = [];
  private pending: {
    rootSessionId: string;
    childRunId: string;
    sessionId: string;
    status: "running" | "queued";
    capabilityReport?: HostCapabilityReport;
  } | undefined;
  private readonly knownRoots = new Map<string, "running" | "queued">();
  private readonly knownChildren = new Map<string, "running" | "queued">();

  constructor(options: { runId?: string; idGenerator?: () => string } = {}) {
    this.runId = normalizeSessionIdPart(options.runId ?? "northstar-runtime");
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  enqueue(run: {
    rootSessionId: string;
    childRunId: string;
    sessionId: string;
    capabilityReport?: HostCapabilityReport;
  }): void {
    this.queue.push({ ...run, status: "running" });
  }

  startRootSession(request: StartRootSessionRequest): { root_session_id: string } {
    this.pending = this.queue.shift();
    if (!this.pending) {
      const plannedId = this.plannedId(request);
      const rootSessionId = `planned-root:${plannedId}`;
      this.pending = {
        rootSessionId,
        childRunId: `planned-child:${plannedId}`,
        sessionId: rootSessionId,
        status: "queued",
      };
    }
    this.knownRoots.set(this.pending.rootSessionId, this.pending.status);
    return { root_session_id: this.pending.rootSessionId };
  }

  startBackgroundChild(request: StartBackgroundChildRequest): HostChildRunResult {
    if (!this.pending) throw new Error("Live host root session was not started before child dispatch");
    const run = this.pending;
    this.pending = undefined;
    this.knownRoots.set(request.root_session_id, run.status);
    this.knownChildren.set(run.childRunId, run.status);
    return {
      child_run_id: run.childRunId,
      root_session_id: request.root_session_id,
      session_id: run.sessionId,
      status: run.status,
      agent: request.role.agent,
      load_skills: request.role.load_skills,
      capability_report: run.capabilityReport,
    };
  }

  recordHeartbeat(): { status: "recorded" } {
    return { status: "recorded" };
  }

  readRootStatus(root_session_id: string): { status: "live" | "missing" } {
    if (this.knownRoots.has(root_session_id) || isPlannedRootSessionId(root_session_id)) {
      return { status: "live" };
    }
    return { status: "missing" };
  }

  readChildStatus(child_run_id: string): { status: string } {
    const status = this.knownChildren.get(child_run_id);
    if (status) return { status };
    if (isPlannedChildRunId(child_run_id)) return { status: "queued" };
    return { status: "missing" };
  }

  resumeHint(): string {
    return "live-sdk-session";
  }

  capabilities(): string[] {
    return ["sdk", "root-session", "background-child", "heartbeat"];
  }

  private plannedId(request: StartRootSessionRequest): string {
    const issue = normalizeSessionIdPart(request.issue_id);
    const stage = normalizeSessionIdPart(request.role_name);
    const nonce = normalizeSessionIdPart(this.idGenerator());
    return `${this.runId}:${issue}:${stage}:${nonce}`;
  }
}

function isPlannedRootSessionId(value: string): boolean {
  return /^planned-root:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/i.test(value);
}

function isPlannedChildRunId(value: string): boolean {
  return /^planned-child:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/i.test(value);
}

function normalizeSessionIdPart(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "unknown";
}

export class SoftwareDevDomainDriver implements DomainDriver {
  private readonly repo: string;
  private readonly kind: string;
  private readonly runId: string;
  // github gateway is retained in constructor for compatibility with existing dependency wiring.
  private readonly worker: SoftwareDevWorker;
  private readonly host: QueuedHostSessionBridge;
  private readonly metrics: SoftwareDevMetrics;
  private readonly baseBranch: string;
  private readonly workspaceHints: SoftwareDevWorkspaceHints;
  private branch = "";
  private fixturePath = "";
  private fixtureContent = "";
  private worktreePath = "";

  constructor(input: {
    repo: string;
    kind: string;
    runId: string;
    github: SoftwareDevGitHubGateway;
    worker: SoftwareDevWorker;
    host: QueuedHostSessionBridge;
    metrics: SoftwareDevMetrics;
    baseBranch?: string;
    worktree?: SoftwareDevWorktree;
    workspaceHints?: SoftwareDevWorkspaceHints;
  }) {
    this.repo = input.repo;
    this.kind = input.kind;
    this.runId = input.runId;
    this.worker = input.worker;
    this.host = input.host;
    this.metrics = input.metrics;
    initializeMergeConflictMetrics(this.metrics);
    this.baseBranch = input.baseBranch ?? "main";
    this.workspaceHints = input.workspaceHints ?? {};
  }

  async prepareStage(input: DomainDriverContext): Promise<StagePreparation> {
    this.fixturePath = "";
    this.fixtureContent = "";
    const slug = issueSlug(input.issue.number, input.issue.title);
    this.branch = stringField(input.runtimeContext.branch) ?? `northstar/${input.issue.number}`;
    this.worktreePath = stringField(input.runtimeContext.worktree_path) ?? `agent-owned://${this.kind}/${this.runId}/${slug}`;
    return { worktreePath: this.worktreePath, branch: this.branch };
  }

  async finalizeWorkerArtifact(input: FinalizeWorkerArtifactInput): Promise<PullRequestResult> {
    const implementationArtifact = await this.runImplementationWorker(input);
    if (!isImplementationResultArtifact(implementationArtifact)) {
      this.metrics.software_dev_malformed_artifacts_rejected += 1;
      throw new ArtifactValidationError(
        "ARTIFACT_UNKNOWN_KIND",
        "artifact_kind",
        "implementation worker must return implementation_result",
      );
    }

    return {
      ...prFromImplementationArtifact(implementationArtifact),
      workerArtifact: implementationArtifact,
    };
  }

  async verifyPullRequest(input: VerifyPullRequestInput): Promise<Record<string, unknown>> {
    const verificationRole = resolveVerificationRole(input);
    return await this.runAndValidateVerification(input, input.pullRequest, undefined, verificationRole);
  }

  async recoverVerifierArtifact(input: RecoverVerifierArtifactInput): Promise<PullRequestResult> {
    const verificationRole = resolveVerificationRole(input);
    const task = buildSoftwareDevAgentTask({
      taskKind: "verification",
      runId: this.runId,
      issueId: input.issue.id,
      stage: "verification",
      attempt: numericRuntimeAttempt(input.runtimeContext),
      repo: repoTaskMetadata(this.repo, this.baseBranch),
      workspace: workspaceTaskMetadata(this.worktreePath, this.branch, this.workspaceHints),
      issue: issueTaskMetadata(input),
      expectedArtifactKind: "verification_result",
    });
    const promptBase = buildSoftwareDevAgentStagePrompt(task, {
      context: input,
      branch: this.branch,
      expectedArtifactFields: ["browser_evidence"],
      artifactMetadata: {
        prNumber: input.pullRequest.prNumber,
        prUrl: input.pullRequest.prUrl,
        branch: input.pullRequest.branch,
        commitSha: input.pullRequest.commitSha,
      },
    });
    const prompt = [
      promptBase,
      "",
      "Recovery requirements:",
      "- Re-validate the existing pull request and workspace evidence.",
      "- Do not create a new pull request.",
      "- Return a schema-valid verification_result artifact.",
    ].join("\n");
    await this.runAndValidateVerification(input, input.pullRequest, prompt, verificationRole);
    return input.pullRequest;
  }

  async recoverDispatchBlock(_input: RecoverDispatchBlockInput): Promise<{ recovered: boolean; note?: string } | undefined> {
    return undefined;
  }

  private async runImplementationWorker(input: DomainDriverContext): Promise<Record<string, unknown>> {
    const task = buildSoftwareDevAgentTask({
      taskKind: "implementation",
      runId: this.runId,
      issueId: input.issue.id,
      stage: input.stage.name,
      attempt: numericRuntimeAttempt(input.runtimeContext),
      repo: repoTaskMetadata(this.repo, this.baseBranch),
      workspace: workspaceTaskMetadata(this.worktreePath, this.branch, this.workspaceHints),
      issue: issueTaskMetadata(input),
      expectedArtifactKind: "implementation_result",
    });
    const prompt = buildSoftwareDevAgentStagePrompt(task, {
      context: input,
      branch: this.branch,
      expectedArtifactFields: ["changed_files"],
    });
    const implementation = await this.worker.runImplementation({
      ...softwareDevWorkerRoleContext(input.role),
      on_stream_session_started: input.recordStreamSession,
      issue_number: input.issue.number,
      issue_url: input.issue.sourceUrl,
      repo: this.repo,
      branch: this.branch,
      worktree_path: this.worktreePath,
      fixture_path: this.fixturePath,
      fixture_content: this.fixtureContent,
      prompt,
      task_json: task,
      expected_artifact_kind: "implementation_result",
    });
    validateWorkerOutput(this.kind, "implementation", implementation.final_response, this.metrics);
    const artifact = parseImplementationArtifact(implementation.final_response, {
      issueNumber: input.issue.number,
      roleName: input.role.name,
    });
    this.metrics.software_dev_driver_shell_fallbacks += implementation.shell_fallbacks;
    return artifact;
  }


  async releaseVerifiedItem(input: ReleaseVerifiedItemInput): Promise<ReleaseResult> {
    const task = buildSoftwareDevAgentTask({
      taskKind: "release",
      runId: this.runId,
      issueId: input.issue.id,
      stage: input.stage.name,
      attempt: numericRuntimeAttempt(input.runtimeContext),
      repo: repoTaskMetadata(this.repo, this.baseBranch),
      workspace: workspaceTaskMetadata(this.worktreePath, this.branch, this.workspaceHints),
      issue: issueTaskMetadata(input),
      expectedArtifactKind: "release_result",
    });
    const prompt = buildSoftwareDevAgentStagePrompt(task, {
      context: input,
      branch: this.branch,
      expectedArtifactFields: ["release", "issue_update"],
      artifactMetadata: releaseArtifactMetadata(input),
    });
    const release = await this.worker.runRelease({
      ...softwareDevWorkerRoleContext(input.role),
      on_stream_session_started: input.recordStreamSession,
      prompt,
      worktree_path: this.worktreePath,
      task_json: task,
      expected_artifact_kind: "release_result",
    });
    validateWorkerOutput(this.kind, "release", release.final_response, this.metrics);
    const artifact = parseReleaseArtifact(release.final_response, {
      issueNumber: input.issue.number,
      roleName: input.role.name,
    });
    this.metrics.software_dev_driver_shell_fallbacks += release.shell_fallbacks;
    const releasePayload = objectRecord(artifact.release, "release");
    const issueUpdate = objectRecord(artifact.issue_update, "issue_update");
    return {
      confirmed: releasePayload.confirmed === true,
      mergeSha: stringFieldRequired(releasePayload.merge_commit, "release.merge_commit"),
      releaseArtifact: artifact,
      issueUpdate,
    };
  }


  async refreshCompletedBase(input: RefreshCompletedBaseInput): Promise<ReleaseSyncWorktreeResult> {
    return { status: "skipped", expectedCommit: input.mergeSha };
  }
  async reconcileExternalCompletion(_input: DomainDriverContext): Promise<ExternalCompletionResult | undefined> {
    return undefined;
  }



  private async runAndValidateVerification(
    input: DomainDriverContext,
    pullRequest: PullRequestResult,
    promptOverride?: string,
    verificationRole: DomainDriverContext["role"] = input.role,
  ): Promise<Record<string, unknown>> {
    const task = buildSoftwareDevAgentTask({
      taskKind: "verification",
      runId: this.runId,
      issueId: input.issue.id,
      stage: "verification",
      attempt: numericRuntimeAttempt(input.runtimeContext),
      repo: repoTaskMetadata(this.repo, this.baseBranch),
      workspace: workspaceTaskMetadata(this.worktreePath, this.branch),
      issue: issueTaskMetadata(input),
      expectedArtifactKind: "verification_result",
    });
    const prompt = promptOverride ?? buildSoftwareDevAgentStagePrompt(task, {
      context: input,
      branch: this.branch,
      expectedArtifactFields: ["browser_evidence"],
      artifactMetadata: {
        prNumber: pullRequest.prNumber,
        prUrl: pullRequest.prUrl,
        branch: pullRequest.branch,
        commitSha: pullRequest.commitSha,
      },
    });
    const verification = await this.worker.runVerification({
      ...softwareDevWorkerRoleContext(verificationRole),
      on_stream_session_started: input.recordStreamSession,
      pr_url: pullRequest.prUrl,
      expected_fixture_path: this.fixturePath,
      worktree_path: this.worktreePath,
      prompt,
      task_json: task,
      expected_artifact_kind: "verification_result",
    });
    try {
      validateWorkerOutput(this.kind, "verification", verification.final_response, this.metrics);
      const artifact = parseVerificationArtifact(verification.final_response, {
        issueNumber: input.issue.number,
        roleName: verificationRole.name,
      });
      validateVerifierArtifactIfBrowserRequired(input, artifact, this.metrics);
      this.metrics.software_dev_driver_shell_fallbacks += verification.shell_fallbacks;
      return artifact;
    } catch (error) {
      throw attachPullRequestToError(error, pullRequest);
    }
  }


}

export function buildSoftwareDevPrompt(input: {
  context: DomainDriverContext;
  worktreePath: string;
  branch: string;
  expectedArtifactFields: string[];
  artifactMetadata?: {
    prNumber?: number;
    prUrl?: string;
    branch?: string;
    commitSha?: string;
    baseBranch?: string;
    mergeSha?: string;
    recoveryReason?: string;
    recoveryAttempt?: number;
    maxRecoveryAttempts?: number;
  };
}): string {
  const template = typeof input.context.role.definition.prompt_template === "string"
    ? input.context.role.definition.prompt_template
    : [
      "Issue title: {{issue_title}}",
      "Issue body: {{issue_body}}",
      "Stage: {{stage_name}}",
      "Role: {{role_name}}",
      "Worktree path: {{worktree_path}}",
      "Branch: {{branch}}",
      "Expected artifact fields: {{expected_artifact_fields}}",
    ].join("\n");

  const expectedArtifactFields = canonicalArtifactFields(input.expectedArtifactFields);
  const retryContext = retryContextInstructions(input);
  const rendered = template
    .replaceAll("{{issue_title}}", input.context.issue.title)
    .replaceAll("{{issue_body}}", input.context.issue.body)
    .replaceAll("{{stage_name}}", input.context.stage.name)
    .replaceAll("{{role_name}}", input.context.role.name)
    .replaceAll("{{worktree_path}}", input.worktreePath)
    .replaceAll("{{branch}}", input.branch)
    .replaceAll("{{expected_artifact_fields}}", expectedArtifactFields.join(", "));
  return [
    rendered,
    "",
    ...retryContext,
    ...(retryContext.length > 0 ? [""] : []),
    ...artifactContractInstructions(input.expectedArtifactFields, input),
    "",
    "Production execution constraints:",
    "- Do not leave long-running foreground commands running. Do not run `npm run dev` as a foreground command.",
    "- Use build, unit, coverage, or Playwright commands that terminate.",
    "- If a dev server is required for browser tests, rely on the Playwright webServer config or start and stop it within the same command.",
    "- Do not merge pull requests from this worker stage.",
    "- Do not close GitHub issues from this worker stage.",
    "- Do not change GitHub Project terminal fields from this worker stage.",
    "- Only Northstar's release stage may merge PRs or close issues. Treat acceptance criteria mentioning merged PRs or closed issues as release-stage responsibilities.",
    "- Before final response, stop any server process you started and summarize the terminating verification commands you ran.",
  ].join("\n");
}

function prFromImplementationArtifact(payload: Record<string, unknown>): PullRequestResult {
  const pr = objectRecord(payload.pr, "pr");
  return {
    prNumber: numberFieldRequired(pr.number, "pr.number"),
    prUrl: stringFieldRequired(pr.url, "pr.url"),
    branch: typeof pr.head_ref === "string" ? pr.head_ref : "",
    commitSha: typeof pr.head_sha === "string" ? pr.head_sha : "",
  };
}

function isImplementationResultArtifact(payload: Record<string, unknown>): boolean {
  const pr = payload.pr;
  return typeof pr === "object" && pr !== null && !Array.isArray(pr);
}

function objectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function numberFieldRequired(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

function stringFieldRequired(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function numericRuntimeAttempt(runtimeContext: Record<string, unknown>): number {
  const exception = runtimeContext.exception;
  if (typeof exception === "object" && exception !== null && !Array.isArray(exception)) {
    const attempt = (exception as Record<string, unknown>).attempt_count;
    if (typeof attempt === "number" && Number.isFinite(attempt) && attempt >= 1) {
      return attempt;
    }
  }
  return 1;
}

function buildSoftwareDevAgentStagePrompt(task: SoftwareDevAgentTaskInput["task_json"], input: {
  context: DomainDriverContext;
  branch: string;
  expectedArtifactFields: string[];
  artifactMetadata?: {
    prNumber?: number;
    prUrl?: string;
    branch?: string;
    commitSha?: string;
    baseBranch?: string;
    mergeSha?: string;
    recoveryReason?: string;
    recoveryAttempt?: number;
    maxRecoveryAttempts?: number;
  };
}): string {
  const retryContext = retryContextInstructions(input);
  return [
    buildSoftwareDevAgentPrompt(task),
    "",
    ...retryContext,
    ...(retryContext.length > 0 ? [""] : []),
    ...artifactContractInstructions(input.expectedArtifactFields, input),
  ].join("\n");
}

function releaseArtifactMetadata(input: ReleaseVerifiedItemInput): {
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  commitSha?: string;
  mergeSha?: string;
} {
  const releaseMetadata = input.releaseMetadata ?? {};
  return {
    prNumber: numberField(releaseMetadata.prNumber),
    prUrl: stringField(releaseMetadata.prUrl),
    branch: stringField(releaseMetadata.branch),
    commitSha: stringField(releaseMetadata.commitSha),
    mergeSha: stringField(releaseMetadata.mergeSha),
  };
}

function repoTaskMetadata(repo: string, baseBranch: string) {
  return {
    provider: "github" as const,
    name: repo,
    url: `https://github.com/${repo}`,
    base_branch: baseBranch,
  };
}

function workspaceTaskMetadata(workspaceUri: string, branch: string, hints: SoftwareDevWorkspaceHints = {}) {
  const slug = workspaceUri.split("/").at(-1) ?? "issue";
  const projectRoot = hints.projectRoot;
  const syncWorktreePath = projectRoot && hints.syncWorktreeDir
    ? resolve(projectRoot, hints.syncWorktreeDir)
    : undefined;
  return {
    workspace_uri: workspaceUri,
    branch,
    worktree_path_hint: `.northstar/runtime/worktrees/${slug}`,
    ...(projectRoot ? { project_root_path: projectRoot } : {}),
    ...(syncWorktreePath ? { sync_worktree_path_hint: syncWorktreePath } : {}),
  };
}

function issueSlug(issueNumber: number, title: string): string {
  const titleSlug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return titleSlug ? `issue-${issueNumber}-${titleSlug}` : `issue-${issueNumber}`;
}

function issueTaskMetadata(input: DomainDriverContext) {
  return {
    number: input.issue.number,
    title: input.issue.title,
    body: input.issue.body,
    url: input.issue.sourceUrl,
  };
}

function resolveVerificationRole(context: DomainDriverContext): DomainDriverContext["role"] {
  if (context.role.name === "verifier_agent") return context.role;

  if (context.role.name === "implementation_agent" || context.stage.name === "implementation") {
    return {
      name: "verifier_agent",
      definition: {
        ...context.role.definition,
        agent: "review",
      },
    };
  }

  return context.role;
}

function softwareDevWorkerRoleContext(role: DomainDriverContext["role"]): SoftwareDevWorkerRoleContext {
  return {
    role_name: role.name,
    role: role.definition,
    timeout_ms: role.definition.timeout_seconds * 1000,
  };
}

function canonicalArtifactFields(expectedArtifactFields: string[]): string[] {
  if (expectedArtifactFields.includes("browser_evidence")) {
    return [
      "schema_version",
      "artifact_kind",
      "issue_number",
      "role",
      "status",
      "observed_at",
      "summary",
      "retryable",
      "pr_number",
      "base_branch",
      "gate_results",
      "verifier",
      "browser_required",
      "browser_evidence",
    ];
  }
  if (expectedArtifactFields.includes("changed_files")) {
    return [
      "schema_version",
      "artifact_kind",
      "issue_number",
      "role",
      "status",
      "observed_at",
      "summary",
      "retryable",
      "branch",
      "base_branch",
      "commit_sha",
      "changed_files",
      "commands_run",
      "test_summary",
      "self_check_summary",
    ];
  }
  if (expectedArtifactFields.includes("merge_status") || expectedArtifactFields.includes("merged_sha")) {
    return [
      "schema_version",
      "artifact_kind",
      "issue_number",
      "role",
      "status",
      "observed_at",
      "summary",
      "retryable",
      "pr_number",
      "merge_status",
      "merged_sha",
    ];
  }
  return expectedArtifactFields;
}

function retryContextInstructions(input: {
  context: DomainDriverContext;
  artifactMetadata?: {
    prNumber?: number;
    prUrl?: string;
    branch?: string;
    commitSha?: string;
    recoveryReason?: string;
    recoveryAttempt?: number;
    maxRecoveryAttempts?: number;
  };
}): string[] {
  const lines: string[] = [];
  const recoveryReason = sanitizedString(input.artifactMetadata?.recoveryReason);
  if (recoveryReason) lines.push(`- Recovery reason: ${recoveryReason}`);

  const lastError = firstSanitizedString(
    input.context.runtimeContext.last_error,
    exceptionCarryForwardField(input.context.runtimeContext, "error"),
  );
  if (lastError) lines.push(`- Previous failure: ${lastError}`);

  const verifierFeedback = sanitizedListSummary(
    exceptionCarryForwardField(input.context.runtimeContext, "feedback_for_implementation"),
  );
  if (verifierFeedback) lines.push(`- Verifier feedback: ${verifierFeedback}`);

  const releaseFeedback = sanitizedListSummary(
    exceptionCarryForwardField(input.context.runtimeContext, "feedback_for_release"),
  );
  if (releaseFeedback) lines.push(`- Release feedback: ${releaseFeedback}`);

  lines.push(...releaseCarryForwardLines(exceptionCarryForwardField(input.context.runtimeContext, "release_context")));

  const retryCount = numericRuntimeValue(input.context.runtimeContext.retry_count)
    ?? numericRuntimeValue(exceptionField(input.context.runtimeContext, "attempt_count"));
  if (retryCount !== undefined) lines.push(`- Retry count: ${retryCount}`);

  if (
    input.artifactMetadata?.recoveryAttempt !== undefined
    && input.artifactMetadata?.maxRecoveryAttempts !== undefined
  ) {
    lines.push(`- Recovery attempt: ${input.artifactMetadata.recoveryAttempt} of ${input.artifactMetadata.maxRecoveryAttempts}`);
  }

  const blockedBy = blockedBySummary(input.context.runtimeContext.blocked_by);
  if (blockedBy) lines.push(`- Blocked by: ${blockedBy}`);

  const pr = pullRequestPromptContext(input.context.runtimeContext, input.artifactMetadata);
  if (pr) {
    lines.push(`- Existing PR: #${pr.prNumber}${pr.prUrl ? ` ${pr.prUrl}` : ""}`);
    if (pr.branch) lines.push(`- Existing PR branch: ${pr.branch}`);
    if (pr.commitSha) lines.push(`- Existing PR head commit: ${pr.commitSha}`);
  }

  return lines.length > 0 ? ["Retry/recovery context:", ...lines] : [];
}

function sanitizedString(value: unknown): string {
  if (typeof value !== "string") return "";
  return redactSecrets(value).trim();
}

function firstSanitizedString(...values: unknown[]): string {
  for (const value of values) {
    const sanitized = sanitizedString(value);
    if (sanitized.length > 0) return sanitized;
  }
  return "";
}

function sanitizedListSummary(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(sanitizedString).filter((item) => item.length > 0).join("; ");
  }
  return sanitizedString(value);
}

function releaseCarryForwardLines(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const context = value as Record<string, unknown>;
  return [
    ["Release merge commit", context.merge_commit],
    ["Release local head", context.local_head],
    ["Release remote head", context.remote_head],
    ["Release worktree cleanup path", context.worktree_cleanup_path],
  ].flatMap(([label, item]) => {
    const text = sanitizedString(item);
    return text ? [`- ${label}: ${text}`] : [];
  });
}

function numericRuntimeValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function exceptionCarryForwardField(runtimeContext: DomainDriverContext["runtimeContext"], field: string): unknown {
  const carryForward = runtimeContext.exception_carry_forward;
  if (typeof carryForward !== "object" || carryForward === null || Array.isArray(carryForward)) return undefined;
  return (carryForward as Record<string, unknown>)[field];
}

function exceptionField(runtimeContext: DomainDriverContext["runtimeContext"], field: string): unknown {
  const exception = runtimeContext.exception;
  if (typeof exception !== "object" || exception === null || Array.isArray(exception)) return undefined;
  return (exception as Record<string, unknown>)[field];
}

function blockedBySummary(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).filter((item) => item.length > 0).join(", ");
  return sanitizedString(value);
}

function pullRequestPromptContext(
  runtimeContext: DomainDriverContext["runtimeContext"],
  metadata?: {
    prNumber?: number;
    prUrl?: string;
    branch?: string;
    commitSha?: string;
  },
): { prNumber: number; prUrl?: string; branch?: string; commitSha?: string } | undefined {
  const runtimePr = runtimeContext.pr;
  const runtimeRecord = typeof runtimePr === "object" && runtimePr !== null && !Array.isArray(runtimePr)
    ? runtimePr as Record<string, unknown>
    : {};
  const prNumber = metadata?.prNumber ?? numberField(runtimeRecord.prNumber);
  if (!prNumber) return undefined;
  return {
    prNumber,
    prUrl: metadata?.prUrl ?? stringField(runtimeRecord.prUrl),
    branch: metadata?.branch ?? stringField(runtimeRecord.branch),
    commitSha: metadata?.commitSha ?? stringField(runtimeRecord.commitSha ?? runtimeRecord.headCommit),
  };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? redactSecrets(value) : undefined;
}

function artifactContractInstructions(expectedArtifactFields: string[], input: {
  context: DomainDriverContext;
  branch: string;
  artifactMetadata?: {
    prNumber?: number;
    prUrl?: string;
    branch?: string;
    commitSha?: string;
    baseBranch?: string;
    mergeSha?: string;
    recoveryReason?: string;
    recoveryAttempt?: number;
    maxRecoveryAttempts?: number;
  };
}): string[] {
  const issueNumber = input.context.issue.number;
  const prNumber = input.artifactMetadata?.prNumber ?? prNumberFromRuntimeContext(input.context.runtimeContext) ?? 1;
  const mergeSha = input.artifactMetadata?.mergeSha ?? "0000000000000000000000000000000000000000";
  const baseBranch = input.artifactMetadata?.baseBranch ?? "main";
  const issueWorktreePath = `.northstar/runtime/worktrees/${issueSlug(issueNumber, input.context.issue.title)}`;

  if (expectedArtifactFields.includes("browser_evidence")) {
    return [
      "Final response contract:",
      "- Return exactly one JSON object as the final response.",
      "- Do not wrap the JSON in Markdown fences, prose, links, or file paths.",
      "- Before returning, self-check that the JSON parses as one object and that schema_version, artifact_kind, issue_number, role, status, observed_at, summary, and retryable are present.",
      "- Before returning, self-check that artifact_kind, issue_number, and role exactly match the Task JSON expected_output and issue/role identity.",
      "- Before returning, self-check that no raw logs, transcripts, browser traces, terminal logs, full logs, or secrets are included.",
      "- Set artifact_kind to verification_result.",
      "- Allowed status values: pass, blocked, failed_retryable, failed_terminal.",
      "- For status blocked or failed_retryable, set retryable=true. For pass or failed_terminal, set retryable=false.",
      "- Always include workspace_evidence with path_checked, expected_branch, observed_branch, expected_head_sha, observed_head_sha, and matches_expected.",
      "- For status pass, workspace_evidence.matches_expected must be true and release_recommendation must be ready_for_release.",
      "- For status failed_retryable, set failure_owner to implementation or release.",
      "- For status failed_retryable with failure_owner=implementation, include feedback_for_implementation as a non-empty array of actionable implementation fixes.",
      "- For status failed_retryable with failure_owner=release, include feedback_for_release as a non-empty array of actionable release fixes.",
      "- Use failure_owner=release for PR mergeability, branch drift, GitHub merge status, or release readiness problems when functional review, browser evidence, build/tests, and workspace evidence otherwise pass.",
      "- If browser acceptance is required and browser_evidence.ran is true, browser_evidence.tests_passed must be a positive number and browser_evidence.screenshots must include at least one screenshot or evidence image path.",
      "Canonical verification_result JSON example:",
      JSON.stringify({
        schema_version: "1.0",
        artifact_kind: "verification_result",
        issue_number: issueNumber,
        role: "verifier_agent",
        status: "pass",
        observed_at: "2026-06-02T00:00:00.000Z",
        summary: "verification passed",
        retryable: false,
        review: { requirements_passed: true, code_review_passed: true },
        functional_review: { required: false, status: "pass" },
        browser_evidence: { required: false, ran: true, tests_passed: 1, screenshots: ["evidence/browser.png"] },
        workspace_evidence: {
          path_checked: issueWorktreePath,
          expected_branch: input.branch,
          observed_branch: input.branch,
          expected_head_sha: input.artifactMetadata?.commitSha ?? "0000000000000000000000000000000000000000",
          observed_head_sha: input.artifactMetadata?.commitSha ?? "0000000000000000000000000000000000000000",
          matches_expected: true,
        },
        release_recommendation: "ready_for_release",
      }, null, 2),
    ];
  }

  if (expectedArtifactFields.includes("changed_files")) {
    return [
      "Final response contract:",
      "- Return exactly one JSON object as the final response.",
      "- Do not wrap the JSON in Markdown fences, prose, links, or file paths.",
      "- Before returning, self-check that the JSON parses as one object and that schema_version, artifact_kind, issue_number, role, status, observed_at, summary, and retryable are present.",
      "- Before returning, self-check that artifact_kind, issue_number, and role exactly match the Task JSON expected_output and issue/role identity.",
      "- Before returning, self-check that no raw logs, transcripts, browser traces, terminal logs, full logs, or secrets are included.",
      "- Set artifact_kind to implementation_result.",
      "- Allowed status values: ready_for_verification, blocked, failed_retryable, failed_terminal.",
      "- For status blocked or failed_retryable, set retryable=true. For ready_for_verification or failed_terminal, set retryable=false.",
      "- For status ready_for_verification, include workspace_evidence proving task.workspace.worktree_path_hint is on task.workspace.branch at the PR head commit with matches_expected=true.",
      "- For status ready_for_verification, workspace_evidence.base_source must identify the fetched remote base or managed sync workspace used to create/reuse the issue branch, such as origin/main or task.workspace.sync_worktree_path_hint, and workspace_evidence.base_commit must include that base commit SHA.",
      "Canonical implementation_result JSON example:",
      JSON.stringify({
        schema_version: "1.0",
        artifact_kind: "implementation_result",
        issue_number: issueNumber,
        role: "implementation_agent",
        status: "ready_for_verification",
        observed_at: "2026-06-02T00:00:00.000Z",
        summary: "implementation complete",
        retryable: false,
        pr: {
          url: `https://github.com/example/repo/pull/${prNumber}`,
          number: prNumber,
          head_ref: input.branch,
          head_sha: "0000000000000000000000000000000000000000",
        },
        changed_files: ["src/example.ts"],
        commands_run: [{ command: "npm test", status: "passed" }],
        self_check_summary: "implementation verified",
        evidence: [{ type: "test", value: "npm test" }],
        workspace_evidence: {
          path_checked: issueWorktreePath,
          base_source: `origin/${input.baseBranch}`,
          base_commit: "0000000000000000000000000000000000000000",
          expected_branch: input.branch,
          observed_branch: input.branch,
          expected_head_sha: "0000000000000000000000000000000000000000",
          observed_head_sha: "0000000000000000000000000000000000000000",
          matches_expected: true,
        },
      }, null, 2),
    ];
  }

  if (
    expectedArtifactFields.includes("merge_status")
    || expectedArtifactFields.includes("merged_sha")
    || expectedArtifactFields.includes("release")
    || expectedArtifactFields.includes("issue_update")
  ) {
    return [
      "Final response contract:",
      "- Return exactly one JSON object as the final response.",
      "- Do not wrap the JSON in Markdown fences, prose, links, or file paths.",
      "- Before returning, self-check that the JSON parses as one object and that schema_version, artifact_kind, issue_number, role, status, observed_at, summary, and retryable are present.",
      "- Before returning, self-check that artifact_kind, issue_number, and role exactly match the Task JSON expected_output and issue/role identity.",
      "- Before returning, self-check that no raw logs, transcripts, browser traces, terminal logs, full logs, or secrets are included.",
      "- Set artifact_kind to release_result.",
      "- Allowed status values: completed, blocked, failed_retryable, failed_terminal.",
      "- For status blocked or failed_retryable, set retryable=true. For completed or failed_terminal, set retryable=false.",
      "- For status completed, release.confirmed must be true and issue_update.comment_summary must be present.",
      "- For status completed, release.local_sync.synced must be true, release.local_sync.matches_remote must be true, and release.local_sync must include base_branch, local_head, and remote_head.",
      "- For status completed, release.local_sync is the required detached managed sync workspace state. A stale or unsynced project root must not make completed fail when release.local_sync is current.",
      "- For status completed, release.repo_root_sync.status must be synced, skipped, or failed_retryable. If status is skipped or failed_retryable, release.repo_root_sync.reason must explain why the project root was not synced.",
      "- For status completed, release.worktree_cleanup.removed must be true and release.worktree_cleanup.path must identify the removed issue worktree.",
      "- The release worker must merge the PR into the configured base branch, sync the detached managed local base workspace to the remote base branch, attempt best-effort project root sync, remove the issue worktree, and self-check these release fields before returning.",
      "Canonical release_result JSON example:",
      JSON.stringify({
        schema_version: "1.0",
        artifact_kind: "release_result",
        issue_number: issueNumber,
        role: "release_agent",
        status: "completed",
        observed_at: "2026-06-02T00:00:00.000Z",
        summary: "release completed",
        retryable: false,
        release: {
          confirmed: true,
          merge_commit: mergeSha,
          local_sync: {
            base_branch: baseBranch,
            synced: true,
            local_head: mergeSha,
            remote_head: mergeSha,
            matches_remote: true,
          },
          repo_root_sync: {
            status: "skipped",
            reason: "repo_root_dirty",
          },
          worktree_cleanup: {
            path: issueWorktreePath,
            removed: true,
          },
        },
        issue_update: {
          comment_summary: `Released via PR #${prNumber}.`,
          close_issue: true,
          labels_to_add: ["northstar:released"],
          labels_to_remove: ["northstar:ready"],
        },
        evidence: [
          { type: "merge_commit", value: mergeSha },
          { type: "local_remote_sync", value: `${baseBranch} at ${mergeSha}` },
          { type: "worktree_cleanup", value: `removed ${issueWorktreePath}` },
        ],
      }, null, 2),
    ];
  }

  return [
    "Final response contract:",
    "- Return exactly one JSON object as the final response.",
    "- Do not wrap the JSON in Markdown fences, prose, links, or file paths.",
    "- Before returning, self-check that the JSON parses as one object and that schema_version, artifact_kind, issue_number, role, status, observed_at, summary, and retryable are present.",
    "- Before returning, self-check that artifact_kind, issue_number, and role exactly match the Task JSON expected_output and issue/role identity.",
    "- Before returning, self-check that no raw logs, transcripts, browser traces, terminal logs, full logs, or secrets are included.",
    `- Required fields: ${expectedArtifactFields.join(", ")}.`,
  ];
}


function prNumberFromRuntimeContext(runtimeContext: DomainDriverContext["runtimeContext"]): number | undefined {
  const pr = runtimeContext.pr;
  if (typeof pr === "object" && pr !== null && !Array.isArray(pr)) {
    const value = (pr as { prNumber?: unknown }).prNumber;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

export function validateWorkerOutput(kind: string, role: string, finalResponse: string, metrics: SoftwareDevMetrics): void {
  if (finalResponse.trim().length === 0) {
    metrics.software_dev_malformed_artifacts_rejected += 1;
    throw new Error(`${kind} ${role} worker returned an empty response`);
  }
  if (/(^|[^A-Za-z0-9])(gh[opsu]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})($|[^A-Za-z0-9_-])/i.test(finalResponse)) {
    metrics.software_dev_malformed_artifacts_rejected += 1;
    metrics.software_dev_driver_secret_leaks += 1;
    throw new Error(`${kind} ${role} worker response contained a secret-shaped value`);
  }
}

function validateVerifierArtifactIfBrowserRequired(
  context: DomainDriverContext,
  artifact: Record<string, unknown>,
  metrics: SoftwareDevMetrics,
): void {
  if (!browserAcceptanceRequired(context)) return;
  try {
    validateArtifactPayload({ ...artifact, browser_required: true });
  } catch (error) {
    if (error instanceof ArtifactValidationError) {
      metrics.software_dev_malformed_artifacts_rejected += 1;
    }
    throw error;
  }
}


function parseImplementationArtifact(
  finalResponse: string,
  expected: { issueNumber: number; roleName: string },
): Record<string, unknown> {
  return parseSoftwareDevAgentResult(finalResponse, {
    expectedArtifactKind: "implementation_result",
    issueNumber: expected.issueNumber,
    role: expected.roleName,
  }).payload;
}

function parseVerificationArtifact(
  finalResponse: string,
  expected: { issueNumber: number; roleName: string },
): Record<string, unknown> {
  return parseSoftwareDevAgentResult(finalResponse, {
    expectedArtifactKind: "verification_result",
    issueNumber: expected.issueNumber,
    role: expected.roleName,
  }).payload;
}

function parseReleaseArtifact(
  finalResponse: string,
  expected: { issueNumber: number; roleName: string },
): Record<string, unknown> {
  return parseSoftwareDevAgentResult(finalResponse, {
    expectedArtifactKind: "release_result",
    issueNumber: expected.issueNumber,
    role: expected.roleName,
  }).payload;
}

function attachPullRequestToError(error: unknown, pullRequest: PullRequestResult): VerifierArtifactErrorWithPullRequest {
  if (error instanceof Error) {
    (error as VerifierArtifactErrorWithPullRequest).pullRequest = pullRequest;
    return error as VerifierArtifactErrorWithPullRequest;
  }
  const wrapped = new Error(String(error)) as VerifierArtifactErrorWithPullRequest;
  wrapped.pullRequest = pullRequest;
  return wrapped;
}


function browserAcceptanceRequired(context: DomainDriverContext): boolean {
  const runtimeContext = context.runtimeContext as Record<string, unknown>;
  if (runtimeContext.browser_required === true || runtimeContext.browser_acceptance_required === true) return true;
  return browserAcceptanceMarkerPattern.test(`${context.issue.body}\n${runtimeContextText(runtimeContext)}`);
}

const browserAcceptanceMarkerPattern = /\b(browser acceptance|browser_required|browser required|verify\b[^.]{0,80}\bbrowser|playwright|screenshot)\b/i;

function runtimeContextText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(runtimeContextText).join("\n");
  if (typeof value === "object" && value !== null) {
    return Object.values(value).map(runtimeContextText).join("\n");
  }
  return "";
}

export function createSoftwareDevCommandPlan(input: {
  projectRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  commitMessage: string;
}): { commands: CommandSpec[] } {
  return {
    commands: [
      commandSpec("git", ["worktree", "add", "-b", input.branch, input.worktreePath, input.baseBranch]),
      commandSpec("git", ["-C", input.worktreePath, "add", "-A"]),
      commandSpec("git", ["-C", input.worktreePath, "commit", "-m", input.commitMessage]),
      commandSpec("git", ["-C", input.worktreePath, "push", "origin", input.branch]),
    ],
  };
}


function initializeMergeConflictMetrics(metrics: SoftwareDevMetrics): void {
  metrics.merge_conflicts_detected ??= 0;
  metrics.merge_conflict_recovery_attempts ??= 0;
  metrics.merge_conflict_recovered_prs_merged ??= 0;
  metrics.merge_conflict_terminal_failures ??= 0;
  metrics.resume_duplicate_prs_created ??= 0;
}
