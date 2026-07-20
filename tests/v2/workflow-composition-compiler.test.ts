import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../../src/v2/orchestration/composition-compiler.ts";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { DeterministicFixtureComposer } from "./fixtures/deterministic-workflow-composer.ts";
import { goalContractHash, requirementSpecFromGoalContract } from "../../src/v2/orchestration/goal-contract.ts";
import {
  finalizeGoalDesignPackageV2,
  type GoalDesignPackageV2,
} from "../../src/v2/orchestration/goal-design.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { softwareGoalContract } from "./fixtures/goal-contract.ts";
import type { GeneratedAgentProfile, WorkflowCompositionPlan, WorkflowNodePromptSpec } from "../../src/v2/design-library/types.ts";

test("compiler builds library-constrained workflow manifest and snapshot from approved candidates", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const goalContract = softwareGoalContract();
    const requirementSpec = requirementSpecFromGoalContract(goalContract);
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composer = new DeterministicFixtureComposer();
    const composition = await composer.compose({
      goalPrompt: "implement calc sum",
      goalContract,
      candidatePacket,
    });
    composition.tasks.find((task) => task.id === "implement-feature")!.workspaceMutation = {
      mode: "shared_write",
      resourceKeys: ["src", "tests"],
    };

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-test-run",
      goalPrompt: "implement calc sum",
      goalContract,
      candidatePacket,
      composition,
    });

    assert.equal(compiled.workflow.schemaVersion, "southstar.v2");
    assert.equal(compiled.workflow.workflowGeneration?.generatorPolicyRef, "library-constrained-llm");
    assert.deepEqual(compiled.workflow.tasks.map((task) => task.id), [
      "understand-repo",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);

    const makerTask = compiled.workflow.tasks.find((task) => task.id === "implement-feature");
    assert.ok(makerTask, "implement-feature task should exist");
    assert.equal(makerTask.agentProfileRef, "profile.generated.software-implement-feature");
    assert.deepEqual(makerTask.instructionRefs, []);
    assert.deepEqual(makerTask.toolGrantRefs, []);
    assert.deepEqual((makerTask.promptInputs?.nodePromptSpec as { expectedOutputs?: string[] })?.expectedOutputs, [
      "artifact.implementation_report",
    ]);
    assert.match(
      JSON.stringify(makerTask.promptInputs?.nodePromptSpec),
      /Implement Feature/,
    );
    assert.deepEqual(makerTask.promptInputs?.requirementIds, [goalContract.requirements[0]!.id]);
    assert.deepEqual(makerTask.workspaceMutation, {
      mode: "shared_write",
      resourceKeys: ["src", "tests"],
    });
    assert.deepEqual(
      (makerTask.promptInputs?.nodePromptSpec as { requirements?: string[] })?.requirements,
      [goalContract.requirements[0]!.statement],
    );
    assert.deepEqual(
      (makerTask.promptInputs?.nodePromptSpec as { acceptanceCriteria?: string[] })?.acceptanceCriteria,
      goalContract.requirements[0]!.acceptanceCriteria,
    );

    assert.equal(compiled.orchestrationSnapshot.validation.ok, true);
    assert.equal(compiled.orchestrationSnapshot.goalContractHash, goalContractHash(goalContract));
    assert.deepEqual(compiled.orchestrationSnapshot.requirementSpec, requirementSpec);
    assert.equal(compiled.goalRequirementCoverage.goalContractHash, goalContractHash(goalContract));
    assert.deepEqual(
      compiled.goalRequirementCoverage.entries[0]?.producerTaskIds.includes("implement-feature"),
      true,
    );
    assert.equal(
      ["verify-feature", "review-code-quality"].every((taskId) =>
        compiled.goalRequirementCoverage.entries[0]?.evaluatorTaskIds.includes(taskId)
      ),
      true,
    );
    assert.equal(
      compiled.orchestrationSnapshot.selectedCompositionPlan.generatedComponentProposals.some((proposal) =>
        proposal.id === "profile.generated.software-implement-feature"
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

test("compiler resolves runtime role/profile definitions for deterministic fixture composition", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const goalContract = softwareGoalContract();
    const requirementSpec = requirementSpecFromGoalContract(goalContract);
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composition = await new DeterministicFixtureComposer().compose({
      goalPrompt: "implement calc sum",
      goalContract,
      candidatePacket,
    });

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-roles-profiles-test-run",
      goalPrompt: "implement calc sum",
      goalContract,
      candidatePacket,
      composition,
    });

    const reviewSpec = compiled.workflow.tasks.find((task) => task.id === "review-spec");
    assert.ok(reviewSpec, "review-spec task should exist");
    assert.equal(reviewSpec.agentProfileRef, "profile.generated.software-review-spec");

    const reviewCodeQuality = compiled.workflow.tasks.find((task) => task.id === "review-code-quality");
    assert.ok(reviewCodeQuality, "review-code-quality task should exist");
    assert.equal(reviewCodeQuality.agentProfileRef, "profile.generated.software-review-code-quality");

    assert.equal(compiled.workflow.roles?.some((role) => role.id === "spec-reviewer"), true);
    assert.equal(
      compiled.workflow.agentProfiles?.some((profile) =>
        profile.id === "profile.generated.software-review-spec" && profile.model === "pi-agent-default"
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

test("compiler snapshot freezes only selected library version refs", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const goalContract = softwareGoalContract();
    const requirementSpec = requirementSpecFromGoalContract(goalContract);
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composition = await new DeterministicFixtureComposer().compose({
      goalPrompt: "implement calc sum",
      goalContract,
      candidatePacket,
    });

    const selectedAgentVersionRef = candidatePacket.graphMetadataCandidates?.nodes.find((node) =>
      node.ref === "agent.software-explorer"
    )?.versionRef;
    assert.ok(selectedAgentVersionRef, "expected explorer agent candidate to include a versionRef");

    const inflatedPacket = {
      ...candidatePacket,
      workflowTemplateCandidates: [
        ...candidatePacket.workflowTemplateCandidates,
        {
          ...candidatePacket.workflowTemplateCandidates[0],
          ref: "template.unused",
          versionRef: "template.unused@v1",
        },
      ],
      graphMetadataCandidates: {
        ...candidatePacket.graphMetadataCandidates!,
        nodes: [
          ...candidatePacket.graphMetadataCandidates!.nodes,
          {
            ref: "agent.unused",
            kind: "agent_definition",
            status: "approved",
            versionRef: "agent.unused@v1",
            scope: "software",
            title: "Unused Agent",
            aliases: [],
          },
        ],
      },
    };

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-selected-version-refs-test-run",
      goalPrompt: "implement calc sum",
      goalContract,
      candidatePacket: inflatedPacket,
      composition,
    });

    assert.equal(
      compiled.orchestrationSnapshot.compiler.libraryVersionRefs.includes("template.software-feature@v1"),
      true,
    );
    assert.equal(
      compiled.orchestrationSnapshot.compiler.libraryVersionRefs.includes(selectedAgentVersionRef),
      true,
    );
    assert.equal(compiled.orchestrationSnapshot.compiler.libraryVersionRefs.includes("template.unused@v1"), false);
    assert.equal(compiled.orchestrationSnapshot.compiler.libraryVersionRefs.includes("agent.unused@v1"), false);
    assert.equal(
      compiled.orchestrationSnapshot.compiler.libraryObjectVersionRefs.find((pair) =>
        pair.objectKey === "template.software-feature"
      )?.versionRef,
      "template.software-feature@v1",
    );
    assert.deepEqual(
      compiled.workflow.compiledFrom?.libraryObjectVersionRefs,
      compiled.orchestrationSnapshot.compiler.libraryObjectVersionRefs,
    );
  } finally {
    await db.close();
  }
});

