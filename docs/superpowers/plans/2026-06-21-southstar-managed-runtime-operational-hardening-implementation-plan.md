# Southstar Managed Runtime Operational Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build production-grade managed runtime hardening for Southstar v2: centralized runtime exception handling, per-task Tork timeout/hang recovery, tool proxy enforcement, work item intake-to-run materialization, operator read models, and real E2E coverage.

**Architecture:** Postgres remains the canonical truth. Existing V2 recovery, callback, completion gate, scheduler, and tool proxy modules are extended rather than replaced. New focused exception modules normalize abnormal evidence into `runtime_exception`, classify it, create `recovery_decision`, and let existing recovery/completion paths apply state changes.

**Tech Stack:** TypeScript, Node.js `node:test`, `tsx`, Postgres, existing Southstar v2 stores, Tork hand provider, Next.js runtime UI/read-model surfaces.

---

## Scope And Ordering

This plan implements the full operational hardening design, not a reduced vertical slice. Tasks are ordered so every commit leaves a testable runtime:

1. Exception contracts and Postgres store.
2. Exception controller classification and recovery decision mapping.
3. Tork observer for queued timeout and running hang.
4. Scheduler and callback integration.
5. Completion gate blocking unresolved exceptions.
6. Tool proxy full-path enforcement.
7. Work item intake-to-run materialization.
8. Read model and operator routes.
9. Real E2E case matrix and docs.

The previous V1/Northstar exception policy was removed with legacy runtime code. Do not restore V1 files. Reuse V2 modules:

- `src/v2/session-recovery/postgres-controller.ts`
- `src/v2/executor/postgres-tork-callback.ts`
- `src/v2/evaluators/completion-gate.ts`
- `src/v2/tool-proxy/policy-enforcer.ts`
- `src/v2/server/runtime-loops.ts`
- `src/v2/scheduler/runnable-task-scheduler.ts`

Use repo-local git:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add <files>
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "<message>"
```

## File Structure

Create:

- `src/v2/exceptions/types.ts`  
  Runtime exception, classification, recovery path, observation, and persistence types.
- `src/v2/exceptions/postgres-runtime-exceptions.ts`  
  Idempotent `runtime_exception` store, history events, listing unresolved exceptions.
- `src/v2/exceptions/runtime-exception-controller.ts`  
  Central observe/classify/decide/apply facade. It delegates persistence to the store and recovery application to existing V2 recovery code.
- `src/v2/executor/tork-observer.ts`  
  Detect queued timeout, running hang, and terminal-without-callback from `hand_execution` resources and provider observations.
- `src/v2/tool-proxy/runtime-enforcement.ts`  
  Pre-execution and callback enforcement facade over existing `policy-enforcer.ts`.
- `src/v2/work-items/run-materialization.ts`  
  Canonical work item -> draft/run linkage helper for API/CLI/UI entry points.
- `tests/v2/runtime-exceptions.test.ts`
- `tests/v2/tork-observer.test.ts`
- `tests/v2/completion-gate-exceptions.test.ts`
- `tests/v2/tool-proxy-runtime-enforcement.test.ts`
- `tests/v2/work-item-run-materialization.test.ts`
- `tests/v2/operator-exception-routes.test.ts`
- `tests/e2e-postgres/cases/14-tork-queue-timeout-recovery.test.ts`
- `tests/e2e-postgres/cases/15-tork-running-hang-recovery.test.ts`
- `tests/e2e-postgres/cases/16-late-callback-superseded-attempt.test.ts`
- `tests/e2e-postgres/cases/17-tool-proxy-runtime-enforcement.test.ts`
- `tests/e2e-postgres/cases/18-work-item-intake-run-execution.test.ts`
- `tests/e2e-postgres/cases/19-completion-gate-unresolved-exception.test.ts`
- `tests/e2e-postgres/cases/20-operator-approved-recovery.test.ts`

Modify:

- `tests/v2/index.test.ts`
- `src/v2/server/runtime-loops.ts`
- `src/v2/scheduler/runnable-task-scheduler.ts`
- `src/v2/executor/postgres-tork-callback.ts`
- `src/v2/evaluators/completion-gate.ts`
- `src/v2/tool-proxy/policy-enforcer.ts`
- `src/v2/server/routes.ts`
- `src/v2/read-models/postgres-run-inspection.ts`
- `src/v2/read-models/managed-agents.ts`
- `src/v2/cli.ts`
- `package.json`
- `tests/e2e-postgres/postgres-real-matrix-static.test.ts`
- `tests/e2e-postgres/README.md`

---

### Task 1: Runtime Exception Contracts And Store

**Files:**
- Create: `src/v2/exceptions/types.ts`
- Create: `src/v2/exceptions/postgres-runtime-exceptions.ts`
- Test: `tests/v2/runtime-exceptions.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing runtime exception store test**

Create `tests/v2/runtime-exceptions.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  listHistoryForRunPg,
  listResourcesPg,
  createWorkflowRunPg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  listUnresolvedRuntimeExceptionsPg,
  recordRuntimeExceptionPg,
  resolveRuntimeExceptionPg,
} from "../../src/v2/exceptions/postgres-runtime-exceptions.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("runtime exception store records idempotent exception resources and history", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-exception-store",
      status: "running",
      domain: "software",
      goalPrompt: "harden runtime",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const first = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-store",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-store:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      status: "observed",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["hand-execution:run-exception-store:task-a:attempt-1"],
      providerEvidence: { externalJobId: "job-a", queueAgeSeconds: 121 },
    });
    const duplicate = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-store",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-store:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      status: "observed",
      observedAt: "2026-06-21T10:00:30.000Z",
      evidenceRefs: ["hand-execution:run-exception-store:task-a:attempt-1"],
      providerEvidence: { externalJobId: "job-a", queueAgeSeconds: 151 },
    });

    assert.equal(duplicate.exceptionId, first.exceptionId);
    assert.equal(duplicate.resourceKey, first.resourceKey);
    const resources = await listResourcesPg(db, { resourceType: "runtime_exception" });
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.status, "observed");
    assert.equal(resources[0]?.payload.schemaVersion, "southstar.runtime.exception.v1");
    assert.equal(resources[0]?.payload.kind, "tork_queue_timeout");
    assert.equal(resources[0]?.payload.severity, "recoverable");

    const unresolved = await listUnresolvedRuntimeExceptionsPg(db, { runId: "run-exception-store" });
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]?.resourceKey, first.resourceKey);

    await resolveRuntimeExceptionPg(db, {
      runId: "run-exception-store",
      resourceKey: first.resourceKey,
      resolvedAt: "2026-06-21T10:02:00.000Z",
      reason: "replacement attempt queued",
    });

    const afterResolve = await listUnresolvedRuntimeExceptionsPg(db, { runId: "run-exception-store" });
    assert.equal(afterResolve.length, 0);
    const history = await listHistoryForRunPg(db, "run-exception-store");
    assert.deepEqual(history.map((event) => event.eventType), [
      "runtime_exception.observed",
      "runtime_exception.resolved",
    ]);
  } finally {
    await db.close();
  }
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./runtime-exceptions.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with an import error for `src/v2/exceptions/postgres-runtime-exceptions.ts`.

- [ ] **Step 3: Add exception types**

Create `src/v2/exceptions/types.ts`:

```ts
export const RUNTIME_EXCEPTION_RESOURCE_TYPE = "runtime_exception";
export const RUNTIME_EXCEPTION_SCHEMA_VERSION = "southstar.runtime.exception.v1";

export type RuntimeExceptionSource =
  | "scheduler"
  | "tork-observer"
  | "callback"
  | "heartbeat"
  | "tool-proxy"
  | "artifact-gate"
  | "completion-gate"
  | "intake"
  | "operator";

export type RuntimeExceptionKind =
  | "tork_queue_timeout"
  | "tork_running_hang"
  | "tork_terminal_without_callback"
  | "late_callback"
  | "stale_callback"
  | "callback_contract_violation"
  | "artifact_rejected"
  | "tool_proxy_violation"
  | "brain_wake_failed"
  | "hand_provision_failed"
  | "hand_submit_failed"
  | "scheduler_claim_stale"
  | "intake_invalid"
  | "completion_gate_failed"
  | "provider_unreachable";

