import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SouthstarDb } from "../../db/postgres.ts";
import { parseLibraryFileContent } from "../files/library-file-parser.ts";
import {
  readLibraryFile,
  removeLibraryFileIfContentMatches,
  validateLibraryFileGraphReferences,
  writeLibraryFile,
  writeNewLibraryFile,
} from "../files/library-file-store.ts";
import type { LibraryFileRecord } from "../files/library-file-types.ts";
import {
  loadLibraryFileCatalog,
  reconcileLibraryCatalogPg,
  type LibraryReconcileResult,
} from "../files/library-reconcile-service.ts";
import type { LibraryGraphSyncResult } from "../files/library-file-store.ts";
import { upsertRuntimeResourcePg } from "../../stores/postgres-runtime-store.ts";
import type { LibraryImportProposal } from "./library-import-proposal.ts";
import {
  asImportSource,
  type LibraryImportSource,
} from "./library-import-extractor.ts";
import {
  fetchLibraryImportSourceSnapshot,
  type LibraryImportSourceDocument,
  type LibraryImportSourceFetcher,
} from "./library-source-fetcher.ts";
import {
  analyzeLibraryImportWithLlm,
  analyzeLibraryImportOntologyResultWithLlm,
  type LibraryImportOntologyExistingGraph,
  type LibraryImportLlmProvider,
} from "./library-llm-import-analyzer.ts";
import type {
  LibraryImportCandidate,
  LibraryImportCandidateKind,
  LibraryImportEdgeType,
  LibraryImportProposedEdge,
} from "./library-candidate-extractor.ts";
import { findLibraryObjectByKey, listLibraryEdges, listLibraryObjects, upsertLibraryEdge } from "../library-graph-store.ts";
import type { LibraryDefinitionKind, LibraryEdgeRecord, LibraryObjectSummary } from "../types.ts";

export const LIBRARY_IMPORT_DRAFT_RESOURCE_TYPE = "library_import_draft";
export const LIBRARY_IMPORT_DRAFT_SCHEMA_VERSION = "southstar.library.import_draft.v1";
const APPROVAL_LEASE_MS = 15 * 60 * 1000;

export type LibraryImportDraftResult = {
  draftId: string;
  status: "draft";
  proposal: LibraryImportProposal;
  documents?: LibraryImportSourceDocument[];
  candidates?: LibraryImportCandidate[];
  proposedEdges?: LibraryImportProposedEdge[];
  piSessionId?: string;
};

export type LibraryImportDraftApprovalResult = {
  draftId: string;
  status: "approved";
  proposal: LibraryImportProposal;
  files: Array<{ relativePath: string }>;
  synced: LibraryGraphSyncResult["results"];
  reconcile: LibraryReconcileResult;
  librarySnapshotHash: string;
};

export type LibraryImportCandidateInstallResult = {
  draftId: string;
  status: "installed";
  installedObjects: Array<{
    objectKey: string;
    kind: LibraryImportCandidateKind;
    relativePath: string;
    object: LibraryObjectSummary;
  }>;
  installedEdges: LibraryEdgeRecord[];
  graph: {
    objectKeys: string[];
    edgeIds: string[];
  };
  piSessionId?: string;
};

type LibraryImportDraftApplyReservation = {
  kind: "apply";
  resourceId: string;
  title: string;
  payload: Record<string, unknown>;
  summary: Record<string, unknown>;
  proposal: LibraryImportProposal;
  approval: { actor: string; reason: string; approvedAt: string };
  approvalLease: { attemptId: string; startedAt: string; expiresAt: string };
};

type PreflightedLibraryImportFile = {
  relativePath: string;
  content: string;
  file: LibraryFileRecord;
  existingFile?: boolean;
};

type SupportingLibraryImportFile = {
  relativePath: string;
  content: Buffer;
  existingFile?: boolean;
};

type LibraryImportFileSnapshot = {
  relativePath: string;
  content: string | Buffer;
};

export type LibraryImportProgressListener = (event: {
  event: string;
  data: Record<string, unknown>;
}) => void;

export async function createLibraryImportDraft(
  db: SouthstarDb,
  input: {
    source: LibraryImportSource;
    scope: string;
    sourceFetcher?: LibraryImportSourceFetcher;
    llmProvider?: LibraryImportLlmProvider;
    localRoot?: string;
    maxFiles?: number;
    maxBytes?: number;
    requestPrompt?: string;
    progress?: LibraryImportProgressListener;
  },
): Promise<LibraryImportDraftResult> {
  const source = asImportSource(input.source);
  input.progress?.({ event: "library.import.source.started", data: { sourceKind: source.kind } });
  const sourceSnapshot = await fetchLibraryImportSourceSnapshot({
    source,
    sourceFetcher: input.sourceFetcher,
    localRoot: input.localRoot,
    maxFiles: input.maxFiles,
    maxBytes: input.maxBytes,
  });
  const documents = sourceSnapshot.documents;
  input.progress?.({
    event: "library.import.source.completed",
    data: {
      sourceKind: source.kind,
      documentCount: documents.length,
      ...(sourceSnapshot.repoPath ? { sourceRepoPath: sourceSnapshot.repoPath } : {}),
    },
  });
  input.progress?.({ event: "library.import.candidates.started", data: { sourceKind: source.kind } });
  const analysis = await analyzeLibraryImportWithLlm({
    documents,
    scope: input.scope,
    llmProvider: input.llmProvider,
    requestPrompt: input.requestPrompt,
    sourceRepoPath: sourceSnapshot.repoPath,
  });
  input.progress?.({
    event: "library.import.candidates.completed",
    data: { candidateCount: analysis.candidates.length },
  });
  const draftId = `library-import-draft-${randomUUID()}`;
  const proposal = proposalFromCandidates(draftId, analysis.candidates);
  await upsertRuntimeResourcePg(db, {
    resourceType: LIBRARY_IMPORT_DRAFT_RESOURCE_TYPE,
    resourceKey: draftId,
    scope: "library",
    status: "draft",
    title: `Library import draft: ${proposal.objectKeys.join(", ") || "proposal"}`,
    payload: {
      schemaVersion: LIBRARY_IMPORT_DRAFT_SCHEMA_VERSION,
      draftId,
      status: "draft",
      source,
      scope: input.scope,
      ...(input.requestPrompt ? { requestPrompt: input.requestPrompt } : {}),
      ...(sourceSnapshot.repoPath ? { sourceRepoPath: sourceSnapshot.repoPath } : {}),
      proposal,
      documents,
      candidates: analysis.candidates,
      proposedEdges: analysis.proposedEdges,
      ...(analysis.piSessionId ? { piSessionId: analysis.piSessionId } : {}),
    },
    summary: {
      scope: input.scope,
      objectKeys: proposal.objectKeys,
      filePaths: proposal.files.map((file) => file.relativePath),
      candidateKeys: analysis.candidates.map((candidate) => candidate.objectKey),
      proposedEdgeCount: analysis.proposedEdges.length,
      ...(analysis.piSessionId ? { piSessionId: analysis.piSessionId } : {}),
      ...(sourceSnapshot.repoPath ? { sourceRepoPath: sourceSnapshot.repoPath } : {}),
    },
  });
  return {
    draftId,
    status: "draft",
    proposal,
    documents,
    candidates: analysis.candidates,
    proposedEdges: analysis.proposedEdges,
    ...(analysis.piSessionId ? { piSessionId: analysis.piSessionId } : {}),
  };
}

