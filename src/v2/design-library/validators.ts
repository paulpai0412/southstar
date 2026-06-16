import type {
  LibraryDefinitionKind,
  LibraryValidationResult,
  WorkflowTemplatePayload,
} from "./types.ts";
import { validateWorkflowTemplateGraph } from "./template-validator.ts";

export function validateLibraryPayload(kind: LibraryDefinitionKind, payload: unknown): LibraryValidationResult {
  const issues: Array<{ path: string; message: string; code?: string }> = [];
  if (!isRecord(payload)) {
    return { ok: false, issues: [{ path: "$", message: "payload must be an object", code: "payload_not_object" }] };
  }

  const schemaVersion = payload.schemaVersion;
  if (typeof schemaVersion !== "string") {
    issues.push({ path: "schemaVersion", message: "schemaVersion is required", code: "schema_required" });
  }

  switch (kind) {
    case "agent_spec":
      if (schemaVersion !== "southstar.library.agent_spec.v1") {
        issues.push({ path: "schemaVersion", message: "agent_spec schemaVersion must be southstar.library.agent_spec.v1" });
      }
      requireObject(payload.identity, "identity", issues);
      requireObject(payload.responsibilities, "responsibilities", issues);
      requireArray(payload.executionProfiles, "executionProfiles", issues);
      requireObject(payload.prompts, "prompts", issues);
      requireObject(payload.capabilities, "capabilities", issues);
      requireObject(payload.contracts, "contracts", issues);
      break;

    case "capability_spec":
      if (schemaVersion !== "southstar.library.capability_spec.v1") {
        issues.push({ path: "schemaVersion", message: "capability_spec schemaVersion must be southstar.library.capability_spec.v1" });
      }
      requireString(payload.title, "title", issues);
      requireString(payload.description, "description", issues);
      requireArray(payload.requiredOperations, "requiredOperations", issues);
      requireObject(payload.risk, "risk", issues);
      break;

    case "contract_spec":
      if (schemaVersion !== "southstar.library.contract_spec.v1") {
        issues.push({ path: "schemaVersion", message: "contract_spec schemaVersion must be southstar.library.contract_spec.v1" });
      }
      requireArray(payload.fields, "fields", issues);
      break;

    case "validator_spec":
      if (schemaVersion !== "southstar.library.validator_spec.v1") {
        issues.push({ path: "schemaVersion", message: "validator_spec schemaVersion must be southstar.library.validator_spec.v1" });
      }
      requireString(payload.validatorType, "validatorType", issues);
      if (typeof payload.required !== "boolean") {
        issues.push({ path: "required", message: "required must be boolean" });
      }
      break;

    case "policy_bundle":
      if (schemaVersion !== "southstar.library.policy_bundle.v1") {
        issues.push({ path: "schemaVersion", message: "policy_bundle schemaVersion must be southstar.library.policy_bundle.v1" });
      }
      requireArray(payload.policyTypes, "policyTypes", issues);
      break;

    case "workflow_template": {
      if (schemaVersion !== "southstar.library.workflow_template.v1") {
        issues.push({ path: "schemaVersion", message: "workflow_template schemaVersion must be southstar.library.workflow_template.v1" });
      }
      const graphValidation = validateWorkflowTemplateGraph(payload as WorkflowTemplatePayload);
      if (!graphValidation.ok) {
        issues.push(...graphValidation.issues);
      }
      break;
    }

    case "workflow_recipe":
      if (schemaVersion !== "southstar.library.workflow_recipe.v1") {
        issues.push({ path: "schemaVersion", message: "workflow_recipe schemaVersion must be southstar.library.workflow_recipe.v1" });
      }
      requireString(payload.baseTemplateRef, "baseTemplateRef", issues);
      requireArray(payload.adaptationRules, "adaptationRules", issues);
      break;
  }

  return { ok: issues.length === 0, issues };
}

function requireObject(value: unknown, path: string, issues: Array<{ path: string; message: string }>): void {
  if (!isRecord(value)) issues.push({ path, message: `${path} must be an object` });
}

function requireArray(value: unknown, path: string, issues: Array<{ path: string; message: string }>): void {
  if (!Array.isArray(value)) issues.push({ path, message: `${path} must be an array` });
}

function requireString(value: unknown, path: string, issues: Array<{ path: string; message: string }>): void {
  if (typeof value !== "string" || value.length === 0) issues.push({ path, message: `${path} must be a non-empty string` });
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
