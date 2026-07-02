import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../../db/postgres.ts";
import { parseLibraryFileContent } from "../files/library-file-parser.ts";
import { syncLibraryFileToGraph, validateLibraryFileGraphReferences, writeLibraryFile } from "../files/library-file-store.ts";
import { upsertRuntimeResourcePg } from "../../stores/postgres-runtime-store.ts";
import type { LibraryPromptImportProposal } from "./prompt-library-importer.ts";
import {
  asImportSource,
  extractLibraryImportProposal,
  type LibraryImportSource,
} from "./library-import-extractor.ts";

export const LIBRARY_IMPORT_DRAFT_RESOURCE_TYPE = "library_import_draft";
export const LIBRARY_IMPORT_DRAFT_SCHEMA_VERSION = "southstar.library.import_draft.v1";

export type LibraryImportDraftResult = {
  draftId: string;
  status: "draft";
  proposal: LibraryPromptImportProposal;
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
};

export async function createLibraryImportDraft(
  db: SouthstarDb,
  input: { source: LibraryImportSource; scope: string },
): Promise<LibraryImportDraftResult> {
  const source = asImportSource(input.source);
  const proposal = extractLibraryImportProposal({ source, scope: input.scope });
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
    },
    summary: {
      scope: input.scope,
      objectKeys: proposal.objectKeys,
      filePaths: proposal.files.map((file) => file.relativePath),
    },
  });
  return { draftId, status: "draft", proposal };
}

export async function approveLibraryImportDraft(
  db: SouthstarDb,
  input: { root: string; draftId: string; actor: string; reason: string },
): Promise<LibraryImportDraftApprovalResult> {
  const reserved = await reserveLibraryImportDraftApproval(db, input);
  if (reserved.kind === "already-approved") return reserved.result;

  try {
    preflightLibraryImportProposal(reserved.proposal);
    const files = [];
    const synced = [];
    for (const file of reserved.proposal.files) {
      files.push(await writeLibraryFile({
        root: input.root,
        relativePath: file.relativePath,
        content: file.content,
      }));
      synced.push(await syncLibraryFileToGraph(db, { root: input.root, relativePath: file.relativePath }));
    }

    const applied = {
      files,
      objectKeys: reserved.proposal.objectKeys,
    };
    await upsertRuntimeResourcePg(db, {
      id: reserved.resourceId,
      resourceType: LIBRARY_IMPORT_DRAFT_RESOURCE_TYPE,
      resourceKey: input.draftId,
      scope: "library",
      status: "approved",
      title: reserved.title,
      payload: {
        ...withoutLastError(reserved.payload),
        status: "approved",
        approval: reserved.approval,
        applied,
      },
      summary: {
        ...reserved.summary,
        status: "approved",
        approvedBy: reserved.approval.actor,
        objectKeys: reserved.proposal.objectKeys,
        filePaths: files.map((file) => file.relativePath),
      },
    });

    return { draftId: input.draftId, status: "approved", proposal: reserved.proposal, files, synced };
  } catch (error) {
    await markLibraryImportDraftApplyFailed(db, reserved, error);
    throw error;
  }
}

function preflightLibraryImportProposal(proposal: LibraryPromptImportProposal): void {
  for (const file of proposal.files) {
    const parsed = parseLibraryFileContent({ path: `library/${file.relativePath}`, content: file.content });
    if (!parsed.ok) {
      throw new Error(
        `library file is invalid: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      );
    }
    validateLibraryFileGraphReferences(parsed.file);
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
      const approval = asApproval(payload.approval) ?? {
        actor: input.actor,
        reason: input.reason,
        approvedAt: new Date().toISOString(),
      };
      return {
        kind: "apply",
        resourceId: resource.id,
        title,
        payload,
        summary,
        proposal,
        approval,
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
    await tx.query(
      `update southstar.runtime_resources
          set status = 'applying',
              payload_json = $2::jsonb,
              summary_json = $3::jsonb,
              updated_at = now()
        where id = $1`,
      [
        resource.id,
        JSON.stringify({ ...payload, status: "applying", approval }),
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
      where id = $1 and status = 'applying'`,
    [
      reserved.resourceId,
      JSON.stringify({
        ...reserved.payload,
        status: "draft",
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

function withoutLastError(payload: Record<string, unknown>): Record<string, unknown> {
  const { lastError: _lastError, ...rest } = payload;
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
  return { files, objectKeys };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  return {};
}
