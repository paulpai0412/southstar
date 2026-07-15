import assert from "node:assert/strict";
import test from "node:test";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { findLibraryEdgesFrom } from "../../src/v2/design-library/library-graph-store.ts";
import type { LibraryEdgeType } from "../../src/v2/design-library/types.ts";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";
import { requirementSpecFromGoalContract } from "../../src/v2/orchestration/goal-contract.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { softwareGoalContract } from "./fixtures/goal-contract.ts";
import { seedDesignArticleLibraryGraph } from "./fixtures/design-article-library-graph.ts";

test("software library seed smoke: expected maker and evaluator edges exist", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);

    await assertHasDirectEdge(db, "profile.software-maker-pi", "implements", "agent.software-maker");
    await assertHasDirectEdge(db, "profile.software-maker-pi", "uses", "skill.software-implementation");
    await assertHasDirectEdge(db, "profile.software-maker-pi", "allows_tool", "tool.workspace-write");
    await assertHasDirectEdge(db, "profile.software-spec-reviewer-codex", "implements", "agent.software-spec-reviewer");
    await assertHasDirectEdge(
      db,
      "profile.software-code-quality-reviewer-codex",
      "implements",
      "agent.software-code-quality-reviewer",
    );
    await assertHasDirectEdge(
      db,
      "evaluator.software-feature-quality",
      "validates_artifact",
      "artifact.implementation_report",
    );
  } finally {
    await db.close();
  }
});

test("candidate resolver returns agents but disables legacy stored agent profiles", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirement = requirementSpecFromGoalContract(softwareGoalContract());
    const packet = await resolveWorkflowCandidates(db, { requirementSpec: requirement, scope: "software" });

    assert.deepEqual(packet.unavailableRequirements, []);
    assert.equal(packet.workflowTemplateCandidates[0]?.ref, "template.software-feature");
    assert.equal(packet.workflowTemplateCandidates.some((candidate) => candidate.ref === "template.graph-dynamic-workflow"), false);
    assert.equal(packet.workflowTemplateCandidates.some((candidate) => candidate.ref === "template.software-feature"), true);
    assert.equal(packet.agentCandidatesByCapability["capability.repo-write"]?.[0]?.ref, "agent.software-maker");
    assert.deepEqual(packet.profileCandidatesByAgent, {});
    assert.deepEqual(packet.skillCandidatesByProfile, {});
    assert.deepEqual(packet.toolCandidatesByProfile, {});
    assert.equal(packet.profilePrimitiveCandidates?.agents.includes("agent.software-maker"), true);
    assert.equal(packet.profilePrimitiveCandidates?.tools.includes("tool.workspace-write"), true);
  } finally {
    await db.close();
  }
});

test("candidate resolver exposes approved MCP graph metadata for composer selection", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirement = requirementSpecFromGoalContract(softwareGoalContract());
    const packet = await resolveWorkflowCandidates(db, { requirementSpec: requirement, scope: "software" });

    assert.deepEqual(packet.mcpGrantCandidatesByProfile, {});
    assert.deepEqual(packet.vaultLeaseCandidatesByProfile, {});
    assert.equal(packet.profilePrimitiveCandidates?.mcpGrants.includes("mcp.filesystem-workspace"), true);
    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.ref === "mcp.filesystem-workspace"), true);
  } finally {
    await db.close();
  }
});

test("candidate resolver does not synthesize a workflow template when only primitives match", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    await db.query(
      "delete from southstar.library_edges where from_object_key = $1 or to_object_key = $1",
      ["template.software-feature"],
    );
    await db.query("delete from southstar.library_objects where object_key = $1", ["template.software-feature"]);
    const requirement = requirementSpecFromGoalContract(softwareGoalContract());
    const packet = await resolveWorkflowCandidates(db, { requirementSpec: requirement, scope: "software" });

    assert.deepEqual(packet.workflowTemplateCandidates, []);
    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.ref === "template.graph-dynamic-workflow"), false);
    assert.equal(packet.profilePrimitiveCandidates?.agents.includes("agent.software-maker"), true);
    assert.equal(packet.profilePrimitiveCandidates?.tools.includes("tool.workspace-write"), true);
  } finally {
    await db.close();
  }
});

test("candidate resolver prefers an approved authored template over the synthetic fallback", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDesignArticleLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: {
        summary: "Create an offline article",
        workType: "general",
        requiredCapabilities: ["capability.workspace-read", "capability.workspace-write", "capability.browser"],
        expectedArtifacts: ["artifact.article_html"],
        acceptanceCriteria: ["article/article.html opens offline"],
        nonGoals: [],
        riskNotes: [],
        workspaceAssumptions: [],
        missingInputs: [],
      },
      scope: "design/article",
    });

    assert.equal(packet.workflowTemplateCandidates[0]?.ref, "template.design-article-offline");
    assert.equal(packet.workflowTemplateCandidates.some((candidate) => candidate.ref === "template.graph-dynamic-workflow"), false);
    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.ref === "template.graph-dynamic-workflow"), false);
  } finally {
    await db.close();
  }
});

async function assertHasDirectEdge(
  db: SouthstarDb,
  fromObjectKey: string,
  edgeType: LibraryEdgeType,
  toObjectKey: string,
): Promise<void> {
  const edges = await findLibraryEdgesFrom(db, fromObjectKey, edgeType, { scope: "software" });
  assert.equal(
    edges.some((edge) => edge.toObjectKey === toObjectKey),
    true,
    `missing ${fromObjectKey} -[${edgeType}]-> ${toObjectKey}`,
  );
}