test("compiler threads explicit scope into workflow domain, task domain, and harness capabilities", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    await mirrorLibraryScope(db, { fromScope: "software", toScope: "research" });
    const goalContract = softwareGoalContract();
    const requirementSpec = requirementSpecFromGoalContract(goalContract);
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "research" });
    const composition = await new DeterministicFixtureComposer().compose({
      goalPrompt: "implement calc sum",
      goalContract,
      candidatePacket,
    });

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-explicit-scope",
      goalPrompt: "implement calc sum",
      goalContract,
      candidatePacket,
      composition,
      scope: "research",
    });

    assert.equal(compiled.workflow.domain, "research");
    assert.equal(compiled.workflow.tasks.every((task) => task.domain === "research"), true);
    assert.equal(
      compiled.workflow.harnessDefinitions?.every((harness) => harness.capabilities.includes("research")),
      true,
    );
  } finally {
    await db.close();
  }
});

test("compiler preserves custom workflow scope while using general task domain", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const goalContract = softwareGoalContract();
    const requirementSpec = requirementSpecFromGoalContract(goalContract);
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composition = await new DeterministicFixtureComposer().compose({
      goalPrompt: "implement calc sum",
      goalContract,
      candidatePacket,
    });
    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-custom-domain",
      goalPrompt: "implement calc sum",
      goalContract,
      candidatePacket,
      composition,
      manifestDomain: "design/article",
    });

    assert.equal(compiled.workflow.domain, "design/article");
    assert.equal(compiled.workflow.tasks.every((task) => task.domain === "general"), true);
    assert.equal(compiled.workflow.harnessDefinitions.every((harness) => harness.capabilities.includes("design/article")), true);
  } finally {
    await db.close();
  }
});

