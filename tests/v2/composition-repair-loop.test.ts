import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import type { WorkflowCompositionPlan, WorkflowCompositionTask } from "../../src/v2/design-library/types.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { ScriptedWorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { runCompositionRepairLoop } from "../../src/v2/orchestration/composition-repair-loop.ts";
import { analyzeRequirementDeterministically } from "../../src/v2/orchestration/requirement-analyzer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("composition repair loop retries once and returns valid composition", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const candidatePacket = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const composer = new ScriptedWorkflowComposer([invalidPlan(), validPlan()]);
    const result = await runCompositionRepairLoop({
      db,
      goalPrompt: "implement calc sum",
      candidatePacket,
      composer,
      scope: "software",
      maxRepairAttempts: 1,
    });
    assert.equal(result.validation.ok, true);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0]?.validation.ok, false);
    assert.equal(result.composition.tasks[0]?.agentProfileRef, "profile.software-explorer-codex");
  } finally {
    await db.close();
  }
});

function invalidPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Invalid Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "invalid profile-agent edge",
    tasks: [
      task(
        "inspect-only",
        [],
        "agent.software-explorer",
        "profile.software-maker-pi",
        ["skill.software-repo-discovery"],
        ["tool.workspace-read"],
        ["instruction.software-explorer"],
        ["artifact.implementation_plan"],
        "evaluator.software-plan-quality",
      ),
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function validPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Valid Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "valid explorer task",
    tasks: [
      task(
        "inspect-only",
        [],
        "agent.software-explorer",
        "profile.software-explorer-codex",
        ["skill.software-repo-discovery"],
        ["tool.workspace-read"],
        ["instruction.software-explorer"],
        ["artifact.implementation_plan"],
        "evaluator.software-plan-quality",
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
