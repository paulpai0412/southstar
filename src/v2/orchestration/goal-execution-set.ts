import { contentHashForPayload } from "../design-library/canonical-json.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { createApprovalPg, deriveGoalExecutionRisk, type GoalExecutionApprovalPayload } from "../approvals/postgres-approval-service.ts";
import { evaluateApprovalPolicy } from "../approvals/policy.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { startRunSchedulingPg } from "../server/run-execution-controller.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../ui-api/postgres-run-api.ts";
import {
  finalizeGoalDesignPackage,
  finalizeGoalDesignPackageV2,
  type GoalDesignPackage,
  type GoalSliceV1,
} from "./goal-design.ts";
import { loadCurrentGoalDesignPackagePg } from "./goal-design-draft-service.ts";
import { finalizeGoalContract, goalContractHash, type GoalContractInterpreter, type GoalContractV1 } from "./goal-contract.ts";
import { loadRunLibrarySnapshotPg } from "./run-library-snapshot.ts";
import type { SubmitGoalContext } from "./run-goal-service.ts";

export type GoalExecutionSetEntryV1 = {
  sliceId: string;
  runId: string;
  manifestHash: string;
  librarySnapshotHash: string;
  approvalId: string;
  dependsOnSliceIds: string[];
  dependencyArtifactRefs: string[];
  status: "created" | "awaiting_approval" | "scheduling" | "running" | "terminal" | "blocked";
};

export type GoalExecutionSetV1 = {
  schemaVersion: "southstar.goal_execution_set.v1";
  id: string;
  draftId: string;
  goalDesignPackageHash: string;
  cwd: string;
  goalRequirementDraftId?: string;
  goalRequirementDraftHash?: string;
  launchOrder: string[];
  entries: GoalExecutionSetEntryV1[];
  status: "created" | "running" | "terminal";
};

export type GoalExecutionSetOutcomeV1 = {
  schemaVersion: "southstar.goal_execution_set_outcome.v1";
  executionSetId: string;
  goalDesignPackageHash: string;
  status: "in_progress" | "satisfied" | "unsatisfied" | "needs_input";
  runOutcomeRefs: string[];
  failedSliceIds: string[];
  blockedSliceIds: string[];
};

export async function materializeGoalExecutionSetPg(
  context: SubmitGoalContext,
  input: {
    draftId: string;
    expectedPackageHash: string;
    goalRequirementDraftId?: string;
    goalRequirementDraftHash?: string;
  },
): Promise<GoalExecutionSetV1> {
  const existing = await loadGoalExecutionSetByDraftPg(context.db, input.draftId);
  if (existing) return existing;
  const pkg = await loadCurrentGoalDesignPackagePg(context.db, input.draftId);
  if (pkg.packageHash !== input.expectedPackageHash) throw new Error(`goal_design_package_stale: ${input.draftId}`);
  if (pkg.compositionStrategy.mode !== "per-slice-runs") {
    throw new Error(`goal design package is not per-slice-runs: ${input.draftId}`);
  }
  const executionSetId = `goal-execution-set-${contentHashForPayload({ draftId: input.draftId, packageHash: pkg.packageHash }).slice(0, 16)}`;
  const cwd = pkg.goalContract.workspace.cwd;
  const launchOrder = topologicalSliceOrder(pkg.slicePlan.slices);
  const entries: GoalExecutionSetEntryV1[] = [];

  for (const sliceId of launchOrder) {
    const slice = pkg.slicePlan.slices.find((candidate) => candidate.id === sliceId);
    if (!slice) throw new Error(`slice not found: ${sliceId}`);
    const slicePackage = goalDesignPackageForSlice(pkg, slice);
    const sliceDraft = await createPostgresPlannerDraft(context.db, {
      goalPrompt: `${pkg.goalContract.originalPrompt}\n\nSlice ${slice.id}: ${slice.outcome}`,
      cwd,
      goalInterpreter: fixedGoalInterpreter(slicePackage.goalContract),
      goalDesignPackage: slicePackage,
      composer: context.composer,
      ...(input.goalRequirementDraftId ? { goalRequirementDraftId: input.goalRequirementDraftId } : {}),
      ...(input.goalRequirementDraftHash ? { goalRequirementDraftHash: input.goalRequirementDraftHash } : {}),
    });
    if (sliceDraft.status !== "validated") {
      throw new Error(`slice planner draft is not validated: ${slice.id}:${sliceDraft.status}`);
    }
    const run = await createPostgresRunFromDraft(context.db, { draftId: sliceDraft.draftId });
    const runInfo = await attachExecutionSetRunMetadataPg(context.db, {
      executionSetId,
      draftId: sliceDraft.draftId,
      slice,
      packageHash: pkg.packageHash,
      runId: run.runId,
      goalContract: pkg.goalContract,
      ...(input.goalRequirementDraftId ? { goalRequirementDraftId: input.goalRequirementDraftId } : {}),
      ...(input.goalRequirementDraftHash ? { goalRequirementDraftHash: input.goalRequirementDraftHash } : {}),
    });
    entries.push({
      sliceId: slice.id,
      runId: run.runId,
      manifestHash: runInfo.manifestHash,
      librarySnapshotHash: runInfo.librarySnapshotHash,
      approvalId: runInfo.approvalId,
      dependsOnSliceIds: [...slice.dependsOnSliceIds],
      dependencyArtifactRefs: [...slice.dependencyArtifactRefs],
      status: runInfo.runStatus,
    });
  }

  const executionSet: GoalExecutionSetV1 = {
    schemaVersion: "southstar.goal_execution_set.v1",
    id: executionSetId,
    draftId: input.draftId,
    goalDesignPackageHash: pkg.packageHash,
    cwd,
    ...(input.goalRequirementDraftId ? { goalRequirementDraftId: input.goalRequirementDraftId } : {}),
    ...(input.goalRequirementDraftHash ? { goalRequirementDraftHash: input.goalRequirementDraftHash } : {}),
    launchOrder,
    entries,
    status: "created",
  };
  await persistExecutionSetPg(context.db, executionSet);
  await advanceGoalExecutionSetPg(context.db, { executionSetId });
  return await loadGoalExecutionSetPg(context.db, executionSetId);
}

