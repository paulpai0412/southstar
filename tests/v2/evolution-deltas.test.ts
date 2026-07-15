import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { synthesizeDeltaProposals, validateDeltaProposal } from "../../src/v2/evolution/deltas.ts";
import { createAssetVersion } from "../../src/v2/evolution/assets.ts";

test("active failure lesson card creates prompt delta resource and graph lineage", async () => {
  await withDb(async (db) => {
    const card = await seedCard(db, {
      id: "card-prompt-delta",
      cardType: "failure_lesson",
      topicKey: "implementation-report-self-check",
      riskTier: "low",
      appliesTo: { artifactTypes: ["implementation_report"], promptTemplates: ["prompt-software-maker"] },
    });
    await createAssetVersion(db, { assetKind: "prompt_template", assetRef: "prompt-software-maker", version: "v1", status: "active", payload: { template: "existing" } });

    const result = await synthesizeDeltaProposals(db, {
      actor: "test-operator",
      reason: "derive prompt delta from repeated implementation report repair card",
      sourceCardRefs: [card.id],
      targetRef: "prompt-software-maker",
      targetVersion: "v1",
    });
    assert.equal(result.deltaIds.length, 1);

    const resource = await db.one<{ resource_type: string; status: string; payload_json: Record<string, unknown> }>(
      "select resource_type, status, payload_json from southstar.runtime_resources where resource_key = $1",
      [result.deltaIds[0]],
    );
    assert.equal(resource.resource_type, "delta_proposal");
    assert.equal(resource.status, "proposed");
    assert.equal(resource.payload_json.deltaKind, "prompt_delta");
    assert.equal(resource.payload_json.targetRef, "prompt-software-maker");

    const node = await db.one<{ node_type: string; status: string }>(
      "select node_type, status from southstar.learning_nodes where id = $1",
      [result.deltaIds[0]],
    );
    assert.equal(node.node_type, "delta_proposal");
    assert.equal(node.status, "proposed");

    const edge = await db.one<{ edge_type: string; from_node_id: string; to_node_id: string }>(
      "select edge_type, from_node_id, to_node_id from southstar.learning_edges where from_node_id = $1 and to_node_id = $2",
      [result.deltaIds[0], card.id],
    );
    assert.equal(edge.edge_type, "BASED_ON");
  });
});

test("delta classifier covers skill, profile, and flow cards without dedicated delta table", async () => {
  await withDb(async (db) => {
    const skill = await seedCard(db, { id: "card-skill", cardType: "success_pattern", topicKey: "skill-checklist", riskTier: "low", appliesTo: { skills: ["software.test-evidence"] } });
    const profile = await seedCard(db, { id: "card-profile", cardType: "profile_lesson", topicKey: "profile-routing", riskTier: "medium", appliesTo: { agentProfiles: ["software-maker-pi"] } });
    const flow = await seedCard(db, { id: "card-flow", cardType: "flow_lesson", topicKey: "checker-flow", riskTier: "high", appliesTo: { flowTemplates: ["software.workflow.feature-implementation"] } });
    await createAssetVersion(db, { assetKind: "skill", assetRef: "software.test-evidence", version: "active", status: "active", payload: { checklist: [] } });
    await createAssetVersion(db, { assetKind: "agent_profile", assetRef: "software-maker-pi", version: "active", status: "active", payload: { profile: "maker" } });
    await createAssetVersion(db, { assetKind: "flow_policy", assetRef: "software.workflow.feature-implementation", version: "active", status: "active", payload: { flow: "feature" } });

    const deltas = await synthesizeDeltaProposals(db, {
      actor: "test-operator",
      reason: "classify all delta kinds",
      sourceCardRefs: [skill.id, profile.id, flow.id],
    });
    assert.equal(deltas.deltaIds.length, 3);

    const rows = await db.query<{ payload_json: { deltaKind: string; riskTier: string } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'delta_proposal' order by resource_key",
    );
    const kinds = rows.rows.map((row) => row.payload_json.deltaKind).sort();
    assert.deepEqual(kinds, ["agent_profile_delta", "flow_delta", "skill_delta"]);

    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'southstar' and table_name = 'delta_proposals'",
    );
    assert.deepEqual(tables.rows, []);
  });
});

test("delta synthesis refuses to invent a target when a card has no applicable asset", async () => {
  await withDb(async (db) => {
    const card = await seedCard(db, {
      id: "card-without-target",
      cardType: "success_pattern",
      topicKey: "unbound-learning",
      riskTier: "low",
      appliesTo: {},
    });

    await assert.rejects(
      synthesizeDeltaProposals(db, {
        actor: "test-operator",
        reason: "do not synthesize an unbound delta",
        sourceCardRefs: [card.id],
      }),
      /evolution_target_ref_required/,
    );
  });
});

