export type PlannerRisk = "low" | "medium" | "high";
export type PlannerConfidence = "high" | "medium" | "low";
export type ReleaseMode = "none" | "commit-only" | "merge-ready" | "merge-and-release";

export type RequirementSpec = {
  summary: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
  repoPath?: string;
};

export type PlannerTaskDraft = {
  id: string;
  name: string;
  dependsOn: string[];
  agentDefinitionRef: string;
  agentProfileRef: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  artifactContractRefs: string[];
  evaluatorRef: string;
  rationale: string;
  conditional?: string;
  executionImage?: string;
};

export type GeneratedDraftComponent = {
  id: string;
  kind: "workflow_template" | "agent_definition" | "agent_profile" | "skill_definition" | "mcp_tool_grant" | "artifact_contract" | "evaluator_profile";
  risk: PlannerRisk;
  reason: string;
  validationStatus: "validated" | "unvalidated";
};

export type ClarificationRequest = {
  id: string;
  question: string;
  reason: string;
  blocksRun: boolean;
};

export type ApprovalRequestDraft = {
  id: string;
  actionType: string;
  riskTags: string[];
  reason: string;
};

export type PlannerRationale = {
  summary: string;
  templateReasons: Array<{ ref: string; score: number; reason: string }>;
  taskReasons: Array<{ taskId: string; reason: string }>;
  rejectedAlternatives: Array<{ ref: string; reason: string }>;
};

export type LibrarySearchTrace = {
  query: string;
  matchedRefs: string[];
  rejectedRefs: Array<{ ref: string; reason: string }>;
};

export type LibraryAwarePlannerResult = {
  schemaVersion: "southstar.library-aware-planner-result.v1";
  draftTitle: string;
  requirementSpec: RequirementSpec;
  selectedTemplateRefs: string[];
  confidence: PlannerConfidence;
  risk: PlannerRisk;
  releaseMode: ReleaseMode;
  tasks: PlannerTaskDraft[];
  rationale: PlannerRationale;
  generatedComponents: GeneratedDraftComponent[];
  requiredClarifications: ClarificationRequest[];
  requiredApprovals: ApprovalRequestDraft[];
  librarySearchTrace: LibrarySearchTrace;
};

export type PlannerValidationIssueCode =
  | "invalid_schema_version"
  | "missing_requirement_summary"
  | "no_template_selected"
  | "no_tasks"
  | "duplicate_task_id"
  | "unknown_dependency"
  | "dependency_cycle"
  | "unknown_workflow_template"
  | "unknown_agent_definition"
  | "unknown_agent_profile"
  | "unknown_skill"
  | "unknown_mcp_grant"
  | "unknown_artifact_contract"
  | "unknown_evaluator"
  | "unapproved_execution_image"
  | "readonly_agent_has_write_grant"
  | "write_task_missing_write_capability"
  | "high_risk_generated_component_requires_approval";

export type PlannerValidationIssue = {
  code: PlannerValidationIssueCode;
  path: string;
  message: string;
};

export type PlannerValidationResult = {
  ok: boolean;
  issues: PlannerValidationIssue[];
};