export type RuntimeExceptionSeverity = "info" | "warning" | "recoverable" | "blocking" | "terminal";
export type RuntimeExceptionStatus = "observed" | "classified" | "deciding" | "recovering" | "resolved" | "blocked" | "terminal";

export type RecoveryPath =
  | "none-observe-only"
  | "requeue-hand-execution"
  | "reprovision-hand"
  | "wake-new-brain"
  | "retry-same-task-new-attempt"
  | "repair-artifact"
  | "rollback-workspace"
  | "block-for-operator"
  | "fail-task"
  | "fail-run";

export type RuntimeExceptionPayload = {
  schemaVersion: typeof RUNTIME_EXCEPTION_SCHEMA_VERSION;
  exceptionId: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  handExecutionId?: string;
  brainBindingId?: string;
  handBindingId?: string;
  source: RuntimeExceptionSource;
  kind: RuntimeExceptionKind;
  severity: RuntimeExceptionSeverity;
  status: RuntimeExceptionStatus;
  observedAt: string;
  classifiedAt?: string;
  evidenceRefs: string[];
  providerEvidence?: Record<string, unknown>;
  retryBudgetRef?: string;
  recoveryDecisionRef?: string;
  resolvedAt?: string;
  resolvedReason?: string;
};

export type RuntimeExceptionRecordInput = Omit<RuntimeExceptionPayload, "schemaVersion" | "exceptionId"> & {
  exceptionId?: string;
};

export type RuntimeExceptionRecord = {
  exceptionId: string;
  resourceKey: string;
  payload: RuntimeExceptionPayload;
};
```

- [ ] **Step 4: Implement Postgres exception store**

Create `src/v2/exceptions/postgres-runtime-exceptions.ts`:

```ts
import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import {
  RUNTIME_EXCEPTION_RESOURCE_TYPE,
  RUNTIME_EXCEPTION_SCHEMA_VERSION,
  type RuntimeExceptionPayload,
  type RuntimeExceptionRecord,
  type RuntimeExceptionRecordInput,
} from "./types.ts";

export async function recordRuntimeExceptionPg(
  db: SouthstarDb,
  input: RuntimeExceptionRecordInput,
): Promise<RuntimeExceptionRecord> {
  const resourceKey = runtimeExceptionResourceKey(input);
  const existing = await getResourceByKeyPg(db, RUNTIME_EXCEPTION_RESOURCE_TYPE, resourceKey);
  if (existing) {
    return {
      exceptionId: String((existing.payload as { exceptionId?: unknown }).exceptionId ?? resourceKey),
      resourceKey,
      payload: existing.payload as RuntimeExceptionPayload,
    };
  }

  const payload: RuntimeExceptionPayload = {
    schemaVersion: RUNTIME_EXCEPTION_SCHEMA_VERSION,
    exceptionId: input.exceptionId ?? resourceKey,
    ...input,
  };

  await upsertRuntimeResourcePg(db, {
    id: resourceKey,
    resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
    resourceKey,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: scopeForException(input),
    status: input.status,
    title: `Runtime exception: ${input.kind}`,
    payload,
    summary: {
      kind: input.kind,
      severity: input.severity,
      source: input.source,
    },
    metrics: {},
  });

  await appendRuntimeExceptionEventOnce(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "runtime_exception.observed",
    idempotencyKey: `${resourceKey}:observed`,
    payload: { exceptionId: payload.exceptionId, resourceKey, kind: input.kind, severity: input.severity },
  });

  return { exceptionId: payload.exceptionId, resourceKey, payload };
}

export async function listUnresolvedRuntimeExceptionsPg(
  db: SouthstarDb,
  input: { runId: string; includeWarnings?: boolean },
): Promise<Array<{ resourceKey: string; status: string; payload: RuntimeExceptionPayload }>> {
  const statuses = ["observed", "classified", "deciding", "recovering", "blocked", "terminal"];
  const rows = await db.query<{ resource_key: string; status: string; payload_json: RuntimeExceptionPayload }>(
    `select resource_key, status, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = $2
        and status = any($3::text[])
      order by created_at, resource_key`,
    [input.runId, RUNTIME_EXCEPTION_RESOURCE_TYPE, statuses],
  );
  return rows.rows
    .filter((row) => input.includeWarnings || row.payload_json.severity !== "warning" && row.payload_json.severity !== "info")
    .map((row) => ({ resourceKey: row.resource_key, status: row.status, payload: row.payload_json }));
}

export async function resolveRuntimeExceptionPg(
  db: SouthstarDb,
  input: { runId: string; resourceKey: string; resolvedAt: string; reason: string },
): Promise<void> {
  const existing = await getResourceByKeyPg(db, RUNTIME_EXCEPTION_RESOURCE_TYPE, input.resourceKey);
  if (!existing) throw new Error(`runtime exception not found: ${input.resourceKey}`);
  const payload = existing.payload as RuntimeExceptionPayload;
  await upsertRuntimeResourcePg(db, {
    id: existing.id,
    resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
    resourceKey: input.resourceKey,
    runId: input.runId,
    taskId: existing.taskId ?? undefined,
    sessionId: existing.sessionId ?? undefined,
    scope: existing.scope,
    status: "resolved",
    title: existing.title,
    payload: {
      ...payload,
      status: "resolved",
      resolvedAt: input.resolvedAt,
      resolvedReason: input.reason,
    },
    summary: existing.summary,
    metrics: existing.metrics,
  });
  await appendRuntimeExceptionEventOnce(db, {
    runId: input.runId,
    taskId: existing.taskId ?? undefined,
    sessionId: existing.sessionId ?? undefined,
    eventType: "runtime_exception.resolved",
    idempotencyKey: `${input.resourceKey}:resolved:${shortHash(input.reason)}`,
    payload: { exceptionId: payload.exceptionId, resourceKey: input.resourceKey, reason: input.reason },
  });
}

function runtimeExceptionResourceKey(input: RuntimeExceptionRecordInput): string {
  const fingerprint = shortHash(JSON.stringify({
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    handExecutionId: input.handExecutionId,
    source: input.source,
    kind: input.kind,
  }));
  return `runtime_exception:${input.runId}:${scopeForException(input)}:${fingerprint}`;
}

function scopeForException(input: RuntimeExceptionRecordInput): string {
  if (input.source === "tool-proxy") return "tool";
  if (input.source === "intake") return "intake";
  if (input.source === "completion-gate") return "evaluator";
  if (input.handExecutionId) return "hand";
  if (input.taskId) return "task";
  return "run";
}

async function appendRuntimeExceptionEventOnce(
  db: SouthstarDb,
  input: { runId: string; taskId?: string; sessionId?: string; eventType: string; idempotencyKey: string; payload: unknown },
): Promise<void> {
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.runId, input.idempotencyKey],
  );
  if (existing) return;
  await appendHistoryEventPg(db, { ...input, actorType: "orchestrator" });
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
```

- [ ] **Step 5: Run the test**

Run:

```bash
npm run test:v2
```

Expected: PASS for `runtime-exceptions.test.ts`.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/exceptions tests/v2/runtime-exceptions.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add runtime exception store"
```

---

### Task 2: Runtime Exception Controller And Recovery Decision Mapping

**Files:**
- Create: `src/v2/exceptions/runtime-exception-controller.ts`
- Modify: `src/v2/exceptions/types.ts`
- Test: `tests/v2/runtime-exceptions.test.ts`

- [ ] **Step 1: Add failing controller tests**

Append to `tests/v2/runtime-exceptions.test.ts`:

```ts
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";

test("runtime exception controller maps queue timeout to requeue-hand-execution decision", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-exception-controller",
      status: "running",
      domain: "software",
      goalPrompt: "recover queue timeout",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const controller = createRuntimeExceptionController({ db });

    const exception = await controller.observe({
      runId: "run-exception-controller",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-controller:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["hand-execution:run-exception-controller:task-a:attempt-1"],
      providerEvidence: { externalJobId: "job-timeout" },
    });
    const classification = await controller.classify(exception);
    const decision = await controller.decide(classification);

    assert.equal(classification.recoveryPath, "requeue-hand-execution");
    assert.equal(decision.payload.path, "requeue-hand-execution");
    assert.equal(decision.payload.exceptionId, exception.exceptionId);
    assert.equal(decision.payload.operatorApprovalRequired, false);
    assert.equal(decision.status, "recorded");
  } finally {
    await db.close();
  }
});

test("runtime exception controller requires operator approval for rollback decisions", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-exception-rollback",
      status: "running",
      domain: "software",
      goalPrompt: "recover hang",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: "run-exception-rollback",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-rollback:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_running_hang",
      severity: "recoverable",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["workspace-snapshot:dirty"],
      providerEvidence: { workspaceUnsafe: true },
    });
    const decision = await controller.decide(await controller.classify(exception));

    assert.equal(decision.payload.path, "rollback-workspace");
    assert.equal(decision.payload.operatorApprovalRequired, true);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm run test:v2
```

