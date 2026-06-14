import test from "node:test";
import assert from "node:assert/strict";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { createDomainPackRegistry } from "../../src/v2/domain-packs/registry.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import type {
  AgentProfile,
  ArtifactContract,
  ContextPolicy,
  DomainPack,
  EvaluatorPipeline,
  Intent,
  MemoryPolicy,
  RoleDefinition,
  SessionPolicy,
  StopCondition,
  WorkflowGeneratorPolicy,
  WorkflowTemplate,
  WorkspacePolicy,
} from "../../src/v2/domain-packs/types.ts";

function acceptsDomainPackContract(_contract: {
  domainPack: DomainPack;
  intent: Intent;
  workflowTemplate: WorkflowTemplate;
  workflowGeneratorPolicy: WorkflowGeneratorPolicy;
  role: RoleDefinition;
  agentProfile: AgentProfile;
  artifactContract: ArtifactContract;
  evaluatorPipeline: EvaluatorPipeline;
  contextPolicy: ContextPolicy;
  sessionPolicy: SessionPolicy;
  memoryPolicy: MemoryPolicy;
  workspacePolicy: WorkspacePolicy;
  stopCondition: StopCondition;
}) {}

test("software domain pack defines the runtime contract for feature work", () => {
  acceptsDomainPackContract({
    domainPack: softwareDomainPack,
    intent: softwareDomainPack.intents[0],
    workflowTemplate: softwareDomainPack.workflowTemplates[0],
    workflowGeneratorPolicy: softwareDomainPack.workflowGeneratorPolicies[0],
    role: softwareDomainPack.roles[0],
    agentProfile: softwareDomainPack.agentProfiles[0],
    artifactContract: softwareDomainPack.artifactContracts[0],
    evaluatorPipeline: softwareDomainPack.evaluatorPipelines[0],
    contextPolicy: softwareDomainPack.contextPolicies[0],
    sessionPolicy: softwareDomainPack.sessionPolicies[0],
    memoryPolicy: softwareDomainPack.memoryPolicies[0],
    workspacePolicy: softwareDomainPack.workspacePolicies[0],
    stopCondition: softwareDomainPack.stopConditions[0],
  });

  assert.equal(softwareDomainPack.id, "software");
  assert.equal(softwareDomainPack.version, "1.0.0");
  assert.ok(softwareDomainPack.intents.some((intent) => intent.id === "implement_feature"));
  assert.ok(softwareDomainPack.intents.some((intent) => intent.id === "fix_bug"));
  assert.ok(softwareDomainPack.roles.some((role) => role.id === "explorer"));
  assert.ok(softwareDomainPack.roles.some((role) => role.id === "maker"));
  assert.ok(softwareDomainPack.roles.some((role) => role.id === "checker"));
  assert.ok(softwareDomainPack.roles.some((role) => role.id === "summarizer"));
  assert.ok(softwareDomainPack.agentProfiles.some((profile) => profile.id === "software-maker-pi"));
  assert.ok(softwareDomainPack.artifactContracts.some((contract) => contract.id === "implementation_report"));
  assert.ok(softwareDomainPack.evaluatorPipelines.some((pipeline) => pipeline.id === "software-feature-quality"));
  assert.ok(softwareDomainPack.contextPolicies.some((policy) => policy.id === "software-context-default"));
  assert.ok(softwareDomainPack.sessionPolicies.some((policy) => policy.id === "software-session-default"));
  assert.ok(softwareDomainPack.memoryPolicies.some((policy) => policy.id === "software-memory-default"));
  assert.ok(softwareDomainPack.workspacePolicies.some((policy) => policy.id === "software-git-workspace"));
  assert.ok(softwareDomainPack.stopConditions.some((condition) => condition.id === "software-feature-complete"));
});

test("domain pack registry resolves software feature prompts by prompt intent hint", () => {
  const registry = createDomainPackRegistry([softwareDomainPack]);
  const routed = registry.route({
    goalPrompt: "新增 CLI 指令 calc sum <numbers...> 並補測試 README",
    domainHint: undefined,
  });

  assert.equal(routed.domainPack.id, "software");
  assert.equal(routed.intent.id, "implement_feature");
});

test("domain pack registry keeps feature intent when recovery requirements mention failure", () => {
  const registry = createDomainPackRegistry([softwareDomainPack]);
  const routed = registry.route({
    goalPrompt: [
      "新增 CLI 指令 `calc sum <numbers...>`，支援多個數字輸入、負數、小數、無效輸入錯誤訊息。",
      "驗收失敗時 RootSession 必須記錄 retry、fork session、rollback workspace 或 workflow revision。",
    ].join("\n"),
  });

  assert.equal(routed.domainPack.id, "software");
  assert.equal(routed.intent.id, "implement_feature");
});

test("domain pack registry resolves software bug prompts to fix_bug", () => {
  const registry = createDomainPackRegistry([softwareDomainPack]);
  const routed = registry.route({
    goalPrompt: "Fix the calc CLI bug causing test failure on negative numbers",
  });

  assert.equal(routed.domainPack.id, "software");
  assert.equal(routed.intent.id, "fix_bug");
});

