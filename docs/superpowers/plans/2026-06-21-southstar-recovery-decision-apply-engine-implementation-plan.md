# Southstar Recovery Decision Apply Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the canonical Recovery Decision Apply Engine so Southstar can turn recorded `recovery_decision` resources into idempotent task/run/hand state transitions, provider evidence, operator-approved recovery, and completion-gate-safe retry execution.

**Architecture:** Keep `RuntimeExceptionController` focused on observe/classify/decide. Add a separate `RecoveryDecisionApplier` that claims `recovery_decision` resources, writes `recovery_execution` evidence, applies state transitions, resolves or preserves exceptions, and lets the existing scheduler dispatch released `pending` tasks. Reuse `PostgresRecoveryController` for managed primitives such as checkpointing and hand reprovisioning.

**Tech Stack:** TypeScript, Node.js `node:test`, `tsx`, Postgres, existing Southstar v2 runtime stores, managed brain/hand providers, Tork executor provider integration, Next.js API routes.

---

## Source Spec

Implement this plan against:

- `docs/superpowers/specs/2026-06-21-southstar-recovery-decision-apply-engine-design.zh.md`

Do not reintroduce SQLite or V1/Northstar runtime paths.

## Repo Commands

Use the repo-local git metadata:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short --branch --untracked-files=all
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add <files>
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "<message>"
```

Run Postgres-backed tests with:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

## File Structure

Create:

- `src/v2/exceptions/recovery-executions.ts`
  Idempotent store helpers for `recovery_execution` resources and history events.
- `src/v2/exceptions/recovery-decision-applier.ts`
  Canonical state machine for applying `recovery_decision` paths.
- `src/v2/exceptions/recovery-approval-service.ts`
  Operator approval/rejection service for `waiting_operator_approval` and `blocked` decisions.
- `src/v2/executor/provider-actions.ts`
  Provider action facade for poll/cancel/destroy evidence. It delegates to `ExecutorProvider.cancel` where available and records failures as evidence.
- `tests/v2/recovery-executions.test.ts`
- `tests/v2/recovery-decision-applier.test.ts`
- `tests/v2/operator-recovery-approval-routes.test.ts`
- `tests/e2e-postgres/cases/21-recovery-decision-apply-requeue.test.ts`
- `tests/e2e-postgres/cases/22-recovery-decision-apply-reprovision.test.ts`
- `tests/e2e-postgres/cases/23-operator-approved-recovery-apply.test.ts`
- `tests/e2e-postgres/cases/24-provider-unreachable-apply-failure.test.ts`

Modify:

- `src/v2/exceptions/types.ts`
  Add decision statuses and recovery execution payload types.
- `src/v2/exceptions/runtime-exception-controller.ts`
  Create operator-required decisions in `waiting_operator_approval`.
- `src/v2/exceptions/postgres-runtime-exceptions.ts`
  Keep existing resolve helper; no ownership expansion.
- `src/v2/evaluators/completion-gate.ts`
  Block unapplied decisions and started recovery executions.
- `src/v2/server/runtime-loops.ts`
  Add `recovery-decision-applier` loop item and runtime controller.
- `src/v2/server/routes.ts`
  Add approval and explicit apply routes.
- `src/v2/read-models/postgres-run-inspection.ts`
  Include latest `recovery_execution` and completion-blocking flags.
- `src/v2/read-models/managed-agents.ts`
  Include `recovery_execution` in managed resource projection.
- `tests/v2/index.test.ts`
- `tests/e2e-postgres/postgres-real-matrix-static.test.ts`
- `tests/e2e-postgres/README.md`
- `package.json`
- `docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md`

---

### Task 1: Recovery Decision And Execution Contracts

**Files:**
- Modify: `src/v2/exceptions/types.ts`
- Create: `src/v2/exceptions/recovery-executions.ts`
- Test: `tests/v2/recovery-executions.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing recovery execution store test**

Create `tests/v2/recovery-executions.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  completeRecoveryExecutionPg,
  startRecoveryExecutionPg,
} from "../../src/v2/exceptions/recovery-executions.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("recovery execution store records idempotent started and succeeded evidence", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-recovery-execution-store",
      status: "running",
      domain: "software",
      goalPrompt: "apply recovery decision",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId: "run-recovery-execution-store",
      taskKey: "task-a",
      status: "queued",
      sortOrder: 0,
      dependsOn: [],
    });

    const started = await startRecoveryExecutionPg(db, {
      decisionId: "decision-a",
      exceptionId: "exception-a",
      runId: "run-recovery-execution-store",
      taskId: "task-a",
      path: "requeue-hand-execution",
      now: "2026-06-21T11:00:00.000Z",
    });
    const duplicate = await startRecoveryExecutionPg(db, {
      decisionId: "decision-a",
      exceptionId: "exception-a",
      runId: "run-recovery-execution-store",
      taskId: "task-a",
      path: "requeue-hand-execution",
      now: "2026-06-21T11:00:30.000Z",
    });

    assert.equal(duplicate.executionId, started.executionId);
    assert.equal(duplicate.resourceKey, started.resourceKey);

    const completed = await completeRecoveryExecutionPg(db, {
      runId: "run-recovery-execution-store",
      executionResourceKey: started.resourceKey,
      status: "succeeded",
      completedAt: "2026-06-21T11:01:00.000Z",
      stateChanges: [
        {
          resourceType: "hand_execution",
          resourceKey: "hand-execution:run-recovery-execution-store:task-a:attempt-1",
          fromStatus: "queued",
          toStatus: "lost",
          reason: "queue timeout requeue",
        },
      ],
      providerActions: [
        {
          providerId: "tork",
          action: "cancel",
          status: "skipped",
          evidenceRef: "hand-execution:run-recovery-execution-store:task-a:attempt-1",
        },
      ],
    });

    assert.equal(completed.status, "succeeded");
    assert.equal(completed.payload.status, "succeeded");
    assert.equal(completed.payload.stateChanges.length, 1);
    assert.equal(completed.payload.providerActions.length, 1);

    const resources = await listResourcesPg(db, { resourceType: "recovery_execution" });
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.status, "succeeded");
    assert.equal(resources[0]?.payload.schemaVersion, "southstar.runtime.recovery_execution.v1");

    const history = await listHistoryForRunPg(db, "run-recovery-execution-store");
    assert.deepEqual(history.map((event) => event.eventType), [
      "recovery_execution.started",
      "recovery_execution.succeeded",
    ]);
  } finally {
    await db.close();
  }
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./recovery-executions.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL with an import error for `src/v2/exceptions/recovery-executions.ts`.

- [ ] **Step 3: Add recovery decision and execution types**

In `src/v2/exceptions/types.ts`, replace `RuntimeRecoveryDecisionRecord` status and add execution types:

```ts
export const RECOVERY_DECISION_RESOURCE_TYPE = "recovery_decision";
export const RECOVERY_DECISION_SCHEMA_VERSION = "southstar.runtime.recovery_decision.v1";

export const RECOVERY_DECISION_STATUSES = [
  "recorded",
  "waiting_operator_approval",
  "approved",
  "applying",
  "applied",
  "blocked",
  "failed",
  "superseded",
] as const;

export type RecoveryDecisionStatus = typeof RECOVERY_DECISION_STATUSES[number];

export type RuntimeRecoveryDecisionRecord = {
  decisionId: string;
  resourceKey: string;
  status: RecoveryDecisionStatus;
  payload: RecoveryDecisionPayload;
};

export const RECOVERY_EXECUTION_RESOURCE_TYPE = "recovery_execution";
export const RECOVERY_EXECUTION_SCHEMA_VERSION = "southstar.runtime.recovery_execution.v1";

export type RecoveryExecutionStatus = "started" | "succeeded" | "failed" | "superseded" | "blocked";
export type RecoveryProviderActionName = "poll" | "cancel" | "destroy" | "provision" | "snapshot" | "rollback" | "wake";
export type RecoveryProviderActionStatus = "requested" | "succeeded" | "failed" | "skipped";

export type RecoveryExecutionStateChange = {
  resourceType: string;
  resourceKey: string;
  fromStatus?: string;
  toStatus?: string;
  reason: string;
};

export type RecoveryExecutionProviderAction = {
  providerId: string;
  action: RecoveryProviderActionName;
  status: RecoveryProviderActionStatus;
  evidenceRef?: string;
  errorExcerpt?: string;
};

export type RecoveryExecutionPayload = {
  schemaVersion: typeof RECOVERY_EXECUTION_SCHEMA_VERSION;
  executionId: string;
  decisionId: string;
  exceptionId: string;
  runId: string;
  taskId?: string;
  path: RecoveryPath;
  status: RecoveryExecutionStatus;
  stateChanges: RecoveryExecutionStateChange[];
  providerActions: RecoveryExecutionProviderAction[];
  createdAt: string;
  completedAt?: string;
};

export type RecoveryExecutionRecord = {
  executionId: string;
  resourceKey: string;
  status: RecoveryExecutionStatus;
  payload: RecoveryExecutionPayload;
};
```

- [ ] **Step 4: Implement the recovery execution store**

Create `src/v2/exceptions/recovery-executions.ts`:

```ts
import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  appendHistoryEventPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
  type RuntimeResourceRecord,
} from "../stores/postgres-runtime-store.ts";
import type {
  RecoveryExecutionPayload,
  RecoveryExecutionProviderAction,
  RecoveryExecutionRecord,
  RecoveryExecutionStateChange,
  RecoveryExecutionStatus,
  RecoveryPath,
} from "./types.ts";
import {
  RECOVERY_EXECUTION_RESOURCE_TYPE,
  RECOVERY_EXECUTION_SCHEMA_VERSION,
} from "./types.ts";

export async function startRecoveryExecutionPg(
  db: SouthstarDb,
  input: {
    decisionId: string;
    exceptionId: string;
    runId: string;
    taskId?: string;
    path: RecoveryPath;
    now?: string;
  },
): Promise<RecoveryExecutionRecord> {
  const resourceKey = recoveryExecutionResourceKey(input.decisionId);
  const executionId = recoveryExecutionId(resourceKey);
  const createdAt = input.now ?? new Date().toISOString();

  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const existing = toRecoveryExecutionRecord(
      await getResourceByKeyPg(tx, RECOVERY_EXECUTION_RESOURCE_TYPE, resourceKey),
    );
    if (existing) {
      await appendStartedHistoryOncePg(tx, existing);
      return existing;
    }

    const payload: RecoveryExecutionPayload = {
      schemaVersion: RECOVERY_EXECUTION_SCHEMA_VERSION,
      executionId,
      decisionId: input.decisionId,
      exceptionId: input.exceptionId,
      runId: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      path: input.path,
      status: "started",
      stateChanges: [],
      providerActions: [],
      createdAt,
    };

    await upsertRuntimeResourcePg(tx, {
      id: executionId,
      resourceType: RECOVERY_EXECUTION_RESOURCE_TYPE,
      resourceKey,
      runId: input.runId,
      taskId: input.taskId,
      scope: "recovery",
      status: "started",
      title: `Recovery execution ${input.path}`,
      payload,
      summary: { decisionId: input.decisionId, path: input.path, status: "started" },
    });

    const record = requireRecoveryExecutionRecord(
      await getResourceByKeyPg(tx, RECOVERY_EXECUTION_RESOURCE_TYPE, resourceKey),
    );
    await appendStartedHistoryOncePg(tx, record);
    return record;
  });
}

export async function completeRecoveryExecutionPg(
  db: SouthstarDb,
  input: {
    runId: string;
    executionResourceKey: string;
    status: Exclude<RecoveryExecutionStatus, "started">;
    completedAt?: string;
    stateChanges: RecoveryExecutionStateChange[];
    providerActions: RecoveryExecutionProviderAction[];
  },
): Promise<RecoveryExecutionRecord> {
  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const current = requireRecoveryExecutionRecord(
      await getResourceByKeyPg(tx, RECOVERY_EXECUTION_RESOURCE_TYPE, input.executionResourceKey),
    );
    if (current.payload.runId !== input.runId) {
      throw new Error(`recovery execution ${input.executionResourceKey} does not belong to run ${input.runId}`);
    }
    if (current.status !== "started") return current;

    const completedAt = input.completedAt ?? new Date().toISOString();
    const payload: RecoveryExecutionPayload = {
      ...current.payload,
      status: input.status,
      stateChanges: input.stateChanges,
      providerActions: input.providerActions,
      completedAt,
    };

    await upsertRuntimeResourcePg(tx, {
      id: current.executionId,
      resourceType: RECOVERY_EXECUTION_RESOURCE_TYPE,
      resourceKey: current.resourceKey,
      runId: current.payload.runId,
      taskId: current.payload.taskId,
      scope: "recovery",
      status: input.status,
      title: `Recovery execution ${current.payload.path}`,
      payload,
      summary: {
        decisionId: current.payload.decisionId,
        path: current.payload.path,
        status: input.status,
        stateChangeCount: input.stateChanges.length,
        providerActionCount: input.providerActions.length,
      },
    });

    const record = requireRecoveryExecutionRecord(
      await getResourceByKeyPg(tx, RECOVERY_EXECUTION_RESOURCE_TYPE, input.executionResourceKey),
    );
    await appendTerminalHistoryOncePg(tx, record);
    return record;
  });
}

