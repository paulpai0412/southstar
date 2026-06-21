import type { SouthstarDb } from "../db/postgres.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { validateWorkflowManifest } from "../manifests/validate.ts";
import { createWorkflowRunPg } from "../stores/postgres-runtime-store.ts";
import { intakeWorkItemPg, linkRunAttemptFromWorkItemPg } from "./intake-service.ts";
import type { WorkItemSourceProvider } from "./types.ts";

export type MaterializeRunFromWorkItemInput = {
  sourceProvider: WorkItemSourceProvider;
  sourceScope?: string;
  sourceRef?: string;
  sourceUrl?: string;
  title: string;
  body: string;
  domain: string;
  runId: string;
  workflowManifest: SouthstarWorkflowManifest;
  executionProjection: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type MaterializeRunFromWorkItemResult = {
  workItemId: string;
  runId: string;
  runAttempt: number;
};

export async function materializeRunFromWorkItemPg(
  db: SouthstarDb,
  input: MaterializeRunFromWorkItemInput,
): Promise<MaterializeRunFromWorkItemResult> {
  validateMaterializationManifest(input.workflowManifest);
  return await db.tx(async (tx) => {
    const intake = await intakeWorkItemPg(tx, {
      sourceProvider: input.sourceProvider,
      sourceScope: input.sourceScope,
      sourceRef: input.sourceRef,
      sourceUrl: input.sourceUrl,
      title: input.title,
      body: input.body,
      domain: input.domain,
      metadata: input.metadata,
    });

    const existingRun = await tx.maybeOne<{
      id: string;
      status: string;
      domain: string;
      goal_prompt: string;
      workflow_manifest_json: unknown;
      execution_projection_json: unknown;
      snapshot_json: unknown;
      runtime_context_json: { workItemRef?: { workItemId?: string; runAttempt?: number } };
      metrics_json: unknown;
    }>(
      `select id, status, domain, goal_prompt, workflow_manifest_json, execution_projection_json,
              snapshot_json, runtime_context_json, metrics_json
         from southstar.workflow_runs
        where id = $1
        for update`,
      [input.runId],
    );
    if (existingRun) {
      assertExistingRunMatchesInput(existingRun, input);
      const workItem = await tx.maybeOne<{ run_refs_json: unknown }>(
        "select run_refs_json from southstar.work_items where id = $1 for update",
        [intake.workItemId],
      );
      const runRef = parseRunRefs(workItem?.run_refs_json).find((ref) => ref.runId === input.runId);
      const contextRef = existingRun.runtime_context_json.workItemRef;
      if (runRef && contextRef?.workItemId === intake.workItemId && contextRef.runAttempt === runRef.runAttempt) {
        return { workItemId: intake.workItemId, runId: input.runId, runAttempt: runRef.runAttempt };
      }
      throw new Error(`workflow run already exists but is not linked to work item ${intake.workItemId}: ${input.runId}`);
    }

    await createWorkflowRunPg(tx, {
      id: input.runId,
      status: "created",
      domain: input.domain,
      goalPrompt: input.body,
      workflowManifestJson: JSON.stringify(input.workflowManifest),
      executionProjectionJson: JSON.stringify(input.executionProjection),
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const runRef = await linkRunAttemptFromWorkItemPg(tx, {
      workItemId: intake.workItemId,
      runId: input.runId,
      statusAtLink: "created",
      reason: "materialized-from-work-item",
    });

    return { workItemId: intake.workItemId, runId: input.runId, runAttempt: runRef.runAttempt };
  });
}

function validateMaterializationManifest(workflowManifest: SouthstarWorkflowManifest): void {
  const validation = validateWorkflowManifest(workflowManifest);
  if (validation.ok) return;
  const details = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  throw new Error(`workflow manifest validation failed: ${details}`);
}

function assertExistingRunMatchesInput(
  run: {
    status: string;
    domain: string;
    goal_prompt: string;
    workflow_manifest_json: unknown;
    execution_projection_json: unknown;
    snapshot_json: unknown;
    metrics_json: unknown;
  },
  input: MaterializeRunFromWorkItemInput,
): void {
  const conflicts = [
    run.status === "created" ? undefined : "status",
    run.domain === input.domain ? undefined : "domain",
    run.goal_prompt === input.body ? undefined : "goalPrompt",
    sameJson(run.workflow_manifest_json, input.workflowManifest) ? undefined : "workflowManifest",
    sameJson(run.execution_projection_json, input.executionProjection) ? undefined : "executionProjection",
    sameJson(run.snapshot_json, {}) ? undefined : "snapshot",
    sameJson(run.metrics_json, {}) ? undefined : "metrics",
  ].filter((field): field is string => Boolean(field));
  if (conflicts.length > 0) {
    throw new Error(`workflow run already exists with conflicting materialization payload: ${input.runId} (${conflicts.join(", ")})`);
  }
}

function parseRunRefs(value: unknown): Array<{ runId: string; runAttempt: number }> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((ref) => {
    if (!ref || typeof ref !== "object") return [];
    const record = ref as { runId?: unknown; runAttempt?: unknown };
    if (typeof record.runId !== "string" || typeof record.runAttempt !== "number") return [];
    return [{ runId: record.runId, runAttempt: record.runAttempt }];
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
