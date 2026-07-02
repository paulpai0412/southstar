import test from "node:test";
import assert from "node:assert/strict";
import { createManagedContextAssembler } from "../../src/v2/context/managed-context-assembler.ts";
import { ScriptedWorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import type { WorkflowCompositionPlan, WorkflowCompositionTask } from "../../src/v2/design-library/types.ts";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("ManagedContextAssembler persists matching ContextPacket, TaskEnvelopeV2, and assembly trace", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    await createWorkflowRunPg(db, {
      id: "run-managed-context",
      status: "running",
      domain: "software",
      goalPrompt: "build managed context",
      workflowManifestJson: JSON.stringify(manifest()),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-managed-context",
      taskKey: "implement-feature",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-managed-context",
    });

    const assembler = createManagedContextAssembler(db, { domainPack: softwareDomainPack });
    const assembled = await assembler.buildForTask({
      runId: "run-managed-context",
      taskId: "implement-feature",
      sessionId: "session-managed-context",
      attemptId: "implement-feature-attempt-1",
      handExecutionId: "hand-execution:run-managed-context:implement-feature:implement-feature-attempt-1",
      dependsOn: [],
    });

    assert.equal(assembled.contextPacket.id, "ctx-run-managed-context-implement-feature-implement-feature-attempt-1");
    assert.equal(assembled.taskEnvelope.contextPacket.id, assembled.contextPacket.id);
    assert.equal(assembled.taskEnvelope.session.sessionId, "session-managed-context");
    assert.equal(assembled.trace.contextPacketId, assembled.contextPacket.id);
    assert.equal(assembled.trace.taskEnvelopeId, assembled.taskEnvelopeId);
    assert.equal(
      assembled.taskEnvelope.materializedLibraryRefs?.skillRefs.includes("skill.software-implementation"),
      true,
    );

    const packets = await listResourcesPg(db, { resourceType: "context_packet" });
    const envelopes = await listResourcesPg(db, { resourceType: "task_envelope" });
    const traces = await listResourcesPg(db, { resourceType: "context_assembly_trace" });

    assert.equal(packets.length, 1);
    assert.equal(envelopes.length, 1);
    assert.equal(traces.length, 1);
    assert.equal((envelopes[0]?.payload as { envelope?: { contextPacket?: { id?: string } } }).envelope?.contextPacket?.id, packets[0]?.resourceKey);
  } finally {
    await db.close();
  }
});

test("ManagedContextAssembler maps host project root into mounted container workspace", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    await createWorkflowRunPg(db, {
      id: "run-managed-context-workspace",
      status: "running",
      domain: "software",
      goalPrompt: "build managed context with workspace",
      workflowManifestJson: JSON.stringify(manifest()),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: JSON.stringify({
        cwd: "/home/timmypai/apps/customer-todo-web",
        projectRoot: "/home/timmypai/apps/customer-todo-web",
      }),
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-managed-context-workspace",
      taskKey: "implement-feature",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-managed-context-workspace",
    });

    const assembler = createManagedContextAssembler(db, { domainPack: softwareDomainPack });
    const assembled = await assembler.buildForTask({
      runId: "run-managed-context-workspace",
      taskId: "implement-feature",
      sessionId: "session-managed-context-workspace",
      attemptId: "implement-feature-attempt-1",
      handExecutionId: "hand-execution:run-managed-context-workspace:implement-feature:implement-feature-attempt-1",
      dependsOn: [],
    });

    assert.deepEqual(assembled.taskEnvelope.workspace?.handle, {
      repoRoot: "/workspace/repo",
      worktreePath: "/workspace/repo",
      hostMountPath: "/home/timmypai/apps/customer-todo-web",
    });
  } finally {
    await db.close();
  }
});

test("ManagedContextAssembler applies assembly policy to failure summaries", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    await createWorkflowRunPg(db, {
      id: "run-managed-context-failure-policy",
      status: "running",
      domain: "software",
      goalPrompt: "build managed context",
      workflowManifestJson: JSON.stringify(manifest()),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-managed-context-failure-policy",
      taskKey: "implement-feature",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-managed-context",
    });

    const assembler = createManagedContextAssembler(db, { domainPack: softwareDomainPack });
    const assembled = await assembler.buildForTask({
      runId: "run-managed-context-failure-policy",
      taskId: "implement-feature",
      sessionId: "session-managed-context",
      attemptId: "implement-feature-attempt-1",
      handExecutionId: "hand-execution:run-managed-context-failure-policy:implement-feature:implement-feature-attempt-1",
      dependsOn: [],
      failureSummary: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    });

    assert.equal(assembled.contextPacket.failureSummary, undefined);
    assert.equal(
      assembled.contextPacket.excludedCandidates.some((item) => item.sourceRef === "failure-summary:implement-feature-attempt-1" && item.reason === "kind-mismatch"),
      true,
    );
    assert.equal(
      assembled.trace.excludedCandidates.some((item) => item.sourceRef === "failure-summary:implement-feature-attempt-1" && item.reason === "kind-mismatch"),
      true,
    );
  } finally {
    await db.close();
  }
});

