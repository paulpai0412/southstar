import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkItemPg, getWorkItemPg, linkRunToWorkItemPg } from "../../src/v2/work-items/postgres-work-items.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";

test("Postgres work item registry creates source-stable work item and links runs", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    const workItem = await createWorkItemPg(db, {
      id: "wi-managed-1",
      sourceProvider: "local",
      sourceRef: "local:managed-1",
      title: "Managed agent run",
      domain: "software",
      status: "active",
      metadata: { sourceUrl: "file:///tmp/request" },
    });
    assert.equal(workItem.id, "wi-managed-1");

    await createWorkflowRunPg(db, {
      id: "run-managed-1",
      status: "created",
      domain: "software",
      goalPrompt: "test managed run",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    await linkRunToWorkItemPg(db, { workItemId: workItem.id, runId: "run-managed-1", runAttempt: 1 });
    const loaded = await getWorkItemPg(db, workItem.id);
    assert.equal(loaded?.runRefs.length, 1);
    assert.deepEqual(loaded?.runRefs[0], { runId: "run-managed-1", runAttempt: 1 });
  } finally {
    await db.close();
  }
});
