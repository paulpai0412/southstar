# Southstar Runtime API P0 Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the P0 Runtime API gaps from the 2026-06-23 API completeness work by adding executor job action/cancel APIs and aligning the runtime client with existing operator routes.

**Architecture:** Extend the existing `/api/v2/runs/:runId/executor-jobs` resource namespace instead of adding a new control plane. Mutable executor job actions reuse `RuntimeCommandRequest`, `RuntimeCommandResult`, `recordRuntimeCommandPg()`, existing execution projection helpers, and durable Postgres history/resources. Client work remains a thin URL/body wrapper over implemented server routes.

**Tech Stack:** TypeScript, Node 22 `node:test`, Southstar v2 runtime server, Postgres-backed runtime store, existing `RuntimeCommand` contract, existing `createRuntimeServerClient()`, real Postgres E2E case 27.

---

## Source Spec

- Design: `docs/superpowers/specs/2026-06-23-southstar-runtime-api-p0-gap-closure-design.md`
- Prior API design: `docs/superpowers/specs/2026-06-23-southstar-api-completeness-for-runtime-control-plane-design.zh.md`
- Existing execution route: `src/v2/server/execution-routes.ts`
- Existing runtime client: `src/v2/server/client.ts`
- Runtime command helper: `src/v2/ui-api/commands/runtime-command.ts`
- Current route tests: `tests/v2/execution-routes.test.ts`
- Current client alignment tests: `tests/v2/runtime-api-client-alignment.test.ts`
- Current API E2E: `tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts`

## File Structure

- Modify `src/v2/server/execution-routes.ts`
  - Add job action availability.
  - Add job cancel command handling.
  - Reuse existing execution projection lookup.
  - Keep response envelope style local to this route module.
- Modify `src/v2/server/client.ts`
  - Add thin typed methods for executor job actions/reconcile/cancel.
  - Add thin typed methods for recovery decision approval/apply.
  - Add thin typed methods for runtime health/loops/tick/wake.
- Modify `tests/v2/execution-routes.test.ts`
  - Add failing tests for job actions and cancel command semantics.
  - Add client URL/body assertions for executor job methods.
- Modify `tests/v2/runtime-api-client-alignment.test.ts`
  - Add missing P0 operator methods to the method-presence assertion.
  - Add URL/body assertions for runtime and recovery methods.
- Modify `tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts`
  - Add API-level executor job cancel coverage.

## Execution Notes

