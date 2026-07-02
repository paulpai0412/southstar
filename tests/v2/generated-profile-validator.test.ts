import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { validateGeneratedNodeProfile } from "../../src/v2/design-library/profile-composer/generated-profile-validator.ts";
import { resolveGraphProfileCandidates } from "../../src/v2/design-library/profile-composer/graph-profile-candidate-resolver.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("generated profile validator accepts agent skill tool MCP graph closure", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPrimitive(db, "agent.frontend-developer", "agent_definition");
    await seedPrimitive(db, "skill.react-ui", "skill_spec");
    await seedPrimitive(db, "tool.workspace-write", "tool_definition");
    await seedPrimitive(db, "mcp.filesystem-workspace", "mcp_tool_grant");
    await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "supports_skill", toObjectKey: "skill.react-ui", scope: "software" });
    await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.workspace-write", scope: "software" });
    await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "allows_mcp_grant", toObjectKey: "mcp.filesystem-workspace", scope: "software" });

    const result = await validateGeneratedNodeProfile(db, {
      scope: "software",
      nodeId: "implement-ui",
      agentRef: "agent.frontend-developer",
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      instructionRefs: [],
    });
    assert.equal(result.ok, true);
  } finally {
    await db.close();
  }
});

test("generated profile validator rejects missing required tool", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPrimitive(db, "agent.frontend-developer", "agent_definition");
    await seedPrimitive(db, "skill.react-ui", "skill_spec");
    await seedPrimitive(db, "tool.workspace-write", "tool_definition");
    await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "supports_skill", toObjectKey: "skill.react-ui", scope: "software" });
    await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.workspace-write", scope: "software" });

    const result = await validateGeneratedNodeProfile(db, {
      scope: "software",
      nodeId: "implement-ui",
      agentRef: "agent.frontend-developer",
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      instructionRefs: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.issues[0]?.code, "missing_required_tool");
  } finally {
    await db.close();
  }
});

test("generated profile validator rejects missing required MCP grant", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPrimitive(db, "agent.frontend-developer", "agent_definition");
    await seedPrimitive(db, "skill.react-ui", "skill_spec");
    await seedPrimitive(db, "mcp.filesystem-workspace", "mcp_tool_grant");
    await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "supports_skill", toObjectKey: "skill.react-ui", scope: "software" });
    await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "allows_mcp_grant", toObjectKey: "mcp.filesystem-workspace", scope: "software" });

    const result = await validateGeneratedNodeProfile(db, {
      scope: "software",
      nodeId: "implement-ui",
      agentRef: "agent.frontend-developer",
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      instructionRefs: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.issues[0]?.code, "missing_required_mcp");
  } finally {
    await db.close();
  }
});

test("generated profile validator rejects missing required instruction refs", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPrimitive(db, "agent.frontend-developer", "agent_definition");
    await seedPrimitive(db, "skill.react-ui", "skill_spec");
    await seedPrimitive(db, "instruction.react-review", "instruction_template");
    await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "supports_skill", toObjectKey: "skill.react-ui", scope: "software" });
    await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "uses_instruction", toObjectKey: "instruction.react-review", scope: "software" });

    const result = await validateGeneratedNodeProfile(db, {
      scope: "software",
      nodeId: "implement-ui",
      agentRef: "agent.frontend-developer",
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      instructionRefs: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.issues[0]?.code, "missing_required_instruction");
  } finally {
    await db.close();
  }
});

test("generated profile validator rejects skills not supported by the selected agent", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPrimitive(db, "agent.frontend-developer", "agent_definition");
    await seedPrimitive(db, "skill.database-design", "skill_spec");

    const result = await validateGeneratedNodeProfile(db, {
      scope: "software",
      nodeId: "implement-ui",
      agentRef: "agent.frontend-developer",
      skillRefs: ["skill.database-design"],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      instructionRefs: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.issues[0]?.code, "agent_does_not_support_skill");
  } finally {
    await db.close();
  }
});

test("generated profile validator rejects wrong-kind and unapproved instruction refs", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPrimitive(db, "skill.react-ui", "skill_spec");

    const result = await validateGeneratedNodeProfile(db, {
      scope: "software",
      nodeId: "implement-ui",
      agentRef: "skill.react-ui",
      skillRefs: [],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      instructionRefs: ["instruction.review-evidence"],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.code), [
      "wrong_kind_ref",
      "unknown_or_unapproved_ref",
    ]);
  } finally {
    await db.close();
  }
});

test("generated profile validator rejects approved refs outside profile scope", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPrimitive(db, "agent.frontend-developer", "agent_definition");
    await seedPrimitive(db, "tool.research-only", "tool_definition", "research");

    const result = await validateGeneratedNodeProfile(db, {
      scope: "software",
      nodeId: "implement-ui",
      agentRef: "agent.frontend-developer",
      skillRefs: [],
      toolGrantRefs: ["tool.research-only"],
      mcpGrantRefs: [],
      instructionRefs: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.issues[0]?.code, "out_of_scope_ref");
  } finally {
    await db.close();
  }
});

test("graph profile candidate resolver returns approved scoped primitives", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPrimitive(db, "agent.frontend-developer", "agent_definition");
    await seedPrimitive(db, "skill.react-ui", "skill_spec");
    await seedPrimitive(db, "tool.workspace-write", "tool_definition");
    await seedPrimitive(db, "mcp.filesystem-workspace", "mcp_tool_grant");
    await upsertLibraryObject(db, {
      objectKey: "agent.blocked",
      objectKind: "agent_definition",
      status: "blocked",
      headVersionId: "agent.blocked@v1",
      state: { scope: "software", title: "Blocked" },
    });

    const candidates = await resolveGraphProfileCandidates(db, { scope: "software" });

    assert.deepEqual(candidates, {
      agents: ["agent.frontend-developer"],
      skills: ["skill.react-ui"],
      tools: ["tool.workspace-write"],
      mcpGrants: ["mcp.filesystem-workspace"],
    });
  } finally {
    await db.close();
  }
});

async function seedPrimitive(db: any, objectKey: string, objectKind: any, scope = "software") {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind,
    status: "approved",
    headVersionId: `${objectKey}@v1`,
    state: { scope, title: objectKey },
  });
}