function proposalFromCandidates(draftId: string, candidates: LibraryImportCandidate[]): LibraryImportProposal {
  const files = candidates.map((candidate) => renderLibraryImportCandidate(draftId, candidate));
  return {
    files,
    objectKeys: candidates.map((candidate) => candidate.objectKey),
    objectSummaries: candidates.map((candidate, index) => ({
      objectKey: candidate.objectKey,
      objectKind: candidateObjectKind(candidate.kind),
      title: candidate.title,
      scope: candidate.scope,
      status: "draft",
      relativePath: files[index]?.relativePath ?? candidateRelativePath(candidate.kind, slugFromCandidate(candidate)),
    })),
    dependencies: [],
  };
}

function candidateObjectKind(kind: LibraryImportCandidateKind): string {
  if (kind === "agent") return "agent_definition";
  if (kind === "skill") return "skill_spec";
  if (kind === "tool") return "tool_definition";
  if (kind === "mcp") return "mcp_tool_grant";
  if (kind === "domain") return "domain_taxonomy";
  if (kind === "capability") return "capability_spec";
  if (kind === "artifact") return "artifact_contract";
  return "evaluator_profile";
}

export async function approveLibraryImportDraft(
  db: SouthstarDb,
  input: { root: string; draftId: string; actor: string; reason: string },
): Promise<LibraryImportDraftApprovalResult> {
  const reserved = await reserveLibraryImportDraftApproval(db, input);
  if (reserved.kind === "already-approved") return reserved.result;
  const createdFiles: Array<{ relativePath: string; content: string }> = [];

  try {
    const preflighted = await preflightLibraryImportProposal(db, { root: input.root, proposal: reserved.proposal });
    const files: Array<{ relativePath: string }> = [];
    for (const file of preflighted) {
      try {
        files.push(await writeNewLibraryFile({
          root: input.root,
          relativePath: file.relativePath,
          content: file.content,
        }));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`library import file already exists: ${file.relativePath}`);
        }
        throw error;
      }
      createdFiles.push({ relativePath: file.relativePath, content: file.content });
    }

    const applied = {
      files,
      objectKeys: reserved.proposal.objectKeys,
    };
    const catalog = await loadLibraryFileCatalog({ root: input.root });
    const importedKeys = new Set(preflighted.map((file) => file.file.objectKey));
    const { reconcile, synced } = await db.tx(async (tx) => {
      const { result: reconcile, graphSync } = await reconcileLibraryCatalogPg(tx, {
        catalog,
        root: input.root,
        trigger: "import_approval",
        rejectExistingObjectKeys: importedKeys,
      });
      const synced = graphSync.results.filter((item) => importedKeys.has(item.object.objectKey));
      const updated = await tx.query(
        `update southstar.runtime_resources
            set status = 'approved',
                title = $2,
                payload_json = $3::jsonb,
                summary_json = $4::jsonb,
                updated_at = now()
          where id = $1
            and status = 'applying'
            and payload_json->'approvalLease'->>'attemptId' = $5`,
        [
          reserved.resourceId,
          reserved.title,
          JSON.stringify({
            ...withoutTransientApplyState(reserved.payload),
            status: "approved",
            approval: reserved.approval,
            applied: {
              ...applied,
              reconcile,
              librarySnapshotHash: reconcile.snapshotHash,
              synced,
            },
          }),
          JSON.stringify({
            ...reserved.summary,
            status: "approved",
            approvedBy: reserved.approval.actor,
            objectKeys: reserved.proposal.objectKeys,
            filePaths: files.map((file) => file.relativePath),
          }),
          reserved.approvalLease.attemptId,
        ],
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw new Error(`library import draft approval lease was lost: ${input.draftId}`);
      }
      return {
        reconcile,
        synced,
      };
    });

    return {
      draftId: input.draftId,
      status: "approved",
      proposal: reserved.proposal,
      files,
      synced,
      reconcile,
      librarySnapshotHash: reconcile.snapshotHash,
    };
  } catch (error) {
    await cleanupCreatedImportFiles(input.root, createdFiles);
    await markLibraryImportDraftApplyFailed(db, reserved, error);
    throw error;
  }
}

