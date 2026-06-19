// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { contentHashForPayload } from "./canonical-json.ts";
import type {
  LibraryActorType,
  LibraryDefinitionKind,
  LibraryDefinitionStatus,
  LibraryDraftStatus,
} from "./types.ts";

type SqlValue = string | number | bigint | Buffer | null;

type LibraryObjectRow = {
  id: string;
  object_key: string;
  object_kind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  head_version_id: string | null;
  state_json: string;
};

export type LibraryObjectRecord = {
  objectId: string;
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  headVersionId?: string;
  status: LibraryDefinitionStatus;
  state: Record<string, unknown>;
};

export type LibraryVersionRecord = {
  versionId: string;
  objectId: string;
  definitionKind: LibraryDefinitionKind;
  payload: unknown;
  contentHash: string;
  createdBy: LibraryActorType;
};

export function createLibraryObject(db: SouthstarDb, input: {
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  state: Record<string, unknown>;
  actorType: LibraryActorType;
}): { objectId: string } {
  const now = new Date().toISOString();
  const id = `obj-${randomUUID()}`;
  db.prepare(`
    insert into library_objects (id, object_key, object_kind, status, head_version_id, state_json, created_at, updated_at)
    values (?, ?, ?, ?, null, ?, ?, ?)
  `).run(id, input.objectKey, input.objectKind, input.status, JSON.stringify(input.state), now, now);
  appendLibraryHistory(db, {
    objectId: id,
    eventType: "object.created",
    actorType: input.actorType,
    payload: {
      objectKey: input.objectKey,
      objectKind: input.objectKind,
      status: input.status,
    },
  });
  return { objectId: id };
}

export function findLibraryObjectByKey(db: SouthstarDb, objectKey: string): LibraryObjectRecord | null {
  const row = db.prepare("select * from library_objects where object_key = ?").get(objectKey) as LibraryObjectRow | undefined;
  return row ? mapObject(row) : null;
}

export function getLibraryObject(db: SouthstarDb, objectId: string): LibraryObjectRecord {
  return getLibraryObjectById(db, objectId);
}

export function appendVersionCreated(db: SouthstarDb, input: {
  objectId: string;
  definitionKind: LibraryDefinitionKind;
  versionId: string;
  payload: unknown;
  createdBy: LibraryActorType;
  status: LibraryDefinitionStatus;
}): LibraryVersionRecord {
  if (input.createdBy === "llm" && input.status === "approved") {
    throw new Error("LLM cannot create approved library versions; create draft/proposal events instead");
  }
  const object = getLibraryObjectById(db, input.objectId);
  const now = new Date().toISOString();
  const contentHash = contentHashForPayload(input.payload);
  appendLibraryHistory(db, {
    objectId: input.objectId,
    eventType: "version.created",
    actorType: input.createdBy,
    payload: {
      versionId: input.versionId,
      definitionKind: input.definitionKind,
      payload: input.payload,
      contentHash,
      status: input.status,
      createdAt: now,
    },
  });
  updateLibraryObjectState(db, {
    objectId: input.objectId,
    status: input.status,
    headVersionId: input.versionId,
    state: {
      ...object.state,
      latestVersionId: input.versionId,
      headContentHash: contentHash,
      latestDefinitionKind: input.definitionKind,
    },
  });
  return {
    versionId: input.versionId,
    objectId: input.objectId,
    definitionKind: input.definitionKind,
    payload: input.payload,
    contentHash,
    createdBy: input.createdBy,
  };
}

export function appendDraftEvent(db: SouthstarDb, input: {
  objectId: string;
  eventType: "draft.opened" | "draft.patch_applied" | "draft.validated" | "draft.approved_for_run";
  status: LibraryDraftStatus;
  payload: Record<string, unknown>;
  actorType: LibraryActorType;
}): void {
  const object = getLibraryObjectById(db, input.objectId);
  appendLibraryHistory(db, {
    objectId: input.objectId,
    eventType: input.eventType,
    actorType: input.actorType,
    payload: {
      ...input.payload,
      status: input.status,
    },
  });
  updateLibraryObjectState(db, {
    objectId: input.objectId,
    status: object.status,
    headVersionId: object.headVersionId,
    state: {
      ...object.state,
      draftStatus: input.status,
      latestDraftEventType: input.eventType,
    },
  });
}

