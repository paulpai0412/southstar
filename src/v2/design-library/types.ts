export type LibraryDefinitionKind =
  | "agent_spec"
  | "agent_definition"
  | "agent_profile"
  | "skill_definition"
  | "domain_taxonomy"
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
  | "blocked_by"
  | "belongs_to_domain"
  | "has_capability"
  | "provides"
  | "uses"
  | "requires"
  | "conflicts_with"
  | "precedes"
  | "workflow_precedes"
  | "unblocks"
  | "validates"
  | "reviews"
  | "produces"
  | "consumes"
  | "similar_to"
  | "substitutes"
  | "complements"
  | "incompatible_with"
  | "requires_approval"
  | "requires_secret";

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
  agentProfileRef?: string;
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
    | { op: "replace-agent"; nodeId: string; agentProfileRef: string }
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

/** Verification modes that a reusable evaluator profile may explicitly support. */
export type RequirementValidationMode =
  | "deterministic"
  | "browser_interaction"
  | "semantic_review"
  | "human_approval";

export type RequirementCoverageCandidateV1 = {
  ref: string;
  versionRef: string;
  reason: string;
};

export type RequirementCoveragePreviewV1 = {
  schemaVersion: "southstar.requirement_coverage_preview.v1";
  requirementId: string;
  status: "ready" | "partial" | "missing" | "manual";
  artifactCandidates: RequirementCoverageCandidateV1[];
  evaluatorCandidates: RequirementCoverageCandidateV1[];
  missingKinds: Array<"artifact" | "evaluator" | "capability" | "domain">;
  criterionIds: string[];
  acceptanceCriteria: string[];
};

export type RequirementValidationBindingV1 = {
  schemaVersion: "southstar.requirement_validation_binding.v1";
  id: string;
  requirementId: string;
  criterionIds: string[];
  acceptanceCriteria: string[];
  artifactContractRefs: string[];
  artifactContractVersionRefs: string[];
  evaluatorProfileRef: string;
  evaluatorProfileVersionRef: string;
  verificationMode: RequirementValidationMode;
  criterionChecks: Array<{
    criterionId: string;
    procedureRef: string;
    expectedEvidenceKinds: string[];
  }>;
  requiredEvidenceKinds: string[];
  independence: "independent";
  failureClassifications: string[];
};

export type GoalValidationGapKind =
  | "artifact"
  | "evaluator"
  | "capability"
  | "domain"
  | "criteria"
  | "version"
  | "edge"
  | "procedure"
  | "evidence"
  | "independence"
  | "manual";

export type GoalValidationGapV1 = {
  schemaVersion: "southstar.goal_validation_gap.v1";
  kind: GoalValidationGapKind;
  requirementId: string;
  criterionIds: string[];
  requestedRef?: string;
  blocking: boolean;
  message: string;
  candidateRefs: string[];
};

export type GoalValidationResolutionV1 = {
  schemaVersion: "southstar.goal_validation_resolution.v1";
  goalContractHash: string;
  requirementDraftHash: string;
  previews: RequirementCoveragePreviewV1[];
  bindings: RequirementValidationBindingV1[];
  gaps: GoalValidationGapV1[];
  resolutionHash: string;
};

export type GraphMetadataNodeCandidate = {
  ref: string;
  kind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  versionRef: string | null;
  scope: string;
  title: string;
  description?: string;
  aliases: string[];
  bodyPreview?: string;
  runtime?: Record<string, unknown>;
};

export type GraphMetadataEdgeCandidate = {
  from: string;
  type: LibraryEdgeType;
  to: string;
  scope: string;
  weight: number;
  rationale?: string;
};

export type GraphMetadataCandidatePacket = {
  schemaVersion: "southstar.graph_metadata_candidates.v1";
  scope: string;
  nodes: GraphMetadataNodeCandidate[];
  edges: GraphMetadataEdgeCandidate[];
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
  profilePrimitiveCandidates?: {
    agents: string[];
    skills: string[];
    tools: string[];
    mcpGrants: string[];
    instructions: string[];
  };
  graphMetadataCandidates?: GraphMetadataCandidatePacket;
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
  agentProfile?: GeneratedAgentProfile;
};

