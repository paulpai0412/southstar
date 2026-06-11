export type WorkflowValidationErrorCode =
  | "WORKFLOW_FIELD_REQUIRED"
  | "WORKFLOW_FIELD_TYPE"
  | "WORKFLOW_EMPTY_COLLECTION"
  | "WORKFLOW_INVALID_RUN_MODE"
  | "WORKFLOW_UNKNOWN_ROLE"
  | "WORKFLOW_UNKNOWN_STAGE_TARGET"
  | "WORKFLOW_UNKNOWN_LIFECYCLE_STATE"
  | "WORKFLOW_UNKNOWN_ARTIFACT_SCHEMA"
  | "WORKFLOW_RETRY_CYCLE_WITHOUT_POLICY"
  | "WORKFLOW_UNSUPPORTED_HOST_CAPABILITY"
  | "WORKFLOW_EXCEPTION_POLICY_INVALID_RULE"
  | "WORKFLOW_EXCEPTION_POLICY_INVALID_MATCH_FIELD"
  | "WORKFLOW_EXCEPTION_POLICY_INVALID_ACTION"
  | "WORKFLOW_EXCEPTION_POLICY_MISSING_TARGET_STAGE"
  | "WORKFLOW_EXCEPTION_POLICY_UNKNOWN_TARGET_STAGE";

export class WorkflowValidationError extends Error {
  readonly code: WorkflowValidationErrorCode;
  readonly path: string;

  constructor(
    code: WorkflowValidationErrorCode,
    path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "WorkflowValidationError";
    this.code = code;
    this.path = path;
  }
}

export function workflowValidationError(
  code: WorkflowValidationErrorCode,
  path: string,
  message: string,
): WorkflowValidationError {
  return new WorkflowValidationError(code, path, message);
}
