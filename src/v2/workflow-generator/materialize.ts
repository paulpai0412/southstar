import type { DomainPack } from "../domain-packs/types.ts";
import type { HarnessDefinition, SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import type { WorkflowGenerationPlan } from "./types.ts";

export type MaterializeGenerationPlanInput = {
  plan: WorkflowGenerationPlan;
  domainPack: DomainPack;
  goalPrompt: string;
};

export function materializeGenerationPlan(input: MaterializeGenerationPlanInput): SouthstarWorkflowManifest {
  const workspaceMounts = fixtureRepoMounts(input.goalPrompt);
  return {
    schemaVersion: "southstar.v2",
    workflowId: `wf-${input.plan.id}`,
    title: "Software Dynamic Feature Workflow",
    domain: input.domainPack.id,
    intent: input.plan.intentRef,
    goalPrompt: input.goalPrompt,
    domainPackRef: input.plan.domainPackRef,
    effortPolicy: input.plan.effortPolicy,
    workflowGeneration: {
      planId: input.plan.id,
      generatorPolicyRef: input.plan.generatorPolicyRef,
      orchestrationSnapshotId: `orch-${input.plan.id}`,
    },
    roles: input.domainPack.roles,
    agentProfiles: input.domainPack.agentProfiles,
    artifactContracts: input.domainPack.artifactContracts,
    evaluatorPipelines: input.domainPack.evaluatorPipelines,
    contextPolicies: input.domainPack.contextPolicies,
    sessionPolicies: input.domainPack.sessionPolicies,
    memoryPolicies: input.domainPack.memoryPolicies,
    workspacePolicies: input.domainPack.workspacePolicies,
    tasks: input.plan.tasks.map((task): WorkflowTaskDefinition => {
      const profile = required(
        input.domainPack.agentProfiles.find((candidate) => candidate.id === task.agentProfileRef),
        `missing profile ${task.agentProfileRef}`,
      );
      const workspacePolicyRef =
        input.domainPack.workflowTemplates
          .flatMap((template) => template.stages)
          .find((stage) => stage.roleRef === task.roleRef)?.workspacePolicyRef ??
        input.domainPack.workspacePolicies[0]?.id ??
        "software-git-workspace";
      const stopConditionRefs =
        input.domainPack.workflowTemplates
          .flatMap((template) => template.stages)
          .find((stage) => stage.roleRef === task.roleRef)?.stopConditionRefs ?? [];
      return {
        id: task.id,
        name: humanize(task.id),
        domain: input.domainPack.id as WorkflowTaskDefinition["domain"],
        roleRef: task.roleRef,
        agentProfileRef: task.agentProfileRef,
        providerRef: profile.provider,
        model: profile.model,
        dependsOn: task.dependsOn,
        promptInputs: task.promptInputs,
        requiredArtifactRefs: task.requiredArtifactRefs,
        evaluatorPipelineRef: task.evaluatorPipelineRef,
        stopConditionRefs,
        recoveryStrategyRefs: task.recoveryStrategyRefs,
        contextPolicyRef: profile.contextPolicyRef,
        sessionPolicyRef: profile.sessionPolicyRef,
        workspacePolicyRef,
        execution: {
          engine: "tork",
          image: "southstar/pi-agent:local",
          command: ["southstar-agent-runner"],
          env: {},
          mounts: workspaceMounts,
          timeoutSeconds: profile.budgetPolicy.maxWallTimeSeconds ?? 900,
          infraRetry: { maxAttempts: 1 },
        },
        rootSession: {
          validator: "schema-evaluator-v1",
          maxRepairAttempts: 2,
        },
        skillRefs: profile.skillRefs,
        memoryScopeRefs: profile.memoryScopes,
        mcpGrantRefs: profile.mcpGrantRefs,
        subagents: [{
          id: `${task.roleRef}-${task.id}`,
          harnessId: profile.harnessRef,
          prompt: `${task.promptTemplateRef}: ${JSON.stringify(task.promptInputs)}`,
          requiredArtifacts: task.requiredArtifactRefs.map((artifactRef) =>
            required(
              input.domainPack.artifactContracts.find((contract) => contract.id === artifactRef),
              `missing artifact contract ${artifactRef}`,
            ).artifactType
          ),
        }],
      };
    }),
    harnessDefinitions: materializeHarnessDefinitions(input.domainPack),
    evaluators: [{
      id: "schema-evaluator-v1",
      kind: "schema",
      artifactTypes: input.domainPack.artifactContracts.map((contract) => contract.artifactType),
      requiredFields: [...new Set(input.domainPack.artifactContracts.flatMap((contract) => contract.requiredFields))],
    }],
    memoryPolicy: { retrievalLimit: 8, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}

function materializeHarnessDefinitions(domainPack: DomainPack): HarnessDefinition[] {
  const byId = new Map<string, HarnessDefinition>();
  for (const profile of domainPack.agentProfiles) {
    const kind = profile.harnessRef === "pi" ? "pi-agent" : profile.harnessRef;
    byId.set(profile.harnessRef, {
      id: profile.harnessRef,
      kind: kind as HarnessDefinition["kind"],
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: [domainPack.id],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    });
  }
  return [...byId.values()];
}

function humanize(id: string): string {
  return id
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function fixtureRepoMounts(goalPrompt: string): Array<{ source: string; target: string; readonly: boolean }> {
  const match = goalPrompt.match(/Fixture repo:\s*(.+)\s*$/im);
  const source = match?.[1]?.trim();
  if (!source?.startsWith("/")) return [];
  return [{ source, target: "/workspace/repo", readonly: false }];
}

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}
