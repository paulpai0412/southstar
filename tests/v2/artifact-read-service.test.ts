import test from "node:test";
import assert from "node:assert/strict";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import { getArtifactRefContentPg } from "../../src/v2/artifacts/artifact-read-service.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("getArtifactRefContentPg reads artifact_ref metadata and JSON artifact blob", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-artifact-read"));
    const written = await acceptOrRejectArtifactRefPg(db, {
      runId: "run-artifact-read",
      taskId: "plan",
      sessionId: "session-plan",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-artifact-read:plan:attempt-1",
      producer: { actorType: "hand", providerId: "tork" },
      artifactType: "implementation_plan",
      status: "accepted",
      content: {
        kind: "implementation_plan",
        summary: "plan ready",
        designDoc: "Use vocabulary cards.",
      },
      contractRefs: ["implementation_plan"],
      summary: "plan ready",
      evidenceRefs: [],
      evaluatorResultRefs: [],
      sourceEventRefs: [],
    });

    const result = await getArtifactRefContentPg(db, { artifactRef: written.artifactRefId });

    assert.equal(result.artifactRef, written.artifactRefId);
    assert.equal(result.status, "accepted");
    assert.equal(result.artifactType, "implementation_plan");
    assert.equal(result.taskId, "plan");
    assert.deepEqual(result.content, {
      designDoc: "Use vocabulary cards.",
      kind: "implementation_plan",
      summary: "plan ready",
    });
  } finally {
    await db.close();
  }
});

function minimalRun(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "read artifact",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