export async function installLibraryImportCandidates(
  db: SouthstarDb,
  input: {
    root: string;
    draftId: string;
    selectedCandidateIds: string[];
    selectedEdgeIds?: string[];
    actor?: string;
    reason: string;
    llmProvider?: LibraryImportLlmProvider;
    progress?: LibraryImportProgressListener;
  },
): Promise<LibraryImportCandidateInstallResult> {
  const createdFiles: Array<{ relativePath: string; content: string | Buffer }> = [];
  const overwrittenFiles: LibraryImportFileSnapshot[] = [];

  try {
    const draft = await loadLibraryImportCandidateDraft(db, input.draftId);
    const selectedCandidates = selectLibraryImportCandidates(draft.candidates, input.selectedCandidateIds);
    const existingGraph = await loadLibraryImportOntologyExistingGraph(db, selectedCandidates);
    input.progress?.({
      event: "library.import.existing_graph.loaded",
      data: {
        draftId: input.draftId,
        nodeCount: existingGraph.nodes.length,
        edgeCount: existingGraph.edges.length,
      },
    });
    input.progress?.({
      event: "library.import.ontology.started",
      data: { draftId: input.draftId, selectedCandidateCount: selectedCandidates.length },
    });
    const ontologyAnalysis = input.llmProvider
      ? await analyzeLibraryImportOntologyResultWithLlm({
        candidates: selectedCandidates,
        scope: selectedCandidates[0]?.scope ?? "general",
        llmProvider: input.llmProvider,
        requestPrompt: typeof draft.payload.requestPrompt === "string" ? draft.payload.requestPrompt : undefined,
        sourceRepoPath: typeof draft.payload.sourceRepoPath === "string" ? draft.payload.sourceRepoPath : undefined,
        documents: asImportSourceDocuments(draft.payload.documents),
        existingGraph,
      })
      : { proposedEdges: draft.proposedEdges };
    const generatedEdges = ontologyAnalysis.proposedEdges;
    input.progress?.({
      event: "library.import.ontology.completed",
      data: {
        draftId: input.draftId,
        proposedEdgeCount: generatedEdges.length,
        ...(ontologyAnalysis.piSessionId ? { piSessionId: ontologyAnalysis.piSessionId } : {}),
      },
    });
    input.progress?.({
      event: "library.import.install.started",
      data: { draftId: input.draftId, selectedCandidateCount: selectedCandidates.length },
    });
    const preflighted = await preflightLibraryImportCandidates(db, {
      root: input.root,
      draftId: input.draftId,
      candidates: selectedCandidates,
      documents: asImportSourceDocuments(draft.payload.documents),
      sourceRepoPath: typeof draft.payload.sourceRepoPath === "string" ? draft.payload.sourceRepoPath : undefined,
      allowExistingCandidateFiles: true,
    });
    const proposedEdges = selectLibraryImportCandidateEdges(generatedEdges, {
      selectedObjectKeys: new Set(selectedCandidates.map((candidate) => candidate.objectKey)),
      existingObjectKeys: new Set(existingGraph.nodes.map((node) => node.objectKey)),
      selectedEdgeIds: input.selectedEdgeIds,
    });

    for (const file of preflighted) {
      try {
        if (file.existingFile) {
          const existing = await readLibraryFile({ root: input.root, relativePath: file.relativePath });
          overwrittenFiles.push({ relativePath: file.relativePath, content: existing.content });
        }
        const write = file.existingFile ? writeLibraryFile : writeNewLibraryFile;
        await write({
          root: input.root,
          relativePath: file.relativePath,
          content: file.content,
        });
        if (!file.existingFile) createdFiles.push({ relativePath: file.relativePath, content: file.content });
        for (const supportingFile of file.supportingFiles) {
          if (supportingFile.existingFile) {
            overwrittenFiles.push({
              relativePath: supportingFile.relativePath,
              content: await readFile(resolveLibraryImportPath(input.root, supportingFile.relativePath)),
            });
          }
          await writeSupportingImportFile({
            root: input.root,
            relativePath: supportingFile.relativePath,
            content: supportingFile.content,
            overwrite: supportingFile.existingFile === true,
          });
          if (!supportingFile.existingFile) {
            createdFiles.push({
              relativePath: supportingFile.relativePath,
              content: supportingFile.content,
            });
          }
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`library import file already exists: ${file.relativePath}`);
        }
        throw error;
      }
    }

    const catalog = await loadLibraryFileCatalog({ root: input.root });
    const result = await db.tx(async (tx) => {
      const { graphSync } = await reconcileLibraryCatalogPg(tx, {
        catalog,
        root: input.root,
        trigger: "import_approval",
      });
      const installedObjects = preflighted.map((file) => {
        const object = graphSync.results.find((synced) => synced.object.objectKey === file.file.objectKey)?.object;
        if (!object) throw new Error(`library object sync result missing: ${file.file.objectKey}`);
        return {
          objectKey: file.file.objectKey,
          kind: file.candidate.kind,
          relativePath: file.relativePath,
          object,
        };
      });

      const installGeneratedAt = new Date().toISOString();
      const installedEdges = [];
      for (const edge of proposedEdges) {
        installedEdges.push(await upsertLibraryEdge(tx, {
          fromObjectKey: edge.fromObjectKey,
          edgeType: edge.edgeType,
          toObjectKey: edge.toObjectKey,
          scope: scopeForImportedEdge(edge, selectedCandidates),
          status: "active",
          weight: edge.confidence,
          metadata: {
            source: input.llmProvider ? "library-import-ontology" : "library-import-candidate",
            draftId: input.draftId,
            newObjectKeys: installedObjects.map((object) => object.objectKey),
            confidence: edge.confidence,
            generatedAt: installGeneratedAt,
            ...(edge.rationale ? { rationale: edge.rationale } : {}),
          },
        }));
      }

      const install = {
        actor: input.actor ?? "operator",
        reason: input.reason,
        installedAt: installGeneratedAt,
        selectedCandidateIds: input.selectedCandidateIds,
        ...(input.selectedEdgeIds ? { selectedEdgeIds: input.selectedEdgeIds } : {}),
        generatedOntologyAt: installGeneratedAt,
        ...(ontologyAnalysis.piSessionId ? { piSessionId: ontologyAnalysis.piSessionId } : {}),
        installedObjectKeys: installedObjects.map((object) => object.objectKey),
        installedObjects: installedObjects.map((object) => ({
          objectKey: object.objectKey,
          kind: object.kind,
          relativePath: object.relativePath,
          headVersionId: object.object.headVersionId,
        })),
        installedEdges: installedEdges.map((edge) => ({
          id: edge.id,
          fromObjectKey: edge.fromObjectKey,
          edgeType: edge.edgeType,
          toObjectKey: edge.toObjectKey,
          scope: edge.scope,
          metadata: edge.metadata,
        })),
      };

      const updated = await tx.query(
        `update southstar.runtime_resources
            set status = 'installed',
                payload_json = $3::jsonb,
                summary_json = $4::jsonb,
                updated_at = now()
          where id = $1
            and status = $2`,
        [
          draft.resourceId,
          draft.status,
          JSON.stringify({
            ...withoutTransientApplyState(draft.payload),
            status: "installed",
            proposedEdges,
            install,
            ...(ontologyAnalysis.piSessionId ? { ontologyPiSessionId: ontologyAnalysis.piSessionId } : {}),
          }),
          JSON.stringify({
            ...draft.summary,
            status: "installed",
            installedBy: install.actor,
            installedObjectKeys: install.installedObjectKeys,
            installedEdgeCount: installedEdges.length,
            ...(ontologyAnalysis.piSessionId ? { ontologyPiSessionId: ontologyAnalysis.piSessionId } : {}),
          }),
        ],
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw new Error(`library import draft install state changed: ${input.draftId}`);
      }

      return {
        draftId: input.draftId,
        status: "installed" as const,
        installedObjects,
        installedEdges,
        graph: {
          objectKeys: installedObjects.map((object) => object.objectKey),
          edgeIds: installedEdges.map((edge) => edge.id),
        },
        ...(ontologyAnalysis.piSessionId ? { piSessionId: ontologyAnalysis.piSessionId } : {}),
      };
    });

    input.progress?.({
      event: "library.import.install.completed",
      data: {
        draftId: input.draftId,
        installedObjectCount: result.installedObjects.length,
        installedEdgeCount: result.installedEdges.length,
      },
    });
    return result;
  } catch (error) {
    await cleanupCreatedImportFiles(input.root, createdFiles);
    await restoreOverwrittenImportFiles(input.root, overwrittenFiles);
    await markLibraryImportCandidateInstallFailed(db, input.draftId, error);
    throw error;
  }
}

