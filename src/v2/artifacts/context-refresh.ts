import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export type RefreshedContextSummary = {
  text: string;
  artifactRefs: string[];
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
};

export function buildRefreshedContextSummary(db: SouthstarDb, input: {
  runId: string;
  taskId: string;
  dependencyTaskIds: string[];
}): RefreshedContextSummary {
  const dependencies = new Set(input.dependencyTaskIds);
  const acceptedArtifacts = listResources(db, { resourceType: "artifact", status: "accepted" })
    .filter((resource) => resource.runId === input.runId && resource.taskId && dependencies.has(resource.taskId));

  const summaries = acceptedArtifacts.map((resource) => {
    const summary = artifactSummary(resource.summary);
    return {
      artifactRef: resource.id,
      text: summary.summary ?? resource.title ?? resource.id,
      evidencePacketRefs: summary.evidencePacketRefs,
      validatorResultRefs: summary.validatorResultRefs,
    };
  });

  return {
    text: summaries
      .map((summary) => `Accepted upstream artifact ${summary.artifactRef}: ${summary.text}`)
      .join("\n"),
    artifactRefs: summaries.map((summary) => summary.artifactRef),
    evidencePacketRefs: summaries.flatMap((summary) => summary.evidencePacketRefs),
    validatorResultRefs: summaries.flatMap((summary) => summary.validatorResultRefs),
  };
}

function artifactSummary(value: unknown): {
  summary?: string;
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { evidencePacketRefs: [], validatorResultRefs: [] };
  }
  const summary = typeof (value as { summary?: unknown }).summary === "string"
    ? (value as { summary: string }).summary
    : undefined;
  return {
    summary,
    evidencePacketRefs: toStringArray((value as { evidencePacketRefs?: unknown }).evidencePacketRefs),
    validatorResultRefs: toStringArray((value as { validatorResultRefs?: unknown }).validatorResultRefs),
  };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