export type GeneratedAgentProfile = {
  workerKind?: "execution_worker" | "validation_worker" | "repair_worker" | "review_worker";
  provider?: "pi" | "codex" | "claude-code" | "openai" | "anthropic" | "custom";
  model?: string;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | string;
  harnessRef?: "pi" | "codex";
  instruction?: string;
  promptTemplateRef?: string;
  contextPolicyRef?: string;
  sessionPolicyRef?: string;
  memoryScopes?: string[];
  agentsMdRefs?: string[];
  vaultLeasePolicyRefs?: string[];
  toolPolicy?: {
    allowedTools?: string[];
    deniedTools?: string[];
    requiresApprovalFor?: string[];
  };
  budgetPolicy?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxCostMicrosUsd?: number;
    maxWallTimeSeconds?: number;
  };
  execution?: {
    engine?: "tork";
    image?: string;
    command?: string[];
    env?: Record<string, string>;
    mounts?: Array<{
      source?: string;
      target?: string;
      readonly?: boolean;
    }>;
    timeoutSeconds?: number;
    infraRetry?: {
      maxAttempts?: number;
    };
  };
};

export type WorkflowCompositionTask = {
  id: string;
  sliceId?: string;
  name: string;
  responsibility: string;
  requirementIds: string[];
  nodePromptSpec?: WorkflowNodePromptSpec;
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

export type WorkflowNodePromptSpec = {
  nodeType: WorkflowNodePromptType;
  goal: string;
  requirements: string[];
  boundaries: string[];
  nonGoals: string[];
  deliverableDocuments: WorkflowNodeDeliverableDocument[];
  expectedOutputs: string[];
  testCases: WorkflowNodePromptTestCase[];
  acceptanceCriteria: string[];
  failureReportContract?: string;
  planningQuestions?: string[];
  decisionCriteria?: string[];
  planArtifactContract?: string;
  implementationScope?: string[];
  filesLikelyToTouch?: string[];
  verificationChecks?: string[];
  failureArtifactContract?: string;
  repairInputs?: string[];
  mustPreserve?: string[];
  reverificationChecks?: string[];
  reviewChecklist?: string[];
  riskCriteria?: string[];
  summarySections?: string[];
  handoffCriteria?: string[];
};

export type WorkflowNodeDeliverableDocument = {
  kind: "design" | "implementation" | "test" | "acceptance" | "verification" | "summary" | "handoff" | "other";
  title: string;
  required: boolean;
  format: "markdown" | "json" | "file" | "inline";
  description: string;
};

export type WorkflowNodePromptType = "plan" | "implement" | "verify" | "repair" | "review" | "summary" | "general";

export type WorkflowNodePromptTestCase = {
  name: string;
  command?: string;
  expected: string;
  given?: string;
  when?: string;
  then?: string;
};

export type WorkflowCompositionPlan = {
  schemaVersion: "southstar.workflow_composition_plan.v1";
  title: string;
  selectedWorkflowTemplateRef?: string;
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
  | "composer_output_too_large"
  | "composer_output_non_json"
  | "composer_output_invalid_json"
  | "composer_output_schema_violation"
  | "invalid_schema_version"
  | "unknown_template"
  | "required_template_mismatch"
  | "duplicate_task_id"
  | "unknown_dependency"
  | "dependency_cycle"
  | "unknown_slice_id"
  | "requirement_not_owned_by_slice"
  | "slice_without_producer"
  | "slice_without_evaluator"
  | "slice_plan_revision_required"
  | "producer_dependency_without_artifact_flow"
  | "missing_required_task_group"
  | "insufficient_task_group_count"
  | "missing_required_group_dependency"
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
  | "conflicting_refs"
  | "evaluator_does_not_validate_artifact"
  | "generated_component_selected"
  | "agent_does_not_use_skill"
  | "generated_profile_missing_agent_profile"
  | "generated_profile_incomplete_agent_profile"
  | "generated_profile_invalid_value"
  | "target_requirement_scope_empty"
  | "unknown_target_requirement_id"
  | "requirement_outside_target_scope"
  | "unknown_requirement_id"
  | "requirement_missing_producer"
  | "requirement_missing_artifact"
  | "requirement_missing_evaluator"
  | "requirement_evaluator_not_independent"
  | "requirement_missing_evidence"
  | "task_without_requirement_coverage";

export type WorkflowCompositionValidationIssue = {
  code: WorkflowCompositionValidationIssueCode;
  path: string;
  message: string;
};

export type WorkflowCompositionValidationResult = {
  ok: boolean;
  issues: WorkflowCompositionValidationIssue[];
};