export function recoveryExecutionResourceKey(decisionId: string): string {
  return `recovery_execution:${decisionId}:attempt-1`;
}

function recoveryExecutionId(resourceKey: string): string {
  return `recovery-execution-${createHash("sha256").update(resourceKey).digest("hex").slice(0, 24)}`;
}

function toRecoveryExecutionRecord(resource: RuntimeResourceRecord | null): RecoveryExecutionRecord | null {
  if (!resource) return null;
  const payload = resource.payload as Partial<RecoveryExecutionPayload>;
  if (
    resource.resourceType !== RECOVERY_EXECUTION_RESOURCE_TYPE ||
    payload.schemaVersion !== RECOVERY_EXECUTION_SCHEMA_VERSION ||
    typeof payload.executionId !== "string" ||
    typeof payload.decisionId !== "string" ||
    typeof payload.exceptionId !== "string" ||
    typeof payload.runId !== "string" ||
    typeof payload.path !== "string" ||
    typeof payload.status !== "string"
  ) {
    return null;
  }
  return {
    executionId: payload.executionId,
    resourceKey: resource.resourceKey,
    status: payload.status as RecoveryExecutionRecord["status"],
    payload: payload as RecoveryExecutionPayload,
  };
}

function requireRecoveryExecutionRecord(resource: RuntimeResourceRecord | null): RecoveryExecutionRecord {
  const record = toRecoveryExecutionRecord(resource);
  if (!record) throw new Error("recovery execution not found");
  return record;
}

async function appendStartedHistoryOncePg(db: SouthstarDb, record: RecoveryExecutionRecord): Promise<void> {
  await appendHistoryEventOncePg(db, {
    runId: record.payload.runId,
    taskId: record.payload.taskId,
    eventType: "recovery_execution.started",
    idempotencyKey: `${record.resourceKey}:started`,
    payload: {
      executionId: record.executionId,
      decisionId: record.payload.decisionId,
      exceptionId: record.payload.exceptionId,
      path: record.payload.path,
    },
  });
}

async function appendTerminalHistoryOncePg(db: SouthstarDb, record: RecoveryExecutionRecord): Promise<void> {
  await appendHistoryEventOncePg(db, {
    runId: record.payload.runId,
    taskId: record.payload.taskId,
    eventType: `recovery_execution.${record.status}`,
    idempotencyKey: `${record.resourceKey}:${record.status}`,
    payload: {
      executionId: record.executionId,
      decisionId: record.payload.decisionId,
      exceptionId: record.payload.exceptionId,
      path: record.payload.path,
      stateChanges: record.payload.stateChanges,
      providerActions: record.payload.providerActions,
    },
  });
}

async function appendHistoryEventOncePg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId?: string;
    eventType: string;
    idempotencyKey: string;
    payload: unknown;
  },
): Promise<void> {
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.runId, input.idempotencyKey],
  );
  if (existing) return;
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: input.eventType,
    actorType: "orchestrator",
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  });
}
```

- [ ] **Step 5: Run the test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for `recovery-executions.test.ts`; other tests remain at their prior status.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/exceptions/types.ts src/v2/exceptions/recovery-executions.ts tests/v2/recovery-executions.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add recovery execution store"
```

---

### Task 2: Recovery Decision Applier Requeue Path

**Files:**
- Create: `src/v2/exceptions/recovery-decision-applier.ts`
- Test: `tests/v2/recovery-decision-applier.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing requeue apply test**

Create `tests/v2/recovery-decision-applier.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";
import { createRecoveryDecisionApplier } from "../../src/v2/exceptions/recovery-decision-applier.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("requeue-hand-execution applies queue timeout recovery and is idempotent", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTaskAndHandExecution(db, {
      runId: "run-apply-requeue",
      taskId: "task-a",
      taskStatus: "queued",
      handStatus: "queued",
      attemptId: "attempt-1",
    });
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: "run-apply-requeue",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-apply-requeue:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T12:00:00.000Z",
      evidenceRefs: ["hand-execution:run-apply-requeue:task-a:attempt-1"],
      providerEvidence: { externalJobId: "job-queued" },
    });
    const decision = await controller.decide(await controller.classify(exception));

    const applier = createRecoveryDecisionApplier({ db });
    const first = await applier.applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: "2026-06-21T12:01:00.000Z",
    });
    const second = await applier.applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: "2026-06-21T12:01:30.000Z",
    });

    assert.equal(first.status, "applied");
    assert.equal(second.status, "applied");
    assert.equal(second.executionResourceKey, first.executionResourceKey);

    const handExecutions = (await listResourcesPg(db, { resourceType: "hand_execution" }))
      .filter((resource) => resource.runId === "run-apply-requeue");
    assert.equal(handExecutions.length, 1);
    assert.equal(handExecutions[0]?.status, "lost");
    assert.equal(handExecutions[0]?.payload.status, "lost");

    const tasks = await db.query<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      ["run-apply-requeue", "task-a"],
    );
    assert.equal(tasks.rows[0]?.status, "pending");

    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-apply-requeue");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.status, "applied");

    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === "run-apply-requeue");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.status, "resolved");

    const executions = (await listResourcesPg(db, { resourceType: "recovery_execution" }))
      .filter((resource) => resource.runId === "run-apply-requeue");
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.status, "succeeded");
    assert.deepEqual(executions[0]?.payload.stateChanges.map((change: { toStatus: string }) => change.toStatus), [
      "lost",
      "pending",
      "applied",
      "resolved",
    ]);

    const history = await listHistoryForRunPg(db, "run-apply-requeue");
    assert.equal(history.some((event) => event.eventType === "recovery_execution.started"), true);
    assert.equal(history.some((event) => event.eventType === "recovery_execution.succeeded"), true);
    assert.equal(history.some((event) => event.eventType === "runtime_exception.resolved"), true);
  } finally {
    await db.close();
  }
});

async function seedRunTaskAndHandExecution(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  input: {
    runId: string;
    taskId: string;
    taskStatus: string;
    handStatus: "queued" | "running" | "completed" | "failed" | "lost" | "superseded" | "cancelled";
    attemptId: string;
  },
): Promise<void> {
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: "running",
    domain: "software",
    goalPrompt: "apply recovery decision",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: input.taskId,
    runId: input.runId,
    taskKey: input.taskId,
    status: input.taskStatus,
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-a",
  });
  const handExecutionId = `hand-execution:${input.runId}:${input.taskId}:${input.attemptId}`;
  await upsertRuntimeResourcePg(db, {
    id: handExecutionId,
    resourceType: "hand_execution",
    resourceKey: handExecutionId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: "session-a",
    scope: "hand",
    status: input.handStatus,
    title: `Hand execution ${input.taskId}`,
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId,
      providerId: "tork",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: "session-a",
      attemptId: input.attemptId,
      brainBindingId: `brain-binding-${input.runId}-${input.taskId}`,
      handBindingId: `hand-binding-${input.runId}-${input.taskId}`,
      externalJobId: "job-queued",
      status: input.handStatus,
      queuedAt: "2026-06-21T11:55:00.000Z",
      queueTimeoutSeconds: 60,
      heartbeatTimeoutSeconds: 30,
    },
    summary: { providerId: "tork", attemptId: input.attemptId },
  });
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./recovery-decision-applier.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL with an import error for `recovery-decision-applier.ts`.

- [ ] **Step 3: Implement the applier public API and requeue path**

