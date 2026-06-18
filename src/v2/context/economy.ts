import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { PlannerRisk, ReleaseMode, RequirementSpec } from "../planner/library-aware-types.ts";

export type RunBriefInput = {
  runId: string;
  requirementSpec: RequirementSpec;
  selectedTemplateRefs: string[];
  selectedAgentRefs: string[];
  risk: PlannerRisk;
  releaseMode: ReleaseMode;
};

export type RepoFactCacheInput = {
  runId: string;
  repoPath?: string;
  facts: {
    packageManager?: string;
    testCommand?: string;
    framework?: string;
    relevantFiles?: string[];
    docsPaths?: string[];
    localPreviewCommand?: string;
  };
};

export type ArtifactSummaryInput = {
  runId: string;
  taskId: string;
  artifactRef: string;
  summary: string;
  evidenceRefs: string[];
  validatorRefs: string[];
  riskNotes: string[];
};

export type ContextSourceSummary = {
  text: string;
  sources: Array<{ kind: "run_brief" | "repo_fact_cache" | "artifact_summary"; resourceKey: string; sourceRef?: string; summary: string }>;
  artifactSummaryRefs: string[];
};

export function createRunBrief(db: SouthstarDb, input: RunBriefInput) {
  const resourceKey = `run-brief-${input.runId}`;
  const summary = `${input.requirementSpec.summary}\nTemplates: ${input.selectedTemplateRefs.join(", ")}\nAgents: ${input.selectedAgentRefs.join(", ")}\nRisk: ${input.risk}\nRelease: ${input.releaseMode}`;
  upsertRuntimeResource(db, {
    id: resourceKey,
    resourceType: "run_brief",
    resourceKey,
    runId: input.runId,
    scope: "workflow",
    status: "created",
    title: "Run Brief",
    payload: { ...input, summary },
    summary: { text: summary, selectedTemplateCount: input.selectedTemplateRefs.length, selectedAgentCount: input.selectedAgentRefs.length },
  });
  return { resourceKey, summary };
}

export function createRepoFactCache(db: SouthstarDb, input: RepoFactCacheInput) {
  const resourceKey = `repo-fact-cache-${input.runId}`;
  const summary = [
    input.repoPath ? `Repo: ${input.repoPath}` : "Repo: unknown",
    input.facts.packageManager ? `Package manager: ${input.facts.packageManager}` : undefined,
    input.facts.testCommand ? `Test command: ${input.facts.testCommand}` : undefined,
    input.facts.framework ? `Framework: ${input.facts.framework}` : undefined,
    input.facts.localPreviewCommand ? `Local preview: ${input.facts.localPreviewCommand}` : undefined,
    input.facts.relevantFiles?.length ? `Relevant files: ${input.facts.relevantFiles.join(", ")}` : undefined,
  ].filter(Boolean).join("\n");
  upsertRuntimeResource(db, {
    id: resourceKey,
    resourceType: "repo_fact_cache",
    resourceKey,
    runId: input.runId,
    scope: "workspace",
    status: "created",
    title: "Repo Fact Cache",
    payload: { ...input, summary },
    summary: { text: summary, repoPath: input.repoPath },
  });
  return { resourceKey, summary };
}

export function createArtifactSummary(db: SouthstarDb, input: ArtifactSummaryInput) {
  const resourceKey = `artifact-summary-${input.runId}-${input.taskId}-${input.artifactRef}`;
  upsertRuntimeResource(db, {
    id: resourceKey,
    resourceType: "artifact_summary",
    resourceKey,
    runId: input.runId,
    taskId: input.taskId,
    scope: "artifact",
    status: "created",
    title: `Artifact Summary for ${input.taskId}`,
    payload: input,
    summary: { summary: input.summary, evidenceRefs: input.evidenceRefs, validatorRefs: input.validatorRefs, sourceArtifactRef: input.artifactRef },
  });
  return { resourceKey, summary: input.summary };
}

export function buildContextSourceSummary(db: SouthstarDb, input: { runId: string; taskId: string; dependencyTaskIds: string[] }): ContextSourceSummary {
  const dependencySet = new Set(input.dependencyTaskIds);
  const runBrief = listResources(db, { resourceType: "run_brief" }).find((resource) => resource.runId === input.runId);
  const repoFactCache = listResources(db, { resourceType: "repo_fact_cache" }).find((resource) => resource.runId === input.runId);
  const artifactSummaries = listResources(db, { resourceType: "artifact_summary" })
    .filter((resource) => resource.runId === input.runId && resource.taskId && dependencySet.has(resource.taskId));

  const sources: ContextSourceSummary["sources"] = [];
  if (runBrief) sources.push({ kind: "run_brief", resourceKey: runBrief.resourceKey, summary: textSummary(runBrief.summary, runBrief.payload) });
  if (repoFactCache) sources.push({ kind: "repo_fact_cache", resourceKey: repoFactCache.resourceKey, summary: textSummary(repoFactCache.summary, repoFactCache.payload) });
  for (const artifact of artifactSummaries) {
    const payload = artifact.payload as { artifactRef?: string; summary?: string };
    sources.push({ kind: "artifact_summary", resourceKey: artifact.resourceKey, sourceRef: payload.artifactRef, summary: payload.summary ?? textSummary(artifact.summary, artifact.payload) });
  }
  return {
    text: sources.map((source) => `${source.kind} ${source.resourceKey}: ${source.summary}`).join("\n"),
    sources,
    artifactSummaryRefs: artifactSummaries.map((resource) => resource.resourceKey).sort(),
  };
}

function textSummary(summary: unknown, payload: unknown): string {
  if (summary && typeof summary === "object" && !Array.isArray(summary) && typeof (summary as { text?: unknown }).text === "string") return (summary as { text: string }).text;
  if (summary && typeof summary === "object" && !Array.isArray(summary) && typeof (summary as { summary?: unknown }).summary === "string") return (summary as { summary: string }).summary;
  if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as { summary?: unknown }).summary === "string") return (payload as { summary: string }).summary;
  return JSON.stringify(payload ?? summary ?? {});
}
