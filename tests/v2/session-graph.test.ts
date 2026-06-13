import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createSqliteSessionGraphProvider } from "../../src/v2/session-graph/sqlite-provider.ts";

test("records checkpoint, fork, reset and rollback lineage without deleting history", () => {
  const db = openSouthstarDb(":memory:");
  insertRun(db, "run-sg");
  const graph = createSqliteSessionGraphProvider(db);
  const session = graph.createSession({
    runId: "run-sg",
    taskId: "implement-feature",
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
  });
  const checkpoint = graph.checkpoint({
    sessionId: session.id,
    runId: "run-sg",
    taskId: "implement-feature",
    contextPacketId: "ctx-run-sg-implement-feature",
    artifactRefs: ["artifact-1"],
    transcriptSummary: "Implemented first attempt.",
    metrics: { tokens: 100, durationMs: 50 },
  });
  const fork = graph.fork({
    runId: "run-sg",
    taskId: "implement-feature",
    baseCheckpointId: checkpoint.id,
    reason: "checker rejected docs",
  });
  graph.reset({
    runId: "run-sg",
    taskId: "implement-feature",
    baseCheckpointId: checkpoint.id,
    reason: "fresh retry",
  });
  const rollback = graph.rollback({ runId: "run-sg", checkpointId: checkpoint.id, reason: "test failure" });

  assert.equal(fork.baseCheckpointId, checkpoint.id);
  assert.equal(rollback.restoredCheckpointId, checkpoint.id);
  assert.equal(count(db, "session_node") >= 3, true);
  assert.equal(count(db, "session_checkpoint") >= 1, true);
  assert.equal(count(db, "recovery_decision") >= 2, true);
  assert.equal(countForRun(db, "recovery_decision", "run-sg") >= 2, true);
});

test("session graph fails closed when workflow run is unknown", () => {
  const db = openSouthstarDb(":memory:");
  const graph = createSqliteSessionGraphProvider(db);

  assert.throws(() => graph.createSession({
    runId: "missing-run",
    taskId: "implement-feature",
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
  }), /unknown workflow run/);
});

test("session graph rejects cross-run recovery from another run checkpoint", () => {
  const db = openSouthstarDb(":memory:");
  insertRun(db, "run-a");
  insertRun(db, "run-b");
  const graph = createSqliteSessionGraphProvider(db);
  const session = graph.createSession({
    runId: "run-a",
    taskId: "implement-feature",
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
  });
  const checkpoint = graph.checkpoint({
    sessionId: session.id,
    runId: "run-a",
    taskId: "implement-feature",
    contextPacketId: "ctx-run-a-implement-feature",
    artifactRefs: ["artifact-a"],
    transcriptSummary: "run-a checkpoint",
  });

  assert.throws(() => graph.fork({
    runId: "run-b",
    taskId: "implement-feature",
    baseCheckpointId: checkpoint.id,
    reason: "should not cross run boundary",
  }), /checkpoint .* does not belong to workflow run run-b/);
  assert.equal(countForRun(db, "recovery_decision", "run-b"), 0);
});

function count(db: ReturnType<typeof openSouthstarDb>, type: string): number {
  const row = db.prepare("select count(*) as count from runtime_resources where resource_type = ?").get(type) as { count: number };
  return row.count;
}

function countForRun(db: ReturnType<typeof openSouthstarDb>, type: string, runId: string): number {
  const row = db.prepare("select count(*) as count from runtime_resources where resource_type = ? and run_id = ?")
    .get(type, runId) as { count: number };
  return row.count;
}

function insertRun(db: ReturnType<typeof openSouthstarDb>, runId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    insert into workflow_runs (
      id, status, domain, goal_prompt, workflow_manifest_json, execution_projection_json,
      snapshot_json, runtime_context_json, metrics_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    "running",
    "software",
    "Implement calc sum",
    JSON.stringify({ workflowId: "wf-sg", tasks: [] }),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({}),
    now,
    now,
  );
}
