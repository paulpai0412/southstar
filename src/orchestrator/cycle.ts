import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeRuntimePath } from "../adapters/platform/paths.ts";
import { projectStatusForLifecycle } from "../adapters/github/project-v2.ts";
import type { RuntimeConfig } from "../config/schema.ts";
import { issuePacketId, type IssuePacket } from "../intake/types.ts";
import { ArtifactValidationError } from "../runtime/artifacts.ts";
import { releaseActiveRuntimeOwnership, repairSnapshot } from "../runtime/repair.ts";
import { resolveExceptionPolicy } from "../runtime/exception-policy.ts";
import { activeLifecycleStates, applyRuntimeEvents, terminalLifecycleStates, type RuntimeEvent } from "../runtime/state-machine.ts";
import { SqliteControlPlaneStore } from "../runtime/store.ts";
import type { HistoryEntry, IssueSnapshot, RuntimeContext } from "../types/control-plane.ts";
import type { HostAdapter } from "../types/host.ts";
import { loadWorkflow, type RoleDefinition, type WorkflowDefinition } from "../types/workflow.ts";
import type { DomainDriverContext, DomainStreamSessionRecord, PullRequestResult, ReleaseResult, ReleaseSyncWorktreeResult } from "./domain-driver.ts";
import type { DomainDriver } from "./domain-driver.ts";
import { parseIssueDependencyMetadata } from "./dependencies.ts";
import { dispatchStageRoot } from "./host-dispatch.ts";
import { claimAndStartRelease, claimAndStartStage, submitChildArtifactPayload, submitConfirmedRelease, submitExternalMerge, submitPullRequestRecorded, submitSyncWorktreeRefreshResult, submitVerifierArtifact, submitWorkerArtifact } from "./issue-flow.ts";
import { inspectIssueSnapshot } from "./inspect.ts";
import { emptyManualCliMetrics } from "./metrics.ts";
import { resolveProductionWorkflowPath } from "./workflow-path.ts";
import { scheduleReadyIssues } from "./scheduler.ts";
import {
  planCompletedWorktreeCleanup,
  runCompletedWorktreeCleanup,
  type CompletedWorktreeCleanupPolicy,
  type ManagedWorktreeCleanup,
} from "./worktree-cleanup.ts";

