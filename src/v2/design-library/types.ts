export type LibraryDefinitionKind =
  | "agent_spec"
  | "agent_definition"
  | "agent_profile"
  | "skill_definition"
  | "mcp_tool_grant"
  | "artifact_contract"
  | "evaluator_profile"
  | "capability_spec"
  | "contract_spec"
  | "validator_spec"
  | "policy_bundle"
  | "workflow_template"
  | "workflow_recipe";

export type LibraryActorType = "user" | "system" | "migration" | "llm" | "validator" | "runtime";

export type LibraryDefinitionStatus = "draft" | "approved" | "deprecated" | "blocked";

export type LibraryDraftStatus = "draft" | "invalid" | "valid" | "approved_for_run" | "rejected";

export type DefinitionProvenance = {
  source: "seed" | "user" | "llm-proposal" | "migration" | "runtime-evidence";
  createdBy: LibraryActorType;
  sourceRefs?: string[];
};

export type RequirementSpec = {
  summary: string;
  requiredInputs: string[];
  clarifiedInputs: Record<string, unknown>;
  assumptions: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  riskNotes: string[];
};

export type WorkflowTemplateNode = {
  id: string;
  nodeType: "agent_task" | "validator_task" | "human_gate" | "decision" | "fan_in" | "artifact_transform" | "template_operation";
  name: string;
  roleRef?: string;
  agentSpecRef?: string;
  executionProfileSelector?: { complexityBand: string; preferredProfileId?: string };
  contractRefs: string[];
  validatorRefs: string[];
  capabilityRefs: string[];
  mcpCapabilityRefs: string[];
  workspacePolicyRef?: string;
};

export type WorkflowTemplateEdge = {
  id: string;
  from: string;
  to: string;
  edgeType: "depends_on" | "artifact_flow" | "approval_gate" | "decision_path" | "fan_in";
  artifactContractRefs: string[];
  workspaceStateRequired?: boolean;
  condition?: string;
};

export type WorkflowTemplatePatch = {
  baseDraftId: string;
  operations: Array<
    | { op: "add-node"; node: WorkflowTemplateNode }
    | { op: "remove-node"; nodeId: string }
    | { op: "update-node"; nodeId: string; patch: Record<string, unknown> }
    | { op: "add-edge"; edge: WorkflowTemplateEdge }
    | { op: "remove-edge"; edgeId: string }
    | { op: "replace-agent"; nodeId: string; agentSpecRef: string }
    | { op: "set-contracts"; nodeId: string; contractRefs: string[] }
    | { op: "set-validators"; nodeId: string; validatorRefs: string[] }
  >;
  rationale: string;
  actor: "llm" | "user" | "system";
};

export type WorkflowTemplatePayload = {
  schemaVersion: "southstar.library.workflow_template.v1";
  templateType: "exact";
  inputContractRef: string;
  flow: {
    primaryPattern: string;
    secondaryPatterns: string[];
    nodes: WorkflowTemplateNode[];
    edges: WorkflowTemplateEdge[];
    fanIns?: Array<{
      nodeId: string;
      strategy: "all-pass" | "majority" | "best-candidate" | "checker-arbitrated";
      requiredInputs: string[];
    }>;
    recovery: { onValidatorFailure: string; maxAttempts: number };
  };
  outputContractRefs: string[];
  evidenceContractRefs: string[];
  stopConditionValidatorRefs: string[];
  lifecycle: {
    status: "draft" | "approved_for_run" | "validated" | "deprecated" | "blocked";
    validatedByRunIds: string[];
    failureEvidenceRefs: string[];
  };
  reuse: {
    signature: string;
    tags: string[];
    requiredInputs: string[];
    assumptionDefaults: Record<string, unknown>;
    clarificationPolicy: {
      askOnlyWhenMissingRequiredInput: boolean;
      askWhenSimilarityBelow: number;
      askWhenRiskAbove: "low" | "medium" | "high";
    };
    requirementSpecSnapshot: RequirementSpec;
  };
};

export type TemplateMatchResult = {
  templateVersionRef: string;
  confidence: number;
  missingInputs: string[];
  risk: "low" | "medium" | "high";
  reason: string;
  clarificationQuestionCount: number;
};

export type LibraryValidationResult = {
  ok: boolean;
  issues: Array<{ path: string; message: string; code?: string }>;
};
