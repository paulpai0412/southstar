import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptOrRejectArtifactRefPg,
  acceptedArtifactTaskIdsForRunPg,
  sha256Stable,
} from "../../src/v2/artifacts/artifact-ref-store.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE, type ArtifactRefPayload } from "../../src/v2/artifacts/types.ts";
import { createWorkflowRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

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
      kind: "inline_digest",
      ref: contentHash,
      sha256: contentHash,
    });
    assert.deepEqual(resource.summary_json, {
      artifactRefId: expectedArtifactRefId,
      artifactType: "implementation_patch",
      contractRefs: ["contract:a", "contract:z"],
      contentHash,
    });

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

test("acceptOrRejectArtifactRefPg writes the resource and history through one caller transaction", async () => {
  const db = transactionOnlyDb();

  const result = await acceptOrRejectArtifactRefPg(db, artifactRefInput({
    runId: "run-artifact-ref-atomic",
    taskId: "task-a",
    content: { atomic: true },
  }));

  assert.equal(result.artifactRefId.startsWith("artifact_ref:run-artifact-ref-atomic:task-a:attempt-1:"), true);
  assert.equal(db.calls.rootTx, 1);
  assert.equal(db.calls.rootMaybeOne, 0);
  assert.equal(db.calls.rootQuery, 0);
  assert.equal(db.calls.rootOne, 0);
  assert.equal(db.calls.resourceUpsertInTx, 1);
  assert.equal(db.calls.historyInsertInTx, 1);
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
  const row = await db.one<{ payload_json: ArtifactRefPayload }>(
    "select payload_json from southstar.runtime_resources where id = $1",
    [resourceId],
  );
  return row.payload_json;
}

function artifactRefInput(overrides: {
  runId: string;
  taskId: string;
  status?: "accepted" | "rejected" | "needs_repair";
  content?: unknown;
  contractRefs?: string[];
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

function transactionOnlyDb(): SouthstarDb & {
  calls: {
    rootTx: number;
    rootMaybeOne: number;
    rootQuery: number;
    rootOne: number;
    resourceUpsertInTx: number;
    historyInsertInTx: number;
  };
} {
  const calls = {
    rootTx: 0,
    rootMaybeOne: 0,
    rootQuery: 0,
    rootOne: 0,
    resourceUpsertInTx: 0,
    historyInsertInTx: 0,
  };
  const txDb: SouthstarDb = {
    async query(sql: string) {
      if (sql.includes("insert into southstar.runtime_resources")) calls.resourceUpsertInTx++;
      if (sql.includes("insert into southstar.workflow_history")) calls.historyInsertInTx++;
      return { rows: [], rowCount: 1 };
    },
    async one<T>(sql: string) {
      if (sql.includes("coalesce(max(sequence)")) return { next_sequence: 1 } as T;
      throw new Error(`unexpected tx one: ${sql}`);
    },
    async maybeOne() {
      return null;
    },
    async tx<T>(fn: (db: SouthstarDb) => Promise<T>) {
      return await fn(txDb);
    },
    async close() {},
  };
  return {
    calls,
    async query() {
      calls.rootQuery++;
      throw new Error("resource writes must use transaction db");
    },
    async one() {
      calls.rootOne++;
      throw new Error("resource writes must use transaction db");
    },
    async maybeOne() {
      calls.rootMaybeOne++;
      throw new Error("resource writes must use transaction db");
    },
    async tx<T>(fn: (db: SouthstarDb) => Promise<T>) {
      calls.rootTx++;
      return await fn(txDb);
    },
    async close() {},
  };
}
