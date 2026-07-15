import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresVault } from "../../src/v2/tool-proxy/postgres-vault.ts";
import { createToolProxy, redact } from "../../src/v2/tool-proxy/tool-proxy.ts";

test("vault leases and tool proxy calls keep plaintext secrets out of persisted runtime surfaces", async () => {
  const db = await createTestPostgresDb();
  const runId = "run-tool-proxy-security";
  const sessionId = "session-tool-proxy-security";
  const plaintextSecret = "opaque-value-0123456789abcdef";
  try {
    await initSouthstarSchema(db);
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "exercise tool proxy security",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const vault = createPostgresVault(db);
    const lease = await vault.issueLease({
      runId,
      sessionId,
      secretRef: "github-token",
      plaintextSecret,
      allowedTools: ["github.create_issue"],
      ttlSeconds: 60,
      reason: "test lease",
    });

    assert.equal(lease.runId, runId);
    assert.equal(lease.sessionId, sessionId);
    assert.equal(lease.secretRef, "github-token");
    assert.deepEqual(lease.allowedTools, ["github.create_issue"]);

    const loadedLease = await vault.getLease(lease.id);
    assert.ok(loadedLease);
    assert.equal(loadedLease.id, lease.id);
    assert.equal(loadedLease?.secretDigest, createHash("sha256").update(plaintextSecret).digest("hex"));
    assert.ok(loadedLease.secretDigest);
    assert.deepEqual(redact({ value: plaintextSecret }, [loadedLease.secretDigest]), { value: "[REDACTED]" });

    const secureBlob = await db.one<{ ciphertext_blob: Buffer }>(
      "select ciphertext_blob from southstar.secure_blobs where resource_id = $1",
      [lease.id],
    );
    assert.deepEqual(secureBlob.ciphertext_blob, Buffer.from(createHash("sha256").update(plaintextSecret).digest("hex")));

    const proxy = createToolProxy(db, {
      vault,
      handlers: {
        "github.create_issue": async () => ({
          ok: true,
          value: `prefix-${plaintextSecret}-suffix`,
          nested: { value: plaintextSecret },
        }),
      },
    });
    const result = await proxy.execute({
      runId,
      sessionId,
      leaseId: lease.id,
      toolName: "github.create_issue",
      input: { title: "safe title", value: plaintextSecret },
    });

    assert.equal(result.ok, true);
    assert.equal(result.summary.toolName, "github.create_issue");
    assert.deepEqual(result.summary.result, {
      type: "object",
      keys: ["nested", "ok", "value"],
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(plaintextSecret));

    const proxyWithoutHandler = createToolProxy(db, { vault });
    await assert.rejects(
      () => proxyWithoutHandler.execute({
        runId,
        sessionId,
        leaseId: lease.id,
        toolName: "github.create_issue",
        input: {},
      }),
      /tool proxy handler is not configured: github\.create_issue/,
    );

    await assert.rejects(
      () => proxy.execute({ runId: "other-run", sessionId, leaseId: lease.id, toolName: "github.create_issue", input: {} }),
      /run mismatch/,
    );
    await assert.rejects(
      () => proxy.execute({ runId, sessionId: "other-session", leaseId: lease.id, toolName: "github.create_issue", input: {} }),
      /session mismatch/,
    );
    await assert.rejects(
      () => proxy.execute({ runId, sessionId, leaseId: lease.id, toolName: "github.delete_repo", input: {} }),
      /not allowed/,
    );
    await db.query(
      `update southstar.runtime_resources
       set expires_at = $1::timestamptz,
           payload_json = jsonb_set(payload_json, '{expiresAt}', to_jsonb($1::text), false)
       where resource_type = 'vault_lease' and resource_key = $2`,
      ["2000-01-01T00:00:00.000Z", lease.id],
    );
    await assert.rejects(
      () => proxy.execute({ runId, sessionId, leaseId: lease.id, toolName: "github.create_issue", input: {} }),
      /expired/,
    );
    await db.query(
      `update southstar.runtime_resources
       set expires_at = null,
           payload_json = jsonb_set(payload_json, '{expiresAt}', to_jsonb('not-a-date'::text), false)
       where resource_type = 'vault_lease' and resource_key = $1`,
      [lease.id],
    );
    await assert.rejects(
      () => proxy.execute({ runId, sessionId, leaseId: lease.id, toolName: "github.create_issue", input: {} }),
      /expired or invalid/,
    );

    const resourceRows = await db.query<{ resource_type: string; payload_json: unknown; summary_json: unknown }>(
      `select resource_type, payload_json, summary_json
       from southstar.runtime_resources
       where resource_type in ('vault_lease', 'tool_proxy_call')
       order by resource_type`,
    );
    const historyRows = await db.query<{ event_type: string; payload_json: unknown }>(
      "select event_type, payload_json from southstar.workflow_history order by sequence",
    );

    const persistedRuntimeSurface = JSON.stringify({ resources: resourceRows.rows, history: historyRows.rows });
    assert.doesNotMatch(persistedRuntimeSurface, new RegExp(plaintextSecret));
    assert.match(persistedRuntimeSurface, /"resource_type":"vault_lease"/);
    assert.match(persistedRuntimeSurface, /"resource_type":"tool_proxy_call"/);
    assert.match(persistedRuntimeSurface, /tool_proxy\.called/);
    assert.match(persistedRuntimeSurface, /vault_lease\.issued/);
  } finally {
    await db.close();
  }
});
