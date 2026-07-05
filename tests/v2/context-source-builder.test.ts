import test from "node:test";
import assert from "node:assert/strict";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import { collectContextSourcesPg } from "../../src/v2/context/source-builder.ts";
import { approveMemoryDeltaPg, createMemoryDeltaPg, writeRunLocalMemoryPg } from "../../src/v2/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("context source builder collects accepted artifacts, session events, checkpoints, active run memory, approved memory, pending deltas, and rollback invalidations", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-source-builder"));
    await createWorkflowTaskPg(db, {
      id: "producer",
      runId: "run-source-builder",
      taskKey: "producer",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
    });
    await createWorkflowTaskPg(db, {
      id: "consumer",
      runId: "run-source-builder",
      taskKey: "consumer",
      status: "pending",
      sortOrder: 1,
      dependsOn: ["producer"],
    });

    const artifact = await acceptOrRejectArtifactRefPg(db, {
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      attemptId: "producer-attempt-1",
      handExecutionId: "hand-execution:run-source-builder:producer:producer-attempt-1",
      producer: { actorType: "hand", providerId: "tork" },
      artifactType: "implementation_report",
      status: "accepted",
      content: {
        kind: "implementation_report",
        summary: "producer completed feature",
        designDoc: "Design: introduce a compact vocabulary card model.",
        implementationNotes: "Implementation: add card rendering and answer state.",
        testPlan: "Test: verify card flip and answer persistence.",
        acceptanceReport: "Acceptance: vocabulary flow can be completed.",
      },
      contractRefs: ["implementation_report"],
      summary: "producer completed feature",
      evidenceRefs: [],
      evaluatorResultRefs: [],
      sourceEventRefs: ["event-producer"],
    });

    const store = createPostgresSessionStore(db);
    const event = await store.emitEvent({
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      eventType: "session.entry",
      actorType: "hand",
      payload: { message: "producer session event", artifactRefs: [artifact.artifactRefId] },
    });
    const checkpoint = await store.createCheckpoint({
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      checkpointType: "artifact-accepted",
      summary: "producer artifact accepted",
      eventRange: { fromSequence: event.sequence, toSequence: event.sequence },
      refs: { artifactRefs: [artifact.artifactRefId] },
    });
    const runMemory = await writeRunLocalMemoryPg(db, {
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      scope: "software",
      kind: "repair_hint",
      text: "Producer validation used a stable implementation pattern.",
      tags: ["producer", "validation"],
      sourceRefs: [artifact.artifactRefId],
    });
    const delta = await createMemoryDeltaPg(db, {
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      scope: "software",
      kind: "failure_lesson",
      text: "Producer validation artifacts should list validation commands.",
      tags: ["producer", "validation", "artifact"],
      confidence: 0.9,
      successScore: 0.8,
      sourceRefs: [artifact.artifactRefId],
    });
    const approved = await approveMemoryDeltaPg(db, {
      deltaId: delta.id,
      approvedBy: "operator",
      reason: "useful lesson",
    });
    const pending = await createMemoryDeltaPg(db, {
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      scope: "software",
      kind: "failure_lesson",
      text: "Pending producer validation lesson should not be injected before approval.",
      tags: ["producer", "validation"],
      sourceRefs: ["memory-source:pending"],
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "rollback_marker",
      resourceKey: "rollback-marker:run-source-builder:consumer:2",
      runId: "run-source-builder",
      taskId: "consumer",
      sessionId: "session-consumer",
      scope: "session",
      status: "recorded",
      title: "rollback invalidated producer artifact",
      payload: {
        invalidatedSourceRefs: [artifact.artifactRefId, `memory_item:${runMemory.id}`],
      },
    });

    const sources = await collectContextSourcesPg(db, {
      runId: "run-source-builder",
      taskId: "consumer",
      sessionId: "session-consumer",
      dependsOn: ["producer"],
      query: "producer validation",
      memoryScopes: ["software"],
      allowedMemoryKinds: ["repair_hint", "failure_lesson"],
      maxMemoryCandidates: 10,
      checkpointRefs: [checkpoint.id],
    });

    assert.equal(hasSourceRef(sources.candidates, artifact.artifactRefId), true);
    const artifactCandidate = sources.candidates.find((candidate) => candidate.sourceRef === artifact.artifactRefId);
    assert.match(artifactCandidate?.text ?? "", /Design: introduce a compact vocabulary card model/);
    assert.match(artifactCandidate?.text ?? "", /Test: verify card flip and answer persistence/);
    assert.equal(hasSourceRef(sources.candidates, checkpoint.id), true);
    assert.equal(hasSourceRef(sources.candidates, `memory_item:${runMemory.id}`), true);
    assert.equal(hasSourceRef(sources.candidates, `memory_item:${approved.memoryItemId}`), true);
    assert.equal(hasSourceRef(sources.candidates, `memory_delta:${pending.id}`), false);
    assert.equal(sources.sourceRefs.rawEventRefs.some((ref) => ref.id === event.id && ref.sessionId === "session-producer"), true);
    assert.deepEqual(sources.sourceRefs.checkpointRefs, [checkpoint.id]);
    assert.deepEqual(sources.sourceRefs.artifactRefs, [artifact.artifactRefId]);
    assert.deepEqual(sources.pendingMemoryRefs, [`memory_delta:${pending.id}`]);
    assert.deepEqual(sources.invalidatedSourceRefs, [artifact.artifactRefId, `memory_item:${runMemory.id}`].sort());
    assert.deepEqual(sources.sourceRefs.rollbackMarkerRefs, ["rollback-marker:run-source-builder:consumer:2"]);
  } finally {
    await db.close();
  }
});

