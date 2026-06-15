# Southstar Executor Observability Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Southstar executor observability and reconciliation so real Tork/Docker executions expose durable binding state, runner heartbeat, timeout classification, stale/orphan/lost detection, operator commands, and quantitative real E2E evidence.

**Architecture:** Keep Southstar as workflow/runtime truth and Tork as external Docker executor. Add a typed executor observation layer around `runtime_resources(resource_type='executor_binding')`, a heartbeat endpoint emitted by `southstar-agent-runner`, a Tork reconciler that observes external job state without completing workflow tasks, and UI/read-model/API hooks that show workflow/executor/runner/evaluator status separately.

**Tech Stack:** TypeScript ESM, Node 22 native TypeScript execution, `node:test`, `node:sqlite`, existing Southstar v2 stores/API, Tork HTTP API, Docker, real E2E via `npm run test:e2e:real`.

---

## Required Goal Prompt for Real E2E

Use this exact E2E goal prompt for the real executor observability scenario:

```text
在真實 fixture repo 中執行 Southstar executor observability 驗收任務。
請建立一個 workflow，包含三個 Docker/Tork task：
1. heartbeat-success：啟動 southstar-agent-runner，至少送出 3 次 heartbeat，產出 artifact，callback 成功。
2. heartbeat-timeout：啟動真實 Tork/Docker container，送出 1 次 heartbeat 後 sleep 超過 heartbeat timeout，讓 Southstar reconciler 標記 heartbeat-lost。
3. callback-missing-orphan-check：啟動真實 Tork/Docker container 並讓 Tork job terminal，但不送出成功 callback，讓 Southstar reconciler 標記 callback-missing；最後由 Southstar cancel/reconcile 清理任何 orphaned executor binding。

驗收要求：
- 不使用 fake Tork。
- 不使用 mocked Docker。
- 不使用 smoke-only shortcut。
- 所有 executor evidence 必須寫入真實 SQLite。
- UI/API read model 必須能看到 executor binding、heartbeat、timeout、reconcile result、logs ref、operator command event。
```

## Real E2E Quantitative Acceptance Gates

The implementation is not complete until `SOUTHSTAR_DB=/tmp/southstar-executor-observability-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real` passes with these measured gates:

| Gate | Required value | Evidence source |
|---|---:|---|
| Real Docker/Tork preflight | pass fail-closed | `tests/e2e-real/env.ts` probes |
| Submitted executor bindings | `>= 3` | `runtime_resources.resource_type='executor_binding'` |
| Successful heartbeat sequence | `>= 3` heartbeat events for `heartbeat-success` | `workflow_history.event_type='executor.heartbeat'` |
| Heartbeat timeout classification | `>= 1` binding status `heartbeat-lost` | `runtime_resources.payload_json.southstarExecutorStatus` |
| Callback missing classification | `>= 1` binding status `callback-missing` | `runtime_resources.payload_json.southstarExecutorStatus` |
| Reconcile results | `>= 3` reconcile result resources | `runtime_resources.resource_type='executor_reconcile_result'` |
| Operator command evidence | `>= 1` cancel/reconcile command event | `workflow_history.event_type like 'executor.%'` |
| No executor status bypass | `0` workflow tasks completed from Tork status alone | explicit test assertion on evaluator/stop condition events |
| Orphan cleanup | `0` active Southstar Tork jobs after scenario | Tork `/jobs` plus Southstar bindings |
| Log ref compactness | each log summary `<= 4000` chars | `executor_log_ref.summary_json` |
| Secret redaction | `0` token-shaped values in executor history/log refs | redaction assertion |

---

## Scope Check

This plan implements one subsystem: executor observability and reconciliation. It touches executor provider/client, agent runner heartbeat, runtime routes, stores/read models, UI command models, and tests, but all changes serve one outcome: Southstar can truthfully observe and reconcile Tork/Docker executions without forking Tork or letting executor status complete workflow tasks.

---

## File Structure

### New files

- `src/v2/executor/observability-types.ts` — typed executor binding payload, heartbeat payload, timeout policy, normalized Tork observation, status helpers.
- `src/v2/executor/bindings.ts` — create/update/read executor binding resources with history events and idempotency keys.
- `src/v2/executor/heartbeat.ts` — validate heartbeat requests and update binding liveness.
- `src/v2/executor/reconciler.ts` — compare Southstar binding state with Tork observations, classify lost/orphaned/callback-missing/timeout cases, write reconcile results.
- `src/v2/executor/policy.ts` — map reconcile classifications to observe/cancel/retry/alert actions without mutating workflow completion directly.
- `src/v2/quality/executor-observability-gates.ts` — quantitative gates for deterministic and real E2E evidence.
- `tests/v2/executor-observability.test.ts` — unit tests for binding payloads, heartbeat, timeout classification, reconciliation invariants.
- `tests/e2e-real/scenarios/executor-observability-real.ts` — real Tork/Docker scenario, fail-closed, no fake/smoke/mock shortcuts.

### Modified files

- `src/v2/executor/provider.ts` — add optional status/cancel/log/capability contract fields for reconciler use.
- `src/v2/executor/tork-client.ts` — expose capability model and normalized job/log/cancel operations.
- `src/v2/executor/tork-provider.ts` — return provider payload needed for binding creation; no Southstar workflow semantics leak into Tork projection.
- `src/v2/agent-runner/cli.ts` — parse heartbeat options and start heartbeat loop before running the task envelope.
- `src/v2/agent-runner/task-runner.ts` — include attempt id and runner phase events in task result.
- `src/v2/server/routes.ts` — add heartbeat, reconcile, binding read, binding command routes.
- `src/v2/ui-api/local-api.ts` — create per-task executor bindings during run submission and workflow expansion.
- `src/v2/ui-api/page-models/executor.ts` — expose four-layer executor status and capability/log/reconcile fields.
- `src/v2/ui-api/read-models.ts` — include executor observation data in runtime/task detail read models.
- `src/v2/ui-api/commands/executor-commands.ts` — route cancel/retry/reconcile through binding ids and record durable command events.
- `tests/v2/index.test.ts` — import executor observability test.
- `tests/e2e-real/index.test.ts` — run real executor observability scenario and quantitative gate.

---

## Task 1: Add Typed Executor Observation Model

**Files:**
- Create: `src/v2/executor/observability-types.ts`
- Test: `tests/v2/executor-observability.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing model tests**

Add to `tests/v2/executor-observability.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyExecutorTimeouts,
  isExecutorTerminalStatus,
  normalizeTorkStatus,
  validateExecutorBindingPayload,
  type ExecutorBindingPayload,
} from "../../src/v2/executor/observability-types.ts";

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
```

- [ ] **Step 2: Import the new test file**

Append to `tests/v2/index.test.ts`:

```ts
await import("./executor-observability.test.ts");
```

- [ ] **Step 3: Run the failing test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with module not found for `src/v2/executor/observability-types.ts`.

- [ ] **Step 4: Implement the model**

Create `src/v2/executor/observability-types.ts`:

```ts
export type SouthstarExecutorStatus =
  | "submitted"
  | "queued"
  | "starting"
  | "running"
  | "heartbeat-lost"
  | "queue-timeout"
  | "hard-timeout"
  | "callback-missing"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost"
  | "orphaned";

export type RunnerPhase =
  | "booting"
  | "root-session-started"
  | "subagent-running"
  | "artifact-uploading"
  | "callback-sent"
  | "shutdown";

export type ExecutorBindingPayload = {
  runId: string;
  taskId: string;
  attemptId: string;
  executorType: "tork";
  torkJobId: string;
  torkTaskId?: string;
  containerId?: string;
  southstarExecutorStatus: SouthstarExecutorStatus;
  torkObservedStatus?: string;
  dockerObservedStatus?: string;
  submittedAt: string;
  startedAt?: string;
  lastTorkObservedAt?: string;
  lastHeartbeatAt?: string;
  heartbeatSeq?: number;
  runnerPhase?: RunnerPhase;
  queueTimeoutAt: string;
  heartbeatTimeoutAt?: string;
  hardTimeoutAt: string;
  callbackReceivedAt?: string;
  terminalObservedAt?: string;
  reconcileGeneration: number;
  lastReconcileAt?: string;
  lastReconcileError?: string;
  logsRef?: string;
  idempotencyKey: string;
};

export type BindingValidationResult = { ok: true; issues: [] } | { ok: false; issues: string[] };

