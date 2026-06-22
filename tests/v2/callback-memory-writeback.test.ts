import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../../src/v2/artifacts/types.ts";
import { collectContextSourcesPg } from "../../src/v2/context/source-builder.ts";
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

test("callback ingestion records artifact repair markers for failed upstream artifact refs", async () => {
  await withDb(async (db) => {
    const runId = "run-callback-artifact-repair-marker";
    const producerTaskId = "producer";
    const validatorTaskId = "validator";
    await seedRunTask(db, runId, producerTaskId);
    await createWorkflowTaskPg(db, {
      id: validatorTaskId,
      runId,
      taskKey: "validate-feature",
      status: "running",
      sortOrder: 1,
      dependsOn: [producerTaskId],
      rootSessionId: "session-validator",
    });

    const producerArtifact = await ingestTaskRunResultPg(db, {
      runId,
      taskId: producerTaskId,
      rootSessionId: "session-producer",
      ok: true,
      attempts: 1,
      attemptId: "producer-attempt-1",
      artifact: {
        kind: "implementation_report",
        summary: "Producer artifact missing validator-required command evidence.",
      },
      metrics: { tokens: 7 },
      receivedAt: "2026-06-22T10:10:00.000Z",
      events: [],
    });
    assert.ok(producerArtifact.artifactRefId);

    const validationResult = await ingestTaskRunResultPg(db, {
      runId,
      taskId: validatorTaskId,
      rootSessionId: "session-validator",
      ok: false,
      attempts: 1,
      attemptId: "validator-attempt-1",
      artifact: {
        kind: "validation_report",
        summary: "Validator found producer artifact missing command evidence.",
        failedArtifactRefs: [producerArtifact.artifactRefId],
        findings: [
          { artifactRefId: producerArtifact.artifactRefId, reason: "missing command evidence" },
        ],
      },
      metrics: { tokens: 5 },
      receivedAt: "2026-06-22T10:11:00.000Z",
      events: [
        {
          eventType: "validator.finding",
          actorType: "evaluator",
          sessionId: "session-validator",
          payload: { failedArtifactRefs: [producerArtifact.artifactRefId] },
        },
      ],
    });
    assert.equal(validationResult.accepted, false);

    const markers = await db.query<{
      resource_key: string;
      task_id: string | null;
      status: string;
      payload_json: { artifactRefId?: string; sourceRefs?: string[]; consumerTaskId?: string; reason?: string };
    }>(
      "select resource_key, task_id, status, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'artifact_repair_marker'",
      [runId],
    );
    assert.equal(markers.rows.length, 1);
    assert.equal(markers.rows[0]?.task_id, producerTaskId);
    assert.equal(markers.rows[0]?.status, "open");
    assert.equal(markers.rows[0]?.payload_json.artifactRefId, producerArtifact.artifactRefId);
    assert.equal(markers.rows[0]?.payload_json.consumerTaskId, validatorTaskId);
    assert.equal(markers.rows[0]?.payload_json.sourceRefs?.includes(validationResult.artifactRefId ?? ""), true);
    assert.match(markers.rows[0]?.payload_json.reason ?? "", /missing command evidence/);
  });
});

test("callback run-local memory is available to downstream managed context without long-term approval", async () => {
  await withDb(async (db) => {
    const runId = "run-callback-memory-context";
    const producerTaskId = "producer";
    const consumerTaskId = "consumer";
    await seedRunTask(db, runId, producerTaskId);
    await createWorkflowTaskPg(db, {
      id: consumerTaskId,
      runId,
      taskKey: consumerTaskId,
      status: "pending",
      sortOrder: 1,
      dependsOn: [producerTaskId],
      rootSessionId: "session-consumer",
    });

    const result = await ingestTaskRunResultPg(db, {
      runId,
      taskId: producerTaskId,
      rootSessionId: "session-producer",
      ok: true,
      attempts: 1,
      attemptId: "producer-attempt-1",
      artifact: {
        kind: "implementation_report",
        summary: "Producer discovered callback memory should feed downstream context.",
      },
      metrics: { tokens: 7 },
      receivedAt: "2026-06-22T10:20:00.000Z",
      events: [],
    });
    assert.ok(result.artifactRefId);

    const sources = await collectContextSourcesPg(db, {
      runId,
      taskId: consumerTaskId,
      sessionId: "session-consumer",
      dependsOn: [producerTaskId],
      query: "callback memory downstream context",
      memoryScopes: ["software"],
      allowedMemoryKinds: ["artifact_summary"],
      maxMemoryCandidates: 5,
      checkpointRefs: [],
    });

    const selectedMemory = sources.candidates.find((candidate) => candidate.sourceType === "memory");
    assert.ok(selectedMemory, "expected callback run-local memory to be collected for downstream context");
    assert.equal(selectedMemory?.sourceRef?.startsWith("memory_item:"), true);
    assert.match(selectedMemory?.text ?? "", /callback memory should feed downstream context/);
    assert.equal(sources.sourceRefs.memoryRefs?.includes(selectedMemory?.sourceRef ?? ""), true);
  });
});

async function seedRunTask(db: SouthstarDb, runId: string, taskId: string, status = "running"): Promise<void> {
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
    taskKey: taskId,
    status,
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