Create `src/v2/exceptions/recovery-decision-applier.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import {
  appendHistoryEventPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
  type RuntimeResourceRecord,
} from "../stores/postgres-runtime-store.ts";
import { resolveRuntimeExceptionPg } from "./postgres-runtime-exceptions.ts";
import {
  completeRecoveryExecutionPg,
  startRecoveryExecutionPg,
} from "./recovery-executions.ts";
import type {
  RecoveryDecisionPayload,
  RecoveryDecisionStatus,
  RecoveryExecutionProviderAction,
  RecoveryExecutionStateChange,
  RuntimeRecoveryDecisionRecord,
} from "./types.ts";
import {
  RECOVERY_DECISION_RESOURCE_TYPE,
  RUNTIME_EXCEPTION_RESOURCE_TYPE,
} from "./types.ts";

export type RecoveryDecisionApplyResult = {
  decisionResourceKey: string;
  status: "applied" | "skipped" | "blocked" | "failed" | "superseded";
  executionResourceKey?: string;
  reason: string;
};

export function createRecoveryDecisionApplier(deps: { db: SouthstarDb }): {
  applyNext(input?: { runId?: string; now?: string }): Promise<RecoveryDecisionApplyResult | null>;
  applyDecision(input: { decisionResourceKey: string; now?: string }): Promise<RecoveryDecisionApplyResult>;
} {
  return {
    async applyNext(input = {}) {
      const row = await deps.db.maybeOne<{ resource_key: string }>(
        `select resource_key
           from southstar.runtime_resources
          where resource_type = $1
            and status in ('recorded', 'approved', 'applying')
            and ($2::text is null or run_id = $2)
          order by created_at, resource_key
          limit 1`,
        [RECOVERY_DECISION_RESOURCE_TYPE, input.runId ?? null],
      );
      if (!row) return null;
      return await this.applyDecision({ decisionResourceKey: row.resource_key, now: input.now });
    },
    async applyDecision(input) {
      const decision = await getDecisionForUpdate(deps.db, input.decisionResourceKey);
      if (decision.status === "applied") {
        const executionKey = `recovery_execution:${decision.decisionId}:attempt-1`;
        return {
          decisionResourceKey: decision.resourceKey,
          status: "applied",
          executionResourceKey: executionKey,
          reason: "decision already applied",
        };
      }
      if (decision.status === "waiting_operator_approval") {
        return { decisionResourceKey: decision.resourceKey, status: "skipped", reason: "waiting for operator approval" };
      }
      if (decision.status === "blocked" || decision.status === "failed" || decision.status === "superseded") {
        return { decisionResourceKey: decision.resourceKey, status: decision.status, reason: `decision is ${decision.status}` };
      }
      if (decision.payload.path !== "requeue-hand-execution") {
        return markDecisionBlocked(deps.db, decision, `unsupported recovery path in this task: ${decision.payload.path}`, input.now);
      }
      return await applyRequeueHandExecution(deps.db, decision, input.now);
    },
  };
}

async function applyRequeueHandExecution(
  db: SouthstarDb,
  decision: RuntimeRecoveryDecisionRecord,
  nowInput?: string,
): Promise<RecoveryDecisionApplyResult> {
  const now = nowInput ?? new Date().toISOString();
  const execution = await startRecoveryExecutionPg(db, {
    decisionId: decision.decisionId,
    exceptionId: decision.payload.exceptionId,
    runId: decision.payload.runId,
    taskId: decision.payload.taskId,
    path: decision.payload.path,
    now,
  });

  const stateChanges: RecoveryExecutionStateChange[] = [];
  const providerActions: RecoveryExecutionProviderAction[] = [];

  await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [decision.payload.runId]);
    const task = decision.payload.taskId
      ? await tx.maybeOne<{ status: string }>(
          "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
          [decision.payload.runId, decision.payload.taskId],
        )
      : null;
    if (task?.status === "completed") {
      await markDecisionStatusPg(tx, decision, "superseded", now, stateChanges, "task already completed");
      return;
    }

    if (decision.payload.handExecutionId) {
      const hand = await getResourceByKeyPg(tx, "hand_execution", decision.payload.handExecutionId);
      if (hand && hand.status !== "lost") {
        await patchRuntimeResourceStatusPg(tx, hand, "lost", {
          status: "lost",
          terminalAt: now,
          lostReason: "requeue-hand-execution",
          recoveryDecisionId: decision.decisionId,
        });
        stateChanges.push({
          resourceType: "hand_execution",
          resourceKey: hand.resourceKey,
          fromStatus: hand.status,
          toStatus: "lost",
          reason: "queue timeout requeue",
        });
        providerActions.push({
          providerId: providerIdFromResource(hand),
          action: "cancel",
          status: "skipped",
          evidenceRef: hand.resourceKey,
        });
      }
    }

    if (decision.payload.taskId && task && task.status !== "pending") {
      await tx.query(
        "update southstar.workflow_tasks set status = 'pending', updated_at = now(), completed_at = null where run_id = $1 and id = $2",
        [decision.payload.runId, decision.payload.taskId],
      );
      stateChanges.push({
        resourceType: "workflow_task",
        resourceKey: `${decision.payload.runId}:${decision.payload.taskId}`,
        fromStatus: task.status,
        toStatus: "pending",
        reason: "queue timeout requeue",
      });
    }

    await markDecisionStatusPg(tx, decision, "applied", now, stateChanges, "requeue applied");
    await appendHistoryEventOncePg(tx, {
      runId: decision.payload.runId,
      taskId: decision.payload.taskId,
      eventType: "recovery_decision.applied",
      idempotencyKey: `${decision.resourceKey}:applied`,
      payload: { decisionId: decision.decisionId, path: decision.payload.path },
    });
  });

  await completeRecoveryExecutionPg(db, {
    runId: decision.payload.runId,
    executionResourceKey: execution.resourceKey,
    status: "succeeded",
    completedAt: now,
    stateChanges,
    providerActions,
  });
  const exceptionResourceKey = await runtimeExceptionResourceKeyFromDecisionPg(db, decision);
  await resolveRuntimeExceptionPg(db, {
    runId: decision.payload.runId,
    resourceKey: exceptionResourceKey,
    resolvedAt: now,
    reason: `recovery decision applied: ${decision.payload.path}`,
  });

  return {
    decisionResourceKey: decision.resourceKey,
    status: "applied",
    executionResourceKey: execution.resourceKey,
    reason: "requeue-hand-execution applied",
  };
}

async function getDecisionForUpdate(db: SouthstarDb, resourceKey: string): Promise<RuntimeRecoveryDecisionRecord> {
  const resource = await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, resourceKey);
  const record = toRuntimeRecoveryDecisionRecord(resource);
  if (!record) throw new Error(`recovery decision not found: ${resourceKey}`);
  return record;
}

function toRuntimeRecoveryDecisionRecord(resource: RuntimeResourceRecord | null): RuntimeRecoveryDecisionRecord | null {
  if (!resource) return null;
  const payload = resource.payload as Partial<RecoveryDecisionPayload>;
  if (
    resource.resourceType !== RECOVERY_DECISION_RESOURCE_TYPE ||
    typeof payload.schemaVersion !== "string" ||
    typeof payload.decisionId !== "string" ||
    typeof payload.exceptionId !== "string" ||
    typeof payload.runId !== "string" ||
    typeof payload.path !== "string"
  ) {
    return null;
  }
  return {
    decisionId: payload.decisionId,
    resourceKey: resource.resourceKey,
    status: resource.status as RuntimeRecoveryDecisionRecord["status"],
    payload: payload as RecoveryDecisionPayload,
  };
}

async function markDecisionStatusPg(
  db: SouthstarDb,
  decision: RuntimeRecoveryDecisionRecord,
  status: RecoveryDecisionStatus,
  now: string,
  stateChanges: RecoveryExecutionStateChange[],
  reason: string,
): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: decision.decisionId,
    resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
    resourceKey: decision.resourceKey,
    runId: decision.payload.runId,
    taskId: decision.payload.taskId,
    scope: "recovery",
    status,
    title: `Runtime recovery decision: ${decision.payload.path}`,
    payload: { ...decision.payload, appliedAt: status === "applied" ? now : undefined, statusReason: reason },
    summary: {
      exceptionId: decision.payload.exceptionId,
      path: decision.payload.path,
      operatorApprovalRequired: decision.payload.operatorApprovalRequired,
      statusReason: reason,
    },
  });
  stateChanges.push({
    resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
    resourceKey: decision.resourceKey,
    fromStatus: decision.status,
    toStatus: status,
    reason,
  });
}

async function markDecisionBlocked(
  db: SouthstarDb,
  decision: RuntimeRecoveryDecisionRecord,
  reason: string,
  nowInput?: string,
): Promise<RecoveryDecisionApplyResult> {
  const now = nowInput ?? new Date().toISOString();
  const execution = await startRecoveryExecutionPg(db, {
    decisionId: decision.decisionId,
    exceptionId: decision.payload.exceptionId,
    runId: decision.payload.runId,
    taskId: decision.payload.taskId,
    path: decision.payload.path,
    now,
  });
  const stateChanges: RecoveryExecutionStateChange[] = [];
  await markDecisionStatusPg(db, decision, "blocked", now, stateChanges, reason);
  await completeRecoveryExecutionPg(db, {
    runId: decision.payload.runId,
    executionResourceKey: execution.resourceKey,
    status: "blocked",
    completedAt: now,
    stateChanges,
    providerActions: [],
  });
  return { decisionResourceKey: decision.resourceKey, status: "blocked", executionResourceKey: execution.resourceKey, reason };
}

async function patchRuntimeResourceStatusPg(
  db: SouthstarDb,
  resource: RuntimeResourceRecord,
  status: string,
  payloadPatch: Record<string, unknown>,
): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: resource.id,
    resourceType: resource.resourceType,
    resourceKey: resource.resourceKey,
    runId: resource.runId,
    taskId: resource.taskId,
    sessionId: resource.sessionId,
    scope: resource.scope,
    status,
    title: resource.title,
    payload: { ...(resource.payload as Record<string, unknown>), ...payloadPatch },
    summary: resource.summary,
    metrics: resource.metrics,
  });
}

function providerIdFromResource(resource: RuntimeResourceRecord): string {
  const payload = resource.payload as Record<string, unknown>;
  return typeof payload.providerId === "string" ? payload.providerId : "tork";
}

async function appendHistoryEventOncePg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId?: string;
    eventType: string;
    idempotencyKey: string;
    payload: unknown;
  },
): Promise<void> {
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.runId, input.idempotencyKey],
  );
  if (existing) return;
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: input.eventType,
    actorType: "orchestrator",
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  });
}

async function runtimeExceptionResourceKeyFromDecisionPg(
  db: SouthstarDb,
  decision: RuntimeRecoveryDecisionRecord,
): Promise<string> {
  const row = await db.one<{ resource_key: string }>(
    `select resource_key
       from southstar.runtime_resources
      where resource_type = $1
        and payload_json->>'exceptionId' = $2
      order by created_at
      limit 1`,
    [RUNTIME_EXCEPTION_RESOURCE_TYPE, decision.payload.exceptionId],
  );
  return row.resource_key;
}
```

- [ ] **Step 4: Run the applier test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for the requeue apply test.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/exceptions/recovery-decision-applier.ts tests/v2/recovery-decision-applier.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: apply requeue recovery decisions"
```

---

### Task 3: Reprovision-Hand Apply Path

**Files:**
- Modify: `src/v2/exceptions/recovery-decision-applier.ts`
- Test: `tests/v2/recovery-decision-applier.test.ts`

- [ ] **Step 1: Add a failing reprovision test**

Append to `tests/v2/recovery-decision-applier.test.ts`:

```ts
import { createFakeBrainProvider } from "../../src/v2/brain/fake-brain-provider.ts";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";

test("reprovision-hand marks old hand lost, creates replacement hand, and releases task", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTaskAndHandExecution(db, {
      runId: "run-apply-reprovision",
      taskId: "task-a",
      taskStatus: "running",
      handStatus: "running",
      attemptId: "attempt-1",
    });
    await upsertRuntimeResourcePg(db, {
      id: "hand-binding-run-apply-reprovision-task-a",
      resourceType: "hand_binding",
      resourceKey: "hand-binding-run-apply-reprovision-task-a",
      runId: "run-apply-reprovision",
      taskId: "task-a",
      sessionId: "session-a",
      scope: "hand",
      status: "running",
      title: "Old hand binding",
      payload: {
        id: "hand-binding-run-apply-reprovision-task-a",
        providerId: "fake-hand",
        runId: "run-apply-reprovision",
        taskId: "task-a",
        handName: "workspace",
        recoveryKey: "old-recovery-key",
      },
    });
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: "run-apply-reprovision",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-apply-reprovision:task-a:attempt-1",
      handBindingId: "hand-binding-run-apply-reprovision-task-a",
      source: "tork-observer",
      kind: "tork_running_hang",
      severity: "recoverable",
      observedAt: "2026-06-21T12:10:00.000Z",
      evidenceRefs: ["hand-execution:run-apply-reprovision:task-a:attempt-1"],
      providerEvidence: { externalJobId: "job-running", status: "running" },
    });
    const decision = await controller.decide(await controller.classify(exception));

    const applier = createRecoveryDecisionApplier({
      db,
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    });
    const result = await applier.applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: "2026-06-21T12:11:00.000Z",
    });

    assert.equal(result.status, "applied");
    const handExecutions = (await listResourcesPg(db, { resourceType: "hand_execution" }))
      .filter((resource) => resource.runId === "run-apply-reprovision");
    assert.equal(handExecutions[0]?.status, "lost");

    const handBindings = (await listResourcesPg(db, { resourceType: "hand_binding" }))
      .filter((resource) => resource.runId === "run-apply-reprovision");
    assert.equal(handBindings.some((resource) => resource.status === "lost"), true);
    assert.equal(handBindings.some((resource) => resource.status === "provisioned"), true);

    const tasks = await db.query<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      ["run-apply-reprovision", "task-a"],
    );
    assert.equal(tasks.rows[0]?.status, "pending");

    const checkpoints = (await listResourcesPg(db, { resourceType: "session_checkpoint" }))
      .filter((resource) => resource.runId === "run-apply-reprovision");
    assert.equal(checkpoints.length, 1);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because `createRecoveryDecisionApplier` does not accept recovery dependencies and blocks `reprovision-hand`.

- [ ] **Step 3: Extend applier dependencies**

In `src/v2/exceptions/recovery-decision-applier.ts`, add imports and dependency type:

```ts
import type { BrainProvider } from "../brain/types.ts";
import type { HandProvider } from "../hands/types.ts";
import { createPostgresRecoveryController } from "../session-recovery/postgres-controller.ts";
import type { SessionStore } from "../session/types.ts";

export type RecoveryDecisionApplierDeps = {
  db: SouthstarDb;
  sessionStore?: SessionStore;
  brainProvider?: BrainProvider;
  handProvider?: HandProvider;
};
```

Change the factory signature:

```ts
export function createRecoveryDecisionApplier(deps: RecoveryDecisionApplierDeps): {
```

- [ ] **Step 4: Implement reprovision path**

In `applyDecision()`, route the path:

```ts
if (decision.payload.path === "reprovision-hand") {
  return await applyReprovisionHand(deps, decision, input.now);
}
```

Add:

```ts
async function applyReprovisionHand(
  deps: RecoveryDecisionApplierDeps,
  decision: RuntimeRecoveryDecisionRecord,
  nowInput?: string,
): Promise<RecoveryDecisionApplyResult> {
  const now = nowInput ?? new Date().toISOString();
  if (!deps.sessionStore || !deps.brainProvider || !deps.handProvider) {
    return await markDecisionBlocked(deps.db, decision, "reprovision-hand requires sessionStore, brainProvider, and handProvider", now);
  }
  const execution = await startRecoveryExecutionPg(deps.db, {
    decisionId: decision.decisionId,
    exceptionId: decision.payload.exceptionId,
    runId: decision.payload.runId,
    taskId: decision.payload.taskId,
    path: decision.payload.path,
    now,
  });
  const stateChanges: RecoveryExecutionStateChange[] = [];
  const providerActions: RecoveryExecutionProviderAction[] = [];

  await deps.db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [decision.payload.runId]);
    if (decision.payload.handExecutionId) {
      const handExecution = await getResourceByKeyPg(tx, "hand_execution", decision.payload.handExecutionId);
      if (handExecution && handExecution.status !== "lost") {
        await patchRuntimeResourceStatusPg(tx, handExecution, "lost", {
          status: "lost",
          terminalAt: now,
          lostReason: "reprovision-hand",
          recoveryDecisionId: decision.decisionId,
        });
        stateChanges.push({
          resourceType: "hand_execution",
          resourceKey: handExecution.resourceKey,
          fromStatus: handExecution.status,
          toStatus: "lost",
          reason: "running hang reprovision",
        });
        providerActions.push({
          providerId: providerIdFromResource(handExecution),
          action: "destroy",
          status: "skipped",
          evidenceRef: handExecution.resourceKey,
        });
      }
    }

    if (decision.payload.handExecutionId) {
      const handExecution = await getResourceByKeyPg(tx, "hand_execution", decision.payload.handExecutionId);
      const oldHandBindingId = stringValue((handExecution?.payload as Record<string, unknown> | undefined)?.handBindingId);
      if (oldHandBindingId) {
        const oldBinding = await getResourceByKeyPg(tx, "hand_binding", oldHandBindingId);
        if (oldBinding && oldBinding.status !== "lost") {
          await patchRuntimeResourceStatusPg(tx, oldBinding, "lost", {
            lostAt: now,
            lostReason: "reprovision-hand",
            recoveryDecisionId: decision.decisionId,
          });
          stateChanges.push({
            resourceType: "hand_binding",
            resourceKey: oldBinding.resourceKey,
            fromStatus: oldBinding.status,
            toStatus: "lost",
            reason: "running hang reprovision",
          });
        }
      }
    }
  });

  const recovery = createPostgresRecoveryController({
    db: deps.db,
    sessionStore: deps.sessionStore,
    brainProvider: deps.brainProvider,
    handProvider: deps.handProvider,
  });
  const recovered = await recovery.recover({
    runId: decision.payload.runId,
    taskId: requireTaskId(decision),
    sessionId: decision.payload.taskId ? `session-a` : decision.payload.runId,
    strategy: "reprovision-hand",
    reason: `Recovery decision ${decision.decisionId}: ${decision.payload.reason}`,
  });
  providerActions.push({
    providerId: deps.handProvider.providerId,
    action: "provision",
    status: "succeeded",
    evidenceRef: recovered.handBindingId,
  });

  await deps.db.tx(async (tx) => {
    const task = await tx.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [decision.payload.runId, requireTaskId(decision)],
    );
    if (task.status !== "pending") {
      await tx.query(
        "update southstar.workflow_tasks set status = 'pending', updated_at = now(), completed_at = null where run_id = $1 and id = $2",
        [decision.payload.runId, requireTaskId(decision)],
      );
      stateChanges.push({
        resourceType: "workflow_task",
        resourceKey: `${decision.payload.runId}:${requireTaskId(decision)}`,
        fromStatus: task.status,
        toStatus: "pending",
        reason: "running hang reprovision",
      });
    }
    await markDecisionStatusPg(tx, decision, "applied", now, stateChanges, "reprovision applied");
  });

  await completeRecoveryExecutionPg(deps.db, {
    runId: decision.payload.runId,
    executionResourceKey: execution.resourceKey,
    status: "succeeded",
    completedAt: now,
    stateChanges,
    providerActions,
  });
  await resolveRuntimeExceptionPg(deps.db, {
    runId: decision.payload.runId,
    resourceKey: await runtimeExceptionResourceKeyFromDecisionPg(deps.db, decision),
    resolvedAt: now,
    reason: `recovery decision applied: ${decision.payload.path}`,
  });
  return {
    decisionResourceKey: decision.resourceKey,
    status: "applied",
    executionResourceKey: execution.resourceKey,
    reason: "reprovision-hand applied",
  };
}

function requireTaskId(decision: RuntimeRecoveryDecisionRecord): string {
  if (!decision.payload.taskId) throw new Error(`recovery decision ${decision.decisionId} requires taskId`);
  return decision.payload.taskId;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

Replace the hard-coded `sessionId: decision.payload.taskId ? "session-a" : decision.payload.runId` with:

```ts
sessionId: await sessionIdForDecisionPg(deps.db, decision),
```

Add:

```ts
async function sessionIdForDecisionPg(db: SouthstarDb, decision: RuntimeRecoveryDecisionRecord): Promise<string> {
  if (decision.payload.taskId) {
    const row = await db.maybeOne<{ root_session_id: string | null }>(
      "select root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      [decision.payload.runId, decision.payload.taskId],
    );
    if (row?.root_session_id) return row.root_session_id;
  }
  return decision.payload.runId;
}
```

- [ ] **Step 5: Run the test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for requeue and reprovision tests.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/exceptions/recovery-decision-applier.ts tests/v2/recovery-decision-applier.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: apply reprovision recovery decisions"
```

---

### Task 4: Decision Status Initialization And Precondition Handling

**Files:**
- Modify: `src/v2/exceptions/runtime-exception-controller.ts`
- Modify: `src/v2/exceptions/recovery-decision-applier.ts`
- Test: `tests/v2/recovery-decision-applier.test.ts`
- Test: `tests/v2/runtime-exceptions.test.ts`

- [ ] **Step 1: Add failing tests for operator-required status and stale success supersede**

Append to `tests/v2/recovery-decision-applier.test.ts`:

```ts
test("operator-required decisions wait for approval and are not auto-applied", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTaskAndHandExecution(db, {
      runId: "run-operator-wait",
      taskId: "task-a",
      taskStatus: "running",
      handStatus: "running",
      attemptId: "attempt-1",
    });
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: "run-operator-wait",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-operator-wait:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_running_hang",
      severity: "recoverable",
      observedAt: "2026-06-21T12:20:00.000Z",
      evidenceRefs: ["hand-execution:run-operator-wait:task-a:attempt-1"],
      providerEvidence: { workspaceUnsafe: true },
    });
    const decision = await controller.decide(await controller.classify(exception));
    assert.equal(decision.status, "waiting_operator_approval");

    const applier = createRecoveryDecisionApplier({ db });
    const result = await applier.applyDecision({ decisionResourceKey: decision.resourceKey });
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "waiting for operator approval");
  } finally {
    await db.close();
  }
});

test("stale decision supersedes when task already completed with accepted artifact", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTaskAndHandExecution(db, {
      runId: "run-stale-decision-success",
      taskId: "task-a",
      taskStatus: "completed",
      handStatus: "queued",
      attemptId: "attempt-1",
    });
    await upsertRuntimeResourcePg(db, {
      id: "artifact-ref-run-stale-decision-success-task-a",
      resourceType: "artifact_ref",
      resourceKey: "artifact-ref:run-stale-decision-success:task-a",
      runId: "run-stale-decision-success",
      taskId: "task-a",
      scope: "artifact",
      status: "accepted",
      title: "Accepted artifact",
      payload: {
        schemaVersion: "southstar.artifact_ref.v1",
        ref: "artifact-ref:run-stale-decision-success:task-a",
        kind: "implementation_report",
      },
    });
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: "run-stale-decision-success",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-stale-decision-success:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T12:30:00.000Z",
      evidenceRefs: ["hand-execution:run-stale-decision-success:task-a:attempt-1"],
    });
    const decision = await controller.decide(await controller.classify(exception));

    const result = await createRecoveryDecisionApplier({ db }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: "2026-06-21T12:31:00.000Z",
    });
    assert.equal(result.status, "superseded");
    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-stale-decision-success");
    assert.equal(decisions[0]?.status, "superseded");
    const tasks = await db.query<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      ["run-stale-decision-success", "task-a"],
    );
    assert.equal(tasks.rows[0]?.status, "completed");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because operator-required decisions are still `recorded`, and completed tasks are not superseded.

- [ ] **Step 3: Set operator-required decision status during decide**

In `src/v2/exceptions/runtime-exception-controller.ts`, change the `upsertRuntimeResourcePg` call for `recovery_decision` status:

```ts
const decisionStatus = classification.operatorApprovalRequired ? "waiting_operator_approval" : "recorded";
```

Use it in the resource:

```ts
status: decisionStatus,
```

Update the returned record type cast so `waiting_operator_approval` is accepted through `RecoveryDecisionStatus`.

- [ ] **Step 4: Supersede completed successful tasks**

In `src/v2/exceptions/recovery-decision-applier.ts`, replace the `task.status === "completed"` block with an accepted artifact check:

```ts
if (task?.status === "completed" && decision.payload.taskId && await hasAcceptedArtifactRefPg(tx, decision.payload.runId, decision.payload.taskId)) {
  await markDecisionStatusPg(tx, decision, "superseded", now, stateChanges, "task already completed with accepted artifact");
  return;
}
```

Add:

```ts
async function hasAcceptedArtifactRefPg(db: SouthstarDb, runId: string, taskId: string): Promise<boolean> {
  const row = await db.maybeOne<{ id: string }>(
    `select id
       from southstar.runtime_resources
      where run_id = $1
        and task_id = $2
        and resource_type = 'artifact_ref'
        and status = 'accepted'
      limit 1`,
    [runId, taskId],
  );
  return Boolean(row);
}
```

When the transaction returns after supersede, complete the recovery execution with status `superseded` instead of `succeeded`. Use a local variable:

```ts
let terminalStatus: "succeeded" | "superseded" = "succeeded";
```

Set it before returning from the transaction:

```ts
terminalStatus = "superseded";
```

Use:

```ts
status: terminalStatus,
```

Return:

```ts
status: terminalStatus === "superseded" ? "superseded" : "applied",
```

- [ ] **Step 5: Run tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for applier status/precondition tests and existing runtime exception tests.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/exceptions/runtime-exception-controller.ts src/v2/exceptions/recovery-decision-applier.ts tests/v2/recovery-decision-applier.test.ts tests/v2/runtime-exceptions.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: enforce recovery decision preconditions"
```

---

### Task 5: Remaining Recovery Path Semantics

**Files:**
- Modify: `src/v2/exceptions/recovery-decision-applier.ts`
- Test: `tests/v2/recovery-decision-applier.test.ts`

- [ ] **Step 1: Add failing tests for the remaining paths**

Append to `tests/v2/recovery-decision-applier.test.ts`:

```ts
const remainingPathCases = [
  {
    name: "retry-same-task-new-attempt supersedes current hand execution and releases task",
    kind: "tork_terminal_without_callback" as const,
    expectedPath: "retry-same-task-new-attempt",
    expectedTaskStatus: "pending",
    expectedHandStatus: "superseded",
    expectedDecisionStatus: "applied",
  },
  {
    name: "repair-artifact keeps rejected evidence and releases task",
    kind: "artifact_rejected" as const,
    expectedPath: "repair-artifact",
    expectedTaskStatus: "pending",
    expectedHandStatus: "running",
    expectedDecisionStatus: "applied",
  },
  {
    name: "block-for-operator blocks the task and keeps exception unresolved",
    kind: "provider_unreachable" as const,
    expectedPath: "block-for-operator",
    expectedTaskStatus: "blocked",
    expectedHandStatus: "running",
    expectedDecisionStatus: "blocked",
  },
  {
    name: "fail-task marks task failed and keeps run finalization evaluator-owned",
    kind: "completion_gate_failed" as const,
    forcedPath: "fail-task" as const,
    expectedTaskStatus: "failed",
    expectedHandStatus: "running",
    expectedDecisionStatus: "applied",
  },
  {
    name: "fail-run marks run failed with recovery evidence",
    kind: "completion_gate_failed" as const,
    forcedPath: "fail-run" as const,
    expectedRunStatus: "failed",
    expectedTaskStatus: "running",
    expectedHandStatus: "running",
    expectedDecisionStatus: "applied",
  },
];

for (const item of remainingPathCases) {
  test(item.name, async () => {
    const db = await createTestPostgresDb();
    try {
      const runId = `run-${item.expectedPath.replace(/[^a-z-]/g, "-")}`;
      const taskId = "task-a";
      await seedRunTaskAndHandExecution(db, {
        runId,
        taskId,
        taskStatus: "running",
        handStatus: "running",
        attemptId: "attempt-1",
      });
      const controller = createRuntimeExceptionController({ db });
      const exception = await controller.observe({
        runId,
        taskId,
        sessionId: "session-a",
        attemptId: "attempt-1",
        handExecutionId: `hand-execution:${runId}:${taskId}:attempt-1`,
        source: "operator",
        kind: item.kind,
        severity: item.expectedPath === "block-for-operator" ? "blocking" : "recoverable",
        observedAt: "2026-06-21T12:40:00.000Z",
        evidenceRefs: [`hand-execution:${runId}:${taskId}:attempt-1`],
      });
      const decision = await controller.decide(await controller.classify(exception));
      if (item.forcedPath) {
        await upsertRuntimeResourcePg(db, {
          id: decision.decisionId,
          resourceType: "recovery_decision",
          resourceKey: decision.resourceKey,
          runId,
          taskId,
          scope: "recovery",
          status: "recorded",
          title: `Forced recovery decision ${item.forcedPath}`,
          payload: { ...decision.payload, path: item.forcedPath },
        });
      }

      const result = await createRecoveryDecisionApplier({ db }).applyDecision({
        decisionResourceKey: decision.resourceKey,
        now: "2026-06-21T12:41:00.000Z",
      });

      assert.equal(result.status, item.expectedDecisionStatus === "blocked" ? "blocked" : "applied");
      const task = await db.one<{ status: string }>(
        "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
        [runId, taskId],
      );
      assert.equal(task.status, item.expectedTaskStatus);
      const run = await db.one<{ status: string }>(
        "select status from southstar.workflow_runs where id = $1",
        [runId],
      );
      assert.equal(run.status, item.expectedRunStatus ?? "running");
      const handExecution = (await listResourcesPg(db, { resourceType: "hand_execution" }))
        .find((resource) => resource.runId === runId);
      assert.equal(handExecution?.status, item.expectedHandStatus);
      const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
        .filter((resource) => resource.runId === runId);
      assert.equal(decisions[0]?.status, item.expectedDecisionStatus);
      const executions = (await listResourcesPg(db, { resourceType: "recovery_execution" }))
        .filter((resource) => resource.runId === runId);
      assert.equal(executions.length, 1);
    } finally {
      await db.close();
    }
  });
}

test("wake-new-brain uses managed recovery primitive and records wake provider action", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTaskAndHandExecution(db, {
      runId: "run-wake-new-brain-path",
      taskId: "task-a",
      taskStatus: "pending",
      handStatus: "queued",
      attemptId: "attempt-1",
    });
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: "run-wake-new-brain-path",
      taskId: "task-a",
      sessionId: "session-a",
      brainBindingId: "brain-binding-old",
      source: "scheduler",
      kind: "brain_wake_failed",
      severity: "recoverable",
      observedAt: "2026-06-21T12:45:00.000Z",
      evidenceRefs: ["brain-binding-old"],
    });
    const decision = await controller.decide(await controller.classify(exception));
    const result = await createRecoveryDecisionApplier({
      db,
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: "2026-06-21T12:46:00.000Z",
    });

    assert.equal(result.status, "applied");
    const brains = (await listResourcesPg(db, { resourceType: "brain_binding" }))
      .filter((resource) => resource.runId === "run-wake-new-brain-path");
    assert.equal(brains.some((resource) => resource.status === "running"), true);
    const executions = (await listResourcesPg(db, { resourceType: "recovery_execution" }))
      .filter((resource) => resource.runId === "run-wake-new-brain-path");
    assert.equal(executions[0]?.payload.providerActions.some((action: { action: string }) => action.action === "wake"), true);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because the applier still blocks unsupported paths.

- [ ] **Step 3: Implement remaining path dispatch**

In `src/v2/exceptions/recovery-decision-applier.ts`, extend `applyDecision()`:

```ts
if (decision.payload.path === "retry-same-task-new-attempt") {
  return await applyRetrySameTaskNewAttempt(deps.db, decision, input.now);
}
if (decision.payload.path === "wake-new-brain") {
  return await applyWakeNewBrain(deps, decision, input.now);
}
if (decision.payload.path === "repair-artifact") {
  return await applyRepairArtifact(deps.db, decision, input.now);
}
if (decision.payload.path === "block-for-operator") {
  return await applyBlockForOperator(deps.db, decision, input.now);
}
if (decision.payload.path === "fail-task") {
  return await applyFailTask(deps.db, decision, input.now);
}
if (decision.payload.path === "fail-run") {
  return await applyFailRun(deps.db, decision, input.now);
}
```

Implement these helpers with the same `startRecoveryExecutionPg()` and `completeRecoveryExecutionPg()` pattern as `applyRequeueHandExecution()`:

```ts
async function applyRetrySameTaskNewAttempt(db: SouthstarDb, decision: RuntimeRecoveryDecisionRecord, nowInput?: string): Promise<RecoveryDecisionApplyResult> {
  return await applySimpleStateTransition(db, decision, nowInput, {
    terminalExecutionStatus: "succeeded",
    decisionStatus: "applied",
    taskStatus: "pending",
    handExecutionStatus: "superseded",
    resolveException: true,
    reason: "retry same task with a new attempt",
  });
}