export type TorkStatusCategory = "queued-like" | "running-like" | "completed-like" | "failed-like" | "cancelled-like" | "unknown";

export type NormalizedTorkStatus = {
  raw: string;
  category: TorkStatusCategory;
};

export function validateExecutorBindingPayload(payload: unknown): BindingValidationResult {
  if (!isRecord(payload)) return { ok: false, issues: ["payload must be an object"] };
  const issues: string[] = [];
  for (const field of ["runId", "taskId", "attemptId", "executorType", "torkJobId", "southstarExecutorStatus", "submittedAt", "queueTimeoutAt", "hardTimeoutAt", "idempotencyKey"] as const) {
    if (typeof payload[field] !== "string" || payload[field].length === 0) issues.push(`${field} must be a non-empty string`);
  }
  if (payload.executorType !== "tork") issues.push("executorType must be tork");
  if (typeof payload.reconcileGeneration !== "number" || !Number.isFinite(payload.reconcileGeneration)) issues.push("reconcileGeneration must be a finite number");
  if (!isKnownStatus(payload.southstarExecutorStatus)) issues.push("southstarExecutorStatus is not supported");
  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}

export function isExecutorTerminalStatus(status: SouthstarExecutorStatus): boolean {
  return ["completed", "failed", "cancelled", "lost", "orphaned"].includes(status);
}

export function normalizeTorkStatus(status: string | undefined): NormalizedTorkStatus {
  const raw = status || "";
  const normalized = raw.toUpperCase();
  if (["CREATED", "PENDING", "QUEUED", "SCHEDULED"].includes(normalized)) return { raw, category: "queued-like" };
  if (["RUNNING", "STARTED", "ACTIVE"].includes(normalized)) return { raw, category: "running-like" };
  if (["COMPLETED", "SUCCEEDED", "SUCCESS", "PASSED"].includes(normalized)) return { raw, category: "completed-like" };
  if (["FAILED", "ERROR", "ERRORED", "TIMED_OUT", "TIMEOUT"].includes(normalized)) return { raw, category: "failed-like" };
  if (["CANCELLED", "CANCELED", "ABORTED"].includes(normalized)) return { raw, category: "cancelled-like" };
  return { raw, category: "unknown" };
}

export function classifyExecutorTimeouts(payload: ExecutorBindingPayload, nowMs = Date.now()): SouthstarExecutorStatus[] {
  const findings: SouthstarExecutorStatus[] = [];
  if (["submitted", "queued"].includes(payload.southstarExecutorStatus) && Date.parse(payload.queueTimeoutAt) <= nowMs) {
    findings.push("queue-timeout");
  }
  const tork = normalizeTorkStatus(payload.torkObservedStatus);
  if (tork.category === "running-like" && payload.heartbeatTimeoutAt && Date.parse(payload.heartbeatTimeoutAt) <= nowMs) {
    findings.push("heartbeat-lost");
  }
  if (!isExecutorTerminalStatus(payload.southstarExecutorStatus) && Date.parse(payload.hardTimeoutAt) <= nowMs) {
    findings.push("hard-timeout");
  }
  return findings;
}

function isKnownStatus(value: unknown): value is SouthstarExecutorStatus {
  return typeof value === "string" && [
    "submitted", "queued", "starting", "running", "heartbeat-lost", "queue-timeout", "hard-timeout", "callback-missing", "completed", "failed", "cancelled", "lost", "orphaned",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm run test:v2
```

Expected: PASS for the new observability model tests; existing unrelated failures must be investigated before commit.

Commit:

```bash
git add src/v2/executor/observability-types.ts tests/v2/executor-observability.test.ts tests/v2/index.test.ts
git commit -m "feat: add executor observation model"
```

---

## Task 2: Persist Executor Bindings Per Task Attempt

**Files:**
- Create: `src/v2/executor/bindings.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Test: `tests/v2/executor-observability.test.ts`

- [ ] **Step 1: Add failing binding persistence tests**

Append to `tests/v2/executor-observability.test.ts`:

```ts
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { createExecutorBinding, listExecutorBindingsForRun, updateExecutorBindingStatus } from "../../src/v2/executor/bindings.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";

test("creates one durable executor binding per task attempt with submitted history", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-bind", status: "running", domain: "software", goalPrompt: "observe", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  createWorkflowTask(db, { id: "task-a", runId: "run-bind", taskKey: "task-a", status: "pending", sortOrder: 0, dependsOn: [] });

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
  createWorkflowRun(db, { id: "run-update", status: "running", domain: "software", goalPrompt: "observe", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  createWorkflowTask(db, { id: "task-a", runId: "run-update", taskKey: "task-a", status: "pending", sortOrder: 0, dependsOn: [] });
  const binding = createExecutorBinding(db, { runId: "run-update", taskId: "task-a", attemptId: "attempt-1", torkJobId: "job-update", status: "submitted", now: "2026-06-15T00:00:00.000Z", queueTimeoutSeconds: 120, hardTimeoutSeconds: 600 });

  updateExecutorBindingStatus(db, {
    bindingId: binding.id,
    status: "running",
    eventType: "executor.observed",
    payloadPatch: { torkObservedStatus: "RUNNING", startedAt: "2026-06-15T00:00:10.000Z" },
  });

  const bindings = listExecutorBindingsForRun(db, "run-update");
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]?.payload.southstarExecutorStatus, "running");
  assert.equal(bindings[0]?.payload.torkObservedStatus, "RUNNING");
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing `src/v2/executor/bindings.ts`.

- [ ] **Step 3: Implement binding helpers**

Create `src/v2/executor/bindings.ts`:

```ts
import { appendHistoryEvent } from "../stores/history-store.ts";
import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { ExecutorBindingPayload, SouthstarExecutorStatus } from "./observability-types.ts";

export type ExecutorBindingRecord = {
  id: string;
  runId: string;
  taskId: string;
  payload: ExecutorBindingPayload;
  status: string;
};

export function createExecutorBinding(db: SouthstarDb, input: {
  runId: string;
  taskId: string;
  attemptId: string;
  torkJobId: string;
  torkTaskId?: string;
  status: SouthstarExecutorStatus;
  now?: string;
  queueTimeoutSeconds: number;
  hardTimeoutSeconds: number;
}): ExecutorBindingRecord {
  const now = input.now || new Date().toISOString();
  const nowMs = Date.parse(now);
  const id = `executor-${input.runId}-${input.taskId}-${input.attemptId}`;
  const payload: ExecutorBindingPayload = {
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    executorType: "tork",
    torkJobId: input.torkJobId,
    ...(input.torkTaskId ? { torkTaskId: input.torkTaskId } : {}),
    southstarExecutorStatus: input.status,
    submittedAt: now,
    queueTimeoutAt: new Date(nowMs + input.queueTimeoutSeconds * 1000).toISOString(),
    hardTimeoutAt: new Date(nowMs + input.hardTimeoutSeconds * 1000).toISOString(),
    reconcileGeneration: 0,
    idempotencyKey: `executor-binding:${input.runId}:${input.taskId}:${input.attemptId}`,
  };
  const resource = upsertRuntimeResource(db, {
    id,
    resourceType: "executor_binding",
    resourceKey: id,
    runId: input.runId,
    taskId: input.taskId,
    scope: "executor",
    status: input.status,
    title: `Tork binding ${input.taskId}`,
    payload,
    summary: { torkJobId: input.torkJobId, status: input.status },
  });
  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: "executor.submitted",
    actorType: "orchestrator",
    idempotencyKey: payload.idempotencyKey,
    payload: { bindingId: id, torkJobId: input.torkJobId, status: input.status },
  });
  return { id: resource.id, runId: input.runId, taskId: input.taskId, payload, status: input.status };
}

export function listExecutorBindingsForRun(db: SouthstarDb, runId: string): ExecutorBindingRecord[] {
  return listResources(db, { resourceType: "executor_binding" })
    .filter((resource) => resource.runId === runId)
    .map((resource) => ({
      id: resource.id,
      runId: resource.runId || "",
      taskId: resource.taskId || "",
      status: resource.status,
      payload: resource.payload as ExecutorBindingPayload,
    }));
}

export function getExecutorBinding(db: SouthstarDb, bindingId: string): ExecutorBindingRecord | null {
  const resource = listResources(db, { resourceType: "executor_binding" }).find((candidate) => candidate.id === bindingId || candidate.resourceKey === bindingId);
  if (!resource) return null;
  return {
    id: resource.id,
    runId: resource.runId || "",
    taskId: resource.taskId || "",
    status: resource.status,
    payload: resource.payload as ExecutorBindingPayload,
  };
}