export async function advanceGoalExecutionSetPg(
  db: SouthstarDb,
  input: { executionSetId: string },
): Promise<{ startedRunIds: string[]; waitingSliceIds: string[] }> {
  return await db.tx(async (tx) => {
    const executionSet = await loadGoalExecutionSetForUpdatePg(tx, input.executionSetId);
    if (executionSet.status === "terminal") return { startedRunIds: [], waitingSliceIds: [] };
    const refreshed = await refreshExecutionSetEntriesPg(tx, executionSet);
    const outcome = await evaluateGoalExecutionSetOutcomeLockedPg(tx, refreshed);
    if (outcome.status !== "in_progress") {
      await persistExecutionSetPg(tx, { ...refreshed, status: "terminal" });
      return { startedRunIds: [], waitingSliceIds: [] };
    }

    const waitingSliceIds: string[] = [];
    for (const sliceId of refreshed.launchOrder) {
      const entry = refreshed.entries.find((candidate) => candidate.sliceId === sliceId);
      if (!entry || entry.status !== "created") continue;
      if (!await dependenciesSatisfiedPg(tx, refreshed, entry)) {
        waitingSliceIds.push(entry.sliceId);
        continue;
      }
      await startRunSchedulingPg(tx, { runId: entry.runId });
      const next = updateEntry(refreshed, entry.sliceId, { status: "scheduling" });
      await persistExecutionSetPg(tx, { ...next, status: "running" });
      return { startedRunIds: [entry.runId], waitingSliceIds };
    }
    await persistExecutionSetPg(tx, refreshed);
    return { startedRunIds: [], waitingSliceIds };
  });
}

export async function evaluateGoalExecutionSetOutcomePg(
  db: SouthstarDb,
  input: { executionSetId: string },
): Promise<GoalExecutionSetOutcomeV1> {
  return await db.tx(async (tx) => {
    const executionSet = await loadGoalExecutionSetForUpdatePg(tx, input.executionSetId);
    return await evaluateGoalExecutionSetOutcomeLockedPg(tx, await refreshExecutionSetEntriesPg(tx, executionSet));
  });
}

