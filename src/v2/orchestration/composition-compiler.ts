import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type { CandidatePacket, WorkflowCompositionPlan, WorkflowCompositionValidationResult } from "../design-library/types.ts";
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
  const scope = input.scope ?? "software";
  const validation = await validateWorkflowCompositionPlan(db, input.candidatePacket, input.composition, { scope });
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
    const promptTemplateRef = normalizeInstructionRef(
      task.instructionRefs[0] ?? `instruction.${profile.promptTemplateRef}`,
    );
    return {
      id: task.id,
      name: task.name,
      domain: scope,
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
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 1 },
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
    domain: scope,
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
        capabilities: [scope],
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
        capabilities: [scope],
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
    workflowTemplateRefs: packet.workflowTemplateCandidates.map((candidate) => candidate.ref).sort(),
    agentDefinitionRefs: flattenCandidateRefs(packet.agentCandidatesByCapability),
    agentProfileRefs: flattenCandidateRefs(packet.profileCandidatesByAgent),
    skillRefs: flattenCandidateRefs(packet.skillCandidatesByProfile),
    toolGrantRefs: flattenCandidateRefs(packet.toolCandidatesByProfile),
    mcpGrantRefs: flattenCandidateRefs(packet.mcpGrantCandidatesByProfile),
    artifactContractRefs: packet.artifactContractCandidates.map((candidate) => candidate.ref).sort(),
    evaluatorProfileRefs: flattenCandidateRefs(packet.evaluatorCandidatesByArtifact),
    policyRefs: packet.policyConstraints.map((candidate) => candidate.ref).sort(),
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
    const runtimeRole = parseRuntimeRole(
      agentState.runtimeRole,
      `agent definition ${task.agentDefinitionRef} state.runtimeRole`,
    );
    byAgentRef.set(task.agentDefinitionRef, runtimeRole);
    byRoleId.set(runtimeRole.id, runtimeRole);
  }
  return { byAgentRef, byRoleId };
}

async function resolveRuntimeProfiles(db: SouthstarDb, plan: WorkflowCompositionPlan): Promise<ResolvedRuntimeProfiles> {
  const byProfileRef = new Map<string, AgentProfile>();
  const byProfileId = new Map<string, AgentProfile>();
  for (const task of plan.tasks) {
    if (byProfileRef.has(task.agentProfileRef)) continue;
    const profile = await findLibraryObjectByKey(db, task.agentProfileRef);
    const profileState = required(profile?.state, `library object not found for ${task.agentProfileRef}`);
    const runtimeProfile = parseRuntimeProfile(
      profileState.runtimeProfile,
      `agent profile ${task.agentProfileRef} state.runtimeProfile`,
    );
    byProfileRef.set(task.agentProfileRef, runtimeProfile);
    byProfileId.set(runtimeProfile.id, runtimeProfile);
  }
  return { byProfileRef, byProfileId };
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
    provider,
    model: stringAt(record.model, `${path}.model`),
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