async function preflightLibraryImportProposal(
  db: SouthstarDb,
  input: { root: string; proposal: LibraryImportProposal },
): Promise<PreflightedLibraryImportFile[]> {
  const seenPaths = new Set<string>();
  const seenObjectKeys = new Set<string>();
  const preflighted: PreflightedLibraryImportFile[] = [];

  for (const file of input.proposal.files) {
    if (seenPaths.has(file.relativePath)) {
      throw new Error(`library import proposal contains duplicate file: ${file.relativePath}`);
    }
    seenPaths.add(file.relativePath);
    const parsed = parseLibraryFileContent({ path: `library/${file.relativePath}`, content: file.content });
    if (!parsed.ok) {
      throw new Error(
        `library file is invalid: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      );
    }
    validateLibraryFileGraphReferences(parsed.file);
    if (seenObjectKeys.has(parsed.file.objectKey)) {
      throw new Error(`library import proposal contains duplicate object: ${parsed.file.objectKey}`);
    }
    seenObjectKeys.add(parsed.file.objectKey);
    if (await libraryFileExists(input.root, file.relativePath)) {
      throw new Error(`library import file already exists: ${file.relativePath}`);
    }
    if (await findLibraryObjectByKey(db, parsed.file.objectKey)) {
      throw new Error(`library import object already exists: ${parsed.file.objectKey}`);
    }
    preflighted.push({ relativePath: file.relativePath, content: file.content, file: parsed.file });
  }
  return preflighted;
}

type LibraryImportCandidateDraft = {
  resourceId: string;
  status: string;
  payload: Record<string, unknown>;
  summary: Record<string, unknown>;
  candidates: LibraryImportCandidate[];
  proposedEdges: LibraryImportProposedEdge[];
};

async function loadLibraryImportCandidateDraft(
  db: SouthstarDb,
  draftId: string,
): Promise<LibraryImportCandidateDraft> {
  const resource = await db.maybeOne<LibraryImportDraftResourceRow>(
    `select id, status, title, payload_json, summary_json
       from southstar.runtime_resources
      where resource_type = $1 and resource_key = $2`,
    [LIBRARY_IMPORT_DRAFT_RESOURCE_TYPE, draftId],
  );
  if (!resource) throw new Error(`library import draft not found: ${draftId}`);
  const payload = asRecord(resource.payload_json);
  if (payload.schemaVersion !== LIBRARY_IMPORT_DRAFT_SCHEMA_VERSION) {
    throw new Error(`library import draft has unsupported schema: ${draftId}`);
  }
  if (resource.status !== "draft") {
    throw new Error(`library import draft is already ${resource.status}: ${draftId}`);
  }
  const candidates = asImportCandidates(payload.candidates);
  if (candidates.length === 0) {
    throw new Error(`library import draft has no candidates to install: ${draftId}`);
  }
  return {
    resourceId: resource.id,
    status: resource.status,
    payload,
    summary: asRecord(resource.summary_json),
    candidates,
    proposedEdges: asImportProposedEdges(payload.proposedEdges),
  };
}

async function preflightLibraryImportCandidates(
  db: SouthstarDb,
  input: {
    root: string;
    draftId: string;
    candidates: LibraryImportCandidate[];
    documents?: LibraryImportSourceDocument[];
    sourceRepoPath?: string;
    allowExistingCandidateFiles?: boolean;
  },
): Promise<Array<PreflightedLibraryImportFile & {
  candidate: LibraryImportCandidate;
  supportingFiles: SupportingLibraryImportFile[];
}>> {
  const seenPaths = new Set<string>();
  const seenObjectKeys = new Set<string>();
  const preflighted: Array<PreflightedLibraryImportFile & {
    candidate: LibraryImportCandidate;
    supportingFiles: SupportingLibraryImportFile[];
  }> = [];
  const sourceDocuments = new Map((input.documents ?? []).map((document) => [document.path, document]));

  for (const candidate of input.candidates) {
    const rendered = renderLibraryImportCandidate(input.draftId, candidate, {
      sourceContent: await sourceContentForCandidate(candidate, {
        documents: sourceDocuments,
        sourceRepoPath: input.sourceRepoPath,
      }),
    });
    if (seenPaths.has(rendered.relativePath)) {
      throw new Error(`library import candidates contain duplicate file: ${rendered.relativePath}`);
    }
    seenPaths.add(rendered.relativePath);
    if (seenObjectKeys.has(candidate.objectKey)) {
      throw new Error(`library import candidates contain duplicate object: ${candidate.objectKey}`);
    }
    seenObjectKeys.add(candidate.objectKey);

    const parsed = parseLibraryFileContent({ path: `library/${rendered.relativePath}`, content: rendered.content });
    if (!parsed.ok) {
      throw new Error(
        `library file is invalid: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      );
    }
    validateLibraryFileGraphReferences(parsed.file);
    if (parsed.file.objectKey !== candidate.objectKey) {
      throw new Error(`library import candidate rendered unexpected object: ${parsed.file.objectKey}`);
    }
    const existingFile = await candidateFileExists(input.root, rendered.relativePath, candidate);
    if (existingFile && !input.allowExistingCandidateFiles) {
      throw new Error(`library import file already exists: ${rendered.relativePath}`);
    }
    const existingObject = await findLibraryObjectByKey(db, parsed.file.objectKey);
    if (existingObject && !input.allowExistingCandidateFiles) {
      throw new Error(`library import object already exists: ${parsed.file.objectKey}`);
    }
    const supportingFiles = await supportingFilesForCandidate(candidate, {
      sourceRepoPath: input.sourceRepoPath,
      destinationSlug: slugFromCandidate(candidate),
    });
    for (const supportingFile of supportingFiles) {
      if (seenPaths.has(supportingFile.relativePath)) {
        throw new Error(`library import candidates contain duplicate file: ${supportingFile.relativePath}`);
      }
      seenPaths.add(supportingFile.relativePath);
      const existingSupportingFile = await supportingFileExists(input.root, supportingFile.relativePath, candidate);
      if (existingSupportingFile && !input.allowExistingCandidateFiles) {
        throw new Error(`library import file already exists: ${supportingFile.relativePath}`);
      }
      supportingFile.existingFile = existingSupportingFile;
    }
    preflighted.push({
      relativePath: rendered.relativePath,
      content: rendered.content,
      file: parsed.file,
      existingFile: existingFile === true,
      candidate,
      supportingFiles,
    });
  }

  return preflighted;
}

function selectLibraryImportCandidates(
  candidates: LibraryImportCandidate[],
  selectedCandidateIds: string[],
): LibraryImportCandidate[] {
  if (!Array.isArray(selectedCandidateIds) || selectedCandidateIds.length === 0) {
    throw new Error("selectedCandidateIds is required");
  }
  const byKey = new Map(candidates.map((candidate) => [candidate.objectKey, candidate]));
  const selected: LibraryImportCandidate[] = [];
  const seen = new Set<string>();
  for (const candidateId of selectedCandidateIds) {
    if (typeof candidateId !== "string" || candidateId.length === 0) {
      throw new Error("selectedCandidateIds must contain strings");
    }
    if (seen.has(candidateId)) continue;
    const candidate = byKey.get(candidateId);
    if (!candidate) throw new Error(`library import candidate not found: ${candidateId}`);
    selected.push(candidate);
    seen.add(candidateId);
  }
  return selected;
}

