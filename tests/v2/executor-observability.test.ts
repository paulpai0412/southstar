import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyExecutorTimeouts,
  isExecutorTerminalStatus,
  normalizeTorkStatus,
  validateExecutorBindingPayload,
  type ExecutorBindingPayload,
} from "../../src/v2/executor/observability-types.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import {
  createExecutorBinding,
  listExecutorBindingsForRun,
  updateExecutorBindingStatus,
} from "../../src/v2/executor/bindings.ts";
import { recordExecutorHeartbeat } from "../../src/v2/executor/heartbeat.ts";
import { reconcileExecutorBindings } from "../../src/v2/executor/reconciler.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import type { RuntimeServerContext } from "../../src/v2/server/runtime-context.ts";
import { buildExecutorOpsPageModel } from "../../src/v2/ui-api/page-models/executor.ts";

test("validates executor binding payload and preserves four-layer status fields", () => {
  const payload: ExecutorBindingPayload = {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    executorType: "tork",
    torkJobId: "job-1",
    southstarExecutorStatus: "submitted",
    submittedAt: "2026-06-15T00:00:00.000Z",
    queueTimeoutAt: "2026-06-15T00:02:00.000Z",
    hardTimeoutAt: "2026-06-15T00:10:00.000Z",
    reconcileGeneration: 0,
    idempotencyKey: "executor-binding:run-1:task-1:attempt-1",
  };

  assert.equal(validateExecutorBindingPayload(payload).ok, true);
  assert.equal(isExecutorTerminalStatus("completed"), true);
  assert.equal(isExecutorTerminalStatus("heartbeat-lost"), false);
});

test("normalizes Tork statuses without treating them as workflow completion", () => {
  assert.deepEqual(normalizeTorkStatus("RUNNING"), { raw: "RUNNING", category: "running-like" });
  assert.deepEqual(normalizeTorkStatus("COMPLETED"), { raw: "COMPLETED", category: "completed-like" });
  assert.deepEqual(normalizeTorkStatus("FAILED"), { raw: "FAILED", category: "failed-like" });
  assert.deepEqual(normalizeTorkStatus("PENDING"), { raw: "PENDING", category: "queued-like" });
});

test("classifies queue, heartbeat, and hard timeout separately", () => {
  const now = Date.parse("2026-06-15T00:05:00.000Z");
  const base: ExecutorBindingPayload = {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    executorType: "tork",
    torkJobId: "job-1",
    southstarExecutorStatus: "queued",
    submittedAt: "2026-06-15T00:00:00.000Z",
    queueTimeoutAt: "2026-06-15T00:01:00.000Z",
    hardTimeoutAt: "2026-06-15T00:30:00.000Z",
    reconcileGeneration: 0,
    idempotencyKey: "executor-binding:run-1:task-1:attempt-1",
  };
  assert.deepEqual(classifyExecutorTimeouts(base, now), ["queue-timeout"]);

  assert.deepEqual(classifyExecutorTimeouts({
    ...base,
    southstarExecutorStatus: "running",
    torkObservedStatus: "RUNNING",
    lastHeartbeatAt: "2026-06-15T00:00:30.000Z",
    heartbeatTimeoutAt: "2026-06-15T00:01:30.000Z",
  }, now), ["heartbeat-lost"]);

  assert.deepEqual(classifyExecutorTimeouts({
    ...base,
    southstarExecutorStatus: "running",
    queueTimeoutAt: "2026-06-15T00:20:00.000Z",
    hardTimeoutAt: "2026-06-15T00:04:00.000Z",
  }, now), ["hard-timeout"]);
});

test("creates one durable executor binding per task attempt with submitted history", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-bind",
    status: "running",
    domain: "software",
    goalPrompt: "observe",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-a",
    runId: "run-bind",
    taskKey: "task-a",
    status: "pending",
    sortOrder: 0,
    dependsOn: [],
  });

  const binding = createExecutorBinding(db, {
    runId: "run-bind",
    taskId: "task-a",
    attemptId: "attempt-1",
    torkJobId: "job-bind",
    status: "submitted",
    now: "2026-06-15T00:00:00.000Z",
    queueTimeoutSeconds: 120,
    hardTimeoutSeconds: 600,
  });

  assert.equal(binding.payload.southstarExecutorStatus, "submitted");
  assert.equal(listExecutorBindingsForRun(db, "run-bind").length, 1);
  assert.equal(listHistoryForRun(db, "run-bind").some((event) => event.eventType === "executor.submitted"), true);
});