Expected: FAIL with import error for `runtime-exception-controller.ts`.

- [ ] **Step 3: Extend types**

Add to `src/v2/exceptions/types.ts`:

```ts
export type RuntimeObservation = RuntimeExceptionRecordInput;

export type RuntimeExceptionClassification = RuntimeExceptionRecord & {
  recoveryPath: RecoveryPath;
  operatorApprovalRequired: boolean;
  reason: string;
};

export type RecoveryDecisionPayload = {
  schemaVersion: "southstar.runtime.recovery_decision.v1";
  decisionId: string;
  exceptionId: string;
  runId: string;
  taskId?: string;
  handExecutionId?: string;
  path: RecoveryPath;
  reason: string;
  operatorApprovalRequired: boolean;
  previousAttemptId?: string;
  nextAttemptId?: string;
  supersedes?: string[];
  evidenceRefs: string[];
  createdAt: string;
};

export type RuntimeRecoveryDecisionRecord = {
  decisionId: string;
  resourceKey: string;
  status: "recorded" | "approved" | "applied" | "blocked" | "failed";
  payload: RecoveryDecisionPayload;
};
```

- [ ] **Step 4: Implement controller**

Create `src/v2/exceptions/runtime-exception-controller.ts`:

```ts
import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { recordRuntimeExceptionPg } from "./postgres-runtime-exceptions.ts";
import type {
  RecoveryPath,
  RuntimeExceptionClassification,
  RuntimeExceptionRecord,
  RuntimeObservation,
  RuntimeRecoveryDecisionRecord,
} from "./types.ts";

export function createRuntimeExceptionController(input: { db: SouthstarDb }): {
  observe(observation: RuntimeObservation): Promise<RuntimeExceptionRecord>;
  classify(exception: RuntimeExceptionRecord): Promise<RuntimeExceptionClassification>;
  decide(classification: RuntimeExceptionClassification): Promise<RuntimeRecoveryDecisionRecord>;
} {
  return {
    async observe(observation) {
      return await recordRuntimeExceptionPg(input.db, { ...observation, status: observation.status ?? "observed" });
    },
    async classify(exception) {
      const recoveryPath = recoveryPathForException(exception);
      const operatorApprovalRequired = recoveryPath === "rollback-workspace" || recoveryPath === "block-for-operator";
      return {
        ...exception,
        recoveryPath,
        operatorApprovalRequired,
        reason: reasonForException(exception, recoveryPath),
      };
    },
    async decide(classification) {
      const decisionId = `recovery-decision-${shortHash(`${classification.resourceKey}:${classification.recoveryPath}`)}`;
      const resourceKey = `recovery_decision:${classification.resourceKey}`;
      const payload = {
        schemaVersion: "southstar.runtime.recovery_decision.v1" as const,
        decisionId,
        exceptionId: classification.exceptionId,
        runId: classification.payload.runId,
        taskId: classification.payload.taskId,
        handExecutionId: classification.payload.handExecutionId,
        path: classification.recoveryPath,
        reason: classification.reason,
        operatorApprovalRequired: classification.operatorApprovalRequired,
        previousAttemptId: classification.payload.attemptId,
        nextAttemptId: nextAttemptId(classification.payload.attemptId),
        evidenceRefs: classification.payload.evidenceRefs,
        createdAt: new Date().toISOString(),
      };
      await upsertRuntimeResourcePg(input.db, {
        id: decisionId,
        resourceType: "recovery_decision",
        resourceKey,
        runId: payload.runId,
        taskId: payload.taskId,
        sessionId: classification.payload.sessionId,
        scope: "recovery",
        status: "recorded",
        title: `Recovery decision: ${payload.path}`,
        payload,
        summary: { path: payload.path, operatorApprovalRequired: payload.operatorApprovalRequired },
        metrics: {},
      });
      await appendHistoryEventPg(input.db, {
        runId: payload.runId,
        taskId: payload.taskId,
        sessionId: classification.payload.sessionId,
        eventType: "runtime_exception.recovery_decided",
        actorType: "orchestrator",
        idempotencyKey: `${resourceKey}:recorded`,
        payload: { decisionId, exceptionId: payload.exceptionId, path: payload.path },
      });
      return { decisionId, resourceKey, status: "recorded", payload };
    },
  };
}

function recoveryPathForException(exception: RuntimeExceptionRecord): RecoveryPath {
  if (exception.payload.kind === "tork_queue_timeout") return "requeue-hand-execution";
  if (exception.payload.kind === "tork_running_hang") {
    return (exception.payload.providerEvidence as { workspaceUnsafe?: unknown } | undefined)?.workspaceUnsafe === true
      ? "rollback-workspace"
      : "reprovision-hand";
  }
  if (exception.payload.kind === "tork_terminal_without_callback") return "retry-same-task-new-attempt";
  if (exception.payload.kind === "late_callback" || exception.payload.kind === "stale_callback") return "none-observe-only";
  if (exception.payload.kind === "callback_contract_violation") return "repair-artifact";
  if (exception.payload.kind === "artifact_rejected") return "repair-artifact";
  if (exception.payload.kind === "tool_proxy_violation") return "block-for-operator";
  if (exception.payload.kind === "brain_wake_failed") return "wake-new-brain";
  if (exception.payload.kind === "hand_provision_failed" || exception.payload.kind === "hand_submit_failed") return "reprovision-hand";
  if (exception.payload.kind === "completion_gate_failed") return "block-for-operator";
  if (exception.payload.kind === "provider_unreachable") return "block-for-operator";
  return "block-for-operator";
}

function reasonForException(exception: RuntimeExceptionRecord, path: RecoveryPath): string {
  return `${exception.payload.kind} classified to ${path}`;
}

function nextAttemptId(attemptId: string | undefined): string | undefined {
  if (!attemptId) return undefined;
  const match = attemptId.match(/^(.*?)(\d+)$/);
  if (!match) return `${attemptId}-retry-2`;
  return `${match[1]}${Number(match[2]) + 1}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for runtime exception controller tests.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/exceptions tests/v2/runtime-exceptions.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: classify runtime exceptions"
```

---

### Task 3: Tork Observer For Queue Timeout And Running Hang

**Files:**
- Create: `src/v2/executor/tork-observer.ts`
- Modify: `src/v2/server/runtime-loops.ts`
- Test: `tests/v2/tork-observer.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing observer tests**

