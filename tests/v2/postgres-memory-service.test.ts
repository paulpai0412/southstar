import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  approveMemoryDeltaPg,
  createMemoryDeltaPg,
  invalidateRunLocalMemoryPg,
  searchContextMemoryPg,
  writeRunLocalMemoryPg,
} from "../../src/v2/memory/postgres-memory-service.ts";

test("Postgres memory service keeps run-local memory separate from approved long-term memory", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-1"));
    await createWorkflowRunPg(db, minimalRun("run-2"));

    const runLocal = await writeRunLocalMemoryPg(db, {
      runId: "run-1",
      taskId: "task-1",
      sessionId: "session-1",
      scope: "software",
      kind: "repair_hint",
      text: "Use the ledger checkpoint when repairing validator failures.",
      tags: ["validator", "checkpoint"],
      sourceRefs: ["history:run-1:7", "artifact_ref:validator-report"],
      confidence: 0.85,
      successScore: 0.7,
    });

    const sameRun = await searchContextMemoryPg(db, {
      runId: "run-1",
      scope: "software",
      query: "validator checkpoint",
      maxCandidates: 10,
    });
    assert.deepEqual(sameRun.map((candidate) => candidate.id), [runLocal.id]);
    assert.equal(sameRun[0]?.lifecycle, "run-local");
    assert.equal(sameRun[0]?.sourceRef, `memory_item:${runLocal.id}`);

    const otherRunBeforeApproval = await searchContextMemoryPg(db, {
      runId: "run-2",
      scope: "software",
      query: "validator checkpoint",
      maxCandidates: 10,
    });
    assert.deepEqual(otherRunBeforeApproval, []);

    const delta = await createMemoryDeltaPg(db, {
      runId: "run-1",
      taskId: "task-1",
      sessionId: "session-1",
      scope: "software",
      kind: "repair_hint",
      text: "Validator checkpoint repairs should cite the ledger checkpoint.",
      tags: ["validator", "checkpoint"],
      sourceRefs: ["history:run-1:8"],
      confidence: 0.9,
      successScore: 0.8,
    });

    const beforeApproval = await searchContextMemoryPg(db, {
      runId: "run-2",
      scope: "software",
      query: "ledger checkpoint",
      maxCandidates: 10,
    });
    assert.deepEqual(beforeApproval, []);

    const approved = await approveMemoryDeltaPg(db, {
      deltaId: delta.id,
      approvedBy: "operator",
      reason: "useful cross-run repair guidance",
    });

    const afterApproval = await searchContextMemoryPg(db, {
      runId: "run-2",
      scope: "software",
      query: "ledger checkpoint",
      maxCandidates: 10,
    });
    assert.deepEqual(afterApproval.map((candidate) => candidate.id), [approved.memoryItemId]);
    assert.equal(afterApproval[0]?.lifecycle, "approved");
    assert.equal(afterApproval[0]?.sourceRef, `memory_item:${approved.memoryItemId}`);
    assert.equal(afterApproval[0]?.scope, "software");

    const otherScope = await searchContextMemoryPg(db, {
      runId: "run-2",
      scope: "docs",
      query: "ledger checkpoint",
      maxCandidates: 10,
    });
    assert.deepEqual(otherScope, []);

    const invalidated = await invalidateRunLocalMemoryPg(db, {
      runId: "run-1",
      sourceRefs: ["artifact_ref:validator-report"],
      reason: "source artifact was superseded",
    });
    assert.deepEqual(invalidated.invalidatedIds, [runLocal.id]);

    const sameRunAfterInvalidation = await searchContextMemoryPg(db, {
      runId: "run-1",
      scope: "software",
      query: "validator checkpoint",
      maxCandidates: 10,
    });
    assert.deepEqual(sameRunAfterInvalidation.map((candidate) => candidate.id), [approved.memoryItemId]);
  } finally {
    await db.close();
  }
});

function minimalRun(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "implement managed context memory",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({ activeTaskIds: [] }),
    runtimeContextJson: JSON.stringify({ scope: "software" }),
    metricsJson: JSON.stringify({}),
  };
}
