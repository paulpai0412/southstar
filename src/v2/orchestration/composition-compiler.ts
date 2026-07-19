import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type {
  CandidatePacket,
  GeneratedAgentProfile,
  GeneratedComponentProposal,
  WorkflowCompositionPlan,
  WorkflowCompositionTask,
  WorkflowNodePromptSpec,
  WorkflowCompositionValidationResult,
} from "../design-library/types.ts";
import { findLibraryObjectByKey } from "../design-library/library-graph-store.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import type {
  AgentProfile,
  ArtifactContract,
  ContextPolicyDefinition,
  EvaluatorPipelineDefinition,
  EvaluatorStepDefinition,
  MemoryPolicyDefinition,
  RoleDefinition,
  SessionPolicyDefinition,
  StopConditionDefinition,
  WorkspacePolicyDefinition,
} from "../design-library/runtime-types.ts";
import type { LibraryObjectVersionRef, SouthstarWorkflowManifest, TaskExecutionSpec, WorkflowTaskDefinition } from "../manifests/types.ts";
import {
  collectSelectedObjectVersionRefs,
  collectSelectedRefs,
  isLibraryBackedRef,
  summarizeCandidates,
  type CandidateSelectionSummary,
} from "./composition-selection-summary.ts";
import { validateWorkflowCompositionPlan } from "./composition-validator.ts";
import {
  buildGoalRequirementCoverage,
  type GoalRequirementCoverageV1,
} from "./goal-requirement-coverage.ts";
import {
  goalContractHash,
  requirementSpecFromGoalContract,
  type GoalContractV1,
} from "./goal-contract.ts";
import type { GoalDesignPackage } from "./goal-design.ts";
import { runtimeBindingCapabilitiesFromEnv, type RuntimeBindingCapabilities } from "./runtime-binding-capabilities.ts";
import { classifyWorkflowCompositionTask } from "./workflow-node-classifier.ts";
import { acceptWorkflowComposition } from "./manifest-acceptance.ts";

export type CompileWorkflowCompositionInput = {
  runId: string;
  goalPrompt: string;
  goalContract: GoalContractV1;
  candidatePacket: CandidatePacket;
  composition: WorkflowCompositionPlan;
  goalDesignPackage?: GoalDesignPackage;
  targetRequirementIds?: string[];
  scope?: string;
  manifestDomain?: string;
  runtimeBindingCapabilities?: RuntimeBindingCapabilities;
};

export type OrchestrationSnapshotV1 = {
  schemaVersion: "southstar.orchestration_snapshot.v1";
  draftId: string;
  requirementSpec: CandidatePacket["requirementSpec"];
  goalContractHash: string;
  candidatePacketHash: string;
  candidateSummary: CandidateSelectionSummary;
  selectedCompositionPlan: WorkflowCompositionPlan;
  validation: WorkflowCompositionValidationResult;
  compiler: {
    version: "library-constrained-compiler-v1";
    manifestHash: string;
    selectedLibraryRefs: string[];
    libraryVersionRefs: string[];
    libraryObjectVersionRefs: LibraryObjectVersionRef[];
  };
};

export type CompiledWorkflowComposition = {
  workflow: SouthstarWorkflowManifest;
  goalRequirementCoverage: GoalRequirementCoverageV1;
  orchestrationSnapshot: OrchestrationSnapshotV1;
};