async function applyRepairArtifact(db: SouthstarDb, decision: RuntimeRecoveryDecisionRecord, nowInput?: string): Promise<RecoveryDecisionApplyResult> {
  return await applySimpleStateTransition(db, decision, nowInput, {
    terminalExecutionStatus: "succeeded",
    decisionStatus: "applied",
    taskStatus: "pending",
    resolveException: true,
    reason: "repair rejected artifact",
  });
}

async function applyBlockForOperator(db: SouthstarDb, decision: RuntimeRecoveryDecisionRecord, nowInput?: string): Promise<RecoveryDecisionApplyResult> {
  return await applySimpleStateTransition(db, decision, nowInput, {
    terminalExecutionStatus: "blocked",
    decisionStatus: "blocked",
    taskStatus: "blocked",
    resolveException: false,
    reason: "blocked for operator",
  });
}

async function applyFailTask(db: SouthstarDb, decision: RuntimeRecoveryDecisionRecord, nowInput?: string): Promise<RecoveryDecisionApplyResult> {
  return await applySimpleStateTransition(db, decision, nowInput, {
    terminalExecutionStatus: "succeeded",
    decisionStatus: "applied",
    taskStatus: "failed",
    resolveException: true,
    reason: "explicit fail-task recovery path",
  });
}

async function applyFailRun(db: SouthstarDb, decision: RuntimeRecoveryDecisionRecord, nowInput?: string): Promise<RecoveryDecisionApplyResult> {
  return await applySimpleStateTransition(db, decision, nowInput, {
    terminalExecutionStatus: "succeeded",
    decisionStatus: "applied",
    runStatus: "failed",
    resolveException: true,
    reason: "explicit fail-run recovery path",
  });
}
```

Add the shared helper:

```ts
async function applySimpleStateTransition(
  db: SouthstarDb,
  decision: RuntimeRecoveryDecisionRecord,
  nowInput: string | undefined,
  input: {
    terminalExecutionStatus: "succeeded" | "blocked" | "failed" | "superseded";
    decisionStatus: RecoveryDecisionStatus;
    taskStatus?: string;
    handExecutionStatus?: string;
    runStatus?: string;
    resolveException: boolean;
    reason: string;
  },
): Promise<RecoveryDecisionApplyResult> {
  const now = nowInput ?? new Date().toISOString();
  const execution = await startRecoveryExecutionPg(db, {
    decisionId: decision.decisionId,
    exceptionId: decision.payload.exceptionId,
    runId: decision.payload.runId,
    taskId: decision.payload.taskId,
    path: decision.payload.path,
    now,
  });
  const stateChanges: RecoveryExecutionStateChange[] = [];
  await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [decision.payload.runId]);
    if (input.runStatus) {
      const run = await tx.one<{ status: string }>("select status from southstar.workflow_runs where id = $1 for update", [decision.payload.runId]);
      await tx.query("update southstar.workflow_runs set status = $1, updated_at = now(), completed_at = coalesce(completed_at, now()) where id = $2", [input.runStatus, decision.payload.runId]);
      stateChanges.push({ resourceType: "workflow_run", resourceKey: decision.payload.runId, fromStatus: run.status, toStatus: input.runStatus, reason: input.reason });
    }
    if (input.taskStatus && decision.payload.taskId) {
      const task = await tx.one<{ status: string }>("select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update", [decision.payload.runId, decision.payload.taskId]);
      await tx.query("update southstar.workflow_tasks set status = $1, updated_at = now(), completed_at = case when $1 in ('failed', 'blocked') then coalesce(completed_at, now()) else null end where run_id = $2 and id = $3", [input.taskStatus, decision.payload.runId, decision.payload.taskId]);
      stateChanges.push({ resourceType: "workflow_task", resourceKey: `${decision.payload.runId}:${decision.payload.taskId}`, fromStatus: task.status, toStatus: input.taskStatus, reason: input.reason });
    }
    if (input.handExecutionStatus && decision.payload.handExecutionId) {
      const hand = await getResourceByKeyPg(tx, "hand_execution", decision.payload.handExecutionId);
      if (hand) {
        await patchRuntimeResourceStatusPg(tx, hand, input.handExecutionStatus, { status: input.handExecutionStatus, terminalAt: now, recoveryDecisionId: decision.decisionId });
        stateChanges.push({ resourceType: "hand_execution", resourceKey: hand.resourceKey, fromStatus: hand.status, toStatus: input.handExecutionStatus, reason: input.reason });
      }
    }
    await markDecisionStatusPg(tx, decision, input.decisionStatus, now, stateChanges, input.reason);
  });
  await completeRecoveryExecutionPg(db, {
    runId: decision.payload.runId,
    executionResourceKey: execution.resourceKey,
    status: input.terminalExecutionStatus,
    completedAt: now,
    stateChanges,
    providerActions: [],
  });
  if (input.resolveException) {
    await resolveRuntimeExceptionPg(db, {
      runId: decision.payload.runId,
      resourceKey: await runtimeExceptionResourceKeyFromDecisionPg(db, decision),
      resolvedAt: now,
      reason: `recovery decision applied: ${decision.payload.path}`,
    });
  }
  return {
    decisionResourceKey: decision.resourceKey,
    status: input.decisionStatus === "blocked" ? "blocked" : "applied",
    executionResourceKey: execution.resourceKey,
    reason: input.reason,
  };
}
```

Implement `applyWakeNewBrain()` by calling `PostgresRecoveryController.recover()` with `strategy: "wake-new-brain"` and writing a `wake` provider action into the `recovery_execution`.

- [ ] **Step 4: Run tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for all applier path tests.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/exceptions/recovery-decision-applier.ts tests/v2/recovery-decision-applier.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: apply remaining recovery decision paths"
```

---

### Task 6: Operator Approval Service And Routes

**Files:**
- Create: `src/v2/exceptions/recovery-approval-service.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/operator-recovery-approval-routes.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `tests/v2/operator-recovery-approval-routes.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("operator approval route moves waiting recovery decision to approved", async () => {
  const db = await createTestPostgresDb();
  try {
    const decision = await seedWaitingDecision(db, "run-approval-route", "task-a");
    const response = await handleRuntimeRoute({ db } as never, new Request(
      `http://southstar.test/api/v2/runs/run-approval-route/recovery-decisions/${encodeURIComponent(decision.decisionId)}/approval`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "approved", reason: "operator allows rollback" }),
        headers: { "content-type": "application/json" },
      },
    ));
    assert.equal(response.status, 200);
    const body = await response.json() as { result: { status: string; decisionId: string } };
    assert.equal(body.result.status, "approved");
    assert.equal(body.result.decisionId, decision.decisionId);

    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-approval-route");
    assert.equal(decisions[0]?.status, "approved");
    const approvals = (await listResourcesPg(db, { resourceType: "operator_approval" }))
      .filter((resource) => resource.runId === "run-approval-route");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.status, "approved");
  } finally {
    await db.close();
  }
});

test("operator rejection route blocks waiting recovery decision", async () => {
  const db = await createTestPostgresDb();
  try {
    const decision = await seedWaitingDecision(db, "run-rejection-route", "task-a");
    const response = await handleRuntimeRoute({ db } as never, new Request(
      `http://southstar.test/api/v2/runs/run-rejection-route/recovery-decisions/${encodeURIComponent(decision.decisionId)}/approval`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "rejected", reason: "operator rejects unsafe rollback" }),
        headers: { "content-type": "application/json" },
      },
    ));
    assert.equal(response.status, 200);
    const body = await response.json() as { result: { status: string } };
    assert.equal(body.result.status, "blocked");
    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-rejection-route");
    assert.equal(decisions[0]?.status, "blocked");
    assert.equal(decisions[0]?.payload.operatorDecision, "rejected");
  } finally {
    await db.close();
  }
});

async function seedWaitingDecision(db: Awaited<ReturnType<typeof createTestPostgresDb>>, runId: string, taskId: string) {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "approve recovery",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: "blocked",
    sortOrder: 0,
    dependsOn: [],
  });
  await upsertRuntimeResourcePg(db, {
    id: `hand-execution:${runId}:${taskId}:attempt-1`,
    resourceType: "hand_execution",
    resourceKey: `hand-execution:${runId}:${taskId}:attempt-1`,
    runId,
    taskId,
    sessionId: "session-a",
    scope: "hand",
    status: "running",
    title: "Hand execution",
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId: `hand-execution:${runId}:${taskId}:attempt-1`,
      providerId: "tork",
      runId,
      taskId,
      sessionId: "session-a",
      attemptId: "attempt-1",
      brainBindingId: `brain-binding-${runId}-${taskId}`,
      handBindingId: `hand-binding-${runId}-${taskId}`,
      status: "running",
      queuedAt: "2026-06-21T12:00:00.000Z",
      startedAt: "2026-06-21T12:01:00.000Z",
      queueTimeoutSeconds: 60,
      heartbeatTimeoutSeconds: 30,
    },
  });
  const controller = createRuntimeExceptionController({ db });
  const exception = await controller.observe({
    runId,
    taskId,
    sessionId: "session-a",
    attemptId: "attempt-1",
    handExecutionId: `hand-execution:${runId}:${taskId}:attempt-1`,
    source: "tork-observer",
    kind: "tork_running_hang",
    severity: "recoverable",
    observedAt: "2026-06-21T12:30:00.000Z",
    evidenceRefs: [`hand-execution:${runId}:${taskId}:attempt-1`],
    providerEvidence: { workspaceUnsafe: true },
  });
  return await controller.decide(await controller.classify(exception));
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./operator-recovery-approval-routes.test.ts");
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL with route not found.

- [ ] **Step 3: Implement approval service**

