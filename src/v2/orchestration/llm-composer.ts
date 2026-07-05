import type {
  CandidatePacket,
  LibraryDefinitionKind,
  WorkflowCompositionPlan,
  WorkflowCompositionTask,
  WorkflowCompositionValidationIssue,
} from "../design-library/types.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "./composer.ts";
import {
  GENERATED_AGENT_PROFILE_ALLOWED_VALUES,
  GENERATED_AGENT_PROFILE_COMMAND_ENTRYPOINT,
  GENERATED_AGENT_PROFILE_HARNESSES,
  GENERATED_AGENT_PROFILE_IMAGES,
  GENERATED_AGENT_PROFILE_MODELS,
  GENERATED_AGENT_PROFILE_PROVIDERS,
  GENERATED_AGENT_PROFILE_THINKING_LEVELS,
  GENERATED_AGENT_PROFILE_WORKER_KINDS,
  isAllowedGeneratedAgentProfileValue,
  runtimeBindingForGeneratedProfileImage,
} from "./generated-agent-profile-policy.ts";

export type LlmTextClient = {
  generateText(input: { model: string; prompt: string; temperature?: number }): Promise<string>;
  generateTextStream?: (
    input: { model: string; prompt: string; temperature?: number },
    handlers: { onDelta?: (text: string) => void },
  ) => Promise<string>;
};

export type LlmWorkflowComposerOptions = {
  model: string;
  client: LlmTextClient;
  maxOutputChars?: number;
  temperature?: number;
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
    "selectedWorkflowTemplateRef",
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
        "name",
        "responsibility",
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
        name: { type: "string", minLength: 1 },
        responsibility: { type: "string", minLength: 1 },
        nodePromptSpec: { $ref: "#/$defs/nodePromptSpec" },
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
        workerKind: { type: "string", enum: [...GENERATED_AGENT_PROFILE_WORKER_KINDS] },
        provider: { type: "string", enum: [...GENERATED_AGENT_PROFILE_PROVIDERS] },
        model: { type: "string", enum: [...GENERATED_AGENT_PROFILE_MODELS] },
        thinkingLevel: { type: "string", enum: [...GENERATED_AGENT_PROFILE_THINKING_LEVELS] },
        harnessRef: { type: "string", enum: [...GENERATED_AGENT_PROFILE_HARNESSES] },
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
            engine: { type: "string", enum: ["tork"] },
            image: { type: "string", enum: [...GENERATED_AGENT_PROFILE_IMAGES] },
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
    const prompt = renderComposerPrompt(input.goalPrompt, input.candidatePacket);
    const textInput = {
      model: this.options.model,
      prompt,
      temperature: this.options.temperature ?? 0,
    };
    const text = this.options.client.generateTextStream
      ? await this.options.client.generateTextStream(textInput, { onDelta: input.onLlmDelta })
      : await this.options.client.generateText(textInput);
    return parseWorkflowCompositionPlanFromText(text, this.options.maxOutputChars ?? 100_000);
  }
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

