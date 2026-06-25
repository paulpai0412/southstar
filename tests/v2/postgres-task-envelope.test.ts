import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { getPostgresTaskEnvelope } from "../../src/v2/ui-api/postgres-task-envelope.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";

test("Postgres task envelope API builds TaskEnvelopeV2 from Postgres run, task, and context packet", async () => {
  await withDb(async (db) => {
    await seedKnowledgeCard(db);
    const draft = await createPostgresPlannerDraft(db, { goalPrompt: "implement calc sum" });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });

    const envelope = await getPostgresTaskEnvelope(db, { runId: run.runId, taskId: "implement-feature" });

    assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
    assert.equal(envelope.runId, run.runId);
    assert.equal(envelope.taskId, "implement-feature");
    assert.equal(envelope.role.id, "maker");
    assert.equal(envelope.agentProfile.id, "software-maker-pi");
    assert.equal(envelope.contextPacket.selectedKnowledgeCards[0]?.sourceRef, "card-envelope-self-check");
    assert.match(envelope.agentPrompt, /Knowledge Cards/);
    assert.match(envelope.agentPrompt, /commandsRun and risks/);
    assert.equal(envelope.artifactContracts.some((contract) => contract.id === "implementation_report"), true);
    assert.equal(envelope.evaluatorPipeline.id, "software-feature-quality");
  });
});

test("Postgres task envelope API returns the latest persisted task envelope before fallback building", async () => {
  await withDb(async (db) => {
    await seedKnowledgeCard(db);
    const draft = await createPostgresPlannerDraft(db, { goalPrompt: "implement calc sum" });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const fallbackEnvelope = await getPostgresTaskEnvelope(db, { runId: run.runId, taskId: "implement-feature" });
    const persistedEnvelope = {
      ...fallbackEnvelope,
      contextPacket: {
        ...fallbackEnvelope.contextPacket,
        id: "ctx-persisted-envelope",
      },
      session: {
        ...fallbackEnvelope.session,
        sessionId: "session-persisted-envelope",
      },
    };

    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: "task-envelope-persisted",
      runId: run.runId,
      taskId: "implement-feature",
      sessionId: "session-persisted-envelope",
      scope: "task",
      status: "materialized",
      payload: { envelope: persistedEnvelope },
      summary: { contextPacketId: "ctx-persisted-envelope" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: "task-envelope-legacy-metadata-only",
      runId: run.runId,
      taskId: "implement-feature",
      sessionId: "session-legacy",
      scope: "task",
      status: "materialized",
      payload: { envelopePath: "/tmp/legacy-envelope.json", taskDir: "/tmp/legacy-task", attemptId: "legacy-attempt" },
      summary: { contextPacketId: "ctx-legacy-metadata-only" },
    });

    const envelope = await getPostgresTaskEnvelope(db, { runId: run.runId, taskId: "implement-feature" });

    assert.equal(envelope.contextPacket.id, "ctx-persisted-envelope");
    assert.equal(envelope.session.sessionId, "session-persisted-envelope");
  });
});

test("Postgres server task envelope route uses new TaskEnvelope API", async () => {
  await withDb(async (db) => {
    await seedKnowledgeCard(db);
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const draft = await api<{ draftId: string }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({ goalPrompt: "implement calc sum" }),
      });
      const run = await api<{ runId: string }>(server.url, "/api/v2/runs", {
        method: "POST",
        body: JSON.stringify({ draftId: draft.draftId }),
      });
      const envelope = await api<{ schemaVersion: string; taskId: string; contextPacket: { selectedKnowledgeCards: Array<{ sourceRef: string }> } }>(
        server.url,
        `/api/v2/runs/${encodeURIComponent(run.runId)}/tasks/implement-feature/envelope`,
      );
      assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
      assert.equal(envelope.taskId, "implement-feature");
      assert.equal(envelope.contextPacket.selectedKnowledgeCards[0]?.sourceRef, "card-envelope-self-check");
    } finally {
      await server.close();
    }
  });
});

