import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import type { WorkflowCompositionPlan, WorkflowCompositionTask } from "../../src/v2/design-library/types.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { validateWorkflowCompositionPlan } from "../../src/v2/orchestration/composition-validator.ts";
import { analyzeRequirementDeterministically } from "../../src/v2/orchestration/requirement-analyzer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("validator accepts a composition that uses approved candidates", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const validation = await validateWorkflowCompositionPlan(db, packet, validComposition());
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues, []);
  } finally {
    await db.close();
  }
});

test("validator rejects refs outside the candidate packet", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[1]!.agentProfileRef = "profile.unapproved-writer";

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((item) => item.code === "ref_not_in_candidate_packet"), true);
  } finally {
    await db.close();
  }
});

test("validator rejects dependency cycles in memory", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[0]!.dependsOn = ["summarize-completion"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((item) => item.code === "dependency_cycle"), true);
  } finally {
    await db.close();
  }
});

function validComposition(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Software Dynamic Feature Workflow",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "Use explorer-maker-checker-summarizer flow.",
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
        "implement-feature",
        ["understand-repo"],
        "agent.software-maker",
        "profile.software-maker-pi",
        ["skill.software-implementation"],
        ["tool.workspace-read", "tool.workspace-write"],
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
        ["tool.workspace-read"],
        ["instruction.software-checker"],
        ["artifact.verification_report"],
        "evaluator.software-verification-quality",
      ),
      task(
        "summarize-completion",
        ["verify-feature"],
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
    name: id,
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
    rationale: id,
  };
}
