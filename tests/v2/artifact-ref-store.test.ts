import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptOrRejectArtifactRefPg,
  acceptedArtifactTaskIdsForRunPg,
  artifactRefIdentity,
  sha256Stable,
} from "../../src/v2/artifacts/artifact-ref-store.ts";
import { buildEvidencePacket } from "../../src/v2/artifacts/evidence.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE, type ArtifactRefPayload } from "../../src/v2/artifacts/types.ts";
import { createWorkflowRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("buildEvidencePacket captures redacted browser URL and screenshot evidence", () => {
  const packet = buildEvidencePacket({
    runId: "run-browser-evidence",
    taskId: "task-browser-verify",
    artifactRef: "artifact-ref-browser",
    requiredEvidenceKinds: ["url", "screenshot"],
    artifact: {
      browserEvidence: {
        url: "https://example.test/subscriptions?access_token=secret#private",
        screenshots: [{ path: "artifacts/subscription-page.png" }],
      },
    },
    now: "2026-07-11T00:00:00.000Z",
  });

  assert.deepEqual(packet.completeness.missingKinds, []);
  assert.deepEqual(packet.evidenceItems.map((item) => [item.kind, item.status]), [
    ["url", "present"],
    ["screenshot", "present"],
  ]);
  assert.match(packet.evidenceItems[0]!.summary, /https:\/\/example\.test\/subscriptions/);
  assert.doesNotMatch(JSON.stringify(packet), /access_token|secret|private/);
  assert.equal(packet.evidenceItems.every((item) => item.redactionApplied), true);
});

test("buildEvidencePacket marks malformed browser evidence invalid without exposing host paths", () => {
  const packet = buildEvidencePacket({
    runId: "run-browser-evidence-invalid",
    taskId: "task-browser-verify",
    artifactRef: "artifact-ref-browser-invalid",
    requiredEvidenceKinds: ["url", "screenshot"],
    artifact: {
      browserEvidence: {
        url: "file:///home/user/.ssh/id_rsa",
        screenshots: [{ path: "../../home/user/.ssh/id_rsa" }],
      },
    },
    now: "2026-07-11T00:00:00.000Z",
  });

  assert.deepEqual(packet.evidenceItems.map((item) => [item.kind, item.status]), [
    ["url", "invalid"],
    ["screenshot", "invalid"],
  ]);
  assert.doesNotMatch(JSON.stringify(packet), /home\/user|id_rsa/);
});

test("buildEvidencePacket accepts only canonical artifact identities as screenshot artifact refs", () => {
  const canonicalRef = `artifact_ref:run-browser-evidence:task-browser:attempt-1:${"a".repeat(64)}`;
  const canonical = buildEvidencePacket({
    runId: "run-browser-evidence",
    taskId: "task-browser-verify",
    artifactRef: "artifact-ref-browser",
    requiredEvidenceKinds: ["screenshot"],
    artifact: { screenshot: { artifactRef: canonicalRef } },
  });
  assert.equal(canonical.evidenceItems[0]?.status, "present");

  for (const artifactRef of [
    "artifact_ref:file:///home/user/screenshot.png",
    "artifact_ref:artifacts/screenshot.png",
    "artifact_ref:secret-token",
    `artifact_ref:other-run:task-browser:attempt-1:${"b".repeat(64)}`,
  ]) {
    const packet = buildEvidencePacket({
      runId: "run-browser-evidence",
      taskId: "task-browser-verify",
      artifactRef: "artifact-ref-browser",
      requiredEvidenceKinds: ["screenshot"],
      artifact: { screenshot: { artifactRef } },
    });
    assert.equal(packet.evidenceItems[0]?.status, "invalid", artifactRef);
    assert.doesNotMatch(JSON.stringify(packet), /home\/user|secret-token|other-run/);
  }
});

test("acceptOrRejectArtifactRefPg writes deterministic accepted artifact_ref runtime resources", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-artifact-ref-write");

    const result = await acceptOrRejectArtifactRefPg(db, artifactRefInput({
      runId: "run-artifact-ref-write",
      taskId: "task-a",
      content: { b: 2, a: 1 },
      contractRefs: ["contract:z", "contract:a"],
    }));

    const contentHash = sha256Stable({ b: 2, a: 1 });
    const expectedArtifactRefId = `artifact_ref:run-artifact-ref-write:task-a:attempt-1:${contentHash}`;
    assert.equal(result.artifactRefId, expectedArtifactRefId);

    const resource = await db.one<{
      id: string;
      resource_type: string;
      resource_key: string;
      run_id: string;
      task_id: string;
      session_id: string;
      scope: string;
      status: string;
      payload_json: ArtifactRefPayload;
      summary_json: Record<string, unknown>;
    }>(
      "select id, resource_type, resource_key, run_id, task_id, session_id, scope, status, payload_json, summary_json from southstar.runtime_resources where id = $1",
      [result.resourceId],
    );

    assert.equal(resource.resource_type, ARTIFACT_REF_RESOURCE_TYPE);
    assert.equal(resource.resource_key, expectedArtifactRefId);
    assert.equal(resource.run_id, "run-artifact-ref-write");
    assert.equal(resource.task_id, "task-a");
    assert.equal(resource.session_id, "session-1");
    assert.equal(resource.scope, "artifact");
    assert.equal(resource.status, "accepted");
    assert.equal(resource.payload_json.artifactRefId, expectedArtifactRefId);
    assert.equal(resource.payload_json.status, "accepted");
    assert.deepEqual(resource.payload_json.contractRefs, ["contract:a", "contract:z"]);
    assert.deepEqual(resource.payload_json.contentRef, {
      kind: "artifact_blob",
      ref: `${expectedArtifactRefId}:content`,
      sha256: contentHash,
    });
    assert.deepEqual(resource.summary_json, {
      artifactRefId: expectedArtifactRefId,
      artifactType: "implementation_patch",
      contractRefs: ["contract:a", "contract:z"],
      contentHash,
    });
    const blob = await db.one<{ body: Buffer; sha256: string; content_type: string }>(
      "select body, sha256, content_type from southstar.artifact_blobs where id = $1",
      [`${expectedArtifactRefId}:content`],
    );
    assert.equal(blob.sha256, contentHash);
    assert.equal(blob.content_type, "application/json");
    assert.deepEqual(JSON.parse(blob.body.toString("utf8")), { a: 1, b: 2 });

    const history = await db.query<{ event_type: string; idempotency_key: string | null; payload_json: { artifactRefId?: string } }>(
      "select event_type, idempotency_key, payload_json from southstar.workflow_history where run_id = $1 order by sequence",
      ["run-artifact-ref-write"],
    );
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0]?.event_type, "artifact.accepted");
    assert.equal(history.rows[0]?.idempotency_key, `${expectedArtifactRefId}:accepted`);
    assert.equal(history.rows[0]?.payload_json.artifactRefId, expectedArtifactRefId);
  } finally {
    await db.close();
  }
});