Create `tests/v2/tork-observer.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { observeTorkHandExecutionExceptionsPg } from "../../src/v2/executor/tork-observer.ts";
import { listResourcesPg, upsertRuntimeResourcePg, createWorkflowRunPg, createWorkflowTaskPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("Tork observer records queue timeout and requeue recovery decision", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTask(db, "run-tork-queue-timeout", "task-a", "scheduling", "queued");
    await seedHandExecution(db, {
      runId: "run-tork-queue-timeout",
      taskId: "task-a",
      status: "queued",
      queuedAt: "2026-06-21T10:00:00.000Z",
      queueTimeoutSeconds: 60,
    });

    const result = await observeTorkHandExecutionExceptionsPg(db, {
      now: "2026-06-21T10:01:30.000Z",
    });

    assert.deepEqual(result.observedKinds, ["tork_queue_timeout"]);
    const exceptions = await listResourcesPg(db, { resourceType: "runtime_exception" });
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "tork_queue_timeout");
    const decisions = await listResourcesPg(db, { resourceType: "recovery_decision" });
    assert.equal(decisions[0]?.payload.path, "requeue-hand-execution");
  } finally {
    await db.close();
  }
});

test("Tork observer records running hang and reprovision recovery decision", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTask(db, "run-tork-running-hang", "task-a", "running", "running");
    await seedHandExecution(db, {
      runId: "run-tork-running-hang",
      taskId: "task-a",
      status: "running",
      queuedAt: "2026-06-21T10:00:00.000Z",
      startedAt: "2026-06-21T10:00:20.000Z",
      lastHeartbeatAt: "2026-06-21T10:00:30.000Z",
      heartbeatTimeoutSeconds: 30,
    });

    const result = await observeTorkHandExecutionExceptionsPg(db, {
      now: "2026-06-21T10:01:20.000Z",
    });

    assert.deepEqual(result.observedKinds, ["tork_running_hang"]);
    const exceptions = await listResourcesPg(db, { resourceType: "runtime_exception" });
    assert.equal(exceptions[0]?.payload.kind, "tork_running_hang");
    const decisions = await listResourcesPg(db, { resourceType: "recovery_decision" });
    assert.equal(decisions[0]?.payload.path, "reprovision-hand");
  } finally {
    await db.close();
  }
});

async function seedRunTask(db: any, runId: string, taskId: string, runStatus: string, taskStatus: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: runStatus,
    domain: "software",
    goalPrompt: "observe tork",
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
    status: taskStatus,
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: `session-${taskId}`,
  });
}

async function seedHandExecution(db: any, input: {
  runId: string;
  taskId: string;
  status: string;
  queuedAt: string;
  startedAt?: string;
  lastHeartbeatAt?: string;
  queueTimeoutSeconds?: number;
  heartbeatTimeoutSeconds?: number;
}): Promise<void> {
  const attemptId = "attempt-1";
  const handExecutionId = `hand-execution:${input.runId}:${input.taskId}:${attemptId}`;
  await upsertRuntimeResourcePg(db, {
    id: handExecutionId,
    resourceType: "hand_execution",
    resourceKey: handExecutionId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: `session-${input.taskId}`,
    scope: "hand",
    status: input.status,
    title: "Hand execution",
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: `session-${input.taskId}`,
      attemptId,
      providerId: "tork",
      status: input.status,
      queuedAt: input.queuedAt,
      startedAt: input.startedAt,
      lastHeartbeatAt: input.lastHeartbeatAt,
      queueTimeoutSeconds: input.queueTimeoutSeconds ?? 120,
      heartbeatTimeoutSeconds: input.heartbeatTimeoutSeconds ?? 60,
      externalJobId: `job-${input.taskId}`,
    },
  });
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./tork-observer.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing `src/v2/executor/tork-observer.ts`.

- [ ] **Step 3: Implement Tork observer**

Create `src/v2/executor/tork-observer.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";

type HandExecutionRow = {
  resource_key: string;
  run_id: string;
  task_id: string | null;
  session_id: string | null;
  status: string;
  payload_json: Record<string, unknown>;
};

export type TorkObserverResult = {
  observedKinds: string[];
};

export async function observeTorkHandExecutionExceptionsPg(
  db: SouthstarDb,
  input: { now?: string } = {},
): Promise<TorkObserverResult> {
  const now = new Date(input.now ?? Date.now());
  const controller = createRuntimeExceptionController({ db });
  const rows = await db.query<HandExecutionRow>(
    `select resource_key, run_id, task_id, session_id, status, payload_json
       from southstar.runtime_resources
      where resource_type = 'hand_execution'
        and status in ('queued', 'running')
      order by updated_at, resource_key`,
  );
  const observedKinds: string[] = [];
  for (const row of rows.rows) {
    const payload = row.payload_json;
    const attemptId = stringValue(payload.attemptId);
    const handExecutionId = stringValue(payload.handExecutionId) ?? row.resource_key;
    if (row.status === "queued" && isExpired(payload.queuedAt, payload.queueTimeoutSeconds, now)) {
      const exception = await controller.observe({
        runId: row.run_id,
        taskId: row.task_id ?? undefined,
        sessionId: row.session_id ?? undefined,
        attemptId,
        handExecutionId,
        source: "tork-observer",
        kind: "tork_queue_timeout",
        severity: "recoverable",
        observedAt: now.toISOString(),
        evidenceRefs: [row.resource_key],
        providerEvidence: { externalJobId: stringValue(payload.externalJobId), status: row.status },
      });
      await controller.decide(await controller.classify(exception));
      observedKinds.push("tork_queue_timeout");
    }
    if (row.status === "running" && isExpired(payload.lastHeartbeatAt ?? payload.startedAt, payload.heartbeatTimeoutSeconds, now)) {
      const exception = await controller.observe({
        runId: row.run_id,
        taskId: row.task_id ?? undefined,
        sessionId: row.session_id ?? undefined,
        attemptId,
        handExecutionId,
        source: "tork-observer",
        kind: "tork_running_hang",
        severity: "recoverable",
        observedAt: now.toISOString(),
        evidenceRefs: [row.resource_key],
        providerEvidence: { externalJobId: stringValue(payload.externalJobId), status: row.status },
      });
      await controller.decide(await controller.classify(exception));
      observedKinds.push("tork_running_hang");
    }
  }
  return { observedKinds };
}

