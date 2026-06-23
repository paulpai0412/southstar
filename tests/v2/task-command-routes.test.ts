import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("task command routes create durable recovery decisions without submitting Tork", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-task-command-api";
    const taskId = "task-a";
    await createWorkflowRunPg(db, {
      id: runId,
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
      id: taskId,
      runId,
      taskKey: "implement",
      status: "failed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-a",
    });

    const actions = await call<{ runId: string; taskId: string; status: string; actions: Array<{ action: string; allowed: boolean }> }>(
      "GET",
      `/api/v2/runs/${runId}/tasks/${taskId}/actions`,
    );
    assert.equal(actions.kind, "task-actions");
    assert.equal(actions.result.status, "failed");
    assert.deepEqual(actions.result.actions.map((action) => [action.action, action.allowed]), [
      ["retry", true],
      ["fork-session", true],
      ["reset-session", true],
      ["rollback-session", true],
      ["request-revision", true],
    ]);

    const retry = await command("retry", "cmd-task-retry", "retry failed task");
    assert.equal(retry.result.status, "queued");
    assert.equal(retry.result.affectedTaskId, taskId);
    assert.equal(retry.result.affectedSessionId, "session-a");
    assert.deepEqual(retry.result.nextSuggestedActions, ["apply-recovery-decision"]);

    await command("fork-session", "cmd-task-fork", "fork from bad context");
    await command("reset-session", "cmd-task-reset", "reset failed suffix");
    const rollback = await command("rollback-session", "cmd-task-rollback", "rollback unsafe session", {
      checkpointId: "checkpoint-a",
      workspaceSnapshotRef: "workspace_snapshot:dirty",
      invalidatedSourceRefs: ["artifact_ref:bad-output"],
    });
    assert.equal(rollback.result.status, "queued");
    assert.deepEqual(rollback.result.nextSuggestedActions, ["approve-recovery-decision"]);
    const revision = await command("request-revision", "cmd-task-revision", "repair artifact", {
      revisionReason: "planner should revise workflow",
    });
    assert.deepEqual(revision.result.nextSuggestedActions, ["review-workflow-revision-request"]);

    const duplicateRetry = await command("retry", "cmd-task-retry", "duplicate retry");
    assert.equal(duplicateRetry.result.resourceRefs[0]?.resourceKey, retry.result.resourceRefs[0]?.resourceKey);

    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === runId)
      .sort((a, b) => String(a.payload.path).localeCompare(String(b.payload.path)));
    assert.deepEqual(decisions.map((resource) => [resource.status, resource.payload.path]), [
      ["recorded", "fork-session"],
      ["recorded", "reset-session"],
      ["recorded", "retry-same-task-new-attempt"],
      ["waiting_operator_approval", "rollback-session"],
    ]);
    assert.equal(decisions.every((resource) => resource.taskId === taskId && resource.sessionId === "session-a"), true);
    assert.equal(decisions.every((resource) => resource.payload.schemaVersion === "southstar.runtime.recovery_decision.v1"), true);
    assert.equal(decisions.find((resource) => resource.payload.path === "rollback-session")?.payload.operatorApprovalRequired, true);
    const rollbackDecision = decisions.find((resource) => resource.payload.path === "rollback-session");
    assert.equal(rollbackDecision?.payload.checkpointId, "checkpoint-a");
    assert.equal(rollbackDecision?.payload.workspaceSnapshotRef, "workspace_snapshot:dirty");
    assert.deepEqual(rollbackDecision?.payload.invalidatedSourceRefs, ["artifact_ref:bad-output"]);

    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" })).filter((resource) => resource.runId === runId);
    assert.equal(exceptions.length, 4);
    assert.equal(decisions.every((decision) => exceptions.some((exception) => exception.payload.exceptionId === decision.payload.exceptionId)), true);

    const revisionRequests = (await listResourcesPg(db, { resourceType: "workflow_revision_request" })).filter((resource) => resource.runId === runId);
    assert.equal(revisionRequests.length, 1);
    assert.equal(revisionRequests[0]?.status, "requested");
    assert.equal(revisionRequests[0]?.payload.reason, "planner should revise workflow");

    const events = await listHistoryForRunPg(db, runId);
    assert.equal(events.filter((event) => event.eventType === "recovery.decision_recorded").length, 4);
    assert.equal(events.filter((event) => event.eventType === "task.command_queued").length, 4);
    assert.equal(events.filter((event) => event.eventType === "task.revision_requested").length, 1);
    assert.deepEqual(events.slice(0, 3).map((event) => event.eventType), [
      "run.command_requested",
      "recovery.decision_recorded",
      "task.command_queued",
    ]);
    assert.equal(events.every((event) => event.taskId === taskId && event.sessionId === "session-a"), true);

    const commands = (await listResourcesPg(db, { resourceType: "runtime_command" })).filter((resource) => resource.runId === runId);
    assert.equal(commands.length, 5);
    assert.equal(commands.some((resource) => resource.status === "queued" && resource.payload.action === "task.rollback-session"), true);

    await createWorkflowTaskPg(db, {
      id: "task-completed",
      runId,
      taskKey: "done",
      status: "completed",
      sortOrder: 1,
      dependsOn: [],
      rootSessionId: "session-completed",
    });
    const blocked = await handleRuntimeRoute({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor must not be used by task command route"); } },
    }, new Request(`http://127.0.0.1/api/v2/runs/${runId}/tasks/task-completed/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-completed", actor: { type: "user", id: "operator-a" }, reason: "bad", payload: {} }),
    }));
    assert.equal(blocked.status, 400);
    assert.match(await blocked.text(), /task status completed does not allow retry/);

    async function command(action: string, commandId: string, reason: string, payload: Record<string, unknown> = { source: "test" }): Promise<{ ok: true; kind: string; result: any }> {
      return await call("POST", `/api/v2/runs/${runId}/tasks/${taskId}/${action}`, {
        commandId,
        actor: { type: "user", id: "operator-a" },
        reason,
        payload,
      });
    }

    async function call<T>(method: string, path: string, body?: unknown): Promise<{ ok: true; kind: string; result: T }> {
      const response = await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor must not be used by task command route"); } },
      }, new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
      const envelope = await response.json() as { ok: true; kind: string; result: T } | { ok: false; error: string };
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }
  } finally {
    await db.close();
  }
});

test("runtime server client exposes task recovery command API URLs", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, kind: "test", result: {} }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = createRuntimeServerClient({ baseUrl: "http://127.0.0.1/" });
    const body = {
      runId: "run/a",
      taskId: "task/a",
      commandId: "cmd/a",
      actor: { type: "user" as const, id: "operator-a" },
      reason: "operator action",
      payload: { source: "ui" },
    };
    await client.getTaskActions({ runId: "run/a", taskId: "task/a" });
    await client.retryTask(body);
    await client.forkTaskSession(body);
    await client.resetTaskSession(body);
    await client.rollbackTaskSession(body);
    await client.requestTaskRevision(body);

    const commandBody = {
      commandId: "cmd/a",
      actor: { type: "user", id: "operator-a" },
      reason: "operator action",
      payload: { source: "ui" },
    };
    assert.deepEqual(calls, [
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/tasks/task%2Fa/actions", body: undefined },
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/tasks/task%2Fa/retry", body: commandBody },
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/tasks/task%2Fa/fork-session", body: commandBody },
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/tasks/task%2Fa/reset-session", body: commandBody },
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/tasks/task%2Fa/rollback-session", body: commandBody },
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/tasks/task%2Fa/request-revision", body: commandBody },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
