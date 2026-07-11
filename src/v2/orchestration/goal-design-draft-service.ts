import type { SouthstarDb } from "../db/postgres.ts";
import {
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";
import {
  loadGoalDesignSkillPg,
  validateGoalDesignPackage,
  type GoalDesignMode,
  type GoalDesignPackageV1,
  type GoalDesigner,
  type WorkflowTemplatePolicyV1,
} from "./goal-design.ts";
import {
  goalContractHash,
  type GoalContractInterpreter,
  type GoalContractV1,
} from "./goal-contract.ts";
import { discoverGoalWorkspace } from "./goal-workspace-discovery.ts";
import type {
  PlannerDraftPersistence,
  PlannerDraftProgressListener,
  PostgresPlannerDraftResult,
} from "../ui-api/postgres-run-api.ts";

type RuntimeResourceUpsertInput = Parameters<typeof upsertRuntimeResourcePg>[1];

export async function persistGoalDesignPackageRevisionPg(
  db: SouthstarDb,
  input: { draftId: string; package: GoalDesignPackageV1 },
): Promise<void> {
  const resourceKey = `${input.draftId}:revision:${input.package.revision}`;
  const existing = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'goal_design_package_revision' and resource_key = $1",
    [resourceKey],
  );
  const existingPackageHash = packageHashFromPayload(existing?.payload_json);
  if (existingPackageHash) {
    if (existingPackageHash !== input.package.packageHash) {
      throw new Error(`goal_design_revision_conflict: ${resourceKey}`);
    }
    return;
  }
  const issues = validateGoalDesignPackage(input.package);
  if (issues.length > 0) {
    throw new Error(`invalid Goal Design package: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ")}`);
  }
  await upsertRuntimeResourcePg(db, {
    resourceType: "goal_design_package_revision",
    resourceKey,
    scope: "planner",
    status: "persisted",
    title: `Goal Design Revision ${input.package.revision}`,
    payload: {
      draftId: input.draftId,
      goalDesignPackage: input.package,
      packageHash: input.package.packageHash,
    },
    summary: {
      draftId: input.draftId,
      revision: input.package.revision,
      parentRevision: input.package.parentRevision,
      goalContractHash: input.package.goalContractHash,
      packageHash: input.package.packageHash,
      mode: input.package.mode,
      templatePolicy: input.package.templatePolicy,
      sliceCount: input.package.slicePlan.slices.length,
    },
  });
}

export async function loadCurrentGoalDesignPackagePg(
  db: SouthstarDb,
  draftId: string,
): Promise<GoalDesignPackageV1> {
  const row = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
    [draftId],
  );
  const pkg = goalDesignPackageFromStored(row?.payload_json.goalDesignPackage);
  if (!pkg) throw new Error(`Goal Design package not found: ${draftId}`);
  return pkg;
}

