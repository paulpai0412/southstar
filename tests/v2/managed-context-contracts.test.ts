import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION,
  type ContextAssemblyTrace,
  type ContextBlockCandidate,
  type ManagedContextSourceRefs,
} from "../../src/v2/context/types.ts";
import type { RecoveryPath, RuntimeExceptionKind } from "../../src/v2/exceptions/types.ts";

test("managed context contracts expose attempt lineage, trace, memory refs, and rollback refs", () => {
  const candidate: ContextBlockCandidate = {
    id: "candidate-memory-1",
    sourceType: "memory",
    title: "Repair hint",
    text: "Validator failure can be repaired by updating tests.",
    sourceRef: "memory_item:run-local:1",
    tokenEstimate: 12,
    score: 0.8,
    lineage: {
      runId: "run-1",
      taskId: "implement",
      sessionId: "session-1",
      attemptId: "implement-attempt-2",
      handExecutionId: "hand-execution:run-1:implement:implement-attempt-2",
      contextPacketId: "ctx-run-1-implement-attempt-2",
      taskEnvelopeId: "task-envelope-run-1-implement-attempt-2",
      artifactRefIds: ["artifact_ref:run-1:producer"],
      checkpointId: "checkpoint-1",
    },
  };

  assert.equal(candidate.lineage?.attemptId, "implement-attempt-2");
  assert.equal(candidate.score, 0.8);

  const refs: ManagedContextSourceRefs = {
    rawEventRefs: [{ id: "event-1", sessionId: "session-1", runId: "run-1", sequence: 1 }],
    omittedEventRanges: [{ fromSequence: 2, toSequence: 4, reason: "reset-session excluded failed suffix" }],
    transformRefs: [{ id: "summary-1", kind: "summary", sourceEventIds: ["event-1"] }],
    checkpointRefs: ["checkpoint-1"],
    artifactRefs: ["artifact_ref:run-1:producer"],
    memoryRefs: ["memory_item:run-local:1"],
    rollbackMarkerRefs: ["rollback-marker-1"],
    cacheKey: "stable",
  };

  assert.deepEqual(refs.artifactRefs, ["artifact_ref:run-1:producer"]);
  assert.deepEqual(refs.memoryRefs, ["memory_item:run-local:1"]);
  assert.deepEqual(refs.rollbackMarkerRefs, ["rollback-marker-1"]);

  const trace: ContextAssemblyTrace = {
    schemaVersion: CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION,
    traceId: "context-trace-run-1-implement-attempt-2",
    runId: "run-1",
    taskId: "implement",
    sessionId: "session-1",
    attemptId: "implement-attempt-2",
    handExecutionId: "hand-execution:run-1:implement:implement-attempt-2",
    contextPacketId: "ctx-run-1-implement-attempt-2",
    taskEnvelopeId: "task-envelope-run-1-implement-attempt-2",
    selectedSourceRefs: ["memory_item:run-local:1"],
    excludedCandidates: [{ sourceRef: "memory_delta:pending-1", reason: "scope-mismatch", tokenEstimate: 20 }],
    tokenEstimate: { total: 12, bySourceType: { memory: 12 } },
    validation: { ok: true, errors: [] },
    createdAt: "2026-06-22T00:00:00.000Z",
  };

  assert.equal(trace.validation.ok, true);
  assert.equal(trace.schemaVersion, "southstar.context_assembly_trace.v1");
});

test("runtime exception contracts include managed context recovery paths", () => {
  const path: RecoveryPath = "reset-session";
  const rollbackPath: RecoveryPath = "rollback-session";
  const exceptionKind: RuntimeExceptionKind = "validation_failed";
  assert.equal(path, "reset-session");
  assert.equal(rollbackPath, "rollback-session");
  assert.equal(exceptionKind, "validation_failed");
});