async function attachExecutionSetRunMetadataPg(
  db: SouthstarDb,
  input: {
    executionSetId: string;
    draftId: string;
    slice: GoalSliceV1;
    packageHash: string;
    runId: string;
    goalContract: GoalContractV1;
    goalRequirementDraftId?: string;
    goalRequirementDraftHash?: string;
  },
): Promise<{ manifestHash: string; librarySnapshotHash: string; approvalId: string; runStatus: "created" | "awaiting_approval" }> {
  return await db.tx(async (tx) => {
    const row = await tx.one<{
      workflow_manifest_json: SouthstarWorkflowManifest;
      runtime_context_json: Record<string, unknown>;
    }>("select workflow_manifest_json, runtime_context_json from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const manifestHash = requiredString(row.runtime_context_json.manifestHash, "manifestHash");
    const librarySnapshot = await loadRunLibrarySnapshotPg(tx, input.runId);
    const risk = deriveGoalExecutionRisk({
      goalContract: input.goalContract,
      workflow: row.workflow_manifest_json,
      librarySnapshot,
    });
    const policy = evaluateApprovalPolicy({ mode: "policy", actionType: "goalExecution", riskTags: risk.riskTags });
    const approvalPayload: GoalExecutionApprovalPayload = {
      actionType: "goalExecution",
      decisionMode: policy.decisionMode,
      policyReason: policy.reason,
      riskTags: risk.riskTags,
      requestedSideEffects: input.goalContract.requestedSideEffects,
      goalContractHash: requiredString(row.runtime_context_json.goalContractHash, "goalContractHash"),
      manifestHash,
      librarySnapshotHash: librarySnapshot.snapshotHash,
      sideEffectEnvelopeHash: risk.sideEffectEnvelopeHash,
    };
    const approval = await createApprovalPg(tx, {
      runId: input.runId,
      actionType: "goalExecution",
      riskTags: risk.riskTags,
      title: `Goal execution approval · ${input.slice.id}`,
      payload: approvalPayload,
      status: policy.status === "approved" ? "approved" : "pending",
    });
    const runStatus = policy.status === "approved" ? "created" : "awaiting_approval";
    await tx.query(
      `update southstar.workflow_runs
          set status = $2,
              runtime_context_json = $3::jsonb,
              updated_at = now()
        where id = $1`,
      [
        input.runId,
        runStatus,
        JSON.stringify({
          ...row.runtime_context_json,
          goalExecutionSetId: input.executionSetId,
          sliceId: input.slice.id,
          dependsOnSliceIds: [...input.slice.dependsOnSliceIds],
          dependencyArtifactRefs: [...input.slice.dependencyArtifactRefs],
          goalDesignPackageHash: input.packageHash,
          parentGoalContractHash: goalContractHash(input.goalContract),
          ...(input.goalRequirementDraftId ? { goalRequirementDraftId: input.goalRequirementDraftId } : {}),
          ...(input.goalRequirementDraftHash ? { goalRequirementDraftHash: input.goalRequirementDraftHash } : {}),
          cwd: input.goalContract.workspace.cwd,
          projectRoot: input.goalContract.workspace.cwd,
        }),
      ],
    );
    return {
      manifestHash,
      librarySnapshotHash: librarySnapshot.snapshotHash,
      approvalId: approval.id,
      runStatus,
    };
  });
}

async function dependenciesSatisfiedPg(
  db: SouthstarDb,
  executionSet: GoalExecutionSetV1,
  entry: GoalExecutionSetEntryV1,
): Promise<boolean> {
  for (const dependencyId of entry.dependsOnSliceIds) {
    const dependency = executionSet.entries.find((candidate) => candidate.sliceId === dependencyId);
    if (!dependency) return false;
    const outcome = await loadRunOutcomePg(db, dependency.runId);
    if (outcome?.status !== "satisfied") return false;
  }
  return true;
}

async function refreshExecutionSetEntriesPg(db: SouthstarDb, executionSet: GoalExecutionSetV1): Promise<GoalExecutionSetV1> {
  const entries = await Promise.all(executionSet.entries.map(async (entry) => {
    const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [entry.runId]);
    const outcome = await loadRunOutcomePg(db, entry.runId);
    if (outcome && (outcome.status === "satisfied" || outcome.status === "unsatisfied" || outcome.status === "blocked")) {
      return { ...entry, status: "terminal" as const };
    }
    if (run.status === "created") return { ...entry, status: "created" as const };
    if (run.status === "awaiting_approval") return { ...entry, status: "awaiting_approval" as const };
    if (run.status === "scheduling") return { ...entry, status: "scheduling" as const };
    if (run.status === "running") return { ...entry, status: "running" as const };
    if (run.status === "blocked") return { ...entry, status: "blocked" as const };
    if (run.status === "cancelled" || run.status === "failed" || run.status === "completed") return { ...entry, status: "terminal" as const };
    return entry;
  }));
  return { ...executionSet, entries };
}

