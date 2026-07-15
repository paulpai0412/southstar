import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { loadRunLibrarySnapshotPg } from "../../src/v2/orchestration/run-library-snapshot.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { createSandboxExperiment, recordSandboxTrial, evaluateSandboxExperiment, startSandboxExecutionPg, recordSandboxEvaluatorOutputPg } from "../../src/v2/evolution/sandbox.ts";
import { DeterministicFixtureComposer, seedDeterministicWorkflowGraph } from "./fixtures/deterministic-workflow-composer.ts";
import { fixedGoalInterpreter, softwareGoalContract } from "./fixtures/goal-contract.ts";

test("sandbox experiment passes when candidate is no worse than baseline and fixes targeted replay", async () => {
  await withDb(async (db) => {
    await seedDelta(db, "delta-sandbox-pass");
    const experiment = await createSandboxExperiment(db, {
      deltaProposalId: "delta-sandbox-pass",
      baselineAssetRefs: ["prompt@v1"],
      candidateAssetRefs: ["prompt@v2-candidate"],
      regressionSuiteRefs: ["software-core-regression"],
      replayRunRefs: ["run-failed-1"],
      maxCostRegressionPercent: 10,
      maxDurationRegressionPercent: 15,
    });

    await recordSandboxTrial(db, {
      experimentId: experiment.experimentId,
      variant: "baseline",
      caseRef: "run-failed-1",
      status: "failed",
      targetedReplayFixed: false,
      metrics: { durationMs: 1000, costMicrosUsd: 1000, repairCount: 1, tokens: 1000, toolCalls: 4 },
    });
    await recordSandboxTrial(db, {
      experimentId: experiment.experimentId,
      variant: "candidate",
      caseRef: "run-failed-1",
      status: "passed",
      targetedReplayFixed: true,
      metrics: { durationMs: 1050, costMicrosUsd: 1050, repairCount: 0, tokens: 1000, toolCalls: 4 },
    });

    const decision = await evaluateSandboxExperiment(db, experiment.experimentId);
    assert.equal(decision.decision, "passed");
    assert.equal(decision.reasons.includes("candidate pass rate is at least baseline"), true);

    const resource = await db.one<{ status: string; payload_json: { decision: string } }>(
      "select status, payload_json from southstar.runtime_resources where resource_key = $1",
      [experiment.experimentId],
    );
    assert.equal(resource.status, "passed");
    assert.equal(resource.payload_json.decision, "passed");

    const edge = await db.one<{ edge_type: string }>(
      "select edge_type from southstar.learning_edges where from_node_id = $1 and to_node_id = $2",
      ["delta-sandbox-pass", experiment.experimentId],
    );
    assert.equal(edge.edge_type, "TESTED");
  });
});

test("sandbox experiment fails when candidate introduces cost regression or fails targeted replay", async () => {
  await withDb(async (db) => {
    await seedDelta(db, "delta-sandbox-fail");
    const experiment = await createSandboxExperiment(db, {
      deltaProposalId: "delta-sandbox-fail",
      baselineAssetRefs: ["skill@v1"],
      candidateAssetRefs: ["skill@v2-candidate"],
      regressionSuiteRefs: ["software-core-regression"],
      replayRunRefs: ["run-failed-2"],
      maxCostRegressionPercent: 10,
      maxDurationRegressionPercent: 15,
    });
    await recordSandboxTrial(db, {
      experimentId: experiment.experimentId,
      variant: "baseline",
      caseRef: "run-failed-2",
      status: "passed",
      targetedReplayFixed: true,
      metrics: { durationMs: 1000, costMicrosUsd: 1000, repairCount: 0, tokens: 1000, toolCalls: 4 },
    });
    await recordSandboxTrial(db, {
      experimentId: experiment.experimentId,
      variant: "candidate",
      caseRef: "run-failed-2",
      status: "passed",
      targetedReplayFixed: false,
      metrics: { durationMs: 1100, costMicrosUsd: 1400, repairCount: 0, tokens: 1200, toolCalls: 5 },
    });

    const decision = await evaluateSandboxExperiment(db, experiment.experimentId);
    assert.equal(decision.decision, "failed");
    assert.equal(decision.reasons.some((reason) => /targeted replay failure was not fixed/.test(reason)), true);
    assert.equal(decision.reasons.some((reason) => /cost regression/.test(reason)), true);
  });
});

