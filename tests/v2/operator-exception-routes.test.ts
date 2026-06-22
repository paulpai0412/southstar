import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("GET /api/v2/runs/:runId/exceptions returns safe exception and recovery decision fields", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-exception-route";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "inspect runtime exceptions",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: `hand-execution:${runId}:task-a:attempt-1`,
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T10:01:30.000Z",
      evidenceRefs: [`hand-execution:${runId}:task-a:attempt-1`],
      providerEvidence: { externalJobId: "job-secret", rawProviderPayload: "do-not-return" },
    });
    const decision = await controller.decide(await controller.classify(exception));

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/runs/${encodeURIComponent(runId)}/exceptions`);
      assert.equal(response.status, 200);
      const responseBody = await response.text();
      assert.equal(responseBody.includes("job-secret"), false);
      assert.equal(responseBody.includes("rawProviderPayload"), false);
      assert.equal(responseBody.includes("do-not-return"), false);
      const envelope = JSON.parse(responseBody) as {
        ok: true;
        kind: string;
        result: {
          runId: string;
          exceptions: Array<Record<string, unknown>>;
          recoveryDecisions: Array<Record<string, unknown>>;
          recoveryExecutions: Array<Record<string, unknown>>;
        };
      };

      assert.equal(envelope.ok, true);
      assert.equal(envelope.kind, "runtime-exceptions");
      assert.equal(envelope.result.runId, runId);
      assert.equal(envelope.result.exceptions.length, 1);
      assert.equal(envelope.result.exceptions[0]?.resourceKey, exception.resourceKey);
      assert.equal(envelope.result.exceptions[0]?.status, "observed");
      assert.equal(envelope.result.exceptions[0]?.kind, "tork_queue_timeout");
      assert.equal(envelope.result.exceptions[0]?.severity, "recoverable");
      assert.equal(envelope.result.exceptions[0]?.source, "tork-observer");
      assert.equal(envelope.result.exceptions[0]?.taskId, "task-a");
      assert.equal(envelope.result.exceptions[0]?.handExecutionId, `hand-execution:${runId}:task-a:attempt-1`);
      assert.equal(envelope.result.exceptions[0]?.observedAt, "2026-06-21T10:01:30.000Z");
      assert.equal("providerEvidence" in envelope.result.exceptions[0]!, false);

      assert.equal(envelope.result.recoveryDecisions.length, 1);
      assert.equal(envelope.result.recoveryDecisions[0]?.status, "recorded");
      assert.equal(envelope.result.recoveryDecisions[0]?.path, "requeue-hand-execution");
      assert.equal(envelope.result.recoveryDecisions[0]?.exceptionId, exception.exceptionId);
      assert.equal(envelope.result.recoveryDecisions[0]?.operatorApprovalRequired, false);

      await upsertRuntimeResourcePg(db, {
        resourceType: "recovery_execution",
        resourceKey: `recovery_execution:${decision.decisionId}:attempt-1`,
        runId,
        taskId: "task-a",
        scope: "recovery",
        status: "succeeded",
        title: "requeue-hand-execution recovery execution",
        payload: {
          schemaVersion: "southstar.runtime.recovery_execution.v1",
          executionId: `recovery_execution:${decision.decisionId}:attempt-1`,
          decisionId: decision.decisionId,
          exceptionId: exception.exceptionId,
          runId,
          taskId: "task-a",
          path: "requeue-hand-execution",
          status: "succeeded",
          stateChanges: [{
            resourceType: "hand_execution",
            resourceKey: "secret-hand-resource",
            fromStatus: "running",
            toStatus: "lost",
            reason: "recovery",
          }],
          providerActions: [{
            providerId: "tork",
            action: "cancel",
            status: "failed",
            evidenceRef: "secret-execution-evidence",
            errorExcerpt: "token=secret-value",
            metadata: { raw: "do-not-return-execution-metadata" },
          }],
          createdAt: "2026-06-21T10:02:00.000Z",
          completedAt: "2026-06-21T10:02:10.000Z",
        },
        summary: {
          decisionId: decision.decisionId,
          exceptionId: exception.exceptionId,
          path: "requeue-hand-execution",
          stateChangeCount: 1,
          providerActionCount: 1,
        },
      });

      const executionResponse = await fetch(`${server.url}/api/v2/runs/${encodeURIComponent(runId)}/exceptions`);
      assert.equal(executionResponse.status, 200);
      const executionResponseBody = await executionResponse.text();
      assert.equal(executionResponseBody.includes("job-secret"), false);
      assert.equal(executionResponseBody.includes("rawProviderPayload"), false);
      assert.equal(executionResponseBody.includes("do-not-return"), false);
      assert.equal(executionResponseBody.includes("providerActions"), false);
      assert.equal(executionResponseBody.includes("stateChanges"), false);
      assert.equal(executionResponseBody.includes("secret-execution-evidence"), false);
      assert.equal(executionResponseBody.includes("token=secret-value"), false);
      assert.equal(executionResponseBody.includes("do-not-return-execution-metadata"), false);
      assert.equal(executionResponseBody.includes("secret-hand-resource"), false);
      const executionEnvelope = JSON.parse(executionResponseBody) as typeof envelope;
      assert.equal(executionEnvelope.result.recoveryExecutions.length, 1);
      assert.equal(executionEnvelope.result.recoveryExecutions[0]?.status, "succeeded");
      assert.equal(executionEnvelope.result.recoveryExecutions[0]?.decisionId, decision.decisionId);
      assert.equal(executionEnvelope.result.recoveryExecutions[0]?.exceptionId, exception.exceptionId);
      assert.equal(executionEnvelope.result.recoveryExecutions[0]?.path, "requeue-hand-execution");
      assert.equal(executionEnvelope.result.recoveryExecutions[0]?.taskId, "task-a");
      assert.equal(executionEnvelope.result.recoveryExecutions[0]?.providerActionCount, 1);
      assert.equal(executionEnvelope.result.recoveryExecutions[0]?.stateChangeCount, 1);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

test("GET /api/v2/runs/:runId/exceptions returns an error envelope for missing runs", async () => {
  const db = await createTestPostgresDb();
  try {
    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/runs/missing-run/exceptions`);
      assert.notEqual(response.status, 200);
      const envelope = await response.json() as { ok: false; error: string };
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error, "run not found: missing-run");
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});
