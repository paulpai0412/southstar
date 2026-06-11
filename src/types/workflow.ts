import { readFileSync } from "node:fs";
import { parseYamlSubset } from "../config/load-config.ts";
import { lifecycleStates } from "./control-plane.ts";
import { WorkflowValidationError, workflowValidationError } from "./workflow-validation.ts";

export { WorkflowValidationError } from "./workflow-validation.ts";

const builtInArtifactSchemas = new Set([
  "worker_result",
  "evidence_packet",
  "implementation_result",
  "verification_result",
  "release_result",
  "acceptance_packet",
]);

const exceptionMatchFields = new Set([
  "source_stage",
  "source_role",
  "artifact_kind",
  "status",
  "category",
  "severity",
  "retryable",
  "summary",
]);

const exceptionActionTypes = new Set([
  "retry_same_stage",
  "retry_stage",
  "return_to_stage",
  "quarantine",
  "fail",
]);

const validRunModes = new Set(["root", "background_child", "manual_gate"]);
const hostCapabilityRoleFields = new Set(["agent", "model", "load_skills", "timeout_seconds", "retry_policy", "prompt_template"]);

export interface RetryPolicy {
  max_attempts: number;
  backoff_seconds: number[];
}

export interface RoleDefinition {
  run_mode: string;
  agent: string;
  model?: string;
  load_skills: string[];
  prompt_template?: string;
  artifact?: string;
  timeout_seconds: number;
  retry_policy?: RetryPolicy;
}

export interface StageDefinition {
  lifecycle_state: string;
  role: string;
  on_success?: string;
  on_pass?: string;
  on_blocked?: string;
  on_blocked_transient?: string;
  on_failed_retryable?: string;
  on_failed_terminal?: string;
  on_fail_retryable?: string;
  on_fail_terminal?: string;
}

export interface ArtifactSchemaDefinition {
  required_fields: string[];
}

export interface EventMappingDefinition {
  runtime_event: string;
  [key: string]: unknown;
}

export interface EffectDefinition {
  adapter: string;
  retryable: boolean;
  [key: string]: unknown;
}

export interface ProjectionTargetDefinition {
  adapter: string;
  [key: string]: unknown;
}

export type ExceptionMatchField =
  | "source_stage"
  | "source_role"
  | "artifact_kind"
  | "status"
  | "category"
  | "severity"
  | "retryable"
  | "summary";

export type ExceptionActionType =
  | "retry_same_stage"
  | "retry_stage"
  | "return_to_stage"
  | "quarantine"
  | "fail";

export interface ExceptionPolicyActionDefinition {
  type: ExceptionActionType;
  target_stage?: string;
  carry_forward?: string[];
}

export interface ExceptionPolicyRuleDefinition {
  name: string;
  match: Partial<Record<ExceptionMatchField, string | boolean>>;
  action: ExceptionPolicyActionDefinition;
  on_exhausted?: { type: "quarantine" | "fail" };
}

export interface ExceptionPolicyDefinition {
  max_recovery_attempts_from?: "runtime.max_recovery_attempts";
  rules: ExceptionPolicyRuleDefinition[];
  default: { action: ExceptionPolicyActionDefinition };
}

export interface WorkflowDefinition {
  id: string;
  version: string;
  domain?: string;
  roles: Record<string, RoleDefinition>;
  stages: Record<string, StageDefinition>;
  artifact_schemas?: Record<string, ArtifactSchemaDefinition>;
  event_mappings?: Record<string, EventMappingDefinition>;
  effects?: Record<string, EffectDefinition>;
  projection_targets?: Record<string, ProjectionTargetDefinition>;
  exception_policy?: ExceptionPolicyDefinition;
}

export interface WorkflowValidationOptions {
  hostCapabilities?: {
    run_modes?: string[];
    role_fields?: string[];
  };
}

export interface WorkflowOverrides {
  roles?: Record<string, Partial<RoleDefinition>>;
}