export function renderComposerPrompt(goalPrompt: string, candidatePacket: CandidatePacket): string {
  const boundedPacket = boundCandidatePacket(candidatePacket);
  return [
    "You are Southstar's library-constrained workflow architect.",
    "Return exactly one JSON object matching schemaVersion southstar.workflow_composition_plan.v1.",
    "Do not return markdown, comments, prose, or multiple JSON objects.",
    "Do not use alias fields. Use exactly the property names defined in OutputJsonSchema.",
    "Select refs only from the candidate packet.",
    "Do not output runtime manifests, secrets, credentials, tool grant definitions, MCP grant definitions, or vault lease values. Vault may appear only as vaultLeasePolicyRefs selected from graph nodes.",
    "Use GraphMetadataCandidates as the direct source of selectable refs for DAG tasks and generated profiles.",
    "When GraphMetadataCandidates is present, selected agentDefinitionRef, skillRef, toolGrantRef, mcpGrantRef, instructionRef, artifact ref, and evaluator ref must come from GraphMetadataCandidates.nodes.",
    "Do not select stored agent_profile refs from the library. For every DAG task, create a generated agent profile id and include it in generatedComponentProposals as kind agent_profile with validationStatus validated.",
    "Use GraphMetadataCandidates.edges to justify profile closure: agent uses skill, skill requires tools, skill allows MCP grants, and skill uses instructions.",
    "You may propose a generated agent profile only by combining refs from profilePrimitiveCandidates and GraphMetadataCandidates.",
    "When selecting a generated profile, include it in generatedComponentProposals with kind agent_profile, validationStatus validated, and agentProfile.",
    "Each agentProfile must define the workerKind, provider, model, thinkingLevel/effort, harnessRef host adapter, instruction, promptTemplateRef, contextPolicyRef, sessionPolicyRef, toolPolicy, budgetPolicy, memoryScopes, agentsMdRefs, vaultLeasePolicyRefs, and execution.",
    "agentProfile.execution must include all Docker/Tork worker input needed by the compiler: engine, image, command, env, mounts, timeoutSeconds, and infraRetry.",
    "Use only values from GeneratedAgentProfileAllowedValues for workerKind, provider, model, thinkingLevel, harnessRef, execution.engine, execution.image, and execution.command[0].",
    "Use harnessRef as the host adapter. For the current runtime image southstar/pi-agent:local, every generated profile must use provider=pi, harnessRef=pi, and model=pi-agent-default.",
    "Never pair provider=codex or harnessRef=codex with southstar/pi-agent:local. Codex requires a different runtime image that is not currently in GeneratedAgentProfileAllowedValues.",
    "Design for harness engineering: choose workerKind per task from execution_worker, validation_worker, repair_worker, or review_worker based on the goal, risk, and required artifacts.",
    "For workflows that create or modify artifacts, include a positive validation path with validation_worker, review_worker, deterministic checks, or another graph-justified verifier. Do not add fixed worker nodes when the goal does not require them.",
    "Validation-oriented agent profiles may use a lightweight/no-reasoning model profile when deterministic shell/test verification is sufficient, but must still include provider, harnessRef, instruction, toolPolicy, and budgetPolicy.",
    "If validation can fail, encode a repair loop in the DAG: the validation task produces an error/report artifact, and a downstream repair/execution task consumes that artifact, fixes the issue, and is followed by another validation task. Keep the loop bounded by explicit tasks rather than cycles.",
    "Every task must include nodePromptSpec. Treat nodePromptSpec as the per-node prompt contract that the Docker worker will see: nodeType, goal, requirements, boundaries, nonGoals, deliverableDocuments, expectedOutputs, testCases, acceptanceCriteria, and optional failureReportContract.",
    "nodePromptSpec.nodeType must be one of plan, implement, verify, repair, review, summary, or general. Choose it from the node's role in the DAG, not from the worker profile name alone.",
    "nodePromptSpec must be specific to that node, not a copy of the global goal. Implementation nodes must include concrete boundaries and expected outputs. Validation/review nodes must include concrete testCases or verification checks and acceptanceCriteria.",
    "The generated profile instruction must explain the worker's exact responsibility, selected skills/tools/MCP grants, success criteria, and what artifact/error report it must produce.",
    "Generated component proposals are proposal-only unless they are validated agent_profile proposals selected as agentProfileRef.",
    "Use DagAndAgentProfileSop as the mandatory generation procedure.",
    "",
    `Goal: ${goalPrompt}`,
    "",
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
    "GraphMetadataCandidates:",
    JSON.stringify(boundedPacket.graphMetadataCandidates ?? {
      schemaVersion: "southstar.graph_metadata_candidates.v1",
      scope: "none",
      nodes: [],
      edges: [],
    }),
    "",
    "GeneratedAgentProfileAllowedValues:",
    JSON.stringify(GENERATED_AGENT_PROFILE_ALLOWED_VALUES),
    "",
    "OutputJsonSchema:",
    JSON.stringify(WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA),
    "",
    "CandidatePacket:",
    JSON.stringify(boundedPacket),
  ].join("\n");
}