export function createProductionOrchestrator(options: {
  store: SqliteControlPlaneStore;
  host: HostAdapter;
  domain: DomainDriver;
  workflowPath: string;
  now: () => string;
  leaseTimeoutSeconds: number;
  heartbeatIntervalSeconds?: number;
  roleOverrides: Record<string, Record<string, unknown>>;
  observability?: ProductionObservability;
  projectId?: string;
  progress?: ProductionProgressReporter;
  externalCompletionEnabled?: boolean;
  issueSource?: ProductionIssueSource;
  cleanupPolicy?: CompletedWorktreeCleanupPolicy;
  cleanup?: ManagedWorktreeCleanup;
  projectRoot?: string;
  worktreesDir?: string;
  maxRecoveryAttempts?: number;
}) {
  const workflow = loadWorkflow(options.workflowPath);
  const manual = emptyManualCliMetrics();

  return {
    async intakeIssue(input: { issueNumber: number; title: string; body: string; sourceUrl: string; labels: string[] }) {
      const metadata = parseIssueDependencyMetadata(input.body);
      const packet: IssuePacket = {
        issue_number: String(input.issueNumber),
        title: input.title,
        source: "github",
        source_url: input.sourceUrl,
        branch: `northstar/${input.issueNumber}`,
        base_branch: "main",
        labels: input.labels,
        dependencies: metadata.dependsOn.map(String),
        raw_text: input.body,
        ready_for_agent: true,
      };

      options.store.upsertIssuePacket(packet);
      const snapshot = options.store.getIssue(issuePacketId(packet));
      snapshot.runtime_context_json.dependencies = metadata.dependsOn;
      snapshot.runtime_context_json.priority = metadata.priority;
      options.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, [], snapshot);
      await syncProjectProjection(options.observability, manual, options.store, snapshot, workflow, options.projectId, {
        progress: options.progress,
      });
      manual.manual_cli_issues_intaken += 1;
      manual.manual_cli_ready_snapshots += snapshot.lifecycle_state === "ready" ? 1 : 0;
      manual.manual_cli_dependency_edges_parsed += metadata.dependsOn.length;
      return snapshot;
    },

    async startIssue(input: { issueId: string }) {
      const snapshot = options.store.getIssue(input.issueId);
      const externallyClosed = await reconcileExternalIssueClosedIfAvailable({
        snapshot,
        store: options.store,
        workflow,
        issueSource: options.issueSource,
        now: options.now(),
        progress: options.progress,
      });
      if (externallyClosed) {
        await syncIssueProgress(options.observability, externallyClosed.snapshot, options.now(), "External GitHub issue is closed");
        await syncProjectProjection(options.observability, manual, options.store, externallyClosed.snapshot, workflow, options.projectId, {
          persistSyncedMarker: true,
          persistRetryMarker: true,
          now: options.now(),
          progress: options.progress,
        });
        return externallyClosed.snapshot;
      }
      const externallyCompleted = options.externalCompletionEnabled === false
        ? undefined
        : await reconcileExternalCompletionIfAvailable({
            snapshot,
            store: options.store,
            domain: options.domain,
            workflow,
            now: options.now(),
            progress: options.progress,
            cleanupPolicy: options.cleanupPolicy,
            cleanup: options.cleanup,
            projectRoot: options.projectRoot,
            worktreesDir: options.worktreesDir,
          });
      if (externallyCompleted) {
        await syncIssueProgress(options.observability, externallyCompleted.snapshot, options.now(), "External merged PR detected");
        await syncProjectProjection(options.observability, manual, options.store, externallyCompleted.snapshot, workflow, options.projectId, {
          persistSyncedMarker: true,
          persistRetryMarker: true,
          now: options.now(),
          progress: options.progress,
        });
        return externallyCompleted.snapshot;
      }
      if (snapshot.lifecycle_state !== "ready") {
        return snapshot;
      }
      const issueNumber = Number((snapshot.runtime_context_json.issue_packet as { issue_number?: string } | undefined)?.issue_number ?? "0");
      const stageName = currentStageName(snapshot, workflow);
      const roleName = roleNameForStage(workflow, stageName);
      if (stageName === releaseStageName(workflow)) {
        await emitProgress(options.progress, {
          event: "issue_started",
          issue_id: snapshot.issue_id,
          issue_number: issueNumber,
          lifecycle_state: snapshot.lifecycle_state,
          stage: stageName,
          role: roleName,
        });
        await emitProgress(options.progress, {
          event: "worker_started",
          issue_id: snapshot.issue_id,
          issue_number: issueNumber,
          lifecycle_state: snapshot.lifecycle_state,
          stage: stageName,
          role: roleName,
        });
        const dispatch = dispatchStageRoot({
          host: options.host,
          workflow,
          issueId: input.issueId,
          stageName,
          leaseId: `lease-${stageName}-${input.issueId}`,
          roleOverrides: options.roleOverrides,
        });
        const result = claimAndStartRelease({
          snapshot,
          workflow,
          roleName,
          leaseId: dispatch.childRun.lease_id,
          rootSessionId: dispatch.rootSessionId,
          childRunId: dispatch.childRun.child_run_id,
          sessionId: dispatch.childRun.session_id,
          now: options.now(),
          ttlSeconds: options.leaseTimeoutSeconds,
        });
        options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, result.snapshot);
        await syncIssueProgress(options.observability, result.snapshot, options.now(), "Release started");
        await syncProjectProjection(options.observability, manual, options.store, result.snapshot, workflow, options.projectId, {
          progress: options.progress,
        });
        manual.manual_cli_owner_leases_claimed += 1;
        manual.manual_cli_root_sessions_started += 1;
        manual.manual_cli_child_runs_started += 1;
        manual.manual_cli_releases_started += 1;
        return result.snapshot;
      }
      await emitProgress(options.progress, {
        event: "issue_started",
        issue_id: snapshot.issue_id,
        issue_number: issueNumber,
        lifecycle_state: snapshot.lifecycle_state,
        stage: stageName,
        role: roleName,
      });
      await emitProgress(options.progress, {
        event: "worker_started",
        issue_id: snapshot.issue_id,
        issue_number: issueNumber,
        lifecycle_state: snapshot.lifecycle_state,
        stage: stageName,
        role: roleName,
      });
      let prepared: Awaited<ReturnType<DomainDriver["prepareStage"]>>;
      try {
        prepared = await options.domain.prepareStage(domainContext({
          snapshot,
          workflow,
          stageName,
          roleName,
        }));
      } catch (error) {
        if (!isRecoverableDispatchBlocker(error)) throw error;
        const blocked = recoverableDispatchBlockedResult({
          snapshot,
          workflow,
          error,
          now: options.now(),
        });
        options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, blocked.history, blocked.snapshot);
        await syncIssueProgress(options.observability, blocked.snapshot, options.now(), `Dispatch blocked: ${errorMessage(error)}`);
        await syncProjectProjection(options.observability, manual, options.store, blocked.snapshot, workflow, options.projectId, {
          progress: options.progress,
        });
        return blocked.snapshot;
      }
      const dispatch = dispatchStageRoot({
        host: options.host,
        workflow,
        issueId: input.issueId,
        stageName,
        leaseId: `lease-${stageName}-${input.issueId}`,
        roleOverrides: options.roleOverrides,
      });
      const result = claimAndStartStage({
        snapshot,
        workflow,
        stageName,
        leaseId: dispatch.childRun.lease_id,
        rootSessionId: dispatch.rootSessionId,
        childRunId: dispatch.childRun.child_run_id,
        sessionId: dispatch.childRun.session_id,
        childStatus: dispatch.childRun.status,
        now: options.now(),
        ttlSeconds: options.leaseTimeoutSeconds,
      });
      result.snapshot.worktree_path = prepared.worktreePath;
      result.snapshot.runtime_context_json = {
        ...result.snapshot.runtime_context_json,
        worktree_path: prepared.worktreePath,
        branch: prepared.branch,
      };
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, result.snapshot);
      await syncIssueProgress(options.observability, result.snapshot, options.now(), "Implementation started");
      await syncProjectProjection(options.observability, manual, options.store, result.snapshot, workflow, options.projectId, {
        progress: options.progress,
      });
      manual.manual_cli_owner_leases_claimed += 1;
      manual.manual_cli_root_sessions_started += 1;
      manual.manual_cli_child_runs_started += 1;
      manual.manual_cli_worktrees_created += 1;
      manual.manual_cli_branches_created += 1;
      return result.snapshot;
    },

    async reconcileIssue(input: { issueId: string }) {
      let snapshot = options.store.getIssue(input.issueId);
      if (snapshot.lifecycle_state === "completed") {
        const refreshedPullRequest = await refreshCompletedPullRequestMetadataIfAvailable({
          snapshot,
          domain: options.domain,
          workflow,
          now: options.now(),
        });
        if (refreshedPullRequest) {
          options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, refreshedPullRequest.history, refreshedPullRequest.snapshot);
          snapshot = refreshedPullRequest.snapshot;
        }

        snapshot = await cleanupTerminalWorktreeIfConfigured({
          snapshot,
          store: options.store,
          now: options.now(),
          cleanupPolicy: options.cleanupPolicy,
          cleanup: options.cleanup,
          projectRoot: options.projectRoot,
          worktreesDir: options.worktreesDir,
        });
        const status = await syncProjectProjection(options.observability, manual, options.store, snapshot, workflow, options.projectId, {
          persistSyncedMarker: true,
          persistRetryMarker: true,
          now: options.now(),
          progress: options.progress,
        });
        return { next_action: status === "success" || status === "skipped" ? "projection_repaired" : "none", issue: snapshot };
      }
      const verifierRecovery = await recoverQuarantinedVerifierArtifactIfAvailable({
        snapshot,
        store: options.store,
        domain: options.domain,
        workflow,
        now: options.now(),
        progress: options.progress,
      });
      if (verifierRecovery) {
        await syncIssueProgress(options.observability, verifierRecovery.snapshot, options.now(), verifierRecovery.message);
        await syncProjectProjection(options.observability, manual, options.store, verifierRecovery.snapshot, workflow, options.projectId, {
          persistSyncedMarker: true,
          persistRetryMarker: true,
          now: options.now(),
          progress: options.progress,
        });
        return { next_action: verifierRecovery.nextAction, issue: verifierRecovery.snapshot };
      }
      const externallyCompleted = options.externalCompletionEnabled === false
        ? undefined
        : await reconcileExternalCompletionIfAvailable({
            snapshot,
            store: options.store,
            domain: options.domain,
            workflow,
            now: options.now(),
            progress: options.progress,
            cleanupPolicy: options.cleanupPolicy,
            cleanup: options.cleanup,
            projectRoot: options.projectRoot,
            worktreesDir: options.worktreesDir,
          });
      if (externallyCompleted) {
        await syncIssueProgress(options.observability, externallyCompleted.snapshot, options.now(), "External merged PR detected");
        await syncProjectProjection(options.observability, manual, options.store, externallyCompleted.snapshot, workflow, options.projectId, {
          persistSyncedMarker: true,
          persistRetryMarker: true,
          now: options.now(),
          progress: options.progress,
        });
        return { next_action: "external_completion_reconciled", issue: externallyCompleted.snapshot };
      }
      const readyRecovery = await recoverReadyRecoverableDispatchBlockIfAvailable({
        snapshot,
        store: options.store,
        domain: options.domain,
        workflow,
        now: options.now(),
      });
      if (readyRecovery) {
        await syncIssueProgress(options.observability, readyRecovery.snapshot, options.now(), readyRecovery.message);
        await syncProjectProjection(options.observability, manual, options.store, readyRecovery.snapshot, workflow, options.projectId, {
          persistSyncedMarker: true,
          persistRetryMarker: true,
          now: options.now(),
          progress: options.progress,
        });
        return { next_action: readyRecovery.nextAction, issue: readyRecovery.snapshot };
      }
      if (snapshot.lifecycle_state === "ready") {
        return { next_action: "ready_noop", issue: snapshot };
      }
      const implementationStageName = currentStageName(snapshot, workflow);
      const implementationRoleName = roleNameForStage(workflow, implementationStageName);
      const implementationRole = workflow.roles[implementationRoleName];
      const implementationChild = snapshot.runtime_context_json.child_runs?.find((run) => run.role === implementationRoleName);
      if (!implementationChild) throw new Error(`Issue ${input.issueId} does not have an implementation child run`);

      let pr;
      try {
        pr = await withOwnerLeaseHeartbeat({
          store: options.store,
          host: options.host,
          workflow,
          issueId: input.issueId,
          leaseId: snapshot.runtime_context_json.owner_lease?.lease_id,
          now: options.now,
          ttlSeconds: options.leaseTimeoutSeconds,
          intervalSeconds: options.heartbeatIntervalSeconds,
        }, () => options.domain.finalizeWorkerArtifact({
          ...domainContext({
            snapshot,
            workflow,
            stageName: implementationStageName,
            roleName: implementationRoleName,
            recordStreamSession: streamSessionRecorder({
              store: options.store,
              workflow,
              issueId: input.issueId,
              childRunId: implementationChild.child_run_id,
              now: options.now,
            }),
          }),
          branch: String(snapshot.runtime_context_json.branch ?? `northstar/${input.issueId}`),
          changedFiles: ["northstar-orchestrator-smoke.txt"],
        }));
      } catch (error) {
        snapshot = options.store.getIssue(input.issueId);
        if (!isAgentArtifactRejection(error)) throw error;
        const externallyCompletedAfterFailure = options.externalCompletionEnabled === false
          ? undefined
          : await reconcileExternalCompletionIfAvailable({
              snapshot,
              store: options.store,
              domain: options.domain,
              workflow,
              now: options.now(),
              progress: options.progress,
              cleanupPolicy: options.cleanupPolicy,
              cleanup: options.cleanup,
              projectRoot: options.projectRoot,
              worktreesDir: options.worktreesDir,
            });
        if (externallyCompletedAfterFailure) {
          await syncIssueProgress(options.observability, externallyCompletedAfterFailure.snapshot, options.now(), "External merged PR detected");
          await syncProjectProjection(options.observability, manual, options.store, externallyCompletedAfterFailure.snapshot, workflow, options.projectId, {
            persistSyncedMarker: true,
            persistRetryMarker: true,
            now: options.now(),
            progress: options.progress,
          });
          return { next_action: "external_completion_reconciled", issue: externallyCompletedAfterFailure.snapshot };
        }

        const prRecord = pullRequestFromError(error);
        const prRecorded = prRecord
          ? submitPullRequestRecorded({
              snapshot,
              workflow,
              ...prRecord,
              now: options.now(),
            })
          : undefined;
        const eventType = artifactRejectionEventType(error);
        const rejected = agentArtifactRejectedResultOrThrow({
          snapshot: prRecorded?.snapshot ?? snapshot,
          workflow,
          error,
          now: options.now(),
          eventType,
        });
        options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, [...(prRecorded?.history ?? []), ...rejected.history], rejected.snapshot);
        await syncIssueProgress(options.observability, rejected.snapshot, options.now(), errorMessage(error));
        await syncProjectProjection(options.observability, manual, options.store, rejected.snapshot, workflow, options.projectId, {
          persistSyncedMarker: true,
          persistRetryMarker: true,
          now: options.now(),
          progress: options.progress,
        });
        return { next_action: eventType, issue: rejected.snapshot };
      }
      snapshot = options.store.getIssue(input.issueId);
      let result = submitPullRequestRecorded({
        snapshot,
        workflow,
        prNumber: pr.prNumber,
        prUrl: pr.prUrl,
        branch: pr.branch,
        commitSha: pr.commitSha,
        now: options.now(),
      });
      snapshot = result.snapshot;
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, snapshot);

      result = pr.workerArtifact
        ? submitChildArtifactPayload({
            snapshot,
            workflow,
            childRunId: implementationChild.child_run_id,
            artifactHistoryId: options.store.listHistory(input.issueId).length + 1,
            artifact: pr.workerArtifact,
            now: options.now(),
          })
        : submitWorkerArtifact({
            snapshot,
            workflow,
            childRunId: implementationChild.child_run_id,
            artifactHistoryId: options.store.listHistory(input.issueId).length + 1,
            roleName: implementationRoleName,
            artifactKind: implementationRole.artifact ?? "worker_result",
            branch: pr.branch,
            commitSha: pr.commitSha,
            changedFiles: ["northstar-orchestrator-smoke.txt"],
            now: options.now(),
          });
      snapshot = result.snapshot;
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, snapshot);
      await syncIssueProgress(options.observability, snapshot, options.now(), `Pull request ready: ${pr.prUrl}`);
      manual.manual_cli_commits_created += 1;
      manual.manual_cli_branches_pushed += 1;
      manual.manual_cli_prs_created += 1;

      const verificationStageName = currentStageName(snapshot, workflow);
      const verificationRoleName = roleNameForStage(workflow, verificationStageName);
      const verificationRole = workflow.roles[verificationRoleName];
      const dispatch = dispatchStageRoot({
        host: options.host,
        workflow,
        issueId: input.issueId,
        stageName: verificationStageName,
        leaseId: `lease-${verificationStageName}-${input.issueId}`,
        roleOverrides: options.roleOverrides,
      });
      result = claimAndStartStage({
        snapshot,
        workflow,
        stageName: verificationStageName,
        leaseId: dispatch.childRun.lease_id,
        rootSessionId: dispatch.rootSessionId,
        childRunId: dispatch.childRun.child_run_id,
        sessionId: dispatch.childRun.session_id,
        childStatus: dispatch.childRun.status,
        now: options.now(),
        ttlSeconds: options.leaseTimeoutSeconds,
      });
      snapshot = result.snapshot;
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, snapshot);
      await syncProjectProjection(options.observability, manual, options.store, snapshot, workflow, options.projectId, {
        progress: options.progress,
      });
      manual.manual_cli_owner_leases_claimed += 1;
      manual.manual_cli_root_sessions_started += 1;
      manual.manual_cli_child_runs_started += 1;

      let verifierArtifact = pr.verifierArtifact;
      if (!verifierArtifact && options.domain.verifyPullRequest) {
        try {
          verifierArtifact = await withOwnerLeaseHeartbeat({
            store: options.store,
            host: options.host,
            workflow,
            issueId: input.issueId,
            leaseId: snapshot.runtime_context_json.owner_lease?.lease_id,
            now: options.now,
            ttlSeconds: options.leaseTimeoutSeconds,
            intervalSeconds: options.heartbeatIntervalSeconds,
          }, () => options.domain.verifyPullRequest?.({
            ...domainContext({
              snapshot,
              workflow,
              stageName: verificationStageName,
              roleName: verificationRoleName,
              recordStreamSession: streamSessionRecorder({
                store: options.store,
                workflow,
                issueId: input.issueId,
                childRunId: dispatch.childRun.child_run_id,
                now: options.now,
              }),
            }),
            pullRequest: pr,
          }));
        } catch (error) {
          snapshot = options.store.getIssue(input.issueId);
          const rejected = agentArtifactRejectedResultOrThrow({
            snapshot,
            workflow,
            error,
            now: options.now(),
            eventType: "verifier_artifact_rejected",
          });
          options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, rejected.history, rejected.snapshot);
          await syncIssueProgress(options.observability, rejected.snapshot, options.now(), errorMessage(error));
          await syncProjectProjection(options.observability, manual, options.store, rejected.snapshot, workflow, options.projectId, {
            persistSyncedMarker: true,
            persistRetryMarker: true,
            now: options.now(),
            progress: options.progress,
          });
          return { next_action: "verifier_artifact_rejected", issue: rejected.snapshot };
        }
      }
      snapshot = options.store.getIssue(input.issueId);

      result = verifierArtifact
        ? submitChildArtifactPayload({
            snapshot,
            workflow,
            childRunId: dispatch.childRun.child_run_id,
            artifactHistoryId: options.store.listHistory(input.issueId).length + 1,
            artifact: verifierArtifact,
            now: options.now(),
          })
        : submitVerifierArtifact({
            snapshot,
            workflow,
            childRunId: dispatch.childRun.child_run_id,
            artifactHistoryId: options.store.listHistory(input.issueId).length + 1,
            roleName: verificationRoleName,
            artifactKind: verificationRole.artifact ?? "evidence_packet",
            prNumber: pr.prNumber,
            now: options.now(),
          });
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, result.snapshot);
      await syncIssueProgress(options.observability, result.snapshot, options.now(), `Verification passed for PR #${pr.prNumber}`);
      await syncPrProgress(options.observability, {
        prNumber: pr.prNumber,
        body: `Northstar verifier passed for ${input.issueId}`,
        verifierEvidence: `Verifier artifact accepted for ${input.issueId}`,
        commandsPassed: ["worker artifact recorded", "verifier artifact accepted"],
        releaseReadiness: "Ready for release after verifier approval",
      });
      await syncProjectProjection(options.observability, manual, options.store, result.snapshot, workflow, options.projectId, {
        progress: options.progress,
      });
      manual.manual_cli_verified_issues += result.snapshot.lifecycle_state === "verified" ? 1 : 0;
      return result.snapshot;
    },

    async releaseIssue(input: { issueId: string; autoRelease: boolean }) {
      let snapshot = options.store.getIssue(input.issueId);
      if (terminalLifecycleStates.includes(snapshot.lifecycle_state)) {
        return snapshot;
      }
      const prRecord = snapshot.runtime_context_json.pr as
        | { prNumber?: unknown; prUrl?: unknown; branch?: unknown; commitSha?: unknown; headCommit?: unknown }
        | undefined;
      const prNumber = typeof prRecord?.prNumber === "number" && Number.isInteger(prRecord.prNumber) ? prRecord.prNumber : undefined;
      if (prNumber === undefined) throw new Error(`Issue ${input.issueId} does not have PR metadata`);
      const currentPr = {
        prNumber,
        prUrl: typeof prRecord?.prUrl === "string" ? prRecord.prUrl : "",
        branch: typeof prRecord?.branch === "string" ? prRecord.branch : `northstar/${prNumber}`,
        commitSha: typeof prRecord?.commitSha === "string" && prRecord.commitSha.length > 0
          ? prRecord.commitSha
          : typeof prRecord?.headCommit === "string" && prRecord.headCommit.length > 0
            ? prRecord.headCommit
            : "",
      };
      const releaseStage = releaseStageName(workflow);
      const releaseRole = releaseRoleName(workflow);

      let result;
      if (snapshot.lifecycle_state !== "releasing") {
        const releaseSessionSegment = runtimeSessionIdSegment(input.issueId, releaseRole, options.now());
        result = claimAndStartRelease({
          snapshot,
          workflow,
          roleName: releaseRole,
          leaseId: `lease-release-${input.issueId}`,
          rootSessionId: `planned-root:${releaseSessionSegment}`,
          childRunId: `planned-child:${releaseSessionSegment}`,
          sessionId: `planned-root:${releaseSessionSegment}`,
          now: options.now(),
          ttlSeconds: options.leaseTimeoutSeconds,
        });
        snapshot = result.snapshot;
        options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, snapshot);
        await syncProjectProjection(options.observability, manual, options.store, snapshot, workflow, options.projectId, {
          progress: options.progress,
        });
        manual.manual_cli_owner_leases_claimed += 1;
        manual.manual_cli_root_sessions_started += 1;
        manual.manual_cli_releases_started += 1;
      }

      let release;
      try {
        release = await withOwnerLeaseHeartbeat({
          store: options.store,
          host: options.host,
          workflow,
          issueId: input.issueId,
          leaseId: snapshot.runtime_context_json.owner_lease?.lease_id,
          now: options.now,
          ttlSeconds: options.leaseTimeoutSeconds,
          intervalSeconds: options.heartbeatIntervalSeconds,
        }, () => options.domain.releaseVerifiedItem({
          ...domainContext({
            snapshot,
            workflow,
            stageName: "release",
            roleName: releaseRole,
            recordStreamSession: streamSessionRecorder({
              store: options.store,
              workflow,
              issueId: input.issueId,
              childRunId: latestChildRunIdForRole(snapshot, releaseRole) ?? `release-${input.issueId}`,
              now: options.now,
            }),
          }),
          releaseMetadata: currentPr,
        }));
      } catch (error) {
        snapshot = options.store.getIssue(input.issueId);
        const rejected = agentArtifactRejectedResultOrThrow({
          snapshot,
          workflow,
          error,
          now: options.now(),
          eventType: "verifier_artifact_rejected",
        });
        options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, rejected.history, rejected.snapshot);
        await syncIssueProgress(options.observability, rejected.snapshot, options.now(), errorMessage(error));
        await syncProjectProjection(options.observability, manual, options.store, rejected.snapshot, workflow, options.projectId, {
          persistSyncedMarker: true,
          persistRetryMarker: true,
          now: options.now(),
          progress: options.progress,
        });
        return { next_action: "verifier_artifact_rejected", issue: rejected.snapshot };
      }
      snapshot = options.store.getIssue(input.issueId);

      const releasePullRequest = pullRequestFromReleaseResult(release);
      if (releasePullRequest &&
        (releasePullRequest.prUrl !== currentPr.prUrl || releasePullRequest.commitSha !== currentPr.commitSha || releasePullRequest.branch !== currentPr.branch)) {
        const refreshed = submitPullRequestRecorded({
          snapshot,
          workflow,
          prNumber: releasePullRequest.prNumber,
          prUrl: releasePullRequest.prUrl,
          branch: releasePullRequest.branch,
          commitSha: releasePullRequest.commitSha,
          now: options.now(),
        });
        snapshot = refreshed.snapshot;
        options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, refreshed.history, snapshot);
      }

      let refreshedPullRequest: PullRequestResult | undefined;
      try {
        refreshedPullRequest = await refreshPullRequestMetadataFromDomain({
          snapshot,
          domain: options.domain,
          workflow,
          stageName: releaseStage ?? currentStageName(snapshot, workflow),
          roleName: releaseRole,
        });
      } catch (_error) {
        refreshedPullRequest = undefined;
      }
      if (refreshedPullRequest &&
        (refreshedPullRequest.prUrl !== currentPr.prUrl || refreshedPullRequest.commitSha !== currentPr.commitSha || refreshedPullRequest.branch !== currentPr.branch)) {
        const refreshed = submitPullRequestRecorded({
          snapshot,
          workflow,
          prNumber: refreshedPullRequest.prNumber,
          prUrl: refreshedPullRequest.prUrl,
          branch: refreshedPullRequest.branch,
          commitSha: refreshedPullRequest.commitSha,
          now: options.now(),
        });
        snapshot = refreshed.snapshot;
        options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, refreshed.history, snapshot);
      }
      result = release.releaseArtifact
        ? submitChildArtifactPayload({
            snapshot,
            workflow,
            childRunId: latestChildRunIdForRole(snapshot, releaseRole) ?? `release-${input.issueId}`,
            artifactHistoryId: options.store.listHistory(input.issueId).length + 1,
            artifact: release.releaseArtifact,
            now: options.now(),
          })
        : submitConfirmedRelease({
            snapshot,
            workflow,
            mergeSha: release.mergeSha,
            syncWorktree: release.syncWorktree,
            now: options.now(),
          });
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, result.snapshot);
      const releaseIssueUpdate = releaseIssueUpdateFromSnapshot(result.snapshot);
      const releaseProgressMessage = releaseIssueUpdate?.comment_summary ?? `Release completed with merge ${release.mergeSha}`;
      result.snapshot = await cleanupTerminalWorktreeIfConfigured({
        snapshot: result.snapshot,
        store: options.store,
        now: options.now(),
        cleanupPolicy: options.cleanupPolicy,
        cleanup: options.cleanup,
        projectRoot: options.projectRoot,
        worktreesDir: options.worktreesDir,
      });
      await syncIssueProgress(options.observability, result.snapshot, options.now(), releaseProgressMessage);
      await emitProgress(options.progress, {
        event: "completed",
        issue_id: result.snapshot.issue_id,
        issue_number: issueNumberFromSnapshot(result.snapshot),
        lifecycle_state: result.snapshot.lifecycle_state,
        message: releaseProgressMessage,
      });
      await syncProjectProjection(options.observability, manual, options.store, result.snapshot, workflow, options.projectId, {
        progress: options.progress,
      });
      manual.manual_cli_prs_merged += release.confirmed ? 1 : 0;
      manual.manual_cli_completed_issues += result.snapshot.lifecycle_state === "completed" ? 1 : 0;
      manual.manual_cli_confirmed_release_facts += release.confirmed ? 1 : 0;
      return result.snapshot;
    },

    inspectIssue(input: { issueId: string }) {
      const model = inspectIssueSnapshot(options.store.getIssue(input.issueId), options.store.listHistory(input.issueId));
      manual.manual_cli_inspect_fields_present = Math.max(manual.manual_cli_inspect_fields_present, model.fields_present);
      return model;
    },

    async syncProjectIssue(input: { issueId: string }) {
      return await syncProjectProjection(
        options.observability,
        manual,
        options.store,
        options.store.getIssue(input.issueId),
        workflow,
        options.projectId,
        { persistSyncedMarker: true, persistRetryMarker: true, now: options.now(), progress: options.progress },
      );
    },

    async repairRuntime(input: { issueId?: string } = {}) {
      const snapshots = input.issueId === undefined
        ? options.store.listAllIssuesForTests()
        : [options.store.getIssue(input.issueId)];
      const repaired = await repairRuntimeInvariantsBeforeScheduling({
        snapshots,
        store: options.store,
        workflow,
        host: options.host,
        observability: options.observability,
        metrics: manual,
        projectId: options.projectId,
        now: options.now(),
        progress: options.progress,
      });
      return {
        repaired,
        issues: snapshots.map((snapshot) => snapshot.issue_id),
      };
    },

    async resumeIssue(input: { issueId: string; reason: string; targetLifecycle: "ready" | "running" }) {
      const snapshot = options.store.getIssue(input.issueId);
      const resumed = applyRuntimeEvents(snapshot, workflow, [{
        type: "operator_resume_to_ready",
        reason: input.reason,
        target: input.targetLifecycle,
      }]);
      if (resumed.operatorMessages.length > 0) {
        const message = resumed.operatorMessages.map((item) => `${item.code}: ${item.message}`).join("; ");
        throw new Error(message);
      }

      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, resumed.history, resumed.snapshot);
      await syncIssueProgress(options.observability, resumed.snapshot, options.now(), `Operator resumed quarantined issue: ${input.reason}`);
      await syncProjectProjection(options.observability, manual, options.store, resumed.snapshot, workflow, options.projectId, {
        persistSyncedMarker: true,
        persistRetryMarker: true,
        now: options.now(),
        progress: options.progress,
      });

      if (input.targetLifecycle === "running") {
        const issue = await this.startIssue({ issueId: input.issueId });
        return {
          resumed: true,
          target_lifecycle: issue.lifecycle_state,
          issue,
        };
      }

      return {
        resumed: true,
        target_lifecycle: resumed.snapshot.lifecycle_state,
        issue: resumed.snapshot,
      };
    },

    async retrySyncIssue(input: { issueId: string }) {
      const snapshot = options.store.getIssue(input.issueId);
      const issueProgressStatus = await syncIssueProgressRepair(
        options.observability,
        manual,
        options.store,
        snapshot,
        workflow,
        options.now(),
      );
      const status = await syncProjectProjection(
        options.observability,
        manual,
        options.store,
        snapshot,
        workflow,
        options.projectId,
        { persistSyncedMarker: true, persistRetryMarker: true, now: options.now(), progress: options.progress },
      );
      const statuses = {
        github_observability: issueProgressStatus,
        github_project: status,
      };
      return {
        synced: Object.entries(statuses).filter(([, value]) => value === "success").map(([key]) => key),
        skipped: Object.entries(statuses).filter(([, value]) => value === "skipped").map(([key]) => key),
        failed: Object.entries(statuses).filter(([, value]) => value === "failed").map(([key]) => key),
      };
    },

    async runCycle(input: { autoRelease: boolean; maxStarts: number }) {
      let allIssues = options.store.listAllIssuesForTests();
      const closedReadyReconciled = await reconcileClosedReadyIssuesBeforeScheduling({
        snapshots: allIssues,
        store: options.store,
        workflow,
        issueSource: options.issueSource,
        observability: options.observability,
        metrics: manual,
        projectId: options.projectId,
        now: options.now(),
        progress: options.progress,
      });
      if (closedReadyReconciled) {
        allIssues = options.store.listAllIssuesForTests();
      }
      const externalCompletionReconciledBeforeRepair = await reconcileExternalCompletionsBeforeRuntimeRepair({
        snapshots: allIssues,
        store: options.store,
        domain: options.domain,
        workflow,
        externalCompletionEnabled: options.externalCompletionEnabled,
        observability: options.observability,
        metrics: manual,
        projectId: options.projectId,
        now: options.now(),
        progress: options.progress,
        cleanupPolicy: options.cleanupPolicy,
        cleanup: options.cleanup,
        projectRoot: options.projectRoot,
        worktreesDir: options.worktreesDir,
      });
      if (externalCompletionReconciledBeforeRepair) {
        allIssues = options.store.listAllIssuesForTests();
      }
      const repairedRuntimeInvariants = await repairRuntimeInvariantsBeforeScheduling({
        snapshots: allIssues,
        store: options.store,
        workflow,
        host: options.host,
        observability: options.observability,
        metrics: manual,
        projectId: options.projectId,
        now: options.now(),
        progress: options.progress,
      });
      if (repairedRuntimeInvariants) {
        allIssues = options.store.listAllIssuesForTests();
      }
      const exceptionResolvedIssueIds = reconcileWorkflowExceptions({
        snapshots: allIssues,
        store: options.store,
        workflow,
        maxRecoveryAttempts: options.maxRecoveryAttempts ?? 2,
        now: options.now(),
      });
      const exceptionResolved = exceptionResolvedIssueIds.length > 0;
      if (exceptionResolved) {
        allIssues = options.store.listAllIssuesForTests();
        for (const issueId of exceptionResolvedIssueIds) {
          const snapshot = allIssues.find((issue) => issue.issue_id === issueId);
          if (!snapshot) continue;
          await syncIssueProgress(options.observability, snapshot, options.now(), "Runtime exception recovered");
          await syncProjectProjection(options.observability, manual, options.store, snapshot, workflow, options.projectId, {
            persistSyncedMarker: true,
            persistRetryMarker: true,
            now: options.now(),
            progress: options.progress,
          });
        }
        allIssues = options.store.listAllIssuesForTests();
      }
      const active = allIssues.filter((snapshot) =>
        ["ready", "running", "verifying", "verified", "release_pending", "releasing"].includes(snapshot.lifecycle_state)
      );
      for (const snapshot of allIssues) {
        if (terminalProjectProjectionNeeded(options.store, snapshot, options.now())) {
          await syncProjectProjection(options.observability, manual, options.store, snapshot, workflow, options.projectId, {
            persistSyncedMarker: true,
            persistRetryMarker: true,
            now: options.now(),
            progress: options.progress,
          });
        }
      }
      const completedSyncRecovery = await reconcileCompletedSyncWorktreeRecovery({
        snapshots: allIssues,
        store: options.store,
        domain: options.domain,
        workflow,
        now: options.now(),
        observability: options.observability,
        metrics: manual,
        projectId: options.projectId,
        progress: options.progress,
      });
      if (completedSyncRecovery.reconciled) {
        allIssues = options.store.listAllIssuesForTests();
      }
      const historyRows = active.reduce((total, snapshot) => total + options.store.listRecentHistory(snapshot.issue_id, 20).length, 0);
      let progressed = externalCompletionReconciledBeforeRepair ||
        repairedRuntimeInvariants ||
        exceptionResolved ||
        completedSyncRecovery.reconciled ||
        completedSyncRecovery.blockedDispatch;

      for (const snapshot of active) {
        const externallyCompleted = options.externalCompletionEnabled === false
          ? undefined
          : await reconcileExternalCompletionIfAvailable({
              snapshot,
              store: options.store,
              domain: options.domain,
              workflow,
              now: options.now(),
              progress: options.progress,
              cleanupPolicy: options.cleanupPolicy,
              cleanup: options.cleanup,
              projectRoot: options.projectRoot,
              worktreesDir: options.worktreesDir,
            });
        if (externallyCompleted) {
          await syncIssueProgress(options.observability, externallyCompleted.snapshot, options.now(), "External merged PR detected");
          await syncProjectProjection(options.observability, manual, options.store, externallyCompleted.snapshot, workflow, options.projectId, {
            persistSyncedMarker: true,
            persistRetryMarker: true,
            now: options.now(),
            progress: options.progress,
          });
          progressed = true;
          continue;
        }
      }

      const dispatchRecovery = await reconcileReadyRecoverableDispatchBlocks({
        snapshots: options.store.listAllIssuesForTests(),
        store: options.store,
        domain: options.domain,
        workflow,
        now: options.now(),
        observability: options.observability,
        metrics: manual,
        projectId: options.projectId,
        progress: options.progress,
      });
      if (dispatchRecovery.reconciled) {
        allIssues = options.store.listAllIssuesForTests();
      }

      if (!input.autoRelease) {
        const pendingApproval = allIssues
          .filter((snapshot) => snapshot.lifecycle_state === "verified")
          .filter((snapshot) => recoverableBlockedByForSnapshot(snapshot).length === 0);
        for (const snapshot of pendingApproval) {
          const approval = applyRuntimeEvents(snapshot, workflow, [{
            type: "release_approval_required",
            at: options.now(),
          }]);
          if (approval.history.length === 0) continue;
          options.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, approval.history, approval.snapshot);
          await syncIssueProgress(options.observability, approval.snapshot, options.now(), "Release approval required");
          await syncProjectProjection(options.observability, manual, options.store, approval.snapshot, workflow, options.projectId, {
            persistSyncedMarker: true,
            persistRetryMarker: true,
            now: options.now(),
            progress: options.progress,
          });
          progressed = true;
        }
        if (pendingApproval.length > 0) {
          allIssues = options.store.listAllIssuesForTests();
        }
      }

      const activeEffects = allIssues
        .filter((snapshot) => ["ready", "running", "verifying", "verified", "release_pending", "releasing"].includes(snapshot.lifecycle_state))
        .filter((snapshot) =>
          recoverableBlockedByForSnapshot(snapshot).length === 0 &&
          (
            ((snapshot.lifecycle_state === "running" || snapshot.lifecycle_state === "verifying") &&
              snapshot.runtime_context_json.child_runs?.some((run) =>
                run.role === roleNameForStage(workflow, currentStageName(snapshot, workflow)) &&
                (run.status === "running" || run.status === "queued")
              )) ||
            (snapshot.lifecycle_state === "releasing" &&
              snapshot.runtime_context_json.child_runs?.some((run) =>
                run.role === releaseRoleName(workflow) &&
                (run.status === "running" || run.status === "queued")
              )) ||
            ((snapshot.lifecycle_state === "verified" || snapshot.lifecycle_state === "release_pending") && input.autoRelease)
          )
        )
        .slice(0, Math.max(0, input.maxStarts));
      if (activeEffects.length > 0) {
        await Promise.all(activeEffects.map(async (snapshot) => {
          if (snapshot.lifecycle_state === "running" || snapshot.lifecycle_state === "verifying") {
            await this.reconcileIssue({ issueId: snapshot.issue_id });
            return;
          }
          await this.releaseIssue({ issueId: snapshot.issue_id, autoRelease: true });
        }));
        progressed = true;
      }

      let started = 0;
      if (!progressed) {
        const scheduled = scheduleReadyIssues({
          issues: allIssues.map((snapshot) => ({
            issueId: snapshot.issue_id,
            number: issueNumberFromSnapshot(snapshot),
            lifecycle: snapshot.lifecycle_state,
            dependencies: Array.isArray(snapshot.runtime_context_json.dependencies)
              ? snapshot.runtime_context_json.dependencies.filter((value): value is number => typeof value === "number")
              : [],
            priority: typeof snapshot.runtime_context_json.priority === "number" ? snapshot.runtime_context_json.priority : 0,
          })),
          maxStarts: input.maxStarts,
        });
        for (const invalid of scheduled.quarantined) {
          const invalidSnapshot = options.store.getIssue(invalid.issueId);
          const dependency = invalid.dependency;
          const blockedBy = invalid.reason === "missing_dependency" && typeof dependency === "number"
            ? [`dependency:${dependency}:missing`]
            : [`dependency:${invalid.issueNumber}:cycle`];
          const lastError = invalid.reason === "missing_dependency" && typeof dependency === "number"
            ? `Dependency #${dependency} is missing`
            : "Dependency graph contains a cycle";
          const updated = dependencyBlockedResult({
            snapshot: invalidSnapshot,
            blockedBy,
            lastError,
            now: options.now(),
          });
          if (updated) {
            options.store.appendHistoryBatchAndUpdateSnapshot(invalidSnapshot.issue_id, [updated.history], updated.snapshot);
          }
          await syncProjectProjection(options.observability, manual, options.store, updated?.snapshot ?? invalidSnapshot, workflow, options.projectId, {
            persistSyncedMarker: true,
            persistRetryMarker: true,
            now: options.now(),
            progress: options.progress,
          });
          await syncIssueProgress(options.observability, updated?.snapshot ?? invalidSnapshot, options.now(), lastError);
        }
        for (const blocked of scheduled.blocked) {
          const blockedSnapshot = options.store.getIssue(blocked.issueId);
          const dependencyBlock = terminalDependencyBlockForSnapshot(blockedSnapshot, allIssues);
          if (!dependencyBlock) continue;
          const updated = dependencyBlockedResult({
            snapshot: blockedSnapshot,
            blockedBy: dependencyBlock.blockedBy,
            lastError: dependencyBlock.lastError,
            now: options.now(),
          });
          if (updated) {
            options.store.appendHistoryBatchAndUpdateSnapshot(blockedSnapshot.issue_id, [updated.history], updated.snapshot);
          }
          await syncProjectProjection(options.observability, manual, options.store, updated?.snapshot ?? blockedSnapshot, workflow, options.projectId, {
            persistSyncedMarker: true,
            persistRetryMarker: true,
            now: options.now(),
            progress: options.progress,
          });
          await syncIssueProgress(options.observability, updated?.snapshot ?? blockedSnapshot, options.now(), dependencyBlock.lastError);
        }
        const startableIssueIds = new Set(scheduled.startable.map((issue) => issue.issueId));
        for (const snapshot of allIssues) {
          if (snapshot.lifecycle_state === "ready" && started < input.maxStarts && startableIssueIds.has(snapshot.issue_id)) {
            const current = options.store.getIssue(snapshot.issue_id);
            if (recoverableBlockedByForSnapshot(current).length > 0) continue;
            const unblocked = clearDependencyBlockIfPresent({ snapshot: current, now: options.now() });
            if (unblocked) {
              options.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, [unblocked.history], unblocked.snapshot);
            }
            await this.startIssue({ issueId: snapshot.issue_id });
            started += 1;
          }
        }
      }
      return {
        activeIssues: active.length,
        effectsStarted: started,
        historyRows,
        summary: { ...manual, watch_cycles_completed: 1, watch_secret_leaks: 0, watch_history_rows: historyRows },
      };
    },

    metrics() {
      return { manual };
    },
  };
}

