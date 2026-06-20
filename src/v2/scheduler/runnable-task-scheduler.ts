import type { BrainProvider } from "../brain/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { HandProvider } from "../hands/types.ts";
import { persistBrainBindingPg, persistHandBindingPg } from "../meta-harness/postgres-bindings.ts";
import type { SessionStore } from "../session/types.ts";
import { appendHistoryEventPg } from "../stores/postgres-runtime-store.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import type { RunnableTaskSchedulerRunInput, RunnableTaskSchedulerRunResult } from "./types.ts";

export type { RunnableTaskSchedulerRunInput, RunnableTaskSchedulerRunResult } from "./types.ts";

export type RunnableTaskSchedulerDeps = {
  sessionStore: SessionStore;
  brainProvider: BrainProvider;
  handProvider: HandProvider;
};

type TaskRow = {
  id: string;
  status: string;
  sort_order: number;
  depends_on_json: unknown;
  root_session_id: string | null;
};

type ContextPacketRow = {
  resource_key: string;
  payload_json: unknown;
};

type ExistingHistoryRow = {
  id: string;
  run_id: string;
  sequence: number;
};

export function createRunnableTaskScheduler(db: SouthstarDb, deps: RunnableTaskSchedulerDeps): {
  runOnce(input: RunnableTaskSchedulerRunInput): Promise<RunnableTaskSchedulerRunResult>;
} {
  return {
    async runOnce(input) {
      const run = await db.maybeOne<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
        "select workflow_manifest_json from southstar.workflow_runs where id = $1",
        [input.runId],
      );
      if (!run) throw new Error(`run not found: ${input.runId}`);

      const tasks = await db.query<TaskRow>(
        `select id, status, sort_order, depends_on_json, root_session_id
           from southstar.workflow_tasks
          where run_id = $1
          order by sort_order, id`,
        [input.runId],
      );
      const acceptedArtifactTaskIds = await acceptedArtifactTaskIdsForRun(db, input.runId);
      const maxParallelTasks = maxParallelTasksForManifest(run.workflow_manifest_json);
      const result: RunnableTaskSchedulerRunResult = { runId: input.runId, dispatchedTaskIds: [], skippedTaskIds: [] };

      for (const task of tasks.rows) {
        if (task.status !== "pending") {
          result.skippedTaskIds.push({ taskId: task.id, reason: `status:${task.status}` });
          continue;
        }

        if (!dependenciesReady(dependsOn(task), acceptedArtifactTaskIds)) {
          result.skippedTaskIds.push({ taskId: task.id, reason: "dependencies-not-accepted" });
          continue;
        }

        const sessionId = task.root_session_id ?? `root-${input.runId}-${task.id}`;
        const claim = await claimRunnableTask(db, {
          runId: input.runId,
          taskId: task.id,
          sessionId,
          maxParallelTasks,
        });
        if (claim !== "claimed") {
          result.skippedTaskIds.push({ taskId: task.id, reason: claim });
          continue;
        }

        await dispatchTask(db, deps, {
          runId: input.runId,
          taskId: task.id,
          sessionId,
          manifest: run.workflow_manifest_json,
        });
        result.dispatchedTaskIds.push(task.id);
      }

      return result;
    },
  };
}

async function dispatchTask(
  db: SouthstarDb,
  deps: RunnableTaskSchedulerDeps,
  input: { runId: string; taskId: string; sessionId: string; manifest: SouthstarWorkflowManifest },
): Promise<void> {
  const contextPacketId = await contextPacketIdForTask(db, input.runId, input.taskId);
  const recoveryKey = `task-dispatch:${input.runId}:${input.taskId}`;

  const brainBindingId = await ensureBrainBinding(db, deps, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    contextPacketId,
    recoveryKey,
    effortPolicy: effortPolicyForBrain(input.manifest),
  });
  await emitSessionEventOnce(db, deps.sessionStore, {
    eventType: "brain.woke",
    actorType: "orchestrator",
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    idempotencyKey: `${recoveryKey}:brain-woke`,
    payload: { brainBindingId, contextPacketId },
  });

  const handBindingId = await ensureHandBinding(db, deps, {
    runId: input.runId,
    taskId: input.taskId,
    recoveryKey,
  });
  await emitSessionEventOnce(db, deps.sessionStore, {
    eventType: "hand.provisioned",
    actorType: "orchestrator",
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    idempotencyKey: `${recoveryKey}:hand-provisioned`,
    payload: { handBindingId, handName: "workspace" },
  });

  await appendHistoryEventOnce(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "task.dispatch_submitted",
    actorType: "orchestrator",
    idempotencyKey: `${recoveryKey}:dispatch-submitted`,
    payload: { brainBindingId, handBindingId, contextPacketId },
  });
}

async function claimRunnableTask(
  db: SouthstarDb,
  input: { runId: string; taskId: string; sessionId: string; maxParallelTasks: number },
): Promise<"claimed" | "parallel-limit" | "status-changed"> {
  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const task = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [input.runId, input.taskId],
    );
    if (!task || task.status !== "pending") return "status-changed";

    const active = await tx.one<{ running_count: number | string }>(
      "select count(*) as running_count from southstar.workflow_tasks where run_id = $1 and status = 'running'",
      [input.runId],
    );
    if (Number(active.running_count) >= input.maxParallelTasks) return "parallel-limit";

    await tx.query(
      "update southstar.workflow_tasks set status = 'running', root_session_id = $1, updated_at = now() where run_id = $2 and id = $3",
      [input.sessionId, input.runId, input.taskId],
    );
    return "claimed";
  });
}

