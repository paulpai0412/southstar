import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { enforcePreExecutionToolProxyPolicyPg } from "../../src/v2/tool-proxy/runtime-enforcement.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("pre-execution tool proxy enforcement records blocking runtime exception without raw credential evidence", async () => {
  const db = await createTestPostgresDb();
  const runId = "run-tool-proxy-pre-execution";
  const taskId = "task-a";
  const sessionId = "session-a";
  const handExecutionId = "hand-execution:run-tool-proxy-pre-execution:task-a:task-a-attempt-1";
  const rawToken = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  try {
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "enforce full-path tool proxy policy",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    await assert.rejects(
      () => enforcePreExecutionToolProxyPolicyPg(db, {
        runId,
        taskId,
        sessionId,
        handExecutionId,
        value: { env: { GITHUB_TOKEN: rawToken } },
      }),
      /raw credential payload/i,
    );

    const violations = (await listResourcesPg(db, { resourceType: "tool_proxy_violation" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.payload.reason, "callback_payload_leak");
    assert.equal(violations[0]?.payload.severity, "blocking");
    assert.equal(violations[0]?.payload.evidenceRef, `${handExecutionId}:pre-execution`);
    assert.doesNotMatch(JSON.stringify(violations[0]), new RegExp(rawToken));

    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "tool_proxy_violation");
    assert.equal(exceptions[0]?.payload.severity, "blocking");
    assert.equal(exceptions[0]?.payload.source, "tool-proxy");
    assert.equal(exceptions[0]?.payload.handExecutionId, handExecutionId);
    assert.deepEqual(exceptions[0]?.payload.evidenceRefs, [`${handExecutionId}:pre-execution`]);
    assert.doesNotMatch(JSON.stringify(exceptions[0]?.payload.providerEvidence), new RegExp(rawToken));
    assert.match(JSON.stringify(exceptions[0]?.payload.providerEvidence), /raw credential payload/i);

    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.payload.exceptionId, exceptions[0]?.payload.exceptionId);
    assert.equal(decisions[0]?.payload.path, "block-for-operator");
  } finally {
    await db.close();
  }
});
