import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { recordLearningSignal } from "../../src/v2/evolution/signals.ts";
import { approveKnowledgeCard, rejectKnowledgeCard, synthesizeKnowledgeCards, triggerRunCompletedKnowledgeCardSynthesis, validateKnowledgeCard } from "../../src/v2/evolution/cards.ts";
import { createWorkflowRunPg, appendHistoryEventPg, listHistoryForRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";

test("repeated repair signals synthesize schema-valid active Knowledge Card with cited evidence", async () => {
  await withDb(async (db) => {
    const first = await recordLearningSignal(db, repairSignal("run-1", "eval-1"));
    const second = await recordLearningSignal(db, repairSignal("run-2", "eval-2"));

    const result = await synthesizeKnowledgeCards(db, { actor: "test-operator", reason: "batch repeated repair signals" });
    assert.equal(result.cardIds.length, 1);

    const row = await db.one<{ status: string; payload_jsonb: Record<string, unknown> }>(
      "select status, payload_jsonb from southstar.learning_nodes where id = $1",
      [result.cardIds[0]],
    );
    assert.equal(row.status, "active");
    assert.equal(row.payload_jsonb.cardType, "failure_lesson");
    assert.equal(row.payload_jsonb.topicKey, "software:implement_feature:maker:implementation_report:missing_required_field:commandsRun-risks:software-maker-pi");
    assert.equal(row.payload_jsonb.status, "active");
    assert.equal(row.payload_jsonb.riskTier, "low");
    const claims = row.payload_jsonb.claims as Array<{ evidenceNodeRefs: string[] }>;
    assert.deepEqual(claims[0]?.evidenceNodeRefs.sort(), [first.nodeId, second.nodeId].sort());
    assert.equal(validateKnowledgeCard(row.payload_jsonb, new Set([first.nodeId, second.nodeId])).ok, true);
  });
});

test("high-risk card synthesis requires approval before activation", async () => {
  await withDb(async (db) => {
    await recordLearningSignal(db, highRiskSignal("run-1", "eval-1"));
    await recordLearningSignal(db, highRiskSignal("run-2", "eval-2"));

    const result = await synthesizeKnowledgeCards(db, { actor: "test-operator", reason: "security-sensitive repeated signals" });
    const row = await db.one<{ status: string; payload_jsonb: Record<string, unknown> }>(
      "select status, payload_jsonb from southstar.learning_nodes where id = $1",
      [result.cardIds[0]],
    );
    assert.equal(row.status, "pending_approval");
    assert.equal(row.payload_jsonb.status, "pending_approval");
    assert.equal(row.payload_jsonb.riskTier, "high");

    await approveKnowledgeCard(db, { cardId: result.cardIds[0]!, actor: "test-operator", reason: "reviewed bounded high-risk lesson", commandId: "cmd-approve-1" });
    const approved = await db.one<{ status: string; payload_jsonb: Record<string, unknown> }>(
      "select status, payload_jsonb from southstar.learning_nodes where id = $1",
      [result.cardIds[0]],
    );
    assert.equal(approved.status, "active");
    assert.equal(approved.payload_jsonb.status, "active");
  });
});

test("completed run trigger synthesizes Knowledge Cards once and records batch audit", async () => {
  await withDb(async (db) => {
    await createWorkflowRunPg(db, {
      id: "run-card-trigger",
      status: "passed",
      domain: "software",
      goalPrompt: "card trigger",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-card-trigger", tasks: [] }),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });
    await appendHistoryEventPg(db, { runId: "run-card-trigger", eventType: "run.completed", actorType: "orchestrator", payload: { status: "passed" } });
    await recordLearningSignal(db, repairSignal("run-card-trigger", "eval-1"));
    await recordLearningSignal(db, repairSignal("run-card-trigger", "eval-2"));

    const first = await triggerRunCompletedKnowledgeCardSynthesis(db, { runId: "run-card-trigger", actor: "southstar", reason: "run completed" });
    const second = await triggerRunCompletedKnowledgeCardSynthesis(db, { runId: "run-card-trigger", actor: "southstar", reason: "run completed" });

    assert.equal(first.triggered, true);
    assert.equal(first.cardIds.length, 1);
    assert.equal(second.triggered, false);
    assert.deepEqual(second.cardIds, first.cardIds);
    const batch = await db.one<{ resource_type: string; status: string; payload_json: { cardIds: string[] } }>(
      "select resource_type, status, payload_json from southstar.runtime_resources where resource_key = 'knowledge-card-synthesis-run-card-trigger'",
    );
    assert.equal(batch.resource_type, "knowledge_card_synthesis_batch");
    assert.equal(batch.status, "completed");
    assert.deepEqual(batch.payload_json.cardIds, first.cardIds);
    const history = await listHistoryForRunPg(db, "run-card-trigger");
    assert.equal(history.filter((event) => event.eventType === "evolution.knowledge_cards_synthesized").length, 1);
  });
});

test("concurrent completed run triggers claim the same Knowledge Card batch only once", async () => {
  await withDb(async (db) => {
    await createWorkflowRunPg(db, {
      id: "run-card-trigger-concurrent",
      status: "passed",
      domain: "software",
      goalPrompt: "card trigger concurrent",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-card-trigger-concurrent", tasks: [] }),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });
    await appendHistoryEventPg(db, {
      runId: "run-card-trigger-concurrent",
      eventType: "run.completed",
      actorType: "orchestrator",
      payload: { status: "passed" },
    });
    await recordLearningSignal(db, repairSignal("run-card-trigger-concurrent", "eval-1"));
    await recordLearningSignal(db, repairSignal("run-card-trigger-concurrent", "eval-2"));

    const gatedDb = gateConcurrentBatchRead(db, "knowledge-card-synthesis-run-card-trigger-concurrent");
    const results = await Promise.all([
      triggerRunCompletedKnowledgeCardSynthesis(gatedDb, { runId: "run-card-trigger-concurrent", actor: "southstar-a", reason: "run completed" }),
      triggerRunCompletedKnowledgeCardSynthesis(gatedDb, { runId: "run-card-trigger-concurrent", actor: "southstar-b", reason: "run completed" }),
    ]);

    assert.equal(results.filter((result) => result.triggered).length, 1);
    assert.equal(results.filter((result) => !result.triggered).length, 1);
    assert.deepEqual(results[0]?.cardIds, results[1]?.cardIds);
    assert.equal(results[0]?.cardIds.length, 1);
    const edges = await db.query<{ count: string }>(
      "select count(*) as count from southstar.learning_edges where from_node_id = $1 and edge_type = 'SUPPORTED_BY'",
      [results[0]?.cardIds[0]],
    );
    assert.equal(Number(edges.rows[0]?.count), 2);
    const batches = await db.query<{ resource_key: string; status: string; payload_json: { status?: string; cardIds?: string[] } }>(
      "select resource_key, status, payload_json from southstar.runtime_resources where resource_type = 'knowledge_card_synthesis_batch' and run_id = $1",
      ["run-card-trigger-concurrent"],
    );
    assert.equal(batches.rows.length, 1);
    assert.equal(batches.rows[0]?.status, "completed");
    assert.equal(batches.rows[0]?.payload_json.status, "completed");
    assert.deepEqual(batches.rows[0]?.payload_json.cardIds, results[0]?.cardIds);
    const history = await listHistoryForRunPg(db, "run-card-trigger-concurrent");
    assert.equal(history.filter((event) => event.eventType === "evolution.knowledge_cards_synthesized").length, 1);
  });
});

test("completed run trigger creates a new synthesis batch after recovery appends a later terminal evaluation", async () => {
  await withDb(async (db) => {
    await createWorkflowRunPg(db, {
      id: "run-card-trigger-recovery",
      status: "failed",
      domain: "software",
      goalPrompt: "card trigger recovery",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-card-trigger-recovery", tasks: [] }),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });
    await appendHistoryEventPg(db, {
      runId: "run-card-trigger-recovery",
      eventType: "run.completed",
      actorType: "evaluator",
      idempotencyKey: "completion-gate:run-card-trigger-recovery:completed:failed-attempt",
      payload: { status: "failed", findings: ["task failed"] },
    });

    const first = await triggerRunCompletedKnowledgeCardSynthesis(db, {
      runId: "run-card-trigger-recovery",
      actor: "southstar",
      reason: "run completed failed",
    });
    assert.equal(first.triggered, true);
    assert.deepEqual(first.cardIds, []);

    await recordLearningSignal(db, repairSignal("run-card-trigger-recovery", "eval-1"));
    await recordLearningSignal(db, repairSignal("run-card-trigger-recovery", "eval-2"));
    await db.query("update southstar.workflow_runs set status = 'passed', updated_at = now() where id = $1", ["run-card-trigger-recovery"]);
    await appendHistoryEventPg(db, {
      runId: "run-card-trigger-recovery",
      eventType: "run.completed",
      actorType: "evaluator",
      idempotencyKey: "completion-gate:run-card-trigger-recovery:completed:passed-attempt",
      payload: { status: "passed", findings: [] },
    });

    const second = await triggerRunCompletedKnowledgeCardSynthesis(db, {
      runId: "run-card-trigger-recovery",
      actor: "southstar",
      reason: "run completed after recovery",
    });

    assert.equal(second.triggered, true);
    assert.notEqual(second.batchId, first.batchId);
    assert.equal(second.cardIds.length, 1);
    const batches = await db.query<{ resource_key: string }>(
      "select resource_key from southstar.runtime_resources where resource_type = 'knowledge_card_synthesis_batch' and run_id = $1 order by created_at, resource_key",
      ["run-card-trigger-recovery"],
    );
    assert.deepEqual(batches.rows.map((row) => row.resource_key), [first.batchId, second.batchId]);
    const history = await listHistoryForRunPg(db, "run-card-trigger-recovery");
    assert.equal(history.filter((event) => event.eventType === "evolution.knowledge_cards_synthesized").length, 2);
  });
});

test("invalid card validation and rejection preserve the Knowledge Card node", async () => {
  await withDb(async (db) => {
    assert.equal(validateKnowledgeCard({ topicKey: "missing" }, new Set()).ok, false);
    await recordLearningSignal(db, repairSignal("run-1", "eval-1"));
    await recordLearningSignal(db, repairSignal("run-2", "eval-2"));
    const result = await synthesizeKnowledgeCards(db, { actor: "test-operator", reason: "candidate to reject" });

    await rejectKnowledgeCard(db, { cardId: result.cardIds[0]!, actor: "test-operator", reason: "operator rejected stale lesson", commandId: "cmd-reject-1" });
    const rejected = await db.one<{ status: string; payload_jsonb: Record<string, unknown> }>(
      "select status, payload_jsonb from southstar.learning_nodes where id = $1",
      [result.cardIds[0]],
    );
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.payload_jsonb.status, "rejected");
    assert.equal(rejected.payload_jsonb.rejectionReason, "operator rejected stale lesson");
  });
});

function repairSignal(runId: string, sourceRef: string) {
  return {
    signalKind: "repair_success",
    scope: "software",
    runId,
    taskId: "implement-feature",
    roleRef: "maker",
    intent: "implement_feature",
    agentProfileRef: "software-maker-pi",
    artifactType: "implementation_report",
    failureKind: "missing_required_field",
    missingFields: ["commandsRun", "risks"],
    repairInstruction: "include commandsRun and risks",
    outcome: "passed_after_repair",
    sourceRefs: [sourceRef],
  };
}

function highRiskSignal(runId: string, sourceRef: string) {
  return {
    ...repairSignal(runId, sourceRef),
    failureKind: "security_tool_grant_required",
    missingFields: ["github.pr-write"],
    repairInstruction: "consider tool/MCP grant expansion only after approval",
  };
}

function gateConcurrentBatchRead(db: SouthstarDb, batchId: string): SouthstarDb {
  let waiting = 0;
  let released = false;
  let release: () => void = () => {};
  const bothWaiting = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    query: db.query.bind(db),
    one: db.one.bind(db),
    async maybeOne(sql, params = []) {
      if (
        !released
        && typeof sql === "string"
        && sql.includes("resource_type = 'knowledge_card_synthesis_batch'")
        && params[0] === batchId
      ) {
        waiting += 1;
        if (waiting === 2) {
          released = true;
          release();
        }
        await Promise.race([
          bothWaiting,
          new Promise<void>((resolve) => setTimeout(resolve, 50)),
        ]);
        released = true;
        release();
      }
      return await db.maybeOne(sql, params);
    },
    tx: db.tx.bind(db),
    close: db.close.bind(db),
  };
}

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    const db = await openSouthstarDb(fixture.databaseUrl);
    try {
      await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await fixture.drop();
  }
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
    },
  };
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