test("compiler freezes approved Library artifact fields, evaluator procedures, criteria, and versions", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const goalContract = softwareGoalContract();
    const requirement = goalContract.requirements[0]!;
    const artifactRef = "artifact.frozen-output";
    const artifactVersionRef = "artifact.frozen-output@2";
    const evaluatorRef = "evaluator.frozen-output";
    const evaluatorVersionRef = "evaluator.frozen-output@3";
    await upsertLibraryObject(db, {
      objectKey: artifactRef,
      objectKind: "artifact_contract",
      status: "approved",
      headVersionId: artifactVersionRef,
      state: {
        scope: "software",
        title: "Frozen output",
        artifactType: "verified_output",
        mediaTypes: ["application/json"],
        requiredFields: ["content"],
        validationRules: ["rule.output-complete"],
        evidenceKinds: ["screenshot"],
        schemaRef: "schema.verified-output.v2",
        provenanceRequirements: ["workspace-artifact"],
      },
    });
    await upsertLibraryObject(db, {
      objectKey: evaluatorRef,
      objectKind: "evaluator_profile",
      status: "approved",
      headVersionId: evaluatorVersionRef,
      state: {
        scope: "software",
        title: "Frozen output evaluator",
        validatesArtifactRefs: [artifactRef],
        requiredInputs: ["accepted-artifact"],
        verificationModes: ["browser_interaction"],
        verificationProcedures: [{
          id: "procedure.inspect-output",
          checkKind: "browser_interaction",
          instruction: "Inspect the accepted output and capture the observable result.",
          allowedEvidenceKinds: ["screenshot"],
        }],
        evidenceKinds: ["screenshot"],
        resultSchemaRef: "southstar.requirement_evaluator_result.v2",
        independencePolicy: "independent",
        failureClassifications: ["output_incomplete"],
      },
    });
    const packageValue = frozenValidationPackage(goalContract, {
      artifactRef,
      artifactVersionRef,
      evaluatorRef,
      evaluatorVersionRef,
    });
    const candidatePacket = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(goalContract),
      scope: "software",
    });
    const composition = hostContractComposition(goalContract, {
      hostArtifactRef: artifactRef,
      hostEvaluatorRef: evaluatorRef,
    });

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-frozen-validation-contracts",
      goalPrompt: goalContract.originalPrompt,
      goalContract,
      goalDesignPackage: packageValue,
      candidatePacket,
      composition,
    });

    const artifact = compiled.workflow.artifactContracts?.find((entry) => entry.libraryObjectRef === artifactRef);
    assert.ok(artifact);
    assert.deepEqual(artifact.requiredFields, ["content"]);
    assert.deepEqual(artifact.validationRules, ["rule.output-complete"]);
    assert.deepEqual(artifact.evidenceKinds, ["screenshot"]);
    assert.deepEqual(artifact.provenanceRequirements, ["workspace-artifact"]);
    assert.equal(artifact.libraryVersionRef, artifactVersionRef);
    const pipeline = compiled.workflow.evaluatorPipelines?.find((entry) => entry.libraryObjectRef === evaluatorRef);
    assert.ok(pipeline);
    assert.equal(pipeline.libraryVersionRef, evaluatorVersionRef);
    assert.equal(pipeline.evaluators[0]?.config.criterionId, "criterion-output");
    assert.equal(pipeline.evaluators[0]?.config.procedureRef, "procedure.inspect-output");
    assert.equal(pipeline.evaluators[0]?.config.acceptanceCriterion, requirement.acceptanceCriteria[0]);
    const coverage = compiled.goalRequirementCoverage.entries[0]!;
    assert.deepEqual(coverage.criterionIds, ["criterion-output"]);
    assert.deepEqual(coverage.acceptanceCriteria, requirement.acceptanceCriteria);
    assert.deepEqual(coverage.evaluatorProfileVersionRefs, [evaluatorVersionRef]);
    assert.equal(coverage.validationBindingId, "binding-output");
    assert.equal(
      compiled.workflow.compiledFrom?.libraryObjectVersionRefs.find((entry) => entry.objectKey === artifactRef)?.versionRef,
      artifactVersionRef,
    );

    await upsertLibraryObject(db, {
      objectKey: artifactRef,
      objectKind: "artifact_contract",
      status: "approved",
      headVersionId: "artifact.frozen-output@3",
      state: {
        scope: "software",
        title: "Frozen output",
        artifactType: "verified_output",
        mediaTypes: ["application/json"],
        requiredFields: ["content"],
        validationRules: ["rule.output-complete"],
        evidenceKinds: ["screenshot"],
        schemaRef: "schema.verified-output.v3",
        provenanceRequirements: ["workspace-artifact"],
      },
    });
    await assert.rejects(
      compileWorkflowComposition(db, {
        runId: "draft-stale-validation-contracts",
        goalPrompt: goalContract.originalPrompt,
        goalContract,
        goalDesignPackage: packageValue,
        candidatePacket,
        composition,
      }),
      /frozen Library version mismatch/,
    );
  } finally {
    await db.close();
  }
});

