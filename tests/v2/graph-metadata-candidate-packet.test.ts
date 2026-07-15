import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { buildGraphMetadataCandidatePacket } from "../../src/v2/orchestration/graph-metadata-packet.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("builds compact approved graph metadata nodes and executable edges", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedGraph(db);

    const packet = await buildGraphMetadataCandidatePacket(db, { scope: "engineering" });

    assert.deepEqual(packet.nodes.map((node) => node.ref), [
      "agent.frontend-developer",
      "skill.react-ui",
      "tool.workspace-write",
    ]);
    assert.deepEqual(packet.edges.map((edge) => `${edge.from}|${edge.type}|${edge.to}`), [
      "agent.frontend-developer|uses|skill.react-ui",
      "skill.react-ui|requires_tool|tool.workspace-write",
    ]);
    assert.equal(packet.nodes.some((node) => node.kind === "agent_profile"), false);
    assert.equal(packet.nodes.find((node) => node.ref === "skill.react-ui")?.bodyPreview?.includes("very long"), false);
  } finally {
    await db.close();
  }
});

test("workflow candidate resolver exposes graph primitives without stored agent profiles", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedGraph(db);
    await upsertLibraryObject(db, {
      objectKey: "capability.frontend-ui",
      objectKind: "capability_spec",
      status: "approved",
      headVersionId: "capability.frontend-ui@1",
      state: { scope: "engineering", title: "Frontend UI" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "provides_capability",
      toObjectKey: "capability.frontend-ui",
      scope: "engineering",
    });

    const packet = await resolveWorkflowCandidates(db, {
      scope: "engineering",
      requirementSpec: {
        summary: "Build a todo app",
        workType: "software_feature",
        requiredCapabilities: ["capability.frontend-ui"],
        expectedArtifacts: [],
        acceptanceCriteria: [],
        nonGoals: [],
        riskNotes: [],
        workspaceAssumptions: [],
        missingInputs: [],
      },
    });

    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.ref === "skill.react-ui"), true);
    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.kind === "agent_profile"), false);
    assert.equal(packet.profilePrimitiveCandidates?.skills.includes("skill.react-ui"), true);
    assert.deepEqual(packet.profileCandidatesByAgent, {});
  } finally {
    await db.close();
  }
});

test("workflow candidates exclude approved primitives that cannot materialize at runtime", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedGraph(db);
    await upsertLibraryObject(db, {
      objectKey: "skill.placeholder-ui",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.placeholder-ui@1",
      state: { scope: "engineering", title: "Placeholder UI" },
    });
    await upsertLibraryObject(db, {
      objectKey: "skill.goal-design-sop",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.goal-design-sop@1",
      state: {
        scope: "engineering",
        title: "Goal Design SOP",
        purpose: "goal_design",
        body: "# Goal Design\n\nDesign goal contracts and slices before workflow composition.",
      },
    });
    await upsertLibraryObject(db, {
      objectKey: "skill.slice-to-dag-composer",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.slice-to-dag-composer@1",
      state: {
        scope: "engineering",
        title: "Slice to DAG Composer",
        purpose: "composer_guidance",
        body: "# Slice to DAG\n\nTranslate slice plans into DAGs.",
      },
    });
    await upsertLibraryObject(db, {
      objectKey: "instruction.placeholder-review",
      objectKind: "instruction_template",
      status: "approved",
      headVersionId: "instruction.placeholder-review@1",
      state: { scope: "engineering", title: "Placeholder Review" },
    });
    await upsertLibraryObject(db, {
      objectKey: "mcp.placeholder-workspace",
      objectKind: "mcp_tool_grant",
      status: "approved",
      headVersionId: "mcp.placeholder-workspace@1",
      state: { scope: "global", title: "Placeholder Workspace" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "uses",
      toObjectKey: "skill.placeholder-ui",
      scope: "engineering",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "uses",
      toObjectKey: "skill.goal-design-sop",
      scope: "engineering",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "uses",
      toObjectKey: "skill.slice-to-dag-composer",
      scope: "engineering",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.placeholder-ui",
      edgeType: "uses_instruction",
      toObjectKey: "instruction.placeholder-review",
      scope: "engineering",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.placeholder-ui",
      edgeType: "allows_mcp_grant",
      toObjectKey: "mcp.placeholder-workspace",
      scope: "engineering",
    });

    const packet = await resolveWorkflowCandidates(db, {
      scope: "engineering",
      requirementSpec: {
        summary: "Build a todo app",
        workType: "software_feature",
        requiredCapabilities: [],
        expectedArtifacts: [],
        acceptanceCriteria: [],
        nonGoals: [],
        riskNotes: [],
        workspaceAssumptions: [],
        missingInputs: [],
      },
    });

    assert.equal(packet.profilePrimitiveCandidates?.skills.includes("skill.placeholder-ui"), false);
    assert.equal(packet.profilePrimitiveCandidates?.skills.includes("skill.goal-design-sop"), false);
    assert.equal(packet.profilePrimitiveCandidates?.skills.includes("skill.slice-to-dag-composer"), false);
    assert.equal(packet.profilePrimitiveCandidates?.instructions.includes("instruction.placeholder-review"), false);
    assert.equal(packet.profilePrimitiveCandidates?.mcpGrants.includes("mcp.placeholder-workspace"), false);
    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.ref === "skill.placeholder-ui"), false);
    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.ref === "skill.goal-design-sop"), false);
    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.ref === "skill.slice-to-dag-composer"), false);
    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.ref === "instruction.placeholder-review"), false);
    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.ref === "mcp.placeholder-workspace"), false);
    assert.equal(packet.graphMetadataCandidates?.edges.some((edge) =>
      edge.from === "skill.placeholder-ui"
      || edge.to === "skill.placeholder-ui"
      || edge.from === "skill.goal-design-sop"
      || edge.to === "skill.goal-design-sop"
      || edge.from === "skill.slice-to-dag-composer"
      || edge.to === "skill.slice-to-dag-composer"
    ), false);
  } finally {
    await db.close();
  }
});