export interface ProductionObservability {
  trySyncIssueProgress(input: {
    issueNumber: number;
    lifecycleState: string;
    blockedBy?: string[];
    comment: string;
    statusMarkdown: string;
  }): Promise<{ status?: string; mutates_lifecycle?: boolean } | unknown>;
  syncPrProgress?(input: {
    prNumber: number;
    body: string;
    verifierEvidence?: string;
    commandsPassed?: string[];
    browserEvidence?: string;
    releaseReadiness?: string;
  }): Promise<void>;
  syncProjectFields?(input: { issueNumber: number; lifecycleState: string; projectId?: string; fields?: Record<string, unknown> }): Promise<unknown>;
}

export interface ProductionIssueSource {
  readIssueState(issueNumber: number): Promise<{
    number: number;
    state: "open" | "closed" | string;
    stateReason?: string | null;
    closedAt?: string | null;
    labels?: string[];
  }>;
}

export interface ProductionProgressEvent {
  event: string;
  issue_id?: string;
  issue_number?: number;
  lifecycle_state?: string;
  stage?: string;
  role?: string;
  projection_target?: string;
  status?: string;
  message?: string;
}

export type ProductionProgressReporter = (event: ProductionProgressEvent) => void | Promise<void>;

async function withOwnerLeaseHeartbeat<T>(
  input: {
    store: SqliteControlPlaneStore;
    host: HostAdapter;
    workflow: WorkflowDefinition;
    issueId: string;
    leaseId: string | undefined;
    now: () => string;
    ttlSeconds: number;
    intervalSeconds?: number;
  },
  task: () => Promise<T>,
): Promise<T> {
  const intervalMs = Math.max(1, Math.floor((input.intervalSeconds ?? 30) * 1000));
  let heartbeatInFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const heartbeatFailure = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void recordActiveOwnerHeartbeats(input)
        .catch((error) => {
          if (timer) clearInterval(timer);
          reject(error);
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, intervalMs);
  });

  try {
    return await Promise.race([task(), heartbeatFailure]);
  } finally {
    if (timer) clearInterval(timer);
  }
}

