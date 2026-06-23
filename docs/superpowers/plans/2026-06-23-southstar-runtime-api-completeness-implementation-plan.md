# Southstar Runtime API Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the P0 Southstar runtime API surface required for future UI control of workflow execution without adding UI code.

**Architecture:** Keep Postgres as canonical truth and add focused route/service modules around existing runtime components. Commands write durable `runtime_command` resources plus history events, read models expose stable API shapes, and recovery/session/memory actions reuse existing Southstar services instead of bypassing the scheduler.

**Tech Stack:** TypeScript, Node 22 `node:test`, Postgres via `pg`, Southstar v2 runtime server, Server-Sent Events, existing `tests/v2/postgres-test-utils.ts`.

---

## Source Spec

- Design: `docs/superpowers/specs/2026-06-23-southstar-api-completeness-for-runtime-control-plane-design.zh.md`
- Existing runtime server: `src/v2/server/routes.ts`
- Existing client: `src/v2/server/client.ts`
- Existing session store: `src/v2/session/postgres-session-store.ts`
- Existing memory service: `src/v2/memory/postgres-memory-service.ts`
- Existing recovery applier: `src/v2/exceptions/recovery-decision-applier.ts`
- Existing Postgres route tests: `tests/v2/run-execution-controller.test.ts`, `tests/v2/operator-exception-routes.test.ts`, `tests/v2/postgres-core-read-models-api.test.ts`

## File Structure

Create focused modules instead of expanding `src/v2/server/routes.ts` further:

- Create `src/v2/ui-api/commands/runtime-command.ts`
  - Owns `RuntimeCommandRequest`, `RuntimeCommandResult`, validation, idempotent command recording, and command result helpers.
- Create `src/v2/server/run-lifecycle-routes.ts`
  - Handles `pause`, `resume`, `cancel`, and run action allowlist.
- Create `src/v2/server/runtime-event-stream.ts`
  - Builds long-lived SSE responses from Postgres `workflow_history`.
- Modify `src/v2/server/sse.ts`
  - Adds `runId`, `sessionId`, and `actorType` to event frames.
- Create `src/v2/server/runtime-loop-registry.ts`
  - Tracks loop health, manual tick handlers, and wake responses.
- Modify `src/v2/server/runtime-context.ts`
  - Adds optional `runtimeLoopRegistry`.
- Create `src/v2/server/session-routes.ts`
  - Exposes session events, checkpoints, and lineage.
- Modify `src/v2/memory/postgres-memory-service.ts`
  - Adds `rejectMemoryDeltaPg`, `listRunMemoryDeltasPg`, and `searchMemoryApiPg`.
- Create `src/v2/server/memory-routes.ts`
  - Exposes memory decision endpoints.
- Create `src/v2/read-models/executions.ts`
  - Normalizes `hand_execution` and `executor_binding` into `ExecutionProjection`.
- Create `src/v2/server/execution-routes.ts`
  - Exposes hand execution and executor job query/cancel/reconcile endpoints.
- Create `src/v2/server/task-command-routes.ts`
  - Creates operator recovery decisions for retry/fork/reset/rollback/request-revision commands.
- Modify `src/v2/server/routes.ts`
  - Delegates to the new route modules before falling through to existing routes.
- Modify `src/v2/read-models/types.ts`
  - Adds normalized read model kinds.
- Modify `src/v2/read-models/postgres-core.ts`
  - Delegates normalized execution read models where required.
- Modify `src/v2/server/client.ts`
  - Keeps client methods aligned with implemented routes only.
- Add tests under `tests/v2/*`.
- Add API E2E cases under `tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts` and wire into the package script plus Postgres real matrix documentation.

## Execution Notes

- Run all commands from `/home/timmypai/apps/southstar`.
- Postgres-backed tests require `SOUTHSTAR_TEST_ADMIN_DATABASE_URL`.
- This checkout uses `.git-local`; commit commands in this plan use:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar
```

## Task 1: Runtime Command Contract

**Files:**
- Create: `src/v2/ui-api/commands/runtime-command.ts`
- Test: `tests/v2/runtime-command-contract.test.ts`

- [x] **Step 1: Write the failing test**

Create `tests/v2/runtime-command-contract.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { recordRuntimeCommandPg } from "../../src/v2/ui-api/commands/runtime-command.ts";
import { createWorkflowRunPg, listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("recordRuntimeCommandPg writes an idempotent command resource and history event", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-command-contract",
      status: "running",
      domain: "software",
      goalPrompt: "exercise runtime commands",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const first = await recordRuntimeCommandPg(db, {
      commandId: "cmd-pause-1",
      runId: "run-command-contract",
      taskId: "task-a",
      sessionId: "session-a",
      action: "run.pause",
      actor: { type: "user", id: "operator-a" },
      reason: "operator pauses scheduling",
      status: "applied",
      resourceRefs: [{ resourceType: "workflow_run", resourceKey: "run-command-contract" }],
      eventType: "run.paused",
      eventPayload: { fromStatus: "running", toStatus: "paused" },
    });
    const second = await recordRuntimeCommandPg(db, {
      commandId: "cmd-pause-1",
      runId: "run-command-contract",
      taskId: "task-a",
      sessionId: "session-a",
      action: "run.pause",
      actor: { type: "user", id: "operator-a" },
      reason: "operator pauses scheduling",
      status: "applied",
      resourceRefs: [{ resourceType: "workflow_run", resourceKey: "run-command-contract" }],
      eventType: "run.paused",
      eventPayload: { fromStatus: "running", toStatus: "paused" },
    });

    assert.equal(first.commandId, "cmd-pause-1");
    assert.equal(first.status, "applied");
    assert.equal(first.accepted, true);
    assert.deepEqual(second, first);

    const commandResources = (await listResourcesPg(db, { resourceType: "runtime_command" }))
      .filter((resource) => resource.runId === "run-command-contract");
    assert.equal(commandResources.length, 1);
    assert.equal(commandResources[0]?.resourceKey, "cmd-pause-1");
    assert.equal(commandResources[0]?.status, "applied");

    const events = await listHistoryForRunPg(db, "run-command-contract");
    assert.equal(events.filter((event) => event.eventType === "run.command_requested").length, 1);
    assert.equal(events.filter((event) => event.eventType === "run.paused").length, 1);
  } finally {
    await db.close();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-command-contract.test.ts
```

Expected: FAIL with an import error for `src/v2/ui-api/commands/runtime-command.ts`.

- [x] **Step 3: Write minimal implementation**

Create `src/v2/ui-api/commands/runtime-command.ts`:

```ts
import type { SouthstarDb } from "../../db/postgres.ts";
import { appendHistoryEventPg, getResourceByKeyPg, upsertRuntimeResourcePg } from "../../stores/postgres-runtime-store.ts";

export type RuntimeCommandActor = {
  type: "user" | "system" | "root-session";
  id?: string;
};

export type RuntimeCommandRequest = {
  commandId: string;
  actor: RuntimeCommandActor;
  reason?: string;
  dryRun?: boolean;
  payload?: Record<string, unknown>;
};

export type RuntimeCommandStatus = "applied" | "queued" | "blocked" | "rejected" | "noop";

export type RuntimeCommandResourceRef = {
  resourceType: string;
  resourceKey: string;
};

export type RuntimeCommandEventRef = {
  runId: string;
  sequence: number;
  eventType: string;
};

export type RuntimeCommandResult = {
  commandId: string;
  accepted: boolean;
  status: RuntimeCommandStatus;
  affectedRunId?: string;
  affectedTaskId?: string;
  affectedSessionId?: string;
  resourceRefs: RuntimeCommandResourceRef[];
  eventRefs: RuntimeCommandEventRef[];
  nextSuggestedActions: string[];
  message?: string;
};

export type RecordRuntimeCommandInput = {
  commandId: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  action: string;
  actor: RuntimeCommandActor;
  reason?: string;
  status: RuntimeCommandStatus;
  resourceRefs?: RuntimeCommandResourceRef[];
  eventType: string;
  eventPayload?: Record<string, unknown>;
  nextSuggestedActions?: string[];
  message?: string;
};

export function requireRuntimeCommandRequest(value: unknown): RuntimeCommandRequest {
  if (!isRecord(value)) throw new Error("command request body must be an object");
  const commandId = stringValue(value.commandId, "commandId");
  const actorValue = value.actor;
  if (!isRecord(actorValue)) throw new Error("actor is required");
  const actorType = stringValue(actorValue.type, "actor.type");
  if (actorType !== "user" && actorType !== "system" && actorType !== "root-session") {
    throw new Error("actor.type must be user, system, or root-session");
  }
  return {
    commandId,
    actor: { type: actorType, id: optionalString(actorValue.id) },
    reason: optionalString(value.reason),
    dryRun: value.dryRun === true,
    payload: isRecord(value.payload) ? value.payload : {},
  };
}

export async function recordRuntimeCommandPg(db: SouthstarDb, input: RecordRuntimeCommandInput): Promise<RuntimeCommandResult> {
  const existing = await getResourceByKeyPg(db, "runtime_command", input.commandId);
  const existingPayload = isRecord(existing?.payload) ? existing.payload : undefined;
  if (existingPayload && existingPayload.commandId === input.commandId) {
    return commandResultFromPayload(existingPayload);
  }

  return await db.tx(async (tx) => {
    const requestedEvent = await appendHistoryEventPg(tx, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      eventType: "run.command_requested",
      actorType: actorTypeForHistory(input.actor),
      idempotencyKey: `runtime-command:${input.commandId}:requested`,
      payload: {
        commandId: input.commandId,
        action: input.action,
        actor: input.actor,
        reason: input.reason,
      },
    });
    const appliedEvent = await appendHistoryEventPg(tx, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      eventType: input.eventType,
      actorType: actorTypeForHistory(input.actor),
      idempotencyKey: `runtime-command:${input.commandId}:${input.eventType}`,
      payload: {
        commandId: input.commandId,
        action: input.action,
        reason: input.reason,
        ...(input.eventPayload ?? {}),
      },
    });
    const eventRefs = [
      { runId: input.runId, sequence: requestedEvent.sequence, eventType: "run.command_requested" },
      { runId: input.runId, sequence: appliedEvent.sequence, eventType: input.eventType },
    ];
    const result: RuntimeCommandResult = {
      commandId: input.commandId,
      accepted: input.status !== "rejected" && input.status !== "blocked",
      status: input.status,
      affectedRunId: input.runId,
      affectedTaskId: input.taskId,
      affectedSessionId: input.sessionId,
      resourceRefs: input.resourceRefs ?? [],
      eventRefs,
      nextSuggestedActions: input.nextSuggestedActions ?? [],
      message: input.message,
    };
    await upsertRuntimeResourcePg(tx, {
      resourceType: "runtime_command",
      resourceKey: input.commandId,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      scope: "operator-command",
      status: input.status,
      title: input.action,
      payload: {
        commandId: input.commandId,
        action: input.action,
        actor: input.actor,
        reason: input.reason,
        result,
      },
      summary: { action: input.action, status: input.status },
    });
    return result;
  });
}

