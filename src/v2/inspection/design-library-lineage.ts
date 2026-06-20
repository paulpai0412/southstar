// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { DesignLibraryLineage } from "./types.ts";

type CompiledFrom = {
  objectKey?: string;
  versionId?: string;
  source?: string;
};

export function readDesignLibraryLineage(db: SouthstarDb, input: {
  runId: string;
  workflowManifest: unknown;
}): DesignLibraryLineage {
  if (!hasTable(db, "library_objects") || !hasTable(db, "library_history")) {
    return { available: false, reason: "library_tables_missing" };
  }
  const compiledFrom = compiledFromManifest(input.workflowManifest);
  if (!compiledFrom) {
    return { available: false, reason: "not_compiled_from_library" };
  }
  const sourceObject = compiledFrom.objectKey
    ? db.prepare("select id, object_key, object_kind, status, head_version_id from library_objects where object_key = ?")
      .get(compiledFrom.objectKey) as LibraryObjectRow | undefined
    : undefined;
  const sourceVersion = compiledFrom.versionId
    ? db.prepare(`
        select payload_json
        from library_history
        where event_type = 'version.created'
          and json_extract(payload_json, '$.versionId') = ?
        order by created_at desc
        limit 1
      `).get(compiledFrom.versionId) as { payload_json: string } | undefined
    : undefined;
  if (!sourceObject && !sourceVersion) {
    return { available: false, reason: "lineage_not_found" };
  }
  const validated = db.prepare(`
    select id, payload_json, created_at
    from library_history
    where event_type = 'template.validated_from_run'
      and json_extract(payload_json, '$.runId') = ?
    order by created_at desc
    limit 1
  `).get(input.runId) as { id: string; payload_json: string; created_at: string } | undefined;
  const versionPayload = sourceVersion ? parseJson(sourceVersion.payload_json) as {
    versionId?: string;
    definitionKind?: string;
    contentHash?: string;
  } : undefined;
  const validatedPayload = validated ? parseJson(validated.payload_json) as { templateVersionId?: string } : undefined;
  return {
    available: true,
    compiledFrom,
    sourceObject: sourceObject ? {
      objectId: sourceObject.id,
      objectKey: sourceObject.object_key,
      objectKind: sourceObject.object_kind,
      status: sourceObject.status,
      headVersionId: sourceObject.head_version_id ?? undefined,
    } : undefined,
    sourceVersion: versionPayload ? {
      versionId: String(versionPayload.versionId ?? compiledFrom.versionId ?? "unknown"),
      definitionKind: String(versionPayload.definitionKind ?? "unknown"),
      contentHash: String(versionPayload.contentHash ?? "unknown"),
    } : undefined,
    validatedFromRun: validated ? {
      eventRef: validated.id,
      validatedTemplateVersionId: String(validatedPayload?.templateVersionId ?? "unknown"),
      createdAt: validated.created_at,
    } : undefined,
  };
}

function hasTable(db: SouthstarDb, name: string): boolean {
  const row = db.prepare("select 1 as ok from sqlite_master where type = 'table' and name = ?").get(name) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function compiledFromManifest(value: unknown): CompiledFrom | undefined {
  const manifest = asRecord(value);
  const direct = asRecord(manifest?.compiledFrom);
  const metadata = asRecord(manifest?.metadata);
  const nested = asRecord(metadata?.compiledFrom);
  const compiledFrom = direct ?? nested;
  if (!compiledFrom) return undefined;
  const objectKey = stringOrUndefined(compiledFrom.objectKey) ?? stringOrUndefined(compiledFrom.templateObjectKey);
  const versionId = stringOrUndefined(compiledFrom.versionId) ?? stringOrUndefined(compiledFrom.templateVersionId);
  const source = stringOrUndefined(compiledFrom.source);
  if (!objectKey && !versionId && !source) return undefined;
  return { objectKey, versionId, source };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type LibraryObjectRow = {
  id: string;
  object_key: string;
  object_kind: string;
  status: string;
  head_version_id: string | null;
};