async function ensureBrainBinding(
  db: SouthstarDb,
  deps: RunnableTaskSchedulerDeps,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    contextPacketId: string;
    recoveryKey: string;
    effortPolicy: { complexity: "simple" | "standard" | "broad" | "deep"; maxToolCallsPerTask: number };
  },
): Promise<string> {
  const existing = await firstBindingId(db, "brain_binding", input.runId, input.taskId);
  if (existing) return existing;
  const binding = await deps.brainProvider.wake({
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    contextPacketId: input.contextPacketId,
    recoveryKey: input.recoveryKey,
    effortPolicy: input.effortPolicy,
  });
  await persistBrainBindingPg(db, binding);
  return binding.id;
}

async function ensureHandBinding(
  db: SouthstarDb,
  deps: RunnableTaskSchedulerDeps,
  input: { runId: string; taskId: string; recoveryKey: string },
): Promise<string> {
  const existing = await firstBindingId(db, "hand_binding", input.runId, input.taskId);
  if (existing) return existing;
  const binding = await deps.handProvider.provision({
    runId: input.runId,
    taskId: input.taskId,
    handName: "workspace",
    resources: {},
    recoveryKey: input.recoveryKey,
  });
  await persistHandBindingPg(db, binding);
  return binding.id;
}

async function emitSessionEventOnce(
  db: SouthstarDb,
  sessionStore: SessionStore,
  event: Parameters<SessionStore["emitEvent"]>[0],
): Promise<void> {
  const existing = event.idempotencyKey ? await historyEventByIdempotencyKey(db, event.runId, event.idempotencyKey) : null;
  if (existing) return;
  try {
    await sessionStore.emitEvent(event);
  } catch (error) {
    if (event.idempotencyKey && isUniqueViolation(error)) return;
    throw error;
  }
}

async function appendHistoryEventOnce(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    eventType: string;
    actorType: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const existing = await historyEventByIdempotencyKey(db, input.runId, input.idempotencyKey);
  if (existing) return;
  try {
    await appendHistoryEventPg(db, input);
  } catch (error) {
    if (isUniqueViolation(error)) return;
    throw error;
  }
}

async function acceptedArtifactTaskIdsForRun(db: SouthstarDb, runId: string): Promise<Set<string>> {
  const rows = await db.query<{ task_id: string }>(
    `select distinct task_id
       from southstar.runtime_resources
      where run_id = $1
        and task_id is not null
        and resource_type = 'artifact_ref'
        and status = 'accepted'`,
    [runId],
  );
  return new Set(rows.rows.map((row) => row.task_id));
}

async function contextPacketIdForTask(db: SouthstarDb, runId: string, taskId: string): Promise<string> {
  const row = await db.maybeOne<ContextPacketRow>(
    `select resource_key, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and task_id = $2
        and resource_type = 'context_packet'
      order by created_at desc
      limit 1`,
    [runId, taskId],
  );
  const payload = asRecord(row?.payload_json);
  return stringValue(payload.id) ?? row?.resource_key ?? `context-${runId}-${taskId}`;
}

async function firstBindingId(db: SouthstarDb, resourceType: "brain_binding" | "hand_binding", runId: string, taskId: string): Promise<string | null> {
  const row = await db.maybeOne<{ id: string }>(
    `select id
       from southstar.runtime_resources
      where resource_type = $1
        and run_id = $2
        and task_id = $3
      order by created_at
      limit 1`,
    [resourceType, runId, taskId],
  );
  return row?.id ?? null;
}

async function historyEventByIdempotencyKey(db: SouthstarDb, runId: string, idempotencyKey: string): Promise<ExistingHistoryRow | null> {
  return await db.maybeOne<ExistingHistoryRow>(
    "select id, run_id, sequence from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [runId, idempotencyKey],
  );
}

function dependenciesReady(dependsOn: string[], acceptedArtifactTaskIds: Set<string>): boolean {
  return dependsOn.every((dependencyTaskId) => acceptedArtifactTaskIds.has(dependencyTaskId));
}

function dependsOn(task: TaskRow): string[] {
  return Array.isArray(task.depends_on_json) && task.depends_on_json.every((item) => typeof item === "string")
    ? task.depends_on_json
    : [];
}

function maxParallelTasksForManifest(manifest: SouthstarWorkflowManifest): number {
  const value = manifest.effortPolicy?.maxParallelTasks;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function effortPolicyForBrain(manifest: SouthstarWorkflowManifest): {
  complexity: "simple" | "standard" | "broad" | "deep";
  maxToolCallsPerTask: number;
} {
  const complexity = manifest.effortPolicy?.complexity;
  return {
    complexity: complexity === "simple" || complexity === "standard" || complexity === "broad" || complexity === "deep"
      ? complexity
      : "standard",
    maxToolCallsPerTask: validPositiveInteger(manifest.effortPolicy?.maxToolCallsPerTask) ?? 10,
  };
}

function validPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}
