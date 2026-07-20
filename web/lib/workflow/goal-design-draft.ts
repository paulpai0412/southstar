import type { GoalDesignContent, GoalDesignPhase, GoalRequirementDraftView, GoalSliceSelection } from "@/lib/types";

export type CurrentGoalDesignDraft = {
  draftId: string;
  status?: string;
  goalDesignPhase?: GoalDesignPhase;
  goalDesignPackageHash: string;
  goalDesignPackage: unknown;
  goalRequirementDraft?: GoalRequirementDraftView;
  goalRequirementDraftHash?: string;
};

export async function readCurrentGoalDesignDraft(
  draftId: string,
  options?: { signal?: AbortSignal },
): Promise<CurrentGoalDesignDraft> {
  const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(draftId)}/orchestration`, {
    cache: "no-store",
    signal: options?.signal,
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => undefined) as unknown;
  const envelope = isRecord(payload) ? payload : undefined;
  if (!response.ok) {
    throw new Error(errorMessage(envelope) ?? `HTTP ${response.status}`);
  }
  const value = isRecord(envelope?.result) ? envelope.result : envelope;
  if (!value || typeof value.draftId !== "string" || value.draftId !== draftId) {
    throw new Error("Current Goal Design draft response was invalid.");
  }
  if (typeof value.goalDesignPackageHash !== "string" || !isRecord(value.goalDesignPackage)) {
    throw new Error("Current Goal Design package hash or package is missing.");
  }
  return {
    draftId,
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.goalDesignPhase === "string" ? { goalDesignPhase: value.goalDesignPhase as GoalDesignPhase } : {}),
    goalDesignPackageHash: value.goalDesignPackageHash,
    goalDesignPackage: value.goalDesignPackage,
    ...(isRecord(value.goalRequirementDraft) ? { goalRequirementDraft: value.goalRequirementDraft as unknown as GoalRequirementDraftView } : {}),
    ...(typeof value.goalRequirementDraftHash === "string" ? { goalRequirementDraftHash: value.goalRequirementDraftHash } : {}),
  };
}

export function goalSliceSelectionFromCurrentDraft(
  current: CurrentGoalDesignDraft,
  selection: Pick<GoalSliceSelection, "selectedSliceId"> & Partial<GoalSliceSelection>,
): GoalSliceSelection {
  return {
    ...selection,
    draftId: current.draftId,
    ...(current.status ? { status: current.status } : {}),
    ...(current.goalDesignPhase ? { goalDesignPhase: current.goalDesignPhase } : {}),
    goalDesignPackageHash: current.goalDesignPackageHash,
    package: current.goalDesignPackage,
    ...(current.goalRequirementDraft ? { requirementDraft: current.goalRequirementDraft } : {}),
  };
}

export function goalDesignContentFromSelection(selection: GoalSliceSelection): GoalDesignContent {
  if (selection.package === undefined || !selection.goalDesignPackageHash) {
    throw new Error("Goal Design save response did not include the current package snapshot.");
  }
  return {
    type: "goalDesign",
    draftId: selection.draftId,
    ...(selection.status ? { status: selection.status } : {}),
    ...(selection.goalDesignPhase ? { goalDesignPhase: selection.goalDesignPhase } : {}),
    goalDesignPackageHash: selection.goalDesignPackageHash,
    package: selection.package,
    ...(selection.requirementDraft ? {
      goalRequirementDraft: selection.requirementDraft,
      goalRequirementDraftHash: selection.requirementDraft.draftHash,
    } : {}),
    ...(selection.selectedSliceId ? { selectedSliceId: selection.selectedSliceId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(value: Record<string, unknown> | undefined): string | undefined {
  return typeof value?.error === "string" ? value.error : typeof value?.message === "string" ? value.message : undefined;
}