async function mirrorLibraryScope(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  input: { fromScope: string; toScope: string },
): Promise<void> {
  await db.query(
    `update southstar.library_objects
        set state_json = jsonb_set(
          state_json,
          '{domainRefs}',
          to_jsonb(array[$1::text, $2::text]),
          true
        )
      where state_json->>'scope' = $1`,
    [input.fromScope, input.toScope],
  );
  await db.query(
    `insert into southstar.library_edges (
       id,
       from_object_key,
       from_version_ref,
       edge_type,
       to_object_key,
       to_version_ref,
       scope,
       status,
       weight,
       metadata_json,
       created_at
     )
     select
       'edge-' || substr(md5(
         from_object_key || '|' ||
         coalesce(from_version_ref, '') || '|' ||
         edge_type || '|' ||
         to_object_key || '|' ||
         coalesce(to_version_ref, '') || '|' ||
         $2
       ), 1, 20),
       from_object_key,
       from_version_ref,
       edge_type,
       to_object_key,
       to_version_ref,
       $2,
       status,
       weight,
       metadata_json,
       now()
      from southstar.library_edges
     where scope = $1
     on conflict (id) do nothing`,
    [input.fromScope, input.toScope],
  );
}

function hostContractComposition(
  goalContract: ReturnType<typeof softwareGoalContract>,
  input: { hostArtifactRef: string; hostEvaluatorRef: string },
): WorkflowCompositionPlan {
  const requirementId = goalContract.requirements[0]!.id;
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Host Goal Design Contract Workflow",
    rationale: "Use graph-backed agents with host-owned Goal Design artifact and evaluator contracts.",
    tasks: [
      hostTask({
        id: "implement-host-contract",
        name: "Implement Host Contract",
        nodeType: "implement",
        sliceId: "slice-main",
        requirementIds: [requirementId],
        dependsOn: [],
        agentDefinitionRef: "agent.software-maker",
        agentProfileRef: "profile.generated.host-implement",
        outputArtifactRefs: [input.hostArtifactRef],
        evaluatorProfileRef: input.hostEvaluatorRef,
      }),
      hostTask({
        id: "verify-host-contract",
        name: "Verify Host Contract",
        nodeType: "verify",
        sliceId: "slice-main",
        requirementIds: [requirementId],
        dependsOn: ["implement-host-contract"],
        agentDefinitionRef: "agent.software-checker",
        agentProfileRef: "profile.generated.host-verify",
        inputArtifactRefs: [input.hostArtifactRef],
        outputArtifactRefs: [input.hostArtifactRef],
        evaluatorProfileRef: input.hostEvaluatorRef,
      }),
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [
      hostGeneratedProfile("profile.generated.host-implement", "Implement the host Goal Design contract.", "execution_worker"),
      hostGeneratedProfile("profile.generated.host-verify", "Verify the host Goal Design contract.", "validation_worker"),
    ],
  };
}