export function getLibraryVersion(db: SouthstarDb, versionId: string): LibraryVersionRecord | null {
  const row = db.prepare(`
    select object_id, actor_type, payload_json
    from library_history
    where event_type = 'version.created'
      and json_extract(payload_json, '$.versionId') = ?
    order by created_at desc
    limit 1
  `).get(versionId) as { object_id: string; actor_type: LibraryActorType; payload_json: string } | undefined;
  if (!row) return null;
  const payload = JSON.parse(row.payload_json) as {
    versionId: string;
    definitionKind: LibraryDefinitionKind;
    payload: unknown;
    contentHash: string;
  };
  return {
    versionId: payload.versionId,
    objectId: row.object_id,
    definitionKind: payload.definitionKind,
    payload: payload.payload,
    contentHash: payload.contentHash,
    createdBy: row.actor_type,
  };
}

export function listLibraryVersions(db: SouthstarDb, objectId: string): LibraryVersionRecord[] {
  const rows = db.prepare(`
    select actor_type, payload_json
    from library_history
    where object_id = ? and event_type = 'version.created'
    order by sequence
  `).all(objectId) as Array<{ actor_type: LibraryActorType; payload_json: string }>;
  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as {
      versionId: string;
      definitionKind: LibraryDefinitionKind;
      payload: unknown;
      contentHash: string;
    };
    return {
      versionId: payload.versionId,
      objectId,
      definitionKind: payload.definitionKind,
      payload: payload.payload,
      contentHash: payload.contentHash,
      createdBy: row.actor_type,
    };
  });
}

export function listLibraryHistory(db: SouthstarDb, input: {
  objectId: string;
}): Array<{ sequence: number; eventType: string; actorType: string; payload: unknown }> {
  return (db.prepare(`
    select sequence, event_type, actor_type, payload_json
    from library_history
    where object_id = ?
    order by sequence
  `).all(input.objectId) as Array<{ sequence: number; event_type: string; actor_type: string; payload_json: string }>).map((row) => ({
    sequence: row.sequence,
    eventType: row.event_type,
    actorType: row.actor_type,
    payload: JSON.parse(row.payload_json),
  }));
}

export function appendLibraryHistory(db: SouthstarDb, input: {
  objectId: string;
  eventType: string;
  actorType: LibraryActorType;
  payload: unknown;
}): { historyId: string; sequence: number } {
  const id = `hist-${randomUUID()}`;
  const sequence = (db.prepare(`
    select coalesce(max(sequence), 0) + 1 as next
    from library_history
    where object_id = ?
  `).get(input.objectId as SqlValue) as { next: number }).next;
  db.prepare(`
    insert into library_history (id, object_id, sequence, event_type, actor_type, payload_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.objectId, sequence, input.eventType, input.actorType, JSON.stringify(input.payload), new Date().toISOString());
  return { historyId: id, sequence };
}

function getLibraryObjectById(db: SouthstarDb, objectId: string): LibraryObjectRecord {
  const row = db.prepare("select * from library_objects where id = ?").get(objectId) as LibraryObjectRow | undefined;
  if (!row) throw new Error(`library object not found: ${objectId}`);
  return mapObject(row);
}

export function updateLibraryObjectState(db: SouthstarDb, input: {
  objectId: string;
  status: LibraryDefinitionStatus;
  headVersionId?: string;
  state: Record<string, unknown>;
}): void {
  db.prepare(`
    update library_objects
    set status = ?,
        head_version_id = ?,
        state_json = ?,
        updated_at = ?
    where id = ?
  `).run(
    input.status,
    input.headVersionId ?? null,
    JSON.stringify(input.state),
    new Date().toISOString(),
    input.objectId,
  );
}

function mapObject(row: LibraryObjectRow): LibraryObjectRecord {
  return {
    objectId: row.id,
    objectKey: row.object_key,
    objectKind: row.object_kind,
    headVersionId: row.head_version_id ?? undefined,
    status: row.status,
    state: JSON.parse(row.state_json) as Record<string, unknown>,
  };
}