test("context source builder exposes explicit rejected artifact refs as failure candidates", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-source-builder-failure"));
    await createWorkflowTaskPg(db, {
      id: "verify",
      runId: "run-source-builder-failure",
      taskKey: "verify",
      status: "failed",
      sortOrder: 0,
      dependsOn: [],
    });
    const rejected = await acceptOrRejectArtifactRefPg(db, {
      runId: "run-source-builder-failure",
      taskId: "verify",
      sessionId: "session-verify",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-source-builder-failure:verify:attempt-1",
      producer: { actorType: "hand", providerId: "tork" },
      artifactType: "verification_report",
      status: "rejected",
      content: { kind: "verification_report", summary: "npm test failed", findings: ["missing handler"] },
      contractRefs: ["verification_report"],
      summary: "npm test failed",
      evidenceRefs: [],
      evaluatorResultRefs: [],
      sourceEventRefs: [],
    });

    const sources = await collectContextSourcesPg(db, {
      runId: "run-source-builder-failure",
      taskId: "repair",
      sessionId: "session-repair",
      dependsOn: [],
      query: "repair verifier failure",
      memoryScopes: ["software"],
      allowedMemoryKinds: ["repair_hint"],
      maxMemoryCandidates: 10,
      checkpointRefs: [],
      failureArtifactRefIds: [rejected.artifactRefId],
    });

    const failure = sources.candidates.find((candidate) => candidate.sourceRef === rejected.artifactRefId);
    assert.equal(failure?.sourceType, "failure");
    assert.match(failure?.text ?? "", /npm test failed/);
    assert.equal(sources.sourceRefs.failureArtifactRefs?.includes(rejected.artifactRefId), true);
  } finally {
    await db.close();
  }
});

function minimalRun(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "source builder",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({ activeTaskIds: [] }),
    runtimeContextJson: JSON.stringify({ scope: "software" }),
    metricsJson: JSON.stringify({}),
  };
}

function hasSourceRef(candidates: Array<{ sourceRef?: string }>, sourceRef: string): boolean {
  return candidates.some((candidate) => candidate.sourceRef === sourceRef);
}