Create `src/v2/exceptions/recovery-approval-service.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import {
  appendHistoryEventPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";
import type { RecoveryDecisionPayload, RecoveryDecisionStatus } from "./types.ts";
import { RECOVERY_DECISION_RESOURCE_TYPE } from "./types.ts";

export type RecoveryDecisionApprovalInput = {
  runId: string;
  decisionId: string;
  decision: "approved" | "rejected";
  reason: string;
  now?: string;
};

export type RecoveryDecisionApprovalResult = {
  decisionId: string;
  status: RecoveryDecisionStatus;
  approvalResourceKey: string;
};

export async function decideRecoveryDecisionApprovalPg(
  db: SouthstarDb,
  input: RecoveryDecisionApprovalInput,
): Promise<RecoveryDecisionApprovalResult> {
  const now = input.now ?? new Date().toISOString();
  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const decisionResource = await tx.one<{
      id: string;
      resource_key: string;
      status: string;
      task_id: string | null;
      session_id: string | null;
      payload_json: RecoveryDecisionPayload;
      summary_json: unknown;
      metrics_json: unknown;
    }>(
      `select id, resource_key, status, task_id, session_id, payload_json, summary_json, metrics_json
         from southstar.runtime_resources
        where run_id = $1
          and resource_type = $2
          and payload_json->>'decisionId' = $3
        for update`,
      [input.runId, RECOVERY_DECISION_RESOURCE_TYPE, input.decisionId],
    );
    if (!["waiting_operator_approval", "blocked"].includes(decisionResource.status)) {
      throw new Error(`recovery decision ${input.decisionId} is not waiting for operator approval`);
    }

    const nextStatus: RecoveryDecisionStatus = input.decision === "approved" ? "approved" : "blocked";
    const approvalResourceKey = `operator_approval:${input.runId}:${input.decisionId}`;
    await upsertRuntimeResourcePg(tx, {
      id: approvalResourceKey,
      resourceType: "operator_approval",
      resourceKey: approvalResourceKey,
      runId: input.runId,
      taskId: decisionResource.task_id ?? undefined,
      sessionId: decisionResource.session_id ?? undefined,
      scope: "operator",
      status: input.decision,
      title: `Operator ${input.decision} recovery decision`,
      payload: {
        schemaVersion: "southstar.operator_approval.v1",
        decisionId: input.decisionId,
        decision: input.decision,
        reason: input.reason,
        decidedAt: now,
      },
      summary: { decision: input.decision, reason: input.reason },
    });

    await upsertRuntimeResourcePg(tx, {
      id: decisionResource.id,
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey: decisionResource.resource_key,
      runId: input.runId,
      taskId: decisionResource.task_id ?? undefined,
      sessionId: decisionResource.session_id ?? undefined,
      scope: "recovery",
      status: nextStatus,
      title: `Runtime recovery decision: ${decisionResource.payload_json.path}`,
      payload: {
        ...decisionResource.payload_json,
        operatorDecision: input.decision,
        operatorDecisionReason: input.reason,
        operatorDecisionAt: now,
      },
      summary: {
        ...(decisionResource.summary_json as Record<string, unknown>),
        operatorDecision: input.decision,
      },
      metrics: decisionResource.metrics_json,
    });

    await appendHistoryEventPg(tx, {
      runId: input.runId,
      taskId: decisionResource.task_id ?? undefined,
      sessionId: decisionResource.session_id ?? undefined,
      eventType: `recovery_decision.${nextStatus}`,
      actorType: "operator",
      idempotencyKey: `${decisionResource.resource_key}:operator:${input.decision}`,
      payload: {
        decisionId: input.decisionId,
        operatorDecision: input.decision,
        reason: input.reason,
        status: nextStatus,
      },
    });

    return { decisionId: input.decisionId, status: nextStatus, approvalResourceKey };
  });
}
```

- [ ] **Step 4: Add approval route**

In `src/v2/server/routes.ts`, import:

```ts
import { decideRecoveryDecisionApprovalPg } from "../exceptions/recovery-approval-service.ts";
```

Add before the read model routes:

```ts
const recoveryDecisionApprovalMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/recovery-decisions\/([^/]+)\/approval$/);
if (request.method === "POST" && recoveryDecisionApprovalMatch) {
  const body = await readJsonBody<{ decision?: unknown; reason?: unknown }>(request);
  const decision = body.decision;
  if (decision !== "approved" && decision !== "rejected") throw new Error("decision must be approved or rejected");
  return json("recovery-decision-approval", await decideRecoveryDecisionApprovalPg(context.db, {
    runId: decodeURIComponent(recoveryDecisionApprovalMatch[1]!),
    decisionId: decodeURIComponent(recoveryDecisionApprovalMatch[2]!),
    decision,
    reason: requiredString(body.reason, "reason"),
  }));
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for approval route tests.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/exceptions/recovery-approval-service.ts src/v2/server/routes.ts tests/v2/operator-recovery-approval-routes.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add recovery decision approval routes"
```

---

### Task 7: Completion Gate Blocks Unapplied Decisions

**Files:**
- Modify: `src/v2/evaluators/completion-gate.ts`
- Test: `tests/v2/completion-gate-exceptions.test.ts`

- [ ] **Step 1: Add failing gate tests**

Append to `tests/v2/completion-gate-exceptions.test.ts`:

```ts
test("completion gate fails while recovery decision is unapplied", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedCompletedRunWithAcceptedArtifact(db, "run-gate-unapplied-decision", "task-a");
    await upsertRuntimeResourcePg(db, {
      id: "decision-unapplied",
      resourceType: "recovery_decision",
      resourceKey: "runtime_exception_recovery_decision:exception-unapplied:requeue-hand-execution",
      runId: "run-gate-unapplied-decision",
      taskId: "task-a",
      scope: "recovery",
      status: "recorded",
      title: "Runtime recovery decision",
      payload: {
        schemaVersion: "southstar.runtime.recovery_decision.v1",
        decisionId: "decision-unapplied",
        exceptionId: "exception-unapplied",
        runId: "run-gate-unapplied-decision",
        taskId: "task-a",
        path: "requeue-hand-execution",
        reason: "unapplied recovery decision",
        operatorApprovalRequired: false,
        evidenceRefs: [],
        createdAt: "2026-06-21T13:00:00.000Z",
      },
    });

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-unapplied-decision" });

    assert.equal(result.status, "failed");
    assert.equal(result.findings.some((finding) => finding.includes("unapplied recovery decision")), true);
  } finally {
    await db.close();
  }
});

test("completion gate fails while recovery execution is started", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedCompletedRunWithAcceptedArtifact(db, "run-gate-started-execution", "task-a");
    await upsertRuntimeResourcePg(db, {
      id: "execution-started",
      resourceType: "recovery_execution",
      resourceKey: "recovery_execution:decision-started:attempt-1",
      runId: "run-gate-started-execution",
      taskId: "task-a",
      scope: "recovery",
      status: "started",
      title: "Recovery execution",
      payload: {
        schemaVersion: "southstar.runtime.recovery_execution.v1",
        executionId: "execution-started",
        decisionId: "decision-started",
        exceptionId: "exception-started",
        runId: "run-gate-started-execution",
        taskId: "task-a",
        path: "requeue-hand-execution",
        status: "started",
        stateChanges: [],
        providerActions: [],
        createdAt: "2026-06-21T13:05:00.000Z",
      },
    });

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-started-execution" });

    assert.equal(result.status, "failed");
    assert.equal(result.findings.some((finding) => finding.includes("started recovery execution")), true);
  } finally {
    await db.close();
  }
});
```

Add this helper to the bottom of `tests/v2/completion-gate-exceptions.test.ts` if the file does not already define it:

```ts
async function seedCompletedRunWithAcceptedArtifact(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  runId: string,
  taskId: string,
): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "completion gate recovery decision",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: "completed",
    sortOrder: 0,
    dependsOn: [],
  });
  await upsertRuntimeResourcePg(db, {
    id: `artifact-ref-${runId}-${taskId}`,
    resourceType: "artifact_ref",
    resourceKey: `artifact-ref:${runId}:${taskId}`,
    runId,
    taskId,
    scope: "artifact",
    status: "accepted",
    title: "Accepted artifact",
    payload: {
      schemaVersion: "southstar.artifact_ref.v1",
      ref: `artifact-ref:${runId}:${taskId}`,
      kind: "implementation_report",
    },
  });
}
```

Ensure the test file imports these helpers:

```ts
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because the gate does not inspect recovery decisions or started executions.

- [ ] **Step 3: Block open recovery decisions**

In `src/v2/evaluators/completion-gate.ts`, after unresolved runtime exception checks, add:

```ts
const openRecoveryDecisions = (await tx.query<{ resource_key: string; status: string; payload_json: { path?: string } }>(
  `select resource_key, status, payload_json
     from southstar.runtime_resources
    where run_id = $1
      and resource_type = 'recovery_decision'
      and status in ('recorded', 'waiting_operator_approval', 'approved', 'applying', 'failed', 'blocked')
    order by created_at, resource_key`,
  [input.runId],
)).rows;
for (const decision of openRecoveryDecisions) {
  findings.push(`unapplied recovery decision ${decision.resource_key}: ${decision.payload_json.path ?? decision.status}`);
}

const startedRecoveryExecutions = (await tx.query<{ resource_key: string }>(
  `select resource_key
     from southstar.runtime_resources
    where run_id = $1
      and resource_type = 'recovery_execution'
      and status = 'started'
    order by created_at, resource_key`,
  [input.runId],
)).rows;
for (const execution of startedRecoveryExecutions) {
  findings.push(`started recovery execution ${execution.resource_key}`);
}
```

Include both arrays in the `evaluationFingerprint` object:

```ts
openRecoveryDecisions,
startedRecoveryExecutions,
```

- [ ] **Step 4: Run tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for completion gate exception tests.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/evaluators/completion-gate.ts tests/v2/completion-gate-exceptions.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: block completion on unapplied recovery"
```

---

### Task 8: Read Models Show Recovery Execution Chain

**Files:**
- Modify: `src/v2/read-models/postgres-run-inspection.ts`
- Modify: `src/v2/read-models/managed-agents.ts`
- Test: `tests/v2/operator-exception-routes.test.ts`
- Test: `tests/v2/managed-agents-read-model.test.ts`

- [ ] **Step 1: Add failing read model assertions**

In `tests/v2/operator-exception-routes.test.ts`, extend the existing exception route test after the decision assertion:

```ts
await upsertRuntimeResourcePg(db, {
  id: "execution-read-model",
  resourceType: "recovery_execution",
  resourceKey: "recovery_execution:decision-read-model:attempt-1",
  runId: "run-operator-exceptions",
  taskId: "task-a",
  scope: "recovery",
  status: "succeeded",
  title: "Recovery execution",
  payload: {
    schemaVersion: "southstar.runtime.recovery_execution.v1",
    executionId: "execution-read-model",
    decisionId: envelope.result.recoveryDecisions[0]?.payload?.decisionId ?? "decision-read-model",
    exceptionId: envelope.result.exceptions[0]?.exceptionId ?? "exception-read-model",
    runId: "run-operator-exceptions",
    taskId: "task-a",
    path: "requeue-hand-execution",
    status: "succeeded",
    stateChanges: [],
    providerActions: [],
    createdAt: "2026-06-21T13:20:00.000Z",
    completedAt: "2026-06-21T13:21:00.000Z",
  },
});
const refreshed = await getJson<{
  exceptions: unknown[];
  recoveryDecisions: unknown[];
  recoveryExecutions: Array<{ resourceKey: string; status: string; decisionId?: string }>;
}>(server.url, `/api/v2/runs/${encodeURIComponent("run-operator-exceptions")}/exceptions`);
assert.equal(refreshed.recoveryExecutions.length, 1);
assert.equal(refreshed.recoveryExecutions[0]?.status, "succeeded");
```

Adapt variable names to the existing test helper in that file.

- [ ] **Step 2: Run failing tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because `recoveryExecutions` is absent.

- [ ] **Step 3: Add recovery executions to run inspection read model**

In `src/v2/read-models/postgres-run-inspection.ts`, extend `RuntimeExceptionRunReadModel`:

```ts
recoveryExecutions: Array<{
  resourceKey: string;
  status: string;
  decisionId?: string;
  exceptionId?: string;
  path?: string;
  taskId?: string;
  providerActionCount?: number;
  stateChangeCount?: number;
}>;
```

Update the query resource types:

```ts
[RUNTIME_EXCEPTION_RESOURCE_TYPE, RECOVERY_DECISION_RESOURCE_TYPE, "recovery_execution"]
```

Add mapping:

```ts
recoveryExecutions: rows.rows
  .filter((row) => row.resource_type === "recovery_execution")
  .map(mapRecoveryExecutionResource),
```

Add:

```ts
function mapRecoveryExecutionResource(row: RuntimeExceptionResourceRow): RuntimeExceptionRunReadModel["recoveryExecutions"][number] {
  const payload = asRecord(row.payload_json);
  return {
    resourceKey: row.resource_key,
    status: row.status,
    decisionId: stringValue(payload.decisionId),
    exceptionId: stringValue(payload.exceptionId),
    path: stringValue(payload.path),
    taskId: row.task_id ?? stringValue(payload.taskId),
    providerActionCount: Array.isArray(payload.providerActions) ? payload.providerActions.length : undefined,
    stateChangeCount: Array.isArray(payload.stateChanges) ? payload.stateChanges.length : undefined,
  };
}
```