export async function compileWorkflowComposition(
  db: SouthstarDb,
  input: CompileWorkflowCompositionInput,
): Promise<CompiledWorkflowComposition> {
  const goalDomain = nonEmptyString(input.goalContract.domain)
    ?? nonEmptyString(input.goalDesignPackage?.goalContract.domain);
  const explicitScope = nonEmptyString(input.scope);
  const libraryScope = explicitScope ?? goalDomain ?? "all";
  const manifestDomain = nonEmptyString(input.manifestDomain)
    ?? explicitScope
    ?? goalDomain
    ?? domainForManifestFallback(libraryScope);
  const taskDomain = workflowTaskDomain(manifestDomain);
  const validation = await validateWorkflowCompositionPlan(db, input.candidatePacket, input.composition, {
    scope: libraryScope,
    goalContract: input.goalContract,
    goalDesignPackage: input.goalDesignPackage,
    targetRequirementIds: input.targetRequirementIds,
    runtimeBindingCapabilities: input.runtimeBindingCapabilities ?? runtimeBindingCapabilitiesFromEnv(),
  });
  if (!validation.ok) {
    throw new Error(`workflow composition failed validation: ${JSON.stringify(validation.issues)}`);
  }

  const { byAgentRef: rolesByAgentRef, byRoleId: resolvedRoles } = await resolveRuntimeRoles(db, input.composition);
  const { byProfileRef: profilesByRef, byProfileId: resolvedProfiles } = await resolveRuntimeProfiles(db, input.composition);
  const artifactContracts = mergeById(
    await resolveRuntimeArtifactContracts(db, input.composition),
    input.goalDesignPackage ? await compileGoalDesignArtifactContracts(db, input.goalDesignPackage) : [],
  );
  const evaluatorPipelines = mergeById(
    await resolveRuntimeEvaluatorPipelines(db, input.composition),
    input.goalDesignPackage ? await compileGoalDesignEvaluatorPipelines(db, input.goalDesignPackage) : [],
  );
  const planHash = contentHashForPayload(input.composition);
  const profileRuntimeRefs = [...resolvedProfiles.values()].flatMap((profile) => [
    ...(profile.agentRef ? [profile.agentRef] : []),
    ...profile.agentsMdRefs,
    ...profile.skillRefs,
    ...profile.mcpGrantRefs,
    ...(profile.vaultLeasePolicyRefs ?? []),
    ...profile.toolPolicy.allowedTools,
    ...profile.toolPolicy.deniedTools,
    ...profile.toolPolicy.requiresApprovalFor,
    profile.contextPolicyRef,
    profile.sessionPolicyRef,
    ...(profile.systemPromptRef ? [profile.systemPromptRef] : []),
  ]).filter(isLibraryBackedRef);
  const bindingVersionRefs = goalDesignBindingVersionRefs(input.goalDesignPackage);
  const selectedLibraryRefs = uniqueSorted([
    ...collectSelectedRefs(input.candidatePacket, input.composition, profileRuntimeRefs),
    ...bindingVersionRefs.map((pair) => pair.objectKey),
  ]);
  const selectedLibraryRefSet = new Set(selectedLibraryRefs);
  const profileLibraryRefs = profileRuntimeRefs.filter((ref) => selectedLibraryRefSet.has(ref));
  const libraryObjectVersionRefs = mergeLibraryObjectVersionRefs(
    collectSelectedObjectVersionRefs(input.candidatePacket, input.composition, profileLibraryRefs),
    bindingVersionRefs,
  );
  const libraryVersionRefs = [...new Set(libraryObjectVersionRefs.map((pair) => pair.versionRef))].sort();
  const selectedTemplateRef = input.composition.selectedWorkflowTemplateRef;
  let templateVersionId: string | undefined;
  if (selectedTemplateRef) {
    const selectedTemplate = await findLibraryObjectByKey(db, selectedTemplateRef);
    templateVersionId = required(
      selectedTemplate?.headVersionId,
      `missing immutable version for ${selectedTemplateRef}`,
    );
    const selectedTemplatePair = libraryObjectVersionRefs.find((pair) =>
      pair.objectKey === selectedTemplateRef
    );
    if (selectedTemplatePair?.versionRef !== templateVersionId) {
      throw new Error(`selected workflow template object-version pair does not match current head: ${templateVersionId}`);
    }
  }
  const taskDefinitions = input.composition.tasks.map((task): WorkflowTaskDefinition => {
    const role = required(rolesByAgentRef.get(task.agentDefinitionRef), `missing resolved role for ${task.agentDefinitionRef}`);
    const profile = required(
      profilesByRef.get(task.agentProfileRef),
      `missing resolved profile for ${task.agentProfileRef}`,
    );
    const execution = executionForTask(task, input.composition);
    const promptTemplateRef = normalizeInstructionRef(
      task.instructionRefs[0] ?? `instruction.${profile.promptTemplateRef}`,
    );
    const nodePromptSpec = nodePromptSpecForTask(input.goalPrompt, input.goalContract, task);
    return {
      id: task.id,
      name: task.name,
      domain: taskDomain,
      roleRef: role.id,
      agentProfileRef: profile.id,
      dependsOn: task.dependsOn,
      promptInputs: {
        goalPrompt: input.goalPrompt,
        responsibility: task.responsibility,
        sliceId: task.sliceId,
        requirementIds: task.requirementIds,
        instructionRefs: task.instructionRefs,
        nodePromptSpec,
        ...(task.workspaceMutation ? { workspaceMutation: task.workspaceMutation } : {}),
      },
      requiredArtifactRefs: task.outputArtifactRefs.map(normalizeArtifactRef),
      evaluatorPipelineRef: normalizeEvaluatorRef(task.evaluatorProfileRef),
      recoveryStrategyRefs: task.recoveryStrategyRefs,
      ...(task.contextPolicyRef ? { contextPolicyRef: task.contextPolicyRef } : {}),
      ...(task.workspacePolicyRef ? { workspacePolicyRef: task.workspacePolicyRef } : {}),
      ...(task.workspaceMutation ? { workspaceMutation: task.workspaceMutation } : {}),
      execution: {
        engine: execution.engine ?? "tork",
        image: execution.image,
        command: execution.command,
        env: execution.env,
        mounts: execution.mounts,
        timeoutSeconds: execution.timeoutSeconds,
        infraRetry: { maxAttempts: execution.infraRetry.maxAttempts },
      },
      rootSession: {
        validator: "schema-evaluator-v1",
        maxRepairAttempts: 2,
      },
      instructionRefs: task.instructionRefs,
      skillRefs: task.skillRefs,
      toolGrantRefs: task.toolGrantRefs,
      vaultLeasePolicyRefs: task.vaultLeasePolicyRefs,
      mcpGrantRefs: task.mcpGrantRefs,
      subagents: [
        {
          id: `${role.id}-${task.id}`,
          harnessId: profile.harnessRef,
          prompt: `${promptTemplateRef}: ${JSON.stringify({ goalPrompt: input.goalPrompt, responsibility: task.responsibility, nodePromptSpec })}`,
          requiredArtifacts: task.outputArtifactRefs.map(normalizeArtifactRef),
        },
      ],
    };
  });

  const workflow: SouthstarWorkflowManifest = {
    schemaVersion: "southstar.v2",
    workflowId: `wf-composed-${hash(input.runId).slice(0, 12)}`,
    title: input.composition.title,
    goalPrompt: input.goalPrompt,
    domain: manifestDomain,
    intent: input.candidatePacket.requirementSpec.workType === "bugfix" ? "fix_bug" : "implement_feature",
    workflowGeneration: {
      planId: `composition-${planHash.slice(0, 12)}`,
      generatorPolicyRef: "library-constrained-llm",
      orchestrationSnapshotId: `orch-${planHash.slice(0, 12)}`,
    },
    roles: [...resolvedRoles.values()],
    agentProfiles: [...resolvedProfiles.values()],
    artifactContracts,
    evaluatorPipelines,
    contextPolicies: defaultContextPolicies(),
    sessionPolicies: defaultSessionPolicies(),
    memoryPolicies: defaultMemoryPolicies(),
    workspacePolicies: defaultWorkspacePolicies(),
    stopConditions: defaultStopConditions(evaluatorPipelines),
    tasks: taskDefinitions,
    harnessDefinitions: buildHarnessDefinitions(taskDefinitions, manifestDomain),
    evaluators: [
      {
        id: "schema-evaluator-v1",
        kind: "schema",
        artifactTypes: [...new Set(taskDefinitions.flatMap((task) => task.requiredArtifactRefs ?? []))],
        requiredFields: ["summary"],
      },
    ],
    memoryPolicy: { retrievalLimit: 8, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    compiledFrom: selectedTemplateRef && templateVersionId
      ? {
          sourceKind: "workflow_template",
          templateDefinitionId: selectedTemplateRef,
          templateVersionId,
          compilerVersion: "library-constrained-compiler-v1",
          inputHash: planHash,
          libraryVersionRefs,
          libraryObjectVersionRefs,
        }
      : {
          sourceKind: "library_primitives",
          compilerVersion: "library-constrained-compiler-v1",
          inputHash: planHash,
          libraryVersionRefs,
          libraryObjectVersionRefs,
        },
  };
  const goalRequirementCoverage = buildGoalRequirementCoverage({
    goalContract: input.goalContract,
    composition: input.composition,
    goalDesignPackage: input.goalDesignPackage,
    targetRequirementIds: input.targetRequirementIds,
  });

  const acceptance = acceptWorkflowComposition({
    composition: input.composition,
    compositionValidation: validation,
    workflow,
  });
  if (!acceptance.ok) {
    throw new Error(`workflow manifest acceptance failed: ${JSON.stringify(acceptance.issues)}`);
  }

  return {
    workflow,
    goalRequirementCoverage,
    orchestrationSnapshot: {
      schemaVersion: "southstar.orchestration_snapshot.v1",
      draftId: input.runId,
      requirementSpec: requirementSpecFromGoalContract(input.goalContract),
      goalContractHash: goalContractHash(input.goalContract),
      candidatePacketHash: hash(JSON.stringify(input.candidatePacket)),
      candidateSummary: summarizeCandidates(input.candidatePacket),
      selectedCompositionPlan: input.composition,
      validation,
      compiler: {
        version: "library-constrained-compiler-v1",
        manifestHash: contentHashForPayload(workflow),
        selectedLibraryRefs,
        libraryVersionRefs,
        libraryObjectVersionRefs,
      },
    },
  };
}

function nodePromptSpecForTask(
  goalPrompt: string,
  goalContract: GoalContractV1,
  task: WorkflowCompositionTask,
): WorkflowNodePromptSpec {
  const linkedRequirements = goalContract.requirements.filter((requirement) => task.requirementIds.includes(requirement.id));
  if (task.nodePromptSpec) {
    return linkedRequirements.length === 0
      ? task.nodePromptSpec
      : {
          ...task.nodePromptSpec,
          requirements: linkedRequirements.map((requirement) => requirement.statement),
          acceptanceCriteria: linkedRequirements.flatMap((requirement) => requirement.acceptanceCriteria),
        };
  }
  const nodeType = classifyWorkflowCompositionTask(task);
  return {
    nodeType,
    goal: `${titleFromTask(task)}: ${task.responsibility}`,
    requirements: linkedRequirements.length > 0
      ? linkedRequirements.map((requirement) => requirement.statement)
      : [`Advance the workflow goal: ${goalPrompt}`],
    boundaries: ["Work only on this task's declared responsibility and artifacts."],
    nonGoals: ["Do not perform unrelated work outside this task."],
    deliverableDocuments: deliverableDocumentsForNodeType(nodeType),
    expectedOutputs: [...task.outputArtifactRefs],
    testCases: [],
    acceptanceCriteria: linkedRequirements.length > 0
      ? linkedRequirements.flatMap((requirement) => requirement.acceptanceCriteria)
      : task.outputArtifactRefs.length > 0
        ? task.outputArtifactRefs.map((artifactRef) => `Produce ${artifactRef} with clear evidence.`)
        : [`Complete ${task.id} and report evidence.`],
    ...(nodeType === "implement" ? { implementationScope: [task.responsibility] } : {}),
    ...(nodeType === "verify" ? { verificationChecks: ["Verify the declared task outputs and report evidence."] } : {}),
    ...(nodeType === "plan" ? { planningQuestions: ["What has to change to satisfy the goal?"], decisionCriteria: ["The plan is scoped, ordered, and testable."] } : {}),
    ...(nodeType === "review" ? { reviewChecklist: ["Check quality, risk, and missing evidence."], riskCriteria: ["Identify regressions or unverified behavior."] } : {}),
    ...(nodeType === "summary" ? { summarySections: ["completed work", "verification", "risks"], handoffCriteria: ["A downstream reader can understand final state and next steps."] } : {}),
    failureReportContract: "If blocked, return the blocker, evidence, and the next repair action.",
  };
}

function deliverableDocumentsForNodeType(nodeType: WorkflowNodePromptSpec["nodeType"]): WorkflowNodePromptSpec["deliverableDocuments"] {
  if (nodeType === "plan") {
    return [{ kind: "design", title: "Design or implementation plan", required: true, format: "markdown", description: "Describe scope, approach, risks, and ordered implementation steps." }];
  }
  if (nodeType === "implement") {
    return [
      { kind: "implementation", title: "Implementation notes", required: true, format: "markdown", description: "Summarize changed behavior, files touched, and important decisions." },
      { kind: "test", title: "Test evidence", required: true, format: "markdown", description: "List tests or checks run and their outcomes." },
    ];
  }
  if (nodeType === "verify") {
    return [{ kind: "verification", title: "Verification report", required: true, format: "markdown", description: "Record verification checks, results, failures, and evidence." }];
  }
  if (nodeType === "repair") {
    return [{ kind: "implementation", title: "Repair notes", required: true, format: "markdown", description: "Describe repaired defects, preserved behavior, and re-verification needs." }];
  }
  if (nodeType === "review") {
    return [{ kind: "acceptance", title: "Review and acceptance report", required: true, format: "markdown", description: "Assess quality, risk, and whether acceptance criteria are met." }];
  }
  if (nodeType === "summary") {
    return [{ kind: "summary", title: "Workflow summary", required: true, format: "markdown", description: "Summarize completed work, accepted artifacts, verification, and handoff notes." }];
  }
  return [];
}

function titleFromTask(task: WorkflowCompositionTask): string {
  return task.name || task.id
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

type ResolvedRuntimeRoles = {
  byAgentRef: Map<string, RoleDefinition>;
  byRoleId: Map<string, RoleDefinition>;
};

type ResolvedRuntimeProfiles = {
  byProfileRef: Map<string, AgentProfile>;
  byProfileId: Map<string, AgentProfile>;
};

async function resolveRuntimeRoles(db: SouthstarDb, plan: WorkflowCompositionPlan): Promise<ResolvedRuntimeRoles> {
  const byAgentRef = new Map<string, RoleDefinition>();
  const byRoleId = new Map<string, RoleDefinition>();
  for (const task of plan.tasks) {
    if (byAgentRef.has(task.agentDefinitionRef)) continue;
    const agent = await findLibraryObjectByKey(db, task.agentDefinitionRef);
    const agentState = required(agent?.state, `library object not found for ${task.agentDefinitionRef}`);
    const runtimeRole = agentState.runtimeRole === undefined
      ? synthesizeRuntimeRoleFromTask(task)
      : parseRuntimeRole(
        agentState.runtimeRole,
        `agent definition ${task.agentDefinitionRef} state.runtimeRole`,
      );
    byAgentRef.set(task.agentDefinitionRef, runtimeRole);
    byRoleId.set(runtimeRole.id, runtimeRole);
  }
  return { byAgentRef, byRoleId };
}

async function resolveRuntimeProfiles(db: SouthstarDb, plan: WorkflowCompositionPlan): Promise<ResolvedRuntimeProfiles> {
  const generatedProfileRefs = validatedGeneratedAgentProfiles(plan);
  const generatedProfileProposals = validatedGeneratedAgentProfileProposals(plan);
  const byProfileRef = new Map<string, AgentProfile>();
  const byProfileId = new Map<string, AgentProfile>();
  for (const task of plan.tasks) {
    if (byProfileRef.has(task.agentProfileRef)) continue;
    const profile = await findLibraryObjectByKey(db, task.agentProfileRef);
    const runtimeProfile = profile
      ? parseRuntimeProfile(
        profile.state.runtimeProfile,
        `agent profile ${task.agentProfileRef} state.runtimeProfile`,
      )
      : generatedProfileRefs.has(task.agentProfileRef)
        ? synthesizeGeneratedRuntimeProfile(
          task.agentProfileRef,
          plan.tasks.filter((candidate) => candidate.agentProfileRef === task.agentProfileRef),
          generatedProfileProposals.get(task.agentProfileRef)?.agentProfile,
        )
        : required<AgentProfile>(null, `library object not found for ${task.agentProfileRef}`);
    byProfileRef.set(task.agentProfileRef, runtimeProfile);
    byProfileId.set(runtimeProfile.id, runtimeProfile);
  }
  return { byProfileRef, byProfileId };
}

async function resolveRuntimeArtifactContracts(
  db: SouthstarDb,
  plan: WorkflowCompositionPlan,
): Promise<ArtifactContract[]> {
  const contracts = new Map<string, ArtifactContract>();
  for (const artifactRef of uniqueSorted(plan.tasks.flatMap((task) => [...task.inputArtifactRefs, ...task.outputArtifactRefs]))) {
    const object = await findLibraryObjectByKey(db, artifactRef);
    const state = object?.state ?? {};
    const contract: ArtifactContract = {
      id: normalizeArtifactRef(artifactRef),
      artifactType: optionalStringAt(state.artifactType) ?? normalizeArtifactRef(artifactRef),
      requiredFields: optionalStringArrayAt(state.requiredFields) ?? ["summary"],
      evidenceFields: optionalStringArrayAt(state.evidenceFields) ?? ["summary"],
    };
    contracts.set(contract.id, contract);
  }
  return [...contracts.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function resolveRuntimeEvaluatorPipelines(
  db: SouthstarDb,
  plan: WorkflowCompositionPlan,
): Promise<EvaluatorPipelineDefinition[]> {
  const pipelines = new Map<string, EvaluatorPipelineDefinition>();
  for (const evaluatorRef of uniqueSorted(plan.tasks.map((task) => task.evaluatorProfileRef))) {
    const object = await findLibraryObjectByKey(db, evaluatorRef);
    const state = object?.state ?? {};
    const pipeline: EvaluatorPipelineDefinition = {
      id: normalizeEvaluatorRef(evaluatorRef),
      evaluators: parseEvaluatorSteps(state.evaluators),
      onFailure: parseEvaluatorOnFailure(state.onFailure),
    };
    pipelines.set(pipeline.id, pipeline);
  }
  return [...pipelines.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function compileGoalDesignArtifactContracts(
  db: SouthstarDb,
  packageValue: GoalDesignPackage,
): Promise<ArtifactContract[]> {
  if (packageValue.schemaVersion === "southstar.goal_design_package.v2") {
    const contracts = new Map<string, ArtifactContract>();
    for (const binding of packageValue.validationBindings) {
      for (const [index, artifactRef] of binding.artifactContractRefs.entries()) {
        const versionRef = required(
          binding.artifactContractVersionRefs[index],
          `missing frozen artifact version for ${artifactRef}`,
        );
        const object = await requireApprovedPinnedLibraryObject(db, artifactRef, versionRef, "artifact_contract");
        const state = object.state;
        contracts.set(normalizeArtifactRef(artifactRef), {
          id: normalizeArtifactRef(artifactRef),
          artifactType: stringAt(state.artifactType, `${artifactRef}.artifactType`),
          requiredFields: stringArrayAt(state.requiredFields, `${artifactRef}.requiredFields`),
          evidenceFields: optionalStringArrayAt(state.evidenceFields) ?? [],
          mediaTypes: stringArrayAt(state.mediaTypes, `${artifactRef}.mediaTypes`),
          validationRules: stringArrayAt(state.validationRules, `${artifactRef}.validationRules`),
          evidenceKinds: stringArrayAt(state.evidenceKinds, `${artifactRef}.evidenceKinds`),
          schemaRef: stringAt(state.schemaRef, `${artifactRef}.schemaRef`),
          provenanceRequirements: stringArrayAt(state.provenanceRequirements, `${artifactRef}.provenanceRequirements`),
          libraryObjectRef: artifactRef,
          libraryVersionRef: versionRef,
        });
      }
    }
    return [...contracts.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
  const contracts = new Map<string, ArtifactContract>();
  for (const artifactRef of uniqueSorted(packageValue.slicePlan.slices.flatMap((slice) => slice.expectedArtifactRefs))) {
    const id = normalizeArtifactRef(artifactRef);
    contracts.set(id, {
      id,
      artifactType: artifactRef,
      requiredFields: ["summary"],
      evidenceFields: [
        "summary",
        "acceptanceCriteria",
        "requiredEvidenceKinds",
      ],
    });
  }
  return [...contracts.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function compileGoalDesignEvaluatorPipelines(
  db: SouthstarDb,
  packageValue: GoalDesignPackage,
): Promise<EvaluatorPipelineDefinition[]> {
  if (packageValue.schemaVersion === "southstar.goal_design_package.v2") {
    const pipelines = new Map<string, EvaluatorPipelineDefinition>();
    for (const binding of packageValue.validationBindings) {
      const object = await requireApprovedPinnedLibraryObject(
        db,
        binding.evaluatorProfileRef,
        binding.evaluatorProfileVersionRef,
        "evaluator_profile",
      );
      const state = object.state;
      const procedures = evaluatorProcedures(state.verificationProcedures, binding.evaluatorProfileRef);
      const acceptanceCriteriaById = new Map(
        binding.criterionIds.map((criterionId, index) => [criterionId, binding.acceptanceCriteria[index]]),
      );
      const pipelineId = normalizeEvaluatorRef(binding.evaluatorProfileRef);
      const existing = pipelines.get(pipelineId);
      const steps = binding.criterionChecks.map((check): EvaluatorStepDefinition => {
        const procedure = required(
          procedures.get(check.procedureRef),
          `missing frozen verification procedure ${check.procedureRef} in ${binding.evaluatorProfileRef}`,
        );
        if (procedure.checkKind !== binding.verificationMode) {
          throw new Error(`verification mode mismatch for ${check.procedureRef}: expected ${binding.verificationMode}, got ${procedure.checkKind}`);
        }
        for (const evidenceKind of check.expectedEvidenceKinds) {
          if (!procedure.allowedEvidenceKinds.includes(evidenceKind)) {
            throw new Error(`unsupported evidence kind ${evidenceKind} for ${check.procedureRef}`);
          }
        }
        return {
          id: `${pipelineId}-${normalizeRuntimeId(check.criterionId)}`,
          kind: evaluatorStepKind(binding.verificationMode),
          required: true,
          config: {
            validationBindingId: binding.id,
            requirementId: binding.requirementId,
            criterionId: check.criterionId,
            acceptanceCriterion: required(
              acceptanceCriteriaById.get(check.criterionId),
              `missing acceptance criterion for ${check.criterionId}`,
            ),
            procedureRef: check.procedureRef,
            instruction: procedure.instruction,
            verificationMode: binding.verificationMode,
            expectedEvidenceKinds: check.expectedEvidenceKinds,
            allowedEvidenceKinds: procedure.allowedEvidenceKinds,
            requiredInputs: stringArrayAt(state.requiredInputs, `${binding.evaluatorProfileRef}.requiredInputs`),
            resultSchemaRef: stringAt(state.resultSchemaRef, `${binding.evaluatorProfileRef}.resultSchemaRef`),
            independence: binding.independence,
            artifactContractRefs: binding.artifactContractRefs,
            artifactContractVersionRefs: binding.artifactContractVersionRefs,
            failureClassifications: binding.failureClassifications,
          },
        };
      });
      pipelines.set(pipelineId, {
        id: pipelineId,
        evaluators: [...(existing?.evaluators ?? []), ...steps],
        libraryObjectRef: binding.evaluatorProfileRef,
        libraryVersionRef: binding.evaluatorProfileVersionRef,
        resultSchemaRef: stringAt(state.resultSchemaRef, `${binding.evaluatorProfileRef}.resultSchemaRef`),
        artifactContractRefs: uniqueSorted([
          ...(existing?.artifactContractRefs ?? []),
          ...binding.artifactContractRefs.map(normalizeArtifactRef),
        ]),
        validationBindingIds: uniqueSorted([...(existing?.validationBindingIds ?? []), binding.id]),
        onFailure: { defaultStrategy: "request-workflow-revision" },
      });
    }
    return [...pipelines.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
  return packageValue.evaluatorContracts.map((contract): EvaluatorPipelineDefinition => ({
    id: normalizeEvaluatorRef(contract.id),
    evaluators: [{
      id: `${normalizeEvaluatorRef(contract.id)}-goal-design-contract`,
      kind: "evidence",
      required: true,
      config: {
        requirementId: contract.requirementId,
        acceptanceCriteria: contract.acceptanceCriteria,
        requiredEvidenceKinds: contract.requiredEvidenceKinds,
        independence: contract.independence,
        failureClassifications: contract.failureClassifications,
      },
    }],
    onFailure: { defaultStrategy: "request-workflow-revision" },
  })).sort((left, right) => left.id.localeCompare(right.id));
}

async function requireApprovedPinnedLibraryObject(
  db: SouthstarDb,
  objectKey: string,
  versionRef: string,
  objectKind: "artifact_contract" | "evaluator_profile",
) {
  const object = await findLibraryObjectByKey(db, objectKey);
  if (!object) throw new Error(`missing frozen Library object: ${objectKey}`);
  if (object.objectKind !== objectKind) {
    throw new Error(`frozen Library object kind mismatch for ${objectKey}: expected ${objectKind}, got ${object.objectKind}`);
  }
  if (object.status !== "approved") throw new Error(`frozen Library object is not approved: ${objectKey}`);
  if (object.headVersionId !== versionRef) {
    throw new Error(`frozen Library version mismatch for ${objectKey}: expected ${versionRef}, got ${object.headVersionId ?? "missing"}`);
  }
  return object;
}

function evaluatorProcedures(value: unknown, evaluatorRef: string): Map<string, {
  checkKind: string;
  instruction: string;
  allowedEvidenceKinds: string[];
}> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`missing executable verification procedures for ${evaluatorRef}`);
  }
  const result = new Map<string, { checkKind: string; instruction: string; allowedEvidenceKinds: string[] }>();
  for (const [index, raw] of value.entries()) {
    const procedure = required(isRecord(raw) ? raw : null, `invalid verification procedure ${evaluatorRef}.${index}`);
    const id = stringAt(procedure.id, `${evaluatorRef}.verificationProcedures.${index}.id`);
    if (result.has(id)) throw new Error(`duplicate verification procedure ${id} in ${evaluatorRef}`);
    result.set(id, {
      checkKind: stringAt(procedure.checkKind, `${evaluatorRef}.verificationProcedures.${index}.checkKind`),
      instruction: stringAt(procedure.instruction, `${evaluatorRef}.verificationProcedures.${index}.instruction`),
      allowedEvidenceKinds: stringArrayAt(procedure.allowedEvidenceKinds, `${evaluatorRef}.verificationProcedures.${index}.allowedEvidenceKinds`),
    });
  }
  return result;
}

function evaluatorStepKind(mode: string): EvaluatorStepDefinition["kind"] {
  if (mode === "deterministic") return "test";
  if (mode === "semantic_review") return "domain";
  if (mode === "human_approval") return "policy";
  return "checker-agent";
}

function mergeById<T extends { id: string }>(fallback: T[], preferred: T[]): T[] {
  const valuesById = new Map<string, T>();
  for (const value of fallback) valuesById.set(value.id, value);
  for (const value of preferred) valuesById.set(value.id, value);
  return [...valuesById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function goalDesignBindingVersionRefs(packageValue: GoalDesignPackage | undefined): LibraryObjectVersionRef[] {
  if (packageValue?.schemaVersion !== "southstar.goal_design_package.v2") return [];
  const pairs: LibraryObjectVersionRef[] = [];
  for (const binding of packageValue.validationBindings) {
    pairs.push({ objectKey: binding.evaluatorProfileRef, versionRef: binding.evaluatorProfileVersionRef });
    for (const [index, objectKey] of binding.artifactContractRefs.entries()) {
      pairs.push({
        objectKey,
        versionRef: required(binding.artifactContractVersionRefs[index], `missing frozen artifact version for ${objectKey}`),
      });
    }
  }
  return mergeLibraryObjectVersionRefs([], pairs);
}

function mergeLibraryObjectVersionRefs(
  base: LibraryObjectVersionRef[],
  frozen: LibraryObjectVersionRef[],
): LibraryObjectVersionRef[] {
  const versions = new Map(base.map((pair) => [pair.objectKey, pair.versionRef]));
  for (const pair of frozen) {
    const current = versions.get(pair.objectKey);
    if (current && current !== pair.versionRef) {
      throw new Error(`conflicting immutable Library versions for ${pair.objectKey}: ${current} and ${pair.versionRef}`);
    }
    versions.set(pair.objectKey, pair.versionRef);
  }
  return [...versions.entries()]
    .map(([objectKey, versionRef]) => ({ objectKey, versionRef }))
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
}

function defaultContextPolicies(): ContextPolicyDefinition[] {
  return [{
    id: "context.generated",
    maxInputTokens: 120_000,
    memoryPolicyRef: "memory.generated",
    includeAgentsMd: true,
    includeWorkspaceSummary: true,
  }];
}

function defaultSessionPolicies(): SessionPolicyDefinition[] {
  return [{
    id: "session.generated",
    checkpointOn: ["task-start", "artifact-accepted", "before-recovery"],
    allowFork: true,
    allowReset: true,
    allowRollback: true,
  }];
}

function defaultMemoryPolicies(): MemoryPolicyDefinition[] {
  return [{
    id: "memory.generated",
    providerRef: "postgres",
    scopes: [],
    maxInjectedTokens: 1_500,
    maxCandidates: 8,
    requireWriteApproval: true,
    allowedKinds: [
      "preference",
      "architecture_decision",
      "domain_pattern",
      "failure_lesson",
      "artifact_summary",
      "workflow_learning",
    ],
    ranking: {
      relevanceWeight: 0.5,
      recencyWeight: 0.2,
      successWeight: 0.2,
      confidenceWeight: 0.1,
    },
    compression: {
      strategy: "extractive",
      maxTokensPerMemory: 500,
    },
  }];
}

function defaultWorkspacePolicies(): WorkspacePolicyDefinition[] {
  return [{
    id: "workspace.generated",
    provider: "git",
    snapshotAtTaskStart: true,
    snapshotAtAcceptedArtifact: true,
    forkOnCheckerReject: false,
    rollbackOnTestFailure: false,
  }];
}

function defaultStopConditions(evaluatorPipelines: EvaluatorPipelineDefinition[]): StopConditionDefinition[] {
  return [{
    id: "stop.generated",
    type: "artifact-accepted",
    evaluatorRefs: evaluatorPipelines.map((pipeline) => pipeline.id),
  }];
}

function optionalStringAt(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringArrayAt(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function parseEvaluatorSteps(value: unknown): EvaluatorStepDefinition[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((record, index): EvaluatorStepDefinition => {
      const kind = optionalStringAt(record.kind) ?? "schema";
      return {
        id: optionalStringAt(record.id) ?? `evaluator-${index + 1}`,
        kind: isEvaluatorStepKind(kind) ? kind : "schema",
        config: isRecord(record.config) ? record.config : {},
        required: typeof record.required === "boolean" ? record.required : true,
      };
    });
}

function parseEvaluatorOnFailure(value: unknown): EvaluatorPipelineDefinition["onFailure"] {
  const record = isRecord(value) ? value : {};
  const strategy = optionalStringAt(record.defaultStrategy);
  if (isEvaluatorFailureStrategy(strategy)) {
    return { defaultStrategy: strategy };
  }
  return { defaultStrategy: "ask-human" };
}

function validatedGeneratedAgentProfiles(plan: WorkflowCompositionPlan): Set<string> {
  return new Set(
    plan.generatedComponentProposals
      .filter((proposal) => proposal.kind === "agent_profile" && proposal.validationStatus === "validated")
      .map((proposal) => proposal.id),
  );
}

function validatedGeneratedAgentProfileProposals(plan: WorkflowCompositionPlan): Map<string, GeneratedComponentProposal> {
  return new Map(
    plan.generatedComponentProposals
      .filter((proposal) => proposal.kind === "agent_profile" && proposal.validationStatus === "validated")
      .map((proposal) => [proposal.id, proposal]),
  );
}

function synthesizeGeneratedRuntimeProfile(
  profileRef: string,
  tasks: WorkflowCompositionTask[],
  agentProfile: GeneratedAgentProfile | undefined,
): AgentProfile {
  const firstTask = required(tasks[0], `missing task for generated profile ${profileRef}`);
  const selectedProfile = required(agentProfile, `generated profile proposal is missing agentProfile: ${profileRef}`);
  const provider = required(selectedProfile.provider, `generated profile provider is missing: ${profileRef}`);
  const harnessRef = required(selectedProfile.harnessRef, `generated profile harnessRef is missing: ${profileRef}`);
  const toolPolicy = required(selectedProfile.toolPolicy, `generated profile toolPolicy is missing: ${profileRef}`);
  const budgetPolicy = required(selectedProfile.budgetPolicy, `generated profile budgetPolicy is missing: ${profileRef}`);
  return {
    id: profileRef,
    name: titleFromRef(profileRef),
    agentRef: firstTask.agentDefinitionRef,
    ...(selectedProfile.workerKind ? { workerKind: selectedProfile.workerKind } : {}),
    provider,
    model: required(selectedProfile.model, `generated profile model is missing: ${profileRef}`),
    ...(selectedProfile.thinkingLevel ? { thinkingLevel: selectedProfile.thinkingLevel } : {}),
    ...(selectedProfile.instruction ? { instruction: selectedProfile.instruction } : {}),
    harnessRef,
    agentsMdRefs: uniqueSorted([
      firstTask.agentDefinitionRef,
      ...required(selectedProfile.agentsMdRefs, `generated profile agentsMdRefs is missing: ${profileRef}`),
    ]),
    promptTemplateRef: required(selectedProfile.promptTemplateRef, `generated profile promptTemplateRef is missing: ${profileRef}`),
    skillRefs: uniqueSorted(tasks.flatMap((task) => task.skillRefs)),
    mcpGrantRefs: uniqueSorted(tasks.flatMap((task) => task.mcpGrantRefs)),
    vaultLeasePolicyRefs: uniqueSorted(tasks.flatMap((task) => task.vaultLeasePolicyRefs)),
    memoryScopes: required(selectedProfile.memoryScopes, `generated profile memoryScopes is missing: ${profileRef}`),
    contextPolicyRef: required(selectedProfile.contextPolicyRef, `generated profile contextPolicyRef is missing: ${profileRef}`),
    sessionPolicyRef: required(selectedProfile.sessionPolicyRef, `generated profile sessionPolicyRef is missing: ${profileRef}`),
    toolPolicy: {
      allowedTools: required(toolPolicy.allowedTools, `generated profile allowedTools is missing: ${profileRef}`),
      deniedTools: required(toolPolicy.deniedTools, `generated profile deniedTools is missing: ${profileRef}`),
      requiresApprovalFor: required(toolPolicy.requiresApprovalFor, `generated profile requiresApprovalFor is missing: ${profileRef}`),
    },
    budgetPolicy: {
      maxInputTokens: required(budgetPolicy.maxInputTokens, `generated profile maxInputTokens is missing: ${profileRef}`),
      maxOutputTokens: required(budgetPolicy.maxOutputTokens, `generated profile maxOutputTokens is missing: ${profileRef}`),
      ...(budgetPolicy.maxCostMicrosUsd !== undefined ? { maxCostMicrosUsd: budgetPolicy.maxCostMicrosUsd } : {}),
      maxWallTimeSeconds: required(budgetPolicy.maxWallTimeSeconds, `generated profile maxWallTimeSeconds is missing: ${profileRef}`),
    },
  };
}

function executionForTask(task: WorkflowCompositionTask, plan: WorkflowCompositionPlan): TaskExecutionSpec {
  const proposal = plan.generatedComponentProposals.find((candidate) =>
    candidate.id === task.agentProfileRef && candidate.kind === "agent_profile" && candidate.validationStatus === "validated"
  );
  const execution = proposal?.agentProfile?.execution;
  if (!execution) {
    throw new Error(`selected generated agent profile is missing validated execution profile: ${task.agentProfileRef}`);
  }
  return {
    engine: required(execution.engine, `missing execution engine for ${task.agentProfileRef}`),
    image: required(execution.image, `missing execution image for ${task.agentProfileRef}`),
    command: required(execution.command, `missing execution command for ${task.agentProfileRef}`),
    env: required(execution.env, `missing execution env for ${task.agentProfileRef}`),
    mounts: required(execution.mounts, `missing execution mounts for ${task.agentProfileRef}`).map((mount) => ({
      source: required(mount.source, `missing execution mount source for ${task.agentProfileRef}`),
      target: required(mount.target, `missing execution mount target for ${task.agentProfileRef}`),
      readonly: mount.readonly ?? false,
    })),
    timeoutSeconds: required(execution.timeoutSeconds, `missing execution timeoutSeconds for ${task.agentProfileRef}`),
    infraRetry: { maxAttempts: required(execution.infraRetry?.maxAttempts, `missing execution infraRetry.maxAttempts for ${task.agentProfileRef}`) },
  };
}

function buildHarnessDefinitions(
  tasks: WorkflowTaskDefinition[],
  capability: string,
): SouthstarWorkflowManifest["harnessDefinitions"] {
  const definitions = new Map<string, SouthstarWorkflowManifest["harnessDefinitions"][number]>();
  for (const task of tasks) {
    for (const subagent of task.subagents) {
      if (definitions.has(subagent.harnessId)) continue;
      definitions.set(subagent.harnessId, {
        id: subagent.harnessId,
        kind: harnessKindForRef(subagent.harnessId),
        entrypoint: required(task.execution.command[0], `missing execution entrypoint for harness ${subagent.harnessId}`),
        image: task.execution.image,
        capabilities: [capability],
        inputProtocol: "task-envelope-v2",
        eventProtocol: "southstar-events-v1",
        supportsCheckpoint: true,
        supportsSteering: true,
        supportsProgress: true,
      });
    }
  }
  return [...definitions.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function harnessKindForRef(ref: string): SouthstarWorkflowManifest["harnessDefinitions"][number]["kind"] {
  if (ref === "pi") return "pi-agent";
  if (ref === "codex") return "codex";
  if (ref === "claude-code") return "claude-code";
  return "custom";
}

function workflowTaskDomain(value: string): WorkflowTaskDefinition["domain"] {
  return value === "software" || value === "research" || value === "data-analysis" || value === "general"
    ? value
    : "general";
}

function domainForManifestFallback(scope: string): string {
  return scope === "all" ? "general" : scope;
}

function synthesizeRuntimeRoleFromTask(task: WorkflowCompositionTask): RoleDefinition {
  return {
    id: roleIdFromAgentRef(task.agentDefinitionRef),
    responsibility: task.responsibility,
    defaultAgentProfileRef: task.agentProfileRef,
    allowedAgentProfileRefs: [task.agentProfileRef],
    artifactInputs: task.inputArtifactRefs.map(normalizeArtifactRef),
    artifactOutputs: task.outputArtifactRefs.map(normalizeArtifactRef),
    stopAuthority: "can-suggest",
  };
}

function parseRuntimeRole(value: unknown, path: string): RoleDefinition {
  const record = required(isRecord(value) ? value : null, `invalid runtime role at ${path}`);
  const stopAuthority = stringAt(record.stopAuthority, `${path}.stopAuthority`);
  if (!isStopAuthority(stopAuthority)) {
    throw new Error(`invalid runtime role stopAuthority at ${path}.stopAuthority`);
  }
  return {
    id: stringAt(record.id, `${path}.id`),
    responsibility: stringAt(record.responsibility, `${path}.responsibility`),
    defaultAgentProfileRef: stringAt(record.defaultAgentProfileRef, `${path}.defaultAgentProfileRef`),
    allowedAgentProfileRefs: stringArrayAt(record.allowedAgentProfileRefs, `${path}.allowedAgentProfileRefs`),
    artifactInputs: stringArrayAt(record.artifactInputs, `${path}.artifactInputs`),
    artifactOutputs: stringArrayAt(record.artifactOutputs, `${path}.artifactOutputs`),
    stopAuthority,
  };
}

function parseRuntimeProfile(value: unknown, path: string): AgentProfile {
  const record = required(isRecord(value) ? value : null, `invalid runtime profile at ${path}`);
  const provider = stringAt(record.provider, `${path}.provider`);
  if (!isProvider(provider)) {
    throw new Error(`invalid runtime profile provider at ${path}.provider`);
  }
  return {
    id: stringAt(record.id, `${path}.id`),
    name: stringAt(record.name, `${path}.name`),
    ...(record.agentRef !== undefined ? { agentRef: stringAt(record.agentRef, `${path}.agentRef`) } : {}),
    ...(record.workerKind !== undefined ? { workerKind: workerKindAt(record.workerKind, `${path}.workerKind`) } : {}),
    provider,
    ...(record.model !== undefined ? { model: stringAt(record.model, `${path}.model`) } : {}),
    harnessRef: stringAt(record.harnessRef, `${path}.harnessRef`),
    agentsMdRefs: stringArrayAt(record.agentsMdRefs, `${path}.agentsMdRefs`),
    promptTemplateRef: stringAt(record.promptTemplateRef, `${path}.promptTemplateRef`),
    skillRefs: stringArrayAt(record.skillRefs, `${path}.skillRefs`),
    mcpGrantRefs: stringArrayAt(record.mcpGrantRefs, `${path}.mcpGrantRefs`),
    memoryScopes: stringArrayAt(record.memoryScopes, `${path}.memoryScopes`),
    contextPolicyRef: stringAt(record.contextPolicyRef, `${path}.contextPolicyRef`),
    sessionPolicyRef: stringAt(record.sessionPolicyRef, `${path}.sessionPolicyRef`),
    toolPolicy: parseToolPolicy(record.toolPolicy, `${path}.toolPolicy`),
    budgetPolicy: parseBudgetPolicy(record.budgetPolicy, `${path}.budgetPolicy`),
  };
}

function parseToolPolicy(value: unknown, path: string): AgentProfile["toolPolicy"] {
  const record = required(isRecord(value) ? value : null, `invalid tool policy at ${path}`);
  return {
    allowedTools: stringArrayAt(record.allowedTools, `${path}.allowedTools`),
    deniedTools: stringArrayAt(record.deniedTools, `${path}.deniedTools`),
    requiresApprovalFor: stringArrayAt(record.requiresApprovalFor, `${path}.requiresApprovalFor`),
  };
}

function parseBudgetPolicy(value: unknown, path: string): AgentProfile["budgetPolicy"] {
  const record = required(isRecord(value) ? value : null, `invalid budget policy at ${path}`);
  return {
    maxInputTokens: numberAt(record.maxInputTokens, `${path}.maxInputTokens`),
    maxOutputTokens: numberAt(record.maxOutputTokens, `${path}.maxOutputTokens`),
    maxCostMicrosUsd: optionalNumberAt(record.maxCostMicrosUsd, `${path}.maxCostMicrosUsd`),
    maxWallTimeSeconds: optionalNumberAt(record.maxWallTimeSeconds, `${path}.maxWallTimeSeconds`),
  };
}

function workerKindAt(value: unknown, path: string): NonNullable<AgentProfile["workerKind"]> {
  const workerKind = stringAt(value, path);
  if (!["execution_worker", "validation_worker", "repair_worker", "review_worker"].includes(workerKind)) {
    throw new Error(`invalid runtime profile workerKind at ${path}`);
  }
  return workerKind as NonNullable<AgentProfile["workerKind"]>;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expected string at ${path}`);
  }
  return value;
}

function stringArrayAt(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected string array at ${path}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") {
      throw new Error(`expected string at ${path}[${index}]`);
    }
  }
  return [...value];
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`expected number at ${path}`);
  }
  return value;
}

function optionalNumberAt(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return numberAt(value, path);
}

function isStopAuthority(value: string): value is RoleDefinition["stopAuthority"] {
  return value === "none" || value === "can-suggest" || value === "can-accept" || value === "can-reject";
}

function isProvider(value: string): value is AgentProfile["provider"] {
  return value === "pi" ||
    value === "codex" ||
    value === "claude-code" ||
    value === "openai" ||
    value === "openai-codex" ||
    value === "github-copilot" ||
    value === "anthropic" ||
    value === "custom";
}

function isEvaluatorStepKind(value: string): value is EvaluatorStepDefinition["kind"] {
  return value === "schema" ||
    value === "domain" ||
    value === "test" ||
    value === "evidence" ||
    value === "checker-agent" ||
    value === "policy";
}

function isEvaluatorFailureStrategy(value: string | undefined): value is EvaluatorPipelineDefinition["onFailure"]["defaultStrategy"] {
  return value === "retry-same-agent" ||
    value === "fork-from-checkpoint" ||
    value === "rollback-workspace" ||
    value === "request-workflow-revision" ||
    value === "ask-human";
}

function normalizeInstructionRef(instructionRef: string): string {
  return instructionRef.replace(/^instruction\./, "");
}

function normalizeArtifactRef(artifactRef: string): string {
  return artifactRef.replace(/^artifact\./, "");
}

function normalizeEvaluatorRef(evaluatorRef: string): string {
  return evaluatorRef.replace(/^evaluator\./, "");
}

function normalizeRuntimeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-") || "criterion";
}

function roleIdFromAgentRef(agentRef: string): string {
  return agentRef.replace(/^agent\./, "").replace(/[^a-zA-Z0-9_-]+/g, "-") || "generated-agent";
}

function titleFromRef(ref: string): string {
  const lastSegment = ref.split(".").at(-1) ?? ref;
  return lastSegment
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ") || ref;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
