import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../../src/v2/artifacts/types.ts";
import { ingestTaskRunResultPg } from "../../src/v2/executor/postgres-tork-callback.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("callback ingestion writes run-local memory and long-term memory delta without approving cross-run memory", async () => {
  await withDb(async (db) => {
    const runId = "run-callback-memory-writeback";
    const taskId = "task-1";
    await seedRunTask(db, runId, taskId);

    const result = await ingestTaskRunResultPg(db, {
      runId,
      taskId,
      rootSessionId: "session-1",
      ok: true,
      attempts: 1,
      artifact: {
        kind: "implementation_report",
        summary: "Validated callback writeback records memory lineage.",
        filesChanged: ["src/v2/executor/postgres-tork-callback.ts"],
        memoryCandidates: [
          {
            scope: "software",
            kind: "failure_lesson",
            text: "Callback writeback must keep cross-run memory pending until operator approval.",
            tags: ["validation"],
            confidence: 0.8,
            successScore: 0.7,
          },
        ],
      },
      metrics: { tokens: 12 },
      receivedAt: "2026-06-22T10:05:00.000Z",
      events: [],
    });

    assert.equal(result.accepted, true);
    assert.ok(result.artifactRefId);

    const artifactRefs = await db.query<{ id: string; resource_key: string }>(
      "select id, resource_key from southstar.runtime_resources where run_id = $1 and resource_type = $2",
      [runId, ARTIFACT_REF_RESOURCE_TYPE],
    );
    assert.equal(artifactRefs.rows.length, 1);
    assert.equal(artifactRefs.rows[0]?.resource_key, result.artifactRefId);

    const runLocalMemory = await db.query<{
      id: string;
      status: string;
      scope: string;
      payload_json: { kind?: string; text?: string; sourceRefs?: string[]; tags?: string[] };
    }>(
      "select id, status, scope, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'memory_item' and status = 'active'",
      [runId],
    );
    assert.equal(runLocalMemory.rows.length, 1);
    assert.equal(runLocalMemory.rows[0]?.scope, `run:${runId}`);
    assert.equal(runLocalMemory.rows[0]?.payload_json.kind, "artifact_summary");
    assert.equal(runLocalMemory.rows[0]?.payload_json.text, "Validated callback writeback records memory lineage.");
    assert.equal(runLocalMemory.rows[0]?.payload_json.sourceRefs?.includes(result.artifactRefId), true);

    const memoryDeltas = await db.query<{
      id: string;
      status: string;
      scope: string;
      payload_json: { kind?: string; text?: string; sourceRefs?: string[]; tags?: string[]; confidence?: number; successScore?: number };
    }>(
      "select id, status, scope, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'memory_delta'",
      [runId],
    );
    assert.equal(memoryDeltas.rows.length, 1);
    assert.equal(memoryDeltas.rows[0]?.status, "pending_approval");
    assert.equal(memoryDeltas.rows[0]?.scope, "software");
    assert.equal(memoryDeltas.rows[0]?.payload_json.kind, "failure_lesson");
    assert.equal(memoryDeltas.rows[0]?.payload_json.text, "Callback writeback must keep cross-run memory pending until operator approval.");
    assert.equal(memoryDeltas.rows[0]?.payload_json.sourceRefs?.includes(result.artifactRefId), true);
    assert.equal(memoryDeltas.rows[0]?.payload_json.confidence, 0.8);
    assert.equal(memoryDeltas.rows[0]?.payload_json.successScore, 0.7);

    const approvedLongTerm = await db.one<{ count: string }>(
      "select count(*)::text as count from southstar.runtime_resources where run_id = $1 and resource_type = 'memory_item' and status = 'approved' and scope = 'software'",
      [runId],
    );
    assert.equal(approvedLongTerm.count, "0");

    const history = await listHistoryForRunPg(db, runId);
    const historyTypes = history.map((event) => event.eventType);
    const artifactCreatedIndex = historyTypes.indexOf("artifact.created");
    const writebackIndex = historyTypes.indexOf("memory.writeback_recorded");
    const callbackCompletedIndex = historyTypes.indexOf("executor.callback_completed");
    const gateIndex = historyTypes.indexOf("run.evaluating_started");
    assert.notEqual(artifactCreatedIndex, -1);
    assert.notEqual(writebackIndex, -1);
    assert.notEqual(callbackCompletedIndex, -1);
    assert.notEqual(gateIndex, -1);
    assert.equal(artifactCreatedIndex < writebackIndex, true);
    assert.equal(writebackIndex < callbackCompletedIndex, true);
    assert.equal(writebackIndex < gateIndex, true);

    const writeback = history.find((event) => event.eventType === "memory.writeback_recorded");
    assert.deepEqual(writeback?.payload, {
      artifactRefId: result.artifactRefId,
      artifactResourceId: result.artifactResourceId,
      memoryItemIds: [runLocalMemory.rows[0]?.id],
      memoryDeltaIds: [memoryDeltas.rows[0]?.id],
    });
  });
});

async function seedRunTask(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "callback memory writeback",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-callback-memory", tasks: [{ id: taskId }] }),
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
