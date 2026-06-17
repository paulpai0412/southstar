import assert from "node:assert/strict";
import test from "node:test";
import { validateLibraryPayload } from "../../src/v2/design-library/validators.ts";
import { validateWorkflowTemplateGraph } from "../../src/v2/design-library/template-validator.ts";
import type { WorkflowTemplatePayload } from "../../src/v2/design-library/types.ts";

test("validator accepts all seeded definition kind payloads", () => {
  const payloads = validPayloads();
  for (const [kind, payload] of Object.entries(payloads)) {
    const result = validateLibraryPayload(kind as Parameters<typeof validateLibraryPayload>[0], payload);
    assert.equal(result.ok, true, `${kind}: ${JSON.stringify(result.issues)}`);
  }
});

test("workflow template graph rejects cycles, missing producers, and raw transcript dependency", () => {
  const cyclic = validTemplate();
  cyclic.flow.edges.push({ id: "cycle", from: "checker", to: "implementer", edgeType: "depends_on", artifactContractRefs: ["software-dev.contract.verification-artifact"] });
  assert.equal(validateWorkflowTemplateGraph(cyclic).ok, false);

  const missingProducer = validTemplate();
  missingProducer.flow.edges[0] = { id: "bad", from: "unknown", to: "implementer", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.implementation-artifact"] };
  assert.match(JSON.stringify(validateWorkflowTemplateGraph(missingProducer).issues), /unknown|producer|node/i);

  const transcriptOnly = validTemplate();
  transcriptOnly.flow.nodes[1]!.contractRefs = ["raw_transcript"];
  assert.match(JSON.stringify(validateWorkflowTemplateGraph(transcriptOnly).issues), /raw transcript/i);
});

function validTemplate(): WorkflowTemplatePayload {
  return {
    schemaVersion: "southstar.library.workflow_template.v1",
    templateType: "exact",
    inputContractRef: "software-dev.contract.issue-input",
    flow: {
      primaryPattern: "maker_checker",
      secondaryPatterns: ["human_gate"],
      nodes: [
        { id: "planner", nodeType: "agent_task", name: "Planner", roleRef: "planner", agentSpecRef: "software-dev.agent.planner@1.0.0", contractRefs: ["software-dev.contract.issue-input"], validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"], capabilityRefs: ["software-dev.capability.repo-read-write@1.0.0"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork@1.0.0" },
        { id: "implementer", nodeType: "agent_task", name: "Implementer", roleRef: "implementer", agentSpecRef: "software-dev.agent.implementer@1.0.0", contractRefs: ["software-dev.contract.implementation-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"], capabilityRefs: ["software-dev.capability.repo-read-write@1.0.0"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork@1.0.0" },
        { id: "checker", nodeType: "agent_task", name: "Checker", roleRef: "checker", agentSpecRef: "software-dev.agent.checker@1.0.0", contractRefs: ["software-dev.contract.verification-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"], capabilityRefs: ["software-dev.capability.browser-ux-verification@1.0.0"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork@1.0.0" },
      ],
      edges: [
        { id: "planner-to-implementer", from: "planner", to: "implementer", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.implementation-artifact"], workspaceStateRequired: true },
        { id: "implementer-to-checker", from: "implementer", to: "checker", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.verification-artifact"], workspaceStateRequired: true },
      ],
      recovery: { onValidatorFailure: "request_workflow_revision", maxAttempts: 2 },
    },
    outputContractRefs: ["software-dev.contract.completion-artifact"],
    evidenceContractRefs: ["software-dev.contract.implementation-artifact", "software-dev.contract.verification-artifact"],
    stopConditionValidatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"],
    lifecycle: { status: "draft", validatedByRunIds: [], failureEvidenceRefs: [] },
    reuse: { signature: "software todo-web feature issue", tags: ["software", "todo-web"], requiredInputs: ["issueTitle", "issueBody", "repoPath"], assumptionDefaults: {}, clarificationPolicy: { askOnlyWhenMissingRequiredInput: true, askWhenSimilarityBelow: 0.85, askWhenRiskAbove: "low" }, requirementSpecSnapshot: { summary: "Todo-web feature", requiredInputs: ["issueTitle", "issueBody", "repoPath"], clarifiedInputs: {}, assumptions: [], acceptanceCriteria: ["tests pass"], nonGoals: [], riskNotes: [] } },
  };
}

function validPayloads(): Record<string, unknown> {
  return {
    agent_spec: { schemaVersion: "southstar.library.agent_spec.v1", identity: { displayName: "Checker", description: "Checks", domainRefs: ["software"], roleRefs: ["checker"], capabilityTags: ["browser"] }, responsibilities: { goals: ["verify"], nonGoals: ["merge"], stopAuthority: "can-reject" }, executionProfiles: [{ id: "default", provider: "pi", model: "pi-default", harnessRef: "pi", complexityBand: "moderate", preferredFor: ["verification"], fallbackFor: [], budget: { maxInputTokens: 8000, maxOutputTokens: 2000 } }], prompts: { system: "Verify feature", taskTemplates: [{ id: "verify", body: "Verify {{issueTitle}}" }], outputRules: ["JSON"], safetyRules: ["No secrets"] }, capabilities: { skillRefs: [], mcpCapabilityRefs: [], requiredToolCapabilities: [], memoryScopes: [] }, policies: {}, contracts: { inputContractRefs: [], outputContractRefs: [], evidenceContractRefs: [], validatorRefs: [] }, provenance: { source: "seed", createdBy: "migration" } },
    capability_spec: { schemaVersion: "southstar.library.capability_spec.v1", capabilityType: "tool_capability", title: "Browser", description: "Browser verification", requiredMounts: [], requiredOperations: ["open-page"], risk: { level: "low", dataSensitivity: "workspace", approvalRequired: false }, contractRefs: [], validatorRefs: [], provenance: { source: "seed", createdBy: "migration" } },
    contract_spec: { schemaVersion: "southstar.library.contract_spec.v1", contractType: "output", fields: [{ name: "summary", type: "string", required: true, description: "Summary" }], evidenceRequirements: [{ kind: "test-result", required: true, description: "Tests" }], artifactType: "implementation_result" },
    validator_spec: { schemaVersion: "southstar.library.validator_spec.v1", validatorType: "pipeline", config: {}, required: true, failureStrategy: "request-workflow-revision", appliesToContractRefs: [], steps: [] },
    policy_bundle: { schemaVersion: "southstar.library.policy_bundle.v1", policyTypes: ["tool"], tool: { allowedTools: ["bash", "read", "edit"], deniedTools: ["secret-read"], requiresApprovalFor: [], networkPolicy: "none", filesystemPolicy: "workspace-write", shellPolicy: "workspace-shell" } },
    workflow_template: validTemplate(),
    workflow_recipe: { schemaVersion: "southstar.library.workflow_recipe.v1", baseTemplateRef: "software-dev.template.issue-to-pr-style-todo-web@1.0.0", adaptationRules: [{ condition: "requires browser evidence", action: "add-checker", parameters: { capability: "browser" } }], allowedAgentSpecRefs: ["software-dev.agent.checker@1.0.0"], allowedCapabilityRefs: ["software-dev.capability.browser-ux-verification@1.0.0"], maxTasks: 8, maxParallelTasks: 2 },
    skill_spec: {
      schemaVersion: "southstar.library.skill_spec.v1",
      skillType: "specialized",
      title: "Checker Verification",
      description: "Verify implementation outputs and return verification artifact.",
      baseSkillRef: "software-dev.skill.artifact-generator-base",
      instructions: {
        format: "markdown",
        content: "# Checker Verification Skill\n\nReturn contract-valid JSON.",
      },
      domainRefs: ["software"],
      roleRefs: ["checker"],
      taskRefs: ["checker"],
      contractRefs: ["software-dev.contract.verification-artifact"],
      designedFor: ["pi-agent"],
      allowedTools: ["read", "search", "shell"],
      requiredMounts: ["/workspace/repo"],
      mcpRequirements: [],
      fieldGuidance: {
        summary: {
          sectionId: "#field-summary",
          description: "Brief summary",
          dataType: "string",
          generationSteps: ["Summarize verification"],
          example: "All checks passed",
          validation: ["Must be non-empty"],
        },
      },
      repairGuidance: {
        template: "Missing fields: {missingFieldsList}",
        fieldReferenceFormat: "- {field} -> {sectionId}: {description}",
      },
      provenance: { source: "seed", createdBy: "migration" },
    },
  };
}