export function loadWorkflow(path: string, options: WorkflowValidationOptions = {}): WorkflowDefinition {
  const parsed = parseYamlSubset(readFileSync(path, "utf8"));
  const workflow = getRecord(parsed, "workflow");
  return validateWorkflow(workflow, options);
}

export function validateWorkflow(value: unknown, options: WorkflowValidationOptions = {}): WorkflowDefinition {
  const workflow = getRecordValue(value);
  const id = stringValue(workflow.id, "workflow.id");
  const version = stringValue(workflow.version, "workflow.version");
  const domain = optionalStringValue(workflow.domain, "workflow.domain");
  const roles = getRecordValue(workflow.roles, "workflow.roles");
  const stages = getRecordValue(workflow.stages, "workflow.stages");
  const artifactSchemas = normalizeArtifactSchemas(workflow.artifact_schemas);
  const eventMappings = normalizeRecordOfRecords<EventMappingDefinition>(workflow.event_mappings, "workflow.event_mappings");
  const effects = normalizeRecordOfRecords<EffectDefinition>(workflow.effects, "workflow.effects");
  const projectionTargets = normalizeRecordOfRecords<ProjectionTargetDefinition>(workflow.projection_targets, "workflow.projection_targets");

  if (Object.keys(roles).length === 0) {
    throw workflowValidationError("WORKFLOW_EMPTY_COLLECTION", "workflow.roles", "workflow.roles must not be empty");
  }
  if (Object.keys(stages).length === 0) {
    throw workflowValidationError("WORKFLOW_EMPTY_COLLECTION", "workflow.stages", "workflow.stages must not be empty");
  }

  const normalizedRoles: Record<string, RoleDefinition> = {};
  const supportedRunModes = new Set(options.hostCapabilities?.run_modes ?? [...validRunModes]);
  const supportedRoleFields = new Set(options.hostCapabilities?.role_fields ?? [...hostCapabilityRoleFields]);
  for (const [name, role] of Object.entries(roles)) {
    const roleRecord = getRecordValue(role, `workflow.roles.${name}`);
    for (const key of Object.keys(roleRecord)) {
      if (hostCapabilityRoleFields.has(key) && !supportedRoleFields.has(key)) {
        throw workflowValidationError(
          "WORKFLOW_UNSUPPORTED_HOST_CAPABILITY",
          `workflow.roles.${name}.${key}`,
          `selected host adapter does not support role field ${key}`,
        );
      }
    }
    const runMode = stringValue(roleRecord.run_mode, `workflow.roles.${name}.run_mode`);
    if (!validRunModes.has(runMode)) {
      throw workflowValidationError(
        "WORKFLOW_INVALID_RUN_MODE",
        `workflow.roles.${name}.run_mode`,
        `unsupported run mode ${runMode}`,
      );
    }
    if (!supportedRunModes.has(runMode)) {
      throw workflowValidationError(
        "WORKFLOW_UNSUPPORTED_HOST_CAPABILITY",
        `workflow.roles.${name}.run_mode`,
        `selected host adapter does not support run mode ${runMode}`,
      );
    }
    const artifact = optionalStringValue(roleRecord.artifact, `workflow.roles.${name}.artifact`);
    if (artifact && !builtInArtifactSchemas.has(artifact) && !artifactSchemas[artifact]) {
      throw workflowValidationError(
        "WORKFLOW_UNKNOWN_ARTIFACT_SCHEMA",
        `workflow.roles.${name}.artifact`,
        `artifact schema ${artifact} is not declared`,
      );
    }
    normalizedRoles[name] = {
      run_mode: runMode,
      agent: stringValue(roleRecord.agent, `workflow.roles.${name}.agent`),
      model: optionalStringValue(roleRecord.model, `workflow.roles.${name}.model`),
      load_skills: stringArrayValue(roleRecord.load_skills, `workflow.roles.${name}.load_skills`),
      prompt_template: optionalStringValue(roleRecord.prompt_template, `workflow.roles.${name}.prompt_template`),
      artifact,
      timeout_seconds: numberValue(roleRecord.timeout_seconds, `workflow.roles.${name}.timeout_seconds`),
      retry_policy: normalizeRetryPolicy(roleRecord.retry_policy, `workflow.roles.${name}.retry_policy`),
    };
  }

  const normalizedStages: Record<string, StageDefinition> = {};
  for (const [name, stage] of Object.entries(stages)) {
    const stageRecord = getRecordValue(stage, `workflow.stages.${name}`);
    const role = stringValue(stageRecord.role, `workflow.stages.${name}.role`);
    if (!normalizedRoles[role]) {
      throw workflowValidationError(
        "WORKFLOW_UNKNOWN_ROLE",
        `workflow.stages.${name}.role`,
        `stage references unknown role ${role}`,
      );
    }
    const lifecycleState = stringValue(stageRecord.lifecycle_state, `workflow.stages.${name}.lifecycle_state`);
    if (!lifecycleStates.includes(lifecycleState)) {
      throw workflowValidationError(
        "WORKFLOW_UNKNOWN_LIFECYCLE_STATE",
        `workflow.stages.${name}.lifecycle_state`,
        `unknown lifecycle state ${lifecycleState}`,
      );
    }
    normalizedStages[name] = {
      lifecycle_state: lifecycleState,
      role,
      on_success: optionalStringValue(stageRecord.on_success, `workflow.stages.${name}.on_success`),
      on_pass: optionalStringValue(stageRecord.on_pass, `workflow.stages.${name}.on_pass`),
      on_blocked: optionalStringValue(stageRecord.on_blocked, `workflow.stages.${name}.on_blocked`),
      on_blocked_transient: optionalStringValue(stageRecord.on_blocked_transient, `workflow.stages.${name}.on_blocked_transient`),
      on_failed_retryable: optionalStringValue(stageRecord.on_failed_retryable, `workflow.stages.${name}.on_failed_retryable`),
      on_failed_terminal: optionalStringValue(stageRecord.on_failed_terminal, `workflow.stages.${name}.on_failed_terminal`),
      on_fail_retryable: optionalStringValue(stageRecord.on_fail_retryable, `workflow.stages.${name}.on_fail_retryable`),
      on_fail_terminal: optionalStringValue(stageRecord.on_fail_terminal, `workflow.stages.${name}.on_fail_terminal`),
    };
  }

  validateStageTransitions(normalizedStages, normalizedRoles);
  const exceptionPolicy = normalizeExceptionPolicy(workflow.exception_policy, normalizedStages);

  return {
    id,
    version,
    domain,
    roles: normalizedRoles,
    stages: normalizedStages,
    artifact_schemas: Object.keys(artifactSchemas).length > 0 ? artifactSchemas : undefined,
    event_mappings: Object.keys(eventMappings).length > 0 ? eventMappings : undefined,
    effects: Object.keys(effects).length > 0 ? effects : undefined,
    projection_targets: Object.keys(projectionTargets).length > 0 ? projectionTargets : undefined,
    exception_policy: exceptionPolicy,
  };
}

