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
import { finalizeGoalDesignPackageV3 } from "../../src/v2/orchestration/goal-design.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { softwareGoalContract } from "./fixtures/goal-contract.ts";

const GOAL_CONTRACT = (() => {
  const contract = softwareGoalContract("Build a todo web app");
  return {
    ...contract,
    requirements: contract.requirements.map((requirement) => ({
      ...requirement,
      acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        blocking: false,
      })),
      blocking: false,
    })),
  };
})();

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
    assert.deepEqual(packet.profilePrimitiveCandidates?.mcpGrants, []);
    assert.deepEqual(packet.profilePrimitiveCandidates?.instructions, ["instruction.react-review"]);

    const validation = await validateWorkflowCompositionPlan(db, packet, generatedProfilePlan(), { scope: "software" });
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues, []);
  } finally {
    await db.close();
  }
});

test("workflow composition rejects a generated profile binding that the host does not advertise", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    const validation = await validateWorkflowCompositionPlan(db, packet, generatedProfilePlan(), {
      scope: "software",
      runtimeBindingCapabilities: {
        providers: ["unavailable-provider"],
        harnesses: ["unavailable-harness"],
        executionEngines: ["tork"],
      },
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.path.endsWith(".provider")), true);
    assert.equal(validation.issues.some((issue) => issue.path.endsWith(".harnessRef")), true);
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
      goalContract: GOAL_CONTRACT,
      candidatePacket: packet,
      composition,
      scope: "software",
      goalDesignPackage: dynamicProfileGoalDesignPackage(),
    });

    const task = compiled.workflow.tasks.find((candidate) => candidate.id === "implement-ui");
    assert.ok(task, "implement-ui task should exist");
    assert.equal(task.agentProfileRef, "profile.generated.todo.implement-ui");
    assert.deepEqual(task.skillRefs, ["skill.react-ui"]);
    assert.deepEqual(task.toolGrantRefs, ["tool.workspace-write"]);
    assert.deepEqual(task.mcpGrantRefs, []);
    assert.deepEqual(task.instructionRefs, ["instruction.react-review"]);
    const generatedProfile = compiled.workflow.agentProfiles?.find((profile) => profile.id === "profile.generated.todo.implement-ui");
    assert.ok(generatedProfile);
    assert.equal(generatedProfile.workerKind, "execution_worker");
  } finally {
    await db.close();
  }
});

test("workflow composition rejects a generated profile that omits a selected skill's required tool", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    const plan = generatedProfilePlan();
    plan.tasks[0]!.toolGrantRefs = [];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, { scope: "software" });

    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "missing_required_tool"), true);
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
      state: { scope: "software", title: "Legacy UI", body: "# Instructions\n\nBuild legacy UI." },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "uses",
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

test("workflow composition allows generated profiles to produce task artifacts without primitive agent artifact edge", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    await db.query(
      `delete from southstar.library_edges
       where from_object_key = $1 and edge_type = $2 and to_object_key = $3`,
      ["agent.frontend-developer", "produces_artifact", "artifact.todo_app"],
    );
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });

    const validation = await validateWorkflowCompositionPlan(db, packet, generatedProfilePlan(), { scope: "software" });

    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues, []);
  } finally {
    await db.close();
  }
});

test("workflow composition allows independently approved agent and skill without a uses edge", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    await db.query(
      `delete from southstar.library_edges
       where from_object_key = $1 and edge_type = $2 and to_object_key = $3`,
      ["agent.frontend-developer", "uses", "skill.react-ui"],
    );
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });

    const validation = await validateWorkflowCompositionPlan(db, packet, generatedProfilePlan(), { scope: "software" });

    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues, []);
  } finally {
    await db.close();
  }
});

test("workflow composition accepts current ontology validates artifact edge for generated profiles", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    await db.query(
      `update southstar.library_edges
       set edge_type = 'validates'
       where from_object_key = $1 and edge_type = 'validates_artifact' and to_object_key = $2`,
      ["evaluator.todo-quality", "artifact.todo_app"],
    );
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });

    const validation = await validateWorkflowCompositionPlan(db, packet, generatedProfilePlan(), { scope: "software" });

    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues, []);
  } finally {
    await db.close();
  }
});