- [ ] **Step 4: Include recovery execution in managed-agent taxonomy**

In `src/v2/read-models/managed-agents.ts`, add `"recovery_execution"` to the runtime resource type list beside `"recovery_decision"`.

- [ ] **Step 5: Run tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for read model tests.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/read-models/postgres-run-inspection.ts src/v2/read-models/managed-agents.ts tests/v2/operator-exception-routes.test.ts tests/v2/managed-agents-read-model.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: expose recovery execution read models"
```

---

### Task 9: Provider Action Evidence For Tork Poll And Cancel

**Files:**
- Create: `src/v2/executor/provider-actions.ts`
- Modify: `src/v2/exceptions/recovery-decision-applier.ts`
- Test: `tests/v2/recovery-decision-applier.test.ts`

- [ ] **Step 1: Add failing provider action failure test**

Append to `tests/v2/recovery-decision-applier.test.ts`:

```ts
test("provider cancel failure is recorded without preventing requeue state transition", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTaskAndHandExecution(db, {
      runId: "run-provider-cancel-failure",
      taskId: "task-a",
      taskStatus: "queued",
      handStatus: "queued",
      attemptId: "attempt-1",
    });
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: "run-provider-cancel-failure",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-provider-cancel-failure:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T13:30:00.000Z",
      evidenceRefs: ["hand-execution:run-provider-cancel-failure:task-a:attempt-1"],
      providerEvidence: { externalJobId: "job-provider-fails" },
    });
    const decision = await controller.decide(await controller.classify(exception));

    const applier = createRecoveryDecisionApplier({
      db,
      providerActions: {
        async cancel() {
          throw new Error("Tork cancel endpoint unreachable: secret=abc123");
        },
      },
    });
    const result = await applier.applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: "2026-06-21T13:31:00.000Z",
    });

    assert.equal(result.status, "applied");
    const executions = (await listResourcesPg(db, { resourceType: "recovery_execution" }))
      .filter((resource) => resource.runId === "run-provider-cancel-failure");
    assert.equal(executions[0]?.status, "succeeded");
    assert.equal(executions[0]?.payload.providerActions[0].status, "failed");
    assert.equal(String(executions[0]?.payload.providerActions[0].errorExcerpt).includes("secret=abc123"), false);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because `providerActions` dependency is unsupported.

- [ ] **Step 3: Implement provider action facade**

Create `src/v2/executor/provider-actions.ts`:

```ts
import type { RecoveryExecutionProviderAction } from "../exceptions/types.ts";

export type RecoveryProviderActions = {
  poll?(input: { providerId: string; externalJobId: string; runId: string }): Promise<Record<string, unknown>>;
  cancel?(input: { providerId: string; externalJobId: string; runId: string; reason: string }): Promise<void>;
};

const SECRET_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,}|secret=[^\s,;]+)/gi;

export async function recordBestEffortCancelAction(input: {
  providerActions?: RecoveryProviderActions;
  providerId: string;
  externalJobId?: string;
  runId: string;
  evidenceRef: string;
  reason: string;
}): Promise<RecoveryExecutionProviderAction> {
  if (!input.externalJobId || !input.providerActions?.cancel) {
    return {
      providerId: input.providerId,
      action: "cancel",
      status: "skipped",
      evidenceRef: input.evidenceRef,
    };
  }
  try {
    await input.providerActions.cancel({
      providerId: input.providerId,
      externalJobId: input.externalJobId,
      runId: input.runId,
      reason: input.reason,
    });
    return {
      providerId: input.providerId,
      action: "cancel",
      status: "succeeded",
      evidenceRef: input.evidenceRef,
    };
  } catch (error) {
    return {
      providerId: input.providerId,
      action: "cancel",
      status: "failed",
      evidenceRef: input.evidenceRef,
      errorExcerpt: redactedProviderError(error),
    };
  }
}

function redactedProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(SECRET_PATTERN, "[REDACTED]").slice(0, 500);
}
```

- [ ] **Step 4: Wire provider actions into applier**

In `RecoveryDecisionApplierDeps`, add:

```ts
providerActions?: RecoveryProviderActions;
```

Import:

```ts
import { recordBestEffortCancelAction, type RecoveryProviderActions } from "../executor/provider-actions.ts";
```

Replace static cancel provider action in `applyRequeueHandExecution()`:

```ts
providerActions.push(await recordBestEffortCancelAction({
  providerActions: deps.providerActions,
  providerId: providerIdFromResource(hand),
  externalJobId: stringValue((hand.payload as Record<string, unknown>).externalJobId),
  runId: decision.payload.runId,
  evidenceRef: hand.resourceKey,
  reason: "requeue-hand-execution",
}));
```

Do the same for running hang destroy/cancel evidence in `applyReprovisionHand()`, using `reason: "reprovision-hand"`.

- [ ] **Step 5: Run tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for provider action failure test.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/executor/provider-actions.ts src/v2/exceptions/recovery-decision-applier.ts tests/v2/recovery-decision-applier.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: record recovery provider actions"
```

---

### Task 10: Runtime Loop And Explicit Apply Route

**Files:**
- Modify: `src/v2/server/runtime-loops.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/managed-runtime-loops.test.ts`
- Test: `tests/v2/operator-recovery-approval-routes.test.ts`

- [ ] **Step 1: Add failing loop plan test**

In `tests/v2/managed-runtime-loops.test.ts`, extend the existing loop plan assertion:

```ts
assert.deepEqual(createManagedRuntimeLoopPlan({ schedulerIntervalMs: 100, recoveryIntervalMs: 200 }).map((item) => item.id), [
  "executor-reconciler",
  "runnable-task-scheduler",
  "recovery-controller",
  "tork-exception-observer",
  "recovery-decision-applier",
]);
```

- [ ] **Step 2: Add failing explicit apply route test**

Append to `tests/v2/operator-recovery-approval-routes.test.ts`:

```ts
test("explicit recovery decision apply route applies an approved decision", async () => {
  const db = await createTestPostgresDb();
  try {
    const decision = await seedWaitingDecision(db, "run-explicit-apply", "task-a");
    await handleRuntimeRoute({ db } as never, new Request(
      `http://southstar.test/api/v2/runs/run-explicit-apply/recovery-decisions/${encodeURIComponent(decision.decisionId)}/approval`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "approved", reason: "operator approves apply" }),
        headers: { "content-type": "application/json" },
      },
    ));
    const response = await handleRuntimeRoute({ db } as never, new Request(
      `http://southstar.test/api/v2/runs/run-explicit-apply/recovery-decisions/${encodeURIComponent(decision.decisionId)}/apply`,
      { method: "POST" },
    ));
    assert.equal(response.status, 200);
    const body = await response.json() as { result: { status: string } };
    assert.equal(["applied", "blocked"].includes(body.result.status), true);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because the loop plan and apply route do not exist.

- [ ] **Step 4: Add applier to runtime loop plan**

In `src/v2/server/runtime-loops.ts`, extend the union:

```ts
id: "executor-reconciler" | "runnable-task-scheduler" | "recovery-controller" | "tork-exception-observer" | "recovery-decision-applier";
```

Add to `createManagedRuntimeLoopPlan()`:

```ts
{ id: "recovery-decision-applier", intervalMs: input.recoveryIntervalMs },
```

Import and instantiate:

```ts
import { createRecoveryDecisionApplier } from "../exceptions/recovery-decision-applier.ts";
```

Inside `createManagedRuntimeLoopController()`:

```ts
const recoveryDecisionApplier = createRecoveryDecisionApplier({
  db: input.db,
  sessionStore: input.sessionStore,
  brainProvider: input.brainProvider,
  handProvider: input.handProvider,
});
```

Add loop controller after observer and before scheduler on the next cycle:

```ts
createRuntimeLoopController({
  intervalMs: input.recoveryIntervalMs,
  runOnce: async () => {
    while (await recoveryDecisionApplier.applyNext()) {
      // drain currently applicable decisions for this tick
    }
  },
}),
```

- [ ] **Step 5: Add explicit apply route**

In `src/v2/server/routes.ts`, import:

```ts
import { createRecoveryDecisionApplier } from "../exceptions/recovery-decision-applier.ts";
```

Add route:

```ts
const recoveryDecisionApplyMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/recovery-decisions\/([^/]+)\/apply$/);
if (request.method === "POST" && recoveryDecisionApplyMatch) {
  const runId = decodeURIComponent(recoveryDecisionApplyMatch[1]!);
  const decisionId = decodeURIComponent(recoveryDecisionApplyMatch[2]!);
  const row = await context.db.one<{ resource_key: string }>(
    `select resource_key
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'recovery_decision'
        and payload_json->>'decisionId' = $2`,
    [runId, decisionId],
  );
  const applier = createRecoveryDecisionApplier({
    db: context.db,
    sessionStore: context.sessionStore,
    brainProvider: context.brainProvider,
    handProvider: context.handProvider,
  });
  return json("recovery-decision-apply", await applier.applyDecision({ decisionResourceKey: row.resource_key }));
}
```

If `RuntimeServerContext` does not expose `sessionStore`, `brainProvider`, or `handProvider`, add optional fields to `src/v2/server/runtime-context.ts` and route only passes defined values. The applier will block paths that require missing recovery dependencies.

- [ ] **Step 6: Run tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for loop plan and explicit apply route tests.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/runtime-loops.ts src/v2/server/routes.ts src/v2/server/runtime-context.ts tests/v2/managed-runtime-loops.test.ts tests/v2/operator-recovery-approval-routes.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: run recovery decision applier loop"
```

---

### Task 11: Real E2E Cases 21-24

**Files:**
- Create: `tests/e2e-postgres/cases/21-recovery-decision-apply-requeue.test.ts`
- Create: `tests/e2e-postgres/cases/22-recovery-decision-apply-reprovision.test.ts`
- Create: `tests/e2e-postgres/cases/23-operator-approved-recovery-apply.test.ts`
- Create: `tests/e2e-postgres/cases/24-provider-unreachable-apply-failure.test.ts`
- Modify: `package.json`
- Modify: `tests/e2e-postgres/postgres-real-matrix-static.test.ts`
- Modify: `tests/e2e-postgres/README.md`

- [ ] **Step 1: Add package scripts**

In `package.json`, add:

```json
"test:e2e:postgres:21": "tsx tests/e2e-postgres/cases/21-recovery-decision-apply-requeue.test.ts",
"test:e2e:postgres:22": "tsx tests/e2e-postgres/cases/22-recovery-decision-apply-reprovision.test.ts",
"test:e2e:postgres:23": "tsx tests/e2e-postgres/cases/23-operator-approved-recovery-apply.test.ts",
"test:e2e:postgres:24": "tsx tests/e2e-postgres/cases/24-provider-unreachable-apply-failure.test.ts"
```

- [ ] **Step 2: Add static matrix expectations**

In `tests/e2e-postgres/postgres-real-matrix-static.test.ts`, extend the ordered case list to include:

```ts
"21-recovery-decision-apply-requeue.test.ts",
"22-recovery-decision-apply-reprovision.test.ts",
"23-operator-approved-recovery-apply.test.ts",
"24-provider-unreachable-apply-failure.test.ts",
```

- [ ] **Step 3: Write case 21**

Create `tests/e2e-postgres/cases/21-recovery-decision-apply-requeue.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
import { createRecoveryDecisionApplier } from "../../../src/v2/exceptions/recovery-decision-applier.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresRealHarness } from "../postgres-real-harness.ts";

