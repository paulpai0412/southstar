import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type {
  LibraryDefinitionKind,
  LibraryDefinitionStatus,
  LibraryEdgeRecord,
  LibraryEdgeType,
  LibraryObjectSummary,
} from "./types.ts";

export type UpsertLibraryObjectInput = {
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  headVersionId?: string;
  state: Record<string, unknown>;
};

export type UpsertLibraryEdgeInput = {
  fromObjectKey: string;
  fromVersionRef?: string;
  edgeType: LibraryEdgeType;
  toObjectKey: string;
  toVersionRef?: string;
  scope?: string;
  status?: LibraryEdgeStatus;
  weight?: number;
  metadata?: Record<string, unknown>;
};

export type LibraryEdgeIdentityInput = {
  edgeType: LibraryEdgeType;
  toObjectKey: string;
  scope?: string;
};

export type FindLibraryEdgesFilters = {
  scope?: string;
  status?: LibraryEdgeStatus;
};

export type ListLibraryObjectsInput = {
  scope?: string;
  status?: LibraryDefinitionStatus;
  objectKind?: LibraryDefinitionKind;
};

export type ListLibraryEdgesInput = {
  scope?: string;
  status?: LibraryEdgeStatus;
};

export type DeleteLibraryObjectResult = {
  object: LibraryObjectSummary;
  deletedObjectKey: string;
  deletedObjectCount: number;
  deletedEdgeCount: number;
  inboundEdgeCount: number;
  outboundEdgeCount: number;
};

export async function upsertLibraryObject(db: SouthstarDb, input: UpsertLibraryObjectInput): Promise<LibraryObjectSummary> {
  const id = `lib-${hash(input.objectKey).slice(0, 16)}`;
  const row = await db.one<LibraryObjectRow>(
    `insert into southstar.library_objects (
       id, object_key, object_kind, status, head_version_id, state_json, updated_at
     ) values ($1, $2, $3, $4, $5, $6::jsonb, now())
     on conflict(object_key) do update set
       object_kind = excluded.object_kind,
       status = excluded.status,
       head_version_id = excluded.head_version_id,
       state_json = excluded.state_json,
       updated_at = now()
     returning id, object_key, object_kind, status, head_version_id, state_json`,
    [id, input.objectKey, input.objectKind, input.status, input.headVersionId ?? null, JSON.stringify(input.state)],
  );
  return mapObject(row);
}

export async function createLibraryObject(db: SouthstarDb, input: UpsertLibraryObjectInput): Promise<LibraryObjectSummary> {
  const id = `lib-${hash(input.objectKey).slice(0, 16)}`;
  try {
    const row = await db.one<LibraryObjectRow>(
      `insert into southstar.library_objects (
         id, object_key, object_kind, status, head_version_id, state_json, updated_at
       ) values ($1, $2, $3, $4, $5, $6::jsonb, now())
       returning id, object_key, object_kind, status, head_version_id, state_json`,
      [id, input.objectKey, input.objectKind, input.status, input.headVersionId ?? null, JSON.stringify(input.state)],
    );
    return mapObject(row);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "23505") {
      throw new Error(`library object already exists: ${input.objectKey}`);
    }
    throw error;
  }
}

