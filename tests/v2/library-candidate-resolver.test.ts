import assert from "node:assert/strict";
import test from "node:test";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { findLibraryEdgesFrom } from "../../src/v2/design-library/library-graph-store.ts";
import type { LibraryEdgeType } from "../../src/v2/design-library/types.ts";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { analyzeRequirementDeterministically } from "../../src/v2/orchestration/requirement-analyzer.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("software library seed smoke: expected maker and evaluator edges exist", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);

    await assertHasDirectEdge(db, "profile.software-maker-pi", "implements", "agent.software-maker");
    await assertHasDirectEdge(db, "profile.software-maker-pi", "supports_skill", "skill.software-implementation");
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

test("candidate resolver returns approved direct-edge candidates without recursive traversal", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirement = analyzeRequirementDeterministically("implement calc sum");
    const packet = await resolveWorkflowCandidates(db, { requirementSpec: requirement, scope: "software" });

    assert.deepEqual(packet.unavailableRequirements, []);
    assert.equal(packet.workflowTemplateCandidates[0]?.ref, "template.software-feature");
    assert.equal(packet.agentCandidatesByCapability["capability.repo-write"]?.[0]?.ref, "agent.software-maker");
    assert.equal(packet.profileCandidatesByAgent["agent.software-maker"]?.[0]?.ref, "profile.software-maker-pi");
    assert.equal(
      packet.skillCandidatesByProfile["profile.software-maker-pi"]?.some((candidate) =>
        candidate.ref === "skill.software-implementation"
      ),
      true,
    );
    assert.equal(
      packet.toolCandidatesByProfile["profile.software-maker-pi"]?.some((candidate) =>
        candidate.ref === "tool.workspace-write"
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

test("candidate resolver exposes MCP and vault candidates from direct profile edges", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirement = analyzeRequirementDeterministically("implement calc sum");
    const packet = await resolveWorkflowCandidates(db, { requirementSpec: requirement, scope: "software" });

    assert.equal(
      packet.mcpGrantCandidatesByProfile["profile.software-maker-pi"]?.some((candidate) =>
        candidate.ref === "mcp.filesystem-workspace"
      ),
      true,
    );
    assert.equal(
      packet.vaultLeaseCandidatesByProfile["profile.software-maker-pi"]?.some((candidate) =>
        candidate.ref === "vault.github-write-token"
      ),
      true,
    );
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
