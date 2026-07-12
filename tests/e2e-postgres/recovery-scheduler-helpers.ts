import type { BrainProvider, BrainSessionBinding, WakeBrainInput } from "../../src/v2/brain/types.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { piAgentConfigMount, piAgentRuntimeEnv } from "../../src/v2/executor/pi-agent-runtime.ts";
import type { ExecutorProvider, ExecutorSubmitRequest, ExecutorSubmitResult } from "../../src/v2/executor/provider.ts";
import { TorkClient } from "../../src/v2/executor/tork-client.ts";
import { TorkExecutorProvider } from "../../src/v2/executor/tork-provider.ts";
import { createTorkHandProvider } from "../../src/v2/hands/tork-hand-provider.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import { createRunnableTaskScheduler } from "../../src/v2/scheduler/runnable-task-scheduler.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import type { RealPostgresInfra } from "./postgres-real-harness.ts";

export function firstAttemptId(taskId: string): string {
  return `${taskId}-attempt-1`;
}

export function canonicalHandExecutionId(runId: string, taskId: string, attemptId: string): string {
  return `hand-execution:${runId}:${taskId}:${attemptId}`;
}

export async function seedRunningHandAttempt(
  db: SouthstarDb,
  input: { runId: string; taskId: string; sessionId: string; attemptId: string },
): Promise<string> {
  const handExecutionId = canonicalHandExecutionId(input.runId, input.taskId, input.attemptId);
  await db.query(
    "update southstar.workflow_runs set status = 'running', updated_at = now() where id = $1",
    [input.runId],
  );
  await db.query(
    `update southstar.workflow_tasks
        set status = 'running',
            root_session_id = $1,
            updated_at = now()
      where run_id = $2
        and id = $3`,
    [input.sessionId, input.runId, input.taskId],
  );
  await upsertRuntimeResourcePg(db, {
    id: handExecutionId,
    resourceType: "hand_execution",
    resourceKey: handExecutionId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "hand",
    status: "running",
    title: `Hand execution ${input.taskId}`,
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId,
      providerId: "tork",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      status: "running",
      externalJobId: `seeded-${handExecutionId}`,
      startedAt: "2026-06-22T00:00:00.000Z",
      queueTimeoutSeconds: 120,
      heartbeatTimeoutSeconds: 60,
    },
    summary: { providerId: "tork", attemptId: input.attemptId },
  });
  return handExecutionId;
}

export function createRealRecoveryScheduler(
  db: SouthstarDb,
  input: { infra: RealPostgresInfra; callbackBase: string; runRoot?: string },
) {
  const torkClient = new TorkClient({ baseUrl: input.infra.torkBaseUrl, requestTimeoutMs: 20_000, retryCount: 2 });
  return createRunnableTaskScheduler(db, {
    sessionStore: createPostgresSessionStore(db),
    brainProvider: deterministicBrainProvider(),
    handProvider: createTorkHandProvider({
      executorProvider: runtimeTorkExecutorProvider({
        torkClient,
        runRoot: input.runRoot ?? "/tmp/southstar-runs",
        harnessEndpoint: input.infra.piHarnessEndpoint,
      }),
      callbackUrl: `${input.callbackBase}/api/v2/tork/callback`,
      heartbeatUrl: `${input.callbackBase}/api/v2/executor/heartbeat`,
      runRoot: input.runRoot ?? "/tmp/southstar-runs",
    }),
  });
}

export async function latestHandExecutionForTask(
  db: SouthstarDb,
  input: { runId: string; taskId: string },
): Promise<{ resourceKey: string; status: string; attemptId: string; externalJobId: string }> {
  const row = await db.maybeOne<{ resource_key: string; status: string; payload_json: { attemptId?: string; externalJobId?: string } }>(
    `select resource_key, status, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and task_id = $2
        and resource_type = 'hand_execution'
      order by created_at desc, resource_key desc
      limit 1`,
    [input.runId, input.taskId],
  );
  if (!row?.payload_json.attemptId || !row.payload_json.externalJobId) {
    throw new Error(`hand execution not found for ${input.runId}/${input.taskId}`);
  }
  return {
    resourceKey: row.resource_key,
    status: row.status,
    attemptId: row.payload_json.attemptId,
    externalJobId: row.payload_json.externalJobId,
  };
}

export async function waitForHandExecutionStatus(
  db: SouthstarDb,
  resourceKey: string,
  statuses: string[],
  timeoutMs = 20 * 60 * 1000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.maybeOne<{ status: string }>(
      "select status from southstar.runtime_resources where resource_type = 'hand_execution' and resource_key = $1",
      [resourceKey],
    );
    if (row && statuses.includes(row.status)) return row.status;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`hand execution ${resourceKey} did not reach ${statuses.join("/")} within ${timeoutMs}ms`);
}

function runtimeTorkExecutorProvider(
  input: { torkClient: TorkClient; runRoot: string; harnessEndpoint?: string },
): ExecutorProvider {
  const delegate = new TorkExecutorProvider({ torkClient: input.torkClient });
  return {
    executorType: "tork",
    async submit(request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult> {
      const runtimeWorkflow = workflowForRuntimeDispatch(request.workflow, {
        runRoot: input.runRoot,
        harnessEndpoint: input.harnessEndpoint,
      });
      return await delegate.submit({
        ...request,
        workflow: runtimeWorkflow,
      });
    },
    cancel: (request) => input.torkClient.cancelJob(request.externalJobId).then(() => ({
      executorType: "tork" as const,
      externalJobId: request.externalJobId,
      status: "cancelled" as const,
    })),
  };
}

function workflowForRuntimeDispatch(
  workflow: SouthstarWorkflowManifest,
  input: { runRoot: string; harnessEndpoint?: string },
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

function deterministicBrainProvider(): BrainProvider {
  return {
    providerId: "deterministic-recovery-brain",
    async wake(input: WakeBrainInput): Promise<BrainSessionBinding> {
      return {
        id: `brain-${input.runId}-${input.taskId}`,
        providerId: "deterministic-recovery-brain",
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        contextPacketId: input.contextPacketId,
        status: "running",
        createdAt: new Date().toISOString(),
        payload: { recoveryKey: input.recoveryKey ?? null },
      };
    },
    async cancel(binding) {
      binding.status = "cancelled";
    },
    capabilities() {
      return {
        supportsWakeFromSession: true,
        supportsCancel: true,
        supportsSteering: true,
        supportsNativeRewind: false,
      };
    },
  };
}
