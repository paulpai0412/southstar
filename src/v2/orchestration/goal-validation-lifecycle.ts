import type { SouthstarDb } from "../db/postgres.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { findLibraryObjectByKeyForUpdate } from "../design-library/library-graph-store.ts";
import {
  createLibraryImportDraft,
  loadLibraryImportCandidateDraft,
} from "../design-library/importers/library-import-draft-store.ts";
import type { LibraryImportCandidateInstallResult } from "../design-library/importers/library-import-draft-store.ts";
import type { LibraryImportLlmProvider } from "../design-library/importers/library-llm-import-analyzer.ts";
import type { LibraryImportSourceFetcher } from "../design-library/importers/library-source-fetcher.ts";
import type { GoalValidationResolutionV2 } from "../design-library/types.ts";
import { criterionValidationCheckKey } from "../design-library/types.ts";
import { resolveApprovedValidationCandidates } from "./candidate-resolver.ts";
import {
  getResourceByKeyPg,
  insertRuntimeResourceIfAbsentPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";
import { goalContractHash, storedGoalContract, type GoalContractV1 } from "./goal-contract.ts";
import { validateGoalRequirementDraft, type GoalRequirementDraftIssue, type GoalRequirementDraftV1 } from "./goal-requirement-draft.ts";
import { goalValidationResolutionReady, type GoalValidationProgressListener } from "./goal-validation-resolver.ts";
import {
  buildGoalValidationImportRequest,
  goalValidationProposalValidatorFromLibraryLlm,
  goalValidationResolverFromLibraryLlm,
  rankGoalValidationCandidatesFromProposal,
  GoalValidationProviderNotConfiguredError,
  type GoalValidationResolver,
} from "./goal-validation-llm-adapter.ts";
import {
  resolveGoalValidationWithCandidates,
  type GoalValidationCandidateRecommendationV1,
} from "./goal-validation-resolver.ts";

type PlannerDraftResourceRow = {
  id: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  scope: string;
  status: string;
  title: string | null;
  payload_json: Record<string, unknown>;
  summary_json: Record<string, unknown>;
  metrics_json: Record<string, unknown>;
  expires_at: string | null;
};

export type GoalValidationLifecycleResult = {
  draftId: string;
  goalRequirementDraftId: string;
  status: "library_review" | "validation_ready";
  phase: "library_review" | "validation_ready";
  goalPrompt: string;
  goalRequirementDraft: GoalRequirementDraftV1;
  goalRequirementDraftHash: string;
  confirmable: false;
  validationIssues: GoalRequirementDraftIssue[];
  goalContract: GoalContractV1;
  goalContractHash: string;
  blockers: string[];
  goalValidationResolution: GoalValidationResolutionV2;
  validationBindings: GoalValidationResolutionV2["bindings"];
  validationGaps: GoalValidationResolutionV2["gaps"];
  libraryImportDraftId?: string;
  invalidated?: {
    validationBindings: boolean;
    slicePlan: boolean;
    dagDraft: boolean;
  };
};

export { GoalValidationProviderNotConfiguredError };
export type { GoalValidationResolver };

export class GoalValidationImportStaleError extends Error {
  readonly code = "goal_validation_import_stale";
  readonly status = 409;

  constructor(readonly libraryImportDraftId: string, message: string) {
    super(`goal_validation_import_stale: ${message}`);
    this.name = "GoalValidationImportStaleError";
  }
}

export async function resumeInstalledLibraryImportGoalValidationPg(
  db: SouthstarDb,
  input: {
    installed: LibraryImportCandidateInstallResult;
    libraryImportLlmProvider?: LibraryImportLlmProvider;
    libraryImportSourceFetcher?: LibraryImportSourceFetcher;
    onValidationReady?: (result: GoalValidationLifecycleResult) => Promise<Record<string, unknown>>;
  },
): Promise<LibraryImportCandidateInstallResult & {
  installed: true;
  goalValidationResume?: Record<string, unknown>;
}> {
  const resource = await getResourceByKeyPg(db, "library_import_draft", input.installed.draftId);
  const payload = asRecord(resource?.payload);
  if (!optionalString(payload.originGoalDraftId)) return { ...input.installed, installed: true };
  let resumed: GoalValidationLifecycleResult | undefined;
  try {
    resumed = await resumeGoalValidationAfterLibraryImportPg(db, {
      libraryImportDraftId: input.installed.draftId,
      libraryImportLlmProvider: input.libraryImportLlmProvider,
      libraryImportSourceFetcher: input.libraryImportSourceFetcher,
      actor: optionalString(asRecord(payload.install).actor) ?? "operator",
    });
    const continued = resumed.status === "validation_ready" && input.onValidationReady
      ? await input.onValidationReady(resumed)
      : undefined;
    return {
      ...input.installed,
      installed: true,
      goalValidationResume: {
        ok: true,
        recoverable: false,
        draftId: resumed.draftId,
        status: optionalString(continued?.status) ?? resumed.status,
        goalDesignPhase: optionalString(continued?.phase) ?? resumed.phase,
        resolutionHash: resumed.goalValidationResolution.resolutionHash,
        ...(continued ? { continued } : {}),
        ...(resumed.libraryImportDraftId ? { libraryImportDraftId: resumed.libraryImportDraftId } : {}),
      },
    };
  } catch (error) {
    return {
      ...input.installed,
      installed: true,
      goalValidationResume: {
        ok: false,
        recoverable: true,
        draftId: optionalString(payload.originGoalDraftId),
        status: resumed?.status ?? "library_review",
        goalDesignPhase: resumed?.phase ?? "library_review",
        ...(resumed ? { resolutionHash: resumed.goalValidationResolution.resolutionHash } : {}),
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof GoalValidationProviderNotConfiguredError ? {
          code: error.code,
          httpStatus: error.status,
          readiness: error.readiness,
        } : {}),
      },
    };
  }
}

