import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
import { listHistoryForRunPg, listResourcesPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  canonicalHandExecutionId,
  createRuntimeServerWithoutBackgroundLoops,
  findRuntimeResource,
  getJson,
  seedHardeningRunTask,
} from "../runtime-hardening-fixtures.ts";

test("20 operator approved recovery path: rollback decision is marked approval-required for operators", async () => {
  const harness = await createInitializedRealPostgresE2E();
  const runId = "real-operator-approved-recovery";
  const taskId = "task-a";
  const handExecutionId = canonicalHandExecutionId(runId, taskId, "attempt-1");
  const server = await createRuntimeServerWithoutBackgroundLoops(harness.db);
  try {
    await seedHardeningRunTask(harness.db, { runId, taskId, runStatus: "running", taskStatus: "running" });
    const controller = createRuntimeExceptionController({ db: harness.db });
    const exception = await controller.observe({
      runId,
      taskId,
      sessionId: `session-${runId}-${taskId}`,
      attemptId: "attempt-1",
      handExecutionId,
      source: "tork-observer",
      kind: "tork_running_hang",
      severity: "recoverable",
      observedAt: "2026-06-21T11:20:00.000Z",
      evidenceRefs: ["workspace-snapshot:dirty"],
      providerEvidence: { workspaceUnsafe: true },
    });
    await controller.decide(await controller.classify(exception));

    const decisions = await listResourcesPg(harness.db, { resourceType: "recovery_decision" });
    const decision = findRuntimeResource(decisions, (resource) => resource.payload.exceptionId === exception.exceptionId);
    assert.equal(decision.payload.path, "rollback-workspace");
    assert.equal(decision.payload.operatorApprovalRequired, true);
    assert.equal(decision.status, "waiting_operator_approval");

    const readModel = await getJson<{
      runId: string;
      exceptions: Array<{ resourceKey: string; kind?: string; handExecutionId?: string }>;
      recoveryDecisions: Array<{ resourceKey: string; path?: string; operatorApprovalRequired?: boolean; exceptionId?: string }>;
    }>(server.url, `/api/v2/runs/${encodeURIComponent(runId)}/exceptions`);

    assert.equal(readModel.runId, runId);
    assert.equal(readModel.exceptions.some((item) => item.resourceKey === exception.resourceKey && item.kind === "tork_running_hang"), true);
    assert.equal(readModel.recoveryDecisions.some((item) => (
      item.exceptionId === exception.exceptionId
      && item.path === "rollback-workspace"
      && item.operatorApprovalRequired === true
    )), true);

    const historyTypes = (await listHistoryForRunPg(harness.db, runId)).map((event) => event.eventType);
    assert.deepEqual(historyTypes, ["runtime_exception.observed", "runtime_exception.recovery_decided"]);
  } finally {
    await server.close();
    await harness.close();
  }
});