async function recordActiveOwnerHeartbeats(input: {
  store: SqliteControlPlaneStore;
  host: HostAdapter;
  workflow: WorkflowDefinition;
  issueId: string;
  leaseId: string | undefined;
  now: () => string;
  ttlSeconds: number;
}): Promise<void> {
  if (!input.leaseId) return;
  const snapshot = input.store.getIssue(input.issueId);
  if (!activeLifecycleStates.includes(snapshot.lifecycle_state)) return;
  const lease = snapshot.runtime_context_json.owner_lease;
  if (!lease || lease.lease_id !== input.leaseId) return;

  const result = applyRuntimeEvents(snapshot, input.workflow, [{
    type: "heartbeat",
    lease_id: lease.lease_id,
    at: input.now(),
    ttl_seconds: input.ttlSeconds,
  }]);
  if (result.operatorMessages.length > 0) {
    throw new Error(`Owner lease heartbeat rejected for ${snapshot.issue_id}: ${result.operatorMessages.map((message) => message.code).join(", ")}`);
  }
  input.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, result.history, result.snapshot);
  input.host.recordHeartbeat(lease.lease_id);
}

export function createProductionOrchestratorFromConfig(input: {
  config: RuntimeConfig;
  store?: SqliteControlPlaneStore;
  host: HostAdapter;
  domain: DomainDriver;
  workflowPath?: string;
  now?: () => string;
  observability?: ProductionObservability;
  progress?: ProductionProgressReporter;
}) {
  const dbPath = normalizeRuntimePath(input.config.project.root, input.config.runtime.dbPath);
  return createProductionOrchestrator({
    store: input.store ?? SqliteControlPlaneStore.open(dbPath),
    host: input.host,
    domain: input.domain,
    workflowPath: resolveProductionWorkflowPath({
      config: input.config,
      workflowPath: input.workflowPath,
    }),
    now: input.now ?? (() => new Date().toISOString()),
    leaseTimeoutSeconds: input.config.runtime.leaseTimeoutSeconds,
    heartbeatIntervalSeconds: input.config.runtime.heartbeatIntervalSeconds,
    roleOverrides: input.config.workflowOverrides?.roles ?? {},
    observability: input.observability,
    projectId: input.config.github.project?.projectId,
    progress: input.progress,
    cleanupPolicy: input.config.cleanup,
    projectRoot: input.config.project.root,
    worktreesDir: input.config.git.worktreesDir,
    maxRecoveryAttempts: input.config.runtime.maxRecoveryAttempts,
  });
}

async function syncIssueProgress(
  observability: ProductionObservability | undefined,
  snapshot: IssueSnapshot,
  now: string,
  message: string,
): Promise<void> {
  if (!observability) return;
  const issueNumber = issueNumberFromSnapshot(snapshot);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return;
  const blockedBy = blockedByListForSnapshot(snapshot);
  await ignoreProjectionFailure(() => observability.trySyncIssueProgress({
    issueNumber,
    lifecycleState: snapshot.lifecycle_state,
    blockedBy,
    comment: `Northstar ${snapshot.lifecycle_state}: ${message}`,
    statusMarkdown: [
      `- lifecycle: ${snapshot.lifecycle_state}`,
      ...(blockedBy.length > 0 ? [`- blocked_by: ${blockedBy.join(", ")}`] : []),
      `- updated_at: ${now}`,
      `- issue_id: ${snapshot.issue_id}`,
    ].join("\n"),
  }));
}

async function syncIssueProgressRepair(
  observability: ProductionObservability | undefined,
  metrics: ReturnType<typeof emptyManualCliMetrics>,
  store: SqliteControlPlaneStore,
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition,
  now: string,
): Promise<"success" | "failed" | "skipped" | "unknown"> {
  if (!observability) return "skipped";
  const issueNumber = issueNumberFromSnapshot(snapshot);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return "skipped";
  const blockedBy = blockedByListForSnapshot(snapshot);
  try {
    const result = await observability.trySyncIssueProgress({
      issueNumber,
      lifecycleState: snapshot.lifecycle_state,
      blockedBy,
      comment: `Northstar ${snapshot.lifecycle_state}: retry-sync repaired issue progress`,
      statusMarkdown: [
        `- lifecycle: ${snapshot.lifecycle_state}`,
        ...(blockedBy.length > 0 ? [`- blocked_by: ${blockedBy.join(", ")}`] : []),
        `- updated_at: ${now}`,
        `- issue_id: ${snapshot.issue_id}`,
      ].join("\n"),
    });
    const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
    if (record.status === "failed") {
      metrics.github_projection_failures_retryable += 1;
      metrics.github_projection_failures_do_not_mutate_lifecycle += record.mutates_lifecycle === true ? 0 : 1;
      persistProjectionFailure(store, snapshot, workflow, projectionFailureFromRecord(record));
      return "failed";
    }
    if (record.status === "skipped") return "skipped";
    if (record.status === "success") return "success";
    return "unknown";
  } catch (error) {
    metrics.github_projection_failures_retryable += 1;
    metrics.github_projection_failures_do_not_mutate_lifecycle += 1;
    persistProjectionFailure(store, snapshot, workflow, {
      type: "projection_result",
      projection_target: "github_observability",
      status: "failed",
      last_error: error instanceof Error ? error.message : String(error),
      next_retry_at: addSeconds(now, 60),
      payload: { issueNumber, lifecycleState: snapshot.lifecycle_state },
    });
    return "failed";
  }
}

async function syncPrProgress(
  observability: ProductionObservability | undefined,
  input: {
    prNumber: number;
    body: string;
    verifierEvidence?: string;
    commandsPassed?: string[];
    browserEvidence?: string;
    releaseReadiness?: string;
  },
): Promise<void> {
  if (!observability?.syncPrProgress) return;
  await ignoreProjectionFailure(() => observability.syncPrProgress!(input));
}

async function repairRuntimeInvariantsBeforeScheduling(input: {
  snapshots: IssueSnapshot[];
  store: SqliteControlPlaneStore;
  workflow: WorkflowDefinition;
  host: HostAdapter;
  observability?: ProductionObservability;
  metrics: ReturnType<typeof emptyManualCliMetrics>;
  projectId?: string;
  now: string;
  progress?: ProductionProgressReporter;
}): Promise<boolean> {
  let repaired = false;
  for (const snapshot of input.snapshots) {
    const result = repairSnapshot(snapshot, input.now, input.workflow);
    const hostRepair = await repairActiveRuntimeHostLiveness(input, result.snapshot, input.workflow);
    if (hostRepair !== undefined) {
      result.snapshot = hostRepair.snapshot;
      result.history.push(...hostRepair.history);
    }
    if (result.history.length === 0) continue;

    input.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, result.history, result.snapshot);
    if (input.progress) {
      const actions = result.history
        .filter((entry) => entry.event_type === "admin_action")
        .map((entry) => entry.payload.action)
        .filter((action) => typeof action === "string");
      await input.progress({
        event: "runtime_invariant_repair",
        issue_id: snapshot.issue_id,
        issue_number: issueNumberFromSnapshot(snapshot),
        lifecycle_state: result.snapshot.lifecycle_state,
        status: actions.join(","),
      });
    }
    repaired = true;
    await syncIssueProgress(input.observability, result.snapshot, input.now, "Runtime invariant repair applied");
    await syncProjectProjection(input.observability, input.metrics, input.store, result.snapshot, input.workflow, input.projectId, {
      persistSyncedMarker: true,
      persistRetryMarker: true,
      now: input.now,
      progress: input.progress,
    });
  }
  return repaired;
}

function reconcileWorkflowExceptions(input: {
  snapshots: IssueSnapshot[];
  store: SqliteControlPlaneStore;
  workflow: WorkflowDefinition;
  maxRecoveryAttempts: number;
  now: string;
}): string[] {
  const changedIssueIds: string[] = [];
  for (const snapshot of input.snapshots) {
    if (snapshot.lifecycle_state !== "exception") continue;
    const resolved = resolveExceptionPolicy(snapshot, input.workflow, {
      maxRecoveryAttempts: input.maxRecoveryAttempts,
      now: input.now,
    });
    if (resolved.history.length === 0) continue;
    input.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, resolved.history, resolved.snapshot);
    changedIssueIds.push(snapshot.issue_id);
  }
  return changedIssueIds;
}

async function reconcileExternalCompletionsBeforeRuntimeRepair(input: {
  snapshots: IssueSnapshot[];
  store: SqliteControlPlaneStore;
  domain: DomainDriver;
  workflow: WorkflowDefinition;
  externalCompletionEnabled?: boolean;
  observability?: ProductionObservability;
  metrics: ReturnType<typeof emptyManualCliMetrics>;
  projectId?: string;
  now: string;
  progress?: ProductionProgressReporter;
  cleanupPolicy?: CompletedWorktreeCleanupPolicy;
  cleanup?: ManagedWorktreeCleanup;
  projectRoot?: string;
  worktreesDir?: string;
}): Promise<boolean> {
  if (input.externalCompletionEnabled === false) return false;

  let reconciled = false;
  for (const snapshot of input.snapshots) {
    if (!["ready", "running", "verifying", "verified", "release_pending", "releasing"].includes(snapshot.lifecycle_state)) {
      continue;
    }
    const externallyCompleted = await reconcileExternalCompletionIfAvailable({
      snapshot,
      store: input.store,
      domain: input.domain,
      workflow: input.workflow,
      now: input.now,
      progress: input.progress,
      cleanupPolicy: input.cleanupPolicy,
      cleanup: input.cleanup,
      projectRoot: input.projectRoot,
      worktreesDir: input.worktreesDir,
    });
    if (!externallyCompleted) continue;

    await syncIssueProgress(input.observability, externallyCompleted.snapshot, input.now, "External merged PR detected");
    await syncProjectProjection(input.observability, input.metrics, input.store, externallyCompleted.snapshot, input.workflow, input.projectId, {
      persistSyncedMarker: true,
      persistRetryMarker: true,
      now: input.now,
      progress: input.progress,
    });
    reconciled = true;
  }
  return reconciled;
}