export async function assertGoalValidationImportCurrentPg(
  db: SouthstarDb,
  libraryImportDraftId: string,
  options: { lockForInstall?: boolean; allowInstalledContractReconciliation?: boolean } = {},
): Promise<{ linked: boolean; originGoalDraftId?: string }> {
  let importDraft = await getResourceByKeyPg(db, "library_import_draft", libraryImportDraftId);
  if (!importDraft) throw new GoalValidationImportStaleError(libraryImportDraftId, "linked import is missing");
  let payload = asRecord(importDraft.payload);
  const originGoalDraftId = optionalString(payload.originGoalDraftId);
  if (options.lockForInstall) {
    if (originGoalDraftId) {
      await db.query(
        `select id from southstar.runtime_resources
          where resource_type = 'planner_draft' and resource_key = $1
          for update`,
        [originGoalDraftId],
      );
    }
    await db.query(
      `select id from southstar.runtime_resources
        where resource_type = 'library_import_draft' and resource_key = $1
        for update`,
      [libraryImportDraftId],
    );
    importDraft = await getResourceByKeyPg(db, "library_import_draft", libraryImportDraftId);
    if (!importDraft) throw new GoalValidationImportStaleError(libraryImportDraftId, "linked import is missing");
    payload = asRecord(importDraft.payload);
  }
  const lockedOriginGoalDraftId = optionalString(payload.originGoalDraftId);
  if (!lockedOriginGoalDraftId) return { linked: false };
  if (lockedOriginGoalDraftId !== originGoalDraftId) {
    throw new GoalValidationImportStaleError(libraryImportDraftId, "linked import origin changed while acquiring the install lock");
  }
  const expectedContractHash = requiredString(payload.originGoalContractHash, "originGoalContractHash", libraryImportDraftId);
  const expectedRequirementHash = requiredString(payload.originGoalRequirementDraftHash, "originGoalRequirementDraftHash", libraryImportDraftId);
  const expectedResolutionHash = requiredString(payload.originGoalValidationResolutionHash, "originGoalValidationResolutionHash", libraryImportDraftId);
  const expectedGapHash = optionalString(payload.originGoalValidationGapHash);
  const current = await loadGoalValidationSourcePg(db, lockedOriginGoalDraftId).catch(() => undefined);
  const planner = await getResourceByKeyPg(db, "planner_draft", lockedOriginGoalDraftId);
  const resolution = asRecord(asRecord(planner?.payload).goalValidationResolution);
  const currentResolutionHash = optionalString(resolution.resolutionHash);
  const currentGapHash = Array.isArray(resolution.gaps) ? contentHashForPayload(resolution.gaps) : undefined;
  const installedContractReconciliation = options.allowInstalledContractReconciliation
    && importDraft.status === "installed"
    && current?.requirementDraft.draftHash === expectedRequirementHash
    && current?.phase !== "requirements_review";
  if ((!current || current.goalContractHash !== expectedContractHash
    || current.requirementDraft.draftHash !== expectedRequirementHash
    || current.phase !== "library_review"
    || currentResolutionHash !== expectedResolutionHash
    || (expectedGapHash !== undefined && currentGapHash !== expectedGapHash))
    && !installedContractReconciliation) {
    if (importDraft.status === "draft") {
      const stale = JSON.stringify({ staleReason: "goal_validation_resolution_changed", staleAt: new Date().toISOString() });
      await db.query(
        `update southstar.runtime_resources
            set status = 'stale', payload_json = payload_json || $2::jsonb,
                summary_json = summary_json || $2::jsonb, updated_at = now()
          where resource_type = 'library_import_draft' and resource_key = $1 and status = 'draft'`,
        [libraryImportDraftId, stale],
      );
    }
    throw new GoalValidationImportStaleError(libraryImportDraftId, "the persisted Goal validation resolution no longer matches the import origin");
  }
  return { linked: true, originGoalDraftId: lockedOriginGoalDraftId };
}