function selectLibraryImportCandidateEdges(
  proposedEdges: LibraryImportProposedEdge[],
  input: { selectedObjectKeys: Set<string>; existingObjectKeys?: Set<string>; selectedEdgeIds?: string[] },
): LibraryImportProposedEdge[] {
  const selectedEdgeIds = input.selectedEdgeIds ? new Set(input.selectedEdgeIds) : null;
  const availableEdgeIds = new Set(proposedEdges.map(libraryImportEdgeId));
  const existingObjectKeys = input.existingObjectKeys ?? new Set<string>();
  const allowedObjectKeys = new Set([...input.selectedObjectKeys, ...existingObjectKeys]);
  if (selectedEdgeIds) {
    for (const edgeId of selectedEdgeIds) {
      if (!availableEdgeIds.has(edgeId)) throw new Error(`library import proposed edge not found: ${edgeId}`);
    }
  }

  return proposedEdges.filter((edge) => {
    if (!allowedObjectKeys.has(edge.fromObjectKey) || !allowedObjectKeys.has(edge.toObjectKey)) {
      return false;
    }
    if (!input.selectedObjectKeys.has(edge.fromObjectKey) && !input.selectedObjectKeys.has(edge.toObjectKey)) {
      return false;
    }
    return selectedEdgeIds ? selectedEdgeIds.has(libraryImportEdgeId(edge)) : true;
  });
}

function libraryImportEdgeId(edge: LibraryImportProposedEdge): string {
  return `${edge.fromObjectKey}|${edge.edgeType}|${edge.toObjectKey}`;
}

const ONTOLOGY_GRAPH_KINDS: ReadonlySet<LibraryDefinitionKind> = new Set([
  "agent_definition",
  "skill_spec",
  "tool_definition",
  "mcp_tool_grant",
  "vault_lease_policy",
  "domain_taxonomy",
]);

async function loadLibraryImportOntologyExistingGraph(
  db: SouthstarDb,
  selectedCandidates: LibraryImportCandidate[],
): Promise<LibraryImportOntologyExistingGraph> {
  const selectedObjectKeys = new Set(selectedCandidates.map((candidate) => candidate.objectKey));
  const objects = (await listLibraryObjects(db, { status: "approved" }))
    .filter((object) => ONTOLOGY_GRAPH_KINDS.has(object.objectKind))
    .filter((object) => !selectedObjectKeys.has(object.objectKey));
  const objectKeys = new Set(objects.map((object) => object.objectKey));
  const edges = (await listLibraryEdges(db, { status: "active" }))
    .filter((edge) => objectKeys.has(edge.fromObjectKey) && objectKeys.has(edge.toObjectKey));

  return {
    nodes: objects.map((object) => ({
      objectKey: object.objectKey,
      objectKind: object.objectKind,
      status: object.status,
      title: stringFromState(object.state, "title") ?? stringFromState(object.state, "name"),
      scope: stringFromState(object.state, "scope"),
      summary: stringFromState(object.state, "summary") ?? stringFromState(object.state, "description"),
      headVersionId: object.headVersionId,
    })),
    edges: edges.map((edge) => ({
      fromObjectKey: edge.fromObjectKey,
      edgeType: edge.edgeType,
      toObjectKey: edge.toObjectKey,
      scope: edge.scope,
      weight: edge.weight,
    })),
  };
}

function scopeForImportedEdge(edge: LibraryImportProposedEdge, selectedCandidates: LibraryImportCandidate[]): string {
  return selectedCandidates.find((candidate) => candidate.objectKey === edge.fromObjectKey)?.scope
    ?? selectedCandidates.find((candidate) => candidate.objectKey === edge.toObjectKey)?.scope
    ?? selectedCandidates[0]?.scope
    ?? "global";
}

function stringFromState(state: Record<string, unknown>, key: string): string | undefined {
  const value = state[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function renderLibraryImportCandidate(
  draftId: string,
  candidate: LibraryImportCandidate,
  options: { sourceContent?: string } = {},
): { relativePath: string; content: string } {
  const slug = slugFromCandidate(candidate);
  const relativePath = candidateRelativePath(candidate.kind, slug);
  const schemaVersion = candidateSchemaVersion(candidate.kind);
  const title = yamlScalar(candidate.title);
  const scope = yamlScalar(candidate.scope);
  const provenance = [
    `importDraftId: ${yamlScalar(draftId)}`,
    `importCandidateKey: ${yamlScalar(candidate.objectKey)}`,
    ...(candidate.sourcePath ? [`importSourcePath: ${yamlScalar(candidate.sourcePath)}`] : []),
  ].join("\n");

  if (candidate.kind !== "agent" && candidate.kind !== "skill") {
    const definitionLines = candidate.kind === "domain"
      ? yamlArray("aliases", candidate.aliases)
      : candidate.kind === "capability"
        ? [
          `description: ${yamlScalar(candidate.description ?? "")}`,
          ...yamlArray("requiredOperations", candidate.requiredOperations),
        ]
        : candidate.kind === "artifact"
          ? [
            `artifactType: ${yamlScalar(candidate.artifactType ?? "")}`,
            ...yamlArray("evidenceKinds", candidate.evidenceKinds),
          ]
          : candidate.kind === "evaluator"
            ? [
              ...yamlArray("validatesArtifactRefs", candidate.validatesArtifactRefs),
              ...yamlArray("evidenceKinds", candidate.evidenceKinds),
            ]
            : [`description: ${yamlScalar(`Imported ${candidate.kind} candidate from library import draft.`)}`];
    return {
      relativePath,
      content: [
        `schemaVersion: ${schemaVersion}`,
        `id: ${candidate.objectKey}`,
        `title: ${title}`,
        `scope: ${scope}`,
        "status: approved",
        ...definitionLines,
        provenance,
        "",
      ].join("\n"),
    };
  }

  const heading = candidate.kind === "agent" ? "Identity" : "Instructions";
  const body = options.sourceContent
    ? [
      `# ${heading}`,
      "",
      `Imported ${candidate.kind} candidate from library import draft ${draftId}.`,
      "",
      "## Source Definition",
      "",
      options.sourceContent.trim(),
      "",
    ]
    : [
      `# ${heading}`,
      "",
      `Imported ${candidate.kind} candidate from library import draft ${draftId}.`,
      "",
    ];
  return {
    relativePath,
    content: [
      "---",
      `schemaVersion: ${schemaVersion}`,
      `id: ${candidate.objectKey}`,
      `title: ${title}`,
      `scope: ${scope}`,
      "status: approved",
      provenance,
      "---",
      "",
      ...body,
    ].join("\n"),
  };
}

async function sourceContentForCandidate(
  candidate: LibraryImportCandidate,
  input: { documents: Map<string, LibraryImportSourceDocument>; sourceRepoPath?: string },
): Promise<string | undefined> {
  if (!candidate.sourcePath || (candidate.kind !== "agent" && candidate.kind !== "skill")) return undefined;
  const document = input.documents.get(candidate.sourcePath);
  if (document) return document.content;
  if (!input.sourceRepoPath) return undefined;
  return await readImportSourceFile(input.sourceRepoPath, candidate.sourcePath);
}

async function supportingFilesForCandidate(
  candidate: LibraryImportCandidate,
  input: { sourceRepoPath?: string; destinationSlug: string },
): Promise<SupportingLibraryImportFile[]> {
  if (candidate.kind !== "skill" || !candidate.sourcePath || !input.sourceRepoPath) return [];
  const sourceDirectory = await resolveImportSourceDirectory(input.sourceRepoPath, candidate.sourcePath);
  if (!sourceDirectory) return [];
  const files = await collectImportSourceFiles(sourceDirectory.absolutePath, sourceDirectory.absolutePath);
  return files.map((file) => ({
    relativePath: path.posix.join("skills", input.destinationSlug, file.relativePath),
    content: file.content,
  }));
}

async function resolveImportSourceDirectory(
  sourceRepoPath: string,
  sourcePath: string,
): Promise<{ absolutePath: string } | null> {
  const sourceFile = resolveImportSourcePath(sourceRepoPath, sourcePath);
  const sourceStats = await stat(sourceFile);
  if (sourceStats.isDirectory()) return { absolutePath: sourceFile };
  if (!sourceStats.isFile()) return null;
  if (path.basename(sourceFile).toLowerCase() !== "skill.md") return null;
  return { absolutePath: path.dirname(sourceFile) };
}

async function collectImportSourceFiles(
  directory: string,
  root: string,
): Promise<Array<{ relativePath: string; content: Buffer }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectImportSourceFiles(absolutePath, root));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({
      relativePath: toPosixPath(path.relative(root, absolutePath)),
      content: await readFile(absolutePath),
    });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readImportSourceFile(sourceRepoPath: string, sourcePath: string): Promise<string> {
  return await readFile(resolveImportSourcePath(sourceRepoPath, sourcePath), "utf8");
}

function resolveImportSourcePath(sourceRepoPath: string, sourcePath: string): string {
  const normalizedSegments = sourcePath.split(/[\\/]+/g).filter(Boolean);
  if (normalizedSegments.length === 0 || normalizedSegments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`library import candidate sourcePath is invalid: ${sourcePath}`);
  }
  const root = path.resolve(sourceRepoPath);
  const filePath = path.resolve(root, ...normalizedSegments);
  const relative = path.relative(root, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`library import candidate sourcePath escapes source repo: ${sourcePath}`);
  }
  return filePath;
}

