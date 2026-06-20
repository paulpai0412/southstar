import { materializeTaskEnvelope } from "../agent-runner/materializer.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { getPostgresTaskEnvelope } from "../ui-api/postgres-task-envelope.ts";
import { withMaterializationMount } from "./materialization-mount.ts";
import { piAgentConfigMount, piAgentRuntimeEnv } from "./pi-agent-runtime.ts";
import { createExecutorBindingPg } from "./postgres-bindings.ts";
import type { ExecutorProvider } from "./provider.ts";

export type PostgresRunDispatchInput = {
  runId: string;
  executorProvider: ExecutorProvider;
  callbackUrl: string;
  heartbeatUrl?: string;
  runRoot?: string;
  envelopeBasePath?: string;
  harnessEndpoint?: string;
  contextRefreshUrl?: string;
  attemptId?: string;
};

export type PostgresRunDispatchResult = {
  runId: string;
  attemptId: string;
  externalJobId: string;
  taskIds: string[];
  materializedEnvelopePaths: string[];
};

export async function dispatchPostgresRunExecutionPg(db: SouthstarDb, input: PostgresRunDispatchInput): Promise<PostgresRunDispatchResult> {
  const run = await db.maybeOne<{ workflow_manifest_json: SouthstarWorkflowManifest; status: string }>(
    "select workflow_manifest_json, status from southstar.workflow_runs where id = $1",
    [input.runId],
  );
  if (!run) throw new Error(`run not found: ${input.runId}`);
  const workflow = run.workflow_manifest_json;
  if (!Array.isArray(workflow.tasks) || workflow.tasks.length === 0) throw new Error(`run has no executable tasks: ${input.runId}`);

  const attemptId = input.attemptId ?? "attempt-1";
  const { workflow: mountedWorkflow, runRoot, envelopeBasePath } = withMaterializationMount(workflow, {
    runRoot: input.runRoot,
    envelopeBasePath: input.envelopeBasePath,
  });
  const executableWorkflow = workflowForRuntimeDispatch(mountedWorkflow, {
    runRoot,
    harnessEndpoint: input.harnessEndpoint,
    contextRefreshUrl: input.contextRefreshUrl,
  });

  const materializedEnvelopePaths: string[] = [];
  for (const task of executableWorkflow.tasks) {
    const envelope = await getPostgresTaskEnvelope(db, { runId: input.runId, taskId: task.id });
    const materialized = await materializeTaskEnvelope(envelope, { runRoot });
    materializedEnvelopePaths.push(materialized.envelopePath);
    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: `task-envelope-${input.runId}-${task.id}-${attemptId}`,
      runId: input.runId,
      taskId: task.id,
      sessionId: envelope.session.sessionId,
      scope: "task",
      status: "materialized",
      title: `Task envelope ${task.id}`,
      payload: { envelopePath: materialized.envelopePath, taskDir: materialized.taskDir, attemptId },
      summary: { taskId: task.id, attemptId },
    });
  }

  const submission = await input.executorProvider.submit({
    runId: input.runId,
    workflow: executableWorkflow,
    callbackUrl: input.callbackUrl,
    heartbeatUrl: input.heartbeatUrl,
    envelopeBasePath,
    attemptId,
  });

  await db.tx(async (tx) => {
    await tx.query(
      "update southstar.workflow_runs set status = 'running', execution_projection_json = $1, updated_at = now() where id = $2",
      [JSON.stringify({ executor: submission.executorType, externalJobId: submission.externalJobId, projectionFingerprint: submission.projectionFingerprint, executionProjection: submission.executionProjection }), input.runId],
    );
    await appendHistoryEventPg(tx, {
      runId: input.runId,
      eventType: "run.execution_submitted",
      actorType: "orchestrator",
      payload: { externalJobId: submission.externalJobId, attemptId, executorType: submission.executorType },
    });

    for (const task of executableWorkflow.tasks) {
      const taskStatus = task.dependsOn.length === 0 ? "running" : "pending";
      await tx.query(
        "update southstar.workflow_tasks set status = $1, updated_at = now() where run_id = $2 and id = $3",
        [taskStatus, input.runId, task.id],
      );
      await createExecutorBindingPg(tx, {
        runId: input.runId,
        taskId: task.id,
        attemptId,
        torkJobId: submission.externalJobId,
        status: submission.status === "queued" ? "queued" : "submitted",
        queueTimeoutSeconds: 120,
        hardTimeoutSeconds: task.execution.timeoutSeconds,
      });
    }
  });

  return {
    runId: input.runId,
    attemptId,
    externalJobId: submission.externalJobId,
    taskIds: executableWorkflow.tasks.map((task) => task.id),
    materializedEnvelopePaths,
  };
}

function workflowForRuntimeDispatch(
  workflow: SouthstarWorkflowManifest,
  input: { runRoot: string; harnessEndpoint?: string; contextRefreshUrl?: string },
): SouthstarWorkflowManifest {
  const piMount = piAgentConfigMount();
  const piEnv = piAgentRuntimeEnv();
  return {
    ...workflow,
    tasks: workflow.tasks.map((task) => ({
      ...task,
      execution: {
        ...task.execution,
        env: {
          ...task.execution.env,
          ...piEnv,
          SOUTHSTAR_MATERIALIZATION_ROOT: input.runRoot,
          ...(input.contextRefreshUrl ? { SOUTHSTAR_CONTEXT_REFRESH_URL: input.contextRefreshUrl } : {}),
          ...(input.harnessEndpoint ? {
            SOUTHSTAR_HARNESS_ENDPOINT: input.harnessEndpoint,
            PI_HARNESS_ENDPOINT: input.harnessEndpoint,
          } : {}),
        },
        mounts: piMount ? ensureMount(task.execution.mounts, piMount) : task.execution.mounts,
      },
    })),
  };
}

function ensureMount(
  mounts: Array<{ source: string; target: string; readonly: boolean }>,
  mount: { source: string; target: string; readonly: boolean },
): Array<{ source: string; target: string; readonly: boolean }> {
  if (mounts.some((entry) => entry.source === mount.source && entry.target === mount.target)) return mounts;
  return [...mounts, mount];
}