async function repairActiveRuntimeHostLiveness(
  input: {
    host: HostAdapter;
    now: string;
    workflow: WorkflowDefinition;
  },
  snapshot: IssueSnapshot,
): Promise<{ snapshot: IssueSnapshot; history: HistoryEntry[] } | undefined> {
  if (!activeLifecycleStates.includes(snapshot.lifecycle_state) || !snapshot.runtime_context_json.owner_lease) {
    return undefined;
  }

  const lease = snapshot.runtime_context_json.owner_lease;
  const rootStatus = await safeHostRootStatus(() => input.host.readRootStatus(lease.root_session_id));
  if (rootStatus === "unknown" || rootStatus === "error") {
    return hostLivenessCheckFailedResult(snapshot, {
      now: input.now,
      hostComponent: "root",
      hostStatus: rootStatus,
      rootSessionId: lease.root_session_id,
    });
  }
  if (rootStatus !== "live") {
    return releaseActiveRuntimeOwnership(snapshot, input.workflow, {
      now: input.now,
      reasonCode: "host_liveness_lost",
      details: {
        host_component: "root",
        host_status: rootStatus,
        root_session_id: lease.root_session_id,
      },
    });
  }

  const stageName = currentStageName(snapshot, input.workflow);
  const expectedRole = roleNameForStage(input.workflow, stageName);
  const expectedRun = snapshot.runtime_context_json.child_runs?.find((run) => run.role === expectedRole);
  if (!expectedRun) {
    return undefined;
  }

  const childStatus = await safeHostChildStatus(() => input.host.readChildStatus(expectedRun.child_run_id));
  if (childStatus === "unknown" || childStatus === "error") {
    return hostLivenessCheckFailedResult(snapshot, {
      now: input.now,
      hostComponent: "child",
      hostStatus: childStatus,
      childRunId: expectedRun.child_run_id,
      rootSessionId: lease.root_session_id,
    });
  }
  if (childStatus !== "running" && childStatus !== "queued") {
    return releaseActiveRuntimeOwnership(snapshot, input.workflow, {
      now: input.now,
      reasonCode: "host_liveness_lost",
      details: {
        host_component: "child",
        host_status: childStatus,
        child_run_id: expectedRun.child_run_id,
        root_session_id: lease.root_session_id,
      },
    });
  }

  return clearHostLivenessBlockIfPresent(snapshot, input.now);
}

function hostLivenessCheckFailedResult(
  snapshot: IssueSnapshot,
  input: {
    now: string;
    hostComponent: "root" | "child";
    hostStatus: string;
    rootSessionId: string;
    childRunId?: string;
  },
): { snapshot: IssueSnapshot; history: HistoryEntry[] } | undefined {
  const previousBlockedBy = Array.isArray(snapshot.runtime_context_json.blocked_by)
    ? snapshot.runtime_context_json.blocked_by.map(String)
    : [];
  const blockedBy = [...new Set([...previousBlockedBy, "host_liveness"])];
  const message = `Host ${input.hostComponent} liveness is ${input.hostStatus}; will retry before releasing ownership`;
  if (
    previousBlockedBy.includes("host_liveness") &&
    snapshot.runtime_context_json.last_error === message
  ) {
    return undefined;
  }
  const next = structuredClone(snapshot) as IssueSnapshot;
  next.runtime_context_json = {
    ...next.runtime_context_json,
    blocked_by: blockedBy,
    last_error: message,
  };
  return {
    snapshot: next,
    history: [{
      event_type: "admin_action",
      payload: {
        action: "host_liveness_check_failed",
        host_component: input.hostComponent,
        host_status: input.hostStatus,
        root_session_id: input.rootSessionId,
        ...(input.childRunId === undefined ? {} : { child_run_id: input.childRunId }),
        at: input.now,
      },
    }],
  };
}

function clearHostLivenessBlockIfPresent(
  snapshot: IssueSnapshot,
  now: string,
): { snapshot: IssueSnapshot; history: HistoryEntry[] } | undefined {
  const blockedBy = Array.isArray(snapshot.runtime_context_json.blocked_by)
    ? snapshot.runtime_context_json.blocked_by.map(String)
    : [];
  if (!blockedBy.includes("host_liveness")) return undefined;

  const remaining = blockedBy.filter((value) => value !== "host_liveness");
  const next = structuredClone(snapshot) as IssueSnapshot;
  if (remaining.length > 0) {
    next.runtime_context_json.blocked_by = remaining;
  } else {
    delete next.runtime_context_json.blocked_by;
  }
  if (typeof next.runtime_context_json.last_error === "string" && next.runtime_context_json.last_error.startsWith("Host ")) {
    delete next.runtime_context_json.last_error;
  }
  return {
    snapshot: next,
    history: [{
      event_type: "admin_action",
      payload: {
        action: "host_liveness_recovered",
        at: now,
      },
    }],
  };
}

function safeHostRootStatus(read: () => { status: "live" | "missing" | "unknown" }): "live" | "missing" | "unknown" | "error" {
  try {
    return read().status;
  } catch {
    return "error";
  }
}

function safeHostChildStatus(read: () => { status: string }): string {
  try {
    return read().status;
  } catch {
    return "error";
  }
}

async function reconcileExternalCompletionIfAvailable(input: {
  snapshot: IssueSnapshot;
  store: SqliteControlPlaneStore;
  domain: DomainDriver;
  workflow: WorkflowDefinition;
  now: string;
  progress?: ProductionProgressReporter;
  cleanupPolicy?: CompletedWorktreeCleanupPolicy;
  cleanup?: ManagedWorktreeCleanup;
  projectRoot?: string;
  worktreesDir?: string;
}): Promise<{ snapshot: IssueSnapshot } | undefined> {
  if (input.snapshot.lifecycle_state === "completed" || !input.domain.reconcileExternalCompletion) {
    return undefined;
  }
  const stageName = currentStageName(input.snapshot, input.workflow);
  const roleName = roleNameForStage(input.workflow, stageName);
  const completion = await input.domain.reconcileExternalCompletion(domainContext({
    snapshot: input.snapshot,
    workflow: input.workflow,
    stageName,
    roleName,
  }));
  if (!completion?.completed || !completion.mergeSha) {
    return undefined;
  }
  const context = domainContext({
    snapshot: input.snapshot,
    workflow: input.workflow,
    stageName,
    roleName,
  });
  const syncWorktree = input.domain.refreshCompletedBase
    ? await refreshCompletedBaseAfterExternalMerge(input.domain, context, completion.mergeSha)
    : undefined;
  const unexpectedMerge = unexpectedExternalMergeDiagnostic(input.snapshot, input.workflow, stageName);

  const result = submitExternalMerge({
    snapshot: input.snapshot,
    workflow: input.workflow,
    ...unexpectedMerge,
    prNumber: completion.prNumber,
    prUrl: completion.prUrl,
    branch: completion.branch,
    headCommit: completion.commitSha,
    mergeSha: completion.mergeSha,
    syncWorktree,
    now: input.now,
  });
  input.store.appendHistoryBatchAndUpdateSnapshot(input.snapshot.issue_id, result.history, result.snapshot);
  result.snapshot = await cleanupTerminalWorktreeIfConfigured({
    snapshot: result.snapshot,
    store: input.store,
    now: input.now,
    cleanupPolicy: input.cleanupPolicy,
    cleanup: input.cleanup,
    projectRoot: input.projectRoot,
    worktreesDir: input.worktreesDir,
  });
  if (unexpectedMerge) {
    await emitProgress(input.progress, {
      event: "unexpected_external_merge_detected",
      issue_id: result.snapshot.issue_id,
      issue_number: issueNumberFromSnapshot(result.snapshot),
      lifecycle_state: result.snapshot.lifecycle_state,
      stage: unexpectedMerge.detectedStage,
      message: "External merged PR detected before Northstar release stage",
    });
  }
  await emitProgress(input.progress, {
    event: "external_merge_detected",
    issue_id: result.snapshot.issue_id,
    issue_number: issueNumberFromSnapshot(result.snapshot),
    lifecycle_state: result.snapshot.lifecycle_state,
    message: "External merged PR detected",
  });
  await emitProgress(input.progress, {
    event: "completed",
    issue_id: result.snapshot.issue_id,
    issue_number: issueNumberFromSnapshot(result.snapshot),
    lifecycle_state: result.snapshot.lifecycle_state,
    message: "Issue completed by external merged PR recovery",
  });
  return { snapshot: result.snapshot };
}

async function refreshCompletedPullRequestMetadataIfAvailable(input: {
  snapshot: IssueSnapshot;
  domain: DomainDriver;
  workflow: WorkflowDefinition;
  now: string;
}): Promise<{ snapshot: IssueSnapshot; history: Array<{ event_type: string; payload: Record<string, unknown> }> } | undefined> {
  if (input.snapshot.lifecycle_state !== "completed" || !input.domain.reconcileExternalCompletion) {
    return undefined;
  }

  const stageName = releaseStageName(input.workflow) ?? currentStageName(input.snapshot, input.workflow);
  const roleName = roleNameForStage(input.workflow, stageName);
  const completion = await refreshPullRequestMetadataFromDomain({
    snapshot: input.snapshot,
    domain: input.domain,
    workflow: input.workflow,
    stageName,
    roleName,
  });
  if (!completion) {
    return undefined;
  }

  const currentPr = pullRequestForSnapshot(input.snapshot);
  if (
    currentPr !== undefined &&
    currentPr.prNumber === completion.prNumber &&
    currentPr.prUrl === completion.prUrl &&
    currentPr.branch === completion.branch &&
    currentPr.commitSha === completion.commitSha
  ) {
    return undefined;
  }

  const result = submitPullRequestRecorded({
    snapshot: input.snapshot,
    workflow: input.workflow,
    prNumber: completion.prNumber,
    prUrl: completion.prUrl,
    branch: completion.branch,
    commitSha: completion.commitSha,
    now: input.now,
  });

  return {
    snapshot: result.snapshot,
    history: result.history,
  };
}

async function recoverQuarantinedVerifierArtifactIfAvailable(input: {
  snapshot: IssueSnapshot;
  store: SqliteControlPlaneStore;
  domain: DomainDriver;
  workflow: WorkflowDefinition;
  now: string;
  progress?: ProductionProgressReporter;
}): Promise<{ snapshot: IssueSnapshot; nextAction: string; message: string } | undefined> {
  if (input.snapshot.lifecycle_state !== "quarantined" || !input.domain.recoverVerifierArtifact) {
    return undefined;
  }
  if (!dependencyFreeVerifierArtifactBlock(input.snapshot)) {
    return undefined;
  }
  const pullRequest = pullRequestForSnapshot(input.snapshot);
  if (!pullRequest) {
    return undefined;
  }

  const stageName = verificationStageName(input.workflow) ?? currentStageName(input.snapshot, input.workflow);
  const roleName = roleNameForStage(input.workflow, stageName);
  let recovered: PullRequestResult;
  try {
    recovered = await input.domain.recoverVerifierArtifact({
      ...domainContext({
        snapshot: input.snapshot,
        workflow: input.workflow,
        stageName,
        roleName,
      }),
      pullRequest,
    });
  } catch (error) {
    const rejected = verifierArtifactRejectedResultOrThrow({
      snapshot: input.snapshot,
      workflow: input.workflow,
      error,
      now: input.now,
    });
    input.store.appendHistoryBatchAndUpdateSnapshot(input.snapshot.issue_id, rejected.history, rejected.snapshot);
    return {
      snapshot: rejected.snapshot,
      nextAction: "verifier_artifact_rejected",
      message: errorMessage(error),
    };
  }

  const result = applyRuntimeEvents(input.snapshot, input.workflow, [{
    type: "verifier_artifact_recovered",
    at: input.now,
    pr_number: recovered.prNumber,
    pr_url: recovered.prUrl,
    branch: recovered.branch,
    commit_sha: recovered.commitSha,
    source: "quarantine_recovery",
  }]);
  input.store.appendHistoryBatchAndUpdateSnapshot(input.snapshot.issue_id, result.history, result.snapshot);
  await emitProgress(input.progress, {
    event: "verifier_artifact_recovered",
    issue_id: result.snapshot.issue_id,
    issue_number: issueNumberFromSnapshot(result.snapshot),
    lifecycle_state: result.snapshot.lifecycle_state,
    message: `Verifier artifact recovered for PR #${recovered.prNumber}`,
  });
  return {
    snapshot: result.snapshot,
    nextAction: "verifier_artifact_recovered",
    message: `Verifier artifact recovered for PR #${recovered.prNumber}`,
  };
}

function unexpectedExternalMergeDiagnostic(
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition,
  detectedStage: string,
): {
  classification: "pre_release_external_merge";
  possibleCause: string;
  detectedLifecycle: string;
  detectedStage: string;
  expectedStage: string;
} | undefined {
  const expectedStage = releaseStageName(workflow);
  if (!expectedStage) return undefined;
  if (snapshot.lifecycle_state === "release_pending" || snapshot.lifecycle_state === "releasing" || detectedStage === expectedStage) {
    return undefined;
  }
  return {
    classification: "pre_release_external_merge",
    possibleCause: "worker_or_external_actor_merged_before_release_stage",
    detectedLifecycle: snapshot.lifecycle_state,
    detectedStage,
    expectedStage,
  };
}

async function cleanupTerminalWorktreeIfConfigured(input: {
  snapshot: IssueSnapshot;
  store: SqliteControlPlaneStore;
  now: string;
  cleanupPolicy?: CompletedWorktreeCleanupPolicy;
  cleanup?: ManagedWorktreeCleanup;
  projectRoot?: string;
  worktreesDir?: string;
}): Promise<IssueSnapshot> {
  if (!input.cleanupPolicy || !input.cleanup || !input.projectRoot || !input.worktreesDir) {
    return input.snapshot;
  }
  const existingStatus = (input.snapshot.runtime_context_json.cleanup as { status?: unknown } | undefined)?.status;
  if (existingStatus === "succeeded" || existingStatus === "kept") {
    return input.snapshot;
  }
  const result = await runCompletedWorktreeCleanup({
    now: input.now,
    snapshot: input.snapshot,
    plan: planCompletedWorktreeCleanup({
      now: input.now,
      projectRoot: input.projectRoot,
      worktreesDir: input.worktreesDir,
      snapshot: input.snapshot,
      policy: input.cleanupPolicy,
    }),
    cleanup: input.cleanup,
  });
  input.store.appendHistoryBatchAndUpdateSnapshot(input.snapshot.issue_id, [result.history], result.snapshot);
  return result.snapshot;
}

async function refreshCompletedBaseAfterExternalMerge(
  domain: DomainDriver,
  context: DomainDriverContext,
  mergeSha: string,
) {
  if (!domain.refreshCompletedBase) return undefined;
  try {
    return await domain.refreshCompletedBase({ ...context, mergeSha });
  } catch (error) {
    return {
      status: "failed" as const,
      expectedCommit: mergeSha,
      code: errorCode(error) ?? "SYNC_WORKTREE_REFRESH_FAILED",
      lastError: errorMessage(error),
      retryable: true,
    };
  }
}