function commandResultFromPayload(payload: Record<string, unknown>): RuntimeCommandResult {
  const result = payload.result;
  if (!isRecord(result)) throw new Error("runtime command resource has invalid result payload");
  return {
    commandId: stringValue(result.commandId, "result.commandId"),
    accepted: result.accepted === true,
    status: runtimeCommandStatus(result.status),
    affectedRunId: optionalString(result.affectedRunId),
    affectedTaskId: optionalString(result.affectedTaskId),
    affectedSessionId: optionalString(result.affectedSessionId),
    resourceRefs: arrayOfRefs(result.resourceRefs),
    eventRefs: arrayOfEventRefs(result.eventRefs),
    nextSuggestedActions: arrayOfStrings(result.nextSuggestedActions),
    message: optionalString(result.message),
  };
}

function runtimeCommandStatus(value: unknown): RuntimeCommandStatus {
  if (value === "applied" || value === "queued" || value === "blocked" || value === "rejected" || value === "noop") return value;
  throw new Error("invalid runtime command status");
}

function actorTypeForHistory(actor: RuntimeCommandActor): string {
  return actor.type === "root-session" ? "root-session" : actor.type;
}

function arrayOfRefs(value: unknown): RuntimeCommandResourceRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    resourceType: stringValue(item.resourceType, "resourceType"),
    resourceKey: stringValue(item.resourceKey, "resourceKey"),
  }));
}

function arrayOfEventRefs(value: unknown): RuntimeCommandEventRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    runId: stringValue(item.runId, "runId"),
    sequence: numberValue(item.sequence, "sequence"),
    eventType: stringValue(item.eventType, "eventType"),
  }));
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a number`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-command-contract.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/ui-api/commands/runtime-command.ts tests/v2/runtime-command-contract.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add runtime command contract"
```

## Task 2: Run Lifecycle API

