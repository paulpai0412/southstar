import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
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
    await controller.decide(await controller.classify(exception));

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
