import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";
import { upsertLibraryEdge, upsertLibraryObject } from "../../../src/v2/design-library/library-graph-store.ts";
import type { GeneratedAgentProfile, WorkflowCompositionPlan, WorkflowCompositionTask } from "../../../src/v2/design-library/types.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "../../../src/v2/orchestration/composer.ts";

export class DeterministicFixtureComposer implements WorkflowComposer {
  async compose(_input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    return deterministicFixtureComposition();
  }
}

export function deterministicFixtureComposition(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Software Dynamic Feature Workflow",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "Test fixture selects graph-backed agents and generated node profiles.",
    tasks: [
      task(
        "understand-repo",
        [],
        "agent.software-explorer",
        "profile.generated.software-understand-repo",
        ["artifact.implementation_plan"],
        "evaluator.software-plan-quality",
      ),
      task(
        "review-spec",
        ["understand-repo"],
        "agent.software-spec-reviewer",
        "profile.generated.software-review-spec",
        ["artifact.implementation_plan"],
        "evaluator.software-plan-quality",
      ),
      task(
        "implement-feature",
        ["review-spec"],
        "agent.software-maker",
        "profile.generated.software-implement-feature",
        ["artifact.implementation_report"],
        "evaluator.software-feature-quality",
      ),
      task(
        "verify-feature",
        ["implement-feature"],
        "agent.software-checker",
        "profile.generated.software-verify-feature",
        ["artifact.verification_report"],
        "evaluator.software-verification-quality",
      ),
      task(
        "review-code-quality",
        ["implement-feature"],
        "agent.software-code-quality-reviewer",
        "profile.generated.software-review-code-quality",
        ["artifact.verification_report"],
        "evaluator.software-verification-quality",
      ),
      task(
        "summarize-completion",
        ["verify-feature", "review-code-quality"],
        "agent.software-summarizer",
        "profile.generated.software-summarize-completion",
        ["artifact.completion_report"],
        "evaluator.software-completion-quality",
      ),
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [
      generatedProfile("profile.generated.software-understand-repo", "Inspect the repository and produce an implementation plan."),
      generatedProfile("profile.generated.software-review-spec", "Review the implementation plan against the requested goal."),
      generatedProfile("profile.generated.software-implement-feature", "Implement the requested feature and report changed behavior."),
      generatedProfile("profile.generated.software-verify-feature", "Verify the feature and produce verification evidence."),
      generatedProfile("profile.generated.software-review-code-quality", "Review code quality and produce verification evidence."),
      generatedProfile("profile.generated.software-summarize-completion", "Summarize the completed workflow and remaining risks."),
    ],
  };
}

export async function seedDeterministicWorkflowGraph(db: SouthstarDb, scope = "software"): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey: "template.software-feature",
    objectKind: "workflow_template",
    status: "approved",
    headVersionId: "template.software-feature@test",
    state: { scope, title: "Software Feature Test Template" },
  });
  for (const agentRef of [
    "agent.software-explorer",
    "agent.software-spec-reviewer",
    "agent.software-maker",
    "agent.software-checker",
    "agent.software-code-quality-reviewer",
    "agent.software-summarizer",
  ]) {
    await upsertLibraryObject(db, {
      objectKey: agentRef,
      objectKind: "agent_definition",
      status: "approved",
      headVersionId: `${agentRef}@test`,
      state: { scope, title: titleFromRef(agentRef) },
    });
  }
  for (const artifactRef of [
    "artifact.implementation_plan",
    "artifact.implementation_report",
    "artifact.verification_report",
    "artifact.completion_report",
  ]) {
    await upsertLibraryObject(db, {
      objectKey: artifactRef,
      objectKind: "artifact_contract",
      status: "approved",
      headVersionId: `${artifactRef}@test`,
      state: { scope, title: titleFromRef(artifactRef) },
    });
  }
  for (const evaluatorRef of [
    "evaluator.software-plan-quality",
    "evaluator.software-feature-quality",
    "evaluator.software-verification-quality",
    "evaluator.software-completion-quality",
  ]) {
    await upsertLibraryObject(db, {
      objectKey: evaluatorRef,
      objectKind: "evaluator_profile",
      status: "approved",
      headVersionId: `${evaluatorRef}@test`,
      state: { scope, title: titleFromRef(evaluatorRef) },
    });
  }
  await upsertLibraryEdge(db, { fromObjectKey: "evaluator.software-plan-quality", edgeType: "validates_artifact", toObjectKey: "artifact.implementation_plan", scope });
  await upsertLibraryEdge(db, { fromObjectKey: "evaluator.software-feature-quality", edgeType: "validates_artifact", toObjectKey: "artifact.implementation_report", scope });
  await upsertLibraryEdge(db, { fromObjectKey: "evaluator.software-verification-quality", edgeType: "validates_artifact", toObjectKey: "artifact.verification_report", scope });
  await upsertLibraryEdge(db, { fromObjectKey: "evaluator.software-completion-quality", edgeType: "validates_artifact", toObjectKey: "artifact.completion_report", scope });
}

function task(
  id: string,
  dependsOn: string[],
  agentDefinitionRef: string,
  agentProfileRef: string,
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
    instructionRefs: [],
    skillRefs: [],
    toolGrantRefs: [],
    mcpGrantRefs: [],
    vaultLeasePolicyRefs: [],
    inputArtifactRefs: [],
    outputArtifactRefs,
    evaluatorProfileRef,
    recoveryStrategyRefs: ["retry-same-agent"],
    rationale: `Select ${agentProfileRef} for ${id}`,
  };
}

function generatedProfile(id: string, instruction: string): WorkflowCompositionPlan["generatedComponentProposals"][number] {
  return {
    id,
    kind: "agent_profile",
    risk: "medium",
    reason: "Test fixture generated from graph-backed primitives.",
    validationStatus: "validated",
    agentProfile: generatedAgentProfile(instruction),
  };
}

function generatedAgentProfile(instruction: string): GeneratedAgentProfile {
  return {
    workerKind: "execution_worker",
    provider: "pi",
    model: "pi-agent-default",
    thinkingLevel: "high",
    harnessRef: "pi",
    instruction,
    promptTemplateRef: "graph-generated",
    contextPolicyRef: "context.generated",
    sessionPolicyRef: "session.generated",
    memoryScopes: [],
    agentsMdRefs: [],
    vaultLeasePolicyRefs: [],
    toolPolicy: {
      allowedTools: [],
      deniedTools: [],
      requiresApprovalFor: [],
    },
    budgetPolicy: {
      maxInputTokens: 120000,
      maxOutputTokens: 8192,
      maxWallTimeSeconds: 900,
    },
    execution: {
      engine: "tork",
      image: "southstar/pi-agent:local",
      command: ["southstar-agent-runner"],
      env: {},
      mounts: [],
      timeoutSeconds: 900,
      infraRetry: { maxAttempts: 1 },
    },
  };
}

function titleFromRef(ref: string): string {
  return ref
    .split(".")
    .at(-1)!
    .split(/[-_]+/g)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
