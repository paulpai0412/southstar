import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { openSouthstarDb } from "../../src/v2/db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../../src/v2/artifacts/types.ts";
import { createExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";
import { ingestTaskRunResultPg, type PostgresTaskRunCallbackResult } from "../../src/v2/executor/postgres-tork-callback.ts";
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

test("tool proxy policy scanner treats credential URL query keys as secrets even for short values", () => {
  for (const key of ["token", "access_token", "api_key", "password", "secret"]) {
    const finding = scanForCredentialLeak({ url: `https://example.test/result?${key}=x&view=summary` });
    assert.equal(finding?.reason, "raw_credential_in_envelope", key);
    assert.doesNotMatch(finding?.redactedExcerpt ?? "", new RegExp(`${key}=x`));
  }
  assert.equal(scanForCredentialLeak({ url: "https://example.test/result?view=summary" }), null);
});

test("tool proxy policy scanner rejects credential URL fragments", () => {
  for (const url of [
    "https://example.test/callback#access_token=x&state=ok",
    "https://example.test/callback#/done?access_token=x",
    "https://user:password@example.test/callback#state=ok",
    "https://example.test/callback#https://redirect.test/?api_key=x",
  ]) {
    const finding = scanForCredentialLeak({ url });
    assert.equal(finding?.reason, "raw_credential_in_envelope", url);
    assert.doesNotMatch(finding?.redactedExcerpt ?? "", /access_token=x|password|api_key=x/);
  }
});

test("tool proxy policy scanner recursively rejects credentials in nested URL parameter values", () => {
  for (const url of [
    "https://example.test/callback?redirect=https%3A%2F%2Fuser%3Apassword%40private.test",
    "https://example.test/callback?next=https%3A%2F%2Fprivate.test%2Fdone%3Faccess_token%3Dx",
    "https://example.test/callback#redirect=https%3A%2F%2Fprivate.test%2Fdone%3Fapi_key%3Dx",
  ]) {
    const finding = scanForCredentialLeak({ url });
    assert.equal(finding?.reason, "raw_credential_in_envelope", url);
    assert.doesNotMatch(finding?.redactedExcerpt ?? "", /password|access_token=x|api_key=x/);
  }
});

test("tool proxy policy redacts entire sensitive-key subtrees before excerpt persistence", () => {
  const nestedSecret = "raw-secret-not-matching-common-token-regex";
  const finding = scanForCredentialLeak({
    env: {
      GITHUB_TOKEN: {
        value: nestedSecret,
        metadata: { source: "vault", nested: ["keep out"] },
      },
    },
  });

  assert.equal(finding?.reason, "raw_credential_in_envelope");
  assert.match(finding?.redactedExcerpt ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(finding?.redactedExcerpt ?? "", new RegExp(nestedSecret));
  assert.doesNotMatch(finding?.redactedExcerpt ?? "", /keep out/);
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

test("tool proxy policy violation writes are idempotent under concurrent duplicate attempts", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-tool-policy-concurrent", "task-1");
    const finding = scanForCredentialLeak({ env: { API_KEY: "sk-1234567890abcdefghijklmnopqrstuvwxyz" } });
    assert.ok(finding);
    const input = {
      runId: "run-tool-policy-concurrent",
      taskId: "task-1",
      sessionId: "session-1",
      handExecutionId: "hand-exec-1",
      severity: "blocking" as const,
      reason: finding.reason,
      evidenceRef: "duplicate-envelope",
      redactedExcerpt: finding.redactedExcerpt,
    };
    const firstDb = await openSouthstarDb((db as SouthstarDb & { databaseUrl: string }).databaseUrl);
    const secondDb = await openSouthstarDb((db as SouthstarDb & { databaseUrl: string }).databaseUrl);
    try {
      const [first, second] = await Promise.all([
        createToolProxyViolationPg(firstDb, input),
        createToolProxyViolationPg(secondDb, input),
      ]);

      assert.equal(first.id, second.id);
    } finally {
      await firstDb.close();
      await secondDb.close();
    }
    const violations = await listResourcesPg(db, { resourceType: "tool_proxy_violation" });
    assert.equal(violations.length, 1);
    const history = await listHistoryForRunPg(db, "run-tool-policy-concurrent");
    assert.equal(history.filter((row) => row.eventType === "tool_proxy.violation").length, 1);
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

test("callback event payload leak is rejected before history or artifact persistence", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-callback-policy-event-leak", "task-1");
    await createExecutorBindingPg(db, {
      runId: "run-callback-policy-event-leak",
      taskId: "task-1",
      attemptId: "attempt-1",
      torkJobId: "job-1",
      status: "running",
      now: "2026-06-21T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });
    const leakedSecret = "ghp_123456789012345678901234567890123456";

    await assert.rejects(
      () => ingestTaskRunResultPg(db, {
        runId: "run-callback-policy-event-leak",
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: true,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", summary: "safe artifact" },
        metrics: {},
        events: [{
          eventType: "session.entry",
          actorType: "root-session",
          sessionId: "session-1",
          payload: { message: `leaked ${leakedSecret}` },
        }],
      }),
      /raw credential detected/i,
    );

    const violations = await listResourcesPg(db, { resourceType: "tool_proxy_violation" });
    assert.equal(violations.length, 1);
    assert.equal((violations[0]?.payload as { evidenceRef?: string }).evidenceRef, "hand-execution:run-callback-policy-event-leak:task-1:attempt-1:events[0].payload");
    assert.doesNotMatch(JSON.stringify(violations[0]), new RegExp(leakedSecret));

    const artifacts = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
    assert.equal(artifacts.length, 0);
    const history = await listHistoryForRunPg(db, "run-callback-policy-event-leak");
    assert.equal(history.some((row) => row.eventType === "session.entry"), false);
    assert.equal(history.some((row) => row.eventType === "executor.callback_received"), false);
    assert.doesNotMatch(JSON.stringify(history), new RegExp(leakedSecret));
  });
});

test("callback metrics leak is rejected before history or artifact persistence", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-callback-policy-metrics-leak", "task-1");
    await createExecutorBindingPg(db, {
      runId: "run-callback-policy-metrics-leak",
      taskId: "task-1",
      attemptId: "attempt-1",
      torkJobId: "job-1",
      status: "running",
      now: "2026-06-21T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });
    const leakedSecret = "raw-secret-not-matching-common-token-regex";

    await assert.rejects(
      () => ingestTaskRunResultPg(db, {
        runId: "run-callback-policy-metrics-leak",
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: true,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", summary: "safe artifact" },
        metrics: { tokens: 10, GITHUB_TOKEN: { value: leakedSecret } } as never,
        events: [],
      }),
      /raw credential detected/i,
    );

    const violations = await listResourcesPg(db, { resourceType: "tool_proxy_violation" });
    assert.equal(violations.length, 1);
    assert.equal((violations[0]?.payload as { evidenceRef?: string }).evidenceRef, "hand-execution:run-callback-policy-metrics-leak:task-1:attempt-1:metrics");
    assert.doesNotMatch(JSON.stringify(violations[0]), new RegExp(leakedSecret));

    const artifacts = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
    assert.equal(artifacts.length, 0);
    const history = await listHistoryForRunPg(db, "run-callback-policy-metrics-leak");
    assert.equal(history.some((row) => row.eventType === "executor.callback_received"), false);
    assert.doesNotMatch(JSON.stringify(history), new RegExp(leakedSecret));
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

test("callback URL credentials are rejected before callback history, resources, or artifact blobs persist them", async () => {
  await withDb(async (db) => {
    const runId = "run-callback-policy-url-leak";
    const leakedUrl = "https://example.test/result#access_token=x&view=summary";
    await seedRunTask(db, runId, "task-1");

    await assert.rejects(
      () => ingestTaskRunResultPg(db, {
        runId,
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: true,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", browserEvidence: { url: leakedUrl } },
        metrics: {},
        events: [],
      }),
      /raw credential detected/i,
    );

    const blobs = await db.query<{ body: Buffer }>("select body from southstar.artifact_blobs where run_id = $1", [runId]);
    const history = await listHistoryForRunPg(db, runId);
    const resources = (await listResourcesPg(db, {})).filter((resource) => resource.runId === runId);
    assert.equal(blobs.rows.length, 0);
    assert.equal(history.some((event) => event.eventType === "executor.callback_received"), false);
    assert.doesNotMatch(JSON.stringify(history), /access_token|\?access_token=x/);
    assert.doesNotMatch(JSON.stringify(resources), /access_token|\?access_token=x/);
  });
});

test("callback nested redirect credentials are rejected before artifact blob persistence", async () => {
  await withDb(async (db) => {
    const runId = "run-callback-policy-nested-url-leak";
    const leakedUrl = "https://example.test/result?redirect=https%3A%2F%2Fuser%3Apassword%40private.test";
    await seedRunTask(db, runId, "task-1");

    await assert.rejects(
      () => ingestTaskRunResultPg(db, {
        runId,
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: true,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", browserEvidence: { url: leakedUrl } },
        metrics: {},
        events: [],
      }),
      /raw credential detected/i,
    );

    assert.equal((await db.query("select id from southstar.artifact_blobs where run_id = $1", [runId])).rows.length, 0);
    assert.doesNotMatch(JSON.stringify(await listHistoryForRunPg(db, runId)), /password|private\.test/);
  });
});

test("callback identity and event metadata surfaces are scanned before persistence", async () => {
  await withDb(async (db) => {
    const secretUrl = "https://example.test/callback?token=x";
    const cases: Array<{ name: string; patch: Record<string, unknown> }> = [
      { name: "root-session", patch: { rootSessionId: secretUrl } },
      { name: "attempt", patch: { attemptId: secretUrl } },
      {
        name: "event-metadata",
        patch: { events: [{ eventType: secretUrl, actorType: "hand", sessionId: secretUrl, payload: {} }] },
      },
    ];

    for (const item of cases) {
      const runId = `run-callback-policy-${item.name}`;
      await seedRunTask(db, runId, "task-1");
      await assert.rejects(
        () => ingestTaskRunResultPg(db, {
          runId,
          taskId: "task-1",
          rootSessionId: "session-1",
          ok: true,
          attempts: 1,
          attemptId: "attempt-1",
          artifact: { kind: "implementation_report", summary: "safe" },
          metrics: {},
          events: [],
          ...item.patch,
        } as PostgresTaskRunCallbackResult),
        /raw credential detected/i,
        item.name,
      );
      const persisted = JSON.stringify({
        history: await listHistoryForRunPg(db, runId),
        resources: (await listResourcesPg(db, {})).filter((resource) => resource.runId === runId),
      });
      assert.doesNotMatch(persisted, /token=x/, item.name);
    }
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