- Run all commands from `/home/timmypai/apps/southstar`.
- This checkout uses `.git-local`; commit commands use:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar
```

- Ignore the existing untracked `tsconfig.tsbuildinfo`; do not add it.
- Postgres-backed tests require `SOUTHSTAR_TEST_ADMIN_DATABASE_URL`.

## Task 1: Executor Job Actions And Cancel Route Tests

**Files:**
- Modify: `tests/v2/execution-routes.test.ts`

- [ ] **Step 1: Write the failing route test imports**

Update the import from `../../src/v2/stores/postgres-runtime-store.ts` near the top of `tests/v2/execution-routes.test.ts`:

```ts
import {
  createWorkflowRunPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
```

- [ ] **Step 2: Add failing tests for executor job actions and cancel**

Append this test after the existing `"execution routes normalize hand_execution and executor_binding"` test and before `readEnvelope()`:

```ts
test("executor job actions and cancel route write durable runtime command evidence", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-executor-job-cancel-api";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "cancel executor job",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "hand_execution",
      resourceKey: `hand-execution:${runId}:task-hand:attempt-1`,
      runId,
      taskId: "task-hand",
      sessionId: "session-hand",
      scope: "hand",
      status: "running",
      payload: {
        providerId: "tork",
        attemptId: "attempt-1",
        externalJobId: "job-hand-cancel",
        status: "running",
      },
      summary: { status: "running" },
    });
    const binding = await createExecutorBindingPg(db, {
      runId,
      taskId: "task-binding",
      attemptId: "attempt-1",
      torkJobId: "job-binding-cancel",
      status: "queued",
      now: "2026-06-23T09:59:00.000Z",
      queueTimeoutSeconds: 300,
      hardTimeoutSeconds: 600,
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "executor-binding-terminal",
      runId,
      taskId: "task-terminal",
      scope: "executor",
      status: "completed",
      payload: {
        executorType: "tork",
        attemptId: "attempt-terminal",
        torkJobId: "job-terminal-cancel",
        status: "completed",
      },
      summary: { status: "completed" },
    });

    const actionEnvelope = await call<{ actions: Array<{ action: string; allowed: boolean; endpoint?: string }> }>(
      `/api/v2/runs/${runId}/executor-jobs/job-hand-cancel/actions`,
    );
    assert.equal(actionEnvelope.kind, "executor-job-actions");
    assert.equal(actionEnvelope.result.actions.some((action) => action.action === "cancel" && action.allowed), true);
    assert.equal(actionEnvelope.result.actions.some((action) => action.action === "reconcile" && !action.allowed), true);

    const dryRun = await post<{ status: string; resourceRefs: unknown[]; eventRefs: unknown[] }>(
      `/api/v2/runs/${runId}/executor-jobs/job-hand-cancel/cancel`,
      {
        commandId: "cmd-job-cancel-dry-run",
        actor: { type: "user", id: "operator-a" },
        reason: "preview job cancel",
        dryRun: true,
      },
    );
    assert.equal(dryRun.result.status, "noop");
    assert.deepEqual(dryRun.result.resourceRefs, []);
    assert.deepEqual(dryRun.result.eventRefs, []);
    assert.equal((await getResourceByKeyPg(db, "hand_execution", `hand-execution:${runId}:task-hand:attempt-1`))?.status, "running");

    const cancelHand = await post<{
      commandId: string;
      status: string;
      affectedRunId?: string;
      affectedTaskId?: string;
      affectedSessionId?: string;
      resourceRefs: Array<{ resourceType: string; resourceKey: string }>;
      eventRefs: Array<{ eventType: string }>;
      nextSuggestedActions: string[];
    }>(`/api/v2/runs/${runId}/executor-jobs/job-hand-cancel/cancel`, {
      commandId: "cmd-job-cancel-hand",
      actor: { type: "user", id: "operator-a" },
      reason: "operator cancels active hand job",
    });
    assert.equal(cancelHand.result.commandId, "cmd-job-cancel-hand");
    assert.equal(cancelHand.result.status, "applied");
    assert.equal(cancelHand.result.affectedRunId, runId);
    assert.equal(cancelHand.result.affectedTaskId, "task-hand");
    assert.equal(cancelHand.result.affectedSessionId, "session-hand");
    assert.deepEqual(cancelHand.result.nextSuggestedActions, ["reconcile-executor-job", "watch-events"]);
    assert.equal(cancelHand.result.resourceRefs.some((ref) => ref.resourceType === "hand_execution"), true);
    assert.deepEqual(cancelHand.result.eventRefs.map((event) => event.eventType), [
      "run.command_requested",
      "executor_job.cancel_requested",
    ]);

    const replayHand = await post<typeof cancelHand.result>(`/api/v2/runs/${runId}/executor-jobs/job-hand-cancel/cancel`, {
      commandId: "cmd-job-cancel-hand",
      actor: { type: "user", id: "operator-a" },
      reason: "operator cancels active hand job",
    });
    assert.deepEqual(replayHand.result, cancelHand.result);

    const handResource = await getResourceByKeyPg(db, "hand_execution", `hand-execution:${runId}:task-hand:attempt-1`);
    assert.equal(handResource?.status, "cancel_requested");
    assert.equal((handResource?.payload as { status?: string }).status, "cancel_requested");
    assert.equal((handResource?.summary as { status?: string }).status, "cancel_requested");

    const cancelBinding = await post<{ status: string }>(`/api/v2/runs/${runId}/executor-jobs/job-binding-cancel/cancel`, {
      commandId: "cmd-job-cancel-binding",
      actor: { type: "user", id: "operator-a" },
      reason: "operator cancels active binding job",
    });
    assert.equal(cancelBinding.result.status, "applied");
    const bindingResource = await getResourceByKeyPg(db, "executor_binding", binding.id);
    assert.equal(bindingResource?.status, "cancel_requested");
    assert.equal((bindingResource?.payload as { status?: string }).status, "cancel_requested");
    assert.equal((bindingResource?.payload as { southstarExecutorStatus?: string }).southstarExecutorStatus, "cancel_requested");
    assert.equal((bindingResource?.summary as { status?: string }).status, "cancel_requested");

    const terminal = await post<{ status: string; message?: string }>(
      `/api/v2/runs/${runId}/executor-jobs/job-terminal-cancel/cancel`,
      {
        commandId: "cmd-job-cancel-terminal",
        actor: { type: "user", id: "operator-a" },
        reason: "terminal job should not mutate",
      },
    );
    assert.equal(terminal.result.status, "noop");
    assert.match(terminal.result.message ?? "", /terminal/);
    assert.equal((await getResourceByKeyPg(db, "executor_binding", "executor-binding-terminal"))?.status, "completed");

    const missing = await route(`/api/v2/runs/${runId}/executor-jobs/missing-job/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-job-cancel-missing",
        actor: { type: "user", id: "operator-a" },
        reason: "missing job",
      }),
    });
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /execution not found/);
    assert.equal((await getResourceByKeyPg(db, "runtime_command", "cmd-job-cancel-missing")), null);

    const commandResources = (await listResourcesPg(db, { resourceType: "runtime_command" }))
      .filter((resource) => resource.runId === runId)
      .map((resource) => resource.resourceKey)
      .sort();
    assert.deepEqual(commandResources, [
      "cmd-job-cancel-binding",
      "cmd-job-cancel-hand",
      "cmd-job-cancel-terminal",
    ]);
    const historyTypes = (await listHistoryForRunPg(db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.filter((eventType) => eventType === "executor_job.cancel_requested").length, 2);

    async function call<T>(path: string): Promise<{ ok: true; kind: string; result: T }> {
      const envelope = await readEnvelope<T>(await route(path));
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }

    async function post<T>(path: string, body: unknown): Promise<{ ok: true; kind: string; result: T }> {
      const envelope = await readEnvelope<T>(await route(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }

    async function route(path: string, init?: RequestInit): Promise<Response> {
      return await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      }, new Request(`http://127.0.0.1${path}`, init));
    }
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
node_modules/.bin/tsx tests/v2/execution-routes.test.ts
```

Expected: FAIL with `not found` or `execution not found` for `/executor-jobs/:jobId/actions` or `/cancel`, because the routes are not implemented yet.

- [ ] **Step 4: Commit the failing test**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add tests/v2/execution-routes.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover executor job cancel api gap"
```