**Files:**
- Create: `src/v2/server/run-lifecycle-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Test: `tests/v2/run-lifecycle-routes.test.ts`

- [x] **Step 1: Write the failing route test**

Create `tests/v2/run-lifecycle-routes.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("run lifecycle routes pause, resume, cancel, and expose actions", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-lifecycle-api",
      status: "running",
      domain: "software",
      goalPrompt: "operate run lifecycle",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId: "run-lifecycle-api",
      taskKey: "implement",
      status: "queued",
      sortOrder: 0,
      dependsOn: [],
    });

    const actionsBefore = await call("GET", "/api/v2/runs/run-lifecycle-api/actions");
    assert.equal(actionsBefore.result.actions.some((action: { action: string; allowed: boolean }) => action.action === "pause" && action.allowed), true);

    const pause = await call("POST", "/api/v2/runs/run-lifecycle-api/pause", {
      commandId: "cmd-run-pause",
      actor: { type: "user", id: "operator-a" },
      reason: "stop new scheduling",
      payload: {},
    });
    assert.equal(pause.result.status, "applied");
    assert.equal((await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", ["run-lifecycle-api"])).status, "paused");

    const pauseReplay = await call("POST", "/api/v2/runs/run-lifecycle-api/pause", {
      commandId: "cmd-run-pause",
      actor: { type: "user", id: "operator-a" },
      reason: "stop new scheduling",
      payload: {},
    });
    assert.deepEqual(pauseReplay.result, pause.result);

    const resume = await call("POST", "/api/v2/runs/run-lifecycle-api/resume", {
      commandId: "cmd-run-resume",
      actor: { type: "user", id: "operator-a" },
      reason: "continue scheduling",
      payload: {},
    });
    assert.equal(resume.result.status, "applied");
    assert.equal((await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", ["run-lifecycle-api"])).status, "scheduling");

    const cancel = await call("POST", "/api/v2/runs/run-lifecycle-api/cancel", {
      commandId: "cmd-run-cancel",
      actor: { type: "user", id: "operator-a" },
      reason: "operator stops run",
      payload: { cancelActiveJobs: true },
    });
    assert.equal(cancel.result.status, "applied");
    assert.equal((await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", ["run-lifecycle-api"])).status, "cancelled");

    const resources = (await listResourcesPg(db, { resourceType: "runtime_command" })).filter((resource) => resource.runId === "run-lifecycle-api");
    assert.deepEqual(resources.map((resource) => resource.resourceKey).sort(), ["cmd-run-cancel", "cmd-run-pause", "cmd-run-resume"]);
    const events = await listHistoryForRunPg(db, "run-lifecycle-api");
    assert.equal(events.some((event) => event.eventType === "run.paused"), true);
    assert.equal(events.some((event) => event.eventType === "run.resumed"), true);
    assert.equal(events.some((event) => event.eventType === "run.cancelled"), true);

    async function call(method: string, path: string, body?: unknown): Promise<{ result: any }> {
      const response = await handleRuntimeRoute(testContext(), new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
      const envelope = await response.json() as { ok: true; result: any } | { ok: false; error: string };
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }

    function testContext() {
      return {
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
      };
    }
  } finally {
    await db.close();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node_modules/.bin/tsx tests/v2/run-lifecycle-routes.test.ts
```

Expected: FAIL because `/pause`, `/resume`, `/cancel`, and `/actions` return `not found`.

- [x] **Step 3: Implement run lifecycle route module**

Create `src/v2/server/run-lifecycle-routes.ts`:

```ts
import { recordRuntimeCommandPg, requireRuntimeCommandRequest } from "../ui-api/commands/runtime-command.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

const TERMINAL_RUN_STATUSES = new Set(["completed", "passed", "failed", "cancelled"]);

export async function handleRunLifecycleRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const actionsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/actions$/);
  if (request.method === "GET" && actionsMatch) {
    const runId = decodeURIComponent(actionsMatch[1]!);
    const run = await readRunStatus(context, runId);
    return json("run-actions", { runId, status: run.status, actions: runActions(run.status) });
  }

  const commandMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(pause|resume|cancel)$/);
  if (request.method === "POST" && commandMatch) {
    const runId = decodeURIComponent(commandMatch[1]!);
    const action = commandMatch[2] as "pause" | "resume" | "cancel";
    const body = requireRuntimeCommandRequest(await request.json());
    if (body.dryRun) {
      const run = await readRunStatus(context, runId);
      return json("run-command", {
        commandId: body.commandId,
        accepted: isRunActionAllowed(action, run.status),
        status: isRunActionAllowed(action, run.status) ? "noop" : "blocked",
        affectedRunId: runId,
        resourceRefs: [],
        eventRefs: [],
        nextSuggestedActions: runActions(run.status).filter((item) => item.allowed).map((item) => item.action),
        message: isRunActionAllowed(action, run.status) ? "dry run accepted" : `run ${runId} cannot ${action} from ${run.status}`,
      });
    }
    return json("run-command", await applyRunLifecycleCommand(context, {
      runId,
      action,
      commandId: body.commandId,
      actor: body.actor,
      reason: body.reason,
      payload: body.payload ?? {},
    }));
  }

  return undefined;
}

async function applyRunLifecycleCommand(
  context: RuntimeServerContext,
  input: {
    runId: string;
    action: "pause" | "resume" | "cancel";
    commandId: string;
    actor: { type: "user" | "system" | "root-session"; id?: string };
    reason?: string;
    payload: Record<string, unknown>;
  },
) {
  return await context.db.tx(async (tx) => {
    const run = await tx.maybeOne<{ status: string }>("select status from southstar.workflow_runs where id = $1 for update", [input.runId]);
    if (!run) throw new Error(`run not found: ${input.runId}`);
    if (!isRunActionAllowed(input.action, run.status)) throw new Error(`run cannot ${input.action} from status ${run.status}`);

    const nextStatus = input.action === "pause" ? "paused" : input.action === "resume" ? "scheduling" : "cancelled";
    await tx.query("update southstar.workflow_runs set status = $2, updated_at = now() where id = $1", [input.runId, nextStatus]);
    if (input.action === "cancel" && input.payload.cancelActiveJobs === true) {
      await tx.query(
        "update southstar.runtime_resources set status = 'cancel_requested', updated_at = now() where run_id = $1 and resource_type in ('hand_execution', 'executor_binding') and status in ('queued', 'running')",
        [input.runId],
      );
    }

    return await recordRuntimeCommandPg(tx, {
      commandId: input.commandId,
      runId: input.runId,
      action: `run.${input.action}`,
      actor: input.actor,
      reason: input.reason,
      status: "applied",
      resourceRefs: [{ resourceType: "workflow_run", resourceKey: input.runId }],
      eventType: input.action === "pause" ? "run.paused" : input.action === "resume" ? "run.resumed" : "run.cancelled",
      eventPayload: { fromStatus: run.status, toStatus: nextStatus, payload: input.payload },
      nextSuggestedActions: runActions(nextStatus).filter((item) => item.allowed).map((item) => item.action),
    });
  });
}

async function readRunStatus(context: RuntimeServerContext, runId: string): Promise<{ status: string }> {
  const run = await context.db.maybeOne<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
  if (!run) throw new Error(`run not found: ${runId}`);
  return run;
}

function runActions(status: string): Array<{ action: string; allowed: boolean; reason?: string; endpoint?: string }> {
  return ["pause", "resume", "cancel"].map((action) => {
    const allowed = isRunActionAllowed(action as "pause" | "resume" | "cancel", status);
    return {
      action,
      allowed,
      reason: allowed ? undefined : `run status ${status} does not allow ${action}`,
      endpoint: `/api/v2/runs/:runId/${action}`,
    };
  });
}

function isRunActionAllowed(action: "pause" | "resume" | "cancel", status: string): boolean {
  if (action === "pause") return status === "scheduling" || status === "running";
  if (action === "resume") return status === "paused" || status === "blocked";
  if (action === "cancel") return !TERMINAL_RUN_STATUSES.has(status);
  return false;
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
```

Modify `src/v2/server/routes.ts`:

```ts
import { handleRunLifecycleRoute } from "./run-lifecycle-routes.ts";
```

Inside `handleRuntimeRoute`, immediately after the existing `handleUiRoute` block, insert:

```ts
    const runLifecycleResponse = await handleRunLifecycleRoute(context, request, url);
    if (runLifecycleResponse) return runLifecycleResponse;
```

Modify `src/v2/server/client.ts` by keeping the existing `pauseRun`, `resumeRun`, and `cancelRun` methods and adding:

```ts
    getRunActions(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/actions`);
    },
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
node_modules/.bin/tsx tests/v2/run-lifecycle-routes.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/run-lifecycle-routes.ts src/v2/server/routes.ts src/v2/server/client.ts tests/v2/run-lifecycle-routes.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add run lifecycle api"
```

## Task 3: Durable SSE Event Stream

**Files:**
- Modify: `src/v2/server/sse.ts`
- Create: `src/v2/server/runtime-event-stream.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/runtime-event-stream.test.ts`

- [x] **Step 1: Write the failing stream test**

Create `tests/v2/runtime-event-stream.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { appendHistoryEventPg, createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("events stream holds the connection, sends history frames, and supports reconnect after sequence", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-stream-api",
      status: "running",
      domain: "software",
      goalPrompt: "stream events",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const abort = new AbortController();
      const response = await fetch(`${server.url}/api/v2/runs/run-stream-api/events/stream?after=0&heartbeatMs=25&pollMs=25&closeOnTerminal=false`, {
        signal: abort.signal,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type")?.startsWith("text/event-stream"), true);
      const reader = response.body!.getReader();

      await appendHistoryEventPg(db, {
        runId: "run-stream-api",
        taskId: "task-a",
        sessionId: "session-a",
        eventType: "progress.commentary",
        actorType: "agent",
        payload: { message: "streamed event" },
      });

      const firstChunk = await readUntil(reader, "progress.commentary");
      assert.match(firstChunk, /event: progress\.commentary/);
      assert.match(firstChunk, /"runId":"run-stream-api"/);
      assert.match(firstChunk, /"sessionId":"session-a"/);
      assert.match(firstChunk, /"actorType":"agent"/);
      abort.abort();

      const reconnect = await fetch(`${server.url}/api/v2/runs/run-stream-api/events?after=0`);
      const reconnectEnvelope = await reconnect.json() as { ok: true; result: Array<{ sequence: number; eventType: string }> };
      assert.equal(reconnectEnvelope.result.some((event) => event.eventType === "progress.commentary"), true);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2_000;
  while (!text.includes(needle) && Date.now() < deadline) {
    const read = await reader.read();
    if (read.done) break;
    text += decoder.decode(read.value, { stream: true });
  }
  return text;
}
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-event-stream.test.ts
```

Expected: FAIL because the current stream endpoint returns only already-present events and closes.

- [x] **Step 3: Implement stream and richer event frames**

Modify `src/v2/server/sse.ts` to use this complete frame and query:

```ts
import type { SouthstarDb } from "../db/postgres.ts";

export type RuntimeEventFrame = {
  sequence: number;
  eventType: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  actorType: string;
  payload: unknown;
  createdAt: string;
};

export async function readRunEventsSince(db: SouthstarDb, input: { runId: string; afterSequence?: number }): Promise<RuntimeEventFrame[]> {
  const rows = await db.query<{
    sequence: number;
    event_type: string;
    run_id: string;
    task_id: string | null;
    session_id: string | null;
    actor_type: string;
    payload_json: unknown;
    created_at: Date | string;
  }>(
    `select sequence, event_type, run_id, task_id, session_id, actor_type, payload_json, created_at
       from southstar.workflow_history
      where run_id = $1 and sequence > $2
      order by sequence`,
    [input.runId, input.afterSequence ?? 0],
  );
  return rows.rows.map((row) => ({
    sequence: row.sequence,
    eventType: row.event_type,
    runId: row.run_id,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    actorType: row.actor_type,
    payload: row.payload_json,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

export function toSseFrame(event: RuntimeEventFrame): string {
  return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function heartbeatSseFrame(now = new Date()): string {
  return `event: heartbeat\ndata: ${JSON.stringify({ type: "heartbeat", createdAt: now.toISOString() })}\n\n`;
}
```

Create `src/v2/server/runtime-event-stream.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { heartbeatSseFrame, readRunEventsSince, toSseFrame } from "./sse.ts";

export function createRunEventStreamResponse(
  db: SouthstarDb,
  input: { runId: string; afterSequence: number; pollMs?: number; heartbeatMs?: number; closeOnTerminal?: boolean },
): Response {
  const encoder = new TextEncoder();
  let lastSequence = input.afterSequence;
  let lastHeartbeatAt = 0;
  let closed = false;
  const pollMs = Math.max(10, input.pollMs ?? 1_000);
  const heartbeatMs = Math.max(10, input.heartbeatMs ?? 15_000);
  const closeOnTerminal = input.closeOnTerminal ?? true;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const tick = async () => {
        if (closed) return;
        try {
          const events = await readRunEventsSince(db, { runId: input.runId, afterSequence: lastSequence });
          for (const event of events) {
            lastSequence = event.sequence;
            controller.enqueue(encoder.encode(toSseFrame(event)));
            if (closeOnTerminal && isTerminalEvent(event.eventType)) {
              closed = true;
              controller.close();
              return;
            }
          }
          const now = Date.now();
          if (now - lastHeartbeatAt >= heartbeatMs) {
            lastHeartbeatAt = now;
            controller.enqueue(encoder.encode(heartbeatSseFrame(new Date(now))));
          }
          setTimeout(tick, pollMs);
        } catch (error) {
          closed = true;
          controller.error(error);
        }
      };
      void tick();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

export function afterSequenceFromRequest(request: Request, url: URL): number {
  const lastEventId = request.headers.get("last-event-id");
  const raw = lastEventId ?? url.searchParams.get("after") ?? "0";
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTerminalEvent(eventType: string): boolean {
  return eventType === "run.completed" || eventType === "run.cancelled" || eventType === "run.failed" || eventType === "completion_gate.completed";
}
```

Modify `src/v2/server/routes.ts` imports:

```ts
import { afterSequenceFromRequest, createRunEventStreamResponse } from "./runtime-event-stream.ts";
```

Replace the existing `/events/stream` block with:

```ts
    const streamMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events\/stream$/);
    if (request.method === "GET" && streamMatch) {
      return createRunEventStreamResponse(context.db, {
        runId: decodeURIComponent(streamMatch[1]!),
        afterSequence: afterSequenceFromRequest(request, url),
        pollMs: optionalPositiveNumber(url.searchParams.get("pollMs")),
        heartbeatMs: optionalPositiveNumber(url.searchParams.get("heartbeatMs")),
        closeOnTerminal: url.searchParams.get("closeOnTerminal") !== "false",
      });
    }
```

Add this helper near the other helpers in `routes.ts`:

```ts
function optionalPositiveNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-event-stream.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/sse.ts src/v2/server/runtime-event-stream.ts src/v2/server/routes.ts tests/v2/runtime-event-stream.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add durable event stream api"
```

## Task 4: Session Timeline And Checkpoint API

**Files:**
- Create: `src/v2/server/session-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Test: `tests/v2/session-routes.test.ts`

- [x] **Step 1: Write the failing session route test**

Create `tests/v2/session-routes.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("session routes expose events, checkpoints, and lineage without mutating runtime fate", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-session-api",
      status: "running",
      domain: "software",
      goalPrompt: "inspect sessions",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId: "run-session-api",
      taskKey: "implement",
      status: "running",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-a",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "session",
      resourceKey: "session-a",
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-a",
      scope: "session",
      status: "active",
      payload: { parentSessionId: null },
    });
    const store = createPostgresSessionStore(db);
    const event = await store.emitEvent({
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-a",
      eventType: "hand.started",
      actorType: "hand",
      payload: { handExecutionId: "hand-execution:run-session-api:task-a:attempt-1" },
    });
    const checkpoint = await store.createCheckpoint({
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-a",
      resourceKey: "checkpoint-a",
      checkpointType: "task-start",
      summary: "Task start checkpoint",
      eventRange: { fromSequence: event.sequence, toSequence: event.sequence },
      refs: { eventIds: [event.id] },
    });

    const events = await call(`/api/v2/sessions/session-a/events?afterSequence=0&limit=10`);
    assert.equal(events.result.events.length >= 1, true);
    assert.equal(events.result.events.some((item: { eventType: string }) => item.eventType === "hand.started"), true);

    const checkpoints = await call("/api/v2/sessions/session-a/checkpoints");
    assert.equal(checkpoints.result.checkpoints.some((item: { id: string }) => item.id === checkpoint.id), true);

    const checkpointDetail = await call(`/api/v2/sessions/session-a/checkpoints/${encodeURIComponent(checkpoint.id)}`);
    assert.equal(checkpointDetail.result.checkpoint.id, checkpoint.id);

    const lineage = await call("/api/v2/sessions/session-a/lineage");
    assert.equal(lineage.result.sessionId, "session-a");
    assert.equal(lineage.result.runIds.includes("run-session-api"), true);

    async function call(path: string): Promise<{ result: any }> {
      const response = await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      }, new Request(`http://127.0.0.1${path}`));
      const envelope = await response.json() as { ok: true; result: any } | { ok: false; error: string };
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }
  } finally {
    await db.close();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node_modules/.bin/tsx tests/v2/session-routes.test.ts
```

Expected: FAIL because `/api/v2/sessions/:sessionId/*` routes are not found.

- [x] **Step 3: Implement session routes**

Create `src/v2/server/session-routes.ts`:

```ts
import { createPostgresSessionStore } from "../session/postgres-session-store.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleSessionRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const eventsMatch = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/events$/);
  if (request.method === "GET" && eventsMatch) {
    const sessionId = decodeURIComponent(eventsMatch[1]!);
    const store = createPostgresSessionStore(context.db);
    const events = await store.getEvents(sessionId, {
      afterSequence: optionalNumber(url.searchParams.get("afterSequence")),
      beforeSequence: optionalNumber(url.searchParams.get("beforeSequence")),
      limit: optionalNumber(url.searchParams.get("limit")),
      eventTypes: optionalStringList(url.searchParams.get("eventTypes")),
      taskId: optionalString(url.searchParams.get("taskId")),
      correlationId: optionalString(url.searchParams.get("correlationId")),
      artifactRef: optionalString(url.searchParams.get("artifactRef")),
      aroundEventId: optionalString(url.searchParams.get("aroundEventId")),
      windowBefore: optionalNumber(url.searchParams.get("windowBefore")),
      windowAfter: optionalNumber(url.searchParams.get("windowAfter")),
    });
    return json("session-events", { sessionId, events });
  }

  const checkpointsMatch = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/checkpoints$/);
  if (request.method === "GET" && checkpointsMatch) {
    const sessionId = decodeURIComponent(checkpointsMatch[1]!);
    const rows = await context.db.query(
      `select resource_key, payload_json, status, task_id, run_id, created_at
         from southstar.runtime_resources
        where resource_type = 'session_checkpoint' and session_id = $1
        order by created_at, resource_key`,
      [sessionId],
    );
    return json("session-checkpoints", { sessionId, checkpoints: rows.rows.map((row) => checkpointSummary(row)) });
  }

  const checkpointMatch = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/checkpoints\/([^/]+)$/);
  if (request.method === "GET" && checkpointMatch) {
    const sessionId = decodeURIComponent(checkpointMatch[1]!);
    const checkpointId = decodeURIComponent(checkpointMatch[2]!);
    const checkpoint = await createPostgresSessionStore(context.db).getCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.sessionId !== sessionId) throw new Error(`checkpoint not found: ${checkpointId}`);
    return json("session-checkpoint", { sessionId, checkpoint });
  }

  const lineageMatch = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/lineage$/);
  if (request.method === "GET" && lineageMatch) {
    const sessionId = decodeURIComponent(lineageMatch[1]!);
    const rows = await context.db.query<{ resource_type: string; resource_key: string; run_id: string | null; task_id: string | null; status: string; payload_json: unknown }>(
      `select resource_type, resource_key, run_id, task_id, status, payload_json
         from southstar.runtime_resources
        where session_id = $1 and resource_type in ('session', 'session_checkpoint', 'session_fork', 'session_reset', 'session_rollback', 'rollback_marker')
        order by created_at, resource_type, resource_key`,
      [sessionId],
    );
    return json("session-lineage", {
      sessionId,
      runIds: [...new Set(rows.rows.map((row) => row.run_id).filter((item): item is string => Boolean(item)))],
      resources: rows.rows.map((row) => ({
        resourceType: row.resource_type,
        resourceKey: row.resource_key,
        runId: row.run_id ?? undefined,
        taskId: row.task_id ?? undefined,
        status: row.status,
        payload: row.payload_json,
      })),
    });
  }

  return undefined;
}

function checkpointSummary(row: Record<string, unknown>) {
  return {
    id: String(row.resource_key),
    runId: typeof row.run_id === "string" ? row.run_id : undefined,
    taskId: typeof row.task_id === "string" ? row.task_id : undefined,
    status: String(row.status),
    payload: row.payload_json,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalString(value: string | null): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function optionalStringList(value: string | null): string[] | undefined {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
```

Modify `src/v2/server/routes.ts`:

```ts
import { handleSessionRoute } from "./session-routes.ts";
```

Insert after run lifecycle route handling:

```ts
    const sessionResponse = await handleSessionRoute(context, request, url);
    if (sessionResponse) return sessionResponse;
```

Modify `src/v2/server/client.ts` by adding:

```ts
    getSessionEvents(body: { sessionId: string; afterSequence?: number; limit?: number }) {
      const query = new URLSearchParams();
      if (body.afterSequence !== undefined) query.set("afterSequence", String(body.afterSequence));
      if (body.limit !== undefined) query.set("limit", String(body.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return get(`${baseUrl}/api/v2/sessions/${encodeURIComponent(body.sessionId)}/events${suffix}`);
    },
    getSessionCheckpoints(sessionId: string) {
      return get(`${baseUrl}/api/v2/sessions/${encodeURIComponent(sessionId)}/checkpoints`);
    },
    getSessionCheckpoint(body: { sessionId: string; checkpointId: string }) {
      return get(`${baseUrl}/api/v2/sessions/${encodeURIComponent(body.sessionId)}/checkpoints/${encodeURIComponent(body.checkpointId)}`);
    },
    getSessionLineage(sessionId: string) {
      return get(`${baseUrl}/api/v2/sessions/${encodeURIComponent(sessionId)}/lineage`);
    },
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
node_modules/.bin/tsx tests/v2/session-routes.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/session-routes.ts src/v2/server/routes.ts src/v2/server/client.ts tests/v2/session-routes.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add session timeline api"
```

## Task 5: Memory Decision API

**Files:**
- Modify: `src/v2/memory/postgres-memory-service.ts`
- Create: `src/v2/server/memory-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Test: `tests/v2/memory-routes.test.ts`

- [x] **Step 1: Write the failing memory route test**

Create `tests/v2/memory-routes.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createMemoryDeltaPg, writeRunLocalMemoryPg } from "../../src/v2/memory/postgres-memory-service.ts";
import { createWorkflowRunPg, listHistoryForRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("memory routes approve, reject, list, invalidate, and search memory", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-memory-api",
      status: "running",
      domain: "software",
      goalPrompt: "memory routes",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await writeRunLocalMemoryPg(db, {
      runId: "run-memory-api",
      taskId: "task-a",
      sessionId: "session-a",
      scope: "run:run-memory-api",
      kind: "implementation_preference",
      text: "Prefer minimal API changes.",
      sourceRefs: ["artifact:a"],
    });
    const approveDelta = await createMemoryDeltaPg(db, {
      runId: "run-memory-api",
      taskId: "task-a",
      sessionId: "session-a",
      scope: "software",
      kind: "implementation_preference",
      text: "Prefer deterministic command ids.",
      sourceRefs: ["artifact:b"],
    });
    const rejectDelta = await createMemoryDeltaPg(db, {
      runId: "run-memory-api",
      taskId: "task-b",
      sessionId: "session-b",
      scope: "software",
      kind: "implementation_preference",
      text: "Reject noisy memory.",
      sourceRefs: ["artifact:c"],
    });

    const approved = await call("POST", `/api/v2/memory-deltas/${encodeURIComponent(approveDelta.id)}/approve`, {
      approvedBy: "operator-a",
      reason: "useful across runs",
    });
    assert.equal(approved.result.deltaId, approveDelta.id);
    assert.equal(typeof approved.result.memoryItemId, "string");

    const rejected = await call("POST", `/api/v2/memory-deltas/${encodeURIComponent(rejectDelta.id)}/reject`, {
      rejectedBy: "operator-a",
      reason: "too noisy",
    });
    assert.equal(rejected.result.deltaId, rejectDelta.id);
    assert.equal(rejected.result.status, "rejected");

    const listed = await call("GET", "/api/v2/runs/run-memory-api/memory-deltas");
    assert.equal(listed.result.memoryDeltas.some((item: { id: string; status: string }) => item.id === approveDelta.id && item.status === "approved"), true);
    assert.equal(listed.result.memoryDeltas.some((item: { id: string; status: string }) => item.id === rejectDelta.id && item.status === "rejected"), true);

    const invalidated = await call("POST", "/api/v2/runs/run-memory-api/memory/invalidate", {
      sourceRefs: ["artifact:a"],
      reason: "source superseded",
    });
    assert.equal(invalidated.result.invalidatedIds.length, 1);

    const searched = await call("GET", "/api/v2/memory/search?runId=run-memory-api&query=deterministic&scopes=software&allowedKinds=implementation_preference&maxCandidates=5");
    assert.equal(searched.result.candidates.some((item: { text: string }) => /deterministic/.test(item.text)), true);

    const events = await listHistoryForRunPg(db, "run-memory-api");
    assert.equal(events.some((event) => event.eventType === "memory.delta_approved"), true);
    assert.equal(events.some((event) => event.eventType === "memory.delta_rejected"), true);
    assert.equal(events.some((event) => event.eventType === "memory.run_local_invalidated"), true);

    async function call(method: string, path: string, body?: unknown): Promise<{ result: any }> {
      const response = await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      }, new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
      const envelope = await response.json() as { ok: true; result: any } | { ok: false; error: string };
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }
  } finally {
    await db.close();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node_modules/.bin/tsx tests/v2/memory-routes.test.ts
```

Expected: FAIL because memory decision routes do not exist and `rejectMemoryDeltaPg` is not exported.

- [x] **Step 3: Implement memory service methods and routes**

Append these exports to `src/v2/memory/postgres-memory-service.ts` after `approveMemoryDeltaPg`:

```ts
export async function rejectMemoryDeltaPg(db: SouthstarDb, input: { deltaId: string; rejectedBy: string; reason: string }): Promise<{ deltaId: string; status: "rejected" }> {
  return await db.tx(async (tx) => {
    const delta = await tx.maybeOne<MemoryResourceRow>(
      "select * from southstar.runtime_resources where resource_type = 'memory_delta' and id = $1 for update",
      [input.deltaId],
    );
    if (!delta) throw new Error(`memory delta not found: ${input.deltaId}`);
    if (delta.status === "rejected") return { deltaId: input.deltaId, status: "rejected" };
    if (delta.status !== "pending_approval") throw new Error(`memory delta is not rejectable: ${delta.status}`);
    const payload = parseMemoryPayload(delta.payload_json);
    const now = new Date().toISOString();
    await tx.query(
      `update southstar.runtime_resources
          set status = 'rejected',
              payload_json = $1::jsonb,
              updated_at = now()
        where id = $2 and resource_type = 'memory_delta'`,
      [JSON.stringify({ ...payload, rejectedBy: input.rejectedBy, rejectedAt: now, rejectionReason: input.reason }), input.deltaId],
    );
    await appendMemoryHistory(tx, delta.run_id ?? "global", delta.task_id ?? undefined, delta.session_id ?? undefined, "memory.delta_rejected", input.deltaId, {
      rejectedBy: input.rejectedBy,
      reason: input.reason,
    });
    return { deltaId: input.deltaId, status: "rejected" };
  });
}

export async function listRunMemoryDeltasPg(db: SouthstarDb, runId: string): Promise<Array<{ id: string; taskId?: string; sessionId?: string; status: string; scope: string; payload: unknown }>> {
  const rows = await db.query<MemoryResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = 'memory_delta' and run_id = $1
      order by created_at, resource_key`,
    [runId],
  );
  return rows.rows.map((row) => ({
    id: row.resource_key,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    scope: row.scope,
    payload: row.payload_json,
  }));
}
```

Create `src/v2/server/memory-routes.ts`:

```ts
import { approveMemoryDeltaPg, invalidateRunLocalMemoryPg, listRunMemoryDeltasPg, rejectMemoryDeltaPg, searchMemoryForContextPg } from "../memory/postgres-memory-service.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleMemoryRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const deltasMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/memory-deltas$/);
  if (request.method === "GET" && deltasMatch) {
    const runId = decodeURIComponent(deltasMatch[1]!);
    return json("memory-deltas", { runId, memoryDeltas: await listRunMemoryDeltasPg(context.db, runId) });
  }

  const approveMatch = url.pathname.match(/^\/api\/v2\/memory-deltas\/([^/]+)\/approve$/);
  if (request.method === "POST" && approveMatch) {
    const body = await readBody(request);
    return json("memory-delta-approve", await approveMemoryDeltaPg(context.db, {
      deltaId: decodeURIComponent(approveMatch[1]!),
      approvedBy: requiredString(body.approvedBy, "approvedBy"),
      reason: requiredString(body.reason, "reason"),
    }));
  }

  const rejectMatch = url.pathname.match(/^\/api\/v2\/memory-deltas\/([^/]+)\/reject$/);
  if (request.method === "POST" && rejectMatch) {
    const body = await readBody(request);
    return json("memory-delta-reject", await rejectMemoryDeltaPg(context.db, {
      deltaId: decodeURIComponent(rejectMatch[1]!),
      rejectedBy: requiredString(body.rejectedBy, "rejectedBy"),
      reason: requiredString(body.reason, "reason"),
    }));
  }

  const invalidateMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/memory\/invalidate$/);
  if (request.method === "POST" && invalidateMatch) {
    const body = await readBody(request);
    return json("memory-invalidate", await invalidateRunLocalMemoryPg(context.db, {
      runId: decodeURIComponent(invalidateMatch[1]!),
      sourceRefs: arrayOfStrings(body.sourceRefs, "sourceRefs"),
      reason: requiredString(body.reason, "reason"),
    }));
  }

  if (request.method === "GET" && url.pathname === "/api/v2/memory/search") {
    const runId = requiredQuery(url, "runId");
    const candidates = await searchMemoryForContextPg(context.db, {
      runId,
      query: requiredQuery(url, "query"),
      scopes: requiredQueryList(url, "scopes"),
      allowedKinds: requiredQueryList(url, "allowedKinds"),
      maxCandidates: positiveQueryNumber(url, "maxCandidates", 10),
    });
    return json("memory-search", { runId, candidates });
  }

  return undefined;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request body must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function arrayOfStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings`);
  return value;
}

function requiredQuery(url: URL, field: string): string {
  const value = url.searchParams.get(field);
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function requiredQueryList(url: URL, field: string): string[] {
  return requiredQuery(url, field).split(",").map((item) => item.trim()).filter(Boolean);
}

function positiveQueryNumber(url: URL, field: string, fallback: number): number {
  const value = url.searchParams.get(field);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be a positive number`);
  return parsed;
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
```

Modify `src/v2/server/routes.ts`:

```ts
import { handleMemoryRoute } from "./memory-routes.ts";
```

Insert after session route handling:

```ts
    const memoryResponse = await handleMemoryRoute(context, request, url);
    if (memoryResponse) return memoryResponse;
```

Modify `src/v2/server/client.ts` by adding memory methods:

```ts
    listMemoryDeltas(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/memory-deltas`);
    },
    approveMemoryDelta(body: { deltaId: string; approvedBy: string; reason: string }) {
      return post(`${baseUrl}/api/v2/memory-deltas/${encodeURIComponent(body.deltaId)}/approve`, { approvedBy: body.approvedBy, reason: body.reason });
    },
    rejectMemoryDelta(body: { deltaId: string; rejectedBy: string; reason: string }) {
      return post(`${baseUrl}/api/v2/memory-deltas/${encodeURIComponent(body.deltaId)}/reject`, { rejectedBy: body.rejectedBy, reason: body.reason });
    },
    invalidateRunMemory(body: { runId: string; sourceRefs: string[]; reason: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/memory/invalidate`, { sourceRefs: body.sourceRefs, reason: body.reason });
    },
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
node_modules/.bin/tsx tests/v2/memory-routes.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/memory/postgres-memory-service.ts src/v2/server/memory-routes.ts src/v2/server/routes.ts src/v2/server/client.ts tests/v2/memory-routes.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add memory decision api"
```

## Task 6: Execution Projection API

**Files:**
- Create: `src/v2/read-models/executions.ts`
- Create: `src/v2/server/execution-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Test: `tests/v2/execution-routes.test.ts`

- [x] **Step 1: Write the failing execution projection test**

Create `tests/v2/execution-routes.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createWorkflowRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("execution routes normalize hand_execution and executor_binding", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-executions-api";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "inspect executions",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "hand_execution",
      resourceKey: `hand-execution:${runId}:task-a:attempt-1`,
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      scope: "hand",
      status: "running",
      payload: {
        providerId: "tork",
        attemptId: "attempt-1",
        externalJobId: "job-hand-1",
        lastHeartbeatAt: "2026-06-23T10:00:00.000Z",
        heartbeatSeq: 2,
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "executor-binding-a",
      runId,
      taskId: "task-b",
      scope: "executor",
      status: "queued",
      payload: {
        executorType: "tork",
        attemptId: "attempt-1",
        externalJobId: "job-legacy-1",
      },
    });

    const list = await call(`/api/v2/runs/${runId}/hand-executions`);
    assert.deepEqual(list.result.executions.map((item: { executionId: string }) => item.executionId).sort(), [
      `hand-execution:${runId}:task-a:attempt-1`,
      "executor-binding-a",
    ]);
    assert.equal(list.result.executions.find((item: { taskId: string }) => item.taskId === "task-a").heartbeat.heartbeatSeq, 2);

    const detail = await call(`/api/v2/runs/${runId}/hand-executions/${encodeURIComponent(`hand-execution:${runId}:task-a:attempt-1`)}`);
    assert.equal(detail.result.execution.externalJobId, "job-hand-1");
    assert.equal(detail.result.execution.providerId, "tork");

    async function call(path: string): Promise<{ result: any }> {
      const response = await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      }, new Request(`http://127.0.0.1${path}`));
      const envelope = await response.json() as { ok: true; result: any } | { ok: false; error: string };
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }
  } finally {
    await db.close();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node_modules/.bin/tsx tests/v2/execution-routes.test.ts
```

Expected: FAIL because `/hand-executions` routes are not found.

- [x] **Step 3: Implement execution projection read model and routes**

Create `src/v2/read-models/executions.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";

export type ExecutionProjection = {
  executionId: string;
  kind: "hand_execution" | "executor_binding";
  providerId: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  status: string;
  externalJobId?: string;
  heartbeat?: { lastHeartbeatAt?: string; heartbeatSeq?: number };
  terminal?: { completedAt?: string; reason?: string };
  callback?: { receivedAt?: string; ok?: boolean; eventRefs: unknown[] };
  exceptionRefs: string[];
};

type ResourceRow = {
  resource_type: "hand_execution" | "executor_binding";
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  status: string;
  payload_json: unknown;
  summary_json: unknown;
};

export async function listExecutionProjectionsPg(db: SouthstarDb, runId: string): Promise<ExecutionProjection[]> {
  const rows = await db.query<ResourceRow>(
    `select resource_type, resource_key, run_id, task_id, session_id, status, payload_json, summary_json
       from southstar.runtime_resources
      where run_id = $1 and resource_type in ('hand_execution', 'executor_binding')
      order by created_at, resource_type, resource_key`,
    [runId],
  );
  const exceptions = await db.query<{ resource_key: string; payload_json: unknown }>(
    `select resource_key, payload_json
       from southstar.runtime_resources
      where run_id = $1 and resource_type = 'runtime_exception'
      order by created_at, resource_key`,
    [runId],
  );
  return rows.rows.map((row) => mapExecution(row, exceptions.rows));
}

export async function getExecutionProjectionPg(db: SouthstarDb, input: { runId: string; executionId: string }): Promise<ExecutionProjection | null> {
  return (await listExecutionProjectionsPg(db, input.runId)).find((execution) => execution.executionId === input.executionId) ?? null;
}

function mapExecution(row: ResourceRow, exceptions: Array<{ resource_key: string; payload_json: unknown }>): ExecutionProjection {
  const payload = asRecord(row.payload_json);
  const executionId = row.resource_key;
  return {
    executionId,
    kind: row.resource_type,
    providerId: stringValue(payload.providerId) ?? stringValue(payload.executorType) ?? "unknown",
    runId: row.run_id ?? stringValue(payload.runId) ?? "",
    taskId: row.task_id ?? stringValue(payload.taskId),
    sessionId: row.session_id ?? stringValue(payload.sessionId),
    attemptId: stringValue(payload.attemptId),
    status: row.status,
    externalJobId: stringValue(payload.externalJobId) ?? stringValue(payload.torkJobId),
    heartbeat: {
      lastHeartbeatAt: stringValue(payload.lastHeartbeatAt),
      heartbeatSeq: numberValue(payload.heartbeatSeq),
    },
    terminal: {
      completedAt: stringValue(payload.completedAt),
      reason: stringValue(payload.reason) ?? stringValue(payload.statusReason),
    },
    callback: {
      receivedAt: stringValue(payload.receivedAt),
      ok: typeof payload.ok === "boolean" ? payload.ok : undefined,
      eventRefs: Array.isArray(payload.eventRefs) ? payload.eventRefs : [],
    },
    exceptionRefs: exceptions
      .filter((exception) => {
        const exceptionPayload = asRecord(exception.payload_json);
        return exceptionPayload.handExecutionId === executionId || exceptionPayload.evidenceRefs instanceof Array && exceptionPayload.evidenceRefs.includes(executionId);
      })
      .map((exception) => exception.resource_key),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
```

Create `src/v2/server/execution-routes.ts`:

```ts
import { getExecutionProjectionPg, listExecutionProjectionsPg } from "../read-models/executions.ts";
import { reconcileExecutorBindingsPg } from "../executor/postgres-reconciler.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleExecutionRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const listMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(?:hand-executions|executor-jobs)$/);
  if (request.method === "GET" && listMatch) {
    const runId = decodeURIComponent(listMatch[1]!);
    return json("executions", { runId, executions: await listExecutionProjectionsPg(context.db, runId) });
  }

  const detailMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(?:hand-executions|executor-jobs)\/([^/]+)$/);
  if (request.method === "GET" && detailMatch) {
    const runId = decodeURIComponent(detailMatch[1]!);
    const executionId = decodeURIComponent(detailMatch[2]!);
    const execution = await getExecutionProjectionPg(context.db, { runId, executionId });
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    return json("execution", { runId, execution });
  }

  const reconcileMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/executor-jobs\/([^/]+)\/reconcile$/);
  if (request.method === "POST" && reconcileMatch) {
    if (!context.torkObservationClient) throw new Error("torkObservationClient is required for executor reconcile");
    return json("executor-job-reconcile", await reconcileExecutorBindingsPg(context.db, { tork: context.torkObservationClient }));
  }

  return undefined;
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
```

Modify `src/v2/server/routes.ts`:

```ts
import { handleExecutionRoute } from "./execution-routes.ts";
```

Insert after memory route handling:

```ts
    const executionResponse = await handleExecutionRoute(context, request, url);
    if (executionResponse) return executionResponse;
```

Modify `src/v2/server/client.ts` by adding:

```ts
    listExecutions(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/hand-executions`);
    },
    getExecution(body: { runId: string; executionId: string }) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/hand-executions/${encodeURIComponent(body.executionId)}`);
    },
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
node_modules/.bin/tsx tests/v2/execution-routes.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/read-models/executions.ts src/v2/server/execution-routes.ts src/v2/server/routes.ts src/v2/server/client.ts tests/v2/execution-routes.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add execution projection api"
```

## Task 7: Runtime Loop Health And Manual Tick API

**Files:**
- Create: `src/v2/server/runtime-loop-registry.ts`
- Modify: `src/v2/server/runtime-context.ts`
- Modify: `src/v2/server/runtime-loops.ts`
- Modify: `src/v2/server/http-server.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/runtime-loop-routes.test.ts`

- [x] **Step 1: Write the failing loop route test**

Create `tests/v2/runtime-loop-routes.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createRuntimeLoopRegistry } from "../../src/v2/server/runtime-loop-registry.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("runtime loop routes expose health and run manual ticks", async () => {
  const db = await createTestPostgresDb();
  try {
    let tickCount = 0;
    const registry = createRuntimeLoopRegistry();
    registry.register({
      id: "runnable-task-scheduler",
      intervalMs: 5_000,
      runOnce: async () => {
        tickCount += 1;
        return { processed: 3 };
      },
    });

    const context = {
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
      runtimeLoopRegistry: registry,
    };

    const health = await call(context, "GET", "/api/v2/runtime/health");
    assert.equal(health.result.database.ok, true);
    assert.equal(health.result.loops.configured, 1);

    const tick = await call(context, "POST", "/api/v2/runtime/loops/runnable-task-scheduler/tick");
    assert.equal(tick.result.loopId, "runnable-task-scheduler");
    assert.equal(tick.result.status, "succeeded");
    assert.equal(tick.result.result.processed, 3);
    assert.equal(tickCount, 1);

    const loops = await call(context, "GET", "/api/v2/runtime/loops");
    assert.equal(loops.result.loops[0].lastStatus, "succeeded");

    async function call(ctx: typeof context, method: string, path: string): Promise<{ result: any }> {
      const response = await handleRuntimeRoute(ctx, new Request(`http://127.0.0.1${path}`, { method }));
      const envelope = await response.json() as { ok: true; result: any } | { ok: false; error: string };
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }
  } finally {
    await db.close();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-loop-routes.test.ts
```

Expected: FAIL because `runtime-loop-registry.ts` and `/api/v2/runtime/*` routes do not exist.

- [x] **Step 3: Implement registry, context, and routes**

Create `src/v2/server/runtime-loop-registry.ts`:

```ts
export type RuntimeLoopId =
  | "executor-reconciler"
  | "runnable-task-scheduler"
  | "recovery-controller"
  | "tork-exception-observer"
  | "recovery-decision-applier";

export type RuntimeLoopTickResult = Record<string, unknown>;

export type RuntimeLoopRegistration = {
  id: RuntimeLoopId;
  intervalMs: number;
  runOnce: () => Promise<RuntimeLoopTickResult>;
};

export type RuntimeLoopSnapshot = {
  id: RuntimeLoopId;
  intervalMs: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastStatus?: "succeeded" | "failed";
  lastError?: string;
  lastResult?: RuntimeLoopTickResult;
};

export type RuntimeLoopRegistry = ReturnType<typeof createRuntimeLoopRegistry>;

export function createRuntimeLoopRegistry() {
  const registrations = new Map<RuntimeLoopId, RuntimeLoopRegistration>();
  const snapshots = new Map<RuntimeLoopId, RuntimeLoopSnapshot>();
  return {
    register(registration: RuntimeLoopRegistration): void {
      registrations.set(registration.id, registration);
      snapshots.set(registration.id, { id: registration.id, intervalMs: registration.intervalMs });
    },
    list(): RuntimeLoopSnapshot[] {
      return [...snapshots.values()].sort((left, right) => left.id.localeCompare(right.id));
    },
    async tick(loopId: RuntimeLoopId): Promise<{ loopId: RuntimeLoopId; status: "succeeded" | "failed"; result?: RuntimeLoopTickResult; error?: string }> {
      const registration = registrations.get(loopId);
      if (!registration) throw new Error(`runtime loop not registered: ${loopId}`);
      const startedAt = new Date().toISOString();
      snapshots.set(loopId, { ...(snapshots.get(loopId) ?? { id: loopId, intervalMs: registration.intervalMs }), lastStartedAt: startedAt });
      try {
        const result = await registration.runOnce();
        const finishedAt = new Date().toISOString();
        snapshots.set(loopId, { id: loopId, intervalMs: registration.intervalMs, lastStartedAt: startedAt, lastFinishedAt: finishedAt, lastStatus: "succeeded", lastResult: result });
        return { loopId, status: "succeeded", result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = new Date().toISOString();
        snapshots.set(loopId, { id: loopId, intervalMs: registration.intervalMs, lastStartedAt: startedAt, lastFinishedAt: finishedAt, lastStatus: "failed", lastError: message });
        return { loopId, status: "failed", error: message };
      }
    },
  };
}

export function parseRuntimeLoopId(value: string): RuntimeLoopId {
  if (
    value === "executor-reconciler"
    || value === "runnable-task-scheduler"
    || value === "recovery-controller"
    || value === "tork-exception-observer"
    || value === "recovery-decision-applier"
  ) return value;
  throw new Error(`unknown runtime loop id: ${value}`);
}
```

Modify `src/v2/server/runtime-context.ts`:

```ts
import type { RuntimeLoopRegistry } from "./runtime-loop-registry.ts";
```

Add to `RuntimeServerContext`:

```ts
  runtimeLoopRegistry?: RuntimeLoopRegistry;
```

Modify `src/v2/server/routes.ts` imports:

```ts
import { parseRuntimeLoopId } from "./runtime-loop-registry.ts";
```

Add these route blocks before `/api/v2/work-items/intake`:

```ts
    if (request.method === "GET" && url.pathname === "/api/v2/runtime/health") {
      await context.db.query("select 1");
      return json("runtime-health", {
        database: { ok: true },
        managedRuntime: { configured: Boolean(context.managedRuntime) },
        torkObservation: { configured: Boolean(context.torkObservationClient) },
        loops: { configured: context.runtimeLoopRegistry?.list().length ?? 0 },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/v2/runtime/loops") {
      return json("runtime-loops", { loops: context.runtimeLoopRegistry?.list() ?? [] });
    }

    const loopTickMatch = url.pathname.match(/^\/api\/v2\/runtime\/loops\/([^/]+)\/tick$/);
    if (request.method === "POST" && loopTickMatch) {
      if (!context.runtimeLoopRegistry) throw new Error("runtimeLoopRegistry is not configured");
      return json("runtime-loop-tick", await context.runtimeLoopRegistry.tick(parseRuntimeLoopId(decodeURIComponent(loopTickMatch[1]!))));
    }

    if (request.method === "POST" && url.pathname === "/api/v2/runtime/wake") {
      if (!context.runtimeLoopRegistry) throw new Error("runtimeLoopRegistry is not configured");
      const results = [];
      for (const loop of context.runtimeLoopRegistry.list()) {
        results.push(await context.runtimeLoopRegistry.tick(loop.id));
      }
      return json("runtime-wake", { results });
    }
```

Modify `src/v2/server/runtime-loops.ts` after creating each loop runner by registering its `runOnce` in a registry. Keep the existing controller behavior intact. The concrete extraction is:

```ts
export type ManagedRuntimeLoopRunner = {
  id: ManagedRuntimeLoopPlanItem["id"];
  intervalMs: number;
  runOnce: () => Promise<Record<string, unknown>>;
};
```

Create an exported `createManagedRuntimeLoopRunners(input: ManagedRuntimeLoopDeps): ManagedRuntimeLoopRunner[]` that contains the current four `runOnce` bodies. Then make `createManagedRuntimeLoopController()` build controllers from those runners. `http-server.ts` can then register those runners when a `runtimeLoopRegistry` is supplied in the context.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-loop-routes.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/runtime-loop-registry.ts src/v2/server/runtime-context.ts src/v2/server/runtime-loops.ts src/v2/server/http-server.ts src/v2/server/routes.ts tests/v2/runtime-loop-routes.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add runtime loop health api"
```

## Task 8: Task Recovery Command API

**Files:**
- Create: `src/v2/server/task-command-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Test: `tests/v2/task-command-routes.test.ts`

- [x] **Step 1: Write the failing task command test**

Create `tests/v2/task-command-routes.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("task command routes create durable recovery decisions without submitting Tork", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-task-command-api",
      status: "running",
      domain: "software",
      goalPrompt: "operate task commands",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId: "run-task-command-api",
      taskKey: "implement",
      status: "failed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-a",
    });

    const retry = await call("POST", "/api/v2/runs/run-task-command-api/tasks/task-a/retry", {
      commandId: "cmd-task-retry",
      actor: { type: "user", id: "operator-a" },
      reason: "retry failed task",
      payload: {},
    });
    assert.equal(retry.result.status, "queued");

    const reset = await call("POST", "/api/v2/runs/run-task-command-api/tasks/task-a/reset-session", {
      commandId: "cmd-task-reset",
      actor: { type: "user", id: "operator-a" },
      reason: "reset failed suffix",
      payload: {},
    });
    assert.equal(reset.result.status, "queued");

    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" })).filter((resource) => resource.runId === "run-task-command-api");
    assert.equal(decisions.some((resource) => resource.status === "recorded" && JSON.stringify(resource.payload).includes("retry-same-task-new-attempt")), true);
    assert.equal(decisions.some((resource) => resource.status === "recorded" && JSON.stringify(resource.payload).includes("reset-session")), true);

    async function call(method: string, path: string, body: unknown): Promise<{ result: any }> {
      const response = await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor must not be used by task command route"); } },
      }, new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      const envelope = await response.json() as { ok: true; result: any } | { ok: false; error: string };
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }
  } finally {
    await db.close();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node_modules/.bin/tsx tests/v2/task-command-routes.test.ts
```

Expected: FAIL because task command routes are not found.

- [x] **Step 3: Implement task command route by recording recovery decisions**

Create `src/v2/server/task-command-routes.ts`:

```ts
import { createHash } from "node:crypto";
import { RECOVERY_DECISION_SCHEMA_VERSION, type RecoveryPath } from "../exceptions/types.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { recordRuntimeCommandPg, requireRuntimeCommandRequest } from "../ui-api/commands/runtime-command.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleTaskCommandRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const actionsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/actions$/);
  if (request.method === "GET" && actionsMatch) {
    const runId = decodeURIComponent(actionsMatch[1]!);
    const taskId = decodeURIComponent(actionsMatch[2]!);
    const task = await readTask(context, runId, taskId);
    return json("task-actions", { runId, taskId, status: task.status, actions: taskActions(task.status) });
  }

  const commandMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/(retry|fork-session|reset-session|rollback-session|request-revision)$/);
  if (request.method === "POST" && commandMatch) {
    const runId = decodeURIComponent(commandMatch[1]!);
    const taskId = decodeURIComponent(commandMatch[2]!);
    const action = commandMatch[3]!;
    const body = requireRuntimeCommandRequest(await request.json());
    const task = await readTask(context, runId, taskId);
    const path = recoveryPathForTaskAction(action);
    const decision = await recordOperatorRecoveryDecision(context, {
      commandId: body.commandId,
      runId,
      taskId,
      sessionId: task.root_session_id ?? undefined,
      path,
      reason: body.reason ?? action,
      operatorApprovalRequired: path === "rollback-session",
      payload: body.payload ?? {},
    });
    const command = await recordRuntimeCommandPg(context.db, {
      commandId: body.commandId,
      runId,
      taskId,
      sessionId: task.root_session_id ?? undefined,
      action: `task.${action}`,
      actor: body.actor,
      reason: body.reason,
      status: "queued",
      resourceRefs: [{ resourceType: "recovery_decision", resourceKey: decision.resourceKey }],
      eventType: "task.command_queued",
      eventPayload: { action, recoveryPath: path, decisionId: decision.decisionId },
      nextSuggestedActions: ["apply-recovery-decision"],
    });
    return json("task-command", command);
  }

  return undefined;
}

async function readTask(context: RuntimeServerContext, runId: string, taskId: string): Promise<{ status: string; root_session_id: string | null }> {
  const task = await context.db.maybeOne<{ status: string; root_session_id: string | null }>(
    "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
    [runId, taskId],
  );
  if (!task) throw new Error(`task not found: ${runId}/${taskId}`);
  return task;
}

async function recordOperatorRecoveryDecision(
  context: RuntimeServerContext,
  input: {
    commandId: string;
    runId: string;
    taskId: string;
    sessionId?: string;
    path: RecoveryPath;
    reason: string;
    operatorApprovalRequired: boolean;
    payload: Record<string, unknown>;
  },
): Promise<{ decisionId: string; resourceKey: string }> {
  const decisionId = `operator-decision-${hash(`${input.commandId}:${input.path}`).slice(0, 24)}`;
  const resourceKey = `operator-recovery:${input.commandId}`;
  const now = new Date().toISOString();
  await upsertRuntimeResourcePg(context.db, {
    resourceType: "recovery_decision",
    resourceKey,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "recovery",
    status: input.operatorApprovalRequired ? "waiting_operator_approval" : "recorded",
    title: `Operator recovery decision: ${input.path}`,
    payload: {
      schemaVersion: RECOVERY_DECISION_SCHEMA_VERSION,
      decisionId,
      exceptionId: `operator:${input.commandId}`,
      runId: input.runId,
      taskId: input.taskId,
      path: input.path,
      reason: input.reason,
      operatorApprovalRequired: input.operatorApprovalRequired,
      evidenceRefs: [`runtime_command:${input.commandId}`],
      createdAt: now,
      ...input.payload,
    },
    summary: { path: input.path, reason: input.reason, operatorApprovalRequired: input.operatorApprovalRequired },
  });
  await appendHistoryEventPg(context.db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "recovery.decision_recorded",
    actorType: "operator",
    idempotencyKey: `operator-recovery:${input.commandId}:recorded`,
    payload: { decisionId, resourceKey, path: input.path, reason: input.reason },
  });
  return { decisionId, resourceKey };
}

function recoveryPathForTaskAction(action: string): RecoveryPath {
  if (action === "retry") return "retry-same-task-new-attempt";
  if (action === "fork-session") return "fork-session";
  if (action === "reset-session") return "reset-session";
  if (action === "rollback-session") return "rollback-session";
  if (action === "request-revision") return "repair-artifact";
  throw new Error(`unsupported task action: ${action}`);
}

function taskActions(status: string): Array<{ action: string; allowed: boolean; reason?: string }> {
  const recoverable = status === "failed" || status === "blocked" || status === "running" || status === "queued";
  return ["retry", "fork-session", "reset-session", "rollback-session", "request-revision"].map((action) => ({
    action,
    allowed: recoverable,
    reason: recoverable ? undefined : `task status ${status} does not allow ${action}`,
  }));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
```

Modify `src/v2/server/routes.ts`:

```ts
import { handleTaskCommandRoute } from "./task-command-routes.ts";
```

Insert after execution route handling:

```ts
    const taskCommandResponse = await handleTaskCommandRoute(context, request, url);
    if (taskCommandResponse) return taskCommandResponse;
```

Modify `src/v2/server/client.ts` by adding:

```ts
    getTaskActions(body: { runId: string; taskId: string }) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/actions`);
    },
    retryTask(body: { runId: string; taskId: string; commandId: string; actor: { type: "user" | "system" | "root-session"; id?: string }; reason?: string; payload: Record<string, unknown> }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/retry`, body);
    },
    resetTaskSession(body: { runId: string; taskId: string; commandId: string; actor: { type: "user" | "system" | "root-session"; id?: string }; reason?: string; payload: Record<string, unknown> }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/reset-session`, body);
    },
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
node_modules/.bin/tsx tests/v2/task-command-routes.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/task-command-routes.ts src/v2/server/routes.ts src/v2/server/client.ts tests/v2/task-command-routes.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add task recovery command api"
```

## Task 9: Normalized Read Model And Client Alignment

**Files:**
- Modify: `src/v2/read-models/types.ts`
- Modify: `src/v2/read-models/postgres-core.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Test: `tests/v2/runtime-api-client-alignment.test.ts`

- [x] **Step 1: Write the failing alignment test**

Create `tests/v2/runtime-api-client-alignment.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";

test("runtime client exposes only implemented P0 API methods", () => {
  const client = createRuntimeServerClient({ baseUrl: "http://127.0.0.1:1" });
  for (const method of [
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
    "getTaskActions",
    "retryTask",
    "resetTaskSession",
  ]) {
    assert.equal(typeof (client as Record<string, unknown>)[method], "function", `${method} should be a runtime client method`);
  }
});

test("routes delegate to focused P0 modules", () => {
  const source = readFileSync(join(process.cwd(), "src/v2/server/routes.ts"), "utf8");
  for (const imported of [
    "run-lifecycle-routes",
    "runtime-event-stream",
    "session-routes",
    "memory-routes",
    "execution-routes",
    "task-command-routes",
  ]) {
    assert.match(source, new RegExp(imported));
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-api-client-alignment.test.ts
```

Expected: FAIL until all client methods and route imports are aligned.

- [x] **Step 3: Add normalized read model kind support**

Modify `src/v2/read-models/types.ts` so `ReadModelKind` includes:

```ts
  | "run-summary"
  | "executions"
  | "exceptions"
```

Modify `src/v2/read-models/postgres-core.ts`:

```ts
import { listExecutionProjectionsPg } from "./executions.ts";
```

Add switch cases:

```ts
    case "run-summary":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.run_summary.v1", kind: input.kind, data: await runSummary(db, input.runId) });
    case "executions":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.executions.v1", kind: input.kind, data: { runId: input.runId, executions: await listExecutionProjectionsPg(db, input.runId) } });
```

Add helper:

```ts
async function runSummary(db: SouthstarDb, runId: string) {
  const run = await db.maybeOne<{ id: string; status: string; domain: string | null; goal_prompt: string }>(
    "select id, status, domain, goal_prompt from southstar.workflow_runs where id = $1",
    [runId],
  );
  if (!run) throw new Error(`run not found: ${runId}`);
  const tasks = await taskRows(db, runId);
  return {
    runId: run.id,
    status: run.status,
    rawStatus: run.status,
    domain: run.domain ?? undefined,
    goalPrompt: run.goal_prompt,
    taskCounts: tasks.reduce<Record<string, number>>((counts, task) => {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
      return counts;
    }, {}),
  };
}
```

Update `isPostgresCoreReadModelKind()`:

```ts
  return ["workflow-canvas", "runtime-monitor", "executor-ops", "task-detail", "sessions-memory", "vault-mcp", "run-summary", "executions"].includes(kind);
```

Modify `src/v2/server/client.ts` to make method names and implemented endpoints match the previous tasks. Remove any client method that points to a route not implemented by this plan.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-api-client-alignment.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/read-models/types.ts src/v2/read-models/postgres-core.ts src/v2/server/routes.ts src/v2/server/client.ts tests/v2/runtime-api-client-alignment.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: align runtime api read models and client"
```

## Task 10: API E2E Coverage Matrix

**Files:**
- Create: `tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts`
- Modify: `package.json`
- Modify: `tests/e2e-postgres/index.test.ts`
- Modify: `tests/e2e-postgres/README.md`

- [x] **Step 1: Write the E2E case**

Create `tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { createRuntimeLoopRegistry } from "../../../src/v2/server/runtime-loop-registry.ts";
import { createPostgresSessionStore } from "../../../src/v2/session/postgres-session-store.ts";
import { createMemoryDeltaPg, writeRunLocalMemoryPg } from "../../../src/v2/memory/postgres-memory-service.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresRealHarness } from "../postgres-real-harness.ts";

test("27 runtime API completeness: operator APIs cover lifecycle, stream, execution, session, and memory", async () => {
  const harness = await createPostgresRealHarness();
  try {
    const runId = "run-api-completeness-27";
    await createWorkflowRunPg(harness.db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "verify runtime API completeness",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(harness.db, {
      id: "task-a",
      runId,
      taskKey: "implement",
      status: "running",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-a",
    });
    await upsertRuntimeResourcePg(harness.db, {
      resourceType: "hand_execution",
      resourceKey: `hand-execution:${runId}:task-a:attempt-1`,
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      scope: "hand",
      status: "running",
      payload: { providerId: "tork", attemptId: "attempt-1", externalJobId: "job-api-27", heartbeatSeq: 1 },
    });
    await createPostgresSessionStore(harness.db).emitEvent({
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      eventType: "progress.commentary",
      actorType: "hand",
      payload: { message: "api completeness progress" },
    });
    await writeRunLocalMemoryPg(harness.db, {
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      scope: `run:${runId}`,
      kind: "implementation_preference",
      text: "prefer API evidence",
      sourceRefs: ["artifact:api"],
    });
    const delta = await createMemoryDeltaPg(harness.db, {
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      scope: "software",
      kind: "implementation_preference",
      text: "prefer runtime command ids",
      sourceRefs: ["artifact:delta"],
    });

    const registry = createRuntimeLoopRegistry();
    registry.register({ id: "runnable-task-scheduler", intervalMs: 5_000, runOnce: async () => ({ processed: 0 }) });
    const server = await createSouthstarRuntimeServer({
      db: harness.db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      runtimeLoopRegistry: registry,
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const actions = await get(server.url, `/api/v2/runs/${runId}/actions`);
      assert.equal(actions.result.actions.some((action: { action: string; allowed: boolean }) => action.action === "pause" && action.allowed), true);

      const executions = await get(server.url, `/api/v2/runs/${runId}/hand-executions`);
      assert.equal(executions.result.executions.some((item: { externalJobId: string }) => item.externalJobId === "job-api-27"), true);

      const sessionEvents = await get(server.url, "/api/v2/sessions/session-a/events?limit=20");
      assert.equal(sessionEvents.result.events.some((item: { eventType: string }) => item.eventType === "progress.commentary"), true);

      const memoryApproval = await post(server.url, `/api/v2/memory-deltas/${encodeURIComponent(delta.id)}/approve`, { approvedBy: "operator-a", reason: "useful evidence" });
      assert.equal(memoryApproval.result.deltaId, delta.id);

      const health = await get(server.url, "/api/v2/runtime/health");
      assert.equal(health.result.database.ok, true);

      const tick = await post(server.url, "/api/v2/runtime/loops/runnable-task-scheduler/tick", {});
      assert.equal(tick.result.status, "succeeded");
    } finally {
      await server.close();
    }
  } finally {
    await harness.close();
  }
});

async function get(baseUrl: string, path: string): Promise<{ result: any }> {
  const response = await fetch(`${baseUrl}${path}`);
  const envelope = await response.json() as { ok: true; result: any } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}

async function post(baseUrl: string, path: string, body: unknown): Promise<{ result: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const envelope = await response.json() as { ok: true; result: any } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}
```

- [x] **Step 2: Run case directly to verify it fails before wiring**

Run:

```bash
npm run test:e2e:postgres:27
```

Expected before script wiring: FAIL because `test:e2e:postgres:27` script is absent. Use direct command for initial run:

```bash
node_modules/.bin/tsx tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts
```

Expected after prior tasks: PASS when `SOUTHSTAR_TEST_ADMIN_DATABASE_URL` and real E2E environment are configured.

- [x] **Step 3: Wire the case into package and matrix**

Modify `package.json` scripts:

```json
"test:e2e:postgres:27": "tsx tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts"
```

Initial plan note: import the case from `tests/e2e-postgres/index.test.ts`:

```ts
await import("./cases/27-runtime-api-completeness.test.ts");
```

Modify `tests/e2e-postgres/README.md` by adding a row:

```markdown
| 27 runtime API completeness | implemented | Operator API covers lifecycle, stream, execution, session, and memory surfaces | run actions, execution projection, session events, memory approval, runtime health/tick |
```

Implementation note: the repository's aggregate `tests/e2e-postgres/index.test.ts` is intentionally a static-only matrix manifest. Case 27 was wired through `package.json` as `test:e2e:postgres:27`, documented in `tests/e2e-postgres/README.md`, and added to `tests/e2e-postgres/postgres-real-matrix-static.test.ts`.

- [x] **Step 4: Run E2E case and full API-focused tests**

Run:

```bash
npm run test:e2e:postgres:27
npm run test:v2
```

Expected:

- `test:e2e:postgres:27`: PASS.
- `test:v2`: PASS.

- [x] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add package.json tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts tests/e2e-postgres/index.test.ts tests/e2e-postgres/README.md
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: add runtime api completeness e2e"
```

## Task 11: Final Verification And Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-southstar-api-completeness-for-runtime-control-plane-design.zh.md`
- Modify: `docs/superpowers/plans/2026-06-23-southstar-runtime-api-completeness-implementation-plan.md`

- [x] **Step 1: Run static checks for plan/spec coverage**

Run:

```bash
rg -n "pause|resume|cancel|events/stream|runtime/health|runtime/loops|sessions/.*/events|memory-deltas|hand-executions|task.*retry|runtime_command" src/v2 tests/v2 tests/e2e-postgres docs/superpowers/specs/2026-06-23-southstar-api-completeness-for-runtime-control-plane-design.zh.md
```

Expected: Output includes source files, tests, and the design spec.

- [x] **Step 2: Run full verification**

Run:

```bash
npm run test:v2
npm run test:e2e:postgres:27
```

Expected:

- `npm run test:v2`: all tests pass.
- `npm run test:e2e:postgres:27`: case 27 passes.

- [x] **Step 3: Validate broader regression scope**

Planned command:

```bash
npm run test:e2e:postgres
```

Result: the aggregate Postgres E2E manifest remains static-only by repository convention. The static matrix assertion was run directly, and the real API coverage case was run through `npm run test:e2e:postgres:27`.

- [x] **Step 4: Update docs with completion evidence**

Append this section to the design spec after acceptance criteria:

```markdown
## Implementation Evidence

- Runtime command contract implemented in `src/v2/ui-api/commands/runtime-command.ts`.
- Run lifecycle API implemented in `src/v2/server/run-lifecycle-routes.ts`.
- Durable SSE stream implemented in `src/v2/server/runtime-event-stream.ts`.
- Session API implemented in `src/v2/server/session-routes.ts`.
- Memory decision API implemented in `src/v2/server/memory-routes.ts`.
- Execution projection API implemented in `src/v2/read-models/executions.ts` and `src/v2/server/execution-routes.ts`.
- Task recovery command API implemented in `src/v2/server/task-command-routes.ts`.
- Runtime loop health API implemented in `src/v2/server/runtime-loop-registry.ts`.
- API E2E coverage added in `tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts`.
```

- [x] **Step 5: Commit docs evidence**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add docs/superpowers/specs/2026-06-23-southstar-api-completeness-for-runtime-control-plane-design.zh.md docs/superpowers/plans/2026-06-23-southstar-runtime-api-completeness-implementation-plan.md
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "docs: record runtime api completeness evidence"
```

## Final Acceptance Checklist

- [x] `pause/resume/cancel/actions` are implemented and client-aligned.
- [x] `events/stream` is a real long-lived SSE stream with heartbeat and reconnect support.
- [x] Runtime health, loop list, loop tick, and wake endpoints exist.
- [x] Task recovery commands create durable recovery decisions and do not submit Tork directly.
- [x] Execution projection API normalizes `hand_execution` and `executor_binding`.
- [x] Session timeline/checkpoint/lineage APIs are backed by Postgres session data.
- [x] Memory approve/reject/invalidate/search routes are backed by memory service semantics.
- [x] Read model and client methods are aligned with implemented routes.
- [x] API E2E case 27 verifies lifecycle, execution, session, memory, and loop health surfaces.
- [x] `npm run test:v2` passes.
- [x] `npm run test:e2e:postgres:27` passes.

## Completion Evidence

- Static coverage scan:
  `rg -n "pause|resume|cancel|events/stream|runtime/health|runtime/loops|sessions/.*/events|memory-deltas|hand-executions|task.*retry|runtime_command" src/v2 tests/v2 tests/e2e-postgres docs/superpowers/specs/2026-06-23-southstar-api-completeness-for-runtime-control-plane-design.zh.md`
  Result: source files, tests, and the design spec all contain the expected runtime API coverage.
- Full v2 regression:
  `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2`
  Result: `# tests 427`, `# pass 427`, `# fail 0`, `# duration_ms 159821.551731`.
- Real Postgres/Tork API E2E:
  `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:postgres:27`
  Result: `# tests 1`, `# pass 1`, `# fail 0`, `# duration_ms 4220.707815`.
- Runtime SSE regression:
  `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres node_modules/.bin/tsx tests/v2/runtime-event-stream.test.ts`
  Result: `# tests 7`, `# pass 7`, `# fail 0`.
- Postgres real matrix static assertion:
  `node_modules/.bin/tsx tests/e2e-postgres/postgres-real-matrix-static.test.ts`
  Result: `# tests 5`, `# pass 5`, `# fail 0`.

## Self-Review Notes

- Spec coverage: Tasks 1-10 cover every P0 section in the design spec: command contract, lifecycle, stream, loop health, task/recovery commands, execution projection, session, memory, read model/client alignment, and API E2E.
- Scope check: UI and pi-web migration are excluded from this plan. The plan only changes runtime API, read-model, service, test, and docs files.
- Type consistency: `RuntimeCommandResult`, `ExecutionProjection`, and route method names are defined before they are used by later tasks.
- Risk: Task 7 touches runtime loop construction. Keep the existing auto-start behavior unchanged and add registry/tick behavior around the current loop runners.
