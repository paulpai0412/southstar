import { createHash } from "node:crypto";
import type { SouthstarDb } from "../../db/postgres.ts";
import {
  getResourceByKeyPg,
  insertRuntimeResourceIfAbsentPg,
  upsertRuntimeResourcePg,
} from "../../stores/postgres-runtime-store.ts";
import {
  appendLibraryHistoryEvent,
  deactivateOutgoingLibraryEdges,
  findLibraryObjectByKeyForUpdate,
  listFileBackedLibraryObjectsForUpdate,
  updateLibraryObjectStatus,
} from "../library-graph-store.ts";
import type { LibraryDefinitionKind } from "../types.ts";
import {
  libraryFileReferences,
  listLibraryFiles,
  readLibraryFile,
  syncLibraryFileRecordsToGraphPg,
} from "./library-file-store.ts";
import type { LibraryFileRecord } from "./library-file-types.ts";

export type LibraryFileDiagnostic = {
  code:
    | "parse_invalid"
    | "duplicate_object_key"
    | "missing_reference"
    | "required_purpose_cardinality"
    | "required_purpose_content";
  message: string;
  fatal: boolean;
  paths: string[];
  objectKey?: string;
  missingRefs: string[];
};

export type LibraryFileCatalog = {
  root: string;
  records: LibraryFileRecord[];
  diagnostics: LibraryFileDiagnostic[];
};

export type ClosedApprovedLibraryFileSet = {
  included: LibraryFileRecord[];
  excluded: Array<LibraryFileDiagnostic & { objectKey: string }>;
  diagnostics: LibraryFileDiagnostic[];
};

export async function loadLibraryFileCatalog(input: { root: string }): Promise<LibraryFileCatalog> {
  const entries = await listLibraryFiles(input);
  const reads = await Promise.all(
    entries.map((entry) => readLibraryFile({ root: input.root, relativePath: entry.relativePath })),
  );
  const records: LibraryFileRecord[] = [];
  const diagnostics: LibraryFileDiagnostic[] = [];
  for (const read of reads) {
    if (read.parsed.ok) {
      records.push(read.parsed.file);
      continue;
    }
    diagnostics.push({
      code: "parse_invalid",
      message: read.parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      fatal: read.parsed.metadata?.status === "approved" || read.parsed.metadata?.status === undefined,
      paths: [`library/${read.relativePath}`],
      objectKey: read.parsed.metadata?.objectKey,
      missingRefs: [],
    });
  }
  return {
    root: input.root,
    records: records.sort((a, b) => a.path.localeCompare(b.path)),
    diagnostics,
  };
}

export function resolveClosedApprovedLibraryFileSet(records: LibraryFileRecord[]): ClosedApprovedLibraryFileSet {
  const byKey = new Map<string, LibraryFileRecord[]>();
  for (const record of records) {
    byKey.set(record.objectKey, [...(byKey.get(record.objectKey) ?? []), record]);
  }

  const diagnostics: LibraryFileDiagnostic[] = [];
  for (const [objectKey, matches] of byKey) {
    if (matches.length > 1) {
      diagnostics.push({
        code: "duplicate_object_key",
        message: `duplicate Library object key ${objectKey}`,
        fatal: true,
        paths: matches.map((item) => item.path).sort(),
        objectKey,
        missingRefs: [],
      });
    }
  }
  diagnostics.sort((a, b) => (a.objectKey ?? "").localeCompare(b.objectKey ?? ""));
  if (diagnostics.length > 0) return { included: [], excluded: [], diagnostics };

  const approved = records.filter((record) => record.status === "approved");
  const candidates = new Map(approved.map((record) => [record.objectKey, record]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [objectKey, record] of [...candidates]) {
      const missing = libraryFileReferences(record).filter((ref) => !candidates.has(ref));
      if (missing.length === 0) continue;
      candidates.delete(objectKey);
      changed = true;
    }
  }

  const excluded = approved
    .filter((record) => !candidates.has(record.objectKey))
    .map((record) => ({
      code: "missing_reference" as const,
      message: `${record.objectKey} is excluded because required references are not in the approved closed set`,
      fatal: false,
      paths: [record.path],
      objectKey: record.objectKey,
      missingRefs: libraryFileReferences(record).filter((ref) => !candidates.has(ref)),
    }))
    .sort((a, b) => a.objectKey.localeCompare(b.objectKey));

  return {
    included: [...candidates.values()].sort((a, b) => a.objectKey.localeCompare(b.objectKey)),
    excluded,
    diagnostics,
  };
}