test("domain pack registry rejects an explicit unknown domain hint", () => {
  const registry = createDomainPackRegistry([softwareDomainPack]);

  assert.throws(
    () =>
      registry.route({
        goalPrompt: "新增 CLI 指令 calc sum <numbers...> 並補測試 README",
        domainHint: "softwrae",
      }),
    /unknown domain hint: softwrae/,
  );
});

test("domain pack registry prefers explicit intent examples over broad software keywords", () => {
  const researchDomainPack: DomainPack = {
    ...softwareDomainPack,
    id: "research",
    displayName: "Research",
    intents: [
      {
        id: "collect_repository_metrics",
        description: "Collect metrics from repositories.",
        examples: ["collect repository metrics"],
        workflowTemplateRef: "research-template",
        requiredInputs: ["goalPrompt"],
        defaultContextPolicyRef: "software-context-default",
        defaultSessionPolicyRef: "software-session-default",
      },
      {
        id: "summarize_repository_study",
        description: "Summarize research involving repositories and tests.",
        examples: ["summarize repository tests dataset"],
        workflowTemplateRef: "research-template",
        requiredInputs: ["goalPrompt"],
        defaultContextPolicyRef: "software-context-default",
        defaultSessionPolicyRef: "software-session-default",
      },
    ],
  };
  const registry = createDomainPackRegistry([softwareDomainPack, researchDomainPack]);

  const routed = registry.route({
    goalPrompt: "Please summarize repository tests dataset and compare the papers",
  });

  assert.equal(routed.domainPack.id, "research");
  assert.equal(routed.intent.id, "summarize_repository_study");
});

test("software domain pack references resolve to defined contracts", () => {
  assertDomainPackReferencesResolve(softwareDomainPack);
});

test("domain pack reference validation rejects unknown workflow stage dependencies", () => {
  const brokenDomainPack: DomainPack = {
    ...softwareDomainPack,
    workflowTemplates: [
      {
        ...softwareDomainPack.workflowTemplates[0],
        stages: softwareDomainPack.workflowTemplates[0].stages.map((stage) =>
          stage.id === "verify" ? { ...stage, dependsOn: ["implment"] } : stage,
        ),
      },
    ],
  };

  assert.throws(() => assertDomainPackReferencesResolve(brokenDomainPack), /stage verify dependsOn implment/);
});