export function resolveWorkflowRoles(
  workflow: WorkflowDefinition,
  overrides?: WorkflowOverrides,
): Record<string, RoleDefinition> {
  const roles = structuredClone(workflow.roles) as Record<string, RoleDefinition>;

  for (const [roleName, override] of Object.entries(overrides?.roles ?? {})) {
    if (!roles[roleName]) {
      continue;
    }
    roles[roleName] = {
      ...roles[roleName],
      ...override,
      load_skills: override.load_skills ?? roles[roleName].load_skills,
      prompt_template: override.prompt_template ?? roles[roleName].prompt_template,
      retry_policy: override.retry_policy ?? roles[roleName].retry_policy,
    };
  }

  return roles;
}

function normalizeRetryPolicy(value: unknown, field: string): RetryPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = getRecordValue(value, field);
  return {
    max_attempts: numberValue(record.max_attempts, `${field}.max_attempts`),
    backoff_seconds: numberArrayValue(record.backoff_seconds, `${field}.backoff_seconds`),
  };
}

function getRecord(value: unknown, key: string): Record<string, unknown> {
  const record = getRecordValue(value);
  return getRecordValue(record[key], key);
}

function getRecordValue(value: unknown, field = "value"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw workflowValidationError("WORKFLOW_FIELD_TYPE", field, `${field} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw workflowValidationError("WORKFLOW_FIELD_REQUIRED", field, `${field} must be a non-empty string`);
  }
  return value;
}

function optionalStringValue(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw workflowValidationError("WORKFLOW_FIELD_TYPE", field, `${field} must be a number`);
  }
  return value;
}

function stringArrayValue(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw workflowValidationError("WORKFLOW_FIELD_TYPE", field, `${field} must be an array of strings`);
  }
  return value;
}

function numberArrayValue(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) {
    throw workflowValidationError("WORKFLOW_FIELD_TYPE", field, `${field} must be an array of numbers`);
  }
  return value;
}

function normalizeArtifactSchemas(value: unknown): Record<string, ArtifactSchemaDefinition> {
  if (value === undefined) {
    return {};
  }
  const records = normalizeRecordOfRecords<Record<string, unknown>>(value, "workflow.artifact_schemas");
  const normalized: Record<string, ArtifactSchemaDefinition> = {};
  for (const [name, schema] of Object.entries(records)) {
    normalized[name] = {
      ...schema,
      required_fields: stringArrayValue(schema.required_fields, `workflow.artifact_schemas.${name}.required_fields`),
    };
  }
  return normalized;
}

function normalizeRecordOfRecords<T extends Record<string, unknown>>(value: unknown, field: string): Record<string, T> {
  if (value === undefined) {
    return {};
  }
  const record = getRecordValue(value, field);
  const normalized: Record<string, T> = {};
  for (const [name, item] of Object.entries(record)) {
    normalized[name] = getRecordValue(item, `${field}.${name}`) as T;
  }
  return normalized;
}

function normalizeExceptionPolicy(
  value: unknown,
  stages: Record<string, StageDefinition>,
): ExceptionPolicyDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }

  const policy = getRecordValue(value, "workflow.exception_policy");
  const rules = arrayValue(policy.rules, "workflow.exception_policy.rules")
    .map((rule, index) => normalizeExceptionRule(rule, index, stages));
  const defaultRecord = getRecordValue(policy.default, "workflow.exception_policy.default");

  const maxRecoveryAttemptsFrom = optionalStringValue(
    policy.max_recovery_attempts_from,
    "workflow.exception_policy.max_recovery_attempts_from",
  );
  if (
    maxRecoveryAttemptsFrom !== undefined
    && maxRecoveryAttemptsFrom !== "runtime.max_recovery_attempts"
  ) {
    throw workflowValidationError(
      "WORKFLOW_FIELD_TYPE",
      "workflow.exception_policy.max_recovery_attempts_from",
      "workflow.exception_policy.max_recovery_attempts_from must be runtime.max_recovery_attempts",
    );
  }

  return {
    ...(maxRecoveryAttemptsFrom === undefined ? {} : { max_recovery_attempts_from: maxRecoveryAttemptsFrom }),
    rules,
    default: {
      action: normalizeExceptionAction(
        defaultRecord.action,
        "workflow.exception_policy.default.action",
        stages,
      ),
    },
  };
}

function normalizeExceptionRule(
  value: unknown,
  index: number,
  stages: Record<string, StageDefinition>,
): ExceptionPolicyRuleDefinition {
  const path = `workflow.exception_policy.rules[${index}]`;
  const record = getRecordValue(value, path);
  const matchRecord = getRecordValue(record.match, `${path}.match`);
  const entries = Object.entries(matchRecord);

  if (entries.length === 0) {
    throw workflowValidationError(
      "WORKFLOW_EXCEPTION_POLICY_INVALID_RULE",
      `${path}.match`,
      "exception policy match must include at least one field",
    );
  }

  const match: Partial<Record<ExceptionMatchField, string | boolean>> = {};
  for (const [field, fieldValue] of entries) {
    if (!exceptionMatchFields.has(field)) {
      throw workflowValidationError(
        "WORKFLOW_EXCEPTION_POLICY_INVALID_MATCH_FIELD",
        `${path}.match.${field}`,
        `unknown exception policy match field ${field}`,
      );
    }
    if (typeof fieldValue !== "string" && typeof fieldValue !== "boolean") {
      throw workflowValidationError(
        "WORKFLOW_FIELD_TYPE",
        `${path}.match.${field}`,
        "exception policy match values must be strings or booleans",
      );
    }
    match[field as ExceptionMatchField] = fieldValue;
  }

  return {
    name: stringValue(record.name, `${path}.name`),
    match,
    action: normalizeExceptionAction(record.action, `${path}.action`, stages),
    on_exhausted: normalizeExceptionOnExhausted(record.on_exhausted, `${path}.on_exhausted`),
  };
}

function normalizeExceptionAction(
  value: unknown,
  path: string,
  stages: Record<string, StageDefinition>,
): ExceptionPolicyActionDefinition {
  const action = getRecordValue(value, path);
  const type = stringValue(action.type, `${path}.type`) as ExceptionActionType;
  if (!exceptionActionTypes.has(type)) {
    throw workflowValidationError(
      "WORKFLOW_EXCEPTION_POLICY_INVALID_ACTION",
      `${path}.type`,
      `unknown exception policy action ${type}`,
    );
  }

  const targetStage = optionalStringValue(action.target_stage, `${path}.target_stage`);
  if ((type === "retry_stage" || type === "return_to_stage") && targetStage === undefined) {
    throw workflowValidationError(
      "WORKFLOW_EXCEPTION_POLICY_MISSING_TARGET_STAGE",
      `${path}.target_stage`,
      `${type} action requires target_stage`,
    );
  }
  if (targetStage && !stages[targetStage]) {
    throw workflowValidationError(
      "WORKFLOW_EXCEPTION_POLICY_UNKNOWN_TARGET_STAGE",
      `${path}.target_stage`,
      `unknown target stage ${targetStage}`,
    );
  }

  return {
    type,
    ...(targetStage === undefined ? {} : { target_stage: targetStage }),
    ...(action.carry_forward === undefined
      ? {}
      : { carry_forward: stringArrayValue(action.carry_forward, `${path}.carry_forward`) }),
  };
}

function normalizeExceptionOnExhausted(
  value: unknown,
  path: string,
): { type: "quarantine" | "fail" } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = getRecordValue(value, path);
  const type = stringValue(record.type, `${path}.type`);
  if (type !== "quarantine" && type !== "fail") {
    throw workflowValidationError(
      "WORKFLOW_EXCEPTION_POLICY_INVALID_ACTION",
      `${path}.type`,
      "on_exhausted.type must be quarantine or fail",
    );
  }
  return { type };
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw workflowValidationError("WORKFLOW_FIELD_TYPE", field, `${field} must be an array`);
  }
  return value;
}

function validateStageTransitions(
  stages: Record<string, StageDefinition>,
  roles: Record<string, RoleDefinition>,
): void {
  for (const [stageName, stage] of Object.entries(stages)) {
    const role = roles[stage.role];
    for (const [key, target] of Object.entries(stage)) {
      if (!key.startsWith("on_") || typeof target !== "string") {
        continue;
      }
      if (!stages[target] && !lifecycleStates.includes(target)) {
        throw workflowValidationError(
          "WORKFLOW_UNKNOWN_STAGE_TARGET",
          `workflow.stages.${stageName}.${key}`,
          `transition target ${target} is not a stage or lifecycle state`,
        );
      }
      if ((key === "on_failed_retryable" || key === "on_fail_retryable") && target === stageName && !role.retry_policy) {
        throw workflowValidationError(
          "WORKFLOW_RETRY_CYCLE_WITHOUT_POLICY",
          `workflow.stages.${stageName}.${key}`,
          `retry transition ${target} requires retry policy on role ${stage.role}`,
        );
      }
    }
  }
}