test("Postgres task envelope fallback normalizes legacy library aliases through shared compatibility rules", async () => {
  await withDb(async (db) => {
    await seedKnowledgeCard(db);
    await createWorkflowRunPg(db, {
      id: "run-envelope-legacy-refs",
      status: "running",
      domain: "software",
      goalPrompt: "legacy refs envelope test",
      workflowManifestJson: JSON.stringify(legacyRefManifest()),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-envelope-legacy-refs",
      taskKey: "implement-feature",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-envelope-legacy-refs",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "context_packet",
      resourceKey: "ctx-envelope-legacy-refs",
      runId: "run-envelope-legacy-refs",
      taskId: "implement-feature",
      sessionId: "session-envelope-legacy-refs",
      scope: "context",
      status: "created",
      payload: {
        id: "ctx-envelope-legacy-refs",
        runId: "run-envelope-legacy-refs",
        taskId: "implement-feature",
        rootSessionId: "session-envelope-legacy-refs",
        executionAttempt: 1,
        roleRef: "maker",
        agentProfileRef: "software-maker-pi",
        taskGoal: "legacy refs envelope test",
        roleInstruction: "implement feature",
        systemInstruction: "prompt.software-maker",
        agentsMdBlocks: [],
        artifactContracts: [],
        selectedMemories: [],
        selectedKnowledgeCards: [],
        priorArtifacts: [],
        skillInstructions: [],
        mcpGrantSummary: [],
        forbiddenActions: [],
        budget: { maxInputTokens: 4000, maxOutputTokens: 2000, maxToolCalls: 8, maxExecutionMinutes: 30 },
        tokenEstimate: { total: 100, bySource: {}, truncated: false },
        excludedCandidates: [],
        managedSourceRefs: {
          artifactRefs: [],
          memoryItemRefs: [],
          memoryDeltaRefs: [],
          knowledgeCardRefs: [],
          checkpointRefs: [],
          handExecutionRefs: [],
          rollbackMarkerRefs: [],
          resetMarkerRefs: [],
        },
      },
      summary: { contextPacketId: "ctx-envelope-legacy-refs" },
    });

    const envelope = await getPostgresTaskEnvelope(db, { runId: "run-envelope-legacy-refs", taskId: "implement-feature" });

    assert.equal(envelope.materializedLibraryRefs?.instructionRefs.includes("instruction.software-maker"), true);
    assert.equal(envelope.materializedLibraryRefs?.instructionRefs.includes("software.maker"), false);
    assert.equal(envelope.materializedLibraryRefs?.skillRefs.includes("skill.software-implementation"), true);
    assert.equal(envelope.materializedLibraryRefs?.skillRefs.includes("software.implementation"), false);
    assert.equal(envelope.materializedLibraryRefs?.toolGrantRefs.includes("tool.workspace-write"), true);
    assert.equal(envelope.materializedLibraryRefs?.toolGrantRefs.includes("software.workspace-write"), false);
    assert.equal(envelope.materializedLibraryRefs?.mcpGrantRefs.includes("mcp.filesystem-workspace"), true);
    assert.equal(envelope.materializedLibraryRefs?.mcpGrantRefs.includes("filesystem-workspace"), false);
  });
});

async function seedKnowledgeCard(db: SouthstarDb): Promise<void> {
  await createLearningNode(db, {
    id: "card-envelope-self-check",
    nodeType: "knowledge_card",
    scope: "software",
    status: "active",
    payload: {
      cardType: "failure_lesson",
      topicKey: "envelope-self-check",
      scope: "software",
      title: "Envelope self-check",
      summary: "Implementation reports should include commandsRun and risks.",
      appliesTo: { intents: ["implement_feature"], roles: ["maker"], artifactTypes: ["implementation-report"], agentProfiles: ["software-maker-pi"] },
      claims: [{ text: "Self-check reduces repair loops.", evidenceNodeRefs: ["card-envelope-self-check"] }],
      confidence: 0.9,
      successScore: 0.8,
      status: "active",
      riskTier: "low",
    },
    summaryText: "Implementation reports should include commandsRun and risks.",
  });
}

async function api<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
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

function legacyRefManifest() {
  const makerRole = softwareDomainPack.roles.find((role) => role.id === "maker");
  const makerProfile = softwareDomainPack.agentProfiles.find((profile) => profile.id === "software-maker-pi");
  if (!makerRole || !makerProfile) throw new Error("softwareDomainPack missing maker role/profile");
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-envelope-legacy-refs",
    title: "Legacy Ref Envelope",
    goalPrompt: "legacy refs envelope test",
    domain: "software",
    intent: "implement_feature",
    roles: [makerRole],
    agentProfiles: [makerProfile],
    tasks: [{
      id: "implement-feature",
      name: "Implement Feature",
      domain: "software",
      dependsOn: [],
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      evaluatorPipelineRef: "software-feature-quality",
      requiredArtifactRefs: ["implementation_report"],
      instructionRefs: ["software.maker"],
      skillRefs: ["software.implementation"],
      toolGrantRefs: ["software.workspace-read", "software.workspace-write", "software.shell-command"],
      mcpGrantRefs: ["filesystem-workspace"],
      vaultLeasePolicyRefs: ["software.github-write-token"],
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 600,
        infraRetry: { maxAttempts: 1 },
      },
      subagents: [],
    }],
    harnessDefinitions: [{
      id: "pi",
      kind: "pi-agent",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: [] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}