test("workflow composition rejects generated agent profile values outside runtime allowlist", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    const plan = generatedProfilePlan();
    const profile = plan.generatedComponentProposals[0]!.agentProfile!;
    profile.workerKind = "unknown_worker" as never;
    profile.provider = "unknown-provider" as never;
    profile.model = "unknown-model";
    profile.thinkingLevel = "too-much-thinking";
    profile.harnessRef = "unknown-harness" as never;
    profile.execution!.image = "unknown/image:latest";
    profile.execution!.command = ["node", "script.js"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, { scope: "software" });

    assert.equal(validation.ok, false);
    assert.equal(
      validation.issues.some((issue) =>
        issue.code === "generated_profile_invalid_value"
        && issue.path === "generatedComponentProposals.0.agentProfile.execution.command"
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

test("workflow composition rejects generated profile bindings the host does not advertise", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    const plan = generatedProfilePlan();
    const profile = plan.generatedComponentProposals[0]!.agentProfile!;
    profile.provider = "codex";
    profile.model = "gpt-5-codex";
    profile.harnessRef = "codex";

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, {
      scope: "software",
      runtimeBindingCapabilities: {
        providers: ["pi"],
        models: ["gpt-5"],
        harnesses: ["pi-agent"],
        executionEngines: ["tork"],
        images: ["southstar/pi-agent:local"],
      },
    });

    assert.equal(validation.ok, false);
    assert.equal(
      validation.issues.some((issue) =>
        issue.code === "generated_profile_invalid_value"
        && issue.path === "generatedComponentProposals.0.agentProfile.harnessRef"
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

test("workflow composition rejects generated profile logical workspace mount sources", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    const plan = generatedProfilePlan();
    plan.generatedComponentProposals[0]!.agentProfile!.execution!.mounts = [{
      source: "workspace",
      target: "/workspace",
      readonly: false,
    }];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, { scope: "software" });

    assert.equal(validation.ok, false);
    assert.equal(
      validation.issues.some((issue) =>
        issue.code === "generated_profile_invalid_value"
        && issue.path === "generatedComponentProposals.0.agentProfile.execution.mounts.0.source"
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

test("workflow composition rejects generated profile images unavailable in the local runtime", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    const plan = generatedProfilePlan();
    plan.generatedComponentProposals[0]!.agentProfile!.execution!.image = "southstar/codex-agent:local";

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, {
      scope: "software",
      runtimeBindingCapabilities: {
        images: ["southstar/pi-agent:local"],
      },
    });

    assert.equal(validation.ok, false);
    assert.equal(
      validation.issues.some((issue) =>
        issue.code === "generated_profile_invalid_value"
        && issue.path === "generatedComponentProposals.0.agentProfile.execution.image"
      ),
      true,
    );
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

function dynamicProfileGoalDesignPackage() {
  const requirement = GOAL_CONTRACT.requirements[0]!;
  const artifactRef = GOAL_CONTRACT.expectedArtifactRefs[0] ?? "artifact.todo_app";
  return finalizeGoalDesignPackageV3({
    schemaVersion: "southstar.goal_design_package.v3",
    revision: 1,
    goalContract: GOAL_CONTRACT,
    requirementDraftHash: "dynamic-profile-requirement-draft",
    validationBindings: [],
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: 1,
      slices: [{
        id: "slice-generated",
        requirementIds: [requirement.id],
        outcome: requirement.statement,
        stateOrArtifactOwner: artifactRef,
        mutationBoundary: "generated profile composition test",
        expectedArtifactRefs: [artifactRef],
        evaluatorContractRefs: [],
        dependsOnSliceIds: [],
        dependencyArtifactRefs: [],
      }],
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: ["slice-generated"],
      rationale: "Exercise a generated profile through one producer and one verification task.",
    },
    templatePolicy: { mode: "auto" },
    goalDesignSkillRef: "skill.southstar-goal-design",
    goalDesignSkillVersionRef: "skill.southstar-goal-design@test",
    workspaceDiscoveryHash: "dynamic-profile-workspace@test",
    mode: "review_before_compose",
  });
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
      requirementIds: GOAL_CONTRACT.requirements.map((requirement) => requirement.id),
      dependsOn: [],
      sliceId: "slice-generated",
      templateSlotRef: "implement",
      nodePromptSpec: {
        nodeType: "implement",
        goal: "Build the todo web app.",
        requirements: ["Build the requested todo web app."],
        boundaries: ["Stay within the todo application workspace."],
        nonGoals: ["Do not add unrelated product behavior."],
        deliverableDocuments: [],
        expectedOutputs: ["artifact.todo_app"],
        testCases: [{ name: "Todo app artifact", expected: "The todo app artifact is produced." }],
        acceptanceCriteria: ["The todo web app satisfies the confirmed criteria."],
        implementationScope: ["Implement the todo web app."],
      },
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.todo.implement-ui",
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.todo_app"],
      evaluatorProfileRef: "evaluator.todo-quality",
      recoveryStrategyRefs: [],
      rationale: "Generated profile uses approved primitives.",
    }, {
      id: "verify-ui",
      name: "Verify UI",
      responsibility: "Verify the todo web app",
      requirementIds: GOAL_CONTRACT.requirements.map((requirement) => requirement.id),
      dependsOn: ["implement-ui"],
      sliceId: "slice-generated",
      templateSlotRef: "verify",
      nodePromptSpec: {
        nodeType: "verify",
        goal: "Verify the todo web app.",
        requirements: ["Verify the requested todo web app."],
        boundaries: ["Evaluate only the declared todo app artifact."],
        nonGoals: ["Do not change the implementation."],
        deliverableDocuments: [],
        expectedOutputs: ["verification evidence"],
        testCases: [{ name: "Todo app verification", expected: "The todo app artifact satisfies the confirmed criteria." }],
        acceptanceCriteria: ["The todo web app satisfies the confirmed criteria."],
        verificationChecks: ["Check the declared todo app artifact against the confirmed criteria."],
      },
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.todo.implement-ui",
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.todo_app"],
      outputArtifactRefs: [],
      evaluatorProfileRef: "evaluator.todo-quality",
      recoveryStrategyRefs: [],
      rationale: "Verify the generated implementation after the producer completes.",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [{
      id: "profile.generated.todo.implement-ui",
      kind: "agent_profile",
      risk: "medium",
      reason: "Generated from approved graph primitives.",
      validationStatus: "validated",
      agentProfile: {
        workerKind: "execution_worker",
        provider: "pi",
        model: "pi-agent-default",
        thinkingLevel: "high",
        harnessRef: "pi",
        instruction: "Implement the todo web app using the approved React UI skill, workspace write tool, and React review instruction. Produce artifact.todo_app.",
        promptTemplateRef: "react-review",
        contextPolicyRef: "context.generated",
        sessionPolicyRef: "session.generated",
        memoryScopes: [],
        agentsMdRefs: [],
        vaultLeasePolicyRefs: [],
        toolPolicy: {
          allowedTools: ["tool.workspace-write"],
          deniedTools: [],
          requiresApprovalFor: [],
        },
        budgetPolicy: {
          maxInputTokens: 120000,
          maxOutputTokens: 8192,
          maxWallTimeSeconds: 900,
        },
        execution: {
          engine: "tork",
          image: "southstar/pi-agent:local",
          command: ["southstar-agent-runner"],
          env: {},
          mounts: [],
          timeoutSeconds: 900,
          infraRetry: { maxAttempts: 1 },
        },
      },
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
    state: { scope: "software", title: "React UI", body: "# Instructions\n\nBuild React UI." },
  });
  await upsertLibraryObject(db, {
    objectKey: "tool.workspace-write",
    objectKind: "tool_definition",
    status: "approved",
    headVersionId: "tool.workspace-write@1",
    state: { scope: "global", title: "Workspace Write", runtimeToolNames: ["edit", "write"] },
  });
  await upsertLibraryObject(db, {
    objectKey: "instruction.react-review",
    objectKind: "instruction_template",
    status: "approved",
    headVersionId: "instruction.react-review@1",
    state: { scope: "software", title: "React Review", content: "Use React best practices.", variables: [] },
  });
  await upsertLibraryObject(db, {
    objectKey: "artifact.todo_app",
    objectKind: "artifact_contract",
    status: "approved",
    headVersionId: "artifact.todo_app@1",
    state: {
      scope: "software",
      title: "Todo app artifact",
      artifactType: "todo-app",
      requiredFields: ["summary"],
      evidenceFields: ["summary"],
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "evaluator.todo-quality",
    objectKind: "evaluator_profile",
    status: "approved",
    headVersionId: "evaluator.todo-quality@1",
    state: {
      scope: "software",
      title: "Todo quality evaluator",
      evaluators: [{ id: "todo-quality-schema", kind: "schema", config: {}, required: true }],
      onFailure: { defaultStrategy: "request-workflow-revision" },
    },
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "provides_capability",
    toObjectKey: "capability.frontend-ui",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "uses",
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