export async function resolveAndPersistGoalValidationPg(
  db: SouthstarDb,
  input: {
    draftId: string;
    expectedGoalContractHash: string;
    resolver?: GoalValidationResolver;
    libraryImportLlmProvider?: LibraryImportLlmProvider;
    libraryImportSourceFetcher?: LibraryImportSourceFetcher;
    actor?: string;
    progress?: GoalValidationProgressListener;
  },
): Promise<GoalValidationLifecycleResult> {
  const snapshot = await loadGoalValidationSourcePg(db, input.draftId);
  if (snapshot.goalContractHash !== input.expectedGoalContractHash) throw new Error(`goal_contract_stale: ${input.draftId}`);
  const resolver = input.resolver ?? goalValidationResolverFromLibraryLlm(input.libraryImportLlmProvider);
  const resolution = await resolver(db, {
    goalContract: snapshot.goalContract,
    requirementDraft: snapshot.requirementDraft,
    scope: snapshot.goalContract.domain,
    progress: input.progress,
  });
  assertGoalValidationResolutionMatches(snapshot, resolution);
  let persisted = await persistGoalValidationResolutionPg(db, {
    draftId: input.draftId,
    expectedGoalContractHash: input.expectedGoalContractHash,
    expectedGoalRequirementDraftHash: snapshot.requirementDraft.draftHash,
    resolution,
    actor: input.actor,
  });
  if (persisted.status === "validation_ready") return persisted;
  if (persisted.libraryImportDraftId) {
    const linked = await getResourceByKeyPg(db, "library_import_draft", persisted.libraryImportDraftId);
    if (linked?.status === "draft") return persisted;
  }
  if (!input.libraryImportLlmProvider) return persisted;

  const request = buildGoalValidationImportRequest({
    goalContract: snapshot.goalContract,
    goalContractHash: snapshot.goalContractHash,
    requirementDraft: snapshot.requirementDraft,
    resolution,
  });
  const importDraft = await createLibraryImportDraft(db, {
    source: { kind: "paste", label: "Confirmed Goal validation gaps", content: JSON.stringify(request.payload) },
    scope: snapshot.goalContract.domain,
    requestPrompt: request.prompt,
    coverageConstraints: request.coverageConstraints,
    ...(input.resolver ? {} : {
      proposalValidator: goalValidationProposalValidatorFromLibraryLlm({
        db,
        provider: input.libraryImportLlmProvider,
        goalContract: snapshot.goalContract,
        requirementDraft: snapshot.requirementDraft,
        resolution,
        scope: snapshot.goalContract.domain,
      }),
    }),
    llmProvider: input.libraryImportLlmProvider,
    sourceFetcher: input.libraryImportSourceFetcher,
    originGoalDraftId: input.draftId,
    originGoalContractHash: snapshot.goalContractHash,
    originGoalRequirementDraftHash: snapshot.requirementDraft.draftHash,
    originGoalValidationResolutionHash: resolution.resolutionHash,
    originGoalValidationGapHash: contentHashForPayload(resolution.gaps),
    progress: input.progress,
  });
  persisted = await attachGoalValidationImportDraftPg(db, {
    draftId: input.draftId,
    expectedGoalContractHash: snapshot.goalContractHash,
    expectedGoalRequirementDraftHash: snapshot.requirementDraft.draftHash,
    expectedResolutionHash: resolution.resolutionHash,
    libraryImportDraftId: importDraft.draftId,
  });
  return persisted;
}