test("delta validator rejects missing source cards and flow auto-promotion", async () => {
  await withDb(async (db) => {
    const missing = await validateDeltaProposal(db, {
      id: "delta-invalid",
      deltaKind: "prompt_delta",
      sourceCardRefs: ["missing-card"],
      sourceNodeRefs: [],
      evidenceSubgraphHash: "hash",
      hypothesis: "missing source should fail",
      patch: { append: "checklist" },
      riskTier: "low",
      validationPlan: { regressionSuiteRefs: [], replayRunRefs: [], maxCostRegressionPercent: 10, maxDurationRegressionPercent: 10 },
      rollbackPlan: { strategy: "disable-delta" },
      status: "proposed",
    });
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join("\n"), /source card not found/);

    const flow = await validateDeltaProposal(db, {
      id: "delta-flow-invalid",
      deltaKind: "flow_delta",
      sourceCardRefs: [],
      sourceNodeRefs: [],
      evidenceSubgraphHash: "hash",
      hypothesis: "flow auto promotion should fail",
      patch: { autoPromote: true },
      riskTier: "low",
      validationPlan: { regressionSuiteRefs: [], replayRunRefs: [], maxCostRegressionPercent: 10, maxDurationRegressionPercent: 10 },
      rollbackPlan: { strategy: "manual" },
      status: "promoted",
    });
    assert.equal(flow.ok, false);
    assert.match(flow.errors.join("\n"), /flow delta cannot be auto-promoted/);
  });
});

test("delta validator enforces target version, patch allowlist, runtime invariant protection, and evidence hash", async () => {
  await withDb(async (db) => {
    await seedCard(db, {
      id: "card-validator",
      cardType: "failure_lesson",
      topicKey: "validator-target",
      riskTier: "low",
      appliesTo: { promptTemplates: ["prompt-validator"] },
    });
    await createAssetVersion(db, { assetKind: "prompt_template", assetRef: "prompt-validator", version: "v1", status: "active", payload: { template: "before" } });

    const validBase = {
      id: "delta-validator",
      deltaKind: "prompt_delta" as const,
      targetRef: "prompt-validator",
      targetVersion: "v1",
      sourceCardRefs: ["card-validator"],
      sourceNodeRefs: ["card-validator"],
      evidenceSubgraphHash: "fb9d150475a93fb2",
      hypothesis: "append bounded prompt guidance",
      patch: { appendSection: "Self-check", instruction: "Run tests before final response." },
      riskTier: "low" as const,
      validationPlan: { regressionSuiteRefs: ["core"], replayRunRefs: [], maxCostRegressionPercent: 10, maxDurationRegressionPercent: 10, minReplayFixRate: 0.8 },
      rollbackPlan: { previousVersionRef: "v1", strategy: "revert-version" as const },
      status: "proposed" as const,
    };

    assert.deepEqual(await validateDeltaProposal(db, validBase), { ok: true });

    const missingTarget = await validateDeltaProposal(db, { ...validBase, id: "delta-missing-target", targetVersion: "v404" });
    assert.equal(missingTarget.ok, false);
    assert.match(missingTarget.errors.join("\n"), /target asset version not found/);

    const badPatch = await validateDeltaProposal(db, { ...validBase, id: "delta-bad-patch", patch: { shell: "rm -rf .", instruction: "bad" } });
    assert.equal(badPatch.ok, false);
    assert.match(badPatch.errors.join("\n"), /patch key is not allowed/);

    const invariantPatch = await validateDeltaProposal(db, { ...validBase, id: "delta-invariant", patch: { appendSection: "Lifecycle", instruction: "Add new lifecycle state drafting" } });
    assert.equal(invariantPatch.ok, false);
    assert.match(invariantPatch.errors.join("\n"), /runtime invariant/);

    const badHash = await validateDeltaProposal(db, { ...validBase, id: "delta-bad-hash", evidenceSubgraphHash: "wrong" });
    assert.equal(badHash.ok, false);
    assert.match(badHash.errors.join("\n"), /evidenceSubgraphHash does not match/);
  });
});

async function seedCard(db: SouthstarDb, input: {
  id: string;
  cardType: "failure_lesson" | "success_pattern" | "profile_lesson" | "flow_lesson";
  topicKey: string;
  riskTier: "low" | "medium" | "high";
  appliesTo: Record<string, string[]>;
}): Promise<{ id: string }> {
  return await createLearningNode(db, {
    id: input.id,
    nodeType: "knowledge_card",
    scope: "software",
    status: "active",
    payload: {
      cardType: input.cardType,
      topicKey: input.topicKey,
      scope: "software",
      title: input.topicKey,
      summary: `${input.topicKey} summary`,
      appliesTo: input.appliesTo,
      claims: [{ text: `${input.topicKey} claim`, evidenceNodeRefs: [input.id] }],
      confidence: 0.8,
      successScore: 0.75,
      status: "active",
      riskTier: input.riskTier,
    },
    summaryText: `${input.topicKey} summary`,
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