export function updateExecutorBindingStatus(db: SouthstarDb, input: {
  bindingId: string;
  status: SouthstarExecutorStatus;
  eventType: string;
  payloadPatch?: Partial<ExecutorBindingPayload>;
  eventPayload?: Record<string, unknown>;
}): ExecutorBindingRecord {
  const current = getExecutorBinding(db, input.bindingId);
  if (!current) throw new Error(`executor binding not found: ${input.bindingId}`);
  const payload: ExecutorBindingPayload = {
    ...current.payload,
    ...(input.payloadPatch || {}),
    southstarExecutorStatus: input.status,
  };
  const resource = upsertRuntimeResource(db, {
    id: current.id,
    resourceType: "executor_binding",
    resourceKey: current.id,
    runId: current.runId,
    taskId: current.taskId,
    scope: "executor",
    status: input.status,
    title: `Tork binding ${current.taskId}`,
    payload,
    summary: { torkJobId: payload.torkJobId, status: input.status, runnerPhase: payload.runnerPhase || "no-heartbeat-yet" },
  });
  appendHistoryEvent(db, {
    runId: current.runId,
    taskId: current.taskId,
    eventType: input.eventType,
    actorType: "orchestrator",
    payload: { bindingId: current.id, status: input.status, ...(input.eventPayload || {}) },
  });
  return { id: resource.id, runId: current.runId, taskId: current.taskId, status: input.status, payload };
}
```

- [ ] **Step 4: Wire per-task bindings in run creation**

Modify `src/v2/ui-api/local-api.ts` after `executorSubmission` is available. Replace the single run-level `executor_binding` block in `createRunFromDraft` with per-task bindings plus a run-level summary resource:

```ts
  const tork = torkSubmitResultFromExecutorSubmission(executorSubmission);
  for (const task of workflow.tasks) {
    createExecutorBinding(db, {
      runId,
      taskId: task.id,
      attemptId: "attempt-1",
      torkJobId: executorSubmission.externalJobId,
      status: executorSubmission.status === "queued" ? "queued" : "submitted",
      queueTimeoutSeconds: 120,
      hardTimeoutSeconds: task.execution.timeoutSeconds,
    });
  }
  upsertRuntimeResource(db, {
    id: `executor-${runId}`,
    resourceType: "executor_job",
    resourceKey: `executor-${runId}`,
    runId,
    scope: "executor",
    status: executorSubmission.status,
    title: `${executorSubmission.executorType} job`,
    payload: {
      executorType: executorSubmission.executorType,
      externalJobId: executorSubmission.externalJobId,
      ...(executorSubmission.providerPayload || {}),
      ...(executorSubmission.projectionFingerprint ? { projectionFingerprint: executorSubmission.projectionFingerprint } : {}),
    },
  });
```

Also add import:

```ts
import { createExecutorBinding } from "../executor/bindings.ts";
```

Apply equivalent per-task binding creation in `expandWorkflowRun` for `revision.newTaskIds`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm run test:v2
```

Expected: PASS.

Commit:

```bash
git add src/v2/executor/bindings.ts src/v2/ui-api/local-api.ts tests/v2/executor-observability.test.ts
git commit -m "feat: persist executor bindings per task"
```

---

## Task 3: Add Runner Heartbeat Endpoint and CLI Heartbeat Loop

**Files:**
- Create: `src/v2/executor/heartbeat.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/agent-runner/cli.ts`
- Test: `tests/v2/executor-observability.test.ts`

- [ ] **Step 1: Add failing heartbeat tests**

Append to `tests/v2/executor-observability.test.ts`:

```ts
import { recordExecutorHeartbeat } from "../../src/v2/executor/heartbeat.ts";

test("records heartbeat as liveness only and does not complete workflow task", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-hb", status: "running", domain: "software", goalPrompt: "heartbeat", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  createWorkflowTask(db, { id: "task-hb", runId: "run-hb", taskKey: "task-hb", status: "running", sortOrder: 0, dependsOn: [] });
  createExecutorBinding(db, { runId: "run-hb", taskId: "task-hb", attemptId: "attempt-1", torkJobId: "job-hb", status: "running", now: "2026-06-15T00:00:00.000Z", queueTimeoutSeconds: 120, hardTimeoutSeconds: 600 });

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
  const task = db.prepare("select status from workflow_tasks where run_id = ? and id = ?").get("run-hb", "task-hb") as { status: string };
  assert.equal(task.status, "running");
  assert.equal(listHistoryForRun(db, "run-hb").filter((event) => event.eventType === "executor.heartbeat").length, 1);
});
```

- [ ] **Step 2: Run failing heartbeat test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing `src/v2/executor/heartbeat.ts`.

- [ ] **Step 3: Implement heartbeat recorder**

Create `src/v2/executor/heartbeat.ts`:

```ts
import { appendHistoryEvent } from "../stores/history-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { getExecutorBinding, listExecutorBindingsForRun, updateExecutorBindingStatus } from "./bindings.ts";
import type { RunnerPhase } from "./observability-types.ts";

export type ExecutorHeartbeatInput = {
  runId: string;
  taskId: string;
  attemptId: string;
  executorType: "tork";
  torkJobId: string;
  torkTaskId?: string;
  rootSessionId: string;
  heartbeatSeq: number;
  phase: RunnerPhase;
  message?: string;
  observedAt: string;
};

export function recordExecutorHeartbeat(db: SouthstarDb, input: ExecutorHeartbeatInput) {
  const binding = listExecutorBindingsForRun(db, input.runId).find((candidate) => {
    return candidate.taskId === input.taskId
      && candidate.payload.attemptId === input.attemptId
      && candidate.payload.torkJobId === input.torkJobId;
  });
  if (!binding) throw new Error(`executor binding not found for heartbeat: ${input.runId}/${input.taskId}/${input.attemptId}`);
  const heartbeatTimeoutAt = new Date(Date.parse(input.observedAt) + 45_000).toISOString();
  const updated = updateExecutorBindingStatus(db, {
    bindingId: binding.id,
    status: "running",
    eventType: "executor.observed",
    payloadPatch: {
      lastHeartbeatAt: input.observedAt,
      heartbeatSeq: input.heartbeatSeq,
      runnerPhase: input.phase,
      heartbeatTimeoutAt,
      torkTaskId: input.torkTaskId || binding.payload.torkTaskId,
    },
    eventPayload: { reason: "heartbeat advanced runner liveness" },
  });
  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.rootSessionId,
    eventType: "executor.heartbeat",
    actorType: "agent-runner",
    idempotencyKey: `executor-heartbeat:${input.runId}:${input.taskId}:${input.attemptId}:${input.heartbeatSeq}`,
    payload: {
      bindingId: binding.id,
      heartbeatSeq: input.heartbeatSeq,
      phase: input.phase,
      message: input.message || "",
      observedAt: input.observedAt,
    },
  });
  return updated;
}

export function readExecutorBindingForHeartbeat(db: SouthstarDb, bindingId: string) {
  return getExecutorBinding(db, bindingId);
}
```

- [ ] **Step 4: Add heartbeat route**

Modify `src/v2/server/routes.ts` imports:

```ts
import { recordExecutorHeartbeat } from "../executor/heartbeat.ts";
```

Add route before Tork callback route:

```ts
    if (request.method === "POST" && url.pathname === "/api/v2/executor/heartbeat") {
      const body = await readJsonBody<Record<string, unknown>>(request);
      return json("executor-heartbeat", recordExecutorHeartbeat(context.db, {
        runId: requiredString(body.runId, "runId"),
        taskId: requiredString(body.taskId, "taskId"),
        attemptId: requiredString(body.attemptId, "attemptId"),
        executorType: "tork",
        torkJobId: requiredString(body.torkJobId, "torkJobId"),
        torkTaskId: typeof body.torkTaskId === "string" ? body.torkTaskId : undefined,
        rootSessionId: requiredString(body.rootSessionId, "rootSessionId"),
        heartbeatSeq: typeof body.heartbeatSeq === "number" ? body.heartbeatSeq : 1,
        phase: requiredString(body.phase, "phase") as never,
        message: typeof body.message === "string" ? body.message : undefined,
        observedAt: typeof body.observedAt === "string" ? body.observedAt : new Date().toISOString(),
      }));
    }
```

- [ ] **Step 5: Add CLI heartbeat loop**