test("updates executor binding status without creating duplicate binding resources", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-update",
    status: "running",
    domain: "software",
    goalPrompt: "observe",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-a",
    runId: "run-update",
    taskKey: "task-a",
    status: "pending",
    sortOrder: 0,
    dependsOn: [],
  });
  const binding = createExecutorBinding(db, {
    runId: "run-update",
    taskId: "task-a",
    attemptId: "attempt-1",
    torkJobId: "job-update",
    status: "submitted",
    now: "2026-06-15T00:00:00.000Z",
    queueTimeoutSeconds: 120,
    hardTimeoutSeconds: 600,
  });

  updateExecutorBindingStatus(db, {
    bindingId: binding.id,
    status: "running",
    eventType: "executor.observed",
    payloadPatch: {
      torkObservedStatus: "RUNNING",
      startedAt: "2026-06-15T00:00:10.000Z",
    },
  });

  const bindings = listExecutorBindingsForRun(db, "run-update");
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]?.payload.southstarExecutorStatus, "running");
  assert.equal(bindings[0]?.payload.torkObservedStatus, "RUNNING");
});

test("records heartbeat as liveness only and does not complete workflow task", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-hb",
    status: "running",
    domain: "software",
    goalPrompt: "heartbeat",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-hb",
    runId: "run-hb",
    taskKey: "task-hb",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
  createExecutorBinding(db, {
    runId: "run-hb",
    taskId: "task-hb",
    attemptId: "attempt-1",
    torkJobId: "job-hb",
    status: "running",
    now: "2026-06-15T00:00:00.000Z",
    queueTimeoutSeconds: 120,
    hardTimeoutSeconds: 600,
  });

  recordExecutorHeartbeat(db, {
    runId: "run-hb",
    taskId: "task-hb",
    attemptId: "attempt-1",
    executorType: "tork",
    torkJobId: "job-hb",
    rootSessionId: "root-run-hb-task-hb",
    heartbeatSeq: 3,
    phase: "subagent-running",
    message: "still running",
    observedAt: "2026-06-15T00:00:30.000Z",
  });

  const binding = listExecutorBindingsForRun(db, "run-hb")[0];
  assert.equal(binding?.payload.heartbeatSeq, 3);
  assert.equal(binding?.payload.runnerPhase, "subagent-running");
  const task = db.prepare("select status from workflow_tasks where run_id = ? and id = ?")
    .get("run-hb", "task-hb") as { status: string };
  assert.equal(task.status, "running");
  assert.equal(listHistoryForRun(db, "run-hb").filter((event) => event.eventType === "executor.heartbeat").length, 1);
});

test("reconciler marks completed Tork job without callback as callback-missing", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-cb",
    status: "running",
    domain: "software",
    goalPrompt: "observe",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-cb",
    runId: "run-cb",
    taskKey: "task-cb",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
  createExecutorBinding(db, {
    runId: "run-cb",
    taskId: "task-cb",
    attemptId: "attempt-1",
    torkJobId: "job-cb",
    status: "running",
    now: "2026-06-15T00:00:00.000Z",
    queueTimeoutSeconds: 120,
    hardTimeoutSeconds: 600,
  });

  const result = await reconcileExecutorBindings(db, {
    now: "2026-06-15T00:01:00.000Z",
    tork: {
      capabilities: () => ({
        supportsJobInspect: true,
        supportsTaskInspect: false,
        supportsJobCancel: true,
        supportsTaskCancel: false,
        supportsJobLogs: true,
        supportsTaskLogs: false,
        supportsWorkerHealth: false,
      }),
      getJob: async () => ({ jobId: "job-cb", status: "COMPLETED" }),
      getJobLogs: async () => "completed without callback",
      cancelJob: async () => undefined,
    },
  });

  assert.equal(result.findings.some((finding) => finding.classification === "callback-missing"), true);
  assert.equal(listExecutorBindingsForRun(db, "run-cb")[0]?.payload.southstarExecutorStatus, "callback-missing");
  const task = db.prepare("select status from workflow_tasks where run_id = ? and id = ?")
    .get("run-cb", "task-cb") as { status: string };
  assert.equal(task.status, "running");
});