test("ManagedContextAssembler materializes implement-feature library refs for llm-constrained run", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer: new ScriptedWorkflowComposer([singleTaskImplementPlan()]),
    });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });

    const assembler = createManagedContextAssembler(db, { domainPack: softwareDomainPack });
    const assembled = await assembler.buildForTask({
      runId: run.runId,
      taskId: "implement-feature",
      sessionId: `root-${run.runId}-implement-feature`,
      attemptId: "implement-feature-attempt-1",
      handExecutionId: `hand-execution:${run.runId}:implement-feature:implement-feature-attempt-1`,
      dependsOn: ["review-spec"],
    });

    const skillInstructionsText = assembled.contextPacket.skillInstructions.map((block) => block.text).join("\n");
    assert.match(skillInstructionsText, /Implement/i);
    assert.match(assembled.taskEnvelope.agentPrompt, /Implement/i);
    assert.equal(assembled.taskEnvelope.toolProxyPolicy?.allowedTools.includes("workspace-write"), true);
    assert.equal(
      assembled.taskEnvelope.materializedLibraryRefs?.instructionRefs.includes("instruction.software-maker"),
      true,
    );
    assert.equal(
      assembled.taskEnvelope.materializedLibraryRefs?.skillRefs.includes("software.implementation"),
      false,
    );
    assert.equal(
      assembled.taskEnvelope.materializedLibraryRefs?.skillRefs.includes("skill.software-implementation"),
      true,
    );
  } finally {
    await db.close();
  }
});

test("ManagedContextAssembler resolves runtime-only reviewer role/profile from workflow manifest", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    await createWorkflowRunPg(db, {
      id: "run-managed-context-runtime-reviewer",
      status: "running",
      domain: "software",
      goalPrompt: "review implementation plan quality",
      workflowManifestJson: JSON.stringify(runtimeReviewerManifest()),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "review-spec",
      runId: "run-managed-context-runtime-reviewer",
      taskKey: "review-spec",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-runtime-reviewer",
    });

    const assembler = createManagedContextAssembler(db, { domainPack: softwareDomainPack });
    const assembled = await assembler.buildForTask({
      runId: "run-managed-context-runtime-reviewer",
      taskId: "review-spec",
      sessionId: "session-runtime-reviewer",
      attemptId: "review-spec-attempt-1",
      handExecutionId: "hand-execution:run-managed-context-runtime-reviewer:review-spec:review-spec-attempt-1",
      dependsOn: [],
    });

    assert.equal(assembled.taskEnvelope.role.id, "spec-reviewer");
    assert.equal(assembled.taskEnvelope.agentProfile.id, "software-spec-reviewer-codex");
  } finally {
    await db.close();
  }
});