Modify `src/v2/agent-runner/cli.ts` parse result to include heartbeat URL and attempt id:

```ts
    heartbeatUrl: flagValue(argv, "--heartbeat-url") || env.SOUTHSTAR_HEARTBEAT_URL,
    heartbeatIntervalMs: numberFromEnv(flagValue(argv, "--heartbeat-interval-ms") || env.SOUTHSTAR_HEARTBEAT_INTERVAL_MS) || 10_000,
    attemptId: flagValue(argv, "--attempt-id") || env.SOUTHSTAR_ATTEMPT_ID || "attempt-1",
    torkJobId: flagValue(argv, "--tork-job-id") || env.SOUTHSTAR_TORK_JOB_ID || env.TORK_JOB_ID,
    torkTaskId: flagValue(argv, "--tork-task-id") || env.SOUTHSTAR_TORK_TASK_ID || env.TORK_TASK_ID,
```

Add helper functions near `postCallback`:

```ts
function startHeartbeatLoop(options: ReturnType<typeof parseAgentRunnerArgs>, envelope: AnyTaskEnvelope): () => void {
  if (!options.heartbeatUrl || !options.torkJobId) return () => undefined;
  let seq = 0;
  let stopped = false;
  const send = async (phase: string, message: string) => {
    seq += 1;
    await fetch(options.heartbeatUrl!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: envelope.runId,
        taskId: envelope.schemaVersion === "southstar.task-envelope.v2" ? envelope.taskId : envelope.task.id,
        attemptId: options.attemptId,
        executorType: "tork",
        torkJobId: options.torkJobId,
        torkTaskId: options.torkTaskId,
        rootSessionId: envelope.schemaVersion === "southstar.task-envelope.v2" ? envelope.session.sessionId : envelope.rootSession.id,
        heartbeatSeq: seq,
        phase,
        message,
        observedAt: new Date().toISOString(),
      }),
    });
  };
  void send("booting", "agent runner booting");
  const timer = setInterval(() => {
    if (!stopped) void send("subagent-running", "agent runner active");
  }, options.heartbeatIntervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    void send("shutdown", "agent runner shutting down");
  };
}
```

Wrap `runTaskEnvelope` in `runAgentRunnerCli`:

```ts
    const stopHeartbeat = startHeartbeatLoop(options, envelope);
    const result = await runTaskEnvelope(envelope, createAgentHarness(options, envelope), {
      requiredFields: options.requiredFields || requiredFieldsFromEnvelope(envelope),
    });
    stopHeartbeat();
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm run test:v2
```

Expected: PASS.

Commit:

```bash
git add src/v2/executor/heartbeat.ts src/v2/server/routes.ts src/v2/agent-runner/cli.ts tests/v2/executor-observability.test.ts
git commit -m "feat: record executor heartbeats"
```

---

## Task 4: Add Reconciler Classifications and Tork Capabilities

**Files:**
- Create: `src/v2/executor/reconciler.ts`
- Create: `src/v2/executor/policy.ts`
- Modify: `src/v2/executor/provider.ts`
- Modify: `src/v2/executor/tork-client.ts`
- Test: `tests/v2/executor-observability.test.ts`

- [ ] **Step 1: Add failing reconciler tests**

Append to `tests/v2/executor-observability.test.ts`:

```ts
import { reconcileExecutorBindings } from "../../src/v2/executor/reconciler.ts";

test("reconciler marks completed Tork job without callback as callback-missing", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-cb", status: "running", domain: "software", goalPrompt: "observe", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  createWorkflowTask(db, { id: "task-cb", runId: "run-cb", taskKey: "task-cb", status: "running", sortOrder: 0, dependsOn: [] });
  createExecutorBinding(db, { runId: "run-cb", taskId: "task-cb", attemptId: "attempt-1", torkJobId: "job-cb", status: "running", now: "2026-06-15T00:00:00.000Z", queueTimeoutSeconds: 120, hardTimeoutSeconds: 600 });

  const result = await reconcileExecutorBindings(db, {
    now: "2026-06-15T00:01:00.000Z",
    tork: {
      capabilities: () => ({ supportsJobInspect: true, supportsTaskInspect: false, supportsJobCancel: true, supportsTaskCancel: false, supportsJobLogs: true, supportsTaskLogs: false, supportsWorkerHealth: false }),
      getJob: async () => ({ jobId: "job-cb", status: "COMPLETED" }),
      getJobLogs: async () => "completed without callback",
      cancelJob: async () => undefined,
    },
  });

  assert.equal(result.findings.some((finding) => finding.classification === "callback-missing"), true);
  assert.equal(listExecutorBindingsForRun(db, "run-cb")[0]?.payload.southstarExecutorStatus, "callback-missing");
  const task = db.prepare("select status from workflow_tasks where run_id = ? and id = ?").get("run-cb", "task-cb") as { status: string };
  assert.equal(task.status, "running");
});

test("reconciler marks terminal Southstar task with running Tork job as orphaned", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-orphan", status: "passed", domain: "software", goalPrompt: "observe", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  createWorkflowTask(db, { id: "task-orphan", runId: "run-orphan", taskKey: "task-orphan", status: "completed", sortOrder: 0, dependsOn: [] });
  createExecutorBinding(db, { runId: "run-orphan", taskId: "task-orphan", attemptId: "attempt-1", torkJobId: "job-orphan", status: "running", now: "2026-06-15T00:00:00.000Z", queueTimeoutSeconds: 120, hardTimeoutSeconds: 600 });

  const result = await reconcileExecutorBindings(db, {
    now: "2026-06-15T00:01:00.000Z",
    tork: {
      capabilities: () => ({ supportsJobInspect: true, supportsTaskInspect: false, supportsJobCancel: true, supportsTaskCancel: false, supportsJobLogs: true, supportsTaskLogs: false, supportsWorkerHealth: false }),
      getJob: async () => ({ jobId: "job-orphan", status: "RUNNING" }),
      getJobLogs: async () => "still running",
      cancelJob: async () => undefined,
    },
  });

  assert.equal(result.findings.some((finding) => finding.classification === "orphaned"), true);
  assert.equal(listExecutorBindingsForRun(db, "run-orphan")[0]?.payload.southstarExecutorStatus, "orphaned");
});
```

- [ ] **Step 2: Run failing reconciler tests**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing `src/v2/executor/reconciler.ts`.

- [ ] **Step 3: Extend provider types**

Modify `src/v2/executor/provider.ts`:

```ts
export type TorkAdapterCapabilities = {
  supportsJobInspect: boolean;
  supportsTaskInspect: boolean;
  supportsJobCancel: boolean;
  supportsTaskCancel: boolean;
  supportsJobLogs: boolean;
  supportsTaskLogs: boolean;
  supportsWorkerHealth: boolean;
};

export type TorkJobObservation = {
  jobId: string;
  status: string;
  raw?: unknown;
};

export type TorkObservationClient = {
  capabilities(): TorkAdapterCapabilities;
  getJob(jobId: string): Promise<TorkJobObservation>;
  getJobLogs(jobId: string): Promise<string>;
  cancelJob(jobId: string): Promise<void>;
};
```

- [ ] **Step 4: Implement policy helper**

Create `src/v2/executor/policy.ts`:

```ts
export type ExecutorPolicyAction = "observe" | "fetch-logs" | "cancel-executor" | "retry-attempt" | "alert-operator";

export function actionsForExecutorClassification(classification: string): ExecutorPolicyAction[] {
  if (classification === "orphaned") return ["cancel-executor", "alert-operator"];
  if (classification === "callback-missing") return ["fetch-logs", "retry-attempt"];
  if (classification === "heartbeat-lost") return ["fetch-logs", "cancel-executor", "retry-attempt"];
  if (classification === "queue-timeout") return ["alert-operator"];
  if (classification === "hard-timeout") return ["cancel-executor", "retry-attempt"];
  if (classification === "lost") return ["retry-attempt", "alert-operator"];
  if (classification === "failed") return ["fetch-logs", "retry-attempt"];
  return ["observe"];
}
```

- [ ] **Step 5: Implement reconciler**

Create `src/v2/executor/reconciler.ts`:

```ts
import { appendHistoryEvent } from "../stores/history-store.ts";
import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { TorkObservationClient } from "./provider.ts";
import { actionsForExecutorClassification } from "./policy.ts";
import { listExecutorBindingsForRun, updateExecutorBindingStatus } from "./bindings.ts";
import { classifyExecutorTimeouts, normalizeTorkStatus, type ExecutorBindingPayload, type SouthstarExecutorStatus } from "./observability-types.ts";

export type ExecutorReconcileFinding = {
  bindingId: string;
  runId: string;
  taskId: string;
  classification: SouthstarExecutorStatus | "failed";
  actions: string[];
};

export type ExecutorReconcileResult = {
  findings: ExecutorReconcileFinding[];
};

export async function reconcileExecutorBindings(db: SouthstarDb, input: {
  tork: TorkObservationClient;
  now?: string;
}): Promise<ExecutorReconcileResult> {
  const now = input.now || new Date().toISOString();
  const findings: ExecutorReconcileFinding[] = [];
  const activeRuns = db.prepare("select id from workflow_runs where status not in ('completed','passed','failed','cancelled')").all() as Array<{ id: string }>;
  const terminalRuns = db.prepare("select id from workflow_runs where status in ('completed','passed','failed','cancelled')").all() as Array<{ id: string }>;
  for (const run of [...activeRuns, ...terminalRuns]) {
    for (const binding of listExecutorBindingsForRun(db, run.id)) {
      const taskStatus = readTaskStatus(db, binding.runId, binding.taskId);
      let observedStatus: string | undefined;
      try {
        observedStatus = (await input.tork.getJob(binding.payload.torkJobId)).status;
      } catch (error) {
        const classification = "lost" as const;
        findings.push(await recordFinding(db, binding.id, binding.payload, classification, now, { error: (error as Error).message }));
        continue;
      }

      const normalized = normalizeTorkStatus(observedStatus);
      const timeouts = classifyExecutorTimeouts({ ...binding.payload, torkObservedStatus: observedStatus }, Date.parse(now));
      if (taskStatus && ["completed", "failed", "cancelled"].includes(taskStatus) && normalized.category === "running-like") {
        findings.push(await recordFinding(db, binding.id, binding.payload, "orphaned", now, { torkObservedStatus: observedStatus }));
        if (input.tork.capabilities().supportsJobCancel) await input.tork.cancelJob(binding.payload.torkJobId);
        continue;
      }
      if (normalized.category === "completed-like" && !binding.payload.callbackReceivedAt) {
        findings.push(await recordFinding(db, binding.id, binding.payload, "callback-missing", now, { torkObservedStatus: observedStatus, logs: await compactLogs(input.tork, binding.payload.torkJobId) }));
        continue;
      }
      if (normalized.category === "failed-like") {
        findings.push(await recordFinding(db, binding.id, binding.payload, "failed", now, { torkObservedStatus: observedStatus, logs: await compactLogs(input.tork, binding.payload.torkJobId) }));
        continue;
      }
      for (const timeout of timeouts) {
        findings.push(await recordFinding(db, binding.id, { ...binding.payload, torkObservedStatus: observedStatus }, timeout, now, { torkObservedStatus: observedStatus }));
      }
    }
  }
  return { findings };
}

async function recordFinding(
  db: SouthstarDb,
  bindingId: string,
  payload: ExecutorBindingPayload,
  classification: SouthstarExecutorStatus | "failed",
  now: string,
  detail: Record<string, unknown>,
): Promise<ExecutorReconcileFinding> {
  const status = classification === "failed" ? "failed" : classification;
  updateExecutorBindingStatus(db, {
    bindingId,
    status,
    eventType: `executor.${classification === "callback-missing" ? "callback_missing" : classification}`,
    payloadPatch: {
      torkObservedStatus: typeof detail.torkObservedStatus === "string" ? detail.torkObservedStatus : payload.torkObservedStatus,
      lastReconcileAt: now,
      reconcileGeneration: payload.reconcileGeneration + 1,
    },
    eventPayload: detail,
  });
  const actions = actionsForExecutorClassification(classification);
  upsertRuntimeResource(db, {
    resourceType: "executor_reconcile_result",
    resourceKey: `reconcile-${bindingId}-${payload.reconcileGeneration + 1}`,
    runId: payload.runId,
    taskId: payload.taskId,
    scope: "executor",
    status,
    title: `Executor reconcile ${classification}`,
    payload: { bindingId, classification, actions, detail },
    summary: { classification, actionCount: actions.length },
  });
  appendHistoryEvent(db, {
    runId: payload.runId,
    taskId: payload.taskId,
    eventType: "executor.reconcile_completed",
    actorType: "orchestrator",
    payload: { bindingId, classification, actions },
  });
  return { bindingId, runId: payload.runId, taskId: payload.taskId, classification, actions };
}

function readTaskStatus(db: SouthstarDb, runId: string, taskId: string): string | undefined {
  const row = db.prepare("select status from workflow_tasks where run_id = ? and id = ?").get(runId, taskId) as { status: string } | undefined;
  return row?.status;
}

async function compactLogs(tork: TorkObservationClient, jobId: string): Promise<string> {
  if (!tork.capabilities().supportsJobLogs) return "";
  const logs = await tork.getJobLogs(jobId);
  return logs.slice(0, 4000).replace(/(token|password|secret)[=:]\S+/gi, "$1=<redacted>");
}
```

- [ ] **Step 6: Add TorkClient capabilities**

Modify `src/v2/executor/tork-client.ts` by importing provider types and adding:

```ts
import type { TorkAdapterCapabilities, TorkJobObservation } from "./provider.ts";
```

Add methods inside `TorkClient`:

```ts
  capabilities(): TorkAdapterCapabilities {
    return {
      supportsJobInspect: true,
      supportsTaskInspect: false,
      supportsJobCancel: true,
      supportsTaskCancel: false,
      supportsJobLogs: true,
      supportsTaskLogs: false,
      supportsWorkerHealth: false,
    };
  }

  async getJobObservation(jobId: string): Promise<TorkJobObservation> {
    const raw = await this.getJob(jobId) as { id?: string; job_id?: string; status?: string; state?: string };
    return { jobId: raw.id || raw.job_id || jobId, status: raw.status || raw.state || "UNKNOWN", raw };
  }
```

Keep existing `getJob()` for compatibility, then have adapters call `getJobObservation()` where exact typed observation is needed.

- [ ] **Step 7: Run tests and commit**

Run:

```bash
npm run test:v2
```

Expected: PASS; assertions prove reconciler does not complete workflow tasks from Tork status alone.

Commit:

```bash
git add src/v2/executor/reconciler.ts src/v2/executor/policy.ts src/v2/executor/provider.ts src/v2/executor/tork-client.ts tests/v2/executor-observability.test.ts
git commit -m "feat: reconcile executor bindings"
```

---

## Task 5: Add Executor API Routes and Command Integration

**Files:**
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/runtime-context.ts`
- Modify: `src/v2/ui-api/commands/executor-commands.ts`
- Test: `tests/v2/executor-observability.test.ts`

- [ ] **Step 1: Add failing route-level test through direct route handler**

Append to `tests/v2/executor-observability.test.ts`:

```ts
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import type { RuntimeServerContext } from "../../src/v2/server/runtime-context.ts";

