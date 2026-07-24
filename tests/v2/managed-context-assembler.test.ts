import test from "node:test";
import assert from "node:assert/strict";
import { createManagedContextAssembler } from "../../src/v2/context/managed-context-assembler.ts";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { captureRunLibrarySnapshotPg } from "../../src/v2/orchestration/run-library-snapshot.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { finalizeGoalRequirementDraft } from "../../src/v2/orchestration/goal-requirement-draft.ts";
import { finalizeUiInteractionContract, reviseUiInteractionContract } from "../../src/v2/orchestration/ui-interaction-contract.ts";

test("ManagedContextAssembler persists matching ContextPacket, TaskEnvelopeV2, and assembly trace", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedManagedContextLibrary(db);
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
    await captureManagedContextSnapshot(db, "run-managed-context");
    await upsertLibraryObject(db, {
      objectKey: "agent.software-maker",
      objectKind: "agent_definition",
      status: "approved",
      headVersionId: "agent.software-maker@mutated",
      state: { scope: "software", title: "Mutated Maker", body: "MUTATED AFTER RUN CREATION" },
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

    const assembler = createManagedContextAssembler(db);
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
    assert.match(
      assembled.contextPacket.agentsMdBlocks.map((block) => block.text).join("\n"),
      /graph-backed software maker AGENTS\.md instructions/,
    );
    assert.equal(
      (assembled.contextPacket as { nodePromptSpec?: { goal?: string } }).nodePromptSpec?.goal,
      "Implement the feature end to end.",
    );
    assert.match(assembled.taskEnvelope.agentPrompt, /Node prompt spec:/);
    assert.match(assembled.taskEnvelope.agentPrompt, /Deliverable documents:/);
    assert.match(assembled.taskEnvelope.agentPrompt, /implementation: Implementation notes/);
    assert.match(assembled.taskEnvelope.agentPrompt, /Acceptance criteria:/);
    assert.match(assembled.taskEnvelope.agentPrompt, /The feature meets the requested behavior/);
    assert.match(assembled.taskEnvelope.agentPrompt, /graph-backed software maker AGENTS\.md instructions/);
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

test("ManagedContextAssembler supplies only confirmed UI contracts owned by task requirements", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedManagedContextLibrary(db);
    const visual = confirmedUiContracts();
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: "draft-ui-context",
      scope: "planner",
      status: "dag_validated",
      payload: {
        goalRequirementDraft: visual.draft,
        goalRequirementDraftHash: visual.draft.draftHash,
        uiInteractionContracts: visual.contracts,
        uiInteractionContractHashes: Object.fromEntries(visual.contracts.map((contract) => [contract.id, contract.contractHash])),
      },
      summary: {},
    });
    await createWorkflowRunPg(db, {
      id: "run-managed-ui-context",
      status: "running",
      domain: "software",
      goalPrompt: "build visual behavior",
      workflowManifestJson: JSON.stringify(manifest(visual.draft.requirements[0]!.id)),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: JSON.stringify({ goalRequirementDraftId: "draft-ui-context" }),
      metricsJson: "{}",
    });
    await captureManagedContextSnapshot(db, "run-managed-ui-context");
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-managed-ui-context",
      taskKey: "implement-feature",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-managed-ui-context",
    });

    const assembled = await createManagedContextAssembler(db).buildForTask({
      runId: "run-managed-ui-context",
      taskId: "implement-feature",
      sessionId: "session-managed-ui-context",
      attemptId: "implement-feature-attempt-1",
      handExecutionId: "hand-ui-context",
      dependsOn: [],
    });

    assert.equal(assembled.contextPacket.uiInteractionContracts?.length, 1);
    assert.equal(assembled.contextPacket.uiInteractionContracts?.[0]?.id, "ui-owned");
    assert.match(assembled.taskEnvelope.agentPrompt, /UI Interaction Contracts:/);
    assert.match(assembled.taskEnvelope.agentPrompt, /screen-owned/);
    assert.doesNotMatch(assembled.taskEnvelope.agentPrompt, /screen-unrelated/);
  } finally {
    await db.close();
  }
});

