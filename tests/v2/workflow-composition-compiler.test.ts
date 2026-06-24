import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../../src/v2/orchestration/composition-compiler.ts";
import { DeterministicFixtureComposer } from "../../src/v2/orchestration/composer.ts";
import { analyzeRequirementDeterministically } from "../../src/v2/orchestration/requirement-analyzer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("compiler builds library-constrained workflow manifest and snapshot from approved candidates", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirementSpec = analyzeRequirementDeterministically("implement calc sum");
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composer = new DeterministicFixtureComposer();
    const composition = await composer.compose({
      goalPrompt: "implement calc sum",
      candidatePacket,
    });

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-test-run",
      goalPrompt: "implement calc sum",
      candidatePacket,
      composition,
    });

    assert.equal(compiled.workflow.schemaVersion, "southstar.v2");
    assert.equal(compiled.workflow.workflowGeneration?.generatorPolicyRef, "library-constrained-llm");
    assert.deepEqual(compiled.workflow.tasks.map((task) => task.id), [
      "understand-repo",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);

    const makerTask = compiled.workflow.tasks.find((task) => task.id === "implement-feature");
    assert.ok(makerTask, "implement-feature task should exist");
    assert.equal(makerTask.agentProfileRef, "software-maker-pi");
    assert.deepEqual(makerTask.instructionRefs, ["instruction.software-maker"]);
    assert.deepEqual(makerTask.toolGrantRefs, ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"]);

    assert.equal(compiled.orchestrationSnapshot.validation.ok, true);
    assert.equal(
      compiled.orchestrationSnapshot.candidateSummary.agentProfileRefs.includes("profile.software-maker-pi"),
      true,
    );
  } finally {
    await db.close();
  }
});

test("compiler resolves runtime role/profile definitions for deterministic fixture composition", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirementSpec = analyzeRequirementDeterministically("implement calc sum");
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composition = await new DeterministicFixtureComposer().compose({
      goalPrompt: "implement calc sum",
      candidatePacket,
    });

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-roles-profiles-test-run",
      goalPrompt: "implement calc sum",
      candidatePacket,
      composition,
    });

    const reviewSpec = compiled.workflow.tasks.find((task) => task.id === "review-spec");
    assert.ok(reviewSpec, "review-spec task should exist");
    assert.equal(reviewSpec.agentProfileRef, "software-spec-reviewer-codex");

    const reviewCodeQuality = compiled.workflow.tasks.find((task) => task.id === "review-code-quality");
    assert.ok(reviewCodeQuality, "review-code-quality task should exist");
    assert.equal(reviewCodeQuality.agentProfileRef, "software-code-quality-reviewer-codex");

    assert.equal(compiled.workflow.roles?.some((role) => role.id === "spec-reviewer"), true);
    assert.equal(
      compiled.workflow.agentProfiles?.some((profile) => profile.id === "software-spec-reviewer-codex"),
      true,
    );
  } finally {
    await db.close();
  }
});