test("21 recovery decision apply requeue: queued timeout releases task for new attempt", async () => {
  const harness = await createPostgresRealHarness();
  try {
    const runId = "real-recovery-apply-requeue";
    const taskId = "task-a";
    await createWorkflowRunPg(harness.db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "real requeue recovery",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(harness.db, {
      id: taskId,
      runId,
      taskKey: taskId,
      status: "queued",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-a",
    });
    const handExecutionId = `hand-execution:${runId}:${taskId}:attempt-1`;
    await upsertRuntimeResourcePg(harness.db, {
      id: handExecutionId,
      resourceType: "hand_execution",
      resourceKey: handExecutionId,
      runId,
      taskId,
      sessionId: "session-a",
      scope: "hand",
      status: "queued",
      title: "Queued hand execution",
      payload: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId,
        providerId: "tork",
        runId,
        taskId,
        sessionId: "session-a",
        attemptId: "attempt-1",
        brainBindingId: "brain-a",
        handBindingId: "hand-a",
        externalJobId: "job-real-requeue",
        status: "queued",
        queuedAt: "2026-06-21T13:00:00.000Z",
        queueTimeoutSeconds: 60,
        heartbeatTimeoutSeconds: 30,
      },
    });
    const controller = createRuntimeExceptionController({ db: harness.db });
    const exception = await controller.observe({
      runId,
      taskId,
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId,
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T13:02:00.000Z",
      evidenceRefs: [handExecutionId],
      providerEvidence: { externalJobId: "job-real-requeue" },
    });
    const decision = await controller.decide(await controller.classify(exception));
    const result = await createRecoveryDecisionApplier({ db: harness.db }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: "2026-06-21T13:03:00.000Z",
    });

    assert.equal(result.status, "applied");
    const task = await harness.db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "pending");
    const executions = await listResourcesPg(harness.db, { resourceType: "recovery_execution" });
    assert.equal(executions.some((resource) => resource.runId === runId && resource.status === "succeeded"), true);
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 4: Write case 22**

Create `tests/e2e-postgres/cases/22-recovery-decision-apply-reprovision.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBrainProvider } from "../../../src/v2/brain/fake-brain-provider.ts";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
import { createRecoveryDecisionApplier } from "../../../src/v2/exceptions/recovery-decision-applier.ts";
import { createFakeHandProvider } from "../../../src/v2/hands/fake-hand-provider.ts";
import { createPostgresSessionStore } from "../../../src/v2/session/postgres-session-store.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresRealHarness } from "../postgres-real-harness.ts";

test("22 recovery decision apply reprovision: running hang creates replacement hand", async () => {
  const harness = await createPostgresRealHarness();
  try {
    const runId = "real-recovery-apply-reprovision";
    const taskId = "task-a";
    await createWorkflowRunPg(harness.db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "real reprovision recovery",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(harness.db, {
      id: taskId,
      runId,
      taskKey: taskId,
      status: "running",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-a",
    });
    const handExecutionId = `hand-execution:${runId}:${taskId}:attempt-1`;
    const handBindingId = `hand-binding:${runId}:${taskId}:old`;
    await upsertRuntimeResourcePg(harness.db, {
      id: handBindingId,
      resourceType: "hand_binding",
      resourceKey: handBindingId,
      runId,
      taskId,
      sessionId: "session-a",
      scope: "hand",
      status: "running",
      title: "Old hand binding",
      payload: { id: handBindingId, providerId: "fake-hand", runId, taskId, handName: "workspace" },
    });
    await upsertRuntimeResourcePg(harness.db, {
      id: handExecutionId,
      resourceType: "hand_execution",
      resourceKey: handExecutionId,
      runId,
      taskId,
      sessionId: "session-a",
      scope: "hand",
      status: "running",
      title: "Running hand execution",
      payload: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId,
        providerId: "tork",
        runId,
        taskId,
        sessionId: "session-a",
        attemptId: "attempt-1",
        brainBindingId: "brain-a",
        handBindingId,
        externalJobId: "job-real-reprovision",
        status: "running",
        queuedAt: "2026-06-21T13:00:00.000Z",
        startedAt: "2026-06-21T13:01:00.000Z",
        queueTimeoutSeconds: 60,
        heartbeatTimeoutSeconds: 30,
      },
    });
    const controller = createRuntimeExceptionController({ db: harness.db });
    const exception = await controller.observe({
      runId,
      taskId,
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId,
      handBindingId,
      source: "tork-observer",
      kind: "tork_running_hang",
      severity: "recoverable",
      observedAt: "2026-06-21T13:02:00.000Z",
      evidenceRefs: [handExecutionId],
      providerEvidence: { externalJobId: "job-real-reprovision", status: "running" },
    });
    const decision = await controller.decide(await controller.classify(exception));
    const result = await createRecoveryDecisionApplier({
      db: harness.db,
      sessionStore: createPostgresSessionStore(harness.db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: "2026-06-21T13:03:00.000Z",
    });

    assert.equal(result.status, "applied");
    const handBindings = await listResourcesPg(harness.db, { resourceType: "hand_binding" });
    assert.equal(handBindings.some((resource) => resource.runId === runId && resource.status === "provisioned"), true);
    const task = await harness.db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "pending");
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 5: Write case 23**

Create `tests/e2e-postgres/cases/23-operator-approved-recovery-apply.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { decideRecoveryDecisionApprovalPg } from "../../../src/v2/exceptions/recovery-approval-service.ts";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
import { createRecoveryDecisionApplier } from "../../../src/v2/exceptions/recovery-decision-applier.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresRealHarness } from "../postgres-real-harness.ts";

test("23 operator approved recovery apply: approval gates decision before apply", async () => {
  const harness = await createPostgresRealHarness();
  try {
    const runId = "real-operator-approved-recovery-apply";
    const taskId = "task-a";
    await createWorkflowRunPg(harness.db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "operator approved recovery",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(harness.db, {
      id: taskId,
      runId,
      taskKey: taskId,
      status: "queued",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-a",
    });
    const handExecutionId = `hand-execution:${runId}:${taskId}:attempt-1`;
    await upsertRuntimeResourcePg(harness.db, {
      id: handExecutionId,
      resourceType: "hand_execution",
      resourceKey: handExecutionId,
      runId,
      taskId,
      sessionId: "session-a",
      scope: "hand",
      status: "queued",
      title: "Queued hand execution",
      payload: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId,
        providerId: "tork",
        runId,
        taskId,
        sessionId: "session-a",
        attemptId: "attempt-1",
        brainBindingId: "brain-a",
        handBindingId: "hand-a",
        externalJobId: "job-operator-approved",
        status: "queued",
        queuedAt: "2026-06-21T13:00:00.000Z",
        queueTimeoutSeconds: 60,
        heartbeatTimeoutSeconds: 30,
      },
    });
    const controller = createRuntimeExceptionController({ db: harness.db });
    const exception = await controller.observe({
      runId,
      taskId,
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId,
      source: "operator",
      kind: "provider_unreachable",
      severity: "blocking",
      observedAt: "2026-06-21T13:02:00.000Z",
      evidenceRefs: [handExecutionId],
    });
    const waitingDecision = await controller.decide(await controller.classify(exception));
    const skipped = await createRecoveryDecisionApplier({ db: harness.db }).applyDecision({
      decisionResourceKey: waitingDecision.resourceKey,
    });
    const approved = await decideRecoveryDecisionApprovalPg(harness.db, {
      runId,
      decisionId: waitingDecision.decisionId,
      decision: "approved",
      reason: "operator approves blocked provider recovery",
    });

    assert.equal(waitingDecision.status, "waiting_operator_approval");
    assert.equal(skipped.status, "skipped");
    assert.equal(approved.status, "approved");
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 6: Write case 24**

Create `tests/e2e-postgres/cases/24-provider-unreachable-apply-failure.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
import { createRecoveryDecisionApplier } from "../../../src/v2/exceptions/recovery-decision-applier.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresRealHarness } from "../postgres-real-harness.ts";

test("24 provider unreachable apply failure: cancel failure is evidence and task is released", async () => {
  const harness = await createPostgresRealHarness();
  try {
    const runId = "real-provider-unreachable-apply-failure";
    const taskId = "task-a";
    await createWorkflowRunPg(harness.db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "provider unreachable recovery",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(harness.db, {
      id: taskId,
      runId,
      taskKey: taskId,
      status: "queued",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-a",
    });
    const handExecutionId = `hand-execution:${runId}:${taskId}:attempt-1`;
    await upsertRuntimeResourcePg(harness.db, {
      id: handExecutionId,
      resourceType: "hand_execution",
      resourceKey: handExecutionId,
      runId,
      taskId,
      sessionId: "session-a",
      scope: "hand",
      status: "queued",
      title: "Queued hand execution",
      payload: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId,
        providerId: "tork",
        runId,
        taskId,
        sessionId: "session-a",
        attemptId: "attempt-1",
        brainBindingId: "brain-a",
        handBindingId: "hand-a",
        externalJobId: "job-cancel-fails",
        status: "queued",
        queuedAt: "2026-06-21T13:00:00.000Z",
        queueTimeoutSeconds: 60,
        heartbeatTimeoutSeconds: 30,
      },
    });
    const controller = createRuntimeExceptionController({ db: harness.db });
    const exception = await controller.observe({
      runId,
      taskId,
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId,
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T13:02:00.000Z",
      evidenceRefs: [handExecutionId],
      providerEvidence: { externalJobId: "job-cancel-fails" },
    });
    const decision = await controller.decide(await controller.classify(exception));
    const result = await createRecoveryDecisionApplier({
      db: harness.db,
      providerActions: {
        async cancel() {
          throw new Error("provider unreachable token=secret-value");
        },
      },
    }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: "2026-06-21T13:03:00.000Z",
    });

    assert.equal(result.status, "applied");
    const executions = (await listResourcesPg(harness.db, { resourceType: "recovery_execution" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.payload.providerActions.some((action: { status: string }) => action.status === "failed"), true);
    assert.equal(JSON.stringify(executions[0]?.payload).includes("secret-value"), false);
    const task = await harness.db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "pending");
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 7: Update README**

In `tests/e2e-postgres/README.md`, add scripts and matrix rows:

```md
npm run test:e2e:postgres:21   # recovery decision apply requeue
npm run test:e2e:postgres:22   # recovery decision apply reprovision
npm run test:e2e:postgres:23   # operator-approved recovery apply
npm run test:e2e:postgres:24   # provider unreachable apply evidence
```

Rows:

```md
| 21 recovery decision apply requeue | implemented | Applies queue timeout decision and releases task for retry | recovered task state, `recovery_execution`, resolved exception |
| 22 recovery decision apply reprovision | implemented | Applies running hang decision and creates replacement hand | lost old hand, new hand binding, pending task |
| 23 operator-approved recovery apply | implemented | Approval gates unsafe recovery until operator action | waiting approval, approval resource, applied decision |
| 24 provider unreachable apply failure | implemented | Provider cancel failure is evidence without corrupting Southstar truth | failed provider action, pending task, succeeded recovery execution |
```

- [ ] **Step 8: Run static matrix**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres /home/timmypai/apps/southstar/node_modules/.bin/tsx tests/e2e-postgres/postgres-real-matrix-static.test.ts
```

Expected: PASS with 4 static tests.

- [ ] **Step 9: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add package.json tests/e2e-postgres/postgres-real-matrix-static.test.ts tests/e2e-postgres/README.md tests/e2e-postgres/cases/21-recovery-decision-apply-requeue.test.ts tests/e2e-postgres/cases/22-recovery-decision-apply-reprovision.test.ts tests/e2e-postgres/cases/23-operator-approved-recovery-apply.test.ts tests/e2e-postgres/cases/24-provider-unreachable-apply-failure.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover recovery decision apply e2e cases"
```

---

### Task 12: Runbook And Final Verification

**Files:**
- Modify: `docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md`

- [ ] **Step 1: Update the runbook**

Add a section after `## 4. hand reprovision`:

```md
## 4.1 recovery decision apply

1. 查詢 `GET /api/v2/runs/:runId/exceptions`，確認 exception、decision、latest recovery execution。
2. 若 decision status 是 `recorded`，runtime loop 應自動 apply。
3. 若 decision status 是 `waiting_operator_approval`，operator 必須先核准或拒絕。
4. 核准：

```bash
curl -X POST "$SOUTHSTAR_URL/api/v2/runs/$RUN_ID/recovery-decisions/$DECISION_ID/approval" \
  -H 'content-type: application/json' \
  -d '{"decision":"approved","reason":"operator approved recovery"}'
```

5. 手動觸發 apply：

```bash
curl -X POST "$SOUTHSTAR_URL/api/v2/runs/$RUN_ID/recovery-decisions/$DECISION_ID/apply"
```

6. apply 後確認：
   - `recovery_execution.status` 是 `succeeded`、`blocked`、`failed` 或 `superseded`。
   - 對應 task/hand state 有 state change evidence。
   - exception 已 resolved，或保留 blocked evidence。
   - completion gate 沒有 unresolved exception 或 unapplied decision。
```

- [ ] **Step 2: Run full verification**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm test
```

Expected: PASS all root tests.

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS all V2 tests.

Run:

```bash
/home/timmypai/apps/southstar/node_modules/.bin/tsc --noEmit
```

Expected: exit 0.

Run:

```bash
npm run web:build
```

Expected: Next.js production build succeeds.

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres /home/timmypai/apps/southstar/node_modules/.bin/tsx tests/e2e-postgres/postgres-real-matrix-static.test.ts
```

Expected: PASS static matrix.

- [ ] **Step 3: Clean generated build artifacts**

Check:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short --branch --untracked-files=all
```

If `next-env.d.ts` changed from:

```ts
import "./.next/dev/types/routes.d.ts";
```

to:

```ts
import "./.next/types/routes.d.ts";
```

restore:

```ts
import "./.next/dev/types/routes.d.ts";
```

If `tsconfig.tsbuildinfo` appears untracked, delete only that generated file.

- [ ] **Step 4: Commit runbook**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "docs: document recovery decision apply operations"
```

- [ ] **Step 5: Final status**

Run:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short --branch --untracked-files=all
```

Expected: clean worktree with the feature branch ahead of its base by the implementation commits.