function frozenValidationPackage(
  goalContract: ReturnType<typeof softwareGoalContract>,
  input: {
    artifactRef: string;
    artifactVersionRef: string;
    evaluatorRef: string;
    evaluatorVersionRef: string;
  },
): GoalDesignPackageV2 {
  const requirement = goalContract.requirements[0]!;
  return finalizeGoalDesignPackageV2({
    schemaVersion: "southstar.goal_design_package.v2",
    revision: 1,
    goalContract,
    requirementDraftHash: "requirement-draft-hash",
    validationBindings: [{
      schemaVersion: "southstar.requirement_validation_binding.v1",
      id: "binding-output",
      requirementId: requirement.id,
      criterionIds: ["criterion-output"],
      acceptanceCriteria: [...requirement.acceptanceCriteria],
      artifactContractRefs: [input.artifactRef],
      artifactContractVersionRefs: [input.artifactVersionRef],
      evaluatorProfileRef: input.evaluatorRef,
      evaluatorProfileVersionRef: input.evaluatorVersionRef,
      verificationMode: "browser_interaction",
      criterionChecks: [{
        criterionId: "criterion-output",
        procedureRef: "procedure.inspect-output",
        expectedEvidenceKinds: ["screenshot"],
      }],
      requiredEvidenceKinds: ["screenshot"],
      independence: "independent",
      failureClassifications: ["output_incomplete"],
    }],
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: 1,
      slices: [{
        id: "slice-main",
        requirementIds: [requirement.id],
        outcome: requirement.statement,
        stateOrArtifactOwner: input.artifactRef,
        mutationBoundary: "single verified output",
        expectedArtifactRefs: [input.artifactRef],
        evaluatorContractRefs: ["binding-output"],
        dependsOnSliceIds: [],
        dependencyArtifactRefs: [],
      }],
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: ["slice-main"],
      rationale: "one requirement and one verification boundary",
    },
    templatePolicy: { mode: "auto" },
    goalDesignSkillRef: "skill.southstar-goal-design",
    goalDesignSkillVersionRef: "skill.southstar-goal-design@test",
    workspaceDiscoveryHash: "discovery-hash",
    mode: "review_before_compose",
  });
}

