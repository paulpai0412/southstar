import test from "node:test";
import assert from "node:assert/strict";
import { recordArtifactRepairMarkerPg } from "../../src/v2/artifacts/lineage.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("artifact lineage records deterministic repair markers idempotently", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-artifact-lineage",
      status: "running",
      domain: "software",
      goalPrompt: "record artifact repair marker",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
      executionProjectionJson: JSON.stringify({ executor: "tork" }),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "task-1",
      runId: "run-artifact-lineage",
      taskKey: "implement-feature",
      status: "running",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-1",
    });

    const first = await recordArtifactRepairMarkerPg(db, {
      runId: "run-artifact-lineage",
      taskId: "task-1",
      sessionId: "session-1",
      artifactRefId: "artifact_ref:run-artifact-lineage:task-1:attempt-1:abc",
      reason: "missing artifact evidence",
      sourceRefs: ["history:validator.finding", "history:artifact.created"],
    });
    const second = await recordArtifactRepairMarkerPg(db, {
      runId: "run-artifact-lineage",
      taskId: "task-1",
      sessionId: "session-1",
      artifactRefId: "artifact_ref:run-artifact-lineage:task-1:attempt-1:abc",
      reason: "missing artifact evidence",
      sourceRefs: ["history:artifact.created", "history:validator.finding"],
      payload: {
        artifactRefId: "artifact_ref:wrong",
        markerId: "wrong-marker",
        reason: "wrong reason",
        sourceRefs: ["history:wrong"],
      },
    });

    assert.deepEqual(second, first);
    const marker = await db.one<{
      id: string;
      resource_type: string;
      resource_key: string;
      scope: string;
      status: string;
      payload_json: { artifactRefId?: string; reason?: string; sourceRefs?: string[] };
    }>(
      "select id, resource_type, resource_key, scope, status, payload_json from southstar.runtime_resources where id = $1",
      [first.markerId],
    );
    assert.equal(marker.resource_type, "artifact_repair_marker");
    assert.equal(marker.resource_key, first.markerId);
    assert.equal(marker.scope, "artifact");
    assert.equal(marker.status, "open");
    assert.equal(marker.payload_json.artifactRefId, "artifact_ref:run-artifact-lineage:task-1:attempt-1:abc");
    assert.equal(marker.payload_json.reason, "missing artifact evidence");
    assert.deepEqual(marker.payload_json.sourceRefs, ["history:artifact.created", "history:validator.finding"]);

    const history = await listHistoryForRunPg(db, "run-artifact-lineage");
    assert.equal(history.filter((event) => event.eventType === "artifact.repair_marker_recorded").length, 1);
  } finally {
    await db.close();
  }
});
