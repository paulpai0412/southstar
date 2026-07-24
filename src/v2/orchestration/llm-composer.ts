import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { findApprovedLibraryObjectsByKind } from "../design-library/library-graph-store.ts";
import type {
  CandidatePacket,
  LibraryDefinitionKind,
  WorkflowCompositionPatch,
  WorkflowCompositionPlan,
  WorkflowCompositionTask,
  WorkflowCompositionValidationIssue,
} from "../design-library/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { ComposeWorkflowInput, ComposeWorkflowRepairInput, WorkflowComposer } from "./composer.ts";
import type { GoalContractV1 } from "./goal-contract.ts";
import type { GoalDesignPackage } from "./goal-design.ts";
import type { PiRuntimeProfileBinding } from "../planner/pi-planner.ts";
import type { RuntimeBindingCapabilities } from "./runtime-binding-capabilities.ts";
import {
  GENERATED_AGENT_PROFILE_COMMAND_ENTRYPOINT,
} from "./generated-agent-profile-policy.ts";

export type LlmTextClient = {
  generateText(input: { model: string; prompt: string; temperature?: number; cwd?: string }): Promise<string>;
  generateTextStream?: (
    input: { model: string; prompt: string; temperature?: number; cwd?: string },
    handlers: { onDelta?: (text: string) => void },
  ) => Promise<string>;
};

export type LlmWorkflowComposerOptions = {
  model: string;
  client: LlmTextClient;
  maxOutputChars?: number;
  temperature?: number;
  /** Optional host-selected packet budget. Omit to expose the complete packet. */
  candidatePacketCharBudget?: number;
  composerSop?: ResolvedWorkflowComposerSopV1 | (() => Promise<ResolvedWorkflowComposerSopV1>);
  runtimeProfileBinding?: (cwd?: string) => Promise<PiRuntimeProfileBinding | undefined>;
  runtimeBindingCapabilities?: RuntimeBindingCapabilities;
};

export type ResolvedWorkflowComposerSopV1 = {
  objectKey: string;
  versionRef: string;
  stateHash: string;
  body: string;
};

const LIBRARY_DEFINITION_KIND_VALUES: readonly LibraryDefinitionKind[] = [
  "agent_spec",
  "agent_definition",
  "agent_profile",
  "skill_definition",
  "mcp_tool_grant",
  "artifact_contract",
  "evaluator_profile",
  "capability_spec",
  "contract_spec",
  "validator_spec",
  "policy_bundle",
  "workflow_template",
  "workflow_recipe",
  "tool_definition",
  "instruction_template",
  "vault_lease_policy",
  "skill_spec",
] as const;

const LIBRARY_DEFINITION_KIND_SET = new Set<string>(LIBRARY_DEFINITION_KIND_VALUES);