function slugFromCandidate(candidate: LibraryImportCandidate): string {
  const prefix = `${candidate.kind}.`;
  if (!candidate.objectKey.startsWith(prefix)) {
    throw new Error(`library import candidate objectKey must start with ${prefix}: ${candidate.objectKey}`);
  }
  const slug = candidate.objectKey.slice(prefix.length)
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .toLowerCase();
  if (slug.length === 0) throw new Error(`library import candidate objectKey has empty slug: ${candidate.objectKey}`);
  return slug;
}

function candidateRelativePath(kind: LibraryImportCandidateKind, slug: string): string {
  if (kind === "agent") return `agents/${slug}.agent.md`;
  if (kind === "skill") return `skills/${slug}.skill.md`;
  if (kind === "tool") return `tools/${slug}.tool.yaml`;
  if (kind === "mcp") return `mcp/${slug}.mcp.yaml`;
  if (kind === "domain") return `domains/${slug}.domain.yaml`;
  if (kind === "capability") return `capabilities/${slug}.capability.yaml`;
  if (kind === "artifact") return `artifacts/${slug}.artifact.yaml`;
  return `evaluators/${slug}.evaluator.yaml`;
}

function candidateSchemaVersion(kind: LibraryImportCandidateKind): string {
  if (kind === "agent") return "southstar.library.agent_definition_file.v1";
  if (kind === "skill") return "southstar.library.skill_spec_file.v1";
  if (kind === "tool") return "southstar.library.tool_definition_file.v1";
  if (kind === "mcp") return "southstar.library.mcp_grant_file.v1";
  if (kind === "domain") return "southstar.library.domain_taxonomy_file.v1";
  if (kind === "capability") return "southstar.library.capability_spec_file.v1";
  if (kind === "artifact") return "southstar.library.artifact_contract_file.v1";
  return "southstar.library.evaluator_profile_file.v1";
}

function asImportCandidates(value: unknown): LibraryImportCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      objectKey: requiredString(record.objectKey, "candidates.objectKey"),
      kind: requiredImportCandidateKind(record.kind),
      title: requiredString(record.title, "candidates.title"),
      scope: requiredString(record.scope, "candidates.scope"),
      ...(typeof record.domain === "string" && record.domain.length > 0 ? { domain: record.domain } : {}),
      ...(typeof record.displayDomain === "string" && record.displayDomain.length > 0 ? { displayDomain: record.displayDomain } : {}),
      ...(typeof record.classificationReason === "string" && record.classificationReason.length > 0
        ? { classificationReason: record.classificationReason }
        : {}),
      ...(typeof record.sourcePath === "string" && record.sourcePath.length > 0 ? { sourcePath: record.sourcePath } : {}),
      selectedByDefault: typeof record.selectedByDefault === "boolean" ? record.selectedByDefault : true,
      ...(typeof record.confidence === "number" ? { confidence: record.confidence } : {}),
      ...(typeof record.description === "string" && record.description.length > 0 ? { description: record.description } : {}),
      ...(stringArray(record.aliases).length > 0 ? { aliases: stringArray(record.aliases) } : {}),
      ...(stringArray(record.requiredOperations).length > 0 ? { requiredOperations: stringArray(record.requiredOperations) } : {}),
      ...(typeof record.artifactType === "string" && record.artifactType.length > 0 ? { artifactType: record.artifactType } : {}),
      ...(stringArray(record.evidenceKinds).length > 0 ? { evidenceKinds: stringArray(record.evidenceKinds) } : {}),
      ...(stringArray(record.validatesArtifactRefs).length > 0
        ? { validatesArtifactRefs: stringArray(record.validatesArtifactRefs) }
        : {}),
    };
  });
}

function asImportSourceDocuments(value: unknown): LibraryImportSourceDocument[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (typeof record.path !== "string" || typeof record.label !== "string" || typeof record.content !== "string") return [];
    return [{ path: record.path, label: record.label, content: record.content }];
  });
}

function asImportProposedEdges(value: unknown): LibraryImportProposedEdge[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      fromObjectKey: requiredString(record.fromObjectKey, "proposedEdges.fromObjectKey"),
      edgeType: requiredImportEdgeType(record.edgeType),
      toObjectKey: requiredString(record.toObjectKey, "proposedEdges.toObjectKey"),
      confidence: typeof record.confidence === "number" ? record.confidence : 0.5,
      ...(typeof record.rationale === "string" && record.rationale.length > 0 ? { rationale: record.rationale } : {}),
    };
  });
}