test("Southstar workflow manifest accepts optional domain-pack-backed fields", () => {
  const manifest = {
    schemaVersion: "southstar.v2",
    workflowId: "wf-domain-pack",
    title: "Domain pack workflow",
    goalPrompt: "新增 CLI 指令 calc sum <numbers...> 並補測試 README",
    domain: "software",
    intent: "implement_feature",
    domainPackRef: { id: "software", version: "1.0.0", contentHash: "sha256:test" },
    workflowGeneration: {
      planId: "plan-1",
      generatorPolicyRef: "software-feature-generator",
      orchestrationSnapshotId: "snapshot-1",
    },
    roles: softwareDomainPack.roles,
    agentProfiles: softwareDomainPack.agentProfiles,
    artifactContracts: softwareDomainPack.artifactContracts,
    evaluatorPipelines: softwareDomainPack.evaluatorPipelines,
    contextPolicies: softwareDomainPack.contextPolicies,
    sessionPolicies: softwareDomainPack.sessionPolicies,
    memoryPolicies: softwareDomainPack.memoryPolicies,
    workspacePolicies: softwareDomainPack.workspacePolicies,
    tasks: [],
    harnessDefinitions: [],
    evaluators: [],
    memoryPolicy: { retrievalLimit: 8, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 300, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  } satisfies SouthstarWorkflowManifest;

  assert.equal(manifest.domainPackRef.id, "software");
  assert.equal(manifest.workflowGeneration.generatorPolicyRef, "software-feature-generator");
});

function assertDomainPackReferencesResolve(domainPack: DomainPack) {
  const intents = new Set(domainPack.intents.map((intent) => intent.id));
  const roles = new Set(domainPack.roles.map((role) => role.id));
  const agentProfiles = new Set(domainPack.agentProfiles.map((profile) => profile.id));
  const workflowTemplates = new Set(domainPack.workflowTemplates.map((template) => template.id));
  const workflowGeneratorPolicies = new Set(domainPack.workflowGeneratorPolicies.map((policy) => policy.id));
  const artifactContracts = new Set(domainPack.artifactContracts.map((contract) => contract.id));
  const evaluatorPipelines = new Set(domainPack.evaluatorPipelines.map((pipeline) => pipeline.id));
  const contextPolicies = new Set(domainPack.contextPolicies.map((policy) => policy.id));
  const sessionPolicies = new Set(domainPack.sessionPolicies.map((policy) => policy.id));
  const memoryPolicies = new Set(domainPack.memoryPolicies.map((policy) => policy.id));
  const workspacePolicies = new Set(domainPack.workspacePolicies.map((policy) => policy.id));
  const stopConditions = new Set(domainPack.stopConditions.map((condition) => condition.id));

  for (const intent of domainPack.intents) {
    assert.ok(workflowTemplates.has(intent.workflowTemplateRef), `intent ${intent.id} workflowTemplateRef`);
    assert.ok(contextPolicies.has(intent.defaultContextPolicyRef), `intent ${intent.id} defaultContextPolicyRef`);
    assert.ok(sessionPolicies.has(intent.defaultSessionPolicyRef), `intent ${intent.id} defaultSessionPolicyRef`);
  }

  for (const role of domainPack.roles) {
    assert.ok(agentProfiles.has(role.defaultAgentProfileRef), `role ${role.id} defaultAgentProfileRef`);
    for (const profileRef of role.allowedAgentProfileRefs) {
      assert.ok(agentProfiles.has(profileRef), `role ${role.id} allowedAgentProfileRef ${profileRef}`);
    }
    for (const artifactRef of [...role.artifactInputs, ...role.artifactOutputs]) {
      assert.ok(artifactContracts.has(artifactRef), `role ${role.id} artifact ref ${artifactRef}`);
    }
  }

  for (const profile of domainPack.agentProfiles) {
    assert.ok(contextPolicies.has(profile.contextPolicyRef), `profile ${profile.id} contextPolicyRef`);
    assert.ok(sessionPolicies.has(profile.sessionPolicyRef), `profile ${profile.id} sessionPolicyRef`);
  }

  for (const template of domainPack.workflowTemplates) {
    const stageIds = new Set(template.stages.map((stage) => stage.id));
    for (const intentRef of template.intentRefs) {
      assert.ok(intents.has(intentRef), `template ${template.id} intentRef ${intentRef}`);
    }
    for (const stage of template.stages) {
      for (const dependency of stage.dependsOn) {
        assert.ok(stageIds.has(dependency), `stage ${stage.id} dependsOn ${dependency}`);
      }
      assert.ok(roles.has(stage.roleRef), `stage ${stage.id} roleRef`);
      for (const artifactRef of stage.requiredArtifactRefs) {
        assert.ok(artifactContracts.has(artifactRef), `stage ${stage.id} artifactRef ${artifactRef}`);
      }
      assert.ok(evaluatorPipelines.has(stage.evaluatorPipelineRef), `stage ${stage.id} evaluatorPipelineRef`);
      for (const conditionRef of stage.stopConditionRefs) {
        assert.ok(stopConditions.has(conditionRef), `stage ${stage.id} stopConditionRef ${conditionRef}`);
      }
      if (stage.workspacePolicyRef) {
        assert.ok(workspacePolicies.has(stage.workspacePolicyRef), `stage ${stage.id} workspacePolicyRef`);
      }
    }
  }

  for (const policy of domainPack.workflowGeneratorPolicies) {
    for (const intentRef of policy.intentRefs) {
      assert.ok(intents.has(intentRef), `generator ${policy.id} intentRef ${intentRef}`);
    }
    for (const templateRef of policy.templateRefs) {
      assert.ok(workflowTemplates.has(templateRef), `generator ${policy.id} templateRef ${templateRef}`);
    }
    for (const roleRef of policy.allowedRoleRefs) {
      assert.ok(roles.has(roleRef), `generator ${policy.id} roleRef ${roleRef}`);
    }
    for (const profileRef of policy.allowedAgentProfileRefs) {
      assert.ok(agentProfiles.has(profileRef), `generator ${policy.id} agentProfileRef ${profileRef}`);
    }
    for (const pipelineRef of policy.allowedEvaluatorPipelineRefs) {
      assert.ok(evaluatorPipelines.has(pipelineRef), `generator ${policy.id} evaluatorPipelineRef ${pipelineRef}`);
    }
    for (const artifactRef of policy.allowedArtifactContractRefs) {
      assert.ok(artifactContracts.has(artifactRef), `generator ${policy.id} artifactRef ${artifactRef}`);
    }
  }

  for (const pipeline of domainPack.evaluatorPipelines) {
    for (const evaluator of pipeline.evaluators) {
      const artifactRef = evaluator.config.artifactRef;
      if (typeof artifactRef === "string") {
        assert.ok(artifactContracts.has(artifactRef), `pipeline ${pipeline.id} evaluator ${evaluator.id} artifactRef`);
      }
    }
  }

  for (const policy of domainPack.contextPolicies) {
    assert.ok(memoryPolicies.has(policy.memoryPolicyRef), `context ${policy.id} memoryPolicyRef`);
  }

  for (const condition of domainPack.stopConditions) {
    for (const evaluatorRef of condition.evaluatorRefs) {
      assert.ok(evaluatorPipelines.has(evaluatorRef), `stop condition ${condition.id} evaluatorRef ${evaluatorRef}`);
    }
  }

  assert.ok(workflowGeneratorPolicies.has("software-feature-generator"));
}