// Architecture decision: recovery clears blockers only; dispatch decisions remain in runCycle scheduling.
async function recoverReadyRecoverableDispatchBlockIfAvailable(input: {
  snapshot: IssueSnapshot;
  store: SqliteControlPlaneStore;
  domain: DomainDriver;
  workflow: WorkflowDefinition;
  now: string;
}): Promise<{ snapshot: IssueSnapshot; nextAction: string; message: string } | undefined> {
  if (input.snapshot.lifecycle_state !== "ready" || !input.domain.recoverDispatchBlock) {
    return undefined;
  }
  const blockers = recoverableBlockedByForSnapshot(input.snapshot);
  const blocker = blockers[0];
  if (!blocker) return undefined;

  const stageName = firstStageName(input.workflow);
  const roleName = roleNameForStage(input.workflow, stageName);
  const blockedErrorCode = typeof input.snapshot.runtime_context_json.blocked_error_code === "string"
    ? input.snapshot.runtime_context_json.blocked_error_code
    : undefined;

  try {
    const recovery = await input.domain.recoverDispatchBlock({
      ...domainContext({
        snapshot: input.snapshot,
        workflow: input.workflow,
        stageName,
        roleName,
      }),
      blocker,
      blockedErrorCode,
    });
    if (!recovery?.recovered) return undefined;

    const recovered = clearRecoverableDispatchBlock({
      snapshot: input.snapshot,
      blocker,
      now: input.now,
    });
    input.store.appendHistoryBatchAndUpdateSnapshot(input.snapshot.issue_id, [recovered.history], recovered.snapshot);
    return {
      snapshot: recovered.snapshot,
      nextAction: "dispatch_recovery_succeeded",
      message: recovery.note ?? "Recoverable dispatch blocker cleared",
    };
  } catch (error) {
    const failed = recordRecoverableDispatchRecoveryFailure({
      snapshot: input.snapshot,
      blocker,
      error,
      now: input.now,
    });
    input.store.appendHistoryBatchAndUpdateSnapshot(input.snapshot.issue_id, [failed.history], failed.snapshot);
    return {
      snapshot: failed.snapshot,
      nextAction: "dispatch_recovery_failed_retryable",
      message: `Dispatch recovery blocked: ${errorMessage(error)}`,
    };
  }
}

async function reconcileReadyRecoverableDispatchBlocks(input: {
  snapshots: IssueSnapshot[];
  store: SqliteControlPlaneStore;
  domain: DomainDriver;
  workflow: WorkflowDefinition;
  now: string;
  observability?: ProductionObservability;
  metrics: ReturnType<typeof emptyManualCliMetrics>;
  projectId?: string;
  progress?: ProductionProgressReporter;
}): Promise<{ reconciled: boolean }> {
  let reconciled = false;
  if (!input.domain.recoverDispatchBlock) return { reconciled };

  for (const snapshot of input.snapshots) {
    if (snapshot.lifecycle_state !== "ready") continue;
    const blockers = recoverableBlockedByForSnapshot(snapshot);
    if (blockers.length === 0) continue;
    const blocker = blockers[0];
    if (!blocker) continue;
    const stageName = firstStageName(input.workflow);
    const roleName = roleNameForStage(input.workflow, stageName);
    const blockedErrorCode = typeof snapshot.runtime_context_json.blocked_error_code === "string"
      ? snapshot.runtime_context_json.blocked_error_code
      : undefined;

    try {
      const recovery = await input.domain.recoverDispatchBlock({
        ...domainContext({
          snapshot,
          workflow: input.workflow,
          stageName,
          roleName,
        }),
        blocker,
        blockedErrorCode,
      });
      if (!recovery?.recovered) continue;

      const recovered = clearRecoverableDispatchBlock({
        snapshot,
        blocker,
        now: input.now,
      });
      input.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, [recovered.history], recovered.snapshot);
      reconciled = true;
      await syncIssueProgress(input.observability, recovered.snapshot, input.now, recovery.note ?? "Recoverable dispatch blocker cleared");
      await syncProjectProjection(input.observability, input.metrics, input.store, recovered.snapshot, input.workflow, input.projectId, {
        persistSyncedMarker: true,
        persistRetryMarker: true,
        now: input.now,
        progress: input.progress,
      });
    } catch (error) {
      const failed = recordRecoverableDispatchRecoveryFailure({
        snapshot,
        blocker,
        error,
        now: input.now,
      });
      input.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, [failed.history], failed.snapshot);
      await syncIssueProgress(input.observability, failed.snapshot, input.now, `Dispatch recovery blocked: ${errorMessage(error)}`);
      await syncProjectProjection(input.observability, input.metrics, input.store, failed.snapshot, input.workflow, input.projectId, {
        persistSyncedMarker: true,
        persistRetryMarker: true,
        now: input.now,
        progress: input.progress,
      });
    }
  }

  return { reconciled };
}

async function reconcileClosedReadyIssuesBeforeScheduling(input: {
  snapshots: IssueSnapshot[];
  store: SqliteControlPlaneStore;
  workflow: WorkflowDefinition;
  issueSource?: ProductionIssueSource;
  observability?: ProductionObservability;
  metrics: ReturnType<typeof emptyManualCliMetrics>;
  projectId?: string;
  now: string;
  progress?: ProductionProgressReporter;
}): Promise<boolean> {
  let reconciled = false;
  for (const snapshot of input.snapshots) {
    if (snapshot.lifecycle_state !== "ready") continue;
    const closed = await reconcileExternalIssueClosedIfAvailable({
      snapshot,
      store: input.store,
      workflow: input.workflow,
      issueSource: input.issueSource,
      now: input.now,
      progress: input.progress,
    });
    if (!closed) continue;
    reconciled = true;
    await syncIssueProgress(input.observability, closed.snapshot, input.now, "External GitHub issue is closed");
    await syncProjectProjection(input.observability, input.metrics, input.store, closed.snapshot, input.workflow, input.projectId, {
      persistSyncedMarker: true,
      persistRetryMarker: true,
      now: input.now,
      progress: input.progress,
    });
  }
  return reconciled;
}

async function reconcileCompletedSyncWorktreeRecovery(input: {
  snapshots: IssueSnapshot[];
  store: SqliteControlPlaneStore;
  domain: DomainDriver;
  workflow: WorkflowDefinition;
  now: string;
  observability?: ProductionObservability;
  metrics: ReturnType<typeof emptyManualCliMetrics>;
  projectId?: string;
  progress?: ProductionProgressReporter;
}): Promise<{ reconciled: boolean; blockedDispatch: boolean }> {
  let reconciled = false;
  let blockedDispatch = false;
  for (const snapshot of input.snapshots) {
    let nextSnapshot = snapshot;
    const refreshedPullRequest = await refreshCompletedPullRequestMetadataIfAvailable({
      snapshot,
      domain: input.domain,
      workflow: input.workflow,
      now: input.now,
    });
    if (refreshedPullRequest) {
      nextSnapshot = refreshedPullRequest.snapshot;
      input.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, refreshedPullRequest.history, nextSnapshot);
      await syncProjectProjection(input.observability, input.metrics, input.store, nextSnapshot, input.workflow, input.projectId, {
        persistSyncedMarker: true,
        persistRetryMarker: true,
        now: input.now,
        progress: input.progress,
      });
      reconciled = true;
      blockedDispatch = true;
    }

    const refresh = syncWorktreeRefreshForSnapshot(nextSnapshot);
    if (!pendingCompletedSyncWorktreeRecovery(nextSnapshot, refresh)) continue;
    blockedDispatch = true;
    if (!input.domain.refreshCompletedBase || !syncWorktreeRecoveryDue(refresh, input.now)) {
      await syncProjectProjection(input.observability, input.metrics, input.store, nextSnapshot, input.workflow, input.projectId, {
        persistSyncedMarker: true,
        persistRetryMarker: true,
        now: input.now,
        progress: input.progress,
      });
      continue;
    }

    const result = submitSyncWorktreeRefreshResult({
      snapshot: nextSnapshot,
      workflow: input.workflow,
      syncWorktree: await refreshCompletedBaseForRecovery(input.domain, nextSnapshot, input.workflow, refresh),
      now: input.now,
    });
    result.history.unshift({
      event_type: "sync_worktree_refresh_retry_started",
      payload: {
        expected_commit: stringValue(refresh.expected_commit),
        attempt_count: numericMetric(refresh.attempt_count, 0) + 1,
      },
    });
    input.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, result.history, result.snapshot);
    await emitProgress(input.progress, {
      event: "sync_worktree_refresh_retry_started",
      issue_id: result.snapshot.issue_id,
      issue_number: issueNumberFromSnapshot(result.snapshot),
      lifecycle_state: result.snapshot.lifecycle_state,
      status: "started",
      projection_target: "sync_worktree",
      message: `Retrying completed sync worktree refresh for expected commit ${stringValue(refresh.expected_commit)}`,
    });
    await syncProjectProjection(input.observability, input.metrics, input.store, result.snapshot, input.workflow, input.projectId, {
      persistSyncedMarker: true,
      persistRetryMarker: true,
      now: input.now,
      progress: input.progress,
    });
    reconciled = true;
  }
  return { reconciled, blockedDispatch };
}

async function refreshCompletedBaseForRecovery(
  domain: DomainDriver,
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition,
  refresh: Record<string, unknown>,
): Promise<ReleaseSyncWorktreeResult> {
  const expectedCommit = stringValue(refresh.expected_commit);
  if (!expectedCommit) {
    return {
      status: "failed",
      code: "SYNC_WORKTREE_EXPECTED_COMMIT_MISSING",
      lastError: "sync worktree recovery is missing expected merge SHA",
      retryable: true,
    };
  }
  try {
    const stageName = releaseStageName(workflow) ?? currentStageName(snapshot, workflow);
    const result = await domain.refreshCompletedBase?.({
      ...domainContext({
        snapshot,
        workflow,
        stageName,
        roleName: roleNameForStage(workflow, stageName),
      }),
      mergeSha: expectedCommit,
    });
    return result ?? {
      status: "skipped",
      expectedCommit,
    };
  } catch (error) {
    return {
      status: "failed",
      expectedCommit,
      code: errorCode(error) ?? "SYNC_WORKTREE_REFRESH_FAILED",
      lastError: errorMessage(error),
      retryable: true,
    };
  }
}

async function reconcileExternalIssueClosedIfAvailable(input: {
  snapshot: IssueSnapshot;
  store: SqliteControlPlaneStore;
  workflow: WorkflowDefinition;
  issueSource?: ProductionIssueSource;
  now: string;
  progress?: ProductionProgressReporter;
}): Promise<{ snapshot: IssueSnapshot } | undefined> {
  if (!input.issueSource || input.snapshot.lifecycle_state === "completed" || input.snapshot.lifecycle_state === "cancelled") {
    return undefined;
  }
  const issueNumber = issueNumberFromSnapshot(input.snapshot);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return undefined;

  const sourceState = await input.issueSource.readIssueState(issueNumber);
  if (String(sourceState.state).toLowerCase() !== "closed") return undefined;

  const result = applyRuntimeEvents(input.snapshot, input.workflow, [{
    type: "external_issue_closed_detected",
    issue_number: issueNumber,
    ...(sourceState.stateReason === undefined || sourceState.stateReason === null ? {} : { state_reason: sourceState.stateReason }),
    ...(sourceState.closedAt === undefined || sourceState.closedAt === null ? {} : { closed_at: sourceState.closedAt }),
    ...(sourceState.labels === undefined ? {} : { labels: sourceState.labels }),
    at: input.now,
  }]);
  input.store.appendHistoryBatchAndUpdateSnapshot(input.snapshot.issue_id, result.history, result.snapshot);
  await emitProgress(input.progress, {
    event: "external_issue_closed_detected",
    issue_id: result.snapshot.issue_id,
    issue_number: issueNumber,
    lifecycle_state: result.snapshot.lifecycle_state,
    message: `GitHub issue #${issueNumber} is closed`,
  });
  return { snapshot: result.snapshot };
}

async function syncProjectProjection(
  observability: ProductionObservability | undefined,
  metrics: ReturnType<typeof emptyManualCliMetrics>,
  store: SqliteControlPlaneStore,
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition,
  projectId: string | undefined,
  options: { persistSyncedMarker?: boolean; persistRetryMarker?: boolean; now?: string; progress?: ProductionProgressReporter } = {},
): Promise<"success" | "failed" | "skipped" | "unknown"> {
  const issueNumber = issueNumberFromSnapshot(snapshot);
  if (!observability?.syncProjectFields || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    await emitProgress(options.progress, {
      event: "project_synced",
      issue_id: snapshot.issue_id,
      issue_number: Number.isInteger(issueNumber) ? issueNumber : undefined,
      lifecycle_state: snapshot.lifecycle_state,
      projection_target: "github_project",
      status: "skipped",
    });
    return "skipped";
  }
  const fields = projectFieldsForSnapshot(snapshot, workflow);
  try {
    const result = await observability.syncProjectFields({
      issueNumber,
      lifecycleState: snapshot.lifecycle_state,
      projectId,
      fields,
    });
    const status = recordProjectProjectionResult(metrics, store, snapshot, workflow, result, fields, {
      persistRetryMarker: options.persistRetryMarker === true,
    });
    if (options.persistSyncedMarker !== false && (status === "success" || status === "skipped")) {
      persistProjectProjectionMarker(store, snapshot, fields, status);
    }
    await emitProgress(options.progress, {
      event: status === "failed" ? "project_sync_failed" : "project_synced",
      issue_id: snapshot.issue_id,
      issue_number: issueNumber,
      lifecycle_state: snapshot.lifecycle_state,
      projection_target: "github_project",
      status,
    });
    return status;
  } catch (error) {
    metrics.github_projection_failures_retryable += 1;
    metrics.github_projection_failures_do_not_mutate_lifecycle += 1;
    const event: Extract<RuntimeEvent, { type: "projection_result" }> = {
      type: "projection_result",
      projection_target: "github_project",
      status: "failed",
      last_error: error instanceof Error ? error.message : String(error),
      next_retry_at: addSeconds(options.now ?? new Date().toISOString(), 60),
      payload: { issueNumber, lifecycleState: snapshot.lifecycle_state, projectId, fields },
    };
    persistProjectionFailure(store, snapshot, workflow, event);
    if (options.persistRetryMarker) {
      persistProjectProjectionRetryMarker(store, snapshot, event);
    }
    await emitProgress(options.progress, {
      event: "project_sync_failed",
      issue_id: snapshot.issue_id,
      issue_number: issueNumber,
      lifecycle_state: snapshot.lifecycle_state,
      projection_target: "github_project",
      status: "failed",
    });
    return "failed";
  }
}

async function ignoreProjectionFailure(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // Projection errors are retryable observability failures and must not mutate lifecycle.
  }
}

async function emitProgress(progress: ProductionProgressReporter | undefined, event: ProductionProgressEvent): Promise<void> {
  if (!progress) return;
  await progress(event);
}

function projectFieldsForSnapshot(snapshot: IssueSnapshot, workflow: WorkflowDefinition): Record<string, unknown> {
  const lifecycle = snapshot.lifecycle_state;
  const { status } = projectStatusForLifecycle(lifecycle);
  return {
    "Northstar Lifecycle": lifecycle,
    Status: projectStatusForSnapshot(snapshot, status),
    "PR URL": prUrlForSnapshot(snapshot),
    "Merge SHA": mergeShaForSnapshot(snapshot),
    "Current Stage": projectCurrentStageForSnapshot(snapshot, workflow),
    "Last Error": lastErrorForSnapshot(snapshot),
    "Retry Count": retryCountForSnapshot(snapshot),
    "Blocked By": blockedByForSnapshot(snapshot),
  };
}