function isExpired(anchor: unknown, timeoutSeconds: unknown, now: Date): boolean {
  if (typeof anchor !== "string") return false;
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return false;
  return new Date(anchor).getTime() + timeoutSeconds * 1000 < now.getTime();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

- [ ] **Step 4: Add observer loop**

Modify `src/v2/server/runtime-loops.ts`:

```ts
import { observeTorkHandExecutionExceptionsPg } from "../executor/tork-observer.ts";
```

Add `id: "tork-exception-observer"` to `ManagedRuntimeLoopPlanItem`:

```ts
export type ManagedRuntimeLoopPlanItem = {
  id: "executor-reconciler" | "runnable-task-scheduler" | "recovery-controller" | "tork-exception-observer";
  intervalMs: number;
};
```

Add to `createManagedRuntimeLoopPlan()`:

```ts
{ id: "tork-exception-observer", intervalMs: input.recoveryIntervalMs },
```

Add a controller to `createManagedRuntimeLoopController()`:

```ts
createRuntimeLoopController({
  intervalMs: input.recoveryIntervalMs,
  runOnce: async () => {
    await observeTorkHandExecutionExceptionsPg(input.db);
  },
}),
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for observer tests and managed runtime loop tests.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/executor/tork-observer.ts src/v2/server/runtime-loops.ts tests/v2/tork-observer.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: observe Tork runtime exceptions"
```

---

### Task 4: Scheduler And Callback Route Exceptions Through The Controller

**Files:**
- Modify: `src/v2/scheduler/runnable-task-scheduler.ts`
- Modify: `src/v2/executor/postgres-tork-callback.ts`
- Test: `tests/v2/runnable-task-scheduler.test.ts`
- Test: `tests/v2/tork-callback-managed-state.test.ts`

- [ ] **Step 1: Add failing scheduler submit failure test**

Append to `tests/v2/runnable-task-scheduler.test.ts`:

```ts
test("scheduler records hand submit failure as runtime_exception and recovery decision", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPendingRunWithSingleTask(db, "run-scheduler-submit-exception", "task-a");
    const scheduler = createRunnableTaskScheduler(db, {
      sessionStore: createNoopSessionStore(),
      brainProvider: createFakeBrainProvider(),
      handProvider: {
        providerId: "failing-hand",
        async provision(input) {
          return {
            id: "hand-binding-submit-fail",
            providerId: "failing-hand",
            runId: input.runId,
            taskId: input.taskId,
            handName: input.handName,
            status: "provisioned",
            createdAt: "2026-06-21T10:00:00.000Z",
            payload: {},
          };
        },
        async executeTask() {
          return { ok: false, output: "Tork task execution failed: provider unreachable", metadata: {} };
        },
        async execute() {
          return { ok: false, output: "not used", metadata: {} };
        },
        async snapshot(binding) {
          return { id: "snapshot", handBindingId: binding.id, createdAt: "2026-06-21T10:00:00.000Z", metadata: {} };
        },
        async destroy() {},
        capabilities() {
          return { supportsSnapshot: true, supportsDestroy: true, supportsReprovision: true, keepsCredentialsOutOfSandbox: true };
        },
      },
    });

    await assert.rejects(() => scheduler.runOnce({ runId: "run-scheduler-submit-exception" }), /provider unreachable/);
    const exceptions = await listResourcesPg(db, { resourceType: "runtime_exception" });
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "hand_submit_failed");
    const decisions = await listResourcesPg(db, { resourceType: "recovery_decision" });
    assert.equal(decisions[0]?.payload.path, "reprovision-hand");
  } finally {
    await db.close();
  }
});
```

Add these helpers to the bottom of `tests/v2/runnable-task-scheduler.test.ts` if they are not already present:

```ts
async function seedPendingRunWithSingleTask(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "scheduling",
    domain: "software",
    goalPrompt: "scheduler submit exception",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: runId,
      tasks: [{
        id: taskId,
        title: taskId,
        kind: "implementation",
        dependsOn: [],
        execution: { provider: "tork", timeoutSeconds: 60 },
      }],
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: "pending",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: `session-${taskId}`,
  });
  await upsertRuntimeResourcePg(db, {
    id: `context-${runId}-${taskId}`,
    resourceType: "context_packet",
    resourceKey: `context-${runId}-${taskId}`,
    runId,
    taskId,
    sessionId: `session-${taskId}`,
    scope: "context",
    status: "ready",
    title: "Context packet",
    payload: { id: `context-${runId}-${taskId}` },
  });
}
```

- [ ] **Step 2: Add failing stale callback exception test**

Append to `tests/v2/tork-callback-managed-state.test.ts`:

```ts
test("stale callback records runtime exception and observe-only recovery decision", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-stale-callback-exception", taskId: "task-a", runStatus: "running", taskStatus: "running" });
    await seedHandExecution(db, {
      runId: "run-stale-callback-exception",
      taskId: "task-a",
      sessionId: "session-current",
      attemptId: "attempt-2",
      status: "running",
      queuedAt: "2026-06-21T10:00:00.000Z",
      externalJobId: "job-current",
    });

    const result = await ingestTaskRunResultPg(db, {
      runId: "run-stale-callback-exception",
      taskId: "task-a",
      rootSessionId: "session-old",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "old result" },
      metrics: {},
      events: [],
      receivedAt: "2026-06-21T10:03:00.000Z",
    });

    assert.equal(result.accepted, false);
    const exceptions = await listResourcesPg(db, { resourceType: "runtime_exception" });
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "stale_callback");
    const decisions = await listResourcesPg(db, { resourceType: "recovery_decision" });
    assert.equal(decisions[0]?.payload.path, "none-observe-only");
  });
});
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
npm run test:v2
```

Expected: FAIL because scheduler/callback do not yet record `runtime_exception` for these cases.

- [ ] **Step 4: Wire scheduler failures**

In `src/v2/scheduler/runnable-task-scheduler.ts`, import:

```ts
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";
```

In `markTaskDispatchFailed()`, after `persistHandExecution()` and before appending `hand.execute_failed`, add:

```ts
const controller = createRuntimeExceptionController({ db });
const exception = await controller.observe({
  runId: input.runId,
  taskId: input.taskId,
  sessionId: input.sessionId,
  attemptId: input.attemptId,
  handExecutionId: input.handExecutionId,
  source: "scheduler",
  kind: "hand_submit_failed",
  severity: "recoverable",
  observedAt: new Date().toISOString(),
  evidenceRefs: [input.handExecutionId],
  providerEvidence: { error: input.errorMessage },
});
await controller.decide(await controller.classify(exception));
```

- [ ] **Step 5: Wire stale and terminal callback exceptions**

In `src/v2/executor/postgres-tork-callback.ts`, import:

```ts
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";
```

In the stale callback branch, before returning `{ accepted: false }`, add:

```ts
const controller = createRuntimeExceptionController({ db: tx });
const exception = await controller.observe({
  runId: result.runId,
  taskId: result.taskId,
  sessionId: result.rootSessionId,
  attemptId,
  handExecutionId,
  source: "callback",
  kind: "stale_callback",
  severity: "warning",
  observedAt: result.receivedAt ?? new Date().toISOString(),
  evidenceRefs: [receipt.idempotencyKey],
  providerEvidence: staleAttempt,
});
await controller.decide(await controller.classify(exception));
```

In the terminal callback branch, before returning `{ accepted: false }`, add:

```ts
const controller = createRuntimeExceptionController({ db: tx });
const exception = await controller.observe({
  runId: result.runId,
  taskId: result.taskId,
  sessionId: result.rootSessionId,
  attemptId,
  handExecutionId,
  source: "callback",
  kind: "late_callback",
  severity: "warning",
  observedAt: result.receivedAt ?? new Date().toISOString(),
  evidenceRefs: [receipt.idempotencyKey],
  providerEvidence: { status: task.status },
});
await controller.decide(await controller.classify(exception));
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for scheduler and callback exception tests.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/scheduler/runnable-task-scheduler.ts src/v2/executor/postgres-tork-callback.ts tests/v2/runnable-task-scheduler.test.ts tests/v2/tork-callback-managed-state.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: route runtime failures through exception controller"
```

---

### Task 5: Completion Gate Blocks Unresolved Runtime Exceptions

**Files:**
- Modify: `src/v2/evaluators/completion-gate.ts`
- Test: `tests/v2/completion-gate-exceptions.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing completion gate exception tests**

Create `tests/v2/completion-gate-exceptions.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import { evaluateRunCompletionGatePg } from "../../src/v2/evaluators/completion-gate.ts";
import { recordRuntimeExceptionPg, resolveRuntimeExceptionPg } from "../../src/v2/exceptions/postgres-runtime-exceptions.ts";
import { createWorkflowRunPg, createWorkflowTaskPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("completion gate fails unresolved blocking runtime exceptions", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedCompletedRun(db, "run-gate-blocking-exception");
    const exception = await recordRuntimeExceptionPg(db, {
      runId: "run-gate-blocking-exception",
      taskId: "task-a",
      sessionId: "session-task-a",
      source: "tool-proxy",
      kind: "tool_proxy_violation",
      severity: "blocking",
      status: "blocked",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["tool-call:1"],
    });

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-blocking-exception" });

    assert.equal(result.status, "failed");
    assert.equal(result.findings.some((finding) => finding.includes(exception.resourceKey)), true);
  } finally {
    await db.close();
  }
});

test("completion gate passes after runtime exception is resolved", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedCompletedRun(db, "run-gate-resolved-exception");
    const exception = await recordRuntimeExceptionPg(db, {
      runId: "run-gate-resolved-exception",
      taskId: "task-a",
      sessionId: "session-task-a",
      source: "tork-observer",
      kind: "late_callback",
      severity: "warning",
      status: "observed",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["callback:old"],
    });
    await resolveRuntimeExceptionPg(db, {
      runId: "run-gate-resolved-exception",
      resourceKey: exception.resourceKey,
      resolvedAt: "2026-06-21T10:01:00.000Z",
      reason: "late callback ignored",
    });

    const result = await evaluateRunCompletionGatePg(db, { runId: "run-gate-resolved-exception" });

    assert.deepEqual(result, { runId: "run-gate-resolved-exception", status: "passed", findings: [] });
  } finally {
    await db.close();
  }
});