export async function persistGoalValidationResolutionPg(
  db: SouthstarDb,
  input: {
    draftId: string;
    expectedGoalContractHash: string;
    expectedGoalRequirementDraftHash: string;
    resolution: GoalValidationResolutionV2;
    actor?: string;
  },
): Promise<GoalValidationLifecycleResult> {
  return await db.tx(async (tx) => {
    const row = await loadGoalValidationPlannerRowTx(tx, input.draftId);
    const snapshot = goalValidationSourceFromRow(row);
    if (snapshot.goalContractHash !== input.expectedGoalContractHash) throw new Error(`goal_contract_stale: ${input.draftId}`);
    if (snapshot.requirementDraft.draftHash !== input.expectedGoalRequirementDraftHash) {
      throw new Error(`goal_requirement_draft_stale: ${input.draftId}`);
    }
    assertGoalValidationResolutionMatches(snapshot, input.resolution);
    const currentPhase = requiredGoalDesignPhase(row.payload_json, input.draftId);
    if (!["validation_resolving", "library_review", "validation_ready"].includes(currentPhase)) {
      throw new Error(`goal validation cannot be resolved in phase ${currentPhase}: ${input.draftId}`);
    }
    await assertFrozenValidationLibraryBindingsTx(tx, input.resolution);
    const ready = goalValidationResolutionReady(input.resolution);
    const phase = ready ? "validation_ready" as const : "library_review" as const;
    const revisionKey = `${input.draftId}:${input.resolution.resolutionHash}`;
    const revision = await insertRuntimeResourceIfAbsentPg(tx, {
      resourceType: "goal_validation_resolution_revision",
      resourceKey: revisionKey,
      scope: "planner",
      status: ready ? "ready" : "gaps",
      title: `Goal Validation Resolution ${input.resolution.resolutionHash.slice(0, 12)}`,
      payload: {
        draftId: input.draftId,
        goalContractHash: snapshot.goalContractHash,
        goalRequirementDraftHash: snapshot.requirementDraft.draftHash,
        resolution: input.resolution,
        ...(input.actor ? { actor: input.actor } : {}),
      },
      summary: {
        draftId: input.draftId,
        resolutionHash: input.resolution.resolutionHash,
        ready,
        bindingCount: input.resolution.bindings.length,
        gapCount: input.resolution.gaps.length,
      },
    });
    if (contentHashForPayload(asRecord(revision.payload).resolution) !== contentHashForPayload(input.resolution)) {
      throw new Error(`goal_validation_resolution_conflict: ${revisionKey}`);
    }
    for (const binding of input.resolution.bindings) {
      const stored = await insertRuntimeResourceIfAbsentPg(tx, {
        resourceType: "goal_requirement_validation_binding",
        resourceKey: `${revisionKey}:${binding.id}`,
        scope: "planner",
        status: "ready",
        title: `Validation binding ${binding.id}`,
        payload: {
          draftId: input.draftId,
          goalContractHash: snapshot.goalContractHash,
          goalRequirementDraftHash: snapshot.requirementDraft.draftHash,
          resolutionHash: input.resolution.resolutionHash,
          binding,
        },
        summary: { draftId: input.draftId, requirementId: binding.requirementId, resolutionHash: input.resolution.resolutionHash },
      });
      if (contentHashForPayload(asRecord(stored.payload).binding) !== contentHashForPayload(binding)) {
        throw new Error(`goal_validation_binding_conflict: ${stored.resourceKey}`);
      }
    }
    const existingResolutionHash = optionalString(asRecord(row.payload_json.goalValidationResolution).resolutionHash);
    const existingImportDraftId = existingResolutionHash === input.resolution.resolutionHash
      ? optionalString(row.payload_json.libraryImportDraftId)
      : undefined;
    const { libraryImportDraftId: _oldImportDraftId, ...payloadWithoutImportDraft } = row.payload_json;
    const { libraryImportDraftId: _oldSummaryImportDraftId, ...summaryWithoutImportDraft } = row.summary_json;
    await upsertRuntimeResourcePg(tx, {
      id: row.id,
      resourceType: "planner_draft",
      resourceKey: input.draftId,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      scope: row.scope,
      status: phase,
      ...(row.title ? { title: row.title } : {}),
      payload: {
        ...payloadWithoutImportDraft,
        goalDesignPhase: phase,
        goalValidationResolution: input.resolution,
        validationBindings: input.resolution.bindings,
        requirementValidationBindings: input.resolution.bindings,
        validationGaps: input.resolution.gaps,
        ...(existingImportDraftId ? { libraryImportDraftId: existingImportDraftId } : {}),
      },
      summary: {
        ...summaryWithoutImportDraft,
        status: phase,
        goalDesignPhase: phase,
        goalValidationResolutionHash: input.resolution.resolutionHash,
        validationBindingCount: input.resolution.bindings.length,
        validationGapCount: input.resolution.gaps.length,
        ...(existingImportDraftId ? { libraryImportDraftId: existingImportDraftId } : {}),
      },
      metrics: row.metrics_json,
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    });
    return goalValidationLifecycleResult(snapshot, input.resolution, phase, existingImportDraftId);
  });
}

async function assertFrozenValidationLibraryBindingsTx(
  db: SouthstarDb,
  resolution: GoalValidationResolutionV2,
): Promise<void> {
  const refs = new Map<string, { objectKind: "artifact_contract" | "evaluator_profile"; versionRef: string }>();
  for (const binding of resolution.bindings) {
    for (const criterionBinding of binding.criterionBindings) {
      refs.set(criterionBinding.artifactContractRef, {
        objectKind: "artifact_contract",
        versionRef: criterionBinding.artifactContractVersionRef,
      });
      refs.set(criterionBinding.evaluatorProfileRef, {
        objectKind: "evaluator_profile",
        versionRef: criterionBinding.evaluatorProfileVersionRef,
      });
    }
  }
  for (const objectKey of [...refs.keys()].sort()) {
    const expected = refs.get(objectKey)!;
    const object = await findLibraryObjectByKeyForUpdate(db, objectKey);
    if (!object
      || object.objectKind !== expected.objectKind
      || object.status !== "approved"
      || object.headVersionId !== expected.versionRef) {
      const version = expected.versionRef.startsWith(`${objectKey}@`)
        ? expected.versionRef.slice(objectKey.length + 1)
        : expected.versionRef;
      throw new Error(`goal_validation_library_binding_stale: ${objectKey}@${version}`);
    }
  }
}

