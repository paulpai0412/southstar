import assert from "node:assert/strict";
import test from "node:test";
import {
  upsertLibraryEdge,
  upsertLibraryObject,
} from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../../src/v2/orchestration/composition-compiler.ts";
import { validateWorkflowCompositionPlan } from "../../src/v2/orchestration/composition-validator.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("workflow composition accepts generated profiles built from approved primitives", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });

    assert.deepEqual(packet.profilePrimitiveCandidates?.agents, ["agent.frontend-developer"]);
    assert.deepEqual(packet.profilePrimitiveCandidates?.skills, ["skill.react-ui"]);
    assert.deepEqual(packet.profilePrimitiveCandidates?.tools, ["tool.workspace-write"]);
    assert.deepEqual(packet.profilePrimitiveCandidates?.mcpGrants, ["mcp.filesystem-workspace"]);
    assert.deepEqual(packet.profilePrimitiveCandidates?.instructions, ["instruction.react-review"]);

    const validation = await validateWorkflowCompositionPlan(db, packet, generatedProfilePlan(), { scope: "software" });
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues, []);
  } finally {
    await db.close();
  }
});

test("compiler preserves generated profile and primitive refs in the manifest", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    const composition = generatedProfilePlan();

    const compiled = await compileWorkflowComposition(db, {
      runId: "dynamic-profile-composition",
      goalPrompt: "Build a todo web app",
      candidatePacket: packet,
      composition,
      scope: "software",
    });

    const task = compiled.workflow.tasks.find((candidate) => candidate.id === "implement-ui");
    assert.ok(task, "implement-ui task should exist");
    assert.equal(task.agentProfileRef, "profile.generated.todo.implement-ui");
    assert.deepEqual(task.skillRefs, ["skill.react-ui"]);
    assert.deepEqual(task.toolGrantRefs, ["tool.workspace-write"]);
    assert.deepEqual(task.mcpGrantRefs, ["mcp.filesystem-workspace"]);
    assert.deepEqual(task.instructionRefs, ["instruction.react-review"]);
    assert.equal(
      compiled.workflow.agentProfiles?.some((profile) => profile.id === "profile.generated.todo.implement-ui"),
      true,
    );
  } finally {
    await db.close();
  }
});

test("workflow composition rejects generated profiles with invalid primitive graph closure", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    await upsertLibraryObject(db, {
      objectKey: "skill.database-design",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.database-design@1",
      state: { scope: "software", title: "Database Design" },
    });
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    const plan = generatedProfilePlan();
    plan.tasks[0]!.skillRefs = ["skill.database-design"];
    plan.tasks[0]!.toolGrantRefs = [];
    plan.tasks[0]!.mcpGrantRefs = [];
    plan.tasks[0]!.instructionRefs = [];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, { scope: "software" });

    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "agent_does_not_support_skill"), true);
  } finally {
    await db.close();
  }
});

test("workflow composition rejects generated profile refs absent from graph metadata candidates", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    packet.graphMetadataCandidates = {
      schemaVersion: "southstar.graph_metadata_candidates.v1",
      scope: "software",
      nodes: packet.graphMetadataCandidates!.nodes.filter((node) => node.ref !== "skill.react-ui"),
      edges: packet.graphMetadataCandidates!.edges.filter((edge) => edge.from !== "skill.react-ui" && edge.to !== "skill.react-ui"),
    };

    const validation = await validateWorkflowCompositionPlan(db, packet, generatedProfilePlan(), { scope: "software" });

    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "ref_not_in_candidate_packet" && issue.message.includes("skill.react-ui")), true);
  } finally {
    await db.close();
  }
});

test("workflow composition rejects generated profile that ignores graph metadata conflict edges", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    await upsertLibraryObject(db, {
      objectKey: "skill.legacy-ui",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.legacy-ui@1",
      state: { scope: "software", title: "Legacy UI" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "supports_skill",
      toObjectKey: "skill.legacy-ui",
      scope: "software",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.react-ui",
      edgeType: "conflicts_with",
      toObjectKey: "skill.legacy-ui",
      scope: "software",
    });
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    const plan = generatedProfilePlan();
    plan.tasks[0]!.skillRefs = ["skill.react-ui", "skill.legacy-ui"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, { scope: "software" });

    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "conflicting_refs"), true);
  } finally {
    await db.close();
  }
});