async function evaluateGoalExecutionSetOutcomeLockedPg(
  db: SouthstarDb,
  executionSet: GoalExecutionSetV1,
): Promise<GoalExecutionSetOutcomeV1> {
  const runOutcomeRefs: string[] = [];
  const failedSliceIds: string[] = [];
  const blockedSliceIds: string[] = executionSet.entries.filter((entry) => entry.status === "blocked").map((entry) => entry.sliceId);
  let allSatisfied = true;
  for (const entry of executionSet.entries) {
    const outcome = await loadRunOutcomePg(db, entry.runId);
    if (!outcome) {
      allSatisfied = false;
      continue;
    }
    runOutcomeRefs.push(`goal-outcome:${entry.runId}`);
    if (outcome.status === "satisfied") continue;
    allSatisfied = false;
    if (outcome.status === "unsatisfied") failedSliceIds.push(entry.sliceId);
    else blockedSliceIds.push(entry.sliceId);
  }
  const status = failedSliceIds.length > 0
    ? "unsatisfied"
    : blockedSliceIds.length > 0
      ? "needs_input"
      : allSatisfied
        ? "satisfied"
        : "in_progress";
  const outcome: GoalExecutionSetOutcomeV1 = {
    schemaVersion: "southstar.goal_execution_set_outcome.v1",
    executionSetId: executionSet.id,
    goalDesignPackageHash: executionSet.goalDesignPackageHash,
    status,
    runOutcomeRefs,
    failedSliceIds: [...new Set(failedSliceIds)].sort(),
    blockedSliceIds: [...new Set(blockedSliceIds)].sort(),
  };
  await upsertRuntimeResourcePg(db, {
    id: `goal-execution-set-outcome:${executionSet.id}`,
    resourceType: "goal_execution_set_outcome",
    resourceKey: executionSet.id,
    scope: "planner",
    status,
    title: "Goal Execution Set Outcome",
    payload: outcome,
    summary: {
      executionSetId: executionSet.id,
      goalDesignPackageHash: executionSet.goalDesignPackageHash,
      status,
      failedSliceIds: outcome.failedSliceIds,
      blockedSliceIds: outcome.blockedSliceIds,
    },
  });
  return outcome;
}

async function loadRunOutcomePg(db: SouthstarDb, runId: string): Promise<{ status: string } | undefined> {
  const resource = await getResourceByKeyPg(db, "goal_outcome", `goal-outcome:${runId}`);
  return resource ? { status: resource.status } : undefined;
}

async function persistExecutionSetPg(db: SouthstarDb, executionSet: GoalExecutionSetV1): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: executionSet.id,
    resourceType: "goal_execution_set",
    resourceKey: executionSet.id,
    scope: "planner",
    status: executionSet.status,
    title: "Goal Execution Set",
    payload: executionSet,
    summary: {
      draftId: executionSet.draftId,
      goalDesignPackageHash: executionSet.goalDesignPackageHash,
      cwd: executionSet.cwd,
      ...(executionSet.goalRequirementDraftId ? { goalRequirementDraftId: executionSet.goalRequirementDraftId } : {}),
      ...(executionSet.goalRequirementDraftHash ? { goalRequirementDraftHash: executionSet.goalRequirementDraftHash } : {}),
      entryCount: executionSet.entries.length,
      status: executionSet.status,
    },
  });
}

async function loadGoalExecutionSetByDraftPg(db: SouthstarDb, draftId: string): Promise<GoalExecutionSetV1 | undefined> {
  const row = await db.maybeOne<{ payload_json: GoalExecutionSetV1 }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'goal_execution_set' and payload_json->>'draftId' = $1 order by created_at desc limit 1",
    [draftId],
  );
  return row?.payload_json;
}

async function loadGoalExecutionSetPg(db: SouthstarDb, executionSetId: string): Promise<GoalExecutionSetV1> {
  const resource = await getResourceByKeyPg(db, "goal_execution_set", executionSetId);
  if (!resource) throw new Error(`goal execution set not found: ${executionSetId}`);
  return resource.payload as GoalExecutionSetV1;
}

async function loadGoalExecutionSetForUpdatePg(db: SouthstarDb, executionSetId: string): Promise<GoalExecutionSetV1> {
  const row = await db.one<{ payload_json: GoalExecutionSetV1 }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'goal_execution_set' and resource_key = $1 for update",
    [executionSetId],
  );
  return row.payload_json;
}

function updateEntry(
  executionSet: GoalExecutionSetV1,
  sliceId: string,
  patch: Partial<GoalExecutionSetEntryV1>,
): GoalExecutionSetV1 {
  return {
    ...executionSet,
    entries: executionSet.entries.map((entry) => entry.sliceId === sliceId ? { ...entry, ...patch } : entry),
  };
}