function manifest() {
  const makerRole = softwareDomainPack.roles.find((role) => role.id === "maker");
  const makerProfile = softwareDomainPack.agentProfiles.find((profile) => profile.id === "software-maker-pi");
  if (!makerRole || !makerProfile) throw new Error("softwareDomainPack missing maker role/profile for test manifest");
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-managed-context",
    title: "Managed context",
    goalPrompt: "build managed context",
    domain: "software",
    intent: "implement_feature",
    roles: [makerRole],
    agentProfiles: [makerProfile],
    tasks: [{
      id: "implement-feature",
      name: "Implement",
      domain: "software",
      dependsOn: [],
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      evaluatorPipelineRef: "software-feature-quality",
      requiredArtifactRefs: ["implementation_report"],
      instructionRefs: ["instruction.software-maker"],
      skillRefs: ["software.implementation"],
      toolGrantRefs: ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      vaultLeasePolicyRefs: ["vault.github-write-token"],
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

function runtimeReviewerManifest() {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-runtime-reviewer-context",
    title: "Runtime reviewer context",
    goalPrompt: "review implementation plan quality",
    domain: "software",
    intent: "implement_feature",
    roles: [{
      id: "spec-reviewer",
      responsibility: "Review implementation plan quality and risk.",
      defaultAgentProfileRef: "software-spec-reviewer-codex",
      allowedAgentProfileRefs: ["software-spec-reviewer-codex"],
      artifactInputs: ["implementation_plan"],
      artifactOutputs: ["implementation_plan"],
      stopAuthority: "can-reject",
    }],
    agentProfiles: [{
      id: "software-spec-reviewer-codex",
      name: "Software Spec Reviewer",
      provider: "codex",
      model: "gpt-5-codex",
      harnessRef: "codex",
      agentsMdRefs: ["repo:AGENTS.md"],
      promptTemplateRef: "software-spec-reviewer",
      skillRefs: ["software-spec-review"],
      mcpGrantRefs: [],
      memoryScopes: ["software", "project"],
      contextPolicyRef: "software-context-default",
      sessionPolicyRef: "software-session-default",
      toolPolicy: { allowedTools: ["read", "search"], deniedTools: ["write"], requiresApprovalFor: [] },
      budgetPolicy: { maxInputTokens: 12_000, maxOutputTokens: 2_000, maxWallTimeSeconds: 300 },
    }],
    tasks: [{
      id: "review-spec",
      name: "Review spec",
      domain: "software",
      dependsOn: [],
      roleRef: "spec-reviewer",
      agentProfileRef: "software-spec-reviewer-codex",
      evaluatorPipelineRef: "software-plan-quality",
      requiredArtifactRefs: ["implementation_plan"],
      instructionRefs: ["instruction.software-spec-reviewer"],
      skillRefs: ["skill.software-spec-review"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
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
      id: "codex",
      kind: "codex",
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

function singleTaskImplementPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Scripted Implement Workflow",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "Scripted llm test plan with mandatory code quality review.",
    tasks: [
      task(
        "understand-repo",
        [],
        "agent.software-explorer",
        "profile.software-explorer-codex",
        ["skill.software-repo-discovery"],
        ["tool.workspace-read"],
        ["instruction.software-explorer"],
        [],
        [],
        ["artifact.implementation_plan"],
        "evaluator.software-plan-quality",
      ),
      task(
        "review-spec",
        ["understand-repo"],
        "agent.software-spec-reviewer",
        "profile.software-spec-reviewer-codex",
        ["skill.software-spec-review"],
        ["tool.workspace-read"],
        ["instruction.software-spec-reviewer"],
        [],
        [],
        ["artifact.implementation_plan"],
        "evaluator.software-plan-quality",
      ),
      task(
        "implement-feature",
        ["review-spec"],
        "agent.software-maker",
        "profile.software-maker-pi",
        ["skill.software-implementation"],
        ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"],
        ["instruction.software-maker"],
        ["mcp.filesystem-workspace"],
        ["vault.github-write-token"],
        ["artifact.implementation_report"],
        "evaluator.software-feature-quality",
      ),
      task(
        "verify-feature",
        ["implement-feature"],
        "agent.software-checker",
        "profile.software-checker-codex",
        ["skill.software-verification"],
        ["tool.workspace-read", "tool.shell-command"],
        ["instruction.software-checker"],
        [],
        [],
        ["artifact.verification_report"],
        "evaluator.software-verification-quality",
      ),
      task(
        "review-code-quality",
        ["implement-feature"],
        "agent.software-code-quality-reviewer",
        "profile.software-code-quality-reviewer-codex",
        ["skill.software-code-quality-review"],
        ["tool.workspace-read", "tool.shell-command"],
        ["instruction.software-code-quality-reviewer"],
        [],
        [],
        ["artifact.verification_report"],
        "evaluator.software-verification-quality",
      ),
      task(
        "summarize-completion",
        ["verify-feature", "review-code-quality"],
        "agent.software-summarizer",
        "profile.software-summarizer-codex",
        ["skill.software-summary"],
        ["tool.workspace-read"],
        ["instruction.software-summarizer"],
        [],
        [],
        ["artifact.completion_report"],
        "evaluator.software-completion-quality",
      ),
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function task(
  id: string,
  dependsOn: string[],
  agentDefinitionRef: string,
  agentProfileRef: string,
  skillRefs: string[],
  toolGrantRefs: string[],
  instructionRefs: string[],
  mcpGrantRefs: string[],
  vaultLeasePolicyRefs: string[],
  outputArtifactRefs: string[],
  evaluatorProfileRef: string,
): WorkflowCompositionTask {
  return {
    id,
    name: id,
    responsibility: id,
    dependsOn,
    templateSlotRef: id,
    agentDefinitionRef,
    agentProfileRef,
    instructionRefs,
    skillRefs,
    toolGrantRefs,
    mcpGrantRefs,
    vaultLeasePolicyRefs,
    inputArtifactRefs: [],
    outputArtifactRefs,
    evaluatorProfileRef,
    recoveryStrategyRefs: ["retry-same-agent"],
    rationale: id,
  };
}