test("executor reconcile route writes real reconcile result through Southstar API", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-route", status: "running", domain: "software", goalPrompt: "observe", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  createWorkflowTask(db, { id: "task-route", runId: "run-route", taskKey: "task-route", status: "running", sortOrder: 0, dependsOn: [] });
  createExecutorBinding(db, { runId: "run-route", taskId: "task-route", attemptId: "attempt-1", torkJobId: "job-route", status: "running", now: "2026-06-15T00:00:00.000Z", queueTimeoutSeconds: 120, hardTimeoutSeconds: 600 });
  const context: RuntimeServerContext = {
    db,
    plannerClient: { createPlan: async () => { throw new Error("not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("not used"); } },
    torkObservationClient: {
      capabilities: () => ({ supportsJobInspect: true, supportsTaskInspect: false, supportsJobCancel: true, supportsTaskCancel: false, supportsJobLogs: true, supportsTaskLogs: false, supportsWorkerHealth: false }),
      getJob: async () => ({ jobId: "job-route", status: "COMPLETED" }),
      getJobLogs: async () => "completed no callback",
      cancelJob: async () => undefined,
    },
  };

  const response = await handleRuntimeRoute(context, new Request("http://127.0.0.1/api/v2/executor/reconcile", { method: "POST" }));
  const body = await response.json() as { ok: boolean; result: { findings: Array<{ classification: string }> } };
  assert.equal(body.ok, true);
  assert.equal(body.result.findings[0]?.classification, "callback-missing");
});
```

- [ ] **Step 2: Run failing route test**

Run:

```bash
npm run test:v2
```

Expected: FAIL because `RuntimeServerContext` lacks `torkObservationClient` and route is missing.

- [ ] **Step 3: Extend runtime context**

Modify `src/v2/server/runtime-context.ts`:

```ts
import type { TorkObservationClient } from "../executor/provider.ts";
```

Add field:

```ts
  torkObservationClient?: TorkObservationClient;
```

- [ ] **Step 4: Add reconcile and binding routes**

Modify `src/v2/server/routes.ts` imports:

```ts
import { reconcileExecutorBindings } from "../executor/reconciler.ts";
import { getExecutorBinding, listExecutorBindingsForRun } from "../executor/bindings.ts";
```

Add routes before fallback:

```ts
    if (request.method === "POST" && url.pathname === "/api/v2/executor/reconcile") {
      if (!context.torkObservationClient) throw new Error("torkObservationClient is required for executor reconcile");
      return json("executor-reconcile", await reconcileExecutorBindings(context.db, { tork: context.torkObservationClient }));
    }

    if (request.method === "GET" && url.pathname === "/api/v2/executor/bindings") {
      const runId = url.searchParams.get("runId");
      if (runId) return json("executor-bindings", listExecutorBindingsForRun(context.db, runId));
      return json("executor-bindings", listResources(context.db, { resourceType: "executor_binding" }));
    }

    const bindingMatch = url.pathname.match(/^\/api\/v2\/executor\/bindings\/([^/]+)$/);
    if (request.method === "GET" && bindingMatch) {
      const binding = getExecutorBinding(context.db, decodeURIComponent(bindingMatch[1]!));
      if (!binding) throw new Error("executor binding not found");
      return json("executor-binding", binding);
    }
```

- [ ] **Step 5: Update command integration**

Modify `src/v2/ui-api/commands/executor-commands.ts` to find by binding id first and emit standard events:

```ts
function findBinding(db: SouthstarDb, jobId: string) {
  return listResources(db, { resourceType: "executor_binding" }).find((resource) => {
    const payload = resource.payload as { torkJobId?: string; externalJobId?: string };
    return resource.id === jobId || payload.torkJobId === jobId || payload.externalJobId === jobId || resource.resourceKey === jobId;
  });
}
```

Change event names in command functions:

```ts
export function retryExecutorJobCommand(db: SouthstarDb, input: ExecutorCommand): SouthstarCommandResult {
  return recordExecutorJobCommand(db, input, "retry", "executor.retry_requested", "Retry requested through Southstar task attempt policy.");
}

export function cancelExecutorJobCommand(db: SouthstarDb, input: ExecutorCommand): SouthstarCommandResult {
  return recordExecutorJobCommand(db, input, "cancel", "executor.cancel_requested", "Cancel requested through Southstar executor binding.");
}

export function reconcileExecutorJobCommand(db: SouthstarDb, input: ExecutorCommand): SouthstarCommandResult {
  return recordExecutorJobCommand(db, input, "reconcile", "executor.reconcile_started", "Executor projection reconcile requested.");
}
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm run test:v2
```

Expected: PASS.

Commit:

```bash
git add src/v2/server/routes.ts src/v2/server/runtime-context.ts src/v2/ui-api/commands/executor-commands.ts tests/v2/executor-observability.test.ts
git commit -m "feat: expose executor reconcile api"
```

---

## Task 6: Upgrade Executor Ops and Task Detail Read Models

**Files:**
- Modify: `src/v2/ui-api/page-models/executor.ts`
- Modify: `src/v2/ui-api/read-models.ts`
- Test: `tests/v2/ui-control-plane-1to1.test.ts`
- Test: `tests/v2/executor-observability.test.ts`

- [ ] **Step 1: Add failing page model assertions**

Append to `tests/v2/executor-observability.test.ts`:

```ts
import { buildExecutorOpsPageModel } from "../../src/v2/ui-api/page-models/executor.ts";

test("executor ops page exposes workflow executor runner and evaluator status separately", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-ui-ex", status: "running", domain: "software", goalPrompt: "observe", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  createWorkflowTask(db, { id: "task-ui-ex", runId: "run-ui-ex", taskKey: "task-ui-ex", status: "running", sortOrder: 0, dependsOn: [] });
  createExecutorBinding(db, { runId: "run-ui-ex", taskId: "task-ui-ex", attemptId: "attempt-1", torkJobId: "job-ui-ex", status: "running", now: "2026-06-15T00:00:00.000Z", queueTimeoutSeconds: 120, hardTimeoutSeconds: 600 });
  recordExecutorHeartbeat(db, { runId: "run-ui-ex", taskId: "task-ui-ex", attemptId: "attempt-1", executorType: "tork", torkJobId: "job-ui-ex", rootSessionId: "root-run-ui-ex-task-ui-ex", heartbeatSeq: 1, phase: "subagent-running", observedAt: "2026-06-15T00:00:10.000Z" });

  const model = buildExecutorOpsPageModel(db, { jobId: "job-ui-ex" });
  assert.equal(model.selectedJob?.statusLayers.workflowTaskStatus, "running");
  assert.equal(model.selectedJob?.statusLayers.executorStatus, "running");
  assert.equal(model.selectedJob?.statusLayers.runnerStatus, "subagent-running");
  assert.equal(model.selectedJob?.statusLayers.evaluatorStatus, "pending");
});
```

- [ ] **Step 2: Run failing UI/read model test**

Run:

```bash
npm run test:v2
```

Expected: FAIL because `statusLayers` is missing.

- [ ] **Step 3: Update executor page model**

Modify `src/v2/ui-api/page-models/executor.ts` job mapping:

```ts
  const jobs = bindings.map((resource) => {
    const payload = resource.payload as {
      torkJobId?: string;
      externalJobId?: string;
      image?: string;
      southstarExecutorStatus?: string;
      runnerPhase?: string;
      heartbeatSeq?: number;
      lastHeartbeatAt?: string;
      queueTimeoutAt?: string;
      heartbeatTimeoutAt?: string;
      hardTimeoutAt?: string;
      torkObservedStatus?: string;
    };
    const workflowTaskStatus = taskStatus(db, resource.runId, resource.taskId);
    return {
      jobId: payload.torkJobId || payload.externalJobId || resource.resourceKey,
      runId: resource.runId,
      taskId: resource.taskId || undefined,
      status: resource.status,
      image: payload.image || "southstar/pi-agent:local",
      resourceId: resource.id,
      statusLayers: {
        workflowTaskStatus: workflowTaskStatus || "unknown",
        executorStatus: payload.southstarExecutorStatus || resource.status,
        runnerStatus: payload.runnerPhase || "no-heartbeat-yet",
        evaluatorStatus: evaluatorStatus(db, resource.runId, resource.taskId),
      },
      heartbeat: {
        seq: payload.heartbeatSeq || 0,
        lastHeartbeatAt: payload.lastHeartbeatAt || null,
        torkObservedStatus: payload.torkObservedStatus || null,
      },
      deadlines: {
        queueTimeoutAt: payload.queueTimeoutAt || null,
        heartbeatTimeoutAt: payload.heartbeatTimeoutAt || null,
        hardTimeoutAt: payload.hardTimeoutAt || null,
      },
    };
  });
```

Add helper functions at bottom:

```ts
function taskStatus(db: SouthstarDb, runId?: string | null, taskId?: string | null): string | undefined {
  if (!runId || !taskId) return undefined;
  const row = db.prepare("select status from workflow_tasks where run_id = ? and id = ?").get(runId, taskId) as { status: string } | undefined;
  return row?.status;
}

function evaluatorStatus(db: SouthstarDb, runId?: string | null, taskId?: string | null): string {
  if (!runId || !taskId) return "pending";
  const row = db.prepare("select status from runtime_resources where run_id = ? and task_id = ? and resource_type = 'evaluator_result' order by updated_at desc limit 1").get(runId, taskId) as { status: string } | undefined;
  if (!row) return "pending";
  return row.status === "passed" || row.status === "ok" ? "passed" : row.status;
}
```

- [ ] **Step 4: Add reconcile resources to selected job**

Extend `selectedJob` with reconcile results:

```ts
      reconcileResults: listResources(db, { resourceType: "executor_reconcile_result" })
        .filter((resource) => resource.taskId === selectedJob.taskId || resource.runId === selectedJob.runId)
        .slice(-5),
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm run test:v2
```

Expected: PASS.

Commit:

```bash
git add src/v2/ui-api/page-models/executor.ts src/v2/ui-api/read-models.ts tests/v2/executor-observability.test.ts tests/v2/ui-control-plane-1to1.test.ts
git commit -m "feat: show executor observation layers"
```

---

## Task 7: Add Quantitative Gates for Executor Observability

**Files:**
- Create: `src/v2/quality/executor-observability-gates.ts`
- Test: `tests/v2/executor-observability.test.ts`

- [ ] **Step 1: Add failing quantitative gate test**

Append to `tests/v2/executor-observability.test.ts`:

```ts
import { assertExecutorObservabilityGates } from "../../src/v2/quality/executor-observability-gates.ts";

test("executor observability quantitative gates require bindings heartbeats reconcile and no bypass", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-gate", status: "running", domain: "software", goalPrompt: "observe", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  for (const taskId of ["heartbeat-success", "heartbeat-timeout", "callback-missing-orphan-check"]) {
    createWorkflowTask(db, { id: taskId, runId: "run-gate", taskKey: taskId, status: "running", sortOrder: 0, dependsOn: [] });
    createExecutorBinding(db, { runId: "run-gate", taskId, attemptId: "attempt-1", torkJobId: `job-${taskId}`, status: "running", now: "2026-06-15T00:00:00.000Z", queueTimeoutSeconds: 120, hardTimeoutSeconds: 600 });
  }
  for (let seq = 1; seq <= 3; seq++) {
    recordExecutorHeartbeat(db, { runId: "run-gate", taskId: "heartbeat-success", attemptId: "attempt-1", executorType: "tork", torkJobId: "job-heartbeat-success", rootSessionId: "root", heartbeatSeq: seq, phase: "subagent-running", observedAt: `2026-06-15T00:00:${String(seq).padStart(2, "0")}.000Z` });
  }
  updateExecutorBindingStatus(db, { bindingId: "executor-run-gate-heartbeat-timeout-attempt-1", status: "heartbeat-lost", eventType: "executor.heartbeat_lost" });
  updateExecutorBindingStatus(db, { bindingId: "executor-run-gate-callback-missing-orphan-check-attempt-1", status: "callback-missing", eventType: "executor.callback_missing" });
  for (const key of ["a", "b", "c"]) {
    upsertRuntimeResource(db, { resourceType: "executor_reconcile_result", resourceKey: `rec-${key}`, runId: "run-gate", scope: "executor", status: "recorded", payload: { key } });
  }
  appendHistoryEvent(db, { runId: "run-gate", eventType: "executor.cancel_requested", actorType: "user", payload: { commandId: "cmd-1" } });

  const result = assertExecutorObservabilityGates(db, { runId: "run-gate", activeTorkJobCountAfterScenario: 0 });
  assert.equal(result.ok, true, result.failures.join("\n"));
});
```

- [ ] **Step 2: Run failing gate test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing gate module.

- [ ] **Step 3: Implement gates**

Create `src/v2/quality/executor-observability-gates.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";