test("sandbox execution materializes baseline and candidate runs with env markers and evaluator-driven decision", async () => {
  await withDb(async (db) => {
    await seedDelta(db, "delta-sandbox-execution");
    await seedDeterministicWorkflowGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "sandbox replay implementation",
      goalInterpreter: fixedGoalInterpreter(softwareGoalContract("sandbox replay implementation")),
      composer: new DeterministicFixtureComposer(),
    });
    const replayRun = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const replaySnapshot = await loadRunLibrarySnapshotPg(db, replayRun.runId);
    const maker = replaySnapshot.objects.find((object) => object.objectKey === "agent.software-maker");
    assert.ok(maker);
    await upsertLibraryObject(db, {
      objectKey: maker.objectKey,
      objectKind: maker.objectKind,
      status: "approved",
      headVersionId: "agent.software-maker@mutated-after-parent-run",
      state: { ...maker.state, body: "MUTATED AFTER PARENT RUN" },
    });
    const experiment = await createSandboxExperiment(db, {
      deltaProposalId: "delta-sandbox-execution",
      baselineAssetRefs: [],
      candidateAssetRefs: [],
      regressionSuiteRefs: ["software-core-regression"],
      replayRunRefs: [replayRun.runId],
      maxCostRegressionPercent: 10,
      maxDurationRegressionPercent: 15,
    });
    const submissions: Array<{ runId: string; env?: Record<string, string> }> = [];
    const started = await startSandboxExecutionPg(db, {
      experimentId: experiment.experimentId,
      executorProvider: {
        executorType: "tork",
        submit: async (request) => {
          submissions.push({ runId: request.runId, env: request.workflow.tasks[0]?.execution.env });
          return { executorType: "tork", externalJobId: `job-${request.runId}`, status: "queued", executionProjection: { sandbox: true } };
        },
      },
      callbackUrl: "http://127.0.0.1/callback",
      heartbeatUrl: "http://127.0.0.1/heartbeat",
    });

    assert.deepEqual(Object.keys(started.runs).sort(), ["baseline", "candidate"]);
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0]?.env?.SOUTHSTAR_RUN_MODE, "sandbox");
    assert.equal(submissions[0]?.env?.SOUTHSTAR_SANDBOX_EXPERIMENT_ID, experiment.experimentId);
    assert.equal(submissions[1]?.env?.SOUTHSTAR_SANDBOX_VARIANT, "candidate");

    for (const childRunId of [started.runs.baseline.runId, started.runs.candidate.runId]) {
      const childSnapshot = await loadRunLibrarySnapshotPg(db, childRunId);
      assert.equal(childSnapshot.runId, childRunId);
      assert.notEqual(childSnapshot.snapshotHash, replaySnapshot.snapshotHash);
      assert.deepEqual(childSnapshot.objects, replaySnapshot.objects);
      assert.equal(
        childSnapshot.objects.find((object) => object.objectKey === maker.objectKey)?.stateHash,
        maker.stateHash,
      );
    }

    const runRows = await db.query<{ id: string; runtime_context_json: { runMode?: string; sandboxExperimentId?: string; sandboxVariant?: string } }>(
      "select id, runtime_context_json from southstar.workflow_runs where id = any($1::text[]) order by id",
      [[started.runs.baseline.runId, started.runs.candidate.runId]],
    );
    assert.equal(runRows.rows.every((row) => row.runtime_context_json.runMode === "sandbox" && row.runtime_context_json.sandboxExperimentId === experiment.experimentId), true);

    const workspaces = await db.query<{ payload_json: { path?: string; variant?: string } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'sandbox_workspace' order by resource_key",
    );
    assert.equal(workspaces.rows.length, 2);
    assert.equal(workspaces.rows.some((row) => row.payload_json.variant === "baseline"), true);
    assert.equal(workspaces.rows.some((row) => row.payload_json.variant === "candidate"), true);

    await recordSandboxEvaluatorOutputPg(db, {
      experimentId: experiment.experimentId,
      variant: "baseline",
      caseRef: replayRun.runId,
      evaluatorResult: { ok: false, metrics: { durationMs: 1000, costMicrosUsd: 1000, repairCount: 1, tokens: 1000, toolCalls: 4 } },
    });
    const decision = await recordSandboxEvaluatorOutputPg(db, {
      experimentId: experiment.experimentId,
      variant: "candidate",
      caseRef: replayRun.runId,
      evaluatorResult: { ok: true, targetedReplayFixed: true, metrics: { durationMs: 1050, costMicrosUsd: 1050, repairCount: 0, tokens: 1000, toolCalls: 4 } },
    });
    assert.equal(decision?.decision, "passed");
  });
});

test("sandbox execution rejects asset refs that are not materializable from the source snapshot", async () => {
  await withDb(async (db) => {
    await seedDelta(db, "delta-sandbox-unmaterializable");
    await seedDeterministicWorkflowGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "sandbox asset validation",
      goalInterpreter: fixedGoalInterpreter(softwareGoalContract("sandbox asset validation")),
      composer: new DeterministicFixtureComposer(),
    });
    const replayRun = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const experiment = await createSandboxExperiment(db, {
      deltaProposalId: "delta-sandbox-unmaterializable",
      baselineAssetRefs: ["asset.missing"],
      candidateAssetRefs: [],
      regressionSuiteRefs: ["software-core-regression"],
      replayRunRefs: [replayRun.runId],
      maxCostRegressionPercent: 10,
      maxDurationRegressionPercent: 15,
    });

    await assert.rejects(
      () => startSandboxExecutionPg(db, {
        experimentId: experiment.experimentId,
        executorProvider: {
          executorType: "tork",
          submit: async () => ({ executorType: "tork", externalJobId: "unused", status: "queued", executionProjection: {} }),
        },
        callbackUrl: "http://127.0.0.1/callback",
      }),
      /sandbox asset cannot be materialized/,
    );
  });
});

test("sandbox records no dedicated sandbox_experiments table", async () => {
  await withDb(async (db) => {
    await seedDelta(db, "delta-sandbox-table-check");
    await createSandboxExperiment(db, {
      deltaProposalId: "delta-sandbox-table-check",
      baselineAssetRefs: [],
      candidateAssetRefs: [],
      regressionSuiteRefs: ["software-core-regression"],
      replayRunRefs: [],
      maxCostRegressionPercent: 10,
      maxDurationRegressionPercent: 15,
    });
    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'southstar' and table_name = 'sandbox_experiments'",
    );
    assert.deepEqual(tables.rows, []);
  });
});

async function seedDelta(db: SouthstarDb, deltaId: string): Promise<void> {
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values ($1, 'delta_proposal', $1, 'evolution', 'validated', $1, $2::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
    [deltaId, JSON.stringify({ id: deltaId, deltaKind: "prompt_delta", status: "validated" })],
  );
  await createLearningNode(db, {
    id: deltaId,
    nodeType: "delta_proposal",
    scope: "evolution",
    status: "validated",
    payload: { id: deltaId, deltaKind: "prompt_delta", status: "validated" },
    summaryText: deltaId,
  });
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