test("acceptOrRejectArtifactRefPg repeats identical artifact content with the same ids and one history event", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-artifact-ref-idempotent");
    const input = artifactRefInput({
      runId: "run-artifact-ref-idempotent",
      taskId: "task-a",
      content: { lines: ["alpha", "beta"], nested: { y: true, x: 3 } },
    });

    const first = await acceptOrRejectArtifactRefPg(db, input);
    const second = await acceptOrRejectArtifactRefPg(db, {
      ...input,
      content: { nested: { x: 3, y: true }, lines: ["alpha", "beta"] },
    });

    assert.equal(second.resourceId, first.resourceId);
    assert.equal(second.artifactRefId, first.artifactRefId);
    const resources = await db.one<{ count: string }>(
      "select count(*) as count from southstar.runtime_resources where run_id = $1 and resource_type = $2",
      ["run-artifact-ref-idempotent", ARTIFACT_REF_RESOURCE_TYPE],
    );
    assert.equal(Number(resources.count), 1);
    const history = await db.one<{ count: string }>(
      "select count(*) as count from southstar.workflow_history where run_id = $1 and event_type = 'artifact.accepted'",
      ["run-artifact-ref-idempotent"],
    );
    assert.equal(Number(history.count), 1);
  } finally {
    await db.close();
  }
});

test("acceptOrRejectArtifactRefPg persists failed artifact refs on rejected artifact payloads", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-artifact-ref-failed-lineage");

    const result = await acceptOrRejectArtifactRefPg(db, artifactRefInput({
      runId: "run-artifact-ref-failed-lineage",
      taskId: "task-a",
      status: "rejected",
      failedArtifactRefs: ["artifact_ref:producer:task:attempt-1:abc"],
    }));

    const payload = await artifactRefPayload(db, result.resourceId);
    assert.deepEqual(payload.failedArtifactRefs, ["artifact_ref:producer:task:attempt-1:abc"]);
  } finally {
    await db.close();
  }
});