## Task 2: Executor Job Actions And Cancel Route Implementation

**Files:**
- Modify: `src/v2/server/execution-routes.ts`
- Test: `tests/v2/execution-routes.test.ts`

- [ ] **Step 1: Add route imports and status constants**

Modify the top of `src/v2/server/execution-routes.ts` to include runtime command helpers:

```ts
import { reconcileExecutorBindingsPg } from "../executor/postgres-reconciler.ts";
import { getExecutionProjectionByExternalJobIdPg, getExecutionProjectionPg, listExecutionProjectionsPg, type ExecutionProjection } from "../read-models/executions.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  recordRuntimeCommandPg,
  requireRuntimeCommandRequest,
  type RuntimeCommandRequest,
  type RuntimeCommandResult,
} from "../ui-api/commands/runtime-command.ts";

const ACTIVE_EXECUTION_STATUSES = new Set([
  "submitted",
  "queued",
  "starting",
  "running",
  "heartbeat-lost",
  "queue-timeout",
  "hard-timeout",
  "callback-missing",
  "orphaned",
]);
const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "failed", "cancelled", "lost", "superseded", "cancel_requested"]);
```

- [ ] **Step 2: Add action and cancel route branches**

Inside `handleExecutionRoute()`, insert these branches after the detail route and before the reconcile route:

```ts
  const actionsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/executor-jobs\/([^/]+)\/actions$/);
  if (request.method === "GET" && actionsMatch) {
    const runId = decodeURIComponent(actionsMatch[1]!);
    const jobId = decodeURIComponent(actionsMatch[2]!);
    const execution = await getExecutionProjectionByExternalJobIdPg(context.db, { runId, jobId });
    if (!execution) throw new Error(`execution not found: ${jobId}`);
    return json("executor-job-actions", {
      runId,
      jobId,
      executionId: execution.executionId,
      status: execution.status,
      rawStatus: execution.rawStatus,
      actions: executorJobActions(context, runId, jobId, execution),
    });
  }

  const cancelMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/executor-jobs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const runId = decodeURIComponent(cancelMatch[1]!);
    const jobId = decodeURIComponent(cancelMatch[2]!);
    const command = requireRuntimeCommandRequest(await request.json());
    return json("runtime-command", await cancelExecutorJobPg(context.db, { runId, jobId, command }));
  }
```

- [ ] **Step 3: Add action availability helpers**

In `src/v2/server/execution-routes.ts`, insert these helpers immediately before the existing `function json<T>(kind: string, result: T): Response` declaration:

```ts
function executorJobActions(
  context: RuntimeServerContext,
  runId: string,
  jobId: string,
  execution: ExecutionProjection,
): Array<{ action: "cancel" | "reconcile"; allowed: boolean; reason?: string; endpoint: string }> {
  const cancelAllowed = isExecutionCancelAllowed(execution.rawStatus);
  const canReconcile = Boolean(context.torkObservationClient && execution.externalJobId);
  return [
    {
      action: "cancel",
      allowed: cancelAllowed.allowed,
      ...(cancelAllowed.reason ? { reason: cancelAllowed.reason } : {}),
      endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(jobId)}/cancel`,
    },
    {
      action: "reconcile",
      allowed: canReconcile,
      ...(canReconcile ? {} : { reason: context.torkObservationClient ? "execution has no external job id" : "torkObservationClient is not configured" }),
      endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(jobId)}/reconcile`,
    },
  ];
}

function isExecutionCancelAllowed(rawStatus: string): { allowed: boolean; reason?: string } {
  if (ACTIVE_EXECUTION_STATUSES.has(rawStatus)) return { allowed: true };
  if (TERMINAL_EXECUTION_STATUSES.has(rawStatus)) return { allowed: false, reason: `execution cannot cancel from terminal status ${rawStatus}` };
  return { allowed: false, reason: `execution cannot cancel from status ${rawStatus}` };
}
```

- [ ] **Step 4: Add cancel command implementation**

In `src/v2/server/execution-routes.ts`, insert these helpers immediately before the `function executorJobActions(...)` helper added in Step 3:

```ts
async function cancelExecutorJobPg(
  db: SouthstarDb,
  input: { runId: string; jobId: string; command: RuntimeCommandRequest },
): Promise<RuntimeCommandResult> {
  const execution = await getExecutionProjectionByExternalJobIdPg(db, { runId: input.runId, jobId: input.jobId });
  if (!execution) throw new Error(`execution not found: ${input.jobId}`);

  const allowed = isExecutionCancelAllowed(execution.rawStatus);
  if (input.command.dryRun) {
    return {
      commandId: input.command.commandId,
      accepted: allowed.allowed,
      status: allowed.allowed ? "noop" : "blocked",
      affectedRunId: input.runId,
      ...(execution.taskId ? { affectedTaskId: execution.taskId } : {}),
      ...(execution.sessionId ? { affectedSessionId: execution.sessionId } : {}),
      resourceRefs: [],
      eventRefs: [],
      nextSuggestedActions: allowed.allowed ? ["cancel-executor-job"] : [],
      message: allowed.allowed ? "dry run: executor job cancel would be requested" : allowed.reason,
    };
  }

  if (!allowed.allowed) {
    return await recordRuntimeCommandPg(db, {
      commandId: input.command.commandId,
      runId: input.runId,
      taskId: execution.taskId,
      sessionId: execution.sessionId,
      action: "executor_job.cancel",
      actor: input.command.actor,
      reason: input.command.reason,
      status: "noop",
      resourceRefs: [{ resourceType: execution.kind, resourceKey: execution.executionId }],
      eventType: "executor_job.cancel_noop",
      eventPayload: {
        jobId: input.jobId,
        executionId: execution.executionId,
        rawStatus: execution.rawStatus,
        reason: allowed.reason,
      },
      nextSuggestedActions: ["watch-events"],
      message: allowed.reason ?? `execution cannot cancel from status ${execution.rawStatus}`,
    });
  }

  return await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [`executor-job-cancel:${input.command.commandId}`]);
    const freshExecution = await getExecutionProjectionByExternalJobIdPg(tx, { runId: input.runId, jobId: input.jobId });
    if (!freshExecution) throw new Error(`execution not found: ${input.jobId}`);
    const freshAllowed = isExecutionCancelAllowed(freshExecution.rawStatus);
    if (!freshAllowed.allowed) {
      return await recordRuntimeCommandPg(tx, {
        commandId: input.command.commandId,
        runId: input.runId,
        taskId: freshExecution.taskId,
        sessionId: freshExecution.sessionId,
        action: "executor_job.cancel",
        actor: input.command.actor,
        reason: input.command.reason,
        status: "noop",
        resourceRefs: [{ resourceType: freshExecution.kind, resourceKey: freshExecution.executionId }],
        eventType: "executor_job.cancel_noop",
        eventPayload: {
          jobId: input.jobId,
          executionId: freshExecution.executionId,
          rawStatus: freshExecution.rawStatus,
          reason: freshAllowed.reason,
        },
        nextSuggestedActions: ["watch-events"],
        message: freshAllowed.reason ?? `execution cannot cancel from status ${freshExecution.rawStatus}`,
      });
    }

    await markExecutionCancelRequestedPg(tx, freshExecution);
    return await recordRuntimeCommandPg(tx, {
      commandId: input.command.commandId,
      runId: input.runId,
      taskId: freshExecution.taskId,
      sessionId: freshExecution.sessionId,
      action: "executor_job.cancel",
      actor: input.command.actor,
      reason: input.command.reason,
      status: "applied",
      resourceRefs: [{ resourceType: freshExecution.kind, resourceKey: freshExecution.executionId }],
      eventType: "executor_job.cancel_requested",
      eventPayload: {
        jobId: input.jobId,
        executionId: freshExecution.executionId,
        externalJobId: freshExecution.externalJobId,
        fromStatus: freshExecution.rawStatus,
        toStatus: "cancel_requested",
      },
      nextSuggestedActions: ["reconcile-executor-job", "watch-events"],
    });
  });
}

async function markExecutionCancelRequestedPg(db: SouthstarDb, execution: ExecutionProjection): Promise<void> {
  const result = await db.query<{ resource_key: string }>(
    `update southstar.runtime_resources
        set status = 'cancel_requested',
            payload_json = case
              when resource_type = 'executor_binding' then
                jsonb_set(
                  jsonb_set(coalesce(payload_json, '{}'::jsonb), '{status}', to_jsonb('cancel_requested'::text), true),
                  '{southstarExecutorStatus}', to_jsonb('cancel_requested'::text), true
                )
              else jsonb_set(coalesce(payload_json, '{}'::jsonb), '{status}', to_jsonb('cancel_requested'::text), true)
            end,
            summary_json = jsonb_set(coalesce(summary_json, '{}'::jsonb), '{status}', to_jsonb('cancel_requested'::text), true),
            updated_at = now()
      where run_id = $1
        and resource_type = $2
        and resource_key = $3
        and status = any($4::text[])
      returning resource_key`,
    [execution.runId, execution.kind, execution.executionId, [...ACTIVE_EXECUTION_STATUSES]],
  );
  if (!result.rows[0]) throw new Error(`execution is no longer cancellable: ${execution.executionId}`);
}
```

- [ ] **Step 5: Run the route test to verify it passes**

Run:

```bash
node_modules/.bin/tsx tests/v2/execution-routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit route implementation**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/execution-routes.ts tests/v2/execution-routes.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add executor job cancel api"
```

## Task 3: Runtime Client Operator Method Alignment

**Files:**
- Modify: `src/v2/server/client.ts`
- Modify: `tests/v2/runtime-api-client-alignment.test.ts`
- Modify: `tests/v2/execution-routes.test.ts`