test("reconciler marks terminal Southstar task with running Tork job as orphaned", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-orphan",
    status: "passed",
    domain: "software",
    goalPrompt: "observe",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-orphan",
    runId: "run-orphan",
    taskKey: "task-orphan",
    status: "completed",
    sortOrder: 0,
    dependsOn: [],
  });
  createExecutorBinding(db, {
    runId: "run-orphan",
    taskId: "task-orphan",
    attemptId: "attempt-1",
    torkJobId: "job-orphan",
    status: "running",
    now: "2026-06-15T00:00:00.000Z",
    queueTimeoutSeconds: 120,
    hardTimeoutSeconds: 600,
  });

  const result = await reconcileExecutorBindings(db, {
    now: "2026-06-15T00:01:00.000Z",
    tork: {
      capabilities: () => ({
        supportsJobInspect: true,
        supportsTaskInspect: false,
        supportsJobCancel: true,
        supportsTaskCancel: false,
        supportsJobLogs: true,
        supportsTaskLogs: false,
        supportsWorkerHealth: false,
      }),
      getJob: async () => ({ jobId: "job-orphan", status: "RUNNING" }),
      getJobLogs: async () => "still running",
      cancelJob: async () => undefined,
    },
  });

  assert.equal(result.findings.some((finding) => finding.classification === "orphaned"), true);
  assert.equal(listExecutorBindingsForRun(db, "run-orphan")[0]?.payload.southstarExecutorStatus, "orphaned");
});

test("executor reconcile route writes real reconcile result through Southstar API", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-route",
    status: "running",
    domain: "software",
    goalPrompt: "observe",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-route",
    runId: "run-route",
    taskKey: "task-route",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
  createExecutorBinding(db, {
    runId: "run-route",
    taskId: "task-route",
    attemptId: "attempt-1",
    torkJobId: "job-route",
    status: "running",
    now: "2026-06-15T00:00:00.000Z",
    queueTimeoutSeconds: 120,
    hardTimeoutSeconds: 600,
  });

  const context: RuntimeServerContext = {
    db,
    plannerClient: {
      generate: async () => {
        throw new Error("not used");
      },
    },
    executorProvider: {
      executorType: "tork",
      submit: async () => {
        throw new Error("not used");
      },
    },
    torkObservationClient: {
      capabilities: () => ({
        supportsJobInspect: true,
        supportsTaskInspect: false,
        supportsJobCancel: true,
        supportsTaskCancel: false,
        supportsJobLogs: true,
        supportsTaskLogs: false,
        supportsWorkerHealth: false,
      }),
      getJob: async () => ({ jobId: "job-route", status: "COMPLETED" }),
      getJobLogs: async () => "completed no callback",
      cancelJob: async () => undefined,
    },
  };

  const response = await handleRuntimeRoute(
    context,
    new Request("http://127.0.0.1/api/v2/executor/reconcile", { method: "POST" }),
  );
  const body = await response.json() as {
    ok: boolean;
    result: { findings: Array<{ classification: string }> };
  };
  assert.equal(body.ok, true);
  assert.equal(body.result.findings[0]?.classification, "callback-missing");
});

test("executor ops page exposes workflow executor runner and evaluator status separately", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-ui-ex",
    status: "running",
    domain: "software",
    goalPrompt: "observe",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-ui-ex",
    runId: "run-ui-ex",
    taskKey: "task-ui-ex",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
  createExecutorBinding(db, {
    runId: "run-ui-ex",
    taskId: "task-ui-ex",
    attemptId: "attempt-1",
    torkJobId: "job-ui-ex",
    status: "running",
    now: "2026-06-15T00:00:00.000Z",
    queueTimeoutSeconds: 120,
    hardTimeoutSeconds: 600,
  });
  recordExecutorHeartbeat(db, {
    runId: "run-ui-ex",
    taskId: "task-ui-ex",
    attemptId: "attempt-1",
    executorType: "tork",
    torkJobId: "job-ui-ex",
    rootSessionId: "root-run-ui-ex-task-ui-ex",
    heartbeatSeq: 1,
    phase: "subagent-running",
    observedAt: "2026-06-15T00:00:10.000Z",
  });

  const model = buildExecutorOpsPageModel(db, { jobId: "job-ui-ex" });
  assert.equal(model.selectedJob?.statusLayers.workflowTaskStatus, "running");
  assert.equal(model.selectedJob?.statusLayers.executorStatus, "running");
  assert.equal(model.selectedJob?.statusLayers.runnerStatus, "subagent-running");
  assert.equal(model.selectedJob?.statusLayers.evaluatorStatus, "pending");
});
