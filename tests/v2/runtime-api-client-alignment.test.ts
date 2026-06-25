import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("runtime server client exposes P0 runtime API methods", () => {
  const client = createRuntimeServerClient({ baseUrl: "http://127.0.0.1/" });
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
    "getPlannerDraftOrchestration",
    "createRunFromPlannerDraft",
    "listPlannerDraftProposals",
    "approvePlannerDraftProposal",
    "rejectPlannerDraftProposal",
    "convertPlannerDraftProposalToLibraryDraft",
  ] as const;

  for (const method of methods) {
    assert.equal(typeof client[method], "function", `${method} should be exposed by RuntimeServerClient`);
  }
});

test("generic read-model API routes core kinds including run control and workflow dag", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-runtime-api-client-alignment";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "align runtime API read models",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId,
      taskKey: "plan",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
    });
    await createWorkflowTaskPg(db, {
      id: "task-b",
      runId,
      taskKey: "implement",
      status: "running",
      sortOrder: 1,
      dependsOn: ["task-a"],
    });
    await createWorkflowTaskPg(db, {
      id: "task-c",
      runId,
      taskKey: "verify",
      status: "queued",
      sortOrder: 2,
      dependsOn: ["task-b"],
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "hand_execution",
      resourceKey: `hand-execution:${runId}:task-b:attempt-1`,
      runId,
      taskId: "task-b",
      sessionId: "session-b",
      scope: "hand",
      status: "running",
      payload: {
        providerId: "tork",
        attemptId: "attempt-1",
        externalJobId: "job-b",
        lastHeartbeatAt: "2026-06-23T10:00:00.000Z",
        heartbeatSeq: 3,
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-b",
      runId,
      taskId: "task-b",
      scope: "runtime",
      status: "observed",
      payload: {
        kind: "tork_running_hang",
        severity: "recoverable",
        source: "tork-observer",
        handExecutionId: `hand-execution:${runId}:task-b:attempt-1`,
        observedAt: "2026-06-23T10:01:00.000Z",
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: `artifact_ref:${runId}:task-a:attempt-1:hash`,
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      scope: "artifact",
      status: "accepted",
      payload: {},
    });

    const summary = await call<{ schemaVersion: string; kind: string; data: { runId: string; status: string; rawStatus: string; domain?: string; goalPrompt: string; taskCounts: Record<string, number> } }>(
      db,
      `/api/v2/read-models/run-summary/${runId}`,
    );
    assert.equal(summary.result.schemaVersion, "southstar.read_model.run_summary.v1");
    assert.equal(summary.result.kind, "run-summary");
    assert.equal(summary.result.data.runId, runId);
    assert.equal(summary.result.data.status, "running");
    assert.equal(summary.result.data.rawStatus, "running");
    assert.equal(summary.result.data.domain, "software");
    assert.equal(summary.result.data.goalPrompt, "align runtime API read models");
    assert.deepEqual(summary.result.data.taskCounts, { completed: 1, queued: 1, running: 1 });

    const executions = await call<{ schemaVersion: string; kind: string; data: { runId: string; executions: Array<{ executionId: string; taskId?: string; status: string }> } }>(
      db,
      `/api/v2/read-models/executions/${runId}`,
    );
    assert.equal(executions.result.schemaVersion, "southstar.read_model.executions.v1");
    assert.equal(executions.result.kind, "executions");
    assert.equal(executions.result.data.runId, runId);
    assert.deepEqual(executions.result.data.executions.map((execution) => execution.executionId), [`hand-execution:${runId}:task-b:attempt-1`]);
    assert.equal(executions.result.data.executions[0]?.taskId, "task-b");
    assert.equal(executions.result.data.executions[0]?.status, "running");

    const exceptions = await call<{ schemaVersion: string; kind: string; data: { runId: string; exceptions: Array<{ resourceKey: string; kind?: string; handExecutionId?: string }> } }>(
      db,
      `/api/v2/read-models/exceptions/${runId}`,
    );
    assert.equal(exceptions.result.schemaVersion, "southstar.read_model.exceptions.v1");
    assert.equal(exceptions.result.kind, "exceptions");
    assert.equal(exceptions.result.data.runId, runId);
    assert.deepEqual(exceptions.result.data.exceptions, [{
      resourceKey: "runtime-exception-b",
      status: "observed",
      kind: "tork_running_hang",
      severity: "recoverable",
      source: "tork-observer",
      taskId: "task-b",
      handExecutionId: `hand-execution:${runId}:task-b:attempt-1`,
      observedAt: "2026-06-23T10:01:00.000Z",
    }]);

    const legacyExceptions = await call<{ runId: string; exceptions: Array<{ resourceKey: string }> }>(
      db,
      `/api/v2/runs/${runId}/exceptions`,
    );
    assert.equal(legacyExceptions.kind, "runtime-exceptions");
    assert.equal(legacyExceptions.result.runId, runId);
    assert.deepEqual(legacyExceptions.result.exceptions.map((exception) => exception.resourceKey), ["runtime-exception-b"]);

    const runControl = await call<{
      schemaVersion: string;
      kind: string;
      scope: { runId: string; domain?: string };
      data: { runId: string; status: string; taskCounts: Record<string, number>; unresolvedExceptionCount: number };
      commands: Array<{ id: string; enabled: boolean }>;
      attentionItems: Array<{ id: string }>;
      sourceRefs: Array<{ id: string; ref: string }>;
    }>(
      db,
      `/api/v2/read-models/run-control/${runId}`,
    );
    assert.equal(runControl.result.schemaVersion, "southstar.read_model.run_control.v1");
    assert.equal(runControl.result.kind, "run-control");
    assert.equal(runControl.result.scope.runId, runId);
    assert.equal(runControl.result.data.runId, runId);
    assert.equal(runControl.result.data.status, "running");
    assert.deepEqual(runControl.result.data.taskCounts, { completed: 1, queued: 1, running: 1 });
    assert.equal(runControl.result.data.unresolvedExceptionCount, 1);
    assert.ok(runControl.result.commands.some((command) => command.id === "pause-run" && command.enabled));
    assert.ok(runControl.result.attentionItems.some((item) => item.id === "exception:runtime-exception-b"));
    assert.ok(runControl.result.sourceRefs.some((ref) => ref.ref === `southstar.workflow_runs:${runId}`));

    const workflowDag = await call<{
      schemaVersion: string;
      kind: string;
      data: { runId: string; nodes: Array<{ id: string; dependencyReady: boolean }>; edges: Array<{ source: string; target: string }> };
    }>(
      db,
      `/api/v2/read-models/workflow-dag/${runId}`,
    );
    assert.equal(workflowDag.result.schemaVersion, "southstar.read_model.workflow_dag.v1");
    assert.equal(workflowDag.result.kind, "workflow-dag");
    assert.equal(workflowDag.result.data.runId, runId);
    assert.equal(workflowDag.result.data.nodes.find((node) => node.id === "task-b")?.dependencyReady, true);
    assert.equal(workflowDag.result.data.nodes.find((node) => node.id === "task-c")?.dependencyReady, false);
    assert.deepEqual(workflowDag.result.data.edges, [
      { source: "task-a", target: "task-b" },
      { source: "task-b", target: "task-c" },
    ]);
  } finally {
    await db.close();
  }
});

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
    await client.createPlannerDraft({
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      composerMode: "fixture",
      scope: "research",
    });
    await client.runGoal({
      goalPrompt: "implement calc sum",
      orchestrationMode: "deterministic",
      composerMode: "llm",
      scope: "software",
    });
    await client.getPlannerDraftOrchestration("draft/a");
    await client.createRunFromPlannerDraft("draft/a");
    await client.listPlannerDraftProposals("draft/a");
    await client.approvePlannerDraftProposal({
      draftId: "draft/a",
      proposalId: "proposal/a",
      actorId: "operator-a",
      reason: "approve proposal",
    });
    await client.rejectPlannerDraftProposal({
      draftId: "draft/a",
      proposalId: "proposal/b",
      actorId: "operator-a",
      reason: "reject proposal",
    });
    await client.convertPlannerDraftProposalToLibraryDraft({
      draftId: "draft/a",
      proposalId: "proposal/a",
      actorId: "operator-a",
      reason: "convert proposal",
    });
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
      {
        url: "http://127.0.0.1/api/v2/planner/drafts",
        method: "POST",
        body: { goalPrompt: "implement calc sum", orchestrationMode: "llm-constrained", composerMode: "fixture", scope: "research" },
      },
      {
        url: "http://127.0.0.1/api/v2/run-goal",
        method: "POST",
        body: { goalPrompt: "implement calc sum", orchestrationMode: "deterministic", composerMode: "llm", scope: "software" },
      },
      { url: "http://127.0.0.1/api/v2/planner/drafts/draft%2Fa/orchestration", method: undefined, body: undefined },
      { url: "http://127.0.0.1/api/v2/planner/drafts/draft%2Fa/runs", method: "POST", body: {} },
      { url: "http://127.0.0.1/api/v2/planner/drafts/draft%2Fa/proposals", method: undefined, body: undefined },
      {
        url: "http://127.0.0.1/api/v2/planner/drafts/draft%2Fa/proposals/proposal%2Fa/approve",
        method: "POST",
        body: { actorId: "operator-a", reason: "approve proposal" },
      },
      {
        url: "http://127.0.0.1/api/v2/planner/drafts/draft%2Fa/proposals/proposal%2Fb/reject",
        method: "POST",
        body: { actorId: "operator-a", reason: "reject proposal" },
      },
      {
        url: "http://127.0.0.1/api/v2/planner/drafts/draft%2Fa/proposals/proposal%2Fa/convert-to-library-draft",
        method: "POST",
        body: { actorId: "operator-a", reason: "convert proposal" },
      },
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

async function call<T>(db: Parameters<typeof handleRuntimeRoute>[0]["db"], path: string): Promise<{ ok: true; kind: string; result: T }> {
  const response = await handleRuntimeRoute({
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
  }, new Request(`http://127.0.0.1${path}`));
  const envelope = await response.json() as { ok: true; kind: string; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}
