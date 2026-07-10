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
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import {
  collectSelectedVersionRefs,
  summarizeCandidates,
  type CandidateSelectionSummary,
} from "./composition-selection-summary.ts";
import { validateWorkflowCompositionPlan } from "./composition-validator.ts";

export type CompileWorkflowCompositionInput = {
  runId: string;
  goalPrompt: string;
  candidatePacket: CandidatePacket;
  composition: WorkflowCompositionPlan;
  scope?: string;
  manifestDomain?: string;
};

export type OrchestrationSnapshotV1 = {
  schemaVersion: "southstar.orchestration_snapshot.v1";
  draftId: string;
  requirementSpec: CandidatePacket["requirementSpec"];
  candidatePacketHash: string;
  candidateSummary: CandidateSelectionSummary;
  selectedCompositionPlan: WorkflowCompositionPlan;
  validation: WorkflowCompositionValidationResult;
  compiler: {
    version: "library-constrained-compiler-v1";
    manifestHash: string;
    libraryVersionRefs: string[];
  };
};

export type CompiledWorkflowComposition = {
  workflow: SouthstarWorkflowManifest;
  orchestrationSnapshot: OrchestrationSnapshotV1;
};

export async function compileWorkflowComposition(
  db: SouthstarDb,
  input: CompileWorkflowCompositionInput,
): Promise<CompiledWorkflowComposition> {
  const libraryScope = input.scope ?? "software";
  const manifestDomain = input.manifestDomain ?? (libraryScope === "all" ? "software" : libraryScope);
  const validation = await validateWorkflowCompositionPlan(db, input.candidatePacket, input.composition, { scope: libraryScope });
  if (!validation.ok) {
    throw new Error(`workflow composition failed validation: ${JSON.stringify(validation.issues)}`);
  }

  const { byAgentRef: rolesByAgentRef, byRoleId: resolvedRoles } = await resolveRuntimeRoles(db, input.composition);
  const { byProfileRef: profilesByRef, byProfileId: resolvedProfiles } = await resolveRuntimeProfiles(db, input.composition);
  const artifactContracts = await resolveRuntimeArtifactContracts(db, input.composition);
  const evaluatorPipelines = await resolveRuntimeEvaluatorPipelines(db, input.composition);
  const planHash = hash(JSON.stringify(input.composition));
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
    const nodePromptSpec = nodePromptSpecForTask(input.goalPrompt, task);
    return {
      id: task.id,
      name: task.name,
      domain: manifestDomain,
      roleRef: role.id,
      agentProfileRef: profile.id,
      dependsOn: task.dependsOn,
      promptInputs: {
        goalPrompt: input.goalPrompt,
        responsibility: task.responsibility,
        instructionRefs: task.instructionRefs,
        nodePromptSpec,
      },
      requiredArtifactRefs: task.outputArtifactRefs.map(normalizeArtifactRef),
      evaluatorPipelineRef: normalizeEvaluatorRef(task.evaluatorProfileRef),
      recoveryStrategyRefs: task.recoveryStrategyRefs,
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
    harnessDefinitions: [
      {
        id: "pi",
        kind: "pi-agent",
        entrypoint: "southstar-agent-runner",
        image: "southstar/pi-agent:local",
        capabilities: [manifestDomain],
        inputProtocol: "task-envelope-v2",
        eventProtocol: "southstar-events-v1",
        supportsCheckpoint: true,
        supportsSteering: true,
        supportsProgress: true,
      },
      {
        id: "codex",
        kind: "codex",
        entrypoint: "southstar-agent-runner",
        image: "southstar/pi-agent:local",
        capabilities: [manifestDomain],
        inputProtocol: "task-envelope-v2",
        eventProtocol: "southstar-events-v1",
        supportsCheckpoint: true,
        supportsSteering: true,
        supportsProgress: true,
      },
    ],
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
  };

  return {
    workflow,
    orchestrationSnapshot: {
      schemaVersion: "southstar.orchestration_snapshot.v1",
      draftId: input.runId,
      requirementSpec: input.candidatePacket.requirementSpec,
      candidatePacketHash: hash(JSON.stringify(input.candidatePacket)),
      candidateSummary: summarizeCandidates(input.candidatePacket),
      selectedCompositionPlan: input.composition,
      validation,
      compiler: {
        version: "library-constrained-compiler-v1",
        manifestHash: hash(JSON.stringify(workflow)),
        libraryVersionRefs: collectSelectedVersionRefs(input.candidatePacket, input.composition),
      },
    },
  };
}