export function validateRequiredLibraryPurposes(records: LibraryFileRecord[]): LibraryFileDiagnostic[] {
  const diagnostics: LibraryFileDiagnostic[] = [];
  for (const purpose of ["goal_design", "composer_guidance"] as const) {
    const matches = records.filter(
      (record) => record.objectKind === "skill_spec" && record.definition.purpose === purpose,
    );
    if (matches.length !== 1) {
      diagnostics.push({
        code: "required_purpose_cardinality",
        message: `expected exactly one approved ${purpose} skill, found ${matches.length}`,
        fatal: true,
        paths: matches.map((item) => item.path).sort(),
        missingRefs: [],
      });
      continue;
    }
    if (!matches[0]!.body.trim()) {
      diagnostics.push({
        code: "required_purpose_content",
        message: `${purpose} skill must contain a non-empty instruction body`,
        fatal: true,
        paths: [matches[0]!.path],
        objectKey: matches[0]!.objectKey,
        missingRefs: [],
      });
    }
  }
  return diagnostics;
}

export type LibraryReconcileTrigger = "startup" | "library_save" | "import_approval";

export type LibraryReconcileResult = {
  schemaVersion: "southstar.library_sync_snapshot.v1";
  snapshotHash: string;
  status: "ready" | "ready_with_warnings";
  sourceRoot: string;
  trigger: LibraryReconcileTrigger;
  included: Array<{
    path: string;
    objectKey: string;
    objectKind: LibraryDefinitionKind;
    sourceHash: string;
    versionRef: string;
  }>;
  excluded: Array<{ path: string; objectKey?: string; reason: string; missingRefs: string[] }>;
  deprecatedObjectKeys: string[];
  warnings: string[];
};

export type LibraryReadiness = {
  schemaVersion: "southstar.library_readiness.v1";
  ready: true;
  status: "ready" | "ready_with_warnings";
  snapshotHash: string;
  sourceRoot: string;
  reconciledAt: string;
  trigger: LibraryReconcileTrigger;
  includedCount: number;
  excludedCount: number;
  diagnostics: LibraryFileDiagnostic[];
};

export class LibraryReconcileError extends Error {
  readonly code = "library_reconcile_failed";

  constructor(readonly diagnostics: LibraryFileDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join("; "));
  }
}

export class LibraryNotReadyError extends Error {
  readonly code = "library_not_ready";
  readonly status = 503;

  constructor(readonly diagnostics: LibraryFileDiagnostic[], message = "Library reconciliation has not produced a ready snapshot") {
    super(message);
  }
}

