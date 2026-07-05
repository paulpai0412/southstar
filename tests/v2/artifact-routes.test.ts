import test from "node:test";
import assert from "node:assert/strict";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("artifact route returns artifact_ref content for MCP/API consumers", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-artifact-route"));
    const written = await acceptOrRejectArtifactRefPg(db, {
      runId: "run-artifact-route",
      taskId: "verify",
      sessionId: "session-verify",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-artifact-route:verify:attempt-1",
      producer: { actorType: "hand", providerId: "tork" },
      artifactType: "verification_report",
      status: "accepted",
      content: { kind: "verification_report", summary: "tests pass", acceptanceReport: "Accepted." },
      contractRefs: ["verification_report"],
      summary: "tests pass",
      evidenceRefs: [],
      evaluatorResultRefs: [],
      sourceEventRefs: [],
    });

    const envelope = await call<{ artifactRef: string; content?: { acceptanceReport?: string } }>(
      db,
      `/api/v2/artifacts/${encodeURIComponent(written.artifactRefId)}`,
    );

    assert.equal(envelope.kind, "artifact");
    assert.equal(envelope.result.artifactRef, written.artifactRefId);
    assert.equal(envelope.result.content?.acceptanceReport, "Accepted.");
  } finally {
    await db.close();
  }
});

async function call<T>(db: Parameters<typeof handleRuntimeRoute>[0]["db"], path: string, init?: RequestInit): Promise<{ ok: true; kind: string; result: T }> {
  const response = await handleRuntimeRoute({
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
  }, new Request(`http://127.0.0.1${path}`, init));
  const envelope = await response.json() as { ok: true; kind: string; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}

function minimalRun(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "read artifact route",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
