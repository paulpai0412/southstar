import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type { CandidatePacket, WorkflowCompositionPlan, WorkflowCompositionValidationResult } from "../design-library/types.ts";
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import { validateWorkflowCompositionPlan } from "./composition-validator.ts";

export type CompileWorkflowCompositionInput = {
  runId: string;
  goalPrompt: string;
  candidatePacket: CandidatePacket;
  composition: WorkflowCompositionPlan;
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
  const validation = await validateWorkflowCompositionPlan(db, input.candidatePacket, input.composition);
  if (!validation.ok) {
    throw new Error(`workflow composition failed validation: ${JSON.stringify(validation.issues)}`);
  }

  const planHash = hash(JSON.stringify(input.composition));
  const taskDefinitions = input.composition.tasks.map((task): WorkflowTaskDefinition => {
    const roleRef = roleFromAgentRef(task.agentDefinitionRef);
    const profileRef = normalizeProfileRef(task.agentProfileRef);
    const promptTemplateRef = normalizeInstructionRef(task.instructionRefs[0] ?? `instruction.software-${roleRef}`);
    return {
      id: task.id,
      name: task.name,
      domain: "software",
      roleRef,
      agentProfileRef: profileRef,
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
          id: `${roleRef}-${task.id}`,
          harnessId: harnessFromProfileRef(profileRef),
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
    domain: "software",
    intent: input.candidatePacket.requirementSpec.workType === "bugfix" ? "fix_bug" : "implement_feature",
    workflowGeneration: {
      planId: `composition-${planHash.slice(0, 12)}`,
      generatorPolicyRef: "library-constrained-llm",
      orchestrationSnapshotId: `orch-${planHash.slice(0, 12)}`,
    },
    tasks: taskDefinitions,
    harnessDefinitions: [
      {
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
      },
      {
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
        libraryVersionRefs: collectVersionRefs(input.candidatePacket),
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

function collectVersionRefs(packet: CandidatePacket): string[] {
  const versionRefs = [
    ...packet.workflowTemplateCandidates,
    ...Object.values(packet.agentCandidatesByCapability).flat(),
    ...Object.values(packet.profileCandidatesByAgent).flat(),
    ...Object.values(packet.skillCandidatesByProfile).flat(),
    ...Object.values(packet.toolCandidatesByProfile).flat(),
    ...Object.values(packet.mcpGrantCandidatesByProfile).flat(),
    ...Object.values(packet.instructionCandidatesByProfile).flat(),
    ...packet.artifactContractCandidates,
    ...Object.values(packet.evaluatorCandidatesByArtifact).flat(),
    ...packet.policyConstraints,
  ].map((candidate) => candidate.versionRef).filter((value): value is string => Boolean(value));
  return [...new Set(versionRefs)].sort();
}

function flattenCandidateRefs(values: Record<string, Array<{ ref: string }>>): string[] {
  return [...new Set(Object.values(values).flat().map((candidate) => candidate.ref))].sort();
}

function roleFromAgentRef(agentDefinitionRef: string): string {
  const normalized = agentDefinitionRef.replace(/^agent\./, "");
  const role = normalized.replace(/^software-/, "");
  if (role === "spec-reviewer" || role === "code-quality-reviewer") return "checker";
  return role;
}

function normalizeProfileRef(profileRef: string): string {
  if (profileRef === "profile.software-spec-reviewer-codex") return "software-checker-codex";
  if (profileRef === "profile.software-code-quality-reviewer-codex") return "software-checker-codex";
  return profileRef.replace(/^profile\./, "");
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

function harnessFromProfileRef(profileRef: string): "pi" | "codex" {
  return profileRef.endsWith("-pi") ? "pi" : "codex";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