function requiredImportCandidateKind(value: unknown): LibraryImportCandidateKind {
  if (
    value === "agent" || value === "skill" || value === "tool" || value === "mcp"
    || value === "domain" || value === "capability" || value === "artifact" || value === "evaluator"
  ) return value;
  throw new Error(`library import candidate kind is invalid: ${String(value)}`);
}

function requiredImportEdgeType(value: unknown): LibraryImportEdgeType {
  if (
    value === "uses" ||
    value === "requires" ||
    value === "belongs_to_domain" ||
    value === "has_capability" ||
    value === "provides" ||
    value === "conflicts_with" ||
    value === "precedes" ||
    value === "workflow_precedes" ||
    value === "unblocks" ||
    value === "validates" ||
    value === "reviews" ||
    value === "produces" ||
    value === "consumes" ||
    value === "similar_to" ||
    value === "substitutes" ||
    value === "complements" ||
    value === "incompatible_with" ||
    value === "requires_approval" ||
    value === "requires_secret_group" ||
    value === "requires_secret"
  ) {
    return value;
  }
  throw new Error(`library import proposed edge type is invalid: ${String(value)}`);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value.replaceAll(/\r?\n/g, " ").trim());
}

function yamlArray(key: string, values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [`${key}: []`];
  return [`${key}:`, ...values.map((value) => `  - ${yamlScalar(value)}`)];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" && item.length > 0 ? [item] : []);
}