async function seedGraph(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await upsertLibraryObject(db, {
    objectKey: "profile.legacy-frontend",
    objectKind: "agent_profile",
    status: "approved",
    headVersionId: "profile.legacy-frontend@1",
    state: {
      scope: "engineering",
      title: "Legacy Frontend Profile",
      runtimeProfile: {
        id: "legacy-frontend",
        name: "Legacy Frontend",
        provider: "codex",
        model: "gpt-5",
        harnessRef: "codex",
        agentsMdRefs: [],
        promptTemplateRef: "react-review",
        skillRefs: ["skill.react-ui"],
        mcpGrantRefs: ["mcp.filesystem-workspace"],
        memoryScopes: [],
        contextPolicyRef: "context.legacy",
        sessionPolicyRef: "session.legacy",
        toolPolicy: { allowedTools: ["tool.workspace-write"], deniedTools: [], requiresApprovalFor: [] },
        budgetPolicy: { maxInputTokens: 120000, maxOutputTokens: 8192 },
      },
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "agent.frontend-developer",
    objectKind: "agent_definition",
    status: "approved",
    headVersionId: "agent.frontend-developer@1",
    state: {
      scope: "engineering",
      title: "Frontend Developer",
      description: "Builds frontend web applications.",
      aliases: ["react", "ui", "webapp"],
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "skill.react-ui",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.react-ui@1",
    state: {
      scope: "engineering",
      title: "React UI",
      description: "Implements React UI.",
      body: "# Instructions\n\nUse React.\n\nvery long body should not be sent in full",
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "tool.workspace-write",
    objectKind: "tool_definition",
    status: "approved",
    headVersionId: "tool.workspace-write@1",
    state: {
      scope: "global",
      title: "Workspace Write",
      runtimeToolNames: ["edit", "write"],
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "mcp.filesystem-workspace",
    objectKind: "mcp_tool_grant",
    status: "approved",
    headVersionId: "mcp.filesystem-workspace@1",
    state: { scope: "global", title: "Filesystem Workspace", serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file"] },
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "uses",
    toObjectKey: "skill.react-ui",
    scope: "engineering",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "requires_tool",
    toObjectKey: "tool.workspace-write",
    scope: "engineering",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "allows_mcp_grant",
    toObjectKey: "mcp.filesystem-workspace",
    scope: "engineering",
  });
  await upsertLibraryObject(db, {
    objectKey: "agent.blocked",
    objectKind: "agent_definition",
    status: "blocked",
    headVersionId: "agent.blocked@1",
    state: { scope: "engineering", title: "Blocked" },
  });
}
