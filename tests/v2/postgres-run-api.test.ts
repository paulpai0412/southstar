import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";

test("Postgres run API creates draft, run, tasks, history, and Knowledge Card context packets", async () => {
  await withDb(async (db) => {
    await createLearningNode(db, {
      id: "card-run-api-self-check",
      nodeType: "knowledge_card",
      scope: "software",
      status: "active",
      payload: {
        cardType: "failure_lesson",
        topicKey: "run-api-self-check",
        scope: "software",
        title: "Run API self-check",
        summary: "Implementation reports should include commandsRun and risks.",
        appliesTo: { intents: ["implement_feature"], roles: ["maker"], artifactTypes: ["implementation-report"], agentProfiles: ["software-maker-pi"] },
        claims: [{ text: "Self-check reduces repair loops.", evidenceNodeRefs: ["card-run-api-self-check"] }],
        confidence: 0.9,
        successScore: 0.8,
        status: "active",
        riskTier: "low",
      },
      summaryText: "Implementation reports should include commandsRun and risks.",
    });

    const draft = await createPostgresPlannerDraft(db, { goalPrompt: "implement calc sum" });
    assert.match(draft.draftId, /^draft-wf-gen-/);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.match(run.runId, /^run-wf-gen-/);

    const runRow = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [run.runId]);
    assert.equal(runRow.status, "created");
    const taskRows = await db.query<{ id: string }>("select id from southstar.workflow_tasks where run_id = $1 order by sort_order", [run.runId]);
    assert.deepEqual(taskRows.rows.map((row) => row.id), ["understand-repo", "implement-feature", "verify-feature", "summarize-completion"]);

    const history = await db.query<{ event_type: string }>("select event_type from southstar.workflow_history where run_id = $1 order by sequence", [run.runId]);
    assert.deepEqual(history.rows.map((row) => row.event_type), ["run.created", "task.created", "task.created", "task.created", "task.created"]);

    const context = await db.one<{ payload_json: { selectedKnowledgeCards: Array<{ sourceRef: string }> } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'context_packet' and run_id = $1 and task_id = 'implement-feature'",
      [run.runId],
    );
    assert.equal(context.payload_json.selectedKnowledgeCards[0]?.sourceRef, "card-run-api-self-check");

    const trace = await db.one<{ payload_json: { selectedCardRefs: string[] } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'knowledge_card_injection_trace' and run_id = $1 and task_id = 'implement-feature'",
      [run.runId],
    );
    assert.deepEqual(trace.payload_json.selectedCardRefs, ["card-run-api-self-check"]);
  });
});

test("Postgres run API supports llm-constrained planner drafts and preserves task creation order", async () => {
  await withDb(async (db) => {
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
    });
    assert.match(draft.draftId, /^draft-wf-composed-/);

    const draftResource = await db.one<{
      summary_json: { planner?: string };
      payload_json: { orchestrationSnapshot?: { validation?: { ok?: boolean } } };
    }>(
      "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.summary_json.planner, "library-constrained-llm");
    assert.equal(draftResource.payload_json.orchestrationSnapshot?.validation?.ok, true);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.deepEqual(run.taskIds, [
      "understand-repo",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);
  });
});

test("Postgres planner draft can use injected scripted LLM composer for non-fixture DAG shape", async () => {
  await withDb(async (db) => {
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with a single exploration task",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer: {
        async compose() {
          return {
            schemaVersion: "southstar.workflow_composition_plan.v1",
            title: "Single Exploration Plan",
            selectedWorkflowTemplateRef: "template.software-feature",
            rationale: "scripted LLM plan for API test",
            tasks: [
              {
                id: "inspect-only",
                name: "Inspect Only",
                responsibility: "inspect repository and produce a plan",
                dependsOn: [],
                templateSlotRef: "understand",
                agentDefinitionRef: "agent.software-explorer",
                agentProfileRef: "profile.software-explorer-codex",
                instructionRefs: ["instruction.software-explorer"],
                skillRefs: ["skill.software-repo-discovery"],
                toolGrantRefs: ["tool.workspace-read"],
                mcpGrantRefs: [],
                vaultLeasePolicyRefs: [],
                inputArtifactRefs: [],
                outputArtifactRefs: ["artifact.implementation_plan"],
                evaluatorProfileRef: "evaluator.software-plan-quality",
                recoveryStrategyRefs: ["retry-same-agent"],
                rationale: "use only explorer candidate",
              },
            ],
            rejectedCandidates: [],
            generatedComponentProposals: [],
          };
        },
      },
    });

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.deepEqual(run.taskIds, ["inspect-only"]);
  });
});

test("Postgres run creation rejects invalid planner drafts", async () => {
  await withDb(async (db) => {
    await upsertRuntimeResourcePg(db, {
      id: "draft-invalid-test",
      resourceType: "planner_draft",
      resourceKey: "draft-invalid-test",
      scope: "planner",
      status: "invalid",
      title: "Invalid Draft",
      payload: { workflow: { workflowId: "wf-invalid" } },
      summary: { planner: "library-constrained-llm" },
    });
    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: "draft-invalid-test" }),
      /planner draft is not validated/,
    );
  });
});

test("Postgres server routes create planner drafts and runs through new API", async () => {
  await withDb(async (db) => {
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner client not used by Postgres constrained planner"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used by created-state route"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const draft = await api<{ draftId: string; workflowId: string }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({ goalPrompt: "implement calc sum" }),
      });
      assert.match(draft.draftId, /^draft-wf-gen-/);
      const run = await api<{ runId: string; taskIds: string[] }>(server.url, "/api/v2/runs", {
        method: "POST",
        body: JSON.stringify({ draftId: draft.draftId }),
      });
      assert.match(run.runId, /^run-wf-gen-/);
      assert.deepEqual(run.taskIds, ["understand-repo", "implement-feature", "verify-feature", "summarize-completion"]);

      const llmDraft = await api<{ draftId: string; workflowId: string }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({ goalPrompt: "implement calc sum", orchestrationMode: "llm-constrained" }),
      });
      assert.match(llmDraft.draftId, /^draft-wf-composed-/);

      const llmRun = await api<{ runId: string; taskIds: string[] }>(server.url, "/api/v2/runs", {
        method: "POST",
        body: JSON.stringify({ draftId: llmDraft.draftId }),
      });
      assert.deepEqual(llmRun.taskIds, [
        "understand-repo",
        "review-spec",
        "implement-feature",
        "verify-feature",
        "review-code-quality",
        "summarize-completion",
      ]);
    } finally {
      await server.close();
    }
  });
});

async function api<T>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
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
