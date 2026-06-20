import { createHash, randomUUID } from "node:crypto";
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
  const inputLabels = Array.isArray(input.labels) ? normalizeLabels(input.labels) : undefined;
  const requestedBy = optionalTrimmed(input.requestedBy);
  const triageState = body.trim().length > 0 ? "ready" : "needs_triage";
  const status: WorkItemRecord["status"] = triageState === "ready" ? "active" : "waiting";
  const existing = sourceRef
    ? await db.maybeOne<{ id: string }>(
        "select id from southstar.work_items where source_provider = $1 and source_ref = $2",
        [sourceProvider, sourceRef],
      )
    : null;
  const existingWorkItem = existing ? await getWorkItemPg(db, existing.id) : null;
  const priority = priorityValue(input.priority, existingWorkItem?.metadata.priority);
  const labels = inputLabels ?? labelValues(existingWorkItem?.metadata.labels);
  const metadataRequestedBy = requestedBy ?? stringValue(existingWorkItem?.metadata.requestedBy);

  const metadata = mergeIntakeMetadata({
    existing: existingWorkItem?.metadata,
    inputMetadata: input.metadata,
    body,
    sourceScope,
    sourceUrl,
    priority,
    labels,
    requestedBy: metadataRequestedBy,
    triageState,
  });
  const record = await createWorkItemPg(db, {
    id: existing?.id ?? workItemId(sourceProvider, sourceRef),
    sourceProvider,
    sourceRef,
    sourceUrl: sourceUrl ?? existingWorkItem?.sourceUrl,
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

    const existingRef = workItem.runRefs.find((ref) => ref.runId === input.runId);
    const runAttempt = existingRef?.runAttempt ?? nextRunAttempt(workItem.runRefs);
    const runRef: WorkItemRunRef = {
      ...existingRef,
      runId: input.runId,
      runAttempt,
      statusAtLink: input.statusAtLink,
      reason: input.reason,
      createdAt: existingRef?.createdAt ?? new Date().toISOString(),
    };
    const nextRunRefs = upsertRunRef(workItem.runRefs, runRef);
    await tx.query(
      "update southstar.work_items set run_refs_json = $1::jsonb, updated_at = now() where id = $2",
      [JSON.stringify(nextRunRefs), input.workItemId],
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

function upsertRunRef(runRefs: WorkItemRunRef[], runRef: WorkItemRunRef): WorkItemRunRef[] {
  let replaced = false;
  const next = runRefs.flatMap((ref) => {
    if (ref.runId !== runRef.runId) return [ref];
    if (replaced) return [];
    replaced = true;
    return [runRef];
  });
  if (!replaced) next.push(runRef);
  return next;
}

function workItemId(sourceProvider: WorkItemSourceProvider, sourceRef: string | undefined): string {
  if (!sourceRef) return `wi_${randomUUID()}`;
  return `wi_${safeId(sourceProvider)}_${safeId(sourceRef)}_${sourceHash(sourceProvider, sourceRef)}`;
}

function sourceHash(sourceProvider: WorkItemSourceProvider, sourceRef: string): string {
  return createHash("sha256").update(sourceProvider).update("\0").update(sourceRef).digest("hex").slice(0, 24);
}

function priorityValue(priority: WorkItemIntakePriority | undefined, existing: unknown): WorkItemIntakePriority {
  if (priority) return priority;
  if (existing === "low" || existing === "normal" || existing === "high" || existing === "urgent") return existing;
  return "normal";
}

function normalizeLabels(labels: string[] | undefined): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => label.trim()).filter((label) => label.length > 0);
}

function labelValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeLabels(value.filter((item): item is string => typeof item === "string"));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function mergeIntakeMetadata(input: {
  existing: Record<string, unknown> | undefined;
  inputMetadata: Record<string, unknown> | undefined;
  body: string;
  sourceScope: string | undefined;
  sourceUrl: string | undefined;
  priority: WorkItemIntakePriority;
  labels: string[];
  requestedBy: string | undefined;
  triageState: string;
}): Record<string, unknown> {
  return {
    ...(input.existing ?? {}),
    ...(isRecord(input.inputMetadata) ? input.inputMetadata : {}),
    body: input.body,
    ...(input.sourceScope ? { sourceScope: input.sourceScope } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    priority: input.priority,
    labels: input.labels,
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    triageState: input.triageState,
    intakeVersion: WORK_ITEM_INTAKE_VERSION,
  };
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