- [ ] **Step 1: Write failing client method presence test**

Update the `methods` array in `tests/v2/runtime-api-client-alignment.test.ts`:

```ts
  const methods = [
    "pauseRun",
    "resumeRun",
    "cancelRun",
    "getRunActions",
    "getSessionEvents",
    "getSessionCheckpoints",
    "getSessionCheckpoint",
    "getSessionLineage",
    "listMemoryDeltas",
    "approveMemoryDelta",
    "rejectMemoryDelta",
    "invalidateRunMemory",
    "listExecutions",
    "getExecution",
    "getExecutorJobActions",
    "reconcileExecutorJob",
    "cancelExecutorJob",
    "approveRecoveryDecision",
    "applyRecoveryDecision",
    "getRuntimeHealth",
    "getRuntimeLoops",
    "tickRuntimeLoop",
    "wakeRuntime",
    "getTaskActions",
    "retryTask",
    "resetTaskSession",
  ] as const;
```

- [ ] **Step 2: Add failing URL/body tests for operator client methods**

Append this test to `tests/v2/runtime-api-client-alignment.test.ts`:

```ts
test("runtime server client exposes operator route URLs and bodies", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ ok: true, kind: "test", result: {} }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = createRuntimeServerClient({ baseUrl: "http://127.0.0.1/" });
    await client.getExecutorJobActions({ runId: "run/a", jobId: "job/a" });
    await client.reconcileExecutorJob({ runId: "run/a", jobId: "job/a" });
    await client.cancelExecutorJob({
      runId: "run/a",
      jobId: "job/a",
      commandId: "cmd/a",
      actor: { type: "user", id: "operator-a" },
      reason: "cancel job",
      payload: { source: "test" },
    });
    await client.approveRecoveryDecision({
      runId: "run/a",
      decisionId: "decision/a",
      decision: "approved",
      reason: "safe",
    });
    await client.applyRecoveryDecision({ runId: "run/a", decisionId: "decision/a" });
    await client.getRuntimeHealth();
    await client.getRuntimeLoops();
    await client.tickRuntimeLoop({ loopId: "runnable-task-scheduler" });
    await client.wakeRuntime({ runId: "run/a", taskId: "task/a" });

    assert.deepEqual(calls, [
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/executor-jobs/job%2Fa/actions", method: undefined, body: undefined },
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/executor-jobs/job%2Fa/reconcile", method: "POST", body: {} },
      {
        url: "http://127.0.0.1/api/v2/runs/run%2Fa/executor-jobs/job%2Fa/cancel",
        method: "POST",
        body: {
          commandId: "cmd/a",
          actor: { type: "user", id: "operator-a" },
          reason: "cancel job",
          payload: { source: "test" },
        },
      },
      {
        url: "http://127.0.0.1/api/v2/runs/run%2Fa/recovery-decisions/decision%2Fa/approval",
        method: "POST",
        body: { decision: "approved", reason: "safe" },
      },
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/recovery-decisions/decision%2Fa/apply", method: "POST", body: {} },
      { url: "http://127.0.0.1/api/v2/runtime/health", method: undefined, body: undefined },
      { url: "http://127.0.0.1/api/v2/runtime/loops", method: undefined, body: undefined },
      { url: "http://127.0.0.1/api/v2/runtime/loops/runnable-task-scheduler/tick", method: "POST", body: {} },
      { url: "http://127.0.0.1/api/v2/runtime/wake", method: "POST", body: { runId: "run/a", taskId: "task/a" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 3: Run client tests to verify they fail**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-api-client-alignment.test.ts
```

Expected: FAIL because the new client methods are not defined.

- [ ] **Step 4: Add client types and methods**

Modify `src/v2/server/client.ts`.

Add this type after `SearchMemoryRequest`:

```ts
type RuntimeLoopId =
  | "executor-reconciler"
  | "runnable-task-scheduler"
  | "recovery-controller"
  | "tork-exception-observer"
  | "recovery-decision-applier";
```

Add these methods after `getExecution()`:

