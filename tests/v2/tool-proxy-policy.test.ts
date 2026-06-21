import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../../src/v2/artifacts/types.ts";
import { createExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";
import { ingestTaskRunResultPg } from "../../src/v2/executor/postgres-tork-callback.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  assertNoRawCredentialPayloadPg,
  createToolProxyViolationPg,
  scanForCredentialLeak,
} from "../../src/v2/tool-proxy/policy-enforcer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("tool proxy policy scanner detects credential-shaped keys and tokens with redacted excerpts", () => {
  const githubToken = "ghp_123456789012345678901234567890123456";
  const keyFinding = scanForCredentialLeak({ env: { GITHUB_TOKEN: githubToken } });
  assert.equal(keyFinding?.reason, "raw_credential_in_envelope");
  assert.match(keyFinding?.redactedExcerpt ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(keyFinding?.redactedExcerpt ?? "", new RegExp(githubToken));

  const stringFinding = scanForCredentialLeak({ output: "configured github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ" });
  assert.equal(stringFinding?.reason, "raw_credential_in_envelope");
  assert.match(stringFinding?.redactedExcerpt ?? "", /\[REDACTED\]/);

  const openAiFinding = scanForCredentialLeak({ output: "new token sk-1234567890abcdefghijklmnopqrstuvwxyz" });
  assert.equal(openAiFinding?.reason, "raw_credential_in_envelope");
  assert.match(openAiFinding?.redactedExcerpt ?? "", /\[REDACTED\]/);

  assert.equal(scanForCredentialLeak({ output: "safe artifact", metadata: { status: "ok" } }), null);
});

test("tool proxy policy violation writes blocking security resource and history event", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-tool-policy", "task-1");
    const finding = scanForCredentialLeak({ env: { API_KEY: "sk-1234567890abcdefghijklmnopqrstuvwxyz" } });
    assert.ok(finding);

    const violation = await createToolProxyViolationPg(db, {
      runId: "run-tool-policy",
      taskId: "task-1",
      sessionId: "session-1",
      handExecutionId: "hand-exec-1",
      severity: "blocking",
      reason: finding.reason,
      evidenceRef: "test-envelope",
      redactedExcerpt: finding.redactedExcerpt,
    });

    const violations = await listResourcesPg(db, { resourceType: "tool_proxy_violation" });
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.id, violation.id);
    assert.equal(violations[0]?.status, "blocking");
    assert.equal(violations[0]?.scope, "security");
    assert.deepEqual(violations[0]?.summary, { reason: "raw_credential_in_envelope", severity: "blocking" });
    assert.equal((violations[0]?.payload as { schemaVersion?: string }).schemaVersion, "southstar.tool_proxy_violation.v1");
    assert.equal((violations[0]?.payload as { evidenceRef?: string }).evidenceRef, "test-envelope");

    const history = await listHistoryForRunPg(db, "run-tool-policy");
    const event = history.find((row) => row.eventType === "tool_proxy.violation");
    assert.ok(event);
    assert.equal(event.actorType, "tool-proxy");
    assert.equal((event.payload as { evidenceRef?: string }).evidenceRef, "test-envelope");
  });
});

test("raw credential assertion fails closed and persists a blocking callback violation", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-policy-assert", "task-1");

    await assert.rejects(
      () => assertNoRawCredentialPayloadPg(db, {
        runId: "run-policy-assert",
        taskId: "task-1",
        sessionId: "session-1",
        handExecutionId: "hand-exec-1",
        evidenceRef: "callback:run-policy-assert:task-1:attempt-1",
        value: { output: "returned token github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ" },
      }),
      /raw credential detected/i,
    );

    const violations = await listResourcesPg(db, { resourceType: "tool_proxy_violation" });
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.status, "blocking");
    assert.equal((violations[0]?.payload as { reason?: string }).reason, "callback_payload_leak");
    assert.doesNotMatch(JSON.stringify(violations[0]), /github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ/);
  });
});

test("callback artifact leak persists violation and does not write accepted artifact_ref", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-callback-policy-leak", "task-1");
    const leakedArtifact = {
      kind: "implementation_report",
      summary: "done",
      diagnostics: "raw credential sk-1234567890abcdefghijklmnopqrstuvwxyz",
    };

    await assert.rejects(
      () => ingestTaskRunResultPg(db, {
        runId: "run-callback-policy-leak",
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: true,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: leakedArtifact,
        metrics: {},
        events: [],
      }),
      /raw credential detected/i,
    );
    await assert.rejects(
      () => ingestTaskRunResultPg(db, {
        runId: "run-callback-policy-leak",
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: true,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: leakedArtifact,
        metrics: {},
        events: [],
      }),
      /raw credential detected/i,
    );

    const violations = await listResourcesPg(db, { resourceType: "tool_proxy_violation" });
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.status, "blocking");
    assert.equal((violations[0]?.payload as { reason?: string }).reason, "callback_payload_leak");
    assert.doesNotMatch(JSON.stringify(violations[0]), /sk-1234567890abcdefghijklmnopqrstuvwxyz/);

    const artifacts = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
    assert.equal(artifacts.length, 0);
    const task = await db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      ["run-callback-policy-leak", "task-1"],
    );
    assert.equal(task.status, "running");
  });
});

test("callback artifact without credentials is accepted", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-callback-policy-safe", "task-1");
    await createExecutorBindingPg(db, {
      runId: "run-callback-policy-safe",
      taskId: "task-1",
      attemptId: "attempt-1",
      torkJobId: "job-1",
      status: "running",
      now: "2026-06-21T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });

    const result = await ingestTaskRunResultPg(db, {
      runId: "run-callback-policy-safe",
      taskId: "task-1",
      rootSessionId: "session-1",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "done", filesChanged: ["src/index.ts"] },
      metrics: {},
      events: [],
    });

    assert.equal(result.accepted, true);
    const artifacts = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.status, "accepted");
    const violations = await listResourcesPg(db, { resourceType: "tool_proxy_violation" });
    assert.equal(violations.length, 0);
  });
});

async function seedRunTask(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "tool proxy policy",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-tool-proxy-policy" }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: "implement-feature",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-1",
  });
}

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const db = await createTestPostgresDb();
  try {
    await run(db);
  } finally {
    await db.close();
  }
}