test("ManagedContextAssembler scopes a shared evaluator pipeline to the task requirement binding", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedManagedContextLibrary(db);
    const workflow = manifest("req-entry");
    workflow.evaluatorPipelines = [{
      id: "software-feature-quality",
      validationBindingIds: ["binding-entry", "binding-quiz"],
      evaluators: [{
        id: "check-entry",
        kind: "evidence",
        required: true,
        config: { validationBindingId: "binding-entry", criterionId: "criterion-entry" },
      }, {
        id: "check-quiz",
        kind: "evidence",
        required: true,
        config: { validationBindingId: "binding-quiz", criterionId: "criterion-quiz" },
      }],
      onFailure: { defaultStrategy: "ask-human" },
    }];
    await createWorkflowRunPg(db, {
      id: "run-managed-context-scoped-evaluator",
      status: "running",
      domain: "software",
      goalPrompt: "build entry then quiz",
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await captureManagedContextSnapshot(db, "run-managed-context-scoped-evaluator");
    await upsertRuntimeResourcePg(db, {
      resourceType: "goal_requirement_coverage",
      resourceKey: "goal-coverage-scoped-evaluator",
      runId: "run-managed-context-scoped-evaluator",
      scope: "run",
      status: "frozen",
      payload: {
        schemaVersion: "southstar.goal_requirement_coverage.v1",
        goalContractHash: "3".repeat(64),
        entries: [{
          requirementId: "req-entry",
          producerTaskIds: ["implement-feature"],
          artifactRefs: ["implementation_report"],
          artifactContractRefs: ["implementation_report"],
          evaluatorTaskIds: ["implement-feature"],
          evaluatorProfileRefs: ["software-feature-quality"],
          evaluatorProfileVersionRefs: ["software-feature-quality@1"],
          validationBindingId: "binding-entry",
          criterionBindings: [{
            criterionId: "criterion-entry",
            criterionVersion: 1,
            blocking: true,
            artifactContractRef: "implementation_report",
            artifactContractVersionRef: "implementation_report@1",
            evaluatorProfileRef: "software-feature-quality",
            evaluatorProfileVersionRef: "software-feature-quality@1",
            verificationMode: "deterministic",
            procedureRef: "procedure.test",
            expectedEvidenceKinds: ["test-result"],
          }],
          criterionIds: ["criterion-entry"],
          acceptanceCriteria: ["Entry behavior passes."],
          requiredEvidenceKinds: ["test-result"],
        }, {
          requirementId: "req-quiz",
          producerTaskIds: ["implement-quiz"],
          artifactRefs: ["implementation_report"],
          artifactContractRefs: ["implementation_report"],
          evaluatorTaskIds: ["verify-quiz"],
          evaluatorProfileRefs: ["software-feature-quality"],
          evaluatorProfileVersionRefs: ["software-feature-quality@1"],
          validationBindingId: "binding-quiz",
          criterionBindings: [{
            criterionId: "criterion-quiz",
            criterionVersion: 1,
            blocking: true,
            artifactContractRef: "implementation_report",
            artifactContractVersionRef: "implementation_report@1",
            evaluatorProfileRef: "software-feature-quality",
            evaluatorProfileVersionRef: "software-feature-quality@1",
            verificationMode: "deterministic",
            procedureRef: "procedure.test",
            expectedEvidenceKinds: ["test-result"],
          }],
          criterionIds: ["criterion-quiz"],
          acceptanceCriteria: ["Quiz behavior passes."],
          requiredEvidenceKinds: ["test-result"],
        }],
      },
      summary: {},
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-managed-context-scoped-evaluator",
      taskKey: "implement-feature",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-scoped-evaluator",
    });

    const assembled = await createManagedContextAssembler(db).buildForTask({
      runId: "run-managed-context-scoped-evaluator",
      taskId: "implement-feature",
      sessionId: "session-scoped-evaluator",
      attemptId: "implement-feature-attempt-1",
      handExecutionId: "hand-scoped-evaluator",
      dependsOn: [],
    });

    assert.deepEqual(assembled.taskEnvelope.evaluatorPipeline.validationBindingIds, ["binding-entry"]);
    assert.deepEqual(assembled.taskEnvelope.evaluatorPipeline.evaluators.map((step) => step.id), ["check-entry"]);
    assert.match(assembled.taskEnvelope.agentPrompt, /criterion-entry/);
    assert.doesNotMatch(assembled.taskEnvelope.agentPrompt, /criterion-quiz/);
  } finally {
    await db.close();
  }
});