async function seedCompletedRun(db: any, runId: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "complete with exception gate",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: "task-a",
    runId,
    taskKey: "task-a",
    status: "completed",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-task-a",
  });
  await acceptOrRejectArtifactRefPg(db, {
    runId,
    taskId: "task-a",
    sessionId: "session-task-a",
    attemptId: "attempt-1",
    handExecutionId: `hand-execution:${runId}:task-a:attempt-1`,
    producer: { actorType: "hand", providerId: "tork" },
    artifactType: "implementation_report",
    status: "accepted",
    content: { ok: true },
    contractRefs: ["task:task-a:completion"],
    summary: "done",
  });
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./completion-gate-exceptions.test.ts");
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run test:v2
```

Expected: FAIL because completion gate does not check unresolved runtime exceptions.

- [ ] **Step 3: Modify completion gate**

In `src/v2/evaluators/completion-gate.ts`, import:

```ts
import { listUnresolvedRuntimeExceptionsPg } from "../exceptions/postgres-runtime-exceptions.ts";
```

Before computing final `status`, add:

```ts
const unresolvedExceptions = await listUnresolvedRuntimeExceptionsPg(tx, { runId: input.runId });
for (const exception of unresolvedExceptions) {
  findings.push(`unresolved runtime exception ${exception.resourceKey}: ${exception.payload.kind}`);
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for completion gate exception tests.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/evaluators/completion-gate.ts tests/v2/completion-gate-exceptions.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: block completion on runtime exceptions"
```

---

### Task 6: Tool Proxy Full-Path Enforcement

**Files:**
- Create: `src/v2/tool-proxy/runtime-enforcement.ts`
- Modify: `src/v2/scheduler/runnable-task-scheduler.ts`
- Modify: `src/v2/executor/postgres-tork-callback.ts`
- Test: `tests/v2/tool-proxy-runtime-enforcement.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing enforcement tests**

Create `tests/v2/tool-proxy-runtime-enforcement.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { enforcePreExecutionToolProxyPolicyPg } from "../../src/v2/tool-proxy/runtime-enforcement.ts";
import { listResourcesPg, createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("pre-execution tool proxy enforcement records blocking exception for raw credentials", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-tool-proxy-pre-exec",
      status: "running",
      domain: "software",
      goalPrompt: "enforce tool proxy",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    await assert.rejects(
      () => enforcePreExecutionToolProxyPolicyPg(db, {
        runId: "run-tool-proxy-pre-exec",
        taskId: "task-a",
        sessionId: "session-a",
        handExecutionId: "hand-execution:run-tool-proxy-pre-exec:task-a:attempt-1",
        value: { env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz123456" } },
      }),
      /raw credential payload/i,
    );

    const violations = await listResourcesPg(db, { resourceType: "tool_proxy_violation" });
    assert.equal(violations.length, 1);
    const exceptions = await listResourcesPg(db, { resourceType: "runtime_exception" });
    assert.equal(exceptions[0]?.payload.kind, "tool_proxy_violation");
  } finally {
    await db.close();
  }
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./tool-proxy-runtime-enforcement.test.ts");
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing `runtime-enforcement.ts`.

- [ ] **Step 3: Implement enforcement facade**

Create `src/v2/tool-proxy/runtime-enforcement.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";
import { assertNoRawCredentialPayloadPg } from "./policy-enforcer.ts";

export async function enforcePreExecutionToolProxyPolicyPg(
  db: SouthstarDb,
  input: { runId: string; taskId: string; sessionId: string; handExecutionId: string; value: unknown },
): Promise<void> {
  try {
    await assertNoRawCredentialPayloadPg(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      handExecutionId: input.handExecutionId,
      evidenceRef: `${input.handExecutionId}:pre-execution`,
      value: input.value,
    });
  } catch (error) {
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      handExecutionId: input.handExecutionId,
      source: "tool-proxy",
      kind: "tool_proxy_violation",
      severity: "blocking",
      observedAt: new Date().toISOString(),
      evidenceRefs: [`${input.handExecutionId}:pre-execution`],
      providerEvidence: { error: error instanceof Error ? error.message : String(error) },
    });
    await controller.decide(await controller.classify(exception));
    throw error;
  }
}
```

- [ ] **Step 4: Wire pre-execution enforcement into scheduler**

In `src/v2/scheduler/runnable-task-scheduler.ts`, import:

```ts
import { enforcePreExecutionToolProxyPolicyPg } from "../tool-proxy/runtime-enforcement.ts";
```

Before `deps.handProvider.executeTask(...)`, add:

```ts
await enforcePreExecutionToolProxyPolicyPg(db, {
  runId: input.runId,
  taskId: input.taskId,
  sessionId: input.sessionId,
  handExecutionId,
  value: {
    intent,
    acceptedInputArtifactRefs,
    toolProxyPolicyRef,
    contextPacketId,
  },
});
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for tool proxy runtime enforcement tests.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/tool-proxy/runtime-enforcement.ts src/v2/scheduler/runnable-task-scheduler.ts tests/v2/tool-proxy-runtime-enforcement.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: enforce tool proxy before hand execution"
```

---

### Task 7: Work Item Intake To Run Materialization

**Files:**
- Create: `src/v2/work-items/run-materialization.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/cli.ts`
- Test: `tests/v2/work-item-run-materialization.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing materialization tests**

Create `tests/v2/work-item-run-materialization.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { materializeRunFromWorkItemPg } from "../../src/v2/work-items/run-materialization.ts";
import { getWorkItemPg } from "../../src/v2/work-items/postgres-work-items.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("work item materialization creates work item and run linkage in one path", async () => {
  const db = await createTestPostgresDb();
  try {
    const result = await materializeRunFromWorkItemPg(db, {
      sourceProvider: "api",
      sourceRef: "request-runtime-hardening",
      title: "Harden runtime",
      body: "Implement runtime exception handling.",
      domain: "software",
      runId: "run-from-work-item",
      workflowManifest: { schemaVersion: "southstar.v2", workflowId: "wf-runtime-hardening", tasks: [] },
      executionProjection: { executor: "managed" },
    });

    assert.equal(result.runId, "run-from-work-item");
    assert.equal(result.runAttempt, 1);
    const workItem = await getWorkItemPg(db, result.workItemId);
    assert.equal(workItem?.runRefs[0]?.runId, "run-from-work-item");
    const run = await db.one<{ runtime_context_json: { workItemRef?: { workItemId?: string; runAttempt?: number } } }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      ["run-from-work-item"],
    );
    assert.equal(run.runtime_context_json.workItemRef?.workItemId, result.workItemId);
    assert.equal(run.runtime_context_json.workItemRef?.runAttempt, 1);
  } finally {
    await db.close();
  }
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./work-item-run-materialization.test.ts");
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing `run-materialization.ts`.

- [ ] **Step 3: Implement materialization helper**

Create `src/v2/work-items/run-materialization.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
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
  workflowManifest: Record<string, unknown>;
  executionProjection: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export async function materializeRunFromWorkItemPg(
  db: SouthstarDb,
  input: MaterializeRunFromWorkItemInput,
): Promise<{ workItemId: string; runId: string; runAttempt: number }> {
  return await db.tx(async (tx) => {
    const intake = await intakeWorkItemPg(tx, input);
    await createWorkflowRunPg(tx, {
      id: input.runId,
      status: "created",
      domain: input.domain,
      goalPrompt: input.body,
      workflowManifestJson: JSON.stringify(input.workflowManifest),
      executionProjectionJson: JSON.stringify(input.executionProjection),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });
    const ref = await linkRunAttemptFromWorkItemPg(tx, {
      workItemId: intake.workItemId,
      runId: input.runId,
      statusAtLink: "created",
      reason: "materialized-from-work-item",
    });
    return { workItemId: intake.workItemId, runId: input.runId, runAttempt: ref.runAttempt };
  });
}
```

- [ ] **Step 4: Wire API route**

In `src/v2/server/routes.ts`, add a route:

```ts
if (request.method === "POST" && url.pathname === "/api/v2/work-items/materialize-run") {
  const body = await readJsonBody(request);
  return json("work-item-run-materialization", await materializeRunFromWorkItemPg(context.db, {
    sourceProvider: sourceProviderValue(body.sourceProvider),
    sourceScope: stringOrUndefined(body.sourceScope),
    sourceRef: stringOrUndefined(body.sourceRef),
    sourceUrl: stringOrUndefined(body.sourceUrl),
    title: requiredString(body.title, "title"),
    body: requiredString(body.body, "body"),
    domain: requiredString(body.domain, "domain"),
    runId: requiredString(body.runId, "runId"),
    workflowManifest: recordValue(body.workflowManifest, "workflowManifest"),
    executionProjection: recordValue(body.executionProjection, "executionProjection"),
    metadata: recordOrUndefined(body.metadata),
  }));
}
```

Add these route-local helpers if equivalent helpers do not already exist in `src/v2/server/routes.ts`:

```ts
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return recordValue(value, "metadata");
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for materialization tests and route tests.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/work-items/run-materialization.ts src/v2/server/routes.ts src/v2/cli.ts tests/v2/work-item-run-materialization.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: materialize runs from work items"
```

---

### Task 8: Operator Read Models And Routes For Exceptions

**Files:**
- Modify: `src/v2/read-models/postgres-run-inspection.ts`
- Modify: `src/v2/read-models/managed-agents.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/operator-exception-routes.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing operator route tests**

