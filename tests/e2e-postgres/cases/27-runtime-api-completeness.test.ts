import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDeltaPg, writeRunLocalMemoryPg } from "../../../src/v2/memory/postgres-memory-service.ts";
import type { SouthstarWorkflowManifest } from "../../../src/v2/manifests/types.ts";
import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import type { RuntimeServerContext } from "../../../src/v2/server/runtime-context.ts";
import { createRuntimeLoopRegistry } from "../../../src/v2/server/runtime-loop-registry.ts";
import {
  appendHistoryEventPg,
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createInitializedRealPostgresE2E, probeRealPostgresTorkPi, requireRealPostgresInfra } from "../postgres-real-harness.ts";

test("27 runtime API completeness: operator APIs cover lifecycle, stream, execution, session, and memory", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const registry = createRuntimeLoopRegistry();
  registry.register({
    id: "runnable-task-scheduler",
    intervalMs: 5_000,
    runOnce: async () => ({ processed: 0 }),
  });
  const context = runtimeContext(env.db, registry);
  const server = await createSouthstarRuntimeServer(context);
  try {
    const runId = "real-runtime-api-completeness";
    const taskId = "runtime-api-task";
    const sessionId = "root-real-runtime-api-completeness-runtime-api-task";
    const externalJobId = "seeded-runtime-api-job-27";
    const deltaId = await seedRuntimeApiCase(env.db, { runId, taskId, sessionId, externalJobId });

    const actions = await api<{
      runId: string;
      status: string;
      actions: Array<{ action: string; allowed: boolean }>;
    }>(server.url, `/api/v2/runs/${encodeURIComponent(runId)}/actions`);
    assert.equal(actions.runId, runId);
    assert.equal(actions.status, "running");
    assert.equal(actions.actions.some((action) => action.action === "pause" && action.allowed), true);

    const pause = await api<{ commandId: string; status: string; affectedRunId?: string }>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/pause`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: "cmd-runtime-api-completeness-pause",
          actor: { type: "user", id: "operator-case-27" },
          reason: "case 27 pauses a running run through the runtime API",
        }),
      },
    );
    assert.equal(pause.commandId, "cmd-runtime-api-completeness-pause");
    assert.equal(pause.status, "applied");
    assert.equal(pause.affectedRunId, runId);

    const run = await api<{ run: { id: string; status: string } }>(server.url, `/api/v2/runs/${encodeURIComponent(runId)}`);
    assert.equal(run.run.status, "paused");

    const summary = await api<{
      schemaVersion: string;
      data: { runId: string; status: string; taskCounts: Record<string, number> };
    }>(server.url, `/api/v2/read-models/run-summary/${encodeURIComponent(runId)}`);
    assert.equal(summary.schemaVersion, "southstar.read_model.run_summary.v1");
    assert.equal(summary.data.status, "paused");
    assert.deepEqual(summary.data.taskCounts, { running: 1 });

    const executions = await api<{ data: { executions: Array<{ externalJobId?: string }> } }>(
      server.url,
      `/api/v2/read-models/executions/${encodeURIComponent(runId)}`,
    );
    assert.equal(executions.data.executions.some((execution) => execution.externalJobId === externalJobId), true);

    const handExecutions = await api<{ executions: Array<{ externalJobId?: string }> }>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/hand-executions`,
    );
    assert.equal(handExecutions.executions.some((execution) => execution.externalJobId === externalJobId), true);

    const executorJobActions = await api<{
      actions: Array<{ action: string; allowed: boolean }>;
    }>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(externalJobId)}/actions`,
    );
    assert.equal(executorJobActions.actions.some((action) => action.action === "cancel" && action.allowed), true);

    const cancel = await api<{
      commandId: string;
      status: string;
      resourceRefs: Array<{ resourceType: string; resourceKey: string }>;
      eventRefs: Array<{ eventType: string }>;
    }>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(externalJobId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: "cmd-runtime-api-completeness-job-cancel",
          actor: { type: "user", id: "operator-case-27" },
          reason: "case 27 cancels seeded executor job through runtime API",
        }),
      },
    );
    assert.equal(cancel.commandId, "cmd-runtime-api-completeness-job-cancel");
    assert.equal(cancel.status, "applied");
    assert.equal(cancel.resourceRefs.some((ref) => ref.resourceType === "hand_execution"), true);
    assert.equal(cancel.eventRefs.some((event) => event.eventType === "executor_job.cancel_requested"), true);

    const executionsAfterCancel = await api<{ data: { executions: Array<{ externalJobId?: string; rawStatus?: string }> } }>(
      server.url,
      `/api/v2/read-models/executions/${encodeURIComponent(runId)}`,
    );
    const canceledExecution = executionsAfterCancel.data.executions.find((execution) => execution.externalJobId === externalJobId);
    assert.ok(canceledExecution);
    assert.equal(canceledExecution.rawStatus, "cancel_requested");

    const cancelCommandResource = await getResourceByKeyPg(env.db, "runtime_command", "cmd-runtime-api-completeness-job-cancel");
    assert.ok(cancelCommandResource);

    const runHistoryEvents = await listHistoryForRunPg(env.db, runId);
    assert.equal(runHistoryEvents.some((event) => event.eventType === "executor_job.cancel_requested"), true);

    const sessionEvents = await api<{ events: Array<{ eventType: string }> }>(
      server.url,
      `/api/v2/sessions/${encodeURIComponent(sessionId)}/events?limit=20`,
    );
    assert.equal(sessionEvents.events.some((event) => event.eventType === "progress.commentary"), true);

    const runEvents = await api<Array<{ eventType: string }>>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/events?after=0`,
    );
    assert.equal(runEvents.some((event) => event.eventType === "progress.commentary"), true);
    assert.equal(runEvents.some((event) => event.eventType === "run.paused"), true);

    const frame = await readOneSseFrame(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/events/stream?after=0&closeOnTerminal=false&pollMs=10&heartbeatMs=1000`,
    );
    assert.match(frame, /^id: \d+/m);
    assert.match(frame, /event: (progress\.commentary|run\.paused|run\.command_requested|memory\.)/);

    const approved = await api<{ deltaId: string; memoryItemId: string }>(
      server.url,
      `/api/v2/memory-deltas/${encodeURIComponent(deltaId)}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ approvedBy: "operator-case-27", reason: "case 27 approves durable memory API coverage" }),
      },
    );
    assert.equal(approved.deltaId, deltaId);
    assert.equal(typeof approved.memoryItemId, "string");

    const memoryDeltas = await api<{
      memoryDeltas: Array<{ id: string; status: string; sourceSessionId?: string }>;
    }>(server.url, `/api/v2/runs/${encodeURIComponent(runId)}/memory-deltas`);
    const listedDelta = memoryDeltas.memoryDeltas.find((item) => item.id === deltaId);
    assert.ok(listedDelta);
    assert.equal(listedDelta.status, "approved");
    assert.equal(listedDelta.sourceSessionId, sessionId);

    const health = await api<{ database: { ok: boolean } }>(server.url, "/api/v2/runtime/health");
    assert.equal(health.database.ok, true);

    const tick = await api<{ loopId: string; status: string; result?: { processed?: number } }>(
      server.url,
      "/api/v2/runtime/loops/runnable-task-scheduler/tick",
      { method: "POST" },
    );
    assert.equal(tick.loopId, "runnable-task-scheduler");
    assert.equal(tick.status, "succeeded");
    assert.equal(tick.result?.processed, 0);
  } finally {
    await server.close();
    await env.close();
  }
});