test("ManagedContextAssembler maps host project root into mounted container workspace", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedManagedContextLibrary(db);
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
    await captureManagedContextSnapshot(db, "run-managed-context-workspace");
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-managed-context-workspace",
      taskKey: "implement-feature",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-managed-context-workspace",
    });

    const assembler = createManagedContextAssembler(db);
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
    await seedManagedContextLibrary(db);
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
    await captureManagedContextSnapshot(db, "run-managed-context-failure-policy");
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-managed-context-failure-policy",
      taskKey: "implement-feature",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-managed-context",
    });

    const assembler = createManagedContextAssembler(db);
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

test("ManagedContextAssembler resolves runtime-only reviewer role/profile from workflow manifest", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedManagedContextLibrary(db);
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
    await captureManagedContextSnapshot(db, "run-managed-context-runtime-reviewer", true);
    await createWorkflowTaskPg(db, {
      id: "review-spec",
      runId: "run-managed-context-runtime-reviewer",
      taskKey: "review-spec",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-runtime-reviewer",
    });

    const assembler = createManagedContextAssembler(db);
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

function confirmedUiContracts() {
  const draft = finalizeGoalRequirementDraft({
    goalPrompt: "Build two visual behaviors",
    cwd: "/workspace",
    summary: "Build owned and unrelated visual behaviors.",
    requirements: [
      visualRequirement("Owned behavior", "ui-owned"),
      visualRequirement("Unrelated behavior", "ui-unrelated"),
    ],
    nonGoals: [],
    blockingInputs: [],
  });
  const contracts = [
    confirmedContract(draft, draft.requirements[0]!.id, draft.requirements[0]!.acceptanceCriteria[0]!.id, "ui-owned", "screen-owned"),
    confirmedContract(draft, draft.requirements[1]!.id, draft.requirements[1]!.acceptanceCriteria[0]!.id, "ui-unrelated", "screen-unrelated"),
  ];
  return { draft, contracts };
}

function visualRequirement(title: string, contractRef: string) {
  return {
    title,
    statement: `${title} is available.`,
    source: "explicit" as const,
    blocking: true,
    userVisibleBehaviors: [title],
    businessRules: [],
    acceptanceCriteria: [{
      observableClaim: `${title} can be completed.`,
      blocking: true,
      verificationIntent: ["Inspect the visual state transition."],
      requiredAssurance: ["browser_interaction" as const],
      evidenceIntent: ["screenshot" as const],
    }],
    expectedOutcomeArtifacts: [{ description: title }],
    verificationIntent: ["Inspect state transition."],
    assumptions: [],
    openQuestions: [],
    riskTags: [],
    interactionContractRefs: [contractRef],
  };
}

function confirmedContract(
  draft: ReturnType<typeof finalizeGoalRequirementDraft>,
  requirementId: string,
  criterionId: string,
  contractId: string,
  screenId: string,
) {
  const initial = finalizeUiInteractionContract({
    requirementIds: [requirementId],
    screens: [{
      id: screenId,
      title: screenId,
      purpose: "Show and complete one behavior",
      layout: { regions: [{ id: `${screenId}-main`, role: "main", position: "center", childRefs: [`${screenId}-action`] }] },
      elements: [{ id: `${screenId}-action`, type: "button", label: "Complete", visibleInStates: ["ready"], enabledInStates: ["ready"] }],
      states: ["ready", "complete"],
      actions: [{ id: `${screenId}-complete`, triggerElementId: `${screenId}-action`, fromState: "ready", toState: "complete", expectedEffect: "Complete behavior" }],
      responsiveRules: ["Action remains visible."],
      accessibilityRules: ["Action is keyboard accessible."],
    }],
    flows: [{ id: `${screenId}-flow`, steps: [`${screenId}-complete`], successOutcome: "Behavior is complete" }],
    criterionBindings: [{ criterionId, screenIds: [screenId], elementIds: [`${screenId}-action`], actionIds: [`${screenId}-complete`] }],
  }, draft, { id: contractId });
  return reviseUiInteractionContract(initial, { kind: "confirm" }, draft);
}

function manifest(requirementId = "req-owned") {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-managed-context",
    title: "Managed context",
    goalPrompt: "build managed context",
    domain: "software",
    intent: "implement_feature",
    roles: [makerRole()],
    agentProfiles: [{
      ...makerProfile(),
      agentRef: "agent.software-maker",
      agentsMdRefs: ["agent.software-maker"],
    }],
    tasks: [{
      id: "implement-feature",
      name: "Implement",
      domain: "software",
      dependsOn: [],
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      evaluatorPipelineRef: "software-feature-quality",
      promptInputs: {
        requirementIds: [requirementId],
        nodePromptSpec: {
          nodeType: "implement",
          goal: "Implement the feature end to end.",
          requirements: ["Use the existing project conventions.", "Preserve current tests."],
          boundaries: ["Only edit files required by this task."],
          nonGoals: ["Do not redesign unrelated UI."],
          deliverableDocuments: [
            {
              kind: "implementation",
              title: "Implementation notes",
              required: true,
              format: "markdown",
              description: "Describe code changes and decisions for the next node.",
            },
            {
              kind: "test",
              title: "Test evidence",
              required: true,
              format: "markdown",
              description: "Record commands and outcomes for verification.",
            },
          ],
          expectedOutputs: ["implementation_report"],
          implementationScope: ["Implement only the requested feature behavior."],
          testCases: [{
            name: "Focused verification",
            command: "npm test",
            expected: "Relevant tests pass.",
          }],
          acceptanceCriteria: ["The feature meets the requested behavior."],
          failureReportContract: "Report blockers with evidence and proposed repair.",
        },
      },
      requiredArtifactRefs: ["implementation_report"],
      instructionRefs: ["instruction.software-maker"],
      skillRefs: ["skill.software-implementation"],
      toolGrantRefs: ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"],
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
    artifactContracts: [{
      id: "implementation_report",
      artifactType: "implementation-report",
      requiredFields: ["summary"],
      evidenceFields: ["summary"],
    }],
    evaluatorPipelines: [{
      id: "software-feature-quality",
      evaluators: [],
      onFailure: { defaultStrategy: "ask-human" },
    }],
    contextPolicies: [contextPolicy()],
    sessionPolicies: [sessionPolicy()],
    memoryPolicies: [memoryPolicy()],
    workspacePolicies: [workspacePolicy()],
    stopConditions: [],
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
      vaultLeasePolicyRefs: [],
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
    artifactContracts: [{
      id: "implementation_plan",
      artifactType: "implementation-plan",
      requiredFields: ["summary"],
      evidenceFields: ["summary"],
    }],
    evaluatorPipelines: [{
      id: "software-plan-quality",
      evaluators: [],
      onFailure: { defaultStrategy: "ask-human" },
    }],
    contextPolicies: [contextPolicy()],
    sessionPolicies: [sessionPolicy()],
    memoryPolicies: [memoryPolicy()],
    workspacePolicies: [workspacePolicy()],
    stopConditions: [],
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

function makerRole() {
  return {
    id: "maker",
    responsibility: "Implement the requested software change.",
    defaultAgentProfileRef: "software-maker-pi",
    allowedAgentProfileRefs: ["software-maker-pi"],
    artifactInputs: [],
    artifactOutputs: ["implementation_report"],
    stopAuthority: "can-suggest",
  };
}

function makerProfile() {
  return {
    id: "software-maker-pi",
    name: "Software Maker",
    provider: "pi",
    model: "pi-agent-default",
    harnessRef: "pi",
    agentsMdRefs: ["agent.software-maker"],
    promptTemplateRef: "software-maker",
    skillRefs: ["skill.software-implementation"],
    mcpGrantRefs: [],
    vaultLeasePolicyRefs: [],
    memoryScopes: ["software", "project"],
    contextPolicyRef: "software-context-default",
    sessionPolicyRef: "software-session-default",
    toolPolicy: {
      allowedTools: ["workspace-read", "workspace-write", "shell-command"],
      deniedTools: [],
      requiresApprovalFor: [],
    },
    budgetPolicy: {
      maxInputTokens: 12_000,
      maxOutputTokens: 4_000,
      maxWallTimeSeconds: 600,
    },
  };
}

function contextPolicy() {
  return {
    id: "software-context-default",
    maxInputTokens: 12_000,
    memoryPolicyRef: "software-memory-default",
    includeAgentsMd: true,
    includeWorkspaceSummary: true,
  };
}

function sessionPolicy() {
  return {
    id: "software-session-default",
    checkpointOn: ["task-start", "artifact-accepted", "before-recovery"],
    allowFork: true,
    allowReset: true,
    allowRollback: true,
  };
}

function memoryPolicy() {
  return {
    id: "software-memory-default",
    providerRef: "postgres",
    scopes: ["software", "project"],
    maxInjectedTokens: 1_500,
    maxCandidates: 5,
    requireWriteApproval: true,
    allowedKinds: ["preference", "architecture_decision", "domain_pattern", "failure_lesson", "artifact_summary", "workflow_learning"],
    ranking: {
      relevanceWeight: 0.5,
      recencyWeight: 0.2,
      successWeight: 0.2,
      confidenceWeight: 0.1,
    },
    compression: {
      strategy: "none",
      maxTokensPerMemory: 800,
    },
  };
}

function workspacePolicy() {
  return {
    id: "software-workspace-default",
    provider: "git",
    snapshotAtTaskStart: true,
    snapshotAtAcceptedArtifact: true,
    forkOnCheckerReject: true,
    rollbackOnTestFailure: true,
  };
}

async function seedManagedContextLibrary(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await upsertLibraryObject(db, {
    objectKey: "agent.software-maker",
    objectKind: "agent_definition",
    status: "approved",
    headVersionId: "agent.software-maker@managed-context-test",
    state: {
      scope: "software",
      title: "Software Maker",
      body: "Use the graph-backed software maker AGENTS.md instructions.",
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "instruction.software-maker",
    objectKind: "instruction_template",
    status: "approved",
    headVersionId: "instruction.software-maker@managed-context-test",
    state: { scope: "software", title: "Software Maker Instruction", content: "Implement and report clearly.", variables: [] },
  });
  await upsertLibraryObject(db, {
    objectKey: "instruction.software-spec-reviewer",
    objectKind: "instruction_template",
    status: "approved",
    headVersionId: "instruction.software-spec-reviewer@managed-context-test",
    state: { scope: "software", title: "Spec Reviewer Instruction", content: "Review the implementation plan.", variables: [] },
  });
  await upsertLibraryObject(db, {
    objectKey: "skill.software-implementation",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.software-implementation@managed-context-test",
    state: {
      scope: "software",
      title: "Software Implementation",
      body: "# Software Implementation\n\nImplement the requested change.",
      allowedTools: ["workspace-read", "workspace-write", "shell-command"],
      requiredMounts: ["workspace"],
      mcpRequirements: [],
      artifactContracts: ["implementation_report"],
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "skill.software-spec-review",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.software-spec-review@managed-context-test",
    state: {
      scope: "software",
      title: "Software Spec Review",
      body: "# Software Spec Review\n\nReview quality and risk.",
      allowedTools: ["workspace-read"],
      requiredMounts: ["workspace"],
      mcpRequirements: [],
      artifactContracts: ["implementation_plan"],
    },
  });
  for (const [objectKey, title, runtimeToolNames] of [
    ["tool.workspace-read", "workspace-read", ["read", "grep", "find", "ls"]],
    ["tool.workspace-write", "workspace-write", ["edit", "write"]],
    ["tool.shell-command", "shell-command", ["bash"]],
  ] as const) {
    await upsertLibraryObject(db, {
      objectKey,
      objectKind: "tool_definition",
      status: "approved",
      headVersionId: `${objectKey}@managed-context-test`,
      state: { scope: "global", title, runtimeToolNames },
    });
  }
}

async function captureManagedContextSnapshot(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  runId: string,
  reviewer = false,
): Promise<void> {
  const selectedRefs = reviewer
    ? ["instruction.software-spec-reviewer", "skill.software-spec-review", "tool.workspace-read"]
    : [
      "agent.software-maker",
      "instruction.software-maker",
      "skill.software-implementation",
      "tool.workspace-read",
      "tool.workspace-write",
      "tool.shell-command",
    ];
  await captureRunLibrarySnapshotPg(db, {
    runId,
    goalContractHash: "1".repeat(64),
    manifestHash: "2".repeat(64),
    libraryObjectVersionRefs: selectedRefs.map((objectKey) => ({ objectKey, versionRef: `${objectKey}@managed-context-test` })),
  });
}