Create `tests/v2/operator-exception-routes.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { recordRuntimeExceptionPg } from "../../src/v2/exceptions/postgres-runtime-exceptions.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("operator route lists runtime exceptions and recovery decisions for a run", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-operator-exceptions",
      status: "running",
      domain: "software",
      goalPrompt: "inspect exceptions",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await recordRuntimeExceptionPg(db, {
      runId: "run-operator-exceptions",
      taskId: "task-a",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      status: "observed",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["hand-execution:1"],
    });
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/runs/run-operator-exceptions/exceptions`);
      const envelope = await response.json();
      assert.equal(response.status, 200);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.result.exceptions.length, 1);
      assert.equal(envelope.result.exceptions[0].kind, "tork_queue_timeout");
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./operator-exception-routes.test.ts");
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run test:v2
```

Expected: FAIL with 404 for `/api/v2/runs/:runId/exceptions`.

- [ ] **Step 3: Add read-model helper**

In `src/v2/read-models/postgres-run-inspection.ts`, add:

```ts
export async function buildRuntimeExceptionReadModelPg(db: SouthstarDb, input: { runId: string }) {
  const rows = await db.query<{ resource_key: string; status: string; payload_json: Record<string, unknown>; summary_json: Record<string, unknown> }>(
    `select resource_key, status, payload_json, summary_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type in ('runtime_exception', 'recovery_decision')
      order by created_at, resource_key`,
    [input.runId],
  );
  return {
    runId: input.runId,
    exceptions: rows.rows
      .filter((row) => row.resource_key.startsWith("runtime_exception:"))
      .map((row) => ({
        resourceKey: row.resource_key,
        status: row.status,
        kind: row.payload_json.kind,
        severity: row.payload_json.severity,
        source: row.payload_json.source,
        taskId: row.payload_json.taskId,
        handExecutionId: row.payload_json.handExecutionId,
      })),
    recoveryDecisions: rows.rows
      .filter((row) => row.resource_key.startsWith("recovery_decision:"))
      .map((row) => ({
        resourceKey: row.resource_key,
        status: row.status,
        path: row.payload_json.path,
        exceptionId: row.payload_json.exceptionId,
        operatorApprovalRequired: row.payload_json.operatorApprovalRequired,
      })),
  };
}
```

- [ ] **Step 4: Add route**

In `src/v2/server/routes.ts`, add:

```ts
const runExceptionsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/exceptions$/);
if (request.method === "GET" && runExceptionsMatch) {
  return json("runtime-exceptions", await buildRuntimeExceptionReadModelPg(context.db, {
    runId: decodeURIComponent(runExceptionsMatch[1]!),
  }));
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS for operator exception route tests.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/read-models src/v2/server/routes.ts tests/v2/operator-exception-routes.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: expose runtime exception read models"
```

---

### Task 9: Real E2E Case Matrix And Documentation

**Files:**
- Create: `tests/e2e-postgres/cases/14-tork-queue-timeout-recovery.test.ts`
- Create: `tests/e2e-postgres/cases/15-tork-running-hang-recovery.test.ts`
- Create: `tests/e2e-postgres/cases/16-late-callback-superseded-attempt.test.ts`
- Create: `tests/e2e-postgres/cases/17-tool-proxy-runtime-enforcement.test.ts`
- Create: `tests/e2e-postgres/cases/18-work-item-intake-run-execution.test.ts`
- Create: `tests/e2e-postgres/cases/19-completion-gate-unresolved-exception.test.ts`
- Create: `tests/e2e-postgres/cases/20-operator-approved-recovery.test.ts`
- Modify: `package.json`
- Modify: `tests/e2e-postgres/postgres-real-matrix-static.test.ts`
- Modify: `tests/e2e-postgres/README.md`

- [ ] **Step 1: Add package scripts**

Modify `package.json` scripts:

```json
"test:e2e:postgres:14": "tsx tests/e2e-postgres/cases/14-tork-queue-timeout-recovery.test.ts",
"test:e2e:postgres:15": "tsx tests/e2e-postgres/cases/15-tork-running-hang-recovery.test.ts",
"test:e2e:postgres:16": "tsx tests/e2e-postgres/cases/16-late-callback-superseded-attempt.test.ts",
"test:e2e:postgres:17": "tsx tests/e2e-postgres/cases/17-tool-proxy-runtime-enforcement.test.ts",
"test:e2e:postgres:18": "tsx tests/e2e-postgres/cases/18-work-item-intake-run-execution.test.ts",
"test:e2e:postgres:19": "tsx tests/e2e-postgres/cases/19-completion-gate-unresolved-exception.test.ts",
"test:e2e:postgres:20": "tsx tests/e2e-postgres/cases/20-operator-approved-recovery.test.ts"
```

- [ ] **Step 2: Update static matrix test**

Modify `tests/e2e-postgres/postgres-real-matrix-static.test.ts` expected file list to include:

```ts
"14-tork-queue-timeout-recovery.test.ts",
"15-tork-running-hang-recovery.test.ts",
"16-late-callback-superseded-attempt.test.ts",
"17-tool-proxy-runtime-enforcement.test.ts",
"18-work-item-intake-run-execution.test.ts",
"19-completion-gate-unresolved-exception.test.ts",
"20-operator-approved-recovery.test.ts",
```

- [ ] **Step 3: Create real case 14**

Create `tests/e2e-postgres/cases/14-tork-queue-timeout-recovery.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";
import { observeTorkHandExecutionExceptionsPg } from "../../../src/v2/executor/tork-observer.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";

test("14 tork queue timeout recovery: timeout creates runtime exception and requeue decision", async () => {
  const harness = await createInitializedRealPostgresE2E();
  try {
    const runId = "run-e2e-14";
    await seedRunTask(harness.db, runId, "task-a", "scheduling", "queued");
    await upsertRuntimeResourcePg(harness.db, {
      id: `hand-execution:${runId}:task-a:attempt-1`,
      resourceType: "hand_execution",
      resourceKey: `hand-execution:${runId}:task-a:attempt-1`,
      runId,
      taskId: "task-a",
      sessionId: "session-task-a",
      scope: "hand",
      status: "queued",
      title: "Hand execution",
      payload: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId: `hand-execution:${runId}:task-a:attempt-1`,
        runId,
        taskId: "task-a",
        sessionId: "session-task-a",
        attemptId: "attempt-1",
        providerId: "tork",
        status: "queued",
        queuedAt: "2026-06-21T10:00:00.000Z",
        queueTimeoutSeconds: 1,
        heartbeatTimeoutSeconds: 60,
        externalJobId: "job-timeout",
      },
    });

    await observeTorkHandExecutionExceptionsPg(harness.db, { now: "2026-06-21T10:00:03.000Z" });

    const exceptions = await listResourcesPg(harness.db, { resourceType: "runtime_exception" });
    assert.equal(exceptions.some((resource) => resource.payload.kind === "tork_queue_timeout"), true);
    const decisions = await listResourcesPg(harness.db, { resourceType: "recovery_decision" });
    assert.equal(decisions.some((resource) => resource.payload.path === "requeue-hand-execution"), true);
  } finally {
    await harness.close();
  }
});