export async function preparePostgresGoalDesignDraft(
  db: SouthstarDb,
  input: {
    goalPrompt: string;
    cwd: string;
    mode: GoalDesignMode;
    templatePolicy: WorkflowTemplatePolicyV1;
    goalInterpreter: GoalContractInterpreter;
    goalDesigner: GoalDesigner;
    persistDraft?: PlannerDraftPersistence;
    onProgress?: PlannerDraftProgressListener;
  },
): Promise<PostgresPlannerDraftResult> {
  input.onProgress?.({ stage: "request.normalized", message: "Goal Design request normalized." });
  const skill = await loadGoalDesignSkillPg(db);
  const workspaceDiscovery = await discoverGoalWorkspace(input.cwd);
  const goalContract = await input.goalInterpreter.interpret({
    goalPrompt: input.goalPrompt,
    cwd: input.cwd,
    goalDesignSkill: skill,
    workspaceDiscovery,
  });
  const contractHash = goalContractHash(goalContract);
  input.onProgress?.({ stage: "goal_contract.interpreted", message: "Goal Contract interpreted." });
  if (goalContract.blockingInputs.length > 0) {
    return await persistGoalContractOnlyDraft(db, {
      goalPrompt: input.goalPrompt,
      cwd: input.cwd,
      goalContract,
      goalContractHash: contractHash,
      skill,
      workspaceDiscoveryHash: workspaceDiscovery.discoveryHash,
      persistDraft: input.persistDraft,
      onProgress: input.onProgress,
    });
  }

  const pkg = await input.goalDesigner.design({
    goalContract,
    workspaceDiscovery,
    mode: input.mode,
    templatePolicy: input.templatePolicy,
    skill,
  });
  const issues = validateGoalDesignPackage(pkg);
  if (issues.length > 0) {
    throw new Error(`invalid Goal Design package: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ")}`);
  }
  const draftId = `draft-goal-design-${pkg.packageHash.slice(0, 12)}`;
  await persistGoalDesignPackageRevisionPg(db, { draftId, package: pkg });
  await persistPlannerDraftResource(db, {
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "ready_for_review",
    title: "Goal Design Ready For Review",
    payload: {
      goalContract,
      goalContractHash: contractHash,
      goalDesignPackage: pkg,
      goalDesignPackageHash: pkg.packageHash,
      plannerRequest: {
        goalPrompt: input.goalPrompt,
        cwd: input.cwd,
        goalDesignMode: input.mode,
        templatePolicy: input.templatePolicy,
      },
      goalDesignSkillRef: skill.objectKey,
      goalDesignSkillVersionRef: skill.versionRef,
      workspaceDiscoveryHash: workspaceDiscovery.discoveryHash,
    },
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId: "",
      planner: "goal-design",
      status: "ready_for_review",
      validationIssues: [],
      taskSummaries: [],
      goalContractHash: contractHash,
      goalDesignPackageHash: pkg.packageHash,
      domain: goalContract.domain,
      intent: goalContract.intent,
      blockers: [],
      requirementCount: goalContract.requirements.length,
      sliceCount: pkg.slicePlan.slices.length,
      plannerRequest: {
        goalPrompt: input.goalPrompt,
        cwd: input.cwd,
        goalDesignMode: input.mode,
        templatePolicy: input.templatePolicy,
      },
    },
  }, input.persistDraft);
  input.onProgress?.({
    stage: "goal_design.persisted",
    ok: true,
    issueCount: 0,
    message: "Goal Design package persisted.",
  });
  return {
    draftId,
    goalPrompt: input.goalPrompt,
    workflowId: "",
    status: "ready_for_review",
    goalContractHash: contractHash,
    goalDesignPackageHash: pkg.packageHash,
    blockers: [],
    validationIssues: [],
    taskSummaries: [],
  } as PostgresPlannerDraftResult;
}

async function persistGoalContractOnlyDraft(
  db: SouthstarDb,
  input: {
    goalPrompt: string;
    cwd: string;
    goalContract: GoalContractV1;
    goalContractHash: string;
    skill: { objectKey: string; versionRef: string };
    workspaceDiscoveryHash: string;
    persistDraft?: PlannerDraftPersistence;
    onProgress?: PlannerDraftProgressListener;
  },
): Promise<PostgresPlannerDraftResult> {
  const draftId = `draft-goal-${input.goalContractHash.slice(0, 12)}`;
  const blockers = [...input.goalContract.blockingInputs];
  await persistPlannerDraftResource(db, {
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "needs_input",
    title: "Planner Draft Needs Input",
    payload: {
      goalContract: input.goalContract,
      goalContractHash: input.goalContractHash,
      plannerRequest: { goalPrompt: input.goalPrompt, cwd: input.cwd },
      goalDesignSkillRef: input.skill.objectKey,
      goalDesignSkillVersionRef: input.skill.versionRef,
      workspaceDiscoveryHash: input.workspaceDiscoveryHash,
    },
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId: "",
      planner: "goal-design",
      status: "needs_input",
      validationIssues: [],
      taskSummaries: [],
      goalContractHash: input.goalContractHash,
      domain: input.goalContract.domain,
      intent: input.goalContract.intent,
      blockers,
      requirementCount: input.goalContract.requirements.length,
    },
  }, input.persistDraft);
  input.onProgress?.({ stage: "draft.persisted", ok: false, issueCount: blockers.length, message: "Planner draft needs input." });
  return {
    draftId,
    goalPrompt: input.goalPrompt,
    workflowId: "",
    status: "needs_input",
    goalContractHash: input.goalContractHash,
    blockers,
    validationIssues: [],
    taskSummaries: [],
  };
}

async function persistPlannerDraftResource(
  db: SouthstarDb,
  resource: RuntimeResourceUpsertInput,
  persistDraft?: PlannerDraftPersistence,
): Promise<void> {
  if (persistDraft) return await persistDraft(resource);
  await upsertRuntimeResourcePg(db, resource);
}

function goalDesignPackageFromStored(value: unknown): GoalDesignPackageV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pkg = value as GoalDesignPackageV1;
  return validateGoalDesignPackage(pkg).length === 0 ? pkg : undefined;
}

function packageHashFromPayload(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.packageHash === "string") return record.packageHash;
  const nested = record.goalDesignPackage;
  return nested && typeof nested === "object" && !Array.isArray(nested) && typeof (nested as { packageHash?: unknown }).packageHash === "string"
    ? (nested as { packageHash: string }).packageHash
    : undefined;
}
