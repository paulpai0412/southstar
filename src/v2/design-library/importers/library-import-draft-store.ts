import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../../db/postgres.ts";
import { parseLibraryFileContent } from "../files/library-file-parser.ts";
import {
  readLibraryFile,
  removeLibraryFileIfContentMatches,
  syncNewLibraryFileRecordsToGraph,
  syncLibraryFileToGraph,
  validateLibraryFileGraphReferences,
  writeNewLibraryFile,
} from "../files/library-file-store.ts";
import type { LibraryFileRecord } from "../files/library-file-types.ts";
import { upsertRuntimeResourcePg } from "../../stores/postgres-runtime-store.ts";
import type { LibraryPromptImportProposal } from "./prompt-library-importer.ts";
import {
  asImportSource,
  extractLibraryImportProposal,
  type LibraryImportSource,
} from "./library-import-extractor.ts";
import {
  fetchLibraryImportSourceDocuments,
  type LibraryImportSourceDocument,
  type LibraryImportSourceFetcher,
} from "./library-source-fetcher.ts";
import {
  analyzeLibraryImportWithLlm,
  type LibraryImportLlmProvider,
} from "./library-llm-import-analyzer.ts";
import type {
  LibraryImportCandidate,
  LibraryImportProposedEdge,
} from "./library-candidate-extractor.ts";
import { findLibraryObjectByKey } from "../library-graph-store.ts";

export const LIBRARY_IMPORT_DRAFT_RESOURCE_TYPE = "library_import_draft";
export const LIBRARY_IMPORT_DRAFT_SCHEMA_VERSION = "southstar.library.import_draft.v1";
const APPROVAL_LEASE_MS = 15 * 60 * 1000;

export type LibraryImportDraftResult = {
  draftId: string;
  status: "draft";
  proposal: LibraryPromptImportProposal;
  documents?: LibraryImportSourceDocument[];
  candidates?: LibraryImportCandidate[];
  proposedEdges?: LibraryImportProposedEdge[];
};

export type LibraryImportDraftApprovalResult = {
  draftId: string;
  status: "approved";
  proposal: LibraryPromptImportProposal;
  files: Array<{ relativePath: string }>;
  synced: Array<Awaited<ReturnType<typeof syncLibraryFileToGraph>>>;
};

type LibraryImportDraftApplyReservation = {
  kind: "apply";
  resourceId: string;
  title: string;
  payload: Record<string, unknown>;
  summary: Record<string, unknown>;
  proposal: LibraryPromptImportProposal;
  approval: { actor: string; reason: string; approvedAt: string };
  approvalLease: { attemptId: string; startedAt: string; expiresAt: string };
};

type PreflightedLibraryImportFile = {
  relativePath: string;
  content: string;
  file: LibraryFileRecord;
};

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
  },
): Promise<LibraryImportDraftResult> {
  const source = asImportSource(input.source);
  const documents = await fetchLibraryImportSourceDocuments({
    source,
    sourceFetcher: input.sourceFetcher,
    localRoot: input.localRoot,
    maxFiles: input.maxFiles,
    maxBytes: input.maxBytes,
  });
  const proposal = extractLibraryImportProposal({
    source: sourceHasInlineContent(source) ? source : sourceFromDocuments(documents),
    scope: input.scope,
  });
  const analysis = await analyzeLibraryImportWithLlm({
    documents,
    scope: input.scope,
    llmProvider: input.llmProvider,
  });
  const draftId = `library-import-draft-${randomUUID()}`;
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
      proposal,
      documents,
      candidates: analysis.candidates,
      proposedEdges: analysis.proposedEdges,
    },
    summary: {
      scope: input.scope,
      objectKeys: proposal.objectKeys,
      filePaths: proposal.files.map((file) => file.relativePath),
      candidateKeys: analysis.candidates.map((candidate) => candidate.objectKey),
      proposedEdgeCount: analysis.proposedEdges.length,
    },
  });
  return {
    draftId,
    status: "draft",
    proposal,
    documents,
    candidates: analysis.candidates,
    proposedEdges: analysis.proposedEdges,
  };
}

function sourceHasInlineContent(source: LibraryImportSource): boolean {
  if (source.kind === "paste") return true;
  return typeof source.content === "string" && source.content.length > 0;
}

function sourceFromDocuments(documents: LibraryImportSourceDocument[]): LibraryImportSource {
  return {
    kind: "paste",
    label: "Fetched library import source",
    content: documents.map((document) => document.content).join("\n\n"),
  };
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
    const files = [];
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
    const synced = await db.tx(async (tx) => {
      const syncedFiles = await syncNewLibraryFileRecordsToGraph(tx, preflighted.map((file) => file.file));
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
            applied,
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
      return syncedFiles;
    });

    return { draftId: input.draftId, status: "approved", proposal: reserved.proposal, files, synced };
  } catch (error) {
    await cleanupCreatedImportFiles(input.root, createdFiles);
    await markLibraryImportDraftApplyFailed(db, reserved, error);
    throw error;
  }
}

async function preflightLibraryImportProposal(
  db: SouthstarDb,
  input: { root: string; proposal: LibraryPromptImportProposal },
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

async function libraryFileExists(root: string, relativePath: string): Promise<boolean> {
  try {
    await readLibraryFile({ root, relativePath });
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupCreatedImportFiles(root: string, files: Array<{ relativePath: string; content: string }>): Promise<void> {
  for (const file of [...files].reverse()) {
    await removeLibraryFileIfContentMatches({ root, relativePath: file.relativePath, content: file.content });
  }
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

function approvedResultFromPayload(
  draftId: string,
  payload: Record<string, unknown>,
  proposal: LibraryPromptImportProposal,
): LibraryImportDraftApprovalResult {
  const applied = asRecord(payload.applied);
  const files = Array.isArray(applied.files)
    ? applied.files.map((file) => {
        const record = asRecord(file);
        return { relativePath: requiredString(record.relativePath, "applied.files.relativePath") };
      })
    : proposal.files.map((file) => ({ relativePath: file.relativePath }));
  return { draftId, status: "approved", proposal, files, synced: [] };
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

function asProposal(value: unknown): LibraryPromptImportProposal {
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
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  return {};
}