async function seedRunTask(
  db: SouthstarDb,
  runId: string,
  taskId: string,
  runStatus: string,
  taskStatus: string,
): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: runStatus,
    domain: "software",
    goalPrompt: "observe runtime exception",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: `wf-${runId}`,
      title: "Runtime hardening E2E",
      goalPrompt: "observe runtime exception",
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
          timeoutSeconds: 60,
          infraRetry: { maxAttempts: 1 },
        },
        rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
        skillRefs: ["software.implementation"],
        subagents: [{ id: "impl", harnessId: "codex", prompt: "complete the task", requiredArtifacts: ["implementation_report"] }],
      }],
      harnessDefinitions: [{
        id: "codex",
        kind: "codex",
        entrypoint: "southstar-agent-runner",
        defaultModel: "gpt-5",
        capabilities: [],
      }],
      completion: {
        strategy: "all_tasks_terminal",
        requiredArtifacts: ["implementation_report"],
        evaluators: [],
      },
    }),
    executionProjectionJson: JSON.stringify({ executor: "managed" }),
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: taskStatus,
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: `root-${runId}-${taskId}`,
  });
}
```

- [ ] **Step 4: Create real cases 15-20**

Create each file with `createInitializedRealPostgresE2E()` and local fixture helpers equivalent to `seedRunTask()` above. Each case must call the production function or HTTP route listed below and assert both durable `runtime_resources` state and `workflow_history` evidence.

`tests/e2e-postgres/cases/15-tork-running-hang-recovery.test.ts`:
- Import `observeTorkHandExecutionExceptionsPg` from `src/v2/executor/tork-observer.ts`.
- Seed one `workflow_run` in `running`, one `workflow_task` in `running`, and one `hand_execution` resource with `status: "running"`, `startedAt: "2026-06-21T10:00:00.000Z"`, `lastHeartbeatAt: "2026-06-21T10:00:00.000Z"`, and `heartbeatTimeoutSeconds: 1`.
- Call `observeTorkHandExecutionExceptionsPg(harness.db, { now: "2026-06-21T10:00:03.000Z" })`.
- Assert one `runtime_exception` has `payload.kind === "tork_running_hang"`, one `recovery_decision` has `payload.path === "reprovision-hand"`, and history contains `runtime_exception.detected`.

`tests/e2e-postgres/cases/16-late-callback-superseded-attempt.test.ts`:
- Import `createSouthstarRuntimeServer` from `src/v2/server/http-server.ts`.
- Seed one run with task `task-a`, a superseded `hand_execution` for `attempt-1`, and an active `hand_execution` for `attempt-2`.
- POST to `/api/v2/tork/callback` with `attemptId: "attempt-1"` and a valid artifact payload.
- Assert task status remains the pre-callback status, the active `attempt-2` hand execution remains active, one `runtime_exception` has `payload.kind === "late_callback"`, one `recovery_decision` has `payload.path === "none-observe-only"`, and no accepted `artifact_ref` is created for `attempt-1`.

`tests/e2e-postgres/cases/17-tool-proxy-runtime-enforcement.test.ts`:
- Import `enforcePreExecutionToolProxyPolicyPg` from `src/v2/tool-proxy/runtime-enforcement.ts`.
- Seed run and task state for `task-a`.
- Call `enforcePreExecutionToolProxyPolicyPg(harness.db, { runId, taskId: "task-a", sessionId: "session-task-a", toolName: "shell", argumentsJson: { env: { GITHUB_TOKEN: "plain-secret" } } })`.
- Assert the result is `allowed: false`, one `runtime_exception` has `payload.kind === "tool_proxy_violation"`, one `tool_proxy_audit` resource records `status: "denied"`, and history contains `tool_proxy.denied`.

`tests/e2e-postgres/cases/18-work-item-intake-run-execution.test.ts`:
- Import `materializeRunFromWorkItemPg` from `src/v2/work-items/run-materialization.ts`.
- Import `createSouthstarRuntimeServer` from `src/v2/server/http-server.ts`.
- Create a `work_item` resource with source metadata, goal prompt, and workflow draft content.
- Call `materializeRunFromWorkItemPg(harness.db, { workItemId: "work-item-e2e-18" })`.
- Start the runtime server and POST `/api/v2/runs/{runId}/execute`.
- Assert the created run has `runtime_context_json.workItemRef.id === "work-item-e2e-18"`, the work item status is `materialized`, the execute response status is `scheduling`, and history contains `work_item.materialized` and `run.scheduling_started`.

`tests/e2e-postgres/cases/19-completion-gate-unresolved-exception.test.ts`:
- Import `evaluateRunCompletionGatePg` from `src/v2/completion/run-completion-gate.ts`.
- Seed a run with all tasks terminal and an accepted `artifact_ref`.
- Seed one unresolved blocking `runtime_exception` resource for the same run.
- Call `evaluateRunCompletionGatePg(harness.db, { runId })`.
- Assert the gate returns `complete: false`, includes finding code `blocking_runtime_exception_unresolved`, leaves the run out of `passed`, and records `run.completion_blocked`.

`tests/e2e-postgres/cases/20-operator-approved-recovery.test.ts`:
- Import `createSouthstarRuntimeServer` from `src/v2/server/http-server.ts`.
- Seed a run, task, unresolved blocking `runtime_exception`, and `recovery_decision` with `path: "rollback-workspace"` and `approvalRequired: true`.
- POST `/api/v2/recovery-decisions/{decisionId}/approve` with operator metadata.
- Assert the decision status becomes `approved`, the exception remains traceable by `runtimeExceptionId`, and history contains `recovery_decision.approved`.

- [ ] **Step 5: Update README**

Modify `tests/e2e-postgres/README.md` implemented case order to include:

```bash
npm run test:e2e:postgres:10   # managed brain crash wake
npm run test:e2e:postgres:11   # managed hand reprovision
npm run test:e2e:postgres:12   # managed credential isolation
npm run test:e2e:postgres:13   # managed per-task Tork runtime
npm run test:e2e:postgres:14   # Tork queue timeout recovery
npm run test:e2e:postgres:15   # Tork running hang heartbeat recovery
npm run test:e2e:postgres:16   # late callback from superseded attempt
npm run test:e2e:postgres:17   # tool proxy runtime enforcement
npm run test:e2e:postgres:18   # work item intake to run execution
npm run test:e2e:postgres:19   # completion gate blocks unresolved exception
npm run test:e2e:postgres:20   # operator-approved recovery path
```

- [ ] **Step 6: Run static E2E matrix**

Run:

```bash
/home/timmypai/apps/southstar/node_modules/.bin/tsx --test tests/e2e-postgres/postgres-real-matrix-static.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run focused real cases when infrastructure is available**

Run one at a time:

```bash
npm run test:e2e:postgres:14
npm run test:e2e:postgres:15
npm run test:e2e:postgres:16
npm run test:e2e:postgres:17
npm run test:e2e:postgres:18
npm run test:e2e:postgres:19
npm run test:e2e:postgres:20
```

Expected: PASS when `SOUTHSTAR_TEST_ADMIN_DATABASE_URL`, `TORK_BASE_URL`, and required Pi harness/SDK env are available. If infra is missing, the cases must fail closed with explicit missing env, not skip.

- [ ] **Step 8: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add package.json tests/e2e-postgres
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover runtime hardening e2e cases"
```

---

### Task 10: Final Verification And Integration

**Files:**
- Verify all modified source, tests, docs.

- [ ] **Step 1: Run root tests**

```bash
npm test
```

Expected: PASS with all root-index tests.

- [ ] **Step 2: Run V2 tests**

```bash
npm run test:v2
```

Expected: PASS when `SOUTHSTAR_TEST_ADMIN_DATABASE_URL` is set. If env is missing, record the exact fail-closed message and run focused non-DB tests that do not require external Postgres.

- [ ] **Step 3: Run TypeScript**

```bash
node_modules/.bin/tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 4: Run web build**

```bash
npm run web:build
```

Expected: exit 0 and static route generation succeeds.

- [ ] **Step 5: Run static Postgres E2E boundary**

```bash
/home/timmypai/apps/southstar/node_modules/.bin/tsx --test tests/e2e-postgres/postgres-real-matrix-static.test.ts
```

Expected: PASS.

- [ ] **Step 6: Clean generated files**

```bash
rm -f tsconfig.tsbuildinfo
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar diff -- next-env.d.ts
```

Expected: no `next-env.d.ts` diff unless the project intentionally changed its Next type mode.

- [ ] **Step 7: Final status**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short --branch --untracked-files=all
```

Expected: clean working tree after all task commits.

---

## Self-Review Checklist

Spec coverage:

- Runtime lifecycle hardening: Tasks 3, 4, 5, 8, 9.
- Central runtime exception handling: Tasks 1, 2, 4, 5.
- Tork queue timeout and running hang: Tasks 3 and 9.
- Tool proxy full-path enforcement: Task 6 and case 17.
- Work item intake end-to-end: Task 7 and case 18.
- Completion gate unresolved exception blocking: Task 5 and case 19.
- Operator read model/recovery path: Task 8 and case 20.
- Real E2E matrix: Task 9.

No legacy reintroduction:

- Do not restore `src/runtime/*`.
- Do not restore `src/orchestrator/*`.
- Do not use SQLite or V1 Northstar lifecycle state.

Verification:

- Every task has a failing test step before implementation.
- Every task has a passing test step and commit step.
- Final task includes root test, V2 test, typecheck, web build, and static Postgres E2E boundary.