function nodePromptSpecForTask(goalPrompt: string, task: WorkflowCompositionTask): WorkflowNodePromptSpec {
  if (task.nodePromptSpec) return task.nodePromptSpec;
  const nodeType = inferNodePromptType(task);
  return {
    nodeType,
    goal: `${titleFromTask(task)}: ${task.responsibility}`,
    requirements: [`Advance the workflow goal: ${goalPrompt}`],
    boundaries: ["Work only on this task's declared responsibility and artifacts."],
    nonGoals: ["Do not perform unrelated work outside this task."],
    deliverableDocuments: deliverableDocumentsForNodeType(nodeType),
    expectedOutputs: [...task.outputArtifactRefs],
    testCases: [],
    acceptanceCriteria: task.outputArtifactRefs.length > 0
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

function inferNodePromptType(task: WorkflowCompositionTask): WorkflowNodePromptSpec["nodeType"] {
  const haystack = `${task.id} ${task.name} ${task.responsibility} ${task.evaluatorProfileRef}`.toLowerCase();
  if (/\b(repair|fix)\b/.test(haystack)) return "repair";
  if (/\b(verify|test|check|validation)\b/.test(haystack)) return "verify";
  if (/\b(review|quality|risk)\b/.test(haystack)) return "review";
  if (/\b(summary|summarize|completion|handoff)\b/.test(haystack)) return "summary";
  if (/\b(plan|spec|understand|inspect|explore)\b/.test(haystack)) return "plan";
  if (/\b(implement|build|code|create)\b/.test(haystack)) return "implement";
  return "general";
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
  const provider = agentProfile?.provider ?? "codex";
  const harnessRef = agentProfile?.harnessRef ?? (provider === "pi" ? "pi" : "codex");
  const toolPolicy = agentProfile?.toolPolicy ?? {};
  const budgetPolicy = agentProfile?.budgetPolicy ?? {};
  return {
    id: profileRef,
    name: titleFromRef(profileRef),
    agentRef: firstTask.agentDefinitionRef,
    ...(agentProfile?.workerKind ? { workerKind: agentProfile.workerKind } : {}),
    provider,
    model: agentProfile?.model ?? "gpt-5",
    ...(agentProfile?.thinkingLevel ? { thinkingLevel: agentProfile.thinkingLevel } : {}),
    ...(agentProfile?.instruction ? { instruction: agentProfile.instruction } : {}),
    harnessRef,
    agentsMdRefs: uniqueSorted([firstTask.agentDefinitionRef, ...(agentProfile?.agentsMdRefs ?? [])]),
    promptTemplateRef: agentProfile?.promptTemplateRef ?? normalizeInstructionRef(firstTask.instructionRefs[0] ?? profileRef),
    skillRefs: uniqueSorted(tasks.flatMap((task) => task.skillRefs)),
    mcpGrantRefs: uniqueSorted(tasks.flatMap((task) => task.mcpGrantRefs)),
    vaultLeasePolicyRefs: uniqueSorted(tasks.flatMap((task) => task.vaultLeasePolicyRefs)),
    memoryScopes: agentProfile?.memoryScopes ?? [],
    contextPolicyRef: agentProfile?.contextPolicyRef ?? firstTask.contextPolicyRef ?? "context.generated",
    sessionPolicyRef: agentProfile?.sessionPolicyRef ?? "session.generated",
    toolPolicy: {
      allowedTools: toolPolicy.allowedTools ?? uniqueSorted(tasks.flatMap((task) => task.toolGrantRefs)),
      deniedTools: toolPolicy.deniedTools ?? [],
      requiresApprovalFor: toolPolicy.requiresApprovalFor ?? [],
    },
    budgetPolicy: {
      maxInputTokens: budgetPolicy.maxInputTokens ?? 120_000,
      maxOutputTokens: budgetPolicy.maxOutputTokens ?? 8_192,
      ...(budgetPolicy.maxCostMicrosUsd !== undefined ? { maxCostMicrosUsd: budgetPolicy.maxCostMicrosUsd } : {}),
      ...(budgetPolicy.maxWallTimeSeconds !== undefined ? { maxWallTimeSeconds: budgetPolicy.maxWallTimeSeconds } : {}),
    },
  };
}

function executionForTask(task: WorkflowCompositionTask, plan: WorkflowCompositionPlan): Required<NonNullable<GeneratedAgentProfile["execution"]>> {
  const proposal = plan.generatedComponentProposals.find((candidate) =>
    candidate.id === task.agentProfileRef && candidate.kind === "agent_profile" && candidate.validationStatus === "validated"
  );
  const execution = proposal?.agentProfile?.execution;
  if (!execution) {
    throw new Error(`selected generated agent profile is missing validated execution profile: ${task.agentProfileRef}`);
  }
  return {
    engine: execution.engine ?? "tork",
    image: required(execution.image, `missing execution image for ${task.agentProfileRef}`),
    command: required(execution.command, `missing execution command for ${task.agentProfileRef}`),
    env: execution.env ?? {},
    mounts: execution.mounts?.map((mount) => ({
      source: required(mount.source, `missing execution mount source for ${task.agentProfileRef}`),
      target: required(mount.target, `missing execution mount target for ${task.agentProfileRef}`),
      readonly: mount.readonly ?? false,
    })) ?? [],
    timeoutSeconds: execution.timeoutSeconds ?? 900,
    infraRetry: { maxAttempts: execution.infraRetry?.maxAttempts ?? 1 },
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
