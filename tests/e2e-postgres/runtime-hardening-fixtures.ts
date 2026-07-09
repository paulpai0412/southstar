import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import type { ExecutorProvider, ExecutorSubmitRequest } from "../../src/v2/executor/provider.ts";
import type { BrainProvider, BrainSessionBinding, WakeBrainInput } from "../../src/v2/brain/types.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../../src/v2/artifacts/types.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createRunnableTaskScheduler } from "../../src/v2/scheduler/runnable-task-scheduler.ts";
import { createSouthstarRuntimeServer, type SouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createTorkHandProvider } from "../../src/v2/hands/tork-hand-provider.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  upsertRuntimeResourcePg,
  type RuntimeResourceRecord,
} from "../../src/v2/stores/postgres-runtime-store.ts";

export const hardeningExecutionProjection = { executor: "managed", queue: "runtime-hardening" };

export async function seedHardeningRunTask(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    runStatus?: string;
    taskStatus?: string;
    rootSessionId?: string;
    dependsOn?: string[];
  },
): Promise<void> {
  const taskId = input.taskId;
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: input.runStatus ?? "running",
    domain: "software",
    goalPrompt: "runtime hardening case",
    workflowManifestJson: JSON.stringify(hardeningWorkflowManifest(input.runId, taskId)),
    executionProjectionJson: JSON.stringify(hardeningExecutionProjection),
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId: input.runId,
    taskKey: taskId,
    status: input.taskStatus ?? "running",
    sortOrder: 1,
    dependsOn: input.dependsOn ?? [],
    rootSessionId: input.rootSessionId ?? `session-${input.runId}-${taskId}`,
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "context_packet",
    resourceKey: `context-${input.runId}-${taskId}`,
    runId: input.runId,
    taskId,
    scope: "brain",
    status: "ready",
    title: `Context ${taskId}`,
    payload: { id: `context-${input.runId}-${taskId}` },
  });
}

export function hardeningWorkflowManifest(runId: string, taskId = "task-a"): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: `wf-${runId}`,
    title: "Runtime hardening case",
    goalPrompt: "runtime hardening case",
    tasks: [{
      id: taskId,
      name: "Runtime task",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 600,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
      skillRefs: ["skill.software-implementation"],
      subagents: [{ id: "impl", harnessId: "codex", prompt: "complete the task", requiredArtifacts: ["implementation_report"] }],
    }],
    harnessDefinitions: [{
      id: "codex",
      kind: "codex",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v1",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation_report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: [] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    executionPolicy: { maxParallelTasks: 1 },
  };
}

export async function seedHandExecution(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    attemptId: string;
    status: "queued" | "running" | "completed" | "failed" | "superseded";
    sessionId?: string;
    queuedAt?: string;
    startedAt?: string;
    lastHeartbeatAt?: string;
    terminalAt?: string;
    externalJobId?: string;
    queueTimeoutSeconds?: number;
    heartbeatTimeoutSeconds?: number;
  },
): Promise<void> {
  const handExecutionId = canonicalHandExecutionId(input.runId, input.taskId, input.attemptId);
  await upsertRuntimeResourcePg(db, {
    id: handExecutionId,
    resourceType: "hand_execution",
    resourceKey: handExecutionId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId ?? `session-${input.runId}-${input.taskId}`,
    scope: "hand",
    status: input.status,
    title: `Hand execution ${input.taskId}`,
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId ?? `session-${input.runId}-${input.taskId}`,
      attemptId: input.attemptId,
      providerId: "tork",
      status: input.status,
      queuedAt: input.queuedAt,
      startedAt: input.startedAt,
      lastHeartbeatAt: input.lastHeartbeatAt,
      terminalAt: input.terminalAt,
      externalJobId: input.externalJobId ?? `job-${input.taskId}-${input.attemptId}`,
      queueTimeoutSeconds: input.queueTimeoutSeconds ?? 120,
      heartbeatTimeoutSeconds: input.heartbeatTimeoutSeconds ?? 30,
    },
  });
}

export function canonicalHandExecutionId(runId: string, taskId: string, attemptId: string): string {
  return `hand-execution:${runId}:${taskId}:${attemptId}`;
}

export async function createRuntimeServerWithoutBackgroundLoops(db: SouthstarDb): Promise<SouthstarRuntimeServer> {
  return await createSouthstarRuntimeServer({
    db: db as never,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("whole workflow executor not used"); } },
    createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
  });
}

export async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

export async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

export function deterministicBrainProvider(): BrainProvider {
  return {
    providerId: "deterministic-brain",
    async wake(input: WakeBrainInput): Promise<BrainSessionBinding> {
      return {
        id: `brain-${input.runId}-${input.taskId}`,
        providerId: "deterministic-brain",
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        contextPacketId: input.contextPacketId,
        status: "running",
        createdAt: "2026-06-21T00:00:00.000Z",
        payload: { effortPolicy: input.effortPolicy },
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

export function recordingTorkExecutorProvider(submitted: ExecutorSubmitRequest[]): ExecutorProvider {
  return {
    executorType: "tork",
    async submit(request) {
      submitted.push(request);
      const taskId = request.workflow.tasks[0]?.id ?? "unknown";
      return {
        executorType: "tork",
        externalJobId: `job-${taskId}`,
        status: "queued",
        projectionFingerprint: `projection-${taskId}`,
        providerPayload: { taskId },
      };
    },
  };
}

export function createManagedScheduler(db: SouthstarDb, serverUrl: string, submitted: ExecutorSubmitRequest[]) {
  return createRunnableTaskScheduler(db, {
    sessionStore: createPostgresSessionStore(db),
    brainProvider: deterministicBrainProvider(),
    handProvider: createTorkHandProvider({
      executorProvider: recordingTorkExecutorProvider(submitted),
      callbackUrl: `${serverUrl}/api/v2/tork/callback`,
      heartbeatUrl: `${serverUrl}/api/v2/executor/heartbeat`,
    }),
  });
}

export function findRuntimeResource(
  resources: RuntimeResourceRecord[],
  predicate: (resource: RuntimeResourceRecord) => boolean,
): RuntimeResourceRecord {
  const resource = resources.find(predicate);
  if (!resource) throw new Error("expected runtime resource was not found");
  return resource;
}

export function acceptedArtifactRefs(resources: RuntimeResourceRecord[]): RuntimeResourceRecord[] {
  return resources.filter((resource) => resource.resourceType === ARTIFACT_REF_RESOURCE_TYPE && resource.status === "accepted");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
