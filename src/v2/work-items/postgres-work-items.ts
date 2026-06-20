import type { SouthstarDb } from "../db/postgres.ts";
import type { CreateWorkItemInput, WorkItemRecord, WorkItemRunRef, WorkItemSourceProvider } from "./types.ts";

type WorkItemRow = {
  id: string;
  source_provider: WorkItemSourceProvider;
  source_ref: string | null;
  source_url: string | null;
  title: string;
  domain: string;
  status: WorkItemRecord["status"];
  run_refs_json: WorkItemRunRef[] | string;
  metadata_json: Record<string, unknown> | string;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function createWorkItemPg(db: SouthstarDb, input: CreateWorkItemInput): Promise<WorkItemRecord> {
  const sourceUrl = input.sourceUrl ?? (typeof input.metadata?.sourceUrl === "string" ? input.metadata.sourceUrl : null);
  const metadata = input.metadata ?? {};
  const row = input.sourceRef
    ? await db.one<WorkItemRow>(
        `insert into southstar.work_items (
          id, source_provider, source_ref, source_url, title, domain, status, metadata_json, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), now())
        on conflict(source_provider, source_ref) where source_ref is not null do update set
          source_url = excluded.source_url,
          title = excluded.title,
          domain = excluded.domain,
          status = excluded.status,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
        returning *`,
        [
          input.id,
          input.sourceProvider,
          input.sourceRef,
          sourceUrl,
          input.title,
          input.domain,
          input.status,
          JSON.stringify(metadata),
        ],
      )
    : await db.one<WorkItemRow>(
        `insert into southstar.work_items (
          id, source_provider, source_ref, source_url, title, domain, status, metadata_json, created_at, updated_at
        ) values ($1, $2, null, $3, $4, $5, $6, $7::jsonb, now(), now())
        on conflict(id) do update set
          source_url = excluded.source_url,
          title = excluded.title,
          domain = excluded.domain,
          status = excluded.status,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
        returning *`,
        [
          input.id,
          input.sourceProvider,
          sourceUrl,
          input.title,
          input.domain,
          input.status,
          JSON.stringify(metadata),
        ],
      );
  return mapRow(row);
}

export async function getWorkItemPg(db: SouthstarDb, id: string): Promise<WorkItemRecord | null> {
  const row = await db.maybeOne<WorkItemRow>("select * from southstar.work_items where id = $1", [id]);
  return row ? mapRow(row) : null;
}

export async function linkRunToWorkItemPg(db: SouthstarDb, input: { workItemId: string; runId: string; runAttempt: number }): Promise<void> {
  await db.tx(async (tx) => {
    const row = await tx.one<Pick<WorkItemRow, "run_refs_json">>(
      "select run_refs_json from southstar.work_items where id = $1 for update",
      [input.workItemId],
    );
    const existing = parseRunRefs(row.run_refs_json);
    const nextRef = { runId: input.runId, runAttempt: input.runAttempt };
    const nextRunRefs = [...existing.filter((ref) => ref.runId !== input.runId), nextRef];

    await tx.query(
      "update southstar.work_items set run_refs_json = $1::jsonb, updated_at = now() where id = $2",
      [JSON.stringify(nextRunRefs), input.workItemId],
    );

    const runUpdate = await tx.query(
      `update southstar.workflow_runs
       set runtime_context_json = jsonb_set(
         runtime_context_json,
         '{workItemRef}',
         $1::jsonb,
         true
       ),
       updated_at = now()
       where id = $2`,
      [JSON.stringify({ workItemId: input.workItemId, runAttempt: input.runAttempt }), input.runId],
    );
    if ((runUpdate.rowCount ?? 0) !== 1) {
      throw new Error(`workflow run not found: ${input.runId}`);
    }
  });
}

function mapRow(row: WorkItemRow): WorkItemRecord {
  return {
    id: row.id,
    sourceProvider: row.source_provider,
    sourceRef: row.source_ref ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    title: row.title,
    domain: row.domain,
    status: row.status,
    runRefs: parseRunRefs(row.run_refs_json),
    metadata: parseMetadata(row.metadata_json),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
  };
}

function parseRunRefs(value: WorkItemRunRef[] | string): WorkItemRunRef[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((ref) => {
    const raw = ref as { runId?: unknown; runAttempt?: unknown; statusAtLink?: unknown; reason?: unknown; createdAt?: unknown };
    return {
      runId: String(raw.runId),
      runAttempt: Number(raw.runAttempt),
      ...(typeof raw.statusAtLink === "string" ? { statusAtLink: raw.statusAtLink } : {}),
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
      ...(typeof raw.createdAt === "string" ? { createdAt: raw.createdAt } : {}),
    };
  });
}

function parseMetadata(value: Record<string, unknown> | string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