function withoutHostContractCandidates(
  packet: Awaited<ReturnType<typeof resolveWorkflowCandidates>>,
  refs: string[],
): Awaited<ReturnType<typeof resolveWorkflowCandidates>> {
  const refSet = new Set(refs);
  return {
    ...packet,
    artifactContractCandidates: packet.artifactContractCandidates.filter((candidate) => !refSet.has(candidate.ref)),
    evaluatorCandidatesByArtifact: Object.fromEntries(Object.entries(packet.evaluatorCandidatesByArtifact).map(([artifactRef, candidates]) => [
      artifactRef,
      candidates.filter((candidate) => !refSet.has(candidate.ref)),
    ])),
    graphMetadataCandidates: packet.graphMetadataCandidates
      ? {
          ...packet.graphMetadataCandidates,
          nodes: packet.graphMetadataCandidates.nodes.filter((node) => !refSet.has(node.ref)),
          edges: packet.graphMetadataCandidates.edges.filter((edge) =>
            !refSet.has(edge.fromRef) && !refSet.has(edge.toRef)
          ),
        }
      : undefined,
  };
}

function hostTask(input: {
  id: string;
  name: string;
  nodeType: WorkflowNodePromptSpec["nodeType"];
  sliceId: string;
  requirementIds: string[];
  dependsOn: string[];
  agentDefinitionRef: string;
  agentProfileRef: string;
  inputArtifactRefs?: string[];
  outputArtifactRefs: string[];
  evaluatorProfileRef: string;
}): WorkflowCompositionPlan["tasks"][number] {
  return {
    id: input.id,
    name: input.name,
    responsibility: input.name,
    sliceId: input.sliceId,
    requirementIds: input.requirementIds,
    nodePromptSpec: {
      nodeType: input.nodeType,
      goal: input.name,
      requirements: ["Satisfy the Goal Design host contract."],
      boundaries: ["Stay within this slice."],
      nonGoals: [],
      deliverableDocuments: [],
      expectedOutputs: input.outputArtifactRefs,
      testCases: [],
      acceptanceCriteria: ["Host evidence is produced."],
    },
    dependsOn: input.dependsOn,
    agentDefinitionRef: input.agentDefinitionRef,
    agentProfileRef: input.agentProfileRef,
    instructionRefs: [],
    skillRefs: [],
    toolGrantRefs: [],
    mcpGrantRefs: [],
    vaultLeasePolicyRefs: [],
    inputArtifactRefs: input.inputArtifactRefs ?? [],
    outputArtifactRefs: input.outputArtifactRefs,
    evaluatorProfileRef: input.evaluatorProfileRef,
    recoveryStrategyRefs: ["retry-same-agent"],
    rationale: `Use ${input.agentDefinitionRef} for ${input.id}`,
  };
}

function hostGeneratedProfile(
  id: string,
  instruction: string,
  workerKind: NonNullable<GeneratedAgentProfile["workerKind"]>,
): WorkflowCompositionPlan["generatedComponentProposals"][number] {
  return {
    id,
    kind: "agent_profile",
    risk: "medium",
    reason: "Generated from graph-backed primitives and host Goal Design contracts.",
    validationStatus: "validated",
    agentProfile: {
      workerKind,
      provider: "pi",
      model: "pi-agent-default",
      thinkingLevel: "high",
      harnessRef: "pi",
      instruction,
      promptTemplateRef: "graph-generated",
      contextPolicyRef: "context.generated",
      sessionPolicyRef: "session.generated",
      memoryScopes: [],
      agentsMdRefs: [],
      vaultLeasePolicyRefs: [],
      toolPolicy: { allowedTools: [], deniedTools: [], requiresApprovalFor: [] },
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
  };
}