export async function resumeGoalValidationAfterLibraryImportPg(
  db: SouthstarDb,
  input: {
    libraryImportDraftId: string;
    resolver?: GoalValidationResolver;
    libraryImportLlmProvider?: LibraryImportLlmProvider;
    libraryImportSourceFetcher?: LibraryImportSourceFetcher;
    actor?: string;
  },
): Promise<GoalValidationLifecycleResult> {
  await assertGoalValidationImportCurrentPg(db, input.libraryImportDraftId, {
    allowInstalledContractReconciliation: true,
  });
  const importDraft = await getResourceByKeyPg(db, "library_import_draft", input.libraryImportDraftId);
  if (!importDraft || importDraft.status !== "installed") {
    throw new GoalValidationImportStaleError(input.libraryImportDraftId, `linked import is ${importDraft?.status ?? "missing"}`);
  }
  const payload = asRecord(importDraft.payload);
  const originGoalDraftId = requiredString(payload.originGoalDraftId, "originGoalDraftId", input.libraryImportDraftId);
  const originGoalContractHash = requiredString(payload.originGoalContractHash, "originGoalContractHash", input.libraryImportDraftId);
  const originGoalRequirementDraftHash = requiredString(payload.originGoalRequirementDraftHash, "originGoalRequirementDraftHash", input.libraryImportDraftId);
  const source = await loadGoalValidationSourcePg(db, originGoalDraftId).catch((error) => {
    throw new GoalValidationImportStaleError(input.libraryImportDraftId, error instanceof Error ? error.message : String(error));
  });
  const installedContractReconciliation = importDraft.status === "installed"
    && source.requirementDraft.draftHash === originGoalRequirementDraftHash
    && source.phase !== "requirements_review";
  if ((source.goalContractHash !== originGoalContractHash && !installedContractReconciliation)
    || source.requirementDraft.draftHash !== originGoalRequirementDraftHash
    || (source.phase !== "library_review" && !installedContractReconciliation)) {
    throw new GoalValidationImportStaleError(input.libraryImportDraftId, "the Goal Contract, Requirement revision, or phase no longer matches the import origin");
  }
  const { confirmGoalRequirementsPg } = await import("./goal-design-draft-service.ts");
  const confirmed = await confirmGoalRequirementsPg(db, {
    draftId: originGoalDraftId,
    expectedDraftHash: source.requirementDraft.draftHash,
    actor: input.actor,
    goalContractMetadata: {
      domain: source.goalContract.domain,
      intent: source.goalContract.intent,
      workType: source.goalContract.workType,
      expectedArtifactRefs: [...source.goalContract.expectedArtifactRefs],
      requiredCapabilities: [...source.goalContract.requiredCapabilities],
      assumptions: [...source.goalContract.assumptions],
      requestedSideEffects: [...source.goalContract.requestedSideEffects],
    },
  });
  const result = input.resolver
    ? await resolveAndPersistGoalValidationPg(db, {
      draftId: originGoalDraftId,
      expectedGoalContractHash: confirmed.goalContractHash ?? originGoalContractHash,
      resolver: input.resolver,
      libraryImportLlmProvider: input.libraryImportLlmProvider,
      libraryImportSourceFetcher: input.libraryImportSourceFetcher,
      actor: input.actor,
    })
    : await resolveInstalledGoalValidationPg({
      db,
      draftId: originGoalDraftId,
      expectedGoalContractHash: confirmed.goalContractHash ?? originGoalContractHash,
      importDraftId: input.libraryImportDraftId,
      actor: input.actor,
    });
  if (result.goalContractHash !== originGoalContractHash
    || result.goalValidationResolution.resolutionHash !== requiredString(payload.originGoalValidationResolutionHash, "originGoalValidationResolutionHash", input.libraryImportDraftId)) {
    const nextOrigin = JSON.stringify({
      originGoalContractHash: result.goalContractHash,
      originGoalRequirementDraftHash: result.goalRequirementDraftHash,
      originGoalValidationResolutionHash: result.goalValidationResolution.resolutionHash,
      originGoalValidationGapHash: contentHashForPayload(result.goalValidationResolution.gaps),
    });
    await db.query(
      `update southstar.runtime_resources
          set payload_json = payload_json || $2::jsonb,
              summary_json = summary_json || $2::jsonb,
              updated_at = now()
        where resource_type = 'library_import_draft' and resource_key = $1`,
      [input.libraryImportDraftId, nextOrigin],
    );
  }
  await upsertRuntimeResourcePg(db, {
    resourceType: "goal_validation_resume",
    resourceKey: input.libraryImportDraftId,
    scope: "planner",
    status: result.status,
    title: "Goal Validation Resumed",
    payload: {
      libraryImportDraftId: input.libraryImportDraftId,
      originGoalDraftId,
      originGoalContractHash: result.goalContractHash,
      originGoalRequirementDraftHash: result.goalRequirementDraftHash,
      resolutionHash: result.goalValidationResolution.resolutionHash,
      goalDesignPhase: result.phase,
      ...(result.libraryImportDraftId ? { followUpLibraryImportDraftId: result.libraryImportDraftId } : {}),
    },
    summary: { draftId: originGoalDraftId, resolutionHash: result.goalValidationResolution.resolutionHash, goalDesignPhase: result.phase },
  });
  return result;
}

