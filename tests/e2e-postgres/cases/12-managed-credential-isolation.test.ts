import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import { createWorkflowRunPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresVault } from "../../../src/v2/tool-proxy/postgres-vault.ts";
import { createToolProxy } from "../../../src/v2/tool-proxy/tool-proxy.ts";

test("12 managed credential isolation: real Postgres tool proxy keeps credential values out of runtime surfaces", async () => {
  const harness = await createInitializedRealPostgresE2E();
  const runId = "real-managed-credential-isolation";
  const sessionId = "session-real-credential";
  const credentialValue = "github_pat_secret_real_e2e_1234567890";
  try {
    await createWorkflowRunPg(harness.db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "credential isolation",
      workflowManifestJson: JSON.stringify({
        schemaVersion: "southstar.v2",
        workflowId: "wf-managed-credential-isolation",
        title: "Managed credential isolation",
        goalPrompt: "credential isolation",
        tasks: [],
        harnessDefinitions: [],
        evaluators: [],
        memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true },
        vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
        mcpServers: [],
        mcpGrants: [],
        progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
        steeringPolicy: { enabled: true, acceptedSignals: [] },
        learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
      }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const vault = createPostgresVault(harness.db);
    const lease = await vault.issueLease({
      runId,
      sessionId,
      secretRef: "github-token",
      plaintextSecret: credentialValue,
      allowedTools: ["github.comment"],
      ttlSeconds: 60,
      reason: "real e2e credential isolation",
    });

    const proxy = createToolProxy(harness.db, {
      vault,
      handlers: {
        "github.comment": async () => ({
          ok: true,
          echoed: credentialValue,
          nested: { token: credentialValue },
        }),
      },
    });
    const result = await proxy.execute({
      runId,
      sessionId,
      leaseId: lease.id,
      toolName: "github.comment",
      input: { body: "safe", authorization: credentialValue, nested: { value: credentialValue } },
    });

    assert.equal(result.ok, true);
    assert.equal(result.summary.secretRef, "github-token");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(credentialValue));

    const resourceRows = await harness.db.query<{ resource_type: string; payload_json: unknown; summary_json: unknown }>(
      `select resource_type, payload_json, summary_json
       from southstar.runtime_resources
       where run_id = $1
       order by resource_type, resource_key`,
      [runId],
    );
    const historyRows = await harness.db.query<{ event_type: string; payload_json: unknown }>(
      `select event_type, payload_json
       from southstar.workflow_history
       where run_id = $1
       order by sequence`,
      [runId],
    );
    const secureBlobRows = await harness.db.query<{ key_id: string; ciphertext_blob: Buffer; metadata_json: unknown }>(
      `select key_id, ciphertext_blob, metadata_json
       from southstar.secure_blobs
       where resource_id = $1`,
      [lease.id],
    );

    const persistedRuntimeSurface = JSON.stringify({
      resources: resourceRows.rows,
      history: historyRows.rows,
      secureBlobs: secureBlobRows.rows.map((row) => ({
        keyId: row.key_id,
        ciphertext: row.ciphertext_blob.toString("utf8"),
        metadata: row.metadata_json,
      })),
    });
    assert.doesNotMatch(persistedRuntimeSurface, new RegExp(credentialValue));
    assert.match(persistedRuntimeSurface, /vault_lease/);
    assert.match(persistedRuntimeSurface, /tool_proxy_call/);
    assert.match(persistedRuntimeSurface, /vault_lease\.issued/);
    assert.match(persistedRuntimeSurface, /tool_proxy\.called/);
  } finally {
    await harness.close();
  }
});