```ts
    getExecutorJobActions(body: { runId: string; jobId: string }) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/executor-jobs/${encodeURIComponent(body.jobId)}/actions`);
    },
    reconcileExecutorJob(body: { runId: string; jobId: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/executor-jobs/${encodeURIComponent(body.jobId)}/reconcile`, {});
    },
    cancelExecutorJob(body: RuntimeCommandRequest & { runId: string; jobId: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/executor-jobs/${encodeURIComponent(body.jobId)}/cancel`, runtimeCommandBody(body));
    },
```

Add these methods after `decideApproval()`:

```ts
    approveRecoveryDecision(body: { runId: string; decisionId: string; decision: "approved" | "rejected"; reason: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/recovery-decisions/${encodeURIComponent(body.decisionId)}/approval`, {
        decision: body.decision,
        reason: body.reason,
      });
    },
    applyRecoveryDecision(body: { runId: string; decisionId: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/recovery-decisions/${encodeURIComponent(body.decisionId)}/apply`, {});
    },
```

Add these methods before `submitTorkCallback()`:

```ts
    getRuntimeHealth() {
      return get(`${baseUrl}/api/v2/runtime/health`);
    },
    getRuntimeLoops() {
      return get(`${baseUrl}/api/v2/runtime/loops`);
    },
    tickRuntimeLoop(body: { loopId: RuntimeLoopId }) {
      return post(`${baseUrl}/api/v2/runtime/loops/${encodeURIComponent(body.loopId)}/tick`, {});
    },
    wakeRuntime(body: { runId?: string; taskId?: string } = {}) {
      return post(`${baseUrl}/api/v2/runtime/wake`, body);
    },
```

- [ ] **Step 5: Update execution client URL test**

In `tests/v2/execution-routes.test.ts`, update the `"runtime server client exposes execution projection API URLs"` test to include the new executor job methods:

```ts
    await client.listExecutions("run/a");
    await client.getExecution({ runId: "run/a", executionId: "hand-execution:run/a:task/a:attempt/1" });
    await client.getExecutorJobActions({ runId: "run/a", jobId: "job/a" });
    await client.reconcileExecutorJob({ runId: "run/a", jobId: "job/a" });
    await client.cancelExecutorJob({
      runId: "run/a",
      jobId: "job/a",
      commandId: "cmd/a",
      actor: { type: "user", id: "operator-a" },
      reason: "cancel job",
    });

    assert.deepEqual(calls, [
      "http://127.0.0.1/api/v2/runs/run%2Fa/hand-executions",
      "http://127.0.0.1/api/v2/runs/run%2Fa/hand-executions/hand-execution%3Arun%2Fa%3Atask%2Fa%3Aattempt%2F1",
      "http://127.0.0.1/api/v2/runs/run%2Fa/executor-jobs/job%2Fa/actions",
      "http://127.0.0.1/api/v2/runs/run%2Fa/executor-jobs/job%2Fa/reconcile",
      "http://127.0.0.1/api/v2/runs/run%2Fa/executor-jobs/job%2Fa/cancel",
    ]);
```

- [ ] **Step 6: Run client and execution tests**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-api-client-alignment.test.ts
node_modules/.bin/tsx tests/v2/execution-routes.test.ts
```

Expected: both PASS.

