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
import { appendHistoryEvent, listHistoryForRun } from "../../src/v2/stores/history-store.ts";
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
import { listResources, upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { assertExecutorObservabilityGates } from "../../src/v2/quality/executor-observability-gates.ts";

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

test("reconciler dispatches cancel action for orphaned binding", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-orphan-action",
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
    id: "task-orphan-action",
    runId: "run-orphan-action",
    taskKey: "task-orphan-action",
    status: "completed",
    sortOrder: 0,
    dependsOn: [],
  });
  createExecutorBinding(db, {
    runId: "run-orphan-action",
    taskId: "task-orphan-action",
    attemptId: "attempt-1",
    torkJobId: "job-orphan-action",
    status: "running",
    now: "2026-06-15T00:00:00.000Z",
    queueTimeoutSeconds: 120,
    hardTimeoutSeconds: 600,
  });

  let cancelCalls = 0;
  await reconcileExecutorBindings(db, {
    now: "2026-06-15T00:01:00.000Z",
    tork: {
      capabilities: () => ({ supportsJobInspect: true, supportsTaskInspect: false, supportsJobCancel: true, supportsTaskCancel: false, supportsJobLogs: true, supportsTaskLogs: false, supportsWorkerHealth: false }),
      getJob: async () => ({ jobId: "job-orphan-action", status: "RUNNING" }),
      getJobLogs: async () => "still running",
      cancelJob: async () => { cancelCalls += 1; },
    },
  });

  assert.equal(cancelCalls, 1);
  const commands = listResources(db, { resourceType: "executor_job_command" })
    .filter((resource) => resource.runId === "run-orphan-action" && resource.taskId === "task-orphan-action");
  assert.equal(commands.length >= 1, true);
  assert.equal(listHistoryForRun(db, "run-orphan-action").some((event) => event.eventType === "executor.action_dispatched"), true);
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
  upsertRuntimeResource(db, {
    resourceType: "executor_reconcile_result",
    resourceKey: "reconcile-run-ui-ex-task-ui-ex",
    runId: "run-ui-ex",
    taskId: "task-ui-ex",
    scope: "executor",
    status: "callback-missing",
    payload: {
      bindingId: "executor-run-ui-ex-task-ui-ex-attempt-1",
      classification: "callback-missing",
      actions: ["fetch-logs", "retry-attempt"],
    },
  });
  upsertRuntimeResource(db, {
    resourceType: "executor_job_command",
    resourceKey: "command-run-ui-ex-task-ui-ex",
    runId: "run-ui-ex",
    taskId: "task-ui-ex",
    scope: "executor",
    status: "executed",
    payload: {
      bindingId: "executor-run-ui-ex-task-ui-ex-attempt-1",
      jobId: "job-ui-ex",
      action: "retry-attempt",
    },
  });

  const model = buildExecutorOpsPageModel(db, { jobId: "job-ui-ex" });
  assert.equal(model.selectedJob?.statusLayers.workflowTaskStatus, "running");
  assert.equal(model.selectedJob?.statusLayers.executorStatus, "running");
  assert.equal(model.selectedJob?.statusLayers.runnerStatus, "subagent-running");
  assert.equal(model.selectedJob?.statusLayers.evaluatorStatus, "pending");
  assert.equal(typeof model.selectedJob?.heartbeat.lastHeartbeatAgeMs, "number");
  assert.equal(model.selectedJob?.reconcile.lastClassification, "callback-missing");
  assert.equal(model.selectedJob?.lastAction?.action, "retry-attempt");
});

test("executor observability gates pass when durable evidence exists", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-gate",
    status: "running",
    domain: "software",
    goalPrompt: "observe",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });

  for (const taskId of ["heartbeat-success", "heartbeat-timeout", "callback-missing-orphan-check"]) {
    createWorkflowTask(db, {
      id: taskId,
      runId: "run-gate",
      taskKey: taskId,
      status: "running",
      sortOrder: 0,
      dependsOn: [],
    });
    createExecutorBinding(db, {
      runId: "run-gate",
      taskId,
      attemptId: "attempt-1",
      torkJobId: `job-${taskId}`,
      status: "running",
      now: "2026-06-15T00:00:00.000Z",
      queueTimeoutSeconds: 120,
      hardTimeoutSeconds: 600,
    });
  }

  for (let seq = 1; seq <= 3; seq += 1) {
    recordExecutorHeartbeat(db, {
      runId: "run-gate",
      taskId: "heartbeat-success",
      attemptId: "attempt-1",
      executorType: "tork",
      torkJobId: "job-heartbeat-success",
      rootSessionId: "root-run-gate-heartbeat-success",
      heartbeatSeq: seq,
      phase: "subagent-running",
      observedAt: `2026-06-15T00:00:${String(seq).padStart(2, "0")}.000Z`,
    });
  }

  updateExecutorBindingStatus(db, {
    bindingId: "executor-run-gate-heartbeat-timeout-attempt-1",
    status: "heartbeat-lost",
    eventType: "executor.heartbeat_lost",
  });
  updateExecutorBindingStatus(db, {
    bindingId: "executor-run-gate-callback-missing-orphan-check-attempt-1",
    status: "callback-missing",
    eventType: "executor.callback_missing",
  });

  for (const key of ["a", "b", "c"]) {
    upsertRuntimeResource(db, {
      resourceType: "executor_reconcile_result",
      resourceKey: `rec-${key}`,
      runId: "run-gate",
      scope: "executor",
      status: "recorded",
      payload: { key },
    });
  }

  appendHistoryEvent(db, {
    runId: "run-gate",
    eventType: "executor.cancel_requested",
    actorType: "user",
    payload: { commandId: "cmd-1" },
  });

  const result = assertExecutorObservabilityGates(db, {
    runId: "run-gate",
    activeTorkJobCountAfterScenario: 0,
  });
  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("executor observability gates fail closed when evidence is missing", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-gate-missing",
    status: "running",
    domain: "software",
    goalPrompt: "observe",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });

  const result = assertExecutorObservabilityGates(db, {
    runId: "run-gate-missing",
    activeTorkJobCountAfterScenario: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.some((failure) => failure.includes("expected >= 3 executor bindings")), true);
  assert.equal(result.failures.some((failure) => failure.includes("expected 0 active Tork jobs")), true);
});