async function libraryFileExists(root: string, relativePath: string): Promise<boolean> {
  try {
    await readLibraryFile({ root, relativePath });
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function candidateFileExists(
  root: string,
  relativePath: string,
  candidate: LibraryImportCandidate,
): Promise<boolean> {
  try {
    const existing = await readLibraryFile({ root, relativePath });
    if (!existing.parsed.ok) throw new Error(`library import file already exists: ${relativePath}`);
    if (existing.parsed.file.objectKey !== candidate.objectKey) {
      throw new Error(`library import file already exists for different object: ${relativePath}`);
    }
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function supportingFileExists(
  root: string,
  relativePath: string,
  candidate: LibraryImportCandidate,
): Promise<boolean> {
  try {
    const absolutePath = resolveLibraryImportPath(root, relativePath);
    await stat(absolutePath);
    const expectedPrefix = `skills/${slugFromCandidate(candidate)}/`;
    if (!relativePath.startsWith(expectedPrefix)) {
      throw new Error(`library import file already exists outside candidate directory: ${relativePath}`);
    }
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupCreatedImportFiles(
  root: string,
  files: Array<{ relativePath: string; content: string | Buffer }>,
): Promise<void> {
  for (const file of [...files].reverse()) {
    if (typeof file.content === "string") {
      await removeLibraryFileIfContentMatches({ root, relativePath: file.relativePath, content: file.content });
    } else {
      await removeSupportingImportFileIfContentMatches({ root, relativePath: file.relativePath, content: file.content });
    }
  }
}

async function restoreOverwrittenImportFiles(
  root: string,
  files: LibraryImportFileSnapshot[],
): Promise<void> {
  for (const file of [...files].reverse()) {
    if (typeof file.content === "string") {
      await writeLibraryFile({ root, relativePath: file.relativePath, content: file.content });
      continue;
    }
    const absolutePath = resolveLibraryImportPath(root, file.relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content);
  }
}

async function writeSupportingImportFile(input: {
  root: string;
  relativePath: string;
  content: Buffer;
  overwrite?: boolean;
}): Promise<void> {
  const absolutePath = resolveLibraryImportPath(input.root, input.relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.content, input.overwrite ? undefined : { flag: "wx" });
}

async function removeSupportingImportFileIfContentMatches(input: {
  root: string;
  relativePath: string;
  content: Buffer;
}): Promise<boolean> {
  const absolutePath = resolveLibraryImportPath(input.root, input.relativePath);
  let existing;
  try {
    existing = await readFile(absolutePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!existing.equals(input.content)) return false;
  await rm(absolutePath, { force: true });
  return true;
}

function resolveLibraryImportPath(root: string, relativePath: string): string {
  const normalizedSegments = relativePath.split(/[\\/]+/g).filter(Boolean);
  if (normalizedSegments.length === 0 || normalizedSegments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`library import file path is invalid: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...normalizedSegments);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`library import file path escapes library root: ${relativePath}`);
  }
  return resolvedPath;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function reserveLibraryImportDraftApproval(
  db: SouthstarDb,
  input: { draftId: string; actor: string; reason: string },
): Promise<
  | { kind: "already-approved"; result: LibraryImportDraftApprovalResult }
  | LibraryImportDraftApplyReservation
> {
  return await db.tx(async (tx) => {
    const resource = await tx.maybeOne<LibraryImportDraftResourceRow>(
      `select id, status, title, payload_json, summary_json
         from southstar.runtime_resources
        where resource_type = $1 and resource_key = $2
        for update`,
      [LIBRARY_IMPORT_DRAFT_RESOURCE_TYPE, input.draftId],
    );
    if (!resource) throw new Error(`library import draft not found: ${input.draftId}`);
    const payload = asRecord(resource.payload_json);
    if (payload.schemaVersion !== LIBRARY_IMPORT_DRAFT_SCHEMA_VERSION) {
      throw new Error(`library import draft has unsupported schema: ${input.draftId}`);
    }
    const proposal = asProposal(payload.proposal);
    const summary = asRecord(resource.summary_json);
    const title = resource.title ?? `Library import draft: ${input.draftId}`;

    if (resource.status === "approved") {
      return {
        kind: "already-approved",
        result: approvedResultFromPayload(input.draftId, payload, proposal),
      };
    }
    if (resource.status === "applying") {
      const existingLease = asApprovalLease(payload.approvalLease);
      if (existingLease && Date.parse(existingLease.expiresAt) > Date.now()) {
        throw new Error(`library import draft is already applying: ${input.draftId}`);
      }
      const approval = asApproval(payload.approval) ?? {
        actor: input.actor,
        reason: input.reason,
        approvedAt: new Date().toISOString(),
      };
      const approvalLease = newApprovalLease();
      await tx.query(
        `update southstar.runtime_resources
            set payload_json = $2::jsonb,
                summary_json = $3::jsonb,
                updated_at = now()
          where id = $1`,
        [
          resource.id,
          JSON.stringify({ ...payload, status: "applying", approval, approvalLease }),
          JSON.stringify({ ...summary, status: "applying", approvedBy: approval.actor }),
        ],
      );
      return {
        kind: "apply",
        resourceId: resource.id,
        title,
        payload,
        summary,
        proposal,
        approval,
        approvalLease,
      };
    }
    if (resource.status !== "draft") {
      throw new Error(`library import draft is already ${resource.status}: ${input.draftId}`);
    }

    const approval = {
      actor: input.actor,
      reason: input.reason,
      approvedAt: new Date().toISOString(),
    };
    const approvalLease = newApprovalLease();
    await tx.query(
      `update southstar.runtime_resources
          set status = 'applying',
              payload_json = $2::jsonb,
              summary_json = $3::jsonb,
              updated_at = now()
        where id = $1`,
      [
        resource.id,
        JSON.stringify({ ...payload, status: "applying", approval, approvalLease }),
        JSON.stringify({ ...summary, status: "applying", approvedBy: approval.actor }),
      ],
    );

    return {
      kind: "apply",
      resourceId: resource.id,
      title,
      payload,
      summary,
      proposal,
      approval,
      approvalLease,
    };
  });
}

async function markLibraryImportDraftApplyFailed(
  db: SouthstarDb,
  reserved: LibraryImportDraftApplyReservation,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.query(
    `update southstar.runtime_resources
        set status = 'draft',
            payload_json = $2::jsonb,
            summary_json = $3::jsonb,
            updated_at = now()
      where id = $1
        and status = 'applying'
        and payload_json->'approvalLease'->>'attemptId' = $4`,
    [
      reserved.resourceId,
      JSON.stringify({
        ...reserved.payload,
        status: "draft",
        approvalLease: reserved.approvalLease,
        lastError: {
          message,
          failedAt: new Date().toISOString(),
          approvalAttempt: reserved.approval,
        },
      }),
      JSON.stringify({
        ...reserved.summary,
        status: "draft",
        lastError: message,
      }),
      reserved.approvalLease.attemptId,
    ],
  );
}

async function markLibraryImportCandidateInstallFailed(
  db: SouthstarDb,
  draftId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.query(
    `update southstar.runtime_resources
        set status = 'draft',
            payload_json = payload_json || $3::jsonb,
            summary_json = coalesce(summary_json, '{}'::jsonb) || $4::jsonb,
            updated_at = now()
      where resource_type = $1
        and resource_key = $2
        and status = 'draft'`,
    [
      LIBRARY_IMPORT_DRAFT_RESOURCE_TYPE,
      draftId,
      JSON.stringify({
        status: "draft",
        lastError: {
          message,
          failedAt: new Date().toISOString(),
          installAttempt: true,
        },
      }),
      JSON.stringify({
        status: "draft",
        lastError: message,
      }),
    ],
  );
}

function approvedResultFromPayload(
  draftId: string,
  payload: Record<string, unknown>,
  proposal: LibraryImportProposal,
): LibraryImportDraftApprovalResult {
  const applied = asRecord(payload.applied);
  const files = Array.isArray(applied.files)
    ? applied.files.map((file) => {
        const record = asRecord(file);
        return { relativePath: requiredString(record.relativePath, "applied.files.relativePath") };
      })
    : proposal.files.map((file) => ({ relativePath: file.relativePath }));
  const reconcile = asRecord(applied.reconcile) as unknown as LibraryReconcileResult;
  const librarySnapshotHash = typeof applied.librarySnapshotHash === "string"
    ? applied.librarySnapshotHash
    : reconcile.snapshotHash;
  if (!librarySnapshotHash || typeof reconcile.snapshotHash !== "string") {
    throw new Error(`approved library import draft is missing reconcile snapshot: ${draftId}`);
  }
  const synced = Array.isArray(applied.synced)
    ? applied.synced as LibraryGraphSyncResult["results"]
    : [];
  return { draftId, status: "approved", proposal, files, synced, reconcile, librarySnapshotHash };
}

type LibraryImportDraftResourceRow = {
  id: string;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
};

function asApproval(value: unknown): { actor: string; reason: string; approvedAt: string } | null {
  const record = asRecord(value);
  const actor = typeof record.actor === "string" ? record.actor : null;
  const reason = typeof record.reason === "string" ? record.reason : null;
  const approvedAt = typeof record.approvedAt === "string" ? record.approvedAt : null;
  return actor && reason && approvedAt ? { actor, reason, approvedAt } : null;
}

function asApprovalLease(value: unknown): { attemptId: string; startedAt: string; expiresAt: string } | null {
  const record = asRecord(value);
  const attemptId = typeof record.attemptId === "string" ? record.attemptId : null;
  const startedAt = typeof record.startedAt === "string" ? record.startedAt : null;
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : null;
  return attemptId && startedAt && expiresAt ? { attemptId, startedAt, expiresAt } : null;
}

function newApprovalLease(): { attemptId: string; startedAt: string; expiresAt: string } {
  const startedAt = new Date();
  return {
    attemptId: `library-import-approval-${randomUUID()}`,
    startedAt: startedAt.toISOString(),
    expiresAt: new Date(startedAt.getTime() + APPROVAL_LEASE_MS).toISOString(),
  };
}

function withoutTransientApplyState(payload: Record<string, unknown>): Record<string, unknown> {
  const { lastError: _lastError, approvalLease: _approvalLease, ...rest } = payload;
  return rest;
}

function asProposal(value: unknown): LibraryImportProposal {
  const record = asRecord(value);
  const files = Array.isArray(record.files)
    ? record.files.map((file) => {
        const fileRecord = asRecord(file);
        return {
          relativePath: requiredString(fileRecord.relativePath, "proposal.files.relativePath"),
          content: requiredString(fileRecord.content, "proposal.files.content"),
        };
      })
    : [];
  const objectKeys = Array.isArray(record.objectKeys)
    ? record.objectKeys.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (files.length === 0) throw new Error("library import draft has no files to approve");
  const objectSummaries = Array.isArray(record.objectSummaries)
    ? record.objectSummaries.map((item) => {
        const summary = asRecord(item);
        return {
          objectKey: requiredString(summary.objectKey, "proposal.objectSummaries.objectKey"),
          objectKind: requiredString(summary.objectKind, "proposal.objectSummaries.objectKind"),
          title: requiredString(summary.title, "proposal.objectSummaries.title"),
          scope: requiredString(summary.scope, "proposal.objectSummaries.scope"),
          status: requiredString(summary.status, "proposal.objectSummaries.status"),
          relativePath: requiredString(summary.relativePath, "proposal.objectSummaries.relativePath"),
        };
      })
    : [];
  const dependencies = Array.isArray(record.dependencies)
    ? record.dependencies.map((item) => {
        const dependency = asRecord(item);
        return {
          fromObjectKey: requiredString(dependency.fromObjectKey, "proposal.dependencies.fromObjectKey"),
          edgeType: requiredString(dependency.edgeType, "proposal.dependencies.edgeType"),
          toObjectKey: requiredString(dependency.toObjectKey, "proposal.dependencies.toObjectKey"),
          scope: requiredString(dependency.scope, "proposal.dependencies.scope"),
        };
      })
    : [];
  return { files, objectKeys, objectSummaries, dependencies };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