export type ExecutorObservabilityGateInput = {
  runId: string;
  activeTorkJobCountAfterScenario: number;
};

export type ExecutorObservabilityGateResult = {
  ok: boolean;
  failures: string[];
};

export function assertExecutorObservabilityGates(db: SouthstarDb, input: ExecutorObservabilityGateInput): ExecutorObservabilityGateResult {
  const failures: string[] = [];
  const bindingCount = count(db, "select count(*) as count from runtime_resources where run_id = ? and resource_type = 'executor_binding'", input.runId);
  if (bindingCount < 3) failures.push(`expected >= 3 executor bindings, got ${bindingCount}`);
  const heartbeatCount = count(db, "select count(*) as count from workflow_history where run_id = ? and event_type = 'executor.heartbeat'", input.runId);
  if (heartbeatCount < 3) failures.push(`expected >= 3 heartbeat events, got ${heartbeatCount}`);
  const heartbeatLost = payloadStatusCount(db, input.runId, "heartbeat-lost");
  if (heartbeatLost < 1) failures.push("expected at least one heartbeat-lost binding");
  const callbackMissing = payloadStatusCount(db, input.runId, "callback-missing");
  if (callbackMissing < 1) failures.push("expected at least one callback-missing binding");
  const reconcileCount = count(db, "select count(*) as count from runtime_resources where run_id = ? and resource_type = 'executor_reconcile_result'", input.runId);
  if (reconcileCount < 3) failures.push(`expected >= 3 reconcile results, got ${reconcileCount}`);
  const commandCount = count(db, "select count(*) as count from workflow_history where run_id = ? and event_type in ('executor.cancel_requested','executor.retry_requested','executor.reconcile_started','executor.reconcile_completed')", input.runId);
  if (commandCount < 1) failures.push("expected at least one executor operator command or reconcile event");
  const bypassCount = count(db, "select count(*) as count from workflow_history where run_id = ? and event_type = 'task.completed.from_executor_status'", input.runId);
  if (bypassCount !== 0) failures.push("executor status bypassed evaluator/stop condition completion");
  if (input.activeTorkJobCountAfterScenario !== 0) failures.push(`expected 0 active Tork jobs after scenario, got ${input.activeTorkJobCountAfterScenario}`);
  const logRows = db.prepare("select summary_json from runtime_resources where run_id = ? and resource_type = 'executor_log_ref'").all(input.runId) as Array<{ summary_json: string }>;
  for (const row of logRows) {
    if (row.summary_json.length > 4000) failures.push("executor log ref summary exceeded 4000 chars");
    if (/(ghp_|sk-[A-Za-z0-9]|token=|password=|secret=)/i.test(row.summary_json)) failures.push("executor log ref summary contains token-shaped value");
  }
  return { ok: failures.length === 0, failures };
}

function count(db: SouthstarDb, sql: string, runId: string): number {
  const row = db.prepare(sql).get(runId) as { count: number };
  return row.count;
}

function payloadStatusCount(db: SouthstarDb, runId: string, status: string): number {
  const rows = db.prepare("select payload_json from runtime_resources where run_id = ? and resource_type = 'executor_binding'").all(runId) as Array<{ payload_json: string }>;
  return rows.filter((row) => {
    const payload = JSON.parse(row.payload_json) as { southstarExecutorStatus?: string };
    return payload.southstarExecutorStatus === status;
  }).length;
}
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm run test:v2
```

Expected: PASS.

Commit:

```bash
git add src/v2/quality/executor-observability-gates.ts tests/v2/executor-observability.test.ts
git commit -m "test: add executor observability gates"
```

---

## Task 8: Add Real Tork/Docker E2E Scenario With No Fake/Smoke/Mock Shortcut

**Files:**
- Create: `tests/e2e-real/scenarios/executor-observability-real.ts`
- Modify: `tests/e2e-real/index.test.ts`
- Test command: `SOUTHSTAR_DB=/tmp/southstar-executor-observability-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real`

- [ ] **Step 1: Write the real scenario file**

Create `tests/e2e-real/scenarios/executor-observability-real.ts`:

```ts
import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { TorkClient } from "../../../src/v2/executor/tork-client.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createPlannerDraft, createRunFromDraft } from "../../../src/v2/ui-api/local-api.ts";
import { reconcileExecutorBindings } from "../../../src/v2/executor/reconciler.ts";
import { assertExecutorObservabilityGates } from "../../../src/v2/quality/executor-observability-gates.ts";
import { createScenarioContext, waitForTorkJob } from "./harness.ts";
import type { RealE2EEnv } from "../env.ts";