- [ ] **Step 7: Commit client alignment**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/client.ts tests/v2/runtime-api-client-alignment.test.ts tests/v2/execution-routes.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: align runtime client operator methods"
```

## Task 4: API E2E Case 27 Executor Job Cancel Coverage

**Files:**
- Modify: `tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts`

- [ ] **Step 1: Update store imports for E2E evidence checks**

Modify the import from `../../../src/v2/stores/postgres-runtime-store.ts`:

```ts
import {
  appendHistoryEventPg,
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
```

- [ ] **Step 2: Add failing E2E assertions after execution list checks**

In `tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts`, after the `handExecutions` assertion, insert:

```ts
    const jobActions = await api<{
      actions: Array<{ action: string; allowed: boolean }>;
    }>(server.url, `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(externalJobId)}/actions`);
    assert.equal(jobActions.actions.some((action) => action.action === "cancel" && action.allowed), true);

    const jobCancel = await api<{
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
          reason: "case 27 cancels a seeded executor job through runtime API",
        }),
      },
    );
    assert.equal(jobCancel.commandId, "cmd-runtime-api-completeness-job-cancel");
    assert.equal(jobCancel.status, "applied");
    assert.equal(jobCancel.resourceRefs.some((ref) => ref.resourceType === "hand_execution"), true);
    assert.equal(jobCancel.eventRefs.some((event) => event.eventType === "executor_job.cancel_requested"), true);

    const cancelledExecutions = await api<{
      data: { executions: Array<{ externalJobId?: string; rawStatus?: string }> };
    }>(server.url, `/api/v2/read-models/executions/${encodeURIComponent(runId)}`);
    const cancelledExecution = cancelledExecutions.data.executions.find((execution) => execution.externalJobId === externalJobId);
    assert.equal(cancelledExecution?.rawStatus, "cancel_requested");

    const commandResource = await getResourceByKeyPg(env.db, "runtime_command", "cmd-runtime-api-completeness-job-cancel");
    assert.ok(commandResource);
    const historyAfterCancel = await listHistoryForRunPg(env.db, runId);
    assert.equal(historyAfterCancel.some((event) => event.eventType === "executor_job.cancel_requested"), true);
```

- [ ] **Step 3: Run E2E case to verify it fails before implementation or passes after Tasks 1-3**

Run:

```bash
npm run test:e2e:postgres:27
```

Expected before Tasks 1-3: FAIL because executor job actions/cancel routes are missing. Expected after Tasks 1-3: PASS.

- [ ] **Step 4: Commit E2E coverage**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover executor job cancel in api e2e"
```

## Task 5: Final Verification And Handoff

**Files:**
- Modify: no source files unless verification exposes a documented mismatch.

- [ ] **Step 1: Run focused route/client tests**

Run:

```bash
node_modules/.bin/tsx tests/v2/execution-routes.test.ts
node_modules/.bin/tsx tests/v2/runtime-api-client-alignment.test.ts
```

Expected: both PASS.

- [ ] **Step 2: Run full v2 regression**

Run:

```bash
npm run test:v2
```

Expected: all v2 tests PASS.

- [ ] **Step 3: Run API E2E case 27**

Run:

```bash
npm run test:e2e:postgres:27
```

Expected: PASS with executor job cancel evidence visible through HTTP API, read model, runtime command, and history.

- [ ] **Step 4: Run static route coverage scan**

Run:

```bash
rg -n "executor-jobs/.*/actions|executor-jobs/.*/cancel|cancelExecutorJob|getExecutorJobActions|reconcileExecutorJob|approveRecoveryDecision|applyRecoveryDecision|getRuntimeHealth|getRuntimeLoops|tickRuntimeLoop|wakeRuntime|executor_job.cancel_requested" src/v2 tests/v2 tests/e2e-postgres docs/superpowers/specs/2026-06-23-southstar-runtime-api-p0-gap-closure-design.md
```

Expected: output includes `src/v2/server/execution-routes.ts`, `src/v2/server/client.ts`, tests, E2E case 27, and the design spec.

- [ ] **Step 5: Commit any verification-only documentation update**

If no files changed during verification, skip this commit. If a documentation evidence note is added, commit only that note:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add docs/superpowers/specs/2026-06-23-southstar-runtime-api-p0-gap-closure-design.md
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "docs: record runtime api gap closure evidence"
```

## Completion Criteria

- `POST /api/v2/runs/:runId/executor-jobs/:jobId/cancel` exists and uses `RuntimeCommandRequest` / `RuntimeCommandResult`.
- `GET /api/v2/runs/:runId/executor-jobs/:jobId/actions` exists and returns action availability under the existing executor-jobs namespace.
- No new parallel control-plane namespace is introduced.
- Active execution cancel updates Southstar-owned resource state to `cancel_requested`.
- Terminal and dry-run cancel paths do not mutate execution resources.
- Missing job cancel writes no durable command.
- `createRuntimeServerClient()` exposes all P0 operator methods specified in this plan.
- API tests and E2E case 27 verify route behavior, idempotency, client URL/body shape, runtime command evidence, history evidence, and execution read model visibility.