async function seedRuntimeApiCase(
  db: SouthstarDb,
  input: { runId: string; taskId: string; sessionId: string; externalJobId: string },
): Promise<string> {
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: "running",
    domain: "software",
    goalPrompt: "verify runtime API completeness",
    workflowManifestJson: JSON.stringify(workflowManifest(input)),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: input.taskId,
    runId: input.runId,
    taskKey: input.taskId,
    status: "running",
    sortOrder: 1,
    dependsOn: [],
    rootSessionId: input.sessionId,
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "session",
    resourceKey: input.sessionId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "task",
    status: "active",
    title: "Runtime API session",
    payload: { summary: "root session for runtime API completeness" },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "hand_execution",
    resourceKey: `hand-execution:${input.runId}:${input.taskId}:${input.taskId}-attempt-1`,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "hand",
    status: "running",
    payload: {
      providerId: "tork",
      attemptId: `${input.taskId}-attempt-1`,
      externalJobId: input.externalJobId,
      lastHeartbeatAt: "2026-06-23T10:00:00.000Z",
      heartbeatSeq: 1,
    },
  });
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "progress.commentary",
    actorType: "hand",
    payload: { message: "case 27 seeded progress event" },
  });
  await writeRunLocalMemoryPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "run:real-runtime-api-completeness",
    kind: "implementation_preference",
    text: "Runtime API completeness should remain deterministic against real Postgres.",
    tags: ["runtime-api", "deterministic"],
    sourceRefs: [`hand-execution:${input.runId}:${input.taskId}:${input.taskId}-attempt-1`],
    confidence: 1,
    successScore: 1,
  });
  const delta = await createMemoryDeltaPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "software",
    kind: "implementation_preference",
    text: "Expose lifecycle, stream, execution, session, and memory APIs in one runtime case.",
    tags: ["runtime-api", "operator"],
    sourceRefs: [`hand-execution:${input.runId}:${input.taskId}:${input.taskId}-attempt-1`],
    confidence: 1,
    successScore: 0.9,
  });
  return delta.id;
}

function runtimeContext(db: SouthstarDb, runtimeLoopRegistry: ReturnType<typeof createRuntimeLoopRegistry>): RuntimeServerContext {
  return {
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
    runtimeLoopRegistry,
    manualRuntimeLoopControls: true,
    createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
  };
}

function workflowManifest(input: { runId: string; taskId: string }): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-runtime-api-completeness",
    title: "Runtime API completeness",
    goalPrompt: "verify runtime API completeness",
    domain: "software",
    intent: "implement_feature",
    tasks: [{
      id: input.taskId,
      name: "Verify runtime API completeness",
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
      subagents: [],
    }],
    harnessDefinitions: [{
      id: "pi",
      kind: "pi-agent",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation_report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    effortPolicy: {
      complexity: "simple",
      maxBrains: 1,
      maxHandsPerBrain: 1,
      maxParallelTasks: 1,
      maxToolCallsPerTask: 10,
      maxInputTokensPerBrain: 20_000,
      maxCostMicrosUsd: 500_000,
      stopWhenEvidenceSufficient: true,
    },
  };
}

async function api<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

async function readOneSseFrame(baseUrl: string, path: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    return await readOneSseChunk(response);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function readOneSseChunk(response: Response): Promise<string> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  try {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    return new TextDecoder().decode(chunk.value);
  } finally {
    await reader.cancel();
  }
}