function goalDesignPackageForSlice(pkg: GoalDesignPackage, slice: GoalSliceV1): GoalDesignPackage {
  const sliceGoalContract = goalContractForSlice(pkg.goalContract, slice);
  if (pkg.schemaVersion === "southstar.goal_design_package.v2") {
    return finalizeGoalDesignPackageV2({
      schemaVersion: "southstar.goal_design_package.v2",
      revision: pkg.revision,
      ...(pkg.parentRevision !== undefined ? { parentRevision: pkg.parentRevision } : {}),
      goalContract: sliceGoalContract,
      requirementDraftHash: pkg.requirementDraftHash,
      validationBindings: pkg.validationBindings.filter((binding) => slice.evaluatorContractRefs.includes(binding.id)),
      slicePlan: {
        schemaVersion: "southstar.goal_slice_plan.v1",
        goalContractHash: "host-filled",
        revision: pkg.slicePlan.revision,
        slices: [{ ...slice, dependsOnSliceIds: [], dependencyArtifactRefs: [] }],
      },
      compositionStrategy: { mode: "single-run", sliceIds: [slice.id], rationale: `Compose slice ${slice.id} as one ordinary run.` },
      templatePolicy: pkg.templatePolicy,
      goalDesignSkillRef: pkg.goalDesignSkillRef,
      goalDesignSkillVersionRef: pkg.goalDesignSkillVersionRef,
      workspaceDiscoveryHash: pkg.workspaceDiscoveryHash,
      mode: pkg.mode,
    });
  }
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: pkg.revision,
    ...(pkg.parentRevision !== undefined ? { parentRevision: pkg.parentRevision } : {}),
    goalContract: sliceGoalContract,
    evaluatorContracts: pkg.evaluatorContracts.filter((contract) => slice.evaluatorContractRefs.includes(contract.id)),
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: pkg.slicePlan.revision,
      slices: [{ ...slice, dependsOnSliceIds: [], dependencyArtifactRefs: [] }],
    },
    compositionStrategy: { mode: "single-run", sliceIds: [slice.id], rationale: `Compose slice ${slice.id} as one ordinary run.` },
    templatePolicy: pkg.templatePolicy,
    goalDesignSkillRef: pkg.goalDesignSkillRef,
    goalDesignSkillVersionRef: pkg.goalDesignSkillVersionRef,
    workspaceDiscoveryHash: pkg.workspaceDiscoveryHash,
    mode: pkg.mode,
  });
}

function goalContractForSlice(goalContract: GoalContractV1, slice: GoalSliceV1): GoalContractV1 {
  const requirementIds = new Set(slice.requirementIds);
  const artifactRefs = new Set([...slice.expectedArtifactRefs, ...slice.dependencyArtifactRefs]);
  const requirements = goalContract.requirements
    .filter((requirement) => requirementIds.has(requirement.id))
    .map((requirement) => ({
      statement: requirement.statement,
      acceptanceCriteria: [...requirement.acceptanceCriteria],
      blocking: requirement.blocking,
      source: requirement.source,
      expectedArtifacts: requirement.expectedArtifacts.map((artifact) => ({ ...artifact })),
    }));
  if (requirements.length === 0) throw new Error(`slice has no Goal Contract requirements: ${slice.id}`);
  return finalizeGoalContract({
    goalPrompt: `${goalContract.originalPrompt}\n\nSlice ${slice.id}: ${slice.outcome}`,
    cwd: goalContract.workspace.cwd,
    projectRef: goalContract.workspace.projectRef,
    interpretation: {
      domain: goalContract.domain,
      intent: goalContract.intent,
      workType: goalContract.workType,
      summary: `${goalContract.summary} · ${slice.id}`,
      requirements,
      expectedArtifactRefs: goalContract.expectedArtifactRefs.filter((ref) => artifactRefs.has(ref)),
      requiredCapabilities: [...goalContract.requiredCapabilities],
      nonGoals: [...goalContract.nonGoals],
      assumptions: [...goalContract.assumptions],
      blockingInputs: [],
      riskTags: [...goalContract.riskTags],
      requestedSideEffects: [...goalContract.requestedSideEffects],
    },
  });
}

function topologicalSliceOrder(slices: GoalSliceV1[]): string[] {
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`slice dependency cycle: ${id}`);
    const slice = byId.get(id);
    if (!slice) throw new Error(`unknown slice dependency: ${id}`);
    visiting.add(id);
    for (const dependencyId of [...slice.dependsOnSliceIds].sort()) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };
  for (const slice of [...slices].sort((a, b) => a.id.localeCompare(b.id))) visit(slice.id);
  return order;
}

function fixedGoalInterpreter(goalContract: GoalContractV1): GoalContractInterpreter {
  return { async interpret() { return goalContract; } };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}