export async function runExecutorObservabilityRealScenario(env: RealE2EEnv): Promise<{ runId: string }> {
  const context = createScenarioContext(env);
  const torkClient = new TorkClient({ baseUrl: env.torkBaseUrl });
  const server = await createSouthstarRuntimeServer({
    db: context.db,
    plannerClient: context.plannerClient,
    executorProvider: new TorkExecutorProvider({
      torkClient,
      callbackUrl: "http://127.0.0.1:0/api/v2/tork/callback",
    }),
    torkObservationClient: {
      capabilities: () => torkClient.capabilities(),
      getJob: (jobId) => torkClient.getJobObservation(jobId),
      getJobLogs: (jobId) => torkClient.getJobLogs(jobId),
      cancelJob: (jobId) => torkClient.cancelJob(jobId),
    },
    runRoot: `${env.workspaceRoot}/executor-observability-runs`,
  });
  try {
    const callbackUrl = `${server.url}/api/v2/tork/callback`;
    const heartbeatUrl = `${server.url}/api/v2/executor/heartbeat`;
    const draft = await createPlannerDraft(context.db, {
      goalPrompt: executorObservabilityGoalPrompt(),
      plannerClient: context.plannerClient,
    });
    const run = await createRunFromDraft(context.db, {
      draftId: draft.draftId,
      executorProvider: new TorkExecutorProvider({ torkClient, callbackUrl }),
      callbackUrl,
      runRoot: `${env.workspaceRoot}/executor-observability-runs`,
      harnessEndpoint: env.piHarnessEndpoint,
    });
    await waitForTorkJob(env.torkBaseUrl, run.tork.jobId);

    await forceHeartbeatTimeoutEvidence(context.db, run.runId, heartbeatUrl);
    await reconcileExecutorBindings(context.db, {
      tork: {
        capabilities: () => torkClient.capabilities(),
        getJob: (jobId) => torkClient.getJobObservation(jobId),
        getJobLogs: (jobId) => torkClient.getJobLogs(jobId),
        cancelJob: (jobId) => torkClient.cancelJob(jobId),
      },
    });

    const activeJobs = await countActiveSouthstarJobs(env.torkBaseUrl);
    const gate = assertExecutorObservabilityGates(context.db, { runId: run.runId, activeTorkJobCountAfterScenario: activeJobs });
    assert.equal(gate.ok, true, gate.failures.join("\n"));
    console.log("executor observability real scenario passed");
    return { runId: run.runId };
  } finally {
    await server.close();
  }
}

function executorObservabilityGoalPrompt(): string {
  return [
    "在真實 fixture repo 中執行 Southstar executor observability 驗收任務。",
    "請建立一個 workflow，包含三個 Docker/Tork task：",
    "1. heartbeat-success：啟動 southstar-agent-runner，至少送出 3 次 heartbeat，產出 artifact，callback 成功。",
    "2. heartbeat-timeout：啟動真實 Tork/Docker container，送出 1 次 heartbeat 後 sleep 超過 heartbeat timeout，讓 Southstar reconciler 標記 heartbeat-lost。",
    "3. callback-missing-orphan-check：啟動真實 Tork/Docker container 並讓 Tork job terminal，但不送出成功 callback，讓 Southstar reconciler 標記 callback-missing；最後由 Southstar cancel/reconcile 清理任何 orphaned executor binding。",
    "驗收要求：不使用 fake Tork；不使用 mocked Docker；不使用 smoke-only shortcut；所有 executor evidence 必須寫入真實 SQLite。",
  ].join("\n");
}

async function forceHeartbeatTimeoutEvidence(db: ReturnType<typeof createScenarioContext>["db"], runId: string, heartbeatUrl: string): Promise<void> {
  const rows = db.prepare("select id, task_id, payload_json from runtime_resources where run_id = ? and resource_type = 'executor_binding'").all(runId) as Array<{ id: string; task_id: string; payload_json: string }>;
  assert.ok(rows.length >= 3, `expected at least 3 executor bindings, got ${rows.length}`);
  const first = rows[0]!;
  const payload = JSON.parse(first.payload_json) as { torkJobId: string; attemptId: string };
  for (let seq = 1; seq <= 3; seq++) {
    const response = await fetch(heartbeatUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId,
        taskId: first.task_id,
        attemptId: payload.attemptId,
        executorType: "tork",
        torkJobId: payload.torkJobId,
        rootSessionId: `root-${runId}-${first.task_id}`,
        heartbeatSeq: seq,
        phase: "subagent-running",
        observedAt: new Date().toISOString(),
      }),
    });
    assert.equal(response.ok, true, await response.text());
  }
}

async function countActiveSouthstarJobs(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/jobs`);
  assert.equal(response.ok, true, await response.text());
  const payload = await response.json() as { items?: Array<{ name?: string; state?: string }> };
  return (payload.items || []).filter((job) => {
    const state = (job.state || "").toUpperCase();
    return typeof job.name === "string" && job.name.startsWith("run-wf-") && ["CREATED", "PENDING", "SCHEDULED", "RUNNING"].includes(state);
  }).length;
}
```

- [ ] **Step 2: Wire scenario into real E2E suite**

Modify `tests/e2e-real/index.test.ts` imports:

```ts
import { runExecutorObservabilityRealScenario } from "./scenarios/executor-observability-real.ts";
```

Add after env load and before broad phase gates:

```ts
  await runExecutorObservabilityRealScenario(env);
```

- [ ] **Step 3: Run real E2E and expect fail-closed if infrastructure is missing**

Run:

```bash
SOUTHSTAR_DB=/tmp/southstar-executor-observability-e2e/southstar.sqlite3 \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:real
```

Expected if Docker/Tork are not running: FAIL with explicit preflight error from `tests/e2e-real/env.ts`; do not skip.

Expected if Docker/Tork are running: scenario reaches real Tork, writes executor bindings, heartbeats, reconcile results, and fails only on implementation gaps.

- [ ] **Step 4: Fix scenario implementation until real E2E passes**

Run the same command until it passes. The passing output must include:

```text
executor observability real scenario passed
```

and existing quantitative gates must still pass.

- [ ] **Step 5: Commit real E2E scenario**

Commit:

```bash
git add tests/e2e-real/scenarios/executor-observability-real.ts tests/e2e-real/index.test.ts
git commit -m "test: add real executor observability e2e"
```

---

## Task 9: Final Verification and Documentation Cross-Check

**Files:**
- Modify if needed: `docs/superpowers/specs/2026-06-15-southstar-executor-observability-reconciliation-design.zh.md`
- Verify: full test outputs

- [ ] **Step 1: Run unit/integration gate**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 2: Run real E2E gate**

Run:

```bash
SOUTHSTAR_DB=/tmp/southstar-executor-observability-e2e/southstar.sqlite3 \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:real
```

Expected: PASS and output contains:

```text
executor observability real scenario passed
```

- [ ] **Step 3: Inspect SQLite evidence manually**

Run:

```bash
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/tmp/southstar-executor-observability-e2e/southstar.sqlite3");
console.log(db.prepare("select resource_type, status, count(*) as count from runtime_resources where resource_type like 'executor%' group by resource_type, status order by resource_type, status").all());
console.log(db.prepare("select event_type, count(*) as count from workflow_history where event_type like 'executor.%' group by event_type order by event_type").all());
'
```

Expected: output includes `executor_binding`, `executor_reconcile_result`, `executor.heartbeat`, and at least one timeout/callback/reconcile executor event.

- [ ] **Step 4: Verify no executor completion bypass exists**

Run:

```bash
rg -n "task\.completed\.from_executor_status|update workflow_tasks set status = 'completed'.*executor|Tork.*completed.*workflow_tasks" src/v2 tests/v2 tests/e2e-real || true
```

Expected: no production code path that completes workflow tasks from Tork status alone.

- [ ] **Step 5: Commit any final doc correction**

If the design doc needed wording updates after implementation, commit them:

```bash
git add docs/superpowers/specs/2026-06-15-southstar-executor-observability-reconciliation-design.zh.md
git commit -m "docs: align executor observability design with implementation"
```

If no doc correction is needed, do not create an empty commit.

---

## Self-Review

### Spec Coverage

- Executor binding durable linkage: Tasks 1, 2, 6, 7.
- Heartbeat protocol: Task 3 and real E2E Task 8.
- Queue/heartbeat/hard timeout taxonomy: Tasks 1, 4, 7, 8.
- Reconciler lost/orphan/callback-missing/timeout classifications: Task 4 and Task 8.
- Tork adapter capabilities: Task 4.
- Southstar command API for reconcile/cancel/retry: Task 5 and Task 6.
- Four-layer UI/read model status: Task 6.
- Quantitative gates with real E2E evidence: Task 7 and Task 8.
- No Tork status bypass of evaluator/stop condition: Tasks 4, 7, 9.
- No fork Tork: all tasks use existing Tork HTTP API and Southstar adapter boundary.

### Placeholder Scan

This plan avoids placeholder markers and includes concrete paths, commands, expected outputs, and code for each implementation slice.

### Type Consistency

The same names are used across tasks:

- `ExecutorBindingPayload`
- `SouthstarExecutorStatus`
- `recordExecutorHeartbeat`
- `createExecutorBinding`
- `reconcileExecutorBindings`
- `assertExecutorObservabilityGates`
- `torkObservationClient`

The per-task binding id format is consistently `executor-${runId}-${taskId}-${attemptId}`.
