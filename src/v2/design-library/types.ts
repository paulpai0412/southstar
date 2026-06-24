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
  | "workflow_recipe"
  | "tool_definition"
  | "instruction_template"
  | "vault_lease_policy"
  | "skill_spec";

export type LibraryActorType = "user" | "system" | "migration" | "llm" | "validator" | "runtime";

export type LibraryDefinitionStatus = "draft" | "approved" | "deprecated" | "blocked";

export type LibraryDraftStatus = "draft" | "invalid" | "valid" | "approved_for_run" | "rejected";

export type LibraryEdgeType =
  | "implements"
  | "provides_capability"
  | "requires_capability"
  | "supports_skill"
  | "requires_skill"
  | "allows_tool"
  | "requires_tool"
  | "uses_instruction"
  | "requires_secret_group"
  | "allows_mcp_grant"
  | "produces_artifact"
  | "consumes_artifact"
  | "validates_artifact"
  | "uses_policy"
  | "part_of_template"
  | "supersedes"
  | "blocked_by";

export type LibraryObjectSummary = {
  id: string;
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  headVersionId: string | null;
  state: Record<string, unknown>;
};

export type LibraryEdgeRecord = {
  id: string;
  fromObjectKey: string;
  fromVersionRef: string | null;
  edgeType: LibraryEdgeType;
  toObjectKey: string;
  toVersionRef: string | null;
  scope: string;
  status: "active" | "inactive" | "blocked";
  weight: number;
  metadata: Record<string, unknown>;
};

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

export type SkillFieldGuidance = {
  sectionId: string;
  description: string;
  dataType: "string" | "array" | "object" | "boolean" | "number";
  generationSteps: string[];
  example: unknown;
  validation: string[];
};

export type SkillRepairGuidance = {
  template: string;
  fieldReferenceFormat: string;
};

export type SkillSpecPayload = {
  schemaVersion: "southstar.library.skill_spec.v1";
  skillType: "base" | "specialized";
  title: string;
  description: string;
  baseSkillRef?: string;
  instructions: {
    format: "markdown";
    content: string;
  };
  domainRefs: string[];
  roleRefs?: string[];
  taskRefs?: string[];
  contractRefs?: string[];
  designedFor: Array<"pi-agent" | "codex" | "opencode">;
  allowedTools: string[];
  requiredMounts: string[];
  mcpRequirements: string[];
  fieldGuidance?: Record<string, SkillFieldGuidance>;
  repairGuidance?: SkillRepairGuidance;
  provenance: DefinitionProvenance;
};

export type RequirementSpecV2 = {
  summary: string;
  workType: "software_feature" | "bugfix" | "research" | "data_analysis" | "migration" | "ops_recovery" | "general";
  requiredCapabilities: string[];
  expectedArtifacts: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  riskNotes: string[];
  workspaceAssumptions: string[];
  missingInputs: string[];
};

export type CandidateSummary = {
  ref: string;
  versionRef: string | null;
  kind: LibraryDefinitionKind;
  displayName: string;
  state: Record<string, unknown>;
  reason: string;
};

export type CandidatePacket = {
  requirementSpec: RequirementSpecV2;
  workflowTemplateCandidates: CandidateSummary[];
  agentCandidatesByCapability: Record<string, CandidateSummary[]>;
  profileCandidatesByAgent: Record<string, CandidateSummary[]>;
  skillCandidatesByProfile: Record<string, CandidateSummary[]>;
  toolCandidatesByProfile: Record<string, CandidateSummary[]>;
  mcpGrantCandidatesByProfile: Record<string, CandidateSummary[]>;
  vaultLeaseCandidatesByProfile: Record<string, CandidateSummary[]>;
  instructionCandidatesByProfile: Record<string, CandidateSummary[]>;
  artifactContractCandidates: CandidateSummary[];
  evaluatorCandidatesByArtifact: Record<string, CandidateSummary[]>;
  policyConstraints: CandidateSummary[];
  unavailableRequirements: Array<{
    capabilityRef: string;
    reason: "no_approved_candidate" | "blocked_by_policy" | "requires_approval";
  }>;
};

export type GeneratedComponentProposal = {
  id: string;
  kind: LibraryDefinitionKind;
  risk: "low" | "medium" | "high";
  reason: string;
  validationStatus: "validated" | "unvalidated";
};

export type WorkflowCompositionTask = {
  id: string;
  name: string;
  responsibility: string;
  dependsOn: string[];
  templateSlotRef: string;
  agentDefinitionRef: string;
  agentProfileRef: string;
  instructionRefs: string[];
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
  inputArtifactRefs: string[];
  outputArtifactRefs: string[];
  evaluatorProfileRef: string;
  contextPolicyRef?: string;
  workspacePolicyRef?: string;
  recoveryStrategyRefs: string[];
  rationale: string;
};

export type WorkflowCompositionPlan = {
  schemaVersion: "southstar.workflow_composition_plan.v1";
  title: string;
  selectedWorkflowTemplateRef: string;
  rationale: string;
  tasks: WorkflowCompositionTask[];
  rejectedCandidates: Array<{ ref: string; reason: string }>;
  generatedComponentProposals: GeneratedComponentProposal[];
};

export type WorkflowCompositionPatch = {
  schemaVersion: "southstar.workflow_composition_patch.v1";
  basePlanHash: string;
  operations: Array<
    | { op: "replace-task"; taskId: string; task: WorkflowCompositionTask }
    | { op: "remove-task"; taskId: string }
    | { op: "add-task"; task: WorkflowCompositionTask }
    | { op: "replace-ref"; taskId: string; field: keyof WorkflowCompositionTask; fromRef: string; toRef: string }
  >;
  rationale: string;
};

export type WorkflowCompositionValidationIssueCode =
  | "invalid_schema_version"
  | "unknown_template"
  | "duplicate_task_id"
  | "unknown_dependency"
  | "dependency_cycle"
  | "ref_not_in_candidate_packet"
  | "profile_does_not_implement_agent"
  | "profile_does_not_allow_skill"
  | "profile_does_not_allow_tool"
  | "profile_does_not_allow_mcp"
  | "profile_does_not_allow_vault_lease"
  | "profile_does_not_allow_instruction"
  | "agent_does_not_produce_artifact"
  | "input_artifact_not_satisfied"
  | "template_slot_not_allowed"
  | "policy_conflict"
  | "evaluator_does_not_validate_artifact"
  | "generated_component_selected";

export type WorkflowCompositionValidationIssue = {
  code: WorkflowCompositionValidationIssueCode;
  path: string;
  message: string;
};

export type WorkflowCompositionValidationResult = {
  ok: boolean;
  issues: WorkflowCompositionValidationIssue[];
};