function requirementSpec() {
  return {
    summary: "Build a todo web app",
    workType: "software_feature" as const,
    requiredCapabilities: ["capability.frontend-ui"],
    expectedArtifacts: ["artifact.todo_app"],
    acceptanceCriteria: ["Todo UI works"],
    nonGoals: [],
    riskNotes: [],
    workspaceAssumptions: [],
    missingInputs: [],
  };
}

function generatedProfilePlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Todo web app",
    selectedWorkflowTemplateRef: "template.dynamic-single-task",
    rationale: "Use generated node profile.",
    tasks: [{
      id: "implement-ui",
      name: "Implement UI",
      responsibility: "Build the todo web app",
      dependsOn: [],
      templateSlotRef: "implement",
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.todo.implement-ui",
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.todo_app"],
      evaluatorProfileRef: "evaluator.todo-quality",
      recoveryStrategyRefs: [],
      rationale: "Generated profile uses approved primitives.",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [{
      id: "profile.generated.todo.implement-ui",
      kind: "agent_profile",
      risk: "medium",
      reason: "Generated from approved graph primitives.",
      validationStatus: "validated",
    }],
  };
}

async function seedDynamicPrimitives(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await upsertLibraryObject(db, {
    objectKey: "template.dynamic-single-task",
    objectKind: "workflow_template",
    status: "approved",
    headVersionId: "template.dynamic-single-task@1",
    state: { scope: "software", title: "Dynamic single task" },
  });
  await upsertLibraryObject(db, {
    objectKey: "capability.frontend-ui",
    objectKind: "capability_spec",
    status: "approved",
    headVersionId: "capability.frontend-ui@1",
    state: { scope: "software", title: "Frontend UI" },
  });
  await upsertLibraryObject(db, {
    objectKey: "agent.frontend-developer",
    objectKind: "agent_definition",
    status: "approved",
    headVersionId: "agent.frontend-developer@1",
    state: {
      scope: "software",
      title: "Frontend Developer",
      runtimeRole: {
        id: "frontend-developer",
        responsibility: "Build frontend user interfaces",
        defaultAgentProfileRef: "profile.generated.todo.implement-ui",
        allowedAgentProfileRefs: ["profile.generated.todo.implement-ui"],
        artifactInputs: [],
        artifactOutputs: ["todo_app"],
        stopAuthority: "can-suggest",
      },
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "skill.react-ui",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.react-ui@1",
    state: { scope: "software", title: "React UI" },
  });
  await upsertLibraryObject(db, {
    objectKey: "tool.workspace-write",
    objectKind: "tool_definition",
    status: "approved",
    headVersionId: "tool.workspace-write@1",
    state: { scope: "global", title: "Workspace Write" },
  });
  await upsertLibraryObject(db, {
    objectKey: "mcp.filesystem-workspace",
    objectKind: "mcp_tool_grant",
    status: "approved",
    headVersionId: "mcp.filesystem-workspace@1",
    state: { scope: "global", title: "Filesystem Workspace" },
  });
  await upsertLibraryObject(db, {
    objectKey: "instruction.react-review",
    objectKind: "instruction_template",
    status: "approved",
    headVersionId: "instruction.react-review@1",
    state: { scope: "software", title: "React Review" },
  });
  await upsertLibraryObject(db, {
    objectKey: "artifact.todo_app",
    objectKind: "artifact_contract",
    status: "approved",
    headVersionId: "artifact.todo_app@1",
    state: { scope: "software", title: "Todo app artifact" },
  });
  await upsertLibraryObject(db, {
    objectKey: "evaluator.todo-quality",
    objectKind: "evaluator_profile",
    status: "approved",
    headVersionId: "evaluator.todo-quality@1",
    state: { scope: "software", title: "Todo quality evaluator" },
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "provides_capability",
    toObjectKey: "capability.frontend-ui",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "supports_skill",
    toObjectKey: "skill.react-ui",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "produces_artifact",
    toObjectKey: "artifact.todo_app",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "requires_tool",
    toObjectKey: "tool.workspace-write",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "allows_mcp_grant",
    toObjectKey: "mcp.filesystem-workspace",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "uses_instruction",
    toObjectKey: "instruction.react-review",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "evaluator.todo-quality",
    edgeType: "validates_artifact",
    toObjectKey: "artifact.todo_app",
    scope: "software",
  });
}
