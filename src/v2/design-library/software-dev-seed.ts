import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import {
  appendVersionCreated,
  createLibraryObject,
  findLibraryObjectByKey,
  listLibraryVersions,
} from "./store.ts";
import type {
  LibraryActorType,
  LibraryDefinitionKind,
} from "./types.ts";
import { seedSoftwareDevSkills } from "./software-dev-skills.ts";

type SeedObject = {
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  tags: string[];
  payload: Record<string, unknown>;
};

const seedObjects: SeedObject[] = [
  {
    objectKey: "software-dev.agent.explorer",
    objectKind: "agent_spec",
    tags: ["software", "explorer"],
    payload: agentPayload("Explorer", "explorer", "Inspect repository and issue before changes."),
  },
  {
    objectKey: "software-dev.agent.planner",
    objectKind: "agent_spec",
    tags: ["software", "planner"],
    payload: agentPayload("Planner", "planner", "Plan implementation and test strategy."),
  },
  {
    objectKey: "software-dev.agent.implementer",
    objectKind: "agent_spec",
    tags: ["software", "implementer"],
    payload: agentPayload("Implementer", "implementer", "Implement minimal code changes with evidence."),
  },
  {
    objectKey: "software-dev.agent.checker",
    objectKind: "agent_spec",
    tags: ["software", "checker"],
    payload: agentPayload("Checker", "checker", "Verify behavior and reject invalid evidence."),
  },
  {
    objectKey: "software-dev.agent.summarizer",
    objectKind: "agent_spec",
    tags: ["software", "summarizer"],
    payload: agentPayload("Summarizer", "summarizer", "Summarize accepted changes and risks."),
  },
  {
    objectKey: "software-dev.capability.repo-read-write",
    objectKind: "capability_spec",
    tags: ["software", "workspace"],
    payload: {
      schemaVersion: "southstar.library.capability_spec.v1",
      capabilityType: "tool_capability",
      title: "Repository read/write",
      description: "Read and edit repository files inside workspace.",
      requiredMounts: ["/workspace/repo"],
      requiredOperations: ["read", "edit", "write"],
      risk: { level: "medium", dataSensitivity: "workspace", approvalRequired: false },
      contractRefs: ["software-dev.contract.implementation-artifact"],
      validatorRefs: ["software-dev.validator.schema-evidence-policy"],
      provenance: { source: "seed", createdBy: "migration" },
    },
  },
  {
    objectKey: "software-dev.capability.browser-ux-verification",
    objectKind: "capability_spec",
    tags: ["software", "browser", "verification"],
    payload: {
      schemaVersion: "southstar.library.capability_spec.v1",
      capabilityType: "skill",
      title: "Browser UX verification",
      description: "Verify browser behavior with screenshot and DOM evidence.",
      requiredMounts: ["/workspace/repo"],
      requiredOperations: ["browser-open", "dom-check", "screenshot"],
      risk: { level: "low", dataSensitivity: "workspace", approvalRequired: false },
      contractRefs: ["software-dev.contract.verification-artifact"],
      validatorRefs: ["software-dev.validator.schema-evidence-policy"],
      provenance: { source: "seed", createdBy: "migration" },
    },
  },
  {
    objectKey: "software-dev.contract.issue-input",
    objectKind: "contract_spec",
    tags: ["software", "input"],
    payload: {
      schemaVersion: "southstar.library.contract_spec.v1",
      contractType: "input",
      fields: [
        { name: "issueTitle", type: "string", required: true, description: "Issue title" },
        { name: "issueBody", type: "string", required: true, description: "Issue body" },
        { name: "repoPath", type: "string", required: true, description: "Repository path" },
        { name: "acceptanceCriteria", type: "array", required: true, description: "Acceptance criteria list" },
      ],
    },
  },
  {
    objectKey: "software-dev.contract.implementation-artifact",
    objectKind: "contract_spec",
    tags: ["software", "output"],
    payload: {
      schemaVersion: "southstar.library.contract_spec.v1",
      contractType: "output",
      artifactType: "implementation_result",
      fields: [
        { name: "summary", type: "string", required: true, description: "Implementation summary" },
        { name: "filesChanged", type: "array", required: true, description: "Changed files" },
        { name: "commandsRun", type: "array", required: true, description: "Commands executed" },
      ],
      evidenceRequirements: [
        { kind: "file-diff", required: true, description: "Git diff evidence" },
        { kind: "test-result", required: true, description: "Test output evidence" },
        { kind: "command-output", required: true, description: "Command output evidence" },
      ],
    },
  },
  {
    objectKey: "software-dev.contract.verification-artifact",
    objectKind: "contract_spec",
    tags: ["software", "verification"],
    payload: {
      schemaVersion: "southstar.library.contract_spec.v1",
      contractType: "output",
      artifactType: "verification_result",
      fields: [
        { name: "summary", type: "string", required: true, description: "Verification summary" },
        { name: "verdict", type: "string", required: true, description: "Verification verdict" },
      ],
      evidenceRequirements: [
        { kind: "test-result", required: true, description: "Automated test evidence" },
        { kind: "screenshot", required: false, description: "Browser screenshot evidence" },
      ],
    },
  },
  {
    objectKey: "software-dev.contract.completion-artifact",
    objectKind: "contract_spec",
    tags: ["software", "completion"],
    payload: {
      schemaVersion: "southstar.library.contract_spec.v1",
      contractType: "output",
      artifactType: "release_result",
      fields: [
        { name: "status", type: "string", required: true, description: "Release status" },
        { name: "confirmed", type: "boolean", required: true, description: "Release confirmation" },
      ],
      evidenceRequirements: [
        { kind: "artifact-ref", required: true, description: "References implementation and verification artifacts" },
      ],
    },
  },
  {
    objectKey: "software-dev.validator.schema-evidence-policy",
    objectKind: "validator_spec",
    tags: ["software", "validator"],
    payload: {
      schemaVersion: "southstar.library.validator_spec.v1",
      validatorType: "pipeline",
      config: {
        validators: ["schema", "evidence", "policy"],
      },
      required: true,
      failureStrategy: "request-workflow-revision",
      appliesToContractRefs: [
        "software-dev.contract.implementation-artifact",
        "software-dev.contract.verification-artifact",
        "software-dev.contract.completion-artifact",
      ],
      steps: [
        { validatorRef: "schema", required: true },
        { validatorRef: "evidence", required: true },
        { validatorRef: "policy", required: true },
      ],
    },
  },
  {
    objectKey: "software-dev.policy.safe-workspace-tork",
    objectKind: "policy_bundle",
    tags: ["software", "policy"],
    payload: {
      schemaVersion: "southstar.library.policy_bundle.v1",
      policyTypes: ["tool", "workspace", "approval", "auto-run"],
      tool: {
        allowedTools: ["bash", "read", "edit", "write"],
        deniedTools: ["secret-read"],
        requiresApprovalFor: [],
        networkPolicy: "none",
        filesystemPolicy: "workspace-write",
        shellPolicy: "workspace-shell",
      },
      workspace: {
        provider: "git",
        isolation: "per-task-worktree",
        snapshotAt: ["task.start", "task.complete"],
        rollbackOn: ["validator.failed"],
      },
      approval: { requiredForRisk: ["high"], requireManualFor: ["mcp-grant"] },
      autoRun: { allowedOnlyWhenTemplateStatus: "validated", requireLowRisk: true, requireAllInputs: true },
    },
  },
  {
    objectKey: "software-dev.template.issue-to-pr-style-todo-web",
    objectKind: "workflow_template",
    tags: ["software", "todo-web", "template"],
    payload: {
      schemaVersion: "southstar.library.workflow_template.v1",
      templateType: "exact",
      inputContractRef: "software-dev.contract.issue-input",
      flow: {
        primaryPattern: "maker_checker",
        secondaryPatterns: ["human_gate"],
        nodes: [
          { id: "explorer", nodeType: "agent_task", name: "Explorer", roleRef: "explorer", agentSpecRef: "software-dev.agent.explorer", contractRefs: ["software-dev.contract.issue-input"], validatorRefs: ["software-dev.validator.schema-evidence-policy"], capabilityRefs: ["software-dev.capability.repo-read-write"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork" },
          { id: "planner", nodeType: "agent_task", name: "Planner", roleRef: "planner", agentSpecRef: "software-dev.agent.planner", contractRefs: ["software-dev.contract.issue-input"], validatorRefs: ["software-dev.validator.schema-evidence-policy"], capabilityRefs: ["software-dev.capability.repo-read-write"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork" },
          { id: "implementer", nodeType: "agent_task", name: "Implementer", roleRef: "implementer", agentSpecRef: "software-dev.agent.implementer", contractRefs: ["software-dev.contract.implementation-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy"], capabilityRefs: ["software-dev.capability.repo-read-write"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork" },
          { id: "checker", nodeType: "agent_task", name: "Checker", roleRef: "checker", agentSpecRef: "software-dev.agent.checker", contractRefs: ["software-dev.contract.verification-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy"], capabilityRefs: ["software-dev.capability.browser-ux-verification"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork" },
          { id: "summarizer", nodeType: "agent_task", name: "Summarizer", roleRef: "summarizer", agentSpecRef: "software-dev.agent.summarizer", contractRefs: ["software-dev.contract.completion-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy"], capabilityRefs: ["software-dev.capability.repo-read-write"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork" },
        ],
        edges: [
          { id: "explorer-to-planner", from: "explorer", to: "planner", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.issue-input"] },
          { id: "planner-to-implementer", from: "planner", to: "implementer", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.implementation-artifact"], workspaceStateRequired: true },
          { id: "implementer-to-checker", from: "implementer", to: "checker", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.verification-artifact"], workspaceStateRequired: true },
          { id: "checker-to-summarizer", from: "checker", to: "summarizer", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.completion-artifact"] },
        ],
        recovery: { onValidatorFailure: "request_workflow_revision", maxAttempts: 2 },
      },
      outputContractRefs: ["software-dev.contract.completion-artifact"],
      evidenceContractRefs: ["software-dev.contract.implementation-artifact", "software-dev.contract.verification-artifact"],
      stopConditionValidatorRefs: ["software-dev.validator.schema-evidence-policy"],
      lifecycle: { status: "approved_for_run", validatedByRunIds: [], failureEvidenceRefs: [] },
      reuse: {
        signature: "todo-web feature issue software workflow",
        tags: ["software", "todo-web"],
        requiredInputs: ["issueTitle", "issueBody", "repoPath", "acceptanceCriteria"],
        assumptionDefaults: {},
        clarificationPolicy: {
          askOnlyWhenMissingRequiredInput: true,
          askWhenSimilarityBelow: 0.85,
          askWhenRiskAbove: "low",
        },
        requirementSpecSnapshot: {
          summary: "Implement todo-web feature issue through software workflow",
          requiredInputs: ["issueTitle", "issueBody", "repoPath", "acceptanceCriteria"],
          clarifiedInputs: {},
          assumptions: [],
          acceptanceCriteria: ["tests pass"],
          nonGoals: [],
          riskNotes: [],
        },
      },
    },
  },
  {
    objectKey: "software-dev.recipe.todo-web-adaptation",
    objectKind: "workflow_recipe",
    tags: ["software", "todo-web", "recipe"],
    payload: {
      schemaVersion: "southstar.library.workflow_recipe.v1",
      baseTemplateRef: "software-dev.template.issue-to-pr-style-todo-web",
      adaptationRules: [
        { condition: "requires browser verification", action: "add-checker", parameters: { capabilityRef: "software-dev.capability.browser-ux-verification" } },
      ],
      allowedAgentSpecRefs: [
        "software-dev.agent.explorer",
        "software-dev.agent.planner",
        "software-dev.agent.implementer",
        "software-dev.agent.checker",
        "software-dev.agent.summarizer",
      ],
      allowedCapabilityRefs: [
        "software-dev.capability.repo-read-write",
        "software-dev.capability.browser-ux-verification",
      ],
      maxTasks: 8,
      maxParallelTasks: 2,
    },
  },
];

export function seedSoftwareDevDesignLibrary(db: SouthstarDb, input: {
  actorType: Extract<LibraryActorType, "migration" | "system" | "user">;
}): { createdObjectIds: string[]; createdVersionIds: string[] } {
  const createdObjectIds: string[] = [];
  const createdVersionIds: string[] = [];

  for (const seed of seedObjects) {
    const existing = findLibraryObjectByKey(db, seed.objectKey);
    const objectId = existing?.objectId ?? createLibraryObject(db, {
      objectKey: seed.objectKey,
      objectKind: seed.objectKind,
      status: "approved",
      state: {
        tags: seed.tags,
        domainRefs: ["software"],
      },
      actorType: input.actorType,
    }).objectId;

    if (!existing) createdObjectIds.push(objectId);

    const versions = listLibraryVersions(db, objectId);
    if (versions.length > 0) continue;

    const versionId = `ver-${randomUUID()}`;
    appendVersionCreated(db, {
      objectId,
      definitionKind: seed.objectKind,
      versionId,
      payload: seed.payload,
      createdBy: input.actorType,
      status: "approved",
    });
    createdVersionIds.push(versionId);
  }

  const seededSkills = seedSoftwareDevSkills(db, { actorType: input.actorType });
  createdObjectIds.push(...seededSkills.createdObjectIds);
  createdVersionIds.push(...seededSkills.createdVersionIds);

  return { createdObjectIds, createdVersionIds };
}

function agentPayload(displayName: string, role: string, description: string): Record<string, unknown> {
  return {
    schemaVersion: "southstar.library.agent_spec.v1",
    identity: {
      displayName,
      description,
      domainRefs: ["software"],
      roleRefs: [role],
      capabilityTags: ["software"],
    },
    responsibilities: {
      goals: [description],
      nonGoals: ["Ignore validation policy"],
      stopAuthority: "can-suggest",
    },
    executionProfiles: [{
      id: "default",
      provider: "pi",
      model: "pi-default",
      harnessRef: "pi",
      complexityBand: "moderate",
      preferredFor: [role],
      fallbackFor: [],
      budget: {
        maxInputTokens: 12_000,
        maxOutputTokens: 4_000,
      },
    }],
    prompts: {
      system: `${displayName}: ${description}`,
      taskTemplates: [{ id: `${role}-task`, body: `Execute ${role} task with evidence output.` }],
      outputRules: ["Return contract-valid JSON"],
      safetyRules: ["Never leak secrets"],
    },
    capabilities: {
      skillRefs: [],
      mcpCapabilityRefs: [],
      requiredToolCapabilities: ["filesystem-read", "filesystem-write"],
      memoryScopes: ["software"],
    },
    policies: {
      workspacePolicyRef: "software-dev.policy.safe-workspace-tork",
    },
    contracts: {
      inputContractRefs: ["software-dev.contract.issue-input"],
      outputContractRefs: ["software-dev.contract.implementation-artifact"],
      evidenceContractRefs: ["software-dev.contract.implementation-artifact"],
      validatorRefs: ["software-dev.validator.schema-evidence-policy"],
    },
    provenance: {
      source: "seed",
      createdBy: "migration",
    },
  };
}
