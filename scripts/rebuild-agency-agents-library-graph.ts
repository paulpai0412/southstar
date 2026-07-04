import { join } from "node:path";
import { openSouthstarDb } from "../src/v2/db/postgres.ts";
import { createGithubLibraryImportSourceFetcher } from "../src/v2/design-library/importers/library-source-fetcher.ts";
import {
  createLibraryImportDraft,
  LIBRARY_IMPORT_DRAFT_SCHEMA_VERSION,
} from "../src/v2/design-library/importers/library-import-draft-store.ts";
import { analyzeLibraryImportOntologyWithLlm, type LibraryImportLlmProvider } from "../src/v2/design-library/importers/library-llm-import-analyzer.ts";
import { listLibraryFiles, syncLibraryFileToGraph } from "../src/v2/design-library/files/library-file-store.ts";
import { upsertLibraryEdge } from "../src/v2/design-library/library-graph-store.ts";
import { createPiSdkPlannerClient } from "../src/v2/planner/pi-planner.ts";
import { upsertRuntimeResourcePg } from "../src/v2/stores/postgres-runtime-store.ts";

const databaseUrl = process.env.SOUTHSTAR_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/southstar";
const libraryRoot = process.env.SOUTHSTAR_LIBRARY_ROOT ?? join(process.cwd(), "library");
const repoUrl = process.env.SOUTHSTAR_AGENCY_AGENTS_REPO_URL ?? "https://github.com/jnMetaCode/agency-agents-zh";

const db = await openSouthstarDb(databaseUrl);

const llmProvider: LibraryImportLlmProvider = async ({ prompt, sourceRepoPath }) => (
  await createPiSdkPlannerClient({
    cwd: sourceRepoPath ?? process.cwd(),
    noTools: sourceRepoPath ? null : "all",
    timeoutMs: 600_000,
  }).generate(prompt)
);

try {
  const draft = await createLibraryImportDraft(db, {
    source: { kind: "github", repoUrl },
    scope: "all",
    requestPrompt: [
      "Import every agent from this repository.",
      "Use the repository CATALOG department taxonomy as the canonical Southstar domain list.",
      "Return candidates for agent, skill, MCP, and tool content only when it exists.",
    ].join("\n"),
    sourceFetcher: createGithubLibraryImportSourceFetcher(),
    llmProvider,
  });
  const candidates = draft.candidates ?? [];
  if (candidates.length < 200) {
    throw new Error(`LLM import returned too few candidates for agency-agents-zh: ${candidates.length}`);
  }

  const importedAgentRows = await db.query<{ object_key: string }>(
    `select object_key
       from southstar.library_objects
      where object_kind = 'agent_definition'
        and state_json ? 'importSourcePath'
      order by object_key`,
  );
  const importedAgentKeys = importedAgentRows.rows.map((row) => row.object_key);

  await db.tx(async (tx) => {
    if (importedAgentKeys.length > 0) {
      await tx.query(
        `delete from southstar.library_edges
          where from_object_key = any($1::text[])
             or to_object_key = any($1::text[])`,
        [importedAgentKeys],
      );
      await tx.query(
        `delete from southstar.library_objects
          where object_key = any($1::text[])`,
        [importedAgentKeys],
      );
    }
  });

  const files = await listLibraryFiles({ root: libraryRoot });
  const syncedObjectScopes = new Map<string, string>();
  let syncedFiles = 0;
  let structuralEdges = 0;
  for (const file of files) {
    const synced = await syncLibraryFileToGraph(db, { root: libraryRoot, relativePath: file.relativePath });
    syncedFiles += 1;
    structuralEdges += synced.edges.length;
    const scope = synced.object.state.scope;
    if (typeof scope === "string" && scope.length > 0) {
      syncedObjectScopes.set(synced.object.objectKey, scope);
    }
  }

  const existingObjectKeys = new Set(syncedObjectScopes.keys());
  const selectedCandidates = candidates.filter((candidate) => existingObjectKeys.has(candidate.objectKey));
  const generatedEdges = await analyzeLibraryImportOntologyWithLlm({
    candidates: selectedCandidates,
    scope: "all",
    llmProvider,
    requestPrompt: "Regenerate ontology edges for the selected imported agents after rebuilding the Southstar library graph.",
  });

  const installedEdges = [];
  for (const edge of generatedEdges) {
    if (!existingObjectKeys.has(edge.fromObjectKey) || !existingObjectKeys.has(edge.toObjectKey)) continue;
    installedEdges.push(await upsertLibraryEdge(db, {
      fromObjectKey: edge.fromObjectKey,
      edgeType: edge.edgeType,
      toObjectKey: edge.toObjectKey,
      scope: syncedObjectScopes.get(edge.fromObjectKey) ?? "global",
      status: "active",
      weight: edge.confidence,
      metadata: {
        source: "library-import-candidate",
        sourceKind: "llm-rebuild",
        draftId: draft.draftId,
        confidence: edge.confidence,
        ...(edge.rationale ? { rationale: edge.rationale } : {}),
      },
    }));
  }

  await upsertRuntimeResourcePg(db, {
    resourceType: "library_import_draft",
    resourceKey: draft.draftId,
    scope: "library",
    status: "installed",
    payload: {
      schemaVersion: LIBRARY_IMPORT_DRAFT_SCHEMA_VERSION,
      source: { kind: "github", repoUrl },
      requestPrompt: "Rebuilt agency-agents-zh library graph with LLM-generated ontology edges.",
      candidates,
      proposedEdges: generatedEdges,
      proposal: draft.proposal,
      install: {
        actor: "operator",
        reason: "rebuilt from local library files with LLM ontology sync",
        installedAt: new Date().toISOString(),
        installedObjectKeys: [...existingObjectKeys].sort(),
        installedEdges,
        generatedOntologyAt: new Date().toISOString(),
      },
    },
  });

  console.log(JSON.stringify({
    repoUrl,
    libraryRoot,
    clearedAgents: importedAgentKeys.length,
    draftId: draft.draftId,
    llmCandidates: candidates.length,
    selectedCandidates: selectedCandidates.length,
    syncedFiles,
    structuralEdges,
    llmEdgesGenerated: generatedEdges.length,
    llmEdgesInstalled: installedEdges.length,
  }, null, 2));
} finally {
  await db.close();
}
