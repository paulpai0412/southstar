import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { createWorkItemPg, getWorkItemPg } from "./postgres-work-items.ts";
import type { WorkItemIntakeInput, WorkItemIntakePriority, WorkItemIntakeResult, WorkItemRecord, WorkItemRunRef, WorkItemSourceProvider } from "./types.ts";

export const WORK_ITEM_INTAKE_VERSION = "southstar.work_item_intake.v1";

export type LinkRunAttemptFromWorkItemInput = {
  workItemId: string;
  runId: string;
  statusAtLink: string;
  reason: string;
};

export async function intakeWorkItemPg(db: SouthstarDb, input: WorkItemIntakeInput): Promise<WorkItemIntakeResult> {
  const sourceProvider = input.sourceProvider;
  const sourceScope = optionalTrimmed(input.sourceScope);
  const sourceRef = optionalTrimmed(input.sourceRef);
  const sourceUrl = optionalTrimmed(input.sourceUrl);
  const title = requiredTrimmed(input.title, "title");
  const body = input.body ?? "";
  const domain = requiredTrimmed(input.domain, "domain");
  const labels = normalizeLabels(input.labels);
  const priority = priorityValue(input.priority);
  const requestedBy = optionalTrimmed(input.requestedBy);
  const triageState = body.trim().length > 0 ? "ready" : "needs_triage";
  const status: WorkItemRecord["status"] = triageState === "ready" ? "active" : "waiting";
  const existing = sourceRef
    ? await db.maybeOne<{ id: string }>(
        "select id from southstar.work_items where source_provider = $1 and source_ref = $2",
        [sourceProvider, sourceRef],
      )
    : null;

  const metadata = {
    ...(isRecord(input.metadata) ? input.metadata : {}),
    body,
    ...(sourceScope ? { sourceScope } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    priority,
    labels,
    ...(requestedBy ? { requestedBy } : {}),
    triageState,
    intakeVersion: WORK_ITEM_INTAKE_VERSION,
  };
  const record = await createWorkItemPg(db, {
    id: existing?.id ?? workItemId(sourceProvider, sourceRef),
    sourceProvider,
    sourceRef,
    sourceUrl,
    title,
    domain,
    status,
    metadata,
  });
  return { workItemId: record.id, status: record.status, deduped: Boolean(existing) };
}

export async function linkRunAttemptFromWorkItemPg(
  db: SouthstarDb,
  input: LinkRunAttemptFromWorkItemInput,
): Promise<WorkItemRunRef> {
  return await db.tx(async (tx) => {
    const locked = await tx.maybeOne<{ id: string }>(
      "select id from southstar.work_items where id = $1 for update",
      [input.workItemId],
    );
    if (!locked) throw new Error(`work item not found: ${input.workItemId}`);
    const workItem = await getWorkItemPg(tx, input.workItemId);
    if (!workItem) throw new Error(`work item not found: ${input.workItemId}`);

    const runAttempt = nextRunAttempt(workItem.runRefs);
    const runRef: WorkItemRunRef = {
      runId: input.runId,
      runAttempt,
      statusAtLink: input.statusAtLink,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    await tx.query(
      "update southstar.work_items set run_refs_json = $1::jsonb, updated_at = now() where id = $2",
      [JSON.stringify([...workItem.runRefs, runRef]), input.workItemId],
    );

    const workItemRef = {
      workItemId: workItem.id,
      sourceProvider: workItem.sourceProvider,
      ...(workItem.sourceRef ? { sourceRef: workItem.sourceRef } : {}),
      runAttempt,
      intakeVersion: WORK_ITEM_INTAKE_VERSION,
    };
    const runUpdate = await tx.query(
      `update southstar.workflow_runs
          set runtime_context_json = jsonb_set(runtime_context_json, '{workItemRef}', $1::jsonb, true),
              updated_at = now()
        where id = $2`,
      [JSON.stringify(workItemRef), input.runId],
    );
    if ((runUpdate.rowCount ?? 0) !== 1) throw new Error(`workflow run not found: ${input.runId}`);
    return runRef;
  });
}

function nextRunAttempt(runRefs: WorkItemRunRef[]): number {
  const attempts = runRefs.map((ref) => ref.runAttempt).filter((value) => Number.isFinite(value));
  return attempts.length === 0 ? 1 : Math.max(...attempts) + 1;
}

function workItemId(sourceProvider: WorkItemSourceProvider, sourceRef: string | undefined): string {
  if (!sourceRef) return `wi_${randomUUID()}`;
  return `wi_${safeId(sourceProvider)}_${safeId(sourceRef)}`;
}

function priorityValue(priority: WorkItemIntakePriority | undefined): WorkItemIntakePriority {
  return priority ?? "normal";
}

function normalizeLabels(labels: string[] | undefined): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => label.trim()).filter((label) => label.length > 0);
}

function requiredTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} is required`);
  return trimmed;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "source";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