/**
 * A reviewed Library proposal has already been semantically ranked and then
 * checked by the proposal validator before installation.  Re-running the
 * full LLM ranker after the files are committed adds latency and can turn a
 * successful install into a timeout.  Re-resolve against the now-approved
 * graph using the proposal's explicit coverage targets, while preserving the
 * bindings that were already valid before the import.
 */
async function resolveInstalledGoalValidationPg(input: {
  db: SouthstarDb;
  draftId: string;
  expectedGoalContractHash: string;
  importDraftId: string;
  actor?: string;
}): Promise<GoalValidationLifecycleResult> {
  const source = await loadGoalValidationSourcePg(input.db, input.draftId);
  if (source.goalContractHash !== input.expectedGoalContractHash) {
    throw new Error(`goal_contract_stale: ${input.draftId}`);
  }
  const planner = await getResourceByKeyPg(input.db, "planner_draft", input.draftId);
  const priorResolution = asRecord(asRecord(planner?.payload).goalValidationResolution) as unknown as GoalValidationResolutionV2;
  if (!priorResolution || !Array.isArray(priorResolution.gaps) || !Array.isArray(priorResolution.bindings)) {
    throw new Error(`goal_validation_resolution_missing: ${input.draftId}`);
  }
  const importDraft = await loadLibraryImportCandidateDraft(input.db, input.importDraftId, { allowInstalled: true });
  // The imported proposal is the host-validated binding for this Goal. Its
  // artifact/evaluator objects may deliberately live in different Library
  // scopes (for example `product` and `testing`) while their validation edge
  // carries the relationship. The approved graph is therefore read without
  // filtering by the Goal display domain; proposal coverage targets still
  // constrain the result to objects the user approved.
  const candidates = await resolveApprovedValidationCandidates(input.db);
  const unresolvedRequirementIds = new Set(priorResolution.gaps.map((gap) => gap.requirementId));
  const priorBindings = new Map(priorResolution.bindings.map((binding) => [binding.requirementId, binding]));

  const resolution = await resolveGoalValidationWithCandidates({
    goalContract: source.goalContract,
    requirementDraft: source.requirementDraft,
    scope: source.goalContract.domain,
    ranker: (rankInput) => {
      if (unresolvedRequirementIds.has(rankInput.contractRequirement.id)) {
        return rankGoalValidationCandidatesFromProposal({
          rankInput,
          coverageTargets: importDraft.candidateCoverageTargets,
        });
      }
      const binding = priorBindings.get(rankInput.contractRequirement.id);
      const criterionId = rankInput.contractRequirement.acceptanceCriteria[0]?.id;
      const criterionBinding = binding?.criterionBindings.find((item) => item.criterionContract.id === criterionId);
      if (!criterionBinding) return [];
      const recommendation: GoalValidationCandidateRecommendationV1 = {
        artifactRef: criterionBinding.artifactContractRef,
        evaluatorRef: criterionBinding.evaluatorProfileRef,
        verificationMode: criterionBinding.verificationMode,
        procedureRef: criterionBinding.procedureRef,
        expectedEvidenceKinds: criterionBinding.expectedEvidenceKinds,
        artifactVersionRef: criterionBinding.artifactContractVersionRef,
        evaluatorVersionRef: criterionBinding.evaluatorProfileVersionRef,
        reason: "Previously validated binding retained after Library import.",
      };
      return recommendation;
    },
  }, candidates);
  return await persistGoalValidationResolutionPg(input.db, {
    draftId: input.draftId,
    expectedGoalContractHash: input.expectedGoalContractHash,
    expectedGoalRequirementDraftHash: source.requirementDraft.draftHash,
    resolution,
    actor: input.actor,
  });
}

type GoalValidationSource = {
  draftId: string;
  phase: string;
  goalContract: GoalContractV1;
  goalContractHash: string;
  requirementDraft: GoalRequirementDraftV1;
};

async function loadGoalValidationPlannerRowTx(db: SouthstarDb, draftId: string): Promise<PlannerDraftResourceRow> {
  const row = await db.maybeOne<PlannerDraftResourceRow>(
    `select id, resource_key, run_id, task_id, session_id, scope, status, title,
            payload_json, summary_json, metrics_json, expires_at
       from southstar.runtime_resources
      where resource_type = 'planner_draft' and resource_key = $1
      for update`,
    [draftId],
  );
  if (!row) throw new Error(`planner draft not found: ${draftId}`);
  return row;
}

