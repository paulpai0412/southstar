import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeTaskEnvelope } from "../../src/v2/agent-runner/materializer.ts";
import { buildTaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { materializeTaskLibraryRefs } from "../../src/v2/orchestration/runtime-library-materializer.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../../src/v2/orchestration/composition-compiler.ts";
import { validateWorkflowCompositionPlan } from "../../src/v2/orchestration/composition-validator.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("graph metadata composition refs materialize into Docker-visible task bundle", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-root-"));
  const runRoot = await mkdtemp(join(tmpdir(), "southstar-run-root-"));
  try {
    await seedExecutableGraph(db, libraryRoot);
    const candidatePacket = await resolveWorkflowCandidates(db, {
      scope: "software",
      requirementSpec: {
        summary: "Build todo web app",
        workType: "software_feature",
        requiredCapabilities: ["capability.frontend-ui"],
        expectedArtifacts: ["artifact.web_app"],
        acceptanceCriteria: ["Todo app works"],
        nonGoals: [],
        riskNotes: [],
        workspaceAssumptions: [],
        missingInputs: [],
      },
    });

    assert.equal(candidatePacket.graphMetadataCandidates?.nodes.some((node) => node.ref === "skill.react-ui"), true);

    const composition = generatedCompositionPlan();
    const validation = await validateWorkflowCompositionPlan(db, candidatePacket, composition, { scope: "software" });
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));

    const compiled = await compileWorkflowComposition(db, {
      runId: "run-chain",
      goalPrompt: "Build todo web app",
      candidatePacket,
      composition,
      scope: "software",
    });
    const task = compiled.workflow.tasks[0]!;
    const profile = compiled.workflow.agentProfiles!.find((candidate) => candidate.id === task.agentProfileRef)!;
    const role = compiled.workflow.roles!.find((candidate) => candidate.id === task.roleRef)!;
    const materialized = await materializeTaskLibraryRefs(db, {
      runId: "run-chain",
      taskId: task.id,
      sessionId: "session-chain",
      libraryRoot,
      instructionRefs: task.instructionRefs,
      skillRefs: task.skillRefs,
      toolGrantRefs: task.toolGrantRefs,
      mcpGrantRefs: task.mcpGrantRefs,
      vaultLeasePolicyRefs: task.vaultLeasePolicyRefs,
    });
    const envelope = buildTaskEnvelopeV2({
      runId: "run-chain",
      workflowId: compiled.workflow.workflowId,
      taskId: task.id,
      domain: "software",
      intent: "implement_feature",
      role,
      agentProfile: profile,
      harness: compiled.workflow.harnessDefinitions[0]!,
      contextPacket: {
        id: "ctx-chain",
        runId: "run-chain",
        taskId: task.id,
        rootSessionId: "session-chain",
        executionAttempt: 1,
        roleRef: role.id,
        agentProfileRef: profile.id,
        taskGoal: "Build todo web app",
        roleInstruction: role.responsibility,
        systemInstruction: profile.promptTemplateRef,
        agentsMdBlocks: [],
        artifactContracts: [],
        selectedMemories: [],
        selectedKnowledgeCards: [],
        priorArtifacts: [],
        skillInstructions: [],
        mcpGrantSummary: [],
        forbiddenActions: [],
        budget: profile.budgetPolicy,
        tokenEstimate: { total: 0, bySourceType: {} },
        excludedCandidates: [],
        managedSourceRefs: {
          rawEventRefs: [],
          omittedEventRanges: [],
          transformRefs: [],
          checkpointRefs: [],
        },
      },
      skills: materialized.skills,
      mcpGrants: materialized.mcpGrants,
      vaultLeases: materialized.vaultLeases,
      toolProxyPolicy: materialized.toolProxyPolicy,
      materializedLibraryRefs: {
        instructionRefs: task.instructionRefs,
        skillRefs: task.skillRefs,
        toolGrantRefs: task.toolGrantRefs,
        mcpGrantRefs: task.mcpGrantRefs,
        vaultLeasePolicyRefs: task.vaultLeasePolicyRefs,
      },
      artifactContracts: [],
      evaluatorPipeline: { id: "evaluator.generated", evaluators: [], onFailure: { defaultStrategy: "ask-human" } },
      session: { sessionId: "session-chain", maxRepairAttempts: 1 },
    });

    const taskMaterialization = await materializeTaskEnvelope(envelope, { runRoot });

    assert.match(await readFile(join(taskMaterialization.taskDir, "skills", "skill.react-ui", "SKILL.md"), "utf8"), /Build React UI/);
    assert.equal(await readFile(join(taskMaterialization.taskDir, "skills", "skill.react-ui", "references", "patterns.md"), "utf8"), "Use controlled inputs.");
    assert.equal(JSON.parse(await readFile(join(taskMaterialization.taskDir, "tools", "tool-policy.json"), "utf8")).allowedTools.includes("workspace-write"), true);
    assert.equal(JSON.parse(await readFile(join(taskMaterialization.taskDir, "mcp", "grants.json"), "utf8"))[0].serverId, "filesystem-workspace");
    const runtimeManifest = JSON.parse(await readFile(join(taskMaterialization.taskDir, "runtime-manifest.json"), "utf8"));
    assert.equal(runtimeManifest.policy.toolsAreGrantPolicyOnly, true);
    assert.equal(runtimeManifest.policy.mcpEntriesAreGrantPolicyOnly, true);
    assert.equal(runtimeManifest.files.some((file: { relativePath: string }) => file.relativePath === "agent-profile/profile.json"), true);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(runRoot, { recursive: true, force: true });
  }
});

function generatedCompositionPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Todo web app",
    selectedWorkflowTemplateRef: "template.dynamic-single-task",
    rationale: "Use graph metadata candidates.",
    tasks: [{
      id: "implement-ui",
      name: "Implement UI",
      responsibility: "Build todo web app UI",
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
      outputArtifactRefs: ["artifact.web_app"],
      evaluatorProfileRef: "evaluator.web-app",
      recoveryStrategyRefs: [],
      rationale: "Frontend agent uses React skill and workspace write access.",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [{
      id: "profile.generated.todo.implement-ui",
      kind: "agent_profile",
      risk: "medium",
      reason: "Generated from graph metadata.",
      validationStatus: "validated",
    }],
  };
}

async function seedExecutableGraph(db: Awaited<ReturnType<typeof createTestPostgresDb>>, libraryRoot: string) {
  await mkdir(join(libraryRoot, "skills", "react-ui", "references"), { recursive: true });
  await writeFile(join(libraryRoot, "skills", "react-ui", "references", "patterns.md"), "Use controlled inputs.", "utf8");
  await upsertLibraryObject(db, {
    objectKey: "template.dynamic-single-task",
    objectKind: "workflow_template",
    status: "approved",
    headVersionId: "template.dynamic-single-task@1",
    state: { scope: "software", title: "Dynamic Single Task" },
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
        responsibility: "Build frontend UI",
        defaultAgentProfileRef: "profile.generated.todo.implement-ui",
        allowedAgentProfileRefs: ["profile.generated.todo.implement-ui"],
        artifactInputs: [],
        artifactOutputs: ["web_app"],
        stopAuthority: "can-suggest",
      },
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "skill.react-ui",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.react-ui@1",
    state: {
      scope: "software",
      title: "React UI",
      body: "# Instructions\n\nBuild React UI.",
      assetBundlePath: "library/skills/react-ui",
      allowedTools: ["workspace-write"],
      requiredMounts: ["workspace"],
      mcpRequirements: ["filesystem-workspace"],
      artifactContracts: ["artifact.web_app"],
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "tool.workspace-write",
    objectKind: "tool_definition",
    status: "approved",
    headVersionId: "tool.workspace-write@1",
    state: { scope: "global", title: "Workspace Write", toolName: "workspace-write", proxyToolName: "workspace-write-proxy" },
  });
  await upsertLibraryObject(db, {
    objectKey: "mcp.filesystem-workspace",
    objectKind: "mcp_tool_grant",
    status: "approved",
    headVersionId: "mcp.filesystem-workspace@1",
    state: { scope: "global", title: "Filesystem Workspace", serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file"] },
  });
  await upsertLibraryObject(db, {
    objectKey: "instruction.react-review",
    objectKind: "instruction_template",
    status: "approved",
    headVersionId: "instruction.react-review@1",
    state: { scope: "software", title: "React Review", content: "Use React best practices.", variables: [] },
  });
  await upsertLibraryObject(db, {
    objectKey: "artifact.web_app",
    objectKind: "artifact_contract",
    status: "approved",
    headVersionId: "artifact.web_app@1",
    state: { scope: "software", title: "Web App" },
  });
  await upsertLibraryObject(db, {
    objectKey: "evaluator.web-app",
    objectKind: "evaluator_profile",
    status: "approved",
    headVersionId: "evaluator.web-app@1",
    state: { scope: "software", title: "Web App Evaluator" },
  });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "provides_capability", toObjectKey: "capability.frontend-ui", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "supports_skill", toObjectKey: "skill.react-ui", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "produces_artifact", toObjectKey: "artifact.web_app", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.workspace-write", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "allows_mcp_grant", toObjectKey: "mcp.filesystem-workspace", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "uses_instruction", toObjectKey: "instruction.react-review", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "evaluator.web-app", edgeType: "validates_artifact", toObjectKey: "artifact.web_app", scope: "software" });
}