test("acceptOrRejectArtifactRefPg treats duplicate same-status metadata changes as an immutable no-op", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-artifact-ref-immutable");
    const first = await acceptOrRejectArtifactRefPg(db, artifactRefInput({
      runId: "run-artifact-ref-immutable",
      taskId: "task-a",
      content: { immutable: true },
      contractRefs: ["contract:first"],
    }));
    const firstResource = await artifactRefResource(db, first.resourceId);

    const second = await acceptOrRejectArtifactRefPg(db, {
      ...artifactRefInput({
        runId: "run-artifact-ref-immutable",
        taskId: "task-a",
        content: { immutable: true },
        contractRefs: ["contract:changed", "contract:first"],
      }),
      producer: { actorType: "brain", providerId: "changed-provider" },
      summary: "Changed summary should not overwrite canonical artifact ref",
      evidenceRefs: ["evidence:changed"],
      evaluatorResultRefs: ["validator:changed"],
      sourceEventRefs: ["history:changed"],
      producedAt: "2026-06-21T01:02:03.000Z",
    });
    const secondResource = await artifactRefResource(db, second.resourceId);

    assert.equal(second.resourceId, first.resourceId);
    assert.equal(second.artifactRefId, first.artifactRefId);
    assert.deepEqual(secondResource.payload_json, firstResource.payload_json);
    assert.deepEqual(secondResource.summary_json, firstResource.summary_json);
    assert.equal(secondResource.status, "accepted");
    const history = await db.one<{ count: string }>(
      "select count(*) as count from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
      ["run-artifact-ref-immutable", `${first.artifactRefId}:accepted`],
    );
    assert.equal(Number(history.count), 1);
  } finally {
    await db.close();
  }
});

test("acceptOrRejectArtifactRefPg keeps generated producedAt stable when retried without producedAt", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-artifact-ref-produced-at");
    const input = artifactRefInputWithoutProducedAt({
      runId: "run-artifact-ref-produced-at",
      taskId: "task-a",
      content: { stable: "produced-at" },
    });

    const first = await acceptOrRejectArtifactRefPg(db, input);
    const firstPayload = await artifactRefPayload(db, first.resourceId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await acceptOrRejectArtifactRefPg(db, input);
    const secondPayload = await artifactRefPayload(db, second.resourceId);

    assert.equal(second.artifactRefId, first.artifactRefId);
    assert.equal(secondPayload.producedAt, firstPayload.producedAt);
  } finally {
    await db.close();
  }
});

test("acceptOrRejectArtifactRefPg preserves first producedAt when duplicate first-time content conflicts", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-artifact-ref-first-produced-at");
    const input = artifactRefInput({
      runId: "run-artifact-ref-first-produced-at",
      taskId: "task-a",
      content: { duplicate: "first wins" },
    });
    const first = await acceptOrRejectArtifactRefPg(db, {
      ...input,
      producedAt: "2026-06-21T00:00:01.000Z",
      summary: "First write",
    });
    const second = await acceptOrRejectArtifactRefPg(db, {
      ...input,
      producedAt: "2026-06-21T00:00:02.000Z",
      summary: "Second write should not overwrite",
    });

    const payload = await artifactRefPayload(db, second.resourceId);
    const history = await db.one<{ count: string }>(
      "select count(*) as count from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
      ["run-artifact-ref-first-produced-at", `${first.artifactRefId}:accepted`],
    );

    assert.equal(second.resourceId, first.resourceId);
    assert.equal(second.artifactRefId, first.artifactRefId);
    assert.equal(payload.producedAt, "2026-06-21T00:00:01.000Z");
    assert.equal(payload.summary, "First write");
    assert.equal(Number(history.count), 1);
  } finally {
    await db.close();
  }
});

test("acceptOrRejectArtifactRefPg allows status changes for the same artifact ref and records status history", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-artifact-ref-status-change");
    const input = artifactRefInput({
      runId: "run-artifact-ref-status-change",
      taskId: "task-a",
      content: { status: "can change" },
    });
    const accepted = await acceptOrRejectArtifactRefPg(db, input);

    const rejected = await acceptOrRejectArtifactRefPg(db, {
      ...input,
      status: "rejected",
      summary: "Rejected after evaluator review",
    });
    const resource = await artifactRefResource(db, rejected.resourceId);
    const history = await db.query<{ event_type: string; idempotency_key: string }>(
      "select event_type, idempotency_key from southstar.workflow_history where run_id = $1 order by sequence",
      ["run-artifact-ref-status-change"],
    );

    assert.equal(rejected.resourceId, accepted.resourceId);
    assert.equal(resource.status, "rejected");
    assert.equal(resource.payload_json.status, "rejected");
    assert.equal(resource.payload_json.summary, "Rejected after evaluator review");
    assert.deepEqual(history.rows.map((row) => row.event_type), ["artifact.accepted", "artifact.rejected"]);
    assert.deepEqual(history.rows.map((row) => row.idempotency_key), [
      `${accepted.artifactRefId}:accepted`,
      `${accepted.artifactRefId}:rejected`,
    ]);
  } finally {
    await db.close();
  }
});

