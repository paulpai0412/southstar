import {
  CANONICAL_DIAGNOSTIC_CODES,
  CanonicalDiagnosticError,
  canonicalDiagnostic,
  type CanonicalDiagnostic,
} from "../canonical-diagnostics.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";
import {
  goalDesignPackageV3FromUnknown,
  type GoalDesignPackageV3,
} from "./goal-design.ts";

export async function loadCanonicalGoalDesignPackagePg(
  db: SouthstarDb,
  draftId: string,
): Promise<GoalDesignPackageV3> {
  const draft = await getResourceByKeyPg(db, "planner_draft", draftId);
  if (!draft) throw new Error(`planner draft not found: ${draftId}`);
  const payload = asRecord(draft.payload);
  const goalDesignPackage = goalDesignPackageV3FromUnknown(payload.goalDesignPackage);
  if (goalDesignPackage) {
    if (nonEmptyString(payload.goalDesignPackageHash) === goalDesignPackage.packageHash) return goalDesignPackage;
    return await rejectIncompatibleGoalDesignDraftPg(db, {
      draftId,
      code: CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageInvalid,
      detail: `planner draft ${draftId} stored Goal Design package hash does not match its canonical package`,
    });
  }
  return await rejectIncompatibleGoalDesignDraftPg(db, { draftId });
}

export async function rejectIncompatibleGoalDesignDraftPg(
  db: SouthstarDb,
  input: { draftId: string; code?: CanonicalDiagnosticError["code"]; detail?: string },
): Promise<never> {
  throwCanonicalGoalDesignDraftRejection(
    await persistIncompatibleGoalDesignDraftPg(db, input),
  );
}

export type CanonicalGoalDesignDraftRejection = {
  diagnostic: CanonicalDiagnostic;
  detail: string;
};

export async function persistIncompatibleGoalDesignDraftPg(
  db: SouthstarDb,
  input: { draftId: string; code?: CanonicalDiagnosticError["code"]; detail?: string },
): Promise<CanonicalGoalDesignDraftRejection> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
  const payload = asRecord(draft.payload);
  const summary = asRecord(draft.summary);
  const code = input.code ?? (payload.goalDesignPackage === undefined
    ? CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageRequired
    : CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageInvalid);
  const detail = input.detail
    ?? `planner draft ${input.draftId} does not contain a valid southstar.goal_design_package.v3`;
  const diagnostic = canonicalDiagnostic(code, detail);
  const validationIssues = [
    ...validationIssueRecords(summary.validationIssues ?? payload.validationIssues)
      .filter((issue) => issue.path !== "goalDesignPackage"),
    { path: "goalDesignPackage", code, message: diagnostic.message },
  ];
  await upsertRuntimeResourcePg(db, {
    id: draft.id,
    resourceType: "planner_draft",
    resourceKey: input.draftId,
    ...(draft.runId ? { runId: draft.runId } : {}),
    ...(draft.taskId ? { taskId: draft.taskId } : {}),
    ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
    scope: draft.scope,
    status: "invalid",
    ...(draft.title ? { title: draft.title } : {}),
    payload: {
      ...payload,
      canonicalDiagnostic: diagnostic,
      validationIssues,
    },
    summary: {
      ...summary,
      status: "invalid",
      blockers: [diagnostic.message],
      validationIssues,
      canonicalDiagnostic: diagnostic,
    },
    metrics: draft.metrics,
    ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}),
  });
  return { diagnostic, detail };
}

export function throwCanonicalGoalDesignDraftRejection(
  rejection: CanonicalGoalDesignDraftRejection,
): never {
  throw new CanonicalDiagnosticError(rejection.diagnostic.code, rejection.detail);
}

function validationIssueRecords(value: unknown): Array<Record<string, unknown> & { path?: string }> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> & { path?: string } =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