export async function upsertLibraryEdge(db: SouthstarDb, input: UpsertLibraryEdgeInput): Promise<LibraryEdgeRecord> {
  const id = `edge-${hash([
    input.fromObjectKey,
    input.fromVersionRef ?? "",
    input.edgeType,
    input.toObjectKey,
    input.toVersionRef ?? "",
    input.scope ?? "global",
  ].join("|")).slice(0, 20)}`;
  const row = await db.one<LibraryEdgeRow>(
    `insert into southstar.library_edges (
       id, from_object_key, from_version_ref, edge_type, to_object_key, to_version_ref,
       scope, status, weight, metadata_json
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     on conflict(id) do update set
       from_version_ref = excluded.from_version_ref,
       to_version_ref = excluded.to_version_ref,
       status = excluded.status,
       weight = excluded.weight,
       metadata_json = excluded.metadata_json
     returning
       id, from_object_key, from_version_ref, edge_type, to_object_key, to_version_ref,
       scope, status, weight, metadata_json`,
    [
      id,
      input.fromObjectKey,
      input.fromVersionRef ?? null,
      input.edgeType,
      input.toObjectKey,
      input.toVersionRef ?? null,
      input.scope ?? "global",
      input.status ?? "active",
      input.weight ?? 1,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return mapEdge(row);
}

export async function deactivateLibraryEdgesForSourceExcept(
  db: SouthstarDb,
  input: {
    fromObjectKey: string;
    sourcePath: string;
    keepEdges: LibraryEdgeIdentityInput[];
  },
): Promise<number> {
  const active = await db.query<Pick<LibraryEdgeRow, "id" | "edge_type" | "to_object_key" | "scope">>(
    `select id, edge_type, to_object_key, scope
       from southstar.library_edges
      where from_object_key = $1
        and status = 'active'
        and metadata_json->>'sourcePath' = $2`,
    [input.fromObjectKey, input.sourcePath],
  );
  const keep = new Set(input.keepEdges.map(edgeIdentityKey));
  const staleIds = active.rows
    .filter((row) => !keep.has(edgeIdentityKey({
      edgeType: row.edge_type,
      toObjectKey: row.to_object_key,
      scope: row.scope,
    })))
    .map((row) => row.id);
  if (staleIds.length === 0) return 0;
  const result = await db.query(
    `update southstar.library_edges
        set status = 'inactive'
      where id = any($1::text[])`,
    [staleIds],
  );
  return result.rowCount ?? 0;
}

export async function findApprovedLibraryObjectsByKind(
  db: SouthstarDb,
  objectKind: LibraryDefinitionKind,
  scope?: string,
): Promise<LibraryObjectSummary[]> {
  const normalizedScope = normalizeScopeInput(scope);
  const result = await db.query<LibraryObjectRow>(
    `select id, object_key, object_kind, status, head_version_id, state_json
       from southstar.library_objects
      where object_kind = $1
        and status = 'approved'
        and ($2::text is null or state_json->>'scope' = $2 or state_json->'domainRefs' ? $2)
      order by object_key`,
    [objectKind, normalizedScope ?? null],
  );
  return result.rows.map(mapObject);
}

export async function findLibraryObjectByKey(db: SouthstarDb, objectKey: string): Promise<LibraryObjectSummary | null> {
  const row = await db.maybeOne<LibraryObjectRow>(
    `select id, object_key, object_kind, status, head_version_id, state_json
       from southstar.library_objects
      where object_key = $1`,
    [objectKey],
  );
  return row ? mapObject(row) : null;
}

export async function findLibraryObjectByKeyForUpdate(
  db: SouthstarDb,
  objectKey: string,
): Promise<LibraryObjectSummary | null> {
  const row = await db.maybeOne<LibraryObjectRow>(
    `select id, object_key, object_kind, status, head_version_id, state_json
       from southstar.library_objects
      where object_key = $1
      for update`,
    [objectKey],
  );
  return row ? mapObject(row) : null;
}

export async function listFileBackedLibraryObjectsForUpdate(db: SouthstarDb): Promise<LibraryObjectSummary[]> {
  const result = await db.query<LibraryObjectRow>(
    `select id, object_key, object_kind, status, head_version_id, state_json
       from southstar.library_objects
      where state_json->>'sourcePath' like 'library/%'
      order by object_key
      for update`,
  );
  return result.rows.map(mapObject);
}

export async function deactivateOutgoingLibraryEdges(db: SouthstarDb, objectKey: string): Promise<number> {
  const result = await db.query(
    `update southstar.library_edges
        set status = 'inactive'
      where from_object_key = $1 and status = 'active'`,
    [objectKey],
  );
  return result.rowCount ?? 0;
}

export async function appendLibraryHistoryEvent(db: SouthstarDb, input: {
  objectId: string;
  eventType: "file_reconciled" | "file_deprecated";
  payload: Record<string, unknown>;
}): Promise<void> {
  const next = await db.one<{ sequence: number }>(
    `select coalesce(max(sequence), 0) + 1 as sequence
       from southstar.library_history
      where object_id = $1`,
    [input.objectId],
  );
  const id = `libhist-${createHash("sha256")
    .update(`${input.objectId}|${next.sequence}|${input.eventType}`)
    .digest("hex").slice(0, 20)}`;
  await db.query(
    `insert into southstar.library_history (
       id, object_id, sequence, event_type, actor_type, payload_json
     ) values ($1, $2, $3, $4, 'library_reconcile', $5::jsonb)`,
    [id, input.objectId, next.sequence, input.eventType, JSON.stringify(input.payload)],
  );
}

export async function updateLibraryObjectStatus(
  db: SouthstarDb,
  input: { objectKey: string; status: LibraryDefinitionStatus },
): Promise<LibraryObjectSummary> {
  const row = await db.maybeOne<LibraryObjectRow>(
    `update southstar.library_objects
        set status = $2,
            state_json = jsonb_set(coalesce(state_json, '{}'::jsonb), '{status}', to_jsonb($2::text), true),
            updated_at = now()
      where object_key = $1
      returning id, object_key, object_kind, status, head_version_id, state_json`,
    [input.objectKey, input.status],
  );
  if (!row) throw new Error(`library object not found: ${input.objectKey}`);
  return mapObject(row);
}

export async function deleteLibraryObject(db: SouthstarDb, objectKey: string): Promise<DeleteLibraryObjectResult | null> {
  return await db.tx(async (tx) => {
    const object = await findLibraryObjectByKeyForUpdate(tx, objectKey);
    if (!object) return null;

    const edgeCounts = await tx.one<{ inbound_count: string; outbound_count: string; edge_count: string }>(
      `select
          count(*) filter (where to_object_key = $1) as inbound_count,
          count(*) filter (where from_object_key = $1) as outbound_count,
          count(*) as edge_count
         from southstar.library_edges
        where from_object_key = $1
           or to_object_key = $1`,
      [objectKey],
    );
    const deleted = await tx.query(
      `delete from southstar.library_objects
        where object_key = $1`,
      [objectKey],
    );

    return {
      object,
      deletedObjectKey: objectKey,
      deletedObjectCount: deleted.rowCount ?? 0,
      deletedEdgeCount: Number(edgeCounts.edge_count),
      inboundEdgeCount: Number(edgeCounts.inbound_count),
      outboundEdgeCount: Number(edgeCounts.outbound_count),
    };
  });
}

export async function listLibraryObjects(
  db: SouthstarDb,
  input: ListLibraryObjectsInput = {},
): Promise<LibraryObjectSummary[]> {
  const scope = normalizeScopeInput(input.scope);
  const result = await db.query<LibraryObjectRow>(
    `select id, object_key, object_kind, status, head_version_id, state_json
       from southstar.library_objects
      where ($1::text is null or status = $1)
        and ($2::text is null or object_kind = $2)
        and (
          $3::text is null
          or coalesce(state_json->>'scope', 'global') = $3
          or coalesce(state_json->>'scope', 'global') = 'global'
          or state_json->'domainRefs' ? $3
        )
      order by coalesce(state_json->>'scope', 'global'), object_kind, object_key`,
    [input.status ?? null, input.objectKind ?? null, scope ?? null],
  );
  return result.rows.map(mapObject);
}

export async function listLibraryEdges(db: SouthstarDb, input: ListLibraryEdgesInput = {}): Promise<LibraryEdgeRecord[]> {
  const scope = normalizeScopeInput(input.scope);
  const result = await db.query<LibraryEdgeRow>(
    `select
        id, from_object_key, from_version_ref, edge_type, to_object_key, to_version_ref,
        scope, status, weight, metadata_json
       from southstar.library_edges
      where ($1::text is null or scope = $1 or scope = 'global')
        and status = $2
      order by scope, edge_type, from_object_key, to_object_key`,
    [scope ?? null, input.status ?? "active"],
  );
  return result.rows.map(mapEdge);
}

export async function findLibraryEdgesFrom(
  db: SouthstarDb,
  fromObjectKey: string,
  edgeTypeOrFilters?: LibraryEdgeType | FindLibraryEdgesFilters,
  filters?: FindLibraryEdgesFilters,
): Promise<LibraryEdgeRecord[]> {
  const { edgeType, scope, status } = resolveReadFilters(edgeTypeOrFilters, filters);
  const result = await db.query<LibraryEdgeRow>(
    `select
        id, from_object_key, from_version_ref, edge_type, to_object_key, to_version_ref,
        scope, status, weight, metadata_json
       from southstar.library_edges
      where from_object_key = $1
        and ($2::text is null or edge_type = $2)
        and ($3::text is null or scope = $3)
        and status = $4
      order by edge_type, to_object_key`,
    [fromObjectKey, edgeType, scope, status],
  );
  return result.rows.map(mapEdge);
}

export async function findLibraryEdgesTo(
  db: SouthstarDb,
  toObjectKey: string,
  edgeTypeOrFilters?: LibraryEdgeType | FindLibraryEdgesFilters,
  filters?: FindLibraryEdgesFilters,
): Promise<LibraryEdgeRecord[]> {
  const { edgeType, scope, status } = resolveReadFilters(edgeTypeOrFilters, filters);
  const result = await db.query<LibraryEdgeRow>(
    `select
        id, from_object_key, from_version_ref, edge_type, to_object_key, to_version_ref,
        scope, status, weight, metadata_json
       from southstar.library_edges
      where to_object_key = $1
        and ($2::text is null or edge_type = $2)
        and ($3::text is null or scope = $3)
        and status = $4
      order by edge_type, from_object_key`,
    [toObjectKey, edgeType, scope, status],
  );
  return result.rows.map(mapEdge);
}

type LibraryObjectRow = {
  id: string;
  object_key: string;
  object_kind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  head_version_id: string | null;
  state_json: Record<string, unknown>;
};

type LibraryEdgeRow = {
  id: string;
  from_object_key: string;
  from_version_ref: string | null;
  edge_type: LibraryEdgeType;
  to_object_key: string;
  to_version_ref: string | null;
  scope: string;
  status: LibraryEdgeStatus;
  weight: number;
  metadata_json: Record<string, unknown>;
};

export type LibraryEdgeStatus = "active" | "inactive" | "blocked";

function edgeIdentityKey(edge: LibraryEdgeIdentityInput): string {
  return [edge.edgeType, edge.toObjectKey, edge.scope ?? "global"].join("\0");
}

function mapObject(row: LibraryObjectRow): LibraryObjectSummary {
  return {
    id: row.id,
    objectKey: row.object_key,
    objectKind: row.object_kind,
    status: row.status,
    headVersionId: row.head_version_id,
    state: row.state_json,
  };
}

function mapEdge(row: LibraryEdgeRow): LibraryEdgeRecord {
  return {
    id: row.id,
    fromObjectKey: row.from_object_key,
    fromVersionRef: row.from_version_ref,
    edgeType: row.edge_type,
    toObjectKey: row.to_object_key,
    toVersionRef: row.to_version_ref,
    scope: row.scope,
    status: row.status,
    weight: row.weight,
    metadata: row.metadata_json,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeScopeInput(scope: string | undefined): string | undefined {
  return !scope || scope === "all" ? undefined : scope;
}

function resolveReadFilters(
  edgeTypeOrFilters?: LibraryEdgeType | FindLibraryEdgesFilters,
  filters?: FindLibraryEdgesFilters,
): {
  edgeType: LibraryEdgeType | null;
  scope: string | null;
  status: LibraryEdgeStatus;
} {
  const edgeType = typeof edgeTypeOrFilters === "string" ? edgeTypeOrFilters : null;
  const mergedFilters = (typeof edgeTypeOrFilters === "string" ? filters : edgeTypeOrFilters) ?? {};
  return {
    edgeType,
    scope: normalizeScopeInput(mergedFilters.scope) ?? null,
    status: mergedFilters.status ?? "active",
  };
}
