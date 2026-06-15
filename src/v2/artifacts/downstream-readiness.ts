import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import {
  DOWNSTREAM_READINESS_SCHEMA_VERSION,
  type DownstreamReadiness,
} from "./types.ts";

export type DownstreamDependencyRequirement = {
  taskId: string;
  artifactContractRefs: string[];
  workspaceStateRequired: boolean;
};

export function computeDownstreamReadiness(db: SouthstarDb, input: {
  runId: string;
  taskId: string;
  dependencies: DownstreamDependencyRequirement[];
  now?: string;
}): DownstreamReadiness {
  const acceptedArtifacts = listResources(db, { resourceType: "artifact", status: "accepted" })
    .filter((resource) => resource.runId === input.runId);

  const blockers = input.dependencies.map((dependency) => {
    const contracts = new Set(acceptedArtifacts
      .filter((resource) => resource.taskId === dependency.taskId)
      .map((resource) => contractRefFromSummary(resource.summary))
      .filter((value): value is string => typeof value === "string"));

    const missingArtifactContractRefs = dependency.artifactContractRefs
      .filter((contractRef) => !contracts.has(contractRef));

    const workspaceReady = dependency.workspaceStateRequired
      ? hasWorkspaceState(db, input.runId, dependency.taskId)
      : true;

    return {
      dependencyTaskId: dependency.taskId,
      missingArtifactContractRefs,
      missingEvidenceKinds: [],
      workspaceStateRequired: dependency.workspaceStateRequired,
      workspaceReady,
    };
  }).filter((blocker) => blocker.missingArtifactContractRefs.length > 0 || !blocker.workspaceReady);

  const readiness: DownstreamReadiness = {
    schemaVersion: DOWNSTREAM_READINESS_SCHEMA_VERSION,
    runId: input.runId,
    taskId: input.taskId,
    ready: blockers.length === 0,
    blockers,
    checkedAt: input.now ?? new Date().toISOString(),
  };

  upsertRuntimeResource(db, {
    id: `downstream-readiness-${input.runId}-${input.taskId}`,
    resourceType: "downstream_readiness",
    resourceKey: `downstream-readiness-${input.runId}-${input.taskId}`,
    runId: input.runId,
    taskId: input.taskId,
    scope: "workflow",
    status: readiness.ready ? "ready" : "blocked",
    title: `Downstream readiness for ${input.taskId}`,
    payload: readiness,
    summary: { ready: readiness.ready, blockerCount: readiness.blockers.length },
  });

  return readiness;
}

function contractRefFromSummary(summary: unknown): string | undefined {
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) return undefined;
  const value = (summary as { contractRef?: unknown }).contractRef;
  return typeof value === "string" ? value : undefined;
}

function hasWorkspaceState(db: SouthstarDb, runId: string, taskId: string): boolean {
  return listResources(db, { resourceType: "workspace_snapshot" })
    .some((resource) => resource.runId === runId && resource.taskId === taskId);
}