export const WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SouthstarWorkflowCompositionPlanV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "title",
    "rationale",
    "tasks",
    "rejectedCandidates",
    "generatedComponentProposals",
  ],
  properties: {
    schemaVersion: { const: "southstar.workflow_composition_plan.v1" },
    title: { type: "string", minLength: 1 },
    selectedWorkflowTemplateRef: { type: "string", minLength: 1 },
    rationale: { type: "string", minLength: 1 },
    tasks: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/task" },
    },
    rejectedCandidates: {
      type: "array",
      items: { $ref: "#/$defs/rejectedCandidate" },
    },
    generatedComponentProposals: {
      type: "array",
      items: { $ref: "#/$defs/generatedComponentProposal" },
    },
  },
  $defs: {
    task: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "sliceId",
        "name",
        "responsibility",
        "requirementIds",
        "nodePromptSpec",
        "dependsOn",
        "templateSlotRef",
        "agentDefinitionRef",
        "agentProfileRef",
        "instructionRefs",
        "skillRefs",
        "toolGrantRefs",
        "mcpGrantRefs",
        "vaultLeasePolicyRefs",
        "inputArtifactRefs",
        "outputArtifactRefs",
        "evaluatorProfileRef",
        "recoveryStrategyRefs",
        "rationale",
      ],
      properties: {
        id: { type: "string", minLength: 1 },
        sliceId: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        responsibility: { type: "string", minLength: 1 },
        requirementIds: { type: "array", items: { type: "string", minLength: 1 } },
        nodePromptSpec: { $ref: "#/$defs/nodePromptSpec" },
        workspaceMutation: { $ref: "#/$defs/workspaceMutation" },
        dependsOn: { type: "array", items: { type: "string", minLength: 1 } },
        templateSlotRef: { type: "string", minLength: 1 },
        agentDefinitionRef: { type: "string", minLength: 1 },
        agentProfileRef: { type: "string", minLength: 1 },
        instructionRefs: { type: "array", items: { type: "string", minLength: 1 } },
        skillRefs: { type: "array", items: { type: "string", minLength: 1 } },
        toolGrantRefs: { type: "array", items: { type: "string", minLength: 1 } },
        mcpGrantRefs: { type: "array", items: { type: "string", minLength: 1 } },
        vaultLeasePolicyRefs: { type: "array", items: { type: "string", minLength: 1 } },
        inputArtifactRefs: { type: "array", items: { type: "string", minLength: 1 } },
        outputArtifactRefs: { type: "array", items: { type: "string", minLength: 1 } },
        evaluatorProfileRef: { type: "string", minLength: 1 },
        contextPolicyRef: { type: "string", minLength: 1 },
        workspacePolicyRef: { type: "string", minLength: 1 },
        recoveryStrategyRefs: { type: "array", items: { type: "string", minLength: 1 } },
        rationale: { type: "string", minLength: 1 },
      },
    },
    workspaceMutation: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["read_only", "shared_write", "append_only"] },
        isolation: { type: "string", enum: ["shared", "git_worktree"] },
        resourceKeys: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    nodePromptSpec: {
      type: "object",
      additionalProperties: false,
      required: [
        "nodeType",
        "goal",
        "requirements",
        "boundaries",
        "nonGoals",
        "deliverableDocuments",
        "expectedOutputs",
        "testCases",
        "acceptanceCriteria",
      ],
      properties: {
        nodeType: { type: "string", enum: ["plan", "implement", "verify", "repair", "review", "summary", "general"] },
        goal: { type: "string", minLength: 1 },
        requirements: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        boundaries: { type: "array", items: { type: "string", minLength: 1 } },
        nonGoals: { type: "array", items: { type: "string", minLength: 1 } },
        deliverableDocuments: { type: "array", items: { $ref: "#/$defs/deliverableDocument" } },
        expectedOutputs: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        testCases: { type: "array", items: { $ref: "#/$defs/nodePromptTestCase" } },
        acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        failureReportContract: { type: "string", minLength: 1 },
        planningQuestions: { type: "array", items: { type: "string", minLength: 1 } },
        decisionCriteria: { type: "array", items: { type: "string", minLength: 1 } },
        planArtifactContract: { type: "string", minLength: 1 },
        implementationScope: { type: "array", items: { type: "string", minLength: 1 } },
        filesLikelyToTouch: { type: "array", items: { type: "string", minLength: 1 } },
        verificationChecks: { type: "array", items: { type: "string", minLength: 1 } },
        failureArtifactContract: { type: "string", minLength: 1 },
        repairInputs: { type: "array", items: { type: "string", minLength: 1 } },
        mustPreserve: { type: "array", items: { type: "string", minLength: 1 } },
        reverificationChecks: { type: "array", items: { type: "string", minLength: 1 } },
        reviewChecklist: { type: "array", items: { type: "string", minLength: 1 } },
        riskCriteria: { type: "array", items: { type: "string", minLength: 1 } },
        summarySections: { type: "array", items: { type: "string", minLength: 1 } },
        handoffCriteria: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    deliverableDocument: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "title", "required", "format", "description"],
      properties: {
        kind: { type: "string", enum: ["design", "implementation", "test", "acceptance", "verification", "summary", "handoff", "other"] },
        title: { type: "string", minLength: 1 },
        required: { type: "boolean" },
        format: { type: "string", enum: ["markdown", "json", "file", "inline"] },
        description: { type: "string", minLength: 1 },
      },
    },
    nodePromptTestCase: {
      type: "object",
      additionalProperties: false,
      required: ["name", "expected"],
      properties: {
        name: { type: "string", minLength: 1 },
        command: { type: "string", minLength: 1 },
        expected: { type: "string", minLength: 1 },
        given: { type: "string", minLength: 1 },
        when: { type: "string", minLength: 1 },
        then: { type: "string", minLength: 1 },
      },
    },
    rejectedCandidate: {
      type: "object",
      additionalProperties: false,
      required: ["ref", "reason"],
      properties: {
        ref: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
      },
    },
    generatedComponentProposal: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "risk", "reason", "validationStatus"],
      properties: {
        id: { type: "string", minLength: 1 },
        kind: { type: "string", enum: LIBRARY_DEFINITION_KIND_VALUES },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        reason: { type: "string", minLength: 1 },
        validationStatus: { type: "string", enum: ["validated", "unvalidated"] },
        agentProfile: { $ref: "#/$defs/agentProfile" },
      },
    },
    agentProfile: {
      type: "object",
      additionalProperties: false,
      required: [
        "workerKind",
        "provider",
        "model",
        "thinkingLevel",
        "harnessRef",
        "instruction",
        "promptTemplateRef",
        "contextPolicyRef",
        "sessionPolicyRef",
        "memoryScopes",
        "agentsMdRefs",
        "vaultLeasePolicyRefs",
        "toolPolicy",
        "budgetPolicy",
        "execution",
      ],
      properties: {
        workerKind: { type: "string", minLength: 1 },
        provider: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        thinkingLevel: { type: "string", minLength: 1 },
        harnessRef: { type: "string", minLength: 1 },
        instruction: { type: "string", minLength: 1 },
        promptTemplateRef: { type: "string", minLength: 1 },
        contextPolicyRef: { type: "string", minLength: 1 },
        sessionPolicyRef: { type: "string", minLength: 1 },
        memoryScopes: { type: "array", items: { type: "string", minLength: 1 } },
        agentsMdRefs: { type: "array", items: { type: "string", minLength: 1 } },
        vaultLeasePolicyRefs: { type: "array", items: { type: "string", minLength: 1 } },
        toolPolicy: {
          type: "object",
          additionalProperties: false,
          required: ["allowedTools", "deniedTools", "requiresApprovalFor"],
          properties: {
            allowedTools: { type: "array", items: { type: "string", minLength: 1 } },
            deniedTools: { type: "array", items: { type: "string", minLength: 1 } },
            requiresApprovalFor: { type: "array", items: { type: "string", minLength: 1 } },
          },
        },
        budgetPolicy: {
          type: "object",
          additionalProperties: false,
          required: ["maxInputTokens", "maxOutputTokens", "maxWallTimeSeconds"],
          properties: {
            maxInputTokens: { type: "number" },
            maxOutputTokens: { type: "number" },
            maxCostMicrosUsd: { type: "number" },
            maxWallTimeSeconds: { type: "number" },
          },
        },
        execution: {
          type: "object",
          additionalProperties: false,
          required: ["engine", "image", "command", "env", "mounts", "timeoutSeconds", "infraRetry"],
          properties: {
            engine: { type: "string", minLength: 1 },
            image: { type: "string", minLength: 1 },
            command: {
              type: "array",
              minItems: 1,
              prefixItems: [{ const: "southstar-agent-runner" }],
              items: { type: "string", minLength: 1 },
            },
            env: { type: "object", additionalProperties: { type: "string" } },
            mounts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  source: { type: "string", minLength: 1 },
                  target: { type: "string", minLength: 1 },
                  readonly: { type: "boolean" },
                },
              },
            },
            timeoutSeconds: { type: "number" },
            infraRetry: {
              type: "object",
              additionalProperties: false,
              required: ["maxAttempts"],
              properties: {
                maxAttempts: { type: "number" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export class LlmComposerOutputError extends Error {
  constructor(public readonly issues: WorkflowCompositionValidationIssue[]) {
    super(`LLM workflow composer output failed contract validation: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.name = "LlmComposerOutputError";
  }
}

export class LlmWorkflowComposer implements WorkflowComposer {
  constructor(private readonly options: LlmWorkflowComposerOptions) {}

  async compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    const composerSop = typeof this.options.composerSop === "function"
      ? await this.options.composerSop()
      : this.options.composerSop;
    const runtimeProfileBinding = await this.options.runtimeProfileBinding?.(input.cwd);
    const prompt = renderComposerPrompt(
      input.goalPrompt,
      input.goalContract,
      input.candidatePacket,
      input.goalDesignPackage,
      composerSop,
      this.options.candidatePacketCharBudget,
      runtimeProfileBinding,
      this.options.runtimeBindingCapabilities,
    );
    const textInput = {
      model: this.options.model,
      prompt,
      temperature: this.options.temperature ?? 0,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    const text = this.options.client.generateTextStream
      ? await this.options.client.generateTextStream(textInput, { onDelta: input.onLlmDelta })
      : await this.options.client.generateText(textInput);
    const plan = parseWorkflowCompositionPlanFromText(text, this.options.maxOutputChars ?? 100_000);
    return applyRuntimeProfileBinding(plan, runtimeProfileBinding);
  }

  async repair(input: ComposeWorkflowRepairInput): Promise<WorkflowCompositionPatch> {
    const composerSop = typeof this.options.composerSop === "function"
      ? await this.options.composerSop()
      : this.options.composerSop;
    const runtimeProfileBinding = await this.options.runtimeProfileBinding?.(input.cwd);
    const prompt = renderCompositionRepairPrompt(
      input,
      composerSop,
      runtimeProfileBinding,
      this.options.runtimeBindingCapabilities,
    );
    const textInput = {
      model: this.options.model,
      prompt,
      temperature: this.options.temperature ?? 0,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    const text = this.options.client.generateTextStream
      ? await this.options.client.generateTextStream(textInput, { onDelta: input.onLlmDelta })
      : await this.options.client.generateText(textInput);
    return parseWorkflowCompositionPatchFromText(text, this.options.maxOutputChars ?? 100_000);
  }
}

function applyRuntimeProfileBinding(
  plan: WorkflowCompositionPlan,
  binding: PiRuntimeProfileBinding | undefined,
): WorkflowCompositionPlan {
  if (!binding) return plan;
  return {
    ...plan,
    generatedComponentProposals: plan.generatedComponentProposals.map((proposal) => {
      if (proposal.kind !== "agent_profile" || proposal.validationStatus !== "validated" || !proposal.agentProfile) {
        return proposal;
      }
      return {
        ...proposal,
        agentProfile: {
          ...proposal.agentProfile,
          harnessRef: binding.harnessRef,
          provider: binding.provider,
          model: binding.model,
        },
      };
    }),
  };
}

export async function loadWorkflowComposerSopPg(db: SouthstarDb): Promise<ResolvedWorkflowComposerSopV1> {
  const skills = (await findApprovedLibraryObjectsByKind(db, "skill_spec"))
    .filter((skill) => skill.state.purpose === "composer_guidance");
  if (skills.length !== 1) {
    throw new Error(`expected exactly one approved Workflow Composer SOP skill, found ${skills.length}`);
  }
  const skill = skills[0]!;
  if (!skill.headVersionId) throw new Error(`Workflow Composer SOP skill missing version ref: ${skill.objectKey}`);
  const body = typeof skill.state.body === "string"
    ? skill.state.body
    : typeof skill.state.instructions === "string"
      ? skill.state.instructions
      : "";
  if (body.trim().length === 0) throw new Error(`Workflow Composer SOP skill missing body: ${skill.objectKey}`);
  return {
    objectKey: skill.objectKey,
    versionRef: skill.headVersionId,
    stateHash: contentHashForPayload(skill.state),
    body,
  };
}

export function parseWorkflowCompositionPlanFromText(text: string, maxOutputChars: number): WorkflowCompositionPlan {
  if (text.length > maxOutputChars) {
    throw new LlmComposerOutputError([
      issue(
        "composer_output_too_large",
        "$",
        `LLM workflow composer output exceeded max output size: ${text.length} > ${maxOutputChars}`,
      ),
    ]);
  }

  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      throw new LlmComposerOutputError([
        issue("composer_output_non_json", "$", "LLM workflow composer returned non-JSON output"),
      ]);
    }
    throw new LlmComposerOutputError([
      issue(
        "composer_output_invalid_json",
        "$",
        `LLM workflow composer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ]);
  }

  const issues = validateStrictWorkflowCompositionPlan(parsed);
  if (issues.length > 0) {
    throw new LlmComposerOutputError(issues);
  }
  return parsed as WorkflowCompositionPlan;
}

export function parseWorkflowCompositionPatchFromText(text: string, maxOutputChars: number): WorkflowCompositionPatch {
  if (text.length > maxOutputChars) {
    throw new LlmComposerOutputError([issue("composer_output_too_large", "$", `LLM workflow repair output exceeded max output size: ${text.length} > ${maxOutputChars}`)]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch (error) {
    throw new LlmComposerOutputError([issue("composer_output_invalid_json", "$", `LLM workflow repair returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)]);
  }
  const issues: WorkflowCompositionValidationIssue[] = [];
  if (!isRecord(parsed)) {
    issues.push(issue("composer_output_schema_violation", "$", "workflow composition patch must be an object"));
  } else {
    validateObjectShape(parsed, ["schemaVersion", "basePlanHash", "operations", "rationale"], ["schemaVersion", "basePlanHash", "operations", "rationale"], "$", issues);
    if (parsed.schemaVersion !== "southstar.workflow_composition_patch.v1") issues.push(issue("composer_output_schema_violation", "$.schemaVersion", "schemaVersion must be southstar.workflow_composition_patch.v1"));
    if (!Array.isArray(parsed.operations) || parsed.operations.length !== 1) issues.push(issue("composer_output_schema_violation", "$.operations", "exactly one bounded repair operation is required"));
    else validateRepairOperation(parsed.operations[0], "$.operations.0", issues);
  }
  if (issues.length > 0) throw new LlmComposerOutputError(issues);
  return parsed as WorkflowCompositionPatch;
}

function validateRepairOperation(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("composer_output_schema_violation", path, "repair operation must be an object"));
    return;
  }
  if (value.op === "replace-task") {
    if (typeof value.taskId !== "string" || !isRecord(value.task)) {
      issues.push(issue("composer_output_schema_violation", path, "replace-task requires taskId and task"));
    }
    return;
  }
  if (value.op === "replace-ref") {
    if (typeof value.taskId !== "string" || typeof value.field !== "string" || typeof value.fromRef !== "string" || typeof value.toRef !== "string") {
      issues.push(issue("composer_output_schema_violation", path, "replace-ref requires taskId, field, fromRef, and toRef"));
    }
    return;
  }
  issues.push(issue("composer_output_schema_violation", `${path}.op`, "only replace-task or replace-ref repair operations are supported"));
}

function renderCompositionRepairPrompt(
  input: ComposeWorkflowRepairInput,
  composerSop: ResolvedWorkflowComposerSopV1 | undefined,
  runtimeProfileBinding: PiRuntimeProfileBinding | undefined,
  runtimeBindingCapabilities: RuntimeBindingCapabilities | undefined,
): string {
  return [
    "Repair one already-composed Southstar workflow plan with exactly one bounded patch.",
    "Return exactly one JSON object and no markdown.",
    "Shape: {\"schemaVersion\":\"southstar.workflow_composition_patch.v1\",\"basePlanHash\":\"...\",\"operations\":[{\"op\":\"replace-task\",\"taskId\":\"...\",\"task\":{...}}],\"rationale\":\"...\"}.",
    "Use the exact basePlanHash supplied below. Emit exactly one operation. Do not add/remove tasks, change task ids, slice ids, requirement ownership, or invent Library refs.",
    "A replace-task operation must preserve the task's id, sliceId, requirementIds, dependsOn, and templateSlotRef; change only fields implicated by the structured issue.",
    "A replace-ref operation is allowed only for one existing string reference field and must use exact values from the supplied candidate packet.",
    "Library/runtime gaps are not repairable: return a patch only when the existing plan can be corrected within these bounds; otherwise the host will block.",
    composerSop ? `Approved Composer SOP ${composerSop.objectKey}@${composerSop.versionRef}:\n${composerSop.body}` : "",
    runtimeProfileBinding ? `Runtime host bindings (authoritative):\n${JSON.stringify(runtimeProfileBinding)}` : "",
    runtimeBindingCapabilities
      ? `RuntimeBindingCapabilities (authoritative):\n${JSON.stringify(runtimeBindingCapabilities)}\nEvery generated profile execution.image must be an exact value from RuntimeBindingCapabilities.images when images are advertised; never invent an image.`
      : "",
    `basePlanHash: ${contentHashForPayload(input.baseComposition)}`,
    `validationIssues: ${JSON.stringify(input.validationIssues)}`,
    `currentPlan: ${JSON.stringify(input.baseComposition)}`,
    `goalContract: ${JSON.stringify(input.goalContract)}`,
  ].filter(Boolean).join("\n\n");
}

export function renderComposerPrompt(
  goalPrompt: string,
  goalContract: GoalContractV1,
  candidatePacket: CandidatePacket,
  goalDesignPackage?: ComposeWorkflowInput["goalDesignPackage"],
  composerSop?: ResolvedWorkflowComposerSopV1,
  candidatePacketCharBudget?: number,
  runtimeProfileBinding?: PiRuntimeProfileBinding,
  runtimeBindingCapabilities?: RuntimeBindingCapabilities,
): string {
  const packetBinding = boundCandidatePacket(candidatePacket, candidatePacketCharBudget, pinnedRefsForGoal(goalContract, goalDesignPackage));
  const boundedPacket = packetBinding.packet;
  const allowedRefsByField = composerAllowedRefsByField(boundedPacket);
  const evaluatorArtifactCompatibility = composerEvaluatorArtifactCompatibility(boundedPacket);
  const forbiddenGoalDesignRefs = goalDesignPackage ? goalDesignForbiddenRefs(goalDesignPackage) : [];
  const frozenValidationConstraints = goalDesignPackage?.schemaVersion === "southstar.goal_design_package.v3"
    ? [
        "FrozenValidationBindings are authoritative and immutable during DAG composition.",
        "For every verify or review task, evaluatorProfileRef must equal the evaluatorProfileRef of a frozen Criterion binding for one of that task's requirementIds.",
        "Use each frozen Criterion binding's artifactContractRef as the artifact that its evaluator profile validates.",
        "For every verify or review task, pair the frozen evaluator profile with the matching frozen artifactContractRef and preserve that pair for the covered Criterion; do not substitute a different artifact just because it is compatible in the graph.",
        "For every covered Criterion, at least one producer task must emit its frozen artifactContractRef in outputArtifactRefs; do not leave a generic implementation_report when the Criterion binding selected a different artifact contract.",
        "A verify or review node must preserve Criterion granularity in nodePromptSpec: name each covered criterion id, observable claim, required assurance, procedure, expected evidence kinds, and blocking behavior. Do not write one broad evaluator instruction that merges independent Criteria.",
        "Do not use a validation binding id as evaluatorProfileRef, and do not replace or invent evaluator profile or artifact refs.",
        "Preserve each Criterion binding's evaluatorProfileVersionRef and artifactContractVersionRef through the supplied Library candidate graph; the host validates their selected versions.",
      ]
    : [];
  const sliceConstraints = goalDesignPackage
      ? [
        "GoalDesignPackage is authoritative.",
        "GoalDesignPackage is a planning constraint, not a selectable Library primitive.",
        "Never use GoalDesignPackage.goalDesignSkillRef, goalDesignSkillVersionRef, or any file/path alias of the Goal Design skill as agentDefinitionRef, skillRefs, instructionRefs, agentProfileRef, evaluatorProfileRef, toolGrantRefs, or mcpGrantRefs.",
        "Every producer, evaluator, repair, review, and summary task must name one existing sliceId.",
        "Producer tasks may use only requirementIds owned by their sliceId. Verify/review tasks may cover multiple slices when their dependencies and evaluator contracts justify it.",
        "Do not merge slices, move requirement ownership, or invent slice ids.",
        "A dependency is valid only when inputArtifactRefs consumes an upstream outputArtifactRef.",
        "If the Slice Plan cannot be compiled, return slice_plan_revision_required instead of rewriting it.",
      ]
    : [
        "Use the Goal Contract and candidate graph to choose the smallest executable DAG.",
      ];
  return [
    "You are Southstar's library-constrained workflow architect.",
    "Return exactly one JSON object matching schemaVersion southstar.workflow_composition_plan.v1.",
    "Do not return markdown, comments, prose, or multiple JSON objects.",
    "Do not use alias fields. Use exactly the property names defined in OutputJsonSchema.",
    "Select refs only from GraphMetadataCandidates and CandidatePacketSummary.",
    "Do not output runtime manifests, secrets, credentials, tool grant definitions, MCP grant definitions, or vault lease values. Vault may appear only as vaultLeasePolicyRefs selected from graph nodes.",
    "Use GraphMetadataCandidates as the direct source of selectable refs for DAG tasks and generated profiles.",
    "When GraphMetadataCandidates is present, selected agentDefinitionRef, skillRef, toolGrantRef, mcpGrantRef, instructionRef, artifact ref, and evaluator ref must come from GraphMetadataCandidates.nodes.",
    "AllowedRefsByField is authoritative and partitions selectable refs by Library object kind. Every ref field must use an exact value from its own list; never substitute a ref from another field list.",
    "agentDefinitionRef accepts only AllowedRefsByField.agentDefinitionRef. evaluatorProfileRef, toolGrantRefs, and artifact refs are different kinds and can never be used as agentDefinitionRef.",
    "generatedComponentProposals may generate agent_profile only. A generated agent profile id may be used as agentProfileRef only; it does not create an agentDefinitionRef, skillRef, toolGrantRef, MCP grant, instruction, artifact, or evaluator.",
    "Never invent generated.* refs for primitive fields. If a required AllowedRefsByField list is empty, do not substitute another kind or claim that a generated profile fills it.",
    "EvaluatorArtifactCompatibility is authoritative. A task evaluatorProfileRef must be paired with outputArtifactRefs that appear in that evaluator's compatibility list.",
    "Do not select stored agent_profile refs from the library. For every DAG task, create a generated agent profile id and include it in generatedComponentProposals as kind agent_profile with validationStatus validated.",
    "Choose agents and skills by semantic fit to the Goal Contract, Slice Plan, node responsibility, titles, descriptions, and body previews. An agent-to-skill uses edge is a preference signal, not a prerequisite: independently approved agents and skills may be combined dynamically.",
    "Graph edges that express intrinsic requirements remain mandatory: when a selected skill requires a tool, MCP grant, or instruction, include that dependency. Never invent a dependency or substitute a different ref kind.",
    "Tool nodes describe logical Library grants. Select toolGrantRefs by required operations and capability edges; the host binds those refs to real harness tools and rejects missing runtime bindings.",
    "You may propose a generated agent profile only by combining refs from profilePrimitiveCandidates and GraphMetadataCandidates.",
    "When selecting a generated profile, include it in generatedComponentProposals with kind agent_profile, validationStatus validated, and agentProfile.",
    "Each agentProfile must define the workerKind, provider, model, thinkingLevel/effort, harnessRef host adapter, instruction, promptTemplateRef, contextPolicyRef, sessionPolicyRef, toolPolicy, budgetPolicy, memoryScopes, agentsMdRefs, vaultLeasePolicyRefs, and execution.",
    "agentProfile.execution must include all Docker/Tork worker input needed by the compiler: engine, image, command, env, mounts, timeoutSeconds, and infraRetry.",
    "Treat workerKind, provider, model, thinkingLevel, harnessRef, and execution.image as runtime binding data. Do not invent a fallback binding; the configured host validates whether the selected binding can execute.",
    ...(runtimeProfileBinding
      ? [
          "DefaultRuntimeProfileBinding is the Pi registry's host-selected default for this draft. Use it for each newly generated agent profile unless an explicit user or persisted binding overrides it; do not invent or substitute provider, model, or harnessRef values.",
          "DefaultRuntimeProfileBinding:",
          JSON.stringify(runtimeProfileBinding),
        ]
      : [
          "No DefaultRuntimeProfileBinding is available from the Pi registry. Do not invent provider, model, harnessRef, or execution image values; let validation fail closed if a required binding is absent.",
        ]),
    ...(runtimeBindingCapabilities
      ? [
          "RuntimeBindingCapabilities (authoritative):",
          JSON.stringify(runtimeBindingCapabilities),
          "Every generated profile execution.image must be an exact value from RuntimeBindingCapabilities.images when images are advertised. If no image is advertised, do not invent one; let validation fail closed.",
          "A selected skill is valid only when every intrinsic required tool, MCP grant, and instruction ref is present in the supplied ProfilePrimitiveCandidates or GraphMetadataCandidates. If a required ref such as tool.shell-command is absent, never select the skill that requires it.",
        ]
      : []),
    "Design for harness engineering: choose workerKind per task from execution_worker, validation_worker, repair_worker, or review_worker based on the goal, risk, and required artifacts.",
    "For workflows that create or modify artifacts, include a positive validation path with validation_worker, review_worker, deterministic checks, or another graph-justified verifier.",
    "For ordinary initial workflow generation, do not pre-add repair/reverify nodes unless the user explicitly asks for a static bounded repair path in the initial DAG. Instead, make validation_worker nodePromptSpec produce repair-ready failure reports for Southstar runtime dynamic repair revision.",
    "For Runtime dynamic repair request goals, generate only the additional bounded repair and reverify tasks needed to continue the existing run. The repair task must use workerKind=repair_worker and consume the failed verification report; the reverify task must use workerKind=validation_worker and depend on the repair task.",
    "Validation-oriented agent profiles may use a lightweight/no-reasoning model profile when deterministic shell/test verification is sufficient, but must still include provider, harnessRef, instruction, toolPolicy, and budgetPolicy.",
    "Never create cyclic dependencies. Runtime dynamic repair is represented by appended repair/reverify nodes, not by back edges to earlier nodes.",
    "Every task must include nodePromptSpec. Treat nodePromptSpec as the per-node prompt contract that the Docker worker will see: nodeType, goal, requirements, boundaries, nonGoals, deliverableDocuments, expectedOutputs, testCases, acceptanceCriteria, and optional failureReportContract.",
    "Every task must include sliceId. When GoalDesignPackage is provided, sliceId must come from GoalDesignPackage.slicePlan.slices.",
    "Every task must include requirementIds selected from GoalContractRequirements, except explicit coordination or summary nodes may use an empty array.",
    "Every blocking Goal Contract requirement must have an executable producer with an output artifact and a distinct independent evaluator task using verify or review that produces evidence.",
    "For every task, classify workspaceMutation from the actual operation: read_only for observation/verification with no writes, shared_write for mutating a shared workspace/resource, and append_only only when the task writes to a declared append namespace. Include resourceKeys for the logical files, records, datasets, or namespaces touched. Set isolation=git_worktree only when the selected workspace/provider capabilities and task resource boundaries require an isolated Git worktree; otherwise set isolation=shared or omit it. Do not label a task read_only if it creates or edits any deliverable.",
    ...(goalDesignPackage ? sliceConstraints : ["Use the Goal Contract and WorkflowComposerSopSkill to choose the smallest executable DAG."]),
    ...frozenValidationConstraints,
    "nodePromptSpec.nodeType must be one of plan, implement, verify, repair, review, summary, or general. Choose it from the node's role in the DAG, not from the worker profile name alone.",
    "nodePromptSpec must be specific to that node, not a copy of the global goal. Implementation nodes must include concrete boundaries and expected outputs. Validation/review nodes must include concrete testCases or verification checks and acceptanceCriteria.",
    "The generated profile instruction must explain the worker's exact responsibility, selected skills/tools/MCP grants, success criteria, and what artifact/error report it must produce.",
    "Generated component proposals are proposal-only unless they are validated agent_profile proposals selected as agentProfileRef.",
    "Use DagAndAgentProfileSop as the mandatory generation procedure.",
    ...(composerSop ? ["Use WorkflowComposerSopSkill as the mandatory slice-to-DAG procedure."] : []),
    "",
    `Goal: ${goalPrompt}`,
    "",
    "GoalContractRequirements:",
    JSON.stringify(goalContract.requirements.map((requirement) => ({
      id: requirement.id,
      statement: requirement.statement,
      acceptanceCriteria: requirement.acceptanceCriteria,
      blocking: requirement.blocking,
    }))),
    "",
    ...(composerSop
      ? [
          "WorkflowComposerSopSkill:",
          JSON.stringify({
            objectKey: composerSop.objectKey,
            versionRef: composerSop.versionRef,
            stateHash: composerSop.stateHash,
            body: composerSop.body,
          }),
          "",
        ]
      : []),
    ...(goalDesignPackage
      ? [
          "ForbiddenGoalDesignRefs:",
          JSON.stringify(forbiddenGoalDesignRefs),
          "These refs and aliases identify the Goal Design SOP used before composition. They must never be used as agentDefinitionRef, skillRefs, instructionRefs, agentProfileRef, evaluatorProfileRef, toolGrantRefs, or mcpGrantRefs.",
          "",
          "GoalDesignPackage:",
          JSON.stringify(goalDesignPackage),
          ...(goalDesignPackage.schemaVersion === "southstar.goal_design_package.v3"
            ? [
                "",
                "FrozenValidationBindings:",
                JSON.stringify(goalDesignPackage.validationBindings),
              ]
            : []),
          "",
          "SliceConstraints:",
          JSON.stringify(sliceConstraints),
          "",
        ]
      : []),
    "DagAndAgentProfileSop:",
    renderDagAndAgentProfileSop(),
    "",
    "ProfilePrimitiveCandidates:",
    JSON.stringify(boundedPacket.profilePrimitiveCandidates ?? {
      agents: [],
      skills: [],
      tools: [],
      mcpGrants: [],
      instructions: [],
    }),
    "",
    "AllowedRefsByField:",
    JSON.stringify(allowedRefsByField),
    "",
    "EvaluatorArtifactCompatibility:",
    JSON.stringify(evaluatorArtifactCompatibility),
    "",
    "GraphMetadataCandidates:",
    JSON.stringify(boundedPacket.graphMetadataCandidates ?? {
      schemaVersion: "southstar.graph_metadata_candidates.v1",
      scope: "none",
      nodes: [],
      edges: [],
    }),
    "",
    "OutputJsonSchema:",
    JSON.stringify(WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA),
    "",
    "CandidatePacketSummary:",
    JSON.stringify(candidatePacketPromptSummary(boundedPacket, packetBinding.omittedOptionalRefs)),
  ].join("\n");
}

function composerAllowedRefsByField(packet: CandidatePacket): Record<string, string[]> {
  const nodes = packet.graphMetadataCandidates?.nodes ?? [];
  const refsForKinds = (...kinds: LibraryDefinitionKind[]) => [...new Set(nodes
    .filter((node) => kinds.includes(node.kind))
    .map((node) => node.ref))].sort();
  return {
    agentDefinitionRef: refsForKinds("agent_definition"),
    skillRefs: refsForKinds("skill_spec", "skill_definition"),
    toolGrantRefs: refsForKinds("tool_definition"),
    mcpGrantRefs: refsForKinds("mcp_tool_grant"),
    instructionRefs: refsForKinds("instruction_template"),
    evaluatorProfileRef: refsForKinds("evaluator_profile"),
    inputArtifactRefs: refsForKinds("artifact_contract"),
    outputArtifactRefs: refsForKinds("artifact_contract"),
    vaultLeasePolicyRefs: refsForKinds("vault_lease_policy"),
  };
}

function composerEvaluatorArtifactCompatibility(packet: CandidatePacket): Record<string, string[]> {
  const nodes = packet.graphMetadataCandidates?.nodes ?? [];
  const evaluatorRefs = new Set(nodes.filter((node) => node.kind === "evaluator_profile").map((node) => node.ref));
  const artifactRefs = new Set(nodes.filter((node) => node.kind === "artifact_contract").map((node) => node.ref));
  const compatible = new Map<string, Set<string>>();
  for (const evaluatorRef of evaluatorRefs) compatible.set(evaluatorRef, new Set());
  for (const edge of packet.graphMetadataCandidates?.edges ?? []) {
    if (!evaluatorRefs.has(edge.from) || !artifactRefs.has(edge.to)) continue;
    if (edge.type !== "validates_artifact" && edge.type !== "validates") continue;
    compatible.get(edge.from)?.add(edge.to);
  }
  return Object.fromEntries([...compatible.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([evaluatorRef, refs]) => [evaluatorRef, [...refs].sort()]));
}

function goalDesignForbiddenRefs(goalDesignPackage: GoalDesignPackage): string[] {
  const refs = [
    goalDesignPackage.goalDesignSkillRef,
    goalDesignPackage.goalDesignSkillVersionRef,
  ].filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0);
  const slug = goalDesignPackage.goalDesignSkillRef?.startsWith("skill.")
    ? goalDesignPackage.goalDesignSkillRef.slice("skill.".length).replace(/\./g, "-")
    : undefined;
  if (slug) {
    refs.push(
      `${slug}.skill.md`,
      `skills/${slug}.skill.md`,
      `library/skills/${slug}.skill.md`,
    );
  }
  return [...new Set(refs)];
}

function renderDagAndAgentProfileSop(): string {
  return [
    "1. Interpret the user goal as the source of requirements, acceptance criteria, risk, and required deliverables.",
    "2. Use GraphMetadataCandidates.nodes and GraphMetadataCandidates.edges as the only library candidate source. Use the LLM to rank candidates by semantic fit to the goal, requirements, slice, node responsibility, titles, descriptions, and body previews.",
    "2a. Agent-to-skill uses edges are recommendations, not fixed profiles. Compose each generated profile from independently approved agent and skill primitives. Skill-to-tool, skill-to-MCP, skill-to-instruction, evaluator-to-artifact, conflict, and incompatibility edges are hard composition constraints.",
    "3. Do not select stored agent_profile refs. Every task must use a generated profile id, and that id must appear in generatedComponentProposals as kind agent_profile with validationStatus validated.",
    "4. Design a DAG, not a manifest. Use explicit dependsOn edges. Choose task count and workerKind dynamically from the goal, graph evidence, risk, and deliverables.",
    "4a. Attach every task to the requirementIds it contributes to. Explicit coordination and summary nodes are the only exception. Every blocking requirement needs artifact-producing work and an independent verify/review evaluator with evidence.",
    "5. Execution workers create or modify requested artifacts. Validation, review, or deterministic-check workers positively verify artifacts when the workflow creates or modifies them.",
    "5a. Workspace mutation is a concurrency contract, not a domain assumption: use read_only for safe parallel reads, shared_write for writes that must be serialized, append_only only for disjoint append namespaces, and git_worktree only when the task needs an isolated Git workspace. The runtime may reject an unsupported isolation request as a durable failure; never assume a worktree exists unless the task envelope says so.",
    "6. Initial workflow rule: when validation can fail, do not automatically add repair/reverify nodes. Instead, make the validation node produce a repair-ready failure artifact that conforms exactly to its selected outputArtifactRefs contract and evaluatorProfileRef. Read the declared artifact requiredFields/schemaRef/validationRules and evaluator result contract; do not invent a generic report shape or fixed field names.",
    "6a. Runtime dynamic repair rule: when the goal begins with a Runtime dynamic repair request, output a bounded appended flow: one repair node and one reverify node unless the failure evidence clearly requires more. The repair node consumes the failed artifact and prior implementation artifacts, preserves existing behavior, fixes only the reported failures, and outputs an artifact conforming to its selected contract. The reverify node depends on the repair node, reruns the failed checks plus relevant regression checks, and emits evaluator evidence using the reverify task's declared output artifact/evaluator contract.",
    "6b. Repair/reverify node prompt requirements: repair nodePromptSpec must include repairInputs, mustPreserve, implementationScope, testCases, expectedOutputs, acceptanceCriteria, and failureReportContract. Reverify nodePromptSpec must include verificationChecks, testCases, failureArtifactContract, expectedOutputs, acceptanceCriteria, and an explicit rule to set the evaluator's declared blocking/failure fields to the failing values for any blocking failure. The required fields and evidence kinds must come from the selected Library artifact/evaluator contracts.",
    "7. For each task, choose agentDefinitionRef, skillRefs, toolGrantRefs, mcpGrantRefs, instructionRefs, evaluatorProfileRef, inputArtifactRefs, and outputArtifactRefs from the graph.",
    "8. For each task, write nodePromptSpec as the worker-facing prompt brief: nodeType, node-local goal, requirements, boundaries, nonGoals, deliverableDocuments, expectedOutputs, testCases, acceptanceCriteria, and failureReportContract when failure should feed repair. The brief must quote or summarize the selected artifact/evaluator contract fields instead of relying on a generic artifact name.",
    "8a. Type-specific nodePromptSpec fields: plan uses planningQuestions/decisionCriteria/planArtifactContract; implement uses implementationScope/filesLikelyToTouch/testCases; verify uses verificationChecks/testCases/failureArtifactContract; repair uses repairInputs/mustPreserve/reverificationChecks; review uses reviewChecklist/riskCriteria; summary uses summarySections/handoffCriteria.",
    "9. Verify graph closure before output: selected skills must include their required tools, MCP grants, and instructions; evaluator must validate output artifacts; conflicting/incompatible edges must not be selected together. Do not require a pre-authored agent-to-skill edge.",
    "10. For each generated profile, output a complete agentProfile that the compiler can materialize into Docker worker input agent-profile/profile.json and task execution.",
    "11. Each agentProfile must include workerKind, provider, model, thinkingLevel, harnessRef, instruction, promptTemplateRef, contextPolicyRef, sessionPolicyRef, memoryScopes, agentsMdRefs, vaultLeasePolicyRefs, toolPolicy, budgetPolicy, and execution.",
    "12. agentProfile.execution must include engine=tork, image, command, env, mounts, timeoutSeconds, and infraRetry.maxAttempts. Use an empty mounts array for workspace access; Southstar runtime injects the real host workspace mount from the task envelope. Never output source=\"workspace\" or container paths as mount sources.",
    "12a. Preserve the provider/model/harness binding selected for the configured runtime; never substitute a default when a binding is unsupported.",
    "13. The agentProfile.instruction must be worker-specific and must name the selected skills/tools/MCP grants, success criteria, produced artifact, and failure/error-report behavior.",
    "14. toolPolicy.allowedTools must include every task.toolGrantRefs entry. agentProfile.vaultLeasePolicyRefs must include every task.vaultLeasePolicyRefs entry. budgetPolicy must include maxInputTokens, maxOutputTokens, and maxWallTimeSeconds.",
    "15. Prefer the smallest DAG that satisfies execution, positive validation, and bounded repair. Add review or summary workers only when risk or graph evidence justifies them.",
  ].join("\n");
}

function validateStrictWorkflowCompositionPlan(value: unknown): WorkflowCompositionValidationIssue[] {
  const issues: WorkflowCompositionValidationIssue[] = [];
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", "$", "plan must be a JSON object"));
    return issues;
  }

  validateObjectShape(
    value,
    [
      "schemaVersion",
      "title",
      "selectedWorkflowTemplateRef",
      "rationale",
      "tasks",
      "rejectedCandidates",
      "generatedComponentProposals",
    ],
    [
      "schemaVersion",
      "title",
      "rationale",
      "tasks",
      "rejectedCandidates",
      "generatedComponentProposals",
    ],
    "$",
    issues,
  );

  if (value.schemaVersion !== "southstar.workflow_composition_plan.v1") {
    issues.push(
      issue(
        "composer_output_schema_violation",
        "schemaVersion",
        "schemaVersion must be southstar.workflow_composition_plan.v1",
      ),
    );
  }
  requireString(value.title, "title", issues);
  if (value.selectedWorkflowTemplateRef !== undefined) {
    requireString(value.selectedWorkflowTemplateRef, "selectedWorkflowTemplateRef", issues);
  }
  requireString(value.rationale, "rationale", issues);

  if (!Array.isArray(value.tasks)) {
    issues.push(issue("composer_output_schema_violation", "tasks", "tasks must be an array"));
  } else {
    if (value.tasks.length === 0) {
      issues.push(issue("composer_output_schema_violation", "tasks", "tasks must contain at least 1 item"));
    }
    for (const [index, task] of value.tasks.entries()) {
      validateTask(task, index, issues);
    }
  }

  if (!Array.isArray(value.rejectedCandidates)) {
    issues.push(issue("composer_output_schema_violation", "rejectedCandidates", "rejectedCandidates must be an array"));
  } else {
    for (const [index, candidate] of value.rejectedCandidates.entries()) {
      validateRejectedCandidate(candidate, index, issues);
    }
  }

  if (!Array.isArray(value.generatedComponentProposals)) {
    issues.push(
      issue(
        "composer_output_schema_violation",
        "generatedComponentProposals",
        "generatedComponentProposals must be an array",
      ),
    );
  } else {
    for (const [index, proposal] of value.generatedComponentProposals.entries()) {
      validateGeneratedComponentProposal(proposal, index, issues);
    }
  }

  return issues;
}

function validateTask(value: unknown, index: number, issues: WorkflowCompositionValidationIssue[]): void {
  const path = `tasks.${index}`;
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "task must be an object"));
    return;
  }
  validateObjectShape(
    value,
    [
      ...TASK_STRING_FIELDS,
      ...TASK_STRING_ARRAY_FIELDS,
      "nodePromptSpec",
      "contextPolicyRef",
      "workspacePolicyRef",
      "workspaceMutation",
    ],
    [...TASK_STRING_FIELDS, ...TASK_STRING_ARRAY_FIELDS, "nodePromptSpec"],
    path,
    issues,
  );
  for (const field of TASK_STRING_FIELDS) {
    requireString(value[field], `${path}.${field}`, issues);
  }
  for (const field of TASK_STRING_ARRAY_FIELDS) {
    requireStringArray(value[field], `${path}.${field}`, issues);
  }
  if (value.contextPolicyRef !== undefined) {
    requireString(value.contextPolicyRef, `${path}.contextPolicyRef`, issues);
  }
  if (value.workspacePolicyRef !== undefined) {
    requireString(value.workspacePolicyRef, `${path}.workspacePolicyRef`, issues);
  }
  if (value.workspaceMutation !== undefined) {
    validateWorkspaceMutation(value.workspaceMutation, `${path}.workspaceMutation`, issues);
  }
  validateNodePromptSpec(value.nodePromptSpec, `${path}.nodePromptSpec`, issues);
}

function validateWorkspaceMutation(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "workspaceMutation must be an object"));
    return;
  }
  validateObjectShape(value, ["mode", "isolation", "resourceKeys"], ["mode"], path, issues);
  if (!["read_only", "shared_write", "append_only"].includes(typeof value.mode === "string" ? value.mode : "")) {
    issues.push(issue("composer_output_schema_violation", `${path}.mode`, "must be read_only, shared_write, or append_only"));
  }
  if (value.isolation !== undefined && !["shared", "git_worktree"].includes(typeof value.isolation === "string" ? value.isolation : "")) {
    issues.push(issue("composer_output_schema_violation", `${path}.isolation`, "must be shared or git_worktree"));
  }
  if (value.resourceKeys !== undefined) requireStringArray(value.resourceKeys, `${path}.resourceKeys`, issues);
}

function validateNodePromptSpec(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "nodePromptSpec must be an object"));
    return;
  }
  validateObjectShape(
    value,
    [
      "nodeType",
      "goal",
      "requirements",
      "boundaries",
      "nonGoals",
      "deliverableDocuments",
      "expectedOutputs",
      "testCases",
      "acceptanceCriteria",
      "failureReportContract",
      "planningQuestions",
      "decisionCriteria",
      "planArtifactContract",
      "implementationScope",
      "filesLikelyToTouch",
      "verificationChecks",
      "failureArtifactContract",
      "repairInputs",
      "mustPreserve",
      "reverificationChecks",
      "reviewChecklist",
      "riskCriteria",
      "summarySections",
      "handoffCriteria",
    ],
    ["nodeType", "goal", "requirements", "boundaries", "nonGoals", "deliverableDocuments", "expectedOutputs", "testCases", "acceptanceCriteria"],
    path,
    issues,
  );
  const nodeType = typeof value.nodeType === "string" ? value.nodeType : "";
  if (!["plan", "implement", "verify", "repair", "review", "summary", "general"].includes(nodeType)) {
    issues.push(issue("composer_output_schema_violation", `${path}.nodeType`, "must be one of: plan, implement, verify, repair, review, summary, general"));
  }
  requireString(value.goal, `${path}.goal`, issues);
  requireNonEmptyStringArray(value.requirements, `${path}.requirements`, issues);
  requireStringArray(value.boundaries, `${path}.boundaries`, issues);
  requireStringArray(value.nonGoals, `${path}.nonGoals`, issues);
  validateDeliverableDocuments(value.deliverableDocuments, `${path}.deliverableDocuments`, issues);
  requireNonEmptyStringArray(value.expectedOutputs, `${path}.expectedOutputs`, issues);
  requireNonEmptyStringArray(value.acceptanceCriteria, `${path}.acceptanceCriteria`, issues);
  if (value.failureReportContract !== undefined) {
    requireString(value.failureReportContract, `${path}.failureReportContract`, issues);
  }
  for (const field of [
    "planningQuestions",
    "decisionCriteria",
    "implementationScope",
    "filesLikelyToTouch",
    "verificationChecks",
    "repairInputs",
    "mustPreserve",
    "reverificationChecks",
    "reviewChecklist",
    "riskCriteria",
    "summarySections",
    "handoffCriteria",
  ]) {
    if (value[field] !== undefined) requireStringArray(value[field], `${path}.${field}`, issues);
  }
  for (const field of ["planArtifactContract", "failureArtifactContract"]) {
    if (value[field] !== undefined) requireString(value[field], `${path}.${field}`, issues);
  }
  if (!Array.isArray(value.testCases)) {
    issues.push(issue("composer_output_schema_violation", `${path}.testCases`, "must be a test case[]"));
    return;
  }
  for (const [index, testCase] of value.testCases.entries()) {
    validateNodePromptTestCase(testCase, `${path}.testCases.${index}`, issues);
  }
  validateNodeTypeSpecificPromptSpec(value, nodeType, path, issues);
}

function validateDeliverableDocuments(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "must be a deliverable document[]"));
    return;
  }
  for (const [index, document] of value.entries()) {
    validateDeliverableDocument(document, `${path}.${index}`, issues);
  }
}

function validateDeliverableDocument(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "deliverable document must be an object"));
    return;
  }
  validateObjectShape(value, ["kind", "title", "required", "format", "description"], ["kind", "title", "required", "format", "description"], path, issues);
  if (!["design", "implementation", "test", "acceptance", "verification", "summary", "handoff", "other"].includes(typeof value.kind === "string" ? value.kind : "")) {
    issues.push(issue("composer_output_schema_violation", `${path}.kind`, "must be one of: design, implementation, test, acceptance, verification, summary, handoff, other"));
  }
  requireString(value.title, `${path}.title`, issues);
  if (typeof value.required !== "boolean") {
    issues.push(issue("composer_output_schema_violation", `${path}.required`, "must be a boolean"));
  }
  if (!["markdown", "json", "file", "inline"].includes(typeof value.format === "string" ? value.format : "")) {
    issues.push(issue("composer_output_schema_violation", `${path}.format`, "must be one of: markdown, json, file, inline"));
  }
  requireString(value.description, `${path}.description`, issues);
}

function validateNodeTypeSpecificPromptSpec(
  value: Record<string, unknown>,
  nodeType: string,
  path: string,
  issues: WorkflowCompositionValidationIssue[],
): void {
  if (nodeType === "plan" && stringArray(value.planningQuestions).length === 0 && stringArray(value.decisionCriteria).length === 0) {
    issues.push(issue("composer_output_schema_violation", `${path}.planningQuestions`, "plan node must include planningQuestions or decisionCriteria"));
  }
  if (nodeType === "implement" && stringArray(value.implementationScope).length === 0) {
    issues.push(issue("composer_output_schema_violation", `${path}.implementationScope`, "implement node must include implementationScope"));
  }
  if (nodeType === "verify" && stringArray(value.verificationChecks).length === 0 && Array.isArray(value.testCases) && value.testCases.length === 0) {
    issues.push(issue("composer_output_schema_violation", `${path}.verificationChecks`, "verify node must include verificationChecks or testCases"));
  }
  if (nodeType === "repair" && stringArray(value.repairInputs).length === 0) {
    issues.push(issue("composer_output_schema_violation", `${path}.repairInputs`, "repair node must include repairInputs"));
  }
  if (nodeType === "review" && stringArray(value.reviewChecklist).length === 0) {
    issues.push(issue("composer_output_schema_violation", `${path}.reviewChecklist`, "review node must include reviewChecklist"));
  }
  if (nodeType === "summary" && stringArray(value.summarySections).length === 0) {
    issues.push(issue("composer_output_schema_violation", `${path}.summarySections`, "summary node must include summarySections"));
  }
}

function validateNodePromptTestCase(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "test case must be an object"));
    return;
  }
  validateObjectShape(value, ["name", "command", "expected", "given", "when", "then"], ["name", "expected"], path, issues);
  requireString(value.name, `${path}.name`, issues);
  requireString(value.expected, `${path}.expected`, issues);
  for (const field of ["command", "given", "when", "then"]) {
    if (value[field] !== undefined) requireString(value[field], `${path}.${field}`, issues);
  }
}

function validateRejectedCandidate(value: unknown, index: number, issues: WorkflowCompositionValidationIssue[]): void {
  const path = `rejectedCandidates.${index}`;
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "rejected candidate must be an object"));
    return;
  }
  validateObjectShape(value, ["ref", "reason"], ["ref", "reason"], path, issues);
  requireString(value.ref, `${path}.ref`, issues);
  requireString(value.reason, `${path}.reason`, issues);
}

function validateGeneratedComponentProposal(
  value: unknown,
  index: number,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const path = `generatedComponentProposals.${index}`;
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "generated component proposal must be an object"));
    return;
  }
  validateObjectShape(
    value,
    ["id", "kind", "risk", "reason", "validationStatus", "agentProfile"],
    ["id", "kind", "risk", "reason", "validationStatus"],
    path,
    issues,
  );
  requireString(value.id, `${path}.id`, issues);
  requireString(value.reason, `${path}.reason`, issues);
  if (typeof value.kind !== "string" || !LIBRARY_DEFINITION_KIND_SET.has(value.kind)) {
    issues.push(
      issue(
        "composer_output_schema_violation",
        `${path}.kind`,
        `kind must be one of: ${LIBRARY_DEFINITION_KIND_VALUES.join(", ")}`,
      ),
    );
  }
  if (value.risk !== "low" && value.risk !== "medium" && value.risk !== "high") {
    issues.push(issue("composer_output_schema_violation", `${path}.risk`, "risk must be one of: low, medium, high"));
  }
  if (value.validationStatus !== "validated" && value.validationStatus !== "unvalidated") {
    issues.push(
      issue(
        "composer_output_schema_violation",
        `${path}.validationStatus`,
        "validationStatus must be one of: validated, unvalidated",
      ),
    );
  }
  if (value.agentProfile !== undefined) {
    validateAgentProfile(value.agentProfile, `${path}.agentProfile`, issues);
  }
}

function validateAgentProfile(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "agentProfile must be an object"));
    return;
  }
  validateObjectShape(
    value,
    [
      "workerKind",
      "provider",
      "model",
      "thinkingLevel",
      "harnessRef",
      "instruction",
      "promptTemplateRef",
      "contextPolicyRef",
      "sessionPolicyRef",
      "memoryScopes",
      "agentsMdRefs",
      "vaultLeasePolicyRefs",
      "toolPolicy",
      "budgetPolicy",
      "execution",
    ],
    [
      "workerKind",
      "provider",
      "model",
      "thinkingLevel",
      "harnessRef",
      "instruction",
      "promptTemplateRef",
      "contextPolicyRef",
      "sessionPolicyRef",
      "memoryScopes",
      "agentsMdRefs",
      "vaultLeasePolicyRefs",
      "toolPolicy",
      "budgetPolicy",
      "execution",
    ],
    path,
    issues,
  );
  for (const field of ["workerKind", "provider", "model", "thinkingLevel", "harnessRef", "instruction", "promptTemplateRef", "contextPolicyRef", "sessionPolicyRef"]) {
    if (value[field] !== undefined) requireString(value[field], `${path}.${field}`, issues);
  }
  const image = isRecord(value.execution) ? value.execution.image : undefined;
  for (const field of ["memoryScopes", "agentsMdRefs", "vaultLeasePolicyRefs"]) {
    if (value[field] !== undefined) requireStringArray(value[field], `${path}.${field}`, issues);
  }
  if (value.toolPolicy !== undefined) {
    validatePolicyStringArrays(
      value.toolPolicy,
      `${path}.toolPolicy`,
      ["allowedTools", "deniedTools", "requiresApprovalFor"],
      ["allowedTools", "deniedTools", "requiresApprovalFor"],
      issues,
    );
  }
  if (value.budgetPolicy !== undefined) {
    validateBudgetPolicy(value.budgetPolicy, `${path}.budgetPolicy`, issues, ["maxInputTokens", "maxOutputTokens", "maxWallTimeSeconds"]);
  }
  if (value.execution !== undefined) {
    validateExecutionSpec(value.execution, `${path}.execution`, issues);
  }
}

function validatePolicyStringArrays(
  value: unknown,
  path: string,
  fields: string[],
  requiredFields: string[],
  issues: WorkflowCompositionValidationIssue[],
): void {
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "must be an object"));
    return;
  }
  validateObjectShape(value, fields, requiredFields, path, issues);
  for (const field of fields) {
    if (value[field] !== undefined) requireStringArray(value[field], `${path}.${field}`, issues);
  }
}

function validateBudgetPolicy(
  value: unknown,
  path: string,
  issues: WorkflowCompositionValidationIssue[],
  requiredFields: string[] = [],
): void {
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "must be an object"));
    return;
  }
  const fields = ["maxInputTokens", "maxOutputTokens", "maxCostMicrosUsd", "maxWallTimeSeconds"];
  validateObjectShape(value, fields, requiredFields, path, issues);
  for (const field of fields) {
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) {
      issues.push(issue("composer_output_schema_violation", `${path}.${field}`, "must be a finite number"));
    }
  }
}

function validateExecutionSpec(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "must be an object"));
    return;
  }
  validateObjectShape(
    value,
    ["engine", "image", "command", "env", "mounts", "timeoutSeconds", "infraRetry"],
    ["engine", "image", "command", "env", "mounts", "timeoutSeconds", "infraRetry"],
    path,
    issues,
  );
  if (value.engine !== undefined && value.engine !== "tork") {
    issues.push(issue("composer_output_schema_violation", `${path}.engine`, "must be tork"));
  }
  for (const field of ["image"] as const) {
    if (value[field] !== undefined) requireString(value[field], `${path}.${field}`, issues);
  }
  if (value.command !== undefined) requireStringArray(value.command, `${path}.command`, issues);
  if (Array.isArray(value.command) && value.command[0] !== GENERATED_AGENT_PROFILE_COMMAND_ENTRYPOINT) {
    issues.push(issue("composer_output_schema_violation", `${path}.command`, `must start with ${GENERATED_AGENT_PROFILE_COMMAND_ENTRYPOINT}`));
  }
  if (value.env !== undefined && (!isRecord(value.env) || Object.values(value.env).some((item) => typeof item !== "string"))) {
    issues.push(issue("composer_output_schema_violation", `${path}.env`, "must be an object with string values"));
  }
  if (value.mounts !== undefined && !Array.isArray(value.mounts)) {
    issues.push(issue("composer_output_schema_violation", `${path}.mounts`, "must be an array"));
  }
  if (Array.isArray(value.mounts)) {
    for (const [index, mount] of value.mounts.entries()) {
      if (!isRecord(mount) || Array.isArray(mount)) {
        issues.push(issue("composer_output_schema_violation", `${path}.mounts.${index}`, "must be an object"));
        continue;
      }
      validateObjectShape(mount, ["source", "target", "readonly"], [], `${path}.mounts.${index}`, issues);
      if (mount.source !== undefined) requireString(mount.source, `${path}.mounts.${index}.source`, issues);
      if (mount.target !== undefined) requireString(mount.target, `${path}.mounts.${index}.target`, issues);
      if (mount.readonly !== undefined && typeof mount.readonly !== "boolean") {
        issues.push(issue("composer_output_schema_violation", `${path}.mounts.${index}.readonly`, "must be a boolean"));
      }
    }
  }
  if (value.timeoutSeconds !== undefined && (typeof value.timeoutSeconds !== "number" || !Number.isFinite(value.timeoutSeconds))) {
    issues.push(issue("composer_output_schema_violation", `${path}.timeoutSeconds`, "must be a finite number"));
  }
  if (value.infraRetry !== undefined) {
    if (!isRecord(value.infraRetry) || Array.isArray(value.infraRetry)) {
      issues.push(issue("composer_output_schema_violation", `${path}.infraRetry`, "must be an object"));
    } else {
      validateObjectShape(value.infraRetry, ["maxAttempts"], ["maxAttempts"], `${path}.infraRetry`, issues);
      if (value.infraRetry.maxAttempts !== undefined && (typeof value.infraRetry.maxAttempts !== "number" || !Number.isFinite(value.infraRetry.maxAttempts))) {
        issues.push(issue("composer_output_schema_violation", `${path}.infraRetry.maxAttempts`, "must be a finite number"));
      }
    }
  }
}

function validateObjectShape(
  value: Record<string, unknown>,
  allowedKeys: string[],
  requiredKeys: string[],
  path: string,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push(issue("composer_output_schema_violation", `${path}.${key}`, `unexpected property: ${key}`));
    }
  }
  for (const key of requiredKeys) {
    if (!(key in value)) {
      issues.push(issue("composer_output_schema_violation", `${path}.${key}`, `missing required property: ${key}`));
    }
  }
}

function requireString(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(issue("composer_output_schema_violation", path, "must be a non-empty string"));
  }
}

function requireStringArray(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(issue("composer_output_schema_violation", path, "must be a string[]"));
    return;
  }
  if (value.some((item) => typeof item !== "string" || item.length === 0)) {
    issues.push(issue("composer_output_schema_violation", path, "must be a string[] with non-empty values"));
  }
}

function requireNonEmptyStringArray(value: unknown, path: string, issues: WorkflowCompositionValidationIssue[]): void {
  requireStringArray(value, path, issues);
  if (Array.isArray(value) && value.length === 0) {
    issues.push(issue("composer_output_schema_violation", path, "must contain at least 1 item"));
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

type BoundCandidatePacket = {
  packet: CandidatePacket;
  omittedOptionalRefs: string[];
};

function boundCandidatePacket(packet: CandidatePacket, budgetChars?: number, pinnedRefs: Set<string> = new Set()): BoundCandidatePacket {
  if (!Number.isFinite(budgetChars) || (budgetChars ?? 0) <= 0 || JSON.stringify(packet).length <= budgetChars!) {
    return { packet, omittedOptionalRefs: [] };
  }

  const requiredRefs = new Set([
    ...pinnedRefs,
    ...(packet.requirementSpec.requiredCapabilities ?? []),
    ...(packet.requirementSpec.expectedArtifacts ?? []),
  ]);
  const graph = packet.graphMetadataCandidates;
  const graphClosure = graph ? graphClosureRefs(graph, requiredRefs) : new Set<string>();
  const requiredCandidateRefs = new Set([...requiredRefs, ...graphClosure]);
  const reduced = structuredClone(packet) as CandidatePacket;
  const omittedOptionalRefs = new Set<string>();

  reduced.workflowTemplateCandidates = retainRequiredCandidates(packet.workflowTemplateCandidates, requiredCandidateRefs, omittedOptionalRefs);
  reduced.artifactContractCandidates = retainRequiredCandidates(packet.artifactContractCandidates, requiredCandidateRefs, omittedOptionalRefs);
  reduced.policyConstraints = retainRequiredCandidates(packet.policyConstraints, requiredCandidateRefs, omittedOptionalRefs);
  reduced.agentCandidatesByCapability = retainCandidateMap(packet.agentCandidatesByCapability, requiredCandidateRefs, omittedOptionalRefs);
  reduced.profileCandidatesByAgent = retainCandidateMap(packet.profileCandidatesByAgent, requiredCandidateRefs, omittedOptionalRefs);
  reduced.skillCandidatesByProfile = retainCandidateMap(packet.skillCandidatesByProfile, requiredCandidateRefs, omittedOptionalRefs);
  reduced.toolCandidatesByProfile = retainCandidateMap(packet.toolCandidatesByProfile, requiredCandidateRefs, omittedOptionalRefs);
  reduced.mcpGrantCandidatesByProfile = retainCandidateMap(packet.mcpGrantCandidatesByProfile, requiredCandidateRefs, omittedOptionalRefs);
  reduced.vaultLeaseCandidatesByProfile = retainCandidateMap(packet.vaultLeaseCandidatesByProfile, requiredCandidateRefs, omittedOptionalRefs);
  reduced.instructionCandidatesByProfile = retainCandidateMap(packet.instructionCandidatesByProfile, requiredCandidateRefs, omittedOptionalRefs);
  reduced.evaluatorCandidatesByArtifact = retainCandidateMap(packet.evaluatorCandidatesByArtifact, requiredCandidateRefs, omittedOptionalRefs);
  if (graph) {
    reduced.graphMetadataCandidates = {
      ...graph,
      // Graph metadata is the authoritative selectable ontology. Keep its
      // nodes and edges intact; only optional summary candidate arrays may be
      // reduced by an explicit host budget.
      nodes: [...graph.nodes],
      edges: [...graph.edges],
    };
  }

  const optionalEntries = collectOptionalCandidateEntries(packet, requiredCandidateRefs);
  for (const entry of optionalEntries) {
    const candidate = entry.candidate;
    entry.add(reduced, candidate);
    if (JSON.stringify(reduced).length > budgetChars!) {
      entry.remove(reduced, candidate);
      omittedOptionalRefs.add(candidate.ref);
    }
  }
  if (JSON.stringify(reduced).length > budgetChars!) {
    throw new Error(`candidate packet required closure exceeds configured character budget: ${budgetChars}`);
  }
  return { packet: reduced, omittedOptionalRefs: [...omittedOptionalRefs].sort() };
}

function candidatePacketPromptSummary(packet: CandidatePacket, omittedOptionalRefs: string[] = []): Record<string, unknown> {
  return {
    requirementSpec: packet.requirementSpec,
    workflowTemplateCandidates: packet.workflowTemplateCandidates,
    agentCandidatesByCapability: packet.agentCandidatesByCapability,
    artifactContractCandidates: packet.artifactContractCandidates,
    evaluatorCandidatesByArtifact: packet.evaluatorCandidatesByArtifact,
    policyConstraints: packet.policyConstraints,
    unavailableRequirements: packet.unavailableRequirements,
    graphMetadataCandidateCounts: packet.graphMetadataCandidates
      ? {
        nodes: packet.graphMetadataCandidates.nodes.length,
        edges: packet.graphMetadataCandidates.edges.length,
      }
      : { nodes: 0, edges: 0 },
    profilePrimitiveCandidateCounts: packet.profilePrimitiveCandidates
      ? {
        agents: packet.profilePrimitiveCandidates.agents.length,
        skills: packet.profilePrimitiveCandidates.skills.length,
        tools: packet.profilePrimitiveCandidates.tools.length,
        mcpGrants: packet.profilePrimitiveCandidates.mcpGrants.length,
        instructions: packet.profilePrimitiveCandidates.instructions.length,
      }
      : { agents: 0, skills: 0, tools: 0, mcpGrants: 0, instructions: 0 },
    omittedOptionalRefs,
  };
}

function pinnedRefsForGoal(goalContract: GoalContractV1, goalDesignPackage?: ComposeWorkflowInput["goalDesignPackage"]): Set<string> {
  const refs = new Set<string>([
    ...goalContract.requiredCapabilities,
    ...goalContract.expectedArtifactRefs,
  ]);
  const policy = goalDesignPackage?.templatePolicy;
  if (policy && policy.mode !== "auto") refs.add(policy.templateRef);
  for (const binding of goalDesignPackage?.validationBindings ?? []) {
    for (const criterionBinding of binding.criterionBindings) {
      refs.add(criterionBinding.evaluatorProfileRef);
      refs.add(criterionBinding.artifactContractRef);
    }
  }
  return refs;
}

function graphClosureRefs(
  graph: NonNullable<CandidatePacket["graphMetadataCandidates"]>,
  pinnedRefs: Set<string>,
): Set<string> {
  const closure = new Set(pinnedRefs);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (closure.has(edge.from) && !closure.has(edge.to)) {
        closure.add(edge.to);
        changed = true;
      }
      if (closure.has(edge.to) && !closure.has(edge.from)) {
        closure.add(edge.from);
        changed = true;
      }
    }
  }
  return closure;
}

function retainRequiredCandidates(
  candidates: CandidatePacket["workflowTemplateCandidates"],
  requiredRefs: Set<string>,
  omitted: Set<string>,
): CandidatePacket["workflowTemplateCandidates"] {
  return candidates.filter((candidate) => {
    if (requiredRefs.has(candidate.ref)) return true;
    omitted.add(candidate.ref);
    return false;
  });
}

function retainCandidateMap(
  candidates: Record<string, CandidatePacket["workflowTemplateCandidates"]>,
  requiredRefs: Set<string>,
  omitted: Set<string>,
): Record<string, CandidatePacket["workflowTemplateCandidates"]> {
  const result: Record<string, CandidatePacket["workflowTemplateCandidates"]> = {};
  for (const [key, values] of Object.entries(candidates)) {
    const retained = retainRequiredCandidates(values, requiredRefs, omitted);
    if (requiredRefs.has(key) || retained.length > 0) result[key] = retained;
  }
  return result;
}

type OptionalCandidateEntry = {
  candidate: CandidatePacket["workflowTemplateCandidates"][number];
  add: (packet: CandidatePacket, candidate: CandidatePacket["workflowTemplateCandidates"][number]) => void;
  remove: (packet: CandidatePacket, candidate: CandidatePacket["workflowTemplateCandidates"][number]) => void;
};

function collectOptionalCandidateEntries(packet: CandidatePacket, requiredRefs: Set<string>): OptionalCandidateEntry[] {
  const entries: OptionalCandidateEntry[] = [];
  const addArray = (get: (value: CandidatePacket) => CandidatePacket["workflowTemplateCandidates"], set: (value: CandidatePacket, next: CandidatePacket["workflowTemplateCandidates"]) => void) => {
    for (const candidate of get(packet)) {
      if (requiredRefs.has(candidate.ref)) continue;
      entries.push({
        candidate,
        add: (value, next) => set(value, [...get(value), next]),
        remove: (value, next) => set(value, get(value).filter((item) => item.ref !== next.ref)),
      });
    }
  };
  addArray((value) => value.workflowTemplateCandidates, (value, next) => { value.workflowTemplateCandidates = next; });
  addArray((value) => value.artifactContractCandidates, (value, next) => { value.artifactContractCandidates = next; });
  addArray((value) => value.policyConstraints, (value, next) => { value.policyConstraints = next; });
  return entries.sort((left, right) => left.candidate.ref.localeCompare(right.candidate.ref));
}

function issue(
  code: WorkflowCompositionValidationIssue["code"],
  path: string,
  message: string,
): WorkflowCompositionValidationIssue {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

const TASK_STRING_FIELDS: Array<keyof WorkflowCompositionTask> = [
  "id",
  "sliceId",
  "name",
  "responsibility",
  "templateSlotRef",
  "agentDefinitionRef",
  "agentProfileRef",
  "evaluatorProfileRef",
  "rationale",
];

const TASK_STRING_ARRAY_FIELDS: Array<keyof WorkflowCompositionTask> = [
  "requirementIds",
  "dependsOn",
  "instructionRefs",
  "skillRefs",
  "toolGrantRefs",
  "mcpGrantRefs",
  "vaultLeasePolicyRefs",
  "inputArtifactRefs",
  "outputArtifactRefs",
  "recoveryStrategyRefs",
];