function renderDagAndAgentProfileSop(): string {
  return [
    "1. Interpret the user goal as the source of requirements, acceptance criteria, risk, and required deliverables.",
    "2. Use GraphMetadataCandidates.nodes and GraphMetadataCandidates.edges as the only library candidate source. Build a task-specific candidate subgraph by semantic fit to the goal and by edge closure.",
    "3. Do not select stored agent_profile refs. Every task must use a generated profile id, and that id must appear in generatedComponentProposals as kind agent_profile with validationStatus validated.",
    "4. Design a DAG, not a manifest. Use explicit dependsOn edges. Choose task count and workerKind dynamically from the goal, graph evidence, risk, and deliverables.",
    "5. Execution workers create or modify requested artifacts. Validation, review, or deterministic-check workers positively verify artifacts when the workflow creates or modifies them.",
    "6. If validation can fail, add bounded repair flow using explicit nodes: validation produces an error/report artifact, a downstream repair/execution worker consumes that artifact, and a following validation worker verifies the repaired output. Never create cyclic dependencies.",
    "7. For each task, choose agentDefinitionRef, skillRefs, toolGrantRefs, mcpGrantRefs, instructionRefs, evaluatorProfileRef, inputArtifactRefs, and outputArtifactRefs from the graph.",
    "8. For each task, write nodePromptSpec as the worker-facing prompt brief: nodeType, node-local goal, requirements, boundaries, nonGoals, deliverableDocuments, expectedOutputs, testCases, acceptanceCriteria, and failureReportContract when failure should feed repair.",
    "8a. Type-specific nodePromptSpec fields: plan uses planningQuestions/decisionCriteria/planArtifactContract; implement uses implementationScope/filesLikelyToTouch/testCases; verify uses verificationChecks/testCases/failureArtifactContract; repair uses repairInputs/mustPreserve/reverificationChecks; review uses reviewChecklist/riskCriteria; summary uses summarySections/handoffCriteria.",
    "9. Verify graph closure before output: selected agent must support selected skills; selected skills must include required tools, MCP grants, and instructions through edges; evaluator must validate output artifacts; conflicting/incompatible edges must not be selected together.",
    "10. For each generated profile, output a complete agentProfile that the compiler can materialize into Docker worker input agent-profile/profile.json and task execution.",
    "11. Each agentProfile must include workerKind, provider, model, thinkingLevel, harnessRef, instruction, promptTemplateRef, contextPolicyRef, sessionPolicyRef, memoryScopes, agentsMdRefs, vaultLeasePolicyRefs, toolPolicy, budgetPolicy, and execution.",
    "12. agentProfile.execution must include engine=tork, image, command, env, mounts, timeoutSeconds, and infraRetry.maxAttempts. Use an empty mounts array for workspace access; Southstar runtime injects the real host workspace mount from the task envelope. Never output source=\"workspace\" or container paths as mount sources.",
    "12a. When agentProfile.execution.image is southstar/pi-agent:local, set provider=pi, harnessRef=pi, and model=pi-agent-default. Do not output codex provider or codex harness for this image.",
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
      "selectedWorkflowTemplateRef",
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
  requireString(value.selectedWorkflowTemplateRef, "selectedWorkflowTemplateRef", issues);
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
  validateNodePromptSpec(value.nodePromptSpec, `${path}.nodePromptSpec`, issues);
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
  requireAllowedAgentProfileValue(GENERATED_AGENT_PROFILE_WORKER_KINDS, value.workerKind, `${path}.workerKind`, issues);
  requireAllowedAgentProfileValue(GENERATED_AGENT_PROFILE_PROVIDERS, value.provider, `${path}.provider`, issues);
  requireAllowedAgentProfileValue(GENERATED_AGENT_PROFILE_MODELS, value.model, `${path}.model`, issues);
  requireAllowedAgentProfileValue(GENERATED_AGENT_PROFILE_THINKING_LEVELS, value.thinkingLevel, `${path}.thinkingLevel`, issues);
  requireAllowedAgentProfileValue(GENERATED_AGENT_PROFILE_HARNESSES, value.harnessRef, `${path}.harnessRef`, issues);
  const image = isRecord(value.execution) ? value.execution.image : undefined;
  const binding = runtimeBindingForGeneratedProfileImage(image);
  if (binding) {
    if (value.provider !== binding.provider) {
      issues.push(issue("composer_output_schema_violation", `${path}.provider`, `must be ${binding.provider} for ${String(image)}`));
    }
    if (value.model !== binding.model) {
      issues.push(issue("composer_output_schema_violation", `${path}.model`, `must be ${binding.model} for ${String(image)}`));
    }
    if (value.harnessRef !== binding.harnessRef) {
      issues.push(issue("composer_output_schema_violation", `${path}.harnessRef`, `must be ${binding.harnessRef} for ${String(image)}`));
    }
  }
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
  requireAllowedAgentProfileValue(["tork"], value.engine, `${path}.engine`, issues);
  for (const field of ["image"] as const) {
    if (value[field] !== undefined) requireString(value[field], `${path}.${field}`, issues);
  }
  requireAllowedAgentProfileValue(GENERATED_AGENT_PROFILE_IMAGES, value.image, `${path}.image`, issues);
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

function requireAllowedAgentProfileValue(
  allowedValues: readonly string[],
  value: unknown,
  path: string,
  issues: WorkflowCompositionValidationIssue[],
): void {
  if (value === undefined) return;
  if (isAllowedGeneratedAgentProfileValue(allowedValues, value)) return;
  issues.push(issue("composer_output_schema_violation", path, `must be one of: ${allowedValues.join(", ")}`));
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

function boundCandidatePacket(packet: CandidatePacket): CandidatePacket {
  return {
    ...packet,
    workflowTemplateCandidates: packet.workflowTemplateCandidates.slice(0, 20),
    agentCandidatesByCapability: boundCandidateMap(packet.agentCandidatesByCapability),
    profileCandidatesByAgent: boundCandidateMap(packet.profileCandidatesByAgent),
    skillCandidatesByProfile: boundCandidateMap(packet.skillCandidatesByProfile),
    toolCandidatesByProfile: boundCandidateMap(packet.toolCandidatesByProfile),
    mcpGrantCandidatesByProfile: boundCandidateMap(packet.mcpGrantCandidatesByProfile),
    vaultLeaseCandidatesByProfile: boundCandidateMap(packet.vaultLeaseCandidatesByProfile),
    instructionCandidatesByProfile: boundCandidateMap(packet.instructionCandidatesByProfile),
    artifactContractCandidates: packet.artifactContractCandidates.slice(0, 50),
    evaluatorCandidatesByArtifact: boundCandidateMap(packet.evaluatorCandidatesByArtifact),
    policyConstraints: packet.policyConstraints.slice(0, 50),
    profilePrimitiveCandidates: packet.profilePrimitiveCandidates
      ? {
        agents: packet.profilePrimitiveCandidates.agents.slice(0, 100),
        skills: packet.profilePrimitiveCandidates.skills.slice(0, 100),
        tools: packet.profilePrimitiveCandidates.tools.slice(0, 100),
        mcpGrants: packet.profilePrimitiveCandidates.mcpGrants.slice(0, 100),
        instructions: packet.profilePrimitiveCandidates.instructions.slice(0, 100),
      }
      : undefined,
    graphMetadataCandidates: packet.graphMetadataCandidates
      ? {
        ...packet.graphMetadataCandidates,
        nodes: packet.graphMetadataCandidates.nodes.slice(0, 500),
        edges: packet.graphMetadataCandidates.edges.slice(0, 1_500),
      }
      : undefined,
  };
}

function boundCandidateMap<T>(candidateMap: Record<string, T[]>): Record<string, T[]> {
  return Object.fromEntries(
    Object.entries(candidateMap)
      .slice(0, 50)
      .map(([key, candidates]) => [key, candidates.slice(0, 20)]),
  );
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
  "name",
  "responsibility",
  "templateSlotRef",
  "agentDefinitionRef",
  "agentProfileRef",
  "evaluatorProfileRef",
  "rationale",
];

const TASK_STRING_ARRAY_FIELDS: Array<keyof WorkflowCompositionTask> = [
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
