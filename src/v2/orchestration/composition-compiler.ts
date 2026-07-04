import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type {
  CandidatePacket,
  GeneratedAgentProfile,
  GeneratedComponentProposal,
  WorkflowCompositionPlan,
  WorkflowCompositionTask,
  WorkflowCompositionValidationResult,
} from "../design-library/types.ts";
import { findLibraryObjectByKey } from "../design-library/library-graph-store.ts";
import type { AgentProfile, RoleDefinition } from "../domain-packs/types.ts";
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
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
  candidateSummary: {
    workflowTemplateRefs: string[];
    agentDefinitionRefs: string[];
    agentProfileRefs: string[];
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    artifactContractRefs: string[];
    evaluatorProfileRefs: string[];
    policyRefs: string[];
  };
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
          prompt: `${promptTemplateRef}: ${JSON.stringify({ goalPrompt: input.goalPrompt, responsibility: task.responsibility })}`,
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

function summarizeCandidates(packet: CandidatePacket): OrchestrationSnapshotV1["candidateSummary"] {
  return {
    workflowTemplateRefs: uniqueSorted([
      ...packet.workflowTemplateCandidates.map((candidate) => candidate.ref),
      ...graphRefsByKind(packet, "workflow_template"),
    ]),
    agentDefinitionRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.agentCandidatesByCapability),
      ...graphRefsByKind(packet, "agent_definition"),
    ]),
    agentProfileRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.profileCandidatesByAgent),
    ]),
    skillRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.skillCandidatesByProfile),
      ...graphRefsByKind(packet, "skill_spec"),
    ]),
    toolGrantRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.toolCandidatesByProfile),
      ...graphRefsByKind(packet, "tool_definition"),
    ]),
    mcpGrantRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.mcpGrantCandidatesByProfile),
      ...graphRefsByKind(packet, "mcp_tool_grant"),
    ]),
    artifactContractRefs: uniqueSorted([
      ...packet.artifactContractCandidates.map((candidate) => candidate.ref),
      ...graphRefsByKind(packet, "artifact_contract"),
    ]),
    evaluatorProfileRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.evaluatorCandidatesByArtifact),
      ...graphRefsByKind(packet, "evaluator_profile"),
    ]),
    policyRefs: uniqueSorted([
      ...packet.policyConstraints.map((candidate) => candidate.ref),
      ...graphRefsByKind(packet, "policy_bundle"),
    ]),
  };
}

function collectSelectedVersionRefs(packet: CandidatePacket, composition: WorkflowCompositionPlan): string[] {
  const versionRefsByRef = new Map<string, string>();
  for (const candidate of [
    ...packet.workflowTemplateCandidates,
    ...Object.values(packet.agentCandidatesByCapability).flat(),
    ...Object.values(packet.profileCandidatesByAgent).flat(),
    ...Object.values(packet.skillCandidatesByProfile).flat(),
    ...Object.values(packet.toolCandidatesByProfile).flat(),
    ...Object.values(packet.mcpGrantCandidatesByProfile).flat(),
    ...Object.values(packet.vaultLeaseCandidatesByProfile).flat(),
    ...Object.values(packet.instructionCandidatesByProfile).flat(),
    ...packet.artifactContractCandidates,
    ...Object.values(packet.evaluatorCandidatesByArtifact).flat(),
    ...packet.policyConstraints,
  ]) {
    if (candidate.versionRef) {
      versionRefsByRef.set(candidate.ref, candidate.versionRef);
    }
  }
  for (const node of packet.graphMetadataCandidates?.nodes ?? []) {
    if (node.versionRef) {
      versionRefsByRef.set(node.ref, node.versionRef);
    }
  }

  const selectedRefs = new Set<string>();
  selectedRefs.add(composition.selectedWorkflowTemplateRef);
  for (const task of composition.tasks) {
    selectedRefs.add(task.agentDefinitionRef);
    selectedRefs.add(task.agentProfileRef);
    selectedRefs.add(task.evaluatorProfileRef);
    addRefs(selectedRefs, task.skillRefs);
    addRefs(selectedRefs, task.toolGrantRefs);
    addRefs(selectedRefs, task.mcpGrantRefs);
    addRefs(selectedRefs, task.vaultLeasePolicyRefs);
    addRefs(selectedRefs, task.instructionRefs);
    addRefs(selectedRefs, task.inputArtifactRefs);
    addRefs(selectedRefs, task.outputArtifactRefs);
    if (task.contextPolicyRef) selectedRefs.add(task.contextPolicyRef);
    if (task.workspacePolicyRef) selectedRefs.add(task.workspacePolicyRef);
  }

  const selectedVersionRefs = [...selectedRefs]
    .map((ref) => versionRefsByRef.get(ref))
    .filter((value): value is string => Boolean(value));
  return [...new Set(selectedVersionRefs)].sort();
}

function addRefs(target: Set<string>, refs: string[]): void {
  for (const ref of refs) {
    target.add(ref);
  }
}

function flattenCandidateRefs(values: Record<string, Array<{ ref: string }>>): string[] {
  return [...new Set(Object.values(values).flat().map((candidate) => candidate.ref))].sort();
}

function graphRefsByKind(packet: CandidatePacket, kind: string): string[] {
  return (packet.graphMetadataCandidates?.nodes ?? [])
    .filter((node) => node.kind === kind)
    .map((node) => node.ref);
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
    value === "anthropic" ||
    value === "custom";
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