function snapshotHash(records: LibraryFileRecord[]): string {
  const canonical = records
    .map((record) => ({
      path: record.path,
      objectKey: record.objectKey,
      objectKind: record.objectKind,
      status: record.status,
      sourceHash: record.sourceHash,
      refs: libraryFileReferences(record),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function loadLibraryReadinessPg(db: SouthstarDb): Promise<LibraryReadiness | null> {
  const resource = await getResourceByKeyPg(db, "library_readiness", "library-readiness:current");
  return resource ? resource.payload as LibraryReadiness : null;
}

export async function requireLibraryReadinessPg(db: SouthstarDb): Promise<LibraryReadiness> {
  const readiness = await loadLibraryReadinessPg(db);
  if (!readiness?.ready) throw new LibraryNotReadyError([]);
  return readiness;
}

export async function reconcileLibraryFilesPg(
  db: SouthstarDb,
  input: { root: string; trigger: LibraryReconcileTrigger },
): Promise<LibraryReconcileResult> {
  const catalog = await loadLibraryFileCatalog({ root: input.root });
  const { result } = await reconcileLibraryCatalogPg(db, { ...input, catalog });
  return result;
}

export async function reconcileLibraryCatalogPg(
  db: SouthstarDb,
  input: {
    catalog: LibraryFileCatalog;
    root: string;
    trigger: LibraryReconcileTrigger;
    rejectExistingObjectKeys?: ReadonlySet<string>;
  },
): Promise<{ result: LibraryReconcileResult; graphSync: Awaited<ReturnType<typeof syncLibraryFileRecordsToGraphPg>> }> {
  const catalog = input.catalog;
  const closed = resolveClosedApprovedLibraryFileSet(catalog.records);
  const purposeDiagnostics = validateRequiredLibraryPurposes(closed.included);
  const fatal = [...catalog.diagnostics, ...closed.diagnostics, ...purposeDiagnostics].filter((item) => item.fatal);
  if (fatal.length > 0) throw new LibraryReconcileError(fatal);
  const hash = snapshotHash(catalog.records);

  return db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", ["southstar.library.reconcile.v1"]);
    const existing = await listFileBackedLibraryObjectsForUpdate(tx);
    for (const objectKey of [...(input.rejectExistingObjectKeys ?? [])].sort()) {
      if (await findLibraryObjectByKeyForUpdate(tx, objectKey)) {
        throw new Error(`library import object already exists: ${objectKey}`);
      }
    }
    const existingByKey = new Map(existing.map((item) => [item.objectKey, item]));
    const effectiveExecutable = closed.included.filter((file) => {
      const current = existingByKey.get(file.objectKey);
      const versionRef = `${file.objectKey}@${file.sourceHash.slice(0, 12)}`;
      return !(current?.headVersionId === versionRef && (current.status === "blocked" || current.status === "deprecated"));
    });
    const effectivePurposeDiagnostics = validateRequiredLibraryPurposes(effectiveExecutable);
    if (effectivePurposeDiagnostics.length > 0) throw new LibraryReconcileError(effectivePurposeDiagnostics);

    const includedKeys = new Set(effectiveExecutable.map((item) => item.objectKey));
    const excludedKeys = new Set(closed.excluded.map((item) => item.objectKey));
    const nonExecutableStatus = (file: LibraryFileRecord): "draft" | "deprecated" | "blocked" => {
      const current = existingByKey.get(file.objectKey);
      const versionRef = `${file.objectKey}@${file.sourceHash.slice(0, 12)}`;
      if (current?.headVersionId === versionRef && (current.status === "blocked" || current.status === "deprecated")) {
        return current.status;
      }
      if (excludedKeys.has(file.objectKey)) return "blocked";
      if (file.status === "deprecated" || file.status === "blocked") return file.status;
      return "draft";
    };
    const nonExecutable = catalog.records
      .filter((file) => !includedKeys.has(file.objectKey))
      .map((file) => ({
        file,
        status: nonExecutableStatus(file),
        reason: excludedKeys.has(file.objectKey) ? "reference closure incomplete" : undefined,
      }));

    const graphSync = await syncLibraryFileRecordsToGraphPg(tx, { executable: effectiveExecutable, nonExecutable });
    const presentKeys = new Set(catalog.records.map((item) => item.objectKey));
    const deprecatedObjectKeys: string[] = [];
    for (const object of existing) {
      if (presentKeys.has(object.objectKey)) continue;
      if (object.status === "deprecated") continue;
      await updateLibraryObjectStatus(tx, { objectKey: object.objectKey, status: "deprecated" });
      await deactivateOutgoingLibraryEdges(tx, object.objectKey);
      await appendLibraryHistoryEvent(tx, {
        objectId: object.id,
        eventType: "file_deprecated",
        payload: { objectKey: object.objectKey, snapshotHash: hash, trigger: input.trigger },
      });
      deprecatedObjectKeys.push(object.objectKey);
    }

    for (const object of graphSync.objects) {
      const before = existing.find((item) => item.objectKey === object.objectKey);
      if (before?.headVersionId === object.headVersionId && before.status === object.status) continue;
      await appendLibraryHistoryEvent(tx, {
        objectId: object.id,
        eventType: "file_reconciled",
        payload: {
          objectKey: object.objectKey,
          previousVersionRef: before?.headVersionId ?? null,
          versionRef: object.headVersionId,
          status: object.status,
          snapshotHash: hash,
          trigger: input.trigger,
        },
      });
    }

    const diagnostics = [...catalog.diagnostics, ...closed.excluded];
    const result: LibraryReconcileResult = {
      schemaVersion: "southstar.library_sync_snapshot.v1",
      snapshotHash: hash,
      status: diagnostics.length > 0 ? "ready_with_warnings" : "ready",
      sourceRoot: input.root,
      trigger: input.trigger,
      included: effectiveExecutable.map((file) => ({
        path: file.path,
        objectKey: file.objectKey,
        objectKind: file.objectKind,
        sourceHash: file.sourceHash,
        versionRef: `${file.objectKey}@${file.sourceHash.slice(0, 12)}`,
      })),
      excluded: diagnostics.map((item) => ({
        path: item.paths[0] ?? "",
        objectKey: item.objectKey,
        reason: item.message,
        missingRefs: item.missingRefs,
      })),
      deprecatedObjectKeys: deprecatedObjectKeys.sort(),
      warnings: diagnostics.map((item) => item.message),
    };
    const reconciledAt = new Date().toISOString();
    const readiness: LibraryReadiness = {
      schemaVersion: "southstar.library_readiness.v1",
      ready: true,
      status: result.status,
      snapshotHash: hash,
      sourceRoot: input.root,
      reconciledAt,
      trigger: input.trigger,
      includedCount: result.included.length,
      excludedCount: result.excluded.length,
      diagnostics,
    };
    await insertRuntimeResourceIfAbsentPg(tx, {
      resourceType: "library_sync_snapshot",
      resourceKey: `library-sync:${hash}`,
      scope: "runtime",
      status: result.status,
      title: `Library sync ${hash.slice(0, 12)}`,
      payload: result,
      summary: result.status,
      metrics: { included: result.included.length, excluded: result.excluded.length },
    });
    await upsertRuntimeResourcePg(tx, {
      resourceType: "library_readiness",
      resourceKey: "library-readiness:current",
      scope: "runtime",
      status: result.status,
      title: "Current Library readiness",
      payload: readiness,
      summary: result.status,
      metrics: { included: result.included.length, excluded: result.excluded.length },
    });
    return { result, graphSync };
  });
}
