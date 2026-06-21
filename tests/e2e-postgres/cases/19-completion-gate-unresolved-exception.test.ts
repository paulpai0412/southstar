import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import { acceptOrRejectArtifactRefPg } from "../../../src/v2/artifacts/artifact-ref-store.ts";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
import { resolveRuntimeExceptionPg } from "../../../src/v2/exceptions/postgres-runtime-exceptions.ts";
import { evaluateRunCompletionGatePg } from "../../../src/v2/evaluators/completion-gate.ts";
import { listHistoryForRunPg, listResourcesPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import { asRecord, canonicalHandExecutionId, seedHardeningRunTask } from "../runtime-hardening-fixtures.ts";

test("19 completion gate unresolved exception: gate fails until blocking exception is resolved", async () => {
  const harness = await createInitializedRealPostgresE2E();
  const runId = "real-completion-gate-unresolved-exception";
  const taskId = "task-a";
  const handExecutionId = canonicalHandExecutionId(runId, taskId, "attempt-1");
  try {
    await seedHardeningRunTask(harness.db, { runId, taskId, runStatus: "running", taskStatus: "completed" });
    await acceptOrRejectArtifactRefPg(harness.db, {
      runId,
      taskId,
      sessionId: `session-${runId}-${taskId}`,
      attemptId: "attempt-1",
      handExecutionId,
      producer: { actorType: "hand", providerId: "tork" },
      artifactType: "implementation_report",
      status: "accepted",
      content: { kind: "implementation_report", summary: "done" },
      contractRefs: [`task:${taskId}:completion`],
      summary: "accepted implementation report",
      evidenceRefs: [],
      evaluatorResultRefs: [],
      sourceEventRefs: ["source-event"],
    });

    const controller = createRuntimeExceptionController({ db: harness.db });
    const exception = await controller.observe({
      runId,
      taskId,
      sessionId: `session-${runId}-${taskId}`,
      handExecutionId,
      source: "tool-proxy",
      kind: "tool_proxy_violation",
      severity: "blocking",
      observedAt: "2026-06-21T11:10:00.000Z",
      evidenceRefs: [`${handExecutionId}:pre-execution`],
      providerEvidence: { phase: "pre-execution" },
    });
    await controller.decide(await controller.classify(exception));

    const blocked = await evaluateRunCompletionGatePg(harness.db, { runId });
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.findings.some((finding) => finding.includes("unresolved runtime exception")), true);
    const blockedResult = (await listResourcesPg(harness.db, { resourceType: "evaluator_result" }))
      .find((resource) => resource.resourceKey === `completion-gate:${runId}`);
    assert.equal(blockedResult?.status, "failed");
    assert.equal(asRecord(blockedResult?.summary).findingCount, blocked.findings.length);
    const afterBlocked = await harness.db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
    assert.equal(afterBlocked.status, "failed");

    await harness.db.query("update southstar.workflow_runs set status = 'running' where id = $1", [runId]);
    await resolveRuntimeExceptionPg(harness.db, {
      runId,
      resourceKey: exception.resourceKey,
      resolvedAt: "2026-06-21T11:12:00.000Z",
      reason: "operator acknowledged and cleared credential payload",
    });

    const passed = await evaluateRunCompletionGatePg(harness.db, { runId });
    assert.equal(passed.status, "passed");
    assert.deepEqual(passed.findings, []);
    const passedResult = (await listResourcesPg(harness.db, { resourceType: "evaluator_result" }))
      .find((resource) => resource.resourceKey === `completion-gate:${runId}`);
    assert.equal(passedResult?.status, "passed");
    assert.equal(asRecord(passedResult?.summary).findingCount, 0);
    const afterPassed = await harness.db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
    assert.equal(afterPassed.status, "passed");

    const historyTypes = (await listHistoryForRunPg(harness.db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.includes("runtime_exception.observed"), true);
    assert.equal(historyTypes.includes("runtime_exception.recovery_decided"), true);
    assert.equal(historyTypes.includes("runtime_exception.resolved"), true);
    assert.equal(historyTypes.filter((eventType) => eventType === "run.completed").length, 2);
  } finally {
    await harness.close();
  }
});