function projectStatusForSnapshot(snapshot: IssueSnapshot, lifecycleStatus: string): string {
  if (pendingCompletedSyncWorktreeRecovery(snapshot, syncWorktreeRefreshForSnapshot(snapshot))) {
    return "Blocked";
  }
  if (dependencyBlockedByForSnapshot(snapshot).length > 0) {
    return "Blocked";
  }
  if (recoverableBlockedByForSnapshot(snapshot).length > 0) {
    return "Blocked";
  }
  return lifecycleStatus;
}

function recoverableDispatchBlockedResult(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  error: unknown;
  now: string;
}) {
  const code = errorCode(input.error) ?? "DISPATCH_BLOCKED_RECOVERABLE";
  const message = errorMessage(input.error);
  const snapshot = structuredClone(input.snapshot) as IssueSnapshot;
  snapshot.lifecycle_state = "ready";
  delete snapshot.current_session_id;
  delete snapshot.runtime_context_json.owner_lease;
  delete snapshot.runtime_context_json.stage_cursor;
  snapshot.runtime_context_json = {
    ...snapshot.runtime_context_json,
    last_error: message,
    blocked_by: addBlockedBy(snapshot.runtime_context_json.blocked_by, "sync_worktree"),
    recoverable: true,
    blocked_error_code: code,
  };
  return {
    snapshot,
    history: [{
      event_type: "dispatch_blocked_recoverable",
      payload: {
        code,
        message,
        blocked_by: "sync_worktree",
        at: input.now,
      },
    }],
    effects: [],
    operatorMessages: [],
  };
}

function clearRecoverableDispatchBlock(input: {
  snapshot: IssueSnapshot;
  blocker: string;
  now: string;
}) {
  const snapshot = structuredClone(input.snapshot) as IssueSnapshot;
  const remainingBlockedBy = removeBlockedBy(snapshot.runtime_context_json.blocked_by, input.blocker);
  if (remainingBlockedBy.length > 0) {
    snapshot.runtime_context_json.blocked_by = remainingBlockedBy;
  } else {
    delete snapshot.runtime_context_json.blocked_by;
    delete snapshot.runtime_context_json.recoverable;
    delete snapshot.runtime_context_json.blocked_error_code;
    delete snapshot.runtime_context_json.last_error;
  }
  return {
    snapshot,
    history: {
      event_type: "dispatch_recovery_succeeded",
      payload: {
        blocked_by: input.blocker,
        at: input.now,
      },
    },
  };
}

function recordRecoverableDispatchRecoveryFailure(input: {
  snapshot: IssueSnapshot;
  blocker: string;
  error: unknown;
  now: string;
}) {
  const snapshot = structuredClone(input.snapshot) as IssueSnapshot;
  const message = errorMessage(input.error);
  snapshot.runtime_context_json = {
    ...snapshot.runtime_context_json,
    last_error: message,
    blocked_by: addBlockedBy(snapshot.runtime_context_json.blocked_by, input.blocker),
    recoverable: true,
    blocked_error_code: errorCode(input.error) ?? snapshot.runtime_context_json.blocked_error_code,
  };
  return {
    snapshot,
    history: {
      event_type: "dispatch_recovery_failed_retryable",
      payload: {
        blocked_by: input.blocker,
        error: message,
        code: errorCode(input.error) ?? "DISPATCH_RECOVERY_FAILED",
        at: input.now,
      },
    },
  };
}

function agentArtifactRejectedResult(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  error: unknown;
  now: string;
  eventType: "worker_artifact_rejected" | "verifier_artifact_rejected";
}) {
  const message = errorMessage(input.error);
  const result = releaseActiveRuntimeOwnership(input.snapshot, input.workflow, {
    now: input.now,
    reasonCode: input.eventType === "worker_artifact_rejected"
      ? "worker_artifact_rejected_retryable"
      : "artifact_rejected_retryable",
    details: {
      error: message,
    },
  });
  result.snapshot.runtime_context_json = {
    ...result.snapshot.runtime_context_json,
    last_error: message,
    recoverable: true,
  };
  result.snapshot.runtime_context_json.exception_carry_forward = {
    error: message,
  };
  const blockedBy = removeBlockedBy(result.snapshot.runtime_context_json.blocked_by, "verifier_artifact");
  if (blockedBy.length > 0) {
    result.snapshot.runtime_context_json.blocked_by = blockedBy;
  } else {
    delete result.snapshot.runtime_context_json.blocked_by;
  }
  result.history.push({
    event_type: input.eventType,
    payload: {
      reason: message,
      retryable: true,
      at: input.now,
    },
  });
  return result;
}

function agentArtifactRejectedResultOrThrow(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  error: unknown;
  now: string;
  eventType: "worker_artifact_rejected" | "verifier_artifact_rejected";
}) {
  if (!isAgentArtifactRejection(input.error)) {
    throw input.error;
  }
  return agentArtifactRejectedResult(input);
}

function pullRequestFromError(error: unknown): {
  prNumber: number;
  prUrl: string;
  branch: string;
  commitSha: string;
} | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const pullRequest = (error as { pullRequest?: unknown }).pullRequest;
  if (typeof pullRequest !== "object" || pullRequest === null) return undefined;
  const record = pullRequest as Record<string, unknown>;
  if (typeof record.prNumber !== "number" || !Number.isInteger(record.prNumber)) return undefined;
  if (typeof record.prUrl !== "string" || record.prUrl.length === 0) return undefined;
  if (typeof record.branch !== "string" || record.branch.length === 0) return undefined;
  if (typeof record.commitSha !== "string" || record.commitSha.length === 0) return undefined;
  return {
    prNumber: record.prNumber,
    prUrl: record.prUrl,
    branch: record.branch,
    commitSha: record.commitSha,
  };
}

function pullRequestFromReleaseResult(release: ReleaseResult): PullRequestResult | undefined {
  if (typeof release.prNumber !== "number" || !Number.isInteger(release.prNumber)) return undefined;
  if (typeof release.prUrl !== "string" || release.prUrl.length === 0) return undefined;
  if (typeof release.branch !== "string" || release.branch.length === 0) return undefined;
  if (typeof release.commitSha !== "string" || release.commitSha.length === 0) return undefined;
  return {
    prNumber: release.prNumber,
    prUrl: release.prUrl,
    branch: release.branch,
    commitSha: release.commitSha,
  };
}

function releaseIssueUpdateFromSnapshot(snapshot: IssueSnapshot): {
  comment_summary?: string;
  close_issue?: boolean;
  labels_to_add?: string[];
  labels_to_remove?: string[];
} | undefined {
  const release = snapshot.runtime_context_json.release;
  if (typeof release !== "object" || release === null || Array.isArray(release)) return undefined;
  const issueUpdate = (release as Record<string, unknown>).issue_update;
  if (typeof issueUpdate !== "object" || issueUpdate === null || Array.isArray(issueUpdate)) return undefined;
  const record = issueUpdate as Record<string, unknown>;
  return {
    ...(typeof record.comment_summary === "string" ? { comment_summary: record.comment_summary } : {}),
    ...(typeof record.close_issue === "boolean" ? { close_issue: record.close_issue } : {}),
    ...(Array.isArray(record.labels_to_add) ? { labels_to_add: record.labels_to_add.filter((label): label is string => typeof label === "string") } : {}),
    ...(Array.isArray(record.labels_to_remove)
      ? { labels_to_remove: record.labels_to_remove.filter((label): label is string => typeof label === "string") }
      : {}),
  };
}

function isAgentArtifactRejection(error: unknown): boolean {
  if (error instanceof ArtifactValidationError) return true;
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    const code = (error as { code: string }).code;
    if (code.startsWith("ARTIFACT_")) return true;
  }
  return /agent result .* must be|browser acceptance requires a structured verifier evidence artifact|ARTIFACT_BROWSER_EVIDENCE_REQUIRED|ArtifactValidationError/i
    .test(errorMessage(error));
}

function artifactRejectionEventType(error: unknown): "worker_artifact_rejected" | "verifier_artifact_rejected" {
  return /agent result .* must be/i.test(errorMessage(error))
    ? "worker_artifact_rejected"
    : "verifier_artifact_rejected";
}

function isRecoverableDispatchBlocker(error: unknown): boolean {
  return [
    "SYNC_WORKTREE_DIRTY",
    "SYNC_WORKTREE_STATUS_FAILED",
    "SYNC_WORKTREE_FETCH_FAILED",
    "SYNC_WORKTREE_FAST_FORWARD_FAILED",
    "SYNC_WORKTREE_CREATE_FAILED",
    "WORKTREE_BASE_SYNC_FAILED",
  ].includes(errorCode(error) ?? "");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordProjectProjectionResult(
  metrics: ReturnType<typeof emptyManualCliMetrics>,
  store: SqliteControlPlaneStore,
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition,
  result: unknown,
  fields: Record<string, unknown>,
  options: { persistRetryMarker?: boolean } = {},
): "success" | "failed" | "skipped" | "unknown" {
  const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
  if (record.status === "failed") {
    metrics.github_projection_failures_retryable += 1;
    metrics.github_projection_failures_do_not_mutate_lifecycle += record.mutates_lifecycle === true ? 0 : 1;
    const event = projectionFailureFromRecord(record);
    persistProjectionFailure(store, snapshot, workflow, event);
    if (options.persistRetryMarker) {
      persistProjectProjectionRetryMarker(store, snapshot, event);
    }
    return "failed";
  }
  if (record.status === "skipped") return "skipped";
  if (record.status !== "success") return "unknown";

  const payload = typeof record.payload === "object" && record.payload !== null ? record.payload as Record<string, unknown> : {};
  const resultMetrics = typeof payload.metrics === "object" && payload.metrics !== null ? payload.metrics as Record<string, unknown> : {};
  metrics.github_project_items_synced += numericMetric(resultMetrics.github_project_items_synced, 1);
  metrics.github_project_lifecycle_completed += numericMetric(resultMetrics.github_project_lifecycle_completed, fields["Northstar Lifecycle"] === "completed" ? 1 : 0);
  metrics.github_project_status_done += numericMetric(resultMetrics.github_project_status_done, fields.Status === "Done" ? 1 : 0);
  metrics.github_project_pr_urls_synced += numericMetric(resultMetrics.github_project_pr_urls_synced, fields["PR URL"] ? 1 : 0);
  metrics.github_project_merge_shas_synced += numericMetric(resultMetrics.github_project_merge_shas_synced, fields["Merge SHA"] ? 1 : 0);
  metrics.github_project_status_mismatches += numericMetric(resultMetrics.github_project_status_mismatches, 0);
  return "success";
}

function persistProjectionFailure(
  store: SqliteControlPlaneStore,
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition,
  event: Extract<RuntimeEvent, { type: "projection_result" }>,
): void {
  const result = applyRuntimeEvents(snapshot, workflow, [event]);
  store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, result.history, result.snapshot);
}

function persistProjectProjectionMarker(
  store: SqliteControlPlaneStore,
  snapshot: IssueSnapshot,
  fields: Record<string, unknown>,
  status: "success" | "skipped",
): void {
  store.recordIdempotentHistory(snapshot.issue_id, {
    event_type: "project_projection_synced",
    payload: {
      projection_target: "github_project",
      lifecycle: snapshot.lifecycle_state,
      status,
      project_status: fields.Status,
      idempotency_key: terminalProjectProjectionKey(snapshot, fields.Status),
    },
  });
}

function persistProjectProjectionRetryMarker(
  store: SqliteControlPlaneStore,
  snapshot: IssueSnapshot,
  event: Extract<RuntimeEvent, { type: "projection_result" }>,
): void {
  store.recordIdempotentHistory(snapshot.issue_id, {
    event_type: "project_projection_retry_scheduled",
    payload: {
      projection_target: "github_project",
      lifecycle: snapshot.lifecycle_state,
      next_retry_at: event.next_retry_at,
      last_error: event.last_error,
      idempotency_key: `${terminalProjectProjectionKey(snapshot)}:retry:${event.next_retry_at}`,
    },
  });
}

function terminalProjectProjectionNeeded(store: SqliteControlPlaneStore, snapshot: IssueSnapshot, now: string): boolean {
  if (!["completed", "cancelled", "failed", "quarantined"].includes(snapshot.lifecycle_state)) return false;
  const history = store.listHistory(snapshot.issue_id);
  if (history.some((entry) =>
    entry.event_type === "project_projection_synced" &&
    entry.payload.projection_target === "github_project" &&
    entry.payload.lifecycle === snapshot.lifecycle_state
  )) {
    return false;
  }
  const retry = history
    .filter((entry) =>
      entry.event_type === "project_projection_retry_scheduled" &&
      entry.payload.projection_target === "github_project" &&
      entry.payload.lifecycle === snapshot.lifecycle_state &&
      typeof entry.payload.next_retry_at === "string"
    )
    .at(-1);
  if (!retry) return true;
  return Date.parse(String(retry.payload.next_retry_at)) <= Date.parse(now);
}

function terminalDependencyBlockForSnapshot(snapshot: IssueSnapshot, allIssues: IssueSnapshot[]): { blockedBy: string[]; lastError: string } | undefined {
  const dependencies = Array.isArray(snapshot.runtime_context_json.dependencies)
    ? snapshot.runtime_context_json.dependencies.filter((value): value is number => typeof value === "number")
    : [];
  if (dependencies.length === 0) return undefined;

  const byIssueNumber = new Map(allIssues.map((issue) => [issueNumberFromSnapshot(issue), issue]));
  const blockers = dependencies
    .map((dependency) => ({ dependency, snapshot: byIssueNumber.get(dependency) }))
    .filter((item): item is { dependency: number; snapshot: IssueSnapshot } =>
      item.snapshot !== undefined &&
      (item.snapshot.lifecycle_state === "quarantined" || item.snapshot.lifecycle_state === "failed" || item.snapshot.lifecycle_state === "cancelled")
    );
  if (blockers.length === 0) return undefined;

  const blockedBy = blockers.map((blocker) => `dependency:${blocker.dependency}:${blocker.snapshot.lifecycle_state}`);
  const first = blockers[0];
  return {
    blockedBy,
    lastError: `Dependency #${first.dependency} is ${first.snapshot.lifecycle_state}`,
  };
}

