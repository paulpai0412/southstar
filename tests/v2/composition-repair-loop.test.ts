import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import type { WorkflowCompositionPlan, WorkflowCompositionTask } from "../../src/v2/design-library/types.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { ScriptedWorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { runCompositionRepairLoop } from "../../src/v2/orchestration/composition-repair-loop.ts";
import { LlmComposerOutputError } from "../../src/v2/orchestration/llm-composer.ts";
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

test("composition repair loop retry prompt includes previous composition JSON and validation issues", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const candidatePacket = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const prompts: string[] = [];
    const composer = {
      async compose(input: { goalPrompt: string }) {
        prompts.push(input.goalPrompt);
        return prompts.length === 1 ? invalidPlan() : validPlan();
      },
    };
    const result = await runCompositionRepairLoop({
      db,
      goalPrompt: "implement calc sum",
      candidatePacket,
      composer,
      scope: "software",
      maxRepairAttempts: 1,
    });
    const retryPrompt = prompts[1] ?? "";
    const firstIssueCode = result.attempts[0]?.validation.issues[0]?.code ?? "";

    assert.equal(result.validation.ok, true);
    assert.equal(prompts.length, 2);
    assert.match(retryPrompt, /Previous composition JSON:/);
    assert.match(retryPrompt, /Latest validation issues:/);
    assert.match(retryPrompt, new RegExp(firstIssueCode));
    assert.match(retryPrompt, /\"title\":\"Invalid Plan\"/);
  } finally {
    await db.close();
  }
});

test("composition repair loop retries when composer output violates schema contract", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const candidatePacket = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    let attempt = 0;
    const prompts: string[] = [];
    const composer = {
      async compose(input: { goalPrompt: string }) {
        prompts.push(input.goalPrompt);
        if (attempt === 0) {
          attempt += 1;
          throw new LlmComposerOutputError([
            {
              code: "composer_output_schema_violation",
              path: "tasks",
              message: "tasks must be an array",
            },
          ]);
        }
        return validPlan();
      },
    };
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
    assert.equal(result.attempts[0]?.validation.issues[0]?.code, "composer_output_schema_violation");
    assert.equal(result.attempts[0]?.composition, undefined);
    assert.equal(result.composition?.tasks[0]?.agentProfileRef, "profile.software-explorer-codex");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /Latest validation issues:/);
    assert.match(prompts[1] ?? "", /composer_output_schema_violation/);
    assert.equal((prompts[1] ?? "").includes("Previous composition JSON:"), false);
  } finally {
    await db.close();
  }
});

function invalidPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Invalid Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "invalid explorer profile should trigger repair",
    tasks: buildPlanTasks("profile.software-maker-pi"),
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function validPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Valid Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "valid software feature workflow with code quality review",
    tasks: buildPlanTasks("profile.software-explorer-codex"),
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function buildPlanTasks(explorerProfileRef: string): WorkflowCompositionTask[] {
  return [
    task(
      "understand-repo",
      [],
      "agent.software-explorer",
      explorerProfileRef,
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
  ];
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
