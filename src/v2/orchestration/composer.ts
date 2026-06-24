import type { CandidatePacket, WorkflowCompositionPlan, WorkflowCompositionTask } from "../design-library/types.ts";

export type ComposeWorkflowInput = {
  goalPrompt: string;
  candidatePacket: CandidatePacket;
};

export interface WorkflowComposer {
  compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan>;
}

export class DeterministicFixtureComposer implements WorkflowComposer {
  async compose(_input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    return {
      schemaVersion: "southstar.workflow_composition_plan.v1",
      title: "Software Dynamic Feature Workflow",
      selectedWorkflowTemplateRef: "template.software-feature",
      rationale: "Fixture composer selects explorer-maker-checker-summarizer using approved refs.",
      tasks: [
        task(
          "understand-repo",
          [],
          "agent.software-explorer",
          "profile.software-explorer-codex",
          ["skill.software-repo-discovery"],
          ["tool.workspace-read"],
          ["instruction.software-explorer"],
          ["artifact.implementation_plan"],
          "evaluator.software-plan-quality",
        ),
        task(
          "review-spec",
          ["understand-repo"],
          "agent.software-spec-reviewer",
          "profile.software-spec-reviewer-codex",
          ["skill.software-spec-review"],
          ["tool.workspace-read"],
          ["instruction.software-spec-reviewer"],
          ["artifact.implementation_plan"],
          "evaluator.software-plan-quality",
        ),
        task(
          "implement-feature",
          ["review-spec"],
          "agent.software-maker",
          "profile.software-maker-pi",
          ["skill.software-implementation"],
          ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"],
          ["instruction.software-maker"],
          ["artifact.implementation_report"],
          "evaluator.software-feature-quality",
        ),
        task(
          "verify-feature",
          ["implement-feature"],
          "agent.software-checker",
          "profile.software-checker-codex",
          ["skill.software-verification"],
          ["tool.workspace-read", "tool.shell-command"],
          ["instruction.software-checker"],
          ["artifact.verification_report"],
          "evaluator.software-verification-quality",
        ),
        task(
          "review-code-quality",
          ["implement-feature"],
          "agent.software-code-quality-reviewer",
          "profile.software-code-quality-reviewer-codex",
          ["skill.software-code-quality-review"],
          ["tool.workspace-read", "tool.shell-command"],
          ["instruction.software-code-quality-reviewer"],
          ["artifact.verification_report"],
          "evaluator.software-verification-quality",
        ),
        task(
          "summarize-completion",
          ["verify-feature", "review-code-quality"],
          "agent.software-summarizer",
          "profile.software-summarizer-codex",
          ["skill.software-summary"],
          ["tool.workspace-read"],
          ["instruction.software-summarizer"],
          ["artifact.completion_report"],
          "evaluator.software-completion-quality",
        ),
      ],
      rejectedCandidates: [],
      generatedComponentProposals: [],
    };
  }
}

function task(
  id: string,
  dependsOn: string[],
  agentDefinitionRef: string,
  agentProfileRef: string,
  skillRefs: string[],
  toolGrantRefs: string[],
  instructionRefs: string[],
  outputArtifactRefs: string[],
  evaluatorProfileRef: string,
): WorkflowCompositionTask {
  return {
    id,
    name: id
      .split("-")
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" "),
    responsibility: id,
    dependsOn,
    templateSlotRef: id,
    agentDefinitionRef,
    agentProfileRef,
    instructionRefs,
    skillRefs,
    toolGrantRefs,
    mcpGrantRefs: [],
    vaultLeasePolicyRefs: [],
    inputArtifactRefs: [],
    outputArtifactRefs,
    evaluatorProfileRef,
    recoveryStrategyRefs: ["retry-same-agent"],
    rationale: `Select ${agentProfileRef} for ${id}`,
  };
}