function dependencyBlockedResult(input: {
  snapshot: IssueSnapshot;
  blockedBy: string[];
  lastError: string;
  now: string;
}): { snapshot: IssueSnapshot; history: { event_type: string; payload: Record<string, unknown> } } | undefined {
  const currentBlockedBy = dependencyBlockedByForSnapshot(input.snapshot);
  if (arraysEqual(currentBlockedBy, input.blockedBy) && input.snapshot.runtime_context_json.last_error === input.lastError) {
    return undefined;
  }
  const snapshot = {
    ...input.snapshot,
    runtime_context_json: {
      ...input.snapshot.runtime_context_json,
      blocked_by: mergeDependencyBlockedBy(input.snapshot.runtime_context_json.blocked_by, input.blockedBy),
      last_error: input.lastError,
    },
  };
  return {
    snapshot,
    history: {
      event_type: "dependency_blocked",
      payload: {
        blocked_by: input.blockedBy,
        reason: input.lastError,
        at: input.now,
      },
    },
  };
}

function clearDependencyBlockIfPresent(input: {
  snapshot: IssueSnapshot;
  now: string;
}): { snapshot: IssueSnapshot; history: { event_type: string; payload: Record<string, unknown> } } | undefined {
  if (dependencyBlockedByForSnapshot(input.snapshot).length === 0) return undefined;
  const blockedBy = Array.isArray(input.snapshot.runtime_context_json.blocked_by)
    ? input.snapshot.runtime_context_json.blocked_by.filter((value) => !String(value).startsWith("dependency:"))
    : [];
  const runtimeContext = { ...input.snapshot.runtime_context_json };
  if (blockedBy.length > 0) {
    runtimeContext.blocked_by = blockedBy;
  } else {
    delete runtimeContext.blocked_by;
  }
  if (typeof runtimeContext.last_error === "string" && runtimeContext.last_error.startsWith("Dependency #")) {
    delete runtimeContext.last_error;
  }
  return {
    snapshot: { ...input.snapshot, runtime_context_json: runtimeContext },
    history: {
      event_type: "dependency_unblocked",
      payload: { at: input.now },
    },
  };
}

function dependencyBlockedByForSnapshot(snapshot: IssueSnapshot): string[] {
  const blockedBy = snapshot.runtime_context_json.blocked_by;
  if (!Array.isArray(blockedBy)) return [];
  return blockedBy.map(String).filter((value) => value.startsWith("dependency:"));
}

function blockedByListForSnapshot(snapshot: IssueSnapshot): string[] {
  const blockedBy = snapshot.runtime_context_json.blocked_by;
  if (!Array.isArray(blockedBy)) return [];
  return blockedBy.map(String).filter((value) => value.length > 0);
}

function addBlockedBy(value: unknown, blocker: string): string[] {
  const existing = Array.isArray(value) ? value.map(String) : [];
  return [...new Set([...existing, blocker])];
}

function removeBlockedBy(value: unknown, blocker: string): string[] {
  const existing = Array.isArray(value) ? value.map(String) : [];
  return existing.filter((entry) => entry !== blocker);
}

function mergeDependencyBlockedBy(value: unknown, dependencyBlockers: string[]): string[] {
  const existing = Array.isArray(value)
    ? value.map(String).filter((entry) => !entry.startsWith("dependency:"))
    : [];
  return [...new Set([...existing, ...dependencyBlockers])];
}

function recoverableBlockedByForSnapshot(snapshot: IssueSnapshot): string[] {
  const blockedBy = snapshot.runtime_context_json.blocked_by;
  if (!Array.isArray(blockedBy)) return [];
  return blockedBy.map(String).filter((value) => value === "sync_worktree" || value === "host_liveness");
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function terminalProjectProjectionKey(snapshot: IssueSnapshot, projectStatus?: unknown): string {
  const statusSuffix = projectStatus === undefined || projectStatus === null || projectStatus === ""
    ? ""
    : `:${String(projectStatus)}`;
  return `project_projection:${snapshot.issue_id}:${snapshot.lifecycle_state}${statusSuffix}`;
}

function pendingCompletedSyncWorktreeRecovery(snapshot: IssueSnapshot, refresh: Record<string, unknown> | undefined): refresh is Record<string, unknown> {
  return snapshot.lifecycle_state === "completed" &&
    refresh?.status === "failed" &&
    refresh.retryable !== false &&
    stringValue(refresh.expected_commit) !== "";
}

function syncWorktreeRecoveryDue(refresh: Record<string, unknown>, now: string): boolean {
  const nextRetryAt = stringValue(refresh.next_retry_at);
  return !nextRetryAt || Date.parse(nextRetryAt) <= Date.parse(now);
}

function syncWorktreeRefreshForSnapshot(snapshot: IssueSnapshot): Record<string, unknown> | undefined {
  const release = snapshot.runtime_context_json.release;
  if (!release || typeof release !== "object" || Array.isArray(release)) return undefined;
  const refresh = (release as Record<string, unknown>).sync_worktree_refresh;
  return refresh && typeof refresh === "object" && !Array.isArray(refresh) ? refresh as Record<string, unknown> : undefined;
}

function projectionFailureFromRecord(record: Record<string, unknown>): Extract<RuntimeEvent, { type: "projection_result" }> {
  return {
    type: "projection_result",
    projection_target: typeof record.projection_target === "string" ? record.projection_target : "github_project",
    status: "failed",
    attempt: typeof record.attempt === "number" ? record.attempt : 1,
    last_error: typeof record.last_error === "string" ? record.last_error : "GitHub Project sync failed",
    next_retry_at: typeof record.next_retry_at === "string" ? record.next_retry_at : new Date(Date.now() + 60_000).toISOString(),
    payload: typeof record.payload === "object" && record.payload !== null ? record.payload as Record<string, unknown> : {},
  };
}

function numericMetric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function dependencyFreeVerifierArtifactBlock(snapshot: IssueSnapshot): boolean {
  const blockedBy = snapshot.runtime_context_json.blocked_by;
  if (!Array.isArray(blockedBy)) return false;
  return blockedBy.map(String).includes("verifier_artifact");
}

function pullRequestForSnapshot(snapshot: IssueSnapshot): PullRequestResult | undefined {
  const pr = snapshot.runtime_context_json.pr;
  if (typeof pr !== "object" || pr === null) return undefined;
  const record = pr as Record<string, unknown>;
  const prNumber = record.prNumber;
  const prUrl = record.prUrl;
  const branch = record.branch;
  const commitSha = record.commitSha ?? record.headCommit;
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber)) return undefined;
  if (typeof prUrl !== "string" || prUrl.length === 0) return undefined;
  if (typeof branch !== "string" || branch.length === 0) return undefined;
  if (typeof commitSha !== "string" || commitSha.length === 0) return undefined;
  return { prNumber, prUrl, branch, commitSha };
}

async function refreshPullRequestMetadataFromDomain(input: {
  snapshot: IssueSnapshot;
  domain: DomainDriver;
  workflow: WorkflowDefinition;
  stageName: string;
  roleName: string;
}): Promise<PullRequestResult | undefined> {
  if (!input.domain.reconcileExternalCompletion) return undefined;

  const completion = await input.domain.reconcileExternalCompletion(domainContext({
    snapshot: input.snapshot,
    workflow: input.workflow,
    stageName: input.stageName,
    roleName: input.roleName,
  }));
  if (!completion?.completed || completion.prNumber === undefined || completion.prUrl === undefined || completion.branch === undefined) {
    return undefined;
  }

  if (typeof completion.commitSha !== "string" || completion.commitSha.length === 0) return undefined;
  if (typeof completion.prNumber !== "number" || !Number.isInteger(completion.prNumber)) return undefined;
  if (typeof completion.prUrl !== "string" || completion.prUrl.length === 0) return undefined;
  if (typeof completion.branch !== "string" || completion.branch.length === 0) return undefined;

  return {
    prNumber: completion.prNumber,
    prUrl: completion.prUrl,
    branch: completion.branch,
    commitSha: completion.commitSha,
  };
}

function prUrlForSnapshot(snapshot: IssueSnapshot): string {
  const pr = snapshot.runtime_context_json.pr;
  return typeof pr === "object" && pr !== null && "prUrl" in pr ? String((pr as { prUrl?: unknown }).prUrl ?? "") : "";
}

function mergeShaForSnapshot(snapshot: IssueSnapshot): string {
  const release = snapshot.runtime_context_json.release;
  return typeof release === "object" && release !== null && "merge_sha" in release
    ? String((release as { merge_sha?: unknown }).merge_sha ?? "")
    : "";
}

function lastErrorForSnapshot(snapshot: IssueSnapshot): string {
  const value = snapshot.runtime_context_json.last_error;
  return value === undefined || value === null ? "" : String(value);
}

function retryCountForSnapshot(snapshot: IssueSnapshot): number {
  const value = snapshot.runtime_context_json.retry_count;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function blockedByForSnapshot(snapshot: IssueSnapshot): string {
  const blockedBy = blockedByListForSnapshot(snapshot);
  if (blockedBy.length > 0) return blockedBy.join(", ");
  const value = snapshot.runtime_context_json.blocked_by;
  return value === undefined || value === null ? "" : String(value);
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

export interface WorkflowGeneralityScan {
  workflow_generality_hardcoded_role_chain_matches: number;
  workflow_generality_hardcoded_release_merge_matches: number;
  files_scanned: number;
}

export async function scanForHardcodedDevWorkflowChain(root = "src/orchestrator"): Promise<WorkflowGeneralityScan> {
  const files = await listSourceFiles(root);
  let roleChainMatches = 0;
  let releaseMergeMatches = 0;
  const implementationRole = "issue_worker";
  const verificationRole = "pr_verifier";
  const releaseRole = "release_worker";
  const stageArrow = "\\s*->\\s*";
  const devRoleChainPattern = new RegExp([implementationRole, stageArrow, verificationRole, stageArrow, releaseRole].join(""), "g");
  for (const file of files) {
    const source = await readFile(file, "utf8");
    roleChainMatches += matchCount(source, devRoleChainPattern);
    releaseMergeMatches += matchCount(source, /release\s*={2,3}\s*["']GitHub merge["']|release\s*==\s*GitHub merge/gi);
  }

  return {
    workflow_generality_hardcoded_role_chain_matches: roleChainMatches,
    workflow_generality_hardcoded_release_merge_matches: releaseMergeMatches,
    files_scanned: files.length,
  };
}

function firstStageName(workflow: WorkflowDefinition): string {
  const [stageName] = Object.keys(workflow.stages);
  if (!stageName) throw new Error(`Workflow ${workflow.id} has no stages`);
  return stageName;
}

function currentStageName(snapshot: { runtime_context_json: { stage_cursor?: string } }, workflow: WorkflowDefinition): string {
  return snapshot.runtime_context_json.stage_cursor ?? firstStageName(workflow);
}

function projectCurrentStageForSnapshot(snapshot: IssueSnapshot, workflow: WorkflowDefinition): string {
  if (snapshot.lifecycle_state === "completed" || snapshot.lifecycle_state === "cancelled" || snapshot.lifecycle_state === "failed" || snapshot.lifecycle_state === "quarantined") {
    return snapshot.lifecycle_state;
  }
  return currentStageName(snapshot, workflow);
}

function roleNameForStage(workflow: WorkflowDefinition, stageName: string): string {
  const stage = workflow.stages[stageName];
  if (!stage) throw new Error(`Unknown workflow stage ${stageName}`);
  return stage.role;
}

function releaseStageName(workflow: WorkflowDefinition): string | undefined {
  return Object.entries(workflow.stages).find(([, stage]) =>
    stage.lifecycle_state === "releasing" || stage.lifecycle_state === "release_pending"
  )?.[0];
}

function verificationStageName(workflow: WorkflowDefinition): string | undefined {
  return Object.entries(workflow.stages).find(([, stage]) => stage.lifecycle_state === "verifying")?.[0];
}

function releaseRoleName(workflow: WorkflowDefinition): string {
  const entry = Object.entries(workflow.stages).find(([, stage]) =>
    stage.lifecycle_state === "releasing" || stage.lifecycle_state === "release_pending"
  );
  if (!entry) throw new Error(`Workflow ${workflow.id} has no release stage`);
  return entry[1].role;
}

function latestChildRunIdForRole(snapshot: IssueSnapshot, roleName: string): string | undefined {
  return snapshot.runtime_context_json.child_runs
    ?.filter((run) => run.role === roleName)
    .at(-1)
    ?.child_run_id;
}

function runtimeSessionIdSegment(issueId: string, roleName: string, now: string): string {
  return [
    "northstar-runtime",
    normalizeRuntimeIdPart(issueId),
    normalizeRuntimeIdPart(roleName),
    normalizeRuntimeIdPart(now),
  ].join(":");
}

function normalizeRuntimeIdPart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "id";
}

function domainContext(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  stageName: string;
  roleName: string;
  recordStreamSession?: (session: DomainStreamSessionRecord) => void | Promise<void>;
}): DomainDriverContext {
  const packet = issuePacket(input.snapshot.runtime_context_json);
  return {
    issue: {
      id: input.snapshot.issue_id,
      number: Number(packet.issue_number ?? "0"),
      title: String(packet.title ?? ""),
      body: String(packet.raw_text ?? ""),
      sourceUrl: String(packet.source_url ?? ""),
    },
    workflow: {
      id: input.workflow.id,
      domain: input.workflow.domain,
    },
    stage: {
      name: input.stageName,
    },
    role: {
      name: input.roleName,
      definition: input.workflow.roles[input.roleName] as RoleDefinition,
    },
    runtimeContext: input.snapshot.runtime_context_json,
    recordStreamSession: input.recordStreamSession,
  };
}

function streamSessionRecorder(input: {
  store: SqliteControlPlaneStore;
  workflow: WorkflowDefinition;
  issueId: string;
  childRunId: string;
  now: () => string;
}): (session: DomainStreamSessionRecord) => void {
  return (session) => {
    const snapshot = input.store.getIssue(input.issueId);
    const result = applyRuntimeEvents(snapshot, input.workflow, [{
      type: "record_stream_session",
      child_run_id: input.childRunId,
      stream_adapter: session.stream_adapter,
      stream_session_id: session.stream_session_id,
      stream_child_run_id: session.stream_child_run_id,
      stream_root_session_id: session.stream_root_session_id,
      at: input.now(),
    }]);
    input.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, result.snapshot);
  };
}

function issueNumberFromSnapshot(snapshot: IssueSnapshot): number {
  return Number(issuePacket(snapshot.runtime_context_json).issue_number ?? "0");
}

function issuePacket(runtimeContext: RuntimeContext): Record<string, unknown> {
  const packet = runtimeContext.issue_packet;
  return typeof packet === "object" && packet !== null && !Array.isArray(packet) ? packet as Record<string, unknown> : {};
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function matchCount(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}