test("acceptedArtifactTaskIdsForRunPg returns only task ids with accepted artifact_ref resources", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-artifact-ref-ready");
    await acceptOrRejectArtifactRefPg(db, artifactRefInput({
      runId: "run-artifact-ref-ready",
      taskId: "task-a",
      status: "accepted",
      content: "accepted",
    }));
    await acceptOrRejectArtifactRefPg(db, artifactRefInput({
      runId: "run-artifact-ref-ready",
      taskId: "task-b",
      status: "rejected",
      content: "rejected",
    }));
    await acceptOrRejectArtifactRefPg(db, artifactRefInput({
      runId: "run-artifact-ref-ready",
      taskId: "task-c",
      status: "needs_repair",
      content: "needs repair",
    }));

    assert.deepEqual([...await acceptedArtifactTaskIdsForRunPg(db, "run-artifact-ref-ready")], ["task-a"]);
  } finally {
    await db.close();
  }
});

test("acceptedArtifactTaskIdsForRunPg ignores accepted legacy artifact resources", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-artifact-ref-legacy");
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact",
      resourceKey: "legacy-artifact-task-a",
      runId: "run-artifact-ref-legacy",
      taskId: "task-a",
      sessionId: "session-1",
      scope: "artifact",
      status: "accepted",
      title: "Legacy artifact",
      payload: { artifactRef: "legacy-artifact-task-a" },
    });
    await acceptOrRejectArtifactRefPg(db, artifactRefInput({
      runId: "run-artifact-ref-legacy",
      taskId: "task-b",
      status: "accepted",
      content: "canonical",
    }));

    assert.deepEqual([...await acceptedArtifactTaskIdsForRunPg(db, "run-artifact-ref-legacy")], ["task-b"]);
  } finally {
    await db.close();
  }
});

test("sha256Stable sorts object keys, preserves array order, and omits object undefined values", () => {
  assert.equal(sha256Stable({ b: 2, a: 1 }), sha256Stable({ a: 1, b: 2 }));
  assert.notEqual(sha256Stable(["a", "b"]), sha256Stable(["b", "a"]));
  assert.equal(sha256Stable({ a: 1, b: undefined }), sha256Stable({ a: 1 }));
});

test("artifactRefIdentity matches the identity persisted by acceptOrRejectArtifactRefPg", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-artifact-ref-identity";
    const taskId = "task-a";
    const content = { b: 2, a: 1 };
    await seedRun(db, runId);

    const identity = artifactRefIdentity({ runId, taskId, attemptId: "attempt-1", content });
    const persisted = await acceptOrRejectArtifactRefPg(db, artifactRefInput({ runId, taskId, content }));

    assert.deepEqual(identity, {
      artifactRefId: persisted.artifactRefId,
      contentHash: persisted.contentHash,
    });
  } finally {
    await db.close();
  }
});

async function seedRun(db: Awaited<ReturnType<typeof createTestPostgresDb>>, runId: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "store artifact refs",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
}

async function artifactRefPayload(db: SouthstarDb, resourceId: string): Promise<ArtifactRefPayload> {
  return (await artifactRefResource(db, resourceId)).payload_json;
}

async function artifactRefResource(db: SouthstarDb, resourceId: string): Promise<{
  status: string;
  payload_json: ArtifactRefPayload;
  summary_json: Record<string, unknown>;
}> {
  return await db.one<{
    status: string;
    payload_json: ArtifactRefPayload;
    summary_json: Record<string, unknown>;
  }>(
    "select status, payload_json, summary_json from southstar.runtime_resources where id = $1",
    [resourceId],
  );
}

function artifactRefInput(overrides: {
  runId: string;
  taskId: string;
  status?: "accepted" | "rejected" | "needs_repair";
  content?: unknown;
  contractRefs?: string[];
  failedArtifactRefs?: string[];
}) {
  return {
    runId: overrides.runId,
    taskId: overrides.taskId,
    sessionId: "session-1",
    attemptId: "attempt-1",
    handExecutionId: "hand-execution-1",
    producer: { actorType: "hand" as const, providerId: "workspace" },
    artifactType: "implementation_patch",
    status: overrides.status ?? "accepted",
    content: overrides.content ?? { patch: "diff --git a/file.ts b/file.ts" },
    contractRefs: overrides.contractRefs ?? ["contract:implementation"],
    summary: "Produced implementation patch",
    failedArtifactRefs: overrides.failedArtifactRefs,
    evidenceRefs: ["evidence:test"],
    evaluatorResultRefs: ["validator:schema"],
    sourceEventRefs: ["history:event"],
    producedAt: "2026-06-21T00:00:00.000Z",
  };
}

function artifactRefInputWithoutProducedAt(overrides: {
  runId: string;
  taskId: string;
  status?: "accepted" | "rejected" | "needs_repair";
  content?: unknown;
  contractRefs?: string[];
}) {
  const input = artifactRefInput(overrides);
  delete (input as { producedAt?: string }).producedAt;
  return input;
}
