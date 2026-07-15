import type { PlannerDraftTaskProfileOverride } from "../design-library/runtime-types.ts";
import { cloneAgentProfile, materializeAgentProfile } from "../design-library/profile-composer/profile-contract.ts";
import type {
  WorkflowCompositionPlan,
  WorkflowCompositionValidationIssue,
  WorkflowCompositionValidationResult,
} from "../design-library/types.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { validateWorkflowManifest } from "../manifests/validate.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";

export type WorkflowManifestAcceptanceResult = {
  ok: boolean;
  issues: WorkflowCompositionValidationIssue[];
};

export function acceptWorkflowComposition(input: {
  composition: WorkflowCompositionPlan | unknown;
  compositionValidation: WorkflowCompositionValidationResult;
  workflow: SouthstarWorkflowManifest;
}): WorkflowManifestAcceptanceResult {
  const issues = [...input.compositionValidation.issues];
  const workflowValidation = validateWorkflowManifest(input.workflow);
  issues.push(...workflowValidation.issues.map((issue) => manifestIssue(issue.path, issue.message)));

  if (!input.workflow.compiledFrom) {
    issues.push(manifestIssue("workflow.compiledFrom", "canonical workflow manifest must preserve composition provenance"));
  } else {
    const expectedInputHash = contentHashForPayload(input.composition);
    if (input.workflow.compiledFrom.inputHash !== expectedInputHash) {
      issues.push(manifestIssue(
        "workflow.compiledFrom.inputHash",
        "must match the accepted workflow composition hash",
      ));
    }
  }

  const materializedWorkflow = materializeWorkflowTaskProfileOverrides(input.workflow);
  const materializedValidation = validateWorkflowManifest(materializedWorkflow);
  issues.push(...materializedValidation.issues.map((issue) => manifestIssue(`materialized.${issue.path}`, issue.message)));

  return { ok: issues.length === 0, issues };
}

export function validateWorkflowMaterialization(workflow: SouthstarWorkflowManifest): Array<{ path: string; message: string }> {
  const validation = validateWorkflowManifest(workflow);
  const materializedValidation = validateWorkflowManifest(materializeWorkflowTaskProfileOverrides(workflow));
  return [
    ...validation.issues,
    ...materializedValidation.issues.map((issue) => ({
      path: `materialized.${issue.path}`,
      message: issue.message,
    })),
  ];
}

export function materializeWorkflowTaskProfileOverrides(workflow: SouthstarWorkflowManifest): SouthstarWorkflowManifest {
  const agentProfiles = (workflow.agentProfiles ?? []).map(cloneAgentProfile);
  const tasks = workflow.tasks.map((task) => ({ ...task } as WorkflowTaskWithProfileOverride));
  const profileById = new Map(agentProfiles.map((profile) => [profile.id, profile]));
  const outputProfiles = [...agentProfiles];

  for (const task of tasks) {
    const override = task.profileOverride;
    if (!override || Object.keys(override).length === 0 || !task.agentProfileRef) continue;
    const baseProfile = profileById.get(task.agentProfileRef);
    if (!baseProfile) continue;

    const overrideProfile = materializeAgentProfile(baseProfile, override, task.id, task.name || task.id);

    outputProfiles.push(overrideProfile);
    profileById.set(overrideProfile.id, overrideProfile);
    task.agentProfileRef = overrideProfile.id;
    if (override.skillRefs !== undefined) task.skillRefs = [...override.skillRefs];
    if (override.mcpGrantRefs !== undefined) task.mcpGrantRefs = [...override.mcpGrantRefs];
    if (override.toolGrantRefs !== undefined) task.toolGrantRefs = [...override.toolGrantRefs];
    if (override.vaultLeasePolicyRefs !== undefined) task.vaultLeasePolicyRefs = [...override.vaultLeasePolicyRefs];
    if (override.nodePromptSpec !== undefined) {
      task.promptInputs = { ...task.promptInputs, nodePromptSpec: { ...override.nodePromptSpec } };
    }
  }

  return { ...workflow, agentProfiles: outputProfiles, tasks };
}

type WorkflowTaskWithProfileOverride = SouthstarWorkflowManifest["tasks"][number] & {
  profileOverride?: PlannerDraftTaskProfileOverride;
};

function manifestIssue(path: string, message: string): WorkflowCompositionValidationIssue {
  return { code: "composer_output_schema_violation", path, message };
}