async function loadGoalValidationSourcePg(db: SouthstarDb, draftId: string): Promise<GoalValidationSource> {
  const row = await db.maybeOne<PlannerDraftResourceRow>(
    `select id, resource_key, run_id, task_id, session_id, scope, status, title,
            payload_json, summary_json, metrics_json, expires_at
       from southstar.runtime_resources
      where resource_type = 'planner_draft' and resource_key = $1`,
    [draftId],
  );
  if (!row) throw new Error(`planner draft not found: ${draftId}`);
  return goalValidationSourceFromRow(row);
}

function goalValidationSourceFromRow(row: PlannerDraftResourceRow): GoalValidationSource {
  const goalContract = storedGoalContract(row.payload_json.goalContract);
  const requirementDraft = goalRequirementDraftFromStored(row.payload_json.goalRequirementDraft);
  if (!goalContract) throw new Error(`confirmed Goal Contract not found: ${row.resource_key}`);
  if (!requirementDraft) throw new Error(`Goal Requirement draft not found: ${row.resource_key}`);
  const computedContractHash = goalContractHash(goalContract);
  if (optionalString(row.payload_json.goalContractHash) !== computedContractHash) throw new Error(`goal_contract_stale: ${row.resource_key}`);
  if (optionalString(row.payload_json.goalRequirementDraftHash) !== requirementDraft.draftHash) {
    throw new Error(`goal_requirement_draft_stale: ${row.resource_key}`);
  }
  return {
    draftId: row.resource_key,
    phase: requiredGoalDesignPhase(row.payload_json, row.resource_key),
    goalContract,
    goalContractHash: computedContractHash,
    requirementDraft,
  };
}

function goalRequirementDraftFromStored(value: unknown): GoalRequirementDraftV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const draft = value as GoalRequirementDraftV1;
  return validateGoalRequirementDraft(draft).length === 0 ? draft : undefined;
}

function goalDesignPhaseFromPayload(payload: Record<string, unknown>): string | undefined {
  return optionalString(payload.goalDesignPhase);
}

function requiredGoalDesignPhase(payload: Record<string, unknown>, draftId: string): string {
  const phase = goalDesignPhaseFromPayload(payload);
  if (!phase) throw new Error(`goal_design_phase_missing: ${draftId}`);
  return phase;
}

