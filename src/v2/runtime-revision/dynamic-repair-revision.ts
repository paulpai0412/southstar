import type { SouthstarDb } from "../db/postgres.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import { resolveWorkflowCandidates } from "../orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../orchestration/composition-compiler.ts";
import { runCompositionRepairLoop } from "../orchestration/composition-repair-loop.ts";
import {
  goalContractHash,
  storedGoalContract,
  type GoalContractV1,
} from "../orchestration/goal-contract.ts";
import type { WorkflowCompositionPlan } from "../design-library/types.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { findLibraryObjectByKey } from "../design-library/library-graph-store.ts";
import { persistTerminalGoalOutcomePg } from "../evaluators/goal-outcome.ts";
import { loadFrozenCoverageContextPg, type FrozenCoverageContext } from "../evaluators/requirement-evaluator-results.ts";
import { applyWorkflowRevision } from "../manifests/workflow-revision.ts";
import type { AgentProfile, RoleDefinition } from "../design-library/runtime-types.ts";
import type { HarnessDefinition, SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import { loadRunLibrarySnapshotPg, type RunLibrarySnapshotV1 } from "../orchestration/run-library-snapshot.ts";
import {
  appendHistoryEventPg,
  appendHistoryEventOncePg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
  updateWorkflowManifestPg,
} from "../stores/postgres-runtime-store.ts";

export type DynamicRepairRevisionInput = {
  runId: string;
  failedTaskId: string;
  failedArtifactRefId?: string;
  failedArtifact?: unknown;
  failedRequirementIds?: string[];
  workflowComposer?: WorkflowComposer;
  maxDynamicRepairRounds?: number;
};

export type DynamicRepairRevisionResult =
  | { status: "applied"; revisionId: string; newTaskIds: string[] }
  | { status: "waiting_operator_approval"; approvalId: string }
  | { status: "skipped"; reason: string };

type TaskRow = {
  id: string;
  status: string;
  sort_order: number;
  depends_on_json: unknown;
  snapshot_json: unknown;
};

type RunRow = {
  status: string;
  domain: string;
  goal_prompt: string;
  workflow_manifest_json: SouthstarWorkflowManifest;
  runtime_context_json: unknown;
};

export async function maybeApplyDynamicRepairRevisionPg(
  db: SouthstarDb,
  input: DynamicRepairRevisionInput,
): Promise<DynamicRepairRevisionResult> {
  if (!input.workflowComposer) return { status: "skipped", reason: "workflow-composer-unavailable" };
  const maxRounds = input.maxDynamicRepairRounds ?? 2;
  if (maxRounds < 1) return { status: "skipped", reason: "dynamic-repair-disabled" };

  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<RunRow>(
      `select status, domain, goal_prompt, workflow_manifest_json, runtime_context_json
         from southstar.workflow_runs
        where id = $1
        for update`,
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);
    if (!["running", "scheduling", "awaiting_approval"].includes(run.status)) {
      return { status: "skipped", reason: `run-status:${run.status}` };
    }
    const goalContractLineage = await loadCanonicalGoalContractLineage(tx, run);
    if ("reason" in goalContractLineage) {
      return { status: "skipped", reason: goalContractLineage.reason };
    }
    const protection = await loadFrozenRepairProtectionPg(tx, input.runId, run, goalContractLineage.goalContractHash);
    if ("reason" in protection) return { status: "skipped", reason: protection.reason };

    const taskRows = await tx.query<TaskRow>(
      `select id, status, sort_order, depends_on_json, snapshot_json
         from southstar.workflow_tasks
        where run_id = $1
        order by sort_order, id
        for update`,
      [input.runId],
    );
    const failedTaskRow = taskRows.rows.find((task) => task.id === input.failedTaskId);
    if (!failedTaskRow) throw new Error(`failed task not found: ${input.runId}/${input.failedTaskId}`);
    const failedTask = run.workflow_manifest_json.tasks.find((task) => task.id === input.failedTaskId);
    if (!failedTask) throw new Error(`failed task missing from manifest: ${input.failedTaskId}`);
    const taskRequirements = taskRequirementIds(failedTask);
    const explicitFailedRequirementIds = input.failedRequirementIds === undefined
      ? undefined
      : unique(input.failedRequirementIds).sort();
    if (explicitFailedRequirementIds?.length === 0) {
      return { status: "skipped", reason: "dynamic-repair-failed-requirements-empty" };
    }
    if (explicitFailedRequirementIds === undefined && taskRequirements.length > 1) {
      return { status: "skipped", reason: "dynamic-repair-failed-requirements-required" };
    }
    const targetRequirementIds = explicitFailedRequirementIds ?? taskRequirements;
    if (targetRequirementIds.length === 0) {
      return { status: "skipped", reason: "dynamic-repair-target-requirements-missing" };
    }
    const knownRequirementIds = new Set(
      goalContractLineage.goalContract.requirements.map((requirement) => requirement.id),
    );
    if (targetRequirementIds.some((requirementId) => !knownRequirementIds.has(requirementId))) {
      return { status: "skipped", reason: "dynamic-repair-target-requirements-invalid" };
    }
    if (targetRequirementIds.some((requirementId) => !taskRequirements.includes(requirementId))) {
      return { status: "skipped", reason: "dynamic-repair-failed-requirements-not-in-task" };
    }
    if (protection.coverageContext && targetRequirementIds.some((requirementId) =>
      !protection.coverageContext!.coverage.entries.some((entry) => entry.requirementId === requirementId)
    )) {
      return { status: "skipped", reason: "dynamic-repair-target-coverage-missing" };
    }
    const failedProfile = run.workflow_manifest_json.agentProfiles?.find((profile) => profile.id === failedTask.agentProfileRef);
    if (failedProfile?.workerKind !== "validation_worker") {
      return { status: "skipped", reason: "failed-task-is-not-validation-worker" };
    }
    const rootFailedTaskId = dynamicRepairRootFailedTaskId(failedTask, failedTaskRow) ?? input.failedTaskId;
    const repairSeedTask = findRepairSeedTask(run.workflow_manifest_json, failedTask);
    const profileHints = dynamicRepairProfileHints({
      workflow: run.workflow_manifest_json,
      failedTask,
      failedProfile,
      repairSeedTask,
    });

    const round = await nextRepairRound(tx, {
      runId: input.runId,
      rootFailedTaskId,
      workflow: run.workflow_manifest_json,
      taskRows: taskRows.rows,
    });
    if (round > maxRounds) {
      await persistExhaustedRepairOutcomePg(tx, input.runId, targetRequirementIds, maxRounds);
      return { status: "skipped", reason: "dynamic-repair-round-limit" };
    }

    const resourceKey = dynamicRevisionResourceKey(input.runId, rootFailedTaskId, round);
    if (await getResourceByKeyPg(tx, "workflow_dynamic_repair_revision", resourceKey)) {
      return { status: "skipped", reason: "dynamic-repair-revision-already-recorded" };
    }

    const scope = run.domain || run.workflow_manifest_json.domain || goalContractLineage.goalContract.domain;
    const candidateScope = "all";
    const repairGoalPrompt = dynamicRepairGoalPrompt({
      goalPrompt: run.goal_prompt,
      failedTask,
      rootFailedTaskId,
      failedArtifactRefId: input.failedArtifactRefId,
      failedArtifact: input.failedArtifact,
      profileHints,
      targetRequirementIds,
      round,
      maxRounds,
    });
    const repairGoalContract = goalContractLineage.goalContract;
    const candidatePacket = await resolveWorkflowCandidates(tx, {
      requirementSpec: {
        summary: `Repair failed validation task ${input.failedTaskId}`,
        workType: "bugfix",
        requiredCapabilities: [],
        expectedArtifacts: failedTask.requiredArtifactRefs ?? [],
        acceptanceCriteria: [
          "Repair the implementation using the failed verifier report.",
          "Reverify the repaired implementation.",
        ],
        nonGoals: ["Do not create cyclic workflow dependencies."],
        riskNotes: ["Dynamic repair revision generated after verifier failure."],
        workspaceAssumptions: [],
        missingInputs: [],
      },
      scope: candidateScope,
    });
    const repairLoopComposer: WorkflowComposer = {
      async compose(composeInput) {
        return prepareDynamicRepairCompositionForCompile(await input.workflowComposer!.compose(composeInput));
      },
    };
    const repairLoop = await runCompositionRepairLoop({
      db: tx,
      goalPrompt: repairGoalPrompt,
      goalContract: repairGoalContract,
      targetRequirementIds,
      candidatePacket,
      composer: repairLoopComposer,
      scope: candidateScope,
      maxRepairAttempts: 2,
    });
    if (!repairLoop.validation.ok || !repairLoop.composition) {
      const firstIssue = repairLoop.validation.issues[0];
      return {
        status: "skipped",
        reason: `dynamic-repair-composition-invalid:${firstIssue?.code ?? "unknown"}:${firstIssue?.message ?? "unknown"}`,
      };
    }
    const composition = repairLoop.composition;
    const compositionForCompile = composition;
    const compiled = await compileWorkflowComposition(tx, {
      runId: `${input.runId}-dynamic-repair-${round}`,
      goalPrompt: run.goal_prompt,
      goalContract: repairGoalContract,
      candidatePacket,
      composition: compositionForCompile,
      targetRequirementIds,
      scope: candidateScope,
      manifestDomain: run.workflow_manifest_json.domain ?? scope,
    });
    const newTasks = rewriteDynamicRepairTasks(compiled.workflow.tasks, {
      failedTaskId: input.failedTaskId,
      rootFailedTaskId,
      failedTaskDependsOn: dependencyList(failedTaskRow.depends_on_json),
      failedArtifactRefId: input.failedArtifactRefId,
      targetRequirementIds,
      round,
    });
    const repairCoverage = rewriteRepairCoverageTaskIds(
      compiled.goalRequirementCoverage,
      compiled.workflow.tasks,
      newTasks,
    );
    let authorityApprovalId: string | undefined;
    if (protection.snapshot) {
      const closureFailure = await compiledLibraryClosureFailurePg(tx, compiled.workflow, protection.snapshot);
      if (closureFailure) return { status: "skipped", reason: closureFailure };
      const requestedAuthority = expandedRepairAuthority(run.workflow_manifest_json, compiled.workflow, newTasks);
      if (hasExpandedAuthority(requestedAuthority)) {
        const compositionHash = contentHashForPayload(composition);
        const approval = await requireDynamicRepairAuthorityApprovalPg(tx, {
          runId: input.runId,
          failedTaskId: input.failedTaskId,
          round,
          goalContractHash: goalContractLineage.goalContractHash,
          librarySnapshotHash: protection.snapshot.snapshotHash,
          baseManifestHash: contentHashForPayload(run.workflow_manifest_json),
          targetRequirementIds,
          requestedAuthority,
          compositionHash,
        });
        if (approval.status === "waiting_operator_approval") {
          await persistDynamicRepairRequestPg(tx, {
            approvalId: approval.approvalId,
            runId: input.runId,
            failedTaskId: input.failedTaskId,
            failedArtifactRefId: input.failedArtifactRefId,
            failedRequirementIds: targetRequirementIds,
            maxDynamicRepairRounds: maxRounds,
            composition,
            compositionHash,
          });
          return approval;
        }
        if (approval.status === "skipped") return approval;
        authorityApprovalId = approval.approvalId;
      }
    }
    const reconnectTargetTaskId = dynamicRepairReconnectTargetTaskId(newTasks, compiled.workflow.agentProfiles);
    const downstreamDependencyChanges = reconnectTargetTaskId
      ? downstreamDependencyChangesFor({
          workflowTasks: run.workflow_manifest_json.tasks,
          taskRows: taskRows.rows,
          failedTaskId: input.failedTaskId,
          reconnectTargetTaskId,
        })
      : [];
    const revisionId = `dynamic-repair-${input.failedTaskId}-attempt-${round}`;
    const taskStates = Object.fromEntries(taskRows.rows.map((task) => [task.id, normalizeTaskStatus(task.status)]));
    const revision = applyWorkflowRevision(run.workflow_manifest_json, {
      revisionId,
      baseRevisionId: run.workflow_manifest_json.workflowGeneration?.planId ?? "current",
      runId: input.runId,
      actorType: "orchestrator",
      reason: `Dynamic repair for failed validation task ${input.failedTaskId}`,
      addTasks: newTasks,
      removeTaskIds: [],
      dependencyChanges: downstreamDependencyChanges,
      idempotencyKey: resourceKey,
    }, taskStates);
    const mergedWorkflow = mergeRuntimeDefinitions(revision.workflow, compiled.workflow);
    await updateWorkflowManifestPg(tx, input.runId, JSON.stringify(mergedWorkflow));
    for (const change of downstreamDependencyChanges) {
      await tx.query(
        `update southstar.workflow_tasks
            set depends_on_json = $3::jsonb,
                updated_at = now()
          where run_id = $1 and id = $2`,
        [input.runId, change.taskId, JSON.stringify(change.dependsOn)],
      );
    }
    const maxSortOrder = Math.max(-1, ...taskRows.rows.map((task) => task.sort_order));
    for (const [index, task] of newTasks.entries()) {
      await createWorkflowTaskPg(tx, {
        id: task.id,
        runId: input.runId,
        taskKey: task.name ?? task.id,
        status: "pending",
        sortOrder: maxSortOrder + index + 1,
        dependsOn: task.dependsOn,
        snapshot: {
          roleRef: task.roleRef,
          agentProfileRef: task.agentProfileRef,
          dynamicRepair: {
            originalFailedTaskId: rootFailedTaskId,
            rootFailedTaskId,
            failedTaskId: input.failedTaskId,
            failedArtifactRefId: input.failedArtifactRefId,
            round,
          },
        },
      });
    }
    if (protection.coverageContext) {
      const effectiveCoverage = mergeGoalRequirementCoverage(
        protection.coverageContext.coverage,
        repairCoverage,
        targetRequirementIds,
      );
      await upsertRuntimeResourcePg(tx, {
        id: `goal-requirement-coverage-revision:${input.runId}:${revisionId}`,
        resourceType: "goal_requirement_coverage_revision",
        resourceKey: `goal-requirement-coverage-revision:${input.runId}:${revisionId}`,
        runId: input.runId,
        taskId: input.failedTaskId,
        scope: "run",
        status: "frozen",
        title: `Goal Requirement Coverage revision ${revisionId}`,
        payload: {
          schemaVersion: "southstar.goal_requirement_coverage_revision.v1",
          revisionId,
          baseCoverageResourceKey: input.runId,
          goalContractHash: goalContractLineage.goalContractHash,
          targetRequirementIds,
          baseCoverageHash: contentHashForPayload(protection.coverageContext.coverage),
          repairCoverage,
          effectiveCoverage,
          effectiveCoverageHash: contentHashForPayload(effectiveCoverage),
        },
        summary: { revisionId, targetRequirementIds },
      });
    }
    await upsertRuntimeResourcePg(tx, {
      id: `workflow-dynamic-repair-${input.runId}-${input.failedTaskId}-${round}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(),
      resourceType: "workflow_dynamic_repair_revision",
      resourceKey,
      runId: input.runId,
      taskId: input.failedTaskId,
      scope: "workflow",
      status: "applied",
      title: "Dynamic repair workflow revision",
      payload: {
        revisionId,
        originalFailedTaskId: rootFailedTaskId,
        rootFailedTaskId,
        failedTaskId: input.failedTaskId,
        failedArtifactRefId: input.failedArtifactRefId,
        round,
        maxRounds,
        newTaskIds: revision.newTaskIds,
        downstreamDependencyChanges,
        composition,
        compiledComposition: compositionForCompile,
        goalContractHash: goalContractLineage.goalContractHash,
        goalRequirementCoverage: repairCoverage,
        orchestrationSnapshot: compiled.orchestrationSnapshot,
        repairLoopAttempts: repairLoop.attempts.map((attempt) => ({
          attempt: attempt.attempt,
          ok: attempt.validation.ok,
          issueCount: attempt.validation.issues.length,
          issues: attempt.validation.issues,
        })),
      },
      summary: { revisionId, newTaskIds: revision.newTaskIds, downstreamDependencyChanges, round },
    });
    await appendHistoryEventPg(tx, {
      runId: input.runId,
      taskId: input.failedTaskId,
      eventType: "workflow.dynamic_repair_revision_applied",
      actorType: "orchestrator",
      idempotencyKey: `${resourceKey}:history`,
      payload: {
        revisionId,
        failedArtifactRefId: input.failedArtifactRefId,
        rootFailedTaskId,
        round,
        newTaskIds: revision.newTaskIds,
        downstreamDependencyChanges,
        manifestFingerprint: revision.manifestFingerprint,
      },
    });
    await tx.query(
      "update southstar.workflow_runs set status = 'running', updated_at = now() where id = $1 and status = 'awaiting_approval'",
      [input.runId],
    );
    const result = { status: "applied" as const, revisionId, newTaskIds: revision.newTaskIds };
    if (authorityApprovalId) await completeDynamicRepairRequestPg(tx, authorityApprovalId, result);
    return result;
  });
}

export async function continueDynamicRepairApprovalPg(
  db: SouthstarDb,
  input: { runId: string; approvalId: string },
): Promise<DynamicRepairRevisionResult> {
  return await db.tx(async (tx) => {
    if (!await tx.maybeOne("select id from southstar.workflow_runs where id = $1 for update", [input.runId])) {
      throw new Error(`run not found: ${input.runId}`);
    }
    const request = await tx.maybeOne<{ status: string; payload_json: unknown }>(
      `select status, payload_json from southstar.runtime_resources
        where resource_type = 'dynamic_repair_request' and resource_key = $1 and run_id = $2
        for update`,
      [input.approvalId, input.runId],
    );
    if (!request) throw new Error(`dynamic repair request not found: ${input.approvalId}`);
    const payload = parseDynamicRepairRequest(request.payload_json, input);
    if (request.status === "applied") return parseAppliedRepairResult(payload.appliedResult, input.approvalId);
    if (request.status === "rejected") return { status: "skipped", reason: `dynamic-repair-request-rejected:${input.approvalId}` };
    const approval = await tx.maybeOne<{ status: string }>(
      `select status from southstar.runtime_resources
        where resource_type = 'approval' and resource_key = $1 and run_id = $2
        for update`,
      [input.approvalId, input.runId],
    );
    if (!approval || approval.status !== "approved") {
      throw new Error(`dynamic repair approval is not approved: ${input.approvalId}`);
    }
    return await maybeApplyDynamicRepairRevisionPg(tx, {
      runId: input.runId,
      failedTaskId: payload.failedTaskId,
      ...(payload.failedArtifactRefId ? { failedArtifactRefId: payload.failedArtifactRefId } : {}),
      failedRequirementIds: payload.failedRequirementIds,
      maxDynamicRepairRounds: payload.maxDynamicRepairRounds,
      workflowComposer: {
        async compose() {
          return structuredClone(payload.composition);
        },
      },
    });
  });
}

export async function rejectDynamicRepairApprovalPg(
  db: SouthstarDb,
  input: { runId: string; approvalId: string; reason: string },
): Promise<{ status: "unsatisfied" }> {
  return await db.tx(async (tx) => {
    const request = await getResourceByKeyPg(tx, "dynamic_repair_request", input.approvalId);
    if (!request || request.runId !== input.runId) throw new Error(`dynamic repair request not found: ${input.approvalId}`);
    const payload = parseDynamicRepairRequest(request.payload, input);
    if (request.status !== "rejected") {
      await upsertRuntimeResourcePg(tx, {
        id: dynamicRepairRequestId(input.approvalId),
        resourceType: "dynamic_repair_request",
        resourceKey: input.approvalId,
        runId: input.runId,
        taskId: payload.failedTaskId,
        scope: "workflow",
        status: "rejected",
        title: `Dynamic repair request for ${payload.failedTaskId}`,
        payload: { ...payload, rejectionReason: input.reason },
        summary: { approvalId: input.approvalId, failedRequirementIds: payload.failedRequirementIds },
      });
    }
    await persistTerminalGoalOutcomePg(tx, {
      runId: input.runId,
      outcomeStatus: "unsatisfied",
      failedRequirementIds: payload.failedRequirementIds,
      findings: [`dynamic repair authority rejected: ${input.reason}`],
      mergeExisting: true,
      actorType: "operator",
      idempotencyKey: `dynamic-repair-rejected:${input.approvalId}:completed`,
    });
    return { status: "unsatisfied" };
  });
}

function mergeGoalRequirementCoverage(
  base: FrozenCoverageContext["coverage"],
  repair: FrozenCoverageContext["coverage"],
  targetRequirementIds: string[],
): FrozenCoverageContext["coverage"] {
  const targets = new Set(targetRequirementIds);
  const replacements = new Map(repair.entries.map((entry) => [entry.requirementId, entry]));
  if (replacements.size !== targets.size || [...targets].some((id) => !replacements.has(id))) {
    throw new Error("dynamic repair coverage does not exactly match target requirements");
  }
  return {
    ...base,
    entries: base.entries.map((entry) => targets.has(entry.requirementId)
      ? required(replacements.get(entry.requirementId), `missing repair coverage for ${entry.requirementId}`)
      : entry),
  };
}

function rewriteRepairCoverageTaskIds(
  coverage: FrozenCoverageContext["coverage"],
  compiledTasks: WorkflowTaskDefinition[],
  rewrittenTasks: WorkflowTaskDefinition[],
): FrozenCoverageContext["coverage"] {
  if (compiledTasks.length !== rewrittenTasks.length) throw new Error("dynamic repair task rewrite changed task count");
  const idMap = new Map(compiledTasks.map((task, index) => [task.id, required(rewrittenTasks[index], `missing rewritten task ${task.id}`).id]));
  return {
    ...coverage,
    entries: coverage.entries.map((entry) => ({
      ...entry,
      producerTaskIds: entry.producerTaskIds.map((id) => required(idMap.get(id), `missing rewritten producer task ${id}`)),
      evaluatorTaskIds: entry.evaluatorTaskIds.map((id) => required(idMap.get(id), `missing rewritten evaluator task ${id}`)),
    })),
  };
}

async function loadCanonicalGoalContractLineage(
  db: SouthstarDb,
  run: RunRow,
): Promise<
  | { goalContract: GoalContractV1; goalContractHash: string }
  | { reason: string }
> {
  const runtimeContext = asRecord(run.runtime_context_json);
  const draftId = nonEmptyString(runtimeContext.draftId);
  if (!draftId) return { reason: "goal-contract-lineage-missing:draftId" };
  const runGoalContractHash = nonEmptyString(runtimeContext.goalContractHash);
  if (!runGoalContractHash) return { reason: "goal-contract-lineage-missing:goalContractHash" };

  const plannerDraft = await getResourceByKeyPg(db, "planner_draft", draftId);
  if (!plannerDraft || plannerDraft.status !== "validated") {
    return { reason: "goal-contract-lineage-missing:plannerDraft" };
  }
  const payload = asRecord(plannerDraft.payload);
  const goalContract = storedGoalContract(payload.goalContract);
  if (!goalContract) return { reason: "goal-contract-lineage-missing:plannerDraft.goalContract" };
  const plannerDraftGoalContractHash = nonEmptyString(payload.goalContractHash);
  if (!plannerDraftGoalContractHash) {
    return { reason: "goal-contract-lineage-missing:plannerDraft.goalContractHash" };
  }
  const recomputedGoalContractHash = goalContractHash(goalContract);
  if (
    runGoalContractHash !== plannerDraftGoalContractHash
    || plannerDraftGoalContractHash !== recomputedGoalContractHash
  ) {
    return { reason: "goal-contract-hash-mismatch" };
  }
  return { goalContract, goalContractHash: recomputedGoalContractHash };
}

async function loadFrozenRepairProtectionPg(
  db: SouthstarDb,
  runId: string,
  run: RunRow,
  canonicalGoalContractHash: string,
): Promise<
  | { coverageContext?: FrozenCoverageContext; snapshot?: RunLibrarySnapshotV1 }
  | { reason: string }
> {
  const runtimeContext = asRecord(run.runtime_context_json);
  const librarySnapshotHash = nonEmptyString(runtimeContext.librarySnapshotHash);
  if (!librarySnapshotHash) return { reason: "dynamic-repair-library-snapshot-missing" };
  const coverageContext = await loadFrozenCoverageContextPg(db, runId);
  if (!coverageContext) return { reason: "dynamic-repair-frozen-coverage-missing" };
  const snapshot = await loadRunLibrarySnapshotPg(db, runId);
  if (
    snapshot.snapshotHash !== librarySnapshotHash
    || snapshot.goalContractHash !== canonicalGoalContractHash
    || snapshot.manifestHash !== nonEmptyString(runtimeContext.manifestHash)
  ) return { reason: "dynamic-repair-frozen-lineage-mismatch" };
  return { coverageContext, snapshot };
}

async function compiledLibraryClosureFailurePg(
  db: SouthstarDb,
  compiled: SouthstarWorkflowManifest,
  snapshot: RunLibrarySnapshotV1,
): Promise<string | undefined> {
  const refs = compiled.compiledFrom?.libraryObjectVersionRefs;
  if (!refs || refs.length === 0) return "dynamic-repair-compiled-library-refs-missing";
  const snapshotByKey = new Map(snapshot.objects.map((object) => [object.objectKey, object]));
  for (const pair of [...refs].sort((a, b) => a.objectKey.localeCompare(b.objectKey))) {
    const frozen = snapshotByKey.get(pair.objectKey);
    if (!frozen || frozen.versionRef !== pair.versionRef) {
      return `dynamic-repair-ref-version-not-in-run-snapshot:${pair.versionRef}`;
    }
    const current = await findLibraryObjectByKey(db, pair.objectKey);
    if (
      !current
      || current.headVersionId !== pair.versionRef
      || contentHashForPayload(current.state) !== frozen.stateHash
    ) return `dynamic-repair-ref-state-not-in-run-snapshot:${pair.versionRef}`;
  }
  return undefined;
}

type RepairAuthorityExpansion = {
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
  mounts: Array<{ source: string; target: string; readonly: boolean }>;
  removedDeniedTools: string[];
  removedApprovalRequirements: string[];
};

function expandedRepairAuthority(
  current: SouthstarWorkflowManifest,
  compiled: SouthstarWorkflowManifest,
  newTasks: WorkflowTaskDefinition[],
): RepairAuthorityExpansion {
  const currentProfiles = current.agentProfiles ?? [];
  const newProfileIds = new Set(newTasks.map((task) => task.agentProfileRef).filter((ref): ref is string => Boolean(ref)));
  const proposedProfiles = (compiled.agentProfiles ?? []).filter((profile) => newProfileIds.has(profile.id));
  const currentToolCapabilities = executableToolCapabilities(current.tasks, currentProfiles);
  const proposedToolCapabilities = executableToolCapabilities(newTasks, proposedProfiles);
  const currentMcp = new Set([
    ...current.tasks.flatMap((task) => task.mcpGrantRefs ?? []),
    ...currentProfiles.flatMap((profile) => profile.mcpGrantRefs),
  ]);
  const currentVault = new Set([
    ...current.tasks.flatMap((task) => task.vaultLeasePolicyRefs ?? []),
    ...currentProfiles.flatMap((profile) => profile.vaultLeasePolicyRefs ?? []),
  ]);
  const currentMounts = new Set(current.tasks.flatMap((task) => task.execution.mounts).map(mountKey));
  return {
    toolGrantRefs: [...proposedToolCapabilities.entries()]
      .filter(([tool, proposed]) => proposed.executable && !currentToolCapabilities.get(tool)?.executable)
      .map(([tool]) => tool)
      .sort(),
    mcpGrantRefs: unique([
      ...newTasks.flatMap((task) => task.mcpGrantRefs ?? []),
      ...proposedProfiles.flatMap((profile) => profile.mcpGrantRefs),
    ]).filter((ref) => !currentMcp.has(ref)).sort(),
    vaultLeasePolicyRefs: unique([
      ...newTasks.flatMap((task) => task.vaultLeasePolicyRefs ?? []),
      ...proposedProfiles.flatMap((profile) => profile.vaultLeasePolicyRefs ?? []),
    ]).filter((ref) => !currentVault.has(ref)).sort(),
    mounts: newTasks.flatMap((task) => task.execution.mounts)
      .filter((mount) => !currentMounts.has(mountKey(mount)))
      .sort((a, b) => mountKey(a).localeCompare(mountKey(b))),
    removedDeniedTools: [...proposedToolCapabilities.entries()]
      .filter(([tool, proposed]) => proposed.executable && !currentToolCapabilities.get(tool)?.executable && currentToolCapabilities.get(tool)?.allowedButDenied)
      .map(([tool]) => tool)
      .sort(),
    removedApprovalRequirements: [...proposedToolCapabilities.entries()]
      .filter(([tool, proposed]) => proposed.noApproval && currentToolCapabilities.get(tool)?.executable && !currentToolCapabilities.get(tool)?.noApproval)
      .map(([tool]) => tool)
      .sort(),
  };
}

function executableToolCapabilities(
  tasks: WorkflowTaskDefinition[],
  profiles: AgentProfile[],
): Map<string, { executable: boolean; noApproval: boolean; allowedButDenied: boolean }> {
  const byProfile = new Map(profiles.map((profile) => [profile.id, profile]));
  const capabilities = new Map<string, { executable: boolean; noApproval: boolean; allowedButDenied: boolean }>();
  for (const task of tasks) {
    const profile = task.agentProfileRef ? byProfile.get(task.agentProfileRef) : undefined;
    if (!profile) continue;
    const taskTools = new Set(task.toolGrantRefs ?? []);
    const denied = new Set(profile.toolPolicy.deniedTools);
    const requiresApproval = new Set(profile.toolPolicy.requiresApprovalFor);
    for (const tool of profile.toolPolicy.allowedTools) {
      if (!taskTools.has(tool)) continue;
      const current = capabilities.get(tool) ?? { executable: false, noApproval: false, allowedButDenied: false };
      const isDenied = denied.has(tool);
      capabilities.set(tool, {
        executable: current.executable || !isDenied,
        noApproval: current.noApproval || (!isDenied && !requiresApproval.has(tool)),
        allowedButDenied: current.allowedButDenied || isDenied,
      });
    }
  }
  return capabilities;
}

function hasExpandedAuthority(authority: RepairAuthorityExpansion): boolean {
  return authority.toolGrantRefs.length > 0
    || authority.mcpGrantRefs.length > 0
    || authority.vaultLeasePolicyRefs.length > 0
    || authority.mounts.length > 0
    || authority.removedDeniedTools.length > 0
    || authority.removedApprovalRequirements.length > 0;
}

async function requireDynamicRepairAuthorityApprovalPg(
  db: SouthstarDb,
  input: {
    runId: string;
    failedTaskId: string;
    round: number;
    goalContractHash: string;
    librarySnapshotHash: string;
    baseManifestHash: string;
    targetRequirementIds: string[];
    requestedAuthority: RepairAuthorityExpansion;
    compositionHash: string;
  },
): Promise<
  | { status: "approved"; approvalId: string }
  | { status: "waiting_operator_approval"; approvalId: string }
  | { status: "skipped"; reason: string }
> {
  const proposalHash = contentHashForPayload({
    actionType: "dynamic_repair_authority_expansion",
    failedTaskId: input.failedTaskId,
    round: input.round,
    goalContractHash: input.goalContractHash,
    librarySnapshotHash: input.librarySnapshotHash,
    baseManifestHash: input.baseManifestHash,
    targetRequirementIds: [...input.targetRequirementIds].sort(),
    requestedAuthority: input.requestedAuthority,
    compositionHash: input.compositionHash,
  });
  const approvalId = `dynamic-repair-approval:${input.runId}:${proposalHash}`;
  const existing = await getResourceByKeyPg(db, "approval", approvalId);
  if (existing) {
    const payload = asRecord(existing.payload);
    const validTuple = existing.runId === input.runId
      && existing.taskId === input.failedTaskId
      && existing.scope === "approval"
      && payload.schemaVersion === "southstar.dynamic_repair_authority_approval.v1"
      && payload.approvalId === approvalId
      && payload.runId === input.runId
      && payload.failedTaskId === input.failedTaskId
      && payload.actionType === "dynamic_repair_authority_expansion"
      && payload.round === input.round
      && payload.proposalHash === proposalHash
      && payload.baseManifestHash === input.baseManifestHash
      && payload.goalContractHash === input.goalContractHash
      && payload.librarySnapshotHash === input.librarySnapshotHash
      && payload.compositionHash === input.compositionHash
      && contentHashForPayload(payload.requestedAuthority) === contentHashForPayload(input.requestedAuthority)
      && contentHashForPayload(stringArray(payload.targetRequirementIds).sort())
        === contentHashForPayload([...input.targetRequirementIds].sort());
    if (!validTuple) return { status: "skipped", reason: `dynamic-repair-authority-approval-invalid:${approvalId}` };
  }
  if (existing?.status === "approved") return { status: "approved", approvalId };
  if (existing?.status === "rejected") return { status: "skipped", reason: `dynamic-repair-authority-approval-rejected:${approvalId}` };
  if (!existing) {
    await upsertRuntimeResourcePg(db, {
      id: approvalId,
      resourceType: "approval",
      resourceKey: approvalId,
      runId: input.runId,
      taskId: input.failedTaskId,
      scope: "approval",
      status: "waiting_operator_approval",
      title: `Dynamic repair authority approval for ${input.failedTaskId}`,
      payload: {
        schemaVersion: "southstar.dynamic_repair_authority_approval.v1",
        approvalId,
        actionType: "dynamic_repair_authority_expansion",
        runId: input.runId,
        failedTaskId: input.failedTaskId,
        round: input.round,
        goalContractHash: input.goalContractHash,
        librarySnapshotHash: input.librarySnapshotHash,
        baseManifestHash: input.baseManifestHash,
        proposalHash,
        targetRequirementIds: [...input.targetRequirementIds].sort(),
        requestedAuthority: input.requestedAuthority,
        compositionHash: input.compositionHash,
      },
      summary: { proposalHash, targetRequirementIds: input.targetRequirementIds },
    });
    await appendHistoryEventPg(db, {
      runId: input.runId,
      taskId: input.failedTaskId,
      eventType: "approval.requested",
      actorType: "orchestrator",
      idempotencyKey: `${approvalId}:requested`,
      payload: { approvalId, actionType: "dynamic_repair_authority_expansion", proposalHash },
    });
  }
  await db.query(
    "update southstar.workflow_runs set status = 'awaiting_approval', updated_at = now() where id = $1 and status in ('running', 'scheduling')",
    [input.runId],
  );
  return { status: "waiting_operator_approval", approvalId };
}

type DynamicRepairRequestPayloadV1 = {
  schemaVersion: "southstar.dynamic_repair_request.v1";
  approvalId: string;
  runId: string;
  failedTaskId: string;
  failedArtifactRefId?: string;
  failedRequirementIds: string[];
  maxDynamicRepairRounds: number;
  composition: WorkflowCompositionPlan;
  compositionHash: string;
  appliedResult?: unknown;
  rejectionReason?: string;
};

async function persistDynamicRepairRequestPg(
  db: SouthstarDb,
  input: Omit<DynamicRepairRequestPayloadV1, "schemaVersion">,
): Promise<void> {
  const payload: DynamicRepairRequestPayloadV1 = {
    schemaVersion: "southstar.dynamic_repair_request.v1",
    ...input,
  };
  const existing = await getResourceByKeyPg(db, "dynamic_repair_request", input.approvalId);
  if (existing && contentHashForPayload(existing.payload) !== contentHashForPayload(payload)) {
    throw new Error(`dynamic repair request payload mismatch: ${input.approvalId}`);
  }
  if (existing) return;
  await upsertRuntimeResourcePg(db, {
    id: dynamicRepairRequestId(input.approvalId),
    resourceType: "dynamic_repair_request",
    resourceKey: input.approvalId,
    runId: input.runId,
    taskId: input.failedTaskId,
    scope: "workflow",
    status: "waiting_operator_approval",
    title: `Dynamic repair request for ${input.failedTaskId}`,
    payload,
    summary: { approvalId: input.approvalId, failedRequirementIds: input.failedRequirementIds, compositionHash: input.compositionHash },
  });
}

async function completeDynamicRepairRequestPg(
  db: SouthstarDb,
  approvalId: string,
  result: Extract<DynamicRepairRevisionResult, { status: "applied" }>,
): Promise<void> {
  const request = await getResourceByKeyPg(db, "dynamic_repair_request", approvalId);
  if (!request) return;
  const payload = parseDynamicRepairRequest(request.payload, { runId: request.runId ?? "", approvalId });
  await upsertRuntimeResourcePg(db, {
    id: dynamicRepairRequestId(approvalId),
    resourceType: "dynamic_repair_request",
    resourceKey: approvalId,
    runId: payload.runId,
    taskId: payload.failedTaskId,
    scope: "workflow",
    status: "applied",
    title: `Dynamic repair request for ${payload.failedTaskId}`,
    payload: { ...payload, appliedResult: result },
    summary: { approvalId, revisionId: result.revisionId, newTaskIds: result.newTaskIds },
  });
}

function dynamicRepairRequestId(approvalId: string): string {
  return `dynamic-repair-request:${approvalId}`;
}

function parseDynamicRepairRequest(
  value: unknown,
  input: { runId: string; approvalId: string },
): DynamicRepairRequestPayloadV1 {
  const payload = asRecord(value);
  const failedRequirementIds = stringArray(payload.failedRequirementIds).sort();
  if (
    payload.schemaVersion !== "southstar.dynamic_repair_request.v1"
    || payload.approvalId !== input.approvalId
    || payload.runId !== input.runId
    || !nonEmptyString(payload.failedTaskId)
    || failedRequirementIds.length === 0
    || typeof payload.maxDynamicRepairRounds !== "number"
    || !Number.isInteger(payload.maxDynamicRepairRounds)
    || payload.maxDynamicRepairRounds < 1
    || !payload.composition
    || payload.compositionHash !== contentHashForPayload(payload.composition)
  ) throw new Error(`invalid dynamic repair request: ${input.approvalId}`);
  return {
    ...(payload as DynamicRepairRequestPayloadV1),
    failedRequirementIds,
  };
}

function parseAppliedRepairResult(value: unknown, approvalId: string): Extract<DynamicRepairRevisionResult, { status: "applied" }> {
  const result = asRecord(value);
  if (result.status !== "applied" || !nonEmptyString(result.revisionId) || !isStringArray(result.newTaskIds)) {
    throw new Error(`invalid applied dynamic repair result: ${approvalId}`);
  }
  return { status: "applied", revisionId: result.revisionId as string, newTaskIds: result.newTaskIds as string[] };
}

async function persistExhaustedRepairOutcomePg(
  db: SouthstarDb,
  runId: string,
  failedRequirementIds: string[],
  maxRounds: number,
): Promise<void> {
  const existing = await getResourceByKeyPg(db, "goal_outcome", `goal-outcome:${runId}`);
  const payload = asRecord(existing?.payload);
  const allFailedRequirementIds = unique([
    ...stringArray(payload.failedRequirementIds),
    ...failedRequirementIds,
  ]).sort();
  const findings = unique([
    ...stringArray(payload.findings),
    `dynamic repair round limit exhausted after ${maxRounds} rounds`,
  ]);
  const auditPayload = {
    outcomeStatus: "unsatisfied",
    failedRequirementIds: allFailedRequirementIds,
    maxRounds,
    findings,
  };
  await appendHistoryEventOncePg(db, {
    runId,
    eventType: "workflow.dynamic_repair_exhausted",
    actorType: "orchestrator",
    idempotencyKey: `dynamic-repair-exhausted:${runId}:${contentHashForPayload(auditPayload)}`,
    payload: auditPayload,
  });
  await persistTerminalGoalOutcomePg(db, {
    runId,
    outcomeStatus: "unsatisfied",
    coveredRequirementIds: stringArray(payload.coveredRequirementIds),
    failedRequirementIds: allFailedRequirementIds,
    findings,
    mergeExisting: true,
    actorType: "orchestrator",
    idempotencyKey: `dynamic-repair-exhausted:${runId}:completed`,
  });
}

function mountKey(mount: { source: string; target: string; readonly: boolean }): string {
  return `${mount.source}\u0000${mount.target}\u0000${mount.readonly ? "readonly" : "write"}`;
}

function rewriteDynamicRepairTasks(
  tasks: WorkflowTaskDefinition[],
  input: {
    failedTaskId: string;
    rootFailedTaskId: string;
    failedTaskDependsOn: string[];
    failedArtifactRefId?: string;
    targetRequirementIds: string[];
    round: number;
  },
): WorkflowTaskDefinition[] {
  const idMap = new Map<string, string>();
  for (const task of tasks) {
    const prefix = task.id.toLowerCase().includes("verify") ? "reverify" : task.id.toLowerCase().includes("repair") ? "repair" : task.id;
    idMap.set(task.id, `${prefix}-${input.failedTaskId}-attempt-${input.round}`);
  }
  return tasks.map((task) => {
    const nextId = required(idMap.get(task.id), `missing dynamic id for ${task.id}`);
    const internalDependsOn = task.dependsOn
      .map((dependency) => idMap.get(dependency))
      .filter((dependency): dependency is string => Boolean(dependency));
    const dependsOn = internalDependsOn.length > 0 ? internalDependsOn : input.failedTaskDependsOn;
    return {
      ...task,
      id: nextId,
      dependsOn,
      promptInputs: {
        ...(task.promptInputs ?? {}),
        requirementIds: [...input.targetRequirementIds],
        dynamicRepair: {
          originalFailedTaskId: input.rootFailedTaskId,
          rootFailedTaskId: input.rootFailedTaskId,
          failedTaskId: input.failedTaskId,
          failedArtifactRefId: input.failedArtifactRefId,
          round: input.round,
        },
      },
      subagents: task.subagents.map((subagent) => ({
        ...subagent,
        id: `${subagent.id}-${nextId}`,
      })),
    };
  });
}

function prepareDynamicRepairCompositionForCompile(composition: WorkflowCompositionPlan): WorkflowCompositionPlan {
  const taskIds = new Set(composition.tasks.map((task) => task.id));
  let previousTaskId: string | undefined;
  const tasksWithInternalDependencies = composition.tasks.map((task) => {
    const internalDependsOn = unique(task.dependsOn.filter((dependency) => taskIds.has(dependency)));
    const dependsOn = internalDependsOn.length > 0
      ? internalDependsOn
      : previousTaskId
        ? [previousTaskId]
        : [];
    previousTaskId = task.id;
    return { ...task, dependsOn };
  });
  return {
    ...composition,
    tasks: tasksWithInternalDependencies.map((task) => ({
      ...task,
      inputArtifactRefs: task.inputArtifactRefs.filter((artifactRef) =>
        upstreamOutputArtifactRefs(tasksWithInternalDependencies, task.id).has(artifactRef)
      ),
    })),
  };
}

function upstreamOutputArtifactRefs(tasks: WorkflowCompositionPlan["tasks"], taskId: string): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const artifacts = new Set<string>();
  const visit = (dependencyId: string) => {
    if (seen.has(dependencyId)) return;
    seen.add(dependencyId);
    const dependency = byId.get(dependencyId);
    if (!dependency) return;
    for (const artifactRef of dependency.outputArtifactRefs) artifacts.add(artifactRef);
    for (const nextDependencyId of dependency.dependsOn) visit(nextDependencyId);
  };
  for (const dependencyId of byId.get(taskId)?.dependsOn ?? []) visit(dependencyId);
  return artifacts;
}

function dynamicRepairReconnectTargetTaskId(
  newTasks: WorkflowTaskDefinition[],
  generatedProfiles: AgentProfile[] | undefined,
): string | undefined {
  const profileById = new Map((generatedProfiles ?? []).map((profile) => [profile.id, profile]));
  const validationTask = [...newTasks]
    .reverse()
    .find((task) => profileById.get(task.agentProfileRef)?.workerKind === "validation_worker");
  return validationTask?.id ?? newTasks.at(-1)?.id;
}

function downstreamDependencyChangesFor(input: {
  workflowTasks: WorkflowTaskDefinition[];
  taskRows: TaskRow[];
  failedTaskId: string;
  reconnectTargetTaskId: string;
}): Array<{ taskId: string; dependsOn: string[] }> {
  const rowsById = new Map(input.taskRows.map((row) => [row.id, row]));
  const changes: Array<{ taskId: string; dependsOn: string[] }> = [];
  for (const task of input.workflowTasks) {
    if (task.id === input.failedTaskId || !task.dependsOn.includes(input.failedTaskId)) continue;
    const row = rowsById.get(task.id);
    if (!row) continue;
    const status = normalizeTaskStatus(row.status);
    if (status === "completed" || status === "running") continue;
    const dependsOn = unique(task.dependsOn.map((dependency) =>
      dependency === input.failedTaskId ? input.reconnectTargetTaskId : dependency
    ));
    if (sameStringArray(dependsOn, task.dependsOn)) continue;
    changes.push({ taskId: task.id, dependsOn });
  }
  return changes;
}

function mergeRuntimeDefinitions(
  base: SouthstarWorkflowManifest,
  generated: SouthstarWorkflowManifest,
): SouthstarWorkflowManifest {
  return {
    ...base,
    roles: mergeById(base.roles ?? [], generated.roles ?? []),
    agentProfiles: mergeById(base.agentProfiles ?? [], generated.agentProfiles ?? []),
    harnessDefinitions: mergeById(base.harnessDefinitions, generated.harnessDefinitions),
    evaluators: mergeById(base.evaluators, generated.evaluators),
    artifactContracts: mergeById(base.artifactContracts ?? [], generated.artifactContracts ?? []),
    evaluatorPipelines: mergeById(base.evaluatorPipelines ?? [], generated.evaluatorPipelines ?? []),
    contextPolicies: mergeById(base.contextPolicies ?? [], generated.contextPolicies ?? []),
    sessionPolicies: mergeById(base.sessionPolicies ?? [], generated.sessionPolicies ?? []),
    memoryPolicies: mergeById(base.memoryPolicies ?? [], generated.memoryPolicies ?? []),
    workspacePolicies: mergeById(base.workspacePolicies ?? [], generated.workspacePolicies ?? []),
    stopConditions: mergeById(base.stopConditions ?? [], generated.stopConditions ?? []),
    compiledFrom: mergeCompiledFrom(base, generated),
  };
}

function mergeCompiledFrom(
  base: SouthstarWorkflowManifest,
  generated: SouthstarWorkflowManifest,
): SouthstarWorkflowManifest["compiledFrom"] {
  if (!base.compiledFrom) return generated.compiledFrom;
  if (!generated.compiledFrom) return base.compiledFrom;
  const pairs = new Map(base.compiledFrom.libraryObjectVersionRefs.map((pair) => [pair.objectKey, pair]));
  for (const pair of generated.compiledFrom.libraryObjectVersionRefs) pairs.set(pair.objectKey, pair);
  const libraryObjectVersionRefs = [...pairs.values()].sort((a, b) => a.objectKey.localeCompare(b.objectKey));
  return {
    ...base.compiledFrom,
    libraryObjectVersionRefs,
    libraryVersionRefs: unique(libraryObjectVersionRefs.map((pair) => pair.versionRef)).sort(),
  };
}

function dynamicRepairGoalPrompt(input: {
  goalPrompt: string;
  failedTask: WorkflowTaskDefinition;
  rootFailedTaskId: string;
  failedArtifactRefId?: string;
  failedArtifact?: unknown;
  profileHints: DynamicRepairProfileHints;
  targetRequirementIds: string[];
  round: number;
  maxRounds: number;
}): string {
  return [
    input.goalPrompt,
    "",
    "Runtime dynamic repair request:",
    `Failed validation task: ${input.failedTask.id}`,
    `Root failed validation task: ${input.rootFailedTaskId}`,
    `Repair round: ${input.round} of ${input.maxRounds}`,
    `Target Goal Contract requirement ids: ${input.targetRequirementIds.join(", ")}`,
    input.failedArtifactRefId ? `Failed artifact ref: ${input.failedArtifactRefId}` : "",
    "Generate only appended runtime repair nodes, not a replacement initial workflow.",
    "Every repair/reverify task must reference only the target Goal Contract requirement ids listed above.",
    "Generate one bounded repair task followed by one reverify task unless the failure evidence clearly requires a smaller or larger bounded set.",
    "The repair task must use workerKind=repair_worker, consume the failed verification report and prior implementation artifacts, preserve existing behavior, fix only reported blocking failures, and output a repaired implementation artifact.",
    "The reverify task must use workerKind=validation_worker, depend on the repair task, rerun the failed checks plus relevant regression checks, and output artifact.verification_report with pass, safeToSave, blockingTests/testResults, evidence, and remaining failures.",
    "For the repair nodePromptSpec include repairInputs, mustPreserve, implementationScope, testCases, expectedOutputs, acceptanceCriteria, and failureReportContract.",
    "For the reverify nodePromptSpec include verificationChecks, testCases, failureArtifactContract, expectedOutputs, acceptanceCriteria, and an explicit rule to set pass=false and safeToSave=false for any blocking failure.",
    "Profile reuse hints:",
    JSON.stringify(input.profileHints, null, 2),
    "Use repairProfileSeed as the preferred source for the repair generated agent profile: preserve its agentRef, provider/model/thinkingLevel/harnessRef, skills, tools, MCP grants, vault grants, context/session policy, budget, and execution image/command/mount shape unless the repair evidence requires a narrower safe change.",
    "Use reverifyProfileSeed as the preferred source for the reverify generated agent profile: preserve its verifier agentRef, provider/model/thinkingLevel/harnessRef, skills, tools, MCP grants, vault grants, context/session policy, budget, evaluator intent, and execution image/command/mount shape unless validation requires a narrower safe change.",
    "Do not reuse the original profile ids directly. Generate new agentProfileRef ids for appended dynamic profiles. The repair generated profile must use workerKind=repair_worker; the reverify generated profile must use workerKind=validation_worker.",
    "Select agentDefinitionRef, skillRefs, toolGrantRefs, mcpGrantRefs, instructionRefs, evaluatorProfileRef, inputArtifactRefs, and outputArtifactRefs only from GraphMetadataCandidates.nodes. Do not use capability refs as agentDefinitionRef.",
    "Do not generate cyclic dependencies, back edges, or repeat already completed implementation work unless needed for the bounded repair.",
    `Failed artifact: ${JSON.stringify(input.failedArtifact ?? {})}`,
  ].filter(Boolean).join("\n");
}

type DynamicRepairProfileHints = {
  repairProfileSeed: DynamicRepairProfileSeed | null;
  reverifyProfileSeed: DynamicRepairProfileSeed;
};

type DynamicRepairProfileSeed = {
  seedTaskId: string;
  seedTaskName: string;
  seedAgentProfileId?: string;
  seedPurpose: "repair_from_implementation" | "reverify_from_failed_validation";
  agentProfile?: Partial<AgentProfile>;
  taskRefs: {
    roleRef?: string;
    agentProfileRef?: string;
    skillRefs: string[];
    instructionRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    vaultLeasePolicyRefs: string[];
    requiredArtifactRefs: string[];
    evaluatorPipelineRef?: string;
    contextPolicyRef?: string;
    sessionPolicyRef?: string;
    workspacePolicyRef?: string;
  };
  taskPromptSpec?: unknown;
  execution?: WorkflowTaskDefinition["execution"];
};

function dynamicRepairProfileHints(input: {
  workflow: SouthstarWorkflowManifest;
  failedTask: WorkflowTaskDefinition;
  failedProfile: AgentProfile;
  repairSeedTask?: WorkflowTaskDefinition;
}): DynamicRepairProfileHints {
  return {
    repairProfileSeed: input.repairSeedTask
      ? profileSeedForTask(input.workflow, input.repairSeedTask, "repair_from_implementation")
      : null,
    reverifyProfileSeed: profileSeedForTask(input.workflow, input.failedTask, "reverify_from_failed_validation", input.failedProfile),
  };
}

function findRepairSeedTask(
  workflow: SouthstarWorkflowManifest,
  failedTask: WorkflowTaskDefinition,
): WorkflowTaskDefinition | undefined {
  const taskById = new Map(workflow.tasks.map((task) => [task.id, task]));
  const profileById = new Map((workflow.agentProfiles ?? []).map((profile) => [profile.id, profile]));
  const dependencies = failedTask.dependsOn
    .map((dependencyId) => taskById.get(dependencyId))
    .filter((task): task is WorkflowTaskDefinition => Boolean(task));
  return dependencies.find((task) => profileById.get(task.agentProfileRef ?? "")?.workerKind === "repair_worker")
    ?? dependencies.find((task) => profileById.get(task.agentProfileRef ?? "")?.workerKind === "execution_worker")
    ?? dependencies.find((task) => nodePromptType(task) === "implement")
    ?? dependencies.find((task) => nodePromptType(task) === "repair")
    ?? dependencies.at(0);
}

function profileSeedForTask(
  workflow: SouthstarWorkflowManifest,
  task: WorkflowTaskDefinition,
  seedPurpose: DynamicRepairProfileSeed["seedPurpose"],
  knownProfile?: AgentProfile,
): DynamicRepairProfileSeed {
  const profile = knownProfile ?? workflow.agentProfiles?.find((candidate) => candidate.id === task.agentProfileRef);
  return {
    seedTaskId: task.id,
    seedTaskName: task.name,
    seedAgentProfileId: profile?.id ?? task.agentProfileRef,
    seedPurpose,
    ...(profile ? { agentProfile: profileSeedProfile(profile) } : {}),
    taskRefs: {
      ...(task.roleRef ? { roleRef: task.roleRef } : {}),
      ...(task.agentProfileRef ? { agentProfileRef: task.agentProfileRef } : {}),
      skillRefs: task.skillRefs ?? [],
      instructionRefs: task.instructionRefs ?? [],
      toolGrantRefs: task.toolGrantRefs ?? [],
      mcpGrantRefs: task.mcpGrantRefs ?? [],
      vaultLeasePolicyRefs: task.vaultLeasePolicyRefs ?? [],
      requiredArtifactRefs: task.requiredArtifactRefs ?? [],
      ...(task.evaluatorPipelineRef ? { evaluatorPipelineRef: task.evaluatorPipelineRef } : {}),
      ...(task.contextPolicyRef ? { contextPolicyRef: task.contextPolicyRef } : {}),
      ...(task.sessionPolicyRef ? { sessionPolicyRef: task.sessionPolicyRef } : {}),
      ...(task.workspacePolicyRef ? { workspacePolicyRef: task.workspacePolicyRef } : {}),
    },
    ...(task.promptInputs?.nodePromptSpec ? { taskPromptSpec: task.promptInputs.nodePromptSpec } : {}),
    execution: task.execution,
  };
}

function profileSeedProfile(profile: AgentProfile): Partial<AgentProfile> {
  return {
    id: profile.id,
    name: profile.name,
    ...(profile.agentRef ? { agentRef: profile.agentRef } : {}),
    ...(profile.workerKind ? { workerKind: profile.workerKind } : {}),
    provider: profile.provider,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
    ...(profile.harnessRef ? { harnessRef: profile.harnessRef } : {}),
    ...(profile.promptTemplateRef ? { promptTemplateRef: profile.promptTemplateRef } : {}),
    skillRefs: profile.skillRefs,
    mcpGrantRefs: profile.mcpGrantRefs,
    vaultLeasePolicyRefs: profile.vaultLeasePolicyRefs ?? [],
    memoryScopes: profile.memoryScopes,
    contextPolicyRef: profile.contextPolicyRef,
    sessionPolicyRef: profile.sessionPolicyRef,
    toolPolicy: profile.toolPolicy,
    budgetPolicy: profile.budgetPolicy,
    agentsMdRefs: profile.agentsMdRefs,
  };
}

function nodePromptType(task: WorkflowTaskDefinition): string | undefined {
  const nodePromptSpec = task.promptInputs?.nodePromptSpec;
  return nodePromptSpec && typeof nodePromptSpec === "object" && "nodeType" in nodePromptSpec
    ? String(nodePromptSpec.nodeType)
    : undefined;
}

function dynamicRepairRootFailedTaskId(task: WorkflowTaskDefinition, taskRow?: TaskRow): string | undefined {
  const dynamicRepair = task.promptInputs?.dynamicRepair ?? snapshotDynamicRepair(taskRow?.snapshot_json);
  if (!dynamicRepair || typeof dynamicRepair !== "object") return undefined;
  if ("rootFailedTaskId" in dynamicRepair && typeof dynamicRepair.rootFailedTaskId === "string") {
    return dynamicRepair.rootFailedTaskId;
  }
  if ("originalFailedTaskId" in dynamicRepair && typeof dynamicRepair.originalFailedTaskId === "string") {
    return dynamicRepair.originalFailedTaskId;
  }
  return undefined;
}

function snapshotDynamicRepair(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object" || !("dynamicRepair" in snapshot)) return undefined;
  return (snapshot as { dynamicRepair?: unknown }).dynamicRepair;
}

async function nextRepairRound(
  db: SouthstarDb,
  input: {
    runId: string;
    rootFailedTaskId: string;
    workflow: SouthstarWorkflowManifest;
    taskRows: TaskRow[];
  },
): Promise<number> {
  const row = await db.one<{ max_round: string }>(
    `select coalesce(max(
        case
          when jsonb_typeof(payload_json->'round') = 'number'
          then (payload_json->>'round')::int
          else null
        end
      ), count(*)::int, 0)::text as max_round
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'workflow_dynamic_repair_revision'
        and coalesce(payload_json->>'rootFailedTaskId', payload_json->>'originalFailedTaskId') = $2
        and status = 'applied'`,
    [input.runId, input.rootFailedTaskId],
  );
  const rounds = [
    Number.parseInt(row.max_round, 10) || 0,
    ...existingDynamicRepairRounds(input.workflow, input.taskRows, input.rootFailedTaskId),
  ];
  return Math.max(0, ...rounds) + 1;
}

function existingDynamicRepairRounds(
  workflow: SouthstarWorkflowManifest,
  taskRows: TaskRow[],
  rootFailedTaskId: string,
): number[] {
  const rounds: number[] = [];
  for (const task of workflow.tasks) {
    const round = dynamicRepairRound(task.promptInputs?.dynamicRepair)
      ?? dynamicRepairTaskIdRound(task.id, rootFailedTaskId);
    if (round) rounds.push(round);
  }
  for (const row of taskRows) {
    const round = dynamicRepairRound(snapshotDynamicRepair(row.snapshot_json))
      ?? dynamicRepairTaskIdRound(row.id, rootFailedTaskId);
    if (round) rounds.push(round);
  }
  return rounds;
}

function dynamicRepairRound(dynamicRepair: unknown): number | undefined {
  if (!dynamicRepair || typeof dynamicRepair !== "object" || !("round" in dynamicRepair)) return undefined;
  const round = (dynamicRepair as { round?: unknown }).round;
  const value = typeof round === "number" ? round : typeof round === "string" ? Number.parseInt(round, 10) : NaN;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function dynamicRepairTaskIdRound(taskId: string, rootFailedTaskId: string): number | undefined {
  if (!/^(repair|reverify)-/.test(taskId) || !taskId.includes(rootFailedTaskId)) return undefined;
  const match = /-attempt-(\d+)$/.exec(taskId);
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function dynamicRevisionResourceKey(runId: string, failedTaskId: string, round: number): string {
  return `workflow-dynamic-repair:${runId}:${failedTaskId}:attempt-${round}`;
}

function dependencyList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function taskRequirementIds(task: WorkflowTaskDefinition): string[] {
  const requirementIds = task.promptInputs?.requirementIds;
  return Array.isArray(requirementIds) && requirementIds.every((item) => typeof item === "string")
    ? unique(requirementIds)
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeTaskStatus(status: string) {
  return ["pending", "running", "completed", "failed", "cancelled"].includes(status)
    ? status as "pending" | "running" | "completed" | "failed" | "cancelled"
    : "pending";
}

function mergeById<T extends { id: string }>(base: T[], generated: T[]): T[] {
  const values = new Map<string, T>();
  for (const item of base) values.set(item.id, item);
  for (const item of generated) {
    if (!values.has(item.id)) values.set(item.id, item);
  }
  return [...values.values()];
}

function required<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function stringArray(value: unknown): string[] {
  return isStringArray(value) ? value : [];
}