function assertGoalValidationResolutionMatches(source: GoalValidationSource, resolution: GoalValidationResolutionV2): void {
  const invalid = (reason: string): never => {
    throw new Error(`goal_validation_resolution_invalid: ${source.draftId}: ${reason}`);
  };
  if (resolution.schemaVersion !== "southstar.goal_validation_resolution.v2") invalid("unsupported schemaVersion");
  if (!Array.isArray(resolution.previews) || !Array.isArray(resolution.bindings) || !Array.isArray(resolution.gaps)) {
    invalid("previews, bindings, and gaps must be arrays");
  }
  if (resolution.goalContractHash !== source.goalContractHash) throw new Error(`goal_validation_contract_hash_mismatch: ${source.draftId}`);
  if (resolution.requirementDraftHash !== source.requirementDraft.draftHash) {
    throw new Error(`goal_validation_requirement_hash_mismatch: ${source.draftId}`);
  }
  const { resolutionHash, ...withoutHash } = resolution;
  if (contentHashForPayload(withoutHash) !== resolutionHash) throw new Error(`goal_validation_resolution_hash_invalid: ${source.draftId}`);

  const requirementsById = new Map(source.goalContract.requirements.map((requirement) => [requirement.id, requirement]));
  const bindingCountByRequirement = new Map<string, number>();
  const boundCriterionIds = new Set<string>();
  const boundCheckKeys = new Set<string>();
  const coveredAssurances = new Map<string, Set<string>>();
  const bindingIds = new Set<string>();
  for (const binding of resolution.bindings) {
    if (binding.schemaVersion !== "southstar.requirement_validation_binding.v3") invalid(`binding ${binding.id} has an unsupported schemaVersion`);
    if (bindingIds.has(binding.id)) invalid(`duplicate binding id ${binding.id}`);
    bindingIds.add(binding.id);
    const requirement = requirementsById.get(binding.requirementId)
      ?? invalid(`binding ${binding.id} references unknown requirement ${binding.requirementId}`);
    bindingCountByRequirement.set(binding.requirementId, (bindingCountByRequirement.get(binding.requirementId) ?? 0) + 1);
    if (!Array.isArray(binding.criterionBindings) || binding.criterionBindings.length === 0) {
      invalid(`binding ${binding.id} has no Criterion bindings`);
    }
    const expectedCriteria = new Map(requirement.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
    for (const criterionBinding of binding.criterionBindings) {
      const criterion = criterionBinding.criterionContract;
      const expected = expectedCriteria.get(criterion.id);
      if (!expected || contentHashForPayload(expected) !== contentHashForPayload(criterion)) {
        invalid(`binding ${binding.id} changed confirmed Criterion ${criterion.id}`);
      }
      const checkKey = criterionValidationCheckKey(criterion.id, criterionBinding.verificationMode);
      if (boundCheckKeys.has(checkKey)) invalid(`Criterion check ${checkKey} has multiple validation bindings`);
      boundCheckKeys.add(checkKey);
      if (criterion.requiredAssurance.length !== 1
        || new Set(criterion.requiredAssurance).size !== criterion.requiredAssurance.length
        || criterion.requiredAssurance[0] !== criterionBinding.verificationMode) {
        invalid(`binding ${binding.id} does not preserve assurance for Criterion ${criterion.id}`);
      }
      boundCriterionIds.add(criterion.id);
      const assuranceCoverage = coveredAssurances.get(criterion.id) ?? new Set<string>();
      assuranceCoverage.add(criterionBinding.verificationMode);
      coveredAssurances.set(criterion.id, assuranceCoverage);
    }
  }
  if ([...bindingCountByRequirement.values()].some((count) => count > 1)) invalid("a requirement has multiple validation bindings");
  const blockingCriteriaBound = source.goalContract.requirements
    .flatMap((requirement) => requirement.acceptanceCriteria)
    .filter((criterion) => criterion.blocking)
    .every((criterion) => criterion.requiredAssurance.length === 1
      && boundCriterionIds.has(criterion.id)
      && coveredAssurances.get(criterion.id)?.has(criterion.requiredAssurance[0]!));
  const derivedReady = !resolution.gaps.some((gap) => gap.blocking) && blockingCriteriaBound;
  if (resolution.ready !== derivedReady) invalid("ready does not match blocking gaps and canonical bindings");
}

async function attachGoalValidationImportDraftPg(
  db: SouthstarDb,
  input: {
    draftId: string;
    expectedGoalContractHash: string;
    expectedGoalRequirementDraftHash: string;
    expectedResolutionHash: string;
    libraryImportDraftId: string;
  },
): Promise<GoalValidationLifecycleResult> {
  const attached = await db.tx(async (tx) => {
    const row = await loadGoalValidationPlannerRowTx(tx, input.draftId);
    const source = goalValidationSourceFromRow(row);
    const resolution = row.payload_json.goalValidationResolution as GoalValidationResolutionV2 | undefined;
    if (source.goalContractHash !== input.expectedGoalContractHash
      || source.requirementDraft.draftHash !== input.expectedGoalRequirementDraftHash
      || !resolution || resolution.resolutionHash !== input.expectedResolutionHash || source.phase !== "library_review") return undefined;
    await upsertRuntimeResourcePg(tx, {
      id: row.id,
      resourceType: "planner_draft",
      resourceKey: input.draftId,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      scope: row.scope,
      status: "library_review",
      ...(row.title ? { title: row.title } : {}),
      payload: { ...row.payload_json, libraryImportDraftId: input.libraryImportDraftId },
      summary: { ...row.summary_json, libraryImportDraftId: input.libraryImportDraftId },
      metrics: row.metrics_json,
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    });
    return goalValidationLifecycleResult(source, resolution, "library_review", input.libraryImportDraftId);
  });
  if (attached) return attached;
  const stale = JSON.stringify({ staleReason: "goal_validation_source_changed", staleAt: new Date().toISOString() });
  await db.query(
    `update southstar.runtime_resources
        set status = 'stale', payload_json = payload_json || $2::jsonb,
            summary_json = summary_json || $2::jsonb, updated_at = now()
      where resource_type = 'library_import_draft' and resource_key = $1 and status = 'draft'`,
    [input.libraryImportDraftId, stale],
  );
  throw new GoalValidationImportStaleError(input.libraryImportDraftId, "Goal validation changed before the import draft was linked");
}

function goalValidationLifecycleResult(
  source: GoalValidationSource,
  resolution: GoalValidationResolutionV2,
  phase: "library_review" | "validation_ready",
  libraryImportDraftId?: string,
): GoalValidationLifecycleResult {
  return {
    draftId: source.draftId,
    goalRequirementDraftId: source.draftId,
    status: phase,
    phase,
    goalPrompt: source.requirementDraft.originalPrompt,
    goalRequirementDraft: source.requirementDraft,
    goalRequirementDraftHash: source.requirementDraft.draftHash,
    confirmable: false,
    validationIssues: [],
    goalContract: source.goalContract,
    goalContractHash: source.goalContractHash,
    blockers: source.requirementDraft.blockingInputs,
    goalValidationResolution: resolution,
    validationBindings: resolution.bindings,
    validationGaps: resolution.gaps,
    ...(libraryImportDraftId ? { libraryImportDraftId } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, field: string, owner: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is missing from ${owner}`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
